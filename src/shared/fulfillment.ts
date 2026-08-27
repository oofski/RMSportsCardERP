/**
 * Getting a sold order out of the building.
 *
 * ## Why this is a second axis and not four more columns on the Sales Orders board
 *
 * A sales order's `status` says where the DOCUMENT is — draft, posted to
 * QuickBooks, sent, paid. That is a different question from where the GOODS are,
 * and the two move independently: an order can be paid and have nothing in hand,
 * or be sitting on the bench boxed and labelled while the buyer has not paid a
 * penny because they are on delivery terms. `awaitingShipment` in @shared/invoices
 * has said as much since readiness was first modelled — it is a timestamp rather
 * than a stage precisely because it does not fit the same row.
 *
 * So this is its own board. A card cannot be in two columns of one row, and
 * forcing fulfilment into the document pipeline would make somebody choose which
 * of two true things to display.
 *
 * ## The pipeline
 *
 *   Awaiting items → Awaiting dims → Ready to ship
 *
 * and an order only ENTERS it once payment says it may. The three gates are
 * asked in that order because each is meaningless before the one above it:
 * there is nothing to measure until the case is in the building, and no label to
 * buy until it has been measured.
 */

import type { PaymentTiming } from './freight'
import type { InvoiceStatus } from './invoices'
import { isInvoicePaid } from './invoices'

export type FulfillmentStage = 'awaiting_items' | 'awaiting_dims' | 'ready'

/** The board's columns, left to right — the order the work moves in. */
export const FULFILLMENT_STAGES: Array<{
  id: FulfillmentStage
  label: string
  hint: string
  icon: string
  tone: string
}> = [
  {
    id: 'awaiting_items',
    label: 'Awaiting items',
    hint: 'Sold, but the goods are not in hand yet',
    icon: 'Truck',
    tone: 'ordered'
  },
  {
    id: 'awaiting_dims',
    label: 'Awaiting dims',
    hint: 'In hand — needs weighing and measuring before a label can be bought',
    icon: 'Ruler',
    tone: 'paid'
  },
  {
    id: 'ready',
    label: 'Ready to ship',
    hint: 'Measured and cleared — buy the label and send it',
    icon: 'PackageCheck',
    tone: 'received'
  }
]

/**
 * The board's COLUMNS, which are not the same as its stages.
 *
 * Awaiting items and awaiting dims are both "sold, not out of the door yet", and
 * the owner asked for them to share one column and be told apart by colour
 * rather than by position — blue for items, amber for dims — with the card
 * saying on hover which it is waiting on. Two states in one column is right for
 * the same reason they are two states at all: the WORK is different (chase the
 * supplier vs weigh the box) while the SITUATION is identical, and a card
 * crossing a column boundary for a change of situation that has not happened
 * reads as progress that was not made.
 */
export type FulfillmentColumn = 'ordered' | 'ready'

export const FULFILLMENT_COLUMNS: Array<{
  id: FulfillmentColumn
  label: string
  hint: string
  icon: string
}> = [
  {
    id: 'ordered',
    label: 'Ordered',
    hint: 'Sold and cleared to go — waiting on the goods, or on the measurements',
    icon: 'ShoppingCart'
  },
  {
    id: 'ready',
    label: 'Ready to ship',
    hint: 'Buy the label and send it',
    icon: 'PackageCheck'
  }
]

export function fulfillmentColumnOf(stage: FulfillmentStage): FulfillmentColumn {
  return stage === 'ready' ? 'ready' : 'ordered'
}

/**
 * The colourway a stage's chip wears. Blue for items, amber for dims.
 *
 * Named as a slug rather than a colour so the stylesheet owns the actual value
 * — `.fx-chip-items` and `.fx-chip-dims` — and a theme change does not have to
 * find its way back into this file.
 */
export const FULFILLMENT_STAGE_TONE: Record<FulfillmentStage, string> = {
  awaiting_items: 'items',
  awaiting_dims: 'dims',
  ready: 'ready'
}

