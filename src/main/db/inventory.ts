import type {
  CategorySummary,
  CostBasisFix,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  LotPickerData,
  NewInventoryProduct,
  PricingRow,
  ProductImage,
  ProductLot,
  SalesPoint,
  UnitType,
  UpdateInventoryProduct
} from '@shared/types'
import type { Database } from 'better-sqlite3'
import type { ProductUnits, StockUnit } from '@shared/units'
import { QTY_SNAP } from '@shared/units'
import { LOCATION_IDS } from '@shared/inventory'
import type { ProductAvailability } from '@shared/availability'
import { isHomeShelf } from '@shared/availability'
import { normalizeUpc } from '@shared/upc'
import { getDb } from './database'
import type { LotPick } from '@shared/costLots'
import {
  QTY_EPS,
  allowsFractionalQty,
  consumeLots,
  createLot,
  listOpenLots,
  recordTxnLots,
  reverseLotReceipt,
  roundQty,
  slicesCost,
  syncProductAvgCost,
  unitMoney
} from './lots'
import { PRODUCT_BASIS, allCostValues, layerGaps, productCostValue, shelfBasis } from './valuation'
import { deleteImageFile, imageDataUrl, importImage, type ImageSource } from '../services/media'
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
  giveaway_item: number
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

/**
 * WHERE THIS PRODUCT IS, PLACE BY PLACE — our shelves and the shops alike.
 *
 * The read behind "4 at RM · 3 at Roadshow Wichita" on a sales-order line. The
 * owner's case: "when putting quantities of things I need the RM inventory +
 * roadshow open tabs." A roadshow shop is an ordinary stock location now, so
 * this is one query over `inventory_stock` and nothing has to know about tabs
 * at all — which is the whole benefit of having modelled a shop as a place.
 *
 * EMPTY PLACES ARE DROPPED HERE rather than by the caller, so a product that
 * has never been anywhere returns an empty list instead of a row of zeroes for
 * every shelf that exists.
 */
export function productAvailability(productId: string): ProductAvailability {
  const id = String(productId ?? '').trim()
  if (!id) return { productId: '', places: [] }
  const rows = getDb()
    .prepare(
      `SELECT location, quantity FROM inventory_stock
        WHERE product_id = ? AND quantity > 0`
    )
    .all(id) as Array<{ location: string; quantity: number }>
  return {
    productId: id,
    places: rows.map((r) => ({
      location: r.location,
      quantity: Number(r.quantity) || 0,
      here: isHomeShelf(r.location)
    }))
  }
}

/**
 * The cost basis carried on a product, straight off its layers.
 *
 * Handed to `toProduct` rather than recomputed from unitCost in the renderer,
 * because on-hand × average is precisely the arithmetic that loses money: the
 * hover card, the quick view and the product table all derive their totals from
 * this now, and all three therefore land on the same number as the dashboard.
 */
function costValueFor(productId: string): number {
  return productCostValue(getDb(), productId)
}

function toProduct(
  row: ProductRow,
  byLoc: Record<string, number>,
  costValue: number
): InventoryProduct {
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
    giveawayItem: Number(row.giveaway_item) === 1,
    unitCost: row.unit_cost,
    highBid: row.high_bid,
    salePrice: row.sale_price,
    reorderPoint: row.reorder_point,
    notes: row.notes,
    quantityByLocation,
    quantity,
    costValue,
    marketValue: row.high_bid != null && row.high_bid > 0 ? quantity * row.high_bid : costValue,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * The stock unit a `unitType` counts in, or null when it counts in neither.
 *
 * The unit contract only knows 'case' and 'box' because those are the only two
 * things a break or a giveaway can be converted against. A product stocked in
 * 'pack' / 'single' / 'other' has no cases-to-boxes relationship to divide by,
 * so this returns null and the caller REFUSES rather than defaulting to 'box' —
 * defaulting is the order-of-magnitude error @shared/units exists to prevent.
 */
export function stockUnitOf(unitType: string): StockUnit | null {
  return unitType === 'case' ? 'case' : unitType === 'box' ? 'box' : null
}

/**
 * Everything @shared/units needs to convert for one product, read straight off
 * its row. Null when the product is gone or is not stocked in cases or boxes.
 */
export function productUnits(productId: string): ProductUnits | null {
  const row = getDb()
    .prepare(
      'SELECT unit_type, boxes_per_case, packs_per_box, giveaway_item FROM inventory_products WHERE id = ?'
    )
    .get(productId) as
    | { unit_type: string; boxes_per_case: number | null; packs_per_box: number | null; giveaway_item: number }
    | undefined
  if (!row) return null
  const unitType = stockUnitOf(row.unit_type)
  if (!unitType) return null
  return {
    unitType,
    boxesPerCase: row.boxes_per_case,
    packsPerBox: row.packs_per_box,
    giveawayItem: Number(row.giveaway_item) === 1
  }
}

export function listProducts(): InventoryProduct[] {
  const rows = getDb()
    .prepare('SELECT * FROM inventory_products ORDER BY name COLLATE NOCASE')
    .all() as ProductRow[]
  const stock = allStockMap()
  const values = allCostValues(getDb())
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}, values.get(r.id) ?? 0))
}

