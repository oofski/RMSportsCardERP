import { useMemo } from 'react'
import type { StreamFinanceTotals } from '@shared/financeStreaming'
import { profitMargin } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { Money, moneyText } from './bits'
import { buildStatement, pnlDrift, sectionSubtotal } from './Pnl'

/**
 * The five figures the business is run on, as widgets over whatever range is
 * selected on the calendar.
 *
 * WHY THIS REPLACED THE EQUATION STRIP. The strip printed the same five terms
 * joined by −, − , − , = so the arithmetic could be checked by eye. It closed,
 * and it was still the wrong object: it described the WHOLE ledger and never
 * anything else, so the only way to ask "what did last week make" was to scroll
 * past it to a statement that answered a different question. The equation is now
 * the statement below — which is where an equation belongs, laid out vertically
 * with its lines — and this row is what an operator glances at, tied to a range
 * they picked.
 *
 * WHAT IS PRESERVED. Every figure here is still a SECTION SUBTOTAL from
 * `buildPnl`, not a field read off the totals, so a widget and the statement
 * under it cannot mean different things by "fees". The checksum is still run:
 * if the five do not reconcile to net profit, the row says so instead of
 * printing five confident numbers that quietly refuse to add up.
 *
 * The order is the order of the statement — revenue, what the goods cost, what
 * the platform took, what shipping did, what was left — so reading left to
 * right is reading the P&L top to bottom.
 */

/** Anything below half a cent is zero. */
const isZero = (n: number): boolean => Math.abs(n) < 0.005

interface Widget {
  key: string
  label: string
  /** Signed, exactly as the statement books it. */
  amount: number
  prior: number | null
  sub: JSX.Element | string | null
  /** The bottom line gets the green/red ramp. A cost is not a loss, so nothing
   *  else does — costs print neutral and negative, the way a statement does. */
  bottomLine?: boolean
  /** Whether a rise in the SIGNED figure is unambiguously good. Costs are left
   *  undefined: fees rising because sales rose is not a regression, and an arrow
   *  that called it one would be worse than no arrow. */
  goodWhenUp?: boolean
  /**
   * Compare MAGNITUDES rather than signed values.
   *
   * For a cost line the operator's question is "did we pay more or less", and
   * these figures are negative — so a signed comparison put a DOWN arrow on
   * fees that had gone up by 115%, beside revenue's up arrow for the same
   * period. Technically right, and read by everyone as "fees fell". On a cost
   * widget, up means more.
   */
  magnitude?: boolean
}

export function RangeWidgets({
  totals,
  prior,
  priorLabel
}: {
  totals: StreamFinanceTotals
  /** The equivalent window immediately before this one, or null for all-time. */
  prior: StreamFinanceTotals | null
  priorLabel: string | null
}): JSX.Element {
  const sections = useMemo(() => buildStatement(totals), [totals])
  const priorSections = useMemo(() => (prior ? buildStatement(prior) : null), [prior])
  const check = useMemo(() => pnlDrift(sections, totals.netProfit), [sections, totals.netProfit])

  const sub = (key: string): number => sectionSubtotal(sections, key)
  const priorSub = (key: string): number | null =>
    priorSections ? sectionSubtotal(priorSections, key) : null

  const revenue = sub('revenue')
  const fees = sub('fees')
  const net = sub('netProfit')

  // Denominator is GROSS SALES, not total revenue: fees are only ever charged on
  // sales — tips and bonuses arrive whole — so dividing by total revenue would
  // dilute the rate on any day with a tip and understate what Whatnot costs. And
  // gross rather than net, because that is the base the two rates are applied
  // to; dividing by the net Whatnot paid would report 9.8% for a 8.9% take.
  const feeRate = totals.grossSales > 0 ? (Math.abs(fees) / totals.grossSales) * 100 : null
  const cogsRate = revenue > 0 ? (Math.abs(sub('cogs')) / revenue) * 100 : null
  const margin = profitMargin(revenue, net)

  const widgets: Widget[] = [
    {
      key: 'revenue',
      label: 'Total revenue',
      amount: revenue,
      prior: priorSub('revenue'),
      goodWhenUp: true,
      sub:
        totals.saleCount > 0
          ? `${totals.saleCount.toLocaleString()} sales across ${totals.sessionCount.toLocaleString()} ${
              totals.sessionCount === 1 ? 'show' : 'shows'
            }`
          : 'sales, tips and bonuses'
    },
    {
      key: 'fees',
      label: 'Platform fees',
      amount: fees,
      prior: priorSub('fees'),
      magnitude: true,
      // THE SPLIT, on the face of the widget. The owner's ask was to still see
      // what is lost in fees, and the two halves are set by different parties —
      // Whatnot's commission is a term of the seller agreement and configurable
      // by date on the Rates tab; Stripe's 2.9% + 30c is a published card rate
      // nobody here negotiates. One combined figure hides which of those moved.
      sub:
        isZero(totals.whatnotFee) && isZero(totals.processingFee) ? (
          "Whatnot's cut and card processing"
        ) : (
          <>
            {moneyText(Math.abs(totals.whatnotFee))} Whatnot ·{' '}
            {moneyText(Math.abs(totals.processingFee))} Stripe
            {feeRate === null ? null : ` · ${feeRate.toFixed(2)}% of gross`}
          </>
        )
    },
    {
      key: 'cogs',
      label: 'Cost of goods sold',
      amount: sub('cogs'),
      prior: priorSub('cogs'),
      magnitude: true,
      sub: cogsRate === null ? 'stock broken and given away' : `${cogsRate.toFixed(1)}% of revenue`
    },
    {
      key: 'shipping',
      label: 'Shipping',
      amount: sub('shipping'),
      prior: priorSub('shipping'),
      // The two sides, because this is the one widget whose sign is genuinely
      // unpredictable — subsidy less postage lands either side of zero from one
      // month to the next, and the figure alone never explains which happened.
      sub: (
        <>
          {moneyText(totals.shippingSubsidy)} subsidy, {moneyText(
            Math.abs(
              totals.shippingCharges + totals.giveawayShipping + totals.refundShipping
            )
          )}{' '}
          postage
        </>
      )
    },
    {
      key: 'net',
      label: 'Net profit',
      amount: net,
      prior: priorSub('netProfit'),
      bottomLine: true,
      goodWhenUp: true,
      sub: margin === null ? null : `${margin.toFixed(1)}% margin`
    }
  ]

  return (
    <div className="fin-widgets" role="group" aria-label="Profit and loss for the selected range">
      {widgets.map((w) => (
        <WidgetCard key={w.key} widget={w} priorLabel={priorLabel} />
      ))}

      {!check.ok && (
        <p className="fin-widgets-drift" role="alert">
          <Icon name="AlertTriangle" size={14} />
          These five do not add up to the stored net profit — they come to{' '}
          <Money value={check.checksum} strong />, which is <Money value={check.drift} strong /> out.
          The app and its data engine were built from different versions of the P&amp;L; update the
          app and re-import before trusting any figure on this screen.
        </p>
      )}
    </div>
  )
}

