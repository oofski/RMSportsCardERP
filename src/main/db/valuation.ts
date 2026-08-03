import type { Database } from 'better-sqlite3'
import { QTY_EPS } from './lots'

/**
 * What the stock on the shelf is worth — the one definition, in one place.
 *
 * THE COST LAYERS ARE THE TRUTH. A product's cost basis is the sum of what its
 * open FIFO layers cost: Σ (qty_remaining × unit_cost). That sum is exact by
 * construction, because every layer records what was actually paid for the units
 * still sitting in it.
 *
 * The product's stored `unit_cost` is the AVERAGE of those layers, and an
 * average is a derived, per-unit display number — the price tag on one box, the
 * figure a pricing decision is made against. It is not the source of a total.
 * Reconstructing a total as on-hand × average multiplies the average's rounding
 * error by the quantity: three boxes at $10.00 and four at $20.00 is $110.00 of
 * stock, but the average is $15.7142…, and seven of those reads $109.97. The
 * error is not fixable by storing more decimals — 110/7 does not terminate — so
 * every TOTAL in this app reads the layers and only per-unit figures read the
 * average.
 *
 * Two things have to be true for that to be safe, and both are handled here:
 *
 *  - STOCK WITH NO LAYERS still has to be worth something. Pre-FIFO shelves
 *    predate the lot engine, and `backfillLots` is a one-time migration rather
 *    than a standing guarantee — `revalueShelf` in inventoryReset.ts has a live
 *    branch for a shelf that has stock and no layer at all. A layer-sourced
 *    total that valued those at zero would report real stock as worth nothing,
 *    which is a far worse failure than the rounding it replaced. So a shelf with
 *    no layers falls back to the product's stored average, exactly as
 *    `resetCatalog` already does when it builds costByLocation.
 *
 *  - Σ layers CAN DISAGREE WITH stock. The engine preserves the invariant, but
 *    an orphan layer on an emptied shelf is a real state (zeroShelf exists to
 *    sweep them) and a half-backfilled shelf is conceivable. When the two
 *    disagree, the QUANTITY on screen wins and the layers supply only the price:
 *    a shelf is always valued for exactly the units inventory_stock says are on
 *    it, at the layers' weighted unit cost. So an orphan layer on an empty shelf
 *    contributes nothing (it is stock nobody has), and stock beyond its layers
 *    is still valued rather than silently dropped. The disagreement is then
 *    reported by `layerGaps()` instead of being absorbed into a total nobody can
 *    see inside.
 *
 * Everything is a SQL fragment rather than a function returning rows, so a
 * caller can join it into its own GROUP BY and there is one arithmetic for the
 * whole app to be wrong or right together.
 */

/**
 * One row per (product, location) that holds stock OR an open layer, with what
 * that shelf is worth.
 *
 * Driven off the UNION of both tables rather than off inventory_stock alone: a
 * shelf carrying an open layer and no stock row is precisely the orphan case,
 * and it has to be visible to `layerGaps` even though it contributes no value.
 *
 * `cost_value` is written as quantity × (layer value ÷ layer quantity) rather
 * than as the layer value directly. Where the invariant holds the two are the
 * same number; where it does not, this one is still the value of what is on the
 * shelf. It is also, deliberately, the identical arithmetic `resetCatalog`
 * performs to build costByLocation — same division, same multiplication, same
 * doubles — so the reset preview's promised totals and this cannot drift.
 */
export const SHELF_BASIS = `
  SELECT k.product_id                AS product_id,
         k.location                  AS location,
         COALESCE(s.quantity, 0)     AS qty,
         COALESCE(l.lot_qty, 0)      AS lot_qty,
         CASE WHEN COALESCE(l.lot_qty, 0) > 0
              THEN l.lot_value / l.lot_qty
              ELSE NULL
         END                         AS lot_basis,
         CASE WHEN COALESCE(l.lot_qty, 0) > 0
              THEN COALESCE(s.quantity, 0) * (l.lot_value / l.lot_qty)
              ELSE COALESCE(s.quantity, 0) * p.unit_cost
         END                         AS cost_value
    FROM (SELECT product_id, location FROM inventory_stock
          UNION
          SELECT product_id, location FROM inventory_lots WHERE qty_remaining > 0) k
    JOIN inventory_products p ON p.id = k.product_id
    LEFT JOIN inventory_stock s
      ON s.product_id = k.product_id AND s.location = k.location
    LEFT JOIN (SELECT product_id, location,
                      SUM(qty_remaining)             AS lot_qty,
                      SUM(qty_remaining * unit_cost) AS lot_value
                 FROM inventory_lots
                WHERE qty_remaining > 0
                GROUP BY product_id, location) l
      ON l.product_id = k.product_id AND l.location = k.location
`