/**
 * What the check mark on a card does next.
 *
 * ONE CONTROL, whose meaning follows the chip beside it: on a card waiting for
 * goods it confirms they have arrived, and on one waiting for measurements it
 * opens the box for them. Two buttons — one of which is always inert — would be
 * asking the operator to work out which of them applies, which is the question
 * the colour already answers.
 */
export function fulfillmentTickLabel(stage: FulfillmentStage): string {
  if (stage === 'awaiting_items') return 'Goods are in hand'
  if (stage === 'awaiting_dims') return 'Weigh and measure it'
  return 'Ready'
}

/**
 * The same thing in two words, for the button face.
 *
 * A card lives in a column a third of a board wide, and the full sentence above
 * wrapped the button onto three lines. The long form stays as the tooltip, so
 * nothing is lost — it is just not shouted on every card.
 */
export function fulfillmentTickShort(stage: FulfillmentStage): string {
  if (stage === 'awaiting_items') return 'In hand'
  if (stage === 'awaiting_dims') return 'Measure'
  return 'Ready'
}

/**
 * What a carrier needs before it will sell a label.
 *
 * All four or none, as far as this board is concerned. A weight with no
 * dimensions cannot be priced for anything that is charged by dimensional
 * weight, which is every service this business uses for a case, so "we have the
 * weight" is not a partial answer that lets the box move.
 */
export interface ShipDims {
  weightLb: number | null
  lengthIn: number | null
  widthIn: number | null
  heightIn: number | null
}

export function hasDims(dims: ShipDims): boolean {
  const ok = (n: number | null): boolean => typeof n === 'number' && Number.isFinite(n) && n > 0
  return ok(dims.weightLb) && ok(dims.lengthIn) && ok(dims.widthIn) && ok(dims.heightIn)
}

/** "12 × 9 × 4 in · 6.5 lb", or null when nothing has been measured. */
export function describeDims(dims: ShipDims): string | null {
  if (!hasDims(dims)) return null
  const n = (v: number | null): string => String(Math.round((v as number) * 100) / 100)
  return `${n(dims.lengthIn)} × ${n(dims.widthIn)} × ${n(dims.heightIn)} in · ${n(dims.weightLb)} lb`
}

/**
 * Everything the pipeline reads off one order.
 *
 * A structural type rather than the full InvoiceDetail so the rules below can be
 * tested against a plain object, and so a caller cannot accidentally make the
 * answer depend on something that is not in this list.
 */
export interface FulfillmentFacts extends ShipDims {
  status: InvoiceStatus
  paymentTiming: PaymentTiming | null
  /** When somebody said the money arrived. See isInvoicePaid. */
  paidAt?: string | null
  /** When Intuit says a payment was applied. Wins over the tick above. */
  qboPaidAt?: string | null
  qboVoided?: boolean | null
  /** Units on lines fulfilled from one of our own shelves. */
  stockUnits: number
  /** Units shipping direct from a supplier. */
  dropshipUnits: number
  /**
   * Units actually taken off the shelf when this order saved.
   *
   * `applyInvoiceStock` gives what the shelf CAN give — `Math.min(asked, have)`
   * — so a sale for ten boxes against three on hand draws three and leaves seven
   * owed. That difference is the only honest signal this app has that a stock
   * order is not yet fillable, and it is why this is read rather than assumed.
   */
  drawnUnits: number
  /**
   * UNITS DRAWN FROM A PLACE THAT IS NOT THIS BUILDING — a roadshow shop.
   *
   * A third thing, and it had to become one. Until roadshow tabs, every unit on
   * an order was in exactly one of two states and the two answered every
   * question at once:
   *
   *   ours and here      RM or AM. Real stock, real cost, and we pack the box.
   *   theirs and direct  a dropship. No stock, no cost, somebody else ships it.
   *
   * A tab is the case that has never existed: OURS, AND NOT HERE. The goods were
   * bought — they carry real cost layers and are counted in `stockUnits` with
   * everything else on a shelf — but the box is three states away and nobody on
   * this floor will ever weigh it.
   *
   * IT CHANGES NO GATE. `stock_units` counts only RM and AM, so a roadshow
   * order already walks the dropship path — waiting on somebody to confirm the
   * goods are in hand, and on the measurements the label needs. This exists so
   * the CARD CAN SAY where the box is coming from, which is what the owner
   * asked for: "show it, but marked as shipping from the shop." A number rather
   * than a flag, so a mixed order can say how much of it is away.
   */
  remoteUnits?: number
  /** Somebody confirmed the goods are in hand. The only signal a dropship has. */
  itemsInHandAt: string | null
  /** Somebody said send it regardless of the gates below. See forcedReady. */
  forceReadyAt: string | null
}

