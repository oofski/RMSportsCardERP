import type { Employee, TimeEntry } from '@shared/types'

/**
 * CSV builders for timesheet export. Produces two shapes:
 *  - a detailed per-punch timesheet, and
 *  - a Gusto-friendly hours summary (Regular / Overtime, per employee).
 *
 * Times are formatted in the machine's local timezone (the employer's context).
 * Overtime uses a simple >40h-per-week rule; adjust if a different policy is
 * needed.
 */

const WEEKLY_OT_THRESHOLD_MIN = 40 * 60

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function localTime(iso: string): string {
  const d = new Date(iso)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** Monday-of-week key (local), used to bucket hours for weekly overtime. */
function weekKey(iso: string): string {
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7 // 0 = Monday
  d.setDate(d.getDate() - day)
  return localDate(d.toISOString())
}

function entryMinutes(e: TimeEntry): number {
  if (!e.clockOut) return 0
  return (new Date(e.clockOut).getTime() - new Date(e.clockIn).getTime()) / 60000
}

function esc(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function hours2(minutes: number): string {
  return (minutes / 60).toFixed(2)
}

export interface PayrollTotals {
  totalMinutes: number
  regularMinutes: number
  overtimeMinutes: number
}

/** Total / regular / overtime minutes for a set of entries (weekly OT rule). */
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
    regular += Math.min(weekMin, WEEKLY_OT_THRESHOLD_MIN)
    overtime += Math.max(0, weekMin - WEEKLY_OT_THRESHOLD_MIN)
  }
  return {
    totalMinutes: Math.round(total),
    regularMinutes: Math.round(regular),
    overtimeMinutes: Math.round(overtime)
  }
}

/** Detailed per-punch timesheet for a single employee. */
export function timesheetCsv(employee: Employee, entries: TimeEntry[]): string {
  const header = [
    'Employee',
    'Company ID',
    'Email',
    'Date',
    'Clock in',
    'Clock out',
    'Hours',
    'Clock-in location',
    'Clock-out location',
    'Source',
    'Note'
  ]
  const name = `${employee.firstName} ${employee.lastName}`
  const lines = [header.map(esc).join(',')]
  for (const e of entries) {
    lines.push(
      [
        esc(name),
        esc(employee.companyId),
        esc(employee.email),
        esc(localDate(e.clockIn)),
        esc(localTime(e.clockIn)),
        esc(e.clockOut ? localTime(e.clockOut) : ''),
        esc(e.clockOut ? hours2(entryMinutes(e)) : ''),
        esc(e.clockInLocation.place ?? ''),
        esc(e.clockOutLocation.place ?? ''),
        esc(e.source),
        esc(e.note ?? '')
      ].join(',')
    )
  }
  const totals = computePayroll(entries)
  lines.push('')
  lines.push([esc('Totals'), '', '', '', '', '', esc(hours2(totals.totalMinutes))].join(','))
  return lines.join('\r\n')
}

export interface GustoRow {
  employee: Employee
  totals: PayrollTotals
}

/** Gusto-friendly hours summary, one row per employee. */
export function gustoCsv(rows: GustoRow[], start: string, end: string): string {
  const header = [
    'First name',
    'Last name',
    'Employee email',
    'Company ID',
    'Regular hours',
    'Overtime hours',
    'Total hours',
    'Pay period start',
    'Pay period end'
  ]
  const lines = [header.map(esc).join(',')]
  for (const { employee, totals } of rows) {
    lines.push(
      [
        esc(employee.firstName),
        esc(employee.lastName),
        esc(employee.email),
        esc(employee.companyId),
        esc(hours2(totals.regularMinutes)),
        esc(hours2(totals.overtimeMinutes)),
        esc(hours2(totals.totalMinutes)),
        esc(localDate(start)),
        esc(localDate(end))
      ].join(',')
    )
  }
  return lines.join('\r\n')
}
