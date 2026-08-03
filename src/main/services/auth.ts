import type { AuthResult, Result, SessionUser } from '@shared/types'
import { effectivePermissions, type Role } from '@shared/permissions'
import {
  countEmployees,
  getEmployeeById,
  getEmployeeRowForAuth,
  insertEmployee,
  setChosenPassword,
  toEmployee,
  verifyPassword,
  companyIdExists,
  emailExists
} from '../db/employees'
import { isValidEmail } from '../util'
import { contextUserId } from './session'

/**
 * The signed-in user of a LOCAL desktop session. Lives in main-process memory
 * only — never written to disk — and is cleared on logout or quit.
 *
 * When the app is talking to a shared server instead, this is not consulted:
 * each request carries its own user (see services/session.ts) and
 * `activeUserId()` prefers that. One variable cannot be ten people.
 */
let currentUserId: string | null = null

/**
 * Whose request is this?
 *
 * A request context always wins, INCLUDING when it says nobody — an
 * unauthenticated server request must never be answered as whoever happens to
 * be signed in locally. Only the genuine absence of a context (the desktop app)
 * falls back to the local session.
 */
function activeUserId(): string | null {
  const fromRequest = contextUserId()
  return fromRequest !== undefined ? fromRequest : currentUserId
}

function sessionUserFor(id: string): SessionUser | null {
  const employee = getEmployeeById(id)
  if (!employee) return null
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    companyId: employee.companyId,
    title: employee.title,
    email: employee.email,
    role: employee.role,
    permissions: effectivePermissions(employee.role, employee.extraPermissions),
    mustChangePassword: employee.mustChangePassword,
    avatarUrl: employee.avatarUrl
  }
}

/** True when no accounts exist yet — triggers first-run Owner setup. */
export function needsSetup(): boolean {
  return countEmployees() === 0
}

/** First-run: create the Owner account with a chosen password (already active). */
export function createOwner(input: {
  firstName: string
  lastName: string
  companyId: string
  email: string
  title: string
  password: string
}): AuthResult {
  if (!needsSetup()) {
    return { ok: false, error: 'Setup has already been completed.' }
  }
  if (!input.firstName.trim() || !input.lastName.trim()) {
    return { ok: false, error: 'First and last name are required.' }
  }
  if (!input.companyId.trim()) {
    return { ok: false, error: 'A Company ID is required.' }
  }
  if (!isValidEmail(input.email)) {
    return { ok: false, error: 'A valid email address is required.' }
  }
  if (input.password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' }
  }

  const { employee } = insertEmployee(
    {
      firstName: input.firstName,
      lastName: input.lastName,
      companyId: input.companyId,
      title: input.title || 'Owner',
      email: input.email,
      role: 'owner',
      status: 'active'
    },
    null,
    input.password
  )
  // The Owner chose their own password, so clear the must-change flag.
  setChosenPassword(employee.id, input.password)
  currentUserId = employee.id

  const user = sessionUserFor(employee.id)
  return user ? { ok: true, user } : { ok: false, error: 'Failed to create the Owner account.' }
}

export function login(identifier: string, password: string): AuthResult {
  if (!identifier.trim() || !password) {
    return { ok: false, error: 'Enter your Company ID (or email) and password.' }
  }
  const row = getEmployeeRowForAuth(identifier)
  if (!row) {
    return { ok: false, error: 'Incorrect credentials.' }
  }
  const employee = toEmployee(row)
  if (employee.status === 'disabled') {
    return { ok: false, error: 'This account has been deactivated. Contact an administrator.' }
  }
  if (!verifyPassword(row, password)) {
    return { ok: false, error: 'Incorrect credentials.' }
  }

  currentUserId = employee.id
  const user = sessionUserFor(employee.id)
  return user ? { ok: true, user } : { ok: false, error: 'Sign-in failed.' }
}

export function logout(): void {
  currentUserId = null
}

export function currentUser(): SessionUser | null {
  const id = activeUserId()
  return id ? sessionUserFor(id) : null
}

export function currentUserId_(): string | null {
  return activeUserId()
}

/** Change the signed-in user's own password (used to satisfy must-change). */
export function changeOwnPassword(currentPassword: string, newPassword: string): Result {
  const currentUserId = activeUserId()
  if (!currentUserId) return { ok: false, error: 'Not signed in.' }
  if (newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' }
  }
  const row = getEmployeeRowForAuth(getEmployeeById(currentUserId)?.companyId ?? '')
  if (!row) return { ok: false, error: 'Account not found.' }
  if (!verifyPassword(row, currentPassword)) {
    return { ok: false, error: 'Current password is incorrect.' }
  }
  setChosenPassword(currentUserId, newPassword)
  return { ok: true }
}

/**
 * Guards used by IPC handlers to enforce validation before writing.
 *
 * Shipping is the one role allowed to arrive without an address: the floor is
 * staffed by people who have no company email, and they sign in with the
 * Company ID they were given. Every other role still needs somewhere the invite
 * can go. The form relaxes the same rule, but the form is not the boundary.
 */
export function validateNewEmployee(input: {
  companyId: string
  email: string
  role: Role
}): string | null {
  const email = (input.email ?? '').trim()
  if (!email) {
    if (input.role !== 'shipping') return 'A valid email address is required.'
  } else if (!isValidEmail(email)) {
    return 'A valid email address is required.'
  }
  if (companyIdExists(input.companyId)) return 'That Company ID is already in use.'
  if (emailExists(email)) return 'That email address is already in use.'
  return null
}
