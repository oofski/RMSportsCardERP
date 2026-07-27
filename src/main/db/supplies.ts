import type Database from 'better-sqlite3'
import type {
  NewSupply,
  NewSupplyOrder,
  Supply,
  SupplyOrder,
  SupplyOrderStatus,
  SupplyPurchaseInput,
  SupplyStats,
  SupplyTransaction,
  SupplyUnit,
  SupplyUseInput,
  UpdateSupply
} from '@shared/types'
import { getDb } from './database'
import { deleteImageFile, imageDataUrl, importImageFile } from '../services/media'
import { newId, nowIso } from '../util'

/**
 * Operating supplies / consumables — bubble mailers, poly bags, labels, tape,
 * shipping boxes. Kept entirely separate from the sellable card catalog so their
 * on-hand stock never folds into inventory value or spread; the spend they carry
 * is an operating cost, surfaced in the supplies rollup.
 */

export const SUPPLY_UNITS: SupplyUnit[] = ['each', 'roll', 'pack', 'box', 'case', 'other']

interface SupplyRow {
  id: string
  name: string
  unit: string
  quantity: number
  unit_cost: number
  items_per_unit: number
  reorder_point: number
  recurring: number
  notes: string | null
  reorder_url: string | null
  image: string | null
  created_at: string
  updated_at: string
}

function toSupply(r: SupplyRow): Supply {
  const unit = (SUPPLY_UNITS.includes(r.unit as SupplyUnit) ? r.unit : 'other') as SupplyUnit
  return {
    id: r.id,
    name: r.name,
    unit,
    quantity: r.quantity,
    unitCost: r.unit_cost,
    itemsPerUnit: r.items_per_unit > 0 ? r.items_per_unit : 1,
    reorderPoint: r.reorder_point,
    recurring: r.recurring === 1,
    notes: r.notes,
    reorderUrl: r.reorder_url,
    imageUrl: r.image ? imageDataUrl(r.image) : null,
    stockValue: r.quantity * r.unit_cost,
    lowStock: r.reorder_point > 0 && r.quantity <= r.reorder_point,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function listSupplies(): Supply[] {
  const rows = getDb()
    .prepare('SELECT * FROM supplies ORDER BY name COLLATE NOCASE')
    .all() as SupplyRow[]
  return rows.map(toSupply)
}

export function getSupply(id: string): Supply | null {
  const row = getDb().prepare('SELECT * FROM supplies WHERE id = ?').get(id) as SupplyRow | undefined
  return row ? toSupply(row) : null
}

function insertSupplyTxn(
  supplyId: string,
  type: string,
  quantityChange: number,
  unitCost: number | null,
  totalCost: number | null,
  note: string | null,
  actorId: string | null,
  units: number | null = null,
  itemsPerUnit: number | null = null
): void {
  getDb()
    .prepare(
      `INSERT INTO supply_transactions
         (id, supply_id, type, quantity_change, unit_cost, total_cost, note, actor_id, units, items_per_unit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId(), supplyId, type, quantityChange, unitCost, totalCost, note, actorId, units, itemsPerUnit, nowIso())
}

export function createSupply(input: NewSupply, actorId: string | null): Supply {
  const db = getDb()
  const id = newId()
  const ts = nowIso()
  const unit = (SUPPLY_UNITS.includes(input.unit) ? input.unit : 'each') as SupplyUnit
  const openQty = Math.max(0, Math.round(input.openingQuantity ?? 0))
  const cost = Math.max(0, Number.isFinite(input.unitCost) ? input.unitCost : 0)

  const itemsPerUnit = Math.max(1, Math.round(input.itemsPerUnit ?? 1))

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO supplies
         (id, name, unit, quantity, unit_cost, items_per_unit, reorder_point, recurring, notes, reorder_url, created_at, updated_at)
       VALUES (@id, @name, @unit, @quantity, @unit_cost, @items_per_unit, @reorder_point, @recurring, @notes, @reorder_url, @ts, @ts)`
    ).run({
      id,
      name: input.name.trim(),
      unit,
      quantity: openQty,
      unit_cost: cost,
      items_per_unit: itemsPerUnit,
      reorder_point: Math.max(0, Math.round(input.reorderPoint ?? 0)),
      recurring: input.recurring ? 1 : 0,
      notes: input.notes?.trim() || null,
      reorder_url: input.reorderUrl?.trim() || null,
      ts
    })
    // A non-zero opening count is logged as the first purchase so the spend
    // rollup reflects it.
    if (openQty > 0) {
      insertSupplyTxn(id, 'purchase', openQty, cost, cost * openQty, 'Opening stock', actorId)
    }
  })
  create()
  return getSupply(id) as Supply
}

