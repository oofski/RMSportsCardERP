import type { Permission, Role } from './permissions'

export type EmployeeStatus = 'invited' | 'active' | 'disabled'

/** An employee record as exposed to the renderer (never includes secrets). */
export interface Employee {
  id: string
  firstName: string
  lastName: string
  companyId: string
  title: string
  /**
   * The address, or '' when there is not one — shipping staff and bench
   * stations sign in with their Company ID instead. The column itself is NOT
   * NULL UNIQUE and holds a synthetic value for those accounts; it is stripped
   * before the record leaves the main process, so nothing downstream has to
   * know that. Treat blank as "no address" and print a dash.
   */
  email: string
  role: Role
  status: EmployeeStatus
  mustChangePassword: boolean
  /** Individually-granted permissions on top of the role (special access). */
  extraPermissions: Permission[]
  /** Profile picture as a ready-to-use data URL, or null if none set. */
  avatarUrl: string | null
  /** A person, or a shared bench computer. See AccountKind. */
  accountKind: AccountKind
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

/**
 * A person, or a computer.
 *
 * A station is a shared bench login: no email, no personal identity, and only
 * the permissions the floor needs. It exists because the alternative — giving
 * every packer an employee account with an address they do not have — ends with
 * the whole shift signed in as whoever set the laptop up.
 */
export type AccountKind = 'person' | 'station'

/**
 * A bench computer, not a person.
 *
 * `name` is what the floor calls it ("Packing bench 1"). `code` is what gets
 * typed at sign-in — it becomes the Company ID, because the login already
 * accepts one of those and a station needs no second mechanism. There is no
 * email: that is the entire point.
 */
export interface NewStationInput {
  name: string
  code: string
  password: string
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
  /**
   * How many boxes make up a case. NOT informational — every cases↔boxes
   * conversion in @shared/units divides by it, and a break entered in loose
   * boxes is refused outright while it is null rather than valued by a guess.
   */
  boxesPerCase: number | null
  /**
   * How many packs make up a box. Same contract as `boxesPerCase`: a giveaway
   * entered in packs cannot be valued without it and is refused, because a
   * giveaway silently valued at zero would understate the loss and still look
   * like a working feature.
   */
  packsPerBox: number | null
  /**
   * Whether this product may be held in FRACTIONAL stock units.
   *
   * True only for product deliberately kept as giveaway material. Giving away
   * three packs out of a twelve-pack box really does leave a quarter box on the
   * shelf — but allowing that catalog-wide would let rounding dust accumulate
   * and quietly corrupt the cost basis of stock nobody is giving away. So the
   * fractional path is opt-in per product and everything else stays whole.
   * See `ProductUnits.giveawayItem` in @shared/units.
   */
  giveawayItem: boolean
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
  /** Boxes in one case. Null when unknown — conversions refuse rather than guess. */
  boxesPerCase: number | null
  /** Packs in one box. Null when unknown. */
  packsPerBox: number | null
  /** Opt in to fractional stock. Omitted means false — whole units only. */
  giveawayItem?: boolean
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

/**
 * Every way stock moves. 'stream_break' and 'stream_giveaway' are the Streaming
 * module opening a box on air or giving one away — both consume stock at real
 * FIFO cost, and both are recorded here so the inventory history stays the one
 * complete account of what happened to a product.
 */
export type InventoryTxnType =
  | 'purchase'
  | 'sale'
  | 'restock'
  | 'adjustment'
  | 'stream_break'
  | 'stream_giveaway'

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
  /**
   * Stock on the shelf carried at NO cost, worst first.
   *
   * These are the reason a Spread figure can be nonsense. A product with stock
   * and a zero cost basis contributes its ENTIRE market value to spread, because
   * spread is value − cost and its cost is nothing. Seven such products were
   * enough to make 48% of a real Spread number fictional. They are surfaced
   * beside the tile rather than silently folded into it, because the fix (put
   * the real cost on the product) is one the operator can act on and nobody can
   * act on a number they cannot see inside.
   */
  zeroCost: ZeroCostStock[]
}

export interface ZeroCostStock {
  id: string
  name: string
  quantity: number
  /** What it is being valued at — i.e. how much fake spread it is creating. */
  marketValue: number
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

// ---------------------------------------------------------------------------
// Operating supplies / consumables (bubble mailers, poly bags, labels, tape).
// Tracked separately from sellable products so they never affect inventory
// value or spread.
// ---------------------------------------------------------------------------

export type SupplyUnit = 'each' | 'roll' | 'pack' | 'box' | 'case' | 'other'

export interface Supply {
  id: string
  name: string
  unit: SupplyUnit
  /** On-hand count in individual items (what gets consumed per shipment). */
  quantity: number
  /** Moving weighted-average cost per item. */
  unitCost: number
  /** How many items come in one ordering unit (a box/pack). Default 1. */
  itemsPerUnit: number
  /** Low-stock threshold (in items); 0 disables the alert. */
  reorderPoint: number
  /** Whether this is a repeat/recurring order (mailers, bags, labels…). */
  recurring: boolean
  notes: string | null
  /** Link to reorder this item (e.g. its Amazon product page). */
  reorderUrl: string | null
  /** Photo of the supply, as a ready-to-use data URL (null when none). */
  imageUrl: string | null
  /**
   * Which consumable this row IS, for costing a show — 'team_bag', 'toploader'
   * and so on (see ShipSupplyRole). Null for anything a show's arithmetic does
   * not touch, which is most of the list. At most one supply may hold a role.
   */
  shipRole: string | null
  /** quantity × unitCost (items × per-item cost). */
  stockValue: number
  /** reorderPoint > 0 && quantity <= reorderPoint. */
  lowStock: boolean
  createdAt: string
  updatedAt: string
}

export interface NewSupply {
  name: string
  unit: SupplyUnit
  /** Per-item cost (optional; usually set by logging a purchase). */
  unitCost: number
  /** Items per ordering unit (pack size). Default 1. */
  itemsPerUnit: number
  reorderPoint: number
  recurring: boolean
  notes: string | null
  /** Optional reorder link (e.g. an Amazon product URL). */
  reorderUrl?: string | null
  /** Optional opening on-hand count of items (logged as the first purchase). */
  openingQuantity?: number
}

export type UpdateSupply = Partial<Omit<NewSupply, 'openingQuantity'>> & { id: string }

/**
 * Record a supply purchase as an order: how many units (boxes/packs) were
 * bought, how many items are in each, and the total paid. The per-unit and
 * per-item cost are derived from these.
 */
export interface SupplyPurchaseInput {
  /** Number of ordering units (boxes / packs) bought. */
  units: number
  /** Items in each unit. */
  itemsPerUnit: number
  /** Total paid for the whole order. */
  total: number
  note?: string | null
}

/** Consume supplies. */
export interface SupplyUseInput {
  quantity: number
  note?: string | null
}

export type SupplyTxnType = 'purchase' | 'use' | 'adjustment'

export interface SupplyTransaction {
  id: string
  supplyId: string
  supplyName: string
  type: SupplyTxnType
  quantityChange: number
  unitCost: number | null
  totalCost: number | null
  note: string | null
  actorName: string | null
  createdAt: string
}

export interface SupplyStats {
  itemCount: number
  unitsOnHand: number
  stockValue: number
  lowStockCount: number
  recurringCount: number
  /** Sum of purchase totals this calendar month (operating spend). */
  spendThisMonth: number
  /** Sum of all purchase totals ever. */
  spendAllTime: number
}

export type SupplyOrderStatus = 'ordered' | 'in_transit' | 'delivered' | 'cancelled'

/**
 * Who placed a supply buy. Supply orders share the Purchase Orders board with
 * product POs, so a card has to be able to say this outright rather than
 * leaving the operator to infer it.
 */
export type SupplyOrderSource = 'manual' | 'auto'

/** A reorder moving through the Ordered → In-transit → Delivered pipeline. */
export interface SupplyOrder {
  id: string
  supplyId: string
  supplyName: string
  unit: SupplyUnit
  /** Supply photo (data URL) for the card thumbnail, if any. */
  imageUrl: string | null
  units: number
  itemsPerUnit: number
  /** Items this order adds on delivery (units × itemsPerUnit). */
  items: number
  total: number
  status: SupplyOrderStatus
  source: SupplyOrderSource
  note: string | null
  orderedAt: string | null
  inTransitAt: string | null
  deliveredAt: string | null
  cancelledAt: string | null
  createdAt: string
}

export interface NewSupplyOrder {
  supplyId: string
  units: number
  itemsPerUnit: number
  total: number
  note?: string | null
  /** Only the reorder automation sets this; the form always creates 'manual'. */
  source?: SupplyOrderSource
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
  /** Profile picture as a ready-to-use data URL, or null if none set. */
  avatarUrl: string | null
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
// Purchase orders
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus = 'ordered' | 'paid' | 'received' | 'cancelled'

/** A PO line as sent to the renderer: catalog identity (JOINed) + buy price. */
export interface PurchaseOrderLine {
  id: string
  productId: string
  productName: string
  sku: string
  category: string
  /** Whole units being purchased. */
  quantity: number
  /** Per-unit buy price being paid (future FIFO cost basis). */
  unitPrice: number
  /** quantity × unitPrice. */
  lineTotal: number
  /** Units already folded into stock (by UPC scan or a whole-PO receive). */
  qtyReceived: number
  /** quantity − qtyReceived, floored at 0. */
  qtyOutstanding: number
  /** ISO timestamp qtyReceived first reached quantity (null while outstanding). */
  receivedAt: string | null
}

/** A purchase order header (list/summary row on the kanban board). */
export interface PurchaseOrder {
  id: string
  /** Human PO number, e.g. "PO-0001". */
  poNumber: string
  /** Optional free-text supplier (minimal header for now). */
  supplier: string | null
  notes: string | null
  status: PurchaseOrderStatus
  /** Destination stock location (RM/AM) its cases will be checked into. */
  location: string
  /** Σ(line qty × unit price), stored snapshot. */
  total: number
  /** Number of line items. */
  lineCount: number
  /** How many of those lines are fully received (partial-receipt progress). */
  receivedLineCount: number
  /**
   * Total UNITS checked in across every line, however partially.
   *
   * Distinct from receivedLineCount, which only counts lines received in full —
   * a PO with one line half-received has receivedLineCount 0 and receivedUnits
   * greater than 0. Deletion is refused on exactly this figure, so the board
   * needs it to decide whether to offer Delete at all rather than offering a
   * button whose only outcome is a refusal.
   */
  receivedUnits: number
  createdAt: string
  updatedAt: string
  orderedAt: string | null
  paidAt: string | null
  receivedAt: string | null
  cancelledAt: string | null
  /** When the PO's cases were scanned into stock (idempotency guard). */
  scannedAt: string | null
}

/** A PO with its line items (detail view + receipt). */
export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: PurchaseOrderLine[]
}

/** A Cost-of-Goods-Sold ledger entry recorded when a PO (a purchase) is created. */
export interface CogsEntry {
  id: string
  poId: string
  poNumber: string
  /** = the PO total at creation. */
  amount: number
  /** = the PO creation timestamp. */
  occurredAt: string
  note: string | null
  createdAt: string
}

/** One line when creating a PO. */
export interface NewPurchaseOrderLine {
  productId: string
  quantity: number
  unitPrice: number
}

/** Create a purchase order from catalog line items. */
export interface NewPurchaseOrder {
  supplier?: string | null
  notes?: string | null
  /** Destination stock location (RM/AM); defaults to the first location. */
  location?: string | null
  lines: NewPurchaseOrderLine[]
}

// ---------------------------------------------------------------------------
// UPC scanning
//
// Two steps by design: resolveScan READS a barcode (never writes), commitScan
// performs the single confirmed action. The split is what makes the camera
// decoder — which fires many times a second — safe, and keeps a future phone
// client on exactly the same contract.
// ---------------------------------------------------------------------------

/** Where a scan came from: handheld keyboard wedge, webcam, or typed by hand. */
export type ScanMode = 'wedge' | 'camera' | 'manual'

/**
 * Which way a scanning session moves stock. Chosen BEFORE scanning and held for
 * the whole session — never per line — so the operator can never be halfway
 * through a stack and unsure whether the last beep added or removed.
 *
 * 'in'  raises stock through addStock (PO-linked when a matching open line exists).
 * 'out' lowers it through adjustStock, which consumes FIFO lots — the same path
 *       shrinkage and corrections already use. Taking stock out must never roll
 *       the average cost: what is left cost what it cost.
 */
export type ScanDirection = 'in' | 'out'

/** What resolveScan made of a barcode. */
export type ScanStatus = 'po_line' | 'product' | 'unknown' | 'ambiguous_product'

/** What commitScan did — also the stored `inventory_scans.outcome`. */
export type ScanCommitKind = 'po_line' | 'add_stock' | 'remove_stock'

/** An outstanding PO line a scanned product can be received against. */
export interface ScanPoCandidate {
  lineId: string
  poId: string
  poNumber: string
  supplier: string | null
  status: PurchaseOrderStatus
  /** Destination stock location the PO's cases check into. */
  location: string
  quantity: number
  qtyReceived: number
  qtyOutstanding: number
  /** Per-unit buy price on this line — the FIFO cost basis it will book at. */
  unitPrice: number
  poCreatedAt: string
  /** Advisory: this is the PO's last outstanding line. Auto-completion is
   * decided inside the commit transaction, never from this flag. */
  completesPo: boolean
  poLinesTotal: number
  poLinesOutstanding: number
}

/** One of several catalog products sharing a normalised UPC (dirty legacy data). */
export interface ScanProductMatch {
  id: string
  name: string
  sku: string
  upc: string | null
}

/** Step A: what a scanned barcode means. Read-only — nothing is written. */
export interface ScanResolution {
  status: ScanStatus
  /** Echoed back so the renderer can never queue a line under the wrong
   * direction if the mode changed mid-flight. An 'out' resolution never carries
   * PO candidates: taking stock out must not touch a purchase order. */
  direction: ScanDirection
  /** Exactly what the wedge / camera sent. */
  rawCode: string
  /** Canonical GTIN-14 lookup key; null when nothing usable was scanned. */
  normalizedCode: string | null
  /** The cleaned code, echoed verbatim in the "not recognised" state. */
  cleanedCode: string
  product: InventoryProduct | null
  /** The product's primary photo as a data URL (so the preview shows the box). */
  imageUrl: string | null
  /** Outstanding PO lines, oldest PO first (purchase-side FIFO). */
  candidates: ScanPoCandidate[]
  /** candidates[0].lineId — the preselected choice. */
  defaultLineId: string | null
  /** Populated only for 'ambiguous_product'. */
  productMatches: ScanProductMatch[]
  suggestedQuantity: number
  suggestedUnitCost: number | null
  suggestedLocation: string
  message: string
}

/** Step B: the single confirmed action to perform. */
export interface ScanCommitInput {
  kind: ScanCommitKind
  rawCode: string
  mode: ScanMode
  /** Required for 'po_line'. Commit never re-resolves and re-picks a line. */
  lineId?: string
  /** Required for 'add_stock' and 'remove_stock'. */
  productId?: string
  location?: string
  /** Omitted on a PO line means "receive the rest"; clamped to the outstanding.
   * A repeat-scanned line sends its accumulated count here — ONE commit of
   * quantity N, never N commits of 1. */
  quantity?: number
  /** Inbound only. An outbound scan has no cost input at all: it consumes the
   * FIFO lots that are there, at what they actually cost. */
  unitCost?: number | null
  note?: string | null
  /** Idempotency key for a retry / double-click / future phone client. */
  clientToken?: string
}

export interface ScanCommitResult {
  scanId: string
  kind: ScanCommitKind
  product: InventoryProduct | null
  quantity: number
  unitCost: number | null
  location: string
  /** The PO after receiving, when this was a PO-line scan. */
  po: PurchaseOrderDetail | null
  /** True when this scan received the PO's last outstanding line. */
  poCompleted: boolean
  /** True when a clientToken replayed an earlier commit — nothing was written. */
  replayed: boolean
  /** Toast copy, shown verbatim. */
  message: string
}

/** A row in the scan log (including unrecognised scans). */
export interface ScanRecord {
  id: string
  rawCode: string
  normalizedCode: string | null
  mode: ScanMode
  outcome: ScanCommitKind | 'unknown'
  productId: string | null
  /** Denormalised so history survives a product delete. */
  productName: string | null
  sku: string | null
  poId: string | null
  poNumber: string | null
  poLineId: string | null
  location: string | null
  /** Always POSITIVE — the number of units moved. The direction lives in
   * `outcome` ('remove_stock' took them out), so the log reads the same way the
   * scan station does. */
  quantity: number
  unitCost: number | null
  poCompleted: boolean
  actorName: string | null
  createdAt: string
  undoneAt: string | null
  /** False once any of the received stock has been sold — the UI disables Undo
   * rather than offering an action that is guaranteed to fail. */
  undoable: boolean
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
  platform?: NodeJS.Platform
  /**
   * Can this build install its own update?
   *
   * Decided in main (see services/updater.ts) and sent down, rather than
   * re-derived in the renderer from the platform. The answer is not "is this
   * Windows" — it is "is this build allowed to replace itself", which on macOS
   * depends on whether it was code-signed. Two places deriving that separately
   * is two places to forget when signing is turned on.
   */
  selfUpdating?: boolean
  /** When it cannot self-install, the direct download link to reinstall from. */
  downloadUrl?: string
}
