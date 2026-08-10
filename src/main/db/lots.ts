import type { Database } from 'better-sqlite3'
import { QTY_SNAP, quantizationSlack } from '@shared/units'
import { normPickQty, validatePicks, type CostLot, type LotPick } from '@shared/costLots'
import { newId, nowIso } from '../util'

/**
 * FIFO cost-lot engine. Every stock-in creates a dated "lot" (a batch bought at
 * a unit cost); sales and negative adjustments consume the oldest lots first.
 *
 * The LAYERS are the cost basis — see db/valuation.ts, which is where every
 * total in the app now reads it from. The product's `unit_cost` is the weighted
 * average of the remaining layers: a per-unit figure, for display and for
 * pricing decisions, and the fallback basis for a shelf that has stock but no
 * layer at all. It is deliberately NOT how a total is reconstructed.
 *
 * All mutating helpers take the `db` handle and MUST be called inside the
 * caller's existing `db.transaction()` so a lot change and its stock change
 * commit together — the invariant `Σ lot.qty_remaining == stock.quantity` per
 * (product, location) is preserved by construction.
 */

export interface LotSlice {
  lotId: string
  qty: number
  unitCost: number
}

export type LotSource = 'restock' | 'opening' | 'adjustment' | 'backfill'

const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * PER-UNIT MONEY PRECISION — four decimals, not two.
 *
 * A TOTAL is money and belongs in cents. A per-unit cost is a rate, and a rate
 * rounded to cents is multiplied back up by the quantity everywhere it is used:
 * as the basis for a found-stock lot, as the basis for a shelf that has no
 * layer, and as the average shown beside a seven-box count. At two decimals a
 * blended average of $15.7142… is stored as $15.71 and every use of it is a cent
 * per unit out; at four it is $15.7143 and the same use is a hundredth of a cent
 * out. Nothing downstream reconstructs a total from it any more, so this is not
 * what makes the totals exact — it is what stops the one place that still has to
 * fall back on an average (unlayered stock) from being wrong by real money.
 *
 * Four, matching QTY_DP, because a unit cost and a unit count are the two halves
 * of the same multiplication and there is no reason for them to disagree.
 */
export const UNIT_DP = 4
const UNIT_SCALE = 10 ** UNIT_DP

/** Round a PER-UNIT money figure (a cost, an average) to UNIT_DP. */
export function unitMoney(n: number): number {
  return Math.round(n * UNIT_SCALE) / UNIT_SCALE
}

/**
 * QUANTITY PRECISION — the one place fractional stock is allowed in, and the one
 * place everything else is kept whole.
 *
 * Four decimal places, matching `round4` in @shared/units, so a quantity that
 * came out of `breakToStock` / `giveawayToStock` survives the trip into the
 * database and back unchanged. A twelfth of a box is 0.0833; deeper precision
 * buys nothing and shallower would not represent a pack.
 */
export const QTY_DP = 4
const QTY_SCALE = 10 ** QTY_DP

/**
 * Comparison slack for quantities. Float arithmetic on 0.0833-sized pieces
 * leaves dust at the 1e-16 level, and a FIFO walk that compared `need > 0`
 * exactly would refuse a consumption that had in fact completed — reporting
 * "short 2.7e-16" to an operator. Everything is rounded to QTY_DP before it is
 * stored, so anything below this is arithmetic noise by construction.
 */
export const QTY_EPS = 1e-6

/**
 * Normalise a quantity for a product.
 *
 * `fractional` is NOT a hint — it is the product's `giveaway_item` flag, and it
 * is the whole gate. False rounds to a whole number, which is exactly what every
 * quantity in this app did before v25, so purchase-order receipts, scan-ins,
 * sales and adjustments are bit-for-bit unchanged for the entire catalog. True
 * keeps four decimals, and only a product deliberately marked as giveaway
 * material can ever be true.
 */
export function roundQty(qty: number, fractional: boolean): number {
  if (!Number.isFinite(qty)) return NaN
  return fractional ? Math.round(qty * QTY_SCALE) / QTY_SCALE : Math.round(qty)
}

/** Round a quantity that is already known to be legitimate (a lot balance, a
 *  running remainder), purely to keep float dust out of storage. */
export function normQty(qty: number): number {
  return Math.round(qty * QTY_SCALE) / QTY_SCALE
}