/**
 * May this order enter the pipeline at all?
 *
 * The owner's rule, in their words: ready to ship "when a sales order is either
 * payment up front and paid, or payment on delivery and paid or unpaid."
 *
 * So an order on DELIVERY terms is admitted the moment it exists — the buyer
 * pays when it lands, and holding the box back until they have would be waiting
 * for something that cannot happen first. An order on UP-FRONT terms waits for
 * the money.
 *
 * An order with NO timing said behaves as up-front. That is the safer reading:
 * the alternative sends goods against a term nobody chose.
 */
export function paymentClearsFulfillment(facts: {
  status: InvoiceStatus
  paymentTiming: PaymentTiming | null
  paidAt?: string | null
  qboPaidAt?: string | null
  qboVoided?: boolean | null
}): boolean {
  if (facts.paymentTiming === 'delivery') return true
  // THE FACT, NOT THE STAGE. Reaching the Payment column means an order is at
  // the settling-up step, which is not the same as the money being in — so this
  // reads what isInvoicePaid reads, and an order dragged into Payment unpaid
  // does not open the packing gate on the strength of where its card sits.
  return isInvoicePaid({
    paidAt: facts.paidAt ?? null,
    qboPaidAt: facts.qboPaidAt ?? null,
    qboVoided: facts.qboVoided ?? null
  })
}

/**
 * MAY THIS ORDER BE CALLED READY TO SHIP AT ALL? Null when it may.
 *
 * The same rule as `paymentClearsFulfillment` and a different job. That one
 * answers a question the packing board asks about itself; this one is a REFUSAL,
 * with the sentence to say, for the two places somebody can put an order on the
 * packing list by hand — dragging its card into Ready to ship on the Sales
 * Orders board, and the release that `setInvoiceReadyToShip` writes.
 *
 * ## Why the gate was missing from exactly those two
 *
 * The fulfilment board DERIVES its columns, so an unpaid up-front order simply
 * never appeared on it: nothing had to refuse, because nothing was ever asked.
 * The Sales Orders board is the opposite — its columns are a stored status
 * somebody drags a card between, and `INVOICE_TRANSITIONS` only knows the SHAPE
 * of the pipeline, not whether the money arrived. So draft → Ready to ship was
 * legal on a buyer who pays up front and has not paid.
 *
 * Worse than the drag: `nextStageFromQbo` moves a card to that same stage the
 * moment QuickBooks reports it emailed the invoice. Emailing an invoice is not
 * being paid for it, so an unpaid up-front order walked itself onto the packing
 * list a quarter of an hour after it was posted, with nobody touching it.
 *
 * ## What it does NOT refuse
 *
 * A FORCED order, which is the whole point of `forceReadyAt` — see forcedReady.
 * A buyer of two years standing whose package is going out today is a real case
 * and it has an answer already; this must not become a second gate that answer
 * cannot open.
 *
 * An order on DELIVERY terms, which is admitted unpaid by design: the buyer pays
 * when it lands, so holding the box back is waiting for something that cannot
 * happen first.
 *
 * AND — the one place this is deliberately NARROWER than
 * `paymentClearsFulfillment` — an order with NO TERMS SAID.
 *
 * That function reads a blank as up-front, which is the right reading for it:
 * the fulfilment board DERIVES its columns, so a blank order simply does not
 * appear there and nobody is stopped from doing anything. This is a REFUSAL on
 * a card somebody is dragging, and neither box on the invoice form is ticked by
 * default. Reading a blank as up-front here would put a wall in front of every
 * order nobody had classified — which is not what was asked for, and is a much
 * bigger change than the one that was. The owner's words were "if something is
 * paid up front that it doesn't get moved to ready to ship unless it has been
 * paid", and Front is a box somebody ticks.
 *
 * So: ticked Front and unpaid is refused, and nothing else is.
 */