function WidgetCard({
  widget,
  priorLabel
}: {
  widget: Widget
  priorLabel: string | null
}): JSX.Element {
  const { amount, prior, bottomLine, goodWhenUp } = widget

  const tone = !bottomLine
    ? ''
    : isZero(amount)
      ? 'is-flat'
      : amount > 0
        ? 'is-up'
        : 'is-down'

  return (
    <div className={`fin-widget${bottomLine ? ' is-bottom' : ''}${tone ? ` ${tone}` : ''}`}>
      <span className="fin-widget-label">{widget.label}</span>
      <span className="fin-widget-value">
        {bottomLine ? (
          <span className={`fin-widget-figure mono ${tone}`}>
            {isZero(amount) ? moneyText(0) : amount > 0 ? `+${moneyText(amount)}` : moneyText(amount)}
          </span>
        ) : (
          <span className="fin-widget-figure mono">{moneyText(amount)}</span>
        )}
      </span>
      {/* Both of these are ALWAYS rendered, empty if they have nothing to say.
          The widgets share four subgrid rows so their figures line up, and a
          card that skipped its note would pull its delta up into the note's
          band — the alignment the subgrid exists to guarantee, broken by the
          one card with no margin to print. */}
      <span className="fin-widget-sub">{widget.sub}</span>
      <Delta
        amount={amount}
        prior={prior}
        priorLabel={priorLabel}
        goodWhenUp={goodWhenUp}
        magnitude={widget.magnitude}
      />
    </div>
  )
}

/**
 * Change against the equivalent window before this one.
 *
 * PERCENTAGE OF THE MAGNITUDE, because these figures are signed and a naive
 * percentage change across a sign flip is nonsense — a net profit going from
 * −$400 to +$400 is not "200% up". Both sides are taken as magnitudes and the
 * direction is decided from the signed difference, so a loss that turns into a
 * profit reads as up, which is what it is.
 *
 * Prints NOTHING when the previous window was empty. "+∞%" against zero is not
 * a comparison, and a first week with no week before it should say nothing
 * rather than manufacture a baseline.
 */
function Delta({
  amount,
  prior,
  priorLabel,
  goodWhenUp,
  magnitude
}: {
  amount: number
  prior: number | null
  priorLabel: string | null
  goodWhenUp?: boolean
  magnitude?: boolean
}): JSX.Element {
  // An empty band rather than nothing: see the note above about the subgrid.
  if (prior === null || priorLabel === null) return <span className="fin-widget-delta is-none" />
  if (isZero(prior)) return <span className="fin-widget-delta is-none" />

  // On a cost widget the direction is read off the MAGNITUDES: "more fees" is
  // up even though the signed figure went down. Everywhere else the direction
  // is the signed one, so a loss turning into a profit reads as up.
  const diff = magnitude ? Math.abs(amount) - Math.abs(prior) : amount - prior
  if (isZero(diff)) {
    return (
      <span className="fin-widget-delta is-flat">
        <Icon name="Minus" size={11} />
        level on {priorLabel}
      </span>
    )
  }

  const pct = (Math.abs(diff) / Math.abs(prior)) * 100
  const up = diff > 0
  // Neutral unless the direction has one meaning. Fees rising because sales
  // rose is not a regression, and a red arrow claiming it is would train the
  // operator to ignore the arrows that do mean something.
  const judged = goodWhenUp === undefined ? '' : up === goodWhenUp ? ' is-good' : ' is-bad'

  return (
    <span
      className={`fin-widget-delta${judged}`}
      title={`${moneyText(prior)} in the ${priorLabel}`}
    >
      <Icon name={up ? 'ArrowUp' : 'ArrowDown'} size={11} />
      <b className="mono">{pct >= 999.5 ? '>999' : pct.toFixed(pct < 10 ? 1 : 0)}%</b>
      vs {priorLabel}
    </span>
  )
}
