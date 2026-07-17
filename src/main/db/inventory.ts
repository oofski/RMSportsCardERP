import type {
  CategoryValue,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  NewInventoryProduct,
  SalesPoint,
  UnitType,
  UpdateInventoryProduct
} from '@shared/types'
import { getDb } from './database'
import { newId, nowIso } from '../util'

interface ProductRow {
  id: string
  sku: string
  name: string
  category: string
  brand: string
  set_name: string
  year: string
  unit_type: string
  quantity: number
  unit_cost: number
  sale_price: number | null
  boxes_per_case: number | null
  packs_per_box: number | null
  reorder_point: number
  notes: string | null
  created_at: string
  updated_at: string
}

const UNIT_TYPES: UnitType[] = ['case', 'box', 'pack', 'single', 'other']

function toProduct(row: ProductRow): InventoryProduct {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    brand: row.brand,
    setName: row.set_name,
    year: row.year,
    unitType: (UNIT_TYPES.includes(row.unit_type as UnitType) ? row.unit_type : 'other') as UnitType,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    salePrice: row.sale_price,
    boxesPerCase: row.boxes_per_case,
    packsPerBox: row.packs_per_box,
    reorderPoint: row.reorder_point,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listProducts(): InventoryProduct[] {
  const rows = getDb()
    .prepare('SELECT * FROM inventory_products ORDER BY name COLLATE NOCASE')
    .all() as ProductRow[]
  return rows.map(toProduct)
}

export function getProduct(id: string): InventoryProduct | null {
  const row = getDb().prepare('SELECT * FROM inventory_products WHERE id = ?').get(id) as
    | ProductRow
    | undefined
  return row ? toProduct(row) : null
}

export function skuExists(sku: string, exceptId?: string): boolean {
  const row = getDb()
    .prepare('SELECT id FROM inventory_products WHERE sku = ? COLLATE NOCASE')
    .get(sku.trim()) as { id: string } | undefined
  return !!row && row.id !== exceptId
}

export function createProduct(
  input: NewInventoryProduct,
  actorId: string | null
): InventoryProduct {
  const db = getDb()
  const id = newId()
  const ts = nowIso()

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO inventory_products
         (id, sku, name, category, brand, set_name, year, unit_type, quantity,
          unit_cost, sale_price, boxes_per_case, packs_per_box, reorder_point,
          notes, created_at, updated_at)
       VALUES
         (@id, @sku, @name, @category, @brand, @set_name, @year, @unit_type, @quantity,
          @unit_cost, @sale_price, @boxes_per_case, @packs_per_box, @reorder_point,
          @notes, @created_at, @updated_at)`
    ).run({
      id,
      sku: input.sku.trim(),
      name: input.name.trim(),
      category: input.category.trim(),
      brand: input.brand.trim(),
      set_name: input.setName.trim(),
      year: input.year.trim(),
      unit_type: input.unitType,
      quantity: Math.max(0, Math.round(input.quantity)),
      unit_cost: Math.max(0, input.unitCost),
      sale_price: input.salePrice,
      boxes_per_case: input.boxesPerCase,
      packs_per_box: input.packsPerBox,
      reorder_point: Math.max(0, Math.round(input.reorderPoint)),
      notes: input.notes,
      created_at: ts,
      updated_at: ts
    })

    // Record the opening stock as a purchase so history is complete.
    if (input.quantity > 0) {
      insertTxn(id, 'purchase', Math.round(input.quantity), input.unitCost, null, 'Opening stock', actorId)
    }
  })
  create()

  return getProduct(id) as InventoryProduct
}

export function updateProduct(input: UpdateInventoryProduct): InventoryProduct | null {
  const existing = getProduct(input.id)
  if (!existing) return null
  const next = {
    sku: (input.sku ?? existing.sku).trim(),
    name: (input.name ?? existing.name).trim(),
    category: (input.category ?? existing.category).trim(),
    brand: (input.brand ?? existing.brand).trim(),
    set_name: (input.setName ?? existing.setName).trim(),
    year: (input.year ?? existing.year).trim(),
    unit_type: input.unitType ?? existing.unitType,
    unit_cost: input.unitCost != null ? Math.max(0, input.unitCost) : existing.unitCost,
    sale_price: input.salePrice !== undefined ? input.salePrice : existing.salePrice,
    boxes_per_case: input.boxesPerCase !== undefined ? input.boxesPerCase : existing.boxesPerCase,
    packs_per_box: input.packsPerBox !== undefined ? input.packsPerBox : existing.packsPerBox,
    reorder_point:
      input.reorderPoint != null ? Math.max(0, Math.round(input.reorderPoint)) : existing.reorderPoint,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    updated_at: nowIso(),
    id: input.id
  }
  // Note: quantity is changed only through sales / restock / adjustments.
  getDb()
    .prepare(
      `UPDATE inventory_products SET
         sku=@sku, name=@name, category=@category, brand=@brand, set_name=@set_name,
         year=@year, unit_type=@unit_type, unit_cost=@unit_cost, sale_price=@sale_price,
         boxes_per_case=@boxes_per_case, packs_per_box=@packs_per_box,
         reorder_point=@reorder_point, notes=@notes, updated_at=@updated_at
       WHERE id=@id`
    )
    .run(next)
  return getProduct(input.id)
}

export function deleteProduct(id: string): boolean {
  const info = getDb().prepare('DELETE FROM inventory_products WHERE id = ?').run(id)
  return info.changes > 0
}

function insertTxn(
  productId: string,
  type: string,
  quantityChange: number,
  unitPrice: number | null,
  counterparty: string | null,
  note: string | null,
  actorId: string | null
): void {
  getDb()
    .prepare(
      `INSERT INTO inventory_transactions
         (id, product_id, type, quantity_change, unit_price, counterparty, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId(), productId, type, quantityChange, unitPrice, counterparty, note, actorId, nowIso())
}

export interface SaleResult {
  product: InventoryProduct
  error?: string
}

/** Record a sale: atomically checks stock, decrements, and logs the movement. */
export function recordSale(
  productId: string,
  quantity: number,
  unitPrice: number,
  client: string,
  note: string | null,
  actorId: string | null
): SaleResult {
  const db = getDb()
  const qty = Math.round(quantity)

  const run = db.transaction((): SaleResult => {
    const row = db.prepare('SELECT * FROM inventory_products WHERE id = ?').get(productId) as
      | ProductRow
      | undefined
    if (!row) return { product: null as unknown as InventoryProduct, error: 'Product not found.' }
    if (qty <= 0) return { product: toProduct(row), error: 'Quantity must be at least 1.' }
    if (qty > row.quantity) {
      return { product: toProduct(row), error: `Only ${row.quantity} in stock.` }
    }
    db.prepare('UPDATE inventory_products SET quantity = quantity - ?, updated_at = ? WHERE id = ?').run(
      qty,
      nowIso(),
      productId
    )
    insertTxn(productId, 'sale', -qty, unitPrice, client.trim() || null, note, actorId)
    return { product: getProduct(productId) as InventoryProduct }
  })

  return run()
}

/** Restock (+) or adjust (±) stock, logging the movement. */
export function adjustStock(
  productId: string,
  type: 'restock' | 'adjustment',
  quantityChange: number,
  unitCost: number | null,
  note: string | null,
  actorId: string | null
): SaleResult {
  const db = getDb()
  const delta = Math.round(quantityChange)

  const run = db.transaction((): SaleResult => {
    const row = db.prepare('SELECT * FROM inventory_products WHERE id = ?').get(productId) as
      | ProductRow
      | undefined
    if (!row) return { product: null as unknown as InventoryProduct, error: 'Product not found.' }
    if (delta === 0) return { product: toProduct(row), error: 'Enter a non-zero quantity.' }
    if (row.quantity + delta < 0) {
      return { product: toProduct(row), error: 'Adjustment would make stock negative.' }
    }
    db.prepare('UPDATE inventory_products SET quantity = quantity + ?, updated_at = ? WHERE id = ?').run(
      delta,
      nowIso(),
      productId
    )
    insertTxn(productId, type, delta, unitCost, null, note, actorId)
    return { product: getProduct(productId) as InventoryProduct }
  })

  return run()
}

interface TxnRow {
  id: string
  product_id: string
  product_name: string
  sku: string
  type: string
  quantity_change: number
  unit_price: number | null
  counterparty: string | null
  note: string | null
  actor_name: string | null
  created_at: string
}

function toTxn(row: TxnRow): InventoryTransaction {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    type: row.type as InventoryTransaction['type'],
    quantityChange: row.quantity_change,
    unitPrice: row.unit_price,
    counterparty: row.counterparty,
    note: row.note,
    actorName: row.actor_name,
    createdAt: row.created_at
  }
}

