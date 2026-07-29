import { useMemo, useState } from 'react'
import type { StreamDayFinance } from '@shared/financeStreaming'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { plural } from './bits'
import { type DayRange, rangeOf } from './range'
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
 * The month view — the navigator for the whole Streaming tab.
 *
 * WHAT IT IS FOR: one glance answers "did we make money, and on which days",
 * and one drag answers "what did that stretch make". The headline on every cell
 * is NET PROFIT, the whole statement collapsed to one figure.
 *
 * IT SELECTS A RANGE, NOT A DAY. Clicking once starts a range on that day and
 * everything above updates to it; clicking a second day closes the range across
 * the span. That is the whole reason the widgets and the statement can be
 * "dynamic to a date range" — there is one selection on this screen and it is
 * this one. A single day is just a range whose ends match, so nothing was lost
 * in the change: the day statement is what a one-day range renders.
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
 * WHICH MONTH IS OPEN AND WHAT IS SELECTED ARE PROPS, not state, so navigating
 * away from Finance and back does not throw the operator out of the month they
 * were reading.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Cell =
  | { kind: 'pad'; key: string }
  | { kind: 'day'; key: string; day: StreamDayFinance | null }

export function FinanceCalendar({
  days,
  month,
  range,
  onMonth,
  onRange
}: {
  days: StreamDayFinance[]
  /** null means "follow the latest month with money in it". */
  month: string | null
  /** null means all time — no cell is highlighted. */
  range: DayRange | null
  onMonth: (key: string) => void
  onRange: (range: DayRange | null) => void
}): JSX.Element {
  /**
   * The first click of a two-click range. While it is set, hovering previews
   * what the second click would select — without it, the first click looks like
   * it selected one day and the second like it moved the selection, and nobody
   * discovers that ranges exist.
   */
  const [anchor, setAnchor] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)

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

  /** How many days on this month's grid carry a show — used only to explain an
   *  empty month, never to summarise one. The figures live in the widgets. */
  const activeInMonth = useMemo(
    () => cells.filter((c) => c.kind === 'day' && c.day).length,
    [cells]
  )

  const today = todayKey()
  const isThisMonth = monthKey === thisMonthKey()

  /**
   * What is painted as selected right now: the live range while a second click
   * is pending, otherwise the committed one. Derived rather than stored, so the
   * preview cannot survive the click that ends it.
   */
  const painted: DayRange | null = anchor ? rangeOf(anchor, hover ?? anchor) : range

  const click = (key: string): void => {
    if (anchor === null) {
      setAnchor(key)
      // Commit the single day immediately. Waiting for a second click would
      // leave the widgets showing the previous range while the calendar showed
      // a new selection — a screen briefly describing two different periods.
      onRange({ from: key, to: key })
      return
    }
    setAnchor(null)
    setHover(null)
    onRange(rangeOf(anchor, key))
  }

  const go = (delta: number): void => {
    setAnchor(null)
    setHover(null)
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
              setAnchor(null)
              onMonth(thisMonthKey())
            }}
            disabled={isThisMonth}
          >
            Today
          </button>
        </div>

        <span className="fin-cal-hint">
          {anchor ? (
            <>
              <Icon name="CalendarRange" size={13} />
              Now click the other end of the range
              <button type="button" className="fin-cal-cancel" onClick={() => setAnchor(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <Icon name="MousePointerClick" size={13} />
              Click a day, then a second day for a range
            </>
          )}
        </span>
      </div>

      <div className="fin-cal">
        <div className="fin-cal-week">
          {WEEKDAYS.map((w) => (
            <span className="fin-wd" key={w}>
              {w}
            </span>
          ))}
        </div>
        <div className="fin-cal-grid" onMouseLeave={() => setHover(null)}>
          {cells.map((cell) =>
            cell.kind === 'pad' ? (
              <span className="fin-cell pad" key={cell.key} aria-hidden="true" />
            ) : (
              <DayCell
                key={cell.key}
                dateKey={cell.key}
                day={cell.day}
                isToday={cell.key === today}
                selected={inPainted(painted, cell.key)}
                pending={anchor !== null}
                onClick={() => click(cell.key)}
                onHover={() => anchor && setHover(cell.key)}
              />
            )
          )}
        </div>
      </div>

      {activeInMonth === 0 && (
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
                setAnchor(null)
                onMonth(latestMonth)
              }}
            >
              <Icon name="ArrowRight" size={14} />
              Go to {monthLabel(latestMonth)}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Whether a day is inside the painted range. Every day in it is marked the
 *  same way — see the .fin-cell.in-range note in app.css for why the ends are
 *  no longer drawn differently from the middle. */
function inPainted(range: DayRange | null, key: string): boolean {
  return range !== null && key >= range.from && key <= range.to
}

function DayCell({
  dateKey,
  day,
  isToday,
  selected,
  pending,
  onClick,
  onHover
}: {
  dateKey: string
  /** null when no show landed on this day — i.e. it was quiet. */
  day: StreamDayFinance | null
  isToday: boolean
  selected: boolean
  pending: boolean
  onClick: () => void
  onHover: () => void
}): JSX.Element {
  // Guarded for the main/renderer skew `Pnl.tsx` guards: a build without
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
        selected ? 'in-range' : '',
        isToday ? 'today' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-pressed={selected}
      aria-current={isToday ? 'date' : undefined}
      aria-label={label}
      // EVERY day is clickable now, including quiet ones. A range from the 1st
      // to the 31st has to be selectable whether or not a show ran on either
      // end, and a disabled cell in the middle of a month is a hole the drag
      // falls into.
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={pending ? onHover : undefined}
    >
      <span className="fin-cell-top">
        <span className="fin-cell-num">{dayNumberOf(dateKey)}</span>
        {isToday && <span className="fin-cell-today">Today</span>}
      </span>

      {day ? (
        <span className="fin-cell-body">
          {known ? (
            <span className={`fin-cell-net mono ${tone}`}>{compactMoney(net)}</span>
          ) : (
            <span className="fin-cell-unknown mono" title="This build did not send a profit figure">
              —
            </span>
          )}
          <span className="fin-cell-sub">
            <span className="fin-cell-shows">
              <Icon name="CircleDot" size={9} />
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
 * Money on a cell, at cell width.
 *
 * Compact ("$4.2K") because seven of these sit across the grid and an exact
 * figure at that width either wraps or truncates. The exact number is in the
 * widgets the moment the day is clicked.
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
