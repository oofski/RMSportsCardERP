import { isLocation, LOCATION_IDS } from './inventory'
import type { PurchaseOrderStatus } from './types'

export const PO_STATUSES: PurchaseOrderStatus[] = ['ordered', 'paid', 'received', 'cancelled']

/**
 * Pipeline columns in display order.
 *
 * RECEIVED SITS BEFORE PAID, which is the order the work actually happens in on
 * this floor: stock turns up and gets checked in, and the invoice is settled
 * after. PO_TRANSITIONS has allowed ordered → received directly for exactly that
 * reason, so a board that drew Paid first was showing a step most orders take
 * second — and the column with eight cards in it sat to the right of an empty
 * one.
 *
 * DISPLAY ONLY. Nothing derives a legal move from this order; see
 * PO_TRANSITIONS, which is unchanged.
 */
export const PO_STAGES: { id: PurchaseOrderStatus; label: string }[] = [
  { id: 'ordered', label: 'Ordered' },
  { id: 'received', label: 'Received' },
  { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' }
]

/**
 * Allowed moves between stages. Cancel is reachable from EVERY live stage,
 * including received: a buy that was checked in by mistake has to be undoable,
 * and refusing left the only exit as deleting the paperwork, which loses the
 * record. Cancelling a received PO hands its stock back by reversing the exact
 * FIFO lot each line opened — see setPurchaseOrderStatus — and is refused when
 * that stock has already been sold. Cancelled is the one terminal stage.
 *
 * Ordered goes straight to Received as well as through Paid, because stock
 * regularly turns up before the invoice is settled. While that move did not
 * exist, the only way to record a delivery was to click Paid first — stamping a
 * payment that had not happened — which made the paid date on every such order
 * worth nothing. See setPurchaseOrderPaid: payment is now recorded as its own
 * fact, and this is the other half of that change.
 */
export const PO_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  ordered: ['paid', 'received', 'cancelled'],
  paid: ['ordered', 'received', 'cancelled'],
  received: ['cancelled'],
  // Cancelled is no longer the end of the road. A PO cancelled by mistake had
  // no way back, and the only remedy was to retype the whole order under a new
  // number — which loses the original number, the dates and the paperwork
  // anybody had already been sent.
  //
  // It reverts to ORDERED and nowhere else, because that is the only stage the
  // cancel left it able to occupy: cancelling reverses every received unit,
  // zeroes qty_received and deletes the receipts, so the order genuinely has
  // nothing checked in any more. Reverting to Received would claim stock that
  // was handed back. See setPurchaseOrderStatus, which re-books the COGS row
  // the cancel voided.
  cancelled: ['ordered']
}

export function isPurchaseOrderStatus(value: unknown): value is PurchaseOrderStatus {
  return PO_STATUSES.includes(value as PurchaseOrderStatus)
}

/**
 * Which COLUMN an order is drawn in, which is not always its status.
 *
 * ## Paid and received is paid
 *
 * Payment is recorded as its own fact — `paid_at`, stamped by
 * setPurchaseOrderPaid without moving the stage — precisely so that stock
 * arriving before the invoice is settled does not force somebody to click Paid
 * for a payment that has not happened. The consequence was an order that had
 * been received AND paid sitting under Received for ever, because its status
 * still said so, while the column to its right was the one that meant finished.
 *
 * With Received now drawn before Paid, the two columns read as the two steps in
 * the order they happen, and PAID IS THE END OF THE LINE. So an order carrying a
 * payment date belongs there whatever stage it stopped at.
 *
 * ## Derived, never stored
 *
 * Both facts survive: the order still knows it was received, and still knows
 * when it was paid. Writing 'paid' into `status` when a payment landed would
 * throw the received state away — and with it the receipt dates, the completion
 * test and the only record that the boxes actually turned up.
 *
 * Cancelled outranks everything: a cancelled order that was once paid is not
 * finished business, it is cancelled, and its stock has been handed back.
 */
