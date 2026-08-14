import { randomUUID } from 'crypto'
import {
  isThreadKind,
  validateMessage,
  validateThread,
  type Contact,
  type Message,
  type NewThreadInput,
  type ThreadDetail,
  type ThreadKind,
  type ThreadParticipant,
  type ThreadSummary
} from '@shared/messages'
import { getDb } from './database'
import { isPlaceholderEmail } from './employees'

/**
 * Conversations, and who is in them.
 *
 * ## The message is the record
 *
 * A push notification is a doorbell: unreliable by design, a few kilobytes wide,
 * and not a record. Everything said here is an ordinary synced row, so a phone
 * that was off, a dropped subscription or a swiped-away banner costs the buzz
 * and never the conversation. See the v69 note in database.ts.
 *
 * ## Reads are scoped to the reader, always
 *
 * Every function that returns messages takes the reader's employee id and joins
 * through `message_participants`. There is no "list all threads" and no "read
 * thread by id" that skips the membership check — a conversation somebody was
 * not put in is one they cannot see, and that has to be true at the layer that
 * fetches rather than at the screen that renders.
 *
 * ## Nothing here sends anything
 *
 * The push is the caller's job (messagesIpc → services/webPush). This file
 * returns WHO should be told, and stops. That keeps the record correct even when
 * the network is not, and it keeps a database module free of a dependency on the
 * relay being reachable.
 */

function nowIso(): string {
  return new Date().toISOString()
}

function fullName(first: string, last: string, fallback: string): string {
  const name = `${first ?? ''} ${last ?? ''}`.trim()
  return name || fallback
}

// ---------------------------------------------------------------------------
// The contact list
// ---------------------------------------------------------------------------

interface ContactRow {
  id: string
  first_name: string
  last_name: string
  company_id: string
  email: string
  role: string
  title: string
  status: string
  avatar: string | null
}

/**
 * Everybody who works here.
 *
 * DISABLED ACCOUNTS ARE LEFT OUT. Somebody who no longer works here should not
 * appear in a picker that starts a conversation — and if they are already in an
 * old thread, that thread still shows them, because the record of who was told
 * something must not change when somebody leaves.
 *
 * `account_kind = 'station'` is excluded too: a shared packing computer is not a
 * person and has no phone to notify. Its rows are history (see the note in
 * employees.ts) and this is a list of people.
 */
export function listContacts(readerId: string | null): Contact[] {
  const rows = getDb()
    .prepare(
      `SELECT id, first_name, last_name, company_id, email, role, title, status, avatar
         FROM employees
        WHERE status <> 'disabled' AND COALESCE(account_kind, 'person') <> 'station'
        ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE`
    )
    .all() as ContactRow[]
  return rows.map((r) => ({
    id: r.id,
    name: fullName(r.first_name, r.last_name, r.company_id),
    companyId: r.company_id,
    // The placeholder address employees.ts mints for an account with no email is
    // not an address anybody can write to, and showing it invites somebody to
    // try. Asked of the module that MINTS it rather than pattern-matched here —
    // a second copy of that rule is a second thing to update.
    email: r.email && !isPlaceholderEmail(r.email) ? r.email : null,
    role: r.role,
    title: r.title,
    status: r.status,
    avatarUrl: null,
    me: !!readerId && r.id === readerId
  }))
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string
  title: string
  kind: string
  created_by: string | null
  created_at: string
  last_message_at: string | null
  last_message_by: string | null
  last_message: string | null
}

function asKind(v: unknown): ThreadKind {
  return isThreadKind(v) ? v : 'group'
}

