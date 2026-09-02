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
/**
 * The one thing the panels below borrow rather than restate.
 *
 * `PAYOUT_GAP_LIMIT` is a judgement — two percent — about how far two figures of
 * the same kind may honestly differ before the window is the suspect. Two copies
 * of that number drift, and the day they do, one panel calls a month settled
 * while the one beside it calls the same month wrong.
 */
import { PAYOUT_GAP_LIMIT, type PinnedTerms, type WhatnotStatement } from './statementFit'

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

/* ===========================================================================
   ASSERTING AGREEMENT WITH AN OUTSIDE DOCUMENT

   Everything above this line DESCRIBES WHAT IS STORED. `reconInRange` treating a
   blank end as "open" is correct there and must stay: the night-by-night table
   is a view of the ledger, and a table that showed nothing until somebody typed
   two dates would be worse at the one job it has.

   Everything below this line ASSERTS THAT TWO SYSTEMS AGREE, and for that job an
   open end is not a convenience, it is a lie. A figure typed off one month's
   statement compared against every night ever imported produces a gap the size
   of the rest of the ledger, and the screen reports it with a straight face.
   That is not a hypothetical: both panels that check revenue against Whatnot
   were built with the window initialised blank/blank, so every answer either of
   them ever gave was that comparison, and neither has ever produced a usable
   number.

   DO NOT "FIX" `reconInRange` TO REQUIRE BOTH ENDS. The blank-means-open rule is
   right for the table and wrong for the panels; the difference is not in the
   filter, it is in what the caller is claiming. `checkWindow` is where the
   panels make that claim, and it is the only place that should refuse.
   =========================================================================== */

