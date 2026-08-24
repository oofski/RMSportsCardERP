/**
 * The rota: who is DUE in, as opposed to who has clocked in.
 *
 * This is a new fact about the business, not a new view of an old one. Until
 * now the app could answer "who is here" — an open time entry is proof somebody
 * is standing in the building — and could not answer "who is in on Thursday",
 * because nothing anywhere recorded an intention. The home page said so out
 * loud rather than guessing ("Nobody has clocked in yet today" is a different
 * sentence from "nobody is coming"). A packer asking what shifts they have next
 * week is asking the second question, so the second question needs a table.
 *
 * ## Wall clock, deliberately
 *
 * A shift is stored as a LOCAL calendar day plus local HH:MM, never as a UTC
 * instant. "You are in at 4pm on Thursday" is a wall-clock fact: it stays 4pm
 * across a daylight-saving boundary, and it stays Thursday. Storing an instant
 * would make the rota shift by an hour twice a year and would put a 7pm
 * Chicago shift on the following day's screen — the exact bug the time clock
 * had to be fixed for, reintroduced somewhere it is much harder to notice.
 *
 * The clock (`time_entries`) is the opposite and stays the opposite: an instant,
 * because "you clocked in AT this moment" is a physical event. The two are
 * different kinds of fact and this file does not try to make them the same one.
 */

import type { Role } from './permissions'
import { roleLabel } from './permissions'

