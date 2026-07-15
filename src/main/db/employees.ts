import bcrypt from 'bcryptjs'
import type { Database } from 'better-sqlite3'
import type {
  Employee,
  EmployeeStatus,
  NewEmployeeInput,
  UpdateEmployeeInput
} from '@shared/types'
import type { Role } from '@shared/permissions'
import { getDb } from './database'
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
  created_at: string
  updated_at: string
  created_by: string | null
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
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
  input: NewEmployeeInput & { status?: EmployeeStatus },
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
        password_hash, must_change_password, created_at, updated_at, created_by)
     VALUES
       (@id, @first_name, @last_name, @company_id, @title, @email, @role, @status,
        @password_hash, @must_change_password, @created_at, @updated_at, @created_by)`
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
    must_change_password: temporaryPassword ? 1 : 0,
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

/** Set a fresh temporary password (invite reset). Returns nothing sensitive. */
export function setTemporaryPassword(id: string, temporaryPassword: string): boolean {
  const db = getDb()
  const hash = bcrypt.hashSync(temporaryPassword, BCRYPT_ROUNDS)
  const info = db
    .prepare(
      `UPDATE employees
         SET password_hash = ?, must_change_password = 1, status = 'invited', updated_at = ?
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
      `UPDATE employees
         SET password_hash = ?, must_change_password = 0, status = 'active', updated_at = ?
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
