import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { getDb } from '../main/db/database'
import { login as verifyCredentials } from '../main/services/auth'
import { getEmployeeById } from '../main/db/employees'
import type { AuthResult } from '@shared/types'

/**
 * Sessions for the shared-database server.
 *
 * The desktop app keeps its signed-in user in a variable. A server cannot: ten
 * people are connected, each request has to say who it is, and the answer has to
 * survive a restart — otherwise a deploy signs the whole warehouse out in the
 * middle of a count.
 *
 * A session is a random 256-bit token. The database stores only its SHA-256, so
 * a leaked backup does not hand over a set of live logins; the token itself
 * exists only in the client that was issued it. Comparison is by hashing what
 * the client presents and looking that up, which is a constant-time operation by
 * construction — there is no secret to compare against, only a key to find.
 */

/** How long a session lasts without use. Long enough not to interrupt a shift. */
const IDLE_TTL_MS = 12 * 60 * 60 * 1000

/** Absolute ceiling regardless of activity, so a token cannot live forever. */
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface IssuedSession {
  token: string
  expiresAt: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * Verify credentials and issue a session.
 *
 * Delegates the password check to the same `login()` the desktop app uses, so
 * there is one place that decides whether a password is correct, one place that
 * knows about disabled accounts, and no second implementation to drift.
 */
export function signIn(
  identifier: string,
  password: string,
  client: string | null
): { result: AuthResult; session?: IssuedSession } {
  const result = verifyCredentials(identifier, password)
  if (!result.ok || !result.user) return { result }

  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = iso(now + IDLE_TTL_MS)
  getDb()
    .prepare(
      `INSERT INTO server_sessions
         (token_hash, employee_id, created_at, last_seen_at, expires_at, client)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(hashToken(token), result.user.id, iso(now), iso(now), expiresAt, client)
  return { result, session: { token, expiresAt } }
}

export interface ResolvedSession {
  employeeId: string
  expiresAt: string
}

/**
 * Who does this token belong to, or null.
 *
 * Sliding expiry: every use pushes the idle deadline out, but never past the
 * absolute ceiling measured from when the session was created. That keeps
 * someone working all day signed in while still guaranteeing every token dies.
 */
export function resolveSession(token: string | null | undefined): ResolvedSession | null {
  if (!token) return null
  const row = getDb()
    .prepare(
      `SELECT employee_id, created_at, expires_at FROM server_sessions WHERE token_hash = ?`
    )
    .get(hashToken(token)) as
    | { employee_id: string; created_at: string; expires_at: string }
    | undefined
  if (!row) return null

  const now = Date.now()
  if (new Date(row.expires_at).getTime() <= now) {
    revokeByHash(hashToken(token))
    return null
  }
  const ceiling = new Date(row.created_at).getTime() + MAX_TTL_MS
  if (ceiling <= now) {
    revokeByHash(hashToken(token))
    return null
  }
  // The account may have been deleted or disabled since the token was issued.
  // Checking on every request is what makes "disable this employee" take effect
  // immediately rather than whenever their session happens to lapse.
  const employee = getEmployeeById(row.employee_id)
  if (!employee || employee.status === 'disabled') {
    revokeByHash(hashToken(token))
    return null
  }

  const nextExpiry = iso(Math.min(now + IDLE_TTL_MS, ceiling))
  getDb()
    .prepare('UPDATE server_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .run(iso(now), nextExpiry, hashToken(token))
  return { employeeId: row.employee_id, expiresAt: nextExpiry }
}

function revokeByHash(hash: string): void {
  getDb().prepare('DELETE FROM server_sessions WHERE token_hash = ?').run(hash)
}

/** Sign one client out. */
export function signOut(token: string | null | undefined): void {
  if (token) revokeByHash(hashToken(token))
}

/** Sign a person out everywhere — used when an account is disabled. */
export function revokeAllForEmployee(employeeId: string): number {
  return getDb().prepare('DELETE FROM server_sessions WHERE employee_id = ?').run(employeeId).changes
}

/** Drop expired rows. Cheap, and called on a timer so the table cannot grow
 *  without bound on a server that runs for months. */
export function purgeExpiredSessions(): number {
  return getDb()
    .prepare('DELETE FROM server_sessions WHERE expires_at <= ?')
    .run(new Date().toISOString()).changes
}

/** How many sessions are currently live — surfaced on the health endpoint. */
export function activeSessionCount(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM server_sessions WHERE expires_at > ?')
    .get(new Date().toISOString()) as { n: number }
  return row.n
}

/**
 * Constant-time compare for the few places that DO compare secrets directly
 * (the shared bootstrap key, if one is ever configured). Not used for session
 * tokens, which are looked up by hash rather than compared.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
