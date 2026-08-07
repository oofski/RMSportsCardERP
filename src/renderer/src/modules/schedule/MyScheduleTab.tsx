import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Availability, AvailabilityStatus, Shift } from '@shared/schedule'
import {
  AVAILABILITY_NOTE_MAX,
  addMonths,
  availabilityLabel,
  dayLabel,
  formatClock,
  monthGrid,
  monthLabel,
  monthOf,
  shiftTimeLabel,
  upcomingFrom
} from '@shared/schedule'
import { dayKey } from '@shared/homeTasks'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { useToast } from '../../components/Toast'

/**
 * One person's schedule: when they are in, and what they have said about the
 * days nobody has put them on yet.
 *
 * ## Both on one calendar, and it has to be one
 *
 * A shift and an availability answer are about the same square of the same
 * month, and the interesting cases are exactly where they disagree — rostered
 * on a day you said you could not work; free every Thursday and never on the
 * rota. Two calendars side by side would make somebody hold one in their head
 * while reading the other, which is the moment a clash gets missed.
 *
 * So one grid, and the SHIFT wins the cell when there is one. A shift is a fact
 * about your week; availability is a thing you said about it, and a decision
 * that has already been taken outranks a preference that fed into it. The
 * availability still shows, as a mark in the corner, precisely so a clash is
 * visible rather than overwritten.
 *
 * ## Three states, not a checkbox
 *
 * Available, unavailable, and NOTHING SAID. Silence is a real answer and must
 * stay distinct from both: read as "unavailable" it would mean nobody gets
 * rostered until they opt in; read as "available" it would mean nobody's day
 * off is ever respected. So clearing a day is its own action rather than
 * un-ticking a box.
 */
