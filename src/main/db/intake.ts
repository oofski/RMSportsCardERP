import { randomUUID, randomBytes } from 'crypto'
import { getDb } from './database'
import { getSyncConfig } from '../services/cloudSync'
import type { IntakeLink, IntakeLinkInput, IntakeSubmission, IntakeStatus } from '@shared/sync'

/**
 * The public intake form, laptop side.
 *
 * Staff create a link here; it travels to the Worker as an ordinary sync row and
 * the form goes live. Customers fill it in; their answers travel back the same
 * way and land in intake_submissions. Nothing operational moves until somebody
 * reviews one.
 *
 * That review step is the whole security model. The form cannot be
 * authenticated — customers have no logins — so anything it could write
 * directly, a stranger with the link could write. Letting it edit a real
 * customer's shipping address would be a way to have someone else's cards
 * mailed to your house. So it writes to its own table, and a person decides.
 */

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 32 characters from a 160-bit random draw.
 *
 * Letters and digits only: the token appears in a URL people read aloud and
 * paste into chat, and it is matched against a restricted alphabet in the
 * Worker so there is nothing in it that could mean something to SQL.
 */
function mintToken(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(32)
  let out = ''
  for (let i = 0; i < 32; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

interface LinkRow {
  id: string
  token: string
  label: string
  event_name: string
  event_date: string | null
  active: number
  created_at: string
  created_by: string | null
}

function publicUrl(token: string): string {
  const base = getSyncConfig().url
  return base ? `${base}/checkin/${token}` : ''
}

function toLink(row: LinkRow, counts: { total: number; fresh: number }): IntakeLink {
  return {
    id: row.id,
    token: row.token,
    label: row.label,
    eventName: row.event_name,
    eventDate: row.event_date,
    active: row.active === 1,
    createdAt: row.created_at,
    createdBy: row.created_by,
    url: publicUrl(row.token),
    submissions: counts.total,
    newSubmissions: counts.fresh
  }
}

export function listIntakeLinks(): IntakeLink[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, token, label, event_name, event_date, active, created_at, created_by
       FROM intake_links ORDER BY active DESC, created_at DESC`
    )
    .all() as LinkRow[]

  const counts = new Map<string, { total: number; fresh: number }>()
  for (const c of db
    .prepare(
      `SELECT link_id,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS fresh
       FROM intake_submissions GROUP BY link_id`
    )
    .all() as Array<{ link_id: string; total: number; fresh: number }>) {
    counts.set(c.link_id, { total: c.total, fresh: c.fresh ?? 0 })
  }

  return rows.map((r) => toLink(r, counts.get(r.id) ?? { total: 0, fresh: 0 }))
}

export function createIntakeLink(input: IntakeLinkInput, createdBy: string | null): IntakeLink {
  const db = getDb()
  const id = randomUUID()
  const token = mintToken()
  const at = nowIso()
  db.prepare(
    `INSERT INTO intake_links
       (id, token, label, event_name, event_date, active, created_at, created_by, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    id,
    token,
    input.label.trim().slice(0, 120),
    input.eventName.trim().slice(0, 160),
    input.eventDate?.trim() || null,
    at,
    createdBy,
    at
  )
  const row = db
    .prepare(
      `SELECT id, token, label, event_name, event_date, active, created_at, created_by
       FROM intake_links WHERE id = ?`
    )
    .get(id) as LinkRow
  return toLink(row, { total: 0, fresh: 0 })
}

/**
 * Turn a link on or off.
 *
 * Deactivating rather than deleting: the submissions that came through it stay
 * attached to something, and the Worker reads `active` from the same synced row,
 * so switching it off here closes the form everywhere within one sync round.
 */
export function setIntakeLinkActive(id: string, active: boolean): boolean {
  const info = getDb()
    .prepare('UPDATE intake_links SET active = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, nowIso(), id)
  return info.changes > 0
}

interface SubmissionRow {
  id: string
  link_id: string
  handle: string
  real_name: string
  email: string
  phone: string
  address1: string
  address2: string
  city: string
  state: string
  postal_code: string
  country: string
  request: string
  status: string
  status_note: string | null
  customer_id: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  created_at: string
  link_label: string | null
}

function toSubmission(row: SubmissionRow): IntakeSubmission {
  return {
    id: row.id,
    linkId: row.link_id,
    linkLabel: row.link_label ?? '',
    handle: row.handle,
    realName: row.real_name,
    email: row.email,
    phone: row.phone,
    address1: row.address1,
    address2: row.address2,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    request: row.request,
    status: (row.status as IntakeStatus) ?? 'new',
    statusNote: row.status_note,
    customerId: row.customer_id,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at
  }
}

export function listIntakeSubmissions(status?: IntakeStatus): IntakeSubmission[] {
  const where = status ? 'WHERE s.status = ?' : ''
  const rows = getDb()
    .prepare(
      `SELECT s.*, l.label AS link_label
       FROM intake_submissions s
       LEFT JOIN intake_links l ON l.id = s.link_id
       ${where}
       ORDER BY s.created_at DESC LIMIT 500`
    )
    .all(...(status ? [status] : [])) as SubmissionRow[]
  return rows.map(toSubmission)
}

export function newSubmissionCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM intake_submissions WHERE status = 'new'`)
    .get() as { n: number }
  return row.n
}

/** The single-line address ship_customers stores. */
function composeAddress(row: SubmissionRow): string {
  return [
    row.address1,
    row.address2,
    [row.city, row.state].filter(Boolean).join(', '),
    row.postal_code,
    row.country && row.country !== 'US' ? row.country : ''
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ')
}

/** Strip the @ people type and normalise case, so one person is one customer. */
function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase()
}

export interface ReviewResult {
  ok: boolean
  error?: string
  submission?: IntakeSubmission
}

/**
 * Accept a submission into the shipping customer list.
 *
 * ship_customers is keyed by the Whatnot handle, which is also the join key
 * between the packing and breaking slips, so a submission without one cannot
 * become a customer — it would create a row nothing could ever match.
 */
export function acceptIntakeSubmission(id: string, reviewer: string | null): ReviewResult {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT s.*, l.label AS link_label FROM intake_submissions s
       LEFT JOIN intake_links l ON l.id = s.link_id WHERE s.id = ?`
    )
    .get(id) as SubmissionRow | undefined
  if (!row) return { ok: false, error: 'That submission no longer exists.' }
  if (row.status === 'accepted') return { ok: false, error: 'Already accepted.' }

  const handle = normalizeHandle(row.handle)
  if (!handle) {
    return {
      ok: false,
      error: 'No Whatnot handle on this submission — it cannot be matched to orders. Reject it, or ask the customer.'
    }
  }

  const address = composeAddress(row)
  const at = nowIso()

  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM ship_customers WHERE id = ?').get(handle) as
      | { id: string }
      | undefined
    if (existing) {
      // Fill blanks and update what the customer just told us. This is the
      // moment a person decided to trust it, which is what makes overwriting a
      // stored address acceptable here and not acceptable at the form.
      db.prepare(
        `UPDATE ship_customers
           SET whatnot_handle = ?,
               real_name = CASE WHEN ? <> '' THEN ? ELSE real_name END,
               address   = CASE WHEN ? <> '' THEN ? ELSE address   END
         WHERE id = ?`
      ).run(row.handle.trim() || handle, row.real_name, row.real_name, address, address, handle)
    } else {
      db.prepare(
        `INSERT INTO ship_customers (id, whatnot_handle, real_name, address, is_new)
         VALUES (?, ?, ?, ?, 1)`
      ).run(handle, row.handle.trim() || handle, row.real_name, address)
    }

    db.prepare(
      `UPDATE intake_submissions
         SET status = 'accepted', customer_id = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
       WHERE id = ?`
    ).run(handle, at, reviewer, at, id)
  })
  run()

  const updated = db
    .prepare(
      `SELECT s.*, l.label AS link_label FROM intake_submissions s
       LEFT JOIN intake_links l ON l.id = s.link_id WHERE s.id = ?`
    )
    .get(id) as SubmissionRow
  return { ok: true, submission: toSubmission(updated) }
}

export function rejectIntakeSubmission(
  id: string,
  note: string,
  reviewer: string | null
): ReviewResult {
  const db = getDb()
  const at = nowIso()
  const info = db
    .prepare(
      `UPDATE intake_submissions
         SET status = 'rejected', status_note = ?, reviewed_at = ?, reviewed_by = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(note.trim().slice(0, 500) || null, at, reviewer, at, id)
  if (info.changes === 0) return { ok: false, error: 'That submission no longer exists.' }

  const updated = db
    .prepare(
      `SELECT s.*, l.label AS link_label FROM intake_submissions s
       LEFT JOIN intake_links l ON l.id = s.link_id WHERE s.id = ?`
    )
    .get(id) as SubmissionRow
  return { ok: true, submission: toSubmission(updated) }
}