export function readyToShipBlockedReason(facts: {
  status: InvoiceStatus
  paymentTiming: PaymentTiming | null
  paidAt?: string | null
  qboPaidAt?: string | null
  qboVoided?: boolean | null
  forceReadyAt?: string | null
}): string | null {
  if (facts.status === 'void') return 'That order was voided, so it cannot be shipped.'
  if (facts.forceReadyAt) return null
  if (facts.paymentTiming !== 'front') return null
  if (
    isInvoicePaid({
      paidAt: facts.paidAt ?? null,
      qboPaidAt: facts.qboPaidAt ?? null,
      qboVoided: facts.qboVoided ?? null
    })
  ) {
    return null
  }
  return (
    'This buyer pays up front and the money has not arrived, so it cannot go on the packing ' +
    'list yet. Record the payment, or use Send anyway if you are shipping it regardless.'
  )
}

/**
 * Are the goods in the building?
 *
 * Two different questions wearing one name, because the answer comes from two
 * different places:
 *
 *   · OUR OWN SHELF answers itself. The stock was drawn when the order saved,
 *     and a shortfall means the shelf could not cover it — see drawnUnits.
 *
 *   · A DROPSHIP CANNOT ANSWER. Nothing in this app knows whether a supplier has
 *     a case in hand, and inventing an answer would send a box to the bench that
 *     nobody can pack. So it waits for somebody to say, which is what
 *     `itemsInHandAt` is.
 *
 * An order with neither — no lines yet — has nothing to wait for.
 */
export function itemsInHand(facts: FulfillmentFacts): boolean {
  const short = Math.max(0, (Number(facts.stockUnits) || 0) - (Number(facts.drawnUnits) || 0))
  if (short > 0) return false
  if ((Number(facts.dropshipUnits) || 0) > 0) return !!facts.itemsInHandAt
  return true
}

/** How many units our own shelf still owes this order. */
export function shelfShortfall(facts: Pick<FulfillmentFacts, 'stockUnits' | 'drawnUnits'>): number {
  return Math.max(0, (Number(facts.stockUnits) || 0) - (Number(facts.drawnUnits) || 0))
}

/**
 * Somebody said send it anyway.
 *
 * The owner's case, and it is a real one: "needed specifically for when a
 * customer has up front payment terms but we are sending the package anyway."
 * A relationship that has run for two years does not stop for a gate.
 *
 * It clears EVERY gate, including the dims one, because the request was to move
 * the order to Ready to ship — not to move it one column. The board still says
 * on the card when a forced order has no measurements, because the label cannot
 * be bought without them and finding that out at the counter is worse than
 * being told here.
 */
export function forcedReady(facts: Pick<FulfillmentFacts, 'forceReadyAt'>): boolean {
  return !!facts.forceReadyAt
}

/**
 * Which column this order sits in, or null when it is not on the board.
 *
 * Null is a real answer and it is the common one: a voided order, and an
 * up-front order nobody has paid for yet, are both simply not the packing
 * floor's problem. See fulfillmentBlockedReason for what to tell somebody
 * looking for one that is missing.
 */
