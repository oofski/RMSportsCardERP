import { useCallback, useEffect, useMemo, useState } from 'react'
import { LIVE, useLiveRefresh } from '../../lib/live'
import type { StreamingFinanceView, WhatnotRatePeriod } from '@shared/financeStreaming'
import { describeImportStanding, importStanding } from '@shared/financeStreaming'
import { reconInRange, reconRows, reconTotals } from '@shared/pnlRecon'
import { Icon } from '../../components/Icon'
import { compactDayLabel } from './time'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { useSession } from '../../lib/session'
import { Money, Note } from './bits'
import { Expenses } from './Expenses'
import { FinanceCalendar } from './FinanceCalendar'
import { RangeBar } from './RangeBar'
import { RangeStatement } from './Statement'
import { RangeWidgets } from './Widgets'
import { useToast } from '../../components/Toast'
import { finance, resultError } from './api'
import {
  type DayRange,
  coveredRange,
  daysInRange,
  priorRange,
  totalsForRange
} from './range'
import { dayRangeLabel, daySpan, monthKeyOfDayKey } from './time'

/**
 * Finance → Streaming: what the shows actually earned.
 *
 * The whole tab hangs off ONE read and ONE selection.
 *
 * `streamView()` derives the days, the rollups, the totals, the unattributed
 * pile and the reconciliation verdict in a single pass, so every write here
 * (import, delete, re-attribute) hands back the whole view and this screen
 * replaces its state with it. Refetching the pieces separately would let the
 * calendar and the unattributed panel disagree about the same money — which is
 * precisely the bug the reconciliation flag exists to catch.
 *
 * THE SELECTION IS A DATE RANGE and it drives everything: the five widgets, the
 * highlight on the calendar and the statement underneath. Before, the headline
 * figures described the entire ledger no matter what was selected, a grain
 * switch changed which LIST appeared below them, and clicking a day opened a
 * third thing — so the page could show an all-time total, a weekly row and one
 * day's statement at once, with nothing saying which of the three the reader
 * was looking at. One range removes the question.
 *
 * THE ORDER OF THE PAGE IS THE ORDER OF THE QUESTIONS.
 *
 *   1. Can I trust this at all?  — the reconciliation banner, if it fails.
 *   2. What did we make?         — five widgets, over the chosen range.
 *   3. When did we make it?      — the calendar, which is also how the range
 *                                  is chosen.
 *   4. How is that made up?      — the statement, opened section by section.
 *   5. Where did it come from?   — provenance, folded away until asked for.
 */
