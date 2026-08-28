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
export interface ShopBuy {
  id: string
  poId: string
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
