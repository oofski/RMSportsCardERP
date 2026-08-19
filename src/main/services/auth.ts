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
  emailExists,
  activateEmployee
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
    sharedAccount: employee.sharedAccount,
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

  // SIGNING IN IS PROOF OF ACTIVITY, and until now it was not treated as such.
  //
  // A person created with an email starts 'invited', and the ONLY thing that
  // promoted them was choosing their own password. Anybody who arrived by some
  // other route — onboarded on the website, given a password by an admin, or
  // signing in with the one they were issued — worked every shift while the
  // roster still called them invited. That is not cosmetic: 'invited' reads as
  // "has not turned up yet" on the screens that hand out work.
  //
  // Whoever just authenticated has demonstrably turned up. 'disabled' was
  // already refused above, so this can only ever move invited -> active, never
  // reinstate somebody who was switched off.
  if (employee.status === 'invited') {
    activateEmployee(employee.id)
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
  const me = getEmployeeById(currentUserId)
  /**
   * A SHARED BENCH CANNOT CHANGE ITS OWN PASSWORD, and this is where that is
   * decided — not on the screen.
   *
   * "My account" hid the form, which is not the same thing as refusing: this
   * handler had no check of its own, so anything that could reach the channel
   * changed the password regardless. The screen is a courtesy; this is the
   * boundary.
   *
   * Keyed on the ACCOUNT rather than the role. Real people work on the shipping
   * role, and treating the role as the answer is exactly what locked all of them
   * out of a credential that is genuinely theirs. See the v75 migration.
   */
  if (me?.sharedAccount) {
    return {
      ok: false,
      error:
        'This is a shared bench login, so its password is not one person’s to change — ' +
        'everybody signed in on it would be signed out. Ask whoever runs the floor to set a ' +
        'new one.'
    }
  }
  const row = getEmployeeRowForAuth(me?.companyId ?? '')
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
 * Shipping is the one role that differs, in two directions at once.
 *
 * It is allowed to arrive without an address: the floor is staffed by people
 * who have no company email, and they sign in with the Company ID they were
 * given. Every other role still needs somewhere the invite can go.
 *
 * And it is the only role that must arrive WITH a password. A packing computer
 * is shared, so there is no one person to generate a temporary password for and
 * prompt to replace it; the administrator types one and reads it out. Eight
 * characters is the same floor the Owner setup and the change-password screen
 * hold everyone else to — a shared password is not a reason to accept a weaker
 * one, and a one-character password typed by mistake would be accepted forever.
 *
 * The form applies both rules too, and the form is not the boundary. This is.
 */
export function validateNewEmployee(input: {
  companyId: string
  email: string
  role: Role
  password?: string
}): string | null {
  const email = (input.email ?? '').trim()
  if (!email) {
    if (input.role !== 'shipping') return 'A valid email address is required.'
  } else if (!isValidEmail(email)) {
    return 'A valid email address is required.'
  }
  // Trimmed, so eight spaces is not a password. The value STORED is the one
  // that was typed, spaces and all — trimming what gets hashed would silently
  // change somebody's password out from under them.
  if (input.role === 'shipping' && (input.password ?? '').trim().length < 8) {
    return 'Set a password of at least 8 characters for this account.'
  }
  if (companyIdExists(input.companyId)) return 'That Company ID is already in use.'
  if (emailExists(email)) return 'That email address is already in use.'
  return null
}
