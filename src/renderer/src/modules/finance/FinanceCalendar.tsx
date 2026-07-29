import { useEffect, useMemo, useRef } from 'react'
import type { StreamDayFinance } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { Money, Profit, plural } from './bits'
import { DayStatement } from './Statement'
import {
  dayKeyOf,
  dayNumberOf,
  longDayLabel,
  monthKeyOfDayKey,
  monthLabel,
  parseMonthKey,
  shiftMonth,
  thisMonthKey,
  todayKey
} from './time'

/**
 * The month view — the front door of Finance → Streaming.
 *
 * WHAT IT IS FOR: one glance answers "did we make money, and on which days".
 * The headline on every cell is NET PROFIT, the whole statement collapsed to one
 * figure, and clicking it opens the statement it came from.
 *
 * The grid is built from the month's own shape and the days are joined onto it,
 * exactly as `StreamCalendar` does in Streaming — the two calendars are the same
 * object seen twice (a show, and what the show earned), so they are laid out the
 * same way and behave the same way. A quiet day prints NOTHING: a grid of
 * $0.00 makes a month with three shows in it look like a month that lost money
 * on twenty-eight days.
 *
 * Cells are keyed by `streamDate` — the day a show STARTED — so a Friday show
 * that sold until 2am appears once, on Friday, with all of its money.
 *
 * WHICH MONTH IS OPEN AND WHICH DAY IS SELECTED ARE PROPS, not state. They used
 * to live here, which meant switching the grain to Week and back destroyed this
 * component and with it the operator's place in the month — a whole navigation
 * undone by pressing a button that was supposed to change one number's grain.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Cell =
  | { kind: 'pad'; key: string }
  | { kind: 'day'; key: string; day: StreamDayFinance | null }

/** What a month's cells add up to. Summed from the DAYS on screen rather than
 *  read from a rollup, so the strip can never claim a total the grid beneath it
 *  does not show. */
interface MonthTotals {
  netProfit: number
  totalRevenue: number
  dayCount: number
  sessionCount: number
  minutes: number
}

