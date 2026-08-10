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
 * ## Two sources, and neither one is the whole answer
 *
 * A vendor reaches this list two ways, and the difference between them is the
 * difference between who this business CAN buy from and who it DOES.
 *
 *   DERIVED — somebody has bought from them. Their name is the free text on a
 *     purchase order (purchase_orders.supplier) or on a cost layer that stock
 *     was received into (inventory_lots.vendor). This is complete by
 *     construction: nobody can be bought from without appearing, it cannot drift
 *     out of date, and every figure below it comes from real documents.
 *
 *   ON FILE — the operator imported the vendor directory, which marks a contact
 *     row is_vendor = 1 (see db/vendorImport.ts). This is the half the derived
 *     list could never hold: a street address, and a business that has been
 *     found and vetted but not yet ordered from.
 *
 * MERGED ON THE NAME, case-insensitively, exactly as the two derived sources
 * already merge with each other. That is what makes the same shop appear once
 * whether it was typed on a purchase order in caps, written onto a cost layer by
 * the backfill, or imported from the owner's sheet.
 *
 * Either side can exist alone and both cases are real, so both are shown and
 * both are labelled — see `onFile` and the order/receipt counts. A vendor with
 * activity and no directory record is somebody bought from before the list was
 * made; a directory record with no activity is somebody found and not yet used.
 * Hiding either one would make this screen answer a narrower question than the
 * one it is titled with.
 */
export interface VendorSummary {
  /**
   * The imported directory's spelling when there is one, otherwise their name as
   * most recently typed on a purchase order.
   */
  name: string
  /** Email · phone · city, when a contact record is filed under this name. */
  detail: string | null
  /**
   * True when a contact row is flagged as a vendor — i.e. they are in the
   * imported directory. False means every figure below came from a document and
   * this app has never been told an address for them.
   */
  onFile: boolean
  /**
   * What the OWNER files them under, when it says something the name does not.
   * Null for a vendor known only from purchase orders: no document carries one.
   */
  label: string | null
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
  /**
   * The most recent order or receipt, ISO. NULL IS NOW POSSIBLE and means
   * exactly one thing: this vendor is in the directory and has never been bought
   * from. Before the directory existed a vendor could only exist by having been
   * bought from, so this was never null; anything sorting or formatting it has
   * to say "never" rather than show a blank that reads as a missing date.
   */
  lastAt: string | null
}

/** Has this business actually been bought from, or is it only on the list? */
export function hasVendorActivity(v: VendorSummary): boolean {
  return v.orders > 0 || v.receipts > 0
}