/** One scheduled shift for one person. */
export interface Shift {
  id: string
  employeeId: string
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  /** Local HH:MM, or null for a day nobody has pinned a time to yet. */
  startTime: string | null
  endTime: string | null
  /** "Pack bench", "streaming", whatever the lead wants to say. */
  note: string | null
  /**
   * When this shift was last PUBLISHED to the person working it. Null = never.
   *
   * A rota is built over an afternoon — somebody is added, moved, thought better
   * of — and until this existed every one of those keystrokes was on the floor's
   * phones the moment it was typed. So a half-built Thursday read as the answer,
   * and the only way to avoid it was to build the week somewhere else and copy
   * it in, which is how a rota ends up on a whiteboard.
   *
   * A DRAFT IS INVISIBLE TO THE PERSON IT IS ABOUT. `myShifts` filters on this;
   * the lead's own range read does not, because the lead has to see what they
   * are building.
   *
   * Compared against `updatedAt` rather than treated as a flag: a shift moved
   * from 4pm to 6pm after it was published is published AND out of date, and the
   * person working it needs telling again. See `shiftNeedsPublishing`.
   */
  publishedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** A shift with the person's name attached, for the team-wide view. */
export interface ShiftWithPerson extends Shift {
  employeeName: string
}

export interface NewShift {
  employeeId: string
  day: string
  startTime?: string | null
  endTime?: string | null
  note?: string | null
}

export const SHIFT_NOTE_MAX = 80

/**
 * What somebody says about a day BEFORE anybody is put on it.
 *
 * The other half of a rota, and the half that decides whether the rota is any
 * good. A lead filling Thursday is guessing unless the people who work Thursday
 * have said something, and the way that gets said today is a text message that
 * nobody can see a week later.
 *
 * TWO STATEMENTS, not one flag with a default. "I can work Thursday" and "I
 * cannot work Thursday" are both things somebody chose to say; a day they have
 * said NOTHING about is a third state and must stay distinct from both. Storing
 * it as a boolean would make silence mean "unavailable" (so nobody gets
 * rostered until they opt in) or "available" (so nobody's day off is ever
 * respected), and both readings are wrong.
 *
 * `unavailable` is the one that has to be loud. Being free is a default a lead
 * can work around; being unable to come in is a fact they cannot.
 */
export type AvailabilityStatus = 'available' | 'unavailable'

export interface Availability {
  id: string
  employeeId: string
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  status: AvailabilityStatus
  /**
   * Optional local HH:MM bounds. "Available, but only from 4pm" is a real and
   * common answer, and forcing it into a whole-day yes/no loses the part a lead
   * actually needs.
   */
  startTime: string | null
  endTime: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface AvailabilityWithPerson extends Availability {
  employeeName: string
}

export interface NewAvailability {
  day: string
  status: AvailabilityStatus
  startTime?: string | null
  endTime?: string | null
  note?: string | null
}

export const AVAILABILITY_NOTE_MAX = 80

/**
 * A USUAL WEEK — the thing somebody actually knows about their own life.
 *
 * Nobody thinks about their availability one date at a time. They think "I work
 * Mondays, Wednesdays and Fridays, and I have class on Tuesday" — a shape that
 * repeats — and asking them to express that by tapping thirty squares a month is
 * asking them to do arithmetic on their own routine. They will do it once and
 * never again, which is the same as not having the feature.
 *
 * So the pattern is the PRIMARY way to answer, and a single day is the
 * EXCEPTION: "I normally do Thursdays, but not this Thursday." Seven rows, set
 * once, and after that the only days worth touching are the ones that differ.
 *
 * ## Evaluated, never expanded
 *
 * The pattern is not turned into rows. Expanding "every Monday" into dated
 * availability would write hundreds of records, make changing your mind mean
 * rewriting all of them, and give the sync relay hundreds of rows to arbitrate
 * where one fact changed. The effective answer for a day is worked out at read
 * time — see `effectiveAvailability` — which is also what keeps the three states
 * honest: a day nobody has said anything about is still a day nobody has said
 * anything about, whether the silence is a missing override or an empty pattern.
 */
export interface AvailabilityPattern {
  id: string
  employeeId: string
  /** 0 = Sunday … 6 = Saturday, matching the calendar grid. */
  weekday: number
  status: AvailabilityStatus
  startTime: string | null
  endTime: string | null
  note: string | null
  updatedAt: string
}

/** One weekday's worth of a usual week, as the screen submits it. */
export interface PatternDayInput {
  weekday: number
  /** null clears the day back to "nothing said". */
  status: AvailabilityStatus | null
  startTime?: string | null
  endTime?: string | null
  note?: string | null
}

/**
 * What a given day actually comes to, once the usual week and any exception
 * for that date have been resolved against each other.
 *
 * `source` is not decoration. "I said this specifically" and "this is just my
 * usual Monday" are different strengths of claim, and a lead looking at a week
 * deserves to know which one they are reading — one of them is a person who
 * thought about that date.
 */
export interface EffectiveAvailability {
  day: string
  status: AvailabilityStatus
  startTime: string | null
  endTime: string | null
  note: string | null
  source: 'day' | 'pattern'
}

export interface EffectiveAvailabilityWithPerson extends EffectiveAvailability {
  employeeId: string
  employeeName: string
}

/**
 * A lead's view of the whole team's week.
 *
 * ## Why this is a read of its own
 *
 * Everything on it can be derived from the rota plus availability, which is
 * exactly the argument for computing it ONCE rather than in the screen. A lead
 * looking at next Thursday is asking four questions at the same time — who can
 * work it, who is already on it, is anybody on it who said no, and is anybody
 * short of hours — and a screen that answers them from four independently
 * filtered lists is a screen where those four answers can disagree.
 *
 * ## What earns a place here
 *
 * Only things somebody would ACT on. "Nobody is rostered on a night three
 * people said they were free" is a job. "Rostered against a stated no" is a
 * job. "This person has never set a usual week" is a job — it is the reason
 * their column is empty, and without it an empty column reads as "unavailable"
 * when it means "never asked".
 *
 * A count of how many people exist is not a job, and is not here.
 */
export interface TeamSchedulePerson {
  employeeId: string
  employeeName: string
  role: string
  /** Their usual week, Sunday first. Empty when they have never set one. */
  pattern: AvailabilityPattern[]
  /** False when they have never set a usual week — the reason a row is blank. */
  hasPattern: boolean
  /** Shifts they are on across the range being looked at. */
  shiftsInRange: number
  /** Rostered minutes across the range, where both ends of a shift are known. */
  minutesInRange: number
  /** Days in range they are rostered on having said they cannot work. */
  clashDays: string[]
}

/** One day of the range, counted across everybody. */
export interface TeamScheduleDay {
  day: string
  /** People whose effective answer for the day is "can work". */
  free: number
  /** People whose effective answer is "cannot work". */
  away: number
  /** People who have said nothing about it, one way or the other. */
  unknown: number
  rostered: number
  /** Rostered on a day they said no to. */
  clashes: number
}

export interface TeamScheduleOverview {
  from: string
  to: string
  people: TeamSchedulePerson[]
  days: TeamScheduleDay[]
}

/**
 * The things on a team week somebody should actually do something about.
 *
 * Derived in the renderer rather than in main, because it is presentation: the
 * facts are all in the overview already, and a second backend shape would be
 * one more thing to keep in step with the first.
 */
export interface ScheduleAlert {
  kind: 'clash' | 'uncovered' | 'no-pattern' | 'nobody-free'
  /** The day it is about, when it is about one. */
  day: string | null
  text: string
}

export function scheduleAlerts(overview: TeamScheduleOverview): ScheduleAlert[] {
  const out: ScheduleAlert[] = []

  // Loudest first: somebody is on the rota for a day they said they cannot do.
  // A person, not a count — the lead has to talk to them.
  for (const p of overview.people) {
    for (const day of p.clashDays) {
      out.push({
        kind: 'clash',
        day,
        text: `${p.employeeName} is rostered on ${dayLabel(day)} and said they cannot work it`
      })
    }
  }

  for (const d of overview.days) {
    // Nobody on, but people available — the definition of a gap that can be
    // filled right now, which is the only kind worth interrupting somebody for.
    if (d.rostered === 0 && d.free > 0) {
      out.push({
        kind: 'uncovered',
        day: d.day,
        text: `Nobody is on ${dayLabel(d.day)} and ${d.free} ${d.free === 1 ? 'person is' : 'people are'} free`
      })
    }
    // Nobody on and nobody free is a different problem with a different fix,
    // and calling it the same thing would send a lead looking for a name that
    // is not there.
    else if (d.rostered === 0 && d.free === 0 && d.away > 0) {
      out.push({
        kind: 'nobody-free',
        day: d.day,
        text: `Nobody is on ${dayLabel(d.day)} and nobody has said they are free`
      })
    }
  }

  // Quietest, and last: a blank row means "never asked", not "unavailable".
  const silent = overview.people.filter((p) => !p.hasPattern)
  if (silent.length > 0) {
    out.push({
      kind: 'no-pattern',
      day: null,
      text:
        silent.length === 1
          ? `${silent[0].employeeName} has not set a usual week`
          : `${silent.length} people have not set a usual week: ${silent.map((p) => p.employeeName.split(' ')[0]).join(', ')}`
    })
  }

  return out
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
]

/**
 * 0 = Sunday … 6 = Saturday for a YYYY-MM-DD.
 *
 * Parsed at UTC noon and read in UTC, like every other date in this file: a
 * date-only string parsed as local midnight can slide across a daylight-saving
 * boundary onto the previous day, and a rota pattern that shifts by one weekday
 * twice a year is a bug nobody would find for months.
 */
export function weekdayOf(day: string): number {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return 0
  return new Date(t).getUTCDay()
}

/**
 * The answer for one day: the exception if there is one, otherwise the usual
 * week, otherwise nothing.
 *
 * An override ALWAYS wins, including an override that says the opposite of the
 * pattern — that is the entire point of being able to mark a single day. Null
 * means nothing has been said, which stays distinct from both answers.
 */
export function effectiveAvailability(
  day: string,
  override: Availability | null | undefined,
  pattern: AvailabilityPattern | null | undefined
): EffectiveAvailability | null {
  if (override) {
    return {
      day,
      status: override.status,
      startTime: override.startTime,
      endTime: override.endTime,
      note: override.note,
      source: 'day'
    }
  }
  if (pattern) {
    return {
      day,
      status: pattern.status,
      startTime: pattern.startTime,
      endTime: pattern.endTime,
      note: pattern.note,
      source: 'pattern'
    }
  }
  return null
}

export function validatePatternDay(input: PatternDayInput): string | null {
  if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
    return 'That is not a day of the week.'
  }
  if (input.status === null) return null
  if (input.status !== 'available' && input.status !== 'unavailable') {
    return 'Say whether you can work or not.'
  }
  if (input.startTime && !TIME_RE.test(input.startTime)) return 'The start time has to be a time.'
  if (input.endTime && !TIME_RE.test(input.endTime)) return 'The end time has to be a time.'
  if ((input.note ?? '').length > AVAILABILITY_NOTE_MAX) {
    return `Keep the note under ${AVAILABILITY_NOTE_MAX} characters.`
  }
  return null
}

/** "Mon, Wed, Fri" — how a usual week reads in one line. */
export function patternSummary(pattern: AvailabilityPattern[]): string {
  const free = pattern
    .filter((p) => p.status === 'available')
    .map((p) => p.weekday)
    .sort((a, b) => a - b)
  if (free.length === 0) return 'No usual days set'
  if (free.length === 7) return 'Every day'
  return free.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(', ')
}

/**
 * How far ahead somebody may mark a day.
 *
 * A year. Long enough for a holiday booked in advance — the single most useful
 * thing on this screen — and short enough that a stray keystroke in the year
 * field cannot write a row nobody will ever see again.
 */
export const AVAILABILITY_HORIZON_DAYS = 366

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** Minutes since local midnight, or null for anything that is not a HH:MM. */
export function minutesOfDay(time: string | null | undefined): number | null {
  if (!time || !TIME_RE.test(time)) return null
  const [h, m] = time.split(':')
  return Number(h) * 60 + Number(m)
}

/**
 * How long a shift is, in minutes, or null when it cannot be known.
 *
 * An end BEFORE the start is read as running past midnight rather than as an
 * error: a show that goes on at 9pm and wraps at 1am is the normal night here,
 * and refusing it would push the floor into entering two shifts for one evening.
 */
export function shiftMinutes(shift: {
  startTime: string | null
  endTime: string | null
}): number | null {
  const from = minutesOfDay(shift.startTime)
  const to = minutesOfDay(shift.endTime)
  if (from === null || to === null) return null
  return to > from ? to - from : to + 24 * 60 - from
}

/**
 * Does this shift still owe somebody a message?
 *
 * TWO CASES, and missing the second is the one that matters. A shift never
 * published is obviously unsent. A shift published on Monday and MOVED on
 * Wednesday is equally unsent — the person working it is holding an answer that
 * is no longer true, which is worse than holding none, because they will not
 * think to check.
 *
 * Timestamps rather than a boolean for exactly that reason: a flag cleared on
 * every edit would also be cleared by a lead retyping the same note, and a flag
 * that is never cleared would never catch the move. The comparison is on strings
 * because both are ISO instants, where lexical order is chronological order.
 */
// ---------------------------------------------------------------------------
// Who sits under which heading on the rotation grid
//
// The grid is one row per person, and a list of everybody in one block is a list
// somebody has to read all of to find the four packers they are rostering. So it
// is grouped by the job people do, which on this floor is exactly the ROLE they
// already hold — there is no second "position" field to keep in step, and
// inventing one would mean two places to change when somebody moves to the
// packing bench.
// ---------------------------------------------------------------------------

/**
 * The order the headings are drawn in.
 *
 * THE FLOOR FIRST, deliberately. A rotation is overwhelmingly about who is
 * packing and who is on camera; the office roles are on it because they
 * occasionally work a night, not because anybody opens this screen to roster
 * them. Putting Owner at the top because it outranks everything would sort the
 * screen by authority, which is not what anybody is looking for.
 *
 * Anything not listed sorts last rather than being dropped — a role added later
 * and forgotten here still appears, under its own heading.
 */
export const ROTATION_ROLE_ORDER: Role[] = ['shipping', 'breaker', 'staff', 'operations', 'owner']

export interface RotationGroup<T> {
  role: Role
  label: string
  people: T[]
}

/**
 * Split people into their headings, in the order above.
 *
 * EMPTY GROUPS ARE DROPPED. A heading with nothing under it is a row of pixels
 * saying nothing, and on a floor where most roles hold one or two people that
 * would be most of the screen.
 */
export function groupByRole<T extends { role: Role; firstName: string; lastName: string }>(
  people: readonly T[]
): Array<RotationGroup<T>> {
  const rank = (role: Role): number => {
    const i = ROTATION_ROLE_ORDER.indexOf(role)
    return i === -1 ? ROTATION_ROLE_ORDER.length : i
  }
  const byRole = new Map<Role, T[]>()
  for (const person of people) {
    const list = byRole.get(person.role)
    if (list) list.push(person)
    else byRole.set(person.role, [person])
  }
  return [...byRole.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([role, list]) => ({
      role,
      label: roleLabel(role),
      people: [...list].sort(
        (a, b) =>
          a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName)
      )
    }))
}