/** Everybody in these threads, in one read rather than one per thread. */
function participantsFor(threadIds: string[]): Map<string, ThreadParticipant[]> {
  const out = new Map<string, ThreadParticipant[]>()
  if (threadIds.length === 0) return out
  const placeholders = threadIds.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT p.thread_id, p.employee_id, p.last_read_at,
              e.first_name, e.last_name, e.company_id, e.role
         FROM message_participants p
         LEFT JOIN employees e ON e.id = p.employee_id
        WHERE p.thread_id IN (${placeholders})
        ORDER BY e.first_name COLLATE NOCASE`
    )
    .all(...threadIds) as Array<{
    thread_id: string
    employee_id: string
    last_read_at: string | null
    first_name: string | null
    last_name: string | null
    company_id: string | null
    role: string | null
  }>
  for (const r of rows) {
    const list = out.get(r.thread_id) ?? []
    list.push({
      employeeId: r.employee_id,
      // A participant whose account has been deleted still shows, because the
      // record of who was told something is not allowed to change afterwards.
      name: fullName(r.first_name ?? '', r.last_name ?? '', r.company_id ?? 'Former colleague'),
      companyId: r.company_id ?? '',
      role: r.role ?? '',
      avatarUrl: null,
      lastReadAt: r.last_read_at
    })
    out.set(r.thread_id, list)
  }
  return out
}

/**
 * The conversations this person is in, most recently active first.
 *
 * The unread count is messages created after their `last_read_at` and NOT
 * written by them. Their own message would otherwise arrive as an unread of
 * their own the moment they sent it.
 */
export function listThreads(readerId: string): ThreadSummary[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.kind, t.created_by, t.created_at,
              t.last_message_at, t.last_message_by, t.last_message
         FROM message_threads t
         JOIN message_participants p ON p.thread_id = t.id AND p.employee_id = ?
        ORDER BY COALESCE(t.last_message_at, t.created_at) DESC`
    )
    .all(readerId) as ThreadRow[]
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const people = participantsFor(ids)
  const placeholders = ids.map(() => '?').join(',')
  const unread = new Map<string, number>()
  for (const r of db
    .prepare(
      `SELECT m.thread_id, COUNT(*) AS n
         FROM messages m
         JOIN message_participants p
           ON p.thread_id = m.thread_id AND p.employee_id = @reader
        WHERE m.thread_id IN (${placeholders})
          AND m.author_id IS NOT @reader
          AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)
        GROUP BY m.thread_id`
    )
    .all(...ids, { reader: readerId }) as Array<{ thread_id: string; n: number }>) {
    unread.set(r.thread_id, r.n)
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: asKind(r.kind),
    participants: people.get(r.id) ?? [],
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at,
    lastMessageBy: r.last_message_by,
    unread: unread.get(r.id) ?? 0,
    createdAt: r.created_at
  }))
}

/** Is this person in this conversation? The membership check every read makes. */
export function isParticipant(threadId: string, employeeId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM message_participants WHERE thread_id = ? AND employee_id = ?')
    .get(threadId, employeeId) as { x: number } | undefined
  return !!row
}

/**
 * One conversation, with its messages.
 *
 * Returns null when the reader is not in it — the same answer as "no such
 * thread", deliberately. Distinguishing the two would tell somebody that a
 * conversation they are not part of exists, which is a small leak and an
 * entirely avoidable one.
 */
export function getThread(threadId: string, readerId: string, limit = 500): ThreadDetail | null {
  const db = getDb()
  if (!isParticipant(threadId, readerId)) return null
  const row = db
    .prepare(
      `SELECT id, title, kind, created_by, created_at, last_message_at, last_message_by, last_message
         FROM message_threads WHERE id = ?`
    )
    .get(threadId) as ThreadRow | undefined
  if (!row) return null

  const messages = (
    db
      .prepare(
        `SELECT m.id, m.thread_id, m.author_id, m.body, m.created_at,
                e.first_name, e.last_name, e.company_id
           FROM messages m
           LEFT JOIN employees e ON e.id = m.author_id
          WHERE m.thread_id = ?
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ?`
      )
      .all(threadId, Math.max(1, Math.min(2000, limit))) as Array<{
      id: string
      thread_id: string
      author_id: string | null
      body: string
      created_at: string
      first_name: string | null
      last_name: string | null
      company_id: string | null
    }>
  )
    // Newest-first in SQL so LIMIT keeps the RECENT end of a long thread, then
    // reversed for display. Ordering ascending and limiting would hand back the
    // oldest 500 messages of a conversation and none of today's.
    .reverse()
    .map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      authorId: m.author_id,
      authorName: fullName(m.first_name ?? '', m.last_name ?? '', m.company_id ?? 'Former colleague'),
      body: m.body,
      createdAt: m.created_at,
      mine: m.author_id === readerId
    }))

  const people = participantsFor([threadId]).get(threadId) ?? []
  return {
    id: row.id,
    title: row.title,
    kind: asKind(row.kind),
    participants: people,
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
    lastMessageBy: row.last_message_by,
    unread: 0,
    createdAt: row.created_at,
    messages
  }
}

