import type {
  CategorySummary,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  NewInventoryProduct,
  SalesPoint,
  UnitType,
  UpdateInventoryProduct
} from '@shared/types'
import { LOCATION_IDS } from '@shared/inventory'
import { getDb } from './database'
import { movingAverageCost } from './costing'
import { newId, nowIso } from '../util'

interface ProductRow {
  id: string
  sku: string
  upc: string | null
  name: string
  category: string
  brand: string
  set_name: string
  year: string
  unit_type: string
  boxes_per_case: number | null
  packs_per_box: number | null
  unit_cost: number
  high_bid: number | null
  sale_price: number | null
  reorder_point: number
  notes: string | null
  created_at: string
  updated_at: string
}

const UNIT_TYPES: UnitType[] = ['case', 'box', 'pack', 'single', 'other']

/** Build a { RM: n, AM: n } map for every product from the stock table. */
function allStockMap(): Map<string, Record<string, number>> {
  const rows = getDb()
    .prepare('SELECT product_id, location, quantity FROM inventory_stock')
    .all() as Array<{ product_id: string; location: string; quantity: number }>
  const map = new Map<string, Record<string, number>>()
  for (const r of rows) {
    const entry = map.get(r.product_id) ?? {}
    entry[r.location] = r.quantity
    map.set(r.product_id, entry)
  }
  return map
}

function stockFor(productId: string): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT location, quantity FROM inventory_stock WHERE product_id = ?')
    .all(productId) as Array<{ location: string; quantity: number }>
  const entry: Record<string, number> = {}
  for (const r of rows) entry[r.location] = r.quantity
  return entry
}

function toProduct(row: ProductRow, byLoc: Record<string, number>): InventoryProduct {
  const quantityByLocation: Record<string, number> = {}
  for (const loc of LOCATION_IDS) quantityByLocation[loc] = byLoc[loc] ?? 0
  const quantity = Object.values(quantityByLocation).reduce((a, b) => a + b, 0)
  return {
    id: row.id,
    sku: row.sku,
    upc: row.upc,
    name: row.name,
    category: row.category,
    brand: row.brand,
    setName: row.set_name,
    year: row.year,
    unitType: (UNIT_TYPES.includes(row.unit_type as UnitType) ? row.unit_type : 'other') as UnitType,
    boxesPerCase: row.boxes_per_case,
    packsPerBox: row.packs_per_box,
    unitCost: row.unit_cost,
    highBid: row.high_bid,
    salePrice: row.sale_price,
    reorderPoint: row.reorder_point,
    notes: row.notes,
    quantityByLocation,
    quantity,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listProducts(): InventoryProduct[] {
  const rows = getDb()
    .prepare('SELECT * FROM inventory_products ORDER BY name COLLATE NOCASE')
    .all() as ProductRow[]
  const stock = allStockMap()
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}))
}

export function getProduct(id: string): InventoryProduct | null {
  const row = getDb().prepare('SELECT * FROM inventory_products WHERE id = ?').get(id) as
    | ProductRow
    | undefined
  return row ? toProduct(row, stockFor(id)) : null
}

/** Typeahead search over the catalog. Matches name / SKU / UPC / category. */
export function searchCatalog(query: string, limit = 25): InventoryProduct[] {
  const q = `%${query.trim().replace(/[%_]/g, (m) => '\\' + m)}%`
  const rows = getDb()
    .prepare(
      `SELECT * FROM inventory_products
       WHERE name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\'
          OR upc LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
       ORDER BY name COLLATE NOCASE
       LIMIT ?`
    )
    .all(q, q, q, q, limit) as ProductRow[]
  const stock = allStockMap()
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}))
}

export function upcExists(upc: string, exceptId?: string): boolean {
  if (!upc.trim()) return false
  const row = getDb().prepare('SELECT id FROM inventory_products WHERE upc = ?').get(upc.trim()) as
    | { id: string }
    | undefined
  return !!row && row.id !== exceptId
}

