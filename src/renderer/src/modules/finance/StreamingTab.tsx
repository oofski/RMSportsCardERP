import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  FinancePeriod,
  StreamFinanceTotals,
  StreamingFinanceView
} from '@shared/financeStreaming'
import { profitMargin } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { useSession } from '../../lib/session'
import { Money, Note, Pct, Profit, plural } from './bits'
import { FinanceCalendar } from './FinanceCalendar'
import { ImportPanel } from './ImportPanel'
import { PeriodList } from './PeriodList'
import { UnattributedPanel } from './UnattributedPanel'
import { buildStatement, pnlDrift, sectionSubtotal } from './Pnl'
import { finance } from './api'
import { dayRangeLabel } from './time'

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
 * THE ORDER OF THE PAGE IS THE ORDER OF THE QUESTIONS.
 *
 *   1. Can I trust this at all?  — the reconciliation banner, if it fails.
 *   2. What did we make?         — the equation, closing on net profit.
 *   3. When did we make it?      — the calendar, or weeks, or months.
 *   4. Where did it come from?   — the ledger: what is imported, what is still
 *                                  waiting for a show.
 *
 * That ordering is why the imports moved to the BOTTOM. They used to open the
 * screen, which put file bookkeeping ahead of the P&L on a page whose whole
 * subject is the P&L. They are provenance, and provenance belongs under the
 * thing it backs — except when there is no ledger at all, when the upload is
 * the only thing to do and gets the whole screen.
 *
 * Position within the page is HELD HERE, not inside the calendar and the period
 * list, so switching Calendar → Week → Calendar returns to the same month with
 * the same day still open. State that lives in a component that unmounts is
 * state the user loses for pressing a grain button.
 */
export function StreamingTab(): JSX.Element {
  const { can } = useSession()
  const canManage = can('finance.manage')

  const [view, setView] = useState<StreamingFinanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [period, setPeriod] = useState<FinancePeriod>('day')

  // null means "follow the latest month with money in it" — the calendar's own
  // default. It only becomes a concrete key once the user navigates.
  const [calMonth, setCalMonth] = useState<string | null>(null)
  const [calDay, setCalDay] = useState<string | null>(null)
  // Keyed by grain, so an open week survives a trip through Month and back.
  const [openPeriod, setOpenPeriod] = useState<Partial<Record<FinancePeriod, string | null>>>({})

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

  /**
   * The newest business month the ledger holds.
   *
   * Watched HERE rather than inside the calendar. A fresh import can land
   * months that did not exist a moment ago and following them is right — the
   * operator uploaded a file to look at what is in it — but the calendar
   * unmounts every time the grain changes, so the same effect living there
   * fired on remount and dragged the view back to the newest month every time
   * anyone glanced at Week and returned. This component never unmounts, so the
   * effect fires when the DATA changes and at no other time.
   */
  const latestMonth = useMemo(() => {
    let best = ''
    for (const d of view?.days ?? []) {
      const k = d.streamDate.slice(0, 7)
      if (k > best) best = k
    }
    return best
  }, [view])

  useEffect(() => {
    setCalMonth(null)
    setCalDay(null)
  }, [latestMonth])

  // Only used for the caption, so an older main that returns no rollups shows
  // "0 weeks" rather than throwing on first paint.
  const rowCount = useMemo(() => {
    if (!view) return 0
    const src = period === 'day' ? view.days : period === 'week' ? view.weeks : view.months
    return Array.isArray(src) ? src.length : 0
  }, [view, period])

  // The stretch of business days the figures above actually cover. Taken from
  // the days rather than from the imports' instants: an import can carry rows
  // that matched no show, and a P&L must not claim to cover a day it has
  // nothing on.
  const covered = useMemo(() => {
    if (!view || view.days.length === 0) return null
    let from = view.days[0].streamDate
    let to = from
    for (const d of view.days) {
      if (d.streamDate < from) from = d.streamDate
      if (d.streamDate > to) to = d.streamDate
    }
    return { from, to }
  }, [view])

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

  const { imports } = view
  const hasLedger = imports.length > 0
  const grainWord = period === 'day' ? 'day' : period === 'week' ? 'week' : 'month'
  const periodRows = period === 'week' ? view.weeks : view.months

  // Nothing has ever been uploaded. The upload is the only thing anyone can do
  // here, so it gets the page to itself rather than sitting under four empty
  // panels explaining what they would say if it had.
  if (!hasLedger) {
    return (
      <div className="fin-stream">
        <ImportPanel imports={imports} canManage={canManage} onView={applyView} />
      </div>
    )
  }

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

      <Topline view={view} covered={covered} />

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
        </div>

        {rowCount === 0 ? (
          <p className="fin-detail-empty">
            <Icon name="Info" size={14} />
            {view.days.length === 0
              ? 'The ledger is loaded, but no row matched a logged show, so there is nothing to report yet. Add the sessions listed below in Streaming and re-attribute.'
              : // Days exist but this rollup does not, which can only mean the
                // app is running against a version that does not produce it.
                // Saying so beats "no data", which would read as a real
                // finding and send someone looking for missing money.
                `There are days in the calendar, but this build produced no ${grainWord} rollup for them. Switch back to Calendar; ${grainWord}s appear once the app is updated.`}
          </p>
        ) : period === 'day' ? (
          <FinanceCalendar
            days={view.days}
            month={calMonth}
            selected={calDay}
            onMonth={setCalMonth}
            onSelect={setCalDay}
          />
        ) : (
          <PeriodList
            rows={periodRows}
            period={period}
            open={openPeriod[period] ?? null}
            onOpen={(key) => setOpenPeriod((prev) => ({ ...prev, [period]: key }))}
          />
        )}
      </section>

      {/* Provenance, in one region rather than as two more equal-weight cards.
          Everything above is derived; everything here is what it was derived
          FROM, and the heading says so. */}
      <section className="fin-source" aria-label="Where these numbers come from">
        <h2 className="fin-source-title">Behind these numbers</h2>

        <UnattributedPanel view={view} canManage={canManage} onView={applyView} />
        <ImportPanel imports={imports} canManage={canManage} onView={applyView} />

        {view.reconciled && (
          <p className="fin-reconciled">
            <Icon name="CheckCircle2" size={14} />
            Every row is accounted for: each one is on a day above, or waiting for a show here.
          </p>
        )}
      </section>
    </div>
  )
}