export function updateSupply(input: UpdateSupply): Supply | null {
  const existing = getSupply(input.id)
  if (!existing) return null
  const next = {
    id: input.id,
    name: (input.name ?? existing.name).trim(),
    unit: (input.unit && SUPPLY_UNITS.includes(input.unit) ? input.unit : existing.unit) as SupplyUnit,
    unit_cost: input.unitCost != null ? Math.max(0, input.unitCost) : existing.unitCost,
    items_per_unit:
      input.itemsPerUnit != null ? Math.max(1, Math.round(input.itemsPerUnit)) : existing.itemsPerUnit,
    reorder_point:
      input.reorderPoint != null ? Math.max(0, Math.round(input.reorderPoint)) : existing.reorderPoint,
    recurring: input.recurring != null ? (input.recurring ? 1 : 0) : existing.recurring ? 1 : 0,
    notes: input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
    reorder_url: input.reorderUrl !== undefined ? input.reorderUrl?.trim() || null : existing.reorderUrl,
    updated_at: nowIso()
  }
  getDb()
    .prepare(
      `UPDATE supplies SET
         name=@name, unit=@unit, unit_cost=@unit_cost, items_per_unit=@items_per_unit,
         reorder_point=@reorder_point, recurring=@recurring, notes=@notes, reorder_url=@reorder_url,
         updated_at=@updated_at
       WHERE id=@id`
    )
    .run(next)
  return getSupply(input.id)
}

/** Attach (or replace) a supply's photo. Copies the file into the media store. */
export function setSupplyImage(id: string, srcPath: string): Supply | null {
  const row = getDb().prepare('SELECT image FROM supplies WHERE id = ?').get(id) as
    | { image: string | null }
    | undefined
  if (!row) return null
  const filename = importImageFile(srcPath, `supply-${id}`)
  try {
    getDb().prepare('UPDATE supplies SET image = ?, updated_at = ? WHERE id = ?').run(filename, nowIso(), id)
  } catch (err) {
    deleteImageFile(filename)
    throw err
  }
  // Remove the previous file if the name changed (different extension).
  if (row.image && row.image !== filename) deleteImageFile(row.image)
  return getSupply(id)
}

