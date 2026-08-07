import { dayKey, daysBetween } from '@shared/homeTasks'
import {
  AVAILABILITY_HORIZON_DAYS,
  sortShifts,
  upcomingFrom,
  validateAvailability,
  validateShift,
  type Availability,
  type AvailabilityWithPerson,
  type NewAvailability,
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
  // Enforced by the DERIVED id below rather than by a unique index, which would
  // reject an incoming row at the relay and retry it forever. The id makes two
  // machines rostering the same person for the same night write the SAME row, so
  // there is nothing for a constraint to catch. A duplicate can now only survive
  // from before this scheme existed, and the week view draws both so either can
  // be removed — a state somebody can see and fix rather than one sync chokes on.
  const existing = db
    .prepare(`SELECT id, created_at FROM shifts WHERE employee_id = ? AND shift_date = ?`)
    .get(input.employeeId, input.day) as { id: string; created_at: string } | undefined

  const stamp = nowIso()
  const shift: Shift = {
    // An existing row keeps its id; a new one gets an id DERIVED from the person
    // and the day. Two leads rostering the same person for the same night on two
    // machines then mint the same row and last-write-wins settles it, instead of
    // producing two lines that both look authoritative. Rows made before this
    // (plain UUIDs) are still found by the lookup above and updated in place, so
    // nothing has to be migrated.
    id: existing?.id ?? `sh_${input.employeeId}_${input.day}`,
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
        // Same derived id as createShift, so two leads copying the same week
        // converge on one row per person per night rather than doubling it.
        `sh_${r.employee_id}_${day}`,
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

// ---------------------------------------------------------------------------
// Availability — what somebody says about a day before anybody is put on it
// ---------------------------------------------------------------------------

interface AvailRow {
  id: string
  employee_id: string
  day: string
  status: string
  start_time: string | null
  end_time: string | null
  note: string | null
  created_at: string
  updated_at: string
}

function toAvailability(r: AvailRow): Availability {
  return {
    id: r.id,
    employeeId: r.employee_id,
    day: r.day,
    // Anything the database does not recognise reads as UNAVAILABLE. A row this
    // build cannot interpret must not be taken as permission to roster somebody
    // — the safe reading of a corrupt answer is the cautious one.
    status: r.status === 'available' ? 'available' : 'unavailable',
    startTime: r.start_time,
    endTime: r.end_time,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/**
 * The id of somebody's answer about a day.
 *
 * DERIVED, not minted — see the note in the v50 migration. Two machines
 * recording the same person's answer for the same day produce the same row, so
 * the relay compares it against an older copy of itself and the later answer
 * wins, which is what changing your mind means.
 */
function availabilityId(employeeId: string, day: string): string {
  return `av_${employeeId}_${day}`
}

/** One person's own answers, oldest day first. */
export function myAvailability(employeeId: string): Availability[] {
  return (
    getDb()
      .prepare(
        `SELECT id, employee_id, day, status, start_time, end_time, note, created_at, updated_at
           FROM availability WHERE employee_id = ? ORDER BY day ASC`
      )
      .all(employeeId) as AvailRow[]
  ).map(toAvailability)
}

/** Everybody's answers across a range, with names — the lead's view. */
export function listAvailability(from: string, to: string): AvailabilityWithPerson[] {
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.employee_id, a.day, a.status, a.start_time, a.end_time, a.note,
              a.created_at, a.updated_at,
              e.first_name AS first, e.last_name AS last
         FROM availability a
         LEFT JOIN employees e ON e.id = a.employee_id
        WHERE a.day >= ? AND a.day <= ?
        ORDER BY a.day ASC`
    )
    .all(from, to) as Array<AvailRow & { first: string | null; last: string | null }>
  return rows.map((r) => ({
    ...toAvailability(r),
    employeeName: `${r.first ?? ''} ${r.last ?? ''}`.trim() || 'Someone'
  }))
}

/**
 * Record an answer, replacing whatever this person said about that day before.
 *
 * There is exactly one answer per person per day by construction — the id says
 * so — which means changing your mind is the same operation as answering, and
 * there is no edit mode and nothing to delete first.
 *
 * The employee is NEVER taken from an argument. Every caller passes the session's
 * own id, and the derived key means an operation that accepted "whose" would be
 * one typo away from overwriting somebody else's day off.
 */
export function setAvailability(employeeId: string, input: NewAvailability): Availability {
  const problem = validateAvailability(input)
  if (problem) throw new Error(problem)

  const today = dayKey(new Date())
  // The PAST is not something to have an opinion about. A rota for last Tuesday
  // is history, and letting somebody mark it would put a row on a lead's screen
  // that reads as a request about a week that is over.
  if (input.day < today) throw new Error('That day has already been and gone.')
  if (daysBetween(today, input.day) > AVAILABILITY_HORIZON_DAYS) {
    throw new Error('That is too far ahead to plan for.')
  }

  const db = getDb()
  const stamp = nowIso()
  const id = availabilityId(employeeId, input.day)
  const existing = db.prepare(`SELECT created_at FROM availability WHERE id = ?`).get(id) as
    | { created_at: string }
    | undefined

  const row: Availability = {
    id,
    employeeId,
    day: input.day,
    status: input.status,
    startTime: clean(input.startTime),
    endTime: clean(input.endTime),
    note: clean(input.note),
    createdAt: existing?.created_at ?? stamp,
    updatedAt: stamp
  }

  db.prepare(
    `INSERT INTO availability
       (id, employee_id, day, status, start_time, end_time, note, created_at, updated_at)
     VALUES (@id, @employeeId, @day, @status, @startTime, @endTime, @note, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       status     = excluded.status,
       start_time = excluded.start_time,
       end_time   = excluded.end_time,
       note       = excluded.note,
       updated_at = excluded.updated_at`
  ).run(row)
  return row
}

/**
 * Take an answer back — say nothing about that day again.
 *
 * Scoped to the caller by the KEY rather than by a WHERE clause somebody has to
 * remember: the id is built from their own employee id, so a request naming
 * another person's row simply does not match.
 */
export function clearAvailability(employeeId: string, day: string): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM availability WHERE id = ?`)
      .run(availabilityId(employeeId, day)).changes > 0
  )
}
