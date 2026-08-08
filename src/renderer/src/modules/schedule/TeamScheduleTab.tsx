import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AvailabilityPattern, TeamScheduleOverview } from '@shared/schedule'
import {
  WEEKDAY_NAMES,
  availabilityLabel,
  dayLabel,
  formatClock,
  scheduleAlerts,
  weekdayOf
} from '@shared/schedule'
import { addDays } from '@shared/homeTasks'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { CenterLoader } from '../../components/ui'
import { formatHours } from '../../lib/format'

/**
 * The lead's view of the team's week.
 *
 * ## Three panels, in the order somebody plans in
 *
 * WHAT NEEDS DOING first. A lead does not open this to browse — they open it
 * because a week has to be filled. So the top of the screen is the short list
 * of things somebody would act on: a person rostered against a stated no, a
 * night with nobody on it and people free to take it, a person whose usual week
 * has never been set. If the list is empty the week is fine, and saying so in
 * one line is worth more than a dashboard.
 *
 * COVERAGE second. Seven columns, one per night: how many are free, how many
 * are away, how many are on. This is the shape of the decision — "Thursday has
 * four free and nobody on" — and it is one click from the day it names.
 *
 * EVERYBODY'S USUAL WEEK last, because it is reference rather than news. It
 * changes about once a term and is read when somebody is being added to a night,
 * not every time the tab opens.
 *
 * ## Blank is not "no"
 *
 * The single easiest way to get this screen wrong is to draw a person who has
 * never set a usual week the same as a person who marked every day off. One is
 * "never asked" and the other is "cannot work"; rostering decisions made from
 * the first reading of the second are how somebody ends up not being asked for a
 * month. So an unset row is drawn as unset AND named in the alerts.
 */
