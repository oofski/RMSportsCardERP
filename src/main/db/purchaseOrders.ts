import type Database from 'better-sqlite3'
import type {
  NewPurchaseOrder,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderStatus
} from '@shared/types'
import { canTransition } from '@shared/purchaseOrders'
import { LOCATION_IDS, isLocation } from '@shared/inventory'
import { getDb, getMeta, setMeta } from './database'
import { addStock } from './inventory'
import { recordPoCogs, voidPoCogs } from './finance'
import { newId, nowIso } from '../util'

interface PoRow {
  id: string
  po_number: string
  supplier: string | null
  notes: string | null
  status: string
  location: string
  total: number
  created_by: string | null
  created_at: string
  updated_at: string
  ordered_at: string | null
  paid_at: string | null
  received_at: string | null
  cancelled_at: string | null
  scanned_at: string | null
}

interface PoLineRow {
  id: string
  po_id: string
  product_id: string
  product_name: string
  sku: string
  category: string
  quantity: number
  unit_price: number
  position: number
}

/** Round to whole cents so line totals never carry float drift. */
const cents = (n: number): number => Math.round(n * 100) / 100

function toSummary(row: PoRow & { line_count: number }): PurchaseOrder {
  return {
    id: row.id,
    poNumber: row.po_number,
    supplier: row.supplier ?? null,
    notes: row.notes ?? null,
    status: row.status as PurchaseOrderStatus,
    location: row.location,
    total: row.total,
    lineCount: row.line_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderedAt: row.ordered_at,
    paidAt: row.paid_at,
    receivedAt: row.received_at,
    cancelledAt: row.cancelled_at,
    scannedAt: row.scanned_at
  }
}

function toLine(row: PoLineRow): PurchaseOrderLine {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    category: row.category,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    lineTotal: cents(row.quantity * row.unit_price)
  }
}

const PO_SELECT = `
  SELECT po.id, po.po_number, po.supplier, po.notes, po.status, po.location, po.total,
         po.created_by, po.created_at, po.updated_at,
         po.ordered_at, po.paid_at, po.received_at, po.cancelled_at, po.scanned_at,
         (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count
  FROM purchase_orders po
`

const LINE_SELECT = `
  SELECT l.id, l.po_id, l.product_id, p.name AS product_name, p.sku AS sku,
         p.category AS category, l.quantity, l.unit_price, l.position
  FROM purchase_order_lines l
  JOIN inventory_products p ON p.id = l.product_id
  WHERE l.po_id = ?
  ORDER BY l.position ASC, l.created_at ASC
`

export function listPurchaseOrders(): PurchaseOrder[] {
  const rows = getDb()
    .prepare(`${PO_SELECT} ORDER BY po.created_at DESC`)
    .all() as Array<PoRow & { line_count: number }>
  return rows.map(toSummary)
}

export function getPurchaseOrder(id: string): PurchaseOrderDetail | null {
  const header = getDb().prepare(`${PO_SELECT} WHERE po.id = ?`).get(id) as
    | (PoRow & { line_count: number })
    | undefined
  if (!header) return null
  const lines = (getDb().prepare(LINE_SELECT).all(id) as PoLineRow[]).map(toLine)
  return { ...toSummary(header), lines }
}

/**
 * Every not-yet-cancelled PO with its line items, newest first — the "incoming
 * shipment boxes" the Inventory module shows. Each box carries the PO's live
 * stage (ordered/paid/received), so the tag always matches the pipeline. These
 * do NOT touch on-hand stock; the cases only fold into inventory later, at the
 * scan/check-in step.
 */