const TXN_SELECT = `
  SELECT t.id, t.product_id, p.name AS product_name, p.sku AS sku, t.type,
         t.quantity_change, t.unit_price, t.counterparty, t.note,
         (e.first_name || ' ' || e.last_name) AS actor_name, t.created_at
  FROM inventory_transactions t
  JOIN inventory_products p ON p.id = t.product_id
  LEFT JOIN employees e ON e.id = t.actor_id
`

export function listTransactions(limit = 200): InventoryTransaction[] {
  const rows = getDb()
    .prepare(`${TXN_SELECT} ORDER BY t.created_at DESC LIMIT ?`)
    .all(limit) as TxnRow[]
  return rows.map(toTxn)
}

export function recentSales(limit = 8): InventoryTransaction[] {
  const rows = getDb()
    .prepare(`${TXN_SELECT} WHERE t.type = 'sale' ORDER BY t.created_at DESC LIMIT ?`)
    .all(limit) as TxnRow[]
  return rows.map(toTxn)
}

export function inventoryStats(): InventoryStats {
  const db = getDb()
  const p = db
    .prepare(
      `SELECT
         COALESCE(SUM(quantity * unit_cost), 0)                                        AS total_value,
         COALESCE(SUM(CASE WHEN unit_type='box'    THEN quantity ELSE 0 END), 0)        AS boxes,
         COALESCE(SUM(CASE WHEN unit_type='case'   THEN quantity ELSE 0 END), 0)        AS cases,
         COALESCE(SUM(CASE WHEN unit_type='pack'   THEN quantity ELSE 0 END), 0)        AS packs,
         COALESCE(SUM(CASE WHEN unit_type='single' THEN quantity ELSE 0 END), 0)        AS singles,
         COALESCE(SUM(quantity), 0)                                                     AS units,
         COUNT(*)                                                                       AS sku_count,
         COALESCE(SUM(CASE WHEN reorder_point > 0 AND quantity <= reorder_point THEN 1 ELSE 0 END), 0) AS low_stock
       FROM inventory_products`
    )
    .get() as {
    total_value: number
    boxes: number
    cases: number
    packs: number
    singles: number
    units: number
    sku_count: number
    low_stock: number
  }
  const s = db
    .prepare(
      `SELECT COALESCE(SUM(-quantity_change * unit_price), 0) AS revenue, COUNT(*) AS cnt
       FROM inventory_transactions WHERE type = 'sale'`
    )
    .get() as { revenue: number; cnt: number }

  return {
    totalValue: p.total_value,
    boxes: p.boxes,
    cases: p.cases,
    packs: p.packs,
    singles: p.singles,
    units: p.units,
    skuCount: p.sku_count,
    lowStockCount: p.low_stock,
    salesRevenue: s.revenue,
    salesCount: s.cnt
  }
}

