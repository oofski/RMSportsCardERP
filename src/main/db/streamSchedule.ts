import type { Result } from '@shared/types'
import type { NewScheduledStream, ScheduledStream, ScheduledStreamStatus } from '@shared/streamReminders'
import {
  SCHEDULED_NOTE_MAX,
  SCHEDULED_TITLE_MAX,
  impliedZoneOffsetMinutes,
  isValidDayKey,
  isValidLocalTime
} from '@shared/streamReminders'
import { getDb } from './database'
import { startSession } from './streaming'
import { newId, nowIso } from '../util'

/**
 * Planned shows — the half of streaming that has not happened yet.
 *
 * Deliberately a separate module from db/streaming.ts, mirroring the separate
 * table. Nothing in here touches stock, cost or the ledger, and nothing in here
 * may: a plan is an intention, and the moment it starts having financial
 * consequences somebody will have booked a case of Bowman to a night that never
 * ran. The one place the two meet is `startScheduled`, which hands the plan's
 * title and host to the ordinary Start-stream path and then steps out of the way.
 *
 * The wall-clock/instant split is the thing to understand before editing here;
 * it is written out in @shared/streamReminders and in the v63 migration.
 */

interface ScheduleRow {
  id: string
  title: string
  stream_date: string
  start_time: string
  starts_at: string
  host_id: string | null
  host_name: string | null
  note: string | null
  status: string
  session_id: string | null
  created_at: string
  updated_at: string
  created_by: string | null
}

const SELECT = `
  SELECT s.id, s.title, s.stream_date, s.start_time, s.starts_at, s.host_id,
         (e.first_name || ' ' || e.last_name) AS host_name,
         s.note, s.status, s.session_id, s.created_at, s.updated_at, s.created_by
  FROM stream_schedule s
  LEFT JOIN employees e ON e.id = s.host_id
`

function statusOf(raw: string): ScheduledStreamStatus {
  if (raw === 'started') return 'started'
  if (raw === 'cancelled') return 'cancelled'
  return 'planned'
}

