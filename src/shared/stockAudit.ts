/**
 * IS THE INVENTORY TIED TO WHAT WAS ACTUALLY SOLD AND BOUGHT?
 *
 * This exists because of a real failure that went unnoticed for weeks. Orders
 * 2366 and 2367 were marked sold before their goods landed. `applyInvoiceStock`
 * clamps a line to what the shelf can give and skips it at zero, so those orders
 * wrote NO stock move at all — and inventory, the wholesale history and the P&L
 * all read from `invoice_stock_moves`. The orders were simply absent from three
 * screens at once, and nothing anywhere said so. They were found because the
 * owner happened to notice the money was short.
 *
 * `rebookInvoiceStock` repairs one of those orders and sits on every card. What
 * was missing was the question it answers: WHICH ONES. Nobody is going to open
 * four hundred orders to check, so the repair was only ever reachable by luck.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a READ. Nothing here writes, moves, or corrects anything — it names what
 * disagrees and leaves the fixing to the person and the buttons that already
 * exist. An audit that quietly repaired things would be indistinguishable from
 * the bug it is looking for: both change the books while nobody is watching.
 *
 * It is NOT a warning system for ordinary business. A dropship books no stock
 * and that is correct; an order still in draft has bought nothing yet. Every
 * check below is written to be silent on the normal case, because a report that
 * cries wolf gets ignored, and the one time it is right is the time it is
 * ignored too.
 *
 * ## The five things that can come untied
 *
 *   SOLD, NOTHING BOOKED     The 2366 case. The order says it sold units off a
 *                            shelf and the shelf has no record of it. Missing
 *                            from inventory, history and the P&L together.
 *
 *   SOLD, PART BOOKED        The same fault, halfway: the shelf had four of the
 *                            six. Worse than none in one way — the order looks
 *                            present on every screen, just short.
 *
 *   SHELF DISAGREES WITH ITS COST LAYERS
 *                            The count and the money describing the same units
 *                            have drifted apart. `assertStockLotsConsistent`
 *                            already throws on this inside a transaction; here
 *                            it is reported instead, because a fault that only
 *                            surfaces as a crash mid-save is one nobody can go
 *                            looking for.
 *
 *   SHELF BELOW ZERO         Negative stock is never a fact about a building.
 *
 *   RECEIVED BUT UNCOSTED    Units checked in against a purchase order that
 *                            opened no cost layer. They are on the shelf and
 *                            they cost nothing, so everything they sell into
 *                            reports pure profit.
 *
 * ## The order they are reported in
 *
 * By units at stake, biggest first, and NOT by category. A hundred units missing
 * from the P&L matters more than a rounding drift on one shelf, and grouping by
 * type would bury it under whichever category happened to sort first.
 */

/** What kind of disagreement this is. */
export type StockFindingKind =
  | 'sold-not-booked'
  | 'sold-part-booked'
  | 'shelf-vs-layers'
  | 'negative-shelf'
  | 'received-uncosted'

export interface StockFinding {
  kind: StockFindingKind
  /** The order or the product this is about, named as a person would name it. */
  subject: string
  /** The sales order id, when there is one — so a screen can open it. */
  invoiceId: string | null
  /** The product id, when the finding is about one shelf. */
  productId: string | null
  location: string | null
  /** How many units are at stake. Drives the ordering. */
  units: number
  /** What is wrong, in one sentence, for somebody who did not write this. */
  sentence: string
  /** What to do about it. Empty when there is nothing a person can press. */
  remedy: string
}

export interface StockAudit {
  findings: StockFinding[]
  /** How many orders were examined, so a clean result is believable. */
  ordersChecked: number
  shelvesChecked: number
  /** When it ran. */
  checkedAt: string
}

/**
 * Fractional quantities are legal here — a giveaway product sits at 9.75 boxes
 * — and two float sums of the same pieces can differ in the last bit. Anything a
 * real mismatch could be is orders of magnitude above this.
 */
export const AUDIT_EPS = 0.0005

const units = (n: number): string => {
  const r = Math.round(n * 1000) / 1000
  return `${r} unit${r === 1 ? '' : 's'}`
}

/** Biggest problem first. See the note above on why not by category. */
export function rankFindings(findings: readonly StockFinding[]): StockFinding[] {
  return [...findings].sort((a, b) => b.units - a.units || a.subject.localeCompare(b.subject))
}

/**
 * One line for the top of the panel.
 *
 * SAYS "NOTHING IS UNTIED" RATHER THAN "0 PROBLEMS". The whole reason somebody
 * opens this is to stop worrying, and a zero next to a word like "errors" reads
 * as a thing that failed to load.
 */
export function summariseStockAudit(audit: StockAudit): string {
  const n = audit.findings.length
  if (n === 0) {
    // ONLY COUNT WHAT WAS ACTUALLY THERE. Running this on a quiet company
    // printed "Everything ties out. 0 orders and 36 shelf lines checked", which
    // claims the orders were verified when there were none to verify — an
    // all-clear nobody earned, and the exact shape of reassurance that stops
    // being worth anything. Found by running it rather than by reading it.
    const parts: string[] = []
    if (audit.ordersChecked > 0) {
      parts.push(`${audit.ordersChecked} order${audit.ordersChecked === 1 ? '' : 's'}`)
    }
    if (audit.shelvesChecked > 0) {
      parts.push(`${audit.shelvesChecked} shelf line${audit.shelvesChecked === 1 ? '' : 's'}`)
    }
    if (parts.length === 0) {
      return 'There is nothing to check yet — no orders and no stock on any shelf.'
    }
    return (
      `Everything ties out. ${parts.join(' and ')} checked — ` +
      (audit.ordersChecked > 0
        ? 'every order that should have taken stock did, and every shelf agrees with what it cost.'
        : 'every shelf agrees with what it cost.')
    )
  }
  const missing = audit.findings.filter(
    (f) => f.kind === 'sold-not-booked' || f.kind === 'sold-part-booked'
  )
  const lead =
    missing.length > 0
      ? `${missing.length} order${missing.length === 1 ? '' : 's'} sold stock the shelf has no record of` +
        ` — those are missing from inventory, from the wholesale history AND from the P&L.`
      : 'The orders all tie out, but the shelves do not.'
  return `${n} thing${n === 1 ? '' : 's'} to look at. ${lead}`
}

/** Everything below this line builds the sentences the panel prints. */
export function describeShortBooking(
  order: string,
  expected: number,
  booked: number
): { sentence: string; remedy: string } {
  if (booked <= AUDIT_EPS) {
    return {
      sentence:
        `${order} sold ${units(expected)} off the shelf and the shelf has no record of any of it. ` +
        'That normally means it was sold before the goods arrived: nothing re-ran when they landed, ' +
        'so this order is missing from inventory, from the wholesale history and from the P&L.',
      remedy: 'Open the order and press “Take the stock” to book it against the shelf as it stands today.'
    }
  }
  return {
    sentence:
      `${order} sold ${units(expected)} but only ${units(booked)} came off the shelf — ` +
      `${units(expected - booked)} were never taken. The order looks present everywhere; it is just short.`,
    remedy: 'Open the order and press “Take the stock” to book the rest against the shelf.'
  }
}
