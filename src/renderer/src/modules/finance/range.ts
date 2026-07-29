import type { StreamDayFinance, StreamFinanceTotals } from '@shared/financeStreaming'
import { sumDayFinance } from '@shared/financeStreaming'
import { dayKeyOf, daySpan, shiftDayKey, todayKey } from './time'

/**
 * The date range the whole Streaming tab is reported over.
 *
 * ONE piece of state drives the widgets, the statement and the calendar's
 * highlight. The screen used to hold a "selected day" that opened a statement
 * and a separate grain switch that changed what the list below showed, which
 * meant the headline figures at the top described the WHOLE ledger while the
 * panel underneath described one day — two answers to "what did we make" on one
 * screen, neither labelled with which question it was answering.
 *
 * `null` means all time. Deliberately not "the widest range in the data": a
 * concrete range would have to be recomputed on every import and would print a
 * span that looks chosen when nobody chose it.
 */
export interface DayRange {
  /** Inclusive, YYYY-MM-DD. */
  from: string
  /** Inclusive, YYYY-MM-DD. */
  to: string
}

export function rangeContains(range: DayRange | null, dayKey: string): boolean {
  if (!range) return true
  return dayKey >= range.from && dayKey <= range.to
}

/** A range from two clicks in either order. */
export function rangeOf(a: string, b: string): DayRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

/** The days of a view that fall inside a range, in calendar order. */
export function daysInRange(
  days: StreamDayFinance[],
  range: DayRange | null
): StreamDayFinance[] {
  const kept = range ? days.filter((d) => rangeContains(range, d.streamDate)) : days.slice()
  return kept.sort((a, b) => a.streamDate.localeCompare(b.streamDate))
}

/**
 * What a range earned.
 *
 * Summed from the DAY ROWS with the contract's own accumulator — the same one
 * main builds the weeks and months with — so a range that happens to line up
 * with a week produces that week's figures to the cent. Nothing here re-derives
 * a fee or a margin from a range total; every field is the sum of the days, and
 * the statement's checksum still has to pass on the result.
 */
export function totalsForRange(
  days: StreamDayFinance[],
  range: DayRange | null
): StreamFinanceTotals {
  return sumDayFinance(daysInRange(days, range))
}

/**
 * The window immediately before this one, of the same length, for the "vs
 * previous" figure on each widget.
 *
 * Measured in CALENDAR days rather than in days that happened to have a show,
 * because that is what makes the comparison fair: a fortnight with four shows
 * against the fortnight before it with six is exactly the fact the delta is
 * there to surface, and matching on show count would hide it by construction.
 *
 * Null for all-time, which has nothing before it.
 */
export function priorRange(range: DayRange | null): DayRange | null {
  if (!range) return null
  const span = daySpan(range.from, range.to)
  if (span <= 0) return null
  const to = shiftDayKey(range.from, -1)
  return { from: shiftDayKey(to, -(span - 1)), to }
}

/** The span the days themselves cover — used to label all-time honestly rather
 *  than claiming a range nobody picked. */
export function coveredRange(days: StreamDayFinance[]): DayRange | null {
  if (days.length === 0) return null
  let from = days[0].streamDate
  let to = from
  for (const d of days) {
    if (d.streamDate < from) from = d.streamDate
    if (d.streamDate > to) to = d.streamDate
  }
  return { from, to }
}

/**
 * The quick ranges, as functions of TODAY rather than of the data.
 *
 * "This month" has to mean the calendar month whatever the ledger holds — a
 * preset that quietly meant "the last month with a show in it" would print
 * July's figures under a July heading in September and there would be nothing
 * on screen to say so. When a preset lands on an empty stretch the calendar
 * says the stretch is empty, which is the truth.
 */
export interface RangePreset {
  key: string
  label: string
  hint: string
  build: () => DayRange
}

export const RANGE_PRESETS: RangePreset[] = [
  {
    key: 'last7',
    label: 'Last 7 days',
    hint: 'Today and the six days before it',
    build: () => {
      const to = todayKey()
      return { from: shiftDayKey(to, -6), to }
    }
  },
  {
    key: 'last30',
    label: 'Last 30 days',
    hint: 'Today and the twenty-nine days before it',
    build: () => {
      const to = todayKey()
      return { from: shiftDayKey(to, -29), to }
    }
  },
  {
    key: 'thisMonth',
    label: 'This month',
    hint: 'The first of this calendar month to today',
    build: () => {
      const now = new Date()
      return {
        from: dayKeyOf(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: todayKey()
      }
    }
  },
  {
    key: 'lastMonth',
    label: 'Last month',
    hint: 'The whole of the previous calendar month',
    build: () => {
      const now = new Date()
      return {
        from: dayKeyOf(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: dayKeyOf(new Date(now.getFullYear(), now.getMonth(), 0))
      }
    }
  }
]

/** Which preset, if any, the current range IS — so the pressed state on the bar
 *  is derived from the range rather than remembered separately and allowed to
 *  drift out of step with it once someone clicks the calendar. */
export function activePreset(range: DayRange | null): string | null {
  if (!range) return null
  for (const p of RANGE_PRESETS) {
    const built = p.build()
    if (built.from === range.from && built.to === range.to) return p.key
  }
  return null
}
