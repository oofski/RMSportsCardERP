/**
 * TYPE IN WHAT THE PLATFORM SAYS, AND SOLVE FOR THE TERMS THAT PRODUCE IT.
 *
 * The owner's words: "figure out the projected revenue vs the actual and create
 * some formula that adjusts the revenue to match, because it's off by the same
 * amount."
 *
 * ## Why the answer is a FIT and not an adjustment
 *
 * An adjustment is a second number beside the first, and the two drift the
 * moment anything changes — a new month, a rate change, a quieter week. The app
 * already has a model with three knobs (commission, card percentage, card flat
 * charge) and every one of them is a guess until somebody checks it against a
 * statement. So rather than bolt a correction on the end, this reads the
 * statement and works out what the knobs must have been. Set them and the
 * revenue matches by construction, for that window and every future one on the
 * same terms.
 *
 * ## THE FIRST THING IT CHECKS IS NOT THE RATE
 *
 * `sales − commission − processing` is what the platform says it paid. The
 * ledger already knows what it actually paid, because that is the column that
 * was uploaded. If those two do not agree, THE WINDOW IS WRONG — the statement
 * covers different days from the ones being compared — and no rate on earth
 * fixes it. That check comes first and is reported first, because a fortnight
 * went into hunting a rate error that a window mismatch was producing.
 *
 * ## "Off by the same amount" is a diagnosis
 *
 * A commission error is a PERCENTAGE: it scales with the money, so a month at a
 * third of the volume is out by roughly a third as much. A gap that stays about
 * the same while volume falls is not a percentage — it is something charged per
 * ORDER. The card flat charge is the only per-order term in the model, and a
 * platform that charges no flat fee against an app configured for thirty cents
 * produces exactly that signature. `perOrderGap` below is what makes it legible:
 * divide the miss by the orders and see whether the two windows agree on it.
 */

/**
 * The one dependency this otherwise-standalone module takes.
 *
 * The band is imported rather than restated because the fit must never OFFER a
 * rate that saving it would then refuse. Two copies of "what counts as a fee
 * schedule" drift, and the day they do, this hands somebody a number, the save
 * rejects it, and nothing on screen explains why the app disagreed with itself.
 */
import { COMMISSION_RATE_MAX, COMMISSION_RATE_MIN } from './financeStreaming'

/** What the platform's own statement says, typed off the document. */
export interface StatementActuals {
  /** The statement's Sales line — what buyers paid, before anything came off. */
  sales: number
  /** Commission, as a POSITIVE number however the statement prints it. */
  commission: number
  /** Payment processing, positive. */
  processing: number
}

/** What the app holds for the same window, off the ledger it imported. */
export interface WindowFigures {
  /** The ledger's own Amount for the sale rows. A record, not a model. */
  netPaid: number
  /** What the app currently derives as gross. */
  derivedRevenue: number
  /** Negative, as the app stores it. */
  derivedCommission: number
  /** Negative. */
  derivedProcessing: number
  /** Orders the fee model charged in this window. */
  orders: number
}

export interface StatementFit {
  /** sales − commission − processing: what the statement says it paid out. */
  statementNet: number
  /** statementNet − netPaid. Zero means the two are looking at the same days. */
  windowGap: number
  /**
   * ARE THE APP AND THE STATEMENT EVEN COVERING THE SAME DAYS?
   *
   * The gate on everything below. False means the comparison is meaningless and
   * no rate can rescue it, so the fit is not offered.
   */
  sameWindow: boolean
  /** derivedRevenue − sales. Positive means the app reads high. */
  revenueGap: number
  /** How much of the revenue gap each order accounts for. See the header. */
  perOrderGap: number | null
  /** The commission rate the statement implies, as a fraction. */
  fittedCommissionRate: number
  /** The card percentage it implies, on the tax-inclusive order total. */
  fittedProcessingRate: number
  /**
   * The card flat charge the fit assumes, in cents.
   *
   * ZERO, and deliberately. One window is one equation and the card charge has
   * two unknowns in it, so something has to be pinned or the answer is a line
   * rather than a point. Zero is the right thing to pin because it is the
   * falsifiable one: fit at zero, and if the residual below is not a rounding
   * error then a flat charge does exist and its size is what is left over.
   */
  fittedProcessingFlatCents: number
  /** Revenue re-derived at the fitted terms. */
  refitRevenue: number
  /** refitRevenue − sales. A few cents is rounding; more is a real per-order term. */
  residual: number
  /** residual ÷ orders — the flat charge the residual implies, in cents. */
  impliedFlatCents: number | null
}

