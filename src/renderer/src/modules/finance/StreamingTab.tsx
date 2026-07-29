import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FinancePeriod, StreamFinanceTotals, StreamingFinanceView } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { useSession } from '../../lib/session'
import { Money, Note, Profit, plural } from './bits'
import { FinanceCalendar } from './FinanceCalendar'
import { ImportPanel } from './ImportPanel'
import { PeriodList } from './PeriodList'
import { UnattributedPanel } from './UnattributedPanel'
import { finance } from './api'

/**
 * `day` still means "the day grain" in the contract; on screen it is the
 * CALENDAR, because at day grain a month of dates laid out as a month is
 * strictly more readable than the same dates in a list.
 */
const PERIODS: Array<{ id: FinancePeriod; label: string; hint: string }> = [
  {
    id: 'day',
    label: 'Calendar',
    hint: 'Every business day on a month grid, with its net profit — click a day for its full statement'
  },
  { id: 'week', label: 'Week', hint: 'The same days summed by week' },
  { id: 'month', label: 'Month', hint: 'The same days summed by calendar month' }
]

/**
 * Finance → Streaming: what the shows actually earned.
 *
 * The whole tab hangs off ONE read. `streamView()` derives the days, the weekly
 * and monthly rollups, the totals, the unattributed pile and the reconciliation
 * verdict in a single pass, so every write here (import, delete, re-attribute)
 * hands back the whole view and this screen replaces its state with it.
 * Refetching the pieces separately would let the calendar and the unattributed
 * panel disagree about the same money — which is precisely the bug the
 * reconciliation flag exists to catch.
 *
 * The shape of the screen follows the shape of the question. "Did we make money
 * on the 24th" is a calendar question, so the calendar is the front door and
 * carries one figure per day: net profit, green or red. "Why" is a statement
 * question, so a day opens into a vertical P&L — revenue, cost of goods, gross
 * profit, fees, shipping, other costs, adjustments, net profit — built by
 * `buildPnl` in the contract rather than laid out here.
 *
 * Cost of goods IS in these figures now. It was not for three releases, which
 * made every "net" number a gross margin wearing a net label; the captions on
 * this screen were rewritten with the arithmetic, because a stale caption on a
 * correct number is its own kind of wrong answer.
 */
export function StreamingTab(): JSX.Element {
  const { can } = useSession()
  const canManage = can('finance.manage')

  const [view, setView] = useState<StreamingFinanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [period, setPeriod] = useState<FinancePeriod>('day')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.streamView()
        if (alive) setView(next)
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'The streaming ledger could not be read.')
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [attempt])

  const applyView = useCallback((next: StreamingFinanceView) => setView(next), [])

  // Only used for the caption, so an older main that returns no rollups shows
  // "0 weeks" rather than throwing on first paint.
  const rowCount = useMemo(() => {
    if (!view) return 0
    const src = period === 'day' ? view.days : period === 'week' ? view.weeks : view.months
    return Array.isArray(src) ? src.length : 0
  }, [view, period])

  if (loading) return <CenterLoader />

  if (error || !view) {
    return (
      <Note tone="danger" icon="AlertTriangle" role="alert">
        <b>The streaming ledger could not be read.</b>
        <p>{error ?? 'Nothing came back.'}</p>
        <Button size="sm" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
      </Note>
    )
  }

  const { totals, imports } = view
  const hasLedger = imports.length > 0
  const grainWord = period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'
  const periodRows = period === 'week' ? view.weeks : view.months

  return (
    <div className="fin-stream">
      {/* Reconciliation first and unconditionally: if the rows do not add up,
          nothing below it means what it says, and the user has to know that
          before they read a single number. */}
      {!view.reconciled && (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <b>These numbers do not add up — do not use them yet.</b>
          <p>
            {view.reconcileNote ??
              'Some rows are neither on a day nor in the unattributed pile, so the totals below are incomplete.'}
          </p>
          <p>
            Re-attributing usually resolves it. If it does not, delete the most recent import and
            upload it again before trusting anything on this screen.
          </p>
        </Note>
      )}

      <ImportPanel imports={imports} canManage={canManage} onView={applyView} />

      {hasLedger && (
        <>
          <UnattributedPanel view={view} canManage={canManage} onView={applyView} />

          <SummaryStrip totals={totals} />

          <section className="fin-days-section">
            <div className="fin-days-head">
              <span className="fin-section-title">
                <Icon name="CalendarDays" size={15} />
                {period === 'day' ? 'Profit by day' : `Profit by ${grainWord}`}
                <span className="fin-count">{rowCount}</span>
              </span>

              <div className="fin-period" role="group" aria-label="Show the profit by">
                {PERIODS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`fin-period-btn${period === p.id ? ' is-on' : ''}`}
                    // aria-pressed, not aria-selected: these are toggle buttons
                    // in a group, not tabs controlling separate panels.
                    aria-pressed={period === p.id}
                    title={p.hint}
                    onClick={() => setPeriod(p.id)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* This caption said "the cost of stock that was sold is not in
                  these figures" for three releases. It is now false in both
                  halves: breaking a case IS the largest cost of running a show
                  and it is booked here, and the bottom line is net profit
                  rather than a revenue figure. A caption that lags the
                  arithmetic is how somebody reads a correct number as the wrong
                  quantity. */}
              <span className="fin-days-scope">
                A full statement: revenue in, the cost of the stock broken and given away,
                Whatnot&rsquo;s fees, shipping both ways, show costs and refunds — down to net
                profit.
              </span>
            </div>

            {rowCount === 0 ? (
              <p className="fin-detail-empty">
                <Icon name="Info" size={14} />
                {view.days.length === 0
                  ? 'The ledger is loaded, but no row matched a logged show, so there is nothing to report yet. Add the sessions listed above in Streaming and re-attribute.'
                  : // Days exist but this rollup does not, which can only mean the
                    // app is running against a version that does not produce it.
                    // Saying so beats "no data", which would read as a real
                    // finding and send someone looking for missing money.
                    `There are days in the calendar, but this build produced no ${grainWord} rollup for them. Switch back to Calendar; ${grainWord}s appear once the app is updated.`}
              </p>
            ) : period === 'day' ? (
              <FinanceCalendar days={view.days} />
            ) : (
              <PeriodList rows={periodRows} period={period} />
            )}
          </section>
        </>
      )}

      {view.reconciled && hasLedger && (
        <p className="fin-reconciled">
          <Icon name="CheckCircle2" size={14} />
          Every row is accounted for: each one is on a day above or in the unattributed list.
        </p>
      )}
    </div>
  )
}

