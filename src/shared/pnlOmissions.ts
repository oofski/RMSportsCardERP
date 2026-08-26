/**
 * WHAT THE PROFIT ON THIS STATEMENT DOES NOT INCLUDE.
 *
 * The owner's question, in his words: "why is our profit higher than what we are
 * seeing." It reads high because several real costs are not terms in the sum —
 * and until now nothing on the screen said so. A number that is short by an
 * unknown amount, presented as if it were complete, is worse than one that is
 * short and says which costs it is missing.
 *
 * ## This is a DISCLOSURE, not a section
 *
 * Deliberately not a `PnlSection`. Every section on the statement is in
 * `netProfit` and `pnlChecksum` asserts exactly that — so a section holding money
 * that is NOT in the bottom line would either break the checksum or have to be
 * excused from it, and an excused section is one somebody later adds up by
 * mistake. These figures live in their own block, under the bottom line, labelled
 * as what is missing from it. Nothing here is subtracted from anything.
 *
 * ## Priced and unpriceable are different answers
 *
 * Some of what is missing the app can put a number on; some it cannot, and
 * pretending otherwise is how a disclosure becomes another wrong figure.
 *
 *   priced       packaging — modelled per night and summed already, just never
 *                subtracted. `amount` is real money.
 *   unpriceable  the cost of cases nobody entered, the cost of stock sold
 *                sealed, wages. The app knows the REVENUE involved, or the
 *                number of nights, and does not know the cost. `amount` is null
 *                and the detail says what IS known.
 *
 * A reader must be able to tell "this is $3,500 you have not counted" from "there
 * is an amount here and it is not knowable from this app", so the two never share
 * a column.
 *
 * ## Why the counts are counts
 *
 * `uncostedSaleDays` is 0 or 1 per business day and is SUMMED through the weekly
 * and monthly rollup, so a month reports "4 of 21 nights". A boolean would not
 * survive that sum, and the rollup is exactly where the disclosure matters most —
 * one bad night inside a month is invisible in the month's own total.
 */

/** One cost this statement leaves out. */
export interface PnlOmission {
  key: string
  label: string
  /**
   * Dollars missing from net profit, POSITIVE, when the app can price it.
   *
   * Null when it cannot — see the header. Never zero-as-unknown: a real zero
   * means "this one is genuinely nothing this period" and reads as reassurance,
   * which is the opposite of what null means.
   */
  amount: number | null
  /** What is known, in the owner's terms. Always says something concrete. */
  detail: string
  /** Nights involved, when nights are the honest unit rather than dollars. */
  count?: number
}

export interface PnlOmissions {
  items: PnlOmission[]
  /** Sum of every `amount` that is not null — what net profit is KNOWN to be high by. */
  pricedTotal: number
  /** How many omissions the app cannot put a number on. */
  unpriceable: number
}

/** The day or period figures this reads. A subset of StreamDayFinance. */
export interface PnlOmissionInput {
  /** Derived gross for every sale row, break spots and whole products together. */
  grossSales?: number | null
  /** The whole-product share of it. Break-spot gross is the difference. */
  productGrossSales?: number | null
  /** Business days that took sale money and recorded no stock at all. */
  uncostedSaleDays?: number | null
  /** Break-spot gross taken on those days. */
  uncostedSaleRevenue?: number | null
  /** How many business days this figure covers, for "4 of 21 nights". */
  dayCount?: number | null
  packagingSleeves?: number | null
  packagingTopLoaders?: number | null
  packagingTeamBags?: number | null
  packagingShippingLabels?: number | null
  packagingTeamBagStickers?: number | null
  packagingMailers?: number | null
}

