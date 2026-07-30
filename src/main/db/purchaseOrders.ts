import type Database from 'better-sqlite3'
import type {
  NewPurchaseOrder,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderStatus,
  ScanPoCandidate
} from '@shared/types'
import { canTransition } from '@shared/purchaseOrders'
import { LOCATION_IDS, isLocation } from '@shared/inventory'
import { getDb, getMeta, setMeta } from './database'
import { addStock, adjustStock, reverseStockReceipt, stockQty } from './inventory'
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
  qty_received: number
  received_at: string | null
}

/** Round to whole cents so line totals never carry float drift. */
const cents = (n: number): number => Math.round(n * 100) / 100

function toSummary(row: PoHeaderRow): PurchaseOrder {
  return {
    id: row.id,
    poNumber: row.po_number,
    supplier: row.supplier ?? null,
    notes: row.notes ?? null,
    status: row.status as PurchaseOrderStatus,
    location: row.location,
    total: row.total,
    lineCount: row.line_count,
    receivedLineCount: row.received_line_count,
    receivedUnits: row.received_units,
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
    lineTotal: cents(row.quantity * row.unit_price),
    qtyReceived: row.qty_received,
    qtyOutstanding: Math.max(0, row.quantity - row.qty_received),
    receivedAt: row.received_at
  }
}

const PO_SELECT = `
  SELECT po.id, po.po_number, po.supplier, po.notes, po.status, po.location, po.total,
         po.created_by, po.created_at, po.updated_at,
         po.ordered_at, po.paid_at, po.received_at, po.cancelled_at, po.scanned_at,
         (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count,
         (SELECT COUNT(*) FROM purchase_order_lines l
           WHERE l.po_id = po.id AND l.qty_received >= l.quantity) AS received_line_count,
         (SELECT COALESCE(SUM(l.qty_received), 0) FROM purchase_order_lines l
           WHERE l.po_id = po.id) AS received_units
  FROM purchase_orders po
`

const LINE_SELECT = `
  SELECT l.id, l.po_id, l.product_id, p.name AS product_name, p.sku AS sku,
         p.category AS category, l.quantity, l.unit_price, l.position,
         l.qty_received, l.received_at
  FROM purchase_order_lines l
  JOIN inventory_products p ON p.id = l.product_id
  WHERE l.po_id = ?
  ORDER BY l.position ASC, l.created_at ASC
`

type PoHeaderRow = PoRow & {
  line_count: number
  received_line_count: number
  received_units: number
}

export function listPurchaseOrders(): PurchaseOrder[] {
  const rows = getDb().prepare(`${PO_SELECT} ORDER BY po.created_at DESC`).all() as PoHeaderRow[]
  return rows.map(toSummary)
}

export function getPurchaseOrder(id: string): PurchaseOrderDetail | null {
  const header = getDb().prepare(`${PO_SELECT} WHERE po.id = ?`).get(id) as PoHeaderRow | undefined
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
    .all({ cutoff }) as PoHeaderRow[]
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
      // Cancelling a PO voids its COGS ledger entry — the single void point.
      if (status === 'cancelled') {
        // Cancelling a RECEIVED PO has to give the stock back, or inventory
        // keeps units that no document accounts for. Each line is reversed
        // against the exact FIFO lot its receipt opened, so the cost layer that
        // came in is the one that goes out — never the FIFO-oldest, which would
        // cannibalise a different (possibly cheaper) layer and quietly move the
        // average. reverseStockReceipt THROWS when part of that stock has
        // already been sold, which rolls this whole transaction back and leaves
        // the PO exactly as it was.
        reverseReceivedLines(db, id, row.po_number, actorId)
        voidPoCogs(db, id)
      }
    }

    if (status === 'received') {
      // Moving a PO to Received on the board takes its stock in for real — the
      // same primitive the scanner uses, so both routes to "Received" produce
      // identical stock, FIFO lots and average cost. Without this the board and
      // the scan path would disagree: two cards in the Received column, only one
      // of which actually moved inventory.
      // Only OUTSTANDING quantity is received, so a PO that was partially
      // scanned in is topped up rather than double-counted.
      const outstanding = db
        .prepare(
          `SELECT id, quantity - qty_received AS outstanding
             FROM purchase_order_lines
            WHERE po_id = ? AND qty_received < quantity
            ORDER BY position, rowid`
        )
        .all(id) as Array<{ id: string; outstanding: number }>
      for (const l of outstanding) {
        // Throws on failure so the whole transaction (including the status
        // change above) rolls back — never a "Received" PO with partial stock.
        receivePoLine(db, l.id, l.outstanding, `Received ${row.po_number}`, actorId)
      }
      // Stamps scanned_at once every line is in, which also retires the PO's box
      // from the Incoming panel.
      completePoIfFullyReceived(db, id)
    }

    return { po: getPurchaseOrder(id) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(id), error: err instanceof Error ? err.message : String(err) }
  }
}

