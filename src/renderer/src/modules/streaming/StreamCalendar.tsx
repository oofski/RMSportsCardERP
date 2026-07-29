import { useEffect, useMemo, useRef, useState } from 'react'
import type { StreamCalendarDay, StreamCalendarMonth, StreamSession } from '@shared/streaming'
import { formatDuration } from '@shared/streaming'
import { formatMoney } from '../../lib/format'
import { formatUnitCount } from '../../lib/productUnits'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui'
import { LiveChip, SourceChip, TimeSpan } from './bits'
import { streaming } from './api'
import {
  dayKeyOf,
  dayNumberOf,
  longDayLabel,
  monthLabel,
  parseMonthKey,
  shiftMonth,
  thisMonthKey,
  todayKey
} from './time'

/**
 * The month view, and the module's front door.
 *
 * `calendar()` returns ONLY the days that carried a show, so the seven-column
 * grid is built here from the month's own shape and the payload is joined onto
 * it. That is deliberate: a quiet day has nothing to say, and filling it with
 * zeroes would make an empty month look like a broken one. Cells are keyed by
 * `streamDate` — the day a show STARTED — so a Monday show that ended at 2am
 * appears once, on Monday.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Cell =
  | { kind: 'pad'; key: string }
  | { kind: 'day'; key: string; day: StreamCalendarDay | null }

export function StreamCalendar({
  version,
  canManage,
  onOpen,
  onAddManual
}: {
  /** Bumped by the shell after any mutation so the month re-derives. */
  version: number
  canManage: boolean
  onOpen: (sessionId: string) => void
  onAddManual: (dateKey: string) => void
}): JSX.Element {
  const [monthKey, setMonthKey] = useState(thisMonthKey)
  const [month, setMonth] = useState<StreamCalendarMonth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [selected, setSelected] = useState<string | null>(null)
  const [daySessions, setDaySessions] = useState<StreamSession[]>([])
  const [dayLoading, setDayLoading] = useState(false)
  const [dayError, setDayError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await streaming.calendar(monthKey)
        if (active) setMonth(next)
      } catch (err) {
        // A rejected read must never leave the grid spinning forever.
        if (active) setError(err instanceof Error ? err.message : 'Could not load that month.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [monthKey, version, attempt])

  // The day panel is a second, lazy read: flicking through months stays cheap
  // because nothing loads until a day is actually opened.
  useEffect(() => {
    if (!selected) {
      setDaySessions([])
      setDayError(null)
      return
    }
    let active = true
    setDayLoading(true)
    setDayError(null)
    ;(async () => {
      try {
        const rows = await streaming.list(selected, selected)
        if (active) setDaySessions(rows)
      } catch (err) {
        if (active) setDayError(err instanceof Error ? err.message : 'Could not load that day.')
      } finally {
        if (active) setDayLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [selected, version])

  const cells = useMemo<Cell[]>(() => {
    const parsed = parseMonthKey(monthKey)
    if (!parsed) return []
    const byDate = new Map<string, StreamCalendarDay>()
    for (const d of month?.days ?? []) byDate.set(d.date, d)

    const first = new Date(parsed.year, parsed.month - 1, 1)
    const daysInMonth = new Date(parsed.year, parsed.month, 0).getDate()
    const out: Cell[] = []
    // Leading blanks belong to the previous month. They are inert padding, not
    // days: the read only covers this month, so they carry no numbers at all.
    for (let i = 0; i < first.getDay(); i++) out.push({ kind: 'pad', key: `lead-${i}` })
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dayKeyOf(new Date(parsed.year, parsed.month - 1, d))
      out.push({ kind: 'day', key, day: byDate.get(key) ?? null })
    }
    while (out.length % 7 !== 0) out.push({ kind: 'pad', key: `trail-${out.length}` })
    return out
  }, [monthKey, month])

  // Keyed to the cursor, not the payload — while a month is in flight the
  // header must already say where the user is going.
  const isThisMonth = monthKey === thisMonthKey()
  // `month` still holds the previous payload until the new read lands; showing
  // it under a new heading would label July's cells "August".
  const stale = !month || month.month !== monthKey
  const today = todayKey()

  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selected) return
    const id = requestAnimationFrame(() =>
      panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    )
    return () => cancelAnimationFrame(id)
  }, [selected, dayLoading])

  const go = (delta: number): void => {
    setSelected(null)
    setMonthKey((k) => shiftMonth(k, delta))
  }

  return (
    <section className="stm-cal-section">
      <div className="stm-cal-head">
        <div className="stm-cal-nav">
          <button className="stm-nav-btn" onClick={() => go(-1)} aria-label="Previous month">
            <Icon name="ChevronLeft" size={16} />
          </button>
          <span className="stm-cal-month">
            {monthLabel(monthKey)}
            {loading && <Icon name="Loader2" size={13} className="spin-ico" />}
          </span>
          <button className="stm-nav-btn" onClick={() => go(1)} aria-label="Next month">
            <Icon name="ChevronRight" size={16} />
          </button>
          <button
            className="stm-today-btn"
            onClick={() => {
              setSelected(null)
              setMonthKey(thisMonthKey())
            }}
            disabled={isThisMonth}
          >
            Today
          </button>
        </div>
        {canManage && (
          <Button size="sm" icon="Plus" onClick={() => onAddManual(selected ?? today)}>
            Add a stream
          </Button>
        )}
      </div>

      {error ? (
        <div className="stm-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{error}</span>
          <Button size="sm" icon="RefreshCw" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
        </div>
      ) : stale ? (
        <div className="stm-cal-grid" aria-hidden="true">
          {Array.from({ length: 35 }, (_, i) => (
            <span className="stm-skel" key={i} />
          ))}
        </div>
      ) : (
        <>
          <div className="stm-sum">
            <SumItem icon="CircleDot" value={String(month.totals.sessionCount)} label="streams" />
            <SumItem icon="Timer" value={formatDuration(month.totals.minutes)} label="on air" />
            <SumItem icon="Layers" value={formatUnitCount(month.totals.breakUnits)} label="stock units broken" />
            <SumItem icon="Gift" value={formatUnitCount(month.totals.giveawayUnits)} label="stock units given" />
            <SumItem
              icon="DollarSign"
              value={formatMoney(month.totals.totalCost)}
              label="cost of stock consumed"
              strong
            />
          </div>

          <div className={`stm-cal ${loading ? 'is-loading' : ''}`}>
            <div className="stm-cal-week">
              {WEEKDAYS.map((w) => (
                <span className="stm-wd" key={w}>
                  {w}
                </span>
              ))}
            </div>
            <div className="stm-cal-grid">
              {cells.map((cell) =>
                cell.kind === 'pad' ? (
                  <span className="stm-cell pad" key={cell.key} aria-hidden="true" />
                ) : (
                  <DayCell
                    key={cell.key}
                    dateKey={cell.key}
                    day={cell.day}
                    isToday={cell.key === today}
                    selected={selected === cell.key}
                    onSelect={() => setSelected((s) => (s === cell.key ? null : cell.key))}
                  />
                )
              )}
            </div>
          </div>

          {month.days.length === 0 && !loading && (
            <div className="stm-empty-row">
              <Icon name="Moon" size={15} />
              No streams in {monthLabel(monthKey)}. Start one from the bar above, or add a show that
              already happened.
            </div>
          )}

          {selected && (
            <div ref={panelRef}>
              <DayPanel
                dateKey={selected}
                sessions={daySessions}
                loading={dayLoading}
                error={dayError}
                canManage={canManage}
                onClose={() => setSelected(null)}
                onOpen={onOpen}
                onAddManual={onAddManual}
              />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function SumItem({
  icon,
  value,
  label,
  strong
}: {
  icon: string
  value: string
  label: string
  strong?: boolean
}): JSX.Element {
  return (
    <span className={`stm-sum-item ${strong ? 'strong' : ''}`}>
      <Icon name={icon} size={13} />
      <b className="mono">{value}</b>
      <em>{label}</em>
    </span>
  )
}

function DayCell({
  dateKey,
  day,
  isToday,
  selected,
  onSelect
}: {
  dateKey: string
  /** null when the month read returned nothing for this day — i.e. it was quiet. */
  day: StreamCalendarDay | null
  isToday: boolean
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const live = (day?.liveCount ?? 0) > 0
  const label = day
    ? `${longDayLabel(dateKey)} — ${day.sessionCount} stream${day.sessionCount === 1 ? '' : 's'}, ${formatDuration(day.minutes)}, ${formatMoney(day.cost)}`
    : `${longDayLabel(dateKey)} — no streams`

  return (
    <button
      type="button"
      className={[
        'stm-cell',
        day ? 'has-activity' : 'quiet',
        live ? 'is-live' : '',
        selected ? 'selected' : '',
        isToday ? 'today' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={selected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={label}
      onClick={onSelect}
    >
      <span className="stm-cell-top">
        <span className="stm-cell-num">{dayNumberOf(dateKey)}</span>
        {isToday && <span className="stm-today-dot">Today</span>}
        {live && (
          <span className="stm-cell-live">
            <span className="stm-live-dot small" aria-hidden="true" />
            LIVE
          </span>
        )}
      </span>

      {day ? (
        <span className="stm-cell-body">
          <span className="stm-cell-count">
            <Icon name="CircleDot" size={11} />
            {day.sessionCount} stream{day.sessionCount === 1 ? '' : 's'}
          </span>
          <span className="stm-cell-dur mono">{formatDuration(day.minutes)}</span>
          <span className="stm-cell-units">
            {day.breakUnits > 0 && (
              <em title={`${formatUnitCount(day.breakUnits)} stock units broken`}>
                <Icon name="Layers" size={10} />
                {formatUnitCount(day.breakUnits)}
              </em>
            )}
            {day.giveawayUnits > 0 && (
              <em title={`${formatUnitCount(day.giveawayUnits)} stock units given away`}>
                <Icon name="Gift" size={10} />
                {formatUnitCount(day.giveawayUnits)}
              </em>
            )}
          </span>
          <span className="stm-cell-cost mono">{formatMoney(day.cost, { compact: true })}</span>
        </span>
      ) : (
        // A quiet day says nothing at all. Zeroes here would read as a loss.
        <span className="stm-cell-quiet" aria-hidden="true" />
      )}
    </button>
  )
}

function DayPanel({
  dateKey,
  sessions,
  loading,
  error,
  canManage,
  onClose,
  onOpen,
  onAddManual
}: {
  dateKey: string
  sessions: StreamSession[]
  loading: boolean
  error: string | null
  canManage: boolean
  onClose: () => void
  onOpen: (id: string) => void
  onAddManual: (dateKey: string) => void
}): JSX.Element {
  return (
    <div className="stm-day-panel">
      <div className="stm-day-head">
        <span className="stm-day-date">
          <Icon name="CalendarDays" size={15} />
          {longDayLabel(dateKey)}
        </span>
        {canManage && (
          <Button size="sm" icon="Plus" onClick={() => onAddManual(dateKey)}>
            Add a stream here
          </Button>
        )}
        <button className="stm-day-close" onClick={onClose} aria-label="Close this day">
          <Icon name="X" size={16} />
        </button>
      </div>

      {loading ? (
        <div className="stm-day-loading">
          <Icon name="Loader2" size={15} className="spin-ico" /> Reading that day&hellip;
        </div>
      ) : error ? (
        <div className="stm-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{error}</span>
        </div>
      ) : sessions.length === 0 ? (
        <div className="stm-empty-row">
          <Icon name="Moon" size={14} />
          Nothing was streamed on this day.
        </div>
      ) : (
        <div className="stm-day-rows">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

/** One session as a row. Shared by the day panel and the Sessions tab. */
export function SessionRow({
  session,
  showDate,
  onOpen
}: {
  session: StreamSession
  showDate?: boolean
  onOpen: (id: string) => void
}): JSX.Element {
  return (
    <button type="button" className="stm-row" onClick={() => onOpen(session.id)}>
      <span className="stm-row-main">
        <b className="stm-row-title">{session.title}</b>
        <span className="stm-row-meta">
          {showDate && <span className="stm-row-date">{longDayLabel(session.streamDate)}</span>}
          <TimeSpan session={session} withDuration />
          {session.hostName && (
            <span className="stm-row-host">
              <Icon name="User" size={11} />
              {session.hostName}
            </span>
          )}
        </span>
      </span>
      <span className="stm-row-chips">
        {session.status === 'live' && <LiveChip />}
        <SourceChip source={session.source} />
      </span>
      <Icon name="ChevronRight" size={16} />
    </button>
  )
}