/**
 * How many minutes a set of shifts comes to.
 *
 * A shift with no times contributes NOTHING rather than a guess. "In on
 * Thursday, time to be confirmed" is a real state on this floor, and inventing
 * eight hours for it would put a number in a total column that nobody agreed to
 * — which is the kind of figure that ends up in a conversation about pay.
 */
export function totalShiftMinutes(
  shifts: readonly { startTime: string | null; endTime: string | null }[]
): number {
  return shifts.reduce((sum, s) => sum + (shiftMinutes(s) ?? 0), 0)
}

/** Minutes as the hours label a rota column shows: "32h", "6h 30m", "—". */
export function hoursLabel(minutes: number): string {
  if (!(minutes > 0)) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h}h`
  return h === 0 ? `${m}m` : `${h}h ${m}m`
}

/**
 * One person's week, as the line that lands on their lock screen.
 *
 * ## Everything about this is shaped by where it is read
 *
 * A push payload is a few kilobytes after encryption and the relay trims the
 * body at 300 characters, so this cannot be the whole rota and must not be
 * truncated mid-word into something that looks like a different time. It is
 * built shortest-useful-first — day, then time — and stops early with a count of
 * what did not fit, so the last thing somebody reads is "+2 more" rather than
 * half of Thursday.
 *
 * It is also read on a phone that may be face-up on a packing bench, which is
 * why it says days and times and never a note: "Pack bench with Ada" is fine on
 * a rota and is not fine displayed to a room.
 */
export function describeOwnWeek(
  shifts: readonly { day: string; startTime: string | null; endTime: string | null }[],
  limit = 240
): string {
  const ordered = [...shifts].sort((a, b) => a.day.localeCompare(b.day))
  if (ordered.length === 0) return 'Nothing this week.'

  const parts: string[] = []
  let used = 0
  for (const [i, shift] of ordered.entries()) {
    const label = `${dayLabel(shift.day)} ${shiftTimeLabel(shift)}`
    // The tail has to fit too, or trimming to make room would itself overflow.
    const tail = i < ordered.length - 1 ? ` +${ordered.length - i} more` : ''
    if (used + label.length + tail.length > limit && parts.length > 0) {
      parts.push(`+${ordered.length - i} more`)
      break
    }
    parts.push(label)
    used += label.length + 3
  }
  const total = totalShiftMinutes(ordered)
  const count = `${ordered.length} shift${ordered.length === 1 ? '' : 's'}`
  return `${parts.join(' · ')} — ${count}${total > 0 ? `, ${hoursLabel(total)}` : ''}`
}

export function shiftNeedsPublishing(shift: {
  publishedAt: string | null
  updatedAt: string
}): boolean {
  if (!shift.publishedAt) return true
  return shift.updatedAt > shift.publishedAt
}

/**
 * The `updated_at` to write for an edit, given what the row was published at.
 *
 * `shiftNeedsPublishing` compares two ISO instants, and ISO instants are only
 * accurate to the MILLISECOND. So an edit landing in the same millisecond as the
 * publish that preceded it is not "after" it — the comparison says the row is
 * published and current, and the person working that shift is never told it
 * moved. There is no error and nothing to see: the message simply does not go.
 *
 * A person cannot click twice in a millisecond, but nothing here is driven only
 * by clicks: publishing stamps a whole week from ONE timestamp taken before the
 * writes, and copying a week creates shifts in a tight loop. On a fast machine
 * those share a millisecond routinely — which is exactly how often the test that
 * found this failed.
 *
 * So an edit to a PUBLISHED shift is forced strictly past the publish. One
 * millisecond, only when the clock did not already provide one, and only on that
 * path: a draft has no publish to be newer than, and an unedited row is never
 * written at all.
 */
export function shiftEditStamp(now: string, publishedAt: string | null): string {
  if (!publishedAt || now > publishedAt) return now
  const next = Date.parse(publishedAt)
  // An unparseable stamp is not something to do arithmetic on. Leaving `now`
  // alone keeps the old behaviour rather than inventing a timestamp from NaN.
  if (!Number.isFinite(next)) return now
  return new Date(next + 1).toISOString()
}

/** "4:00pm – 9:30pm", "From 4:00pm", or "Time to be confirmed". */
export function shiftTimeLabel(shift: {
  startTime: string | null
  endTime: string | null
}): string {
  const from = formatClock(shift.startTime)
  const to = formatClock(shift.endTime)
  if (from && to) return `${from} – ${to}`
  if (from) return `From ${from}`
  if (to) return `Until ${to}`
  return 'Time to be confirmed'
}

/** HH:MM → a 12-hour label, or '' when there is nothing to format. */
export function formatClock(time: string | null | undefined): string {
  const mins = minutesOfDay(time)
  if (mins === null) return ''
  const h24 = Math.floor(mins / 60)
  const m = mins % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')}${h24 < 12 ? 'am' : 'pm'}`
}

