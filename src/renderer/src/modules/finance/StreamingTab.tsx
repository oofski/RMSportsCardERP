import { useCallback, useEffect, useState } from 'react'
import type { StreamingFinanceView } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { useSession } from '../../lib/session'
import { Money, Note, Stat, plural } from './bits'
import { DayTable } from './DayTable'
import { ImportPanel } from './ImportPanel'
import { UnattributedPanel } from './UnattributedPanel'
import { finance } from './api'

/**
 * Finance → Streaming: what the shows actually earned.
 *
 * The whole tab hangs off ONE read. `streamView()` derives the days, the totals,
 * the unattributed pile and the reconciliation verdict in a single pass, so
 * every write here (import, delete, re-attribute) hands back the whole view and
 * this screen replaces its state with it. Refetching the pieces separately would
 * let the day table and the unattributed panel disagree about the same money —
 * which is precisely the bug the reconciliation flag exists to catch.
 *
 * Scope note, stated on screen as well: this is REVENUE. The only costs shown
 * are the ones the platform charged for running the show. Cost of goods is a
 * later step and belongs to the complete P&L.
 */
export function StreamingTab(): JSX.Element {
  const { can } = useSession()
  const canManage = can('finance.manage')

  const [view, setView] = useState<StreamingFinanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

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

  const { days, totals, imports } = view
  const hasLedger = imports.length > 0

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

          <div className="fin-stats">
            <Stat label="Net revenue" hint="what the shows earned, after the platform's charges">
              <Money value={totals.netRevenue} strong />
            </Stat>
            <Stat label="Gross revenue" hint="sales, subsidy, tips and bonuses, less reversals">
              <Money value={totals.grossRevenue} strong />
            </Stat>
            <Stat label="Show costs" hint="giveaway postage, shipping charges and Show Boost">
              <Money value={totals.showCosts} cost strong />
            </Stat>
            <Stat
              label="Streamed"
              hint={`${plural(totals.sessionCount, 'show')} · ${formatDuration(
                totals.minutes
              )} on air`}
            >
              <span className="mono">
                {totals.dayCount} day{totals.dayCount === 1 ? '' : 's'}
              </span>
            </Stat>
          </div>

          <section className="fin-days-section">
            <div className="fin-days-head">
              <span className="fin-section-title">
                <Icon name="CalendarDays" size={15} />
                Day by day
                <span className="fin-count">{days.length}</span>
              </span>
              <span className="fin-days-scope">
                Revenue only — stock cost is not in these figures.
              </span>
            </div>

            {days.length === 0 ? (
              <p className="fin-detail-empty">
                <Icon name="Info" size={14} />
                The ledger is loaded, but no row matched a logged show, so there are no days to
                show. Add the sessions listed above in <b>Streaming</b> and re-attribute.
              </p>
            ) : (
              <DayTable days={days} totals={totals} />
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
