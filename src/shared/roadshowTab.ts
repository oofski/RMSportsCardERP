/**
 * BUYING FROM A ROADSHOW SHOP ALL WEEK AND SETTLING UP ONCE.
 *
 * The owner's words: "the roadshow shops are a little different — we buy things
 * from them throughout the week and then basically like pay once at the end and
 * sometimes we don't know the prices ... a button on a PO that for each of the 4
 * roadshows we can add what we buy from them for a purchase order throughout the
 * week, and then sales orders can be created from that ongoing purchase order,
 * and the deal ticket is just linked to the ongoing PO until the PO is paid out."
 *
 * ## Why an ordinary purchase order could not express this
 *
 * A purchase order in this app is one delivery: it is raised, it arrives, it is
 * checked in, and the moment its last receivable unit lands it CLOSES ITSELF —
 * see completePoIfFullyReceived, which exists so the receiving desk is not left
 * chasing an order that is already in the building.
 *
 * That is exactly wrong for a week's trading with a shop. Buy one case on
 * Tuesday, carry it home, check it in, and the order shuts — so Wednesday's box
 * has nowhere to go and the week becomes five purchase orders and five separate
 * amounts owed to a shop that is expecting one payment.
 *
 * ## So a tab is a purchase order that does not close itself
 *
 * Everything else about it is an ordinary purchase order, deliberately: the same
 * board, the same lines, the same receiving, the same cost lots, the same deal
 * ticket, the same link to any sale raised from it. A second kind of document
 * would have meant a second place to look for what a roadshow owes.
 *
 * What is new is three rules:
 *
 *   1. IT NEVER CLOSES ITSELF while it is open. Lines are added and checked in
 *      all week and the order stays put.
 *   2. A LINE MAY HAVE NO PRICE YET. "We do not know" and "it was free" are
 *      different facts and this app has been bitten by conflating them before —
 *      see labelCost, which is nullable for the same reason.
 *   3. IT CANNOT BE PAID WHILE ANY PRICE IS MISSING. A total nobody can compute
 *      is not a bill anybody can settle, and a tab that could be marked paid
 *      with three unpriced lines on it would quietly under-report a week's cost
 *      of goods for ever.
 */

/** Anything called "Roadshow <somewhere>" — see isRoadshowLocation, which is the
 *  same test applied to the same names from the other side. */
export { isRoadshowLocation } from './inventory'

/**
 * The tab's own facts, as they travel on a purchase order.
 *
 * Two timestamps rather than a status, because a tab is not a fifth column on
 * the board: it is a purchase order in `ordered` that happens to stay there.
 * Modelling it as a status would have meant teaching PO_TRANSITIONS, the board,
 * the receiving desk and the P&L about a stage none of them needs to know about.
 */
export interface TabFacts {
  /**
   * When the order was opened as an ongoing one. NULL on every ordinary
   * purchase order.
   *
   * UNDEFINED IS ACCEPTED as well as null, and that is not laziness. The field
   * is optional on `PurchaseOrder` — it has to be, because every caller that
   * builds one of those by hand predates it — so requiring null here meant a
   * `?? null` at every single call site, and the one somebody forgets is a
   * typecheck error at best and a wrong answer at worst. Both absences mean the
   * same thing: this is not an ongoing order.
   */
  tabOpenedAt?: string | null
  /** When it was settled. NULL or absent while it is still running. */
  tabClosedAt?: string | null
}

/** Is this order a tab at all — open or settled? */
export function isTab(po: TabFacts): boolean {
  return !!po.tabOpenedAt
}

/**
 * WHERE A TAB'S GOODS SIT: at the shop, and the shop IS the supplier.
 *
 * The owner, on what a roadshow tab is for: "roadshow is inventory that I don't
 * have but it is mine and I can pull from it ... when putting quantities of
 * things I need RM inventory + roadshow open tabs."
 *
 * That is not a dropship. A dropship is goods this business never owns — no
 * cost layer, no COGS, nothing to sell out of. These were BOUGHT: the money is
 * committed the moment a case is put on the tab, and what is unusual is only
 * that the box is three states away. So the honest model is a STOCK LOCATION
 * that is not this building — which this app has supported since locations
 * stopped being the two hardcoded shelves and became a table.
 *
 * ## Why the supplier, rather than a name somebody types
 *
 * The four roadshow shops are already suppliers here. Deriving the place from
 * the supplier means the two can never drift: there is no second name to keep in
 * step, no picker offering "Roadshow Dallas" beside "Roadshow Dalas", and
 * nothing to seed by hand before the feature works. Open a tab with a shop and
 * the shop is where its goods are.
 *
 * ## THIS IS THE BUG IT REPLACES
 *
 * Tabs were being raised against MULTI_SHIPMENT, which is the sentinel for "a
 * dropship to several buyers nobody has named yet" and is DEFINED as holding no
 * stock. Units sent there are unreceivable on purpose: no cost layer, nothing on
 * a shelf, nothing any sales order could ever draw. So a week's buying produced
 * a bill and no inventory, and the tab could not be sold out of at all — which
 * is exactly the symptom that was reported.
 *
 * Returns '' for a tab with no supplier, which the caller must treat as "not
 * ready to be a tab yet" rather than as a place called nothing.
 */
