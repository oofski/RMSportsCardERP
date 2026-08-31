import { useCallback, useEffect, useState } from 'react'
import type { StreamingFinanceView } from '@shared/financeStreaming'
import { CenterLoader, EmptyState } from '../../components/ui'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { finance } from '../finance/api'
import { ImportPanel } from '../finance/ImportPanel'
import { Provenance } from '../finance/Provenance'

/**
 * UPLOADING THE LEDGER, AND EVERY UPLOAD THAT CAME BEFORE.
 *
 * Both panels here used to sit on Finance → Streaming, above and below the P&L
 * they feed. The owner's ask moved them: "when the ledger gets uploaded and data
 * is there I just want it to be there ... it should be just sent there and not
 * in the streaming tab."
 *
 * ## Why that is the right split rather than merely a tidier one
 *
 * Streaming answers "what did the business make". This answers "where did those
 * figures come from, and did anything go wrong getting them here". They are
 * different questions asked by the same person in different moods, and only one
 * of them is asked weekly. Uploading a CSV, reading a match rate and deleting a
 * bad import are maintenance; putting maintenance on the screen somebody reads
 * to check their revenue means the revenue is read past furniture every time.
 *
 * ## The panels are LIFTED, not reimplemented
 *
 * `ImportPanel` and `Provenance` are imported from the finance module exactly as
 * they were, with the same props. Copying them here to "own" them would leave
 * two import screens that drift, and the one nobody is looking at would be the
 * one still deleting imports by the old rules.
 *
 * ## It reads its own view
 *
 * Rather than being handed one, matching `DayCoverage` in RatesTab. A tile in
 * Admin can be opened without Finance ever having been visited, so it cannot
 * depend on a fetch some other screen may or may not have done — and both panels
 * hand a freshly derived view back after a write, which is the state this then
 * holds.
 */
export function LedgerTab(): JSX.Element {
  const { can } = useSession()
  const canManage = can('finance.manage')
  const [view, setView] = useState<StreamingFinanceView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setError(null)
    void finance
      .streamView()
      .then((v) => {
        if (alive) setView(v)
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : 'The ledger could not be read.')
        }
      })
    return () => {
      alive = false
    }
  }, [attempt])

  // An import run on another machine changes everything on this screen.
  useLiveRefresh(LIVE.finance, () => setAttempt((n) => n + 1))

  /**
   * Both panels hand back the view their own write produced.
   *
   * Taking it rather than refetching is what makes a delete's effect visible
   * immediately AND consistent: the numbers on screen came out of the same
   * derivation the write ran, so nothing here can disagree with what just
   * happened.
   */
  const applyView = useCallback((next: StreamingFinanceView) => setView(next), [])

  if (error) {
    return (
      <EmptyState
        icon="AlertTriangle"
        title="The ledger could not be read"
        message={error}
      />
    )
  }
  if (view === null) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Ledger</h2>
          <p className="section-sub">
            Upload Whatnot&rsquo;s export, and everything that has been uploaded before.
          </p>
        </div>
      </div>

      <ImportPanel imports={view.imports} canManage={canManage} onView={applyView} />
      <Provenance view={view} canManage={canManage} onView={applyView} />
    </>
  )
}