export function MyScheduleTab(): JSX.Element {
  const toast = useToast()
  const today = dayKey(new Date())
  const [shifts, setShifts] = useState<Shift[]>([])
  const [answers, setAnswers] = useState<Availability[]>([])
  const [loading, setLoading] = useState(true)
  const [month, setMonth] = useState(() => monthOf(today))
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([api.staff.myShifts(), api.staff.myAvailability()])
    setShifts(s)
    setAnswers(a)
  }, [])

  useLiveRefresh(LIVE.schedule, load)

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

  const shiftByDay = useMemo(() => {
    const map = new Map<string, Shift>()
    for (const s of shifts) if (!map.has(s.day)) map.set(s.day, s)
    return map
  }, [shifts])

  const answerByDay = useMemo(() => {
    const map = new Map<string, Availability>()
    for (const a of answers) map.set(a.day, a)
    return map
  }, [answers])

  const cells = useMemo(() => monthGrid(month), [month])
  const upcoming = useMemo(() => upcomingFrom(shifts, today, 6), [shifts, today])

  const save = async (
    day: string,
    status: AvailabilityStatus,
    startTime: string,
    endTime: string,
    note: string
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.staff.setAvailability({ day, status, startTime, endTime, note })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save that.')
        return
      }
      toast.success(
        status === 'available' ? `Marked ${dayLabel(day)} as free.` : `Marked ${dayLabel(day)} off.`
      )
      await load()
      setOpenDay(null)
    } finally {
      setBusy(false)
    }
  }

  const clear = async (day: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.staff.clearAvailability(day)
      if (!res.ok) toast.error(res.error ?? 'Could not clear that.')
      await load()
      setOpenDay(null)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <CenterLoader />

  const marked = answers.filter((a) => a.day >= today).length

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Your schedule</h2>
        </div>
        <div className="sb-month-nav">
          <button onClick={() => setMonth((m) => addMonths(m, -1))} title="Previous month">
            <Icon name="ChevronLeft" size={15} />
          </button>
          <span>{monthLabel(month)}</span>
          <button onClick={() => setMonth((m) => addMonths(m, 1))} title="Next month">
            <Icon name="ChevronRight" size={15} />
          </button>
        </div>
      </div>

      <p className="sched-hint">
        Tap a day to say whether you can work it. {marked === 0
          ? 'You have not marked any days yet — the more you mark, the better the rota fits.'
          : `You have marked ${marked} day${marked === 1 ? '' : 's'} ahead.`}
      </p>

      <div className="sched-legend">
        <span className="sched-key" data-kind="shift">
          <i /> On the rota
        </span>
        <span className="sched-key" data-kind="available">
          <i /> Can work
        </span>
        <span className="sched-key" data-kind="unavailable">
          <i /> Cannot work
        </span>
        <span className="sched-key" data-kind="clash">
          <i /> Rostered on a day you said no
        </span>
      </div>

      <div className="sched-cal">
        <div className="sb-cal-head">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="sb-cal-grid">
          {cells.map((c) => {
            const shift = shiftByDay.get(c.day)
            const answer = answerByDay.get(c.day)
            // The one arrangement worth a colour of its own: on the rota for a
            // day you already said you could not do. Nobody has to spot it.
            const clash = !!shift && answer?.status === 'unavailable'
            const past = c.day < today
            return (
              <button
                key={c.day}
                className="sched-cell"
                data-out={c.inMonth ? 'false' : 'true'}
                data-today={c.day === today ? 'true' : 'false'}
                data-past={past ? 'true' : 'false'}
                data-shift={shift ? 'true' : 'false'}
                data-mark={clash ? 'clash' : (answer?.status ?? 'none')}
                // The past is not something to have an opinion about, and the
                // handler refuses it — so the button refuses it too rather than
                // opening a form that can only fail.
                disabled={past}
                onClick={() => setOpenDay(c.day)}
                title={
                  [
                    shift ? `On the rota · ${shiftTimeLabel(shift)}` : null,
                    answer ? availabilityLabel(answer) : null
                  ]
                    .filter(Boolean)
                    .join(' — ') || undefined
                }
              >
                <span className="sched-date">{c.date}</span>
                {shift && (
                  <span className="sched-shift">
                    {shift.startTime ? formatClock(shift.startTime) : 'IN'}
                  </span>
                )}
                {answer && (
                  <span className="sched-mark" aria-hidden="true">
                    <Icon
                      name={
                        clash ? 'AlertTriangle' : answer.status === 'available' ? 'Check' : 'Ban'
                      }
                      size={11}
                      strokeWidth={3}
                    />
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {openDay && (
        <DayEditor
          day={openDay}
          shift={shiftByDay.get(openDay) ?? null}
          answer={answerByDay.get(openDay) ?? null}
          busy={busy}
          onSave={save}
          onClear={clear}
          onClose={() => setOpenDay(null)}
        />
      )}

      <div className="panel-card" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h3>Coming up</h3>
          <span className="ph-sub">Shifts a lead has put you on</span>
        </div>
        {upcoming.length === 0 ? (
          <p className="ob-empty">
            Nothing on the rota yet. Marking the days you can work above is what a lead
            builds it from.
          </p>
        ) : (
          <ul className="ob-shows">
            {upcoming.map((s) => {
              const answer = answerByDay.get(s.day)
              return (
                <li key={s.id} data-live={s.day === today ? 'true' : 'false'}>
                  <span className="ob-show-when">
                    {dayLabel(s.day)}
                    <em>{shiftTimeLabel(s)}</em>
                  </span>
                  <span className="ob-show-title">{s.note || 'Shift'}</span>
                  {answer?.status === 'unavailable' ? (
                    <span className="ob-flag" data-tone="danger">
                      YOU SAID NO
                    </span>
                  ) : s.day === today ? (
                    <span className="ob-live">TODAY</span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </>
  )
}

/**
 * Answering for one day.
 *
 * Inline under the calendar rather than a modal, for the same reason the rota
 * editor is: marking availability is half a dozen of these in a row, and a
 * dialog reopened for each turns a minute into a chore.
 *
 * The two buttons are the whole interface. Times are optional and folded away
 * behind "Can work", because "free from 4pm" is a real answer and "free" is the
 * common one — asking for times up front would make the common answer the
 * slower one.
 */
function DayEditor({
  day,
  shift,
  answer,
  busy,
  onSave,
  onClear,
  onClose
}: {
  day: string
  shift: Shift | null
  answer: Availability | null
  busy: boolean
  onSave: (
    day: string,
    status: AvailabilityStatus,
    startTime: string,
    endTime: string,
    note: string
  ) => Promise<void>
  onClear: (day: string) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [status, setStatus] = useState<AvailabilityStatus>(answer?.status ?? 'available')
  const [startTime, setStartTime] = useState(answer?.startTime ?? '')
  const [endTime, setEndTime] = useState(answer?.endTime ?? '')
  const [note, setNote] = useState(answer?.note ?? '')

  return (
    <div className="rota-add-panel">
      <div className="rota-add-head">
        <Icon name="CalendarPlus" size={15} />
        <b>{dayLabel(day)}</b>
        {shift && (
          <span className="ob-sub">On the rota · {shiftTimeLabel(shift)}</span>
        )}
        <button className="rota-x" onClick={onClose} title="Close">
          <Icon name="X" size={14} />
        </button>
      </div>

      {/* A shift you already said no to is the one thing on this screen that
          needs saying in words rather than a colour — the person to fix it is a
          lead, not the packer reading this. */}
      {shift && answer?.status === 'unavailable' && (
        <div className="sched-clash">
          <Icon name="AlertTriangle" size={15} />
          <span>
            You are on the rota for this day and have said you cannot work it. Send a
            reminder from the home page so a lead can move it.
          </span>
        </div>
      )}

      <div className="sched-choice">
        <button
          className={`sched-opt ${status === 'available' ? 'on' : ''}`}
          data-kind="available"
          onClick={() => setStatus('available')}
        >
          <Icon name="Check" size={15} />
          I can work
        </button>
        <button
          className={`sched-opt ${status === 'unavailable' ? 'on' : ''}`}
          data-kind="unavailable"
          onClick={() => setStatus('unavailable')}
        >
          <Icon name="Ban" size={15} />
          I cannot work
        </button>
      </div>

      <div className="rota-add-row">
        {status === 'available' && (
          <>
            <label>
              From
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </label>
            <label>
              Until
              <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </>
        )}
        <label className="rota-note">
          {status === 'available' ? 'Note' : 'Reason (optional)'}
          <input
            value={note}
            maxLength={AVAILABILITY_NOTE_MAX}
            placeholder={status === 'available' ? 'Any time after class…' : 'Away, exam, …'}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSave(day, status, startTime, endTime, note)
            }}
          />
        </label>
        <Button
          variant="primary"
          size="sm"
          icon="Check"
          loading={busy}
          onClick={() => void onSave(day, status, startTime, endTime, note)}
        >
          Save
        </Button>
        {/* Only when there IS something to take back. "Clear" on a day nobody
            has answered is a button that can only tell you it did nothing. */}
        {answer && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void onClear(day)}>
            Say nothing
          </Button>
        )}
      </div>
    </div>
  )
}