const c2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100
const n = (v: number | null | undefined): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
/** Cents, so a comparison of two money figures is never a float comparison. */
const cents = (v: number): number => Math.round(n(v) * 100)

/**
 * The divisor the app's model works backwards through.
 *
 * payout = item − item×commission − (item×(1+tax))×processing − flat
 *        = item × (1 − commission − processing×(1+tax)) − flat
 *
 * so item = (payout + flat) ÷ this. One place, so the fit and the check below
 * cannot disagree about the arithmetic they are fitting.
 */
export function modelDivisor(
  commissionRate: number,
  processingRate: number,
  taxRate: number
): number {
  return 1 - n(commissionRate) - n(processingRate) * (1 + n(taxRate))
}

/**
 * Solve the model's terms from one statement window.
 *
 * `taxRate` is taken as given rather than fitted: it is the state's number, the
 * operator knows it, and it appears in the model only because the card charge is
 * levied on a total that includes it. Fitting it would let a tax error hide
 * inside a fee rate.
 */
export function fitStatement(
  actual: StatementActuals,
  app: WindowFigures,
  taxRate: number
): StatementFit {
  const sales = c2(n(actual.sales))
  const commission = Math.abs(c2(n(actual.commission)))
  const processing = Math.abs(c2(n(actual.processing)))
  const netPaid = c2(n(app.netPaid))
  const orders = Math.max(0, Math.round(n(app.orders)))

  const statementNet = c2(sales - commission - processing)
  const windowGap = c2(statementNet - netPaid)
  // A CENT EITHER WAY IS THE SAME WINDOW. Two systems rounding the same money
  // will differ by rounding; a genuine period mismatch is never one cent.
  const sameWindow = Math.abs(cents(windowGap)) <= 1

  const revenueGap = c2(n(app.derivedRevenue) - sales)

  // A rate can only be solved from a window that actually has sales in it.
  const fittedCommissionRate = sales > 0 ? commission / sales : 0
  const taxed = sales * (1 + n(taxRate))
  const fittedProcessingRate = taxed > 0 ? processing / taxed : 0

  const divisor = modelDivisor(fittedCommissionRate, fittedProcessingRate, taxRate)
  // A divisor at or below zero means the fitted fees swallow the whole sale,
  // which is not a fee schedule — it is a typo in one of the three boxes.
  const refitRevenue = divisor > 0 ? c2(netPaid / divisor) : 0
  const residual = c2(refitRevenue - sales)

  return {
    statementNet,
    windowGap,
    sameWindow,
    revenueGap,
    perOrderGap: orders > 0 ? Math.round((revenueGap / orders) * 100) / 100 : null,
    fittedCommissionRate,
    fittedProcessingRate,
    fittedProcessingFlatCents: 0,
    refitRevenue,
    residual,
    impliedFlatCents: orders > 0 ? Math.round((residual / orders) * 100) : null
  }
}

/**
 * What the fit is telling somebody to do next, in one sentence.
 *
 * Ordered by what has to be true before the next thing is worth reading: the
 * window before the rate, the rate before the leftovers. A screen that offered
 * all three at once would invite fixing the third while the first was wrong.
 */