/**
 * Does this database have the v25 flag column yet? Memoised per handle: it is a
 * property of the schema, not of a row, and probing it on every lot operation
 * would be a PRAGMA per FIFO step.
 *
 * A database WITHOUT the column is one where no product can be a giveaway item,
 * so "no column" answers the question rather than dodging it — and the answer is
 * whole units, which is what every such database already did.
 */
const HAS_FLAG = new WeakMap<Database, boolean>()
function hasGiveawayFlag(db: Database): boolean {
  const known = HAS_FLAG.get(db)
  if (known !== undefined) return known
  const cols = db.prepare('PRAGMA table_info(inventory_products)').all() as Array<{ name: string }>
  const has = cols.some((c) => c.name === 'giveaway_item')
  HAS_FLAG.set(db, has)
  return has
}

/**
 * Is this product deliberately stocked in fractional units?
 *
 * Read from the product row on every call rather than passed in, so that no
 * caller of createLot / consumeFifo / restoreFifo had to change and none of them
 * can accidentally opt a product in. A product that no longer exists is false —
 * whole units — which is the safe answer.
 */
export function allowsFractionalQty(db: Database, productId: string | null | undefined): boolean {
  if (!productId) return false
  if (!hasGiveawayFlag(db)) return false
  const row = db.prepare('SELECT giveaway_item FROM inventory_products WHERE id = ?').get(productId) as
    | { giveaway_item: number }
    | undefined
  return !!row && Number(row.giveaway_item) === 1
}

/** Insert one cost lot (qty_received === qty_remaining === qty). Returns the new
 * lot's id (empty string when nothing was inserted) so a caller can record
 * exactly which cost layer a receipt created and reverse that one later.
 *
 * `vendor` is who the stock was bought from, and it is OPTIONAL because most
 * ways a layer comes into existence genuinely do not know: an opening balance, a
 * count-sheet correction and a found-stock adjustment have no supplier behind
 * them. Only a purchase-order receipt does, and only that path passes one. The
 * cost-lot picker prints it so an operator choosing between two layers at
 * different prices can tell which case is which — see `lotLabel` in
 * @shared/costLots for what a layer without one shows instead. */
