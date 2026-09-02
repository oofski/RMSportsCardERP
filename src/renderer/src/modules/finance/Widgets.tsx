import { useMemo } from 'react'
import type { StreamFinanceTotals } from '@shared/financeStreaming'
import { profitMargin } from '@shared/financeStreaming'
import type { CheckWindow, CoveringStatement } from '@shared/pnlRecon'
import { revenueStanding } from '@shared/pnlRecon'
import { Icon } from '../../components/Icon'
import { Money, moneyText } from './bits'
import { buildStatement, pnlDrift, sectionSubtotal } from './Pnl'

/**
 * The four figures the business is run on, as widgets over whatever range is
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
 * if they do not reconcile to net profit, the row says so instead of printing
 * four confident numbers that quietly refuse to add up.
 *
 * The order is the order of the statement — revenue, what the goods cost, what
 * the platform took, what was left — so reading left to right is reading the
 * P&L top to bottom.
 *
 * THERE IS NO SHIPPING WIDGET, because there is no shipping section: the owner
 * took postage off the P&L pending another treatment of the cost. Reading it
 * from `totals.shippingSubsidy` and friends instead would have kept the tile
 * alive on the very screen the statement had stopped mentioning postage on,
 * which is worse than either answer on its own.
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
  /**
   * A note on the FACE of the tile about where its figure came from, with the
   * long version in the tooltip.
   *
   * NEUTRAL, and that is the entire design. The tile carrying one is not WRONG,
   * it is DERIVED — a different thing, and true of it every single day. A red
   * badge on a figure that is usually fine is a badge the owner learns to look
   * past inside a week, and then it is worth nothing on the day the figure
   * really is wrong. So it reads at --text-2, like the label beside it: a fact
   * about where the number came from, not an alarm about its value. The loud
   * styling on this row belongs to the checksum failure, which means the
   * figures do not add up at all.
   */
  chip?: { text: string; why: string }
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
  priorLabel,
  againstWhatnot
}: {
  totals: StreamFinanceTotals
  /** The equivalent window immediately before this one, or null for all-time. */
  prior: StreamFinanceTotals | null
  priorLabel: string | null
  /**
   * EVERYTHING NEEDED TO CHECK THE TOP LINE AGAINST WHATNOT — except the figure
   * itself, which this component owns and which is deliberately NOT passed in.
   *
   * The derived revenue used below is `revenue`, the same variable the tile
   * prints. Hand a component a window and a set of statements and it can only
   * say something about the number it is already showing; hand it a
   * pre-computed answer and the day someone derives "revenue" a second way
   * upstream, the sentence quietly starts quoting a figure different from the
   * one directly above it. A screen that contradicts itself is worth less than
   * a blank one.
   */
  againstWhatnot: {
    /** The selected range, already judged fit or unfit to compare against. */
    window: CheckWindow
    /** Every figure ever saved off a Whatnot statement. Empty is ordinary. */
    statements: readonly CoveringStatement[]
  }
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
  // dilute the rate on any day with a tip and understate what the platform
  // costs. And gross rather than net, because the net is what is left AFTER the
  // fees; dividing by it would report a bigger take than was charged. It is a
  // share of the sales line, not one of the configured rates — neither of those
  // is charged on this base.
  const feeRate = totals.grossSales > 0 ? (Math.abs(fees) / totals.grossSales) * 100 : null
  const cogsRate = revenue > 0 ? (Math.abs(sub('cogs')) / revenue) * 100 : null
  const margin = profitMargin(revenue, net)

  /**
   * WHERE THE TOP LINE STANDS AGAINST WHATNOT'S OWN FIGURE FOR THE SAME DAYS.
   *
   * Every other figure on this row can be checked against something. Net paid is
   * the ledger's own Amount column, cost of goods is what the stock cost, and
   * the checksum below proves the four of them reconcile to the stored net
   * profit. Revenue is the one with nothing behind it but a rate somebody typed
   * — and because the same modelled fee is subtracted again two sections down,
   * getting that rate wrong moves this tile and leaves net profit identical to
   * the cent, which is precisely why nothing ever caught it. The row printed all
   * four in the same weight and said none of that out loud.
   *
   * The sentence is built in @shared/pnlRecon and not here, on purpose: a
   * component that assembles it out of a state and two numbers will eventually
   * assemble one the numbers do not support. This prints what it is handed.
   */
  const standing = useMemo(
    // GROSS SALES, NOT THE REVENUE SUBTOTAL, and the distinction is the whole
    // difference between a check and a second opinion nobody asked for.
    //
    // Whatnot's stated figure is what the window SOLD. The revenue subtotal on
    // the tile beside this is grossSales PLUS tips, seller bonuses and
    // unrecognised rows — money that arrives whole and was never a sale. Feeding
    // that in compares two different quantities and calls the difference a
    // discrepancy: a July that agrees with Whatnot to the cent reads as 2.7% out
    // because $8,000 of tips landed in the same month, and the Fees & rates
    // screen — which passes grossSales — calls the very same statement a match.
    // Two screens contradicting each other about one document is the exact
    // failure this whole feature exists to end.
    //
    // `feeRate` directly above already refuses total revenue for its denominator
    // and says why. Same reason, same base.
    () => revenueStanding(againstWhatnot.window, againstWhatnot.statements, totals.grossSales),
    [againstWhatnot, totals.grossSales]
  )

  const widgets: Widget[] = [
    {
      key: 'revenue',
      label: 'Total revenue',
      amount: revenue,
      prior: priorSub('revenue'),
      goodWhenUp: true,
      // WORKED OUT, not stated. Whatnot's export gives one money column and it
      // is what they PAID; this figure is that column with the modelled fees put
      // back on top, so it is the app's arithmetic and not the platform's
      // assertion. Two words on the tile and the whole reason in the tooltip,
      // because the tile is the thing somebody is looking at when the question
      // occurs to them. Neutral by construction — see `chip` on the interface
      // above for why this must never be dressed as a warning.
      chip: {
        text: 'worked out',
        why:
          'Whatnot’s export states only what it paid. This is that figure with the modelled ' +
          'fees added back — it is not a number Whatnot stated.'
      },
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
      // what is lost in fees, and the two halves are charged on different bases —
      // the commission on the sale price, card processing on the whole order
      // including the sales tax the buyer paid, plus a flat charge per order.
      // Both are configurable by date on the Rates tab. One combined figure
      // hides which of them moved.
      sub:
        isZero(totals.whatnotFee) && isZero(totals.processingFee) ? (
          "Whatnot's cut and card processing"
        ) : (
          <>
            {moneyText(Math.abs(totals.whatnotFee))} commission ·{' '}
            {moneyText(Math.abs(totals.processingFee))} processing
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

      {/* ONE LINE, and it prints the sentence it was given and nothing else.
          SECOND TO LAST ON PURPOSE. The drift line below is the harder failure —
          the figures do not add up, so nothing on this row means what it says —
          and it stays last and loudest. This one is quieter and always present:
          it says whether anybody has ever checked the top line against the
          document it is modelling, and it says so in the same weight whatever
          the answer is, 'disagrees' included. A line that shouts on the bad days
          is a line that gets skipped on all the others, and the sentence itself
          is emphatic enough without help from the styling. */}
      <p className="fin-widgets-standing">{standing.sentence}</p>

      {!check.ok && (
        <p className="fin-widgets-drift" role="alert">
          <Icon name="AlertTriangle" size={14} />
          These five come to <Money value={check.checksum} strong />,{' '}
          <Money value={check.drift} strong /> off the stored net profit. Update the app and
          re-import.
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
      {/* The chip lives INSIDE the label rather than in a band of its own. The
          four widgets share four subgrid rows so their figures line up, and a
          fifth row would be blank on three of the four cards — the label simply
          wraps instead, which it is already built to do. */}
      <span className="fin-widget-label">
        {widget.label}
        {widget.chip ? (
          <span className="fin-widget-derived" title={widget.chip.why}>
            {widget.chip.text}
          </span>
        ) : null}
      </span>
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
