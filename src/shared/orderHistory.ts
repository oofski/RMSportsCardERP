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
/**
 * WHERE SOME OF A SALES-ORDER LINE'S UNITS CAME FROM.
 *
 * A LIST per line, not one answer, because a line can be split by case — "eight
 * off the RM shelf and two shipped direct from Kestrel" is one line with two
 * origins, and collapsing that to the first would put the wrong story in the
 * one screen somebody reads a year later to find out what happened.
 *
 * `fromShelf` and `poNumber` are two different facts and both are needed:
 *
 *   fromShelf true, no PO      ordinary stock, oldest first. Most lines.
 *   fromShelf true, a PO       taken out of THAT order's cases, and costed
 *                              against its layers.
 *   fromShelf false, no PO     a supplier shipped it direct and nobody said
 *                              which purchase it was.
 *   fromShelf false, a PO      shipped direct off that purchase — the roadshow
 *                              open-tab case, where the goods never touched a
 *                              shelf here and this is the only record of where
 *                              they came from.
 */
export interface HistoryLineSource {
  /** How many of the line's units this origin accounts for. */
  quantity: number
  /** The shelf, or the party that shipped it direct. Inheritance resolved. */
  where: string
  /** True when these units came off our own shelf. */
  fromShelf: boolean
  poId: string | null
  poNumber: string | null
  supplier: string | null
}

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
  /**
   * Where this line's goods came from. ALWAYS EMPTY on a purchase order line:
   * a purchase IS the origin, so asking it where its goods came from is asking
   * the wrong document. See HistoryLineSource.
   */
  sources: HistoryLineSource[]
}

/** A purchase order named from somewhere else. */
export interface HistoryPurchaseRef {
  poId: string
  poNumber: string
  supplier: string | null
}

/** A sales order named from somewhere else. */
export interface HistorySaleRef {
  invoiceId: string
  number: string
  customerName: string
}

/**
 * A PURCHASE ORDER THE HISTORY CAN BE NARROWED TO.
 *
 * The owner: "I can see where everything is coming from" — which means being
 * able to start from the buying trip as well as from the order. Only purchases
 * that actually supplied something are offered: a list of every purchase ever
 * raised would bury the four that answer the question.
 */
export interface HistorySource {
  poId: string
  poNumber: string
  supplier: string | null
  /** The day it was raised, for telling two trips to one shop apart. */
  orderedOn: string | null
  /** True when it was opened as a running tab — a roadshow. */
  roadshow: boolean
  /** How many sales draw on it, by a line or by being attached to the sale. */
  saleCount: number
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
  /**
   * WHERE ITS GOODS WENT — the sales this purchase supplied, and who bought them.
   *
   * The other direction of the same link, and the half a purchase order could
   * never show. A trip to a roadshow that cost $9,000 is only half a story; the
   * other half is which five sales came out of it.
   *
   * Read from all three places a sale can name a purchase — the line, the
   * per-case split, and `sale_purchase_links` — because they are three different
   * claims and any of them makes this purchase the origin of those goods.
   */
  suppliedSales: HistorySaleRef[]
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
  /**
   * The purchases attached to this sale as a DOCUMENT, from
   * `sale_purchase_links` — the operator's claim about which orders supplied it,
   * which is a different fact from what any one line says about its own cases.
   * A dropship is the usual case: the two documents are one deal and may share
   * no catalog product at all.
   */
  sourcePos: HistoryPurchaseRef[]
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