export function fitVerdict(fit: StatementFit): {
  tone: 'bad' | 'warn' | 'good'
  headline: string
  detail: string
} {
  if (!fit.sameWindow) {
    const dir = fit.windowGap > 0 ? 'more' : 'less'
    return {
      tone: 'bad',
      headline: 'These are not the same days.',
      detail:
        `The statement says it paid out ${money(fit.statementNet)}; the ledger for this window ` +
        `holds ${money(fit.statementNet - fit.windowGap)} — ${money(Math.abs(fit.windowGap))} ${dir}. ` +
        'Nothing about the fee rate can close a gap like that. Match the dates to the ' +
        'statement period first — platform statements often do not run to a calendar month.'
    }
  }
  // Under a dollar over a whole period is per-row rounding, not a term.
  if (Math.abs(fit.residual) < 1) {
    return {
      tone: 'good',
      headline: 'These terms reproduce the statement exactly.',
      detail:
        `At ${pct(fit.fittedCommissionRate)} commission and ${pct(fit.fittedProcessingRate)} card ` +
        `fee, the ledger grosses up to ${money(fit.refitRevenue)} against a stated ` +
        `${money(fit.refitRevenue - fit.residual)}. Save these as a rate period and the revenue ` +
        'for every night in this window matches the statement.'
    }
  }
  const flat = fit.impliedFlatCents
  return {
    tone: 'warn',
    headline: 'The percentages fit, but something per-order is left over.',
    detail:
      `Fitting the two rates leaves ${money(Math.abs(fit.residual))} unaccounted for` +
      (flat !== null
        ? ` across ${fit.perOrderGap !== null ? 'these' : 'the'} orders — about ${flat}¢ each. ` +
          'That is the signature of a flat per-order charge: set the card flat charge to ' +
          `${Math.abs(flat)}¢ and the rest should close.`
        : '. Check the three figures typed above against the statement.')
  }
}

