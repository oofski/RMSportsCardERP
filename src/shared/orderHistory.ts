import type { PurchaseOrderStatus } from './types'
import type { InvoiceStatus } from './invoices'

/**
 * The year's ledger of orders — what was bought and what was sold, one row each.
 *
 * ## Why these are their own types
 *
 * `PurchaseOrderDetail` and `InvoiceDetail` carry everything the boards need:
 * tracking state, QuickBooks push state, allocations, destinations, per-unit
 * receipts. None of that belongs in a record you are reading a year later, and
 * sending it would make a 400-order year a several-megabyte read.
 *
 * These are the fields somebody actually looks up: which number, when, who,
 * how much, and what was on it. Flat, small, and the same shape for both sides
 * of the business so one screen can render either.
 *
 * ## Lines travel WITH the row
 *
 * Expanding a row shows its contents, and a second round-trip per expand would
 * make that feel like the network rather than like a disclosure triangle. A
 * year's lines are a few thousand small objects; the whole payload is smaller
 * than one product image.
 */

/** One line as it was recorded on the document. */
export interface OrderHistoryLine {
  position: number
  /** The catalog product, when the line came from one. */
  productId: string | null
  /** What the document calls it — the product's name, or freehand text. */
  item: string
  sku: string | null
  quantity: number
  unitPrice: number
  amount: number
  /**
   * Units actually received (buy side) or that actually left the shelf (sell
   * side). Null on a line where the distinction does not apply.
   */
  settledQty: number | null
}

export interface PurchaseOrderHistoryRow {
  id: string
  /** "PO-0042". What somebody searches by. */
  number: string
  status: PurchaseOrderStatus
  supplier: string | null
  /** RM, AM, or the name of a place the units were dropped straight to. */
  destination: string
  /** The business day the order is filed under — ordered, else created. */
  date: string
  orderedAt: string | null
  paidAt: string | null
  receivedAt: string | null
  cancelledAt: string | null
  carrier: string | null
  trackingNumber: string | null
  unitsOrdered: number
  unitsReceived: number
  total: number
  /** True once it has left the board — see isSettledPurchaseOrder. */
  settled: boolean
  lines: OrderHistoryLine[]
}

export interface SalesOrderHistoryRow {
  id: string
  /** The invoice number, or the QuickBooks one when they differ. */
  number: string
  status: InvoiceStatus
  customerName: string
  date: string
  dueDate: string | null
  terms: string
  /** The document number QuickBooks gave it, when it has been posted. */
  qboDocNumber: string | null
  unitsSold: number
  unitsOut: number
  total: number
  /** What the units on it cost, from the FIFO layers they consumed. */
  cost: number
  /** total − cost. Null when nothing on the order had a recoverable cost. */
  margin: number | null
  /**
   * True once it has left the board — see isSettledInvoice.
   *
   * The sell-side twin of the same field on a purchase order, added when the
   * sales board finally got the sweep the PO board has had all along. Without it
   * this row could not draw the "filed" chip, and the one screen that can tell
   * somebody where an order went would not say it had gone anywhere.
   */
  settled: boolean
  lines: OrderHistoryLine[]
}

/** Which years have anything in them, newest first. */
export interface OrderHistoryYears {
  purchase: number[]
  sales: number[]
}

/** The four-digit year of an ISO date or a `YYYY-MM-DD`, or null. */
export function historyYearOf(value: string | null | undefined): number | null {
  const year = Number(String(value ?? '').slice(0, 4))
  return Number.isInteger(year) && year > 1970 ? year : null
}
