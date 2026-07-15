import type { Permission, Role } from './permissions'

export type EmployeeStatus = 'invited' | 'active' | 'disabled'

/** An employee record as exposed to the renderer (never includes secrets). */
export interface Employee {
  id: string
  firstName: string
  lastName: string
  companyId: string
  title: string
  email: string
  role: Role
  status: EmployeeStatus
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

export interface NewEmployeeInput {
  firstName: string
  lastName: string
  companyId: string
  title: string
  email: string
  role: Role
}

export interface UpdateEmployeeInput {
  id: string
  firstName?: string
  lastName?: string
  companyId?: string
  title?: string
  email?: string
  role?: Role
  status?: EmployeeStatus
}

/** Returned when an employee is created — carries the one-time temp password. */
export interface EmployeeInvite {
  employee: Employee
  temporaryPassword: string
}

export interface TimeEntry {
  id: string
  employeeId: string
  clockIn: string
  clockOut: string | null
  note: string | null
  source: 'manual' | 'clock'
  createdAt: string
}

export interface NewTimeEntryInput {
  employeeId: string
  clockIn: string
  clockOut: string | null
  note?: string | null
}

/** Aggregated hours for the Admin > Hours view. */
export interface EmployeeHoursSummary {
  employeeId: string
  employeeName: string
  companyId: string
  totalMinutes: number
  entryCount: number
  lastEntryAt: string | null
}

/** The signed-in user, as held by the renderer. */
export interface SessionUser {
  id: string
  firstName: string
  lastName: string
  companyId: string
  title: string
  email: string
  role: Role
  permissions: Permission[]
  mustChangePassword: boolean
}

export interface AuthResult {
  ok: boolean
  user?: SessionUser
  /** Present when ok === false. */
  error?: string
}

/** Result envelope used by mutating IPC calls so the UI can show errors. */
export interface Result<T = void> {
  ok: boolean
  data?: T
  error?: string
}

/** Composed invite email, ready to open in the user's mail client. */
export interface ComposedEmail {
  to: string
  subject: string
  body: string
  mailtoUrl: string
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  /** Version found on the update feed, when one is available. */
  availableVersion?: string
  releaseNotes?: string
  releaseDate?: string
  /** 0–100 while downloading. */
  percent?: number
  bytesPerSecond?: number
  message?: string
}
