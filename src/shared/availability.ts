import { BUILTIN_LOCATION_IDS } from './inventory'

/**
 * HOW MANY OF THIS PRODUCT WE HAVE, AND WHERE — including the shops.
 *
 * The owner's words, and the case he led the whole roadshow change with:
 *
 *   "Say I have 4 of product A in total in RM but I need 7. How this logically
 *    should work is that I can say I want 7 — now I can add 3 of product A to
 *    roadshow and basically pull from there. Roadshow is inventory that I don't
 *    have but it is mine and I can pull from it. So the biggest thing is that
 *    when putting quantities of things I need the RM inventory + roadshow open
 *    tabs."
 *
 * ## The sales-order line editor showed NOTHING at all
 *
 * Not a number, not a warning, not a hint. Somebody typing 7 had no way to know
 * whether 7 existed, where they were, or that 3 of them were sitting in a shop
 * in Wichita — so the answer was found out later, by the shelf coming up short
 * and the order sitting in Awaiting items. This is that answer, at the moment
 * the quantity is typed.
 *
 * ## HERE AND AWAY, because they are not the same offer
 *
 * A case at RM can go in a box this afternoon. A case at a roadshow shop is
 * just as much ours and just as sellable, but somebody has to get it — so a
 * screen that added the two into one number would be answering a question
 * nobody asked. They are added, and they are also broken out, and the breakdown
 * is what somebody acts on.
 *
 * ## It is a HINT, not a gate
 *
 * Nothing here refuses anything. Selling more than is on hand is ordinary trade
 * — the case is on its way, the shop is holding one, the count is a day out of
 * date — and an app that refused it would be an app people work around by
 * typing the quantity somewhere else. `applyInvoiceStock` already draws what it
 * can and leaves the rest owed, which is the honest behaviour; this just stops
 * the shortfall being a surprise.
 */

/** What one place is holding. */
export interface StockAtPlace {
  location: string
  quantity: number
  /**
   * True when this is one of our own shelves — RM or AM.
   *
   * Derived from the BUILT-IN list rather than from the name, because "is this
   * our building" is a fact about the two original shelves and not something a
   * string can be asked. A place added later — a shop, a storage unit — is
   * away, which is the safe reading: the only cost of being wrong is telling
   * somebody to go and fetch something that was already here.
   */
  here: boolean
}

export interface ProductAvailability {
  productId: string
  places: StockAtPlace[]
}

/** Is this one of the two home shelves? */
export function isHomeShelf(location: string): boolean {
  const v = String(location ?? '').trim().toLowerCase()
  return BUILTIN_LOCATION_IDS.some((b) => b.toLowerCase() === v)
}

/** Everything on our own shelves. */
export function unitsHere(a: ProductAvailability | null | undefined): number {
  return (a?.places ?? []).reduce((n, p) => n + (p.here ? p.quantity : 0), 0)
}

/** Everything at a shop — ours, and not in this building. */
export function unitsAway(a: ProductAvailability | null | undefined): number {
  return (a?.places ?? []).reduce((n, p) => n + (p.here ? 0 : p.quantity), 0)
}

/** Everything we own of it, wherever it is standing. */
export function unitsOwned(a: ProductAvailability | null | undefined): number {
  return unitsHere(a) + unitsAway(a)
}

/**
 * The places worth naming on a line, most first.
 *
 * HOME SHELVES LEAD, then the biggest holding. Somebody reading this is
 * deciding where the boxes come from, and the answer is nearly always "the
 * shelf downstairs" — putting a shop first because it happens to hold more
 * would bury the ordinary case under the exception.
 *
 * Empty places are dropped: "0 at AM" is a row that costs a glance and answers
 * nothing.
 */
export function placesWorthNaming(a: ProductAvailability | null | undefined): StockAtPlace[] {
  return [...(a?.places ?? [])]
    .filter((p) => p.quantity > 0)
    .sort((x, y) => {
      if (x.here !== y.here) return x.here ? -1 : 1
      if (y.quantity !== x.quantity) return y.quantity - x.quantity
      return x.location.localeCompare(y.location)
    })
}

/**
 * What to tell somebody who has typed a quantity — null when there is nothing
 * worth saying.
 *
 * THREE ANSWERS, and the third is the one this was built for:
 *
 *   null            enough on our own shelves. The ordinary case, and it says
 *                   nothing at all rather than congratulating anybody.
 *   'away'          not enough here, but enough once the shops are counted.
 *                   This is "I have 4 in RM and I need 7" — the answer is yes,
 *                   and it names where the other three are.
 *   'short'         not enough anywhere. The order can still be written; the
 *                   shelf will draw what it can and the rest stays owed.
 */
export function availabilityNote(
  a: ProductAvailability | null | undefined,
  wanted: number
): { kind: 'away' | 'short'; here: number; away: number; short: number } | null {
  const want = Number(wanted) || 0
  if (want <= 0) return null
  /**
   * NOTHING KNOWN IS NOT THE SAME AS NONE.
   *
   * A null availability means nobody has looked — a hand-typed line with no
   * catalog product, or a read that failed — and reporting "5 short" from that
   * would be the screen stating as fact something it never checked. The same
   * distinction `qboTotalState` draws between a disagreement and an absence of
   * evidence, and for the same reason: one confidently wrong warning teaches
   * somebody to ignore the true one.
   */
  if (!a) return null
  const here = unitsHere(a)
  if (here >= want) return null
  const away = unitsAway(a)
  const short = Math.max(0, want - here - away)
  return { kind: short > 0 ? 'short' : 'away', here, away, short }
}