export function validateShift(input: NewShift): string | null {
  if (!input.employeeId?.trim()) return 'Say who the shift is for.'
  if (!DAY_RE.test(input.day ?? '')) return 'Pick a day.'
  if (input.startTime && !TIME_RE.test(input.startTime)) return 'The start time has to be a time.'
  if (input.endTime && !TIME_RE.test(input.endTime)) return 'The end time has to be a time.'
  // An end with no start is allowed on purpose — "off at 9" is a real thing to
  // put on a rota when the start depends on when the show finishes loading.
  if ((input.note ?? '').length > SHIFT_NOTE_MAX) {
    return `Keep the note under ${SHIFT_NOTE_MAX} characters.`
  }
  return null
}

/**
 * The shifts still ahead, out of a rota already in hand.
 *
 * TODAY COUNTS AS AHEAD, and that is the whole reason this is a named function
 * rather than an inline filter. Somebody opening the app at nine in the morning
 * wants to see the four o'clock they are in for; a cutoff at "after today" would
 * hide precisely the shift they most need to be reminded of. The rule lives here
 * so the board and the repository cannot disagree about it.
 */
export function upcomingFrom<T extends Shift>(shifts: T[], today: string, limit = 8): T[] {
  return sortShifts(shifts)
    .filter((s) => s.day >= today)
    .slice(0, Math.max(1, limit))
}

