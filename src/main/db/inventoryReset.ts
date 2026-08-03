/**
 * Mass inventory re-adjustment — the database half.
 *
 * @shared/inventoryReset decides what a pasted count sheet WOULD change; this
 * file supplies the catalog it decides against and performs the write. Nothing
 * here re-derives a decision: apply re-runs the same pure planner against a
 * freshly-read catalog and writes exactly what it returns, so the preview the
 * operator approved and the transaction that runs cannot disagree.
 *
 * The sheet is the whole warehouse. Rows land on their counted numbers and
 * EVERY other shelf in the catalog — every product, at every location — is
 * emptied. Emptying is a real write, not a quantity of zero: stock goes to nil,
 * the shelf's cost layers are retired, the product's average is recomputed from
 * what survives, and a ledger row records the movement. A layer left open on an
 * empty shelf would resurface in the next valuation as stock nobody has.
 *
 * Every quantity move goes through the same primitives as a manual adjustment —
 * bumpStock, createLot, consumeFifo, syncProductAvgCost, insertTxn — so a bulk
 * reset leaves the FIFO ledger in the state a hundred hand adjustments would
 * have. The whole run is ONE transaction: a reset that half-applied would leave
 * a warehouse nobody could reconcile.
 */

import { readFileSync } from 'fs'
import { basename } from 'path'
import type { Location } from '@shared/inventory'
import { LOCATION_IDS } from '@shared/inventory'
import type {
  ParsedSheet,
  ResetApplyResult,
  ResetCatalogProduct,
  ResetField,
  ResetPlan,
  ResetRunSummary
} from '@shared/inventoryReset'
import { buildResetPlan, guessMapping, money, parseSheet } from '@shared/inventoryReset'
import type { Result } from '@shared/types'
import { getDb } from './database'
import { bumpStock, insertTxn, stockQty } from './inventory'
import { consumeFifo, createLot, roundQty, syncProductAvgCost } from './lots'
import { newId, nowIso } from '../util'

type Database = ReturnType<typeof getDb>

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

// ---------------------------------------------------------------------------
// The catalog the planner sees
// ---------------------------------------------------------------------------

/**
 * Every product with its per-location on-hand, shaped for the pure planner.
 *
 * Locations are filled in for ALL of them, present or not, so "RM holds zero"
 * and "RM was never counted" are distinguishable downstream by whether the sheet
 * mentions the shelf — not by whether a stock row happens to exist.
 */
export function resetCatalog(): ResetCatalogProduct[] {
  const db = getDb()
  const products = db
    .prepare(
      `SELECT id, sku, upc, name, category, unit_type, giveaway_item, unit_cost, high_bid
         FROM inventory_products
        ORDER BY name COLLATE NOCASE`
    )
    .all() as Array<{
    id: string
    sku: string
    upc: string | null
    name: string
    category: string
    unit_type: string
    giveaway_item: number
    unit_cost: number
    high_bid: number | null
  }>
  const stock = db.prepare('SELECT product_id, location, quantity FROM inventory_stock').all() as Array<{
    product_id: string
    location: string
    quantity: number
  }>
  // Cost per shelf, straight off the remaining FIFO layers — the same weighting
  // syncProductAvgCost uses, just not collapsed across locations. The planner
  // needs it to say what a one-location revaluation does to the product-wide
  // average.
  const shelfCosts = db
    .prepare(
      `SELECT product_id, location,
              SUM(qty_remaining * unit_cost) / SUM(qty_remaining) AS avg_cost
         FROM inventory_lots
        WHERE qty_remaining > 0
        GROUP BY product_id, location`
    )
    .all() as Array<{ product_id: string; location: string; avg_cost: number }>

  const byProduct = new Map<string, Record<string, number>>()
  for (const s of stock) {
    const entry = byProduct.get(s.product_id) ?? {}
    entry[s.location] = s.quantity
    byProduct.set(s.product_id, entry)
  }
  const costs = new Map<string, Record<string, number>>()
  for (const c of shelfCosts) {
    if (!Number.isFinite(c.avg_cost)) continue
    const entry = costs.get(c.product_id) ?? {}
    entry[c.location] = c.avg_cost
    costs.set(c.product_id, entry)
  }

  return products.map((p) => {
    const held = byProduct.get(p.id) ?? {}
    const quantityByLocation: Record<string, number> = {}
    for (const loc of LOCATION_IDS) quantityByLocation[loc] = held[loc] ?? 0
    for (const [loc, qty] of Object.entries(held)) quantityByLocation[loc] = qty
    const shelfCost = costs.get(p.id) ?? {}
    const costByLocation: Record<string, number> = {}
    // A shelf with stock but no cost layer (pre-FIFO legacy stock) falls back to
    // the product average rather than to zero, which would silently value it at
    // nothing.
    for (const loc of Object.keys(quantityByLocation)) {
      costByLocation[loc] = shelfCost[loc] ?? p.unit_cost
    }
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      upc: p.upc,
      category: p.category,
      unitType: p.unit_type,
      giveawayItem: Number(p.giveaway_item) === 1,
      unitCost: p.unit_cost,
      highBid: p.high_bid,
      quantityByLocation,
      costByLocation
    }
  })
}