/** Remove a supply's photo. */
export function clearSupplyImage(id: string): Supply | null {
  const row = getDb().prepare('SELECT image FROM supplies WHERE id = ?').get(id) as
    | { image: string | null }
    | undefined
  if (!row) return null
  if (row.image) {
    getDb().prepare('UPDATE supplies SET image = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id)
    deleteImageFile(row.image)
  }
  return getSupply(id)
}

export function deleteSupply(id: string): boolean {
  const row = getDb().prepare('SELECT image FROM supplies WHERE id = ?').get(id) as
    | { image: string | null }
    | undefined
  const info = getDb().prepare('DELETE FROM supplies WHERE id = ?').run(id)
  if (info.changes > 0 && row?.image) deleteImageFile(row.image)
  return info.changes > 0
}

export interface SupplyResult {
  supply: Supply | null
  error?: string
}

/**
 * Record a supply purchase as an order: `units` (boxes/packs) × `itemsPerUnit`
 * items are added to on-hand, and `total` is what we paid for the whole order.
 * The per-item cost is total ÷ items, which rolls the moving weighted-average.
 * The order total is logged as the operating-expense line for the spend rollup,
 * and the supply's default pack size is updated to the ordered items-per-unit.
 */
/**
 * Core purchase mutation — runs inside the caller's transaction. Adds items to
 * on-hand, rolls the moving weighted-average per-item cost, updates the pack
 * size, and logs the order total as spend. Shared by the direct "Buy" flow and
 * by a supply order transitioning to Delivered.
 */
function applySupplyPurchase(
  db: Database.Database,
  id: string,
  units: number,
  itemsPerUnit: number,
  total: number,
  note: string | null,
  actorId: string | null
): { ok: boolean; error?: string } {
  const row = db.prepare('SELECT quantity, unit_cost FROM supplies WHERE id = ?').get(id) as
    | { quantity: number; unit_cost: number }
    | undefined
  if (!row) return { ok: false, error: 'Supply not found.' }
  if (units <= 0) return { ok: false, error: 'Enter at least 1 unit.' }
  if (itemsPerUnit <= 0) return { ok: false, error: 'Items per unit must be at least 1.' }

  const itemsAdded = units * itemsPerUnit
  const perItem = itemsAdded > 0 ? total / itemsAdded : 0
  const newQty = row.quantity + itemsAdded
  const newAvg = newQty > 0 ? (row.quantity * row.unit_cost + total) / newQty : perItem
  db.prepare(
    'UPDATE supplies SET quantity = ?, unit_cost = ?, items_per_unit = ?, updated_at = ? WHERE id = ?'
  ).run(newQty, newAvg, itemsPerUnit, nowIso(), id)
  insertSupplyTxn(id, 'purchase', itemsAdded, perItem, total, note, actorId, units, itemsPerUnit)
  return { ok: true }
}

export function purchaseSupply(id: string, input: SupplyPurchaseInput, actorId: string | null): SupplyResult {
  const db = getDb()
  const units = Math.round(input.units)
  const itemsPerUnit = Math.round(input.itemsPerUnit)
  const total = Number.isFinite(input.total) ? Math.max(0, input.total) : 0
  const run = db.transaction((): SupplyResult => {
    const res = applySupplyPurchase(db, id, units, itemsPerUnit, total, input.note?.trim() || null, actorId)
    if (!res.ok) return { supply: getSupply(id), error: res.error }
    return { supply: getSupply(id) }
  })
  return run()
}

/** Consume supplies (e.g. mailers used shipping orders). Never goes negative. */
export function useSupply(id: string, input: SupplyUseInput, actorId: string | null): SupplyResult {
  const db = getDb()
  const qty = Math.round(input.quantity)
  const run = db.transaction((): SupplyResult => {
    const row = db.prepare('SELECT quantity FROM supplies WHERE id = ?').get(id) as
      | { quantity: number }
      | undefined
    if (!row) return { supply: null, error: 'Supply not found.' }
    if (qty <= 0) return { supply: getSupply(id), error: 'Quantity must be at least 1.' }
    if (row.quantity - qty < 0) {
      return { supply: getSupply(id), error: `Only ${row.quantity} on hand.` }
    }
    db.prepare('UPDATE supplies SET quantity = quantity - ?, updated_at = ? WHERE id = ?').run(
      qty,
      nowIso(),
      id
    )
    insertSupplyTxn(id, 'use', -qty, null, null, input.note?.trim() || null, actorId)
    return { supply: getSupply(id) }
  })
  return run()
}

/** Correct an on-hand count up or down (+/−). Never goes below zero. */
export function adjustSupply(
  id: string,
  quantityChange: number,
  note: string | null,
  actorId: string | null
): SupplyResult {
  const db = getDb()
  const delta = Math.round(quantityChange)
  const run = db.transaction((): SupplyResult => {
    const row = db.prepare('SELECT quantity FROM supplies WHERE id = ?').get(id) as
      | { quantity: number }
      | undefined
    if (!row) return { supply: null, error: 'Supply not found.' }
    if (delta === 0) return { supply: getSupply(id), error: 'Enter a non-zero quantity.' }
    if (row.quantity + delta < 0) {
      return { supply: getSupply(id), error: 'Adjustment would make stock negative.' }
    }
    db.prepare('UPDATE supplies SET quantity = quantity + ?, updated_at = ? WHERE id = ?').run(
      delta,
      nowIso(),
      id
    )
    insertSupplyTxn(id, 'adjustment', delta, null, null, note?.trim() || null, actorId)
    return { supply: getSupply(id) }
  })
  return run()
}

/** Start of the current calendar month (local), as an ISO instant. */
function monthStartIso(): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).toISOString()
}