export function tabLocation(supplier: string | null | undefined): string {
  return String(supplier ?? '').trim()
}

/**
 * May this tab's routing still be changed?
 *
 * The owner's rule, in his words: "we can change the destination, that is the
 * thing — but once we close out a tab it is done, you cannot change where things
 * are going."
 *
 * So an OPEN tab is editable and a CLOSED one is history. That is what makes
 * closing meaningful rather than cosmetic: everything on it has been decided —
 * which cases stayed at the shop and which came home — and the record stops
 * moving. It also removes the need for a stock transfer between places, because
 * the question "where is this going" is settled while the answer can still be
 * acted on.
 */
export function tabRoutingLocked(po: TabFacts): boolean {
  return isTab(po) && !isOpenTab(po)
}

/**
 * Is this tab still taking things?
 *
 * The one test the whole feature turns on. `completePoIfFullyReceived` asks it
 * before closing an order, and a tab that answers yes is left alone however much
 * of it has arrived.
 */
export function isOpenTab(po: TabFacts): boolean {
  return !!po.tabOpenedAt && !po.tabClosedAt
}

/** How a tab's state reads on a card. Null on an ordinary purchase order. */
export function tabStatusLabel(po: TabFacts): string | null {
  if (!isTab(po)) return null
  return isOpenTab(po) ? 'Open tab' : 'Settled'
}

/**
 * One line's price, when it may not be known.
 *
 * `pending` is stored beside the number rather than encoded INTO it, because
 * every honest encoding is taken: 0 is a real price a roadshow sometimes gives
 * on a throw-in, and null would mean touching a NOT NULL column every existing
 * read depends on.
 */
export interface TabLinePrice {
  unitPrice: number
  pricePending: boolean
}

/** What a line contributes to the tab's total. Nothing, while nobody knows. */
export function linePriced(line: TabLinePrice): boolean {
  return !line.pricePending
}

/**
 * What is owed so far — the priced lines only.
 *
 * DELIBERATELY NOT AN ESTIMATE. A tab with two unpriced cases on it owes more
 * than this says, and the screen shows the count of unpriced lines beside it so
 * the figure is never mistaken for the bill. Guessing at the missing ones —
 * from the product's average, from last week — would produce a number that
 * looks like money and is not, on the one screen somebody uses to work out what
 * to pay a shop.
 */
export function tabKnownTotal(
  lines: readonly (TabLinePrice & { quantity: number })[]
): number {
  let total = 0
  for (const l of lines) {
    if (linePriced(l)) total += (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0)
  }
  return Math.round(total * 100) / 100
}

/** How many lines are still waiting for a price. */
export function pendingPriceCount(lines: readonly TabLinePrice[]): number {
  let n = 0
  for (const l of lines) if (l.pricePending) n++
  return n
}

/**
 * Why this tab cannot be settled yet — null when it can.
 *
 * The refusal names the COUNT rather than the lines, because the caller has the
 * lines on screen and a sentence listing four product names is a sentence
 * nobody reads to the end. What it must do is be specific about the reason:
 * "cannot be paid" with no cause is the kind of refusal people work around by
 * typing a zero.
 */
export function settleTabRefusal(
  po: TabFacts,
  lines: readonly TabLinePrice[]
): string | null {
  if (!isTab(po)) return null
  if (!isOpenTab(po)) return 'That tab has already been settled.'
  if (lines.length === 0) {
    return 'There is nothing on this tab yet.'
  }
  const pending = pendingPriceCount(lines)
  if (pending > 0) {
    return (
      `${pending} line${pending === 1 ? '' : 's'} on this tab still ${pending === 1 ? 'has' : 'have'} no price. ` +
      'Fill them in before settling — a total nobody can work out is not a bill anybody can pay.'
    )
  }
  return null
}

/**
 * May a line still be added to this order?
 *
 * An ordinary purchase order refuses once it has been checked in — anything
 * added then could never arrive. A TAB is the case that rule was written before:
 * it is checked in as it goes and stays open on purpose, so the refusal must not
 * apply to it while it is running.
 */
export function tabAcceptsLines(po: TabFacts): boolean {
  return isOpenTab(po)
}

