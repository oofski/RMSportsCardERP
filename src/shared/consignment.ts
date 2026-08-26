/**
 * STOCK THIS BUSINESS STILL OWNS AND NO LONGER HAS.
 *
 * The owner's words: "for cases of certain cards I can mark it as I have sent
 * that case to consignment ... a popup that just lets me say who I gave it to
 * ... and basically if something is in consignment means we cannot use it for
 * streaming or for selling it."
 *
 * A case handed to a shop to sell on our behalf is in a state this app had no
 * way to express. It was either on the shelf — where a sales order could bill it
 * and a break could rip it, neither of which is possible for a box that is
 * fifty miles away — or gone, which would write off a case we still own and
 * expect money for.
 *
 * ## The one decision the whole feature rests on
 *
 * SENDING ON CONSIGNMENT CONSUMES THE COST LOTS, exactly as a break or a
 * giveaway does. The units come off the shelf at their real FIFO cost and the
 * layers they came from are remembered.
 *
 * That is what makes "cannot be sold and cannot be streamed" TRUE rather than
 * enforced. Neither path gets a new check: `consumeFifo` cannot find units that
 * are not in a lot, so a sales order cannot draw them, a break cannot rip them,
 * and the scan queue cannot offer them. A flag on the product would have needed
 * a guard in every one of those places, and the one that got missed would be
 * the one that quietly sold a case out of somebody else's shop.
 *
 * It is the same shape as `stream_items` / `stream_item_lots` on purpose —
 * pull N units of a product out of a location at their layered cost, remember
 * which layers — which also means it inherits the reversal path that already
 * works: `restoreFifo` puts a returned case back into the exact layers it left,
 * at the exact price, so the FIFO order of the shelf is what it would have been
 * had it never gone.
 *
 * ## Three ways it ends, and only one of them is a sale
 *
 *   OUT       — they have it. It is our asset, sitting somewhere else.
 *   RETURNED  — it came back unsold. The layers are restored; the shelf is as
 *               it was, and the whole episode cost nothing.
 *   SOLD      — they sold it. The cost stays OFF the shelf, because the case is
 *               genuinely gone. What the consignee owes us is a conversation
 *               about money, not about stock, and this app does not pretend to
 *               model a settlement it has never been given the terms of.
 */

/** Where a consignment has got to. */
export type ConsignmentStatus = 'out' | 'returned' | 'sold'

export const CONSIGNMENT_STATUSES: Array<{
  id: ConsignmentStatus
  label: string
  hint: string
}> = [
  { id: 'out', label: 'Out on consignment', hint: 'They have it. It is still ours.' },
  { id: 'returned', label: 'Came back', hint: 'Returned unsold and back on the shelf' },
  { id: 'sold', label: 'They sold it', hint: 'Gone for good — settle up outside the app' }
]

export function consignmentStatusLabel(status: string): string {
  return CONSIGNMENT_STATUSES.find((s) => s.id === status)?.label ?? 'Out on consignment'
}

/** Anything unrecognised reads as still out, which is the safe assumption:
 *  it keeps the units visible as somebody else's problem rather than losing
 *  them. */
export function asConsignmentStatus(v: unknown): ConsignmentStatus {
  return v === 'returned' || v === 'sold' ? v : 'out'
}

