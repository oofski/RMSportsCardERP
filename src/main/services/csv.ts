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

/**
 * An hours figure for Gusto — or nothing at all, which is not the same as zero.
 *
 * ## Gusto's rule, in Gusto's words
 *
 *   · "Zeros override previously entered information — if your spreadsheet has
 *     any, the zeros will replace any existing info."
 *   · "Blank values have no impact on previously entered information."
 *
 * So in a Smart Import a zero is not a neutral way of saying "nothing to
 * report". It is an instruction to ERASE the cell. And the export this feeds
 * used to write `0.00` into Overtime for every employee on every run, because
 * `toFixed(2)` has no way of saying "no answer" — which meant any overtime
 * entered or corrected inside Gusto was wiped by the next upload, silently,
 * with a file that looked completely ordinary.
 *
 * A blank is the honest rendering of "this app has nothing to say about that
 * cell", and it is also the safe one. Nothing is lost: an app that computed no
 * overtime is not asserting that Gusto's overtime is wrong, it simply did not
 * measure any.
 *
 * ## Tested on the RENDERED value, deliberately
 *
 * Not on the raw minutes. Eighteen seconds of clock drift is a real, non-zero
 * number of minutes that formats as "0.00" — and writing that would erase a
 * genuine figure in order to report three-tenths of a minute nobody is paid
 * for. Whatever prints as zero is treated as zero.
 *
 * ## If somebody genuinely needs to zero a cell
 *
 * They type a 0 into the sheet by hand before uploading. That is the only way
 * to express it, by Gusto's design, and it should be a deliberate act rather
 * than a side effect of exporting a quiet fortnight.
 */
function hoursCell(minutes: number): string {
  const rendered = hours2(minutes)
  return rendered === '0.00' ? '' : rendered
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

/**
 * The Gusto Smart Import sheet: one row per employee who actually worked.
 *
 * ## Why an employee with no hours is LEFT OUT rather than written as zero
 *
 * The caller hands this every employee on the books, not every employee who
 * clocked in — so a fortnight's export carries a row for the salaried office,
 * for anyone on leave, and for anyone whose hours are keyed straight into Gusto
 * and never touch this app. Those rows have nothing to report.
 *
 * Written as `0.00` they were not nothing: by Gusto's rule a zero replaces
 * what is already there, so the export was quietly erasing the hours of exactly
 * the people it knew least about. Written as blanks they would be harmless but
 * pointless — a row of empty cells that invites somebody to "finish" it by
 * typing zeros. So they are omitted, and the file says only what this app
 * actually measured.
 *
 * ## What the numeric cells do
 *
 * See `hoursCell`. Any figure that prints as zero is written blank, so a week
 * with no overtime leaves Gusto's overtime alone instead of clearing it.
 */
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
    // Nothing measured, nothing to say. See the note above: a row of zeros here
    // is an instruction to erase, not a statement that the week was quiet.
    if (hours2(totals.totalMinutes) === '0.00') continue
    lines.push(
      [
        esc(employee.firstName),
        esc(employee.lastName),
        esc(employee.email),
        esc(employee.companyId),
        esc(hoursCell(totals.regularMinutes)),
        esc(hoursCell(totals.overtimeMinutes)),
        esc(hoursCell(totals.totalMinutes)),
        esc(localDate(start)),
        esc(localDate(end))
      ].join(',')
    )
  }
  return lines.join('\r\n')
}
