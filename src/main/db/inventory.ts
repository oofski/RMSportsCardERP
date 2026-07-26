import type {
  CategorySummary,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  NewInventoryProduct,
  PricingRow,
  ProductImage,
  ProductLot,
  SalesPoint,
  UnitType,
  UpdateInventoryProduct
} from '@shared/types'
import type { Database } from 'better-sqlite3'
import { LOCATION_IDS } from '@shared/inventory'
import { normalizeUpc } from '@shared/upc'
import { getDb } from './database'
import { consumeFifo, createLot, reverseLotReceipt, slicesCost, syncProductAvgCost } from './lots'
import { deleteImageFile, imageDataUrl, importImageFile } from '../services/media'
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

/**
 * Keyword typeahead over the catalog: each whitespace-separated term must match
 * name / SKU / UPC / category / brand (LIKE is case-insensitive), in any order,
 * so "bowman 2026" and "2026 bowman" both find the 2026 Bowman case.
 */
export function searchCatalog(query: string, limit = 25): InventoryProduct[] {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  const like = (t: string): string => `%${t.replace(/[%_\\]/g, (m) => '\\' + m)}%`
  // Mirror the renderer's search haystack so the add-stock typeahead and the
  // catalog filter find the same products (set_name / year were missing).
  const fields = ['name', 'sku', 'upc', 'category', 'brand', 'set_name', 'year']
  const clause = `(${fields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`
  const where = terms.length ? terms.map(() => clause).join(' AND ') : '1=1'
  const params: unknown[] = []
  for (const t of terms) for (let i = 0; i < fields.length; i++) params.push(like(t))
  params.push(limit)
  const rows = getDb()
    .prepare(`SELECT * FROM inventory_products WHERE ${where} ORDER BY name COLLATE NOCASE LIMIT ?`)
    .all(...params) as ProductRow[]
  const stock = allStockMap()
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}))
}

/**
 * Is this UPC already in the catalog? Compares on the CANONICAL form, so
 * "0012345678905" is correctly rejected when "012345678905" already exists —
 * which is what keeps newly-entered data out of the ambiguous-scan state.
 */
export function upcExists(upc: string, exceptId?: string): boolean {
  const normalized = normalizeUpc(upc)
  if (!normalized) return false
  const row = getDb()
    .prepare('SELECT id FROM inventory_products WHERE upc_norm = ?')
    .get(normalized) as { id: string } | undefined
  return !!row && row.id !== exceptId
}

/** Every catalog product carrying this canonical UPC. Returns an ARRAY because
 * upc_norm is intentionally non-unique: the caller decides whether 0 / 1 / many
 * means unknown / product / ambiguous. */
export function findProductsByUpc(normalized: string | null): InventoryProduct[] {
  if (!normalized) return []
  const rows = getDb()
    .prepare('SELECT * FROM inventory_products WHERE upc_norm = ? ORDER BY name COLLATE NOCASE')
    .all(normalized) as ProductRow[]
  return rows.map((r) => toProduct(r, stockFor(r.id)))
}

/** Returns the new transaction's id so a caller can point an audit row at the
 * exact ledger entry it wrote. */