export function poColumnOf(po: {
  status: PurchaseOrderStatus
  paidAt?: string | null
}): PurchaseOrderStatus {
  if (po.status === 'cancelled') return 'cancelled'
  if (po.paidAt) return 'paid'
  return po.status
}

/**
 * How long a fully-received order stays on the board after the boxes land.
 *
 * TWO DAYS, and the two days are the point rather than the number. A received
 * order is not finished with the moment it is checked in: a short shipment turns
 * up the next morning, a scan gets corrected, somebody notices the price on the
 * invoice does not match the line. Sweeping it off the board the instant the
 * last box is counted would put the one order most likely to need a correction
 * behind a search.
 *
 * After that it is history. The board is a place where work is done, and an
 * order with nothing left to do on it is clutter that makes the orders that DO
 * need attention harder to see — which is the whole reason this exists.
 */
export const PO_SETTLE_DAYS = 2

/**
 * Is this order finished with — off the board, into the year's ledger?
 *
 * DERIVED, never stored, and that is deliberate. A stored `archived` flag needs
 * something to set it: a background job, a check on every read, or a button
 * somebody has to remember. All three can be wrong, and the first two can be
 * wrong on one machine and right on another — sync would then carry the wrong
 * answer across. Computed from `received_at` it is simply a fact about the
 * clock, identical everywhere, correct on a laptop that has been shut for a
 * month, and needs no migration to change if the two days ever become five.
 *
 * Keyed on `receivedAt` rather than on `status`, because an order can be both
 * received AND paid and the status column only holds one of those. The
 * timestamp is what records that the boxes arrived.
 *
 * A cancelled order is NOT settled by this. Cancelling reverses every received
 * unit and is reversible in turn; it belongs on the board where somebody can see
 * what they did.
 */
