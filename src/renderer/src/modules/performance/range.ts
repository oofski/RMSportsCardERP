import { addDayKey, localDayKey, orderDays } from '@shared/performance'

/**
 * The range the whole tab is reported over: a run of LOCAL calendar days.
 *
 * Days, never instants. The stamps being summarised are UTC instants — physical
 * moments — but "this week" is a statement about a calendar, and the conversion
 * between the two happens in exactly one place (utcWindowForDays, in the main
 * process). Nothing in this file does date arithmetic on an ISO timestamp, and
 * that is deliberate: two places doing it is two places to get a clock change
 * wrong.
 *
 * There is no "all time" here, unlike the Finance range bar. Finance has a
 * ledger with a first row and a last one; this log begins whenever the feature
 * was installed on a machine, so an all-time button would print a span nobody
 * chose over a period the app was not recording for.
 */
export interface DayRange {
  /** Inclusive, YYYY-MM-DD. */
  from: string
  /** Inclusive, YYYY-MM-DD. */
  to: string
}

export function todayKey(): string {
  return localDayKey(new Date().toISOString())
}

export type RangeGrain = 'day' | 'week' | 'month' | 'custom'

export interface RangePreset {
  key: Exclude<RangeGrain, 'custom'>
  label: string
  hint: string
  build: () => DayRange
}

/**
 * Day, week, month — as functions of TODAY rather than of the data.
 *
 * "This month" has to mean the calendar month whatever the log holds. A preset
 * that quietly meant "the last month with work in it" would print July's
 * figures under a July heading in September with nothing on screen to say so.
 * When a preset lands on a stretch with nothing in it, the screen says the
 * stretch was empty — and says whether the log was even running.
 */
export const RANGE_PRESETS: RangePreset[] = [
  {
    key: 'day',
    label: 'Today',
    hint: 'Work finished today',
    build: () => {
      const t = todayKey()
      return { from: t, to: t }
    }
  },
  {
    key: 'week',
    label: 'Last 7 days',
    hint: 'Today and the six days before it',
    build: () => {
      const t = todayKey()
      return { from: addDayKey(t, -6), to: t }
    }
  },
  {
    key: 'month',
    label: 'Last 30 days',
    hint: 'Today and the twenty-nine days before it',
    build: () => {
      const t = todayKey()
      return { from: addDayKey(t, -29), to: t }
    }
  }
]

/**
 * Which preset the current range IS, derived rather than remembered.
 *
 * Remembering it separately means the pressed button and the dates can drift
 * apart the moment somebody edits one of the two date boxes — and a highlighted
 * "Today" over a range that is not today is worse than no highlight at all.
 */
export function activeGrain(range: DayRange): RangeGrain {
  for (const p of RANGE_PRESETS) {
    const built = p.build()
    if (built.from === range.from && built.to === range.to) return p.key
  }
  return 'custom'
}

export function rangeOf(a: string, b: string): DayRange {
  return orderDays(a, b)
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

/** A day key as a person reads it. Parsed at UTC noon — see addDayKey. */
export function dayLabel(day: string): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  const d = new Date(t)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function rangeLabel(range: DayRange): string {
  return range.from === range.to
    ? dayLabel(range.from)
    : `${dayLabel(range.from)} – ${dayLabel(range.to)}`
}