export function validateAvailability(input: NewAvailability): string | null {
  if (!DAY_RE.test(input.day ?? '')) return 'Pick a day.'
  if (input.status !== 'available' && input.status !== 'unavailable') {
    return 'Say whether you can work or not.'
  }
  if (input.startTime && !TIME_RE.test(input.startTime)) return 'The start time has to be a time.'
  if (input.endTime && !TIME_RE.test(input.endTime)) return 'The end time has to be a time.'
  if ((input.note ?? '').length > AVAILABILITY_NOTE_MAX) {
    return `Keep the note under ${AVAILABILITY_NOTE_MAX} characters.`
  }
  return null
}

/** How one person's answer reads on a lead's screen. */
export function availabilityLabel(a: {
  status: AvailabilityStatus
  startTime: string | null
  endTime: string | null
}): string {
  if (a.status === 'unavailable') return 'Cannot work'
  const from = formatClock(a.startTime)
  const to = formatClock(a.endTime)
  if (from && to) return `Free ${from} – ${to}`
  if (from) return `Free from ${from}`
  if (to) return `Free until ${to}`
  return 'Free'
}

/**
 * Soonest first, and within a day, earliest start first.
 *
 * A shift with no time sorts AFTER the timed ones on its day: it is the least
 * specific thing on that line and the least useful to read first.
 */