function insertTxn(
  productId: string,
  type: string,
  quantityChange: number,
  unitPrice: number | null,
  counterparty: string | null,
  note: string | null,
  actorId: string | null,
  location: string | null,
  costBasis: number | null = null
): string {
  const id = newId()
  getDb()
    .prepare(
      `INSERT INTO inventory_transactions
         (id, product_id, type, quantity_change, unit_price, counterparty, note, actor_id, location, cost_basis, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, productId, type, quantityChange, unitPrice, counterparty, note, actorId, location, costBasis, nowIso())
  return id
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

export function createProduct(input: NewInventoryProduct, actorId: string | null): InventoryProduct {
  const db = getDb()
  const id = newId()
  const ts = nowIso()

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO inventory_products
         (id, sku, upc, upc_norm, name, category, brand, set_name, year, unit_type,
          boxes_per_case, packs_per_box, unit_cost, high_bid, high_bid_at, sale_price, reorder_point,
          notes, created_at, updated_at)
       VALUES
         (@id, @sku, @upc, @upc_norm, @name, @category, @brand, @set_name, @year, @unit_type,
          @boxes_per_case, @packs_per_box, @unit_cost, @high_bid, @high_bid_at, @sale_price, @reorder_point,
          @notes, @ts, @ts)`
    ).run({
      id,
      sku: input.sku.trim(),
      upc: input.upc?.trim() || null,
      // The scan lookup key. A product whose upc_norm goes stale is permanently
      // unscannable, so it is written on every path that touches upc.
      upc_norm: normalizeUpc(input.upc),
      name: input.name.trim(),
      category: input.category.trim(),
      brand: input.brand.trim(),
      set_name: input.setName.trim(),
      year: input.year.trim(),
      unit_type: input.unitType,
      boxes_per_case: input.boxesPerCase,
      packs_per_box: input.packsPerBox,
      unit_cost: Math.max(0, input.unitCost),
      high_bid: normalizeHighBid(input.highBid),
      high_bid_at: normalizeHighBid(input.highBid) != null ? ts : null,
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
      createLot(db, id, loc, openQty, Math.max(0, input.unitCost), ts, 'opening', 'Opening stock')
      syncProductAvgCost(db, id)
      insertTxn(id, 'purchase', openQty, input.unitCost, null, 'Opening stock', actorId, loc)
    }
  })
  create()
  return getProduct(id) as InventoryProduct
}

/** Normalize a high bid: 0 / invalid → null (unpriced), otherwise clamp ≥ 0. */
function normalizeHighBid(highBid: number | null | undefined): number | null {
  if (highBid == null || highBid === 0 || !Number.isFinite(highBid)) return null
  return Math.max(0, highBid)
}

export function updateProduct(input: UpdateInventoryProduct): InventoryProduct | null {
  const existing = getProduct(input.id)
  if (!existing) return null
  const upc = input.upc !== undefined ? input.upc?.trim() || null : existing.upc
  const next = {
    sku: (input.sku ?? existing.sku).trim(),
    upc,
    // Kept in lockstep with upc — see createProduct.
    upc_norm: normalizeUpc(upc),
    name: (input.name ?? existing.name).trim(),
    category: (input.category ?? existing.category).trim(),
    brand: (input.brand ?? existing.brand).trim(),
    set_name: (input.setName ?? existing.setName).trim(),
    year: (input.year ?? existing.year).trim(),
    unit_type: input.unitType ?? existing.unitType,
    boxes_per_case: input.boxesPerCase !== undefined ? input.boxesPerCase : existing.boxesPerCase,
    packs_per_box: input.packsPerBox !== undefined ? input.packsPerBox : existing.packsPerBox,
    unit_cost: input.unitCost != null ? Math.max(0, input.unitCost) : existing.unitCost,
    high_bid: input.highBid !== undefined ? normalizeHighBid(input.highBid) : existing.highBid,
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
         sku=@sku, upc=@upc, upc_norm=@upc_norm, name=@name, category=@category, brand=@brand,
         set_name=@set_name, year=@year, unit_type=@unit_type,
         boxes_per_case=@boxes_per_case, packs_per_box=@packs_per_box,
         unit_cost=@unit_cost, high_bid=@high_bid, sale_price=@sale_price,
         reorder_point=@reorder_point, notes=@notes, updated_at=@updated_at
       WHERE id=@id`
    )
    .run(next)
  // Keep the "last priced" timestamp in sync when the bid changes here too, so
  // the Pricing screen's recency doesn't go stale when a bid is edited in the
  // catalog. Stamp when a bid is set, clear when it's removed.
  if (input.highBid !== undefined) {
    getDb()
      .prepare('UPDATE inventory_products SET high_bid_at = ? WHERE id = ?')
      .run(next.high_bid != null ? nowIso() : null, input.id)
  }
  return getProduct(input.id)
}

/** Update only a product's high bid (market value) + when it was set. */
export function updateHighBid(productId: string, highBid: number | null): InventoryProduct | null {
  if (!getProduct(productId)) return null
  const val = normalizeHighBid(highBid)
  const ts = nowIso()
  // Stamp "last priced" when a bid is set; clear it when the bid is removed.
  getDb()
    .prepare('UPDATE inventory_products SET high_bid = ?, high_bid_at = ?, updated_at = ? WHERE id = ?')
    .run(val, val != null ? ts : null, ts, productId)
  return getProduct(productId)
}

interface LotRow {
  id: string
  product_id: string
  location: string
  qty_received: number
  qty_remaining: number
  unit_cost: number
  received_at: string
  source: string
}

/** A product's open cost lots, oldest first (for the FIFO case view). */
export function listLots(productId: string): ProductLot[] {
  const rows = getDb()
    .prepare(
      `SELECT id, product_id, location, qty_received, qty_remaining, unit_cost, received_at, source
       FROM inventory_lots
       WHERE product_id = ? AND qty_remaining > 0
       ORDER BY received_at ASC, rowid ASC`
    )
    .all(productId) as LotRow[]
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    location: r.location,
    qtyReceived: r.qty_received,
    qtyRemaining: r.qty_remaining,
    unitCost: r.unit_cost,
    receivedAt: r.received_at,
    source: r.source
  }))
}

/** In-stock products with the money needed by the Daily Pricing screen. */
export function pricingList(): PricingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.name, p.sku, p.category, p.unit_type,
              p.unit_cost, p.high_bid, p.high_bid_at,
              COALESCE(SUM(s.quantity), 0) AS qty
       FROM inventory_products p
       JOIN inventory_stock s ON s.product_id = p.id
       GROUP BY p.id
       HAVING qty > 0
       ORDER BY p.category, p.name COLLATE NOCASE`
    )
    .all() as Array<{
    id: string
    name: string
    sku: string
    category: string
    unit_type: string
    unit_cost: number
    high_bid: number | null
    high_bid_at: string | null
    qty: number
  }>
  return rows.map((r) => {
    const market = r.high_bid && r.high_bid > 0 ? r.high_bid : r.unit_cost
    return {
      id: r.id,
      name: r.name,
      sku: r.sku,
      category: r.category,
      unitType: (UNIT_TYPES.includes(r.unit_type as UnitType) ? r.unit_type : 'other') as UnitType,
      quantity: r.qty,
      unitCost: r.unit_cost,
      highBid: r.high_bid,
      highBidAt: r.high_bid_at,
      invValue: r.qty * market,
      spread: r.qty * (market - r.unit_cost)
    }
  })
}