/**
 * Everything, in one line of arithmetic.
 *
 * The left of the rule is the owner's fee model stated the way he states it:
 * total revenue, less the two fees, equals net revenue. It is kept intact
 * because it is the one part of the P&L he checks by eye against Whatnot.
 *
 * The right of the rule is now where the statement ENDS — cost of goods, then
 * net profit as the largest figure on the screen. Net shipping used to sit
 * there and no longer does: it is one section of every statement below and was
 * never the bottom line, whereas net profit was missing entirely from a screen
 * whose whole subject it is.
 *
 * The effective fee rate is the number that gets sanity-checked, so it is
 * printed to two decimals and captioned with its own denominator. A rate whose
 * base is ambiguous is worse than no rate: 6% + 2.9% + 30c a transaction lands
 * near 9.2% of the top line on real data, but only because the flat 30c is
 * charged thousands of times, and the same fees expressed against sales alone
 * would be a different, equally true number.
 */
function SummaryStrip({ totals }: { totals: StreamFinanceTotals }): JSX.Element {
  // Denominator is SALES, not total revenue. Fees are only ever charged on
  // sales — tips and bonuses arrive whole — so dividing by total revenue would
  // quietly dilute the rate on any day with a tip and understate what Whatnot
  // actually costs. The caption names the base so the number can be checked.
  const rate = totals.sales > 0 ? Math.abs(totals.totalFees) / totals.sales : null

  return (
    <section className="fin-summary" aria-label="Streaming revenue summary">
      {/* The three cells of the subtraction are wrapped together so they wrap as
          a unit. Split across two lines they would still be readable, but the
          "−" and "=" between them would not be, and those glyphs are the whole
          point of laying the strip out this way. */}
      <div className="fin-sum-flow">
        <div className="fin-sum">
          <span className="fin-sum-label">Total revenue</span>
          <span className="fin-sum-value">
            <Money value={totals.totalRevenue} strong />
          </span>
          <em className="fin-sum-hint">sales, tips and bonuses, before any deduction</em>
        </div>

        <span className="fin-sum-op" aria-hidden="true">
          −
        </span>

        <div className="fin-sum">
          <span className="fin-sum-label">
            Fees
            {rate !== null && (
              <b className="fin-rate" title="Total fees as a share of sales — fees are charged on sales only">
                {(rate * 100).toFixed(2)}% of sales
              </b>
            )}
          </span>
          <span className="fin-sum-value">
            <Money value={totals.totalFees} strong />
          </span>
          <em className="fin-sum-hint">6% Whatnot, plus 2.9% and 30¢ a transaction</em>
        </div>

        <span className="fin-sum-op" aria-hidden="true">
          =
        </span>

        {/* No longer `is-net`. It is still the answer to THIS subtraction, but
            it stopped being the bottom line of the screen the moment cost of
            goods landed, and two 26px figures would say the statement ends in
            two places. */}
        <div className="fin-sum">
          <span className="fin-sum-label">Net revenue</span>
          <span className="fin-sum-value">
            <Money value={totals.netRevenue} strong />
          </span>
          <em className="fin-sum-hint">what Whatnot actually keeps for you</em>
        </div>
      </div>

      {/* Shipping sits the other side of a rule, never behind an operator: it is
          not part of the fee subtraction and must not look like it is. */}
      <span className="fin-sum-rule" aria-hidden="true" />

      <div className="fin-sum-side">
        <div className="fin-sum">
          <span className="fin-sum-label">Cost of goods</span>
          <span className="fin-sum-value">
            <Money value={totals.cogs} strong />
          </span>
          <em className="fin-sum-hint">the stock broken and given away, at what it cost</em>
        </div>

        <div className="fin-sum is-net">
          <span className="fin-sum-label">Net profit</span>
          <span className="fin-sum-value">
            <Profit value={totals.netProfit} />
          </span>
          <em className="fin-sum-hint">after goods, fees, shipping and every show cost</em>
        </div>

        <div className="fin-sum">
          <span className="fin-sum-label">Streamed</span>
          <span className="fin-sum-value mono">{plural(totals.dayCount, 'day')}</span>
          <em className="fin-sum-hint">
            {plural(totals.sessionCount, 'show')} · {formatDuration(totals.minutes)} on air
          </em>
        </div>
      </div>
    </section>
  )
}
