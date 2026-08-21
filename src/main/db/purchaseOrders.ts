import type Database from 'better-sqlite3'
import type {
  NewPurchaseOrder,
  NewPurchaseOrderLine,
  PoRoutingPatch,
  PurchaseOrder,
  PurchaseOrderAllocation,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderStatus,
  ScanPoCandidate
} from '@shared/types'
import {
  canTransition,
  canonicalDestination,
  destinationHoldsStock,
  isSettledPurchaseOrder,
  orderKindOf,
  type OrderParty,
  type OrderPartyKind,
  type SupplierSuggestion,
  type VendorSummary
} from '@shared/purchaseOrders'
import type { Carrier, PaymentTiming } from '@shared/freight'
import { asCarrier, asPaymentTiming, detectCarrier } from '@shared/freight'
import { asShipStatus } from '@shared/tracking'
import { LOCATION_IDS } from '@shared/inventory'
import { getDb, getMeta, setMeta } from './database'
import { addStock, adjustStock, reverseStockReceipt, stockQty } from './inventory'
import { recordPoCogs, voidPoCogs } from './finance'
import { adoptLegacyFreight, deleteOrderExtras, recordOrderEvent } from './orderExtras'
import { dealTicketRefFor, issueDealTicket } from './dealTickets'
import { newId, nowIso } from '../util'

interface PoRow {
  id: string
  po_number: string
  supplier: string | null
  notes: string | null
  status: string
  location: string
  linked_invoice_id: string | null
  total: number
  created_by: string | null
  created_at: string
  updated_at: string
  ordered_at: string | null
  paid_at: string | null
  received_at: string | null
  cancelled_at: string | null
  scanned_at: string | null
  carrier: string | null
  service: string | null
  tracking_number: string | null
  payment_timing: string | null
  tracking_status: string | null
  tracking_status_detail: string | null
  tracking_status_at: string | null
  tracking_checked_at: string | null
  tracking_error: string | null
  tracking_attempted_at: string | null
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
  header_supplier: string | null
  header_destination: string
}

/** One row of po_unit_destinations: some units, one supplier, one destination. */
interface UnitRow {
  po_id: string
  po_line_id: string
  /** NULL for an unsplit line — the one implicit allocation (invariant I3). */
  allocation_id: string | null
  quantity: number
  qty_received: number
  position: number
  supplier: string | null
  destination: string
  received_at: string | null
}

/**
 * The columns a RECEIPT reads off that view — six of the nine.
 *
 * receivePoLine selects only what it uses, and casting that result to UnitRow
 * would promise three fields the SELECT never fetched: po_id, po_line_id and
 * received_at would all be `undefined` at runtime while the type said otherwise.
 * Nothing reads them today, so the type is narrowed to match the query rather
 * than the query widened to match the type — the next reader who needs one of
 * the three gets a compile error instead of an undefined.
 */
type StockUnitRow = Pick<
  UnitRow,
  'allocation_id' | 'quantity' | 'qty_received' | 'position' | 'supplier' | 'destination'
>

/**
 * "May units bound here be checked into stock?", as SQL — GENERATED from
 * LOCATION_IDS rather than typed out beside it.
 *
 * The alternative is a hard-coded IN ('RM','AM') in eight queries, which is
 * eight copies of a rule that lives in @shared/inventory. Generating it means
 * the SQL and the TypeScript cannot drift apart at all, rather than being
 * checked for drift after the fact; tests/dropship.test.ts (T13) still pins the
 * exact string, so widening LOCATION_IDS fails a test rather than silently
 * turning a new value into a stock-holding shelf everywhere at once.
 *
 * The alias exists because purchase_order_lines now has a `destination` column
 * of its own, so an unqualified name is ambiguous in any query that joins it.
 *
 * KNOWN AND DELIBERATELY LEFT: this test is CASE-SENSITIVE (SQLite compares
 * TEXT byte for byte by default) while `destinationHoldsStock` folds case
 * through `canonicalDestination`, so a stored destination of 'rm' would read as
 * a drop here and as a shelf there. Nothing can store one: every destination
 * goes through `canonicalDestination` at the door, in createPurchaseOrder and in
 * setPurchaseOrderRouting, which rewrites 'rm' to 'RM' before it is saved (T8
 * pins that). Adding COLLATE NOCASE here would make a destination named "rm
 * Collectibles" no more correct and would cost the index on every query that
 * uses this predicate, so the door is the place it is fixed.
 */
const stockDest = (alias = ''): string =>
  `${alias}destination IN (${LOCATION_IDS.map((id) => `'${id}'`).join(', ')})`

/** The generated stock-bound predicate, exported so a test can pin it. */
export const STOCK_DESTINATION_SQL = stockDest()

/**
 * Break "N units of this line arrived" into one receipt per shelf.
 *
 * A line split 6 to RM and 6 to AM has two allocations, and receivePoLine books
 * against exactly one of them — deliberately, because which shelf a box lands on
 * is a physical fact and not something to average. But the delivery form asks
 * one question per line, so somebody answering 12 means "all of it", not "12
 * against whichever allocation you find first".
 *
 * Filling in position order is a GUESS about which shelf got what, and it is the
 * same guess the whole-order button and the scan-in path already make. It is the
 * right one when the whole line arrives, which is the ordinary case; when only
 * part of it has, an operator who cares which shelf it went to can say so by
 * passing an explicit allocation id, which short-circuits this entirely.
 *
 * An unsplit line has exactly one stock allocation with a NULL id, so this
 * returns a single part and the caller makes the single call it always made.
 */
function spreadAcrossStockAllocations(
  db: Database.Database,
  lineId: string,
  take: number,
  allocationId: string | null
): Array<{ allocationId: string | null; take: number }> {
  // An explicit choice is honoured as-is: the operator has told us the shelf,
  // and re-deriving it would throw that answer away.
  if (allocationId) return [{ allocationId, take }]

  const rows = db
    .prepare(
      `SELECT allocation_id, quantity, qty_received
         FROM po_unit_destinations
        WHERE po_line_id = ? AND ${stockDest()}
        ORDER BY position, allocation_id`
    )
    .all(lineId) as Array<{ allocation_id: string | null; quantity: number; qty_received: number }>

  // No stock allocation at all is a wholly drop-shipped line. Return the ask
  // unchanged so receivePoLine throws its own message, which names the product
  // and where the units are actually going — better than anything this function
  // could say about a line it was never meant to handle.
  if (rows.length <= 1) return [{ allocationId: rows[0]?.allocation_id ?? null, take }]

  const parts: Array<{ allocationId: string | null; take: number }> = []
  let left = take
  for (const r of rows) {
    if (left <= 0) break
    const outstanding = Math.max(0, r.quantity - r.qty_received)
    if (outstanding <= 0) continue
    const part = Math.min(outstanding, left)
    parts.push({ allocationId: r.allocation_id, take: part })
    left -= part
  }
  // Anything still unplaced means the ask exceeds what the line's shelves have
  // outstanding. Hand the remainder to the first allocation so receivePoLine
  // raises the over-receipt refusal it would have raised anyway, naming both
  // numbers — swallowing it here would book less than was stated, which is the
  // exact silence this path was rebuilt to remove.
  if (left > 0) {
    if (parts.length > 0) parts[parts.length - 1].take += left
    else parts.push({ allocationId: rows[0].allocation_id, take })
  }
  return parts
}

/** Round to whole cents so line totals never carry float drift. */
const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * STORE THE INHERITANCE, NOT A COPY.
 *
 * A line or an allocation that says the same thing as the row above it stores
 * NULL, which means "same as the header". Copying the value instead would go
 * stale the first time the header changed, and it would also make every row
 * raised before v67 read differently from every row raised after — NULL there
 * has always meant exactly this, which is why the migration writes nothing.
 *
 * Case-insensitive, because a supplier box and a destination box are both free
 * text and "steel city" typed under a header of "Steel City" is the same
 * answer, not an override.
 */
function inheritable(value: string | null | undefined, inherited: string | null): string | null {
  const v = String(value ?? '').trim()
  if (!v) return null
  if (inherited && v.toLowerCase() === inherited.trim().toLowerCase()) return null
  return v
}

function toSummary(row: PoHeaderRow): PurchaseOrder {
  const orderedUnits = row.ordered_units
  const receivableUnits = row.receivable_units
  // Derived from where the units are going, never stored. A stored flag would be
  // a second source of truth that drifts the first time a line is re-routed, and
  // the failure mode is a dropship that still says PO and gets received onto a
  // shelf.
  const dropshipUnits = Math.max(0, orderedUnits - receivableUnits)
  return {
    id: row.id,
    poNumber: row.po_number,
    supplier: row.supplier ?? null,
    notes: row.notes ?? null,
    status: row.status as PurchaseOrderStatus,
    location: row.location,
    linkedInvoiceId: row.linked_invoice_id ?? null,
    total: row.total,
    lineCount: row.line_count,
    receivedLineCount: row.received_line_count,
    receivedUnits: row.received_units,
    orderedUnits,
    orderKind: orderKindOf(receivableUnits, dropshipUnits, row.location),
    receivableUnits,
    dropshipUnits,
    destinationCount: row.destination_count,
    // Null on a purchase order with no sale behind it, which is most of them —
    // and "no linked sale" is a different fact from "its sale has the goods".
    saleAwaitsItems: row.sale_awaits_items == null ? null : row.sale_awaits_items === 1,
    // Nullable so "nobody said" stays distinct from "free" — see the v82 note.
    shippingCost: row.shipping_cost == null ? null : Number(row.shipping_cost),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderedAt: row.ordered_at,
    paidAt: row.paid_at,
    receivedAt: row.received_at,
    cancelledAt: row.cancelled_at,
    scannedAt: row.scanned_at,
    carrier: asCarrier(row.carrier),
    service: row.service ?? null,
    trackingNumber: row.tracking_number ?? null,
    paymentTiming: asPaymentTiming(row.payment_timing),
    trackingStatus: asShipStatus(row.tracking_status),
    trackingStatusDetail: row.tracking_status_detail ?? null,
    trackingStatusAt: row.tracking_status_at ?? null,
    trackingCheckedAt: row.tracking_checked_at ?? null,
    trackingError: row.tracking_error ?? null,
    trackingAttemptedAt: row.tracking_attempted_at ?? null
  }
}

function toAllocation(u: UnitRow): PurchaseOrderAllocation {
  const destination = canonicalDestination(u.destination)
  return {
    id: String(u.allocation_id),
    quantity: u.quantity,
    supplier: u.supplier?.trim() || null,
    destination,
    holdsStock: destinationHoldsStock(destination),
    qtyReceived: u.qty_received,
    qtyOutstanding: Math.max(0, u.quantity - u.qty_received),
    receivedAt: u.received_at
  }
}

/**
 * A line, plus where its units are going.
 *
 * `units` are this line's rows from po_unit_destinations — one per allocation
 * for a split line, exactly one for a line that was never split. THE SECOND CASE
 * IS THE IMPORTANT ONE: it carries the whole quantity at the header's
 * destination, which is precisely what every purchase order raised before
 * dropship existed produces. So `qtyReceivable === quantity` and `allocations`
 * is empty for all of them, and every progress bar, completion test and incoming
 * count reads the number it read before.
 */
function toLine(row: PoLineRow, units: UnitRow[]): PurchaseOrderLine {
  // Defensive only: the view's second arm guarantees at least one row per line.
  const rows: UnitRow[] = units.length
    ? units
    : [
        {
          po_id: row.po_id,
          po_line_id: row.id,
          allocation_id: null,
          quantity: row.quantity,
          qty_received: row.qty_received,
          position: row.position,
          supplier: row.header_supplier,
          destination: row.header_destination,
          received_at: row.received_at
        }
      ]
  const destinations = [...new Set(rows.map((u) => canonicalDestination(u.destination)))]
  const suppliers = [...new Set(rows.map((u) => u.supplier?.trim() || ''))]
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
    receivedAt: row.received_at,
    // Null when the splits disagree: there is no one answer to show in one cell,
    // and picking the first would be a quiet lie about the other half.
    supplier: suppliers.length === 1 ? suppliers[0] || null : null,
    destination: destinations.length === 1 ? destinations[0] : null,
    qtyReceivable: rows.reduce((n, u) => n + (destinationHoldsStock(u.destination) ? u.quantity : 0), 0),
    // Empty for an unsplit line — never a single full-quantity row, so the
    // unsplit state stores nothing at all and stays byte-identical to a legacy
    // line.
    allocations: rows.filter((u) => u.allocation_id !== null).map(toAllocation)
  }
}

/** Units bound for a shelf, over the whole order. */
const RECEIVABLE_UNITS_SQL = `
  (SELECT COALESCE(SUM(CASE WHEN ${stockDest('d.')} THEN d.quantity ELSE 0 END), 0)
     FROM po_unit_destinations d WHERE d.po_id = po.id)`

/** Units that are never coming here. */
const DROP_UNITS_SQL = `
  (SELECT COALESCE(SUM(CASE WHEN ${stockDest('d.')} THEN 0 ELSE d.quantity END), 0)
     FROM po_unit_destinations d WHERE d.po_id = po.id)`

/**
 * Lines that are FULLY ARRIVED, measured against what each line can ever
 * receive — the same denominator completePoIfFullyReceived uses, and for the
 * same reason.
 *
 * The obvious `l.qty_received >= l.quantity` counts a mixed line only when its
 * drop units arrive too, which is never: a 20-unit line split 12 to RM and 8 to
 * a shop stays uncounted for ever, so an order whose whole delivery has landed
 * reports 0 of 1 lines received while its status says Received.
 *
 * A line with NO receivable units is not counted at all, rather than counted as
 * complete on 0 >= 0. A pure-drop order therefore still reports zero received
 * lines, which is what it reported before this existed and what the board draws.
 *
 * Every line raised before v67 has receivable === quantity, so this is the old
 * count verbatim for all of them.
 */
const RECEIVED_LINE_COUNT_SQL = `
  (SELECT COUNT(*) FROM
     (SELECT d.po_line_id,
             SUM(CASE WHEN ${stockDest('d.')} THEN d.quantity     ELSE 0 END) AS receivable,
             SUM(CASE WHEN ${stockDest('d.')} THEN d.qty_received ELSE 0 END) AS received
        FROM po_unit_destinations d WHERE d.po_id = po.id GROUP BY d.po_line_id) r
    WHERE r.receivable > 0 AND r.received >= r.receivable)`

