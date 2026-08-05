import { useCallback, useEffect, useMemo, useState } from 'react'
import { LIVE, useLiveRefresh } from '../../lib/live'
import type { StreamingFinanceView } from '@shared/financeStreaming'
import { Button, CenterLoader } from '../../components/ui'
import { useSession } from '../../lib/session'
import { Note } from './bits'
import { Expenses } from './Expenses'
import { FinanceCalendar } from './FinanceCalendar'
import { ImportPanel } from './ImportPanel'
import { Provenance } from './Provenance'
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

  // Nothing has ever been uploaded. The upload is the only thing anyone can do
  // here, so it gets the page to itself rather than sitting under four empty
  // panels explaining what they would say if it had.
  if (imports.length === 0) {
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

      <Provenance view={view} canManage={canManage} onView={applyView} />
    </div>
  )
}
