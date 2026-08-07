import { randomUUID } from 'crypto'
import {
  dayKey,
  daysBetween,
  recentPayrollPeriods,
  recurringDue,
  validateRecurring,
  type DerivedTask,
  type RecurringDue,
  type RecurringTask
} from '@shared/homeTasks'
import { getDb } from './database'

/**
 * The jobs the app works out for itself.
 *
 * Everything derived here is READ-ONLY over data another module owns, so this
 * file cannot be the reason a number is wrong — it can only be the reason
 * somebody is told about one.
 */

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * How long a show stays on the "slips are missing" list.
 *
 * Three weeks. Long enough that a night nobody got to on the Monday is still
 * being asked about the following week, short enough that a show from March is
 * not still shouting — by then it is history, not a task, and a list that never
 * empties is a list nobody reads.
 */
const SLIP_LOOKBACK_DAYS = 21

/**
 * How long after a show a slip may arrive and still count as that show's.
 *
 * Nights end late and the packing slips get uploaded the next morning, so an
 * import dated the day AFTER the stream is the normal case rather than the
 * exception. Two days is the honest window: it covers "we did it the next
 * morning" and "we did it on the Monday after a Saturday night" without
 * swallowing an entirely separate show.
 *
 * The app has no column tying an import to a show date — the shipping calendar
 * keys an import by the day it was created (see localDateKey in
 * shippingCalendar.ts) — so this window IS the join, and it is a judgement
 * rather than a fact. That is worth saying out loud where somebody can change it.
 */
const SLIP_GRACE_DAYS = 2

/**
 * Streams that were recorded with no packing slip against them.
 *
 * The signal the owner asked for: "if streams are recorded and the slips are not
 * there, that is something that can be changed". A stream session is proof the
 * night happened; an import is proof the paper came in. A day with the first and
 * not the second is a job.
 */
export function slipsOutstanding(): DerivedTask[] {
  const db = getDb()
  const today = dayKey(new Date())
  const from = new Date()
  from.setDate(from.getDate() - SLIP_LOOKBACK_DAYS)
  const fromKey = dayKey(from)

  // Oldest first, and the order is load-bearing: an import is consumed by the
  // first show it can belong to, so one upload cannot clear three nights.
  const streamDays = db
    .prepare(
      `SELECT stream_date AS day, COUNT(*) AS sessions, MIN(title) AS title,
              MAX(COALESCE(ended_at, started_at)) AS finished
         FROM stream_sessions
        WHERE stream_date >= ? AND stream_date <= ?
        GROUP BY stream_date
        ORDER BY stream_date ASC`
    )
    .all(fromKey, today) as Array<{
    day: string
    sessions: number
    title: string | null
    finished: string
  }>
  if (streamDays.length === 0) return []

  /**
   * The slip uploads, as INSTANTS, oldest first.
   *
   * Instants and not calendar days, and only `pdf` imports. Both were wrong
   * before, and both were wrong in the direction that hides the problem:
   *
   *   · A day-level match let an import created at 8am on the 2nd clear a show
   *     that started at 9pm ON THE 2ND — a file that physically predates the
   *     night it was supposed to cover. Since uploading the previous night's
   *     slips in the morning is the normal routine, every Sunday upload of
   *     Saturday's slips silently cleared Sunday night too.
   *   · `kind` was not filtered, so loading the demo dataset cleared real work.
   */
  const uploads = (
    db
      .prepare(
        `SELECT created_at FROM ship_imports
          WHERE created_at IS NOT NULL AND kind = 'pdf'
          ORDER BY created_at ASC`
      )
      .all() as Array<{ created_at: string }>
  )
    .map((r) => Date.parse(r.created_at))
    .filter((t) => Number.isFinite(t))

  const used = new Set<number>()
  const graceMs = SLIP_GRACE_DAYS * 24 * 60 * 60 * 1000

  const out: DerivedTask[] = []
  for (const s of streamDays) {
    const finished = Date.parse(s.finished)
    const after = Number.isFinite(finished) ? finished : Date.parse(`${s.day}T00:00:00`)
    // The first unused upload that happened AFTER this show and within the
    // grace window. Claiming it stops a later night reusing the same file.
    let matched = -1
    for (let i = 0; i < uploads.length; i++) {
      if (used.has(i)) continue
      if (uploads[i] < after) continue
      if (uploads[i] - after > graceMs) break
      matched = i
      break
    }
    if (matched >= 0) {
      used.add(matched)
      continue
    }
    const ageDays = daysBetween(s.day, today)
    // Today's own show is not late yet — the night may not have finished.
    if (ageDays < 1) continue
    out.push({
      id: `slips:${s.day}`,
      kind: 'slips',
      title: `Upload the packing slips for ${s.day}`,
      detail:
        (s.sessions === 1
          ? `${s.title || 'A show'} ran that day with no slip imported`
          : `${s.sessions} shows ran that day with no slip imported`) +
        ' — import it in Admin › Shipping setup',
      day: s.day,
      ageDays
    })
  }
  // Newest first on screen: the most recent night is the one being chased.
  return out.reverse()
}

// ---------------------------------------------------------------------------
// Recurring jobs
// ---------------------------------------------------------------------------

interface Row {
  id: string
  title: string
  every_days: number
  anchor_date: string
  lead_days: number
  last_done_on: string | null
  active: number
}

