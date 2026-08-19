import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StaffBoard as Board } from '@shared/staffBoard'
import type { Shift } from '@shared/schedule'
import {
  addMonths,
  dayLabel,
  monthGrid,
  monthLabel,
  monthOf,
  shiftTimeLabel
} from '@shared/schedule'
import { dayKey, payrollPeriodFor } from '@shared/homeTasks'
import { api } from '../../lib/api'
import { useChrome } from '../../lib/chrome'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { formatHours } from '../../lib/format'
import { SendReminder } from './OwnerBoard'

/**
 * The floor's home page.
 *
 * Three questions, and the order is the answer to "what do I open this for":
 * what is waiting for me, what have I earned this fortnight, when am I next in.
 *
 * ## What is NOT here, and why
 *
 * The owner's board — the P&L, the payables, the stock valuation, who else is on
 * the clock. Every one of those is either none of a packer's business or nothing
 * they can act on, and a landing screen full of numbers somebody cannot act on
 * teaches them to stop reading the screen.
 *
 * The quick actions are gone too. There is no router in this app, so an action
 * can only ever land on a module's default screen — and the two modules a packer
 * can open are already in the sidebar, on screen at all times. A row of
 * shortcuts to the same two places is furniture.
 *
 * The reminders half is SEND ONLY, which is not a simplification of the owner's
 * card but the whole of what a reminder is from this side: you write it and it
 * goes to whoever runs the place. There is no inbox here because nobody writes
 * back — the inbox is the other end of this same pipe, and it lives on the
 * owner's board where somebody can act on it.
 */
export function StaffBoard(): JSX.Element | null {
  const { navigate } = useChrome()
  const [board, setBoard] = useState<Board | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    setBoard(await api.staff.board())
  }, [])

  // Every family a card here reads. Shipping because tonight's pile changes as
  // the bench works it, people because the clock is a time entry, and schedule
  // because the rota is written on the lead's machine and read on this one.
  useLiveRefresh(LIVE.shipping, load)
  useLiveRefresh(LIVE.people, load)
  useLiveRefresh(LIVE.schedule, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoaded(true)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  if (!loaded || !board) return null

  return (
    <div className="ob">
      <div className="ob-grid">
        {board.sorting && <SortingCard board={board} onOpen={() => navigate('fulfillment')} />}
        <HoursCard board={board} onOpen={() => navigate('timepay')} />
      </div>

      <ShiftsCard
        shifts={board.allShifts}
        upcoming={board.shifts}
        onOpen={() => navigate('schedule')}
      />

      <div className="ob-card ob-span" style={{ marginTop: 12 }}>
        <header>
          <Icon name="Send" size={16} />
          <h3>Send a reminder</h3>
          <span className="ob-sub">Goes straight to whoever runs the floor</span>
        </header>
        <div style={{ padding: '12px 14px 14px' }}>
          <SendReminder bare />
        </div>
      </div>
    </div>
  )
}

/**
 * Tonight's pile.
 *
 * The three numbers the owner asked for, in the order somebody standing at a
 * bench needs them: how many orders, off how many breaks, from when. "From when"
 * is answered with the upload time rather than the event date whenever the slip
 * did not carry one, because these PDFs usually do not and a blank line is worse
 * than an honest approximation clearly labelled.
 */
function SortingCard({ board, onOpen }: { board: Board; onOpen: () => void }): JSX.Element {
  const s = board.sorting
  if (!s) return <></>
  const from = s.eventDate
    ? dayLabel(s.eventDate)
    : s.importedAt
      ? dayLabel(s.importedAt.slice(0, 10))
      : null
  const done = s.imported && s.orders === 0

  return (
    <div className="ob-card">
      <header onClick={onOpen} style={{ cursor: 'pointer' }}>
        <Icon name="Layers" size={16} />
        <h3>To sort</h3>
        <span className="ob-sub">
          {!s.imported ? 'No slip imported' : done ? 'All sorted' : `${s.cardsLeft} cards left`}
        </span>
        <span className="ob-open">
          Open <Icon name="ArrowRight" size={13} />
        </span>
      </header>

      {!s.imported ? (
        <p className="ob-empty">
          Nothing imported yet — the slip for the last show has not been uploaded.
        </p>
      ) : (
        <>
          <div className="sb-figures">
            <span className="sb-fig" data-lead="true">
              <b className="mono">{s.orders}</b>
              <em>order{s.orders === 1 ? '' : 's'} to sort</em>
            </span>
            <span className="sb-fig">
              <b className="mono">{s.breaks}</b>
              <em>break{s.breaks === 1 ? '' : 's'}</em>
            </span>
            <span className="sb-fig">
              <b className="mono">{s.cardsLeft}</b>
              <em>cards</em>
            </span>
          </div>
          {/* Progress against the whole night, not against what is left. A bar
              that always reads "some way to go" tells nobody anything; one that
              fills as the night is worked is the only reason to draw it. */}
          {s.cardsTotal > 0 && (
            <div className="sb-bar" title={`${s.cardsTotal - s.cardsLeft} of ${s.cardsTotal} sorted`}>
              <span
                style={{
                  width: `${Math.round(((s.cardsTotal - s.cardsLeft) / s.cardsTotal) * 100)}%`
                }}
              />
            </div>
          )}
          <p className="ob-foot">
            {done
              ? 'Every card on this slip is checked off.'
              : from
                ? `From ${from}${s.eventName ? ` · ${s.eventName}` : ''}`
                : 'The slip does not say which night it is for.'}
          </p>
        </>
      )}
    </div>
  )
}

/**
 * This fortnight.
 *
 * The period shown is the one PAYROLL runs on — every second Wednesday from 5
 * August 2026 — because a figure that adds up over a different window from the
 * one that pays is worse than no figure at all.
 */
