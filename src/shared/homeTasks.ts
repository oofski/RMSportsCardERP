/**
 * The things the app works out you have to do, rather than waiting to be told.
 *
 * Two kinds, and they are different in a way worth stating once:
 *
 *   DERIVED — a fact about the data that is also a job. "There is a stream
 *   recorded for the 3rd and no packing slip against it" is not a note somebody
 *   wrote; it is a gap the app can see. It appears on its own and, more
 *   importantly, DISAPPEARS on its own the moment the slip lands. Nothing is
 *   stored, so there is nothing to tick, nothing to go stale, and no row left
 *   behind claiming a job that is finished.
 *
 *   RECURRING — a job on a clock. Payroll every second Wednesday. The app cannot
 *   see whether it happened, so this half IS stored, and ticking it records
 *   which occurrence was done so the next one comes back on its own.
 *
 * The date arithmetic lives here rather than in the database module because it
 * is the part that is easy to get subtly wrong and easy to test without one.
 */

/** A job the app worked out for itself. */
export interface DerivedTask {
  /** Stable within a render, so React has a key and a tick has a target. */
  id: string
  kind: 'slips'
  title: string
  detail: string
  /** The day it is about, YYYY-MM-DD. */
  day: string
  /** How overdue it is, in days. Drives the tone, not the order. */
  ageDays: number
}

/** A job on a clock. */
export interface RecurringTask {
  id: string
  title: string
  /** 14 for "every second Wednesday". */
  everyDays: number
  /** A date the job IS due — every occurrence is this plus a multiple. */
  anchorDate: string
  /** Show it this many days before it is due. */
  leadDays: number
  /** The occurrence last ticked off, or null. */
  lastDoneOn: string | null
  active: boolean
}

/** A recurring job as it appears on the list today. */
export interface RecurringDue {
  id: string
  title: string
  /** The occurrence being asked for, YYYY-MM-DD. */
  dueOn: string
  /** Negative when it is still ahead, 0 today, positive when it is late. */
  daysLate: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** YYYY-MM-DD for a Date, in ITS OWN calendar — never via toISOString. */
export function dayKey(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Whole days between two YYYY-MM-DD keys.
 *
 * Parsed at UTC noon rather than midnight. A date-only string parsed as local
 * midnight and then shifted by a daylight-saving boundary can land on 23:00 the
 * previous day and round the wrong way; noon is twelve hours from either edge,
 * so no real-world offset can reach across it.
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`)
  const b = Date.parse(`${to}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / DAY_MS)
}

/** Shift a YYYY-MM-DD key by whole days. */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The first occurrence on or after `from`.
 *
 * Works backwards as well as forwards: an anchor in the future is just as valid
 * as one in the past, because "every second Wednesday from the 5th" describes an
 * infinite series in both directions and somebody entering next month's date
 * meant the same series.
 */
export function nextOccurrence(anchorDate: string, everyDays: number, from: string): string {
  const step = Math.max(1, Math.trunc(everyDays))
  const delta = daysBetween(anchorDate, from)
  // Math.ceil, so an occurrence falling exactly on `from` is that occurrence
  // rather than the next one — the day a job is due is a day it is due.
  const cycles = Math.ceil(delta / step)
  return addDays(anchorDate, cycles * step)
}

/**
 * What a recurring job is asking for today, or null when it is asking nothing.
 *
 * The occurrence LAST TICKED is skipped, which is what makes ticking stick: the
 * job vanishes for the rest of its cycle and returns for the next one, without
 * a second table recording completions.
 *
 * An occurrence that is late stays on the list. A payroll run missed on
 * Wednesday is not less due on Thursday, and a job that quietly rolls forward to
 * the next fortnight is the exact failure this exists to prevent.
 */
export function recurringDue(task: RecurringTask, today: string): RecurringDue | null {
  if (!task.active) return null
  const step = Math.max(1, Math.trunc(task.everyDays))

  // The oldest occurrence nobody has ticked.
  //
  // With a history, that is simply the one after the last completion — which is
  // what makes an occurrence somebody MISSED stay on the list rather than
  // rolling forward. A payroll run missed on Wednesday is not less due on
  // Thursday, and a job that silently jumps to the next fortnight is exactly the
  // failure a recurring reminder exists to prevent.
  //
  // WITHOUT a history there is nothing to be behind on. A series is infinite in
  // both directions, so the anchor is not a start date — and treating it as one
  // would mean a job created today, anchored on a date last year, announcing
  // itself as twenty-six occurrences overdue on the day it was made. So a job
  // that has never been ticked asks for its CURRENT occurrence: the latest one
  // that has come round, or the first one still ahead.
  // The occurrence that has most recently come round — never more than one
  // cycle behind, whatever has or has not been ticked.
  const upcoming = nextOccurrence(task.anchorDate, step, today)
  const current = upcoming === today ? today : addDays(upcoming, -step)

  let due: string
  if (task.lastDoneOn) {
    // The one after the last tick, so an occurrence somebody MISSED stays on the
    // list rather than rolling forward — but capped at the current one, because
    // a job ticked once in August and left alone must ask for THIS fortnight's
    // payroll, not name a date from last year and count 351 days of arrears
    // nobody can clear except by clicking twenty-six times.
    const afterLast = nextOccurrence(task.anchorDate, step, addDays(task.lastDoneOn, 1))
    due = afterLast > current ? afterLast : current
  } else {
    due = current
  }
  // Anchored in the future and never reached: the first one is the upcoming one.
  if (due < task.anchorDate) due = task.anchorDate

  const daysLate = daysBetween(due, today)
  // Still further away than its notice period — say nothing.
  if (daysLate < -Math.max(0, Math.trunc(task.leadDays))) return null
  return { id: task.id, title: task.title, dueOn: due, daysLate }
}

/** How a due job reads on the list. */
export function recurringLabel(due: RecurringDue): string {
  if (due.daysLate === 0) return 'Due today'
  if (due.daysLate > 0) {
    return `${due.daysLate} day${due.daysLate === 1 ? '' : 's'} overdue`
  }
  const ahead = -due.daysLate
  return ahead === 1 ? 'Due tomorrow' : `Due in ${ahead} days`
}

export const RECURRING_TITLE_MAX = 80

export function validateRecurring(input: {
  title: string
  everyDays: number
  anchorDate: string
}): string | null {
  const title = (input.title ?? '').trim()
  if (!title) return 'Give the job a name.'
  if (title.length > RECURRING_TITLE_MAX) {
    return `Keep the name under ${RECURRING_TITLE_MAX} characters.`
  }
  if (!Number.isFinite(input.everyDays) || input.everyDays < 1 || input.everyDays > 365) {
    return 'It has to repeat somewhere between every day and every year.'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate ?? '')) {
    return 'Pick a date it is next due.'
  }
  return null
}
