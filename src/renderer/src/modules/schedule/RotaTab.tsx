import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Employee } from '@shared/types'
import type { AvailabilityWithPerson, ShiftWithPerson } from '@shared/schedule'
import { addDays, dayKey } from '@shared/homeTasks'
import {
  availabilityLabel,
  dayLabel,
  formatClock,
  shiftTimeLabel,
  SHIFT_NOTE_MAX
} from '@shared/schedule'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { useToast } from '../../components/Toast'

/**
 * The rota, from the lead's side.
 *
 * A WEEK at a time, not a month. Rotas are made a week ahead — that is the unit
 * the decision is actually taken in — and a month grid with seven names in each
 * cell is unreadable at the size a screen gives it. The packers' own screen
 * shows a month, because reading "which Thursdays am I in" is a different job
 * from setting them.
 *
 * ## One shift per person per day
 *
 * Enforced in the repository, and it is a simplification rather than a
 * limitation: the floor works one shift a night, and the realistic way a second
 * row appears is somebody clicking Add twice. So adding again REPLACES, which
 * makes correcting a time the same gesture as setting one — there is no edit
 * mode to find and nothing to delete first.
 *
 * ## Copying a week
 *
 * The same four people on the same four nights, most weeks. Without this the
 * alternative is typing twenty-eight identical rows a month, which is how rotas
 * end up on a whiteboard instead of in the app. Shifts already on the target
 * week are left alone — a row already there was put there deliberately, most
 * likely because that week is the one that differs.
 */