export function deleteProduct(id: string): boolean {
  const files = (
    getDb().prepare('SELECT filename FROM inventory_product_images WHERE product_id = ?').all(id) as Array<{
      filename: string
    }>
  ).map((r) => r.filename)
  const info = getDb().prepare('DELETE FROM inventory_products WHERE id = ?').run(id)
  if (info.changes > 0) files.forEach(deleteImageFile)
  return info.changes > 0
}

// ---------------------------------------------------------------------------
// Product images
// ---------------------------------------------------------------------------

/** Images for one product, as ready-to-use data URLs (missing files skipped). */
export function listProductImages(productId: string): ProductImage[] {
  const rows = getDb()
    .prepare(
      'SELECT id, filename, position FROM inventory_product_images WHERE product_id = ? ORDER BY position, created_at'
    )
    .all(productId) as Array<{ id: string; filename: string; position: number }>
  return rows
    .map((r) => ({ id: r.id, position: r.position, dataUrl: imageDataUrl(r.filename) ?? '' }))
    .filter((x) => x.dataUrl)
}

/** Copy a picked file into the media store and attach it to a product. */
export function addProductImage(productId: string, srcPath: string): ProductImage[] {
  const exists = getDb().prepare('SELECT id FROM inventory_products WHERE id = ?').get(productId)
  if (!exists) throw new Error('Product not found.')
  const id = newId()
  const filename = importImageFile(srcPath, id)
  try {
    const pos = (
      getDb()
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM inventory_product_images WHERE product_id = ?')
        .get(productId) as { p: number }
    ).p
    getDb()
      .prepare(
        'INSERT INTO inventory_product_images (id, product_id, filename, position, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, productId, filename, pos, nowIso())
  } catch (err) {
    deleteImageFile(filename) // don't leak the copied file if the row insert fails
    throw err
  }
  return listProductImages(productId)
}

/** Detach an image (removing the file); returns the product's remaining images. */
export function removeProductImage(imageId: string): { productId: string | null; images: ProductImage[] } {
  const row = getDb()
    .prepare('SELECT product_id, filename FROM inventory_product_images WHERE id = ?')
    .get(imageId) as { product_id: string; filename: string } | undefined
  if (!row) return { productId: null, images: [] }
  getDb().prepare('DELETE FROM inventory_product_images WHERE id = ?').run(imageId)
  deleteImageFile(row.filename)
  return { productId: row.product_id, images: listProductImages(row.product_id) }
}

/** Map of productId → primary image data URL, for products that have one. */
export function productThumbnails(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT product_id, filename FROM inventory_product_images ORDER BY product_id, position, created_at')
    .all() as Array<{ product_id: string; filename: string }>
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (out[r.product_id]) continue
    const url = imageDataUrl(r.filename)
    if (url) out[r.product_id] = url
  }
  return out
}

