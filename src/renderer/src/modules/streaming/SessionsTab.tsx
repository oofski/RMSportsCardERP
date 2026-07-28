import { useEffect, useMemo, useState } from 'react'
import type { StreamSession } from '@shared/streaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, Field, Input } from '../../components/ui'
import { SessionRow } from './StreamCalendar'
import { streaming } from './api'
import { dayKeyOf, longDayLabel, todayKey } from './time'

/**
 * The flat list, for the questions a month grid answers badly: "what did we run
 * over the last fortnight", "find that show from March". The range is over
 * `streamDate`, same as the calendar, so a late-finishing show is counted on
 * the day it started here too.
 */
export function SessionsTab({
  version,
  canManage,
  onOpen,
  onAddManual
}: {
  version: number
  canManage: boolean
  onOpen: (id: string) => void
  onAddManual: (dateKey: string) => void
}): JSX.Element {
  // Opens on the last 30 days rather than the calendar month: the list is the
  // "what have we been doing" view, and a month boundary is an arbitrary place
  // to cut that off.
  const [from, setFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 29)
    return dayKeyOf(d)
  })
  const [to, setTo] = useState(todayKey)
  const [rows, setRows] = useState<StreamSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (from > to) return
    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await streaming.list(from, to)
        if (active) setRows(next)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not load those streams.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [from, to, version, attempt])

  // Grouped by business day so the run of shows on one night reads as one night.
  const groups = useMemo(() => {
    const map = new Map<string, StreamSession[]>()
    for (const s of rows) {
      const list = map.get(s.streamDate)
      if (list) list.push(s)
      else map.set(s.streamDate, [s])
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [rows])

  const totalMinutes = rows.reduce((n, s) => n + (s.durationMinutes ?? 0), 0)
  const rangeInvalid = from > to

  return (
    <section className="stm-list-section">
      <div className="stm-list-head">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" error={rangeInvalid ? 'Earlier than From' : undefined}>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <span className="stm-list-count">
          {rows.length} stream{rows.length === 1 ? '' : 's'} · {formatDuration(totalMinutes)} on air
        </span>
        {canManage && (
          <Button size="sm" icon="Plus" onClick={() => onAddManual(todayKey())}>
            Add a stream
          </Button>
        )}
      </div>

      {rangeInvalid ? (
        <div className="stm-empty-row">
          <Icon name="Info" size={14} />
          The end of the range is before its start.
        </div>
      ) : error ? (
        <div className="stm-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{error}</span>
          <Button size="sm" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <CenterLoader />
      ) : groups.length === 0 ? (
        <div className="stm-empty-row">
          <Icon name="Moon" size={14} />
          No streams between {longDayLabel(from)} and {longDayLabel(to)}.
        </div>
      ) : (
        <div className="stm-groups">
          {groups.map(([date, sessions]) => (
            <div className="stm-group" key={date}>
              <span className="stm-group-date">
                <Icon name="CalendarDays" size={13} />
                {longDayLabel(date)}
              </span>
              <div className="stm-day-rows">
                {sessions.map((s) => (
                  <SessionRow key={s.id} session={s} onOpen={onOpen} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