/**
 * The headline block: what the shows made, as one line of arithmetic that
 * CLOSES.
 *
 * The strip this replaces printed total revenue, fees, net revenue, cost of
 * goods and net profit — and on real data the last figure was $243.73 away from
 * the four before it, because net shipping moved the number and was nowhere on
 * the line. A reader who tries to check the arithmetic and fails does not
 * conclude they misread; they conclude the app is wrong, and on the evidence in
 * front of them they are right to.
 *
 * So every term that moves the number is printed. The terms are not written out
 * by hand either: they are the SECTION SUBTOTALS from `buildPnl`, the same ones
 * every statement below is built from, which is what makes it impossible for
 * this line and those statements to mean different things by "fees". Their sum
 * is net profit by the contract's own `pnlChecksum`, so the equation closes by
 * construction — and when it does not, it says so instead of printing five
 * figures that quietly refuse to add up.
 */
function Topline({
  view,
  covered
}: {
  view: StreamingFinanceView
  covered: { from: string; to: string } | null
}): JSX.Element {
  const { totals, unattributed } = view
  const sections = useMemo(() => buildStatement(totals), [totals])

  const revenue = sectionSubtotal(sections, 'revenue')
  const net = sectionSubtotal(sections, 'netProfit')
  const check = pnlDrift(sections, totals.netProfit)
  const margin = profitMargin(revenue, net)

  return (
    <section className="fin-topline" aria-label="Streaming profit and loss">
      <div className="fin-topline-head">
        <h2>Streaming profit and loss</h2>
        {covered && (
          <span className="fin-topline-scope">{dayRangeLabel(covered.from, covered.to)}</span>
        )}
      </div>

      {!check.ok && (
        <Note tone="danger" icon="AlertTriangle" role="alert">
          <b>This total does not add up — do not use it.</b>
          <p>
            The terms below come to <Money value={check.checksum} strong />, but net profit is
            stored as <Money value={check.stated} strong />, a difference of{' '}
            <Money value={check.drift} strong />. The app and its data engine were built from
            different versions of the P&amp;L. Update the app and re-import before trusting any
            figure on this screen.
          </p>
        </Note>
      )}

      <Equation totals={totals} sections={sections} net={net} margin={margin} />

      <div className="fin-topline-foot">
        <span className="fin-topline-meta">
          <b className="mono">{totals.dayCount.toLocaleString()}</b>{' '}
          {totals.dayCount === 1 ? 'day' : 'days'} streamed
          <span aria-hidden="true">·</span>
          <b className="mono">{totals.sessionCount.toLocaleString()}</b>{' '}
          {totals.sessionCount === 1 ? 'show' : 'shows'}
          <span aria-hidden="true">·</span>
          <b className="mono">{formatDuration(totals.minutes)}</b> on air
          <span aria-hidden="true">·</span>
          <b className="mono">{totals.saleCount.toLocaleString()}</b>{' '}
          {totals.saleCount === 1 ? 'sale' : 'sales'}
        </span>

        {unattributed.rowCount > 0 && (
          <button
            type="button"
            className="fin-topline-waiting"
            onClick={() =>
              document
                .getElementById('fin-unattributed')
                ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
            }
          >
            <Icon name="CalendarRange" size={13} />
            <Money value={unattributed.amount} /> across{' '}
            {plural(unattributed.rowCount, 'row')} is not on any day yet
            <Icon name="ArrowDown" size={13} />
          </button>
        )}
      </div>
    </section>
  )
}