export function supplyStats(): SupplyStats {
  const db = getDb()
  const s = db
    .prepare(
      `SELECT
         COUNT(*)                                                              AS item_count,
         COALESCE(SUM(quantity), 0)                                            AS units_on_hand,
         COALESCE(SUM(quantity * unit_cost), 0)                                AS stock_value,
         COALESCE(SUM(CASE WHEN reorder_point > 0 AND quantity <= reorder_point THEN 1 ELSE 0 END), 0) AS low_stock,
         COALESCE(SUM(CASE WHEN recurring = 1 THEN 1 ELSE 0 END), 0)           AS recurring_count
       FROM supplies`
    )
    .get() as Record<string, number>

  const month = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost), 0) AS spend
       FROM supply_transactions WHERE type = 'purchase' AND created_at >= ?`
    )
    .get(monthStartIso()) as { spend: number }

  const all = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost), 0) AS spend
       FROM supply_transactions WHERE type = 'purchase'`
    )
    .get() as { spend: number }

  return {
    itemCount: s.item_count,
    unitsOnHand: s.units_on_hand,
    stockValue: s.stock_value,
    lowStockCount: s.low_stock,
    recurringCount: s.recurring_count,
    spendThisMonth: month.spend,
    spendAllTime: all.spend
  }
}

interface SupplyTxnRow {
  id: string
  supply_id: string
  supply_name: string
  type: string
  quantity_change: number
  unit_cost: number | null
  total_cost: number | null
  note: string | null
  actor_name: string | null
  created_at: string
}