function toTask(r: Row): RecurringTask {
  return {
    id: r.id,
    title: r.title,
    everyDays: r.every_days,
    anchorDate: r.anchor_date,
    leadDays: r.lead_days,
    lastDoneOn: r.last_done_on,
    active: r.active === 1
  }
}

export function listRecurring(ownerId: string): RecurringTask[] {
  return (
    getDb()
      .prepare(
        `SELECT id, title, every_days, anchor_date, lead_days, last_done_on, active
           FROM recurring_tasks WHERE owner_id = ? ORDER BY created_at ASC`
      )
      .all(ownerId) as Row[]
  ).map(toTask)
}

/** The ones asking for something today, soonest first. */
export function recurringDueNow(ownerId: string, today = dayKey(new Date())): RecurringDue[] {
  return listRecurring(ownerId)
    .map((t) => recurringDue(t, today))
    .filter((d): d is RecurringDue => d !== null)
    .sort((a, b) => b.daysLate - a.daysLate || a.title.localeCompare(b.title))
}

export function createRecurring(
  ownerId: string,
  input: { title: string; everyDays: number; anchorDate: string; leadDays?: number }
): RecurringTask {
  const problem = validateRecurring(input)
  if (problem) throw new Error(problem)
  const stamp = nowIso()
  const task: RecurringTask = {
    id: randomUUID(),
    title: input.title.trim(),
    everyDays: Math.trunc(input.everyDays),
    anchorDate: input.anchorDate,
    leadDays: Math.max(0, Math.trunc(input.leadDays ?? 2)),
    lastDoneOn: null,
    active: true
  }
  getDb()
    .prepare(
      `INSERT INTO recurring_tasks
         (id, owner_id, title, every_days, anchor_date, lead_days, last_done_on, active,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`
    )
    .run(
      task.id,
      ownerId,
      task.title,
      task.everyDays,
      task.anchorDate,
      task.leadDays,
      stamp,
      stamp
    )
  return task
}

/**
 * Tick off ONE occurrence.
 *
 * The date matters and is not "today": somebody ticking Wednesday's payroll on
 * Friday has done Wednesday's, and recording Friday would push the whole series
 * two days out of step for ever. The caller passes the occurrence the screen
 * showed them.
 */
export function completeRecurring(ownerId: string, id: string, occurrence: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrence)) throw new Error('That is not a date.')
  return (
    getDb()
      .prepare(
        `UPDATE recurring_tasks SET last_done_on = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND (last_done_on IS NULL OR last_done_on < ?)`
      )
      .run(occurrence, nowIso(), id, ownerId, occurrence).changes > 0
  )
}

export function deleteRecurring(ownerId: string, id: string): boolean {
  return (
    getDb().prepare(`DELETE FROM recurring_tasks WHERE id = ? AND owner_id = ?`).run(id, ownerId)
      .changes > 0
  )
}

// ---------------------------------------------------------------------------
// One person's own hours
// ---------------------------------------------------------------------------

/**
 * Every shift somebody has worked, and what each payroll period came to.
 *
 * Scoped to ONE employee and never taking whose from an argument the caller
 * chose — the same rule as the to-do list. This is the screen a packer opens to
 * check their own pay, so it must be impossible for it to be somebody else's.
 *
 * The DAY of a shift is the day it STARTED, in local time. A shift that runs
 * past midnight belongs to the night it began — that is how the floor talks
 * about it, and how the payroll period it falls in has to count it.
 */
export function myHours(
  employeeId: string,
  periods = 8
): {
  days: Array<{ day: string; minutes: number; shifts: number }>
  periods: Array<{ start: string; end: string; paidOn: string; current: boolean; minutes: number }>
  totalMinutes: number
  firstDay: string | null
} {
  const rows = getDb()
    .prepare(
      `SELECT clock_in, clock_out FROM time_entries
        WHERE employee_id = ? ORDER BY clock_in ASC`
    )
    .all(employeeId) as Array<{ clock_in: string; clock_out: string | null }>

  const byDay = new Map<string, { minutes: number; shifts: number }>()
  let total = 0
  let firstDay: string | null = null
  for (const r of rows) {
    const started = new Date(r.clock_in)
    if (Number.isNaN(started.getTime())) continue
    const day = dayKey(started)
    if (firstDay === null || day < firstDay) firstDay = day
    // An open shift counts what it has run so far, or somebody who clocked in
    // an hour ago reads as having done nothing today.
    const endedAt = r.clock_out ? new Date(r.clock_out).getTime() : Date.now()
    const mins = Math.max(0, Math.round((endedAt - started.getTime()) / 60000))
    const entry = byDay.get(day) ?? { minutes: 0, shifts: 0 }
    entry.minutes += mins
    entry.shifts += 1
    total += mins
    byDay.set(day, entry)
  }

  const days = [...byDay.entries()]
    .map(([day, v]) => ({ day, minutes: v.minutes, shifts: v.shifts }))
    .sort((a, b) => a.day.localeCompare(b.day))

  const windows = recentPayrollPeriods(dayKey(new Date()), periods).map((p) => {
    let minutes = 0
    for (const d of days) {
      if (d.day >= p.start && d.day <= p.end) minutes += d.minutes
    }
    return { start: p.start, end: p.end, paidOn: p.paidOn, current: p.current, minutes }
  })

  return { days, periods: windows, totalMinutes: total, firstDay }
}
