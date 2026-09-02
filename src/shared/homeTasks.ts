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

// ---------------------------------------------------------------------------
// Payroll periods
// ---------------------------------------------------------------------------

/**
 * When payroll runs, and therefore what a "period" is.
 *
 * ## Three dates, not two
 *
 * A fortnight of work has a beginning, an end, a day the run happens and a day
 * the money lands, and they are FOUR different days:
 *
 *     work        Mon 03 Aug  →  Sun 16 Aug     (14 days)
 *     run on      Wed 19 Aug                    (end + 3)
 *     paid on     Fri 21 Aug                    (end + 5)
 *
 *     next        Mon 17 Aug  →  Sun 30 Aug
 *     run on      Wed 02 Sep
 *     paid on     Fri 04 Sep
 *
 * ## The fortnight moved one day, and the paydays did not
 *
 * The owner: "the payroll dates need to be shifted one day back, so really
 * payroll is the 17th through the 30th, and then the 31st through next." The
 * fortnight used to open on a Sunday and close on a Saturday — the 16th to the
 * 29th — and the floor's own week does not actually break there.
 *
 * So the ANCHOR moved forward a day and the two LAGS shrank by one, which are
 * the same edit seen from opposite ends: the period slid a day later, and the
 * run and the payment stayed exactly where they were. Wednesday is still the
 * run and Friday is still payday.
 *
 * Moving the anchor alone would have been the smaller diff and the wrong
 * change. The lags are measured from the period's END, so a period closing a
 * day later would have dragged the run to a Thursday and the money to a
 * SATURDAY — a payday on a weekend, arrived at silently, off a request that
 * only ever mentioned which days people are being paid FOR.
 *
 * This used to collapse the run and the payment into one field and put the
 * period boundary on the run date, so a period read as "05/08 → 19/08, paid the
 * 19th". That describes a fortnight nobody works: the floor's week runs Sunday
 * to Saturday, the run is a Wednesday four days after the timesheet closes, and
 * the money arrives the Friday after that. Every one of those gaps is real, and
 * an export that assumes the period ends the day it is paid hands Gusto a
 * fortnight shifted three days off the one the hours were worked in.
 *
 * ## Why the lag is measured from `end`
 *
 * Because that is what the lag IS — the office needs the first few days after
 * the timesheet closes to approve it, and the bank needs two more to move the
 * money.
 * Measured from `start` the same two numbers would be 17 and 19, which are
 * arithmetic rather than reasons, and would silently need changing if the
 * fortnight ever became something else.
 */
export const PAYROLL_ANCHOR = '2026-08-03'
export const PAYROLL_EVERY_DAYS = 14
/** Days after the period ENDS that payroll is run. Sunday close → Wednesday run. */
export const PAYROLL_RUN_LAG_DAYS = 3
/** Days after the period ENDS that the money lands. Sunday close → Friday pay. */
export const PAYROLL_PAY_LAG_DAYS = 5

/**
 * THE WEEKDAYS THE FORTNIGHT OPENS AND CLOSES ON, DERIVED — never typed.
 *
 * The My Hours screen explained the schedule in words: "a period is 14 days of
 * work, Sunday to Saturday ... so a fortnight ending on a Saturday is run that
 * Wednesday". Every one of those weekday names was TRUE when it was written and
 * FALSE the moment the anchor moved forward a day, and nothing failed — the
 * dates on the same screen were right while the sentence beside them described a
 * different fortnight. A second source of truth about the same fact always ends
 * this way; the only question is how long before somebody reads the wrong half.
 *
 * So the sentence now asks the anchor. These cannot disagree with the schedule
 * because they ARE the schedule.
 *
 * Parsed at UTC noon like every other date-only value here: local midnight
 * shifted across a daylight-saving boundary lands on 23:00 the previous day and
 * would name the wrong weekday twice a year.
 */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

export function weekdayName(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return ''
  return WEEKDAYS[new Date(t).getUTCDay()]
}

/** The weekday a fortnight opens on, e.g. "Monday". */
export const PAYROLL_OPENS_ON = weekdayName(PAYROLL_ANCHOR)
/** The weekday a fortnight closes on, e.g. "Sunday". */
export const PAYROLL_CLOSES_ON = weekdayName(addDays(PAYROLL_ANCHOR, PAYROLL_EVERY_DAYS - 1))
/** The weekday payroll is run on. */
export const PAYROLL_RUN_WEEKDAY = weekdayName(
  addDays(PAYROLL_ANCHOR, PAYROLL_EVERY_DAYS - 1 + PAYROLL_RUN_LAG_DAYS)
)
/** The weekday the money lands. */
export const PAYROLL_PAY_WEEKDAY = weekdayName(
  addDays(PAYROLL_ANCHOR, PAYROLL_EVERY_DAYS - 1 + PAYROLL_PAY_LAG_DAYS)
)

export interface PayrollPeriod {
  /** First day of work in the period, inclusive. A Monday. */
  start: string
  /** Last day of work in the period, inclusive. A Sunday. */
  end: string
  /** The day payroll is RUN for this period — three days after it closes. */
  runOn: string
  /** The day the money lands — five days after it closes, two after the run. */
  paidOn: string
  /** True for the period the given day falls inside. */
  current: boolean
}

/** The three derived dates for a period that starts on `start`. */
function periodFrom(start: string, current: boolean): PayrollPeriod {
  const end = addDays(start, PAYROLL_EVERY_DAYS - 1)
  return {
    start,
    end,
    runOn: addDays(end, PAYROLL_RUN_LAG_DAYS),
    paidOn: addDays(end, PAYROLL_PAY_LAG_DAYS),
    current
  }
}

/**
 * The period a day belongs to.
 *
 * Half-open by construction: a period runs from one period start up to, but not
 * including, the next. A day that IS a start opens the fortnight ahead rather
 * than closing the one behind — work done that Sunday belongs to the new period.
 */
export function payrollPeriodFor(day: string): PayrollPeriod {
  const next = nextOccurrence(PAYROLL_ANCHOR, PAYROLL_EVERY_DAYS, day)
  const start = next === day ? day : addDays(next, -PAYROLL_EVERY_DAYS)
  return periodFrom(start, false)
}

/** The `count` most recent periods, newest first, ending with the one `today` is in. */
export function recentPayrollPeriods(today: string, count: number): PayrollPeriod[] {
  const here = payrollPeriodFor(today)
  const out: PayrollPeriod[] = []
  for (let i = 0; i < Math.max(1, count); i++) {
    out.push(periodFrom(addDays(here.start, -i * PAYROLL_EVERY_DAYS), i === 0))
  }
  return out
}

/**
 * The most recently CLOSED period — the one an export is almost always for.
 *
 * Not the period `today` sits in: that one is still being worked and its hours
 * are not final. "Last payroll" means the fortnight whose timesheet has closed,
 * which is the one immediately before the current fortnight.
 */
export function lastClosedPayrollPeriod(today: string): PayrollPeriod {
  const here = payrollPeriodFor(today)
  return periodFrom(addDays(here.start, -PAYROLL_EVERY_DAYS), false)
}
