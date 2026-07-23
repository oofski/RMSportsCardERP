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

/** A catalog product plus its on-hand stock per location. */
export interface InventoryProduct {
  id: string
  sku: string
  upc: string | null
  name: string
  category: string
  brand: string
  setName: string
  year: string
  unitType: UnitType
  /** Informational: how many boxes make up a case. */
  boxesPerCase: number | null
  /** Informational: how many packs make up a box. */
  packsPerBox: number | null
  /** Average cost per unit (what we paid). */
  unitCost: number
  /** Current top bid / market value per unit. Drives inventory value + spread. */
  highBid: number | null
  /** Default asking price per unit (optional). */
  salePrice: number | null
  /** Low-stock threshold (on total across locations). */
  reorderPoint: number
  notes: string | null
  /** On-hand quantity per location, e.g. { RM: 4, AM: 2 }. */
  quantityByLocation: Record<string, number>
  /** Total on hand across all locations. */
  quantity: number
  createdAt: string
  updatedAt: string
}

export interface NewInventoryProduct {
  sku: string
  upc: string | null
  name: string
  category: string
  brand: string
  setName: string
  year: string
  unitType: UnitType
  boxesPerCase: number | null
  packsPerBox: number | null
  unitCost: number
  highBid: number | null
  salePrice: number | null
  reorderPoint: number
  notes: string | null
  /** Optional opening stock so a new product can go straight into a location. */
  openingQuantity?: number
  openingLocation?: string
}

export type UpdateInventoryProduct = Partial<Omit<NewInventoryProduct, 'openingQuantity' | 'openingLocation'>> & {
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
  location: string | null
  note: string | null
  actorName: string | null
  createdAt: string
}

/** Add received stock to a product at a location. */
export interface AddStockInput {
  productId: string
  location: string
  quantity: number
  unitCost?: number | null
  note?: string | null
}

/** Correct a location's count up or down. */
export interface AdjustStockInput {
  productId: string
  location: string
  quantityChange: number
  note?: string | null
}

export interface RecordSaleInput {
  productId: string
  location: string
  quantity: number
  unitPrice: number
  client: string
  note?: string | null
}

export interface InventoryStats {
  /** Market value on hand = Σ (qty × high bid, falling back to unit cost). */
  totalValue: number
  /** Cost basis on hand = Σ (qty × average unit cost). */
  totalCost: number
  /** totalValue − totalCost. */
  spread: number
  boxes: number
  cases: number
  packs: number
  singles: number
  units: number
  skuCount: number
  /** Products with stock at or below their reorder point. */
  lowStockCount: number
  salesRevenue: number
  salesCount: number
  /** Total on-hand units per location. */
  unitsByLocation: Record<string, number>
}

export type IncomingStatus = 'expected' | 'received' | 'cancelled'

/** A shipment of stock on its way in (an expected delivery / purchase order). */
export interface IncomingShipment {
  id: string
  productId: string
  productName: string
  sku: string
  category: string
  location: string
  quantity: number
  /** What we expect to pay per unit — folds into average cost when received. */
  unitCost: number | null
  /** Vendor / PO / tracking reference (optional). */
  reference: string | null
  /** ISO date the shipment is expected (optional). */
  expectedDate: string | null
  status: IncomingStatus
  note: string | null
  createdAt: string
  receivedAt: string | null
}

/** Log an expected shipment of stock coming in. */
export interface NewIncomingShipment {
  productId: string
  location: string
  quantity: number
  unitCost?: number | null
  reference?: string | null
  expectedDate?: string | null
  note?: string | null
}

/** A product photo, delivered to the renderer as a ready-to-use data URL. */
export interface ProductImage {
  id: string
  /** base64 `data:` URL for direct use in an <img src>. */
  dataUrl: string
  position: number
}

/** A FIFO cost layer: a dated batch of stock bought at a unit cost. */
export interface ProductLot {
  id: string
  productId: string
  location: string
  qtyReceived: number
  qtyRemaining: number
  unitCost: number
  receivedAt: string
  /** How the lot was created: restock | opening | adjustment | backfill. */
  source: string
}

/** A row on the Daily Pricing screen (in-stock products with derived money). */
export interface PricingRow {
  id: string
  name: string
  sku: string
  category: string
  unitType: UnitType
  quantity: number
  /** Average cost per unit (FIFO remaining-lot weighted average). */
  unitCost: number
  highBid: number | null
  /** ISO timestamp the high bid was last set. */
  highBidAt: string | null
  /** quantity × (high bid, falling back to average cost). */
  invValue: number
  /** invValue − quantity × average cost. */
  spread: number
}

/** Per-category rollup for the dashboard. */
export interface CategorySummary {
  category: string
  cases: number
  boxes: number
  units: number
  value: number
  productCount: number
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