function insertTxn(
  productId: string,
  type: string,
  quantityChange: number,
  unitPrice: number | null,
  counterparty: string | null,
  note: string | null,
  actorId: string | null,
  location: string | null
): void {
  getDb()
    .prepare(
      `INSERT INTO inventory_transactions
         (id, product_id, type, quantity_change, unit_price, counterparty, note, actor_id, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId(), productId, type, quantityChange, unitPrice, counterparty, note, actorId, location, nowIso())
}

/** Add `delta` to a product's stock at a location (delta may be negative). */
function bumpStock(productId: string, location: string, delta: number): void {
  getDb()
    .prepare(
      `INSERT INTO inventory_stock (id, product_id, location, quantity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(product_id, location) DO UPDATE SET quantity = quantity + excluded.quantity`
    )
    .run(newId(), productId, location, delta)
}

function stockQty(productId: string, location: string): number {
  const row = getDb()
    .prepare('SELECT quantity FROM inventory_stock WHERE product_id = ? AND location = ?')
    .get(productId, location) as { quantity: number } | undefined
  return row?.quantity ?? 0
}

/** Total on-hand across every location for a product. */
function stockTotal(productId: string): number {
  const row = getDb()
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE product_id = ?')
    .get(productId) as { q: number }
  return row.q
}

export function createProduct(input: NewInventoryProduct, actorId: string | null): InventoryProduct {
  const db = getDb()
  const id = newId()
  const ts = nowIso()

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO inventory_products
         (id, sku, upc, name, category, brand, set_name, year, unit_type,
          boxes_per_case, packs_per_box, unit_cost, high_bid, sale_price, reorder_point,
          notes, created_at, updated_at)
       VALUES
         (@id, @sku, @upc, @name, @category, @brand, @set_name, @year, @unit_type,
          @boxes_per_case, @packs_per_box, @unit_cost, @high_bid, @sale_price, @reorder_point,
          @notes, @ts, @ts)`
    ).run({
      id,
      sku: input.sku.trim(),
      upc: input.upc?.trim() || null,
      name: input.name.trim(),
      category: input.category.trim(),
      brand: input.brand.trim(),
      set_name: input.setName.trim(),
      year: input.year.trim(),
      unit_type: input.unitType,
      boxes_per_case: input.boxesPerCase,
      packs_per_box: input.packsPerBox,
      unit_cost: Math.max(0, input.unitCost),
      high_bid: input.highBid != null ? Math.max(0, input.highBid) : null,
      sale_price: input.salePrice,
      reorder_point: Math.max(0, Math.round(input.reorderPoint)),
      notes: input.notes,
      ts
    })

    const openQty = Math.round(input.openingQuantity ?? 0)
    if (openQty > 0) {
      const loc = LOCATION_IDS.includes((input.openingLocation ?? '') as never)
        ? (input.openingLocation as string)
        : LOCATION_IDS[0]
      bumpStock(id, loc, openQty)
      insertTxn(id, 'purchase', openQty, input.unitCost, null, 'Opening stock', actorId, loc)
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
    upc: input.upc !== undefined ? input.upc?.trim() || null : existing.upc,
    name: (input.name ?? existing.name).trim(),
    category: (input.category ?? existing.category).trim(),
    brand: (input.brand ?? existing.brand).trim(),
    set_name: (input.setName ?? existing.setName).trim(),
    year: (input.year ?? existing.year).trim(),
    unit_type: input.unitType ?? existing.unitType,
    boxes_per_case: input.boxesPerCase !== undefined ? input.boxesPerCase : existing.boxesPerCase,
    packs_per_box: input.packsPerBox !== undefined ? input.packsPerBox : existing.packsPerBox,
    unit_cost: input.unitCost != null ? Math.max(0, input.unitCost) : existing.unitCost,
    high_bid:
      input.highBid !== undefined
        ? input.highBid == null
          ? null
          : Math.max(0, input.highBid)
        : existing.highBid,
    sale_price: input.salePrice !== undefined ? input.salePrice : existing.salePrice,
    reorder_point:
      input.reorderPoint != null ? Math.max(0, Math.round(input.reorderPoint)) : existing.reorderPoint,
    notes: input.notes !== undefined ? input.notes : existing.notes,
    updated_at: nowIso(),
    id: input.id
  }
  getDb()
    .prepare(
      `UPDATE inventory_products SET
         sku=@sku, upc=@upc, name=@name, category=@category, brand=@brand,
         set_name=@set_name, year=@year, unit_type=@unit_type,
         boxes_per_case=@boxes_per_case, packs_per_box=@packs_per_box,
         unit_cost=@unit_cost, high_bid=@high_bid, sale_price=@sale_price,
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

export interface StockResult {
  product: InventoryProduct | null
  error?: string
}

/**
 * Add received stock to a location. When a unit cost is supplied the product's
 * average cost is rolled forward as a **moving weighted-average** across all
 * on-hand units, so cost (and therefore total cost and spread) tracks what we
 * actually paid over time rather than staying frozen. If there was no prior
 * cost basis, the purchase price simply becomes the average.
 */
export function addStock(
  productId: string,
  location: string,
  quantity: number,
  unitCost: number | null,
  note: string | null,
  actorId: string | null
): StockResult {
  const db = getDb()
  const qty = Math.round(quantity)
  const run = db.transaction((): StockResult => {
    const row = db.prepare('SELECT unit_cost FROM inventory_products WHERE id = ?').get(productId) as
      | { unit_cost: number }
      | undefined
    if (!row) return { product: null, error: 'Product not found.' }
    if (qty <= 0) return { product: getProduct(productId), error: 'Quantity must be at least 1.' }

    const prevQty = stockTotal(productId)
    bumpStock(productId, location, qty)

    if (unitCost != null && Number.isFinite(unitCost) && unitCost >= 0) {
      const newAvg = movingAverageCost(prevQty, row.unit_cost, qty, unitCost)
      db.prepare('UPDATE inventory_products SET unit_cost = ?, updated_at = ? WHERE id = ?').run(
        newAvg,
        nowIso(),
        productId
      )
    }
    insertTxn(productId, 'restock', qty, unitCost, null, note, actorId, location)
    return { product: getProduct(productId) }
  })
  return run()
}

/** Correct a location's count up or down (never below zero). */
export function adjustStock(
  productId: string,
  location: string,
  quantityChange: number,
  note: string | null,
  actorId: string | null
): StockResult {
  const db = getDb()
  const delta = Math.round(quantityChange)
  const run = db.transaction((): StockResult => {
    const exists = db.prepare('SELECT id FROM inventory_products WHERE id = ?').get(productId)
    if (!exists) return { product: null, error: 'Product not found.' }
    if (delta === 0) return { product: getProduct(productId), error: 'Enter a non-zero quantity.' }
    if (stockQty(productId, location) + delta < 0) {
      return { product: getProduct(productId), error: 'Adjustment would make stock negative.' }
    }
    bumpStock(productId, location, delta)
    insertTxn(productId, 'adjustment', delta, null, null, note, actorId, location)
    return { product: getProduct(productId) }
  })
  return run()
}

/** Sell from a location's stock: atomic check + decrement + ledger entry. */
export function recordSale(
  productId: string,
  location: string,
  quantity: number,
  unitPrice: number,
  client: string,
  note: string | null,
  actorId: string | null
): StockResult {
  const db = getDb()
  const qty = Math.round(quantity)
  const run = db.transaction((): StockResult => {
    const exists = db.prepare('SELECT id FROM inventory_products WHERE id = ?').get(productId)
    if (!exists) return { product: null, error: 'Product not found.' }
    if (qty <= 0) return { product: getProduct(productId), error: 'Quantity must be at least 1.' }
    const have = stockQty(productId, location)
    if (qty > have) return { product: getProduct(productId), error: `Only ${have} in ${location}.` }
    bumpStock(productId, location, -qty)
    insertTxn(productId, 'sale', -qty, unitPrice, client.trim() || null, note, actorId, location)
    return { product: getProduct(productId) }
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
  location: string | null
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
    location: row.location,
    note: row.note,
    actorName: row.actor_name,
    createdAt: row.created_at
  }
}

const TXN_SELECT = `
  SELECT t.id, t.product_id, p.name AS product_name, p.sku AS sku, t.type,
         t.quantity_change, t.unit_price, t.counterparty, t.location, t.note,
         (e.first_name || ' ' || e.last_name) AS actor_name, t.created_at
  FROM inventory_transactions t
  JOIN inventory_products p ON p.id = t.product_id
  LEFT JOIN employees e ON e.id = t.actor_id
`

export function listTransactions(limit = 200): InventoryTransaction[] {
  return (getDb().prepare(`${TXN_SELECT} ORDER BY t.created_at DESC LIMIT ?`).all(limit) as TxnRow[]).map(
    toTxn
  )
}

export function recentSales(limit = 8): InventoryTransaction[] {
  return (
    getDb()
      .prepare(`${TXN_SELECT} WHERE t.type = 'sale' ORDER BY t.created_at DESC LIMIT ?`)
      .all(limit) as TxnRow[]
  ).map(toTxn)
}

/**
 * Per-product total on-hand joined to catalog attributes.
 * `market` is the per-unit value: the high bid when set, else the average cost.
 */
const PRODUCT_TOTALS = `
  SELECT p.id, p.unit_type, p.unit_cost, p.reorder_point, p.category,
         COALESCE(NULLIF(p.high_bid, 0), p.unit_cost) AS market,
         COALESCE(s.qty, 0) AS qty
  FROM inventory_products p
  LEFT JOIN (SELECT product_id, SUM(quantity) AS qty FROM inventory_stock GROUP BY product_id) s
    ON s.product_id = p.id
`

export function inventoryStats(): InventoryStats {
  const db = getDb()
  const p = db
    .prepare(
      `SELECT
         COALESCE(SUM(t.qty * t.market), 0)                                        AS total_value,
         COALESCE(SUM(t.qty * t.unit_cost), 0)                                     AS total_cost,
         COALESCE(SUM(CASE WHEN t.unit_type='case'   THEN t.qty ELSE 0 END), 0)     AS cases,
         COALESCE(SUM(CASE WHEN t.unit_type='box'    THEN t.qty ELSE 0 END), 0)     AS boxes,
         COALESCE(SUM(CASE WHEN t.unit_type='pack'   THEN t.qty ELSE 0 END), 0)     AS packs,
         COALESCE(SUM(CASE WHEN t.unit_type='single' THEN t.qty ELSE 0 END), 0)     AS singles,
         COALESCE(SUM(t.qty), 0)                                                    AS units,
         COUNT(t.id)                                                                AS sku_count,
         COALESCE(SUM(CASE WHEN t.reorder_point>0 AND t.qty<=t.reorder_point THEN 1 ELSE 0 END), 0) AS low_stock
       FROM (${PRODUCT_TOTALS}) t`
    )
    .get() as Record<string, number>

  const s = db
    .prepare(
      `SELECT COALESCE(SUM(-quantity_change * unit_price), 0) AS revenue, COUNT(*) AS cnt
       FROM inventory_transactions WHERE type = 'sale'`
    )
    .get() as { revenue: number; cnt: number }

  const locRows = db
    .prepare('SELECT location, SUM(quantity) AS qty FROM inventory_stock GROUP BY location')
    .all() as Array<{ location: string; qty: number }>
  const unitsByLocation: Record<string, number> = {}
  for (const loc of LOCATION_IDS) unitsByLocation[loc] = 0
  for (const r of locRows) unitsByLocation[r.location] = r.qty

  return {
    totalValue: p.total_value,
    totalCost: p.total_cost,
    spread: p.total_value - p.total_cost,
    boxes: p.boxes,
    cases: p.cases,
    packs: p.packs,
    singles: p.singles,
    units: p.units,
    skuCount: p.sku_count,
    lowStockCount: p.low_stock,
    salesRevenue: s.revenue,
    salesCount: s.cnt,
    unitsByLocation
  }
}

export function categorySummaries(): CategorySummary[] {
  const rows = getDb()
    .prepare(
      `SELECT
         CASE WHEN TRIM(t.category)='' THEN 'Uncategorized' ELSE t.category END AS category,
         COALESCE(SUM(CASE WHEN t.unit_type='case' THEN t.qty ELSE 0 END),0) AS cases,
         COALESCE(SUM(CASE WHEN t.unit_type='box'  THEN t.qty ELSE 0 END),0) AS boxes,
         COALESCE(SUM(t.qty),0)          AS units,
         COALESCE(SUM(t.qty*t.market),0) AS value,
         COUNT(t.id)                     AS product_count
       FROM (${PRODUCT_TOTALS}) t
       GROUP BY category
       ORDER BY category COLLATE NOCASE`
    )
    .all() as Array<{
    category: string
    cases: number
    boxes: number
    units: number
    value: number
    product_count: number
  }>
  return rows.map((r) => ({
    category: r.category,
    cases: r.cases,
    boxes: r.boxes,
    units: r.units,
    value: r.value,
    productCount: r.product_count
  }))
}

export function productsByCategory(category: string): InventoryProduct[] {
  const rows = getDb()
    .prepare('SELECT * FROM inventory_products WHERE category = ? ORDER BY name COLLATE NOCASE')
    .all(category) as ProductRow[]
  const stock = allStockMap()
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}))
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
  return [...buckets.entries()].map(([key, revenue]) => ({ label: key.slice(8), revenue: Math.round(revenue) }))
}

function dayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