export function createLot(
  db: Database,
  productId: string,
  location: string,
  qty: number,
  unitCost: number,
  receivedAt: string,
  source: LotSource,
  note: string | null,
  vendor: string | null = null
): string {
  // Whole units unless this exact product is flagged for fractions. The flag is
  // read here rather than taken from the caller so that every existing call site
  // (opening stock, restock, adjustment, PO receipt, scan-in, backfill) keeps
  // its pre-v25 whole-number behaviour without being touched.
  const q = roundQty(qty, allowsFractionalQty(db, productId))
  if (!(q > 0)) return ''
  const id = newId()
  // A layer's unit cost is a per-unit figure, so it is stored at UNIT_DP. A real
  // purchase price is a cent value and is unaffected; a layer opened at a blended
  // average (found stock, a backfill, a count sheet's extended total) is the case
  // this exists for — cent-rounding there would bake the average's error
  // permanently into the one thing the app treats as the truth.
  db.prepare(
    `INSERT INTO inventory_lots
       (id, product_id, location, qty_received, qty_remaining, unit_cost, received_at, source, note, vendor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    productId,
    location,
    q,
    q,
    unitMoney(Math.max(0, unitCost)),
    receivedAt,
    source,
    note,
    (vendor ?? '').trim() || null,
    nowIso()
  )
  return id
}

/**
 * Reverse a specific receipt (an undo), targeting the exact lot it created
 * rather than consuming FIFO-oldest — undoing an old scan must never cannibalise
 * a newer cost layer. MUST be called inside the caller's db.transaction().
 *
 * Throws when the lot is gone, or when part of it has already been sold (a clean
 * reversal is impossible then); the throw rolls the caller back. Decrements BOTH
 * qty_received and qty_remaining so the engine invariant
 * `Σ lot.qty_remaining == inventory_stock.quantity` per (product, location) —
 * the one assertStockLotsConsistent() checks — stays intact.
 */
export function reverseLotReceipt(db: Database, lotId: string, qty: number): void {
  const lot = db
    .prepare('SELECT product_id, qty_received, qty_remaining FROM inventory_lots WHERE id = ?')
    .get(lotId) as { product_id: string; qty_received: number; qty_remaining: number } | undefined
  if (!lot) throw new Error('That cost lot no longer exists.')
  // The lot names its own product, so the fractional gate is read from the row
  // already in hand rather than asked of the caller.
  const q = roundQty(qty, allowsFractionalQty(db, lot.product_id))
  if (!(q > 0)) return
  // Compared with slack: a fractional reversal of exactly what was received can
  // otherwise land a dust-width under it and read as "already sold".
  if (lot.qty_remaining < q - QTY_EPS) {
    throw new Error('Some of that stock has already been sold — adjust it manually instead.')
  }
  if (normQty(lot.qty_received - q) <= QTY_EPS) {
    db.prepare('DELETE FROM inventory_lots WHERE id = ?').run(lotId)
    return
  }
  // Written as absolute values rather than decrements so a fractional balance is
  // re-rounded to QTY_DP every time instead of accumulating float dust.
  db.prepare(
    'UPDATE inventory_lots SET qty_received = ?, qty_remaining = ? WHERE id = ?'
  ).run(normQty(lot.qty_received - q), normQty(lot.qty_remaining - q), lotId)
}

/**
 * Consume `qty` units from a product's open lots at a location, oldest first.
 * Returns the consumed slices (for COGS). Throws if the lots can't cover `qty`
 * — callers already guard on stock, so a throw rolls the transaction back.
 */
export function consumeFifo(db: Database, productId: string, location: string, qty: number): LotSlice[] {
  let need = roundQty(qty, allowsFractionalQty(db, productId))
  if (!(need > 0)) return []
  const lots = db
    .prepare(
      `SELECT id, qty_remaining, unit_cost FROM inventory_lots
       WHERE product_id = ? AND location = ? AND qty_remaining > 0
       ORDER BY received_at ASC, rowid ASC`
    )
    .all(productId, location) as Array<{ id: string; qty_remaining: number; unit_cost: number }>
  // Absolute, not `qty_remaining - ?`: a fractional take is re-rounded to QTY_DP
  // on the way in, so a lot can never end up holding 3.9999999999999996.
  const set = db.prepare('UPDATE inventory_lots SET qty_remaining = ? WHERE id = ?')
  const slices: LotSlice[] = []
  for (const lot of lots) {
    if (need <= QTY_EPS) break
    const take = normQty(Math.min(need, lot.qty_remaining))
    if (!(take > 0)) continue
    /**
     * SNAP TO ZERO once the layer is within rounding dust of empty.
     *
     * For divisors whose 1/N rounds DOWN at four places (3, 9, 11, 12, 30),
     * taking all N pieces left the lot holding 0.0001 to 0.001 forever: an open
     * cost layer, and a product still showing stock it does not have, with no UI
     * able to enter a fraction to clear it. The layer is empty; the arithmetic
     * just cannot say so in four decimal places.
     */
    const left = normQty(lot.qty_remaining - take)
    set.run(left > QTY_SNAP ? left : 0, lot.id)
    slices.push({ lotId: lot.id, qty: take, unitCost: lot.unit_cost })
    need = normQty(need - take)
  }
  /**
   * Slack, not `> 0`: the remainder of a fractional walk is dust, and refusing
   * on 2.7e-16 would roll back a consumption that had actually completed.
   *
   * The slack is the accumulated QUANTIZATION error, not a fixed 1e-6. Every
   * balance here is re-rounded to QTY_DP on every step, so taking a unit one
   * 1/N piece at a time leaves the layers a few ten-thousandths short of the
   * full-precision ask by the last piece — and a 1e-6 threshold turned that into
   * a throw that rolled back a break the caller had already accepted.
   */
  if (need > quantizationSlack(qty)) {
    throw new Error(`Not enough cost lots to consume ${qty} at ${location} (short ${need}).`)
  }
  return slices
}

/**
 * The open cost layers for one (product, location), oldest first — what the
 * picker puts on screen.
 *
 * A READ, and the only one the dialog gets. It is re-read inside the write's
 * transaction before anything is consumed (see consumePicked), because between
 * the operator opening the dialog and pressing Confirm another station can have
 * emptied one of these layers, and honouring a stale row would take stock out of
 * a lot that no longer has it.
 */
export function listOpenLots(db: Database, productId: string, location: string): CostLot[] {
  const rows = db
    .prepare(
      `SELECT id, unit_cost, qty_remaining, received_at, source, note, vendor
         FROM inventory_lots
        WHERE product_id = ? AND location = ? AND qty_remaining > 0
        ORDER BY received_at ASC, rowid ASC`
    )
    .all(productId, location) as Array<{
    id: string
    unit_cost: number
    qty_remaining: number
    received_at: string
    source: string
    note: string | null
    vendor: string | null
  }>
  return rows.map((r) => ({
    lotId: r.id,
    vendor: r.vendor,
    unitCost: r.unit_cost,
    qtyRemaining: r.qty_remaining,
    receivedAt: r.received_at,
    source: r.source,
    note: r.note
  }))
}

/**
 * Consume EXACTLY the layers the operator chose, in the quantities they chose.
 *
 * The other half of the picker. `consumeFifo` answers "which layers?" by itself;
 * this one is told, and its whole job is to be told faithfully — the cost it
 * returns is the cost that gets booked, so a silent deviation here would put the
 * app back where it started, only with a dialog in front of it pretending
 * otherwise.
 *
 * THROWS rather than falling back, in every failure case:
 *
 *  - a layer that has gone (deleted product, emptied by another station),
 *  - a layer that no longer holds what was asked of it,
 *  - a total that does not match the quantity being consumed.
 *
 * Every one of those means the operator's answer no longer describes the shelf.
 * Quietly walking FIFO instead would book a cost they did not choose while they
 * believe they chose it, which is strictly worse than never having asked — the
 * throw rolls the caller's transaction back and the consumption is retried
 * against fresh numbers.
 *
 * MUST be called inside the caller's db.transaction().
 */
export function consumePicked(
  db: Database,
  productId: string,
  location: string,
  qty: number,
  picks: LotPick[]
): LotSlice[] {
  const want = roundQty(qty, allowsFractionalQty(db, productId))
  if (!(want > 0)) return []

  // Re-read inside the transaction. The list the dialog was drawn from is a
  // snapshot from before the operator started reading it.
  const check = validatePicks(listOpenLots(db, productId, location), picks, want)
  if (!check.ok) throw new Error(check.error)

  const read = db.prepare(
    'SELECT qty_remaining, unit_cost FROM inventory_lots WHERE id = ? AND product_id = ? AND location = ?'
  )
  const set = db.prepare('UPDATE inventory_lots SET qty_remaining = ? WHERE id = ?')
  const slices: LotSlice[] = []
  let taken = 0
  for (const pick of picks) {
    const lot = read.get(pick.lotId, productId, location) as
      | { qty_remaining: number; unit_cost: number }
      | undefined
    if (!lot) throw new Error('That cost layer is no longer on the shelf — choose again.')
    // Clamped to what the layer holds, exactly as the FIFO walk does. A
    // fractional ask is a full-precision 1/N against a balance re-rounded to four
    // places, so asking for a hair more than the layer stores is arithmetic, not
    // an error — validatePicks has already refused anything bigger than that.
    const take = normQty(Math.min(normPickQty(pick.qty), lot.qty_remaining))
    if (!(take > 0)) continue
    // Same snap-to-zero as consumeFifo: for divisors whose 1/N rounds down at
    // four places, taking all N pieces otherwise leaves the layer holding 0.0001
    // forever — an open cost layer for stock that is gone, and a product still
    // reporting a fraction no UI can enter to clear.
    const left = normQty(lot.qty_remaining - take)
    set.run(left > QTY_SNAP ? left : 0, pick.lotId)
    slices.push({ lotId: pick.lotId, qty: take, unitCost: lot.unit_cost })
    taken = normQty(taken + take)
  }
  // The clamp above can shave a few ten-thousandths off a fractional take, so
  // the comparison carries the same quantization slack every other quantity
  // comparison in this file does. Anything larger is a real shortfall and the
  // caller must not book a cost for stock the layers could not supply.
  if (Math.abs(taken - want) > quantizationSlack(want)) {
    throw new Error(`Those cost layers cover ${taken}, not ${want}. Choose again.`)
  }
  return slices
}

/**
 * The ONE door every consumption goes through: take the operator's allocation
 * when there is one, walk FIFO when there is not.
 *
 * `picks` being null is not a fallback for a failed picker — it is the ordinary
 * case where there was nothing to decide (one layer, or several all at the same
 * unit cost) and no dialog was ever shown. It is also what the non-interactive
 * paths pass: a count-sheet reset, a purchase-order cancellation, a scan-out
 * replayed from its token. Those have no operator in front of them, and FIFO is
 * the behaviour they have always had.
 *
 * A picker that was shown and CANCELLED never reaches here at all: the renderer
 * abandons the whole action. Arriving here with null after a cancel would book
 * oldest-first while the operator believed they had chosen, which is the exact
 * failure the dialog exists to prevent.
 */
export function consumeLots(
  db: Database,
  productId: string,
  location: string,
  qty: number,
  picks: LotPick[] | null | undefined
): LotSlice[] {
  const chosen = picks && picks.length > 0
  return chosen
    ? consumePicked(db, productId, location, qty, picks as LotPick[])
    : consumeFifo(db, productId, location, qty)
}

/**
 * Record which layers a ledger movement took, against that movement.
 *
 * The audit half of the picker, and the reason a later reader cannot be told a
 * different story by the P&L, the valuation and the layers themselves: the rows
 * written here are the SAME slices whose cost was booked on the transaction and
 * whose qty_remaining was decremented. One set of numbers, written three places,
 * from one variable.
 *
 * `picked` says whether an operator chose this allocation or the FIFO walk
 * produced it. Without that flag a $1,400 booking against a $1,600 case looks
 * identical whether somebody decided it or nobody was asked, and those are the
 * two cases anybody investigating a wrong margin needs to tell apart.
 *
 * Streaming lines do not use this — they have `stream_item_lots`, which predates
 * it and additionally has to survive the product being deleted so a removed line
 * can hand back exactly what it took.
 *
 * MUST be called inside the caller's db.transaction().
 */
export function recordTxnLots(db: Database, txnId: string, slices: LotSlice[], picked: boolean): void {
  if (!txnId || slices.length === 0) return
  const ins = db.prepare(
    `INSERT INTO inventory_txn_lots (id, txn_id, lot_id, quantity, unit_cost, picked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const ts = nowIso()
  for (const s of slices) ins.run(newId(), txnId, s.lotId, s.qty, s.unitCost, picked ? 1 : 0, ts)
}

/**
 * Put consumed quantity BACK into the exact lots it came from — the inverse of
 * consumeFifo, and deliberately NOT the same thing as reverseLotReceipt (which
 * undoes a RECEIPT by shrinking qty_received as well).
 *
 * It exists because a caller that recorded which slices it consumed can undo
 * itself precisely. Handing the units back through createLot instead would open
 * a fresh layer at today's average: the FIFO order would change, and the cost
 * basis of everything still on the shelf would silently move. Restoring the
 * original layers leaves the engine exactly as it was before the consumption.
 *
 * Refuses rather than clamps when a restore would push qty_remaining past
 * qty_received (that can only mean the same consumption is being undone twice)
 * or when the lot is gone, so `Σ lot.qty_remaining == inventory_stock.quantity`
 * per (product, location) cannot be broken by a partial restore. Both throws
 * roll the caller back.
 *
 * MUST be called inside the caller's db.transaction().
 */
export function restoreFifo(db: Database, slices: LotSlice[]): void {
  const read = db.prepare(
    'SELECT product_id, qty_received, qty_remaining FROM inventory_lots WHERE id = ?'
  )
  const upd = db.prepare('UPDATE inventory_lots SET qty_remaining = ? WHERE id = ?')
  for (const slice of slices) {
    const lot = read.get(slice.lotId) as
      | { product_id: string; qty_received: number; qty_remaining: number }
      | undefined
    if (!lot) throw new Error('The cost layer that stock came from no longer exists.')
    const q = roundQty(slice.qty, allowsFractionalQty(db, lot.product_id))
    if (!(q > 0)) continue
    // Slack on the ceiling: restoring exactly what was taken from a fractional
    // lot lands a dust-width over qty_received and would read as a double undo.
    if (normQty(lot.qty_remaining + q) > lot.qty_received + QTY_EPS) {
      throw new Error('That stock has already been put back.')
    }
    upd.run(normQty(lot.qty_remaining + q), slice.lotId)
  }
}

/**
 * Weighted average cost of the remaining lots across all locations (0 if none).
 *
 * A DERIVED PER-UNIT NUMBER. Nothing may multiply this by a quantity to get a
 * total — that is the whole defect this file's header describes. Rounded to
 * UNIT_DP rather than to cents because it is a rate, not money.
 */
export function lotWeightedAvgCost(db: Database, productId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_remaining), 0) AS q, COALESCE(SUM(qty_remaining * unit_cost), 0) AS c
       FROM inventory_lots WHERE product_id = ?`
    )
    .get(productId) as { q: number; c: number }
  return row.q > 0 ? unitMoney(row.c / row.q) : 0
}

/**
 * Recompute and store the product's average unit cost from its remaining lots.
 * When nothing remains on hand, the last-known average is retained (matching the
 * prior moving-average behaviour), so a later zero-cost restock doesn't reset
 * the basis to 0.
 */
export function syncProductAvgCost(db: Database, productId: string): void {
  const row = db
    .prepare('SELECT COALESCE(SUM(qty_remaining), 0) AS q FROM inventory_lots WHERE product_id = ?')
    .get(productId) as { q: number }
  if (row.q <= 0) return
  db.prepare('UPDATE inventory_products SET unit_cost = ?, updated_at = ? WHERE id = ?').run(
    lotWeightedAvgCost(db, productId),
    nowIso(),
    productId
  )
}

/** Total COGS of a set of consumed slices, rounded to cents. */
export function slicesCost(slices: LotSlice[]): number {
  return cents(slices.reduce((sum, s) => sum + s.qty * s.unitCost, 0))
}

/**
 * One-time backfill: seed a single lot per (product, location) that has stock
 * but no lot yet, valued at the product's current average cost and dated to the
 * product's creation (so legacy stock is consumed first under FIFO).
 */
export function backfillLots(db: Database): void {
  const run = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT s.product_id AS pid, s.location AS loc, s.quantity AS qty,
                p.unit_cost AS cost, p.created_at AS created
         FROM inventory_stock s
         JOIN inventory_products p ON p.id = s.product_id
         WHERE s.quantity > 0`
      )
      .all() as Array<{ pid: string; loc: string; qty: number; cost: number; created: string }>
    const hasLot = db.prepare('SELECT 1 FROM inventory_lots WHERE product_id = ? AND location = ? LIMIT 1')
    for (const r of rows) {
      if (hasLot.get(r.pid, r.loc)) continue
      createLot(db, r.pid, r.loc, r.qty, r.cost, r.created, 'backfill', 'Opening balance')
    }
  })
  run()
}