export function sortShifts<T extends Shift>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day)
    const am = minutesOfDay(a.startTime)
    const bm = minutesOfDay(b.startTime)
    if (am === null && bm === null) return 0
    if (am === null) return 1
    if (bm === null) return -1
    return am - bm
  })
}

// ---------------------------------------------------------------------------
// The calendar grid
// ---------------------------------------------------------------------------

export interface CalendarCell {
  /** YYYY-MM-DD. */
  day: string
  /** Day of the month, for the label. */
  date: number
  /** False for the leading/trailing days borrowed from the months either side. */
  inMonth: boolean
}

/**
 * Six weeks of cells covering a month, Sunday first.
 *
 * SIX, always, rather than however many the month needs. A grid that changes
 * height between months makes everything below it jump when you page through,
 * and a calendar you page through is the only way to use one.
 *
 * Built by counting days rather than by constructing Dates in a loop, because
 * `new Date(y, m, d)` walks into daylight-saving edges — the 2am that does not
 * exist in March lands the cell on the previous day in some zones. Every date
 * here is arithmetic on a YYYY-MM-DD string, which has no such edges.
 */
export function monthGrid(month: string): CalendarCell[] {
  const [y, m] = month.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return []
  const first = Date.UTC(y, m - 1, 1)
  const firstWeekday = new Date(first).getUTCDay()
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const out: CalendarCell[] = []
  for (let i = 0; i < 42; i++) {
    const offset = i - firstWeekday
    const d = new Date(first + offset * 24 * 60 * 60 * 1000)
    out.push({
      day: d.toISOString().slice(0, 10),
      date: d.getUTCDate(),
      inMonth: offset >= 0 && offset < daysInMonth
    })
  }
  return out
}

/** YYYY-MM for a YYYY-MM-DD. */
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

/** Shift a YYYY-MM month key by whole months. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = total - ny * 12 + 1
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** "August 2026" for a YYYY-MM. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return month
  return `${MONTH_NAMES[m - 1] ?? month} ${y}`
}

/** "Thu 13 Aug" for a YYYY-MM-DD, without constructing a local Date. */
export function dayLabel(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  const d = new Date(t)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  const mon = (MONTH_NAMES[d.getUTCMonth()] ?? '').slice(0, 3)
  return `${weekday} ${d.getUTCDate()} ${mon}`
}