/**
 * One term of the equation.
 *
 * `amount` stays SIGNED, exactly as the statement books it, and the operator is
 * derived from that sign while the figure prints as a magnitude. That is the
 * whole reason shipping cannot render as "− −$243.73": there is only ever one
 * sign on screen and it is the one the operator glyph carries. Shipping is the
 * term that proves it — subsidy less postage lands either side of zero from one
 * month to the next.
 */
interface EqTerm {
  key: string
  label: string
  amount: number
  note?: JSX.Element | string
  /** Printed even at zero. Fees, cost of goods and shipping are the SHAPE of
   *  this business's P&L; a line missing because it happened to be zero reads
   *  as a line somebody forgot. The occasional ones — show costs, refunds —
   *  appear only when they moved the number, so a quiet month is not padded
   *  with two dashes. */
  structural?: boolean
}

function Equation({
  totals,
  sections,
  net,
  margin
}: {
  totals: StreamFinanceTotals
  sections: ReturnType<typeof buildStatement>
  net: number
  margin: number | null
}): JSX.Element {
  // Denominator is SALES, not total revenue. Fees are only ever charged on
  // sales — tips and bonuses arrive whole — so dividing by total revenue would
  // quietly dilute the rate on any day with a tip and understate what Whatnot
  // actually costs. `Pct` prints the base beside it so the number is checkable.
  const fees = sectionSubtotal(sections, 'fees')
  const feeRate = totals.sales > 0 ? (Math.abs(fees) / totals.sales) * 100 : null

  const terms: EqTerm[] = [
    {
      key: 'fees',
      label: 'Platform fees',
      amount: fees,
      structural: true,
      note: (
        <>
          {feeRate !== null && (
            <>
              <Pct
                value={feeRate}
                base="of sales"
                digits={2}
                title="Total fees as a share of sales — fees are charged on sales only, never on tips or bonuses. The statements below break it into commission and processing."
              />
              {' — '}
            </>
          )}
          Whatnot&rsquo;s commission and card processing
        </>
      )
    },
    {
      key: 'cogs',
      label: 'Cost of goods',
      amount: sectionSubtotal(sections, 'cogs'),
      structural: true,
      note: 'the stock broken and given away, at what it cost'
    },
    {
      key: 'shipping',
      label: 'Shipping',
      amount: sectionSubtotal(sections, 'shipping'),
      structural: true,
      note: 'subsidy received, less all postage'
    },
    {
      key: 'showCosts',
      label: 'Show costs',
      amount: sectionSubtotal(sections, 'showCosts'),
      note: 'paid promotion of a show'
    },
    {
      key: 'adjustments',
      label: 'Refunds',
      amount: sectionSubtotal(sections, 'adjustments'),
      note: 'orders reversed after the sale'
    }
  ].filter((t) => t.structural || Math.abs(t.amount) >= 0.005)

  return (
    <div className="fin-eq">
      <div className="fin-eq-terms">
        <EqCell
          label="Total revenue"
          value={<Money value={sectionSubtotal(sections, 'revenue')} strong />}
          note="sales, tips and bonuses, before any deduction"
        />
        {terms.map((t) => (
          <EqCell
            key={t.key}
            op={t.amount < 0 ? 'minus' : 'plus'}
            label={t.label}
            value={<Money value={t.amount} abs strong />}
            note={t.note}
          />
        ))}
      </div>

      <EqCell
        className="fin-eq-result"
        op="equals"
        label="Net profit"
        value={<Profit value={net} />}
        // profitMargin returns null on no revenue. Printing "0.0% of revenue"
        // there would be a statement about nothing that invites comparison with
        // a real margin, so nothing is printed at all.
        note={margin === null ? undefined : <Pct value={margin} base="of total revenue" />}
      />
    </div>
  )
}

/** The three operators, as the glyph on screen and the word a screen reader
 *  hears. U+2212 and U+002B are a digit wide and unmistakable at 18px; the
 *  words are what make the line an equation rather than four figures in a row
 *  when it is read aloud. */
const OPS = {
  minus: { glyph: '−', word: 'less ' },
  plus: { glyph: '+', word: 'plus ' },
  equals: { glyph: '=', word: 'equals ' }
} as const

function EqCell({
  op,
  label,
  value,
  note,
  className = ''
}: {
  op?: keyof typeof OPS
  label: string
  value: JSX.Element
  note?: JSX.Element | string
  className?: string
}): JSX.Element {
  const o = op ? OPS[op] : null
  // Four flat children, not an operator beside a stacked block: the cell is a
  // grid, and the operator has to sit on the FIGURE's row rather than on the
  // label's. Nesting the label, figure and note inside a wrapper would put them
  // in one grid cell and there would be nothing for the operator to align to.
  return (
    <div className={`fin-eq-cell${className ? ` ${className}` : ''}`}>
      <span className="fin-eq-label">
        {o && <span className="fin-sr">{o.word}</span>}
        {label}
      </span>
      <span className="fin-eq-op" aria-hidden="true">
        {o?.glyph}
      </span>
      <span className="fin-eq-value">{value}</span>
      {note ? <span className="fin-eq-note">{note}</span> : null}
    </div>
  )
}
