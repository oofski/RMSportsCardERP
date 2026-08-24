/**
 * WHERE THESE CASES CAME FROM, AND WHAT IS STILL COMING.
 *
 * ## The question this answers
 *
 * "I have four cases of 2026 Topps on the shelf. Where did they come from, what
 * did each one cost, and is there another purchase order about to bring more?"
 *
 * Every part of that answer was already in the database and none of it was on a
 * screen. The catalog said how many; the cost-lot picker said what each layer
 * cost; the purchase-order board said what had been ordered. Nobody could get
 * from a case in their hand to the document that bought it without opening three
 * screens and matching dates by eye.
 *
 * ## Two halves, and they are genuinely different questions
 *
 * ON HAND is history: stock that is here, and the paperwork it arrived on. It is
 * settled — a receipt happened, at a price, on a date, from a supplier.
 *
 * ON ORDER is a forecast: purchase orders with units still outstanding. Nothing
 * about it is settled. It is deliberately NOT folded into a single "you will
 * have 6" number, because an ordered case and a case on the shelf are not the
 * same thing and a screen that adds them together is how a break gets scheduled
 * against stock that has not shipped.
 *
 * ## A layer with no purchase order behind it is normal
 *
 * Opening balances, count-sheet corrections and found stock all open real cost
 * layers and none of them has a document. They are shown as what they are rather
 * than hidden — a case is a case, and "we do not know where this one came from"
 * is the single most useful thing this screen can tell somebody.
 */

import type { PurchaseOrderStatus } from './types'

/**
 * One cost layer still on the shelf, with the paperwork it arrived on.
 *
 * A "layer" is not a case: it is however many units came in on ONE receipt at
 * ONE price. A PO received in two partial commits at two prices makes two
 * layers, which is exactly the thing this screen exists to show.
 */
export interface StockSource {
  lotId: string
  /** The shelf these units are on. */
  location: string
  /** Units of this layer still on hand — never the number originally received. */
  qtyRemaining: number
  /** Per stock unit. What this particular receipt cost, not the average. */
  unitCost: number
  /** ISO instant the receipt happened. */
  receivedAt: string
  /** Who it was bought from, when the receipt knew. Never guessed. */
  vendor: string | null
  /** restock | opening | adjustment | backfill — how the layer came to exist. */
  source: string
  note: string | null
  /**
   * The purchase order this layer came in on.
   *
   * NULL is a real and common answer — see the note at the top of this file.
   * `poId` is what makes the row clickable; `poNumber` is what it says.
   */
  poId: string | null
  poNumber: string | null
}

/** A purchase order with units of this product still to arrive. */
export interface IncomingSource {
  poId: string
  poNumber: string
  supplier: string | null
  status: PurchaseOrderStatus
  /** Where the outstanding units are headed, when the order says. */
  destination: string | null
  /** Units on the order. */
  ordered: number
  /** Units already received against it. */
  received: number
  /** ordered − received, floored at zero. What is still coming. */
  outstanding: number
  /** Per stock unit, as ordered. */
  unitPrice: number
  /** ISO instant the order was raised — the ordering key. */
  orderedAt: string
  /** True once the money has gone out, which is the useful "is this real" flag. */
  paid: boolean
}

export interface StockProvenance {
  productId: string
  onHand: StockSource[]
  incoming: IncomingSource[]
}

/** Units on the shelf, summed off the layers rather than read off the product. */
export function onHandUnits(p: { onHand: StockSource[] }): number {
  let n = 0
  for (const s of p.onHand) n += s.qtyRemaining
  return round4(n)
}

/** Units still to arrive, across every open purchase order. */
export function incomingUnits(p: { incoming: IncomingSource[] }): number {
  let n = 0
  for (const i of p.incoming) n += i.outstanding
  return round4(n)
}

