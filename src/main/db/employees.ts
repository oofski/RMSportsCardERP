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
    email: row.email,
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

/** Look up by company ID or email (used for login). Case-insensitive. */
function getRowByLogin(identifier: string): EmployeeRow | undefined {
  const value = identifier.trim()
  return getDb()
    .prepare('SELECT * FROM employees WHERE company_id = ? COLLATE NOCASE OR email = ? COLLATE NOCASE')
    .get(value, value) as EmployeeRow | undefined
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
    email: input.email.trim(),
    role: input.role,
    status: input.status ?? 'invited',
    password_hash: passwordHash,
    // A station never has a password to change: nobody owns it, so there is
    // nobody to prompt. Forcing the change would strand the bench behind a
    // screen the first person to sit down cannot get past.
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
  const existing = getEmployeeById(input.id)
  if (!existing) return null

  const next = {
    first_name: input.firstName?.trim() ?? existing.firstName,
    last_name: input.lastName?.trim() ?? existing.lastName,
    company_id: input.companyId?.trim() ?? existing.companyId,
    title: input.title?.trim() ?? existing.title,
    email: input.email?.trim() ?? existing.email,
    role: input.role ?? existing.role,
    status: input.status ?? existing.status,
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
  const hash = bcrypt.hashSync(temporaryPassword, BCRYPT_ROUNDS)
  const info = db
    .prepare(
      // A DISABLED employee keeps that status. Resetting a password is about
      // credentials; it is not a rehire, and unconditionally writing 'invited'
      // erased the only record that someone had been deactivated — they came
      // back with their original role and permissions intact.
      `UPDATE employees
         SET password_hash = ?, must_change_password = 1,
             status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'invited' END,
             updated_at = ?
       WHERE id = ?`
    )
    .run(hash, nowIso(), id)
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

export function emailExists(email: string, exceptId?: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT id FROM employees WHERE email = ? COLLATE NOCASE')
    .get(email.trim()) as { id: string } | undefined
  return !!row && row.id !== exceptId
}

export type { EmployeeRow }
export { toEmployee, type Database }

// ---------------------------------------------------------------------------
// Stations — a bench computer that signs in, rather than a person
// ---------------------------------------------------------------------------

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
  return `station:${code.trim().toLowerCase()}`
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
