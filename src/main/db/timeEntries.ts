import type {
  EmployeeHoursSummary,
  NewTimeEntryInput,
  TimeEntry
} from '@shared/types'
import { getDb } from './database'
import { newId, nowIso } from '../util'

interface TimeEntryRow {
  id: string
  employee_id: string
  clock_in: string
  clock_out: string | null
  note: string | null
  source: string
  created_at: string
}

function toTimeEntry(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    employeeId: row.employee_id,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    note: row.note,
    source: row.source === 'clock' ? 'clock' : 'manual',
    createdAt: row.created_at
  }
}

export function listTimeEntries(employeeId?: string): TimeEntry[] {
  const db = getDb()
  const rows = employeeId
    ? (db
        .prepare('SELECT * FROM time_entries WHERE employee_id = ? ORDER BY clock_in DESC')
        .all(employeeId) as TimeEntryRow[])
    : (db.prepare('SELECT * FROM time_entries ORDER BY clock_in DESC').all() as TimeEntryRow[])
  return rows.map(toTimeEntry)
}

export function insertTimeEntry(input: NewTimeEntryInput): TimeEntry {
  const db = getDb()
  const id = newId()
  db.prepare(
    `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, note, source, created_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?)`
  ).run(id, input.employeeId, input.clockIn, input.clockOut, input.note ?? null, nowIso())
  const row = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as TimeEntryRow
  return toTimeEntry(row)
}

export function deleteTimeEntry(id: string): boolean {
  const info = getDb().prepare('DELETE FROM time_entries WHERE id = ?').run(id)
  return info.changes > 0
}

/**
 * Per-employee hours totals. Open entries (no clock-out) contribute nothing to
 * the total but still count toward the entry count, so an in-progress shift is
 * visible without inflating hours.
 */
export function hoursSummary(): EmployeeHoursSummary[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT
         e.id                                   AS employee_id,
         e.first_name || ' ' || e.last_name     AS employee_name,
         e.company_id                           AS company_id,
         COUNT(t.id)                            AS entry_count,
         MAX(t.clock_in)                        AS last_entry_at,
         COALESCE(SUM(
           CASE
             WHEN t.clock_out IS NOT NULL
             THEN (julianday(t.clock_out) - julianday(t.clock_in)) * 24 * 60
             ELSE 0
           END
         ), 0)                                  AS total_minutes
       FROM employees e
       LEFT JOIN time_entries t ON t.employee_id = e.id
       GROUP BY e.id
       ORDER BY employee_name COLLATE NOCASE`
    )
    .all() as Array<{
    employee_id: string
    employee_name: string
    company_id: string
    entry_count: number
    last_entry_at: string | null
    total_minutes: number
  }>

  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    companyId: r.company_id,
    totalMinutes: Math.round(r.total_minutes),
    entryCount: r.entry_count,
    lastEntryAt: r.last_entry_at
  }))
}
