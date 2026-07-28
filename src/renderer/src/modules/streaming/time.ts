/**
 * Wall-clock helpers for the Streaming module.
 *
 * Everything here is deliberately LOCAL. A session's business day is the local
 * calendar date it started on (see @shared/streaming), so every key the UI
 * builds — month keys, day keys, the grid itself — has to be built the same way
 * or the calendar would file a 9pm show under tomorrow.
 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Local YYYY-MM-DD for a Date. */
export function dayKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Local YYYY-MM for a Date. */
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

export function todayKey(): string {
  return dayKeyOf(new Date())
}

export function thisMonthKey(): string {
  return monthKeyOf(new Date())
}

/** `{ year, month }` with month 1-12; nulls on anything malformed. */
export function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key)
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]) }
}

/**
 * A YYYY-MM-DD key as a LOCAL Date at midnight. `new Date(key)` parses the
 * bare form as UTC and slides the day backwards for anyone west of Greenwich,
 * which is exactly the class of bug this module exists to prevent.
 */
export function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function shiftMonth(key: string, delta: number): string {
  const parsed = parseMonthKey(key)
  if (!parsed) return thisMonthKey()
  return monthKeyOf(new Date(parsed.year, parsed.month - 1 + delta, 1))
}

export function monthLabel(key: string): string {
  const parsed = parseMonthKey(key)
  if (!parsed) return key
  return new Date(parsed.year, parsed.month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
}

/** "Monday, 28 July 2026" — used wherever a day heading needs to be unambiguous. */
export function longDayLabel(key: string): string {
  const d = parseDayKey(key)
  if (!d) return key
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

/** "Mon 28 Jul" — the compact form for list rows. */
export function shortDayLabel(key: string): string {
  const d = parseDayKey(key)
  if (!d) return key
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function dayNumberOf(key: string): number {
  return Number(key.slice(8, 10))
}

/** Local clock time of an instant, e.g. "9:04 PM". */
export function timeLabel(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "21:04" — the value an <input type="time"> expects. */
export function timeInputValue(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * How many LOCAL calendar days the end sits past the start. This is the number
 * the "+1d" marker is drawn from: a stream that crossed midnight is the normal
 * case here, and the operator must be able to see it at a glance rather than
 * work it out from two clock times.
 */
export function crossedDays(startedAt: string, endedAt: string | null): number {
  if (!endedAt) return 0
  const a = parseDayKey(dayKeyOf(new Date(startedAt)))
  const b = parseDayKey(dayKeyOf(new Date(endedAt)))
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/**
 * Build an ISO instant from a wall-clock date + "HH:MM" + a whole-day offset.
 * Returns null when either half is unparseable, so a caller can refuse to save
 * rather than post an Invalid Date to the ledger.
 */
export function isoFromLocalParts(dayKey: string, time: string, dayOffset = 0): string | null {
  const day = parseDayKey(dayKey)
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!day || !m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, hours, minutes, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** "3:07:22" / "14:02" — the live bar's ticking elapsed clock. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}