const PO_SELECT = `
  SELECT po.id, po.po_number, po.supplier, po.notes, po.status, po.location,
         po.linked_invoice_id, po.total, po.shipping_cost,
         po.created_by, po.created_at, po.updated_at,
         po.ordered_at, po.paid_at, po.received_at, po.cancelled_at, po.scanned_at,
         po.carrier, po.service, po.tracking_number, po.payment_timing,
         po.tracking_status, po.tracking_status_detail, po.tracking_status_at, po.tracking_checked_at,
         po.tracking_error, po.tracking_attempted_at,
         (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count,
         ${RECEIVED_LINE_COUNT_SQL} AS received_line_count,
         (SELECT COALESCE(SUM(l.qty_received), 0) FROM purchase_order_lines l
           WHERE l.po_id = po.id) AS received_units,
         (SELECT COALESCE(SUM(l.quantity), 0) FROM purchase_order_lines l
           WHERE l.po_id = po.id) AS ordered_units,
         ${RECEIVABLE_UNITS_SQL} AS receivable_units,
         (SELECT COUNT(DISTINCT d.destination) FROM po_unit_destinations d
           WHERE d.po_id = po.id) AS destination_count,
         -- IS THE SALE THIS ORDER SUPPLIES STILL WAITING ON THE GOODS?
         --
         -- A dropship purchase exists to put boxes in a buyer's hands, and when
         -- the sale on the other end says it has nothing yet, THIS is the order
         -- somebody has to chase. Without it the Ready to Ship board knows and
         -- the purchase board — where the supplier's name and the tracking
         -- number are — does not.
         --
         -- One boolean rather than the linked sale's whole fulfilment state:
         -- the other gates are answered by facts that live on the SALE (its
         -- shelf, its measurements) and mean nothing against a purchase order.
         -- Only "the goods are not here yet" is a fact about this document too.
         --
         -- ANY OF THEM, not the first of them. A multi-shipment purchase supplies
         -- one sale per buyer, so it is read off invoices.source_po_id — the many
         -- side — rather than off po.linked_invoice_id, which holds only whichever
         -- sale was saved first. Keyed on the single column, a purchase with five
         -- buyers would go quiet the moment that ONE buyer's order was marked in
         -- hand, while four people were still waiting on boxes nobody was chasing.
         --
         -- AND NULL STILL MEANS "NO SALE BEHIND THIS ORDER", which is a third
         -- state and not a slow way of saying false. Folding it into 0 would be
         -- invisible here and wrong on the board: every ordinary purchase order
         -- would start answering a question about a sale it does not have.
         (SELECT CASE
                   WHEN NOT EXISTS (SELECT 1 FROM invoices i WHERE i.source_po_id = po.id)
                     THEN NULL
                   WHEN EXISTS (
                     SELECT 1 FROM invoices i
                      WHERE i.source_po_id = po.id
                        AND i.items_in_hand_at IS NULL
                        AND i.status != 'void'
                   ) THEN 1
                   ELSE 0
                 END) AS sale_awaits_items
  FROM purchase_orders po
`

const LINE_SELECT = `
  SELECT l.id, l.po_id, l.product_id, p.name AS product_name, p.sku AS sku,
         p.category AS category, l.quantity, l.unit_price, l.position,
         l.qty_received, l.received_at,
         po.supplier AS header_supplier, po.location AS header_destination
  FROM purchase_order_lines l
  JOIN inventory_products p ON p.id = l.product_id
  JOIN purchase_orders po ON po.id = l.po_id
  WHERE l.po_id = ?
  ORDER BY l.position ASC, l.created_at ASC
`

/**
 * Where every unit of an order is going, in one read.
 *
 * received_at comes from the allocation row because the view deliberately does
 * not carry it: the view's job is the destination arithmetic, and a column only
 * one of its two arms could ever fill would invite readers to treat the other
 * arm's NULL as "not received" rather than "not applicable".
 */
const UNIT_SELECT = `
  SELECT d.po_id, d.po_line_id, d.allocation_id, d.quantity, d.qty_received, d.position,
         d.supplier, d.destination, a.received_at
    FROM po_unit_destinations d
    LEFT JOIN purchase_order_allocations a ON a.id = d.allocation_id
`

type PoHeaderRow = PoRow & {
  line_count: number
  received_line_count: number
  received_units: number
  ordered_units: number
  receivable_units: number
  destination_count: number
  sale_awaits_items: number | null
  shipping_cost: number | null
}

/** This order's unit rows, grouped by line, in allocation order. */
function unitsByLine(db: Database.Database, poId: string): Map<string, UnitRow[]> {
  const rows = db
    .prepare(`${UNIT_SELECT} WHERE d.po_id = ? ORDER BY d.position ASC, d.allocation_id ASC`)
    .all(poId) as UnitRow[]
  const byLine = new Map<string, UnitRow[]>()
  for (const r of rows) {
    const list = byLine.get(r.po_line_id)
    if (list) list.push(r)
    else byLine.set(r.po_line_id, [r])
  }
  return byLine
}

/**
 * The board: every order there is still something to do about.
 *
 * SETTLED ORDERS ARE LEFT OUT — completed (paid AND received, or cancelled) more
 * than PO_SETTLE_DAYS ago. They have not gone anywhere: `listPurchaseOrderHistory`
 * is the year's ledger and shows every order regardless of stage, so an order
 * swept off here is one search away and still carries its lines, its dates and
 * the cost basis every FIFO layer points at.
 *
 * The filter is applied in JS against the shared predicate rather than as SQL,
 * so the board and the history and any future caller cannot disagree about what
 * "finished with" means. A few hundred rows is not a query worth optimising
 * against a rule that has to be one rule.
 */
export function listPurchaseOrders(): PurchaseOrder[] {
  const rows = getDb().prepare(`${PO_SELECT} ORDER BY po.created_at DESC`).all() as PoHeaderRow[]
  const now = Date.now()
  return rows.map(toSummary).filter((po) => !isSettledPurchaseOrder(po, now))
}

export function getPurchaseOrder(id: string): PurchaseOrderDetail | null {
  const db = getDb()
  const header = db.prepare(`${PO_SELECT} WHERE po.id = ?`).get(id) as PoHeaderRow | undefined
  if (!header) return null
  const units = unitsByLine(db, id)
  const lines = (db.prepare(LINE_SELECT).all(id) as PoLineRow[]).map((l) =>
    toLine(l, units.get(l.id) ?? [])
  )
  // Attached on the DETAIL path only, and behind a guard — see dealTicketRefFor
  // for why it is not part of PO_SELECT.
  return { ...toSummary(header), ...dealTicketRefFor(db, 'po', id), lines }
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
         AND NOT (${RECEIVABLE_UNITS_SQL} = 0 AND ${DROP_UNITS_SQL} > 0)
       ORDER BY po.created_at DESC`
    )
    .all({ cutoff }) as PoHeaderRow[]
  const lineStmt = db.prepare(LINE_SELECT)
  return headers.map((h) => {
    const units = unitsByLine(db, h.id)
    return {
      ...toSummary(h),
      // A wholly-drop line is still RETURNED — the box has to be able to explain
      // why its count is 12 when the order says 20 — but it carries
      // qtyReceivable 0 and contributes nothing to any total.
      lines: (lineStmt.all(h.id) as PoLineRow[]).map((l) => toLine(l, units.get(l.id) ?? []))
    }
  })
}

/** The routing a draft line asks for, canonicalised and validated. */
interface DraftSplit {
  quantity: number
  supplier: string | null
  destination: string
}

/**
 * Invariants I1 and I5, checked BEFORE anything is written.
 *
 * SQLite cannot express a cross-row sum, so the write path is the only place
 * these can live. Checked over the whole draft rather than line by line for the
 * reason receivePurchaseOrderLines gives about its own form: a bad number on the
 * last line must not leave somebody wondering which of the earlier ones went in.
 * (Nothing would have — this runs before the transaction opens — but the message
 * should not require knowing that.)
 */
function validateSplits(
  db: Database.Database,
  lines: NewPurchaseOrder['lines']
): Map<number, DraftSplit[]> {
  const byIndex = new Map<number, DraftSplit[]>()
  const nameStmt = db.prepare('SELECT name FROM inventory_products WHERE id = ?')
  lines.forEach((line, i) => {
    const raw = Array.isArray(line.allocations) ? line.allocations : []
    if (raw.length === 0) return // NOT SPLIT — writes no rows at all. The whole back-compat mechanism.
    const productName =
      (nameStmt.get(line.productId) as { name: string } | undefined)?.name ?? 'That product'
    const quantity = Math.round(line.quantity)
    const splits: DraftSplit[] = raw.map((a) => ({
      quantity: Math.round(Number(a?.quantity)),
      supplier: typeof a?.supplier === 'string' && a.supplier.trim() ? a.supplier.trim() : null,
      destination: canonicalDestination(String(a?.destination ?? ''))
    }))
    for (const s of splits) {
      // I5. A zero-quantity split is deleted, never stored: a row for no units is
      // a destination somebody stopped choosing, and keeping it would make the
      // line read as split when it is not.
      if (!Number.isFinite(s.quantity) || s.quantity < 1) {
        throw new Error(
          `${productName}: every split needs a whole quantity of at least 1. Remove the empty one, or give it units.`
        )
      }
      if (!s.destination) {
        throw new Error(`${productName}: every split needs a destination.`)
      }
    }
    const sum = splits.reduce((n, s) => n + s.quantity, 0)
    // I1. Named with both numbers, in the style receivePurchaseOrderLines uses.
    if (sum !== quantity) {
      throw new Error(
        `${productName}: the splits add up to ${sum} of ${quantity} ordered, so this order cannot be saved.`
      )
    }
    byIndex.set(i, splits)
  })
  return byIndex
}

export function createPurchaseOrder(
  input: NewPurchaseOrder,
  actorId: string | null
): PurchaseOrderDetail {
  const db = getDb()
  /**
   * THE LINE THAT USED TO KILL THIS FEATURE.
   *
   * It read `isLocation(input.location) ? input.location : LOCATION_IDS[0]`,
   * which silently rewrote every destination that is not RM or AM to 'RM' — so
   * every dropship became an RM purchase order and every unit landed on the
   * shelf, with the cost-basis consequence described in the v67 migration.
   *
   * An unrecognised name is KEPT, not coerced: a one-off drop to a shop that is
   * not in the directory yet must not require a detour into a contacts screen
   * first, which is the rule ContactTypeahead already states for suppliers. Only
   * an empty destination falls back to RM, exactly as before.
   */
  const location = canonicalDestination(String(input.location ?? '').trim()) || LOCATION_IDS[0]
  const splitsByIndex = validateSplits(db, input.lines)
  const create = db.transaction((): string => {
    const id = newId()
    const ts = nowIso()
    const poNumber = nextPoNumber(db)
    // Sum the SAME per-line rounded values the receipt/detail shows (toLine
    // rounds each line to cents), so the stored header total always equals
    // Σ(lineTotal) even when a unit price carries sub-cent precision.
    // FREIGHT IS PART OF IT, on the same terms restateOrderTotal states: what
    // the supplier charges to get the boxes here is money owed on this order.
    // Added at creation as well as on every later restatement, or an order
    // raised WITH freight would report a total that only became right the first
    // time somebody edited it.
    const freight = freightIn(input.shippingCost) ?? 0
    const total = cents(
      input.lines.reduce((sum, l) => sum + cents(Math.round(l.quantity) * Math.max(0, l.unitPrice)), 0) +
        cents(freight)
    )
    /**
     * A header supplier the operator did not type, when every line agrees on one.
     *
     * The common shape of a multi-destination order is ONE supplier shipping to
     * several places, and leaving the header blank there would drop the whole
     * order out of listVendors' figures — a vendor screen that understates spend
     * because of where the boxes went. Only stamped when the answer is
     * unanimous; a genuinely multi-supplier order leaves it alone rather than
     * inventing an apportionment of money across suppliers, which is a separate
     * change with its own reconciliation (see Open risks in the spec).
     */
    const typedSupplier = input.supplier?.trim() || null
    const lineSuppliers = new Set(
      input.lines.flatMap((line, i) => {
        const splits = splitsByIndex.get(i)
        if (splits) return splits.map((s) => s.supplier?.trim() || '')
        return [line.supplier?.trim() || '']
      })
    )
    // An empty string in the set means "inherit", so a set of exactly one empty
    // string yields null and the header stays blank — which is every order
    // raised without line-level suppliers, i.e. all of them until now.
    const unanimous = lineSuppliers.size === 1 ? [...lineSuppliers][0] || null : null
    const headerSupplier = typedSupplier ?? unanimous
    db.prepare(
      `INSERT INTO purchase_orders
         (id, po_number, supplier, notes, status, location, total, created_by, created_at, updated_at, ordered_at,
          carrier, service, tracking_number, payment_timing, shipping_cost)
       VALUES
         (@id, @po_number, @supplier, @notes, 'ordered', @location, @total, @created_by, @ts, @ts, @ts,
          @carrier, @service, @tracking_number, @payment_timing, @shipping_cost)`
    ).run({
      id,
      po_number: poNumber,
      supplier: headerSupplier,
      notes: input.notes?.trim() || null,
      location,
      shipping_cost: freightIn(input.shippingCost),
      total,
      created_by: actorId,
      ts,
      // The carrier is stored as given when it is one of the three, and derived
      // from the number when it is not — a pasted 1Z... identifies itself, so
      // there is no reason to make somebody also pick UPS from a list.
      carrier: asCarrier(input.carrier) ?? detectCarrier(input.trackingNumber ?? ''),
      service: input.service?.trim() || null,
      tracking_number: input.trackingNumber?.trim() || null,
      payment_timing: asPaymentTiming(input.paymentTiming)
    })

    // The first line of the log. Without it a purchase order's history opens on
    // whatever was done to it SECOND, and the moment it came into existence —
    // which is the one every other entry is measured against — is missing.
    recordOrderEvent('po', id, 'created', {
      toStage: 'ordered',
      detail: `Raised as ${poNumber}`,
      actorId,
      db
    })

    // The deal ticket, struck in THIS transaction. Goods committed to come in
    // is a movement, and every movement gets a number — see @shared/dealTickets.
    // Inside the transaction so a purchase order can never exist without one:
    // nothing afterwards would know a number was owed, and the register would
    // have a hole it could not detect, let alone repair.
    issueDealTicket(db, {
      kind: 'purchase_order',
      documentKind: 'po',
      documentId: id,
      documentNumber: poNumber,
      party: headerSupplier,
      amount: total,
      issuedAt: ts,
      actorId
    })

    // Freight typed on the form becomes the order's first PARCEL. Without this
    // the number lives only in the mirror columns, and the first parcel anybody
    // adds later overwrites it — see adoptLegacyFreight.
    adoptLegacyFreight(
      'po',
      id,
      {
        carrier: asCarrier(input.carrier) ?? detectCarrier(input.trackingNumber ?? ''),
        service: input.service ?? null,
        trackingNumber: input.trackingNumber ?? null
      },
      actorId,
      db
    )

    const insertLine = db.prepare(
      `INSERT INTO purchase_order_lines
         (id, po_id, product_id, quantity, unit_price, position, created_at, supplier, destination)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertAllocation = db.prepare(
      `INSERT INTO purchase_order_allocations
         (id, po_id, po_line_id, quantity, supplier, destination, position, qty_received, received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    )
    const headerDestination = location
    input.lines.forEach((line, i) => {
      const lineId = newId()
      // NULL means "same as the header" — the inheritance is stored, not a copy
      // of the value. A copy would go stale the moment the header changed, and
      // it is also what makes every line raised before today read correctly:
      // NULL there has always meant exactly this.
      const lineSupplier = inheritable(line.supplier ?? null, headerSupplier)
      const lineDestination = inheritable(
        line.destination ? canonicalDestination(line.destination) : null,
        headerDestination
      )
      insertLine.run(
        lineId,
        id,
        line.productId,
        Math.round(line.quantity),
        Math.max(0, line.unitPrice),
        i,
        ts,
        lineSupplier,
        lineDestination
      )
      // AN UNSPLIT LINE WRITES ZERO ALLOCATION ROWS. Not one row of the whole
      // quantity — zero. That is what makes an ordinary order identical to one
      // raised before this feature existed, byte for byte.
      const splits = splitsByIndex.get(i)
      if (!splits) return
      splits.forEach((s, pos) => {
        insertAllocation.run(
          newId(),
          id,
          lineId,
          s.quantity,
          inheritable(s.supplier, lineSupplier ?? headerSupplier),
          s.destination,
          pos,
          ts
        )
      })
    })
    // Record the purchase as a Cost-of-Goods-Sold ledger entry (same rounded
    // total, same creation timestamp), atomic with the PO insert.
    recordPoCogs(db, { poId: id, poNumber, amount: total, occurredAt: ts, note: `Purchase order ${poNumber}` })
    return id
  })

  // RETRY THE NUMBER, NOT THE ORDER. `nextPoNumber` reads the table, so the only
  // way to land on a taken number is for one to arrive between the read and the
  // insert — a sync applying in another tick, or a second process on the same
  // file. Each attempt runs in its own transaction and allocates afresh, so the
  // retry picks up whatever just landed. Three is generous: two writers colliding
  // three times in a row is not a thing that happens, and an unbounded loop
  // against a genuinely broken table would hang the app instead of reporting.
  let id: string | null = null
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3 && id === null; attempt++) {
    try {
      id = create()
    } catch (err) {
      lastErr = err
      const message = err instanceof Error ? err.message : String(err)
      if (!/UNIQUE constraint failed: purchase_orders\.po_number/i.test(message)) throw err
    }
  }
  if (id === null) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  return getPurchaseOrder(id) as PurchaseOrderDetail
}

export interface PoStatusResult {
  po: PurchaseOrderDetail | null
  error?: string
}

/**
 * Set (or clear) how a PO travels and when it settles, after the fact.
 *
 * Separate from createPurchaseOrder because the tracking number almost never
 * exists when the order is placed — it turns up in a shipping confirmation
 * hours or days later. Without this the only way to record it would be to
 * delete the PO and re-enter it, which would take its COGS entry and any
 * received stock with it.
 *
 * Every field is optional and `undefined` means "leave it alone", so the board
 * can send just a tracking number without wiping a payment choice somebody else
 * made. An explicit null clears.
 */
export function setPurchaseOrderFreight(
  id: string,
  patch: {
    carrier?: Carrier | null
    service?: string | null
    trackingNumber?: string | null
    paymentTiming?: PaymentTiming | null
  }
): PoStatusResult {
  const db = getDb()
  const row = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(id) as
    | { id: string }
    | undefined
  if (!row) return { po: null, error: 'Purchase order not found.' }

  const sets: string[] = []
  const params: Record<string, unknown> = { id, ts: nowIso() }
  const tracking = patch.trackingNumber === undefined ? undefined : patch.trackingNumber?.trim() || null
  if (patch.carrier !== undefined || tracking !== undefined) {
    // Same rule as creation: an explicit carrier wins, otherwise the number
    // names itself. Recomputed whenever either half changes so the pair can
    // never end up describing two different carriers.
    const explicit = patch.carrier === undefined ? undefined : asCarrier(patch.carrier)
    const current =
      tracking !== undefined
        ? tracking
        : ((db.prepare('SELECT tracking_number AS t FROM purchase_orders WHERE id = ?').get(id) as
            | { t: string | null }
            | undefined)?.t ?? null)
    sets.push('carrier = @carrier')
    params.carrier = explicit ?? detectCarrier(current ?? '')
  }
  if (tracking !== undefined) {
    sets.push('tracking_number = @tracking_number')
    params.tracking_number = tracking
  }
  if (patch.service !== undefined) {
    sets.push('service = @service')
    params.service = patch.service?.trim() || null
  }
  if (patch.paymentTiming !== undefined) {
    sets.push('payment_timing = @payment_timing')
    params.payment_timing = asPaymentTiming(patch.paymentTiming)
  }
  if (!sets.length) return { po: getPurchaseOrder(id) }

  db.prepare(
    `UPDATE purchase_orders SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`
  ).run(params)
  return { po: getPurchaseOrder(id) }
}

/** Column stamped when a PO enters each stage (ordered_at is set at creation). */
const STATUS_TS_COLUMN: Record<PurchaseOrderStatus, string> = {
  ordered: 'ordered_at',
  paid: 'paid_at',
  received: 'received_at',
  cancelled: 'cancelled_at'
}

/**
 * Record that a purchase order has been paid — WITHOUT moving it.
 *
 * ## Why this is not a stage move
 *
 * Stock regularly arrives before the invoice is settled, so an order sits in
 * Received while the money is still owed. Answering that with a transition —
 * adding 'paid' to what a received PO may become — would drag the card back
 * into the Paid column, where it reads as "not received yet" to everybody
 * looking at the board, and would re-run the received branch's stock handling
 * on the way back in. The order has not gone backwards; one more fact is known
 * about it.
 *
 * So payment is a date on the order, not a place in the pipeline. The Paid
 * COLUMN still means "paid and not yet here", which is the ordinary sequence
 * and worth keeping visible; `paid_at` means "the money has gone", wherever the
 * card happens to be sitting.
 *
 * ## What it deliberately does not touch
 *
 * No stock, no cost layer, no COGS. Money left the bank; nothing moved on a
 * shelf. COGS was booked once when the order was raised and is voided only by
 * cancel or delete — paying an invoice is not one of those events, and adding a
 * second booking point here would double-count every order paid this way.
 *
 * Reversible on purpose. A payment marked against the wrong order has to be
 * removable, and the alternative — cancelling the PO to clear it — would hand
 * back stock that is really on the shelf.
 */
/**
 * Add product lines to an order that already exists.
 *
 * A purchase order was write-once: get a line wrong, or find a second case you
 * meant to include, and the only remedy was to cancel and retype the whole
 * thing under a new number — losing the number, the dates, and any paperwork
 * already sent to the supplier.
 *
 * ## The total and the money book move together
 *
 * `purchase_orders.total` is a STORED SNAPSHOT, not a sum computed on read, and
 * a COGS row was written from it when the order was raised. Adding a line has
 * to move both, in the same transaction. Updating one without the other leaves
 * the receipt and the accounts quoting different figures for the same document,
 * with nothing on either screen to say which is right.
 *
 * The total is recomputed from EVERY line with the identical expression
 * `createPurchaseOrder` uses — per-line rounding to cents, then summed — rather
 * than added to the stored figure. Adding to it would let a rounding difference
 * accumulate silently across edits until the header disagreed with the lines it
 * is made of.
 *
 * ## What it refuses, and why those two
 *
 * A CANCELLED order: its money is already back out of COGS, and adding a line
 * would assert a purchase the ledger no longer carries.
 *
 * A RECEIVED order: it is closed, its box is gone from Incoming and its scan
 * queue is empty (both filter on `scanned_at IS NULL`), so a line added here
 * would be immediately unreceivable — outstanding for ever with no screen able
 * to take it in. Reopen it first; that is a decision with a visible effect on
 * the board, and it should be made deliberately rather than as a side effect of
 * adding a product.
 */
export function addPurchaseOrderLines(
  poId: string,
  lines: NewPurchaseOrderLine[]
): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const head = db
      .prepare('SELECT id, po_number, status, supplier, location FROM purchase_orders WHERE id = ?')
      .get(poId) as
      | { id: string; po_number: string; status: PurchaseOrderStatus; supplier: string | null; location: string }
      | undefined
    if (!head) return { po: null, error: 'Purchase order not found.' }
    if (head.status === 'cancelled') {
      return {
        po: getPurchaseOrder(poId),
        error: `${head.po_number} was cancelled. Reopen it before adding anything.`
      }
    }
    if (head.status === 'received') {
      return {
        po: getPurchaseOrder(poId),
        error: `${head.po_number} is closed, so anything added now could never be checked in. Move it back to Ordered first.`
      }
    }
    const wanted = (lines ?? []).filter((l) => l && l.productId && Math.round(l.quantity) > 0)
    if (!wanted.length) return { po: getPurchaseOrder(poId), error: 'Choose a product and a quantity.' }

    // Named, not silently dropped: a product deleted from the catalog between
    // opening the form and saving it is rare and utterly baffling if the line
    // just fails to appear.
    for (const l of wanted) {
      const exists = db
        .prepare('SELECT name FROM inventory_products WHERE id = ?')
        .get(l.productId) as { name: string } | undefined
      if (!exists) return { po: getPurchaseOrder(poId), error: 'That product is no longer in the catalog.' }
    }

    const ts = nowIso()
    const nextPos = (
      db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM purchase_order_lines WHERE po_id = ?').get(poId) as {
        p: number
      }
    ).p
    const insertLine = db.prepare(
      `INSERT INTO purchase_order_lines
         (id, po_id, product_id, quantity, unit_price, position, created_at, supplier, destination)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    wanted.forEach((l, i) => {
      insertLine.run(
        newId(),
        poId,
        l.productId,
        Math.round(l.quantity),
        Math.max(0, l.unitPrice),
        nextPos + 1 + i,
        ts,
        // NULL means "same as the header", exactly as it does on a line written
        // at creation. Storing the inheritance rather than a copy is what keeps
        // a later change of header destination from leaving stale values behind.
        inheritable(l.supplier ?? null, head.supplier),
        inheritable(l.destination ? canonicalDestination(l.destination) : null, head.location)
      )
    })

    const all = db
      .prepare('SELECT quantity, unit_price FROM purchase_order_lines WHERE po_id = ?')
      .all(poId) as Array<{ quantity: number; unit_price: number }>
    const total = cents(
      all.reduce((sum, l) => sum + cents(Math.round(l.quantity) * Math.max(0, l.unit_price)), 0)
    )
    db.prepare('UPDATE purchase_orders SET total = ?, updated_at = ? WHERE id = ?').run(total, ts, poId)
    // The ledger follows the document. UPDATE rather than void-and-rewrite so
    // the row keeps the date the purchase was committed — re-booking it today
    // would move the cost into this month and restate two months at once.
    db.prepare('UPDATE finance_cogs SET amount = ? WHERE po_id = ?').run(total, poId)
    return { po: getPurchaseOrder(poId) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(poId), error: (err as Error).message }
  }
}

