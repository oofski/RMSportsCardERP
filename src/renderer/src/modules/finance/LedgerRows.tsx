import { useEffect, useState } from 'react'
import type { LedgerRow } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { BucketChip, Money, plural } from './bits'
import { finance } from './api'
import { timeLabel } from './time'

/** A day can carry several hundred rows; this is enough to scan and not enough
 *  to stall the render. The footer says when there are more. */
const DAY_ROW_LIMIT = 300

/**
 * The rows behind a day — the evidence under the statement.
 *
 * Fetched on expand rather than with the view: a five-week export is thousands
 * of rows and almost none of them are ever looked at. This is the end of the
 * trail — calendar to day, day to statement, statement to the ledger lines the
 * statement was summed from — so it stays reachable from every day, but closed
 * until asked for.
 */
export function LedgerRows({
  streamDate,
  rowCount
}: {
  streamDate: string
  /** What the day says it holds, so the footer can say whether the list is all
   *  of it or the first page of it. */
  rowCount: number
}): JSX.Element {
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.rows({ streamDate, limit: DAY_ROW_LIMIT })
        if (alive) setRows(next)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Those rows could not be read.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [streamDate])

  if (error) {
    return (
      <p className="fin-detail-empty">
        <Icon name="AlertTriangle" size={14} />
        {error}
      </p>
    )
  }

  if (loading) {
    return (
      <p className="fin-detail-empty">
        <span className="spinner dark" />
        Reading this day&rsquo;s ledger rows…
      </p>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="fin-detail-empty">
        <Icon name="Info" size={14} />
        No ledger rows are stored against this day.
      </p>
    )
  }

  return (
    <>
      <ul className="fin-rows">
        {rows.map((r) => (
          <li className="fin-row" key={r.id}>
            <span className="fin-row-time mono">{timeLabel(r.occurredAt)}</span>
            <BucketChip bucket={r.bucket} />
            {r.attribution === 'carried_back' && (
              <span
                className="fin-row-carry"
                title="This settled after the show ended and was booked back to it. Expected for shipping and adjustment rows."
              >
                <Icon name="Undo2" size={10} />
                settled later
              </span>
            )}
            <span className="fin-row-msg" title={r.message}>
              {r.message}
            </span>
            {r.breakNumber !== null && (
              <span className="fin-row-break">
                <Icon name="Hash" size={10} />
                Break {r.breakNumber}
              </span>
            )}
            {r.repaired && (
              <span
                className="fin-row-flag"
                title="This row was exported malformed and was stitched back together on import."
              >
                repaired
              </span>
            )}
            <Money value={r.amount} />
          </li>
        ))}
      </ul>
      <p className="fin-detail-foot">
        Showing {rows.length.toLocaleString()} of {plural(rowCount, 'row')} on this day
        {rows.length < rowCount ? ' — the rest are stored but not listed here.' : '.'}
      </p>
    </>
  )
}