/** One product's primary photo as a data URL (null when it has none) — the
 * single-product form of productThumbnails(), for the scan preview. */
export function productThumbnail(productId: string): string | null {
  const row = getDb()
    .prepare(
      'SELECT filename FROM inventory_product_images WHERE product_id = ? ORDER BY position, created_at LIMIT 1'
    )
    .get(productId) as { filename: string } | undefined
  return row ? (imageDataUrl(row.filename) ?? null) : null
}

export interface StockResult {
  product: InventoryProduct | null
  error?: string
  /** The FIFO cost lot this receipt created (undo reverses exactly this one). */
  lotId?: string
  /** The ledger row this receipt wrote. */
  txnId?: string
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

    bumpStock(productId, location, qty)

    // Record the purchase as a FIFO cost lot. A restock with no cost given
    // inherits the current average so it doesn't move the basis.
    const lotCost =
      unitCost != null && Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : row.unit_cost
    const lotId = createLot(db, productId, location, qty, lotCost, nowIso(), 'restock', note)
    syncProductAvgCost(db, productId)

    const txnId = insertTxn(productId, 'restock', qty, unitCost, null, note, actorId, location)
    // lotId/txnId are optional on the result, so the existing call sites that
    // ignore them are unaffected; the scan log records them to make undo exact.
    return { product: getProduct(productId), lotId, txnId }
  })
  return run()
}

/**
 * Reverse ONE receipt previously written by addStock: its exact FIFO lot, the
 * stock it added, the average cost it rolled, and a visible reversing ledger
 * entry (the audit trail stays append-only — the original transaction is never
 * deleted). Lives here, beside addStock, so no caller ever hand-rolls stock or
 * cost SQL.
 *
 * MUST be called inside the caller's db.transaction(). Throws — rolling the
 * caller back — when the lot is gone or part of it has already been sold.
 */
export function reverseStockReceipt(
  db: Database,
  args: {
    productId: string
    location: string
    quantity: number
    lotId: string
    note: string | null
    actorId: string | null
  }
): string {
  const qty = Math.round(args.quantity)
  if (qty <= 0) throw new Error('There is nothing to reverse for that scan.')
  reverseLotReceipt(db, args.lotId, qty)
  bumpStock(args.productId, args.location, -qty)
  syncProductAvgCost(db, args.productId)
  return insertTxn(args.productId, 'adjustment', -qty, null, null, args.note, args.actorId, args.location)
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
    if (delta < 0) {
      // Shrinkage / correction down — consume the oldest lots.
      consumeFifo(db, productId, location, -delta)
    } else {
      // Found stock — value it at the current average so the basis is undistorted.
      const row = db.prepare('SELECT unit_cost FROM inventory_products WHERE id = ?').get(productId) as
        | { unit_cost: number }
        | undefined
      createLot(db, productId, location, delta, row?.unit_cost ?? 0, nowIso(), 'adjustment', note)
    }
    syncProductAvgCost(db, productId)
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
    // Consume the oldest cost lots first (FIFO); the consumed cost is the COGS.
    const cogs = slicesCost(consumeFifo(db, productId, location, qty))
    syncProductAvgCost(db, productId)
    insertTxn(productId, 'sale', -qty, unitPrice, client.trim() || null, note, actorId, location, cogs)
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