/**
 * Recompute the header total and the ledger row from the lines as they now
 * stand.
 *
 * Every edit below changes what the order is worth, and the total is a stored
 * snapshot rather than a view — so it has to be restated deliberately or the
 * document and the money disagree. UPDATE rather than void-and-rewrite, for the
 * same reason `addPurchaseOrderLines` does it: the COGS row keeps the date the
 * purchase was committed. Re-booking it today would move the cost into this
 * month and silently restate two months at once.
 */
/**
 * What this order comes to, and therefore what it costs.
 *
 * FREIGHT IS PART OF IT. What a supplier charges to get the boxes here is money
 * owed on this order, so it belongs in the total and in the COGS row that
 * follows the total one line down.
 *
 * It is NOT spread across the per-unit FIFO layers, and that is a decision
 * rather than an omission. Apportioning freight over units would change the
 * cost basis of stock that may already be sold, on every edit to a shipping
 * figure — so inventory valuation stays ex-freight and the P&L carries the real
 * spend. The two answer different questions and are allowed to differ by the
 * freight.
 */
/**
 * A freight figure on the way in. Null when nobody said, never negative.
 *
 * Zero is kept as zero rather than folded to null: "the supplier shipped it
 * free" is a real answer somebody may want on the document, and it is not the
 * same as leaving the box empty.
 */
function freightIn(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
}

function restateOrderTotal(db: Database.Database, poId: string, ts: string): void {
  const all = db
    .prepare('SELECT quantity, unit_price FROM purchase_order_lines WHERE po_id = ?')
    .all(poId) as Array<{ quantity: number; unit_price: number }>
  const freightRow = db
    .prepare('SELECT shipping_cost FROM purchase_orders WHERE id = ?')
    .get(poId) as { shipping_cost: number | null } | undefined
  const freight = Math.max(0, Number(freightRow?.shipping_cost) || 0)
  const total = cents(
    all.reduce((sum, l) => sum + cents(Math.round(l.quantity) * Math.max(0, l.unit_price)), 0) +
      cents(freight)
  )
  db.prepare('UPDATE purchase_orders SET total = ?, updated_at = ? WHERE id = ?').run(total, ts, poId)
  db.prepare('UPDATE finance_cogs SET amount = ? WHERE po_id = ?').run(total, poId)
}

/**
 * Correct the descriptive half of an order: who it is from, and the note on it.
 *
 * ## Why the supplier is editable at all
 *
 * Because an order raised in a hurry says "No supplier" and there was no way
 * back. A PO's supplier is free text on the document — see @shared/purchaseOrders
 * for why it is not a foreign key — so correcting it is a correction to a label,
 * not a re-pointing of a relationship, and nothing downstream holds a reference
 * that could dangle.
 *
 * ## What changing it does to the lines
 *
 * Lines store their supplier as INHERITABLE: null means "same as the header".
 * That is why this is a rename rather than a rewrite — every line that never
 * named its own supplier follows the header automatically, and a line that DID
 * name one keeps it. A line that explicitly repeated what the header used to say
 * is collapsed back to inheriting, so it does not sit there naming the old
 * vendor after the header has moved on.
 *
 * Allowed in every status, cancelled included. This edits nothing that has
 * money attached — no total, no lot, no ledger row — and the commonest moment to
 * discover the name is missing is while filing an order that is already closed.
 */
export function updatePurchaseOrderHeader(
  id: string,
  patch: { supplier?: string | null; notes?: string | null; shippingCost?: number | null }
): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const head = db
      .prepare('SELECT id, supplier FROM purchase_orders WHERE id = ?')
      .get(id) as { id: string; supplier: string | null } | undefined
    if (!head) return { po: null, error: 'Purchase order not found.' }

    const ts = nowIso()
    const sets: string[] = []
    const params: Record<string, unknown> = { id, ts }

    if (patch.supplier !== undefined) {
      const next = String(patch.supplier ?? '').trim().slice(0, 120) || null
      sets.push('supplier = @supplier')
      params.supplier = next
      // A line storing NULL is INHERITING and must be left alone — that is the
      // whole point of storing the inheritance rather than a copy, and reading
      // its effective value here to write it back would freeze every such line
      // to the name the order is moving away from.
      //
      // Only an explicit value needs a decision, and there is one: keep it,
      // unless it now says exactly what the header says, in which case it
      // collapses back to inheriting so the two cannot drift apart later.
      const lines = db
        .prepare('SELECT id, supplier FROM purchase_order_lines WHERE po_id = ? AND supplier IS NOT NULL')
        .all(id) as Array<{ id: string; supplier: string }>
      const setLine = db.prepare('UPDATE purchase_order_lines SET supplier = ? WHERE id = ?')
      for (const line of lines) setLine.run(inheritable(line.supplier, next), line.id)
    }
    if (patch.notes !== undefined) {
      sets.push('notes = @notes')
      params.notes = String(patch.notes ?? '').trim().slice(0, 2000) || null
    }
    // FREIGHT MOVES THE TOTAL, so it cannot be written like the other two and
    // left there — restateOrderTotal has to run after it, or the order says one
    // thing and its COGS row says another.
    const freightChanged = patch.shippingCost !== undefined
    if (freightChanged) {
      sets.push('shipping_cost = @shipping_cost')
      params.shipping_cost = freightIn(patch.shippingCost)
    }
    if (!sets.length) return { po: getPurchaseOrder(id) }

    db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(
      params
    )
    if (freightChanged) restateOrderTotal(db, id, ts)
    return { po: getPurchaseOrder(id) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(id), error: (err as Error).message }
  }
}

/**
 * Change the quantity or the unit price of a line that already exists.
 *
 * ## The two things this refuses, and why they are different refusals
 *
 * QUANTITY may not fall below what has already been checked in. Units on the
 * shelf came from this line; typing a smaller number would not send them back,
 * it would just make the document disagree with the building. Raising it is
 * fine — that is a short delivery being recorded honestly — and so is lowering
 * it to anywhere at or above what landed.
 *
 * UNIT PRICE may not change once ANY unit has been received, and this is the
 * stricter rule. Receiving stamps the price into a FIFO cost lot; that lot is
 * what every future sale of those units is costed against, and it is already
 * out there in the valuation. Editing the line afterwards would move the header
 * total and the COGS row while leaving the lot where it was, so the order would
 * claim one cost and the stock would carry another. Correct a price BEFORE the
 * boxes are booked in; after that it is a credit note, which is not this button.
 *
 * Refused outright on a cancelled order (its cost is out of the ledger) and on a
 * received one (closed), which is the same pair `addPurchaseOrderLines` refuses
 * and for the same reasons.
 */
