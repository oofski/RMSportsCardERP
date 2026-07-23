import type { Database } from 'better-sqlite3'
import { newId } from '../util'

interface Row {
  id: string
  name: string
  upc: string | null
  high_bid: number | null
  unit_cost: number
  category: string
  brand: string
  boxes_per_case: number | null
  created_at: string
}

/**
 * One-time cleanup for legacy databases that accumulated duplicate products
 * across early beta builds (same name showing up twice, one empty). Merges each
 * group of same-name products into a single keeper: combines per-location
 * stock, re-points transactions + images, backfills any field the keeper is
 * missing, then removes the extras. Idempotent — a de-duped catalog is a no-op.
 */
export function dedupeProducts(database: Database): void {
  const products = database
    .prepare(
      `SELECT id, name, upc, high_bid, unit_cost, category, brand, boxes_per_case, created_at
       FROM inventory_products`
    )
    .all() as Row[]

  const byName = new Map<string, Row[]>()
  for (const p of products) {
    const key = p.name.trim().toLowerCase()
    const arr = byName.get(key)
    if (arr) arr.push(p)
    else byName.set(key, [p])
  }

  const stockTotal = (id: string): number =>
    (
      database
        .prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE product_id = ?')
        .get(id) as { q: number }
    ).q

  const bump = database.prepare(
    `INSERT INTO inventory_stock (id, product_id, location, quantity)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_id, location) DO UPDATE SET quantity = quantity + excluded.quantity`
  )

  const run = database.transaction(() => {
    for (const group of byName.values()) {
      if (group.length < 2) continue

      // Keeper: most stock, then has a high bid, then has a UPC, then oldest.
      group.sort((a, b) => {
        const sa = stockTotal(a.id)
        const sb = stockTotal(b.id)
        if (sa !== sb) return sb - sa
        const ha = a.high_bid ? 1 : 0
        const hb = b.high_bid ? 1 : 0
        if (ha !== hb) return hb - ha
        const ua = a.upc ? 1 : 0
        const ub = b.upc ? 1 : 0
        if (ua !== ub) return ub - ua
        return a.created_at < b.created_at ? -1 : 1
      })
      const keeper = group[0]

      for (const dup of group.slice(1)) {
        // 1. Fold the duplicate's stock into the keeper (per location).
        const dupStock = database
          .prepare('SELECT location, quantity FROM inventory_stock WHERE product_id = ?')
          .all(dup.id) as Array<{ location: string; quantity: number }>
        for (const s of dupStock) bump.run(newId(), keeper.id, s.location, s.quantity)

        // 2. Re-point history, images + any incoming shipments to the keeper.
        database.prepare('UPDATE inventory_transactions SET product_id = ? WHERE product_id = ?').run(keeper.id, dup.id)
        database.prepare('UPDATE inventory_product_images SET product_id = ? WHERE product_id = ?').run(keeper.id, dup.id)
        database.prepare('UPDATE inventory_incoming SET product_id = ? WHERE product_id = ?').run(keeper.id, dup.id)

        // 3. Remove the duplicate (frees its UPC before any backfill).
        database.prepare('DELETE FROM inventory_stock WHERE product_id = ?').run(dup.id)
        database.prepare('DELETE FROM inventory_products WHERE id = ?').run(dup.id)

        // 4. Backfill anything the keeper is missing from the duplicate.
        const set: string[] = []
        const params: Record<string, unknown> = { id: keeper.id }
        if (!keeper.upc && dup.upc) {
          set.push('upc = @upc')
          params.upc = dup.upc
          keeper.upc = dup.upc
        }
        if (!keeper.high_bid && dup.high_bid) {
          set.push('high_bid = @high_bid')
          params.high_bid = dup.high_bid
          keeper.high_bid = dup.high_bid
        }
        if (keeper.unit_cost === 0 && dup.unit_cost) {
          set.push('unit_cost = @unit_cost')
          params.unit_cost = dup.unit_cost
          keeper.unit_cost = dup.unit_cost
        }
        if (!keeper.category && dup.category) {
          set.push('category = @category')
          params.category = dup.category
          keeper.category = dup.category
        }
        if (!keeper.brand && dup.brand) {
          set.push('brand = @brand')
          params.brand = dup.brand
          keeper.brand = dup.brand
        }
        if (keeper.boxes_per_case == null && dup.boxes_per_case != null) {
          set.push('boxes_per_case = @boxes_per_case')
          params.boxes_per_case = dup.boxes_per_case
          keeper.boxes_per_case = dup.boxes_per_case
        }
        if (set.length) {
          database.prepare(`UPDATE inventory_products SET ${set.join(', ')} WHERE id = @id`).run(params)
        }
      }
    }
  })
  run()
}
