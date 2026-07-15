import type { TimeEntry } from '@shared/types'

/** A pay-period / date range. `end` is exclusive (start of the following day). */
export interface Period {
  id: string
  label: string
  start: string
  end: string
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function mondayOf(d: Date): Date {
  const x = startOfDay(d)
  const day = (x.getDay() + 6) % 7 // Monday = 0
  x.setDate(x.getDate() - day)
  return x
}

/** Standard preset periods computed from "now". */
export function presetPeriods(now: Date = new Date()): Period[] {
  const today = startOfDay(now)
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)

  const thisMon = mondayOf(now)
  const nextMon = new Date(thisMon)
  nextMon.setDate(thisMon.getDate() + 7)
  const lastMon = new Date(thisMon)
  lastMon.setDate(thisMon.getDate() - 7)

  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const nextFirst = new Date(today.getFullYear(), today.getMonth() + 1, 1)
  const lastFirst = new Date(today.getFullYear(), today.getMonth() - 1, 1)

  const last14 = new Date(today)
  last14.setDate(today.getDate() - 13)

  return [
    { id: 'this-week', label: 'This week', start: thisMon.toISOString(), end: nextMon.toISOString() },
    { id: 'last-week', label: 'Last week', start: lastMon.toISOString(), end: thisMon.toISOString() },
    {
      id: 'last-14',
      label: 'Last 14 days',
      start: last14.toISOString(),
      end: tomorrow.toISOString()
    },
    {
      id: 'this-month',
      label: 'This month',
      start: first.toISOString(),
      end: nextFirst.toISOString()
    },
    {
      id: 'last-month',
      label: 'Last month',
      start: lastFirst.toISOString(),
      end: first.toISOString()
    }
  ]
}

/** Build a custom period from two yyyy-mm-dd local dates (end inclusive). */
export function customPeriod(startDate: string, endDate: string): Period {
  const s = startOfDay(new Date(`${startDate}T00:00:00`))
  const e = startOfDay(new Date(`${endDate}T00:00:00`))
  e.setDate(e.getDate() + 1) // make end exclusive
  return { id: 'custom', label: 'Custom', start: s.toISOString(), end: e.toISOString() }
}

/** yyyy-mm-dd (local) for a date input, from an ISO string. */
export function toDateInput(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Inclusive last day of a period (end is exclusive internally). */
export function inclusiveEndInput(iso: string): string {
  const d = new Date(iso)
  d.setDate(d.getDate() - 1)
  return toDateInput(d.toISOString())
}

const WEEKLY_OT_MIN = 40 * 60

export interface PayrollTotals {
  totalMinutes: number
  regularMinutes: number
  overtimeMinutes: number
}

function entryMinutes(e: TimeEntry): number {
  if (!e.clockOut) return 0
  return (new Date(e.clockOut).getTime() - new Date(e.clockIn).getTime()) / 60000
}

function weekKey(iso: string): string {
  const d = mondayOf(new Date(iso))
  return toDateInput(d.toISOString())
}

/** Weekly-overtime payroll totals for a set of entries (mirrors the exporter). */
export function computePayroll(entries: TimeEntry[]): PayrollTotals {
  const byWeek = new Map<string, number>()
  for (const e of entries) {
    const m = entryMinutes(e)
    if (m <= 0) continue
    byWeek.set(weekKey(e.clockIn), (byWeek.get(weekKey(e.clockIn)) ?? 0) + m)
  }
  let total = 0
  let regular = 0
  let overtime = 0
  for (const weekMin of byWeek.values()) {
    total += weekMin
    regular += Math.min(weekMin, WEEKLY_OT_MIN)
    overtime += Math.max(0, weekMin - WEEKLY_OT_MIN)
  }
  return {
    totalMinutes: Math.round(total),
    regularMinutes: Math.round(regular),
    overtimeMinutes: Math.round(overtime)
  }
}

export { entryMinutes }
