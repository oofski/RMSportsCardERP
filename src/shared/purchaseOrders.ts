import type { PurchaseOrderStatus } from './types'

export const PO_STATUSES: PurchaseOrderStatus[] = ['ordered', 'paid', 'received', 'cancelled']

/** Pipeline columns in display order. */
export const PO_STAGES: { id: PurchaseOrderStatus; label: string }[] = [
  { id: 'ordered', label: 'Ordered' },
  { id: 'paid', label: 'Paid' },
  { id: 'received', label: 'Received' },
  { id: 'cancelled', label: 'Cancelled' }
]

/**
 * Allowed moves between stages. Cancel is reachable from EVERY live stage,
 * including received: a buy that was checked in by mistake has to be undoable,
 * and refusing left the only exit as deleting the paperwork, which loses the
 * record. Cancelling a received PO hands its stock back by reversing the exact
 * FIFO lot each line opened — see setPurchaseOrderStatus — and is refused when
 * that stock has already been sold. Cancelled is the one terminal stage.
 */
export const PO_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  ordered: ['paid', 'cancelled'],
  paid: ['ordered', 'received', 'cancelled'],
  received: ['cancelled'],
  cancelled: []
}

export function isPurchaseOrderStatus(value: unknown): value is PurchaseOrderStatus {
  return PO_STATUSES.includes(value as PurchaseOrderStatus)
}

export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PO_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * A name to offer in the supplier box.
 *
 * ## Why a suggestion and not a supplier record
 *
 * A PO's supplier is a STRING on the document — a nullable TEXT column, no id,
 * no table, nothing pointing at it. A buyer is a record with a UUID that
 * invoices refer to. They are not the same kind of thing in this schema, and
 * turning the supplier into a foreign key would assert that everyone this
 * business buys from is also someone it bills, which is false: a distributor
 * is a supplier and never a buyer.
 *
 * So the two stay separate and only the SEARCH is shared. The contact list the
 * owner imported is offered on the supplier box, and picking one types its name
 * in — which is exactly the auto-populate that was asked for, without inventing
 * a relationship the data does not have.
 *
 * ## Both sources, because both answer the question
 *
 * `contact` is somebody in the buyer/contact list. `history` is a name already
 * used on a purchase order and known nowhere else — most of the regular
 * distributors, who were typed straight onto POs long before any contact list
 * existed. Dropping those would make the box worse than the plain text field it
 * replaced.
 */
export interface SupplierSuggestion {
  name: string
  /** Email, phone or city for a contact; the PO count for a name from history. */
  detail: string | null
  source: 'contact' | 'history'
  /** How many purchase orders already name them. Zero for an unused contact. */
  usedOnOrders: number
}

/**
 * One vendor on the Admin → Vendors list.
 *
 * ## This is DERIVED, and that is the honest shape of the data
 *
 * There is no vendor table in this schema and this interface does not pretend
 * otherwise. A vendor exists because somebody has BOUGHT from them: their name
 * is the free text on a purchase order (`purchase_orders.supplier`) or on a
 * cost layer that stock was received into (`inventory_lots.vendor`). Nothing
 * else in the database says who a vendor is.
 *
 * So the list is exactly "everyone this business has bought from", which is a
 * true and complete answer to "who are our vendors" — and it is a stronger one
 * than a typed-in list would be, because it cannot drift out of date and cannot
 * contain somebody nobody has ever ordered from.
 *
 * What it CANNOT do is hold a vendor's email, phone or address, because no
 * purchase order carries those. `detail` is filled in only when a contact
 * record happens to be filed under the same name — the same name match, and the
 * same reasoning, as SupplierSuggestion above. A vendor with no contact record
 * shows a blank there, which is the truth: this app has never been told how to
 * reach them.
 *
 * DO NOT "fix" that by minting a vendor record here. See the note on
 * listSupplierSuggestions for why a second contact table for the buy side is
 * the wrong answer, and the report accompanying this change for what filing
 * vendor contact details properly would actually cost.
 */
export interface VendorSummary {
  /** Their name as most recently typed on a purchase order. */
  name: string
  /** Email · phone · city, when a contact record is filed under this name. */
  detail: string | null
  /**
   * Purchase orders naming them, CANCELLED ONES INCLUDED. A cancelled order is
   * still an order this business raised with them, and dropping it would leave
   * a vendor whose only order was cancelled reading as a stranger with a date.
   */
  orders: number
  /**
   * Σ of those orders' totals with CANCELLED ONES EXCLUDED — the opposite rule
   * to `orders`, deliberately: money on a cancelled order was never committed,
   * so counting it would overstate what this business has spent with them.
   */
  ordered: number
  /**
   * Cost layers naming them. Non-zero with `orders` at 0 means every receipt
   * from them was entered straight onto stock without a purchase order, which
   * is a real way stock arrives here and not an error.
   */
  receipts: number
  /** The most recent order or receipt, ISO. Null is impossible in practice. */
  lastAt: string | null
}
