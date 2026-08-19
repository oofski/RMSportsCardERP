import { addDays, dayKey, daysBetween } from '@shared/homeTasks'
import {
  AVAILABILITY_HORIZON_DAYS,
  effectiveAvailability,
  shiftNeedsPublishing,
  sortShifts,
  upcomingFrom,
  validateAvailability,
  validatePatternDay,
  shiftMinutes,
  validateShift,
  weekdayOf,
  type Availability,
  type AvailabilityPattern,
  type AvailabilityWithPerson,
  type EffectiveAvailability,
  type EffectiveAvailabilityWithPerson,
  type NewAvailability,
  type NewShift,
  type PatternDayInput,
  type Shift,
  type ShiftWithPerson,
  type TeamScheduleDay,
  type TeamSchedulePerson,
  type TeamScheduleOverview
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
  published_at: string | null
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
    publishedAt: r.published_at ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const SHIFT_COLS = `id, employee_id, shift_date, start_time, end_time, note, published_at,
                    created_by, created_at, updated_at`

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Everything on one person's rota, oldest first.
 *
 * PUBLISHED ONLY, and that filter is the whole of the draft feature as far as
 * the floor is concerned. A shift a lead is still deciding about does not exist
 * on the phone of the person it might be about — which is the difference between
 * a rota and a lead thinking out loud.
 *
 * An EDIT to an already-published shift is visible immediately, and that is
 * deliberate rather than an oversight: once somebody has been told they are in
 * at 4pm, the worst thing this screen can show them is the old time. The
 * publishing pass exists to send the message about the change, not to hide it.
 */
export function myShifts(employeeId: string): Shift[] {
  const rows = getDb()
    .prepare(`SELECT ${SHIFT_COLS} FROM shifts WHERE employee_id = ? AND published_at IS NOT NULL`)
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

/**
 * The whole team's rota across a date range, with names.
 *
 * DRAFTS INCLUDED, unlike `myShifts`. This is the lead's read and the screen it
 * feeds is the one where the week is built — hiding the unpublished rows from it
 * would hide the work in progress from the person doing the work.
 */
export function listShifts(from: string, to: string): ShiftWithPerson[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.employee_id, s.shift_date, s.start_time, s.end_time, s.note,
              s.published_at, s.created_by, s.created_at, s.updated_at,
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
    .prepare(
      `SELECT id, created_at, published_at FROM shifts WHERE employee_id = ? AND shift_date = ?`
    )
    .get(input.employeeId, input.day) as
    | { id: string; created_at: string; published_at: string | null }
    | undefined

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
    // A NEW shift is a draft; an edit KEEPS whatever publishing state it had.
    // Clearing it on edit would look tidier and would be wrong twice over: the
    // person working it would lose the shift off their screen entirely because
    // a lead corrected a note, and `updatedAt` moving past `publishedAt` already
    // records that the change is unsent — see shiftNeedsPublishing.
    publishedAt: existing?.published_at ?? null,
    createdBy: actorId,
    createdAt: existing?.created_at ?? stamp,
    updatedAt: stamp
  }

  db.prepare(
    `INSERT INTO shifts
       (id, employee_id, shift_date, start_time, end_time, note, published_at,
        created_by, created_at, updated_at)
     VALUES (@id, @employeeId, @day, @startTime, @endTime, @note, @publishedAt,
             @createdBy, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       shift_date = excluded.shift_date,
       start_time = excluded.start_time,
       end_time   = excluded.end_time,
       note       = excluded.note,
       updated_at = excluded.updated_at`
  ).run(shift)
  return shift
}

/**
 * Shifts in a range that still owe somebody a message.
 *
 * Never published, or published and changed since. See shiftNeedsPublishing for
 * why the second case is not an afterthought: a shift moved after it was
 * announced leaves the person holding an answer that is no longer true, and they
 * have no reason to go and look.
 */
export function unpublishedShifts(from: string, to: string): ShiftWithPerson[] {
  return listShifts(from, to).filter(shiftNeedsPublishing)
}

/**
 * Publish a week.
 *
 * Returns WHAT WAS PUBLISHED rather than just how many, because the caller has
 * to tell each person about their own shifts and cannot ask again afterwards —
 * once the stamp is written the rows no longer look unpublished, so a second
 * read would come back empty and nobody would be told anything.
 *
 * The read and the stamp are one transaction for the same reason: two leads
 * pressing Publish at once must not both decide they are the ones announcing
 * Thursday.
 *
 * Only ever moves shifts FORWARD into published. There is deliberately no
 * unpublish: taking a shift back off somebody's phone after they have been told
 * about it does not untell them, and a screen that implies otherwise is worse
 * than one that makes you delete the shift and say so.
 */
export function publishShifts(from: string, to: string): ShiftWithPerson[] {
  const db = getDb()
  const stamp = nowIso()
  const run = db.transaction((): ShiftWithPerson[] => {
    const due = unpublishedShifts(from, to)
    if (due.length === 0) return []
    const mark = db.prepare(`UPDATE shifts SET published_at = ? WHERE id = ?`)
    for (const shift of due) mark.run(stamp, shift.id)
    return due.map((s) => ({ ...s, publishedAt: stamp }))
  })
  return run()
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
 *
 * A COPIED WEEK ARRIVES AS A DRAFT. `published_at` is not in the column list
 * below, so every row lands NULL — which is the point: copying last week is the
 * FIRST step in building this one, not the last, and a copy that published
 * itself would tell the floor about a week nobody has looked at yet.
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

// ---------------------------------------------------------------------------
// The usual week — a repeating pattern, evaluated rather than expanded
// ---------------------------------------------------------------------------

interface PatternRow {
  id: string
  employee_id: string
  weekday: number
  status: string
  start_time: string | null
  end_time: string | null
  note: string | null
  updated_at: string
}

function toPattern(r: PatternRow): AvailabilityPattern {
  return {
    id: r.id,
    employeeId: r.employee_id,
    weekday: r.weekday,
    // Same rule as a dated answer: an unreadable status is never taken as
    // permission to roster somebody.
    status: r.status === 'available' ? 'available' : 'unavailable',
    startTime: r.start_time,
    endTime: r.end_time,
    note: r.note,
    updatedAt: r.updated_at
  }
}

function patternId(employeeId: string, weekday: number): string {
  return `ap_${employeeId}_${weekday}`
}

const PATTERN_COLS = `id, employee_id, weekday, status, start_time, end_time, note, updated_at`

/** One person's usual week, Sunday first. */
export function myPattern(employeeId: string): AvailabilityPattern[] {
  return (
    getDb()
      .prepare(
        `SELECT ${PATTERN_COLS} FROM availability_pattern
          WHERE employee_id = ? ORDER BY weekday ASC`
      )
      .all(employeeId) as PatternRow[]
  ).map(toPattern)
}

/**
 * Replace the named days of a usual week in one go.
 *
 * ONE transaction and one gesture, because that is how somebody thinks about
 * it: "this is my week." Saving seven days as seven calls would let a dropped
 * connection leave a half-written week that reads as a real answer — Monday
 * saved, Wednesday not, and a lead rostering against the difference.
 *
 * A day whose status is null is CLEARED rather than stored as a "no". Silence
 * about Tuesday and "I cannot work Tuesday" are different claims, and the
 * screen has three positions for exactly that reason.
 */
export function setPattern(employeeId: string, days: PatternDayInput[]): AvailabilityPattern[] {
  for (const d of days) {
    const problem = validatePatternDay(d)
    if (problem) throw new Error(problem)
  }
  const seen = new Set<number>()
  for (const d of days) {
    if (seen.has(d.weekday)) throw new Error('That week names the same day twice.')
    seen.add(d.weekday)
  }

  const db = getDb()
  const stamp = nowIso()
  const upsert = db.prepare(
    `INSERT INTO availability_pattern
       (id, employee_id, weekday, status, start_time, end_time, note, created_at, updated_at)
     VALUES (@id, @employeeId, @weekday, @status, @startTime, @endTime, @note, @stamp, @stamp)
     ON CONFLICT(id) DO UPDATE SET
       status     = excluded.status,
       start_time = excluded.start_time,
       end_time   = excluded.end_time,
       note       = excluded.note,
       updated_at = excluded.updated_at`
  )
  const drop = db.prepare(`DELETE FROM availability_pattern WHERE id = ?`)

  const run = db.transaction(() => {
    for (const d of days) {
      const id = patternId(employeeId, d.weekday)
      // NULL CLEARS. It must not fall through into a stored "unavailable" —
      // silence about a day and a refusal of it are different claims, and
      // promoting one into the other is the single worst bug this table can have.
      if (d.status === null) {
        drop.run(id)
        continue
      }
      upsert.run({
        id,
        employeeId,
        weekday: d.weekday,
        status: d.status,
        startTime: clean(d.startTime),
        endTime: clean(d.endTime),
        note: clean(d.note),
        stamp
      })
    }
  })
  run()
  return myPattern(employeeId)
}

/** Throw the whole usual week away. */
export function clearPattern(employeeId: string): number {
  return getDb()
    .prepare(`DELETE FROM availability_pattern WHERE employee_id = ?`)
    .run(employeeId).changes
}

/**
 * What one person's days actually come to across a range.
 *
 * The merge lives here rather than in every screen that wants it, because
 * getting it wrong is silent: a caller that forgot the pattern would show a
 * blank week for somebody who set their usual days months ago and has not
 * touched a date since.
 *
 * Only days somebody has actually said something about come back. A range where
 * neither an override nor a pattern applies is empty, which is what keeps
 * "nothing said" a real third state rather than a default.
 */
export function myEffectiveAvailability(
  employeeId: string,
  from: string,
  to: string
): EffectiveAvailability[] {
  const overrides = new Map(
    myAvailability(employeeId)
      .filter((a) => a.day >= from && a.day <= to)
      .map((a) => [a.day, a])
  )
  const pattern = new Map(myPattern(employeeId).map((p) => [p.weekday, p]))
  const out: EffectiveAvailability[] = []
  let guard = 0
  for (let day = from; day <= to && guard < 800; day = addDays(day, 1), guard++) {
    const eff = effectiveAvailability(day, overrides.get(day), pattern.get(weekdayOf(day)))
    if (eff) out.push(eff)
  }
  return out
}

/**
 * EVERYBODY's days across a range, merged the same way — the lead's view.
 *
 * Two reads and an in-memory merge rather than a query per person per day. The
 * alternative that looks tidier — a correlated subquery per calendar cell — is a
 * table scan per cell on the one screen a lead builds next week from.
 *
 * ONE ROW PER PERSON PER DAY. An override REPLACES the pattern row rather than
 * sitting beside it: two contradictory lines for one person on one day is
 * exactly the thing a lead cannot act on.
 */
export function listEffectiveAvailability(
  from: string,
  to: string
): EffectiveAvailabilityWithPerson[] {
  const db = getDb()
  const overrides = listAvailability(from, to)
  const patterns = (
    db
      .prepare(
        `SELECT p.id, p.employee_id, p.weekday, p.status, p.start_time, p.end_time, p.note,
                p.updated_at, e.first_name AS first, e.last_name AS last
           FROM availability_pattern p
           LEFT JOIN employees e ON e.id = p.employee_id`
      )
      .all() as Array<PatternRow & { first: string | null; last: string | null }>
  ).map((r) => ({
    pattern: toPattern(r),
    name: `${r.first ?? ''} ${r.last ?? ''}`.trim() || 'Someone'
  }))

  const overrideByKey = new Set(overrides.map((a) => `${a.employeeId}|${a.day}`))
  const out: EffectiveAvailabilityWithPerson[] = []

  // Every override in range lands, whatever the pattern says — it is the
  // stronger claim by construction.
  for (const a of overrides) {
    out.push({
      employeeId: a.employeeId,
      employeeName: a.employeeName,
      day: a.day,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
      note: a.note,
      source: 'day'
    })
  }

  let guard = 0
  for (let day = from; day <= to && guard < 400; day = addDays(day, 1), guard++) {
    const weekday = weekdayOf(day)
    for (const { pattern, name } of patterns) {
      if (pattern.weekday !== weekday) continue
      if (overrideByKey.has(`${pattern.employeeId}|${day}`)) continue
      out.push({
        employeeId: pattern.employeeId,
        employeeName: name,
        day,
        status: pattern.status,
        startTime: pattern.startTime,
        endTime: pattern.endTime,
        note: pattern.note,
        source: 'pattern'
      })
    }
  }
  return out.sort(
    (a, b) => a.day.localeCompare(b.day) || a.employeeName.localeCompare(b.employeeName)
  )
}

// ---------------------------------------------------------------------------
// The lead's view of the whole team's week
// ---------------------------------------------------------------------------

/**
 * Everything a lead needs to look at a week, in ONE read.
 *
 * A lead looking at next Thursday is asking four questions at once — who can
 * work it, who is already on it, is anybody on it who said no, is anybody short
 * of hours — and a screen that answers them from four independently filtered
 * lists is a screen where those four answers can disagree with each other.
 *
 * Built from three queries and an in-memory merge. The obvious alternative — a
 * correlated subquery per person per calendar day — is a table scan per cell on
 * the one screen next week gets planned from.
 *
 * DISABLED PEOPLE ARE EXCLUDED from the roster but NOT from the shift and clash
 * counts: somebody who left last week may still be on Thursday's rota, and a
 * screen that quietly dropped them would show a night as covered when nobody is
 * coming.
 */
export function teamScheduleOverview(from: string, to: string): TeamScheduleOverview {
  const db = getDb()

  const roster = db
    .prepare(
      `SELECT id, first_name AS first, last_name AS last, role
         FROM employees WHERE status != 'disabled'
        ORDER BY first_name, last_name`
    )
    .all() as Array<{ id: string; first: string | null; last: string | null; role: string }>

  const patterns = myPatternsForAll()
  const shifts = listShifts(from, to)
  const answers = listEffectiveAvailability(from, to)

  const answerByKey = new Map(answers.map((a) => [`${a.employeeId}|${a.day}`, a]))

  const days: TeamScheduleDay[] = []
  const dayKeys: string[] = []
  let guard = 0
  for (let day = from; day <= to && guard < 120; day = addDays(day, 1), guard++) {
    dayKeys.push(day)
  }

  const clashesByPerson = new Map<string, string[]>()
  for (const s of shifts) {
    if (answerByKey.get(`${s.employeeId}|${s.day}`)?.status !== 'unavailable') continue
    const list = clashesByPerson.get(s.employeeId) ?? []
    list.push(s.day)
    clashesByPerson.set(s.employeeId, list)
  }

  const people: TeamSchedulePerson[] = roster.map((r) => {
    const mine = shifts.filter((s) => s.employeeId === r.id)
    let minutes = 0
    for (const s of mine) {
      const span = shiftMinutes(s)
      if (span !== null) minutes += span
    }
    const pattern = patterns.get(r.id) ?? []
    return {
      employeeId: r.id,
      employeeName: `${r.first ?? ''} ${r.last ?? ''}`.trim() || 'Someone',
      role: r.role,
      pattern,
      // The distinction the whole grid rests on: an empty row means "never
      // asked", not "unavailable", and without this flag nobody can tell.
      hasPattern: pattern.length > 0,
      shiftsInRange: mine.length,
      minutesInRange: minutes,
      clashDays: (clashesByPerson.get(r.id) ?? []).slice().sort()
    }
  })

  for (const day of dayKeys) {
    let free = 0
    let away = 0
    let rostered = 0
    let clashes = 0
    for (const r of roster) {
      const a = answerByKey.get(`${r.id}|${day}`)
      if (!a) continue
      if (a.status === 'available') free++
      else away++
    }
    for (const s of shifts) {
      if (s.day !== day) continue
      rostered++
      if (answerByKey.get(`${s.employeeId}|${s.day}`)?.status === 'unavailable') clashes++
    }
    days.push({
      day,
      free,
      away,
      // Everybody on the roster who said neither thing. Counted rather than
      // inferred from `roster.length - free - away` so a person who has left but
      // still has an answer on file cannot make it come out negative.
      unknown: roster.filter((r) => !answerByKey.has(`${r.id}|${day}`)).length,
      rostered,
      clashes
    })
  }

  return { from, to, people, days }
}

/** Everybody's usual week, keyed by employee. */
function myPatternsForAll(): Map<string, AvailabilityPattern[]> {
  const rows = getDb()
    .prepare(
      `SELECT ${PATTERN_COLS} FROM availability_pattern ORDER BY employee_id, weekday ASC`
    )
    .all() as PatternRow[]
  const map = new Map<string, AvailabilityPattern[]>()
  for (const r of rows) {
    const p = toPattern(r)
    const list = map.get(p.employeeId) ?? []
    list.push(p)
    map.set(p.employeeId, list)
  }
  return map
}