export function FinanceCalendar({
  days,
  month,
  selected,
  onMonth,
  onSelect
}: {
  days: StreamDayFinance[]
  /** null means "follow the latest month with money in it". */
  month: string | null
  selected: string | null
  onMonth: (key: string) => void
  onSelect: (key: string | null) => void
}): JSX.Element {
  const byDate = useMemo(() => {
    const m = new Map<string, StreamDayFinance>()
    for (const d of days) m.set(d.streamDate, d)
    return m
  }, [days])

  /**
   * Open on the LATEST month that has money in it, not on the current month.
   *
   * The ledger is a file somebody uploaded; it is normal for the most recent
   * export to stop weeks before today. Opening on an empty August, with July
   * full of shows one click away, would read as "the import did not work".
   *
   * Derived, never stored, and there is deliberately NO effect here that snaps
   * back to it. This component unmounts every time the grain changes to Week,
   * so a "follow the newest month" effect would fire on remount and throw the
   * operator back to July every time they came back from a weekly view — which
   * is exactly the lost place this refactor exists to stop. Following a fresh
   * import is the parent's job, because the parent stays mounted.
   */
  const latestMonth = useMemo(() => {
    let best = ''
    for (const d of days) {
      const k = monthKeyOfDayKey(d.streamDate)
      if (k > best) best = k
    }
    return best || thisMonthKey()
  }, [days])

  const monthKey = month ?? latestMonth

  const cells = useMemo<Cell[]>(() => {
    const parsed = parseMonthKey(monthKey)
    if (!parsed) return []
    const first = new Date(parsed.year, parsed.month - 1, 1)
    const daysInMonth = new Date(parsed.year, parsed.month, 0).getDate()
    const out: Cell[] = []
    // Leading blanks belong to the previous month. They are inert padding, not
    // days — they carry no number and no figure, so nothing on screen implies
    // this month started on a Sunday.
    for (let i = 0; i < first.getDay(); i++) out.push({ kind: 'pad', key: `lead-${i}` })
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dayKeyOf(new Date(parsed.year, parsed.month - 1, d))
      out.push({ kind: 'day', key, day: byDate.get(key) ?? null })
    }
    while (out.length % 7 !== 0) out.push({ kind: 'pad', key: `trail-${out.length}` })
    return out
  }, [monthKey, byDate])

  const totals = useMemo<MonthTotals>(() => {
    const t: MonthTotals = {
      netProfit: 0,
      totalRevenue: 0,
      dayCount: 0,
      sessionCount: 0,
      minutes: 0
    }
    for (const cell of cells) {
      if (cell.kind !== 'day' || !cell.day) continue
      const d = cell.day
      t.netProfit += Number.isFinite(d.netProfit) ? d.netProfit : 0
      t.totalRevenue += d.totalRevenue
      t.dayCount += 1
      t.sessionCount += d.sessionCount
      t.minutes += d.minutes
    }
    // Rounded once, at the end. Twenty-eight float additions left unrounded
    // print a month total a cent away from the days it was summed from.
    t.netProfit = Math.round(t.netProfit * 100) / 100
    t.totalRevenue = Math.round(t.totalRevenue * 100) / 100
    return t
  }, [cells])

  const today = todayKey()
  const isThisMonth = monthKey === thisMonthKey()
  const selectedDay = selected ? (byDate.get(selected) ?? null) : null

  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!selectedDay) return
    const id = requestAnimationFrame(() =>
      panelRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    )
    return () => cancelAnimationFrame(id)
  }, [selectedDay])

  const go = (delta: number): void => {
    onSelect(null)
    onMonth(shiftMonth(monthKey, delta))
  }

  return (
    <div className="fin-cal-section">
      <div className="fin-cal-head">
        <div className="fin-cal-nav">
          <button className="fin-nav-btn" onClick={() => go(-1)} aria-label="Previous month">
            <Icon name="ChevronLeft" size={16} />
          </button>
          <span className="fin-cal-month">{monthLabel(monthKey)}</span>
          <button className="fin-nav-btn" onClick={() => go(1)} aria-label="Next month">
            <Icon name="ChevronRight" size={16} />
          </button>
          <button
            className="fin-today-btn"
            onClick={() => {
              onSelect(null)
              onMonth(thisMonthKey())
            }}
            disabled={isThisMonth}
          >
            Today
          </button>
        </div>

        <MonthTotalsStrip totals={totals} label={monthLabel(monthKey)} />
      </div>

      <div className="fin-cal">
        <div className="fin-cal-week">
          {WEEKDAYS.map((w) => (
            <span className="fin-wd" key={w}>
              {w}
            </span>
          ))}
        </div>
        <div className="fin-cal-grid">
          {cells.map((cell) =>
            cell.kind === 'pad' ? (
              <span className="fin-cell pad" key={cell.key} aria-hidden="true" />
            ) : (
              <DayCell
                key={cell.key}
                dateKey={cell.key}
                day={cell.day}
                isToday={cell.key === today}
                selected={selected === cell.key}
                onSelect={() => onSelect(selected === cell.key ? null : cell.key)}
              />
            )
          )}
        </div>
      </div>

      {totals.dayCount === 0 && (
        <div className="fin-cal-empty">
          <Icon name="Moon" size={15} />
          <span>
            No shows landed on any day in {monthLabel(monthKey)}.
            {latestMonth !== monthKey && (
              <>
                {' '}
                The most recent month with money in it is <b>{monthLabel(latestMonth)}</b>.
              </>
            )}
          </span>
          {latestMonth !== monthKey && (
            <button
              type="button"
              className="fin-more"
              onClick={() => {
                onSelect(null)
                onMonth(latestMonth)
              }}
            >
              <Icon name="ArrowRight" size={14} />
              Go to {monthLabel(latestMonth)}
            </button>
          )}
        </div>
      )}

      {selectedDay && (
        <div ref={panelRef}>
          <DayStatement day={selectedDay} onClose={() => onSelect(null)} />
        </div>
      )}

      {/* Selected a day the ledger has nothing on. Saying so beats silently
          doing nothing, which reads as a click that did not register. */}
      {selected && !selectedDay && (
        <div className="fin-cal-empty">
          <Icon name="Moon" size={15} />
          <span>
            Nothing was streamed on {longDayLabel(selected)}, so there is no statement for it.
          </span>
          <button type="button" className="fin-more" onClick={() => onSelect(null)}>
            <Icon name="X" size={14} />
            Close
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The month's bottom line, beside the month's name.
 *
 * Net profit is the strong figure here for the same reason it is the headline on
 * every cell: it is the question. Revenue and time on air sit beside it as the
 * two things that make a profit figure interpretable — $400 on one show and $400
 * on nine are not the same month.
 *
 * No box around it. It sits inside a card already, and a bordered strip on a
 * bordered card is a frame drawn twice; a hairline on its left does the same
 * separating job with a tenth of the ink.
 */
function MonthTotalsStrip({
  totals,
  label
}: {
  totals: MonthTotals
  label: string
}): JSX.Element {
  if (totals.dayCount === 0) {
    return <span className="fin-cal-total is-quiet">No activity in {label}</span>
  }

  return (
    <div className="fin-cal-total">
      <span className="fin-cal-fig is-main">
        <em>Net profit</em>
        <Profit value={totals.netProfit} />
      </span>
      <span className="fin-cal-fig">
        <em>Revenue</em>
        <Money value={totals.totalRevenue} strong />
      </span>
      <span className="fin-cal-fig">
        <em>Streamed</em>
        <b className="mono">{plural(totals.dayCount, 'day')}</b>
        <i>
          {plural(totals.sessionCount, 'show')} · {formatDuration(totals.minutes)}
        </i>
      </span>
    </div>
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
  /** null when no show landed on this day — i.e. it was quiet. */
  day: StreamDayFinance | null
  isToday: boolean
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  // Guarded for the same main/renderer skew `Pnl.tsx` guards: a build without
  // netProfit must not print a confident $0.00 on a day that sold thousands.
  const known = day !== null && Number.isFinite(day.netProfit)
  const net = day && Number.isFinite(day.netProfit) ? day.netProfit : 0
  const tone = !known ? '' : net > 0.005 ? 'is-up' : net < -0.005 ? 'is-down' : 'is-flat'

  // Spelled out in words: a screen reader gets "made" or "lost", not a colour
  // and a glyph it has no way to convey.
  const label = !day
    ? `${longDayLabel(dateKey)} — nothing streamed`
    : known
      ? `${longDayLabel(dateKey)} — ${net < 0 ? 'lost' : 'made'} ${formatMoney(
          Math.abs(net)
        )}, ${plural(day.sessionCount, 'show')}`
      : `${longDayLabel(dateKey)} — ${plural(day.sessionCount, 'show')}, net profit unavailable`

  return (
    <button
      type="button"
      className={[
        'fin-cell',
        day ? 'has-activity' : 'quiet',
        tone,
        selected ? 'selected' : '',
        isToday ? 'today' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={selected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={label}
      disabled={!day}
      onClick={onSelect}
    >
      <span className="fin-cell-top">
        <span className="fin-cell-num">{dayNumberOf(dateKey)}</span>
        {isToday && <span className="fin-cell-today">Today</span>}
      </span>

      {day ? (
        <span className="fin-cell-body">
          {known ? (
            <Profit value={net} />
          ) : (
            <span className="fin-cell-unknown mono" title="This build did not send a profit figure">
              —
            </span>
          )}
          <span className="fin-cell-sub">
            <span className="fin-cell-shows">
              <Icon name="CircleDot" size={10} />
              {day.sessionCount}
            </span>
            <span className="fin-cell-rev mono" title="Revenue before any deduction">
              {compactMoney(day.totalRevenue)}
            </span>
          </span>
        </span>
      ) : (
        // A quiet day says nothing at all. A zero here would read as a day that
        // ran and made nothing, which is a completely different fact.
        <span className="fin-cell-quiet" aria-hidden="true" />
      )}
    </button>
  )
}

/**
 * Revenue on a cell, at cell width.
 *
 * Compact ("$4.2K") because it is the SECONDARY figure — its job is to say
 * whether the profit above it came off a big day or a small one, and a second
 * exact figure would compete with the headline for the same 100px. The exact
 * number is one click away in the statement.
 *
 * One decimal ALWAYS above a thousand, so a column of cells reads $4.2K, $1.0K,
 * $12.5K rather than mixing $4.2K with $1K — the eye lines those up on the wrong
 * digit. And the minus is swapped for U+2212 like every other figure on the
 * screen, because a compact number is still a number.
 *
 * The threshold is 999.50, not 1000: Intl decides the K suffix from the value
 * AFTER rounding to the digits it was given, so $999.99 with no decimals prints
 * "$1K" while $1,000.00 prints "$1.0K" — one cent apart and formatted two
 * different ways.
 */
function compactMoney(value: number): string {
  const big = Math.abs(value) >= 999.5
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    minimumFractionDigits: big ? 1 : 0,
    maximumFractionDigits: big ? 1 : 0
  })
    .format(value)
    .replace('-', '−')
}