function HoursCard({ board, onOpen }: { board: Board; onOpen: () => void }): JSX.Element {
  const h = board.hours
  const today = dayKey(new Date())
  const daysLeft = Math.max(0, Math.round((Date.parse(`${h.end}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000))

  return (
    <div className="ob-card">
      <header onClick={onOpen} style={{ cursor: 'pointer' }}>
        <Icon name="Clock" size={16} />
        <h3>This pay period</h3>
        <span className="ob-sub">
          {h.start.slice(5)} – {h.end.slice(5)}
        </span>
        <span className="ob-open">
          Open <Icon name="ArrowRight" size={13} />
        </span>
      </header>

      <div className="sb-hours">
        <b className="mono">{formatHours(h.minutes)}</b>
        {h.onTheClock && (
          <span className="ob-flag" data-tone="ok">
            ON THE CLOCK
          </span>
        )}
      </div>

      <div className="sb-figures">
        <span className="sb-fig">
          <b className="mono">{formatHours(h.minutesToday)}</b>
          <em>today</em>
        </span>
        <span className="sb-fig">
          <b className="mono">{h.daysWorked}</b>
          <em>day{h.daysWorked === 1 ? '' : 's'} in</em>
        </span>
        <span className="sb-fig">
          <b className="mono">{daysLeft}</b>
          <em>day{daysLeft === 1 ? '' : 's'} left</em>
        </span>
      </div>

      {/* Both dates, because they are two different days and the gap between
          them is the question people actually ask. "Paid on the 19th" when the
          money arrives on the 21st is the kind of wrong that gets noticed at
          the bank rather than here. */}
      <p className="ob-foot">
        Run on {dayLabel(h.runOn)}, paid on {dayLabel(h.paidOn)}.
      </p>
    </div>
  )
}

/**
 * The rota, as a month.
 *
 * A calendar rather than a list because the question is "when am I in", and the
 * shape of a month answers that in a way a list of dates does not — four
 * Thursdays in a column is a pattern; four dates in a row is arithmetic.
 *
 * The upcoming shifts are listed BESIDE it rather than only marked on it. A dot
 * on the 14th tells you there is a shift; it does not tell you it starts at four
 * or that it is the pack bench, and those are the parts somebody acts on.
 */
function ShiftsCard({
  shifts,
  upcoming,
  onOpen
}: {
  shifts: Shift[]
  upcoming: Shift[]
  onOpen: () => void
}): JSX.Element {
  const today = dayKey(new Date())
  const [month, setMonth] = useState(() => monthOf(today))

  const byDay = useMemo(() => {
    const map = new Map<string, Shift[]>()
    for (const s of shifts) {
      const list = map.get(s.day)
      if (list) list.push(s)
      else map.set(s.day, [s])
    }
    return map
  }, [shifts])

  const cells = useMemo(() => monthGrid(month), [month])
  const period = payrollPeriodFor(today)

  return (
    <div className="ob-card ob-span" style={{ marginTop: 12 }}>
      <header>
        <Icon name="CalendarDays" size={16} />
        {/* A door, not a place to work — marking availability happens in
            Schedule, and the header is how you get there from here. */}
        <h3 className="sb-link" onClick={onOpen} title="Open Schedule">
          Your shifts
        </h3>
        <span className="ob-sub">
          {upcoming.length === 0
            ? 'Nothing scheduled yet'
            : `${upcoming.length} coming up`}
        </span>
        <div className="sb-month-nav">
          <button onClick={() => setMonth((m) => addMonths(m, -1))} title="Previous month">
            <Icon name="ChevronLeft" size={15} />
          </button>
          <span>{monthLabel(month)}</span>
          <button onClick={() => setMonth((m) => addMonths(m, 1))} title="Next month">
            <Icon name="ChevronRight" size={15} />
          </button>
        </div>
      </header>

      <div className="sb-schedule">
        <div className="sb-cal">
          <div className="sb-cal-head">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="sb-cal-grid">
            {cells.map((c) => {
              const day = byDay.get(c.day) ?? []
              return (
                <div
                  key={c.day}
                  className="sb-cal-cell"
                  data-out={c.inMonth ? 'false' : 'true'}
                  data-today={c.day === today ? 'true' : 'false'}
                  data-on={day.length > 0 ? 'true' : 'false'}
                  data-past={c.day < today ? 'true' : 'false'}
                  /* The pay period the CURRENT day sits in, shaded across the
                     calendar. It is the same fortnight the card above adds up,
                     so somebody can see which of these shifts that number is
                     made of rather than being asked to take it on trust. */
                  data-period={c.day >= period.start && c.day <= period.end ? 'true' : 'false'}
                  title={day.length > 0 ? day.map((s) => shiftTimeLabel(s)).join(', ') : undefined}
                >
                  <span className="sb-cal-date">{c.date}</span>
                  {day.length > 0 && (
                    <span className="sb-cal-time">
                      {day[0].startTime ? shiftTimeLabel(day[0]).split(' – ')[0] : '•'}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="sb-next">
          <div className="sb-next-head">Coming up</div>
          {upcoming.length === 0 ? (
            <p className="ob-empty" style={{ padding: '10px 0' }}>
              Nothing on the rota yet. Your shifts appear here as soon as a lead
              puts them in.
            </p>
          ) : (
            <ul className="ob-shows">
              {upcoming.map((s) => (
                <li key={s.id} data-live={s.day === today ? 'true' : 'false'}>
                  <span className="ob-show-when">
                    {dayLabel(s.day)}
                    <em>{shiftTimeLabel(s)}</em>
                  </span>
                  <span className="ob-show-title">{s.note || 'Shift'}</span>
                  {s.day === today && <span className="ob-live">TODAY</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
