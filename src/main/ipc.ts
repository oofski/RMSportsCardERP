import { shell, app, dialog, nativeTheme, BrowserWindow, type OpenDialogOptions } from 'electron'
import { ipcMain } from './ipcRegistry'
import { writeFileSync } from 'fs'
import { IPC, type AppInfo } from '@shared/ipc'
import type {
  AuthResult,
  ClockStatus,
  ComposedEmail,
  Employee,
  EmployeeHoursSummary,
  EmployeeInvite,
  ExportRequest,
  ExportResult,
  NewEmployeeInput,
  NewTimeEntryInput,
  RememberedCredentials,
  Result,
  SessionUser,
  ThemeMode,
  TimeEntry,
  UpdateEmployeeInput,
  UpdateStatus
} from '@shared/types'
import { assignableRoles, roleLabel, sanitizePermissions, type Permission } from '@shared/permissions'
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
  clearEmployeeAvatar,
  companyIdExists,
  emailExists,
  getEmployeeById,
  insertEmployee,
  listEmployees,
  setEmployeeAvatar,
  setEmployeePermissions,
  setTemporaryPassword,
  setPortalPin,
  clearPortalPin,
  updateEmployee
} from './db/employees'
import {
  clockIn as dbClockIn,
  clockOut as dbClockOut,
  deleteTimeEntry,
  getOpenEntry,
  hoursSummary,
  insertTimeEntry,
  listInRange,
  listTimeEntries,
  minutesInRange
} from './db/timeEntries'
import { composeInviteEmail } from './services/email'
import { roughLocation } from './services/location'
import { computePayroll, gustoCsv, timesheetCsv, type GustoRow } from './services/csv'
import { clearRemembered, getRemembered, setRemembered } from './services/credentials'
import { generateTempPassword, isValidEmail } from './util'
import {
  checkForUpdates,
  currentDownloadUrl,
  downloadUpdate,
  getUpdateStatus,
  installUpdate
} from './services/updater'

