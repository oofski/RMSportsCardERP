import { randomUUID } from 'crypto'
import { sortTodos, validateTodo, type Todo } from '@shared/ownerDashboard'
import { getDb } from './database'

/**
 * One person's checklist.
 *
 * Everything here is scoped by `ownerId` and there is no operation that takes a
 * list belonging to somebody else — not because a to-do is a secret, but because
 * "whose list is this" is the only question this feature has, and an API that
 * lets it be answered wrongly will eventually answer it wrongly. The caller's id
 * comes from the session in the IPC layer; nothing accepts one as an argument.
 */

function nowIso(): string {
  return new Date().toISOString()
}

interface Row {
  id: string
  body: string
  done: number
  created_at: string
  done_at: string | null
}

function toTodo(r: Row): Todo {
  return {
    id: r.id,
    body: r.body,
    done: r.done === 1,
    createdAt: r.created_at,
    doneAt: r.done_at
  }
}

export function listTodos(ownerId: string): Todo[] {
  const rows = getDb()
    .prepare(
      `SELECT id, body, done, created_at, done_at
         FROM todos WHERE owner_id = ? ORDER BY created_at ASC`
    )
    .all(ownerId) as Row[]
  return sortTodos(rows.map(toTodo))
}

export function createTodo(ownerId: string, body: string): Todo {
  const problem = validateTodo(body)
  if (problem) throw new Error(problem)
  const now = nowIso()
  const todo: Todo = {
    id: randomUUID(),
    body: body.trim(),
    done: false,
    createdAt: now,
    doneAt: null
  }
  getDb()
    .prepare(
      `INSERT INTO todos (id, owner_id, body, done, created_at, updated_at, done_at)
       VALUES (?, ?, ?, 0, ?, ?, NULL)`
    )
    .run(todo.id, ownerId, todo.body, now, now)
  return todo
}

/**
 * Tick or un-tick.
 *
 * `done_at` is cleared on un-ticking rather than left behind: it is the answer to
 * "when was this finished", and a row that is not finished has no answer. A
 * stale timestamp there would sort a re-opened task among the completed ones.
 */
export function setTodoDone(ownerId: string, id: string, done: boolean): Todo | null {
  const db = getDb()
  const now = nowIso()
  const info = db
    .prepare(
      `UPDATE todos SET done = ?, done_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ?`
    )
    .run(done ? 1 : 0, done ? now : null, now, id, ownerId)
  if (info.changes === 0) return null
  const row = db
    .prepare(`SELECT id, body, done, created_at, done_at FROM todos WHERE id = ?`)
    .get(id) as Row | undefined
  return row ? toTodo(row) : null
}

export function deleteTodo(ownerId: string, id: string): boolean {
  return (
    getDb().prepare(`DELETE FROM todos WHERE id = ? AND owner_id = ?`).run(id, ownerId).changes > 0
  )
}

/** Clear every ticked line at once — the "tidy up" the list eventually needs. */
export function clearDoneTodos(ownerId: string): number {
  return getDb().prepare(`DELETE FROM todos WHERE owner_id = ? AND done = 1`).run(ownerId).changes
}