/**
 * What the stock on hand cost, off the layers.
 *
 * Never quantity × average: the average is a derived reference figure and the
 * layers are the truth. A shelf holding one case at $1,400 and one at $1,600 is
 * worth $3,000, and reporting 2 × the $1,500 average happens to agree here and
 * stops agreeing the moment one of them is broken.
 */
export function onHandCost(p: { onHand: StockSource[] }): number {
  let total = 0
  for (const s of p.onHand) total += s.qtyRemaining * s.unitCost
  return Math.round(total * 100) / 100
}

/** What the outstanding units will cost at the prices already agreed. */
export function incomingCost(p: { incoming: IncomingSource[] }): number {
  let total = 0
  for (const i of p.incoming) total += i.outstanding * i.unitPrice
  return Math.round(total * 100) / 100
}

/**
 * What a layer is CALLED when there is no purchase order behind it.
 *
 * The vendor first, because that is what somebody holding the case wants to
 * know. Then whatever the receipt wrote down. The source words are last and are
 * deliberately plain: "Opening stock" and "Stock correction" are different
 * events and an operator has to be able to tell which one they are looking at.
 *
 * Mirrors `lotLabel` in @shared/costLots on purpose — the picker and this screen
 * describe the same layers, and two vocabularies for one thing is how somebody
 * ends up believing they are two different cases.
 */
export function sourceLabel(s: StockSource): string {
  const po = (s.poNumber ?? '').trim()
  if (po) return po
  const vendor = (s.vendor ?? '').trim()
  if (vendor) return vendor
  const note = (s.note ?? '').trim()
  if (note) return note
  switch (s.source) {
    case 'opening':
      return 'Opening stock'
    case 'adjustment':
      return 'Stock correction'
    case 'backfill':
      return 'Opening balance'
    default:
      return 'No paperwork recorded'
  }
}

/**
 * Is this a layer nobody can account for?
 *
 * Not an error — see the file note — but the one thing on this screen worth
 * marking, because it is the answer to "why does the count not match the
 * orders". A layer with a vendor but no PO is accounted for: somebody typed
 * where it came from.
 */
export function unaccounted(s: StockSource): boolean {
  return !s.poId && !(s.vendor ?? '').trim()
}

/**
 * The layers, grouped by the purchase order that brought them.
 *
 * A PO received in two partial commits is TWO layers and ONE delivery, and the
 * question "where did these come from" is asked about the delivery. Layers with
 * no PO each stand alone rather than being heaped into one "unknown" pile: two
 * count-sheet corrections a month apart are two separate events and merging them
 * would invent a receipt that never happened.
 */
export interface SourceGroup {
  key: string
  poId: string | null
  poNumber: string | null
  label: string
  vendor: string | null
  layers: StockSource[]
  qty: number
  cost: number
  /** The EARLIEST receipt in the group — when this delivery started arriving. */
  receivedAt: string
}

export function groupSources(sources: StockSource[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()
  for (const s of sources) {
    const key = s.poId ? `po:${s.poId}` : `lot:${s.lotId}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        poId: s.poId,
        poNumber: s.poNumber,
        label: sourceLabel(s),
        vendor: s.vendor,
        layers: [],
        qty: 0,
        cost: 0,
        receivedAt: s.receivedAt
      }
      groups.set(key, group)
    }
    group.layers.push(s)
    group.qty = round4(group.qty + s.qtyRemaining)
    group.cost = Math.round((group.cost + s.qtyRemaining * s.unitCost) * 100) / 100
    if (s.receivedAt < group.receivedAt) group.receivedAt = s.receivedAt
    // A group's vendor is whichever layer in it knew one; partial receipts
    // routinely leave the second commit without the supplier the first had.
    if (!group.vendor && s.vendor) group.vendor = s.vendor
  }
  // OLDEST FIRST, which is the order they will be consumed in. A picker looking
  // at this list is deciding which case to open, and FIFO is the answer.
  return [...groups.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}

/** Four places, matching the quantity precision the store keeps. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
