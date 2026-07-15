import { ipcMain, shell, app } from 'electron'
import { IPC, type AppInfo } from '@shared/ipc'
import type {
  AuthResult,
  ComposedEmail,
  Employee,
  EmployeeHoursSummary,
  EmployeeInvite,
  NewEmployeeInput,
  NewTimeEntryInput,
  Result,
  SessionUser,
  TimeEntry,
  UpdateEmployeeInput,
  UpdateStatus
} from '@shared/types'
import { assignableRoles, roleHas, type Permission } from '@shared/permissions'
import {
  changeOwnPassword,
  createOwner,
  currentUser,
  currentUserId_,
  login,
  logout,
  needsSetup,
  validateNewEmployee
} from './services/auth'
import {
  companyIdExists,
  emailExists,
  getEmployeeById,
  insertEmployee,
  listEmployees,
  setTemporaryPassword,
  updateEmployee
} from './db/employees'
import {
  deleteTimeEntry,
  hoursSummary,
  insertTimeEntry,
  listTimeEntries
} from './db/timeEntries'
import { composeInviteEmail } from './services/email'
import { generateTempPassword, isValidEmail } from './util'
import {
  checkForUpdates,
  downloadUpdate,
  getUpdateStatus,
  installUpdate
} from './services/updater'

/** Return the signed-in user or throw a Result-shaped rejection. */
function requirePermission(permission: Permission): SessionUser {
  const user = currentUser()
  if (!user) {
    throw new PermissionError('You are not signed in.')
  }
  if (!roleHas(user.role, permission)) {
    throw new PermissionError('You do not have permission to do that.')
  }
  return user
}

class PermissionError extends Error {}

function fail(err: unknown): Result<never> {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: message }
}

