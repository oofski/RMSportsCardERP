import { randomUUID } from 'crypto'
import { dayKey } from '@shared/homeTasks'
import {
  sortShifts,
  upcomingFrom,
  validateShift,
  type NewShift,
  type Shift,
  type ShiftWithPerson
} from '@shared/schedule'
import { getDb } from './database'

/**
 * The rota.
 *
 * Reads come in two shapes and the difference is a permission boundary rather
 * than a convenience: `myShifts` takes an employee id the CALLER cannot choose
 * (the handler passes the session's), and `listShifts` is the team-wide view
 * behind admin.hours.view. There is deliberately no single function with an
 * optional employee filter, because that is the shape where somebody eventually
 * forgets to pass the filter.
 */

interface Row {
  id: string
  employee_id: string
  shift_date: string
  start_time: string | null
  end_time: string | null
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

function toShift(r: Row): Shift {
  return {
    id: r.id,
    employeeId: r.employee_id,
    day: r.shift_date,
    startTime: r.start_time,
    endTime: r.end_time,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** Everything on one person's rota, oldest first. */
export function myShifts(employeeId: string): Shift[] {
  const rows = getDb()
    .prepare(
      `SELECT id, employee_id, shift_date, start_time, end_time, note, created_by,
              created_at, updated_at
         FROM shifts WHERE employee_id = ?`
    )
    .all(employeeId) as Row[]
  return sortShifts(rows.map(toShift))
}

/**
 * One person's shifts from today forward.
 *
 * The "today counts as forward" rule lives in @shared/schedule so the board —
 * which already holds the whole rota and must not run a second query to say the
 * same thing — cannot drift from this.
 */
export function upcomingShifts(employeeId: string, limit = 8): Shift[] {
  return upcomingFrom(myShifts(employeeId), dayKey(new Date()), limit)
}

/** The whole team's rota across a date range, with names. */
export function listShifts(from: string, to: string): ShiftWithPerson[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.employee_id, s.shift_date, s.start_time, s.end_time, s.note,
              s.created_by, s.created_at, s.updated_at,
              e.first_name AS first, e.last_name AS last
         FROM shifts s
         LEFT JOIN employees e ON e.id = s.employee_id
        WHERE s.shift_date >= ? AND s.shift_date <= ?`
    )
    .all(from, to) as Array<Row & { first: string | null; last: string | null }>
  return sortShifts(
    rows.map((r) => ({
      ...toShift(r),
      // A shift whose employee row has gone still has to render. Dropping it
      // would silently shrink the rota, which is worse than a line that reads
      // "Someone" and prompts a lead to fix it.
      employeeName: `${r.first ?? ''} ${r.last ?? ''}`.trim() || 'Someone'
    }))
  )
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

export function createShift(input: NewShift, actorId: string | null): Shift {
  const problem = validateShift(input)
  if (problem) throw new Error(problem)

  const db = getDb()
  // Somebody who is not on the roster cannot be rostered. There is no foreign
  // key on this table (see the migration note), so this is where the check has
  // to live — and it earns its keep: a typo'd id would otherwise produce a
  // shift that appears on nobody's screen and can only be found in the table.
  const exists = db.prepare(`SELECT 1 FROM employees WHERE id = ?`).get(input.employeeId)
  if (!exists) throw new Error('That person is not on the roster.')

  // One shift per person per day. The floor works one shift a night, and the
  // real-world version of a second row is somebody clicking Add twice — which
  // would put the same evening on the calendar twice with nothing to say which
  // is right. Adding again REPLACES, so correcting a time is the same gesture
  // as setting one.
  //
  // Enforced HERE and deliberately not by a unique index. Two leads on two
  // laptops can each mint a different id for the same person and day, and a
  // unique index would make the second one fail to APPLY when it arrived over
  // the relay — a rejected row that then retries forever, to stop a duplicate
  // that is merely untidy. So the constraint is best-effort and local: the week
  // view draws both lines and either can be removed, which is a state somebody
  // can see and fix rather than one the sync silently chokes on.
  const existing = db
    .prepare(`SELECT id, created_at FROM shifts WHERE employee_id = ? AND shift_date = ?`)
    .get(input.employeeId, input.day) as { id: string; created_at: string } | undefined

  const stamp = nowIso()
  const shift: Shift = {
    id: existing?.id ?? randomUUID(),
    employeeId: input.employeeId,
    day: input.day,
    startTime: clean(input.startTime),
    endTime: clean(input.endTime),
    note: clean(input.note),
    createdBy: actorId,
    createdAt: existing?.created_at ?? stamp,
    updatedAt: stamp
  }

  db.prepare(
    `INSERT INTO shifts
       (id, employee_id, shift_date, start_time, end_time, note, created_by, created_at, updated_at)
     VALUES (@id, @employeeId, @day, @startTime, @endTime, @note, @createdBy, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       shift_date = excluded.shift_date,
       start_time = excluded.start_time,
       end_time   = excluded.end_time,
       note       = excluded.note,
       updated_at = excluded.updated_at`
  ).run(shift)
  return shift
}

export function deleteShift(id: string): boolean {
  return getDb().prepare(`DELETE FROM shifts WHERE id = ?`).run(id).changes > 0
}

/**
 * Copy one week onto the next.
 *
 * The rota here repeats far more often than it changes — the same four people
 * on the same four nights — so the alternative to this is typing twenty-eight
 * identical rows a month, which is the reason rotas end up on a whiteboard
 * instead of in the app.
 *
 * Existing shifts on the target week are LEFT ALONE rather than overwritten. A
 * row already there was put there deliberately, most likely because that week
 * is the one that differs, and a copy that silently reverted it would be worse
 * than one that skipped it.
 */
export function copyWeek(fromMonday: string, toMonday: string, actorId: string | null): number {
  const db = getDb()
  const shift = (day: string, n: number): string => {
    const t = Date.parse(`${day}T12:00:00Z`)
    return new Date(t + n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  }
  const fromEnd = shift(fromMonday, 6)
  const source = db
    .prepare(
      `SELECT employee_id, shift_date, start_time, end_time, note
         FROM shifts WHERE shift_date >= ? AND shift_date <= ?`
    )
    .all(fromMonday, fromEnd) as Array<{
    employee_id: string
    shift_date: string
    start_time: string | null
    end_time: string | null
    note: string | null
  }>
  if (source.length === 0) return 0

  const stamp = nowIso()
  const insert = db.prepare(
    `INSERT INTO shifts
       (id, employee_id, shift_date, start_time, end_time, note, created_by, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM shifts WHERE employee_id = ? AND shift_date = ?
      )`
  )
  let made = 0
  const run = db.transaction(() => {
    for (const r of source) {
      const offset = Math.round(
        (Date.parse(`${r.shift_date}T12:00:00Z`) - Date.parse(`${fromMonday}T12:00:00Z`)) /
          (24 * 60 * 60 * 1000)
      )
      const day = shift(toMonday, offset)
      made += insert.run(
        randomUUID(),
        r.employee_id,
        day,
        r.start_time,
        r.end_time,
        r.note,
        actorId,
        stamp,
        stamp,
        r.employee_id,
        day
      ).changes
    }
  })
  run()
  return made
}