/** The same thing rolled up per product — the cost basis of everything on hand. */
export const PRODUCT_BASIS = `
  SELECT product_id, SUM(cost_value) AS cost_value, SUM(qty) AS qty
    FROM (${SHELF_BASIS})
   GROUP BY product_id
`

/**
 * A shelf whose cost layers and counted stock do not agree.
 *
 * Surfaced rather than swallowed. Both directions are wrong in a way somebody
 * has to fix: stock above the layers is carried on the product's average instead
 * of a real purchase price, and layers above the stock are cost basis attached
 * to units that are not there. Either way the valuation follows `quantity`, so
 * the tile is never a number the stock column contradicts — but a valuation that
 * quietly disagrees with the count beside it is exactly the kind of thing that
 * goes unnoticed for a quarter, so it is listed.
 */
export interface LayerGap {
  id: string
  name: string
  location: string
  /** On hand at that location, per inventory_stock. */
  quantity: number
  /** What the open layers there account for. */
  lotQuantity: number
  /** The per-unit basis the valuation used for this shelf. */
  unitBasis: number
  /** What the shelf contributes to every total — always for `quantity` units. */
  value: number
}

export function layerGaps(db: Database): LayerGap[] {
  const rows = db
    .prepare(
      `SELECT b.product_id AS id, p.name AS name, b.location AS location,
              b.qty AS qty, b.lot_qty AS lot_qty, b.lot_basis AS lot_basis,
              b.cost_value AS cost_value, p.unit_cost AS unit_cost
         FROM (${SHELF_BASIS}) b
         JOIN inventory_products p ON p.id = b.product_id
        WHERE ABS(b.qty - b.lot_qty) > ?
        ORDER BY ABS(b.qty - b.lot_qty) DESC, p.name COLLATE NOCASE`
    )
    .all(QTY_EPS) as Array<{
    id: string
    name: string
    location: string
    qty: number
    lot_qty: number
    lot_basis: number | null
    cost_value: number
    unit_cost: number
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    location: r.location,
    quantity: r.qty,
    lotQuantity: r.lot_qty,
    unitBasis: r.lot_basis ?? r.unit_cost,
    value: r.cost_value
  }))
}

/** Cost basis of everything on hand for one product (0 when it holds nothing). */
export function productCostValue(db: Database, productId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_value), 0) AS v FROM (${SHELF_BASIS}) WHERE product_id = ?`
    )
    .get(productId) as { v: number }
  return row.v
}

/** Cost basis of everything on hand, keyed by product — for list queries. */
export function allCostValues(db: Database): Map<string, number> {
  const rows = db.prepare(PRODUCT_BASIS).all() as Array<{ product_id: string; cost_value: number }>
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.product_id, r.cost_value)
  return map
}

export interface ShelfBasis {
  quantity: number
  lotQuantity: number
  /**
   * The layers' weighted unit cost at this shelf, or null when it has none.
   * This is the same expression `resetCatalog` reads into costByLocation, so a
   * found-stock lot opened at it and the preview that predicted it agree.
   */
  lotBasis: number | null
  /** What the shelf is worth — for the units inventory_stock says are on it. */
  value: number
}

/**
 * Cost basis of one shelf — what a found-stock lot at that location should be
 * valued at, and what the count-sheet export writes out.
 */
export function shelfBasis(db: Database, productId: string, location: string): ShelfBasis | null {
  const row = db
    .prepare(`SELECT * FROM (${SHELF_BASIS}) WHERE product_id = ? AND location = ?`)
    .get(productId, location) as
    | { qty: number; lot_qty: number; lot_basis: number | null; cost_value: number }
    | undefined
  if (!row) return null
  return {
    quantity: row.qty,
    lotQuantity: row.lot_qty,
    lotBasis: row.lot_basis,
    value: row.cost_value
  }
}
