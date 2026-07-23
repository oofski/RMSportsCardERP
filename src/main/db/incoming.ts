import type { IncomingShipment, NewIncomingShipment } from '@shared/types'
import { getDb } from './database'
import { addStock } from './inventory'
import { newId, nowIso } from '../util'

interface IncomingRow {
  id: string
  product_id: string
  product_name: string
  sku: string
  category: string
  location: string
  quantity: number
  unit_cost: number | null
  reference: string | null
  expected_date: string | null
  status: string
  note: string | null
  created_at: string
  received_at: string | null
}

const SELECT = `
  SELECT i.id, i.product_id, p.name AS product_name, p.sku AS sku, p.category AS category,
         i.location, i.quantity, i.unit_cost, i.reference, i.expected_date, i.status,
         i.note, i.created_at, i.received_at
  FROM inventory_incoming i
  JOIN inventory_products p ON p.id = i.product_id
`

function toShipment(row: IncomingRow): IncomingShipment {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    category: row.category,
    location: row.location,
    quantity: row.quantity,
    unitCost: row.unit_cost,
    reference: row.reference,
    expectedDate: row.expected_date,
    status: row.status as IncomingShipment['status'],
    note: row.note,
    createdAt: row.created_at,
    receivedAt: row.received_at
  }
}

/**
 * Expected shipments, soonest first. Rows without an expected date sort after
 * dated ones, then by when they were logged.
 */
export function listIncoming(): IncomingShipment[] {
  const rows = getDb()
    .prepare(
      `${SELECT}
       WHERE i.status = 'expected'
       ORDER BY (i.expected_date IS NULL), i.expected_date ASC, i.created_at ASC`
    )
    .all() as IncomingRow[]
  return rows.map(toShipment)
}

export function addIncoming(input: NewIncomingShipment): IncomingShipment {
  const db = getDb()
  const id = newId()
  const ts = nowIso()
  db.prepare(
    `INSERT INTO inventory_incoming
       (id, product_id, location, quantity, unit_cost, reference, expected_date, status, note, created_at, updated_at)
     VALUES
       (@id, @product_id, @location, @quantity, @unit_cost, @reference, @expected_date, 'expected', @note, @ts, @ts)`
  ).run({
    id,
    product_id: input.productId,
    location: input.location,
    quantity: Math.round(input.quantity),
    unit_cost: input.unitCost != null ? Math.max(0, input.unitCost) : null,
    reference: input.reference?.trim() || null,
    expected_date: input.expectedDate?.trim() || null,
    note: input.note?.trim() || null,
    ts
  })
  const row = db.prepare(`${SELECT} WHERE i.id = ?`).get(id) as IncomingRow
  return toShipment(row)
}

/**
 * Receive an expected shipment: fold its units into on-hand stock at its
 * destination (rolling its cost into the moving average), then mark it received.
 * Runs as a single transaction — the inner addStock nests as a savepoint.
 */
export function receiveIncoming(id: string, actorId: string | null): { ok: boolean; error?: string } {
  const db = getDb()
  const run = db.transaction((): { ok: boolean; error?: string } => {
    const row = db.prepare('SELECT * FROM inventory_incoming WHERE id = ?').get(id) as
      | { product_id: string; location: string; quantity: number; unit_cost: number | null; reference: string | null; status: string }
      | undefined
    if (!row) return { ok: false, error: 'Shipment not found.' }
    if (row.status !== 'expected') return { ok: false, error: 'This shipment was already handled.' }

    const note = row.reference ? `Received shipment (${row.reference})` : 'Received incoming shipment'
    const res = addStock(row.product_id, row.location, row.quantity, row.unit_cost, note, actorId)
    if (res.error) return { ok: false, error: res.error }

    const ts = nowIso()
    db.prepare(
      "UPDATE inventory_incoming SET status = 'received', received_at = ?, updated_at = ? WHERE id = ?"
    ).run(ts, ts, id)
    return { ok: true }
  })
  return run()
}

/** Cancel an expected shipment (kept as a cancelled record, not deleted). */
export function cancelIncoming(id: string): boolean {
  const ts = nowIso()
  const info = getDb()
    .prepare("UPDATE inventory_incoming SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'expected'")
    .run(ts, id)
  return info.changes > 0
}
