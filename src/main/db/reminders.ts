import type { NewReminder, Reminder, ReminderStatus } from '@shared/ownerDashboard'
import { REMINDER_MAX_LENGTH, sortReminders, validateReminder } from '@shared/ownerDashboard'
import { getDb } from './database'
import { newId, nowIso } from '../util'

/**
 * The owner's inbox: what the floor needs him to know.
 *
 * Anybody signed in can write one. That is the point — a reminder somebody has
 * to go and ask permission to send is a reminder that does not get sent, and
 * the failure mode of this feature is silence, not spam.
 *
 * Only the owner's board reads them, and only the owner clears them.
 */

interface ReminderRow {
  id: string
  body: string
  from_id: string | null
  from_name: string | null
  status: string
  due_date: string | null
  urgent: number
  created_at: string
  done_at: string | null
  done_by: string | null
}

const SELECT = `
  SELECT r.id, r.body, r.from_id, r.status, r.due_date, r.urgent,
         r.created_at, r.done_at, r.done_by,
         NULLIF(TRIM(COALESCE(e.first_name, '') || ' ' || COALESCE(e.last_name, '')), '') AS from_name
    FROM reminders r
    LEFT JOIN employees e ON e.id = r.from_id
`

function toReminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    body: r.body,
    fromId: r.from_id,
    fromName: r.from_name,
    status: r.status === 'done' ? 'done' : 'open',
    dueDate: r.due_date,
    urgent: r.urgent === 1,
    createdAt: r.created_at,
    doneAt: r.done_at,
    doneBy: r.done_by
  }
}

/**
 * Everything open, plus recently-cleared for context.
 *
 * Done reminders do not vanish the instant they are ticked — somebody who
 * clears the wrong one needs to be able to see it and put it back. Two weeks is
 * long enough for that and short enough that the list stays a list.
 */
export function listReminders(limit = 100): Reminder[] {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const rows = getDb()
    .prepare(
      `${SELECT} WHERE r.status = 'open' OR r.done_at IS NULL OR r.done_at >= @cutoff
        ORDER BY r.created_at DESC LIMIT @limit`
    )
    .all({ cutoff, limit }) as ReminderRow[]
  return sortReminders(rows.map(toReminder))
}

export function countOpenReminders(): { open: number; urgent: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(urgent), 0) AS u
         FROM reminders WHERE status = 'open'`
    )
    .get() as { n: number; u: number }
  return { open: row?.n ?? 0, urgent: row?.u ?? 0 }
}

export interface ReminderResult {
  reminder: Reminder | null
  error?: string
}

export function createReminder(input: NewReminder, fromId: string | null): ReminderResult {
  const problem = validateReminder(input)
  if (problem) return { reminder: null, error: problem }
  const id = newId()
  getDb()
    .prepare(
      `INSERT INTO reminders (id, body, from_id, status, due_date, urgent, created_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`
    )
    .run(
      id,
      input.body.trim().slice(0, REMINDER_MAX_LENGTH),
      fromId,
      input.dueDate?.trim() || null,
      input.urgent ? 1 : 0,
      nowIso()
    )
  return { reminder: getReminder(id) }
}

export function getReminder(id: string): Reminder | null {
  const row = getDb().prepare(`${SELECT} WHERE r.id = ?`).get(id) as ReminderRow | undefined
  return row ? toReminder(row) : null
}

/** Tick one off, or put it back. Reversible on purpose — see listReminders. */
export function setReminderStatus(
  id: string,
  status: ReminderStatus,
  userId: string | null
): ReminderResult {
  const done = status === 'done'
  const res = getDb()
    .prepare(
      `UPDATE reminders SET status = ?, done_at = ?, done_by = ? WHERE id = ?`
    )
    .run(done ? 'done' : 'open', done ? nowIso() : null, done ? userId : null, id)
  if (res.changes === 0) return { reminder: null, error: 'That reminder is no longer there.' }
  return { reminder: getReminder(id) }
}

export function deleteReminder(id: string): boolean {
  return getDb().prepare(`DELETE FROM reminders WHERE id = ?`).run(id).changes > 0
}
