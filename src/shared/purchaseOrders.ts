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