export function registerIpcHandlers(): void {
  // ---- App meta -----------------------------------------------------------
  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged
    }
  })

  // ---- Auth ---------------------------------------------------------------
  ipcMain.handle(IPC.authSetupState, (): { needsSetup: boolean } => {
    return { needsSetup: needsSetup() }
  })

  ipcMain.handle(
    IPC.authCreateOwner,
    (_e, input: Parameters<typeof createOwner>[0]): AuthResult => {
      return createOwner(input)
    }
  )

  ipcMain.handle(
    IPC.authLogin,
    (_e, payload: { identifier: string; password: string }): AuthResult => {
      return login(payload.identifier, payload.password)
    }
  )

  ipcMain.handle(IPC.authLogout, (): Result => {
    logout()
    return { ok: true }
  })

  ipcMain.handle(IPC.authCurrent, (): SessionUser | null => {
    return currentUser()
  })

  ipcMain.handle(
    IPC.authChangePassword,
    (_e, payload: { currentPassword: string; newPassword: string }): Result => {
      return changeOwnPassword(payload.currentPassword, payload.newPassword)
    }
  )

  // ---- Employees ----------------------------------------------------------
  ipcMain.handle(IPC.employeesList, (): Employee[] => {
    const user = currentUser()
    if (!user || !roleHas(user.role, 'admin.employees.view')) return []
    return listEmployees()
  })

  ipcMain.handle(
    IPC.employeesCreate,
    (_e, input: NewEmployeeInput): Result<EmployeeInvite> => {
      try {
        const actor = requirePermission('admin.employees.manage')

        if (!input.firstName?.trim() || !input.lastName?.trim()) {
          return { ok: false, error: 'First and last name are required.' }
        }
        if (!input.companyId?.trim()) {
          return { ok: false, error: 'A Company ID is required.' }
        }
        if (!isValidEmail(input.email)) {
          return { ok: false, error: 'A valid email address is required.' }
        }
        if (!assignableRoles(actor.role).includes(input.role)) {
          return { ok: false, error: `You cannot assign the ${input.role} role.` }
        }
        const dupeError = validateNewEmployee(input)
        if (dupeError) return { ok: false, error: dupeError }

        const temporaryPassword = generateTempPassword()
        const { employee } = insertEmployee(input, actor.id, temporaryPassword)
        return { ok: true, data: { employee, temporaryPassword } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.employeesUpdate,
    (_e, input: UpdateEmployeeInput): Result<Employee> => {
      try {
        const actor = requirePermission('admin.employees.manage')
        const existing = getEmployeeById(input.id)
        if (!existing) return { ok: false, error: 'Employee not found.' }

        if (input.role && !assignableRoles(actor.role).includes(input.role)) {
          return { ok: false, error: `You cannot assign the ${input.role} role.` }
        }
        if (input.companyId && companyIdExists(input.companyId, input.id)) {
          return { ok: false, error: 'That Company ID is already in use.' }
        }
        if (input.email) {
          if (!isValidEmail(input.email)) {
            return { ok: false, error: 'A valid email address is required.' }
          }
          if (emailExists(input.email, input.id)) {
            return { ok: false, error: 'That email address is already in use.' }
          }
        }
        // Guard against removing the last active Owner.
        if (
          existing.role === 'owner' &&
          ((input.role && input.role !== 'owner') || input.status === 'disabled')
        ) {
          const owners = listEmployees().filter(
            (e) => e.role === 'owner' && e.status !== 'disabled'
          )
          if (owners.length <= 1) {
            return { ok: false, error: 'There must be at least one active Owner.' }
          }
        }

        const updated = updateEmployee(input)
        return updated
          ? { ok: true, data: updated }
          : { ok: false, error: 'Update failed.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.employeesResetPassword,
    (_e, payload: { id: string }): Result<EmployeeInvite> => {
      try {
        requirePermission('admin.employees.manage')
        const employee = getEmployeeById(payload.id)
        if (!employee) return { ok: false, error: 'Employee not found.' }
        const temporaryPassword = generateTempPassword()
        setTemporaryPassword(payload.id, temporaryPassword)
        const refreshed = getEmployeeById(payload.id) as Employee
        return { ok: true, data: { employee: refreshed, temporaryPassword } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- Hours --------------------------------------------------------------
  ipcMain.handle(IPC.hoursSummary, (): EmployeeHoursSummary[] => {
    const user = currentUser()
    if (!user || !roleHas(user.role, 'admin.hours.view')) return []
    return hoursSummary()
  })

  ipcMain.handle(IPC.hoursList, (_e, employeeId?: string): TimeEntry[] => {
    const user = currentUser()
    if (!user || !roleHas(user.role, 'admin.hours.view')) return []
    return listTimeEntries(employeeId)
  })

  ipcMain.handle(
    IPC.hoursCreate,
    (_e, input: NewTimeEntryInput): Result<TimeEntry> => {
      try {
        requirePermission('admin.employees.manage')
        if (!input.employeeId) return { ok: false, error: 'Select an employee.' }
        if (!input.clockIn) return { ok: false, error: 'A clock-in time is required.' }
        if (input.clockOut && input.clockOut < input.clockIn) {
          return { ok: false, error: 'Clock-out must be after clock-in.' }
        }
        return { ok: true, data: insertTimeEntry(input) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.hoursDelete, (_e, payload: { id: string }): Result => {
    try {
      requirePermission('admin.employees.manage')
      return deleteTimeEntry(payload.id)
        ? { ok: true }
        : { ok: false, error: 'Entry not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Email --------------------------------------------------------------
  ipcMain.handle(
    IPC.emailComposeInvite,
    (_e, payload: { employeeId: string; temporaryPassword: string | null }): Result<ComposedEmail> => {
      try {
        requirePermission('admin.employees.manage')
        const employee = getEmployeeById(payload.employeeId)
        if (!employee) return { ok: false, error: 'Employee not found.' }
        const sender = currentUser()
        const senderName = sender ? `${sender.firstName} ${sender.lastName}` : 'your administrator'
        const email = composeInviteEmail(employee, payload.temporaryPassword, senderName)
        return { ok: true, data: email }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.emailOpenExternal, async (_e, url: string): Promise<Result> => {
    try {
      if (!/^mailto:/i.test(url) && !/^https?:/i.test(url)) {
        return { ok: false, error: 'Refusing to open an unexpected URL scheme.' }
      }
      await shell.openExternal(url)
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Updates (available to any signed-in user) --------------------------
  ipcMain.handle(IPC.updatesGetStatus, (): UpdateStatus => getUpdateStatus())

  ipcMain.handle(IPC.updatesCheck, async (): Promise<UpdateStatus> => {
    guardSignedIn()
    return checkForUpdates()
  })

  ipcMain.handle(IPC.updatesDownload, async (): Promise<UpdateStatus> => {
    guardSignedIn()
    return downloadUpdate()
  })

  ipcMain.handle(IPC.updatesInstall, (): Result => {
    guardSignedIn()
    installUpdate()
    return { ok: true }
  })
}

function guardSignedIn(): void {
  if (!currentUserId_()) {
    throw new PermissionError('You are not signed in.')
  }
}
