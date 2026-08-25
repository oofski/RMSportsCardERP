/**
 * THE THREE THINGS SOMEBODY SCANS A BOARD FOR.
 *
 * The owner's words: "clearly be able to see what is paid vs unpaid, shipped vs
 * not shipped, payment up front / payment upon delivery."
 *
 * Every one of those facts was already on the sales-order card and NONE of them
 * was reliably readable, because each was shown by something being THERE:
 *
 *   · PAID was the words "paid 12 Aug" where an unpaid order said "due 3 Sep".
 *     Two dates in the same place, in the same grey, telling opposite stories.
 *   · SHIPPED was a carrier line that simply is not drawn when there is no
 *     tracking number. An order nobody has posted looks identical to an order
 *     with no parcel — nothing.
 *   · THE TERMS were not on the card at all. They decide whether an order can be
 *     released before the money lands, which is the rule the packing gate keeps,
 *     and the only place to read them was inside the order.
 *
 * Absence is not something anybody scans for. The purchase-order board learned
 * this already — it grew an explicit "Owing" chip precisely because "no Paid
 * chip" was invisible — and this is the same lesson applied to the other side
 * and to the other two questions.
 *
 * ## So each answer is a WORD, always drawn, in a fixed slot
 *
 * Three chips in the same order on every card, so a column can be read
 * vertically: money, then shipping, then terms. A card that is missing a chip is
 * never how a state is expressed here — the only thing that varies is what the
 * chip SAYS.
 *
 * ## Labels and tones live here, not in the card
 *
 * Because the same three answers now appear in more than one place — on the
 * card, and in the filter that narrows the board down to them — and a filter
 * whose idea of "shipped" differs from the chip's is a filter that hides the
 * card it claims to be showing.
 */

import type { PaymentTiming } from './freight'
import { isInvoicePaid, type InvoiceStatus } from './invoices'
import type { ShipStatusCode } from './shippingTypes'
import { TRACKING_LABELS } from './tracking'

/**
 * How a chip reads. `tone` names a colourway rather than a colour, so the
 * stylesheet owns the value and a theme change never comes back to this file.
 */
export type StatusTone = 'good' | 'bad' | 'warn' | 'info' | 'idle'

export interface StatusChip {
  /** Which of the three slots. Stable, so CSS and tests can name one. */
  slot: 'money' | 'ship' | 'terms'
  label: string
  tone: StatusTone
  /** The longer answer, for the tooltip. Never repeats the label. */
  title: string
}

/** Everything the three reads below need. A structural type, so a list row, a
 *  detail and a plain test object all satisfy it. */