/** One shipment out to one consignee. */
export interface Consignment {
  id: string
  /** Null only when the catalog product was later deleted. */
  productId: string | null
  /** Denormalised, so the row still reads after a product is deleted — the same
   *  rule stream_items follows, and for the same reason. */
  productName: string
  sku: string
  category: string
  /** Who has it. A NAME on a document, not a record: see the note on the form. */
  consignee: string
  /** The shelf it left from. Needed to put it back on the right one. */
  location: string
  quantity: number
  /** Per unit, off the layers this shipment actually consumed. Never an average. */
  unitCost: number
  /** quantity × the real layered costs. What is sitting in somebody else's shop. */
  costTotal: number
  status: ConsignmentStatus
  sentAt: string
  sentBy: string | null
  /** When it came back, or when they told us it sold. Null while out. */
  settledAt: string | null
  settledBy: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

/** What the form hands to the store. */
export interface NewConsignment {
  productId: string
  consignee: string
  location: string
  quantity: number
  note?: string | null
}

export const CONSIGNEE_MAX = 120
export const CONSIGNMENT_NOTE_MAX = 400

/**
 * Refuse it before anything moves, in words somebody can act on.
 *
 * The quantity is checked against what is ON THE SHELF, not against the
 * product's total: a case at AM is not something RM can send, and a consignment
 * that consumed more than a location holds would throw inside `consumeFifo` and
 * roll back with a message about cost lots that means nothing to an operator.
 */
export function validateConsignment(
  input: NewConsignment,
  onHandAtLocation: number
): string | null {
  if (!String(input?.productId ?? '').trim()) return 'Pick a product.'
  const who = String(input?.consignee ?? '').trim()
  if (!who) return 'Say who you gave it to.'
  if (who.length > CONSIGNEE_MAX) return 'That name is too long.'
  if (!String(input?.location ?? '').trim()) return 'Say which shelf it came off.'
  const qty = Number(input?.quantity)
  if (!Number.isFinite(qty) || qty <= 0) return 'Send at least one.'
  if (qty > onHandAtLocation + 1e-9) {
    return onHandAtLocation <= 0
      ? `There is nothing on the ${String(input.location).trim()} shelf to send.`
      : `Only ${onHandAtLocation} on the ${String(input.location).trim()} shelf — you cannot send ${qty}.`
  }
  if (String(input?.note ?? '').length > CONSIGNMENT_NOTE_MAX) {
    return 'That note is too long.'
  }
  return null
}

/**
 * Units of this product currently sitting with somebody else.
 *
 * Only the OUT ones. A returned consignment put its units back on the shelf and
 * a sold one is gone, so counting either would double what the business
 * believes it owns.
 */
export function consignedUnits(rows: readonly Consignment[]): number {
  let n = 0
  for (const r of rows) if (r.status === 'out') n += r.quantity
  return Math.round(n * 10000) / 10000
}

/** What that stock cost us — the money standing in somebody else's shop. */
export function consignedCost(rows: readonly Consignment[]): number {
  let total = 0
  for (const r of rows) if (r.status === 'out') total += r.costTotal
  return Math.round(total * 100) / 100
}

/**
 * "2 cases with Fenwick Card Shop", for a one-line summary.
 *
 * Null when nothing is out, so the caller draws NOTHING rather than a line
 * saying zero. A product that has never been consigned should look exactly as
 * it did before this feature existed.
 */
export function consignmentSummary(
  rows: readonly Consignment[],
  unitNoun = 'unit'
): string | null {
  const out = rows.filter((r) => r.status === 'out')
  if (out.length === 0) return null
  const units = consignedUnits(rows)
  const people = [...new Set(out.map((r) => r.consignee))]
  const who = people.length === 1 ? people[0] : `${people.length} consignees`
  return `${units} ${units === 1 ? unitNoun : unitNoun + 's'} with ${who}`
}

/**
 * May this consignment still be acted on?
 *
 * Only while it is OUT. Returning a returned one would put a second copy of the
 * units back on the shelf — inventing stock — and re-selling a sold one is a
 * second claim on a case that has already gone. Both are the kind of thing a
 * double-click does, so the refusal lives here and the store checks it again.
 */
export function canSettleConsignment(status: ConsignmentStatus): boolean {
  return status === 'out'
}

export function settleRefusal(status: ConsignmentStatus): string | null {
  if (canSettleConsignment(status)) return null
  return status === 'returned'
    ? 'That consignment already came back — its units are on the shelf.'
    : 'That consignment was already settled as sold.'
}
