import type {
  EmployeeHoursSummary,
  NewTimeEntryInput,
  PunchLocation,
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
  clock_in_lat: number | null
  clock_in_lng: number | null
  clock_in_place: string | null
  clock_out_lat: number | null
  clock_out_lng: number | null
  clock_out_place: string | null
}

function toTimeEntry(row: TimeEntryRow): TimeEntry {
  return {
    id: row.id,
    employeeId: row.employee_id,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    note: row.note,
    source: row.source === 'clock' ? 'clock' : 'manual',
    createdAt: row.created_at,
    clockInLocation: {
      place: row.clock_in_place,
      lat: row.clock_in_lat,
      lng: row.clock_in_lng
    },
    clockOutLocation: {
      place: row.clock_out_place,
      lat: row.clock_out_lat,
      lng: row.clock_out_lng
    }
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

/** Entries whose clock-in falls within [start, end). */
export function listInRange(start: string, end: string, employeeId?: string): TimeEntry[] {
  const db = getDb()
  const rows = employeeId
    ? (db
        .prepare(
          'SELECT * FROM time_entries WHERE employee_id = ? AND clock_in >= ? AND clock_in < ? ORDER BY clock_in ASC'
        )
        .all(employeeId, start, end) as TimeEntryRow[])
    : (db
        .prepare(
          'SELECT * FROM time_entries WHERE clock_in >= ? AND clock_in < ? ORDER BY clock_in ASC'
        )
        .all(start, end) as TimeEntryRow[])
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

// ---------------------------------------------------------------------------
// Time clock (self-service punches)
// ---------------------------------------------------------------------------

/** The employee's currently open (not-yet-clocked-out) shift, if any. */
export function getOpenEntry(employeeId: string): TimeEntry | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM time_entries WHERE employee_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1'
    )
    .get(employeeId) as TimeEntryRow | undefined
  return row ? toTimeEntry(row) : null
}

export function clockIn(employeeId: string, location: PunchLocation): TimeEntry {
  const db = getDb()
  const id = newId()
  const ts = nowIso()
  db.prepare(
    `INSERT INTO time_entries
       (id, employee_id, clock_in, clock_out, note, source, created_at,
        clock_in_lat, clock_in_lng, clock_in_place)
     VALUES (?, ?, ?, NULL, NULL, 'clock', ?, ?, ?, ?)`
  ).run(id, employeeId, ts, ts, location.lat, location.lng, location.place)
  const row = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as TimeEntryRow
  return toTimeEntry(row)
}

export function clockOut(entryId: string, location: PunchLocation): TimeEntry | null {
  const db = getDb()
  db.prepare(
    `UPDATE time_entries
       SET clock_out = ?, clock_out_lat = ?, clock_out_lng = ?, clock_out_place = ?
     WHERE id = ? AND clock_out IS NULL`
  ).run(nowIso(), location.lat, location.lng, location.place, entryId)
  const row = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entryId) as
    | TimeEntryRow
    | undefined
  return row ? toTimeEntry(row) : null
}

/** Completed minutes for an employee within [start, end). Open shifts excluded. */
export function minutesInRange(employeeId: string, start: string, end: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(
         CASE WHEN clock_out IS NOT NULL
              THEN (julianday(clock_out) - julianday(clock_in)) * 24 * 60
              ELSE 0 END), 0) AS mins
       FROM time_entries
       WHERE employee_id = ? AND clock_in >= ? AND clock_in < ?`
    )
    .get(employeeId, start, end) as { mins: number }
  return Math.round(row.mins)
}

/**
 * Per-employee hours totals. Open entries contribute nothing to the total but
 * still count toward the entry count, so an in-progress shift is visible
 * without inflating hours.
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