export function updatePurchaseOrderLine(
  poId: string,
  lineId: string,
  patch: { quantity?: number; unitPrice?: number }
): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const head = db
      .prepare('SELECT id, po_number, status FROM purchase_orders WHERE id = ?')
      .get(poId) as { id: string; po_number: string; status: PurchaseOrderStatus } | undefined
    if (!head) return { po: null, error: 'Purchase order not found.' }
    if (head.status === 'cancelled') {
      return {
        po: getPurchaseOrder(poId),
        error: `${head.po_number} was cancelled. Reopen it before changing anything on it.`
      }
    }
    if (head.status === 'received') {
      return {
        po: getPurchaseOrder(poId),
        error: `${head.po_number} is closed. Move it back to Ordered before changing what was bought.`
      }
    }

    const line = db
      .prepare(
        `SELECT l.id, l.quantity, l.unit_price, l.qty_received, p.name AS product_name
           FROM purchase_order_lines l
           JOIN inventory_products p ON p.id = l.product_id
          WHERE l.id = ? AND l.po_id = ?`
      )
      .get(lineId, poId) as
      | { id: string; quantity: number; unit_price: number; qty_received: number; product_name: string }
      | undefined
    if (!line) return { po: getPurchaseOrder(poId), error: 'That line is not on this order.' }

    const received = Math.max(0, Math.round(line.qty_received ?? 0))
    const sets: string[] = []
    const params: Record<string, unknown> = { id: lineId }

    if (patch.quantity !== undefined) {
      const qty = Math.round(Number(patch.quantity))
      if (!Number.isFinite(qty) || qty < 1) {
        return { po: getPurchaseOrder(poId), error: 'A quantity has to be at least 1.' }
      }
      if (qty < received) {
        return {
          po: getPurchaseOrder(poId),
          error:
            `${received} of ${line.product_name} ${received === 1 ? 'has' : 'have'} already been ` +
            `checked in, so this line cannot go below ${received}. Take the stock back out first ` +
            `if that is what happened.`
        }
      }
      sets.push('quantity = @quantity')
      params.quantity = qty
    }

    if (patch.unitPrice !== undefined) {
      const price = Number(patch.unitPrice)
      if (!Number.isFinite(price) || price < 0) {
        return { po: getPurchaseOrder(poId), error: 'A unit price cannot be negative.' }
      }
      if (received > 0 && cents(price) !== cents(line.unit_price)) {
        return {
          po: getPurchaseOrder(poId),
          error:
            `${received} of ${line.product_name} ${received === 1 ? 'has' : 'have'} already been ` +
            `received at ${line.unit_price.toFixed(2)}, and that price is what the stock on the ` +
            `shelf is costed at. Changing it here would leave the order and the valuation ` +
            `disagreeing.`
        }
      }
      sets.push('unit_price = @unit_price')
      params.unit_price = Math.max(0, price)
    }

    if (!sets.length) return { po: getPurchaseOrder(poId) }
    db.prepare(`UPDATE purchase_order_lines SET ${sets.join(', ')} WHERE id = @id`).run(params)

    const ts = nowIso()
    // A line raised to more than has landed is outstanding again, so the stamp
    // saying it was complete is no longer true. Left alone when it still is.
    db.prepare(
      `UPDATE purchase_order_lines SET received_at = NULL
        WHERE id = ? AND qty_received < quantity`
    ).run(lineId)
    restateOrderTotal(db, poId, ts)
    return { po: getPurchaseOrder(poId) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(poId), error: (err as Error).message }
  }
}

/**
 * Take a line off an order.
 *
 * Refused once any unit on it has been checked in: those units are on a shelf,
 * costed against a lot that points at this line's price, and deleting the row
 * would leave stock whose origin cannot be explained. Cancel the order — which
 * reverses receipts properly — or reduce the quantity instead.
 *
 * Refused on the LAST line, because an order with nothing on it is not a
 * corrected order, it is a deleted one wearing a number. Delete or cancel it.
 */
export function removePurchaseOrderLine(poId: string, lineId: string): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const head = db
      .prepare('SELECT id, po_number, status FROM purchase_orders WHERE id = ?')
      .get(poId) as { id: string; po_number: string; status: PurchaseOrderStatus } | undefined
    if (!head) return { po: null, error: 'Purchase order not found.' }
    if (head.status === 'cancelled') {
      return {
        po: getPurchaseOrder(poId),
        error: `${head.po_number} was cancelled. Reopen it before changing anything on it.`
      }
    }
    if (head.status === 'received') {
      return {
        po: getPurchaseOrder(poId),
        error: `${head.po_number} is closed. Move it back to Ordered before changing what was bought.`
      }
    }

    const line = db
      .prepare(
        `SELECT l.id, l.qty_received, p.name AS product_name
           FROM purchase_order_lines l
           JOIN inventory_products p ON p.id = l.product_id
          WHERE l.id = ? AND l.po_id = ?`
      )
      .get(lineId, poId) as
      | { id: string; qty_received: number; product_name: string }
      | undefined
    if (!line) return { po: getPurchaseOrder(poId), error: 'That line is not on this order.' }

    const received = Math.max(0, Math.round(line.qty_received ?? 0))
    if (received > 0) {
      return {
        po: getPurchaseOrder(poId),
        error:
          `${received} of ${line.product_name} ${received === 1 ? 'is' : 'are'} already on the ` +
          `shelf against this line, so it cannot just be removed. Cancel the order to reverse the ` +
          `receipt, or lower the quantity instead.`
      }
    }

    const count = (
      db.prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ?').get(poId) as {
        n: number
      }
    ).n
    if (count <= 1) {
      return {
        po: getPurchaseOrder(poId),
        error: `That is the only line on ${head.po_number}. Delete or cancel the order instead.`
      }
    }

    // The allocations go with it. They are ON DELETE CASCADE in the schema, but
    // saying so here is what makes the intent readable at the call site: a split
    // is part of the line, not a thing that outlives it.
    db.prepare('DELETE FROM purchase_order_lines WHERE id = ?').run(lineId)
    restateOrderTotal(db, poId, nowIso())
    return { po: getPurchaseOrder(poId) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(poId), error: (err as Error).message }
  }
}