export function valueByCategory(): CategoryValue[] {
  const rows = getDb()
    .prepare(
      `SELECT CASE WHEN TRIM(category) = '' THEN 'Uncategorized' ELSE category END AS category,
              SUM(quantity * unit_cost) AS value,
              SUM(quantity) AS units
       FROM inventory_products
       GROUP BY category
       ORDER BY value DESC`
    )
    .all() as Array<{ category: string; value: number; units: number }>
  return rows.map((r) => ({ category: r.category, value: r.value ?? 0, units: r.units ?? 0 }))
}

/** Daily sales revenue for the last `days` days (local day buckets). */
export function salesSeries(days: number): SalesPoint[] {
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  since.setDate(since.getDate() - (days - 1))
  const rows = getDb()
    .prepare(
      `SELECT created_at, -quantity_change * unit_price AS revenue
       FROM inventory_transactions
       WHERE type = 'sale' AND created_at >= ?`
    )
    .all(since.toISOString()) as Array<{ created_at: string; revenue: number }>

  const buckets = new Map<string, number>()
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setDate(since.getDate() + i)
    buckets.set(dayKey(d), 0)
  }
  for (const r of rows) {
    const key = dayKey(new Date(r.created_at))
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + (r.revenue ?? 0))
  }
  return [...buckets.entries()].map(([key, revenue]) => ({
    label: key.slice(8), // DD
    revenue: Math.round(revenue)
  }))
}

function dayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