/** The Monday on or before a day. */
function mondayOf(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  // getUTCDay: 0 = Sunday. A Sunday belongs to the week that just ended, which
  // is how a rota reads out loud ("Monday to Sunday"), so it goes back six.
  const dow = new Date(t).getUTCDay()
  return addDays(day, dow === 0 ? -6 : 1 - dow)
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function RotaTab({ employees }: { employees: Employee[] }): JSX.Element {
  const toast = useToast()
  const { can } = useSession()
  // READING the rota is admin.hours.view — the gate on the tab itself, beside
  // the team timesheet. CHANGING it is admin.employees.manage, which main
  // enforces regardless. Asking here as well is not a second gate; it is what
  // stops somebody being shown an Add button that answers "only a lead can
  // change the rota", which is a worse screen than no button.
  const canEdit = can('admin.employees.manage')
  const today = dayKey(new Date())
  const [weekStart, setWeekStart] = useState(() => mondayOf(today))
  const [shifts, setShifts] = useState<ShiftWithPerson[]>([])
  const [answers, setAnswers] = useState<AvailabilityWithPerson[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [openDay, setOpenDay] = useState<string | null>(null)

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  )

  const load = useCallback(async () => {
    // Both in one go. Reading them separately would let the week paint with a
    // rota and no answers against it, which is the state this screen exists to
    // avoid somebody making a decision in.
    const [s, a] = await Promise.all([
      api.staff.shifts(weekStart, weekEnd),
      api.staff.availability(weekStart, weekEnd)
    ])
    setShifts(s)
    setAnswers(a)
  }, [weekStart, weekEnd])

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

  const byDay = useMemo(() => {
    const map = new Map<string, ShiftWithPerson[]>()
    for (const s of shifts) {
      const list = map.get(s.day)
      if (list) list.push(s)
      else map.set(s.day, [s])
    }
    return map
  }, [shifts])

  /**
   * Everybody's answer for each day of this week, keyed day → employee.
   *
   * THE REASON AVAILABILITY EXISTS. A lead filling Thursday is guessing unless
   * the people who work Thursday have said something, and until now the way
   * that got said was a text message nobody could see a week later.
   */
  const answersByDay = useMemo(() => {
    const map = new Map<string, Map<string, AvailabilityWithPerson>>()
    for (const a of answers) {
      const forDay = map.get(a.day) ?? new Map<string, AvailabilityWithPerson>()
      forDay.set(a.employeeId, a)
      map.set(a.day, forDay)
    }
    return map
  }, [answers])

  // Disabled people can still appear on shifts already made — history is
  // history — but they are not offered for new ones.
  const roster = useMemo(
    () => employees.filter((e) => e.status !== 'disabled'),
    [employees]
  )

  const remove = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.staff.deleteShift(id)
      if (!res.ok) toast.error(res.error ?? 'Could not remove that shift.')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const copyLastWeek = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.staff.copyWeek(addDays(weekStart, -7), weekStart)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not copy that week.')
        return
      }
      const made = res.data?.created ?? 0
      toast.success(
        made === 0
          ? 'Nothing to copy — last week is empty, or this week already has those shifts.'
          : `Copied ${made} shift${made === 1 ? '' : 's'} from last week.`
      )
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Rota</h2>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="sb-month-nav">
            <button onClick={() => setWeekStart((w) => addDays(w, -7))} title="Previous week">
              <Icon name="ChevronLeft" size={15} />
            </button>
            <span style={{ minWidth: 150 }}>
              {dayLabel(weekStart)} – {dayLabel(weekEnd)}
            </span>
            <button onClick={() => setWeekStart((w) => addDays(w, 7))} title="Next week">
              <Icon name="ChevronRight" size={15} />
            </button>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setWeekStart(mondayOf(today))}>
            This week
          </Button>
          {canEdit && (
            <Button
              variant="secondary"
              size="sm"
              icon="Copy"
              loading={busy}
              onClick={() => void copyLastWeek()}
            >
              Copy last week
            </Button>
          )}
        </div>
      </div>

      <div className="rota-week">
        {days.map((day, i) => {
          const list = byDay.get(day) ?? []
          const said = answersByDay.get(day)
          // Who has said they cannot do this day and is NOT already on it. The
          // ones already on it are flagged individually below, which is the
          // louder problem; this is the quieter one — a name a lead is about to
          // add without knowing.
          const away = [...(said?.values() ?? [])].filter(
            (a) => a.status === 'unavailable' && !list.some((s) => s.employeeId === a.employeeId)
          )
          const free = [...(said?.values() ?? [])].filter(
            (a) => a.status === 'available' && !list.some((s) => s.employeeId === a.employeeId)
          )
          return (
            <div
              key={day}
              className="rota-day"
              data-today={day === today ? 'true' : 'false'}
              data-past={day < today ? 'true' : 'false'}
            >
              <div className="rota-day-head">
                <b>{WEEKDAYS[i]}</b>
                <span>{Number(day.slice(8))}</span>
              </div>
              <ul className="rota-list">
                {list.map((s) => {
                  // Rostered on a day they said they could not work. The single
                  // most useful thing this screen can tell a lead, so it is a
                  // colour on the row rather than something to go and check.
                  const clash = said?.get(s.employeeId)?.status === 'unavailable'
                  return (
                  <li key={s.id} data-clash={clash ? 'true' : 'false'}>
                    <span className="rota-who">
                      {clash && <Icon name="AlertTriangle" size={11} strokeWidth={3} />}
                      {s.employeeName}
                    </span>
                    <span className="rota-when">
                      {clash
                        ? 'Said they cannot work'
                        : (s.startTime ? formatClock(s.startTime) : 'TBC') +
                          (s.note ? ` · ${s.note}` : '')}
                    </span>
                    {canEdit && (
                      <button
                        className="rota-x"
                        title={`Remove ${s.employeeName} from ${dayLabel(day)}`}
                        disabled={busy}
                        onClick={() => void remove(s.id)}
                      >
                        <Icon name="X" size={12} />
                      </button>
                    )}
                  </li>
                  )
                })}
                {list.length === 0 && !canEdit && <li className="rota-none">Nobody in</li>}
              </ul>
              {(free.length > 0 || away.length > 0) && (
                <div className="rota-said">
                  {free.length > 0 && (
                    <span className="rota-said-row" data-kind="available">
                      <Icon name="Check" size={10} strokeWidth={3} />
                      {free.map((a) => a.employeeName.split(' ')[0]).join(', ')} free
                    </span>
                  )}
                  {away.length > 0 && (
                    <span className="rota-said-row" data-kind="unavailable">
                      <Icon name="Ban" size={10} strokeWidth={3} />
                      {away.map((a) => a.employeeName.split(' ')[0]).join(', ')} away
                    </span>
                  )}
                </div>
              )}
              {canEdit && (
                <button className="rota-add" onClick={() => setOpenDay(day)}>
                  <Icon name="Plus" size={13} />
                  Add
                </button>
              )}
            </div>
          )
        })}
      </div>

      {openDay && canEdit && (
        <AddShift
          day={openDay}
          roster={roster}
          existing={byDay.get(openDay) ?? []}
          said={answersByDay.get(openDay) ?? new Map()}
          onClose={() => setOpenDay(null)}
          onSaved={async () => {
            await load()
          }}
        />
      )}
    </>
  )
}

