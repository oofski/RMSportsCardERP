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