export function StreamingTab(): JSX.Element {
  const { can } = useSession()
  const canManage = can('finance.manage')
  // Entering a cost against a stream line is a STREAMING write — it edits
  // `stream_items` — so it is gated on the streaming permission even though the
  // click happens on the P&L.
  const canCostLines = can('streaming.manage')
  const toast = useToast()

  const [view, setView] = useState<StreamingFinanceView | null>(null)
  /**
   * The rate periods, read only so this tab can say when a night was priced at
   * terms nobody chose. See the banner below.
   *
   * Fetched here rather than folded into the view because the answer depends on
   * the SELECTED RANGE, which only this tab knows — and because reusing the same
   * reconRows the Fees tab reads means the two screens cannot report different
   * uncovered figures.
   */
  const [periods, setPeriods] = useState<WhatnotRatePeriod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // null means all time. The calendar month is separate: the operator can page
  // through months to pick a range without the range moving under them.
  const [range, setRange] = useState<DayRange | null>(null)
  const [calMonth, setCalMonth] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.streamView()
        if (alive) setView(next)
        // Failing to read the rate list must not blank the tab: the numbers are
        // still worth showing, the coverage warning simply is not available.
        const rates = await finance.rates().catch(() => [] as WhatnotRatePeriod[])
        if (alive) setPeriods(rates)
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

  // A ledger import run on another machine changes every number on this screen.
  // Reuses the existing retry counter rather than adding a second way to reload.
  useLiveRefresh(LIVE.finance, () => setAttempt((n) => n + 1))

  const applyView = useCallback((next: StreamingFinanceView) => setView(next), [])

  /**
   * The one line that survives the move to Admin. Built from the same function
   * the Admin tile uses, so a pointer promising nothing is wrong can never sit
   * above a tile listing four unreadable rows.
   */
  const standing = useMemo(() => importStanding(view?.imports ?? []), [view?.imports])

  /**
   * How much of the money on screen was priced at terms NOBODY CHOSE.
   *
   * `effectiveFeeRates` falls back to the built-in 8% for any business day no
   * rate period covers, and it does so silently. That is not a small default:
   * revenue here is the net with the modelled fee added back, so pricing a night
   * at 8% when the real commission is 4% invents about 4.8 cents of revenue per
   * dollar Whatnot actually paid — around $19k on a $400k month. It moves no
   * bottom line, because the fee is subtracted again two sections down, which is
   * exactly why nothing caught it.
   *
   * Sized in MONEY, never in nights. Four uncovered Tuesdays worth $40 between
   * them is a footnote; one uncovered Saturday that took $60,000 is the whole
   * discrepancy, and a count cannot tell those apart — the same argument
   * `reconTotals` already makes for the figure it returns.
   */
  const uncovered = useMemo(() => {
    if (!view || periods.length === 0) return null
    const rows = reconInRange(
      reconRows(view.days, periods),
      range?.from ?? '',
      range?.to ?? ''
    )
    const t = reconTotals(rows)
    return t.uncoveredNetPaid > 0 ? t : null
  }, [view, periods, range])

  /**
   * Re-run attribution over every stored row.
   *
   * Lives HERE rather than in the panel that offers the button, because the
   * button now sits inside the statement — and the statement is rebuilt from the
   * view this component owns. Attribution changes which day money is on, so the
   * whole view has to be replaced at once; refreshing only the panel would leave
   * the calendar and the widgets describing the arrangement from before.
   */
  const reattribute = useCallback(async () => {
    try {
      const res = await finance.reattribute()
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'Re-attribution did not run.'))
        return
      }
      const before = view?.unattributed.rowCount ?? 0
      const claimed = before - res.data.unattributed.rowCount
      applyView(res.data)
      toast.success(
        claimed > 0
          ? `${claimed.toLocaleString()} row${claimed === 1 ? '' : 's'} moved onto a show.`
          : 'Every row re-checked. Nothing new matched — the missing shows still need logging.'
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-attribution did not run.')
    }
  }, [applyView, toast, view])

  /**
   * The newest business month the ledger holds.
   *
   * Watched HERE rather than inside the calendar. A fresh import can land
   * months that did not exist a moment ago and following them is right — the
   * operator uploaded a file to look at what is in it. This component never
   * unmounts, so the effect fires when the DATA changes and at no other time.
   */
  const latestMonth = useMemo(() => {
    let best = ''
    for (const d of view?.days ?? []) {
      const k = monthKeyOfDayKey(d.streamDate)
      if (k > best) best = k
    }
    return best
  }, [view])

  useEffect(() => {
    setCalMonth(null)
  }, [latestMonth])

  /**
   * Follow the range onto the calendar.
   *
   * Picking "last month" or a week from the dropdown while looking at July has
   * to move the grid, or the highlight lands off-screen and the selection looks
   * like it did nothing. Only when the range's own month is not already the one
   * being viewed — a range selected BY clicking the calendar is already there,
   * and re-setting the month on it would fight a multi-month drag.
   */
  useEffect(() => {
    if (!range) return
    const m = monthKeyOfDayKey(range.from)
    setCalMonth((cur) => {
      const shown = cur ?? latestMonth
      return shown === m || (shown >= m && shown <= monthKeyOfDayKey(range.to)) ? cur : m
    })
  }, [range, latestMonth])

  // Everything reported on the screen, derived from the one range. Summed with
  // the CONTRACT's accumulator, so a range that lines up with a week produces
  // that week's figures to the cent.
  const inRange = useMemo(() => daysInRange(view?.days ?? [], range), [view, range])
  const totals = useMemo(() => totalsForRange(view?.days ?? [], range), [view, range])

  const prior = useMemo(() => {
    const p = priorRange(range)
    if (!p || !view) return null
    return { range: p, totals: totalsForRange(view.days, p) }
  }, [view, range])

  // The single day behind a one-day range — it unlocks the ledger drill-down
  // and the show titles, neither of which means anything across a span.
  const singleDay = range && range.from === range.to ? (inRange[0] ?? null) : null

  const covered = useMemo(() => coveredRange(view?.days ?? []), [view])

  /**
   * The waiting days inside the selected range.
   *
   * At all-time this is every one of them, which makes the panel the complete
   * list of shows worth logging — nothing is stranded in a month nobody thought
   * to page to. Narrow to a day and it is that day alone.
   */
  const waitingInRange = useMemo(() => {
    const all = view?.unattributed.byDay ?? []
    if (!range) return all
    return all.filter((d) => d.localDate >= range.from && d.localDate <= range.to)
  }, [view, range])

  const rangeLabel = range
    ? dayRangeLabel(range.from, range.to)
    : covered
      ? `All time · ${dayRangeLabel(covered.from, covered.to)}`
      : 'All time'

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

  /**
   * Nothing has ever been uploaded.
   *
   * This used to BE the uploader — the panel had the page to itself, because
   * uploading was the only thing anyone could do here. Now that uploading lives
   * in Admin, the empty state has to say where it went: a tab that goes blank
   * with no way forward is worse than the four empty panels the old comment was
   * arguing against.
   */
  if (imports.length === 0) {
    return (
      <div className="fin-stream">
        <EmptyState
          icon="Upload"
          title="No ledger has been uploaded yet"
          message={
            canManage
              ? 'Upload Whatnot’s export in Admin → Ledger, and every figure on this tab appears.'
              : 'Once somebody uploads Whatnot’s export in Admin → Ledger, this tab fills in.'
          }
        />
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
            Re-attribute first. If that fails, delete the last import and upload it again.
          </p>
        </Note>
      )}

      {/* SECOND, and at the same weight. The reconcile banner above says the rows
          do not add up; this one says they add up to a figure priced on terms
          nobody set. Both make every number below untrustworthy, and only one of
          them used to be said out loud. */}
      {uncovered && (
        <Note tone="warn" icon="AlertTriangle" role="alert">
          <b>
            <Money value={uncovered.uncoveredNetPaid} /> of this was priced at the standard rates,
            not yours.
          </b>
          <p>
            {uncovered.uncoveredDays === 1
              ? 'One night in this range is not covered by any rate period'
              : `${uncovered.uncoveredDays} nights in this range are not covered by any rate period`}
            , so they were charged at the built-in 8% commission and 2.9% card fee. If your real
            terms are lower, revenue for those nights reads high — and only revenue, which is why
            the profit below still looks right.
          </p>
          <p>
            Set a rate period covering them in <b>Fees &amp; rates</b>, or use the revenue check
            there to work out what the commission must have been.
          </p>
        </Note>
      )}

      <section className="fin-head" aria-label="Streaming profit and loss">
        <div className="fin-head-top">
          <h2>Streaming</h2>
          <span className="fin-head-scope">{rangeLabel}</span>
        </div>

        <RangeBar range={range} weeks={view.weeks} months={view.months} onRange={setRange} />

        <RangeWidgets
          totals={totals}
          prior={prior?.totals ?? null}
          priorLabel={
            prior ? `previous ${daySpan(prior.range.from, prior.range.to)} days` : null
          }
        />
      </section>

      <FinanceCalendar
        days={view.days}
        waiting={view.unattributed.byDay}
        month={calMonth}
        range={range}
        onMonth={setCalMonth}
        onRange={setRange}
      />

      <RangeStatement
        totals={totals}
        label={rangeLabel}
        range={range}
        spanDays={range ? daySpan(range.from, range.to) : null}
        day={singleDay}
        waiting={waitingInRange}
        onReattribute={reattribute}
        onPickDay={(key) => setRange({ from: key, to: key })}
        /* Only offered to somebody who may write a stream line. What it writes
           is a stream line, whichever screen the click came from, so the gate is
           `streaming.manage` and not this module's own permission. The whole
           view is re-read afterwards rather than patched: a cost lands on cost
           of goods, gross profit, net profit, the calendar cell and every rollup
           that contains the day, and patching one of those would leave the rest
           describing the arrangement from before. */
        onCosted={canCostLines ? () => setAttempt((n) => n + 1) : undefined}
      />

      {/* Under the statement, because it is the only figure on it that nobody
          imported — and the only one an operator can change from this screen.
          Above provenance, because provenance is about where the FILE came from
          and this is about a number that came from a person. */}
      <Expenses range={range} canManage={canManage} onView={applyView} />

      {/* WHERE THE NUMBERS CAME FROM, in one line.
          The upload box and the import history moved to Admin, so this tab is
          about the money. But a screen reporting revenue must not go silent
          about a reason its revenue could be wrong, so the line stays and says
          plainly when something needs a person — see importStanding, which the
          Admin tile is built from too, so the two cannot disagree. */}
      <p className={`fin-imports-note${standing.needsAttention ? ' needs-attention' : ''}`}>
        <Icon name={standing.needsAttention ? 'AlertTriangle' : 'Upload'} size={14} />
        <span>
          {describeImportStanding(standing)}
          {standing.lastImportAt ? `, last on ${compactDayLabel(standing.lastImportAt.slice(0, 10))}` : ''}
          . Uploading and import history are in <b>Admin → Ledger</b>.
        </span>
      </p>
    </div>
  )
}