const money = (v: number): string =>
  `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Date-only strings are turned into instants at UTC NOON, never local midnight.
 *
 * Local midnight is the trap this codebase has written down three times already
 * (see addDays in @shared/homeTasks, @shared/schedule and @shared/invoices): a
 * day parsed at midnight and moved across a daylight-saving boundary lands on
 * 23:00 the previous day, and a day count rounds one short. Noon is twelve hours
 * from either edge, so no offset any zone uses can push it into the wrong day.
 *
 * Returns null for anything that is not a real calendar day, INCLUDING a
 * well-shaped one that does not exist: '2026-02-30' matches the pattern and
 * Date.UTC happily rolls it into March, so the round-trip below is what actually
 * rejects it. A window silently starting on a different day from the one typed
 * is exactly the class of error this whole file exists to catch.
 */
function utcNoon(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d, 12, 0, 0, 0)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) {
    return null
  }
  return ms
}

const DAY_MS = 24 * 60 * 60 * 1000

export interface CheckWindow {
  /** The start as typed, trimmed. Blank when nothing was entered. */
  from: string
  to: string
  /**
   * IS THIS WINDOW FIT TO BE COMPARED WITH AN OUTSIDE DOCUMENT?
   *
   * True only when both ends are set, both are real YYYY-MM-DD days, and the
   * start is not after the end. Anything else and the window does not describe a
   * period a statement could cover, so no comparison drawn against it means
   * anything — see the block comment above.
   */
  bounded: boolean
  /** Inclusive day count when bounded — 1 to 31 is 31 days, not 30. Else 0. */
  days: number
  /** Null when bounded. Otherwise the reason, in the owner's own language. */
  problem: string | null
}

/**
 * REFUSE THE WINDOW BEFORE ANYTHING IS COMPARED AGAINST IT.
 *
 * The defect this exists to end: `RatesTab` initialises its two date boxes as
 * useState('') / useState(''), and a blank end means NO FILTER, so the revenue
 * check and the payout check both ran over the entire ledger. Type July's
 * payout, and the app compares one month's figure with every night ever
 * imported and reports the difference as a discrepancy. The owner has been
 * looking at a $24k gap; a comparison built that way could not have told them
 * anything about it either way.
 *
 * So the panels ask this first, and print `problem` instead of a number when it
 * is not null. It refuses rather than guesses: there is no defensible default
 * for "which month did you mean", and picking one — the current month, the last
 * statement's dates — would put a window on screen that nobody chose and that
 * the figure beside it may not be about.
 *
 * String comparison for the ordering check, deliberately, and the same rule the
 * rest of this file keeps: YYYY-MM-DD sorts correctly as text, and parsing a
 * date-only value into a Date is how it picks up a timezone. The parse below
 * happens only to COUNT days, which text cannot do.
 */
export function checkWindow(from: string, to: string): CheckWindow {
  const a = String(from ?? '').trim()
  const z = String(to ?? '').trim()
  const base = { from: a, to: z, bounded: false, days: 0 }

  if (!a && !z) {
    return {
      ...base,
      problem:
        'This is every night ever imported. A figure off one statement cannot be compared ' +
        'with the whole ledger — set the dates the statement covers.'
    }
  }
  if (!a) {
    return {
      ...base,
      problem:
        'There is no start date, so this runs from the first night ever imported. A statement ' +
        `covers a period with two ends — set the day this one starts, on or before ${z}.`
    }
  }
  if (!z) {
    return {
      ...base,
      problem:
        'There is no end date, so this runs to the last night ever imported. A statement covers ' +
        `a period with two ends — set the day this one ends, on or after ${a}.`
    }
  }

  const start = utcNoon(a)
  const end = utcNoon(z)
  if (start === null || end === null) {
    const bad = start === null ? a : z
    return {
      ...base,
      problem:
        `“${bad}” is not a day this app can read. Business days are written YYYY-MM-DD — ` +
        '2026-07-01, not 07/01/26 and not the 31st of a month with thirty days.'
    }
  }
  // Ordering is checked on the text, not on the instants, so that this answer
  // can never depend on the machine's clock settings.
  if (a > z) {
    return {
      ...base,
      problem:
        `The start (${a}) falls after the end (${z}), so this window covers no nights at all. ` +
        'Swap the two dates.'
    }
  }

  return {
    from: a,
    to: z,
    bounded: true,
    // Both ends are inclusive everywhere in this app — a rate period, a show
    // window, this — so the count is the difference PLUS ONE. July is 31 days.
    days: Math.round((end - start) / DAY_MS) + 1,
    problem: null
  }
}

/** The three fields of a saved figure that deciding coverage actually needs. */
export type CoveringStatement = Pick<WhatnotStatement, 'fromDate' | 'toDate' | 'statedGross'>

export type RevenueStandingState = 'never' | 'stale' | 'compared' | 'disagrees'

export interface RevenueStanding {
  /**
   * · never      no figure has ever been saved. Nothing to compare against.
   * · stale      figures exist, but none of them covers these days.
   * · compared   one covers the window and agrees with what the app derives.
   * · disagrees  one covers the window and does not.
   *
   * 'never' and 'stale' are kept apart because they ask for different things:
   * one wants a figure typed in, the other wants the DATES changed to the ones a
   * figure was typed for. A single "no data" state sends somebody re-entering a
   * number they already have.
   */
  state: RevenueStandingState
  /** The statement the comparison used, or null in 'never' and 'stale'. */
  statement: CoveringStatement | null
  /** What that statement says the window sold. Null when none covered it. */
  statedGross: number | null
  /** What the app derives — THE VALUE PASSED IN, unmodified. See below. */
  derivedRevenue: number
  /** derivedRevenue − statedGross. POSITIVE MEANS THE APP READS HIGH. */
  gap: number | null
  /** The gap as a share of the stated figure. Compared with PAYOUT_GAP_LIMIT. */
  gapShare: number | null
  /** Printed verbatim by the renderer. The whole point of this function. */
  sentence: string
}

/**
 * WHERE THE APP'S REVENUE STANDS AGAINST WHATNOT'S OWN FIGURE FOR THE SAME DAYS.
 *
 * The owner's question is one sentence long — "is my revenue right?" — and the
 * answer has to be one sentence back, which is why the sentence is built here
 * and not in a component. A renderer that assembles this out of four booleans
 * and two numbers will eventually assemble a sentence the numbers do not
 * support, and this is the screen that has already lied twice.
 *
 * ## RULE ONE: coverage is containment, and PARTIAL OVERLAP IS NOT COVERAGE
 *
 *     s.fromDate <= range.from && s.toDate >= range.to
 *
 * The statement must contain the whole window. Loosening this to an intersection
 * test — "the statement touches these days" — is EXACTLY the trap that produced
 * the mess this function was written to end. A figure for 1-15 July set beside a
 * window covering all of July is not a smaller number for the same period, it is
 * a number for HALF the period, and comparing it with a full month's derived
 * revenue manufactures a gap of roughly half the month out of nothing at all.
 * That is the same shape as the $24k the owner has been chasing, which is
 * precisely why it must not be possible to produce one accidentally.
 *
 * ## RULE TWO: an all-time window can NEVER be covered, and statements are NEVER SUMMED
 *
 * An unbounded range has no ends for a statement to contain, so nothing covers
 * it and the answer is 'stale' — never a total. It is tempting to add up every
 * statement on file and compare that, and it is wrong: two statements with a gap
 * between their windows sum to a figure NOBODY EVER STATED, for a period nobody
 * ever reported on, and the app would then present it as Whatnot's own number.
 * A wrong answer wearing the authority of an outside document is worse than no
 * answer. So the 'stale' sentence contains no money at all.
 *
 * ## RULE THREE: when several cover the window, take the NARROWEST
 *
 * A quarterly statement and a July statement both contain July. The July one is
 * the better evidence about July — the quarter's figure includes June and August
 * and only bounds the answer from above — so the tightest window that still
 * contains the range wins. Widest-wins would let a year's 1099 quietly answer a
 * question about one month.
 *
 * ## THE WORDING IS PART OF THE CONTRACT
 *
 * Say COMPARED. NEVER say "reconciled". The app's July is July's SHOWS, and a
 * statement's July is whatever rows Whatnot chose to settle in July: matching
 * dates do not guarantee the same rows, so agreement here is evidence and not
 * proof, and a screen that says "reconciled" tells somebody to stop looking.
 *
 * And the derived figure printed is `derivedRevenue` exactly as it was passed
 * in. Re-deriving it here — from statements, from a fit, from anything — is how
 * a sentence ends up disagreeing with the tile it is sitting directly under, and
 * a screen that contradicts itself is worth less than a blank one.
 */
export function revenueStanding(
  range: CheckWindow,
  statements: readonly CoveringStatement[],
  /**
   * GROSS SALES FOR THE WINDOW. Not the P&L revenue subtotal.
   *
   * The name follows the one `statementFit` has always used, where it has always
   * meant sales — `revenueGap` there is `derivedRevenue - sales`. Both sides of
   * this comparison have to be the same quantity or the difference is not a
   * discrepancy, it is a category error wearing one.
   *
   * A statement's stated figure is what the window SOLD. The revenue subtotal is
   * that plus tips, seller bonuses and unrecognised rows — money that arrives
   * whole and was never a sale. Passing it here was caught in review: a July
   * agreeing with Whatnot to the cent read as 2.7% out because $8,000 of tips
   * landed in the same month, while the other screen called the same statement a
   * match. Two screens contradicting each other about one document is the exact
   * failure this function was written to end.
   */
  derivedRevenue: number
): RevenueStanding {
  const derived = c2(n(derivedRevenue))
  const base = {
    statement: null,
    statedGross: null,
    derivedRevenue: derived,
    gap: null,
    gapShare: null
  }

  if (statements.length === 0) {
    return {
      ...base,
      state: 'never',
      sentence:
        'No figure from Whatnot has ever been saved, so there is nothing here to compare the ' +
        'app’s sales against. Type what Whatnot says a window sold and save it.'
    }
  }

  // RULE TWO. No ends means nothing to contain, so nothing covers it — and the
  // sentence deliberately carries no figure, because the only figure available
  // would be a sum nobody stated.
  if (!range.bounded) {
    return {
      ...base,
      state: 'stale',
      sentence:
        'These are all the nights ever imported, and no single statement covers that. Adding ' +
        'saved figures together would invent a total nobody ever stated — two windows with a ' +
        'gap between them do not make one period. Set the dates one statement covers.'
    }
  }

  // RULE ONE. Containment, both ends, on the text: these are YYYY-MM-DD business
  // days and they sort correctly as strings. A statement that merely overlaps is
  // not evidence about this window.
  const covering = statements.filter((s) => {
    const a = String(s.fromDate ?? '').trim()
    const z = String(s.toDate ?? '').trim()
    return !!a && !!z && a <= range.from && z >= range.to
  })

  if (covering.length === 0) {
    return {
      ...base,
      state: 'stale',
      sentence:
        `No saved Whatnot figure covers all of ${range.from} to ${range.to}. A statement that ` +
        'covers only part of these days cannot settle the rest of them — enter the figure for ' +
        'exactly this period, or move the dates to a period one of them covers.'
    }
  }

  // RULE THREE. Narrowest wins: the tightest window that still contains the
  // range is the one with the least of somebody else's months in it. Ties break
  // on the earlier start so the answer never depends on list order.
  const width = (s: CoveringStatement): number => {
    const a = utcNoon(String(s.fromDate ?? '').trim())
    const z = utcNoon(String(s.toDate ?? '').trim())
    return a === null || z === null ? Number.MAX_SAFE_INTEGER : z - a
  }
  const best = [...covering].sort((x, y) => {
    const d = width(x) - width(y)
    return d !== 0 ? d : x.fromDate < y.fromDate ? -1 : x.fromDate > y.fromDate ? 1 : 0
  })[0]

  const stated = c2(n(best.statedGross))
  const gap = c2(derived - stated)
  // A stated gross of zero is not a sales figure, so there is no percentage to
  // take: anything derived against it is 100% off, which is the honest reading
  // and needs no fifth state to say so.
  const gapShare = stated > 0 ? Math.abs(gap) / stated : gap === 0 ? 0 : 1
  const disagrees = gapShare > PAYOUT_GAP_LIMIT

  if (!disagrees) {
    return {
      statement: best,
      statedGross: stated,
      derivedRevenue: derived,
      gap,
      gapShare,
      state: 'compared',
      sentence:
        `Whatnot’s own figure for ${range.from} to ${range.to} and the sales this app derives ` +
        'agree, inside the two percent that timing and rounding account for. Compared, not ' +
        'settled: the app’s July is July’s SHOWS, so agreeing dates are not a promise of the ' +
        'same rows.'
    }
  }

  const dir = gap > 0 ? 'higher' : 'lower'
  return {
    statement: best,
    statedGross: stated,
    derivedRevenue: derived,
    gap,
    gapShare,
    state: 'disagrees',
    sentence:
      `Whatnot states ${money(stated)} for ${best.fromDate} to ${best.toDate}; this app derives ` +
      `${money(derived)} for ${range.from} to ${range.to} — ${money(gap)} ${dir}, ` +
      `${(gapShare * 100).toFixed(1)}% of the stated figure. Compared, not settled: matching ` +
      'dates do not guarantee the same rows, so check the window before the rate.'
  }
}

/** Only what pinning needs off a row, so a caller can pass anything shaped right. */
export type PinnableRow = Pick<ReconRow, 'day' | 'netPaid'>

export interface PinnedTermsFor {
  /** The card terms the fit holds fixed while it solves the commission. */
  pinned: PinnedTerms
  /**
   * Did the window span more than one set of card terms?
   *
   * A single fitted commission assumes it did not. When it did, the fit is still
   * the best single answer available, but it is an average of two regimes and
   * saying so is cheaper than letting somebody save it believing otherwise.
   */
  mixedTerms: boolean
  /** The night the terms came from, or null when the window held no money. */
  pinnedDay: string | null
}

/**
 * THE TERMS TO HOLD FIXED: the ones that priced the most money in the window.
 *
 * ## Why this moved into shared code
 *
 * Two screens ask this same question and gave two different answers.
 * `whatnotStatements.revenueCheck` took the terms from the heaviest night in the
 * window, which is right. `RatesTab` took them from the window's LAST DAY, and
 * fell back to TODAY when the box was blank — and since that box defaulted to
 * blank (see `checkWindow`), the panel was pinning a fit on July's money to
 * whatever rates happen to be in force today. Two answers to one question, one
 * of them silently about the wrong month.
 *
 * The heaviest night wins because when one answer is required, the honest one is
 * the terms that priced most of the money. The last day is arbitrary: a quiet
 * Tuesday closing the month decides how a $60,000 Saturday is fitted. It is the
 * same rule `reconRows` applies when a night carries two rates, for the same
 * reason.
 *
 * ## Why the lookup is a CALLBACK and not a `periods` list
 *
 * Resolving a day to its terms is not the same call in the two places that need
 * it, and the resolver lives in modules this one must not depend on — the main
 * process has a store-backed lookup, the renderer has the periods it already
 * holds in state. Importing either into `@shared` would drag process-specific
 * code into a module the browser bundle includes. Taking the lookup as a
 * function keeps this pure and testable: the rule is here, the resolution stays
 * where the data is.
 *
 * `fallback` is what to pin when the window held no money at all. There is no
 * heaviest night to ask, and nothing is being priced, so any answer is
 * arbitrary — the caller names its own rather than this guessing at one.
 */
export function pinTermsFor(
  rows: readonly PinnableRow[],
  termsFor: (day: string) => PinnedTerms,
  fallback?: PinnedTerms
): PinnedTermsFor {
  // One lookup per distinct day: `termsFor` may reach a store, and the mixed
  // check would otherwise call it once per row all over again.
  const cache = new Map<string, PinnedTerms>()
  const lookup = (day: string): PinnedTerms => {
    const hit = cache.get(day)
    if (hit) return hit
    const t = termsFor(day)
    cache.set(day, t)
    return t
  }

  // Heaviest first. The tiebreak is explicit and on the LATER day, so that two
  // nights holding identical money can never make this answer depend on the
  // order the rows happened to arrive in.
  const heaviest = [...rows].sort(
    (a, b) => n(b.netPaid) - n(a.netPaid) || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)
  )[0]

  const key = (t: PinnedTerms): string =>
    `${n(t.processingRate)}|${n(t.taxRate)}|${n(t.processingFlatCents)}`
  const mixedTerms = new Set(rows.map((r) => key(lookup(r.day)))).size > 1

  return {
    pinned: heaviest ? lookup(heaviest.day) : (fallback ?? termsFor('')),
    mixedTerms,
    pinnedDay: heaviest ? heaviest.day : null
  }
}
