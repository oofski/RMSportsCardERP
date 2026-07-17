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
  /** Individually-granted permissions on top of the role (special access). */
  extraPermissions: Permission[]
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

/** A rough (city-level) location captured at a punch. */
export interface PunchLocation {
  place: string | null
  lat: number | null
  lng: number | null
}

export interface TimeEntry {
  id: string
  employeeId: string
  clockIn: string
  clockOut: string | null
  note: string | null
  source: 'manual' | 'clock'
  createdAt: string
  clockInLocation: PunchLocation
  clockOutLocation: PunchLocation
}

export interface NewTimeEntryInput {
  employeeId: string
  clockIn: string
  clockOut: string | null
  note?: string | null
}

/** State of the signed-in user's own time clock (Home widget). */
export interface ClockStatus {
  open: TimeEntry | null
  todayMinutes: number
  weekMinutes: number
}

export type ExportFormat = 'timesheet' | 'gusto'

export interface ExportRequest {
  scope: 'employee' | 'team'
  employeeId?: string
  start: string
  end: string
  format: ExportFormat
}

export interface ExportResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export interface RememberedCredentials {
  identifier: string
  password: string
}

export type ThemeMode = 'light' | 'dark'

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type UnitType = 'case' | 'box' | 'pack' | 'single' | 'other'

export interface InventoryProduct {
  id: string
  sku: string
  name: string
  category: string
  brand: string
  setName: string
  year: string
  unitType: UnitType
  quantity: number
  /** What we paid per unit. */
  unitCost: number
  /** Default asking price per unit (optional). */
  salePrice: number | null
  /** Informational: how many boxes make up a case. */
  boxesPerCase: number | null
  /** Informational: how many packs make up a box. */
  packsPerBox: number | null
  /** Low-stock threshold. */
  reorderPoint: number
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface NewInventoryProduct {
  sku: string
  name: string
  category: string
  brand: string
  setName: string
  year: string
  unitType: UnitType
  quantity: number
  unitCost: number
  salePrice: number | null
  boxesPerCase: number | null
  packsPerBox: number | null
  reorderPoint: number
  notes: string | null
}

export interface UpdateInventoryProduct extends Partial<NewInventoryProduct> {
  id: string
}

export type InventoryTxnType = 'purchase' | 'sale' | 'restock' | 'adjustment'

export interface InventoryTransaction {
  id: string
  productId: string
  productName: string
  sku: string
  type: InventoryTxnType
  /** Positive for stock in, negative for stock out. */
  quantityChange: number
  /** Sale price (sales) or unit cost (purchases/restock). */
  unitPrice: number | null
  /** Client (sale) or vendor (purchase). */
  counterparty: string | null
  note: string | null
  actorName: string | null
  createdAt: string
}

export interface RecordSaleInput {
  productId: string
  quantity: number
  unitPrice: number
  client: string
  note?: string | null
}

export interface AdjustStockInput {
  productId: string
  type: 'restock' | 'adjustment'
  quantityChange: number
  /** Unit cost for a restock. */
  unitCost?: number | null
  note?: string | null
}

export interface InventoryStats {
  totalValue: number
  boxes: number
  cases: number
  packs: number
  singles: number
  units: number
  skuCount: number
  lowStockCount: number
  salesRevenue: number
  salesCount: number
}

export interface CategoryValue {
  category: string
  value: number
  units: number
}

export interface SalesPoint {
  /** Day-of-month label. */
  label: string
  revenue: number
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
  /** Platform for which auto-install applies (windows) vs manual download (mac). */
  platform?: NodeJS.Platform
  /** On platforms without auto-install (macOS unsigned), the direct download link. */
  downloadUrl?: string
}