export function isSettledPurchaseOrder(
  po: { status: PurchaseOrderStatus; receivedAt: string | null },
  now: number = Date.now()
): boolean {
  if (po.status === 'cancelled' || !po.receivedAt) return false
  const at = Date.parse(po.receivedAt)
  if (!Number.isFinite(at)) return false
  return now - at >= PO_SETTLE_DAYS * 24 * 60 * 60 * 1000
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

/* -------------------------------------------------------------------------- */
/* Destinations and dropship                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A DESTINATION is wider than a LOCATION, and keeping the two words apart is
 * the whole safety story of this feature.
 *
 *   location    — RM or AM. A shelf in a building. Stock can exist here, and
 *                 `isLocation` in @shared/inventory is what decides. Nine call
 *                 sites gate a stock write on it.
 *   destination — where units are going: a location, OR the name of a vendor or
 *                 a customer. Every location is a destination; most destinations
 *                 are not locations.
 *
 * `isLocation` is deliberately NOT widened to accept a party name. If it were,
 * every one of those nine gates would start letting stock be written to a
 * customer's name, and `addStock` does not validate its location argument
 * (`src/main/db/inventory.ts`) — it would create a real `inventory_stock` row
 * and a real FIFO layer keyed to that name. `syncProductAvgCost` then averages
 * `inventory_lots` across ALL locations, so a phantom layer at "Fenwick Cards"
 * would move the unit cost — and therefore the reported margin — of boxes
 * physically sitting on the RM shelf. `assertStockLotsConsistent` would still
 * pass, because the phantom row is internally consistent with itself.
 *
 * So: `isDestination` validates what may be TYPED IN A PICKER.
 * `destinationHoldsStock` decides what may be WRITTEN TO STOCK, and it is a
 * straight delegation to `isLocation` rather than a second copy of the test.
 */

/** Anything non-empty is a destination — a shelf, or somebody's name. */
export function isDestination(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Fold a hand-typed location id back to its canonical spelling; leave every
 * other name alone but trimmed.
 *
 * Without this, "rm" typed into the destination box becomes a dropship to a
 * shop called rm: the units stop being receivable, no box appears in Incoming,
 * and the PO can never complete. The failure is silent and looks like the
 * feature is broken rather than like a typo, so it is fixed at the door.
 */
export function canonicalDestination(value: string): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  const hit = LOCATION_IDS.find((id) => id.toLowerCase() === trimmed.toLowerCase())
  return hit ?? trimmed
}

/**
 * May units bound here be checked into stock?
 *
 * The single question every receiving path asks, and it is asked PER
 * ALLOCATION — never per order. There is no "this is a dropship PO" branch
 * anywhere in the receiving code, because a mixed order is both at once.
 */
export function destinationHoldsStock(destination: string): boolean {
  return isLocation(canonicalDestination(destination))
}

/**
 * What kind of order this is, derived from where its units are going.
 *
 * Never stored. A stored flag would be a second source of truth that drifts the
 * first time somebody edits a line's destination, and the failure mode is a
 * dropship order that still says PO and gets received onto a shelf.
 */
export type OrderKind = 'stock' | 'drop' | 'mixed'

export function orderKindOf(receivableUnits: number, dropUnits: number, headerDestination: string): OrderKind {
  // A PO with no lines yet has nothing to derive from, so it reads as whatever
  // its header says. Without this an empty draft would render as a dropship the
  // moment it was created, before anybody had chosen anything.
  if (receivableUnits <= 0 && dropUnits <= 0) {
    return destinationHoldsStock(headerDestination) ? 'stock' : 'drop'
  }
  if (dropUnits <= 0) return 'stock'
  if (receivableUnits <= 0) return 'drop'
  return 'mixed'
}

/**
 * `PO-0042` becomes `Drop-0042` — for display, and nowhere else.
 *
 * `purchase_orders.po_number` stores `PO-0042` for a dropship too, and the two
 * share one counter, so the sequence has no gaps and no branches. Storing the
 * Drop spelling would mean the prefix could disagree with the destinations the
 * moment a line was re-routed, and would put a second format through
 * `nextPoNumber`'s UNIQUE constraint.
 *
 * A MIXED order keeps `PO`. The prefix answers exactly one question — are boxes
 * coming to this building? — and on a mixed order they are. The glow says part
 * of it never arrives. Calling it `Drop` would tell the receiving desk to expect
 * nothing, which is worse than saying too little.
 */
export function displayOrderNumber(poNumber: string, kind: OrderKind): string {
  if (kind !== 'drop') return poNumber
  return poNumber.startsWith('PO-') ? 'Drop-' + poNumber.slice(3) : poNumber
}

/** Does this order get the dropship glow? Mixed orders do; pure stock does not. */
export function orderGlows(kind: OrderKind): boolean {
  return kind === 'drop' || kind === 'mixed'
}

/** How the destination reads on a card or a receipt header. */
export function destinationSummary(destinations: string[]): string {
  const seen = [...new Set(destinations.map(canonicalDestination).filter(Boolean))]
  if (seen.length === 0) return ''
  if (seen.length === 1) return seen[0]
  return `${seen.length} destinations`
}

/**
 * Where a party may be offered from. `both` is a business this operation buys
 * from AND sells to — one row, not two, the same rule `listVendors` already
 * applies when it merges its sources on a case-insensitive name.
 */
export type OrderPartyKind = 'location' | 'vendor' | 'customer' | 'both' | 'history'

/** One row in the destination / supplier picker. */
export interface OrderParty {
  name: string
  kind: OrderPartyKind
  /** Email · phone · city, when a contact record exists under this name. */
  detail: string | null
  /** True only for RM and AM. Drives every stock/no-stock decision downstream. */
  holdsStock: boolean
  pinned: boolean
  /** False for RM and AM: they are locations, not pins, and cannot be removed. */
  pinnable: boolean
  /** Most recent order or receipt, ISO. Null means never dealt with. */
  lastAt: string | null
}

/** How many user pins are shown above the fold, before the full list. */
export const MAX_PINNED_PARTIES = 6