/** Add somebody to a thread. Idempotent — the unique pair is the guard. */
function addParticipant(threadId: string, employeeId: string, addedBy: string | null): void {
  const stamp = nowIso()
  getDb()
    .prepare(
      `INSERT INTO message_participants
         (id, thread_id, employee_id, added_at, added_by, last_read_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (thread_id, employee_id) DO NOTHING`
    )
    .run(randomUUID(), threadId, employeeId, stamp, addedBy, stamp)
}

/**
 * Start a conversation.
 *
 * THE AUTHOR IS ALWAYS IN IT. A thread somebody started and cannot see is a
 * message they cannot follow up, and the commonest way to produce one is to
 * forget to add yourself.
 *
 * A two-person thread is a 'direct' one automatically. Nothing about it differs
 * except the name it is shown under, which is computed per reader — see
 * `threadTitle`.
 */
export function createThread(input: NewThreadInput, actorId: string): ThreadSummary {
  const problem = validateThread(input)
  if (problem) throw new Error(problem)

  const db = getDb()
  const id = randomUUID()
  const stamp = nowIso()
  const people = new Set(input.participantIds.filter((p) => !!p?.trim()))
  people.add(actorId)
  const kind: ThreadKind = input.kind && isThreadKind(input.kind)
    ? input.kind
    : people.size <= 2
      ? 'direct'
      : 'group'

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO message_threads
         (id, title, kind, created_by, created_at, updated_at, last_message_at, last_message_by, last_message)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
    ).run(id, (input.title ?? '').trim(), kind, actorId, stamp, stamp)
    for (const employeeId of people) addParticipant(id, employeeId, actorId)
    // The starter has read their own new thread by definition; without this it
    // arrives on their own screen with an unread badge on it.
    markRead(id, actorId)
  })
  run()

  const started = listThreads(actorId).find((t) => t.id === id)
  if (!started) throw new Error('That conversation could not be started.')
  return started
}

/**
 * Everybody, in one thread — the whole-team notification.
 *
 * A NEW THREAD EACH TIME, deliberately. Reusing one "Everyone" thread would mean
 * an announcement about Saturday's show sits under one about a broken printer,
 * with replies to both interleaved. Each broadcast is its own conversation, and
 * people can answer it without answering the last one.
 *
 * Membership is taken at the moment of sending: whoever works here now. Somebody
 * hired next week does not retroactively receive last week's announcement, and
 * somebody who leaves keeps their copy of what they were told.
 */
export function createBroadcast(title: string, body: string, actorId: string): ThreadSummary {
  const everyone = listContacts(actorId).map((c) => c.id)
  return createThread(
    { title: title.trim() || 'Everyone', kind: 'broadcast', participantIds: everyone, body },
    actorId
  )
}

// ---------------------------------------------------------------------------
// Saying something
// ---------------------------------------------------------------------------

/**
 * Post a message, and report who should be told about it.
 *
 * Returns the message and the OTHER participants' ids. Sending the notification
 * is the caller's job — a database write must not depend on a relay being
 * reachable, and a message that landed is worth having even when the buzz fails.
 *
 * The author is excluded from the notify list. They are holding the device that
 * just sent it, and a buzz two seconds later reads as a duplicate — the same
 * reasoning the clock notifications use for the person who punched.
 */