export function fulfillmentStageOf(facts: FulfillmentFacts): FulfillmentStage | null {
  if (facts.status === 'void') return null
  if (forcedReady(facts)) return 'ready'
  if (!paymentClearsFulfillment(facts)) return null
  if (!itemsInHand(facts)) return 'awaiting_items'
  /**
   * MEASUREMENTS ARE STILL OWED, and roadshow orders are no exception.
   *
   * It is tempting to waive them for a box nobody here will weigh. They are not
   * waived, because this app BUYS THE LABEL and sends it to whoever is holding
   * the goods — see the dropship label path, which has worked that way since
   * shipping landed. A shop shipping on our postage needs a label, a label needs
   * a price, and a price needs the dimensions. Waiving them would produce an
   * order that reads ready and cannot actually be sent.
   *
   * So a roadshow order walks the same gates a dropship walks, which is what it
   * already did: `stock_units` counts only RM and AM, so its units are drop
   * units to every one of these tests. What is new is only that the card SAYS
   * where it ships from — see shipsFromAway.
   */
  if (!hasDims(facts)) return 'awaiting_dims'
  return 'ready'
}

/**
 * Does any of this order ship straight from a shop we are not standing in?
 *
 * What the card says out loud. The owner asked for these to stay ON the board
 * rather than vanish the way a dropship does — "show it, but marked as shipping
 * from the shop" — because somebody still has to confirm it went out. So the
 * order keeps its place in the queue and the packer is told not to go looking
 * for a box.
 */
export function shipsFromAway(facts: Pick<FulfillmentFacts, 'remoteUnits'>): boolean {
  return (Number(facts.remoteUnits) || 0) > 0
}

/**
 * Why an order is not on the board, in words.
 *
 * Null when it IS on it. Exists because "my order is not in the list" is the
 * question this feature will generate, and the answer is always one of three
 * things — none of which is visible from the board that does not contain it.
 */
export function fulfillmentBlockedReason(facts: FulfillmentFacts): string | null {
  if (facts.status === 'void') return 'This order was voided.'
  if (fulfillmentStageOf(facts) !== null) return null
  return (
    'The buyer pays up front and has not paid yet. Record the payment, or move it to Ready to ' +
    'ship by hand if you are sending it anyway.'
  )
}

/**
 * What still has to happen before this order can move on, in FEW words.
 *
 * Null on a ready order. Deliberately short: this is printed on a card in a
 * column, and the first draft's full sentences wrapped to three lines and
 * pushed the buttons off the bottom. `fulfillmentBlockedDetail` carries the
 * long form for the tooltip, so the advice is a hover away rather than gone.
 *
 * Written here rather than in the board so the card and any future list say the
 * same thing — the two drifting is how a screen comes to promise a step that is
 * not the one blocking it.
 */
export function fulfillmentNextStep(facts: FulfillmentFacts): string | null {
  const stage = fulfillmentStageOf(facts)
  if (stage === null || stage === 'ready') return null
  if (stage === 'awaiting_items') {
    const short = shelfShortfall(facts)
    if (short > 0) {
      return `${short} short on the shelf`
    }
    return 'Waiting on the supplier'
  }
  return 'Needs weighing and measuring'
}

/** The same answer at length, for a tooltip that has room for it. */
export function fulfillmentNextStepDetail(facts: FulfillmentFacts): string | null {
  const stage = fulfillmentStageOf(facts)
  if (stage === null || stage === 'ready') return null
  if (stage === 'awaiting_items') {
    const short = shelfShortfall(facts)
    if (short > 0) {
      return `${short} unit${short === 1 ? '' : 's'} of this order could not come off the shelf — there was not enough on hand when it saved. Receive the stock, or fill it from somewhere else.`
    }
    return 'Nothing here knows whether the supplier has these in hand, so it waits until somebody says. Tick it once they have confirmed.'
  }
  return 'A carrier prices a case on weight AND dimensions, so all four are needed before a label can be bought.'
}