export function listActivePurchaseOrderBoxes(): PurchaseOrderDetail[] {
  const db = getDb()
  // ISO strings sort chronologically (matching nowIso() storage), so a lexical
  // >= compare against a computed cutoff is a valid 14-day window test.
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const headers = db
    .prepare(
      `${PO_SELECT}
       WHERE po.status != 'cancelled'
         AND po.scanned_at IS NULL
         AND (po.status != 'received' OR po.received_at IS NULL OR po.received_at >= @cutoff)
       ORDER BY po.created_at DESC`
    )
    .all({ cutoff }) as Array<PoRow & { line_count: number }>
  const lineStmt = db.prepare(LINE_SELECT)
  return headers.map((h) => ({
    ...toSummary(h),
    lines: (lineStmt.all(h.id) as PoLineRow[]).map(toLine)
  }))
}

export function createPurchaseOrder(
  input: NewPurchaseOrder,
  actorId: string | null
): PurchaseOrderDetail {
  const db = getDb()
  const location = isLocation(input.location) ? input.location : LOCATION_IDS[0]
  const create = db.transaction((): string => {
    const id = newId()
    const ts = nowIso()
    const poNumber = nextPoNumber(db)
    // Sum the SAME per-line rounded values the receipt/detail shows (toLine
    // rounds each line to cents), so the stored header total always equals
    // Σ(lineTotal) even when a unit price carries sub-cent precision.
    const total = cents(
      input.lines.reduce((sum, l) => sum + cents(Math.round(l.quantity) * Math.max(0, l.unitPrice)), 0)
    )
    db.prepare(
      `INSERT INTO purchase_orders
         (id, po_number, supplier, notes, status, location, total, created_by, created_at, updated_at, ordered_at)
       VALUES
         (@id, @po_number, @supplier, @notes, 'ordered', @location, @total, @created_by, @ts, @ts, @ts)`
    ).run({
      id,
      po_number: poNumber,
      supplier: input.supplier?.trim() || null,
      notes: input.notes?.trim() || null,
      location,
      total,
      created_by: actorId,
      ts
    })

    const insertLine = db.prepare(
      `INSERT INTO purchase_order_lines
         (id, po_id, product_id, quantity, unit_price, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    input.lines.forEach((line, i) => {
      insertLine.run(newId(), id, line.productId, Math.round(line.quantity), Math.max(0, line.unitPrice), i, ts)
    })
    // Record the purchase as a Cost-of-Goods-Sold ledger entry (same rounded
    // total, same creation timestamp), atomic with the PO insert.
    recordPoCogs(db, { poId: id, poNumber, amount: total, occurredAt: ts, note: `Purchase order ${poNumber}` })
    return id
  })
  const id = create()
  return getPurchaseOrder(id) as PurchaseOrderDetail
}

export interface PoStatusResult {
  po: PurchaseOrderDetail | null
  error?: string
}

/** Column stamped when a PO enters each stage (ordered_at is set at creation). */
const STATUS_TS_COLUMN: Record<PurchaseOrderStatus, string> = {
  ordered: 'ordered_at',
  paid: 'paid_at',
  received: 'received_at',
  cancelled: 'cancelled_at'
}

export function setPurchaseOrderStatus(
  id: string,
  status: PurchaseOrderStatus,
  actorId: string | null
): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const row = db
      .prepare('SELECT id, status, po_number FROM purchase_orders WHERE id = ?')
      .get(id) as { id: string; status: PurchaseOrderStatus; po_number: string } | undefined
    if (!row) return { po: null, error: 'Purchase order not found.' }
    if (row.status === status) return { po: getPurchaseOrder(id) }
    if (!canTransition(row.status, status)) {
      return { po: getPurchaseOrder(id), error: `Cannot move a ${row.status} PO to ${status}.` }
    }

    const ts = nowIso()
    const tsCol = STATUS_TS_COLUMN[status]
    // ordered_at is set once at creation; on an undo back to 'ordered' keep the
    // original stamp but clear the downstream stage stamps so the timestamps
    // reflect the PO's current stage (no stale paid_at on a reopened PO).
    if (status === 'ordered') {
      db.prepare(
        'UPDATE purchase_orders SET status = ?, paid_at = NULL, received_at = NULL, updated_at = ? WHERE id = ?'
      ).run(status, ts, id)
    } else {
      db.prepare(
        `UPDATE purchase_orders SET status = ?, ${tsCol} = ?, updated_at = ? WHERE id = ?`
      ).run(status, ts, ts, id)
      // Cancelling a PO voids its COGS ledger entry. Cancel is only reachable
      // from ordered/paid (per PO_TRANSITIONS), so this is the single void point.
      if (status === 'cancelled') voidPoCogs(db, id)
    }

    if (status === 'received') {
      // --- DEFERRED: received -> inventory writeback -------------------------
      // TODO(po-receive): when the received->inventory feature ships, fold each
      // PO line into on-hand stock + a FIFO cost lot HERE, e.g.:
      //   const lines = db.prepare('SELECT product_id, quantity, unit_price FROM purchase_order_lines WHERE po_id = ?').all(id)
      //   for (const l of lines) addStock(l.product_id, <destination location>, l.quantity, l.unit_price, `PO ${row.po_number}`, actorId)
      // The line's unit_price is the intended FIFO cost basis (see db/inventory.ts
      // addStock -> lots.createLot). A destination location is NOT captured on the
      // PO header yet (minimal header for now) and must be added before this runs.
      // Until then, 'received' is a pipeline stage ONLY — no stock/lot mutation.
      // ----------------------------------------------------------------------
      void actorId // reserved: becomes the ledger actor when the hook above ships
    }

    return { po: getPurchaseOrder(id) }
  })
  return run()
}

export interface ScanInResult {
  po: PurchaseOrderDetail | null
  error?: string
}

/**
 * Scan a PO's cases into on-hand stock. Idempotent + atomic: the scanned_at
 * guard is read INSIDE the same transaction that stamps it, so a double-click
 * adds stock exactly once. Each line folds into inventory through the existing
 * addStock engine (moving weighted-average cost + FIFO cost lot), so no stock or
 * cost math is hand-rolled. A line failure THROWS to roll back every prior line.
 */
export function scanInPurchaseOrder(id: string, actorId: string | null): ScanInResult {
  const db = getDb()
  const run = db.transaction((): ScanInResult => {
    const h = db
      .prepare('SELECT id, status, po_number, location, scanned_at FROM purchase_orders WHERE id = ?')
      .get(id) as
      | { id: string; status: PurchaseOrderStatus; po_number: string; location: string; scanned_at: string | null }
      | undefined
    if (!h) return { po: null, error: 'Purchase order not found.' }
    if (h.status === 'cancelled') return { po: getPurchaseOrder(id), error: 'This purchase order was cancelled.' }
    if (h.scanned_at)
      return { po: getPurchaseOrder(id), error: 'This purchase order has already been scanned in.' } // idempotency guard
    const lines = db
      .prepare('SELECT product_id, quantity, unit_price FROM purchase_order_lines WHERE po_id = ?')
      .all(id) as Array<{ product_id: string; quantity: number; unit_price: number }>
    for (const l of lines) {
      const res = addStock(l.product_id, h.location, l.quantity, l.unit_price, `Scanned in ${h.po_number}`, actorId)
      if (res.error) throw new Error(res.error) // THROW so the outer txn rolls back every prior line (atomic)
    }
    const ts = nowIso()
    if (h.status !== 'received')
      db.prepare(
        'UPDATE purchase_orders SET status = ?, received_at = ?, scanned_at = ?, updated_at = ? WHERE id = ?'
      ).run('received', ts, ts, ts, id)
    else db.prepare('UPDATE purchase_orders SET scanned_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id)
    return { po: getPurchaseOrder(id) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(id), error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read + increment the shared PO sequence counter, returning "PO-0001" etc.
 * Called inside the create transaction so the bump + insert commit atomically. */
function nextPoNumber(db: Database.Database): string {
  const seq = Number(getMeta(db, 'po_seq') ?? '0') + 1
  setMeta(db, 'po_seq', String(seq))
  return 'PO-' + String(seq).padStart(4, '0')
}
