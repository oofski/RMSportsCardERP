import type { Database } from 'better-sqlite3'
import { newId } from '../util'

interface Row {
  id: string
  name: string
  sku: string | null
  upc: string | null
  high_bid: number | null
  unit_cost: number
  category: string
  brand: string
  boxes_per_case: number | null
  created_at: string
}

/**
 * Every table that points at a product, and has to follow it into the merge.
 *
 * THE LIST BEING SHORT IS WHAT MADE THIS DANGEROUS. Four of these were
 * re-pointed and the rest were not — and `purchase_order_lines.product_id` is
 * `ON DELETE CASCADE`, so merging two products SILENTLY DELETED THE LINES OF
 * EVERY PURCHASE ORDER that had bought the losing one. The order survived with
 * its stored total intact and nothing on it, which reads as a data-entry mistake
 * rather than as damage, so nobody would look here for the cause.
 *
 * The other three are quieter and still wrong: `inventory_scans` and
 * `stream_items` are `ON DELETE SET NULL`, so a scan or a giveaway forgets which
 * box it was; `invoice_lines` and `ledger_rows` carry a product_id with no
 * foreign key at all, so theirs was left dangling at an id that no longer
 * exists.
 *
 * Anything added later that references a product belongs in this list. The
 * existence check below is what keeps that safe rather than fatal: this runs as
 * a migration, at a fixed point in the schema's history, and a table added after
 * it simply is not there yet.
 */
const PRODUCT_REFS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'inventory_transactions', column: 'product_id' },
  { table: 'inventory_product_images', column: 'product_id' },
  { table: 'inventory_incoming', column: 'product_id' },
  { table: 'inventory_lots', column: 'product_id' },
  { table: 'purchase_order_lines', column: 'product_id' },
  { table: 'inventory_scans', column: 'product_id' },
  { table: 'stream_items', column: 'product_id' },
  { table: 'invoice_lines', column: 'product_id' },
  { table: 'ledger_rows', column: 'product_id' }
]

function hasColumn(database: Database, table: string, column: string): boolean {
  try {
    const info = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return info.some((c) => c.name === column)
  } catch {
    return false
  }
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase()
}

/**
 * May these two rows be treated as one product?
 *
 * ONLY IF NOTHING THEY BOTH CARRY DISAGREES. Grouping by name alone was the
 * whole rule, and a name is not an identity: "2025 Topps Series 1 Hobby Box" is
 * the name of several genuinely different boxes, and two of them with different
 * UPCs were merged into one — pooling two products' stock onto one shelf, and
 * pooling their FIFO cost lots so the surviving product's cost basis became a
 * blend of two things that never cost the same.
 *
 * A UPC or a SKU is the identity. Where both rows have one and the two disagree,
 * they are different products with the same name and this leaves them alone. A
 * blank on either side is not evidence of anything, so it does not block the
 * merge — that is the legacy shape this cleanup exists for: one full row and one
 * empty one, created twice by an early build.
 */
function sameProduct(a: Row, b: Row): boolean {
  if (a.upc && b.upc && norm(a.upc) !== norm(b.upc)) return false
  if (a.sku && b.sku && norm(a.sku) !== norm(b.sku)) return false
  return true
}

/**
 * One-time cleanup for legacy databases that accumulated duplicate products
 * across early beta builds (same name showing up twice, one empty). Merges each
 * group of same-name products into a single keeper: combines per-location
 * stock, re-points everything that points at the loser, backfills any field the
 * keeper is missing, then removes the extras. Idempotent — a de-duped catalog is
 * a no-op.
 *
 * Same name is the CANDIDATE test, never the verdict. See `sameProduct`.
 */
export function dedupeProducts(database: Database): void {
  const products = database
    .prepare(
      `SELECT id, name, sku, upc, high_bid, unit_cost, category, brand, boxes_per_case, created_at
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

  // Resolved once, against the schema as it stands at this point in the
  // migration history, rather than per product per table.
  const refs = PRODUCT_REFS.filter((r) => hasColumn(database, r.table, r.column)).map((r) => ({
    ...r,
    stmt: database.prepare(`UPDATE ${r.table} SET ${r.column} = ? WHERE ${r.column} = ?`)
  }))

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
        // 0. SAME NAME IS NOT SAME PRODUCT. A disagreeing UPC or SKU means these
        //    are two different boxes that happen to be called the same thing,
        //    and merging them would pool two shelves and blend two cost bases.
        if (!sameProduct(keeper, dup)) continue

        // 1. Fold the duplicate's stock into the keeper (per location).
        const dupStock = database
          .prepare('SELECT location, quantity FROM inventory_stock WHERE product_id = ?')
          .all(dup.id) as Array<{ location: string; quantity: number }>
        for (const s of dupStock) bump.run(newId(), keeper.id, s.location, s.quantity)

        // 2. Move EVERYTHING that points at the loser. Anything left behind is
        //    either cascade-deleted or orphaned by the delete below.
        for (const ref of refs) ref.stmt.run(keeper.id, dup.id)

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
        // The SKU travels for the same reason the UPC does, and the assignment
        // back onto `keeper` matters as much as the column: the next duplicate in
        // this group is tested against the keeper AS IT NOW STANDS, so a SKU
        // picked up here will correctly block a merge with a third row carrying a
        // different one.
        if (!keeper.sku && dup.sku) {
          set.push('sku = @sku')
          params.sku = dup.sku
          keeper.sku = dup.sku
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