export function TeamScheduleTab({
  weekStart,
  onOpenDay
}: {
  weekStart: string
  /** Jump to the rota editor on a given day. */
  onOpenDay: (day: string) => void
}): JSX.Element {
  const [overview, setOverview] = useState<TeamScheduleOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])

  const load = useCallback(async () => {
    setOverview(await api.staff.teamSchedule(weekStart, weekEnd))
  }, [weekStart, weekEnd])

  useLiveRefresh(LIVE.schedule, load)
  useLiveRefresh(LIVE.people, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  const alerts = useMemo(() => (overview ? scheduleAlerts(overview) : []), [overview])

  if (loading || !overview) return <CenterLoader />

  const totalShifts = overview.people.reduce((n, p) => n + p.shiftsInRange, 0)
  const totalMinutes = overview.people.reduce((n, p) => n + p.minutesInRange, 0)
  const withPattern = overview.people.filter((p) => p.hasPattern).length

  return (
    <>
      {/* ---- What needs doing ------------------------------------------- */}
      <div className="panel-card">
        <div className="panel-head">
          <h3>Needs attention</h3>
          <span className="ph-sub">
            {dayLabel(weekStart)} – {dayLabel(weekEnd)}
          </span>
        </div>
        {alerts.length === 0 ? (
          <p className="ob-empty">
            Nothing to sort out — every night is covered and nobody is rostered against
            a day they said no to.
          </p>
        ) : (
          <ul className="ts-alerts">
            {alerts.map((a, i) => (
              <li key={`${a.kind}-${a.day ?? i}-${i}`} data-kind={a.kind}>
                <Icon
                  name={
                    a.kind === 'clash'
                      ? 'AlertTriangle'
                      : a.kind === 'no-pattern'
                        ? 'Info'
                        : 'CalendarDays'
                  }
                  size={14}
                />
                <span>{a.text}</span>
                {a.day && (
                  <button className="ts-alert-go" onClick={() => onOpenDay(a.day as string)}>
                    Open <Icon name="ArrowRight" size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Coverage ---------------------------------------------------- */}
      <div className="panel-card" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h3>Coverage this week</h3>
          <span className="ph-sub">
            {totalShifts} shift{totalShifts === 1 ? '' : 's'} · {formatHours(totalMinutes)} rostered
          </span>
        </div>
        <div className="ts-cover">
          {overview.days.map((d) => (
            <button
              key={d.day}
              className="ts-cover-day"
              /* The state worth colouring is a gap that CAN be filled. A night
                 with nobody on and nobody free is a different problem with a
                 different fix, and calling them the same thing sends a lead
                 looking for a name that is not there. */
              data-gap={d.rostered === 0 && d.free > 0 ? 'true' : 'false'}
              data-clash={d.clashes > 0 ? 'true' : 'false'}
              onClick={() => onOpenDay(d.day)}
              title={`Open ${dayLabel(d.day)} on the rota`}
            >
              <span className="ts-cover-name">{WEEKDAY_NAMES[weekdayOf(d.day)].slice(0, 3)}</span>
              <span className="ts-cover-on">{d.rostered}</span>
              <span className="ts-cover-sub">on</span>
              <span className="ts-cover-bits">
                <em data-kind="free">{d.free} free</em>
                <em data-kind="away">{d.away} away</em>
                {d.unknown > 0 && <em data-kind="unknown">{d.unknown} ?</em>}
              </span>
              {d.clashes > 0 && (
                <span className="ts-cover-flag">
                  <Icon name="AlertTriangle" size={10} strokeWidth={3} />
                  {d.clashes}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ---- Everybody's usual week -------------------------------------- */}
      <div className="panel-card" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h3>Everyone&rsquo;s usual week</h3>
          <span className="ph-sub">
            {withPattern} of {overview.people.length} set
          </span>
        </div>

        {overview.people.length === 0 ? (
          <p className="ob-empty">Nobody on the roster yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data ts-week">
              <thead>
                <tr>
                  <th>Person</th>
                  {WEEKDAY_NAMES.map((n) => (
                    <th key={n} style={{ textAlign: 'center' }}>
                      {n.slice(0, 3)}
                    </th>
                  ))}
                  <th style={{ textAlign: 'right' }}>This week</th>
                </tr>
              </thead>
              <tbody>
                {overview.people.map((p) => {
                  const byWeekday = new Map<number, AvailabilityPattern>(
                    p.pattern.map((x) => [x.weekday, x])
                  )
                  return (
                    <tr key={p.employeeId} data-unset={p.hasPattern ? 'false' : 'true'}>
                      <td>
                        <span style={{ fontWeight: 600 }}>{p.employeeName}</span>
                        {!p.hasPattern && (
                          <span className="ts-unset"> — not set</span>
                        )}
                      </td>
                      {WEEKDAY_NAMES.map((name, weekday) => {
                        const cell = byWeekday.get(weekday)
                        return (
                          <td key={name} style={{ textAlign: 'center' }}>
                            <span
                              className="ts-cell"
                              data-status={cell?.status ?? 'none'}
                              title={
                                cell
                                  ? `${name}s — ${availabilityLabel(cell)}${cell.note ? ` (${cell.note})` : ''}`
                                  : `${p.employeeName} has said nothing about ${name}s`
                              }
                            >
                              {cell?.status === 'available' ? (
                                cell.startTime ? (
                                  formatClock(cell.startTime).replace(':00', '')
                                ) : (
                                  <Icon name="Check" size={12} strokeWidth={3} />
                                )
                              ) : cell?.status === 'unavailable' ? (
                                <Icon name="Ban" size={12} strokeWidth={3} />
                              ) : (
                                '·'
                              )}
                            </span>
                          </td>
                        )
                      })}
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ fontWeight: 600 }}>{p.shiftsInRange}</span>
                        {p.minutesInRange > 0 && (
                          <span className="muted"> · {formatHours(p.minutesInRange)}</span>
                        )}
                        {p.clashDays.length > 0 && (
                          <span className="ts-row-clash">
                            <Icon name="AlertTriangle" size={11} strokeWidth={3} />
                            {p.clashDays.length}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="ts-foot">
          A dot means that person has said nothing about that day — not that they are
          unavailable. Times shown are when they can start.
        </p>
      </div>
    </>
  )
}
