/**
 * Wall-clock helpers for the Finance module.
 *
 * Everything here is LOCAL, for the same reason it is in Streaming: a row's
 * business day is its session's local `streamDate`, and a UTC read of the same
 * instant files a 9pm show under tomorrow. The ledger is full of 1am rows that
 * belong to the previous evening, so any helper that quietly used UTC would move
 * roughly a quarter of the money to the wrong day.
 */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * A YYYY-MM-DD key as a LOCAL Date at midnight. `new Date(key)` reads the bare
 * form as UTC and slides the day backwards for anyone west of Greenwich.
 */
export function parseDayKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

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

/**
 * The month a business day belongs to, taken as a STRING SLICE.
 *
 * A day key is already local wall-clock, so re-parsing it into a Date only to
 * format it again would put it back through the timezone that `parseDayKey`
 * exists to avoid. The first seven characters are the answer.
 */
export function monthKeyOfDayKey(key: string): string {
  return (key || '').slice(0, 7)
}

/** `{ year, month }` with month 1-12; null on anything malformed. */
export function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '')
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]) }
}

export function shiftMonth(key: string, delta: number): string {
  const parsed = parseMonthKey(key)
  if (!parsed) return thisMonthKey()
  return monthKeyOf(new Date(parsed.year, parsed.month - 1 + delta, 1))
}

/** "July 2026" — the calendar's heading. */
export function monthLabel(key: string): string {
  const parsed = parseMonthKey(key)
  if (!parsed) return key || '—'
  return new Date(parsed.year, parsed.month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })
}

/** The number printed in the corner of a calendar cell. */
export function dayNumberOf(key: string): number {
  return Number((key || '').slice(8, 10))
}

/** "Fri, Jul 24" — the compact form for table rows and cluster headings. */
export function shortDayLabel(key: string): string {
  const d = parseDayKey(key)
  if (!d) return key || '—'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * "Jul 20" — one end of a week or month span.
 *
 * No weekday and no year, because this only ever appears beneath a label that
 * already carries them ("Week of Jul 20", "July 2026"). Repeating either turns a
 * quiet caption into a second heading competing with the row's own.
 */
export function compactDayLabel(key: string): string {
  const d = parseDayKey(key)
  if (!d) return key || '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** "Friday, July 24, 2026" — used wherever a day heading must be unambiguous. */
export function longDayLabel(key: string): string {
  const d = parseDayKey(key)
  if (!d) return key || '—'
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

/** Local clock time of an instant, e.g. "3:14 PM". */
export function timeLabel(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** "Jul 24, 2026" — the ends of an import's coverage range. */
export function shortInstantDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * "Jul 24, 2026, 3:07 PM" — when a file was uploaded.
 *
 * Carries the YEAR, unlike the app-wide `formatDateTime`. This is the only
 * place an operator distinguishes last Tuesday's upload from the one twelve
 * months ago, and a weekly ledger habit fills this list with entries that are
 * otherwise identical to the minute.
 */
export function instantLabel(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * How many LOCAL calendar days the end sits past the start.
 *
 * Clusters of unattributed activity are usually evening shows, so they cross
 * midnight as a matter of course. Without this the span "9:04 PM – 1:22 AM"
 * reads as a run backwards through the same day.
 */
export function crossedDays(fromIso: string, toIso: string): number {
  const a = parseDayKey(dayKeyOf(new Date(fromIso)))
  const b = parseDayKey(dayKeyOf(new Date(toIso)))
  if (!a || !b) return 0
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/**
 * "Jul 1 – Jul 31, 2026" — the stretch a report covers.
 *
 * The year is printed ONCE when both ends share it, which is the normal case
 * and the only way the range stays short enough to sit beside a heading. A
 * range that crosses new year prints both, because "Dec 28 – Jan 4, 2027" is
 * genuinely ambiguous about which December it means.
 */
export function dayRangeLabel(from: string, to: string): string {
  const a = parseDayKey(from)
  const b = parseDayKey(to)
  if (!a || !b) return `${from || '—'} – ${to || '—'}`
  if (from === to) return longDayLabel(from)
  const sameYear = a.getFullYear() === b.getFullYear()
  const left = a.toLocaleDateString(
    undefined,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' }
  )
  const right = b.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return `${left} – ${right}`
}