const money = (v: number): string =>
  `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (v: number): string => `${(v * 100).toFixed(3).replace(/\.?0+$/, '')}%`

/* ===========================================================================
   FITTING FROM A GROSS FIGURE ALONE

   `fitStatement` above needs three numbers off a statement — sales, commission
   and processing — and solves both rates at once. That is the right tool when
   somebody is holding a real statement.

   It is the wrong tool for the case that actually comes up. Whatnot's dashboard
   states SALES and nothing else, and a 1099 states gross and nothing else. An
   owner looking at "your revenue says $320k, Whatnot says $307k" has exactly one
   number to offer, and until now there was nowhere to put it.

   One number is still enough, because the window is not one equation with three
   unknowns — the ledger already supplies the answer to two of them. The net is a
   RECORD: it is the column that was uploaded and it reconciles to the bank. The
   order count is a record too. So the only unknown left is the commission rate,
   and one equation solves it.

   ## Why commission and not the card rate

   Both would fit. Commission is the one to solve for because it is the one that
   varies: it is negotiated, it changes when terms are renegotiated, and it
   differs by what is being sold. The card rate is a processor's published number
   that a marketplace does not get to negotiate per seller, and pinning the term
   that does not move is what makes the answer a point rather than a line.

   That is the same argument `fitStatement` makes for pinning the flat charge at
   zero, applied to the axis this call has evidence about.
   =========================================================================== */

/** The terms held fixed while the commission is solved. */
export interface PinnedTerms {
  processingRate: number
  taxRate: number
  processingFlatCents: number
}

export interface GrossFit {
  /** What the platform says the window sold. Typed in, not derived. */
  statedGross: number
  /** The ledger's own Amount for the same window. A record. */
  netPaid: number
  orders: number
  /** What the app derives for this window today. */
  derivedRevenue: number
  /** derivedRevenue − statedGross. POSITIVE MEANS THE APP READS HIGH. */
  revenueGap: number
  /** How much of the gap each order accounts for. See `gapShape`. */
  perOrderGap: number | null
  /**
   * The commission rate that reproduces `statedGross` exactly.
   *
   *   net   = gross × (1 − commission − processing × (1 + tax)) − flat × orders
   *   ⇒ commission = 1 − processing × (1 + tax) − (net + flat × orders) ÷ gross
   */
  fittedCommissionRate: number
  /**
   * Did the pair produce a rate a fee schedule could actually have?
   *
   * False is not a rounding complaint. A rate outside the band means the two
   * numbers cannot both be describing the same window, and the fitted figure
   * must not be offered for saving — it would silently re-price every night it
   * covered with a number derived from a mismatch.
   */
  solvable: boolean
  /** What went wrong, in the owner's words, when `solvable` is false. */
  problem: string | null
  /** Revenue re-derived at the fitted rate. Lands on `statedGross`. */
  refitRevenue: number
}

/**
 * IS THE MISS A PERCENTAGE OR IS IT PER ORDER?
 *
 * The single most useful thing a gap can tell you, and it is the same question
 * in both fits, so it is asked in one place.
 *
 * A commission error scales with the money: halve the volume and the gap halves.
 * A per-order charge does not — it tracks the order COUNT, so a quiet month is
 * out by nearly as much as a busy one. Comparing two windows of different sizes
 * on `perOrderGap` is what separates them, and getting it backwards sends
 * somebody hunting a rate error that a flat charge is producing (or the reverse,
 * which is how a fortnight was lost once already — see the header).
 */
export function gapShape(
  gap: number,
  orders: number
): { perOrder: number | null; hint: string } {
  const per = orders > 0 ? Math.round((gap / orders) * 100) / 100 : null
  if (per === null) return { perOrder: null, hint: 'No orders in this window.' }
  return {
    perOrder: per,
    hint:
      `${money(gap)} across ${orders.toLocaleString()} orders is ${money(per)} each. ` +
      'Check a second window of a different size: a gap that holds this per-order ' +
      'figure is a flat charge, and one that moves with the money is the commission.'
  }
}

/**
 * Solve the commission rate from one stated gross figure.
 *
 * Refuses rather than returns nonsense. Two impossibilities are checked before
 * the arithmetic, because both produce a plausible-looking rate that is wrong:
 *
 *   · A stated gross at or below the net. Gross is what buyers paid and net is
 *     what survived the fees, so gross is always the larger. Equal or smaller
 *     means the window does not match, or the two figures were entered the wrong
 *     way round — and the division would hand back a negative rate.
 *   · A fitted rate outside the band the model validates elsewhere. There is no
 *     fee schedule at 60%, so a fit that lands there is evidence about the
 *     inputs rather than about the platform.
 */
export function fitFromGross(
  statedGross: number,
  app: Pick<WindowFigures, 'netPaid' | 'derivedRevenue' | 'orders'>,
  pinned: PinnedTerms
): GrossFit {
  const gross = c2(n(statedGross))
  const netPaid = c2(n(app.netPaid))
  const derivedRevenue = c2(n(app.derivedRevenue))
  const orders = Math.max(0, Math.round(n(app.orders)))
  const revenueGap = c2(derivedRevenue - gross)
  const shape = gapShape(revenueGap, orders)

  const base = {
    statedGross: gross,
    netPaid,
    orders,
    derivedRevenue,
    revenueGap,
    perOrderGap: shape.perOrder
  }

  if (gross <= 0) {
    return {
      ...base,
      fittedCommissionRate: 0,
      solvable: false,
      problem: 'Enter the sales figure the platform states for this window.',
      refitRevenue: 0
    }
  }
  if (gross <= netPaid) {
    return {
      ...base,
      fittedCommissionRate: 0,
      solvable: false,
      problem:
        `The stated ${money(gross)} is not more than the ${money(netPaid)} the ledger says was ` +
        'paid out. Gross is what buyers paid and net is what survived the fees, so gross is ' +
        'always larger — these two are not describing the same days.',
      refitRevenue: 0
    }
  }

  // net = gross × divisor − flat × orders, solved for the commission in divisor.
  const flatDollars = (Math.max(0, n(pinned.processingFlatCents)) * orders) / 100
  const impliedDivisor = (netPaid + flatDollars) / gross
  const fitted = 1 - n(pinned.processingRate) * (1 + n(pinned.taxRate)) - impliedDivisor
  const rate = Math.round(fitted * 1e6) / 1e6

  if (rate < COMMISSION_RATE_MIN || rate > COMMISSION_RATE_MAX) {
    return {
      ...base,
      fittedCommissionRate: rate,
      solvable: false,
      problem:
        `Those two figures imply a commission of ${pct(rate)}, which is not a fee schedule. ` +
        'Check that the stated figure covers exactly the days in this window, and that it is ' +
        'sales rather than payouts.',
      refitRevenue: 0
    }
  }

  const divisor = modelDivisor(rate, pinned.processingRate, pinned.taxRate)
  const refitRevenue = divisor > 0 ? c2((netPaid + flatDollars) / divisor) : 0

  return {
    ...base,
    fittedCommissionRate: rate,
    solvable: true,
    problem: null,
    refitRevenue
  }
}

/** What the gross fit is telling somebody to do next, in one sentence. */
export function grossFitVerdict(fit: GrossFit): {
  tone: 'bad' | 'warn' | 'good'
  headline: string
  detail: string
} {
  if (!fit.solvable) {
    return {
      tone: 'bad',
      headline: 'These two figures cannot both be right.',
      detail: fit.problem ?? 'Check the figure entered against the window selected.'
    }
  }
  // Under a dollar over a whole period is per-row rounding, not a term.
  if (Math.abs(fit.revenueGap) < 1) {
    return {
      tone: 'good',
      headline: 'Revenue already matches the stated figure.',
      detail:
        `The app derives ${money(fit.derivedRevenue)} against a stated ${money(fit.statedGross)}. ` +
        'The rates in force for these days are reproducing the platform’s own number.'
    }
  }
  const dir = fit.revenueGap > 0 ? 'higher than' : 'lower than'
  return {
    tone: 'warn',
    headline: `Revenue reads ${money(fit.revenueGap)} ${dir} the stated figure.`,
    detail:
      `A commission of ${pct(fit.fittedCommissionRate)} reproduces ${money(fit.statedGross)} ` +
      `exactly from the ${money(fit.netPaid)} the ledger says was paid out. ` +
      gapShape(fit.revenueGap, fit.orders).hint
  }
}

/* ===========================================================================
   A STATED FIGURE, KEPT

   These live in the contract rather than beside their repository because the
   bridge carries them, and the bridge is bundled into a browser where nothing
   from `src/main` can follow it.
   =========================================================================== */

export interface WhatnotStatement {
  id: string
  /** Inclusive business days — the same dating rate periods and shows use. */
  fromDate: string
  toDate: string
  /** What the platform says the window sold, before anything came off. */
  statedGross: number
  /** What it says came off, when the document says. Null is ordinary. */
  statedFees: number | null
  /**
   * WHAT ACTUALLY LEFT THE PLATFORM AND LANDED IN THE BANK.
   *
   * The owner, sending a July statement beside a screen reading $24k higher:
   * "the things I am uploading is what we get in our account, so that is the
   * most important part, since it is that minus COGS to profit."
   *
   * ## The only figure on a statement that is not a modelled anything
   *
   * Sales is a total the platform computed. Fees are its own arithmetic. The
   * PAYOUT is cash that moved — and the app has a number of the same kind, the
   * sum of the ledger's Amount column, which is recorded per row rather than
   * derived. Comparing those two isolates the question every other comparison
   * confounds: is the app holding the right SET OF ROWS, before anything is
   * asked about whether it prices them correctly.
   *
   * That distinction is what a fitted commission cannot make. If the ledger
   * holds more money than the statement's window covers, no rate reproduces the
   * stated sales — `fitFromGross` returns a negative commission and says the
   * figures cannot both be right, which is true but does not say which one to go
   * and look at. This does.
   *
   * Null is ordinary: a dashboard reading states sales alone.
   */
  statedPayout: number | null
  note: string
  createdAt: string
  updatedAt: string
}

export interface StatementInput {
  id?: string
  fromDate: string
  toDate: string
  statedGross: number
  statedFees?: number | null
  statedPayout?: number | null
  note?: string
}

/**
 * THE LEDGER'S OWN MONEY AGAINST THE MONEY THAT MOVED.
 *
 * Both sides are recorded rather than modelled — Σ of the ledger's Amount
 * column, and the platform's payout — so this comparison has no fee schedule in
 * it and cannot be wrong for the reasons a fitted rate can.
 *
 * ## What a gap means, and why it is checked FIRST
 *
 * The two are not expected to match to the cent. Between them sit the costs a
 * statement lists separately and the ledger has already had taken off — seller
 * paid shipping, boosts, refunds, surcharges — and the timing difference of a
 * payout cycle that does not end on the last day of the month.
 *
 * What matters is the SIZE. Those costs are ordinarily a fraction of a percent,
 * so a gap of several percent is not shipping: it is the window, or the rows.
 * Either the statement covers different days from the ones on screen, or the
 * import holds orders the statement does not. Both are answerable; a fitted
 * commission is not, and quietly re-pricing the month to close a hole of that
 * size would bury the very thing worth finding.
 */
export interface PayoutCheck {
  statedPayout: number
  /** Σ of the ledger's Amount column across the window. */
  netPaid: number
  /** netPaid − statedPayout. POSITIVE MEANS THE LEDGER HOLDS MORE. */
  gap: number
  /** The gap as a share of what the platform paid. */
  gapShare: number
  /**
   * Is the gap too big to be the costs a statement lists separately?
   *
   * Two percent, and the number is a judgement rather than a derivation — said
   * so here rather than buried in a screen. Shipping, boosts and refunds on a
   * real month came to half a percent of the payout; the gap that prompted this
   * was seven. Anything in between is worth a look either way, which is what the
   * sentence says.
   */
  material: boolean
  sentence: string
}

const share = (a: number, b: number): number => (b === 0 ? 0 : a / b)

/** The gap that means "look at the window", above which it cannot be shipping. */
export const PAYOUT_GAP_LIMIT = 0.02

export function payoutCheck(netPaid: number, statedPayout: number): PayoutCheck {
  const paid = c2(n(statedPayout))
  const net = c2(n(netPaid))
  const gap = c2(net - paid)
  const gapShare = share(Math.abs(gap), paid)
  const material = gapShare > PAYOUT_GAP_LIMIT
  const sentence = material
    ? gap > 0
      ? `The ledger holds ${money(gap)} MORE than this statement paid out — ${(gapShare * 100).toFixed(1)}% of it. ` +
        'Shipping, boosts and refunds are a fraction of a percent, so a gap this size is the window or the rows: ' +
        'check that the statement covers exactly these days, and that it is not a payout cycle running to a different cutoff.'
      : `This statement paid out ${money(-gap)} MORE than the ledger holds — ${(gapShare * 100).toFixed(1)}% of it. ` +
        'That usually means nights are missing from the import, or the statement covers days beyond the ones on screen.'
    : gap === 0
      ? 'The ledger and the payout agree exactly.'
      : `The ledger is within ${money(Math.abs(gap))} of what was paid out, which is the size of ` +
        'shipping, boosts and refunds — nothing here needs chasing.'
  return { statedPayout: paid, netPaid: net, gap, gapShare, material, sentence }
}

/** What the revenue-check panel needs, in one read. */
export interface RevenueCheck {
  fromDate: string
  toDate: string
  /** False when the window holds no money at all — nothing to check. */
  hasData: boolean
  fit: GrossFit
  verdict: { tone: 'bad' | 'warn' | 'good'; headline: string; detail: string }
  /** The terms held fixed while the commission was solved. */
  pinned: PinnedTerms
  /**
   * Do all the nights in this window share one set of card terms?
   *
   * A single fitted commission assumes they do. When they do not, the fit is
   * still the best single answer available but it is an average of two regimes,
   * and saying so is cheaper than letting somebody act on it believing
   * otherwise.
   */
  mixedTerms: boolean
  /** Nights priced at the built-in defaults rather than a chosen period. */
  uncoveredDays: number
  uncoveredNetPaid: number
  /**
   * THE LEDGER'S MONEY AGAINST THE MONEY THAT MOVED — read before the fit.
   *
   * Null when the statement does not state a payout. When it does, this is the
   * check that runs first, because both sides of it are recorded rather than
   * modelled: a gap here means the app is holding the wrong set of rows, and no
   * commission rate can be right until that is settled. See payoutCheck.
   */
  payout: PayoutCheck | null
}

