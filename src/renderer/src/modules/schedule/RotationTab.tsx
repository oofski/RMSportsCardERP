import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Employee } from '@shared/types'
import type { Role } from '@shared/permissions'
import type { EffectiveAvailabilityWithPerson, ShiftWithPerson } from '@shared/schedule'
import { addDays, dayKey } from '@shared/homeTasks'
import {
  dayCoverLabel,
  dayLabel,
  dayRoster,
  formatClock,
  groupByRole,
  type DayRosterEntry,
  hoursLabel,
  shiftNeedsPublishing,
  shiftTimeLabel,
  SHIFT_NOTE_MAX,
  totalShiftMinutes
} from '@shared/schedule'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Avatar, Button, CenterLoader } from '../../components/ui'
import { useToast } from '../../components/Toast'

/**
 * The rotation: one row per person, one column per day.
 *
 * ## Why the person is the row
 *
 * The old screen was seven columns of names — a day at a time, each with a list
 * under it. That answers "who is in on Thursday", which is the question a lead
 * asks about once. The question they ask about constantly is "how is Ada's week
 * looking", and to answer it on a day-column layout you had to read all seven
 * columns and hold the answer in your head.
 *
 * A person per row answers both. Ada's week is a line you read left to right;
 * Thursday is still a column you read top to bottom. And it gives somewhere
 * honest to put the two figures a rota is actually checked against — hours per
 * person, and cover per day — which had nowhere to live before.
 *
 * ## Grouped by the job, not by a second field
 *
 * Shipping, Breaker, Staff. That is the ROLE people already hold, not a
 * "position" invented for this screen: a second field would be a second thing to
 * change when somebody moves to the packing bench, and the day it disagrees with
 * the role is the day somebody gets rostered who cannot get into the building.
 *
 * ## Every cell is a button
 *
 * The row already says who and the column already says when, so putting somebody
 * on a day is one click on the square where those meet — no name to pick out of
 * a list of everybody. That is the whole of "select who I want to add": the
 * selection is the position of the cell.
 *
 * ## Nothing here is on anybody's phone until it is published
 *
 * See Shift.publishedAt. A week is built over an afternoon and the floor should
 * see the answer, not the working out.
 */