function toPlan(row: ScheduleRow): ScheduledStream {
  return {
    id: row.id,
    title: row.title,
    streamDate: row.stream_date,
    startTime: row.start_time,
    startsAt: row.starts_at,
    hostId: row.host_id,
    // Null when the employee record is gone; the id is kept either way, so the
    // row still says a host was named and the relay can still try to reach them.
    hostName: row.host_name?.trim() || null,
    note: row.note,
    status: statusOf(row.status),
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

function getPlan(id: string): ScheduledStream | null {
  const row = getDb().prepare(`${SELECT} WHERE s.id = ?`).get(id) as ScheduleRow | undefined
  return row ? toPlan(row) : null
}

/**
 * What is still coming, soonest first.
 *
 * Ranged on `starts_at` rather than on `stream_date`, and this is the one query
 * in the streaming feature where that is right: the question is "what have we
 * not run yet", which is a question about the instant, not about which business
 * day something is filed under.
 *
 * Cancelled plans are excluded. They are kept in the table so "did we call
 * Friday off" stays answerable, and they are not what a screen headed "upcoming"
 * is asking for.
 */
export function listUpcoming(limit = 12): ScheduledStream[] {
  const rows = getDb()
    .prepare(
      `${SELECT}
       WHERE s.status = 'planned' AND s.starts_at >= ?
       ORDER BY s.starts_at ASC
       LIMIT ?`
    )
    // A little slack behind now, so a show that was due five minutes ago and
    // has not been started yet is still on the screen of the person who is
    // supposed to be starting it. Dropping it at the stroke of nine would hide
    // the row exactly when it matters most.
    .all(new Date(Date.now() - 60 * 60_000).toISOString(), Math.max(1, Math.min(100, limit))) as ScheduleRow[]
  return rows.map(toPlan)
}

/** Plans whose local day falls in [from, to] — the calendar's question. */
export function listScheduledBetween(from: string, to: string): ScheduledStream[] {
  const rows = getDb()
    .prepare(
      `${SELECT}
       WHERE s.stream_date >= ? AND s.stream_date <= ? AND s.status <> 'cancelled'
       ORDER BY s.starts_at ASC`
    )
    .all(from, to) as ScheduleRow[]
  return rows.map(toPlan)
}

/**
 * Everything a plan has to satisfy before it is worth reminding anybody about.
 *
 * The zone check is the interesting one and it is doing less than it looks like.
 * Main cannot recompute the instant — in the web build it runs on a server that
 * may be in another zone than the browser that typed "9:00 PM" — so it checks
 * that the instant it was handed is A PLAUSIBLE CONVERSION of the wall clock
 * beside it: some real UTC offset apart, to the minute. That does not prove the
 * conversion was right. What it catches is the instant that is not a conversion
 * of this pair AT ALL — a stale value left in a form, a date edited without its
 * instant, a client sending the wrong field — each of which would otherwise
 * schedule a reminder for a moment with no relationship to the show.
 */
function validate(input: NewScheduledStream): string | null {
  if (!isValidDayKey(input.streamDate)) return 'Pick the day the show is on.'
  if (!isValidLocalTime(input.startTime)) return 'Enter a start time as HH:MM.'
  const instant = Date.parse(input.startsAt)
  if (Number.isNaN(instant)) return 'That start time could not be read.'
  if (impliedZoneOffsetMinutes(input.streamDate, input.startTime, input.startsAt) === null) {
    return 'The date and the time on this plan do not agree. Re-enter them.'
  }
  return null
}

/**
 * Put a show in the diary.
 *
 * A start in the PAST is refused. Not out of tidiness: the only thing this table
 * is for is reminding people before a show, and a plan that can never be
 * reminded about is a row that looks like a feature working and is not. A show
 * that already happened is typed into stream_sessions, which is what that table
 * is for.
 */
export function scheduleStream(input: NewScheduledStream, actorId: string | null): Result<ScheduledStream> {
  const bad = validate(input)
  if (bad) return { ok: false, error: bad }
  if (Date.parse(input.startsAt) <= Date.now()) {
    return { ok: false, error: 'That start time has already passed. Pick a time in the future.' }
  }

  const id = newId()
  const ts = nowIso()
  getDb()
    .prepare(
      `INSERT INTO stream_schedule
         (id, title, stream_date, start_time, starts_at, host_id, note, status, session_id,
          created_at, updated_at, created_by)
       VALUES (@id, @title, @stream_date, @start_time, @starts_at, @host_id, @note, 'planned', NULL,
               @ts, @ts, @created_by)`
    )
    .run({
      id,
      title: (input.title ?? '').trim().slice(0, SCHEDULED_TITLE_MAX),
      stream_date: input.streamDate,
      start_time: input.startTime,
      starts_at: input.startsAt,
      host_id: input.hostId || null,
      note: input.note?.trim().slice(0, SCHEDULED_NOTE_MAX) || null,
      ts,
      created_by: actorId
    })
  return { ok: true, data: getPlan(id) as ScheduledStream }
}

/**
 * Move or re-title a planned show.
 *
 * Moving the time re-arms both reminders, because the relay keys what it has
 * already sent on the START INSTANT as well as the plan — see `reminderKey`. A
 * show moved from 9pm to 11pm gets told about again, which is the point; a show
 * whose title was corrected does not, because its instant did not change.
 */
export function rescheduleStream(
  input: { id: string } & Partial<NewScheduledStream>,
  actorId: string | null
): Result<ScheduledStream> {
  void actorId
  const existing = getPlan(String(input?.id ?? '').trim())
  if (!existing) return { ok: false, error: 'That scheduled stream no longer exists.' }
  if (existing.status === 'started') {
    return { ok: false, error: 'That show has already started — edit the session instead.' }
  }

  const next: NewScheduledStream = {
    title: input.title !== undefined ? input.title : existing.title,
    streamDate: input.streamDate !== undefined ? input.streamDate : existing.streamDate,
    startTime: input.startTime !== undefined ? input.startTime : existing.startTime,
    startsAt: input.startsAt !== undefined ? input.startsAt : existing.startsAt,
    hostId: input.hostId !== undefined ? input.hostId : existing.hostId,
    note: input.note !== undefined ? input.note : existing.note
  }
  const bad = validate(next)
  if (bad) return { ok: false, error: bad }

  getDb()
    .prepare(
      `UPDATE stream_schedule
          SET title = @title, stream_date = @stream_date, start_time = @start_time,
              starts_at = @starts_at, host_id = @host_id, note = @note, updated_at = @ts
        WHERE id = @id`
    )
    .run({
      id: existing.id,
      title: (next.title ?? '').trim().slice(0, SCHEDULED_TITLE_MAX),
      stream_date: next.streamDate,
      start_time: next.startTime,
      starts_at: next.startsAt,
      host_id: next.hostId || null,
      note: next.note?.trim().slice(0, SCHEDULED_NOTE_MAX) || null,
      ts: nowIso()
    })
  return { ok: true, data: getPlan(existing.id) as ScheduledStream }
}

/**
 * Call it off.
 *
 * A status change rather than a delete, so the row survives to answer "did we
 * cancel Friday" — and so the relay learns about it the same way it learns
 * everything else. Deleting works too and stops the reminders just as well (the
 * tombstone travels), but it answers no questions afterwards.
 *
 * THE HONEST LIMIT, worth knowing before somebody is surprised by it: the relay
 * only sees this once the laptop that did it has synced. Cancel a show on a
 * machine that is offline and the reminder still goes out at ten to nine. There
 * is no fix for that which does not involve the phone asking the laptop, which
 * is the arrangement this whole feature exists to avoid.
 */
export function cancelScheduled(id: string, actorId: string | null): Result<ScheduledStream> {
  void actorId
  const existing = getPlan(String(id ?? '').trim())
  if (!existing) return { ok: false, error: 'That scheduled stream no longer exists.' }
  if (existing.status === 'started') {
    return { ok: false, error: 'That show has already started — end the session instead.' }
  }
  getDb()
    .prepare("UPDATE stream_schedule SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(nowIso(), existing.id)
  return { ok: true, data: getPlan(existing.id) as ScheduledStream }
}

/** Remove a plan outright. For the one somebody typed by mistake. */
export function deleteScheduled(id: string, actorId: string | null): Result {
  void actorId
  const info = getDb().prepare('DELETE FROM stream_schedule WHERE id = ?').run(String(id ?? '').trim())
  if (info.changes === 0) return { ok: false, error: 'That scheduled stream no longer exists.' }
  return { ok: true }
}

/**
 * Go live on a planned show.
 *
 * The plan does not BECOME the session. It hands over its title and its host to
 * the ordinary `startSession` path — the same one the Start stream button uses,
 * with the same "a stream is already live" and overlap refusals — and then
 * records which session it turned into.
 *
 * Written this way so there is exactly one way a show goes on air. A second
 * insert path here would be a second place for the overlap rule to be forgotten,
 * and an overlap is the one thing in this module that no later report can
 * untangle.
 *
 * The session's start is NOW, not the planned time, and that is deliberate: the
 * plan said nine o'clock and the show went live at 9:07, and the record of the
 * night has to be what happened. The plan keeps its own 9:00 PM; the two are
 * different kinds of fact and this is the seam between them.
 */
export function startScheduled(id: string, actorId: string | null): Result<{ sessionId: string }> {
  const db = getDb()
  const existing = getPlan(String(id ?? '').trim())
  if (!existing) return { ok: false, error: 'That scheduled stream no longer exists.' }
  if (existing.status === 'started') return { ok: false, error: 'That show has already been started.' }
  if (existing.status === 'cancelled') return { ok: false, error: 'That show was cancelled.' }

  // One transaction over both writes. A session that went on air while its plan
  // still reads 'planned' is a show that would keep reminding people to start
  // the show they are already running — the exact failure this feature is one
  // bug away from at all times.
  const run = db.transaction((): Result<{ sessionId: string }> => {
    const started = startSession(
      { title: existing.title, hostId: existing.hostId, note: existing.note },
      actorId
    )
    // Refusals from startSession are the useful ones — "a stream is already
    // live", "that overlaps ..." — so they travel out untouched rather than
    // being rewritten into something about the schedule.
    if (!started.ok || !started.data) return { ok: false, error: started.error }

    db.prepare(
      "UPDATE stream_schedule SET status = 'started', session_id = ?, updated_at = ? WHERE id = ?"
    ).run(started.data.id, nowIso(), existing.id)
    return { ok: true, data: { sessionId: started.data.id } }
  })
  try {
    return run()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
