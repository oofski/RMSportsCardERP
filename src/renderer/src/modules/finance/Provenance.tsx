import { useState } from 'react'
import type { StreamingFinanceView } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { Money, plural } from './bits'
import { ImportPanel } from './ImportPanel'

/**
 * Where the numbers came from — folded away until asked for.
 *
 * This region used to open flat: a full unattributed panel with a paragraph of
 * explanation and a cluster table, then the import list with its own counts and
 * warning banners, all of it below the P&L and all of it on screen at once. It
 * was accurate and it was too much. On a normal week nothing here needs doing,
 * and a screen that shows the file bookkeeping at the same weight as the profit
 * figure teaches the operator to scroll past both.
 *
 * NOTHING IS HIDDEN, only folded. Every fact anyone acts on is on the summary
 * line — how many rows are in, what share matched a show, how much money is
 * still waiting for one, and whether an import has anything to check. The line
 * is the trigger, so the detail is one click from the number that raised the
 * question, and the upload button stays outside the fold because uploading is
 * the one thing here anybody does on purpose.
 */
export function Provenance({
  view,
  canManage,
  onView
}: {
  view: StreamingFinanceView
  canManage: boolean
  onView: (view: StreamingFinanceView) => void
}): JSX.Element {
  const { imports, unattributed, totals } = view

  // Warnings are the one thing here that can be urgent, so the fold OPENS on
  // them the first time they appear. It is initial state, not a forced one —
  // closing it stays closed while the operator works, rather than springing
  // back open on every re-render the way a derived `open` would.
  const warnings = imports.reduce((n, imp) => n + imp.warnings.length, 0)
  const [open, setOpen] = useState(warnings > 0 || !view.reconciled)

  const rowsImported = imports.reduce((n, imp) => n + imp.rowsImported, 0)
  const attributed = totals.rowCount
  const pool = attributed + unattributed.rowCount
  const matchedShare = pool > 0 ? Math.round((attributed / pool) * 100) : null

  return (
    <section className={`fin-source${open ? ' is-open' : ''}`}>
      <div className="fin-source-bar">
        <button
          type="button"
          className="fin-source-toggle"
          aria-expanded={open}
          aria-controls="fin-source-body"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
          <span className="fin-source-title">Behind these numbers</span>

          <span className="fin-source-facts">
            <span>
              <b className="mono">{rowsImported.toLocaleString()}</b> rows from{' '}
              {plural(imports.length, 'file')}
            </span>
            {matchedShare !== null && (
              <span title="Share of imported rows that fell inside a logged show">
                <b className="mono">{matchedShare}%</b> matched a show
              </span>
            )}
            {unattributed.rowCount > 0 && (
              <span
                className="fin-source-waiting"
                title="Money in the ledger that no logged show covers. It is on those days in the calendar above, and listed under the statement."
              >
                <Money value={unattributed.amount} strong /> waiting on{' '}
                {plural(unattributed.byDay.length, 'day')}
              </span>
            )}
          </span>

          {warnings > 0 && (
            <span className="fin-source-warn">
              <Icon name="AlertTriangle" size={12} />
              {plural(warnings, 'thing')} to check
            </span>
          )}
        </button>
      </div>

      {open && (
        <div className="fin-source-body" id="fin-source-body">
          {/* The unattributed panel used to open here — a total, a paragraph, a
              row of chips and a table of every burst in the ledger. It has moved
              onto the calendar and into the statement, where the money is
              attached to the day it belongs to instead of being one figure the
              reader had to map onto the days themselves. */}
          <ImportPanel imports={imports} canManage={canManage} onView={onView} />

          {view.reconciled && (
            <p className="fin-reconciled">
              <Icon name="CheckCircle2" size={14} />
              Every row is accounted for — on a day in the calendar, or waiting for a show on one.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