export function getProduct(id: string): InventoryProduct | null {
  const row = getDb().prepare('SELECT * FROM inventory_products WHERE id = ?').get(id) as
    | ProductRow
    | undefined
  return row ? toProduct(row, stockFor(id), costValueFor(id)) : null
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
  const values = allCostValues(getDb())
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}, values.get(r.id) ?? 0))
}

/**
 * Find the catalog product a Whatnot listing title is describing.
 *
 * Whatnot titles are typed by hand into a listing form, so they are close to a
 * catalog name and rarely equal to one: "2025-26 Topps Chrome Cactus Jack
 * Basketball Hobby Box" against a catalog row of "2025-26 Topps Chrome Cactus
 * Jack Basketball Hobby Box (12 Box)". Matching has to tolerate that without
 * tolerating so much that it confidently returns the wrong box.
 *
 * SCORED, NOT FUZZY. Every significant word in the catalog name must appear in
 * the title — that is the floor, and it is what stops "Topps Chrome Baseball"
 * matching "Topps Chrome Football". The score then rewards how much of the
 * TITLE the name accounts for, so between two products that both fit, the more
 * specific one wins. A tie is refused rather than broken arbitrarily: two
 * products the app cannot tell apart is a fact for a person, not a coin flip.
 *
 * The year is treated as decisive when the title has one. "2020-21 Panini Prizm
 * Basketball Hobby Box" and its 2024-25 namesake differ in nothing else, and
 * booking a sale against the wrong year's cost is worse than not booking it.
 */
export interface ProductNameMatch {
  product: InventoryProduct
  /** 0-1. How much of the listing title the catalog name accounted for. */
  score: number
  /** True when a second product scored the same — caller must not auto-apply. */
  ambiguous: boolean
}

/** Words that carry no identifying weight in a card-product name. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'new', 'release', 'box', 'hobby', 'sealed', 'x'
])

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0)
}

/** "2025-26" and "2025" both reduce to the leading year. */
function yearsIn(s: string): Set<string> {
  return new Set((s.match(/\b(19|20)\d{2}\b/g) ?? []).map((y) => y))
}

export function matchProductByName(rawTitle: string): ProductNameMatch | null {
  const title = (rawTitle || '').trim()
  if (!title) return null
  const titleTokens = tokens(title)
  if (titleTokens.length === 0) return null
  const titleSet = new Set(titleTokens)
  const titleYears = yearsIn(title)

  const rows = getDb().prepare('SELECT * FROM inventory_products').all() as ProductRow[]
  let best: { row: ProductRow; score: number } | null = null
  let tied = false

  for (const row of rows) {
    const nameTokens = tokens(row.name)
    const significant = nameTokens.filter((t) => !STOPWORDS.has(t))
    if (significant.length === 0) continue
    // The floor: every significant word of the catalog name is in the title.
    if (!significant.every((t) => titleSet.has(t))) continue

    // A year in both that does not agree is a different product, full stop.
    const nameYears = yearsIn(row.name)
    if (titleYears.size > 0 && nameYears.size > 0) {
      let shared = false
      for (const y of nameYears) if (titleYears.has(y)) shared = true
      if (!shared) continue
    }

    const covered = titleTokens.filter((t) => nameTokens.includes(t)).length
    const score = covered / titleTokens.length
    if (!best || score > best.score) {
      best = { row, score }
      tied = false
    } else if (score === best.score) {
      tied = true
    }
  }

  if (!best) return null
  return {
    product: toProduct(best.row, stockFor(best.row.id), costValueFor(best.row.id)),
    score: Math.round(best.score * 1000) / 1000,
    ambiguous: tied
  }
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
  return rows.map((r) => toProduct(r, stockFor(r.id), costValueFor(r.id)))
}

/** Returns the new transaction's id so a caller can point an audit row at the
 * exact ledger entry it wrote. */
/**
 * Shared with db/streaming.ts, which moves stock the same way a sale does.
 * Exported rather than duplicated on purpose: two copies of a stock mutation
 * are two things that must be changed together forever, and the day they drift
 * is the day the cost basis quietly stops adding up.
 */