/**
 * Re-derive every product's stored average from its remaining layers.
 *
 * A one-time pass for databases whose averages were written when this was a
 * cent-rounded figure. It reads nothing but the layers, so it cannot invent a
 * basis: a product with nothing on hand keeps the average it already had (see
 * syncProductAvgCost), and a product whose layers all sit at the same cent value
 * comes back with exactly the number it went in with.
 */
export function resyncProductAvgCosts(db: Database): void {
  const run = db.transaction(() => {
    const ids = db
      .prepare('SELECT DISTINCT product_id AS id FROM inventory_lots WHERE qty_remaining > 0')
      .all() as Array<{ id: string }>
    for (const r of ids) syncProductAvgCost(db, r.id)
  })
  run()
}

/**
 * Dev/test invariant: Σ lot.qty_remaining per (product, location) must equal the
 * aggregate inventory_stock quantity. Throws on the first mismatch.
 */
export function assertStockLotsConsistent(db: Database): void {
  const rows = db
    .prepare(
      `SELECT s.product_id AS pid, s.location AS loc, s.quantity AS stock,
              COALESCE((SELECT SUM(l.qty_remaining) FROM inventory_lots l
                        WHERE l.product_id = s.product_id AND l.location = s.location), 0) AS lots
       FROM inventory_stock s`
    )
    .all() as Array<{ pid: string; loc: string; stock: number; lots: number }>
  for (const r of rows) {
    // Compared with slack rather than `!==`: a giveaway-flagged product legally
    // sits at 9.75 boxes, and two float sums of the same fractional pieces can
    // differ in the last bit without anything being wrong. Anything a real
    // mismatch could be is orders of magnitude above QTY_EPS.
    if (Math.abs(r.stock - r.lots) > QTY_EPS) {
      throw new Error(`Lot/stock mismatch for ${r.pid}@${r.loc}: stock=${r.stock} lots=${r.lots}`)
    }
  }
}