/** Distinct categories already in use — the mapping guesser recognises columns by them. */
export function knownCategories(): string[] {
  return (
    getDb()
      .prepare("SELECT DISTINCT category FROM inventory_products WHERE category <> '' ORDER BY category")
      .all() as Array<{ category: string }>
  ).map((r) => r.category)
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ResetPreviewInput {
  text: string
  /** Null on the first call: the guess is returned so the UI can show it. */
  mapping: ResetField[] | null
  defaultLocation?: string
}

export interface ResetPreview {
  sheet: ParsedSheet
  plan: ResetPlan
  /** True when `plan.mapping` was inferred rather than supplied. */
  guessed: boolean
}

function normalizeLocation(raw: string | undefined): Location {
  const up = String(raw ?? '').trim().toUpperCase()
  return (LOCATION_IDS as string[]).includes(up) ? (up as Location) : LOCATION_IDS[0]
}

export function previewReset(input: ResetPreviewInput): ResetPreview {
  const sheet = parseSheet(String(input.text ?? ''))
  const catalog = resetCatalog()
  const supplied = Array.isArray(input.mapping) && input.mapping.length > 0
  const mapping = supplied
    ? sizeMapping(input.mapping as ResetField[], sheet.columns)
    : guessMapping(sheet, knownCategories())
  const plan = buildResetPlan(sheet, mapping, catalog, normalizeLocation(input.defaultLocation))
  return { sheet, plan, guessed: !supplied }
}

/** Pad or trim a supplied mapping to the sheet's real width. */
function sizeMapping(mapping: ResetField[], columns: number): ResetField[] {
  const out: ResetField[] = []
  for (let i = 0; i < columns; i++) out.push(mapping[i] ?? 'ignore')
  return out
}

/** Read a chosen file so the same preview path serves paste and upload alike. */
export function readSheetFile(filePath: string): Result<{ text: string; filename: string }> {
  try {
    return { ok: true, data: { text: readFileSync(filePath, 'utf8'), filename: basename(filePath) } }
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ResetApplyInput extends ResetPreviewInput {
  mapping: ResetField[]
  /** Where the sheet came from, for the run record. */
  source?: string
}

/**
 * Move one shelf to an exact quantity, FIFO-correctly.
 *
 * Up is a found-stock lot valued at `unitCost` (the sheet's cost when it stated
 * one, otherwise the product's current average, so a count that only corrects a
 * quantity does not disturb the basis). Down consumes the oldest layers, exactly
 * as a sale or a shrinkage adjustment does.
 */
function setShelfQuantity(
  db: Database,
  args: {
    productId: string
    location: string
    target: number
    unitCost: number | null
    note: string
    actorId: string | null
  }
): number {
  const before = stockQty(args.productId, args.location)
  const target = roundQty(Math.max(0, args.target), true)
  // 4dp, not cents: a giveaway product moves in fractions of a box and rounding
  // the DELTA to two places would strand dust that the stock/lot invariant then
  // reports as a divergence.
  const delta = roundQty(target - before, true)
  if (delta === 0) return 0
  bumpStock(args.productId, args.location, delta)
  if (delta < 0) {
    consumeFifo(db, args.productId, args.location, -delta)
  } else {
    const row = db.prepare('SELECT unit_cost FROM inventory_products WHERE id = ?').get(args.productId) as
      | { unit_cost: number }
      | undefined
    const cost = args.unitCost != null && args.unitCost >= 0 ? args.unitCost : (row?.unit_cost ?? 0)
    createLot(db, args.productId, args.location, delta, cost, nowIso(), 'adjustment', args.note)
  }
  syncProductAvgCost(db, args.productId)
  insertTxn(args.productId, 'adjustment', delta, null, null, args.note, args.actorId, args.location)
  return delta
}

/** Open cost quantity sitting on one shelf. */
function openLotQty(db: Database, productId: string, location: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_remaining), 0) AS q FROM inventory_lots
        WHERE product_id = ? AND location = ? AND qty_remaining > 0`
    )
    .get(productId, location) as { q: number }
  return row.q
}

/**
 * Empty one shelf completely — stock, cost layers and ledger.
 *
 * This is the destructive half of a baseline count, and it is deliberately NOT
 * setShelfQuantity(target 0):
 *
 *  - The stock move is written as the EXACT negative of what is on the shelf,
 *    never routed through roundQty. A giveaway product legitimately sits at 9.75
 *    boxes; a target-and-delta calculation that rounded anywhere would leave a
 *    tenth of a box behind, or invent one.
 *
 *  - The layers are retired outright rather than walked FIFO. consumeFifo THROWS
 *    when the open layers cannot cover the stock — which is the right answer for
 *    a sale, and the wrong one here: a single shelf carrying pre-FIFO stock with
 *    no layer would abort a run that is emptying three hundred products, and
 *    nothing would be written at all. Emptying is also the one case where FIFO
 *    order is irrelevant, because every layer is going.
 *
 *  - It sweeps a shelf whose stock is ALREADY zero but still carries an open
 *    layer. That layer is an orphan; left alone it keeps weighting the product's
 *    average cost and quietly values stock nobody has.
 *
 * qty_remaining goes to 0 rather than the row being deleted, exactly as
 * consumeFifo leaves a spent layer: qty_received survives, so what was once on
 * this shelf is still readable.
 *
 * Returns the quantity that came off (0 when there was nothing to do).
 */
function zeroShelf(
  db: Database,
  args: { productId: string; location: string; note: string; actorId: string | null }
): number {
  const before = stockQty(args.productId, args.location)
  const open = openLotQty(db, args.productId, args.location)
  if (before === 0 && open === 0) return 0

  if (before !== 0) bumpStock(args.productId, args.location, -before)
  db.prepare(
    `UPDATE inventory_lots SET qty_remaining = 0
      WHERE product_id = ? AND location = ? AND qty_remaining > 0`
  ).run(args.productId, args.location)
  // After the layers, never before: the average has to be recomputed from what
  // actually survives, and at this point what survives is the product's OTHER
  // locations only.
  syncProductAvgCost(db, args.productId)
  if (before !== 0) {
    insertTxn(args.productId, 'adjustment', -before, null, null, args.note, args.actorId, args.location)
  }
  return before
}

/**
 * Re-value the cost layers a count says are worth something else.
 *
 * A physical count that restates cost is a REVALUATION, not a purchase: the same
 * units are still on the shelf, they are just carried at a different number. So
 * the remaining layers at that location are re-based to the counted unit cost
 * and the product's average is recomputed from them — no phantom receipt, no
 * quantity movement, and `Σ lot.qty_remaining == inventory_stock.quantity` holds
 * throughout.
 *
 * Scoped to the counted LOCATION. A product also held somewhere the sheet did
 * not count keeps that shelf's basis until the zero sweep empties it, at which
 * point the average is recomputed again and lands on the counted cost alone.
 */
function revalueShelf(
  db: Database,
  productId: string,
  location: string,
  unitCost: number
): boolean {
  const cost = money(Math.max(0, unitCost))
  const info = db
    .prepare(
      `UPDATE inventory_lots SET unit_cost = ?
        WHERE product_id = ? AND location = ? AND qty_remaining > 0`
    )
    .run(cost, productId, location)
  if (info.changes > 0) {
    syncProductAvgCost(db, productId)
    return true
  }
  // Stock with no cost layer at all — pre-FIFO stock that predates the backfill.
  // There is nothing to re-base, so the counted cost BECOMES the layer. Without
  // this the shelf would keep an invisible basis the sheet just overruled, and
  // the dashboard would read a number the operator never pasted.
  const qty = stockQty(productId, location)
  if (!(qty > 0)) return false
  createLot(db, productId, location, qty, cost, nowIso(), 'backfill', 'Counted cost — no prior cost layer')
  syncProductAvgCost(db, productId)
  return true
}

export function applyReset(input: ResetApplyInput, actorId: string | null): Result<ResetApplyResult> {
  const text = String(input.text ?? '')
  if (!text.trim()) return { ok: false, error: 'Nothing to apply — paste or choose a sheet first.' }

  const sheet = parseSheet(text)
  const defaultLocation = normalizeLocation(input.defaultLocation)
  const mapping = sizeMapping(input.mapping ?? [], sheet.columns)

  const db = getDb()
  const run = db.transaction((): Result<ResetApplyResult> => {
    // Re-plan against the catalog as it is RIGHT NOW, inside the transaction, so
    // nothing that changed between preview and apply is written blind.
    const catalog = resetCatalog()
    const plan = buildResetPlan(sheet, mapping, catalog, defaultLocation)
    if (plan.problems.length > 0) return { ok: false, error: plan.problems[0] }

    const applied: string[] = []
    let rowsApplied = 0
    let shelvesZeroed = 0
    const stamp = nowIso()
    const note = `Bulk inventory reset ${stamp.slice(0, 10)}`
    /** Every (product, location) the sheet spoke for. Everything else empties. */
    const counted = new Set<string>()

    for (const row of plan.rows) {
      if (!row.productId) continue
      counted.add(`${row.productId}::${row.location}`)
      if (row.status !== 'change') continue

      const parts: string[] = []
      if (row.quantityAfter != null && row.quantityAfter !== row.quantityBefore) {
        // A row that counts ZERO empties the shelf by the same route an uncounted
        // one does. Same retirement of the layers, and the same immunity to a
        // pre-FIFO shelf whose layers cannot cover its stock — a FIFO walk down
        // to nothing would throw there and take the whole run with it.
        const delta =
          row.quantityAfter === 0
            ? -zeroShelf(db, { productId: row.productId, location: row.location, note, actorId })
            : setShelfQuantity(db, {
                productId: row.productId,
                location: row.location,
                // The SHELF's counted cost, not the product average: found stock
                // is valued at what the count says this shelf is worth.
                unitCost: row.shelfCostAfter,
                target: row.quantityAfter,
                note,
                actorId
              })
        if (delta !== 0) {
          parts.push(`${row.location} ${row.quantityBefore ?? 0} → ${row.quantityAfter}`)
        }
      }
      // Re-base against the shelf's counted cost; row.costAfter is the product
      // average that results, and is only used for the log line.
      if (row.shelfCostAfter != null) {
        if (revalueShelf(db, row.productId, row.location, row.shelfCostAfter)) {
          if (money(row.costAfter ?? 0) !== money(row.costBefore ?? 0)) {
            parts.push(`cost ${money(row.costBefore ?? 0)} → ${money(row.costAfter ?? 0)}`)
          }
        }
      }
      if (row.marketAfter != null && row.marketAfter !== row.marketBefore) {
        db.prepare(
          'UPDATE inventory_products SET high_bid = ?, high_bid_at = ?, updated_at = ? WHERE id = ?'
        ).run(money(row.marketAfter), stamp, stamp, row.productId)
        parts.push(`market ${money(row.marketBefore ?? 0)} → ${money(row.marketAfter)}`)
      }
      if (parts.length > 0) {
        rowsApplied++
        applied.push(`${row.productName}: ${parts.join(', ')}`)
      }
    }

    // ---- The sheet is the whole warehouse -----------------------------------
    //
    // Every shelf of every catalog product that this sheet did not name is
    // emptied. Swept over the FULL location set rather than over plan.missing,
    // because plan.missing only knows about shelves carrying a positive
    // quantity: a shelf sitting at zero with an open cost layer still poisons
    // the product's average cost, and a shelf at a location the catalog snapshot
    // has never seen still has to be asked about. zeroShelf is a no-op on a
    // shelf that is already empty in both senses, so the cost of asking is one
    // indexed lookup per shelf.
    //
    // Runs AFTER the counted rows on purpose: found stock valued at "the current
    // average" is then valued at the average as it stood before the write-off,
    // and every zeroShelf re-syncs the average behind it, so the last word on
    // each product's cost is spoken with the final lot state in view.
    const zeroNote = `${note} — not on the count sheet`
    for (const product of catalog) {
      for (const location of Object.keys(product.quantityByLocation)) {
        if (counted.has(`${product.id}::${location}`)) continue
        const removed = zeroShelf(db, { productId: product.id, location, note: zeroNote, actorId })
        if (removed !== 0) {
          shelvesZeroed++
          applied.push(`${product.name}: ${location} ${removed} → 0 (not counted)`)
        }
      }
    }

    const summary: ResetRunSummary = {
      id: newId(),
      source: String(input.source ?? 'Pasted sheet').slice(0, 200),
      rowsTotal: plan.counts.total,
      rowsApplied,
      // Always 0 now: a row the planner could not read blocks the run outright,
      // so nothing reaches this point half-understood. Kept because the history
      // table shows runs from before that was true.
      rowsSkipped: plan.counts.unmatched + plan.counts.ambiguous + plan.counts.invalid,
      // Likewise: this operation never creates a product. Historical runs did.
      productsCreated: 0,
      shelvesZeroed,
      unitsBefore: plan.totals.unitsBefore,
      unitsAfter: plan.totals.unitsAfter,
      costBefore: plan.totals.costBefore,
      costAfter: plan.totals.costAfter,
      marketBefore: plan.totals.marketBefore,
      marketAfter: plan.totals.marketAfter,
      createdAt: stamp,
      createdBy: actorId,
      actorName: null
    }
    db.prepare(
      `INSERT INTO inventory_resets
         (id, source, rows_total, rows_applied, rows_skipped, products_created, shelves_zeroed,
          units_before, units_after, cost_before, cost_after, market_before, market_after,
          options_json, detail_json, created_at, created_by)
       VALUES
         (@id, @source, @rows_total, @rows_applied, @rows_skipped, @products_created, @shelves_zeroed,
          @units_before, @units_after, @cost_before, @cost_after, @market_before, @market_after,
          @options_json, @detail_json, @created_at, @created_by)`
    ).run({
      id: summary.id,
      source: summary.source,
      rows_total: summary.rowsTotal,
      rows_applied: summary.rowsApplied,
      rows_skipped: summary.rowsSkipped,
      products_created: summary.productsCreated,
      shelves_zeroed: summary.shelvesZeroed,
      units_before: summary.unitsBefore,
      units_after: summary.unitsAfter,
      cost_before: summary.costBefore,
      cost_after: summary.costAfter,
      market_before: summary.marketBefore,
      market_after: summary.marketAfter,
      // There are no options left to record. The marker is written anyway so a
      // run made under the baseline rule is distinguishable in the history from
      // one made when this screen still had six checkboxes — those rows carry
      // the flags they ran with, and reading them as a baseline would be wrong.
      options_json: JSON.stringify({ mode: 'baseline' }),
      // Capped: the record is a summary, not a second copy of the sheet.
      detail_json: JSON.stringify(applied.slice(0, 500)),
      created_at: summary.createdAt,
      created_by: summary.createdBy
    })

    return { ok: true, data: { run: summary, applied } }
  })

  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function listResetRuns(limit = 12): ResetRunSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT r.*, (e.first_name || ' ' || e.last_name) AS actor_name
         FROM inventory_resets r
         LEFT JOIN employees e ON e.id = r.created_by
        ORDER BY r.created_at DESC
        LIMIT ?`
    )
    .all(Math.max(1, Math.min(100, Math.round(limit)))) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: String(r.id),
    source: String(r.source ?? ''),
    rowsTotal: Number(r.rows_total ?? 0),
    rowsApplied: Number(r.rows_applied ?? 0),
    rowsSkipped: Number(r.rows_skipped ?? 0),
    productsCreated: Number(r.products_created ?? 0),
    shelvesZeroed: Number(r.shelves_zeroed ?? 0),
    unitsBefore: Number(r.units_before ?? 0),
    unitsAfter: Number(r.units_after ?? 0),
    costBefore: Number(r.cost_before ?? 0),
    costAfter: Number(r.cost_after ?? 0),
    marketBefore: Number(r.market_before ?? 0),
    marketAfter: Number(r.market_after ?? 0),
    createdAt: String(r.created_at ?? ''),
    createdBy: r.created_by == null ? null : String(r.created_by),
    actorName: r.actor_name == null ? null : String(r.actor_name)
  }))
}

