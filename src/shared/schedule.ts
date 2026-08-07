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