/** What receiving one PO line actually did (the scan log records all of it). */
export interface ReceivedPoLine {
  lineId: string
  poId: string
  poNumber: string
  productId: string
  productName: string
  location: string
  /** Units actually received on this call (clamped to the outstanding amount). */
  quantity: number
  unitCost: number
  lotId: string
  txnId: string
}

/**
 * THE single primitive for receiving ONE PO line's stock — used by both the
 * whole-PO button and a UPC scan, so the two paths can never disagree (or
 * double-add).
 *
 * MUST be called inside the caller's db.transaction(): it opens none of its own
 * so it composes with either flow. Throws (rather than returning an error) so a
 * failure rolls back every line received before it, matching the existing
 * scan-in line-loop contract.
 */
export function receivePoLine(
  db: Database.Database,
  lineId: string,
  qty: number,
  note: string | null,
  actorId: string | null
): ReceivedPoLine {
  const row = db
    .prepare(
      `SELECT l.id, l.po_id, l.product_id, l.quantity, l.qty_received, l.unit_price,
              p.name AS product_name, po.po_number, po.status, po.location
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.po_id
       JOIN inventory_products p ON p.id = l.product_id
       WHERE l.id = ?`
    )
    .get(lineId) as
    | {
        id: string
        po_id: string
        product_id: string
        quantity: number
        qty_received: number
        unit_price: number
        product_name: string
        po_number: string
        status: PurchaseOrderStatus
        location: string
      }
    | undefined
  if (!row) throw new Error('That purchase order line no longer exists.')
  // Re-read inside the transaction, so a PO cancelled between resolve and commit
  // is caught here and rolls the whole commit back.
  if (row.status === 'cancelled') throw new Error('That purchase order was cancelled.')
  // THIS is the real double-add guard — not the header's scanned_at. Two scans
  // of the same box serialise (better-sqlite3 is synchronous), and the second
  // sees the first's qty_received.
  const outstanding = row.quantity - row.qty_received
  if (outstanding <= 0) throw new Error('That line has already been fully received.')
  // No quantity (or a nonsense one) means "receive the rest"; over-receiving is
  // impossible because the ask is clamped to what's outstanding.
  const want = Number.isFinite(qty) ? Math.round(qty) : outstanding
  const take = Math.min(Math.max(1, want), outstanding)

  // The one money path: FIFO lot + moving weighted-average cost + ledger entry.
  const res = addStock(
    row.product_id,
    row.location,
    take,
    row.unit_price,
    note ?? `Scanned in ${row.po_number}`,
    actorId
  )
  if (res.error) throw new Error(res.error) // THROW so the outer txn rolls back every prior line (atomic)

  const ts = nowIso()
  db.prepare(
    `UPDATE purchase_order_lines
        SET qty_received = qty_received + @take,
            received_at  = CASE WHEN qty_received + @take >= quantity THEN @ts ELSE received_at END,
            lot_id       = @lotId
      WHERE id = @id`
  ).run({ take, ts, id: lineId, lotId: res.lotId ?? null })

  // The authoritative record of what this receipt took in. A line received in
  // several commits gets several rows, each naming its own lot — which is what
  // makes an exact reversal possible. (lot_id above is kept only so a database
  // written by the one build that had it can still be read.)
  if (res.lotId) {
    db.prepare(
      `INSERT INTO po_line_receipts (id, po_id, po_line_id, lot_id, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(newId(), row.po_id, lineId, res.lotId, take, ts)
  }

  return {
    lineId,
    poId: row.po_id,
    poNumber: row.po_number,
    productId: row.product_id,
    productName: row.product_name,
    location: row.location,
    quantity: take,
    unitCost: row.unit_price,
    lotId: res.lotId ?? '',
    txnId: res.txnId ?? ''
  }
}

/** The PO header state a completion overwrote, so an undo can restore it. */
export interface PoCompletion {
  completed: boolean
  prevStatus: PurchaseOrderStatus
  prevReceivedAt: string | null
}

/**
 * Auto-complete a PO once every line is fully received. Call inside the caller's
 * transaction, immediately after any receivePoLine.
 *
 * Because listActivePurchaseOrderBoxes() filters on `scanned_at IS NULL`,
 * stamping scanned_at is what makes the completed PO's box leave the Incoming
 * panel. Deliberately does NOT touch finance_cogs: the COGS entry is written
 * once at PO creation by recordPoCogs, and booking it again on receipt would
 * double-count the purchase.
 */
export function completePoIfFullyReceived(db: Database.Database, poId: string): PoCompletion {
  const h = db
    .prepare('SELECT status, received_at, scanned_at FROM purchase_orders WHERE id = ?')
    .get(poId) as
    | { status: PurchaseOrderStatus; received_at: string | null; scanned_at: string | null }
    | undefined
  const unchanged: PoCompletion = {
    completed: false,
    prevStatus: h?.status ?? 'ordered',
    prevReceivedAt: h?.received_at ?? null
  }
  if (!h || h.scanned_at) return unchanged
  const c = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN qty_received >= quantity THEN 1 ELSE 0 END), 0) AS done
       FROM purchase_order_lines WHERE po_id = ?`
    )
    .get(poId) as { total: number; done: number }
  // total > 0 guard: over zero rows SUM and COUNT are both 0, so an empty PO
  // would otherwise auto-complete itself.
  if (c.total === 0 || c.done < c.total) return unchanged
  const ts = nowIso()
  db.prepare(
    `UPDATE purchase_orders
        SET status = 'received', received_at = COALESCE(received_at, @ts), scanned_at = @ts, updated_at = @ts
      WHERE id = @id`
  ).run({ ts, id: poId })
  return { ...unchanged, completed: true }
}

/**
 * Every still-outstanding PO line for a product, oldest PO first (purchase-side
 * FIFO — the earliest order is the one most likely arriving). Read-only.
 *
 * Eligibility keys on scanned_at + qty_received, never on status alone: a PO
 * with status='received' but scanned_at NULL never wrote stock (see the deferred
 * TODO in setPurchaseOrderStatus), so its lines ARE still outstanding and stay
 * scannable. Cancelled POs are excluded entirely.
 */
export function outstandingLinesForProduct(productId: string): ScanPoCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id AS line_id, l.po_id, l.quantity, l.qty_received, l.unit_price, l.position,
              po.po_number, po.status, po.supplier, po.location, po.created_at,
              (SELECT COUNT(*) FROM purchase_order_lines x WHERE x.po_id = l.po_id) AS po_lines_total,
              (SELECT COUNT(*) FROM purchase_order_lines x
                WHERE x.po_id = l.po_id AND x.qty_received < x.quantity) AS po_lines_outstanding
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.po_id
       WHERE l.product_id = ?
         AND po.status != 'cancelled'
         AND po.scanned_at IS NULL
         AND l.qty_received < l.quantity
       ORDER BY po.created_at ASC, po.po_number ASC, l.position ASC`
    )
    .all(productId) as Array<{
    line_id: string
    po_id: string
    quantity: number
    qty_received: number
    unit_price: number
    position: number
    po_number: string
    status: PurchaseOrderStatus
    supplier: string | null
    location: string
    created_at: string
    po_lines_total: number
    po_lines_outstanding: number
  }>
  return rows.map((r) => ({
    lineId: r.line_id,
    poId: r.po_id,
    poNumber: r.po_number,
    supplier: r.supplier,
    status: r.status,
    location: r.location,
    quantity: r.quantity,
    qtyReceived: r.qty_received,
    qtyOutstanding: Math.max(0, r.quantity - r.qty_received),
    unitPrice: r.unit_price,
    poCreatedAt: r.created_at,
    completesPo: r.po_lines_outstanding === 1,
    poLinesTotal: r.po_lines_total,
    poLinesOutstanding: r.po_lines_outstanding
  }))
}

export interface ScanInResult {
  po: PurchaseOrderDetail | null
  error?: string
}

/**
 * Receive a whole PO's remaining cases into on-hand stock. Line-aware since v15:
 * each line is received through receivePoLine, which re-reads its qty_received
 * INSIDE this transaction — so lines already received one-by-one by UPC add
 * nothing here and the PO is simply stamped. (Under the pre-v15 implementation
 * this button would have double-added them.)
 *
 * The header scanned_at check is now only a fast-path early return; per-line
 * qty_received is the authoritative guard. A line failure THROWS to roll back
 * every prior line.
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
      return { po: getPurchaseOrder(id), error: 'This purchase order has already been scanned in.' } // fast path
    const lines = db
      .prepare('SELECT id, quantity, qty_received FROM purchase_order_lines WHERE po_id = ?')
      .all(id) as Array<{ id: string; quantity: number; qty_received: number }>
    // A PO with no lines can never auto-complete (see completePoIfFullyReceived),
    // so say so rather than appearing to do nothing.
    if (lines.length === 0) {
      return { po: getPurchaseOrder(id), error: 'This purchase order has no line items to receive.' }
    }
    for (const l of lines) {
      const outstanding = l.quantity - l.qty_received
      if (outstanding <= 0) continue // already received by UPC scan — never add it twice
      receivePoLine(db, l.id, outstanding, `Scanned in ${h.po_number}`, actorId)
    }
    // Stamps status/received_at/scanned_at once every line is in (a zero-line PO
    // is left alone), so the whole-PO and per-line paths complete identically.
    completePoIfFullyReceived(db, id)
    return { po: getPurchaseOrder(id) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(id), error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Hand back everything a purchase order took into stock. Called only from the
 * cancel path, inside its transaction.
 *
 * A line received BEFORE schema v19 has no lot recorded, so there is no way to
 * know which cost layer to unwind. That is reported rather than approximated:
 * unwinding the wrong layer would silently misstate the average cost of
 * everything left on the shelf, which is worse than refusing.
 */
function reverseReceivedLines(
  db: Database.Database,
  poId: string,
  poNumber: string,
  actorId: string | null
): void {
  const lines = db
    .prepare(
      `SELECT l.id, l.product_id, l.qty_received, l.lot_id, p.location
         FROM purchase_order_lines l
         JOIN purchase_orders p ON p.id = l.po_id
        WHERE l.po_id = ? AND l.qty_received > 0`
    )
    .all(poId) as Array<{
    id: string
    product_id: string
    qty_received: number
    lot_id: string | null
    location: string
  }>

  for (const line of lines) {
    // Newest receipt first: unwinding in reverse order of arrival means a lot
    // is never left half-open behind a later one.
    const receipts = db
      .prepare(
        'SELECT lot_id, quantity FROM po_line_receipts WHERE po_line_id = ? ORDER BY created_at DESC, rowid DESC'
      )
      .all(line.id) as Array<{ lot_id: string; quantity: number }>

    // No receipt rows: either this line predates v20, or it was received by the
    // single build that recorded only lot_id. Fall back to that column when it
    // accounts for the whole quantity, and refuse otherwise rather than reverse
    // the wrong cost layer.
    const plan =
      receipts.length > 0
        ? receipts
        : line.lot_id
          ? [{ lot_id: line.lot_id, quantity: line.qty_received }]
          : []

    if (plan.length === 0) {
      // The old wording ended "Adjust the stock down by hand, then delete the
      // PO", which does not work and cost somebody a hunt: adjusting stock in
      // Inventory does not touch qty_received on the line, so delete still
      // refuses afterwards and the PO cannot be removed at all. Say what is
      // actually true rather than send the operator after a fix that isn't one.
      throw new Error(
        `${poNumber} was received before this version recorded which cost layer each receipt opened, so cancelling it cannot return the stock safely. Adjust the stock by hand in Inventory if the boxes are not really there — but this PO cannot be cancelled or deleted in this version, and will stay on the board.`
      )
    }

    const planned = plan.reduce((sum, r) => sum + r.quantity, 0)
    if (planned !== line.qty_received) {
      throw new Error(
        `${poNumber} has ${line.qty_received} unit(s) received but only ${planned} accounted for, so cancelling it cannot return the stock safely. Adjust the stock by hand instead.`
      )
    }

    for (const r of plan) {
      reverseStockReceipt(db, {
        productId: line.product_id,
        location: line.location,
        quantity: r.quantity,
        lotId: r.lot_id,
        note: `Cancelled ${poNumber}`,
        actorId
      })
    }
  }

  // The lines are open again, and the header must not keep claiming a receipt.
  db.prepare('DELETE FROM po_line_receipts WHERE po_id = ?').run(poId)
  db.prepare(
    `UPDATE purchase_order_lines
        SET qty_received = 0, received_at = NULL, lot_id = NULL
      WHERE po_id = ?`
  ).run(poId)
  db.prepare('UPDATE purchase_orders SET received_at = NULL, scanned_at = NULL WHERE id = ?').run(poId)
}

/**
 * THE WAY OUT of a purchase order that cannot be cancelled and cannot be
 * deleted.
 *
 * A PO received before this app recorded which FIFO layer each receipt opened
 * has no traceable cost layers, so `reverseReceivedLines` refuses and Cancel
 * fails; its lines still carry qty_received, so Delete refuses too. The old
 * advice — "adjust the stock down by hand, then delete the PO" — does not
 * work, because a manual adjustment in Inventory does not touch qty_received.
 * The order was stuck on the board with no in-app remedy.
 *
 * So this does the remedy properly, and the CALLER chooses what happens to the
 * stock, because only a human knows whether the boxes are physically there:
 *
 *   removeStock: true   the units were never really received (a test order, a
 *                       mis-click). They come out of inventory. Each unit is
 *                       reversed against its own FIFO layer where that layer is
 *                       known, and where it is not, it is taken out as an
 *                       ordinary correction down — consuming oldest-first,
 *                       exactly what a hand adjustment would have done, and
 *                       recorded in the product's history naming this PO.
 *
 *   removeStock: false  the boxes are on the shelf and stay there. Only the
 *                       paperwork goes. The FIFO layers keep their own
 *                       unit_cost — nothing in inventory_lots points at a PO —
 *                       so the cost basis of that stock survives intact; what
 *                       is lost is the purchase's row in the COGS ledger and
 *                       the link from the scan history to this order.
 *
 * Stock already SOLD cannot come back out, and this does not pretend otherwise:
 * that quantity is skipped and reported in `soldUnits` so the caller can say so
 * rather than silently deleting less than it claimed.
 */
export function forceDeletePurchaseOrder(
  id: string,
  removeStock: boolean,
  actorId: string | null
): { ok: boolean; error?: string; removedUnits?: number; soldUnits?: number } {
  const db = getDb()
  const row = db
    .prepare('SELECT id, po_number FROM purchase_orders WHERE id = ?')
    .get(id) as { id: string; po_number: string } | undefined
  if (!row) return { ok: false, error: 'Purchase order not found.' }

  let removed = 0
  let sold = 0

  const run = db.transaction((): void => {
    if (removeStock) {
      const lines = db
        .prepare(
          `SELECT l.id, l.product_id, l.qty_received, l.lot_id, p.location
             FROM purchase_order_lines l
             JOIN purchase_orders p ON p.id = l.po_id
            WHERE l.po_id = ? AND l.qty_received > 0`
        )
        .all(id) as Array<{
        id: string
        product_id: string
        qty_received: number
        lot_id: string | null
        location: string
      }>

      for (const line of lines) {
        const receipts = db
          .prepare(
            'SELECT lot_id, quantity FROM po_line_receipts WHERE po_line_id = ? ORDER BY created_at DESC, rowid DESC'
          )
          .all(line.id) as Array<{ lot_id: string; quantity: number }>
        const plan =
          receipts.length > 0
            ? receipts
            : line.lot_id
              ? [{ lot_id: line.lot_id, quantity: line.qty_received }]
              : []

        let outstanding = line.qty_received

        /**
         * Prefer the EXACT layer wherever it is known — same reasoning as
         * cancelling: the cost layer that came in is the one that should go out,
         * never the FIFO-oldest, which would cannibalise a different and
         * possibly cheaper layer and quietly move the average.
         *
         * CLAMPED TO WHAT THE LAYER STILL HOLDS. Asking for the whole receipt
         * makes `reverseLotReceipt` throw the moment any of it has been sold,
         * and the throw abandoned every unit on that line — including the ones
         * still sitting on the shelf. 10 received with 4 sold reversed nothing.
         */
        for (const r of plan) {
          if (outstanding <= 0) break
          const lot = db
            .prepare('SELECT qty_remaining FROM inventory_lots WHERE id = ?')
            .get(r.lot_id) as { qty_remaining: number } | undefined
          const take = Math.min(r.quantity, outstanding, lot?.qty_remaining ?? 0)
          if (take <= 0) continue
          try {
            reverseStockReceipt(db, {
              productId: line.product_id,
              location: line.location,
              quantity: take,
              lotId: r.lot_id,
              note: `Force-deleted ${row.po_number}`,
              actorId
            })
            outstanding -= take
            removed += take
          } catch {
            // The layer will not give these units back. Fall through to the
            // correction below rather than abandoning the whole operation.
          }
        }

        /**
         * Whatever is left has no traceable layer, or its layer would not give
         * the units back. Take it out the way a person would have by hand —
         * but only as much as is ACTUALLY ON THE SHELF.
         *
         * `adjustStock` refuses an ask that would drive stock negative, and it
         * refuses the WHOLE ask: one unit short and nothing moved, while the
         * error path counted every unit as already sold. So the remainder is
         * split against the real on-hand figure, and only the genuine shortfall
         * is reported as sold.
         */
        if (outstanding > 0) {
          const have = stockQty(line.product_id, line.location)
          const take = Math.min(outstanding, Math.max(0, have))
          if (take > 0) {
            const res = adjustStock(
              line.product_id,
              line.location,
              -take,
              `Force-deleted ${row.po_number} — received stock removed`,
              actorId
            )
            if (!res.error) {
              removed += take
              outstanding -= take
            }
          }
          // Anything still outstanding genuinely cannot come back out. Every
          // unit of the line is now accounted for exactly once, so
          // removed + sold always equals what was received.
          sold += outstanding
          outstanding = 0
        }
      }

      db.prepare('DELETE FROM po_line_receipts WHERE po_id = ?').run(id)
      db.prepare(
        `UPDATE purchase_order_lines
            SET qty_received = 0, received_at = NULL, lot_id = NULL
          WHERE po_id = ?`
      ).run(id)
    }

    // Same two statements the ordinary delete runs. Lines cascade; the scan
    // history keeps its rows with po_id set to NULL.
    voidPoCogs(db, id)
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id)
  })

  try {
    run()
    return { ok: true, removedUnits: removed, soldUnits: sold }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Read + increment the shared PO sequence counter, returning "PO-0001" etc.
 * Called inside the create transaction so the bump + insert commit atomically. */
function nextPoNumber(db: Database.Database): string {
  const seq = Number(getMeta(db, 'po_seq') ?? '0') + 1
  setMeta(db, 'po_seq', String(seq))
  return 'PO-' + String(seq).padStart(4, '0')
}

/**
 * Delete a purchase order outright — the paperwork was a mistake, not a buy
 * that happened.
 *
 * REFUSED once ANY of its stock has landed. A received line has already gone
 * through addStock: it bumped quantity, opened a FIFO lot at that unit price
 * and rolled the moving average. Deleting the PO would leave that stock in
 * inventory with its cost basis pointing at a document that no longer exists,
 * and there would be no way to answer "where did these boxes come from and
 * what did they cost". Cancel is the right move for a buy that fell through
 * after receipt; delete is only for one that never should have existed.
 *
 * Lines and the COGS ledger row cascade on delete; inventory_scans keeps its
 * audit rows with po_id set to NULL, so the scan history stays honest about
 * what was scanned even though the order is gone.
 */
export function deletePurchaseOrder(
  id: string,
  actorId: string | null
): { ok: boolean; error?: string } {
  const db = getDb()
  const row = db.prepare('SELECT id, po_number, status FROM purchase_orders WHERE id = ?').get(id) as
    | { id: string; po_number: string; status: string }
    | undefined
  if (!row) return { ok: false, error: 'Purchase order not found.' }

  const received = db
    .prepare('SELECT COALESCE(SUM(qty_received), 0) AS n FROM purchase_order_lines WHERE po_id = ?')
    .get(id) as { n: number }
  if (row.status === 'received' || received.n > 0) {
    return {
      ok: false,
      error:
        received.n > 0 && row.status !== 'received'
          ? `${row.po_number} has ${received.n} unit(s) already checked in. Cancel it instead — deleting would leave that stock with no cost record.`
          : `${row.po_number} has been received into stock. Cancel it instead — deleting would leave that stock with no cost record.`
    }
  }

  const run = db.transaction((): void => {
    // Drop the COGS row explicitly rather than relying on the cascade, so the
    // ledger is corrected the same way cancelling would correct it.
    voidPoCogs(db, id)
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id)
  })
  try {
    run()
    void actorId
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