/**
 * One product standing at one place. See `stockAtLocation`.
 *
 * The mirror of `StockAtPlace`, which is one place on one product. Both are
 * needed because the two screens ask opposite questions: a sales-order line asks
 * "where is THIS product", and a shop board asks "what is at THIS shop".
 *
 * No cost figure on purpose. The board this feeds answers "what have I got in
 * Kentucky" — a picking question, asked by somebody deciding whether they can
 * fill an order — and a valuation column beside it would invite reading the
 * shop's worth off a screen that is not reconciled to the ledger. What the week
 * cost is on the tab, where the money already lives.
 */
export interface StockAtLocationRow {
  productId: string
  name: string
  sku: string | null
  category: string | null
  quantity: number
}

/**
 * ONE ACT OF BUYING, behind a product standing at a shop. See `shopBuys`.
 *
 * A receipt, not a purchase order: a tab takes a case on Tuesday and two more
 * on Thursday, and those are two separate acts of buying against one bill.
 * Collapsing them onto the order would hide the dates, which are the thing
 * worth showing.
 */
/**
 * ONE PRODUCT'S WHOLE STORY AT ONE SHOP — bought, still here, gone out.
 *
 * The owner: "anything that is sold from the roadshow shops should still show up
 * on the list, and when I click on the roadshow shop it shows me what is sold
 * and what is what's stuck. That is a big thing."
 *
 * ## Why the column could not say it before
 *
 * It listed `stockAtLocation`, which is what is STANDING there. That is the
 * right answer to "what can I sell", and the wrong one to "what did this week
 * do" — a case bought and sold on the same afternoon never appeared at all, so a
 * shop that had traded all day could read as empty. Settling up with a shop is
 * the other question, and it was the one with no screen.
 *
 * ## Three numbers, from three different places, none of them derived
 *
 * `bought` is the RECEIPTS, read off po_line_receipts.location — the shelf a
 * case landed on, which does not change when the layer is later moved. `here` is
 * the live shelf. `sold` is what actually left on invoices, off
 * invoice_stock_moves.location.
 *
 * Counting `sold` rather than inferring it from bought − here is the whole point
 * of doing it this way. Stock leaves a shelf three ways — sold, driven home,
 * adjusted away — and the subtraction cannot tell them apart. Reporting a case
 * that was carried back to RM as "sold" would be a sentence about money that
 * nobody received, on the screen somebody uses to settle a bill.
 */
export interface ShopShelfRow {
  productId: string
  name: string
  sku: string | null
  category: string | null
  /** Units this shop has ever handed over, off its receipts. */
  bought: number
  /** Units standing there right now. What a sales order can draw. */
  here: number
  /** Units that left on a sale from this shop. Never inferred — counted. */
  sold: number
  /**
   * Bought, minus what is here, minus what was sold: units that left some other
   * way — driven home, or adjusted off. Zero on almost every row, and the reason
   * `sold` is not a subtraction.
   */
  movedOn: number
  /**
   * UNITS STILL STANDING HERE whose cost nobody has entered yet.
   *
   * The warning on the column is derived from this and nothing else. A line that
   * has already SOLD is not something the board can usefully shout about — the
   * money is spent, the sale is booked, and the place that reports it is the
   * Wholesale tab, which holds those rows out of its margin totals and names the
   * tab to price. What a shop board can prevent is the NEXT wrong sale, and that
   * is only ever about stock that is still there.
   */
  unpricedHere: number
}

/**
 * A SALE THAT TOOK THIS PRODUCT OFF THIS SHOP'S SHELF.
 *
 * The owner: "let me click on it if it was sold and then it tells me which PO
 * and SO it was attached to."
 *
 * The panel could already say which purchase order a case came IN on, and had
 * nothing at all about where it went. Both halves matter at a roadshow, because
 * the case that arrives and leaves in an afternoon is the ordinary one and the
 * only trace of it was two documents nobody had a reason to open.
 */
export interface ShopSale {
  invoiceId: string
  /** The sales order's number. Blank on a draft that has not been numbered. */
  invoiceNumber: string
  customerName: string
  /** The day it was billed. */
  soldOn: string
  /** How many this sale took from THIS shop. */
  quantity: number
  status: string
}

export interface ShopBuy {
  id: string
  poId: string
  /**
   * The tab LINE this receipt came in on, so the row can be undone.
   *
   * The receipt is what arrived; the line is what was bought, and removing
   * something added by mistake means removing the line — see removeTabLine,
   * which reverses the receipt as part of it.
   */
  poLineId: string
  poNumber: string
  supplier: string | null
  /** When it was taken in. */
  boughtAt: string
  /** How many arrived on this receipt. */
  quantity: number
  /** How many of them are still standing there. */
  remaining: number
  /** What one cost, or NULL while nobody has said — never zero for unknown. */
  unitCost: number | null
  /** Has the bill been paid? */
  settled: boolean
  /** Is its tab still taking things this week? */
  tabOpen: boolean
}
