/**
 * DAY BY DAY: WHAT WHATNOT PAID, WHAT THE APP MADE OF IT, AND AT WHAT RATE.
 *
 * The owner's words, after a fortnight of not being able to tie two numbers
 * together: "all I am doing is taking the net payments, asking for the revenue
 * projection, and then looking at cost of goods sold." That is a three-column
 * sum, and until now there was nowhere in the app to see it laid out.
 *
 * ## The failure this exists to make visible
 *
 * A rate period covers a DATE RANGE. `effectiveFeeRates` ends with
 *
 *     const p = coveringRatePeriod(periods, day)
 *     if (!p) return DEFAULT_FEE_RATES
 *
 * so a business day that no period covers is priced at the built-in 8% and 2.9%
 * — silently, with nothing on any screen saying so. The Fees & rates tab lists
 * the periods somebody entered and looks completely correct; the nights outside
 * their ranges are being charged at a rate nobody chose, and the derived revenue
 * for those nights is wrong by whatever the difference comes to.
 *
 * Reading the period list cannot catch that. It is a question about the GAPS
 * between the periods, and a gap is invisible in a list of what exists. So this
 * goes the other way round: it starts from the days that actually carry money
 * and asks each one which terms it was priced under.
 *
 * ## Every column is checkable against something outside the app
 *
 *   netPaid     the ledger's own Amount, summed. This is the number the operator
 *               uploaded. It is not derived, not modelled, and it should match
 *               Whatnot to the cent.
 *   grossSales  netPaid with the modelled fees added back — the only column on
 *               this table that is a MODEL rather than a record.
 *   commission  what the model says came off, and at what rate.
 *   cogs        what the stock cost, from the stream items.
 *   netProfit   the day's bottom line.
 *
 * `grossSales + commission + processing === netPaid` holds to the cent on every
 * row by construction, which is why an error in the rate cannot move the bottom
 * line — and why it moves the top one by exactly the amount the rate is wrong.
 */

import {
  coveringRatePeriod,
  type StreamDayFinance,
  type WhatnotRatePeriod
} from './financeStreaming'

export interface ReconRow {
  /** Business day, YYYY-MM-DD. */
  day: string
  /** The ledger's own figure for this day's sale rows. Not derived. */
  netPaid: number
  /**
   * EVERY LEDGER ROW ON THIS DAY, summed at face value — the money that actually
   * left Whatnot for the bank.
   *
   * `netPaid` is the sale rows ALONE. That is the right number to fit a
   * commission against, because the commission was charged on those rows and
   * nothing else. It is the wrong number to compare with a payout: postage,
   * boosts, refunds, tips and bonuses are all real ledger rows that moved real
   * money, and a payout figure has every one of them in it already.
   *
   * Comparing a payout with `netPaid` therefore reports the app's own missing
   * buckets as a discrepancy. On a light month that is a couple of thousand
   * dollars of false alarm; on a month of heavy postage it is enough to bury a
   * real one. So the payout comparison uses THIS, and the fee fit uses that.
   *
   * `giveawayLoss` is stripped because it is the one figure on a day that comes
   * from outside the ledger — a prize somebody typed in, which Whatnot never
   * saw and never deducted. See StreamDayFinance.netAfterCosts.
   */
  ledgerNet: number
  /** netPaid with the modelled fees added back. The only modelled column. */
  grossSales: number
  /** Negative. */
  commission: number
  /** Negative. */
  processing: number
  /** Negative. */
  cogs: number
  netProfit: number
  /**
   * Orders the fee model charged on this night.
   *
   * Carried because a per-ORDER error and a per-DOLLAR error look identical in a
   * total and are told apart only by dividing by this. See @shared/statementFit.
   */
  orders: number
  /**
   * The commission rate this day was actually priced at, as a fraction.
   *
   * Null when the day carried no sale rows, which is a real state — a night of
   * tips and a shipping adjustment and nothing sold — and is not the same as a
   * rate of zero.
   */
  rate: number | null
  /**
   * DID A RATE PERIOD COVER THIS DAY, or did it fall through to the built-in
   * defaults? The whole point of the table.
   */
  covered: boolean
  /** The period's own label, when one covered it. */
  periodNote: string | null
}

export interface ReconTotals {
  netPaid: number
  /** Every ledger row across the window. The figure a payout is checked against. */
  ledgerNet: number
  grossSales: number
  commission: number
  processing: number
  cogs: number
  netProfit: number
  /** Orders the fee model charged across the window. */
  orders: number
  /** Days in the list that fell through to the built-in rates. */
  uncoveredDays: number
  /** Money that was priced at the built-in rates rather than a chosen one. */
  uncoveredNetPaid: number
}