export function listSupplyTransactions(limit = 200): SupplyTransaction[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id, t.supply_id, s.name AS supply_name, t.type, t.quantity_change,
              t.unit_cost, t.total_cost, t.note,
              (e.first_name || ' ' || e.last_name) AS actor_name, t.created_at
       FROM supply_transactions t
       JOIN supplies s ON s.id = t.supply_id
       LEFT JOIN employees e ON e.id = t.actor_id
       ORDER BY t.created_at DESC LIMIT ?`
    )
    .all(limit) as SupplyTxnRow[]
  return rows.map((r) => ({
    id: r.id,
    supplyId: r.supply_id,
    supplyName: r.supply_name,
    type: r.type as SupplyTransaction['type'],
    quantityChange: r.quantity_change,
    unitCost: r.unit_cost,
    totalCost: r.total_cost,
    note: r.note,
    actorName: r.actor_name,
    createdAt: r.created_at
  }))
}

// ---------------------------------------------------------------------------
// Supply orders — Ordered → In-transit → Delivered pipeline
// ---------------------------------------------------------------------------

interface SupplyOrderRow {
  id: string
  supply_id: string
  supply_name: string
  unit: string
  image: string | null
  units: number
  items_per_unit: number
  total: number
  status: string
  note: string | null
  ordered_at: string | null
  in_transit_at: string | null
  delivered_at: string | null
  cancelled_at: string | null
  created_at: string
}

const SUPPLY_ORDER_SELECT = `
  SELECT o.id, o.supply_id, s.name AS supply_name, s.unit AS unit, s.image AS image,
         o.units, o.items_per_unit, o.total, o.status, o.note,
         o.ordered_at, o.in_transit_at, o.delivered_at, o.cancelled_at, o.created_at
  FROM supply_orders o
  JOIN supplies s ON s.id = o.supply_id
`

function toSupplyOrder(r: SupplyOrderRow): SupplyOrder {
  const unit = (SUPPLY_UNITS.includes(r.unit as SupplyUnit) ? r.unit : 'other') as SupplyUnit
  return {
    id: r.id,
    supplyId: r.supply_id,
    supplyName: r.supply_name,
    unit,
    imageUrl: r.image ? imageDataUrl(r.image) : null,
    units: r.units,
    itemsPerUnit: r.items_per_unit,
    items: r.units * r.items_per_unit,
    total: r.total,
    status: r.status as SupplyOrderStatus,
    note: r.note,
    orderedAt: r.ordered_at,
    inTransitAt: r.in_transit_at,
    deliveredAt: r.delivered_at,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at
  }
}

function getSupplyOrder(id: string): SupplyOrder | null {
  const row = getDb().prepare(`${SUPPLY_ORDER_SELECT} WHERE o.id = ?`).get(id) as SupplyOrderRow | undefined
  return row ? toSupplyOrder(row) : null
}

/**
 * Active orders (Ordered / In-transit) plus anything that reached a TERMINAL
 * stage in the last 14 days — delivered or cancelled alike.
 *
 * Cancelled orders used to be filtered out entirely, which made cancelling a
 * one-way disappearance: the row stayed in the table forever with no screen
 * showing it and no way to reach deleteSupplyOrder. The Purchase Orders tab
 * renders a Cancelled lane, so the rows have to reach it.
 */
export function listSupplyOrders(): SupplyOrder[] {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const rows = getDb()
    .prepare(
      `${SUPPLY_ORDER_SELECT}
       WHERE (o.status != 'delivered' OR o.delivered_at IS NULL OR o.delivered_at >= @cutoff)
         AND (o.status != 'cancelled' OR o.cancelled_at IS NULL OR o.cancelled_at >= @cutoff)
       ORDER BY o.created_at DESC`
    )
    .all({ cutoff }) as SupplyOrderRow[]
  return rows.map(toSupplyOrder)
}

export interface SupplyOrderResult {
  order: SupplyOrder | null
  error?: string
}

export function createSupplyOrder(input: NewSupplyOrder, actorId: string | null): SupplyOrderResult {
  const db = getDb()
  const units = Math.round(input.units)
  const itemsPerUnit = Math.round(input.itemsPerUnit)
  const total = Number.isFinite(input.total) ? Math.max(0, input.total) : 0
  const supply = db.prepare('SELECT id FROM supplies WHERE id = ?').get(input.supplyId)
  if (!supply) return { order: null, error: 'Supply not found.' }
  if (units <= 0) return { order: null, error: 'Enter at least 1 unit.' }
  if (itemsPerUnit <= 0) return { order: null, error: 'Items per unit must be at least 1.' }
  const id = newId()
  const ts = nowIso()
  db.prepare(
    `INSERT INTO supply_orders
       (id, supply_id, units, items_per_unit, total, status, note, actor_id, ordered_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'ordered', ?, ?, ?, ?)`
  ).run(id, input.supplyId, units, itemsPerUnit, total, input.note?.trim() || null, actorId, ts, ts)
  return { order: getSupplyOrder(id) }
}

/**
 * Advance an order's stage (forward only) or cancel it. Delivering an order
 * applies its stock/cost exactly once (atomically). Delivered/cancelled orders
 * are terminal — they can't be changed (un-delivering would require reversing
 * the stock, which we don't do).
 */
export function setSupplyOrderStatus(
  id: string,
  status: SupplyOrderStatus,
  actorId: string | null
): SupplyOrderResult {
  const db = getDb()
  const run = db.transaction((): SupplyOrderResult => {
    const row = db.prepare('SELECT * FROM supply_orders WHERE id = ?').get(id) as
      | {
          supply_id: string
          units: number
          items_per_unit: number
          total: number
          status: string
          note: string | null
          in_transit_at: string | null
        }
      | undefined
    if (!row) return { order: null, error: 'Order not found.' }
    if (row.status === 'delivered' || row.status === 'cancelled') {
      return { order: getSupplyOrder(id), error: `This order is already ${row.status}.` }
    }
    if (status === row.status) return { order: getSupplyOrder(id) }
    const ts = nowIso()

    if (status === 'delivered') {
      const res = applySupplyPurchase(
        db,
        row.supply_id,
        row.units,
        row.items_per_unit,
        row.total,
        row.note,
        actorId
      )
      if (!res.ok) return { order: getSupplyOrder(id), error: res.error }
      db.prepare(
        'UPDATE supply_orders SET status = ?, delivered_at = ?, in_transit_at = COALESCE(in_transit_at, ?) WHERE id = ?'
      ).run('delivered', ts, ts, id)
    } else if (status === 'in_transit') {
      db.prepare('UPDATE supply_orders SET status = ?, in_transit_at = COALESCE(in_transit_at, ?) WHERE id = ?').run(
        'in_transit',
        ts,
        id
      )
    } else if (status === 'cancelled') {
      db.prepare('UPDATE supply_orders SET status = ?, cancelled_at = ? WHERE id = ?').run('cancelled', ts, id)
    } else {
      return { order: getSupplyOrder(id), error: 'Unsupported status change.' }
    }
    return { order: getSupplyOrder(id) }
  })
  return run()
}

export function deleteSupplyOrder(id: string): boolean {
  return getDb().prepare('DELETE FROM supply_orders WHERE id = ?').run(id).changes > 0
}
