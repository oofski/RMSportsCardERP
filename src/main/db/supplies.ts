import type {
  NewSupply,
  Supply,
  SupplyPurchaseInput,
  SupplyStats,
  SupplyTransaction,
  SupplyUnit,
  SupplyUseInput,
  UpdateSupply
} from '@shared/types'
import { getDb } from './database'
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
  reorder_point: number
  recurring: number
  notes: string | null
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
    reorderPoint: r.reorder_point,
    recurring: r.recurring === 1,
    notes: r.notes,
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
  actorId: string | null
): void {
  getDb()
    .prepare(
      `INSERT INTO supply_transactions
         (id, supply_id, type, quantity_change, unit_cost, total_cost, note, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(newId(), supplyId, type, quantityChange, unitCost, totalCost, note, actorId, nowIso())
}

export function createSupply(input: NewSupply, actorId: string | null): Supply {
  const db = getDb()
  const id = newId()
  const ts = nowIso()
  const unit = (SUPPLY_UNITS.includes(input.unit) ? input.unit : 'each') as SupplyUnit
  const openQty = Math.max(0, Math.round(input.openingQuantity ?? 0))
  const cost = Math.max(0, Number.isFinite(input.unitCost) ? input.unitCost : 0)

  const create = db.transaction(() => {
    db.prepare(
      `INSERT INTO supplies
         (id, name, unit, quantity, unit_cost, reorder_point, recurring, notes, created_at, updated_at)
       VALUES (@id, @name, @unit, @quantity, @unit_cost, @reorder_point, @recurring, @notes, @ts, @ts)`
    ).run({
      id,
      name: input.name.trim(),
      unit,
      quantity: openQty,
      unit_cost: cost,
      reorder_point: Math.max(0, Math.round(input.reorderPoint ?? 0)),
      recurring: input.recurring ? 1 : 0,
      notes: input.notes?.trim() || null,
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
    reorder_point:
      input.reorderPoint != null ? Math.max(0, Math.round(input.reorderPoint)) : existing.reorderPoint,
    recurring: input.recurring != null ? (input.recurring ? 1 : 0) : existing.recurring ? 1 : 0,
    notes: input.notes !== undefined ? input.notes?.trim() || null : existing.notes,
    updated_at: nowIso()
  }
  getDb()
    .prepare(
      `UPDATE supplies SET
         name=@name, unit=@unit, unit_cost=@unit_cost, reorder_point=@reorder_point,
         recurring=@recurring, notes=@notes, updated_at=@updated_at
       WHERE id=@id`
    )
    .run(next)
  return getSupply(input.id)
}

export function deleteSupply(id: string): boolean {
  const info = getDb().prepare('DELETE FROM supplies WHERE id = ?').run(id)
  return info.changes > 0
}

export interface SupplyResult {
  supply: Supply | null
  error?: string
}

/**
 * Record a supply purchase: add to on-hand and roll the moving weighted-average
 * unit cost so stock value tracks what we actually paid. The purchase total is
 * logged as the operating-expense line for the spend rollup.
 */
export function purchaseSupply(id: string, input: SupplyPurchaseInput, actorId: string | null): SupplyResult {
  const db = getDb()
  const qty = Math.round(input.quantity)
  const run = db.transaction((): SupplyResult => {
    const row = db.prepare('SELECT quantity, unit_cost FROM supplies WHERE id = ?').get(id) as
      | { quantity: number; unit_cost: number }
      | undefined
    if (!row) return { supply: null, error: 'Supply not found.' }
    if (qty <= 0) return { supply: getSupply(id), error: 'Quantity must be at least 1.' }
    const cost =
      input.unitCost != null && Number.isFinite(input.unitCost) && input.unitCost >= 0
        ? input.unitCost
        : row.unit_cost
    const newQty = row.quantity + qty
    // Moving weighted-average across all on-hand units.
    const newAvg = newQty > 0 ? (row.quantity * row.unit_cost + qty * cost) / newQty : cost
    db.prepare('UPDATE supplies SET quantity = ?, unit_cost = ?, updated_at = ? WHERE id = ?').run(
      newQty,
      newAvg,
      nowIso(),
      id
    )
    insertSupplyTxn(id, 'purchase', qty, cost, cost * qty, input.note?.trim() || null, actorId)
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