export function setPurchaseOrderPaid(
  id: string,
  paid: boolean,
  // WHO ticked it. The handler already had this and threw it away; the log is
  // the reason it is worth carrying, and "somebody marked this paid on Tuesday"
  // with no name is the answer the log exists to stop giving.
  actorId: string | null = null
): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const row = db
      .prepare('SELECT id, status, po_number, paid_at FROM purchase_orders WHERE id = ?')
      .get(id) as
      | { id: string; status: PurchaseOrderStatus; po_number: string; paid_at: string | null }
      | undefined
    if (!row) return { po: null, error: 'Purchase order not found.' }
    // A cancelled order is the one terminal stage, and its money has already
    // been taken back out of COGS. Stamping a payment on it would assert a
    // spend the ledger no longer carries.
    if (row.status === 'cancelled') {
      return {
        po: getPurchaseOrder(id),
        error: `${row.po_number} was cancelled, so it cannot be marked paid.`
      }
    }
    // Idempotent: pressing it twice is one payment, not two, and a repeated
    // press must not move the date it already carries.
    if (paid && row.paid_at) return { po: getPurchaseOrder(id) }
    if (!paid && !row.paid_at) return { po: getPurchaseOrder(id) }

    const ts = nowIso()
    db.prepare('UPDATE purchase_orders SET paid_at = ?, updated_at = ? WHERE id = ?').run(
      paid ? ts : null,
      ts,
      id
    )
    recordOrderEvent('po', id, 'paid', {
      detail: paid ? 'Marked paid' : 'Payment un-marked',
      actorId,
      db
    })
    return { po: getPurchaseOrder(id) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(id), error: (err as Error).message }
  }
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
        'UPDATE purchase_orders SET status = ?, paid_at = NULL, received_at = NULL, cancelled_at = NULL, updated_at = ? WHERE id = ?'
      ).run(status, ts, id)
      recordOrderEvent('po', id, 'stage', {
        fromStage: row.status,
        toStage: status,
        actorId,
        db
      })
      // UN-CANCELLING PUTS THE MONEY BACK.
      //
      // Cancelling is the single void point for a PO's COGS row: the purchase
      // stops being a cost because it stopped being a purchase. Reverting makes
      // it a live order again, so the cost has to come back with it — otherwise
      // the board shows an open order for stock that is on its way while the
      // money book has no record of committing to it, and the two disagree for
      // ever with nothing to point at.
      //
      // The stock is deliberately NOT restored. The cancel handed every
      // received unit back and zeroed qty_received, so the order really does
      // have nothing checked in; it is receivable again from scratch, which is
      // both true and the only state its lines can now describe.
      if (row.status === 'cancelled') {
        const head = db
          .prepare('SELECT po_number, total, ordered_at, created_at FROM purchase_orders WHERE id = ?')
          .get(id) as {
          po_number: string
          total: number
          ordered_at: string | null
          created_at: string
        }
        // Guarded rather than assumed: force-delete also voids the row, and a
        // second INSERT would double-count the purchase in every P&L that sums
        // this table.
        const already = db
          .prepare('SELECT COUNT(*) AS n FROM finance_cogs WHERE po_id = ?')
          .get(id) as { n: number }
        if (already.n === 0) {
          recordPoCogs(db, {
            poId: id,
            poNumber: head.po_number,
            amount: head.total,
            // The date the money was committed, not the date somebody fixed the
            // mistake — booking it today would move the purchase into this
            // month's costs and silently restate two months at once.
            occurredAt: head.ordered_at ?? head.created_at,
            note: `Purchase order ${head.po_number}`
          })
        }
      }
    } else {
      db.prepare(
        `UPDATE purchase_orders SET status = ?, ${tsCol} = ?, updated_at = ? WHERE id = ?`
      ).run(status, ts, ts, id)
      // INSIDE the transaction, so the move and the record of it commit
      // together. A log that can lag the board is a log nobody can use to work
      // out what went wrong, which is the only reason anybody opens one.
      recordOrderEvent('po', id, 'stage', {
        fromStage: row.status,
        toStage: status,
        actorId,
        db
      })
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
      //
      // STOCK ALLOCATIONS ONLY. For a pure-drop order this returns nothing, so
      // moving it to Received stamps the status and books no stock — which is
      // the manual way a Drop order is closed, and the only way, because it can
      // never auto-complete.
      // Ordered to be REPEATABLE, not meaningful: the view's position means the
      // allocation's place within its line on one arm and the line's place in
      // the order on the other, so this is not a cross-line sequence. It does
      // not need to be — every row selected is received, in one transaction.
      const outstanding = db
        .prepare(
          `SELECT allocation_id, po_line_id, quantity - qty_received AS outstanding
             FROM po_unit_destinations
            WHERE po_id = ? AND ${stockDest()} AND qty_received < quantity
            ORDER BY position, po_line_id`
        )
        .all(id) as Array<{ allocation_id: string | null; po_line_id: string; outstanding: number }>
      for (const l of outstanding) {
        // Throws on failure so the whole transaction (including the status
        // change above) rolls back — never a "Received" PO with partial stock.
        receivePoLine(
          db,
          l.po_line_id,
          l.outstanding,
          `Received ${row.po_number}`,
          actorId,
          false,
          l.allocation_id
        )
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
  /** The ALLOCATION's destination — always RM or AM, never the header's name. */
  location: string
  /** Which slice this landed against. Null for an unsplit line. */
  allocationId: string | null
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
  actorId: string | null,
  /**
   * The operator's recorded answer to "you have scanned more than this order
   * asked for". Off by default, and deliberately not inferable: the clamp below
   * is what stops a double-beep double-adding, so lifting it has to be a
   * decision somebody made rather than something the numbers implied.
   */
  allowOverage = false,
  /**
   * Which slice of the line this receipt is against. Null resolves the line's
   * STOCK allocations in position order — which for an unsplit line is the one
   * implicit allocation, i.e. exactly today's behaviour.
   */
  allocationId: string | null = null
): ReceivedPoLine {
  const row = db
    .prepare(
      `SELECT l.id, l.po_id, l.product_id, l.quantity, l.qty_received, l.unit_price,
              p.name AS product_name, po.po_number, po.status, po.location, po.supplier
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
        supplier: string | null
      }
    | undefined
  if (!row) throw new Error('That purchase order line no longer exists.')
  // Re-read inside the transaction, so a PO cancelled between resolve and commit
  // is caught here and rolls the whole commit back.
  if (row.status === 'cancelled') throw new Error('That purchase order was cancelled.')

  /**
   * WHICH UNITS THIS RECEIPT IS AGAINST — asked PER ALLOCATION, never per order.
   *
   * There is no "this is a dropship PO" branch anywhere in this file, because a
   * mixed order is both at once. The only question ever asked is whether THIS
   * slice of THIS line is bound for a shelf, and the answer comes from the one
   * view that defines it.
   *
   * For a line that was never split this returns exactly one row carrying the
   * whole quantity at the header's destination — so everything below is, for
   * every order raised before v67, the code that was here before.
   */
  const stockUnits = db
    .prepare(
      `SELECT allocation_id, quantity, qty_received, position, supplier, destination
         FROM po_unit_destinations
        WHERE po_line_id = ? AND ${stockDest()}
        ORDER BY position, allocation_id`
    )
    .all(lineId) as StockUnitRow[]

  if (stockUnits.length === 0) {
    // EVERY allocation on this line is a drop. Throwing (rather than returning)
    // matches the existing contract and rolls the caller's transaction back, so
    // a delivery form naming a drop line commits none of its other lines either.
    const going = db
      .prepare(`SELECT DISTINCT destination FROM po_unit_destinations WHERE po_line_id = ?`)
      .all(lineId) as Array<{ destination: string }>
    const where = going.map((g) => canonicalDestination(g.destination)).join(', ') || 'another party'
    throw new Error(
      `${row.product_name} on ${row.po_number} is drop-shipped to ${where}; it is not received into stock.`
    )
  }

  const target = allocationId
    ? stockUnits.find((u) => u.allocation_id === allocationId)
    : stockUnits.find((u) => u.quantity - u.qty_received > 0) ?? stockUnits[0]
  if (!target) {
    // Either the allocation is not on this line, or it is a DROP allocation and
    // was filtered out above. Both are the same answer to the caller: these
    // units are not the ones being checked in.
    throw new Error(
      `${row.product_name} on ${row.po_number}: that split is not one this order receives into stock.`
    )
  }
  // Belt and braces on the load-bearing invariant. The SQL above already
  // guarantees it; this is what would catch a future edit that loosened the
  // filter, BEFORE addStock — which does not validate its location — opened a
  // phantom cost layer at a customer's name.
  const destination = canonicalDestination(target.destination)
  if (!destinationHoldsStock(destination)) {
    throw new Error(
      `${row.product_name} on ${row.po_number} is going to ${destination}, which does not hold stock.`
    )
  }

  // THIS is the real double-add guard — not the header's scanned_at. Two scans
  // of the same box serialise (better-sqlite3 is synchronous), and the second
  // sees the first's qty_received. MEASURED AGAINST THE ALLOCATION, which for an
  // unsplit line is the line.
  const outstanding = target.quantity - target.qty_received
  if (outstanding <= 0 && !allowOverage) {
    throw new Error('That line has already been fully received.')
  }
  // No quantity (or a nonsense one) means "receive the rest". The ask is clamped
  // to what is outstanding UNLESS the operator explicitly took the overage, in
  // which case the line goes past its ordered quantity and reads as an
  // over-receipt — which the progress bars paint as a discrepancy, not as done.
  const want = Number.isFinite(qty) ? Math.round(qty) : outstanding
  // AN EXPLICIT QUANTITY THAT DOES NOT FIT IS REFUSED, NOT TRIMMED.
  //
  // Clamping is right for "receive the rest" — no quantity given, take what is
  // left — and wrong for a number somebody sent: quietly booking 2 against a
  // stated 4 leaves them believing 4 landed, which is the silence this whole
  // path was rebuilt to remove. The scanner's answer to that is the overage
  // override; without one, the refusal names both numbers.
  if (!allowOverage && Number.isFinite(qty) && want > outstanding) {
    throw new Error(
      `${row.product_name}: only ${outstanding} of ${target.quantity} ${
        outstanding === 1 ? 'is' : 'are'
      } still outstanding on ${row.po_number}, so ${want} cannot be received.`
    )
  }
  const take = allowOverage ? Math.max(1, want) : Math.min(Math.max(1, want), outstanding)

  // The one money path: FIFO lot + moving weighted-average cost + ledger entry.
  // The supplier travels onto the cost layer this receipt opens. It is the one
  // place in the app that reliably knows who stock was bought from, and without
  // it the picker's vendor column would be blank for every case in the building —
  // leaving an operator to choose between "$1,400" and "$1,600" with nothing else
  // to go on.
  //
  // BOTH ARGUMENTS COME FROM THE ALLOCATION, not the header. The location is
  // where these particular units are going, and the vendor is who these
  // particular units were bought from — which fixes a real defect the moment
  // lines can carry their own supplier, because the cost layer would otherwise
  // name the wrong vendor in the lot picker.
  const res = addStock(
    row.product_id,
    destination,
    take,
    row.unit_price,
    note ?? `Scanned in ${row.po_number}`,
    actorId,
    target.supplier?.trim() || null
  )
  if (res.error) throw new Error(res.error) // THROW so the outer txn rolls back every prior line (atomic)

  const ts = nowIso()
  // I2: the allocation's counter and the line's move together, or the two
  // disagree the first time anything is undone.
  if (target.allocation_id) {
    db.prepare(
      `UPDATE purchase_order_allocations
          SET qty_received = qty_received + @take,
              received_at  = CASE WHEN qty_received + @take >= quantity THEN @ts ELSE received_at END
        WHERE id = @id`
    ).run({ take, ts, id: target.allocation_id })
  }
  // THE LINE IS FINISHED WHEN ITS RECEIVABLE UNITS ARE IN, not when its ordered
  // quantity is. A line of 20 split 12 to RM and 8 to a shop is complete at 12:
  // the other eight were never addressed to this building and no receipt can
  // ever arrive for them, so measuring against `quantity` would leave
  // received_at NULL for ever on a line that is, in every sense the receiving
  // desk cares about, done. Every line raised before v67 has exactly one
  // implicit stock allocation of its whole quantity, so this sum IS `quantity`
  // for all of them and the stamp lands on the receipt it always landed on.
  const receivable = stockUnits.reduce((n, u) => n + u.quantity, 0)
  db.prepare(
    `UPDATE purchase_order_lines
        SET qty_received = qty_received + @take,
            received_at  = CASE WHEN qty_received + @take >= @receivable THEN @ts ELSE received_at END,
            lot_id       = @lotId
      WHERE id = @id`
  ).run({ take, ts, id: lineId, lotId: res.lotId ?? null, receivable })

  // The authoritative record of what this receipt took in. A line received in
  // several commits gets several rows, each naming its own lot — which is what
  // makes an exact reversal possible. (lot_id above is kept only so a database
  // written by the one build that had it can still be read.)
  //
  // The location is stored ON THE RECEIPT because that is the only place it
  // stays true: the three reversal paths used to re-read it from the PO header,
  // which with per-line destinations unwinds against the wrong shelf.
  if (res.lotId) {
    db.prepare(
      `INSERT INTO po_line_receipts
         (id, po_id, po_line_id, lot_id, quantity, created_at, allocation_id, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), row.po_id, lineId, res.lotId, take, ts, target.allocation_id, destination)
  }

  return {
    lineId,
    poId: row.po_id,
    poNumber: row.po_number,
    productId: row.product_id,
    productName: row.product_name,
    location: destination,
    allocationId: target.allocation_id,
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
  // THE DENOMINATOR IS WHAT IS COMING HERE, not what was ordered.
  //
  // A line with drop units is finished the moment its stock-bound units are in;
  // waiting for the rest would leave a fully-arrived mixed order open for ever,
  // with the receiving desk chasing boxes that were never addressed to this
  // building. On every line raised before v67 the receivable figure IS the
  // quantity, so this is the previous rule verbatim.
  //
  // KNOWN LIMITATION, deliberately not fixed here: the test is a SUM over a
  // line's allocations, so an OVER-receipt against one of them can cover
  // another's outstanding units — 12 taken against a 6-unit RM slice with the
  // overage override on makes received (12) >= receivable (12) while the AM
  // slice still has 6 due, and the order completes and retires its box with
  // those six stranded. It is unreachable today: the only caller that passes
  // allowOverage is a scan commit carrying an explicit 'overage' override, and
  // receivePoLine's own clamp is per allocation, so an override can only ever
  // push ONE slice past its own quantity for a scan the operator chose to force.
  // Fixing it properly means per-slice completion arithmetic, which is a change
  // to what "received" means and belongs in its own spec.
  const c = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN r.received >= r.receivable THEN 1 ELSE 0 END), 0) AS done
         FROM (SELECT po_line_id,
                      SUM(CASE WHEN ${stockDest()} THEN quantity     ELSE 0 END) AS receivable,
                      SUM(CASE WHEN ${stockDest()} THEN qty_received ELSE 0 END) AS received
                 FROM po_unit_destinations WHERE po_id = ? GROUP BY po_line_id) r
        WHERE r.receivable > 0`
    )
    .get(poId) as { total: number; done: number }
  // total > 0 guard: over zero rows SUM and COUNT are both 0, so an empty PO
  // would otherwise auto-complete itself. It now covers the pure-drop case as
  // well — no receivable lines means no auto-completion, ever, which is why a
  // Drop order is closed by hand on the board.
  if (c.total === 0 || c.done < c.total) return unchanged
  const ts = nowIso()
  db.prepare(
    `UPDATE purchase_orders
        SET status = 'received', received_at = COALESCE(received_at, @ts), scanned_at = @ts, updated_at = @ts
      WHERE id = @id`
  ).run({ ts, id: poId })
  // THE ORDER CLOSED ITSELF, and the log has to say so. This is one of the two
  // places a purchase order's stage changes without going through
  // setPurchaseOrderStatus, so a log hooked only into that function would show
  // an order sitting in Ordered while the board says Received — the exact
  // disagreement somebody opens a log to resolve.
  //
  // No actor: nobody clicked. The last box being scanned in is what did it, and
  // naming the scanner would credit them with a decision they did not make.
  recordOrderEvent('po', poId, 'stage', {
    toStage: 'received',
    detail: 'Closed automatically — every receivable unit was checked in',
    db
  })
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
  // ONE CANDIDATE PER STOCK ALLOCATION, and none at all for a drop one.
  //
  // The old query copied the HEADER's destination onto every candidate, which
  // the ScanQueue draws as a pill and the commit uses as the shelf. Under
  // per-line destinations that is wrong twice over: it would offer a shelf the
  // units are not going to, and it would offer units that are not in the
  // building. A product ordered only for dropship now produces zero candidates,
  // so a scan of it resolves as no_order — the honest answer.
  //
  // A line split 6 to RM and 6 to AM therefore yields TWO candidates. That is
  // deliberate: which shelf six boxes land on is the operator's call, and
  // silently picking the first would misplace them with no way to notice.
  const receivableLines = `
    SELECT po_line_id,
           SUM(CASE WHEN ${stockDest()} THEN quantity     ELSE 0 END) AS receivable,
           SUM(CASE WHEN ${stockDest()} THEN qty_received ELSE 0 END) AS received
      FROM po_unit_destinations WHERE po_id = l.po_id GROUP BY po_line_id`
  /**
   * Outstanding SLICES on this order, which is what "will this scan finish it?"
   * actually turns on.
   *
   * Counted per allocation, never per line: a line split 6 to RM and 6 to AM is
   * ONE outstanding line and TWO outstanding candidates, so a line-based count
   * told both of them they were the last thing the order was waiting for, and
   * the operator saw "completes this PO" on a scan that leaves six boxes still
   * due. Every candidate row is itself an outstanding slice, so a count of 1
   * means this row is the one.
   */
  const outstandingSlices = `
    (SELECT COUNT(*) FROM po_unit_destinations o
      WHERE o.po_id = l.po_id AND ${stockDest('o.')} AND o.qty_received < o.quantity)`
  const rows = getDb()
    .prepare(
      `SELECT l.id AS line_id, l.po_id, d.allocation_id, d.quantity, d.qty_received,
              l.unit_price, l.position, d.position AS alloc_position,
              po.po_number, po.status, d.supplier, d.destination AS location, po.created_at,
              (SELECT COUNT(*) FROM (${receivableLines}) r WHERE r.receivable > 0) AS po_lines_total,
              (SELECT COUNT(*) FROM (${receivableLines}) r
                WHERE r.receivable > 0 AND r.received < r.receivable) AS po_lines_outstanding,
              ${outstandingSlices} AS po_slices_outstanding
       FROM po_unit_destinations d
       JOIN purchase_order_lines l ON l.id = d.po_line_id
       JOIN purchase_orders po ON po.id = l.po_id
       WHERE l.product_id = ?
         AND po.status != 'cancelled'
         AND po.scanned_at IS NULL
         AND ${stockDest('d.')}
         AND d.qty_received < d.quantity
       ORDER BY po.created_at ASC, po.po_number ASC, l.position ASC, d.position ASC`
    )
    .all(productId) as Array<{
    line_id: string
    po_id: string
    allocation_id: string | null
    quantity: number
    qty_received: number
    unit_price: number
    position: number
    alloc_position: number
    po_number: string
    status: PurchaseOrderStatus
    supplier: string | null
    location: string
    created_at: string
    po_lines_total: number
    po_lines_outstanding: number
    po_slices_outstanding: number
  }>
  return rows.map((r) => ({
    lineId: r.line_id,
    poId: r.po_id,
    poNumber: r.po_number,
    // The ALLOCATION's effective supplier: on a multi-supplier order the header
    // names only one of them, and the cost layer this scan opens is going to be
    // stamped with whoever actually sold these units.
    supplier: r.supplier,
    status: r.status,
    allocationId: r.allocation_id,
    // Always RM or AM by construction — the query cannot return anything else.
    location: canonicalDestination(r.location),
    quantity: r.quantity,
    qtyReceived: r.qty_received,
    qtyOutstanding: Math.max(0, r.quantity - r.qty_received),
    unitPrice: r.unit_price,
    poCreatedAt: r.created_at,
    // Advisory, and still advisory: the commit transaction decides completion
    // for itself. What this now promises is what its name says — receive this
    // slice in full and the order has nothing left due here.
    completesPo: r.po_slices_outstanding === 1,
    // Both figures stay per LINE. They are drawn as "line 2 of 5" on the scan
    // queue, where a line is what an operator counts.
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
      .prepare('SELECT id FROM purchase_order_lines WHERE po_id = ?')
      .all(id) as Array<{ id: string }>
    // A PO with no lines can never auto-complete (see completePoIfFullyReceived),
    // so say so rather than appearing to do nothing.
    if (lines.length === 0) {
      return { po: getPurchaseOrder(id), error: 'This purchase order has no line items to receive.' }
    }
    // Stock allocations only, so "All of it arrived" on a mixed order takes in
    // the twelve that came and never tries to receive the eight that went
    // straight to the shop. For a line that was never split this is the line.
    // Ordered to be repeatable rather than meaningful — see the note on the same
    // query in setPurchaseOrderStatus.
    const units = db
      .prepare(
        `SELECT allocation_id, po_line_id, quantity - qty_received AS outstanding
           FROM po_unit_destinations
          WHERE po_id = ? AND ${stockDest()} AND qty_received < quantity
          ORDER BY position, po_line_id`
      )
      .all(id) as Array<{ allocation_id: string | null; po_line_id: string; outstanding: number }>
    if (units.length === 0) {
      // Every unit on this order is drop-shipped, so there is nothing here to
      // check in. Close it on the board instead — see setPurchaseOrderStatus.
      return {
        po: getPurchaseOrder(id),
        error: 'Every unit on this purchase order is drop-shipped, so there is nothing to receive into stock.'
      }
    }
    for (const u of units) {
      // already received by UPC scan — never add it twice
      if (u.outstanding <= 0) continue
      receivePoLine(
        db,
        u.po_line_id,
        u.outstanding,
        `Scanned in ${h.po_number}`,
        actorId,
        false,
        u.allocation_id
      )
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

/** One line of a delivery: how many of THIS line turned up. */
export interface PoReceiptItem {
  lineId: string
  quantity: number
  /**
   * Which slice of the line, when a line is split across two shelves and the
   * operator picked. Omitted or null takes the line's stock allocations in
   * position order, which for an unsplit line is the one implicit allocation —
   * i.e. exactly what every delivery form did before dropship existed.
   */
  allocationId?: string | null
}

/**
 * Receive PART of a purchase order — the delivery that turns up in two vans.
 *
 * The receiving arithmetic has always been partial-aware (`qty_received` adds
 * up, `received_at` is stamped only when a line reaches its ordered quantity,
 * and the PO completes only when every line does). What did not exist was any
 * way to SAY "twenty-three of the thirty-eight came today" — the only controls
 * were a UPC scan, which needs a barcode most of this catalog does not have,
 * and "Scanned in", which takes the whole order at once. So a half delivery had
 * to be either recorded as complete, which invents fifteen units of stock at a
 * cost basis, or left untouched, which hides twenty-three real ones.
 *
 * ## Over-receipt is refused, not clamped
 *
 * `receivePoLine` clamps quantities, which is right for a scan — each beep is
 * one unit and the clamp is what stops a double-beep double-adding. It is wrong
 * for a typed number: somebody who enters 12 against a line with 8 outstanding
 * has miscounted or is looking at the wrong line, and quietly booking 8 leaves
 * them believing 12 landed. Refusing names the line and both numbers.
 *
 * The whole delivery is one transaction. A refusal on line seven rolls back
 * lines one to six, because half a delivery recorded from a form somebody is
 * about to correct is worse than none.
 */
export function receivePurchaseOrderLines(
  id: string,
  items: PoReceiptItem[],
  actorId: string | null
): ScanInResult {
  const db = getDb()
  const run = db.transaction((): ScanInResult => {
    const h = db
      .prepare('SELECT id, status, po_number FROM purchase_orders WHERE id = ?')
      .get(id) as { id: string; status: PurchaseOrderStatus; po_number: string } | undefined
    if (!h) return { po: null, error: 'Purchase order not found.' }
    if (h.status === 'cancelled') {
      return { po: getPurchaseOrder(id), error: 'This purchase order was cancelled.' }
    }

    // The receivable figure, not the ordered one: on a mixed line of 20 with 12
    // coming here, "20 arrived" is a miscount and has to be refused with the
    // number that is actually due. Every line raised before v67 has receivable
    // equal to quantity, so the arithmetic below is unchanged for all of them.
    const lines = db
      .prepare(
        `SELECT l.id, l.quantity, l.qty_received, p.name AS product_name,
                COALESCE((SELECT SUM(CASE WHEN ${stockDest('d.')} THEN d.quantity ELSE 0 END)
                            FROM po_unit_destinations d WHERE d.po_line_id = l.id), 0) AS receivable,
                COALESCE((SELECT SUM(CASE WHEN ${stockDest('d.')} THEN d.qty_received ELSE 0 END)
                            FROM po_unit_destinations d WHERE d.po_line_id = l.id), 0) AS received
           FROM purchase_order_lines l
           JOIN inventory_products p ON p.id = l.product_id
          WHERE l.po_id = ?`
      )
      .all(id) as Array<{
      id: string
      quantity: number
      qty_received: number
      product_name: string
      receivable: number
      received: number
    }>
    const byId = new Map(lines.map((l) => [l.id, l]))

    // Validate the WHOLE form before writing any of it, so a bad number on the
    // last line does not leave the operator staring at a rolled-back toast
    // wondering which of the earlier ones went in. (Nothing would have, but the
    // message should not require knowing that.)
    const wanted: Array<{ lineId: string; take: number; allocationId: string | null }> = []
    for (const item of items ?? []) {
      const line = byId.get(String(item?.lineId ?? ''))
      if (!line) return { po: getPurchaseOrder(id), error: 'That line is not on this purchase order.' }
      const take = Math.round(Number(item?.quantity))
      if (!Number.isFinite(take) || take < 0) {
        return { po: getPurchaseOrder(id), error: `Enter a whole number for ${line.product_name}.` }
      }
      if (take === 0) continue // "none of this one came" — a normal answer, not an error
      const allocationId = item?.allocationId?.trim() || null
      // A wholly drop-shipped line has nothing due here at all, and saying so is
      // more use than "already fully received", which would be a lie about a
      // line that never arrives.
      if (line.receivable === 0) {
        return {
          po: getPurchaseOrder(id),
          error: `${line.product_name} is drop-shipped, so none of it is received into stock here.`
        }
      }
      const outstanding = Math.max(0, line.receivable - line.received)
      if (outstanding === 0) {
        return {
          po: getPurchaseOrder(id),
          error: `${line.product_name} is already fully received.`
        }
      }
      if (take > outstanding) {
        return {
          po: getPurchaseOrder(id),
          error: `${line.product_name}: only ${outstanding} of ${line.receivable} ${
            outstanding === 1 ? 'is' : 'are'
          } still outstanding, so ${take} cannot be received.`
        }
      }
      wanted.push({ lineId: line.id, take, allocationId })
    }
    if (!wanted.length) {
      return { po: getPurchaseOrder(id), error: 'Enter how many of at least one item arrived.' }
    }

    for (const w of wanted) {
      // A quantity against a SPLIT line is spread across its shelves, in
      // position order, rather than pushed at one of them.
      //
      // The form asks one question per line — "how many arrived?" — and
      // validates the answer against the line's whole receivable figure. But
      // receivePoLine books against ONE allocation and refuses anything larger
      // than that allocation's own outstanding. Handing it the line's total
      // therefore refused every delivery of a line split across RM and AM, with
      // a message quoting numbers ("only 6 of 6") that appear nowhere on the
      // screen the operator is looking at, which says 12.
      //
      // Spreading is the same rule the whole-order button and the scan-in path
      // already follow, so all three now agree. For a line that was never split
      // this yields exactly one part with a null allocation id — byte for byte
      // the single call that was here before.
      for (const part of spreadAcrossStockAllocations(db, w.lineId, w.take, w.allocationId)) {
        receivePoLine(
          db,
          w.lineId,
          part.take,
          `Received against ${h.po_number}`,
          actorId,
          false,
          part.allocationId
        )
      }
    }
    // Only completes if this delivery happened to finish the order. A partial
    // one leaves the PO exactly where it was, still open, still in its column.
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
    /** The HEADER's destination — a last-resort fallback only. See below. */
    location: string
  }>

  for (const line of lines) {
    // Newest receipt first: unwinding in reverse order of arrival means a lot
    // is never left half-open behind a later one.
    //
    // EACH RECEIPT NAMES ITS OWN SHELF. Re-reading the destination from the PO
    // header was correct only while an order had exactly one; with per-line
    // destinations it unwinds against the wrong shelf and the refusal message
    // names a cause that is not the real one. Every receipt written before v67
    // was backfilled with the header location, which is what this code was
    // reading anyway, so cancelling a legacy order behaves identically.
    const receipts = db
      .prepare(
        `SELECT lot_id, quantity, location FROM po_line_receipts
          WHERE po_line_id = ? ORDER BY created_at DESC, rowid DESC`
      )
      .all(line.id) as Array<{ lot_id: string; quantity: number; location: string | null }>

    // No receipt rows: either this line predates v20, or it was received by the
    // single build that recorded only lot_id. Fall back to that column when it
    // accounts for the whole quantity, and refuse otherwise rather than reverse
    // the wrong cost layer. A line in that state predates per-line destinations
    // entirely, so the header's location IS its shelf.
    const plan: Array<{ lot_id: string; quantity: number; location: string }> =
      receipts.length > 0
        ? receipts.map((r) => ({ ...r, location: r.location ?? line.location }))
        : line.lot_id
          ? [{ lot_id: line.lot_id, quantity: line.qty_received, location: line.location }]
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
        location: r.location,
        quantity: r.quantity,
        lotId: r.lot_id,
        note: `Cancelled ${poNumber}`,
        actorId
      })
    }
  }

  // Every allocation's counter goes back with the line's, or I2 breaks and a
  // re-received order would start from a number that no longer matches.
  db.prepare(
    `UPDATE purchase_order_allocations SET qty_received = 0, received_at = NULL WHERE po_id = ?`
  ).run(poId)

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
        // Each receipt names the shelf it landed on. The header's location is a
        // fallback for rows written before v67 only — and those were backfilled
        // with exactly that value, so it is never actually needed.
        const receipts = db
          .prepare(
            `SELECT lot_id, quantity, location FROM po_line_receipts
              WHERE po_line_id = ? ORDER BY created_at DESC, rowid DESC`
          )
          .all(line.id) as Array<{ lot_id: string; quantity: number; location: string | null }>
        const plan: Array<{ lot_id: string; quantity: number; location: string }> =
          receipts.length > 0
            ? receipts.map((r) => ({ ...r, location: r.location ?? line.location }))
            : line.lot_id
              ? [{ lot_id: line.lot_id, quantity: line.qty_received, location: line.location }]
              : []

        let outstanding = line.qty_received
        /**
         * What could not be reversed against its exact layer, PER SHELF.
         *
         * The hand-adjustment fallback below has to name a location, and once a
         * line can be split across RM and AM there is no single "the line's
         * location" to use — taking six units off RM because the header says RM
         * when they are sitting on AM would leave both shelves wrong. So the
         * shortfall is tracked against the shelf each receipt actually used.
         */
        const shortfall = new Map<string, number>()
        const note = (location: string, qty: number): void => {
          if (qty > 0) shortfall.set(location, (shortfall.get(location) ?? 0) + qty)
        }

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
          const want = Math.min(r.quantity, outstanding)
          const take = Math.min(want, lot?.qty_remaining ?? 0)
          if (take <= 0) {
            note(r.location, want)
            outstanding -= want
            continue
          }
          try {
            reverseStockReceipt(db, {
              productId: line.product_id,
              location: r.location,
              quantity: take,
              lotId: r.lot_id,
              note: `Force-deleted ${row.po_number}`,
              actorId
            })
            outstanding -= take
            removed += take
            note(r.location, want - take)
            outstanding -= want - take
          } catch {
            // The layer will not give these units back. Fall through to the
            // correction below rather than abandoning the whole operation.
            note(r.location, want)
            outstanding -= want
          }
        }
        // Units the plan never accounted for at all (a line whose receipts add
        // up to less than qty_received). Nothing names their shelf, so the
        // header's destination is the only answer left — and a line in that
        // state predates per-line destinations, where the header WAS the shelf.
        //
        // GUARDED, because since v67 the header is a DESTINATION and a
        // destination can be a party name. This is the last place in this file
        // where a non-location string could still reach stockQty and adjustStock
        // — neither of which validates what it is handed, so adjustStock would
        // open a real inventory_stock row at a customer's name and
        // lotWeightedAvgCost would then average that phantom layer into the unit
        // cost of boxes sitting on the RM shelf. It is safe today only because
        // nothing ever writes stock at a party name, which is a fact about the
        // rest of the file rather than anything this line checks. Now it checks.
        //
        // Units the guard rejects are counted as unrecoverable rather than
        // dropped, so removed + sold still equals what the line received.
        if (destinationHoldsStock(line.location)) note(canonicalDestination(line.location), outstanding)
        else sold += outstanding
        outstanding = 0

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
        for (const [location, wanted] of shortfall) {
          let left = wanted
          const have = stockQty(line.product_id, location)
          const take = Math.min(left, Math.max(0, have))
          if (take > 0) {
            const res = adjustStock(
              line.product_id,
              location,
              -take,
              `Force-deleted ${row.po_number} — received stock removed`,
              actorId
            )
            if (!res.error) {
              removed += take
              left -= take
            }
          }
          // Anything still outstanding genuinely cannot come back out. Every
          // unit of the line is now accounted for exactly once, so
          // removed + sold always equals what was received.
          sold += left
        }
      }

      db.prepare('DELETE FROM po_line_receipts WHERE po_id = ?').run(id)
      db.prepare(
        `UPDATE purchase_order_lines
            SET qty_received = 0, received_at = NULL, lot_id = NULL
          WHERE po_id = ?`
      ).run(id)
      db.prepare(
        `UPDATE purchase_order_allocations SET qty_received = 0, received_at = NULL WHERE po_id = ?`
      ).run(id)
    }

    // Same two statements the ordinary delete runs. Lines cascade; the scan
    // history keeps its rows with po_id set to NULL.
    voidPoCogs(db, id)
    // The parcels and the paperwork go with the order. The EVENTS deliberately
    // do not — a deleted purchase order is itself a thing that happened, and the
    // log is the only place that would still say so.
    deleteOrderExtras('po', id, db)
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id)
  })

  try {
    run()
    return { ok: true, removedUnits: removed, soldUnits: sold }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The next free purchase-order number — "PO-0001", "PO-0002", …
 *
 * Called inside the create transaction so the bump and the insert commit
 * together.
 *
 * ## Why it reads the TABLE and not just the counter
 *
 * The counter lives in `meta`, and `meta` is deliberately not synced (see the
 * manifest in syncTables.ts): it holds this machine's own settings, its
 * QuickBooks tokens, its schema version. So a counter is a PER-MACHINE fact,
 * and two machines raising an order on the same afternoon both minted PO-0007.
 *
 * That is not a cosmetic clash. `purchase_orders.po_number` is UNIQUE, so when
 * the second PO-0007 arrived over sync it hit a constraint the upsert has no
 * ON CONFLICT clause for, the whole batch failed, the row-by-row retry failed
 * too, and the order was QUARANTINED — invisible on the receiving machine, with
 * its lines orphaned behind it. A purchase order that silently does not exist on
 * one of two machines is money nobody can see.
 *
 * Taking the greater of the counter and the highest number actually on the table
 * closes the ordinary case completely: a machine that has pulled somebody else's
 * PO-0007 allocates PO-0008 next, without needing to be told. What it cannot fix
 * is two machines BOTH offline, which is why sync now settles a genuine clash
 * rather than quarantining it — see RELABEL_ON_CONFLICT in sync.ts.
 *
 * The counter is still the floor, so a run of deleted orders does not hand the
 * same number out twice.
 */
/**
 * The highest PO number considered spent, without spending another.
 *
 * The same two sources `nextPoNumber` reads — the counter, which is the floor,
 * and MAX over the table, which catches numbers that arrived from another
 * machine through sync. Split out so the numbering screen can SHOW what the next
 * one will be without minting it: reading a value must never consume it, or
 * opening Admin would burn a purchase order number every time.
 */
export function poCeiling(db: Database.Database): number {
  const fromCounter = Number(getMeta(db, 'po_seq') ?? '0') || 0
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(po_number, 4) AS INTEGER)) AS n
         FROM purchase_orders WHERE po_number GLOB 'PO-[0-9]*'`
    )
    .get() as { n: number | null } | undefined
  return Math.max(fromCounter, Number(row?.n ?? 0) || 0)
}