/**
 * Putting somebody on a day.
 *
 * Inline under the week rather than in a modal: setting a rota is half a dozen
 * of these in a row, and a dialog that has to be reopened for each one turns a
 * two-minute job into a chore. The person list excludes anybody already on that
 * day, so the same name cannot be added twice — the repository would replace
 * rather than duplicate, but offering it at all reads as though it would not.
 */
function AddShift({
  day,
  roster,
  existing,
  said,
  onClose,
  onSaved
}: {
  day: string
  roster: Employee[]
  existing: ShiftWithPerson[]
  /** What each person said about this day, keyed by employee id. */
  said: Map<string, AvailabilityWithPerson>
  onClose: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const taken = new Set(existing.map((s) => s.employeeId))
  /**
   * Who is left to add, ORDERED BY WHAT THEY SAID.
   *
   * People who said they are free first, then people who said nothing, then
   * people who said they cannot. Not a filter — a lead may have a good reason to
   * ask somebody who marked themselves off, and a list that hid them would send
   * that conversation back outside the app. But the default pick should be a
   * person who has already agreed to be asked.
   */
  const RANK: Record<string, number> = { available: 0, none: 1, unavailable: 2 }
  const available = roster
    .filter((e) => !taken.has(e.id))
    .map((e) => ({ e, status: said.get(e.id)?.status ?? 'none' }))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.e.firstName.localeCompare(b.e.firstName))
  const [employeeId, setEmployeeId] = useState(available[0]?.e.id ?? '')
  const [startTime, setStartTime] = useState('16:00')
  const [endTime, setEndTime] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (!employeeId || saving) return
    setSaving(true)
    try {
      const res = await api.staff.addShift({ employeeId, day, startTime, endTime, note })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save that shift.')
        return
      }
      await onSaved()
      // Stay open, on the same day, with the next person preselected. Setting a
      // rota is several of these in a row.
      setNote('')
      const next = available.find((a) => a.e.id !== employeeId)
      setEmployeeId(next?.e.id ?? '')
      if (!next) onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rota-add-panel">
      <div className="rota-add-head">
        <Icon name="CalendarPlus" size={15} />
        <b>{dayLabel(day)}</b>
        {existing.length > 0 && (
          <span className="ob-sub">
            {existing.map((s) => `${s.employeeName} ${shiftTimeLabel(s)}`).join(' · ')}
          </span>
        )}
        <button className="rota-x" onClick={onClose} title="Close">
          <Icon name="X" size={14} />
        </button>
      </div>

      {available.length === 0 ? (
        <p className="ob-empty">Everybody on the roster is already on this day.</p>
      ) : (
        <div className="rota-add-row">
          <label>
            Who
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              {available.map(({ e, status }) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName}
                  {status === 'available' ? ' — free' : status === 'unavailable' ? ' — away' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label>
            Until
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </label>
          <label className="rota-note">
            Note
            <input
              value={note}
              maxLength={SHIFT_NOTE_MAX}
              placeholder="Pack bench, breaking, …"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </label>
          <Button size="sm" icon="Plus" loading={saving} disabled={!employeeId} onClick={() => void save()}>
            Add
          </Button>
        </div>
      )}

      {/* Said out loud, not just sorted to the bottom. Adding somebody who
          marked themselves off is allowed — a lead may have a good reason to
          ask — but it must never happen by accident. */}
      {said.get(employeeId)?.status === 'unavailable' && (
        <div className="sched-clash">
          <Icon name="AlertTriangle" size={15} />
          <span>
            {said.get(employeeId)?.employeeName} said they cannot work this day
            {said.get(employeeId)?.note ? ` — “${said.get(employeeId)?.note}”` : ''}. You can
            still add them, but check with them first.
          </span>
        </div>
      )}
      {said.get(employeeId)?.status === 'available' && (
        <p className="rota-free-note">
          {availabilityLabel(said.get(employeeId) as AvailabilityWithPerson)}
          {said.get(employeeId)?.note ? ` — “${said.get(employeeId)?.note}”` : ''}
        </p>
      )}
    </div>
  )
}
