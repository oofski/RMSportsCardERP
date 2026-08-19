import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  PAYROLL_ANCHOR,
  PAYROLL_EVERY_DAYS,
  PAYROLL_PAY_LAG_DAYS,
  PAYROLL_RUN_LAG_DAYS,
  dayKey
} from '@shared/homeTasks'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatHours } from '../../lib/format'

/**
 * Somebody's own hours — every shift they have worked, and what each payroll
 * period came to.
 *
 * THIS IS THEIRS AND NOBODY ELSE'S. The employee is taken from the session
 * inside the handler and never from anything this screen sends, so there is no
 * argument to get wrong and no id to leak. That is the whole reason it is a
 * separate operation from the admin timesheet rather than the same one with a
 * filter: a filter can be forgotten.
 *
 * Two views of one fact, because the two questions are different. The calendar
 * answers "did I work that Tuesday", which somebody asks when a day looks wrong.
 * The period totals answer "what am I being paid for", which is what they
 * actually opened this for — and those totals are cut on the SAME fortnight
 * payroll runs on, from the same anchor, because a timesheet that adds up over a
 * different fortnight than the one that pays is worse than no timesheet at all.
 */

interface Hours {
  days: Array<{ day: string; minutes: number; shifts: number }>
  periods: Array<{
    start: string
    end: string
    runOn: string
    paidOn: string
    current: boolean
    minutes: number
  }>
  totalMinutes: number
  firstDay: string | null
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

function shortDate(day: string): string {
  const [, m, d] = day.split('-')
  return `${MONTHS[Number(m) - 1]?.slice(0, 3) ?? m} ${Number(d)}`
}

export function MyHours(): JSX.Element {
  const [hours, setHours] = useState<Hours | null>(null)
  const [loading, setLoading] = useState(true)
  const [monthOffset, setMonthOffset] = useState(0)

  const load = useCallback(async () => {
    setHours((await api.owner.myHours()) as Hours | null)
  }, [])

  // Clocking in on the warehouse tablet has to show up here.
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

  const byDay = useMemo(() => {
    const m = new Map<string, { minutes: number; shifts: number }>()
    for (const d of hours?.days ?? []) m.set(d.day, { minutes: d.minutes, shifts: d.shifts })
    return m
  }, [hours])

  if (loading) return <CenterLoader />
  if (!hours) {
    return <EmptyState icon="Clock" title="Sign in to see your hours." />
  }
  if (hours.days.length === 0) {
    return (
      <EmptyState
        icon="Clock"
        title="No shifts yet"
        message="Clock in from the home page or the warehouse tablet and your hours appear here."
      />
    )
  }

  // The month being looked at. Starts on this one; steps back through the whole
  // tenure and refuses to go earlier than the first shift, so the arrows cannot
  // walk into empty years.
  const now = new Date()
  const shown = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  const year = shown.getFullYear()
  const month = shown.getMonth()
  const first = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const lead = first.getDay()
  const firstDay = hours.firstDay ?? dayKey(now)
  const atStart = `${year}-${String(month + 1).padStart(2, '0')}-01` <= firstDay.slice(0, 7) + '-01'

  const cells: Array<{ day: string; minutes: number; shifts: number } | null> = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const hit = byDay.get(key)
    cells.push({ day: key, minutes: hit?.minutes ?? 0, shifts: hit?.shifts ?? 0 })
  }

  const monthMinutes = cells.reduce((n, c) => n + (c?.minutes ?? 0), 0)

  return (
    <div>
      <div className="stat-grid">
        <Tile value={formatHours(hours.totalMinutes)} label="Hours, all time" />
        <Tile
          value={formatHours(hours.periods.find((p) => p.current)?.minutes ?? 0)}
          label="This pay period"
        />
        <Tile value={hours.firstDay ? shortDate(hours.firstDay) : '—'} label="First shift" />
      </div>

      <div className="panel-row">
        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>
                {MONTHS[month]} {year}
              </h3>
              <span className="ph-sub">{formatHours(monthMinutes)} this month</span>
            </div>
            <div className="mh-nav">
              <button
                className="icon-btn"
                disabled={atStart}
                title="Earlier"
                onClick={() => setMonthOffset((v) => v - 1)}
              >
                <Icon name="ChevronLeft" size={16} />
              </button>
              <button
                className="icon-btn"
                disabled={monthOffset >= 0}
                title="Later"
                onClick={() => setMonthOffset((v) => Math.min(0, v + 1))}
              >
                <Icon name="ChevronRight" size={16} />
              </button>
            </div>
          </div>

          <div className="mh-grid">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div className="mh-head" key={`${d}-${i}`}>
                {d}
              </div>
            ))}
            {cells.map((c, i) =>
              c === null ? (
                <div className="mh-cell empty" key={`pad-${i}`} />
              ) : (
                <div
                  className={`mh-cell ${c.minutes > 0 ? 'worked' : ''}`}
                  key={c.day}
                  title={
                    c.minutes > 0
                      ? `${formatHours(c.minutes)} over ${c.shifts} shift${c.shifts === 1 ? '' : 's'}`
                      : 'No shift'
                  }
                >
                  <span className="mh-n">{Number(c.day.slice(-2))}</span>
                  {c.minutes > 0 && <span className="mh-h">{formatHours(c.minutes)}</span>}
                </div>
              )
            )}
          </div>
        </div>

        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>Pay periods</h3>
              <span className="ph-sub">Sunday to Saturday, every fortnight</span>
            </div>
          </div>
          <div className="metric-list">
            {hours.periods.map((p) => (
              <div className="metric-row" key={p.start}>
                <span className="m-k">
                  {shortDate(p.start)} – {shortDate(p.end)}
                  {p.current && <span className="mh-now">now</span>}
                </span>
                <span className="m-v mono">{formatHours(p.minutes)}</span>
              </div>
            ))}
          </div>
          <p className="mh-note">
            A period is {PAYROLL_EVERY_DAYS} days of work, Sunday to Saturday. Payroll is run{' '}
            {PAYROLL_RUN_LAG_DAYS} days after it closes and the money lands{' '}
            {PAYROLL_PAY_LAG_DAYS} days after it closes — so a fortnight ending on a Saturday is run
            that Wednesday and paid that Friday. The series starts {shortDate(PAYROLL_ANCHOR)}.
          </p>
        </div>
      </div>
    </div>
  )
}

function Tile({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name="Clock" size={21} />
      </div>
      <div>
        <div className="stat-val">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