/** The highest PO number a document actually carries. 0 when there are none. */
export function poIssued(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(po_number, 4) AS INTEGER)) AS n
         FROM purchase_orders WHERE po_number GLOB 'PO-[0-9]*'`
    )
    .get() as { n: number | null } | undefined
  return Number(row?.n ?? 0) || 0
}

export function nextPoNumber(db: Database.Database): string {
  const fromCounter = Number(getMeta(db, 'po_seq') ?? '0') || 0
  // GLOB rather than LIKE: LIKE is case-insensitive here and '[0-9]' is not a
  // LIKE wildcard, so it would match any number-shaped string including ones
  // this app never minted. CAST stops at the first non-digit and yields 0 for
  // anything unparseable, which is the right answer for a hand-typed number.
  const row = db
    .prepare(
      `SELECT MAX(CAST(SUBSTR(po_number, 4) AS INTEGER)) AS n
         FROM purchase_orders WHERE po_number GLOB 'PO-[0-9]*'`
    )
    .get() as { n: number | null } | undefined
  const seq = Math.max(fromCounter, Number(row?.n ?? 0) || 0) + 1
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
  // A PURE-DROP order reaches Received with nothing in stock, and moving it
  // there by hand is the documented — and only — way to close one. Refusing
  // Delete on the status alone would mean the act of closing a Drop order is
  // also the act of losing the Delete button, and the receipt's own tooltip
  // promises the opposite ("nothing on it ever arrives here, so no stock is
  // affected"). The refusal exists to protect stock that has a cost record;
  // where no unit was ever checked in there is nothing to protect.
  //
  // Deliberately keyed on receivable units rather than on orderKind: an order
  // that COULD have received stock and simply has not is still an order whose
  // status is the thing being trusted, and this must not widen to it.
  const receivable = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN ${stockDest()} THEN quantity ELSE 0 END), 0) AS n
         FROM po_unit_destinations WHERE po_id = ?`
    )
    .get(id) as { n: number }
  const closedDropOrder = row.status === 'received' && received.n === 0 && receivable.n === 0
  if ((row.status === 'received' && !closedDropOrder) || received.n > 0) {
    return {
      ok: false,
      error:
        received.n > 0 && row.status !== 'received'
          ? `${row.po_number} has ${received.n} unit(s) already checked in. Cancel it instead — deleting would leave that stock with no cost record.`
          : `${row.po_number} has been received into stock. Cancel it instead — deleting would leave that stock with no cost record.`
    }
  }

  const run = db.transaction((): void => {
    /**
     * THE SALE ON THE OTHER END LETS GO FIRST.
     *
     * `invoices.source_po_id` has no foreign key behind it, so deleting this row
     * used to leave the sale pointing at nothing: `salesOrderKindOf` reads that
     * column, so the order kept a "Part drop" badge with no purchase order to
     * open, and `linkDropshipPair` refuses any sale that already carries a
     * pointer — so it could not even be paired with the replacement order. See
     * the v80 migration, which repairs the pairs already broken this way.
     *
     * The event is recorded on the SALE, because the sale is the document that
     * survives, and its own history is now the only place that says why the
     * badge went away.
     */
    const linked = db
      .prepare(`SELECT id FROM invoices WHERE source_po_id = ?`)
      .all(id) as Array<{ id: string }>
    for (const inv of linked) {
      db.prepare(`UPDATE invoices SET source_po_id = NULL, updated_at = ? WHERE id = ?`).run(
        nowIso(),
        inv.id
      )
      recordOrderEvent('so', inv.id, 'link', {
        detail: `Dropship link cleared — purchase order ${row.po_number} was deleted`,
        actorId,
        db
      })
    }

    // Drop the COGS row explicitly rather than relying on the cascade, so the
    // ledger is corrected the same way cancelling would correct it.
    voidPoCogs(db, id)
    // The parcels and the paperwork go with the order. The EVENTS deliberately
    // do not — a deleted purchase order is itself a thing that happened, and the
    // log is the only place that would still say so.
    deleteOrderExtras('po', id, db)
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

/**
 * Names to offer in the supplier box, from both places one can come from.
 *
 * Reaching into invoice_customers from the purchase-order file is deliberate
 * and is the smaller of two evils. The alternative — a second contact table for
 * the buy side — is the one that actually hurts: the same card shop would exist
 * twice, and correcting a phone number on one copy would leave the other wrong
 * with nothing on either screen to say which was current. One list of people,
 * two documents that reference it, and only the reference differs.
 *
 * History wins the top of the list. A supplier used on a purchase order last
 * week is far more likely to be the one being typed now than the 340th name in
 * an alphabetical contact list, and the ordering is the whole value of a
 * suggestion box.
 */
export function listSupplierSuggestions(): SupplierSuggestion[] {
  const db = getDb()
  const used = db
    .prepare(
      `SELECT TRIM(supplier) AS name, COUNT(*) AS n, MAX(created_at) AS last_used
         FROM purchase_orders
        WHERE supplier IS NOT NULL AND TRIM(supplier) != ''
        GROUP BY TRIM(supplier) COLLATE NOCASE
        ORDER BY last_used DESC`
    )
    .all() as Array<{ name: string; n: number; last_used: string }>

  const contacts = db
    .prepare(
      `SELECT name, email, phone, mobile, bill_city, bill_region
         FROM invoice_customers
        WHERE active = 1
        ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as Array<{
    name: string
    email: string | null
    phone: string | null
    mobile: string | null
    bill_city: string | null
    bill_region: string | null
  }>

  // Matched case-insensitively, because that is how the buyer table matches
  // names everywhere else. Without it a supplier typed in lower case would
  // appear twice in the list — once from history, once from the contact it
  // already is — and picking the wrong one would look like it did nothing.
  const orders = new Map<string, { n: number }>()
  for (const u of used) orders.set(u.name.toLowerCase(), { n: u.n })

  const out: SupplierSuggestion[] = []
  const claimed = new Set<string>()

  for (const u of used) {
    const key = u.name.toLowerCase()
    const contact = contacts.find((c) => c.name.toLowerCase() === key)
    claimed.add(key)
    out.push({
      name: contact?.name ?? u.name,
      detail: contact
        ? contactDetail(contact)
        : `${u.n} purchase ${u.n === 1 ? 'order' : 'orders'}`,
      source: contact ? 'contact' : 'history',
      usedOnOrders: u.n
    })
  }

  // Suppliers named on a LINE rather than on a header. Same fourth source
  // listVendors gained, and the same limit: a name and nothing more, because the
  // order count on the right of this box is a count of DOCUMENTS naming them and
  // a line does not make one.
  for (const s of lineSupplierNames(db)) {
    const key = s.name.toLowerCase()
    if (claimed.has(key)) continue
    claimed.add(key)
    const contact = contacts.find((c) => c.name.toLowerCase() === key)
    out.push({
      name: contact?.name ?? s.name,
      detail: contact ? contactDetail(contact) : null,
      source: contact ? 'contact' : 'history',
      usedOnOrders: 0
    })
  }

  for (const c of contacts) {
    const key = c.name.toLowerCase()
    if (claimed.has(key)) continue
    out.push({
      name: c.name,
      detail: contactDetail(c),
      source: 'contact',
      usedOnOrders: orders.get(key)?.n ?? 0
    })
  }
  return out
}

function contactDetail(c: {
  email: string | null
  phone: string | null
  mobile: string | null
  bill_city: string | null
  bill_region: string | null
}): string | null {
  const where = [c.bill_city, c.bill_region].filter(Boolean).join(', ')
  return [c.email, c.phone ?? c.mobile, where].filter(Boolean).join(' · ') || null
}

/**
 * Everyone this business buys from — the Vendors list.
 *
 * ## Why this is not listSupplierSuggestions with a different name
 *
 * That function answers "what could I be about to type", so it offers the whole
 * contact list whether or not a penny has ever gone to any of them. This one
 * answers "who ARE our vendors", and 360 people who have never sold us anything
 * is the wrong answer to that — it would also make the count on the Admin tile
 * the size of the contact list rather than the size of the vendor list, which
 * is the exact failure the tile exists to avoid.
 *
 * So the contact list is NOT offered wholesale. Names come from what was bought
 * and from the contacts explicitly FLAGGED as vendors by the directory import,
 * and those are two different claims: the first is "money went to them", the
 * second is "the owner put them on the list of people we buy from". Both are
 * answers to the question this screen asks. A customer who has never sold us
 * anything is neither, and still does not appear.
 *
 * ## Three sources, because stock arrives two ways and a directory is the third
 *
 * A purchase order is the paperwork path. But `addStock` takes a vendor
 * directly — that is somebody typing a case straight onto the shelf with no PO
 * behind it, which is how a lot of this warehouse actually gets filled, and a
 * vendor list that could not see those receipts would be missing the suppliers
 * used most casually. `inventory_lots.vendor` is read for exactly that, and a
 * vendor known ONLY that way still gets a row.
 *
 * The third is the imported directory — contacts flagged is_vendor. It carries
 * no figures at all, because a directory entry is not a transaction, and that is
 * precisely why it had to be a separate source rather than a fourth column on
 * one of the other two: a business the owner has found and not yet ordered from
 * has nothing in either table to be found by, and would otherwise be invisible
 * on the screen listing who we can buy from.
 *
 * ## Case is folded TWICE, and the two do different jobs
 *
 * The supplier box is free text, so the same distributor is typed in caps on one
 * order and mixed case on the next. Grouped case-sensitively that is two vendors
 * with half the orders each and two wrong spend figures — the same bug
 * listSupplierSuggestions guards against, and the reason both group NOCASE.
 *
 * NOCASE inside each query is what makes the spelling shown the MOST RECENT one:
 * with a single max() aggregate SQLite takes the other columns from the row that
 * produced the maximum, so one group means one answer to "how was it last
 * written". Cosmetic — nothing is keyed on it — but it is what somebody has just
 * seen themselves type.
 *
 * The fold in the merge below is the one that cannot be done in SQL at all: the
 * two spellings can be in two DIFFERENT TABLES, an order saying "Bramble
 * Wholesale" and a receipt saying "BRAMBLE WHOLESALE", and no GROUP BY spans
 * both. Without it the same business appears twice on the one screen whose
 * entire job is to say who this business buys from.
 */
export function listVendors(): VendorSummary[] {
  const db = getDb()

  const ordered = db
    .prepare(
      `SELECT TRIM(supplier) AS name,
              COUNT(*) AS orders,
              SUM(CASE WHEN status = 'cancelled' THEN 0 ELSE total END) AS ordered,
              MAX(created_at) AS last_at
         FROM purchase_orders
        WHERE supplier IS NOT NULL AND TRIM(supplier) != ''
        GROUP BY TRIM(supplier) COLLATE NOCASE`
    )
    .all() as Array<{ name: string; orders: number; ordered: number | null; last_at: string }>

  const received = db
    .prepare(
      `SELECT TRIM(vendor) AS name,
              COUNT(*) AS receipts,
              MAX(received_at) AS last_at
         FROM inventory_lots
        WHERE vendor IS NOT NULL AND TRIM(vendor) != ''
        GROUP BY TRIM(vendor) COLLATE NOCASE`
    )
    .all() as Array<{ name: string; receipts: number; last_at: string }>

  // Ordered here rather than sorted later, so the directory-only vendors — which
  // all share a null lastAt and would otherwise come back in whatever order
  // SQLite felt like — land alphabetically at the bottom of the list instead of
  // shuffling between two reads of the same unchanged data.
  const contacts = db
    .prepare(
      `SELECT name, email, phone, mobile, bill_city, bill_region, is_vendor, vendor_label
         FROM invoice_customers
        WHERE active = 1
        ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as Array<{
    name: string
    email: string | null
    phone: string | null
    mobile: string | null
    bill_city: string | null
    bill_region: string | null
    is_vendor: number
    vendor_label: string | null
  }>
  const byName = new Map(contacts.map((c) => [c.name.toLowerCase(), c]))

  // Folded again in JS rather than trusting the GROUP BYs to have produced
  // matching keys: a PO backfilled the lot's vendor column, so the two tables
  // hold the same names, and one collation quirk between them would list a
  // distributor twice on a screen whose whole job is to be the list. The
  // directory joins through the same fold for the same reason — the owner's
  // sheet spells a distributor properly and the purchase order shouts it.
  const merged = new Map<string, VendorSummary>()
  const rowFor = (name: string): VendorSummary => {
    const key = name.toLowerCase()
    const found = merged.get(key)
    if (found) return found
    const fresh: VendorSummary = {
      name,
      detail: null,
      onFile: false,
      label: null,
      orders: 0,
      ordered: 0,
      receipts: 0,
      lastAt: null
    }
    merged.set(key, fresh)
    return fresh
  }
  // ISO-8601 strings compare lexicographically in the same order they compare as
  // instants, which is the whole reason this app stores them that way — so the
  // latest of an order date and a receipt date needs no date parsing at all.
  const noteSeen = (row: VendorSummary, when: string | null): void => {
    if (when && (!row.lastAt || when > row.lastAt)) row.lastAt = when
  }

  for (const o of ordered) {
    const row = rowFor(o.name)
    row.orders += o.orders
    row.ordered += o.ordered ?? 0
    noteSeen(row, o.last_at)
  }
  for (const r of received) {
    const row = rowFor(r.name)
    // The purchase order's spelling wins when there is one: that is what somebody
    // typed on the document, where the lot's copy was written by the backfill.
    if (row.orders === 0) row.name = r.name
    row.receipts += r.receipts
    noteSeen(row, r.last_at)
  }

  /**
   * The fourth source: a supplier named on a LINE rather than on the header.
   *
   * NAMES AND DATES ONLY. Apportioning a header total across line suppliers
   * cannot be reconciled against the stored purchase_orders.total without
   * double counting, so `orders` and `ordered` stay header-derived and a
   * genuinely multi-supplier order still attributes its money to the header
   * name. That is a known limit, written down rather than half-fixed: quietly
   * changing this screen's money figures is not part of the dropship change.
   *
   * A supplier who is only ever named on a line would otherwise be invisible on
   * the one screen whose job is to list who this business buys from.
   */
  for (const s of lineSupplierNames(db)) {
    const row = rowFor(s.name)
    noteSeen(row, s.last_at)
  }

  // The directory, last, and it brings no figures — only the fact that somebody
  // put this business on the list of people we buy from, and what they file them
  // under. A name in here with nothing above it is a vendor with no activity,
  // which is a real and useful thing to know: it is a supplier who has been
  // found and not yet ordered from.
  for (const c of contacts) {
    if (c.is_vendor !== 1) continue
    const row = rowFor(c.name)
    // THE DIRECTORY'S SPELLING WINS, which is the opposite of the rule one loop
    // up, and deliberately so. A lot's vendor is a backfilled copy of a purchase
    // order, so between those two the document is the better source. A directory
    // record is not a copy of anything — it is a name somebody deliberately
    // curated, where a PO supplier is free text typed at speed on a form with no
    // spell-check. Taking the PO's would also make the name on this screen flip
    // spelling every time somebody raised an order in a hurry.
    row.name = c.name
    row.onFile = true
    row.label = c.vendor_label
  }

  for (const row of merged.values()) {
    const contact = byName.get(row.name.toLowerCase())
    if (contact) row.detail = contactDetail(contact)
  }

  // Most recently dealt with first. The same ordering the supplier box uses, and
  // for the same reason: a list of everyone we buy from is only useful if the
  // ones still being bought from are at the top of it.
  //
  // The tiebreak is what keeps the directory readable. Every vendor who has never
  // been ordered from has a null lastAt, so without it 151 imported names would
  // come back in map-insertion order — which is stable enough to look deliberate
  // and arbitrary enough to be unfindable.
  return [...merged.values()].sort((a, b) => {
    const when = (b.lastAt ?? '').localeCompare(a.lastAt ?? '')
    return when !== 0 ? when : a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}

/* -------------------------------------------------------------------------- */
/* Destinations: who units can be sent to, and which ones sit at the top       */
/* -------------------------------------------------------------------------- */

/** Names already used as a line-level or allocation-level supplier. */
function lineSupplierNames(db: Database.Database): Array<{ name: string; last_at: string }> {
  return db
    .prepare(
      `SELECT TRIM(d.supplier) AS name, MAX(po.created_at) AS last_at
         FROM po_unit_destinations d
         JOIN purchase_orders po ON po.id = d.po_id
        WHERE d.supplier IS NOT NULL AND TRIM(d.supplier) != ''
        GROUP BY TRIM(d.supplier) COLLATE NOCASE`
    )
    .all() as Array<{ name: string; last_at: string }>
}

/** The pin id is DERIVED from the name, so two laptops write the same row. */
const pinId = (name: string): string => 'pin:' + name.trim().toLowerCase()

/**
 * Everywhere units can be SENT.
 *
 * ## Not listSupplierSuggestions under another name
 *
 * That answers "who do we buy from". A dropship destination is very often
 * somebody this business SELLS to — that is the whole point of the feature — so
 * this merges the vendor directory and the buyer directory into one list, on the
 * name, case-insensitively, exactly as listVendors merges its own sources. A
 * business that both buys and sells is ONE row with kind 'both', which is the
 * v62 decision honoured rather than re-argued.
 *
 * ## RM and AM are not pins
 *
 * They are prepended in code, they are the only rows with holdsStock true, and
 * they cannot be unpinned. Everything downstream reads that flag rather than
 * re-testing the name, so there is exactly one place the rule lives.
 *
 * Ordering: RM, AM, then the operator's pins in the order they chose, then
 * everyone else most-recently-dealt-with first and alphabetically after that.
 * The tiebreak is the one listVendors already uses and exists for the same
 * reason: without it every never-used directory name shares a null date and
 * comes back in map-insertion order.
 */
export function listOrderParties(): OrderParty[] {
  const db = getDb()

  const contacts = db
    .prepare(
      `SELECT name, email, phone, mobile, bill_city, bill_region, is_vendor, is_customer
         FROM invoice_customers
        WHERE active = 1
        ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as Array<{
    name: string
    email: string | null
    phone: string | null
    mobile: string | null
    bill_city: string | null
    bill_region: string | null
    is_vendor: number
    is_customer: number
  }>

  // Names on documents that are in no directory: a supplier typed onto a
  // purchase order, a destination typed into the picker for a one-off drop, a
  // vendor written onto a cost layer. Dropping them would make the box worse
  // than the plain text field it replaces — most of the regular distributors
  // were typed straight onto orders long before any directory existed.
  const history = [
    ...(db
      .prepare(
        `SELECT TRIM(supplier) AS name, MAX(created_at) AS last_at
           FROM purchase_orders
          WHERE supplier IS NOT NULL AND TRIM(supplier) != ''
          GROUP BY TRIM(supplier) COLLATE NOCASE`
      )
      .all() as Array<{ name: string; last_at: string }>),
    ...lineSupplierNames(db),
    ...(db
      .prepare(
        `SELECT TRIM(d.destination) AS name, MAX(po.created_at) AS last_at
           FROM po_unit_destinations d
           JOIN purchase_orders po ON po.id = d.po_id
          WHERE TRIM(d.destination) != ''
          GROUP BY TRIM(d.destination) COLLATE NOCASE`
      )
      .all() as Array<{ name: string; last_at: string }>),
    ...(db
      .prepare(
        `SELECT TRIM(vendor) AS name, MAX(received_at) AS last_at
           FROM inventory_lots
          WHERE vendor IS NOT NULL AND TRIM(vendor) != ''
          GROUP BY TRIM(vendor) COLLATE NOCASE`
      )
      .all() as Array<{ name: string; last_at: string }>)
  ]

  const pins = db
    .prepare('SELECT id, name, position FROM order_party_pins ORDER BY position ASC, created_at ASC')
    .all() as Array<{ id: string; name: string; position: number }>
  const pinOrder = new Map(pins.map((p, i) => [p.name.trim().toLowerCase(), i]))

  const merged = new Map<string, OrderParty>()
  const rowFor = (name: string, kind: OrderPartyKind): OrderParty => {
    const key = name.trim().toLowerCase()
    const found = merged.get(key)
    if (found) return found
    const fresh: OrderParty = {
      name: name.trim(),
      kind,
      detail: null,
      // NEVER true for anything but RM and AM, which are added separately below.
      holdsStock: false,
      pinned: pinOrder.has(key),
      pinnable: true,
      lastAt: null
    }
    merged.set(key, fresh)
    return fresh
  }
  const noteSeen = (row: OrderParty, when: string | null): void => {
    if (when && (!row.lastAt || when > row.lastAt)) row.lastAt = when
  }

  for (const c of contacts) {
    // A shelf is not a party. A contact somehow named RM would otherwise be
    // folded into the location row and its units would become receivable — see
    // the note on canonicalDestination in @shared/purchaseOrders.
    if (destinationHoldsStock(c.name)) continue
    const kind: OrderPartyKind =
      c.is_vendor === 1 && c.is_customer === 1 ? 'both' : c.is_vendor === 1 ? 'vendor' : 'customer'
    const row = rowFor(c.name, kind)
    // THE DIRECTORY'S SPELLING WINS, the same rule listVendors applies: a
    // directory record is curated, where a name on a document is free text
    // typed at speed.
    row.name = c.name.trim()
    row.kind = kind
    row.detail = contactDetail(c)
  }

  for (const h of history) {
    if (!h.name || destinationHoldsStock(h.name)) continue
    const row = rowFor(h.name, 'history')
    noteSeen(row, h.last_at)
  }
  // A pinned name that exists nowhere else still has to appear, or unpinning it
  // would be the only way to see it again.
  for (const p of pins) {
    if (destinationHoldsStock(p.name)) continue
    rowFor(p.name, 'history')
  }

  const rest = [...merged.values()].sort((a, b) => {
    const ap = pinOrder.get(a.name.toLowerCase())
    const bp = pinOrder.get(b.name.toLowerCase())
    if (ap !== undefined || bp !== undefined) {
      if (ap === undefined) return 1
      if (bp === undefined) return -1
      return ap - bp
    }
    const when = (b.lastAt ?? '').localeCompare(a.lastAt ?? '')
    return when !== 0 ? when : a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })

  // RM and AM first, always, and never removable.
  const shelves: OrderParty[] = LOCATION_IDS.map((id) => ({
    name: id,
    kind: 'location' as OrderPartyKind,
    detail: null,
    holdsStock: true,
    pinned: true,
    pinnable: false,
    lastAt: null
  }))
  return [...shelves, ...rest]
}

/**
 * Pin a party to the top of the picker, or take the pin off.
 *
 * The row's id is derived from the lower-cased name rather than minted, so two
 * laptops pinning the same shop write the SAME row and last-write-wins only ever
 * compares that row against an older copy of itself. Minting a UUID here would
 * leave two rows for one shop and a picker that showed it twice.
 */
export function setPartyPinned(name: string, pinned: boolean): OrderParty[] {
  const db = getDb()
  const clean = String(name ?? '').trim()
  if (!clean) throw new Error('Pick a name to pin.')
  // RM and AM are locations, not pins. They are prepended in code, they are the
  // only destinations that hold stock, and an operator who could unpin them
  // would be one click from an order with nowhere to receive into.
  if (destinationHoldsStock(clean)) {
    throw new Error(`${canonicalDestination(clean)} is a stock location, so it is always at the top and cannot be unpinned.`)
  }
  const id = pinId(clean)
  const ts = nowIso()
  if (pinned) {
    const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM order_party_pins').get() as {
      n: number
    }
    db.prepare(
      `INSERT INTO order_party_pins (id, name, position, created_at, updated_at)
       VALUES (@id, @name, @position, @ts, @ts)
       ON CONFLICT (id) DO UPDATE SET name = @name, updated_at = @ts`
    ).run({ id, name: clean, position: next.n, ts })
  } else {
    db.prepare('DELETE FROM order_party_pins WHERE id = ?').run(id)
  }
  return listOrderParties()
}

/**
 * Change where an EXISTING order's units are going.
 *
 * ## Refused once anything has landed
 *
 * Re-routing units that are already on a shelf would mean MOVING STOCK, which is
 * Inventory's job and not a paperwork edit — a destination change here writes no
 * inventory row at all, so an order re-routed after receipt would leave the
 * boxes where they are and the document claiming otherwise. Refused by name, and
 * the message says where the operation actually lives.
 *
 * ## Refused once the order is CLOSED, even where nothing landed
 *
 * A per-line check is not enough on its own. A mixed order auto-completes when
 * its receivable units are in, and its drop lines still read qty_received 0 for
 * ever — so the per-line guard waves them through on an order the receiving desk
 * has already finished with. Routing such a line back to RM invents units that
 * nothing can ever check in: the box is gone from Incoming and there are no scan
 * candidates (both filter on scanned_at IS NULL), and scanInPurchaseOrder
 * refuses with "already been scanned in". A closed order cannot be reopened
 * either — 'received' transitions only to 'cancelled' — so the units would be
 * stranded permanently, on a document that says they are coming.
 *
 * ## It completes the order when re-routing is what finished it
 *
 * The mirror of the same problem. Sending the last line with units still due
 * here off to a shop leaves the order open with an empty Receive panel and
 * nothing that can ever close it, so the completion test runs at the end of this
 * transaction exactly as it does after a receipt.
 *
 * ## Splits are replaced, not patched
 *
 * A partial patch would need a rule for what happens to the rows it did not
 * mention, and every such rule can leave the allocation sum out of step with the
 * line quantity (I1) behind somebody's back. An empty allocations array means
 * "not split": the rows are deleted and the line goes back to being one implicit
 * allocation, which is how a split is undone and why the unsplit state stores
 * nothing rather than one full-quantity row.
 */
export function setPurchaseOrderRouting(poId: string, patch: PoRoutingPatch): PoStatusResult {
  const db = getDb()
  const run = db.transaction((): PoStatusResult => {
    const header = db
      .prepare('SELECT id, po_number, status, supplier, location, scanned_at FROM purchase_orders WHERE id = ?')
      .get(poId) as
      | {
          id: string
          po_number: string
          status: PurchaseOrderStatus
          supplier: string | null
          location: string
          scanned_at: string | null
        }
      | undefined
    if (!header) return { po: null, error: 'Purchase order not found.' }
    if (header.status === 'cancelled') {
      return { po: getPurchaseOrder(poId), error: 'This purchase order was cancelled.' }
    }

    const lines = db
      .prepare(
        `SELECT l.id, l.quantity, l.qty_received, p.name AS product_name
           FROM purchase_order_lines l
           JOIN inventory_products p ON p.id = l.product_id
          WHERE l.po_id = ?`
      )
      .all(poId) as Array<{ id: string; quantity: number; qty_received: number; product_name: string }>
    const byId = new Map(lines.map((l) => [l.id, l]))

    const touched = new Set<string>([
      ...(patch.lines ?? []).map((l) => String(l?.lineId ?? '')),
      ...(patch.splits ?? []).map((s) => String(s?.lineId ?? ''))
    ])
    for (const lineId of touched) {
      const line = byId.get(lineId)
      if (!line) return { po: getPurchaseOrder(poId), error: 'That line is not on this purchase order.' }
      if (line.qty_received > 0) {
        return {
          po: getPurchaseOrder(poId),
          error: `${line.qty_received} unit(s) of ${line.product_name} on ${header.po_number} have already been checked in; re-route them by adjusting stock in Inventory.`
        }
      }
    }

    // AFTER the per-line check, not before it: a line with units on a shelf gets
    // the refusal that names the product and counts them, which is the more
    // useful of the two answers and the one T29 pins. This one catches the case
    // that check cannot see — a drop line, permanently at qty_received 0, on an
    // order that has already been received and retired from Incoming.
    if (header.scanned_at || header.status === 'received') {
      return {
        po: getPurchaseOrder(poId),
        error: `${header.po_number} has already been received and closed, so its routing can no longer be changed; units re-routed here would have nothing left that could check them in. Raise a new order for them, or move stock in Inventory.`
      }
    }

    for (const patchLine of patch.lines ?? []) {
      const line = byId.get(String(patchLine?.lineId ?? ''))
      if (!line) continue
      const sets: string[] = []
      const params: Record<string, unknown> = { id: line.id }
      if (patchLine.supplier !== undefined) {
        sets.push('supplier = @supplier')
        params.supplier = inheritable(patchLine.supplier, header.supplier)
      }
      if (patchLine.destination !== undefined) {
        const dest = patchLine.destination ? canonicalDestination(patchLine.destination) : null
        sets.push('destination = @destination')
        params.destination = inheritable(dest, header.location)
      }
      if (sets.length) {
        db.prepare(`UPDATE purchase_order_lines SET ${sets.join(', ')} WHERE id = @id`).run(params)
      }
    }

    // Re-read the lines' own routing AFTER the patch above, so an allocation
    // that repeats what its line now says stores NULL rather than a copy.
    const routing = new Map(
      (
        db
          .prepare('SELECT id, supplier, destination FROM purchase_order_lines WHERE po_id = ?')
          .all(poId) as Array<{ id: string; supplier: string | null; destination: string | null }>
      ).map((r) => [r.id, r])
    )

    const ts = nowIso()
    for (const split of patch.splits ?? []) {
      const line = byId.get(String(split?.lineId ?? ''))
      if (!line) continue
      const rows = Array.isArray(split.allocations) ? split.allocations : []
      const cleaned = rows.map((a) => ({
        id: typeof a?.id === 'string' && a.id.trim() ? a.id.trim() : newId(),
        quantity: Math.round(Number(a?.quantity)),
        supplier: typeof a?.supplier === 'string' && a.supplier.trim() ? a.supplier.trim() : null,
        destination: canonicalDestination(String(a?.destination ?? ''))
      }))
      for (const a of cleaned) {
        // I5, and the same refusal createPurchaseOrder gives.
        if (!Number.isFinite(a.quantity) || a.quantity < 1) {
          return {
            po: getPurchaseOrder(poId),
            error: `${line.product_name}: every split needs a whole quantity of at least 1. Remove the empty one, or give it units.`
          }
        }
        if (!a.destination) {
          return { po: getPurchaseOrder(poId), error: `${line.product_name}: every split needs a destination.` }
        }
      }
      const sum = cleaned.reduce((n, a) => n + a.quantity, 0)
      // I1.
      if (cleaned.length > 0 && sum !== line.quantity) {
        return {
          po: getPurchaseOrder(poId),
          error: `${line.product_name}: the splits add up to ${sum} of ${line.quantity} ordered, so this order cannot be saved.`
        }
      }
      db.prepare('DELETE FROM purchase_order_allocations WHERE po_line_id = ?').run(line.id)
      const own = routing.get(line.id)
      const inheritedSupplier = own?.supplier ?? header.supplier
      cleaned.forEach((a, pos) => {
        db.prepare(
          `INSERT INTO purchase_order_allocations
             (id, po_id, po_line_id, quantity, supplier, destination, position, qty_received, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
        ).run(a.id, poId, line.id, a.quantity, inheritable(a.supplier, inheritedSupplier), a.destination, pos, ts)
      })
    }

    db.prepare('UPDATE purchase_orders SET updated_at = ? WHERE id = ?').run(ts, poId)
    // Re-routing can be the act that FINISHES an order: send the last line with
    // units still due here off to a shop and everything receivable is already
    // in, with nothing left that could ever close it. Same primitive the receipt
    // paths call, inside this transaction, so the routing change and the
    // completion commit together or not at all. It writes no COGS, and a
    // now-pure-drop order still does not auto-complete (no receivable line to
    // finish), which is why one is closed by hand on the board.
    completePoIfFullyReceived(db, poId)
    return { po: getPurchaseOrder(poId) }
  })
  try {
    return run()
  } catch (err) {
    return { po: getPurchaseOrder(poId), error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The address to print on a dropship PDF, when the destination is somebody this
 * business already has on file.
 *
 * Name only when it is not. A one-off drop to a shop that is not in the
 * directory yet is a normal thing to raise — that is the whole reason
 * createPurchaseOrder keeps an unrecognised destination rather than coercing it
 * — so the document prints what it knows and does not pretend to an address.
 */
/**
 * The email address already on file for a party, by name.
 *
 * ## Why a lookup and not a column
 *
 * A purchase order's supplier is a STRING on the document — no id, no table,
 * nothing pointing at it — which is deliberate and written down at length beside
 * `SupplierSuggestion`: a distributor is somebody this business buys from and
 * never bills, so making them a foreign key into the customer table would assert
 * a relationship the data does not have.
 *
 * But the contact directory the supplier box already searches IS that table, and
 * it holds an email for most of the people in it. So the address can be FOUND by
 * name at the moment somebody wants to email a label, without either document
 * having to own a copy of it that then goes stale.
 *
 * A suggestion, never an assertion. It fills the To box in and the operator can
 * type over it — because two suppliers can share a name, a contact's address can
 * be old, and a label going to the wrong party is somebody else's parcel.
 *
 * Matched case-insensitively on the trimmed name, the same way every other party
 * lookup in this file matches, so "fenwick distribution" typed on a Tuesday
 * finds the record filed as "Fenwick Distribution".
 */
export function lookupPartyEmail(name: string): string | null {
  const clean = String(name ?? '').trim()
  if (!clean) return null
  const row = getDb()
    .prepare(
      `SELECT email FROM invoice_customers
        WHERE LOWER(TRIM(name)) = LOWER(?) AND active = 1 AND email IS NOT NULL AND email != ''
        LIMIT 1`
    )
    .get(clean) as { email: string | null } | undefined
  return row?.email?.trim() || null
}

export function lookupPartyAddress(name: string): string[] | null {
  const clean = String(name ?? '').trim()
  if (!clean) return null
  const row = getDb()
    .prepare(
      `SELECT name, bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country
         FROM invoice_customers
        WHERE LOWER(TRIM(name)) = LOWER(?) AND active = 1
        LIMIT 1`
    )
    .get(clean) as
    | {
        name: string
        bill_line1: string | null
        bill_line2: string | null
        bill_city: string | null
        bill_region: string | null
        bill_postal_code: string | null
        bill_country: string | null
      }
    | undefined
  if (!row) return null
  const city = [row.bill_city, row.bill_region].filter(Boolean).join(', ')
  const lines = [
    row.bill_line1,
    row.bill_line2,
    [city, row.bill_postal_code].filter(Boolean).join(' '),
    row.bill_country
  ]
    .map((l) => (l ?? '').trim())
    .filter(Boolean)
  return lines.length ? lines : null
}