const c2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100
const n = (v: number | null | undefined): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/**
 * One row per business day that carried any money, newest first.
 *
 * NEWEST FIRST because a reconciliation starts from the thing that just landed.
 * Days with no rows at all are dropped: a table of empty Tuesdays buries the
 * three nights somebody is actually trying to tie out.
 *
 * The rate is read off `rateBreakdown`, which the day already carries and which
 * is built from the same accumulator as `grossSales` — so it is the rate that
 * was APPLIED, not a rate re-derived here that could disagree with it.
 *
 * THE SORT DECIDES THE ANSWER, and it did not always have to. A business day
 * once had exactly one slice — the rate was resolved per day and every row on
 * it was charged under that one — so the direction of this sort could not change
 * anything and no test could tell it apart from the reverse.
 *
 * That stopped being true when a rate gained a SCOPE. A night selling both break
 * spots and sealed product under different terms now carries two slices, and
 * this column has to report one rate. It reports the terms that priced most of
 * the money, which is the same answer the rolled-up shape gives: `FinancePeriodRow`
 * extends this type and its `rateBreakdown` is merged across days, so a week
 * spanning a rate change has always landed here needing exactly this rule.
 *
 * The `covered` flag beside it is unaffected and stays the honest one: it asks
 * whether a period covered the day at all, not which of two did.
 */
export function reconRows(
  days: readonly StreamDayFinance[],
  periods: readonly WhatnotRatePeriod[]
): ReconRow[] {
  const rows: ReconRow[] = []
  for (const d of days) {
    const netPaid = c2(n(d.netSales))
    const grossSales = c2(n(d.grossSales))
    const cogs = c2(n(d.cogs))
    if (netPaid === 0 && grossSales === 0 && cogs === 0 && n(d.netProfit) === 0) continue
    const slices = [...(d.rateBreakdown ?? [])].sort((a, b) => n(b.grossSales) - n(a.grossSales))
    const covering = coveringRatePeriod(periods, d.streamDate)
    rows.push({
      day: d.streamDate,
      netPaid,
      ledgerNet: c2(n(d.netAfterCosts) - n(d.giveawayLoss)),
      grossSales,
      commission: c2(n(d.whatnotFee)),
      processing: c2(n(d.processingFee)),
      cogs,
      netProfit: c2(n(d.netProfit)),
      orders: Math.max(0, Math.round(n(d.feeSaleCount))),
      rate: slices.length > 0 ? n(slices[0].rate) : null,
      covered: !!covering,
      periodNote: covering ? (covering.note ?? '').trim() || null : null
    })
  }
  return rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

/**
 * The bottom of the table, and the two figures that answer "is my rate set up
 * actually reaching my shows".
 *
 * `uncoveredNetPaid` is deliberately the money and not the day count. Four
 * uncovered Tuesdays that took $40 between them is a footnote; one uncovered
 * Saturday that took $60,000 is the whole discrepancy, and a count cannot tell
 * those two apart.
 */
export function reconTotals(rows: readonly ReconRow[]): ReconTotals {
  const t: ReconTotals = {
    netPaid: 0,
    ledgerNet: 0,
    grossSales: 0,
    commission: 0,
    processing: 0,
    cogs: 0,
    netProfit: 0,
    orders: 0,
    uncoveredDays: 0,
    uncoveredNetPaid: 0
  }
  for (const r of rows) {
    t.netPaid += r.netPaid
    t.ledgerNet += r.ledgerNet
    t.grossSales += r.grossSales
    t.commission += r.commission
    t.processing += r.processing
    t.cogs += r.cogs
    t.netProfit += r.netProfit
    t.orders += r.orders
    if (!r.covered) {
      t.uncoveredDays += 1
      t.uncoveredNetPaid += r.netPaid
    }
  }
  for (const k of [
    'netPaid',
    'ledgerNet',
    'grossSales',
    'commission',
    'processing',
    'cogs',
    'netProfit',
    'uncoveredNetPaid'
  ] as const) {
    t[k] = c2(t[k])
  }
  return t
}

/**
 * Rows inside a date window, both ends inclusive. Blank ends mean open.
 *
 * String comparison, deliberately: these are YYYY-MM-DD business days, which
 * sort correctly as text, and parsing them into Dates is how a day-only value
 * picks up a timezone and lands on the wrong side of a month end. The same rule
 * the rest of this codebase keeps about date-only strings.
 */
export function reconInRange(
  rows: readonly ReconRow[],
  from: string,
  to: string
): ReconRow[] {
  const a = (from || '').trim()
  const z = (to || '').trim()
  return rows.filter((r) => (!a || r.day >= a) && (!z || r.day <= z))
}
