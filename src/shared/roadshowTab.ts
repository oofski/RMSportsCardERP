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