export function postMessage(
  threadId: string,
  body: string,
  actorId: string
): { message: Message; notify: string[] } {
  const problem = validateMessage(body)
  if (problem) throw new Error(problem)
  const db = getDb()
  if (!isParticipant(threadId, actorId)) {
    throw new Error('You are not in that conversation.')
  }

  const text = body.trim()
  const id = randomUUID()
  const stamp = nowIso()

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO messages (id, thread_id, author_id, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, threadId, actorId, text, stamp, stamp)
    // The thread's preview and its place in the list, written in the same
    // transaction so a list read can never show a thread without the message
    // that moved it to the top.
    db.prepare(
      `UPDATE message_threads
          SET last_message_at = ?, last_message_by = ?, last_message = ?, updated_at = ?
        WHERE id = ?`
    ).run(stamp, actorId, text.slice(0, 280), stamp, threadId)
    // Writing is reading: the author has seen their own message.
    markRead(threadId, actorId, stamp)
  })
  run()

  const notify = (
    db
      .prepare(
        'SELECT employee_id FROM message_participants WHERE thread_id = ? AND employee_id <> ?'
      )
      .all(threadId, actorId) as Array<{ employee_id: string }>
  ).map((r) => r.employee_id)

  const author = db
    .prepare('SELECT first_name, last_name, company_id FROM employees WHERE id = ?')
    .get(actorId) as { first_name: string; last_name: string; company_id: string } | undefined

  return {
    message: {
      id,
      threadId,
      authorId: actorId,
      authorName: fullName(author?.first_name ?? '', author?.last_name ?? '', author?.company_id ?? 'Someone'),
      body: text,
      createdAt: stamp,
      mine: true
    },
    notify
  }
}

/** Mark this reader caught up. Idempotent, and never moves the mark backwards. */
export function markRead(threadId: string, employeeId: string, at: string = nowIso()): void {
  getDb()
    .prepare(
      `UPDATE message_participants
          SET last_read_at = CASE
                WHEN last_read_at IS NULL OR last_read_at < @at THEN @at
                ELSE last_read_at
              END,
              updated_at = @at
        WHERE thread_id = @thread AND employee_id = @employee`
    )
    .run({ at, thread: threadId, employee: employeeId })
}

/** How many messages this person has not read, across every conversation. */
export function unreadCount(readerId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM messages m
         JOIN message_participants p
           ON p.thread_id = m.thread_id AND p.employee_id = @reader
        WHERE m.author_id IS NOT @reader
          AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)`
    )
    .get({ reader: readerId }) as { n: number }
  return row.n
}

/**
 * Add people to a conversation that already exists.
 *
 * They see the whole history, which is the point: somebody pulled into a thread
 * about a customer needs what was already said about that customer. A thread
 * where new members start blind is one people restate everything in.
 */
export function addToThread(threadId: string, employeeIds: string[], actorId: string): ThreadSummary {
  if (!isParticipant(threadId, actorId)) throw new Error('You are not in that conversation.')
  const db = getDb()
  const run = db.transaction(() => {
    for (const id of employeeIds.filter((i) => !!i?.trim())) addParticipant(threadId, id, actorId)
    db.prepare('UPDATE message_threads SET updated_at = ? WHERE id = ?').run(nowIso(), threadId)
  })
  run()
  const updated = listThreads(actorId).find((t) => t.id === threadId)
  if (!updated) throw new Error('That conversation is gone.')
  return updated
}

/**
 * Leave a conversation.
 *
 * The thread and its messages stay. What somebody said is not unsaid by them
 * walking away from the thread, and the people still in it were told it.
 */
export function leaveThread(threadId: string, employeeId: string): boolean {
  return (
    getDb()
      .prepare('DELETE FROM message_participants WHERE thread_id = ? AND employee_id = ?')
      .run(threadId, employeeId).changes > 0
  )
}