/** What one run actually moved, as it was recorded. */
export function resetRunDetail(id: string): string[] {
  const row = getDb().prepare('SELECT detail_json FROM inventory_resets WHERE id = ?').get(id) as
    | { detail_json: string }
    | undefined
  if (!row) return []
  try {
    const parsed = JSON.parse(row.detail_json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXPORT_HEADER = [
  'Product',
  'SKU',
  'Category',
  'UPC',
  'Location',
  'Quantity',
  'Market value',
  'Market total',
  'Cost',
  'Cost total'
]

/**
 * The current count, in exactly the shape this screen reads back.
 *
 * That round trip is the point: export, count against it in Excel, paste the
 * result back. The header row is written so the mapping is recognised without
 * anybody having to set it, and the file is TAB-separated because the money
 * columns carry thousands separators that would break a CSV the moment somebody
 * saved it out of Excel.
 */
export function buildResetExport(): string {
  const rows = getDb()
    .prepare(
      // The cost written out is the SHELF's, not the product-wide average, so a
      // product split across RM and AM exports the two costs it actually
      // carries — and re-importing the file unchanged is a no-op rather than a
      // quiet revaluation of both shelves to their blend.
      `SELECT p.name, p.sku, p.category, p.upc, s.location, s.quantity,
              p.unit_cost, p.high_bid,
              (SELECT SUM(l.qty_remaining * l.unit_cost) / SUM(l.qty_remaining)
                 FROM inventory_lots l
                WHERE l.product_id = s.product_id
                  AND l.location = s.location
                  AND l.qty_remaining > 0) AS shelf_cost
         FROM inventory_stock s
         JOIN inventory_products p ON p.id = s.product_id
        WHERE s.quantity <> 0
        ORDER BY p.category, p.name COLLATE NOCASE, s.location`
    )
    .all() as Array<{
    name: string
    sku: string
    category: string
    upc: string | null
    location: string
    quantity: number
    unit_cost: number
    high_bid: number | null
    shelf_cost: number | null
  }>
  const lines = [EXPORT_HEADER.join('\t')]
  for (const r of rows) {
    // A product with no high bid exports a BLANK market cell, not its cost.
    // The dashboard values unpriced stock at cost for display, but writing that
    // number into a count sheet would hand it straight back on the next import
    // as a market value somebody had supposedly set — inventing priced data out
    // of unpriced data, which is precisely what this screen exists to prevent.
    const market = r.high_bid && r.high_bid > 0 ? r.high_bid : null
    const cost =
      r.shelf_cost != null && Number.isFinite(r.shelf_cost) ? r.shelf_cost : r.unit_cost
    lines.push(
      [
        r.name,
        r.sku,
        r.category,
        r.upc ?? '',
        r.location,
        String(r.quantity),
        market == null ? '' : market.toFixed(2),
        market == null ? '' : money(market * r.quantity).toFixed(2),
        cost.toFixed(2),
        money(cost * r.quantity).toFixed(2)
      ]
        // A tab or newline inside a product name would shift every column to its
        // right by one; there is no quoting in TSV, so they are stripped.
        .map((cell) => String(cell).replace(/[\t\r\n]+/g, ' '))
        .join('\t')
    )
  }
  return lines.join('\n')
}