/** The Monday on or before a day. Sunday belongs to the week just ended. */
function mondayOf(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  const dow = new Date(t).getUTCDay()
  return addDays(day, dow === 0 ? -6 : 1 - dow)
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Two letters for the avatar, from whatever parts of a name exist. */
function initials(person: { firstName: string; lastName: string }): string {
  return `${person.firstName.charAt(0)}${person.lastName.charAt(0)}`.toUpperCase() || '?'
}

export function RotationTab({
  employees,
  weekStart,
  setWeekStart,
  focusDay,
  onFocusHandled
}: {
  employees: Employee[]
  /** Owned by the module so this tab and Team page together. */
  weekStart: string
  setWeekStart: (day: string) => void
  /** A day to open the editor on, set by a click from the Team tab. */
  focusDay: string | null
  onFocusHandled: () => void
}): JSX.Element {
  const toast = useToast()
  const { can } = useSession()
  // READING is admin.hours.view — the gate on the tab. CHANGING is
  // admin.employees.manage, which main enforces regardless; asking here is what
  // stops somebody being shown buttons that answer "only a lead can do that".
  const canEdit = can('admin.employees.manage')
  const today = dayKey(new Date())

  const [shifts, setShifts] = useState<ShiftWithPerson[]>([])
  const [answers, setAnswers] = useState<EffectiveAvailabilityWithPerson[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)
  /** The cell being edited: who, and which day. */
  const [editing, setEditing] = useState<{ employeeId: string; day: string } | null>(null)

  // ---- Filters. Three, and no more: who by name, which jobs, and whether to
  // bother drawing people with nothing on. Everything else a scheduling app
  // usually offers here is a way of hiding rows, which on a floor of a dozen
  // people is a way of missing one.
  const [query, setQuery] = useState('')
  const [hiddenRoles, setHiddenRoles] = useState<Set<Role>>(new Set())
  const [onlyRostered, setOnlyRostered] = useState(false)

  /**
   * WEEK OR ONE DAY.
   *
   * The grid answers "how is Ada's week looking". The other question a lead
   * asks — "who is in on Thursday, and who could be" — needs the day, because
   * on the grid the second half of it (who is free and NOT yet rostered) is not
   * drawn at all: availability is a tint behind a cell, and the cells that
   * matter for that question are the empty ones.
   *
   * The two share every filter and every read. Switching view re-sorts what is
   * already on screen; it does not fetch anything or forget where you were.
   */
  const [view, setView] = useState<'week' | 'day'>('week')
  const [dayShown, setDayShown] = useState<string>(() => today)

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart])
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

  const load = useCallback(async () => {
    // Both together. Painting the week with a rota and no availability against
    // it is precisely the state this screen exists to stop somebody deciding in.
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

  /**
   * A day clicked on the Team tab OPENS THAT DAY.
   *
   * It used to just scroll the week into view and stop, because a cell is a
   * person AND a day and Team had only named the day — so the click that a lead
   * makes on a thin-looking Thursday dead-ended on a grid of empty squares. The
   * day view needs only the day, which is exactly what was handed over.
   */
  useEffect(() => {
    if (!focusDay) return
    setDayShown(focusDay)
    setView('day')
    onFocusHandled()
  }, [focusDay, onFocusHandled])

  // A day is only meaningful inside the week on screen. Stepping the week takes
  // the focused day with it rather than leaving it behind on a week nobody is
  // looking at.
  useEffect(() => {
    if (dayShown < weekStart || dayShown > addDays(weekStart, 6)) {
      const sameWeekAsToday = today >= weekStart && today <= addDays(weekStart, 6)
      setDayShown(sameWeekAsToday ? today : weekStart)
    }
  }, [weekStart, dayShown, today])

  /** shift, keyed "employeeId|day" — the cell lookup. */
  const cells = useMemo(() => {
    const map = new Map<string, ShiftWithPerson>()
    for (const s of shifts) map.set(`${s.employeeId}|${s.day}`, s)
    return map
  }, [shifts])

  /** What each person said about each day, same key. */
  const said = useMemo(() => {
    const map = new Map<string, EffectiveAvailabilityWithPerson>()
    for (const a of answers) map.set(`${a.employeeId}|${a.day}`, a)
    return map
  }, [answers])

  const pending = useMemo(() => shifts.filter(shiftNeedsPublishing), [shifts])

  /**
   * The grid's rows, grouped and filtered.
   *
   * Disabled people are gone from here entirely: they can still appear on a
   * shift already made — history is history, and `shifts` still carries it — but
   * a rotation is about the weeks to come.
   */
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const roster = employees.filter((e) => {
      if (e.status === 'disabled') return false
      if (hiddenRoles.has(e.role)) return false
      if (needle && !`${e.firstName} ${e.lastName}`.toLowerCase().includes(needle)) return false
      if (onlyRostered && !days.some((d) => cells.has(`${e.id}|${d}`))) return false
      return true
    })
    return groupByRole(roster)
  }, [employees, query, hiddenRoles, onlyRostered, days, cells])

  /** Every role present on the roster, for the chips — not every role there is. */
  const roles = useMemo(
    () => groupByRole(employees.filter((e) => e.status !== 'disabled')).map((g) => g),
    [employees]
  )

  const shown = useMemo(() => groups.flatMap((g) => g.people), [groups])

  const minutesFor = useCallback(
    (employeeId: string, within: string[]): number =>
      totalShiftMinutes(
        within.map((d) => cells.get(`${employeeId}|${d}`)).filter((s): s is ShiftWithPerson => !!s)
      ),
    [cells]
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
          : `Copied ${made} shift${made === 1 ? '' : 's'}. Nobody has been told yet — press Publish when the week is right.`
      )
      await load()
    } finally {
      setBusy(false)
    }
  }

  const publish = async (): Promise<void> => {
    if (publishing || pending.length === 0) return
    setPublishing(true)
    try {
      const res = await api.staff.publishShifts(weekStart, weekEnd)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not publish the week.')
        return
      }
      const { published, people, notified, problem } = res.data
      toast.success(
        `${published} shift${published === 1 ? '' : 's'} published to ${people} ` +
          `${people === 1 ? 'person' : 'people'}. ${notified} phone${notified === 1 ? '' : 's'} buzzed.`
      )
      // SAID SEPARATELY, and not as a failure. The week IS published and is on
      // everybody's own screen; what did not happen is the doorbell, and the
      // reason is usually something an owner has to go and fix rather than
      // something to retry.
      if (problem) toast.error(`The week is published, but notifications did not send — ${problem}`)
      await load()
    } finally {
      setPublishing(false)
    }
  }

  if (loading) return <CenterLoader />

  const weekMinutes = shown.reduce((sum, p) => sum + minutesFor(p.id, days), 0)

  return (
    <div className="rot-shell">
      <div className="section-head">
        <div>
          <h2>Rotation</h2>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="sb-month-nav">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))} title="Previous week">
              <Icon name="ChevronLeft" size={15} />
            </button>
            <span style={{ minWidth: 150 }}>
              {dayLabel(weekStart)} – {dayLabel(weekEnd)}
            </span>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))} title="Next week">
              <Icon name="ChevronRight" size={15} />
            </button>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setWeekStart(mondayOf(today))}>
            This week
          </Button>
          {/* WEEK OR ONE DAY. Both are the same seven days and the same filters
              — this re-sorts what is already on screen rather than going
              anywhere. See the note on `view`. */}
          <div className="rot-view-toggle">
            <button
              className={view === 'week' ? 'on' : ''}
              onClick={() => setView('week')}
              title="Everybody's week, a person per row"
            >
              Week
            </button>
            <button
              className={view === 'day' ? 'on' : ''}
              onClick={() => setView('day')}
              title="One day: who is on, who is free, who said no"
            >
              Day
            </button>
          </div>
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
          {/* THE COUNT IS THE POINT. A Publish button with no number beside it
              gives no way to tell a week that is fully out from one with two
              shifts nobody has been told about — which is the state this whole
              draft mechanism exists to make visible. */}
          {canEdit && (
            <Button
              variant="primary"
              size="sm"
              icon="Send"
              loading={publishing}
              disabled={pending.length === 0}
              onClick={() => void publish()}
              title={
                pending.length === 0
                  ? 'Everybody has been told about this week'
                  : `${pending.length} shift${pending.length === 1 ? '' : 's'} not yet sent`
              }
            >
              Publish{pending.length > 0 ? ` (${pending.length})` : ''}
            </Button>
          )}
        </div>
      </div>

      <div className="rot-filters">
        <label className="rot-search">
          <Icon name="Search" size={14} />
          <input
            value={query}
            placeholder="Find someone"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button onClick={() => setQuery('')} title="Clear">
              <Icon name="X" size={13} />
            </button>
          )}
        </label>
        {/* One chip per job actually on the roster. Roles nobody holds are not
            offered — a filter for an empty set is a control that does nothing. */}
        <div className="rot-chips">
          {roles.map((g) => {
            const off = hiddenRoles.has(g.role)
            return (
              <button
                key={g.role}
                className={`rot-chip${off ? ' is-off' : ''}`}
                onClick={() =>
                  setHiddenRoles((prev) => {
                    const next = new Set(prev)
                    if (next.has(g.role)) next.delete(g.role)
                    else next.add(g.role)
                    return next
                  })
                }
              >
                {g.label}
                <span>{g.people.length}</span>
              </button>
            )
          })}
        </div>
        <label className="rot-toggle">
          <input
            type="checkbox"
            checked={onlyRostered}
            onChange={(e) => setOnlyRostered(e.target.checked)}
          />
          Only people on this week
        </label>
      </div>

      {view === 'day' && (
        <DayBoard
          day={dayShown}
          days={days}
          today={today}
          groups={groups}
          cells={cells}
          said={said}
          canEdit={canEdit}
          busy={busy}
          onDay={setDayShown}
          onOpen={(employeeId) => setEditing({ employeeId, day: dayShown })}
          onRemove={remove}
        />
      )}

      <div className="rot-scroll" hidden={view === 'day'}>
        <div className="rot-grid">
          <div className="rot-row rot-head">
            <div className="rot-name">{shown.length} people</div>
            {days.map((day, i) => (
              <div
                key={day}
                className="rot-cell rot-day-head"
                data-today={day === today ? 'true' : 'false'}
              >
                <b>{WEEKDAYS[i]}</b>
                <span>{Number(day.slice(8))}</span>
              </div>
            ))}
            <div className="rot-total">Total</div>
          </div>

          {groups.map((group) => (
            <div key={group.role} className="rot-group">
              <div className="rot-band" data-role={group.role}>
                {group.label}
                <span>
                  {group.people.length} {group.people.length === 1 ? 'person' : 'people'}
                </span>
              </div>

              {group.people.map((person) => {
                const mins = minutesFor(person.id, days)
                return (
                  <div key={person.id} className="rot-row">
                    <div className="rot-name">
                      <Avatar text={initials(person)} src={person.avatarUrl} small />
                      <span className="rot-person">
                        {person.firstName} {person.lastName}
                      </span>
                    </div>
                    {days.map((day) => (
                      <Cell
                        key={day}
                        shift={cells.get(`${person.id}|${day}`) ?? null}
                        answer={said.get(`${person.id}|${day}`) ?? null}
                        past={day < today}
                        canEdit={canEdit}
                        busy={busy}
                        onOpen={() => setEditing({ employeeId: person.id, day })}
                        onRemove={(id) => void remove(id)}
                      />
                    ))}
                    <div className="rot-total mono">{hoursLabel(mins)}</div>
                  </div>
                )
              })}

              {/* Cover per day, per job. The figure a lead is actually checking
                  when they look down a column: is there anybody on the bench on
                  Thursday. */}
              <div className="rot-row rot-sub">
                <div className="rot-name">On each day</div>
                {days.map((day) => {
                  const on = group.people.filter((p) => cells.has(`${p.id}|${day}`)).length
                  return (
                    <div key={day} className="rot-cell rot-count" data-none={on === 0 ? 'true' : 'false'}>
                      {on === 0 ? '—' : on}
                    </div>
                  )
                })}
                <div className="rot-total mono">
                  {hoursLabel(group.people.reduce((sum, p) => sum + minutesFor(p.id, days), 0))}
                </div>
              </div>
            </div>
          ))}

          {groups.length === 0 && (
            <div className="rot-empty">
              <Icon name="Users" size={22} />
              <p>Nobody matches those filters.</p>
            </div>
          )}

          <div className="rot-row rot-grand">
            <div className="rot-name">Everybody</div>
            {days.map((day) => {
              const on = shown.filter((p) => cells.has(`${p.id}|${day}`)).length
              return (
                <div key={day} className="rot-cell rot-count" data-none={on === 0 ? 'true' : 'false'}>
                  {on === 0 ? '—' : on}
                </div>
              )
            })}
            <div className="rot-total mono">{hoursLabel(weekMinutes)}</div>
          </div>
        </div>
      </div>

      {canEdit && pending.length > 0 && (
        <p className="rot-foot">
          <Icon name="Info" size={14} />
          <span>
            <b>
              {pending.length} shift{pending.length === 1 ? '' : 's'} on this week{' '}
              {pending.length === 1 ? 'is' : 'are'} not published.
            </b>{' '}
            Nobody has been told about {pending.length === 1 ? 'it' : 'them'} yet — a shift is only
            on somebody&rsquo;s own screen once you press Publish, which also buzzes their phone
            with their own days.
          </span>
        </p>
      )}

      {editing && canEdit && (
        <EditCell
          day={editing.day}
          person={employees.find((e) => e.id === editing.employeeId) ?? null}
          shift={cells.get(`${editing.employeeId}|${editing.day}`) ?? null}
          answer={said.get(`${editing.employeeId}|${editing.day}`) ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await load()
          }}
          onRemove={async (id) => {
            await remove(id)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * ONE DAY: who is on it, who could be, and who said no.
 *
 * ## Why this is not just a column of the grid
 *
 * The grid answers "how is Ada's week looking" and cannot answer "who could I
 * put on Thursday", because the answer to that lives in the EMPTY squares — and
 * an empty square is the one thing a grid is worst at drawing. Availability was
 * a tint behind a cell; the list of people who are free and not yet rostered was
 * on no screen at all, so filling a thin day meant reading a column, then going
 * to a different tab to find out who had said they could work.
 *
 * ## Three lists, in the order somebody works through them
 *
 * ON is what you have. FREE is what you can do about it. AWAY is the answer to
 * "why is nobody left" — shown rather than hidden, because a lead who cannot see
 * that four people said no will keep looking for a fifth.
 *
 * Somebody rostered on a day they said no to stays in ON and is marked. Filing
 * them under away would hide a real shift from the person building the rota.
 *
 * ## Adding somebody is one press
 *
 * The name is already on screen and the day is already chosen, so there is
 * nothing left to pick. The press opens the same time editor the grid uses —
 * one editor, so a shift set here and a shift set there cannot differ.
 */
function DayBoard({
  day,
  days,
  today,
  groups,
  cells,
  said,
  canEdit,
  busy,
  onDay,
  onOpen,
  onRemove
}: {
  day: string
  days: string[]
  today: string
  groups: Array<{ role: Role; label: string; people: Employee[] }>
  cells: Map<string, ShiftWithPerson>
  said: Map<string, EffectiveAvailabilityWithPerson>
  canEdit: boolean
  busy: boolean
  onDay: (day: string) => void
  onOpen: (employeeId: string) => void
  onRemove: (id: string) => Promise<void>
}): JSX.Element {
  // The SAME people the grid is showing — same search, same role chips, same
  // "only people on this week". Two lists of who counts is two answers to one
  // question, and the day is the one somebody acts on.
  const people = useMemo(() => groups.flatMap((g) => g.people), [groups])

  const roster = useMemo(
    () =>
      dayRoster(
        day,
        people,
        [...cells.values()],
        [...said.values()]
      ),
    [day, people, cells, said]
  )

  /** A bucket's entries under their job headings, so the shape matches the grid. */
  const byRole = (entries: typeof roster.on): Array<{ label: string; entries: typeof roster.on }> => {
    const order = groups.map((g) => g.role)
    const out: Array<{ label: string; entries: typeof roster.on }> = []
    for (const g of groups) {
      const mine = entries.filter((e) => e.person.role === g.role)
      if (mine.length > 0) out.push({ label: g.label, entries: mine })
    }
    // A role the chips have hidden cannot appear, so anything left over is a
    // person whose role is not in the current grouping at all — shown rather
    // than dropped, because a missing name on a rota is the worst outcome here.
    const rest = entries.filter((e) => !order.includes(e.person.role))
    if (rest.length > 0) out.push({ label: 'Other', entries: rest })
    return out
  }

  return (
    <div className="dayb">
      <div className="dayb-nav">
        {days.map((d) => {
          const count = [...cells.values()].filter((s) => s.day === d).length
          return (
            <button
              key={d}
              className={`dayb-pill${d === day ? ' on' : ''}`}
              data-today={d === today ? 'true' : 'false'}
              onClick={() => onDay(d)}
            >
              <b>{WEEKDAYS[days.indexOf(d)]}</b>
              <span>{d.slice(8)}</span>
              {/* The count is what makes this a way of FINDING the thin day
                  rather than a row of buttons you have to press to learn
                  anything. */}
              <em>{count > 0 ? count : '—'}</em>
            </button>
          )
        })}
      </div>

      <div className="dayb-head">
        <h3>{dayLabel(day)}</h3>
        <span>{dayCoverLabel(roster)}</span>
        {roster.clashes > 0 && (
          <span className="dayb-clash-count">
            <Icon name="AlertTriangle" size={12} />
            {roster.clashes} rostered against a no
          </span>
        )}
      </div>

      <div className="dayb-cols">
        <DayColumn
          title="On"
          count={roster.on.length}
          tone="on"
          empty="Nobody on this day yet."
          sections={byRole(roster.on)}
          canEdit={canEdit}
          busy={busy}
          onOpen={onOpen}
          onRemove={onRemove}
        />
        <DayColumn
          title="Free"
          count={roster.free.length}
          tone="free"
          empty="Everybody is either on or away."
          sections={byRole(roster.free)}
          canEdit={canEdit}
          busy={busy}
          onOpen={onOpen}
          onRemove={onRemove}
        />
        <DayColumn
          title="Said no"
          count={roster.away.length}
          tone="away"
          empty="Nobody has said they cannot work."
          sections={byRole(roster.away)}
          canEdit={canEdit}
          busy={busy}
          onOpen={onOpen}
          onRemove={onRemove}
        />
      </div>
    </div>
  )
}

/** One of the three lists, with its people under their job headings. */
function DayColumn({
  title,
  count,
  tone,
  empty,
  sections,
  canEdit,
  busy,
  onOpen,
  onRemove
}: {
  title: string
  count: number
  tone: 'on' | 'free' | 'away'
  empty: string
  sections: Array<{ label: string; entries: Array<DayRosterEntry<Employee>> }>
  canEdit: boolean
  busy: boolean
  onOpen: (employeeId: string) => void
  onRemove: (id: string) => Promise<void>
}): JSX.Element {
  return (
    <div className="dayb-col" data-tone={tone}>
      <div className="dayb-col-head">
        {title}
        <span>{count}</span>
      </div>
      {count === 0 ? (
        <p className="dayb-empty">{empty}</p>
      ) : (
        sections.map((sec) => (
          <div className="dayb-sec" key={sec.label}>
            <div className="dayb-sec-head">{sec.label}</div>
            {sec.entries.map((e) => (
              <div className={`dayb-row${e.clash ? ' is-clash' : ''}`} key={e.person.id}>
                <Avatar text={initials(e.person)} src={e.person.avatarUrl} small />
                <div className="dayb-who">
                  <b>
                    {e.person.firstName} {e.person.lastName}
                  </b>
                  <span>{entryLine(e)}</span>
                </div>
                {canEdit && (
                  <div className="dayb-acts">
                    {/* One press. The name is on screen and the day is chosen,
                        so there is nothing left to pick — this opens the same
                        time editor the grid uses. */}
                    <button
                      className="dayb-btn"
                      disabled={busy}
                      onClick={() => onOpen(e.person.id)}
                      title={e.shift ? 'Change this shift' : `Put them on this day`}
                    >
                      <Icon name={e.shift ? 'Pencil' : 'Plus'} size={13} />
                      {e.shift ? 'Change' : 'Add'}
                    </button>
                    {e.shift && (
                      <button
                        className="dayb-btn is-remove"
                        disabled={busy}
                        onClick={() => void onRemove(e.shift?.id ?? '')}
                        title="Take them off this day"
                      >
                        <Icon name="X" size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}

/**
 * The line under a name.
 *
 * A shift shows its time, because that is what somebody is checking. Without
 * one it shows WHAT THEY SAID — and "said nothing" is spelled out rather than
 * left blank, because a blank row reads as an answer that has not loaded.
 */
function entryLine(e: DayRosterEntry<Employee>): string {
  if (e.shift) {
    const time = shiftTimeLabel(e.shift)
    return e.clash ? `${time} · said they cannot work` : time
  }
  if (e.answer?.status === 'unavailable') {
    return e.answer.note?.trim() || 'Said they cannot work'
  }
  if (e.saidYes) {
    const from = formatClock(e.answer?.startTime)
    return from ? `Can work from ${from}` : 'Said they can work'
  }
  return 'Has not said'
}

/**
 * One person on one day.
 *
 * THREE STATES, and the empty one carries the most information. A cell with a
 * shift shows the time. A cell without one shows what that person SAID about the
 * day — free, or away — which is the fact a lead needs before they click it, and
 * which used to live in a summary line under each day that named people by first
 * name only.
 *
 * The dashed outline on an unpublished shift is the same idea as the count on
 * the Publish button, at the level of the individual square: it is possible to
 * look at this grid and see exactly which squares the floor has not been told
 * about.
 */
function Cell({
  shift,
  answer,
  past,
  canEdit,
  busy,
  onOpen,
  onRemove
}: {
  shift: ShiftWithPerson | null
  answer: EffectiveAvailabilityWithPerson | null
  past: boolean
  canEdit: boolean
  busy: boolean
  onOpen: () => void
  onRemove: (id: string) => void
}): JSX.Element {
  // Rostered on a day they said they could not work. The single most useful
  // thing this grid can tell a lead, so it is a colour on the cell rather than
  // something to go and check.
  const clash = !!shift && answer?.status === 'unavailable'
  const unsent = !!shift && shiftNeedsPublishing(shift)

  if (!shift) {
    const status = answer?.status ?? 'none'
    return (
      <button
        className="rot-cell rot-open"
        data-past={past ? 'true' : 'false'}
        data-said={status}
        disabled={!canEdit}
        title={
          canEdit
            ? status === 'unavailable'
              ? `Said they cannot work${answer?.note ? ` — “${answer.note}”` : ''}. Click to roster anyway.`
              : 'Click to put them on this day'
            : status === 'unavailable'
              ? 'Said they cannot work'
              : ''
        }
        onClick={onOpen}
      >
        {status === 'available' && <span className="rot-said">Free</span>}
        {status === 'unavailable' && <span className="rot-said">Away</span>}
        {status === 'none' && canEdit && <Icon name="Plus" size={13} />}
      </button>
    )
  }

  return (
    <div
      className="rot-cell rot-has"
      data-clash={clash ? 'true' : 'false'}
      data-unsent={unsent ? 'true' : 'false'}
      data-past={past ? 'true' : 'false'}
    >
      <button
        className="rot-shift"
        disabled={!canEdit}
        title={
          clash
            ? 'Rostered on a day they said they cannot work'
            : `${shiftTimeLabel(shift)}${shift.note ? ` · ${shift.note}` : ''}${
                unsent ? ' — not published yet' : ''
              }`
        }
        onClick={onOpen}
      >
        {clash && <Icon name="AlertTriangle" size={11} strokeWidth={3} />}
        <span className="rot-time">
          {shift.startTime ? formatClock(shift.startTime) : 'TBC'}
          {shift.endTime ? `–${formatClock(shift.endTime)}` : ''}
        </span>
        {shift.note && <span className="rot-note">{shift.note}</span>}
      </button>
      {canEdit && (
        <button
          className="rot-x"
          disabled={busy}
          title="Remove this shift"
          onClick={() => onRemove(shift.id)}
        >
          <Icon name="X" size={11} />
        </button>
      )}
    </div>
  )
}

/**
 * Setting or changing one cell.
 *
 * NO "WHO" FIELD. The cell that was clicked already said who and already said
 * which day, and re-asking would be the app forgetting what the user just told
 * it. What is left is the time, which is the only thing there is to decide.
 *
 * Inline under the grid rather than a modal, because setting a week is a dozen
 * of these in a row and a dialog to dismiss each time turns a two-minute job
 * into a chore.
 */
function EditCell({
  day,
  person,
  shift,
  answer,
  onClose,
  onSaved,
  onRemove
}: {
  day: string
  person: Employee | null
  shift: ShiftWithPerson | null
  answer: EffectiveAvailabilityWithPerson | null
  onClose: () => void
  onSaved: () => Promise<void>
  onRemove: (id: string) => Promise<void>
}): JSX.Element | null {
  const toast = useToast()
  const [startTime, setStartTime] = useState(shift?.startTime ?? '16:00')
  const [endTime, setEndTime] = useState(shift?.endTime ?? '')
  const [note, setNote] = useState(shift?.note ?? '')
  const [saving, setSaving] = useState(false)

  if (!person) return null

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const res = await api.staff.addShift({
        employeeId: person.id,
        day,
        startTime,
        endTime,
        note
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save that shift.')
        return
      }
      await onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rota-add-panel">
      <div className="rota-add-head">
        <Icon name="CalendarPlus" size={15} />
        <b>
          {person.firstName} {person.lastName}
        </b>
        <span className="ob-sub">{dayLabel(day)}</span>
        <button className="rota-x" onClick={onClose} title="Close">
          <Icon name="X" size={14} />
        </button>
      </div>

      <div className="rota-add-row">
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
        <Button size="sm" icon="Check" loading={saving} onClick={() => void save()}>
          {shift ? 'Save' : 'Add'}
        </Button>
        {shift && (
          <Button
            size="sm"
            variant="ghost"
            icon="Trash2"
            disabled={saving}
            onClick={() => void onRemove(shift.id)}
          >
            Remove
          </Button>
        )}
      </div>

      {/* Said out loud, not just shaded on the grid. Rostering somebody who
          marked themselves off is allowed — a lead may have a good reason to
          ask — but it must never happen by accident. */}
      {answer?.status === 'unavailable' && (
        <div className="sched-clash">
          <Icon name="AlertTriangle" size={15} />
          <span>
            {person.firstName} said they cannot work this day
            {answer.note ? ` — “${answer.note}”` : ''}. You can still put them on, but check with
            them first.
          </span>
        </div>
      )}
      {shift && shiftNeedsPublishing(shift) && (
        <p className="rot-free-note">
          Not published yet — this is only on your screen until you press Publish.
        </p>
      )}
    </div>
  )
}