export interface OrderStatusFacts {
  status: InvoiceStatus
  paidAt: string | null
  qboPaidAt?: string | null
  qboVoided?: boolean | null
  paymentTiming: PaymentTiming | null
  paidUpFront?: boolean | null
  trackingNumber: string | null
  trackingStatus?: ShipStatusCode | null
  /** Parcels on this order carrying a tracking number. See shipState. */
  trackedParcels?: number | null
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Paid or not, and it is the FACT rather than the column.
 *
 * `isInvoicePaid` is the one rule — QuickBooks wins where it speaks, a voided
 * copy over there un-pays it whatever this floor ticked, and a tick here answers
 * the rest of the time. This adds no judgement of its own; it only puts words
 * and a colour on that answer.
 *
 * A VOID ORDER IS NEITHER. Saying "Unpaid" on a cancelled sale invites somebody
 * to go and chase money for boxes that went back on the shelf.
 */
export function moneyChip(facts: OrderStatusFacts): StatusChip {
  if (facts.status === 'void') {
    return { slot: 'money', label: 'Void', tone: 'idle', title: 'This order was cancelled.' }
  }
  if (isInvoicePaid(facts)) {
    return {
      slot: 'money',
      label: 'Paid',
      tone: 'good',
      title: facts.qboPaidAt
        ? 'QuickBooks has a payment against this invoice.'
        : 'Somebody recorded the money as arrived.'
    }
  }
  return {
    slot: 'money',
    label: 'Unpaid',
    tone: 'bad',
    title:
      facts.paymentTiming === 'front'
        ? 'Nothing recorded. This buyer pays up front, so it cannot go on the packing list yet.'
        : 'Nothing recorded against this order yet.'
  }
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

/**
 * Has it gone?
 *
 * A TRACKING NUMBER IS THE EVENT. Nothing in this app stamps "shipped" — the
 * moment a parcel becomes real is the moment somebody has a number for it, and
 * inventing a second flag beside that would be a fact that could disagree with
 * the one the carrier answers about.
 *
 * BOTH PLACES A NUMBER CAN LIVE. The header carries one, and `order_shipments`
 * carries a row per parcel — a four-box order split across two labels has two
 * parcels and may have nothing on the header at all. Reading only the header
 * would report a fully-shipped order as not shipped, which is the exact failure
 * this chip exists to prevent.
 *
 * The label UPGRADES to the carrier's own word once there is one, because
 * "Delivered" is a strictly better answer than "Shipped" and somebody looking at
 * this column wants the furthest-along truth available.
 */
export function shipChip(facts: OrderStatusFacts): StatusChip {
  const hasNumber = !!(facts.trackingNumber ?? '').trim() || (facts.trackedParcels ?? 0) > 0
  if (!hasNumber) {
    return {
      slot: 'ship',
      label: 'Not shipped',
      tone: 'idle',
      title: 'No tracking number on this order or on any of its parcels.'
    }
  }
  const status = facts.trackingStatus ?? null
  // `not_shipped` from a carrier means "we have the label and not the box",
  // which is genuinely not shipped — so it keeps that word rather than being
  // overridden to Shipped by the mere existence of a number.
  if (status && status !== 'not_shipped') {
    return {
      slot: 'ship',
      label: TRACKING_LABELS[status],
      tone: status === 'delivered' ? 'good' : status === 'exception' || status === 'returned' ? 'bad' : 'info',
      title: 'What the carrier last said about this parcel.'
    }
  }
  if (status === 'not_shipped') {
    return {
      slot: 'ship',
      label: 'Label made',
      tone: 'warn',
      title: 'A label exists but the carrier has not taken the parcel yet.'
    }
  }
  return {
    slot: 'ship',
    label: 'Shipped',
    tone: 'info',
    title: 'There is a tracking number. The carrier has not been asked yet.'
  }
}

/** The yes/no behind the chip, for a filter. One rule, read twice. */
export function isShipped(facts: OrderStatusFacts): boolean {
  const hasNumber = !!(facts.trackingNumber ?? '').trim() || (facts.trackedParcels ?? 0) > 0
  if (!hasNumber) return false
  return facts.trackingStatus !== 'not_shipped'
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/**
 * When the money is meant to change hands.
 *
 * NOT SAID IS A REAL THIRD ANSWER and is drawn as one. Plenty of orders are
 * written before anybody has decided, and both of the other two chips would be a
 * claim nobody made — see PaymentTiming, which keeps null distinct for exactly
 * this reason. It is drawn in the idle grey rather than left blank, so a card
 * with no terms is visibly a card with no terms rather than a card with a
 * missing chip.
 *
 * PAID UP FRONT IS ITS OWN SENTENCE. An order whose money genuinely arrived
 * before anything shipped says so, because that is a stronger fact than the
 * intention — the intention is what was agreed, and this is what happened.
 */
export function termsChip(facts: OrderStatusFacts): StatusChip {
  if (facts.paymentTiming === 'delivery') {
    return {
      slot: 'terms',
      label: 'On delivery',
      tone: 'info',
      title: 'The buyer pays when it lands, so it can be packed and sent unpaid.'
    }
  }
  if (facts.paymentTiming === 'front') {
    return {
      slot: 'terms',
      label: facts.paidUpFront ? 'Paid up front' : 'Pay up front',
      tone: facts.paidUpFront ? 'good' : 'warn',
      title: facts.paidUpFront
        ? 'The money arrived before anything shipped.'
        : 'Nothing ships until the money is in, unless somebody sends it anyway.'
    }
  }
  return {
    slot: 'terms',
    label: 'Terms not set',
    tone: 'idle',
    title: 'Nobody has said whether this buyer pays up front or on delivery.'
  }
}

/**
 * The three, in the order they are read.
 *
 * Money first because it is the question asked most; shipping second because it
 * is the other half of "where is this order"; terms last because it EXPLAINS the
 * first two rather than being scanned on its own.
 */
export function orderStatusChips(facts: OrderStatusFacts): StatusChip[] {
  return [moneyChip(facts), shipChip(facts), termsChip(facts)]
}

// ---------------------------------------------------------------------------
// Narrowing a board down to one of them
// ---------------------------------------------------------------------------

/**
 * The filters, as a list rather than as five booleans on a component.
 *
 * Declared here so the chips a screen draws and the predicates it applies come
 * from one place. A filter row hand-written beside a predicate written somewhere
 * else is how a board comes to offer "Unpaid" and show a paid order.
 *
 * `readyToPack` is the one the owner asked for by name and the one that had no
 * home: "be able to see what is ready to be packed / what has been paid so that
 * the label can be sent to the dropship source". Ticked beside Paid and Dropship
 * it is exactly that list.
 */
export type OrderFilterId = 'unpaid' | 'paid' | 'unshipped' | 'upfront' | 'dropship' | 'readyToPack'

export interface OrderFilterDef {
  id: OrderFilterId
  label: string
  hint: string
}

export const ORDER_FILTERS: OrderFilterDef[] = [
  { id: 'paid', label: 'Paid', hint: 'The money has arrived' },
  { id: 'unpaid', label: 'Unpaid', hint: 'Nothing recorded against it yet' },
  { id: 'unshipped', label: 'Not shipped', hint: 'No tracking number on it or on any parcel' },
  { id: 'upfront', label: 'Pays up front', hint: 'The buyer pays before it ships' },
  { id: 'dropship', label: 'Dropship', hint: 'A supplier ships some or all of it direct' },
  {
    id: 'readyToPack',
    label: 'Ready to pack',
    hint: 'Cleared every gate — in hand, measured, and payment says it may go'
  }
]

/** What a row must carry to be filtered. The status facts, plus two flags. */
export interface OrderFilterFacts extends OrderStatusFacts {
  /** Units a supplier ships direct. > 0 makes it a dropship. */
  dropshipUnits: number
  /** Set when this sale was raised from a purchase order. See salesOrderKindOf. */
  sourcePoId?: string | null
  /** Has it cleared every fulfilment gate? Supplied by the caller, which has
   *  the whole FulfillmentFacts; this module does not re-derive it. */
  readyToPack: boolean
}

/**
 * Does this order survive the ticked filters?
 *
 * AND, not OR, and that is the whole reason this is worth having: the useful
 * question is never "unpaid" on its own, it is "unpaid AND not shipped" — the
 * orders where nothing has happened — or "paid AND ready to pack", which is the
 * list of labels to go and buy. OR would return everything and answer nothing.
 *
 * NOTHING TICKED SHOWS EVERYTHING, rather than nothing. An empty filter set is
 * somebody who has not asked a question yet, and a board that empties itself
 * until you tick something reads as broken.
 *
 * Paid and Unpaid ticked TOGETHER is a contradiction and empties the board on
 * purpose. Silently treating it as "either" would be a third meaning for AND
 * that only applies to one pair, and the empty board is instantly legible as
 * "you asked for both".
 */
export function passesOrderFilters(
  facts: OrderFilterFacts,
  active: ReadonlySet<OrderFilterId>
): boolean {
  if (active.size === 0) return true
  if (active.has('paid') && !isInvoicePaid(facts)) return false
  if (active.has('unpaid') && isInvoicePaid(facts)) return false
  if (active.has('unshipped') && isShipped(facts)) return false
  if (active.has('upfront') && facts.paymentTiming !== 'front') return false
  if (active.has('dropship') && !isDropship(facts)) return false
  if (active.has('readyToPack') && !facts.readyToPack) return false
  return true
}

/**
 * Is a supplier shipping any of this?
 *
 * The same two-part test `salesOrderKindOf` makes: units routed off our shelves,
 * OR a link back to the purchase that supplies it. The second half matters
 * because a sale raised from a dropship purchase is a dropship from the moment
 * it exists, before anybody has typed a line on it.
 */
export function isDropship(facts: { dropshipUnits: number; sourcePoId?: string | null }): boolean {
  return (Number(facts.dropshipUnits) || 0) > 0 || !!facts.sourcePoId
}