export function insertTxn(
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

/**
 * Add `delta` to a product's stock at a location (delta may be negative).
 *
 * The sum is ROUNDed to 4dp in SQL. For the whole catalog that is a no-op — a
 * sum of integers is already exact — and it is what keeps a giveaway-flagged
 * product's balance at 9.75 instead of drifting to 9.749999999999998 over a
 * season of pack-sized movements. INTEGER affinity then stores a whole result as
 * an integer and a genuine fraction as a REAL, so nothing else in the app sees a
 * change.
 */
export function bumpStock(productId: string, location: string, delta: number): void {
  getDb()
    .prepare(
      // The CASE snaps a balance that is only rounding dust to exactly zero —
      // consumeFifo does the same to the cost layer, and the two must land on
      // zero together or assertStockLotsConsistent reports a divergence that is
      // really just 0.0004 of a case. See QTY_SNAP in @shared/units.
      `INSERT INTO inventory_stock (id, product_id, location, quantity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(product_id, location) DO UPDATE
         SET quantity = CASE
               WHEN ABS(ROUND(quantity + excluded.quantity, 4)) < ${QTY_SNAP}
                 THEN 0
               ELSE ROUND(quantity + excluded.quantity, 4)
             END`
    )
    .run(newId(), productId, location, delta)
}

export function stockQty(productId: string, location: string): number {
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
          boxes_per_case, packs_per_box, giveaway_item, unit_cost, high_bid, high_bid_at, sale_price,
          reorder_point, notes, created_at, updated_at)
       VALUES
         (@id, @sku, @upc, @upc_norm, @name, @category, @brand, @set_name, @year, @unit_type,
          @boxes_per_case, @packs_per_box, @giveaway_item, @unit_cost, @high_bid, @high_bid_at, @sale_price,
          @reorder_point, @notes, @ts, @ts)`
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
      // First-class, editable, and load-bearing: every cases↔boxes↔packs
      // conversion divides by these. Null stays null — a missing divisor makes
      // the conversion refuse, which is the point.
      boxes_per_case: normalizeDivisor(input.boxesPerCase),
      packs_per_box: normalizeDivisor(input.packsPerBox),
      giveaway_item: input.giveawayItem ? 1 : 0,
      unit_cost: Math.max(0, input.unitCost),
      high_bid: normalizeHighBid(input.highBid),
      high_bid_at: normalizeHighBid(input.highBid) != null ? ts : null,
      sale_price: input.salePrice,
      reorder_point: Math.max(0, Math.round(input.reorderPoint)),
      notes: input.notes,
      ts
    })

    // Opening stock follows the same gate as every later movement, read from the
    // flag this very insert just wrote — a giveaway item can open at 4.5 boxes,
    // everything else opens whole.
    const openQty = roundQty(input.openingQuantity ?? 0, !!input.giveawayItem)
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

/**
 * Normalize a boxes-per-case / packs-per-box divisor.
 *
 * Zero, negative and non-finite all become NULL rather than being stored: they
 * are not "no boxes in a case", they are "unknown", and NULL is the value every
 * conversion in @shared/units checks for before refusing. Storing 0 would divide
 * a cost by zero and hand back Infinity.
 */
function normalizeDivisor(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const n = Math.round(value)
  return n > 0 ? n : null
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
    boxes_per_case:
      input.boxesPerCase !== undefined ? normalizeDivisor(input.boxesPerCase) : existing.boxesPerCase,
    packs_per_box:
      input.packsPerBox !== undefined ? normalizeDivisor(input.packsPerBox) : existing.packsPerBox,
    giveaway_item:
      input.giveawayItem !== undefined ? (input.giveawayItem ? 1 : 0) : existing.giveawayItem ? 1 : 0,
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
         giveaway_item=@giveaway_item,
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
  // A cost typed into the CATALOG has to reach the stock, not only the product
  // row. The valuation reads the FIFO layers first (db/valuation.ts), so for the
  // products that need this most — a box taken in with the cost field left
  // blank, which opens its layer at zero — writing the average alone moves no
  // total anywhere: the layers still say nothing, the box stays outside the
  // Spread, and the operator is left believing a field works when it does not.
  // The catalog is where somebody goes to put a price on a product, so it is
  // where doing so has to land.
  //
  // It can only ever ADD basis, never reprice a purchase. It runs solely when
  // the product's cost value is nil, and even then touches only layers carrying
  // nothing — the same two guards `setZeroCostBasis` gives the banner's field,
  // which remains the version that REPORTS what it did.
  if (input.unitCost != null && next.unit_cost > 0 && productCostValue(getDb(), input.id) <= 0) {
    rebaseZeroCostLayers(getDb(), input.id, unitMoney(next.unit_cost))
  }
  return getProduct(input.id)
}

/**
 * Re-base the open cost layers that are carrying NOTHING onto `cost`, and
 * re-sync the product's average from what the layers then say.
 *
 * A layer at a real price is a real purchase and is never touched, so this can
 * only add basis where there is none. Shared by the catalog's cost field and by
 * the dashboard banner's, because "a cost typed here reaches the stock" has to
 * be one behaviour rather than two that drift.
 */
function rebaseZeroCostLayers(db: Database, productId: string, cost: number): number {
  const run = db.transaction((): number => {
    const info = db
      .prepare(
        `UPDATE inventory_lots SET unit_cost = ?
          WHERE product_id = ? AND qty_remaining > 0 AND unit_cost <= 0`
      )
      .run(cost, productId)
    // Recomputes the average from whatever the layers now say. Where there are
    // none it returns early and the figure already on the product row stands,
    // which is the number the valuation falls back to.
    syncProductAvgCost(db, productId)
    return info.changes
  })
  return run()
}

/**
 * Put a cost basis on stock that is carried at nothing.
 *
 * WHY THIS IS MORE THAN A WRITE TO `unit_cost`. The valuation reads the COST
 * LAYERS first and only falls back to the product's stored average where a shelf
 * has none (db/valuation.ts). So for the products that actually reach the
 * zero-cost banner — a catalog import that created them at `unit_cost = 0`
 * followed by a count that opened layers at the zero it found, or a box taken in
 * with the cost left blank — writing the average alone changes nothing anybody
 * can see: the layers still say zero, the banner still lists the product, and
 * the operator is left believing they typed a number into a field that does not
 * work. A cost field that silently fails to fix the thing it was offered for is
 * worse than no field, so this does the whole job. `updateProduct` now shares
 * the same re-basing for the same reason; what this adds is the REPORT — the
 * caller can say whether it landed instead of assuming so.
 *
 * WHAT IT TOUCHES, AND WHAT IT REFUSES TO. Only layers carrying NOTHING are
 * re-based. A layer at a real price is a real purchase and this is not the screen
 * for repricing one — the operation can therefore only ever add basis where there
 * is none, never overwrite what somebody paid. `syncProductAvgCost` then has the
 * last word on the average, exactly as it does after every other lot write, so
 * this cannot be the one path that leaves the average disagreeing with the layers
 * under it.
 *
 * A shelf with stock and NO layer at all is left without one on purpose: the
 * valuation's documented fallback already values it at the average this writes,
 * and minting a lot would invent a receipt date and a source for stock whose
 * history nobody knows.
 *
 * `costValue` comes back so the caller can say whether it actually worked rather
 * than assume it — see the banner in InventoryOverview.
 */
export function setZeroCostBasis(productId: string, unitCost: number): CostBasisFix | null {
  const db = getDb()
  if (!getProduct(productId)) return null
  // UNIT_DP, not cents: this is a per-unit rate that gets multiplied by a
  // quantity again, the same precision a layer and a product average are stored
  // at everywhere else.
  const cost = unitMoney(Math.max(0, unitCost))
  const run = db.transaction((): number => {
    db.prepare('UPDATE inventory_products SET unit_cost = ?, updated_at = ? WHERE id = ?').run(
      cost,
      nowIso(),
      productId
    )
    return rebaseZeroCostLayers(db, productId, cost)
  })
  const layersRevalued = run()
  const product = getProduct(productId)
  if (!product) return null
  return { product, layersRevalued, costValue: productCostValue(db, productId) }
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

/**
 * Everything the cost-lot picker needs for one (product, location), in ONE read.
 *
 * One call rather than three, because the dialog opens in the middle of somebody
 * recording a break on air: three round trips over the web transport is three
 * chances to draw a half-populated dialog, and a picker showing layers without
 * the average to judge them against is a picker showing a list of prices with no
 * reference point.
 *
 * `averageCost` is the product's stored weighted average — the reference figure
 * the owner asked to stay visible throughout. It is deliberately NOT what any
 * consumption books; it is what the layers on screen blend to, so a chosen
 * allocation can be read against it at a glance.
 *
 * A product that no longer exists comes back null rather than as an empty shell.
 * An empty `lots` array is a real answer — the shelf has stock recorded with no
 * cost layer under it — and the caller must not prompt on it.
 */
export function lotOptions(productId: string, location: string): LotPickerData | null {
  const db = getDb()
  const row = db
    .prepare('SELECT id, name, unit_type, unit_cost FROM inventory_products WHERE id = ?')
    .get(productId) as
    | { id: string; name: string; unit_type: string; unit_cost: number }
    | undefined
  if (!row) return null
  return {
    productId: row.id,
    productName: row.name,
    unitType: row.unit_type as UnitType,
    location,
    averageCost: row.unit_cost,
    lots: listOpenLots(db, productId, location)
  }
}

/**
 * In-stock products with the money needed by the Daily Pricing screen.
 *
 * Reads the layers for the cost side exactly as the dashboard does, so the
 * column that decides what gets re-priced cannot show a different spread from
 * the tile that prompted the operator to open the screen. The average cost is
 * derived back OUT of the exact basis rather than read off the product row: it
 * is the per-unit view of a total, not the other way round.
 */
export function pricingList(): PricingRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id, p.name, p.sku, p.category, p.unit_type,
              p.unit_cost, p.high_bid, p.high_bid_at,
              COALESCE(s.qty, 0) AS qty,
              COALESCE(v.cost_value, 0) AS cost_value
       FROM inventory_products p
       JOIN (SELECT product_id, SUM(quantity) AS qty FROM inventory_stock GROUP BY product_id) s
         ON s.product_id = p.id
       LEFT JOIN (${PRODUCT_BASIS}) v ON v.product_id = p.id
       WHERE s.qty > 0
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
    cost_value: number
  }>
  return rows.map((r) => {
    const priced = r.high_bid != null && r.high_bid > 0
    const invValue = priced ? r.qty * (r.high_bid as number) : r.cost_value
    const unitType = (UNIT_TYPES.includes(r.unit_type as UnitType) ? r.unit_type : 'other') as UnitType
    // The same gate PRODUCT_TOTALS applies, on the same two facts — no basis
    // under the stock, and it is a box. Restated rather than joined because this
    // query reads the layers itself; it is asserted against the dashboard in
    // tests/inventoryValuation.test.ts so the two cannot quietly disagree about
    // which rows the Spread column is speaking for.
    const outsideSpread = r.qty > 0 && r.cost_value <= 0 && unitType === 'box'
    return {
      id: r.id,
      name: r.name,
      sku: r.sku,
      category: r.category,
      unitType,
      quantity: r.qty,
      unitCost: r.qty > 0 ? unitMoney(r.cost_value / r.qty) : r.unit_cost,
      costValue: r.cost_value,
      highBid: r.high_bid,
      highBidAt: r.high_bid_at,
      invValue,
      outsideSpread,
      spread: outsideSpread ? 0 : invValue - r.cost_value
    }
  })
}

/**
 * Remove a product from the catalog.
 *
 * REFUSED while a live purchase order still names it. `purchase_order_lines`
 * has ON DELETE CASCADE on product_id and `PRAGMA foreign_keys` is on, so
 * deleting a product silently took its PO lines with it — while the order kept
 * its stored `total`. The card then showed the full dollar amount with zero
 * items, the receipt and its PDF printed an empty order, and Invoicing went on
 * counting that money as committed. A PO already Received was left unremovable
 * too: delete refuses on a received PO, and Cancel found no lines to reverse.
 *
 * Cancelled orders are historical and do not block — nothing is owed on them,
 * and their lines cascading away costs only a record of what was never bought.
 *
 * Streaming solved the same problem the other way (stream_items.product_id is
 * ON DELETE SET NULL with the name and sku snapshotted onto the line, so a
 * deleted product leaves the break intact). Purchase orders never got that, and
 * retrofitting it is a schema change; refusing is the honest guard until then.
 */
export function deleteProduct(id: string): { ok: boolean; error?: string } {
  const db = getDb()
  const blocking = db
    .prepare(
      `SELECT DISTINCT po.po_number
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
        WHERE l.product_id = ? AND po.status <> 'cancelled'
        ORDER BY po.po_number`
    )
    .all(id) as Array<{ po_number: string }>
  if (blocking.length > 0) {
    const names = blocking.map((b) => b.po_number)
    const shown = names.slice(0, 4).join(', ')
    const more = names.length - Math.min(4, names.length)
    return {
      ok: false,
      error:
        `This product is on ${names.length === 1 ? 'purchase order' : 'purchase orders'} ` +
        `${shown}${more > 0 ? ` (+${more} more)` : ''}. Cancel or delete ` +
        `${names.length === 1 ? 'that order' : 'those orders'} first — deleting the product now ` +
        `would strip their line items and leave the totals pointing at nothing.`
    }
  }

  const files = (
    db.prepare('SELECT filename FROM inventory_product_images WHERE product_id = ?').all(id) as Array<{
      filename: string
    }>
  ).map((r) => r.filename)
  const info = db.prepare('DELETE FROM inventory_products WHERE id = ?').run(id)
  if (info.changes === 0) return { ok: false, error: 'Product not found.' }
  files.forEach(deleteImageFile)
  return { ok: true }
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
export function addProductImage(productId: string, source: ImageSource): ProductImage[] {
  const exists = getDb().prepare('SELECT id FROM inventory_products WHERE id = ?').get(productId)
  if (!exists) throw new Error('Product not found.')
  const id = newId()
  const filename = importImage(source, id)
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
  actorId: string | null,
  /**
   * Who this was bought from, when the caller knows. Only the purchase-order
   * receipt path and the manual add-stock form do; a scan-in with no PO behind it
   * and an incoming shipment do not, and they pass nothing rather than a guess.
   * It travels onto the cost layer so the picker can tell two layers of the same
   * product at different prices apart by more than their price.
   */
  vendor: string | null = null
): StockResult {
  const db = getDb()
  const run = db.transaction((): StockResult => {
    const row = db.prepare('SELECT unit_cost FROM inventory_products WHERE id = ?').get(productId) as
      | { unit_cost: number }
      | undefined
    if (!row) return { product: null, error: 'Product not found.' }
    // Whole units for the whole catalog, exactly as before v25. A receipt only
    // keeps decimals for a product explicitly flagged for fractions, which no PO
    // receipt or scan-in ever is unless the owner marked that product a giveaway
    // item on purpose.
    const fractional = allowsFractionalQty(db, productId)
    const qty = roundQty(quantity, fractional)
    if (!(qty > 0)) {
      return {
        product: getProduct(productId),
        error: fractional ? 'Enter a quantity greater than zero.' : 'Quantity must be at least 1.'
      }
    }

    bumpStock(productId, location, qty)

    // Record the purchase as a FIFO cost lot. A restock with no cost given
    // inherits the current average so it doesn't move the basis.
    const lotCost =
      unitCost != null && Number.isFinite(unitCost) && unitCost >= 0 ? unitCost : row.unit_cost
    const lotId = createLot(db, productId, location, qty, lotCost, nowIso(), 'restock', note, vendor)
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
  // Same gate as the receipt it reverses, so an undo hands back exactly the
  // number the receipt took in — including a fractional one.
  const qty = roundQty(args.quantity, allowsFractionalQty(db, args.productId))
  if (!(qty > 0)) throw new Error('There is nothing to reverse for that scan.')
  reverseLotReceipt(db, args.lotId, qty)
  bumpStock(args.productId, args.location, -qty)
  syncProductAvgCost(db, args.productId)
  return insertTxn(args.productId, 'adjustment', -qty, null, null, args.note, args.actorId, args.location)
}

/**
 * Correct a location's count up or down (never below zero).
 *
 * `allocation` names the cost layers a DOWNWARD correction comes out of, when an
 * operator was asked. Null is not a failed picker — it is the ordinary case where
 * there was nothing to decide (one layer, or several all at the same unit cost),
 * and it is what every non-interactive caller passes: a purchase-order
 * cancellation, a count-sheet reset, a replayed scan. Those keep the oldest-first
 * behaviour they have always had. Ignored entirely on an upward correction, which
 * OPENS a layer rather than consuming one.
 */
export function adjustStock(
  productId: string,
  location: string,
  quantityChange: number,
  note: string | null,
  actorId: string | null,
  allocation?: LotPick[] | null
): StockResult {
  const db = getDb()
  const run = db.transaction((): StockResult => {
    const exists = db.prepare('SELECT id FROM inventory_products WHERE id = ?').get(productId)
    if (!exists) return { product: null, error: 'Product not found.' }
    const delta = roundQty(quantityChange, allowsFractionalQty(db, productId))
    if (!Number.isFinite(delta) || delta === 0) {
      return { product: getProduct(productId), error: 'Enter a non-zero quantity.' }
    }
    // Slack, so a correction down to exactly zero on a fractional balance is not
    // refused by a dust-width overshoot.
    if (stockQty(productId, location) + delta < -QTY_EPS) {
      return { product: getProduct(productId), error: 'Adjustment would make stock negative.' }
    }
    bumpStock(productId, location, delta)
    let slices: ReturnType<typeof consumeLots> = []
    if (delta < 0) {
      // Shrinkage / correction down — the layers the operator chose, or the
      // oldest when nothing had to be decided.
      slices = consumeLots(db, productId, location, -delta, allocation)
    } else {
      /**
       * Found stock — valued at what THIS SHELF is already carrying.
       *
       * It used to open the layer at `products.unit_cost`, which is
       * `lotWeightedAvgCost` — the average across EVERY location. For a product
       * held in one place that is the same number. For one held in two it is a
       * blend of both, so finding two boxes at AM, where AM's layers cost $250
       * and RM's cost $100, opened an AM layer at about $150. The error is real
       * money, it is permanent (a layer's cost is never re-derived), and it
       * flows straight into COGS the next time those boxes sell.
       *
       * `shelfBasis` is the same expression the count-sheet reset already uses
       * for exactly this decision — its own doc comment calls it "what a
       * found-stock lot at that location should be valued at" — and this was the
       * one found-stock path that did not ask it. The product average remains
       * the fallback, for a shelf that has never had a layer at all.
       *
       * Read AFTER bumpStock deliberately: `lotBasis` is computed from the
       * LAYERS, and no layer has moved yet, so the increment cannot distort the
       * basis it is about to be valued at.
       */
      const shelf = shelfBasis(db, productId, location)
      const row = db.prepare('SELECT unit_cost FROM inventory_products WHERE id = ?').get(productId) as
        | { unit_cost: number }
        | undefined
      const basis = shelf?.lotBasis ?? row?.unit_cost ?? 0
      createLot(db, productId, location, delta, basis, nowIso(), 'adjustment', note)
    }
    syncProductAvgCost(db, productId)
    // The COST of a correction down has always been left off the ledger row —
    // an adjustment is a count correction, not a sale — and that is unchanged.
    // What is new is the COMPOSITION beside it: the exact layers this movement
    // took. Written from the same slice list that decremented them, so the
    // valuation and this record cannot come apart.
    const txnId = insertTxn(productId, 'adjustment', delta, null, null, note, actorId, location)
    recordTxnLots(db, txnId, slices, !!allocation && allocation.length > 0)
    return { product: getProduct(productId) }
  })
  return run()
}

/**
 * Sell from a location's stock: atomic check + decrement + ledger entry.
 *
 * `allocation` is the operator's cost-layer choice; null means there was nothing
 * to choose and FIFO runs, exactly as it always has. The COGS booked on the
 * ledger row is computed from the slices that were actually consumed, whichever
 * of the two produced them — the number on the transaction and the decrement on
 * the layers come from one variable, so a sale cannot be worth one thing to the
 * P&L and another to the valuation.
 */
export function recordSale(
  productId: string,
  location: string,
  quantity: number,
  unitPrice: number,
  client: string,
  note: string | null,
  actorId: string | null,
  allocation?: LotPick[] | null
): StockResult {
  const db = getDb()
  const run = db.transaction((): StockResult => {
    const exists = db.prepare('SELECT id FROM inventory_products WHERE id = ?').get(productId)
    if (!exists) return { product: null, error: 'Product not found.' }
    const fractional = allowsFractionalQty(db, productId)
    const qty = roundQty(quantity, fractional)
    if (!(qty > 0)) {
      return {
        product: getProduct(productId),
        error: fractional ? 'Enter a quantity greater than zero.' : 'Quantity must be at least 1.'
      }
    }
    const have = stockQty(productId, location)
    // Slack: selling the exact fractional balance must not be refused by dust.
    if (qty > have + QTY_EPS) {
      return { product: getProduct(productId), error: `Only ${have} in ${location}.` }
    }
    bumpStock(productId, location, -qty)
    // The layers the operator allocated, or the oldest first when there was
    // nothing to decide. Their cost IS the COGS — not a re-derivation of it.
    const slices = consumeLots(db, productId, location, qty, allocation)
    const cogs = slicesCost(slices)
    syncProductAvgCost(db, productId)
    const txnId = insertTxn(
      productId,
      'sale',
      -qty,
      unitPrice,
      client.trim() || null,
      note,
      actorId,
      location,
      cogs
    )
    recordTxnLots(db, txnId, slices, !!allocation && allocation.length > 0)
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
 * Per-product on-hand, joined to catalog attributes AND to the money the cost
 * layers say that stock is worth.
 *
 * `cost_value` comes from db/valuation.ts — Σ over the product's shelves of what
 * each shelf holds. It is NOT on-hand × the stored average, and that is the
 * point: an average is a rounded per-unit rate, and multiplying it back up by
 * the quantity multiplies its error by the quantity too.
 *
 * `market_value` is the same figure priced. A high bid IS a per-unit number the
 * operator typed, so quantity × bid is exact and stays a multiplication; without
 * a bid, stock is valued at what it cost, which is `cost_value` — so an unpriced
 * product contributes exactly zero spread rather than a rounding residue.
 *
 * `spread_value` is what the product puts into the Spread tile, and it is NOT
 * always market − cost. A BOX may be taken into stock without a unit cost — the
 * cost field on the add-stock form is optional because boxes get picked up ad
 * hoc and there is often no figure to hand — and stock carried at nothing would
 * otherwise report its entire high bid as profit. That is the exact mirror of
 * the unpriced product above, so it gets the same answer: an uncosted box
 * contributes zero until a cost is recorded, and `outside_spread` marks the rows
 * that do, so the market value left out can be reported beside the tile instead
 * of turning value − cost into a subtraction that does not reconcile.
 *
 * BOXES AND NOTHING ELSE. A case, a pack or a single with no cost keeps counting
 * its whole market value as spread exactly as it does today, and the zero-cost
 * banner goes on naming it. A case is a deliberate four-figure purchase whose
 * price is known at the moment it is bought; a box is the thing that gets picked
 * up on the way past. Money that size must not be able to leave the Spread
 * quietly, which is the difference this gate is drawing.
 *
 * The mass-paste check in shared/inventoryReset.ts draws the SAME line, for the
 * same reason: a pasted baseline warns about a box it would leave uncosted and
 * applies it, and still refuses outright for anything larger. It can afford the
 * warning precisely because of this rule — the box it lets through lands outside
 * the Spread and is reported, rather than turning into profit nobody typed.
 */
const PRODUCT_TOTALS = `
  SELECT t.*,
         CASE WHEN t.outside_spread = 1 THEN 0 ELSE t.market_value - t.cost_value END AS spread_value
    FROM (
      SELECT p.id, p.unit_type, p.unit_cost, p.reorder_point, p.category, p.high_bid,
             COALESCE(s.qty, 0) AS qty,
             COALESCE(v.cost_value, 0) AS cost_value,
             CASE WHEN COALESCE(p.high_bid, 0) > 0
                  THEN COALESCE(s.qty, 0) * p.high_bid
                  ELSE COALESCE(v.cost_value, 0)
             END AS market_value,
             -- Stock on the shelf, no cost basis under it, and it is a box.
             -- One definition, read by the spread above and by every caller
             -- that has to say how much money it is holding out.
             CASE WHEN COALESCE(s.qty, 0) > 0
                   AND COALESCE(v.cost_value, 0) <= 0
                   AND p.unit_type = 'box'
                  THEN 1 ELSE 0
             END AS outside_spread
      FROM inventory_products p
      LEFT JOIN (SELECT product_id, SUM(quantity) AS qty FROM inventory_stock GROUP BY product_id) s
        ON s.product_id = p.id
      LEFT JOIN (${PRODUCT_BASIS}) v ON v.product_id = p.id
    ) t
`

export function inventoryStats(): InventoryStats {
  const db = getDb()
  const p = db
    .prepare(
      `SELECT
         COALESCE(SUM(t.market_value), 0)                                          AS total_value,
         COALESCE(SUM(t.cost_value), 0)                                            AS total_cost,
         COALESCE(SUM(t.spread_value), 0)                                          AS spread,
         COALESCE(SUM(CASE WHEN t.outside_spread=1 THEN t.market_value ELSE 0 END), 0) AS outside_value,
         COALESCE(SUM(t.outside_spread), 0)                                        AS outside_count,
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

  // Stock carried at nothing. Tested on `cost_value` rather than on the stored
  // average, because the layers are what a total is built from: a shelf whose
  // layers are all at zero is carrying no basis whatever the product row says.
  // `market_value` in PRODUCT_TOTALS already falls back to cost, so for these
  // rows it IS the high bid.
  //
  // ALL of it is listed, boxes and everything else, because every row here is a
  // product whose money the app cannot fully account for. What differs is which
  // way it is wrong, and `outsideSpread` is how the banner says so: an uncosted
  // box is market value the Spread is leaving out, while an uncosted case is
  // market value the Spread is still counting as profit. One list, two
  // sentences. Ordered by how much money each is carrying either way.
  const zeroCost = (
    db
      .prepare(
        `SELECT t.id, p.name, t.qty, t.market_value AS market_value, t.outside_spread
           FROM (${PRODUCT_TOTALS}) t
           JOIN inventory_products p ON p.id = t.id
          WHERE t.qty > 0 AND t.cost_value <= 0
          ORDER BY market_value DESC`
      )
      .all() as Array<{
      id: string
      name: string
      qty: number
      market_value: number
      outside_spread: number
    }>
  ).map((r) => ({
    id: r.id,
    name: r.name,
    quantity: r.qty,
    marketValue: r.market_value,
    outsideSpread: r.outside_spread === 1
  }))

  return {
    totalValue: p.total_value,
    totalCost: p.total_cost,
    // Summed per product rather than taken as total_value − total_cost, which is
    // no longer the same number: an uncosted box is counted in the value and
    // contributes nothing here. The difference between the two is exactly
    // `outsideSpreadValue`, which is why it is returned rather than left for the
    // operator to discover by subtracting two tiles.
    spread: p.spread,
    outsideSpreadValue: p.outside_value,
    outsideSpreadCount: p.outside_count,
    boxes: p.boxes,
    cases: p.cases,
    packs: p.packs,
    singles: p.singles,
    units: p.units,
    skuCount: p.sku_count,
    lowStockCount: p.low_stock,
    salesRevenue: s.revenue,
    salesCount: s.cnt,
    unitsByLocation,
    zeroCost,
    layerGaps: layerGaps(db)
  }
}

export function categorySummaries(): CategorySummary[] {
  const rows = getDb()
    .prepare(
      `SELECT
         CASE WHEN TRIM(t.category)='' THEN 'Uncategorized' ELSE t.category END AS category,
         COALESCE(SUM(CASE WHEN t.unit_type='case' THEN t.qty ELSE 0 END),0) AS cases,
         COALESCE(SUM(CASE WHEN t.unit_type='box'  THEN t.qty ELSE 0 END),0) AS boxes,
         COALESCE(SUM(t.qty),0)            AS units,
         -- Summed from the same per-product figure the headline tile sums, so
         -- the bars of the value-by-category chart add up to it exactly. This
         -- is the MARKET side, which the uncosted-box rule does not touch: the
         -- owner has those boxes and they are worth what they are worth. It is
         -- only the spread they stay out of, and no category figure is a spread.
         COALESCE(SUM(t.market_value),0)   AS value,
         COUNT(t.id)                       AS product_count
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
  const values = allCostValues(getDb())
  return rows.map((r) => toProduct(r, stock.get(r.id) ?? {}, values.get(r.id) ?? 0))
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