const n = (v: number | null | undefined): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
/** Cents-safe, matching the rest of the finance code's rounding. */
const c2 = (v: number): number => Math.round(v * 100) / 100
const money = (v: number): string =>
  `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * The six modelled packaging lines, summed.
 *
 * Computed every night and rolled into every period already — see the note in
 * the rollup field list — and read by no statement section, which is precisely
 * why it belongs here. It is the one omission the app can price exactly.
 *
 * Stored NEGATIVE like every other cost, so this flips the sign: a disclosure
 * says how much net profit is HIGH by, and a negative number in that sentence
 * reads as the opposite of what it means.
 */
export function packagingTotal(d: PnlOmissionInput): number {
  return c2(
    Math.abs(
      n(d.packagingSleeves) +
        n(d.packagingTopLoaders) +
        n(d.packagingTeamBags) +
        n(d.packagingShippingLabels) +
        n(d.packagingTeamBagStickers) +
        n(d.packagingMailers)
    )
  )
}

/**
 * Everything this statement's profit leaves out, in the order it costs money.
 *
 * An omission that is genuinely nothing this period is DROPPED rather than shown
 * at zero. A list that always prints four rows is a list nobody reads, and the
 * whole value of this block is that its presence means something.
 */
export function buildPnlOmissions(d: PnlOmissionInput): PnlOmissions {
  const items: PnlOmission[] = []

  // 1. NIGHTS THAT SOLD AND RECORDED NO STOCK.
  //
  // The largest and the least visible. Break cost of goods has exactly one
  // source — rows somebody types into the session — so a night whose cases were
  // never entered reads as 100% margin, and the statement's own uncosted flag
  // cannot see it: that flag is computed over the stock rows, so a night with no
  // stock rows has nothing for it to look at. This counts the nights instead.
  const badDays = Math.max(0, Math.round(n(d.uncostedSaleDays)))
  if (badDays > 0) {
    const days = Math.max(0, Math.round(n(d.dayCount)))
    const rev = c2(Math.abs(n(d.uncostedSaleRevenue)))
    items.push({
      key: 'uncostedNights',
      label: badDays === 1 ? 'A night with no stock recorded' : `${badDays} nights with no stock recorded`,
      amount: null,
      count: badDays,
      detail:
        `${money(rev)} of break sales on ${badDays === 1 ? 'a night' : `${badDays} nights`}` +
        `${days > 0 ? ` of ${days}` : ''} where nobody entered what was opened. ` +
        'Those sales are counted at full price against no cost at all, so they read as pure profit. ' +
        'Add the cases to the show and the number corrects itself.'
    })
  }

  // 2. STOCK SOLD SEALED.
  //
  // A box or case sold whole goes into the same top line as a break spot and can
  // never carry a cost: a stream item is a break or a giveaway and there is no
  // third kind, so no cost row can be written for one. The app knows exactly what
  // this revenue was and nothing about what the stock cost.
  const market = c2(Math.abs(n(d.productGrossSales)))
  if (market > 0) {
    items.push({
      key: 'sealedProductCost',
      label: 'Boxes and cases sold sealed',
      amount: null,
      detail:
        `${money(market)} of sales where the stock left unopened. The app records what it sold for ` +
        'and has no way yet to charge what it cost, so all of it is sitting in profit.'
    })
  }

  // 3. PACKAGING — the one that can be priced.
  const packaging = packagingTotal(d)
  if (packaging > 0) {
    items.push({
      key: 'packaging',
      label: 'Packaging',
      amount: packaging,
      detail:
        'Sleeves, top loaders, team bags, labels, stickers and mailers, priced per night and ' +
        'deliberately left out of the bottom line. Net profit is higher by exactly this.'
    })
  }

  // 4. WAGES. Nothing in the app turns a minute into a dollar, so this one is
  //    unpriceable by construction rather than by circumstance. Named anyway,
  //    because for a business with staff on the bench it is the biggest of the
  //    four and its absence is the easiest to forget.
  items.push({
    key: 'labour',
    label: 'Wages',
    amount: null,
    detail:
      'Hours are tracked and sent to payroll; no pay rate is stored here, so no labour cost ' +
      'reaches this statement. Whatever the bench was paid for these shows is still in this profit.'
  })

  const priced = items.filter((i) => i.amount !== null)
  return {
    items,
    pricedTotal: c2(priced.reduce((a, i) => a + (i.amount ?? 0), 0)),
    unpriceable: items.length - priced.length
  }
}
