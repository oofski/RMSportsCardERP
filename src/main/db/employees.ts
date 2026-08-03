import bcrypt from 'bcryptjs'
import type { Database } from 'better-sqlite3'
import type {
  AccountKind,
  Employee,
  EmployeeStatus,
  NewEmployeeInput,
  UpdateEmployeeInput
} from '@shared/types'
import { sanitizePermissions, type Permission, type Role } from '@shared/permissions'
import { getDb } from './database'
import { deleteImageFile, imageDataUrl, importImageFile } from '../services/media'
import { newId, nowIso } from '../util'

const BCRYPT_ROUNDS = 12

interface EmployeeRow {
  id: string
  first_name: string
  last_name: string
  company_id: string
  title: string
  email: string
  role: string
  status: string
  password_hash: string | null
  must_change_password: number
  permissions_json: string | null
  avatar: string | null
  account_kind: string | null
  created_at: string
  updated_at: string
  created_by: string | null
}

function parseExtraPermissions(json: string | null): Permission[] {
  if (!json) return []
  try {
    return sanitizePermissions(JSON.parse(json))
  } catch {
    return []
  }
}

function toEmployee(row: EmployeeRow): Employee {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    companyId: row.company_id,
    title: row.title,
    // Scrubbed at the boundary, not at each screen. An account with no address
    // still holds a synthetic one in the column (see placeholderEmailFor), and
    // a rule that every list, CSV and invite has to remember to apply is a rule
    // the next screen forgets. Nothing outside this file sees the raw value.
    email: isPlaceholderEmail(row.email) ? '' : row.email,
    role: row.role as Role,
    status: row.status as EmployeeStatus,
    mustChangePassword: row.must_change_password === 1,
    extraPermissions: parseExtraPermissions(row.permissions_json),
    avatarUrl: row.avatar ? imageDataUrl(row.avatar) : null,
    // Anything not explicitly a station is a person — which is also what every
    // row written before stations existed is.
    accountKind: row.account_kind === 'station' ? 'station' : 'person',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

/** Replace an employee's individual permission overrides. */
export function setEmployeePermissions(id: string, permissions: Permission[]): boolean {
  const clean = sanitizePermissions(permissions)
  const info = getDb()
    .prepare('UPDATE employees SET permissions_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(clean), nowIso(), id)
  return info.changes > 0
}

export function countEmployees(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }
  return row.n
}

export function listEmployees(): Employee[] {
  const rows = getDb()
    .prepare('SELECT * FROM employees ORDER BY first_name COLLATE NOCASE, last_name COLLATE NOCASE')
    .all() as EmployeeRow[]
  return rows.map(toEmployee)
}

export function getEmployeeById(id: string): Employee | null {
  const row = getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as
    | EmployeeRow
    | undefined
  return row ? toEmployee(row) : null
}

/**
 * Look up by company ID or email (used for login). Case-insensitive.
 *
 * Two things this must never do, both of which the old single OR could.
 *
 * A blank identifier must match nobody. The OR spanned two columns, so an empty
 * string was a live query for whichever row ever ended up with an empty one —
 * and callers do reach here with a default of '' (changeOwnPassword does).
 *
 * And a synthetic address must not be a second way in. Accounts with no email
 * hold `no-email:<company id>` or `station:<code>` in the column; both are
 * derived from values that are public within the shop and trivially guessable.
 * They identify nobody, so they authenticate nobody. Those accounts sign in
 * with their Company ID, which is what they were given. The email branch alone
 * is dropped rather than the whole lookup: a Company ID is whatever an
 * administrator typed, and it is not this function's place to rule one out.
 */
function getRowByLogin(identifier: string): EmployeeRow | undefined {
  const value = identifier.trim()
  if (!value) return undefined
  const db = getDb()
  const byCompanyId = db
    .prepare('SELECT * FROM employees WHERE company_id = ? COLLATE NOCASE')
    .get(value) as EmployeeRow | undefined
  if (byCompanyId) return byCompanyId
  if (isPlaceholderEmail(value)) return undefined
  return db.prepare('SELECT * FROM employees WHERE email = ? COLLATE NOCASE').get(value) as
    | EmployeeRow
    | undefined
}

export function getEmployeeRowForAuth(identifier: string): EmployeeRow | undefined {
  return getRowByLogin(identifier)
}

export interface CreateEmployeeResult {
  employee: Employee
  temporaryPassword: string | null
}

/**
 * Insert a new employee. If a temporary password is supplied it is hashed and
 * the employee is marked as needing to change it on first login. Returns the
 * created record; the plaintext temp password is echoed back so it can be
 * placed in the invite email exactly once.
 */
export function insertEmployee(
  input: NewEmployeeInput & { status?: EmployeeStatus; accountKind?: AccountKind },
  createdBy: string | null,
  temporaryPassword: string | null
): CreateEmployeeResult {
  const db = getDb()
  const id = newId()
  const ts = nowIso()
  const passwordHash = temporaryPassword ? bcrypt.hashSync(temporaryPassword, BCRYPT_ROUNDS) : null
  const email = input.email.trim()

  db.prepare(
    `INSERT INTO employees
       (id, first_name, last_name, company_id, title, email, role, status,
        password_hash, must_change_password, account_kind, created_at, updated_at, created_by)
     VALUES
       (@id, @first_name, @last_name, @company_id, @title, @email, @role, @status,
        @password_hash, @must_change_password, @account_kind, @created_at, @updated_at, @created_by)`
  ).run({
    id,
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    company_id: input.companyId.trim(),
    title: input.title.trim(),
    email: email || placeholderEmailFor(input.companyId),
    role: input.role,
    // Nobody is waiting on an invite that was never sent. An employee with no
    // address is handed their temporary password across the bench, so they are
    // usable the moment they exist; leaving them 'invited' would park a Resend
    // button in the directory that can never do anything.
    status: input.status ?? (email ? 'invited' : 'active'),
    password_hash: passwordHash,
    // A station never has a password to change: nobody owns it, so there is
    // nobody to prompt. Forcing the change would strand the bench behind a
    // screen the first person to sit down cannot get past. A person with no
    // email is the opposite case — somebody does own it, and the prompt never
    // needed an address — so they still choose their own on first sign-in.
    must_change_password: input.accountKind === 'station' ? 0 : temporaryPassword ? 1 : 0,
    account_kind: input.accountKind === 'station' ? 'station' : 'person',
    created_at: ts,
    updated_at: ts,
    created_by: createdBy
  })

  return {
    employee: getEmployeeById(id) as Employee,
    temporaryPassword
  }
}

export function updateEmployee(input: UpdateEmployeeInput): Employee | null {
  const db = getDb()
  // The raw row, not getEmployeeById: that one hands back a blank email for a
  // synthetic address, and writing the blank back would breach NOT NULL's
  // intent and collide the moment a second employee had none either.
  const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(input.id) as
    | EmployeeRow
    | undefined
  if (!existing) return null

  const companyId = input.companyId?.trim() ?? existing.company_id
  const suppliedEmail = input.email?.trim()

  const next = {
    first_name: input.firstName?.trim() ?? existing.first_name,
    last_name: input.lastName?.trim() ?? existing.last_name,
    company_id: companyId,
    title: input.title?.trim() ?? existing.title,
    // An emptied box is not an erasure — the column is NOT NULL — it is the
    // same synthetic value a no-email employee is created with. It is rebuilt
    // from the (possibly new) Company ID rather than carried over, because a
    // stale one would collide with whoever is given that ID next.
    email: emailToStore(suppliedEmail, existing.email, companyId),
    role: input.role ?? (existing.role as Role),
    status: input.status ?? (existing.status as EmployeeStatus),
    updated_at: nowIso(),
    id: input.id
  }

  db.prepare(
    `UPDATE employees SET
       first_name = @first_name,
       last_name  = @last_name,
       company_id = @company_id,
       title      = @title,
       email      = @email,
       role       = @role,
       status     = @status,
       updated_at = @updated_at
     WHERE id = @id`
  ).run(next)

  return getEmployeeById(input.id)
}

/** Import a picked image as an employee's profile picture, replacing any prior
 *  one (the old file is deleted so the media dir doesn't leak). */
export function setEmployeeAvatar(id: string, srcPath: string): Employee | null {
  const db = getDb()
  const row = db.prepare('SELECT avatar FROM employees WHERE id = ?').get(id) as
    | { avatar: string | null }
    | undefined
  if (!row) return null
  const filename = importImageFile(srcPath, `emp-${id}`)
  // Delete the previous file only if a different extension made a new filename,
  // so we never orphan e.g. an old .png after switching to a .jpg.
  if (row.avatar && row.avatar !== filename) deleteImageFile(row.avatar)
  db.prepare('UPDATE employees SET avatar = ?, updated_at = ? WHERE id = ?').run(filename, nowIso(), id)
  return getEmployeeById(id)
}

/** Remove an employee's profile picture (deletes the stored file). */
export function clearEmployeeAvatar(id: string): Employee | null {
  const db = getDb()
  const row = db.prepare('SELECT avatar FROM employees WHERE id = ?').get(id) as
    | { avatar: string | null }
    | undefined
  if (!row) return null
  if (row.avatar) deleteImageFile(row.avatar)
  db.prepare('UPDATE employees SET avatar = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id)
  return getEmployeeById(id)
}

/** Set a fresh temporary password (invite reset). Returns nothing sensitive. */
export function setTemporaryPassword(id: string, temporaryPassword: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT email FROM employees WHERE id = ?').get(id) as
    | { email: string }
    | undefined
  if (!row) return false
  const hash = bcrypt.hashSync(temporaryPassword, BCRYPT_ROUNDS)
  // Where the reset leaves them. An account with no address is not waiting on
  // an invite — the same reasoning as insertEmployee — so it goes straight back
  // to active with the new password read out to them.
  const reset: EmployeeStatus = isPlaceholderEmail(row.email) ? 'active' : 'invited'
  const info = db
    .prepare(
      // A DISABLED employee keeps that status. Resetting a password is about
      // credentials; it is not a rehire, and unconditionally writing 'invited'
      // erased the only record that someone had been deactivated — they came
      // back with their original role and permissions intact.
      `UPDATE employees
         SET password_hash = ?, must_change_password = 1,
             status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE ? END,
             updated_at = ?
       WHERE id = ?`
    )
    .run(hash, reset, nowIso(), id)
  return info.changes > 0
}

/** Change a password to one the employee chose. Clears the must-change flag. */
export function setChosenPassword(id: string, newPassword: string): boolean {
  const db = getDb()
  const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS)
  const info = db
    .prepare(
      // Same rule as setTemporaryPassword: choosing a password does not
      // reactivate a disabled account.
      `UPDATE employees
         SET password_hash = ?, must_change_password = 0,
             status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'active' END,
             updated_at = ?
       WHERE id = ?`
    )
    .run(hash, nowIso(), id)
  return info.changes > 0
}

export function verifyPassword(row: EmployeeRow, password: string): boolean {
  if (!row.password_hash) return false
  return bcrypt.compareSync(password, row.password_hash)
}

export function companyIdExists(companyId: string, exceptId?: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT id FROM employees WHERE company_id = ? COLLATE NOCASE')
    .get(companyId.trim()) as { id: string } | undefined
  return !!row && row.id !== exceptId
}

function emailRowId(email: string): string | undefined {
  const row = getDb()
    .prepare('SELECT id FROM employees WHERE email = ? COLLATE NOCASE')
    .get(email.trim()) as { id: string } | undefined
  return row?.id
}

/**
 * Is this address already somebody else's?
 *
 * Asked of what a human typed, so it answers no for the two things a human
 * cannot have typed meaningfully: nothing at all, and a synthetic address. A
 * placeholder is not an address anybody can claim, and calling one "in use"
 * would block the very accounts that carry it.
 */
export function emailExists(email: string, exceptId?: string): boolean {
  const value = email.trim()
  if (!value || isPlaceholderEmail(value)) return false
  const id = emailRowId(value)
  return !!id && id !== exceptId
}

/**
 * Is this synthetic address already on a row? Asked by the station path, where
 * the address IS the identifier and so the question is a real one — emailExists
 * deliberately declines to answer it.
 */
export function syntheticEmailTaken(email: string): boolean {
  return emailRowId(email) !== undefined
}

export type { EmployeeRow }
export { toEmployee, type Database }

// ---------------------------------------------------------------------------
// Accounts with no email address
// ---------------------------------------------------------------------------

const STATION_PREFIX = 'station:'
const NO_EMAIL_PREFIX = 'no-email:'

/**
 * The synthetic address a station carries.
 *
 * `employees.email` is NOT NULL and UNIQUE, and rebuilding the table every
 * other table points at — to make one column nullable — is a real risk for a
 * cosmetic gain. So a station stores something that is unmistakably not an
 * address, is unique by construction, and never reaches a screen: `accountKind`
 * is what the UI reads to decide what it is looking at.
 */
export function stationEmailFor(code: string): string {
  return `${STATION_PREFIX}${code.trim().toLowerCase()}`
}

/**
 * The same trade, for a person who simply has no company address.
 *
 * Most of the shipping floor does not have one, and the alternative to this is
 * the table rebuild the comment above declined. `company_id` is already UNIQUE
 * COLLATE NOCASE, so deriving from it is unique by construction and needs no
 * lookup to prove it.
 */
export function placeholderEmailFor(companyId: string): string {
  return `${NO_EMAIL_PREFIX}${companyId.trim().toLowerCase()}`
}

/**
 * Is this one of the two synthetic forms rather than something a person could
 * actually be written to?
 *
 * The one gate everything passes through: `toEmployee` strips these before any
 * record leaves this file, `emailExists` refuses to call one taken, and the
 * login lookup refuses to accept one as an identifier.
 */
export function isPlaceholderEmail(email: string): boolean {
  const value = email.trim().toLowerCase()
  return value.startsWith(STATION_PREFIX) || value.startsWith(NO_EMAIL_PREFIX)
}

/** What the email column should hold after an edit. See updateEmployee. */
function emailToStore(supplied: string | undefined, stored: string, companyId: string): string {
  if (supplied !== undefined) return supplied || placeholderEmailFor(companyId)
  // Untouched by this edit: keep a real address as it is, but re-derive a
  // no-email placeholder in case the Company ID it was built from just moved.
  // A station's is left alone — its code cannot change, and its prefix is what
  // marks the row as a computer.
  return stored.toLowerCase().startsWith(NO_EMAIL_PREFIX) ? placeholderEmailFor(companyId) : stored
}

export function listStations(): Employee[] {
  const rows = getDb()
    .prepare(`SELECT * FROM employees WHERE account_kind = 'station' ORDER BY first_name COLLATE NOCASE`)
    .all() as EmployeeRow[]
  return rows.map(toEmployee)
}

/** Set (or reset) a station's password. Stations never must-change it. */
export function setStationPassword(id: string, password: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE employees
          SET password_hash = ?, must_change_password = 0, updated_at = ?
        WHERE id = ? AND account_kind = 'station'`
    )
    .run(bcrypt.hashSync(password, BCRYPT_ROUNDS), nowIso(), id)
  return info.changes > 0
}

export function setStationStatus(id: string, status: EmployeeStatus): boolean {
  const info = getDb()
    .prepare(`UPDATE employees SET status = ?, updated_at = ? WHERE id = ? AND account_kind = 'station'`)
    .run(status, nowIso(), id)
  return info.changes > 0
}