/**
 * THE FOUR SHOPS. Named here once, so nobody ever types one again.
 *
 * ## What this replaces, and why it was the hard part
 *
 * The shops were never a list. A tab's shop was whatever somebody TYPED into the
 * supplier box, and that typed string became the shelf its stock stood on — see
 * `ensureTabLocation`. So opening the week's tab was four decisions where there
 * should have been one: raise a purchase order, find the Roadshow tick, type the
 * shop's name exactly as it was typed last time, and leave the destination
 * alone.
 *
 * The third one is the trap. "KY Roadshow" one week and "Kentucky Roadshow" the
 * next are two shelves holding half the stock each, and nothing on any screen
 * says so — the sales order simply comes up short and the other half is standing
 * under a name nobody thinks to look for. The owner's own words: "the roadshow
 * logic should not be this hard."
 *
 * With the shops as a list, opening a tab is one decision: WHICH SHOP. Nothing
 * is typed, so nothing can be mistyped, and there is no second spelling for a
 * shelf to split across.
 *
 * ## Why exactly four, in source, rather than a table
 *
 * Because there are exactly four, and they are the same four every season. A
 * managed list would add a screen for maintaining something nobody maintains,
 * and every screen that offers the shops would have to handle the empty case —
 * "no shops configured" — which is a state this business is never in. A fifth
 * shop is a change to this line and a push, which is the honest cost of a fact
 * that changes about once.
 *
 * They are STILL ordinary stock locations underneath, registered on the way in
 * like any other. This list decides what is offered; it does not decide what
 * holds stock, and a shop retired from here would keep every case it ever
 * costed. See the note on `retired` in @shared/inventory.
 *
 * ## The spelling is the owner's existing one
 *
 * State first — "Kentucky Roadshow" — because that is what his live data already
 * says, and a tidier convention would have meant renaming a shelf with stock
 * standing on it. Matching what exists beats matching a preference.
 */
export const ROADSHOW_SHOPS: readonly string[] = [
  'Kentucky Roadshow',
  'California Roadshow',
  'Texas Roadshow',
  'New York Roadshow'
]

/**
 * Is this one of the four? Case-insensitively, and trimmed.
 *
 * Folded for case because the name reaches this from three directions — a
 * location id written months ago, a supplier on an order, a value off a picker —
 * and a shop that failed to recognise its own shelf because of a capital letter
 * would be the exact bug the list exists to remove.
 */
export function isRoadshowShop(name: string | null | undefined): boolean {
  const v = String(name ?? '').trim().toLowerCase()
  if (!v) return false
  return ROADSHOW_SHOPS.some((s) => s.toLowerCase() === v)
}

/**
 * The shop's name as the list spells it, or null when it is not one of them.
 *
 * The canonical form, for a caller holding a name from somewhere else. Returning
 * the LIST's spelling rather than the caller's is what stops "kentucky roadshow"
 * opening a second shelf beside "Kentucky Roadshow".
 */
export function roadshowShopNamed(name: string | null | undefined): string | null {
  const v = String(name ?? '').trim().toLowerCase()
  return ROADSHOW_SHOPS.find((s) => s.toLowerCase() === v) ?? null
}

/**
 * WHY A SHOP'S COLUMN IS EMPTY WHEN ITS TAB PLAINLY IS NOT.
 *
 * The owner, looking at New York: 0 units, "Nothing here yet", and directly
 * underneath it "PO-0452 · $0.00 · 1 unpriced". His words: "why is the roadshow
 * tab not showing the product ... that doesn't make sense."
 *
 * ## Both halves of that card were telling the truth
 *
 * The column reads the SHELF and the footer reads the TAB, deliberately — see
 * the note at the top of RoadshowBoard for why, and it is the right split. A
 * case bought at a shop and sold out of it the same afternoon leaves the shelf
 * at zero and stays on the week's tab for ever, which is exactly the shape a
 * roadshow produces: writing the sale short at a shop BUYS the case onto the tab
 * and consumes it in the same transaction (see buyShortAtShop), so a product can
 * be bought, sold and gone without ever having been seen standing there.
 *
 * ## So the bug was the SENTENCE, and it was a real one
 *
 * "Nothing here yet. Add what you buy and it lands on this shelf straight away"
 * asserts that nothing was ever added. When a tab is running, that is false, and
 * it is false in the one direction that costs money: it invites somebody to add
 * the case a second time. What is true is that nothing is standing there NOW,
 * and the tab says where it went.
 *
 * ## The unpriced count stops being decoration
 *
 * A line still price-pending means its cases are carried at nothing, and if any
 * have gone out that sale was costed at nothing too. Pricing it later fixes
 * both — `setPurchaseOrderLinePrice` re-costs the stock AND the sales already
 * drawn from it, which is precisely what makes a tab safe to sell out of — but
 * only if somebody does it, so it is said in full rather than left as two words
 * in the footer.
 *
 * THAT WARNING BELONGS TO THE TAB, NOT TO AN EMPTY SHELF, and it was wired to
 * the wrong one. It shipped inside the empty-column branch, so a shop still
 * holding its cases said nothing at all — and that is the shop where it matters
 * most, because those cases are on the shelf at a cost of zero and every screen
 * that values stock is reading that zero. The owner, looking at California
 * holding four unpriced cases in silence beside two empty shops shouting about
 * one each: "why can not everything is showing like that, it should be the
 * same." Quite. `unpricedTabWarning` is separate from the headline for exactly
 * that reason — one answers "why is this empty", the other "what does this
 * week still owe a number", and only the first is about emptiness.
 */