/** Local day boundaries as ISO strings, for "today" / "this week" totals. */
function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}
function startOfWeek(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const day = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - day)
  return d.toISOString()
}
function nowIsoLocal(): string {
  return new Date().toISOString()
}
function datePart(iso: string): string {
  const d = new Date(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function buildStatus(userId: string): ClockStatus {
  return {
    open: getOpenEntry(userId),
    todayMinutes: minutesInRange(userId, startOfToday(), nowIsoLocal()),
    weekMinutes: minutesInRange(userId, startOfWeek(), nowIsoLocal())
  }
}

/** Effective permission check — honours role grants AND individual overrides. */
function userCan(user: SessionUser, permission: Permission): boolean {
  return user.permissions.includes(permission)
}

/** Return the signed-in user or throw a Result-shaped rejection. */
function requirePermission(permission: Permission): SessionUser {
  const user = currentUser()
  if (!user) {
    throw new PermissionError('You are not signed in.')
  }
  if (!userCan(user, permission)) {
    throw new PermissionError('You do not have permission to do that.')
  }
  return user
}

class PermissionError extends Error {}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

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
    if (!user || !userCan(user, 'admin.employees.view')) return []
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
        if (!assignableRoles(actor.role).includes(input.role)) {
          return { ok: false, error: `You cannot assign the ${input.role} role.` }
        }
        // Whether an address is required, and whether a password has to be
        // typed, both depend on the role — so the whole rule lives in one place
        // rather than half here. The form applies the same rule, but a form is
        // not a trust boundary; this is.
        const dupeError = validateNewEmployee(input)
        if (dupeError) return { ok: false, error: dupeError }

        // A packing bench is shared, so nobody owns its password: the
        // administrator types one and reads it out, the account is usable
        // immediately, and nothing ever prompts for a change the four people
        // using the computer cannot agree on. Every other role still gets a
        // generated password it must replace on first sign-in.
        //
        // The plaintext is split off the record here so it can only travel as
        // the argument that gets hashed, never inside the object the row is
        // built from — where a column added later could pick it up by name.
        const { password: typed, ...details } = input
        const isBench = details.role === 'shipping'
        const temporaryPassword = isBench ? null : generateTempPassword()
        const { employee } = insertEmployee(
          { ...details, status: isBench ? 'active' : undefined },
          actor.id,
          temporaryPassword ?? str(typed),
          !isBench
        )
        // `temporaryPassword` is null for a bench account, and deliberately: the
        // typed password must not travel back out to a modal that would show it,
        // copy it to a clipboard, or paste it into an invite email.
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

        // You may only modify an account whose role you are allowed to manage.
        // Without this, a lower-privileged actor could rewrite a higher one's
        // login identifiers (email / Company ID) and take the account over.
        if (!assignableRoles(actor.role).includes(existing.role)) {
          return { ok: false, error: 'You do not have permission to manage that user.' }
        }
        if (input.role && !assignableRoles(actor.role).includes(input.role)) {
          return { ok: false, error: `You cannot assign the ${input.role} role.` }
        }
        if (input.companyId !== undefined && !str(input.companyId).trim()) {
          return { ok: false, error: 'A Company ID is required.' }
        }
        if (input.companyId && companyIdExists(input.companyId, input.id)) {
          return { ok: false, error: 'That Company ID is already in use.' }
        }
        // Judge the address the account will END UP with against the role it
        // will end up with. Clearing the box and switching Shipping to Staff in
        // the same save is the case that has to be caught, and checking either
        // field on its own misses it. `existing.email` is already blank when
        // there is only a placeholder behind it.
        const nextRole = input.role ?? existing.role
        const nextEmail = input.email !== undefined ? str(input.email).trim() : existing.email
        if (nextEmail) {
          if (!isValidEmail(nextEmail)) {
            return { ok: false, error: 'A valid email address is required.' }
          }
          if (emailExists(nextEmail, input.id)) {
            return { ok: false, error: 'That email address is already in use.' }
          }
        } else if (nextRole !== 'shipping') {
          return {
            ok: false,
            error: `An email address is required for the ${roleLabel(nextRole)} role.`
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
        const actor = requirePermission('admin.employees.manage')
        const employee = getEmployeeById(payload.id)
        if (!employee) return { ok: false, error: 'Employee not found.' }
        // Prevent resetting the password of an account you may not manage
        // (e.g. Operations resetting the Owner and reading the new temp password).
        if (!assignableRoles(actor.role).includes(employee.role)) {
          return { ok: false, error: 'You do not have permission to manage that user.' }
        }
        const temporaryPassword = generateTempPassword()
        setTemporaryPassword(payload.id, temporaryPassword)
        const refreshed = getEmployeeById(payload.id) as Employee
        return { ok: true, data: { employee: refreshed, temporaryPassword } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Set — or take away — the PIN this employee clocks in with on the web.
   *
   * Gated on the same permission as resetting a password and by the same
   * assignable-roles rule, for the same reason: this hands somebody a working
   * credential, and an Operations account must not be able to mint one for the
   * Owner. It is a weaker credential than a password — it only reaches the
   * clock — but "weaker" is not "unguarded".
   *
   * The PIN is chosen by whoever is setting it and returned to them ONCE, in
   * this reply, so they can hand it over. It is never stored in the clear and
   * cannot be read back afterwards; a forgotten PIN is replaced, not recovered.
   */
  ipcMain.handle(
    IPC.employeesSetPortalPin,
    (_e, payload: { id: string; pin: string }): Result<Employee> => {
      try {
        const actor = requirePermission('admin.employees.manage')
        const target = getEmployeeById(payload.id)
        if (!target) return { ok: false, error: 'Employee not found.' }
        if (!assignableRoles(actor.role).includes(target.role)) {
          return { ok: false, error: 'You do not have permission to manage that user.' }
        }
        const res = setPortalPin(payload.id, String(payload.pin || ''))
        if (!res.ok) return { ok: false, error: res.error ?? 'That PIN could not be set.' }
        return { ok: true, data: getEmployeeById(payload.id) as Employee }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.employeesClearPortalPin,
    (_e, payload: { id: string }): Result<Employee> => {
      try {
        const actor = requirePermission('admin.employees.manage')
        const target = getEmployeeById(payload.id)
        if (!target) return { ok: false, error: 'Employee not found.' }
        if (!assignableRoles(actor.role).includes(target.role)) {
          return { ok: false, error: 'You do not have permission to manage that user.' }
        }
        clearPortalPin(payload.id)
        return { ok: true, data: getEmployeeById(payload.id) as Employee }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.employeesSetPermissions,
    (_e, payload: { id: string; permissions: Permission[] }): Result<Employee> => {
      try {
        const actor = requirePermission('admin.roles.manage')
        const target = getEmployeeById(payload.id)
        if (!target) return { ok: false, error: 'Employee not found.' }
        if (!assignableRoles(actor.role).includes(target.role)) {
          return { ok: false, error: 'You do not have permission to manage that user.' }
        }
        const requested = sanitizePermissions(payload.permissions)
        // You can only grant permissions you yourself hold — no escalating a
        // person above the grantor's own access.
        const notAllowed = requested.filter((p) => !userCan(actor, p))
        if (notAllowed.length > 0) {
          return { ok: false, error: 'You can only grant permissions you have yourself.' }
        }
        setEmployeePermissions(payload.id, requested)
        return { ok: true, data: getEmployeeById(payload.id) as Employee }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** Authorize an avatar change: an employee may set their OWN picture, and an
   *  admin may set one for anyone whose role they are allowed to manage. */
  const canEditAvatar = (targetId: string): string | Employee => {
    const user = currentUser()
    if (!user) return 'You are not signed in.'
    const target = getEmployeeById(targetId)
    if (!target) return 'Employee not found.'
    if (user.id === targetId) return target
    if (!userCan(user, 'admin.employees.manage')) return 'You cannot change that profile picture.'
    if (!assignableRoles(user.role).includes(target.role)) {
      return 'You do not have permission to manage that user.'
    }
    return target
  }

  ipcMain.handle(IPC.employeesSetAvatar, async (e, id: string): Promise<Result<Employee>> => {
    try {
      const auth = canEditAvatar(String(id ?? ''))
      if (typeof auth === 'string') return { ok: false, error: auth }
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
      const opts: OpenDialogOptions = {
        title: 'Choose a profile picture',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No image selected.' }
      const updated = setEmployeeAvatar(String(id), picked.filePaths[0])
      return updated ? { ok: true, data: updated } : { ok: false, error: 'Could not set the picture.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.employeesRemoveAvatar, (_e, id: string): Result<Employee> => {
    try {
      const auth = canEditAvatar(String(id ?? ''))
      if (typeof auth === 'string') return { ok: false, error: auth }
      const updated = clearEmployeeAvatar(String(id))
      return updated ? { ok: true, data: updated } : { ok: false, error: 'Could not remove the picture.' }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Hours --------------------------------------------------------------
  ipcMain.handle(IPC.hoursSummary, (): EmployeeHoursSummary[] => {
    const user = currentUser()
    if (!user || !userCan(user, 'admin.hours.view')) return []
    return hoursSummary()
  })

  ipcMain.handle(IPC.hoursList, (_e, employeeId?: string): TimeEntry[] => {
    const user = currentUser()
    if (!user || !userCan(user, 'admin.hours.view')) return []
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

  ipcMain.handle(
    IPC.hoursTimesheet,
    (_e, payload: { employeeId: string; start: string; end: string }): TimeEntry[] => {
      const user = currentUser()
      if (!user || !userCan(user, 'admin.hours.view')) return []
      return listInRange(payload.start, payload.end, payload.employeeId)
    }
  )

  ipcMain.handle(IPC.hoursExport, async (_e, req: ExportRequest): Promise<ExportResult> => {
    try {
      const user = currentUser()
      if (!user || !userCan(user, 'admin.hours.view')) {
        return { ok: false, error: 'You do not have permission to export hours.' }
      }

      let csv: string
      let defaultName: string

      if (req.format === 'gusto') {
        const employees =
          req.scope === 'employee' && req.employeeId
            ? ([getEmployeeById(req.employeeId)].filter(Boolean) as Employee[])
            : listEmployees()
        const rows: GustoRow[] = employees.map((emp) => ({
          employee: emp,
          totals: computePayroll(listInRange(req.start, req.end, emp.id))
        }))
        csv = gustoCsv(rows, req.start, req.end)
        defaultName = `gusto-hours-${datePart(req.start)}_${datePart(req.end)}.csv`
      } else {
        if (!req.employeeId) return { ok: false, error: 'Select an employee.' }
        const emp = getEmployeeById(req.employeeId)
        if (!emp) return { ok: false, error: 'Employee not found.' }
        const entries = listInRange(req.start, req.end, emp.id)
        csv = timesheetCsv(emp, entries)
        defaultName = `timesheet-${emp.companyId}-${datePart(req.start)}_${datePart(req.end)}.csv`
      }

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Export hours',
        defaultPath: defaultName,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }
      writeFileSync(filePath, csv, 'utf8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- Time clock (self-service, any signed-in user) ----------------------
  ipcMain.handle(IPC.clockStatus, (): ClockStatus => {
    const user = currentUser()
    if (!user) return { open: null, todayMinutes: 0, weekMinutes: 0 }
    return buildStatus(user.id)
  })

  ipcMain.handle(IPC.clockIn, async (): Promise<Result<ClockStatus>> => {
    try {
      const user = currentUser()
      if (!user) return { ok: false, error: 'You are not signed in.' }
      if (getOpenEntry(user.id)) return { ok: false, error: "You're already clocked in." }
      const location = await roughLocation()
      dbClockIn(user.id, location)
      return { ok: true, data: buildStatus(user.id) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.clockOut, async (): Promise<Result<ClockStatus>> => {
    try {
      const user = currentUser()
      if (!user) return { ok: false, error: 'You are not signed in.' }
      const open = getOpenEntry(user.id)
      if (!open) return { ok: false, error: "You're not clocked in." }
      const location = await roughLocation()
      dbClockOut(open.id, location)
      return { ok: true, data: buildStatus(user.id) }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Email --------------------------------------------------------------
  ipcMain.handle(
    IPC.emailComposeInvite,
    (_e, payload: { employeeId: string; temporaryPassword: string | null }): Result<ComposedEmail> => {
      try {
        const actor = requirePermission('admin.employees.manage')
        const employee = getEmployeeById(payload.employeeId)
        if (!employee) return { ok: false, error: 'Employee not found.' }
        if (!assignableRoles(actor.role).includes(employee.role)) {
          return { ok: false, error: 'You do not have permission to manage that user.' }
        }
        // No address, no invite to compose. The screen already knows this and
        // shows the credentials to read out instead; this is here so a caller
        // that does not cannot end up with a mailto: pointing nowhere.
        if (!employee.email) {
          return { ok: false, error: 'This employee has no email address.' }
        }
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
  ipcMain.handle(IPC.updatesGetStatus, (): UpdateStatus => {
    guardSignedIn()
    return getUpdateStatus()
  })

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

  // Opens the update download in the browser (macOS manual-install path).
  ipcMain.handle(IPC.updatesOpenDownload, async (_e, url?: string): Promise<Result> => {
    guardSignedIn()
    const target = url ?? currentDownloadUrl()
    if (!target || !/^https:/i.test(target)) {
      return { ok: false, error: 'No download link available.' }
    }
    await shell.openExternal(target)
    return { ok: true }
  })

  // ---- Remembered credentials (pre-login, no session) ---------------------
  ipcMain.handle(IPC.credGet, (): RememberedCredentials | null => getRemembered())

  ipcMain.handle(IPC.credSet, (_e, creds: RememberedCredentials): Result => {
    try {
      if (!creds || typeof creds.identifier !== 'string' || typeof creds.password !== 'string') {
        return { ok: false, error: 'Invalid credentials.' }
      }
      setRemembered(creds)
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.credClear, (): Result => {
    clearRemembered()
    return { ok: true }
  })

  // ---- Theme --------------------------------------------------------------
  ipcMain.handle(IPC.themeSet, (_e, mode: ThemeMode): Result => {
    nativeTheme.themeSource = mode === 'dark' ? 'dark' : 'light'
    return { ok: true }
  })
}

function guardSignedIn(): void {
  if (!currentUserId_()) {
    throw new PermissionError('You are not signed in.')
  }
}
