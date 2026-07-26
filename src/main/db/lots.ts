import type { Database } from 'better-sqlite3'
import { newId, nowIso } from '../util'

/**
 * FIFO cost-lot engine. Every stock-in creates a dated "lot" (a batch bought at
 * a unit cost); sales and negative adjustments consume the oldest lots first.
 * The product's `unit_cost` is kept as the weighted average of the *remaining*
 * lots, so all existing money queries (value, cost, spread) stay correct.
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

/** Insert one cost lot (qty_received === qty_remaining === qty). Returns the new
 * lot's id (empty string when nothing was inserted) so a caller can record
 * exactly which cost layer a receipt created and reverse that one later. */
export function createLot(
  db: Database,
  productId: string,
  location: string,
  qty: number,
  unitCost: number,
  receivedAt: string,
  source: LotSource,
  note: string | null
): string {
  const q = Math.round(qty)
  if (q <= 0) return ''
  const id = newId()
  db.prepare(
    `INSERT INTO inventory_lots
       (id, product_id, location, qty_received, qty_remaining, unit_cost, received_at, source, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, productId, location, q, q, cents(Math.max(0, unitCost)), receivedAt, source, note, nowIso())
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
  const q = Math.round(qty)
  if (q <= 0) return
  const lot = db
    .prepare('SELECT qty_received, qty_remaining FROM inventory_lots WHERE id = ?')
    .get(lotId) as { qty_received: number; qty_remaining: number } | undefined
  if (!lot) throw new Error('That cost lot no longer exists.')
  if (lot.qty_remaining < q) {
    throw new Error('Some of that stock has already been sold — adjust it manually instead.')
  }
  if (lot.qty_received - q <= 0) {
    db.prepare('DELETE FROM inventory_lots WHERE id = ?').run(lotId)
    return
  }
  db.prepare(
    'UPDATE inventory_lots SET qty_received = qty_received - ?, qty_remaining = qty_remaining - ? WHERE id = ?'
  ).run(q, q, lotId)
}

/**
 * Consume `qty` units from a product's open lots at a location, oldest first.
 * Returns the consumed slices (for COGS). Throws if the lots can't cover `qty`
 * — callers already guard on stock, so a throw rolls the transaction back.
 */
export function consumeFifo(db: Database, productId: string, location: string, qty: number): LotSlice[] {
  let need = Math.round(qty)
  if (need <= 0) return []
  const lots = db
    .prepare(
      `SELECT id, qty_remaining, unit_cost FROM inventory_lots
       WHERE product_id = ? AND location = ? AND qty_remaining > 0
       ORDER BY received_at ASC, rowid ASC`
    )
    .all(productId, location) as Array<{ id: string; qty_remaining: number; unit_cost: number }>
  const dec = db.prepare('UPDATE inventory_lots SET qty_remaining = qty_remaining - ? WHERE id = ?')
  const slices: LotSlice[] = []
  for (const lot of lots) {
    if (need <= 0) break
    const take = Math.min(need, lot.qty_remaining)
    dec.run(take, lot.id)
    slices.push({ lotId: lot.id, qty: take, unitCost: lot.unit_cost })
    need -= take
  }
  if (need > 0) {
    throw new Error(`Not enough cost lots to consume ${qty} at ${location} (short ${need}).`)
  }
  return slices
}

/** Weighted average cost of the remaining lots across all locations (0 if none). */
export function lotWeightedAvgCost(db: Database, productId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_remaining), 0) AS q, COALESCE(SUM(qty_remaining * unit_cost), 0) AS c
       FROM inventory_lots WHERE product_id = ?`
    )
    .get(productId) as { q: number; c: number }
  return row.q > 0 ? cents(row.c / row.q) : 0
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
    if (r.stock !== r.lots) {
      throw new Error(`Lot/stock mismatch for ${r.pid}@${r.loc}: stock=${r.stock} lots=${r.lots}`)
    }
  }
}