export interface ShopTabStanding {
  /** The tab's own number, so the sentence can point at something findable. */
  poNumber: string
  /** Σ(line quantity) on the tab — everything bought from this shop this week. */
  orderedUnits: number
  /**
   * Units actually checked in. At a shop that is every unit STAYING there, taken
   * the moment it was typed; units routed home are on a lorry and are not.
   */
  receivedUnits: number
  /** Lines still waiting for a price. */
  pendingPriceCount: number
}

const NOTHING_YET =
  'Nothing here yet. Add what you buy and it lands on this shelf straight away.'

const whole = (v: unknown): number => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

const units = (n: number): string => `${n} unit${n === 1 ? '' : 's'}`

/**
 * The sentence for a shop holding nothing, given the week's tab.
 *
 * A tab with nothing on it is still "nothing here yet" — the week has been
 * opened and not yet bought against, which is the same state to the person
 * looking at the column and should not read as a different one.
 */
export function emptyShelfHeadline(tab: ShopTabStanding | null): string {
  const ordered = whole(tab?.orderedUnits)
  if (!tab || ordered <= 0) return NOTHING_YET

  // Capped at what was ordered: the two figures come from the same order, but a
  // count that read "4 sold and −1 coming" would be worse than merely wrong.
  const landed = Math.min(ordered, whole(tab.receivedUnits))
  const coming = ordered - landed

  const said: string[] = []
  if (landed > 0) {
    said.push(`the ${units(landed)} bought here ${landed === 1 ? 'has' : 'have'} been sold`)
  }
  if (coming > 0) {
    said.push(
      `${landed > 0 ? `${units(coming)} more ${coming === 1 ? 'is' : 'are'}` : `the ${units(coming)} on it ${coming === 1 ? 'is' : 'are'}`} coming home rather than staying at the shop`
    )
  }

  return `Nothing is standing here now — ${said.join(', and ')}. It is all on ${tab.poNumber}.`
}

/**
 * WHAT THIS WEEK STILL OWES A NUMBER — on every column, full or empty.
 *
 * ## Why the sentence changes with what is left on the shelf
 *
 * An unpriced line is one fact with two different consequences, and saying the
 * wrong one is worse than saying nothing:
 *
 *   · NOTHING HAS GONE YET — the cases are standing there at a cost of zero, so
 *     the shelf is under-valued and the first sale out of them will book pure
 *     profit. That is a warning about the FUTURE, and the fix is to price them
 *     before selling.
 *   · SOME HAS GONE — a sale has already been costed at nothing. That is a
 *     warning about the PAST, and pricing the line now corrects the sale as well
 *     as the shelf (see restateConsumedCost), which is the only reason selling
 *     out of an unpriced tab is safe at all.
 *
 * Telling a shop still holding all four cases that "anything sold from them was
 * costed at nothing" would be a sentence about a sale that never happened, on a
 * screen somebody is using to decide what to chase.
 *
 * `unitsOnShelf` is what the COLUMN counts, and `receivedUnits` is what the tab
 * checked in; the difference is what has left by any route. Passing the shelf in
 * rather than deriving it here keeps the one number the board already has as the
 * one this reads — there is no second count to disagree with it.
 */
export function unpricedTabWarning(
  tab: ShopTabStanding | null,
  unitsOnShelf: number
): string | null {
  const pending = whole(tab?.pendingPriceCount)
  if (!tab || pending <= 0) return null
  const one = pending === 1
  const lines = `${pending} line${one ? '' : 's'} on ${tab.poNumber} still ${one ? 'has' : 'have'} no price`
  const gone = whole(tab.receivedUnits) - whole(unitsOnShelf)
  return gone > 0
    ? `${lines}, so anything sold from ${one ? 'it' : 'them'} was costed at nothing. Fill the price in on the tab and both the shelf and those sales are put right.`
    : `${lines}, so ${one ? 'that case is' : 'those cases are'} sitting here at a cost of nothing. Fill the price in on the tab before ${one ? 'it is' : 'they are'} sold.`
}
