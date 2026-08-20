import type { CostLot, LotPick } from './costLots'
import type { Carrier, PaymentTiming } from './freight'
import type { ShipStatusCode } from './shippingTypes'
import type { Permission, Role } from './permissions'
import type { InvoiceStatus } from './invoices'
// Type-only, so it is erased at compile time and the cycle with
// ./purchaseOrders (which imports PurchaseOrderStatus from here) never exists
// at runtime.
import type { OrderKind } from './purchaseOrders'

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
  /** A person, or a legacy shared bench computer. See AccountKind. */
  accountKind: AccountKind
  /**
   * True when this login is a PLACE rather than a person — a shared packing
   * bench that several people sit at under one set of details.
   *
   * Its holder cannot change the password: `setChosenPassword` revokes every
   * other session for the account, so one packer pressing it signs the rest of
   * the floor out mid-shift. An administrator sets a new one and reads it out.
   *
   * Deliberately NOT derived from the role. Real employees work on the shipping
   * role, and treating the role as the answer locked every one of them out of
   * their own credential. See the v75 migration.
   */
  sharedAccount: boolean
  /**
   * Can this person clock in on the web portal — i.e. has a PIN been set?
   *
   * Deliberately a boolean and not the hash. The credential is needed by the
   * Cloudflare Worker and by the one file that writes it, and by nothing on a
   * screen; shipping it to the renderer would put it in a place where somebody
   * could reasonably decide to render it.
   */
  hasPortalPin: boolean
  /** When that PIN was last set, for the admin list. Null if there is none. */
  portalPinSetAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

/**
 * A person, or a computer.
 *
 * 'station' is history. Shared bench logins were once their own kind of account
 * — no email, no personal identity, only the floor's permissions — and the
 * shipping ROLE replaced them: it gives a real person the same narrow access,
 * so the shop has one way to put somebody at a packing computer instead of two.
 * Nothing creates a station any more, but rows created while it existed are
 * still on disk (they own time entries and picked cards, so deleting them would
 * throw away work), and the picking bench still excludes them from its roster.
 * The field reports what a row says; it is never written as anything but
 * 'person'.
 */
export type AccountKind = 'person' | 'station'

export interface NewEmployeeInput {
  firstName: string
  lastName: string
  companyId: string
  title: string
  email: string
  role: Role
  /**
   * The password an administrator types for a SHIPPING account, which is
   * required for that role and ignored for every other one.
   *
   * A packing computer is shared by whoever is on shift, so the usual flow —
   * generate a temporary password, make them choose their own on first sign-in
   * — has nobody to address: the first person to sit down would change it out
   * from under the other three. The administrator sets one and reads it out.
   * Validated in main (see validateNewEmployee); the form is not the boundary.
   */
  password?: string
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
  /**
   * Mark this login as a shared bench, or clear it.
   *
   * Omitted leaves it alone, so every existing caller — and every form that does
   * not show the box — keeps whatever the account already said.
   */
  sharedAccount?: boolean
}

/** Returned when an employee is created — carries the one-time temp password. */
export interface EmployeeInvite {
  employee: Employee
  /**
   * The generated temporary password, or null when there is nothing to hand
   * over: a shipping account is created with a password the administrator
   * typed and already knows. Echoing it back would only put a live credential
   * on a screen — and into a clipboard button — for no reason.
   */
  temporaryPassword: string | null
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

/**
 * A file the CLIENT sends up, rather than a path the backend opens.
 *
 * Six operations used to start by opening a native file picker in the main
 * process — the ledger CSV, the count sheet, the packing-slip PDF and three
 * images. That works only where the backend and the person are the same
 * computer. In a browser they are not, and a server that took a path instead
 * would be offering to read any file it can reach to anybody who can name one.
 *
 * So those operations take content. Exactly one of `text` (CSV/TSV) or `base64`
 * (PDF, image) is set; `filename` is carried because the import records and the
 * stored image extension are both derived from the name the operator chose.
 * Omit the whole argument on the desktop and the native picker still runs.
 */
export interface UploadedFile {
  filename: string
  text?: string
  base64?: string
  /**
   * What the browser said the file is, when it said anything.
   *
   * Optional because every upload that predates it managed without: those are
   * spreadsheets and PDFs whose handler already knows what it is being handed.
   * It matters for a file that is STORED and handed back later — a shipping
   * label is opened by an OS that decides what to launch from the content type,
   * and a PDF served as an image is a file nothing will open.
   *
   * Never trusted on its own. It comes from the browser, so the receiving end
   * checks it against a list of what it is willing to keep — see
   * validateOrderDocument — rather than storing whatever a page claimed.
   */
  mimeType?: string
}

export interface RememberedCredentials {
  identifier: string
  password: string
}

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
  /**
   * Cost basis of everything on hand, read from the FIFO cost layers.
   *
   * Carried on the product rather than left to be recomputed as quantity ×
   * unitCost, because that multiplication is where money disappears: unitCost is
   * a rounded per-unit average, and 3 boxes at $10 plus 4 at $20 is $110.00 of
   * stock that 7 × $15.7143 cannot express. Every screen showing a total cost
   * for a product reads this.
   */
  costValue: number
  /**
   * Market value of everything on hand: quantity × high bid when a bid is set,
   * and the cost basis when it is not — so unpriced stock carries exactly zero
   * spread rather than a rounding residue.
   */
  marketValue: number
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
  /**
   * Who it was bought from. Stamped on the cost layer this receipt opens, so the
   * picker can later tell two layers of the same product apart by more than
   * their price. Optional and never guessed — a receipt with nobody named opens
   * a layer with no vendor, which is the truth about it.
   */
  vendor?: string | null
}

/** Correct a location's count up or down. */
export interface AdjustStockInput {
  productId: string
  location: string
  quantityChange: number
  note?: string | null
  /**
   * Which cost layers a DOWNWARD correction comes out of, as chosen in the
   * picker. Absent means there was nothing to decide and the oldest layers are
   * consumed — the behaviour every caller had before the picker existed.
   *
   * A picker that was shown and CANCELLED must never arrive here as an absent
   * allocation: the caller abandons the whole action instead, because booking
   * oldest-first while the operator believes they chose is the failure the
   * dialog exists to prevent.
   */
  allocation?: LotPick[] | null
}

export interface RecordSaleInput {
  productId: string
  location: string
  quantity: number
  unitPrice: number
  client: string
  note?: string | null
  /** The operator's cost-layer choice. See AdjustStockInput.allocation. */
  allocation?: LotPick[] | null
}

export interface InventoryStats {
  /**
   * Market value on hand = Σ over products of (qty × high bid) where a bid is
   * set, and of the cost basis where none is.
   */
  totalValue: number
  /**
   * Cost basis on hand, summed from the FIFO cost layers — Σ over shelves of
   * what each shelf actually holds. NOT Σ (qty × average unit cost): an average
   * is a rounded rate and multiplying it back up by the quantity multiplies the
   * rounding by the quantity too.
   */
  totalCost: number
  /**
   * What the stock on hand stands to make — and NOT totalValue − totalCost.
   *
   * A box may be taken into stock with no unit cost (the field is optional,
   * deliberately: boxes get picked up ad hoc and there is often no figure to
   * hand). Stock carried at nothing used to report its whole high bid as profit,
   * because spread was a subtraction and its cost was zero. So an uncosted BOX
   * now contributes exactly zero here, the same answer an unpriced product has
   * always got, and its market value is reported in `outsideSpreadValue`.
   *
   * Only boxes. A case, a pack or a single with no cost still contributes its
   * whole market value, exactly as before — a case is a deliberate four-figure
   * purchase whose price is known when it is bought, and money that size must
   * not be able to leave this figure quietly. The zero-cost banner goes on
   * naming those the way it always has.
   */
  spread: number
  /**
   * Market value on hand that `spread` is NOT speaking for — uncosted boxes.
   *
   * Returned so the difference can be stated on screen rather than discovered:
   * totalValue − totalCost = spread + outsideSpreadValue, exactly, and without
   * this field the three tiles would be a subtraction that does not reconcile.
   * It is the same money the `outsideSpread` rows of `zeroCost` name.
   */
  outsideSpreadValue: number
  /** How many products that is. */
  outsideSpreadCount: number
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
   * Every row here is money the app cannot fully account for; `outsideSpread`
   * says which way. A BOX with no cost is market value the Spread is leaving
   * out — an incomplete number, and the amount is `outsideSpreadValue`.
   * Anything else with no cost is market value the Spread is still counting as
   * profit — a wrong number, which is what this list was built for: seven such
   * products were once enough to make 48% of a real Spread fictional.
   *
   * Both are surfaced beside the tile rather than folded into it, because the
   * fix (put the real cost on the product) is one the operator can act on and
   * nobody can act on a number they cannot see inside.
   */
  zeroCost: ZeroCostStock[]
  /**
   * Shelves whose cost layers do not account for the stock counted on them.
   *
   * The valuation always follows the QUANTITY — a shelf is valued for exactly
   * the units inventory_stock says are on it — so a total can never contradict
   * the count beside it. But where the layers disagree, part of the money is
   * coming from the product's average rather than from a real purchase price
   * (stock above layers), or a cost basis is attached to units nobody has
   * (layers above stock). Neither is visible in a total, so both are listed.
   */
  layerGaps: StockLayerGap[]
}

export interface ZeroCostStock {
  id: string
  name: string
  quantity: number
  /**
   * What it is being valued at — which is how much market value the Spread is
   * holding out (`outsideSpread`), or how much fake spread it is creating.
   */
  marketValue: number
  /**
   * True when this is a BOX, and therefore stock the Spread now excludes rather
   * than inflates. Decided next to the arithmetic that does the excluding, so
   * the banner describes the tile instead of guessing at it.
   */
  outsideSpread: boolean
}

/**
 * What happened when a cost basis was put on stock that had none.
 *
 * `costValue` is the point of the shape. Setting a product's average cost only
 * clears the zero-cost banner when the stock has no cost LAYERS — the valuation
 * reads layers first — so the operation re-bases the layers that are carrying
 * nothing as well, and then reports what the product is actually worth
 * afterwards. The caller shows that rather than assuming the fix landed.
 */
export interface CostBasisFix {
  product: InventoryProduct
  /** Open layers that were carrying nothing and now carry the stated cost. */
  layersRevalued: number
  /** The product's cost basis after the write, read the way the banner reads it. */
  costValue: number
}

/** One shelf where Σ lot.qty_remaining and inventory_stock.quantity disagree. */
export interface StockLayerGap {
  id: string
  name: string
  location: string
  /** On hand there, per inventory_stock — the number the valuation follows. */
  quantity: number
  /** What the open cost layers there account for. */
  lotQuantity: number
  /** The per-unit basis used for this shelf. */
  unitBasis: number
  /** What the shelf contributes to every total. */
  value: number
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

/**
 * Everything the cost-lot picker draws itself from, for one product at one
 * location.
 *
 * `averageCost` rides along because the owner asked for it to stay visible while
 * the choice is being made: "the $1,550 lot" means nothing without knowing the
 * shelf averages $1,510. It is a REFERENCE FIGURE and nothing books against it —
 * what books is the blend of the layers actually allocated.
 */
export interface LotPickerData {
  productId: string
  productName: string
  unitType: UnitType
  location: string
  /** The product's stored weighted average per stock unit. Never the basis. */
  averageCost: number
  lots: CostLot[]
}

/** A row on the Daily Pricing screen (in-stock products with derived money). */
export interface PricingRow {
  id: string
  name: string
  sku: string
  category: string
  unitType: UnitType
  quantity: number
  /**
   * Average cost per unit — derived back out of `costValue`, so it is the
   * per-unit view of the exact basis rather than the number the basis was
   * (wrongly) reconstructed from.
   */
  unitCost: number
  /** Cost basis of everything on hand, from the FIFO cost layers. */
  costValue: number
  highBid: number | null
  /** ISO timestamp the high bid was last set. */
  highBidAt: string | null
  /** quantity × high bid when priced; the cost basis when not. */
  invValue: number
  /**
   * An uncosted BOX: stock with no basis under it, which the Spread leaves out
   * rather than counting whole. Same gate as the dashboard — see InventoryStats.
   */
  outsideSpread: boolean
  /** invValue − costValue, or zero when `outsideSpread`. */
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
  /** True for a shared bench login, which cannot change its own password. */
  sharedAccount: boolean
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
  /**
   * Effective supplier once inheritance is resolved (allocation → line →
   * header). Null when the line's splits name different suppliers, because
   * there is no one answer to show in a single cell.
   */
  supplier: string | null
  /** Effective destination, same inheritance. Null when the splits differ. */
  destination: string | null
  /**
   * Units bound for RM or AM — the denominator every progress bar and every
   * completion test measures against.
   *
   * Equals `quantity` on EVERY line that predates dropship, because a line with
   * no allocation rows is one implicit allocation at the header's location, and
   * every header before this feature held RM or AM. That identity is what makes
   * the whole migration a no-op for existing orders.
   */
  qtyReceivable: number
  /** Empty when the line is not split. Never a single full-quantity row. */
  allocations: PurchaseOrderAllocation[]
}

/**
 * A slice of a line: some of its units, going one place, bought from one party.
 *
 * ## Zero rows is the important case
 *
 * A line with NO allocations is a line with ONE implicit allocation of its
 * whole quantity, at the line's effective supplier and destination. That is not
 * a convenience — it is the entire back-compat mechanism. Every purchase order
 * in the database before this feature has zero allocation rows and keeps
 * behaving byte for byte as it did, because the code path that reads "no rows"
 * produces exactly what the code path that read the header used to produce.
 *
 * The migration therefore writes NO allocation rows for any existing order.
 *
 * ## Invariants the write path enforces
 *
 * SQLite cannot express a cross-row sum, so these are checked in code before
 * any insert, and the whole order is refused if one fails:
 *
 *   I1  Σ allocations.quantity = line.quantity
 *   I2  Σ allocations.qtyReceived = line.qtyReceived
 *   I4  qtyReceived stays 0 forever on a drop allocation — nothing receives one
 *   I5  quantity ≥ 1; a zero-quantity split is deleted, never stored
 */
export interface PurchaseOrderAllocation {
  id: string
  quantity: number
  /** Effective supplier after inheritance. */
  supplier: string | null
  /** Effective destination after inheritance. Always canonically spelled. */
  destination: string
  /** destinationHoldsStock(destination) — RM or AM, and nothing else. */
  holdsStock: boolean
  /** Always 0 on a drop allocation (I4). */
  qtyReceived: number
  qtyOutstanding: number
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
  /**
   * The order's DEFAULT destination — where units go unless a line or an
   * allocation says otherwise.
   *
   * Still called `location`, and deliberately so. Renaming the column would
   * break sync in a way nobody would diagnose from the symptom: `upsertFor`
   * discovers columns via PRAGMA table_info and silently drops any the
   * receiving database does not have, so during a staggered rollout a new
   * laptop's `destination` would be dropped by an old one and an old laptop's
   * `location` would be dropped by a new one. Both directions end with a
   * dropship that quietly became an RM purchase order. Widening the meaning of
   * the column costs one comment; renaming it costs a data incident.
   *
   * Since v67 this may hold a vendor or customer name, not only RM/AM. Ask
   * `destinationHoldsStock` before writing stock against it — never `isLocation`
   * on a raw header value, and never assume it is a shelf.
   */
  location: string
  /**
   * The sales order raised against this purchase, on a dropship. Null otherwise.
   *
   * Buying from one party and selling to another is TWO documents — money out
   * and money in — and this is the only thing recording that a particular pair
   * are the same deal. By ID and never by number: sync REWRITES po_number on a
   * cross-machine collision (see RELABEL_ON_CONFLICT), so a link keyed on the
   * number would silently repoint at whatever order inherited it.
   *
   * Both halves stay independent. Deleting or cancelling one must not take the
   * other with it — they are separate commitments to separate people, and a
   * supplier is still owed for goods they shipped even if the buyer fell
   * through.
   */
  linkedInvoiceId: string | null
  /**
   * Is the sale this order supplies still waiting on the goods?
   *
   * Null when there is no linked sale, which is most purchase orders — and that
   * is deliberately distinct from `false`, which means there IS one and it has
   * what it needs. A board that folded the two together would light up every
   * ordinary purchase.
   */
  saleAwaitsItems?: boolean | null
  /**
   * The deal ticket this document answers to — the GROUP's number when it has
   * been folded in with others, not its own retired one. Null on anything
   * raised before the register existed.
   */
  dealTicket?: string | null
  /** Was this folded under another document's ticket? */
  dealTicketMerged?: boolean
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
  /**
   * Total UNITS on the order — Σ(line quantity), the denominator receivedUnits
   * is measured against.
   *
   * Distinct from lineCount, and the distinction is the whole reason partial
   * receiving needed a number of its own: nine items can be thirty-eight units,
   * and "9 items" says nothing about whether twenty-three of them turned up.
   */
  orderedUnits: number
  /**
   * Stock, drop or mixed — derived from where the units are going, never
   * stored. See `orderKindOf` in @shared/purchaseOrders for why a stored flag
   * would be a second source of truth that drifts on the first re-route.
   */
  orderKind: OrderKind
  /**
   * Units bound for RM or AM. `orderedUnits` on every order that predates
   * dropship, and the denominator of every progress figure after it.
   */
  receivableUnits: number
  /** orderedUnits − receivableUnits. Zero on every legacy order. */
  dropshipUnits: number
  /** How many distinct destinations the order's units are going to. */
  destinationCount: number
  createdAt: string
  updatedAt: string
  orderedAt: string | null
  paidAt: string | null
  receivedAt: string | null
  cancelledAt: string | null
  /** When the PO's cases were scanned into stock (idempotency guard). */
  scannedAt: string | null
  /** Who is carrying it — see @shared/freight. Null until somebody says. */
  carrier: Carrier | null
  /** The carrier's own service name, e.g. "Ground". Free text by design. */
  service: string | null
  trackingNumber: string | null
  /** Front or upon delivery. Null is a real answer: nobody has decided. */
  paymentTiming: PaymentTiming | null
  /**
   * Where the carrier says the package has got to, and when we last managed to
   * read that. Null status means nobody has read it yet — NOT "no movement".
   */
  trackingStatus: ShipStatusCode | null
  trackingStatusDetail: string | null
  trackingStatusAt: string | null
  trackingCheckedAt: string | null
  /** Why the LAST attempt failed, if it did. Null once one succeeds. */
  trackingError: string | null
  /** When we last ASKED — distinct from checkedAt, which means we got an answer. */
  trackingAttemptedAt: string | null
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
  /** Omit or null to inherit the header's supplier. Store the inheritance. */
  supplier?: string | null
  /** Omit or null to inherit the header's destination. */
  destination?: string | null
  /**
   * Split this line's units across destinations. Omit (or pass an empty array)
   * for an unsplit line — which writes NO allocation rows at all, and is what
   * keeps an ordinary order identical to one raised before this feature.
   *
   * Σ quantity must equal the line's quantity (I1) and each must be ≥ 1 (I5);
   * the whole order is refused by name if either fails.
   */
  allocations?: Array<{ quantity: number; supplier: string | null; destination: string }>
}

/**
 * A re-route of an order that already exists.
 *
 * Two independent halves, either of which may be omitted: `lines` changes where
 * a whole line goes, `splits` replaces a line's allocation set outright.
 * Replacing rather than patching the set is deliberate — a partial patch would
 * need a rule for what happens to the rows it did not mention, and every such
 * rule can leave Σ allocations ≠ line.quantity (I1) behind somebody's back.
 *
 * An empty `allocations` array means "not split": the rows are deleted and the
 * line goes back to being one implicit allocation. That is how a split is
 * undone, and it is why the unsplit state stores nothing rather than storing a
 * single full-quantity row.
 */
export interface PoRoutingPatch {
  lines?: Array<{ lineId: string; supplier?: string | null; destination?: string | null }>
  splits?: Array<{
    lineId: string
    allocations: Array<{ id?: string; quantity: number; supplier: string | null; destination: string }>
  }>
}

/** Create a purchase order from catalog line items. */
export interface NewPurchaseOrder {
  supplier?: string | null
  notes?: string | null
  /** Destination stock location (RM/AM); defaults to the first location. */
  location?: string | null
  carrier?: Carrier | null
  service?: string | null
  trackingNumber?: string | null
  paymentTiming?: PaymentTiming | null
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

/**
 * What resolveScan made of a barcode.
 *
 *   po_line            inbound, and it matched an open purchase order line
 *   so_line            outbound, and it matched an open sales order line
 *   no_order           the product is known but nothing open matches it. NOT an
 *                      error and NOT a silent stock movement — a question, with
 *                      an override the operator has to choose.
 *   product            known product, no order matching applies
 *   unknown            the barcode is in no catalog row
 *   ambiguous_product  one barcode, two catalog rows (legacy data)
 */
export type ScanStatus =
  | 'po_line'
  | 'so_line'
  | 'no_order'
  | 'product'
  | 'unknown'
  | 'ambiguous_product'

/** What commitScan did — also the stored `inventory_scans.outcome`. */
export type ScanCommitKind = 'po_line' | 'so_line' | 'add_stock' | 'remove_stock'

/**
 * Why a scan that did not fit was allowed through anyway.
 *
 * Stored on the scan row, never inferred. A stock movement whose reason lives
 * only in somebody's memory is the one nobody can explain a month later.
 */
export type ScanOverride =
  /** More units than the order asked for, taken in (or out) regardless. */
  | 'overage'
  /** The barcode matched no open order and the operator moved it anyway. */
  | 'no_order'

/** An outstanding PO line a scanned product can be received against. */
export interface ScanPoCandidate {
  lineId: string
  poId: string
  poNumber: string
  supplier: string | null
  status: PurchaseOrderStatus
  /**
   * Which slice of the line this candidate is. Null for an unsplit line — the
   * one implicit allocation — which is every line raised before dropship.
   *
   * A line split 6 → RM and 6 → AM produces TWO candidates with distinct ids.
   * That is deliberate: which shelf six boxes land on is the operator's call,
   * and silently picking the first would misplace them with no way to notice.
   */
  allocationId: string | null
  /**
   * The ALLOCATION's destination, not the header's. Always RM or AM by
   * construction — drop allocations never become candidates, because those
   * boxes are not in the building to be scanned.
   */
  location: string
  quantity: number
  qtyReceived: number
  qtyOutstanding: number
  /** Per-unit buy price on this line — the FIFO cost basis it will book at. */
  unitPrice: number
  poCreatedAt: string
  /**
   * Advisory: this is the PO's last outstanding SLICE, so receiving it in full
   * leaves nothing else due at this building. Auto-completion is decided inside
   * the commit transaction, never from this flag.
   *
   * Per allocation, not per line. A line split 6 → RM and 6 → AM is one
   * outstanding line and two outstanding candidates; counting lines told both
   * candidates they finished the order, and the operator saw "completes this
   * PO" on a scan that leaves six boxes still due.
   */
  completesPo: boolean
  poLinesTotal: number
  poLinesOutstanding: number
}

/**
 * An open SALES order line a scanned product can be fulfilled against — the
 * mirror of ScanPoCandidate on the way out of the building.
 *
 * Same shape, deliberately: the two directions are one job with the sign
 * flipped, and a screen that had to speak two vocabularies to say "3 of 5" in
 * each would grow two of everything.
 */
export interface ScanSoCandidate {
  lineId: string
  invoiceId: string
  invoiceNumber: string
  customerName: string | null
  status: InvoiceStatus
  quantity: number
  qtyFulfilled: number
  qtyOutstanding: number
  /** What it is being sold for. Never a cost — outbound never touches basis. */
  unitPrice: number
  invoiceDate: string
  /** Advisory: this is the order's last outstanding line. */
  completesOrder: boolean
  orderLinesTotal: number
  orderLinesOutstanding: number
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
  /** Outstanding SALES order lines, oldest order first. Outbound only. */
  soCandidates: ScanSoCandidate[]
  /** candidates[0].lineId / soCandidates[0].lineId — the preselected choice. */
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
  /** Required for 'po_line' and 'so_line'. Commit never re-resolves and
   * re-picks a line. */
  lineId?: string
  /**
   * Which allocation of that line, when the operator picked between two shelves.
   * Null or omitted resolves the line's stock allocations in position order,
   * which for an unsplit line is the one implicit allocation — i.e. exactly the
   * behaviour every scan had before dropship existed.
   */
  allocationId?: string | null
  /**
   * The operator's answer to a scan that did not fit.
   *
   * Required to exceed an order's outstanding quantity, and required to move
   * stock for a product no open order covers. Absent means the scan fitted, and
   * the commit refuses anything that does not — an override has to be chosen,
   * never assumed from the numbers.
   */
  override?: ScanOverride | null
  /** Required for 'add_stock' and 'remove_stock'. */
  productId?: string
  location?: string
  /** Omitted on a PO line means "receive the rest"; clamped to the outstanding.
   * A repeat-scanned line sends its accumulated count here — ONE commit of
   * quantity N, never N commits of 1. */
  quantity?: number
  /** Inbound only. An outbound scan has no cost input at all: it consumes the
   * cost layers that are there, at what they actually cost. */
  unitCost?: number | null
  note?: string | null
  /**
   * Outbound only: which cost layers this scan takes its stock out of.
   *
   * Asked at CONFIRM time rather than when the barcode beeps, because repeat
   * scans of one code accumulate into a single line and an allocation chosen
   * against a count of 1 would be wrong by the time the line reads 5. Absent
   * means there was nothing to decide and the oldest layers are consumed, as
   * they always were.
   */
  allocation?: LotPick[] | null
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
  /**
   * Is a software update a thing that can happen to this copy at all?
   *
   * False in the browser, and it is NOT the same question as `selfUpdating`. An
   * unsigned Mac build answers false to that one and is still updatable — a
   * person downloads a .dmg. A web page is not a build; it is whatever was
   * deployed last, so there is nothing to check and nothing to offer, and a UI
   * that offers it anyway hands out an installer the tab cannot run.
   *
   * Absent means true, so a desktop build that predates this field behaves as
   * it always did.
   */
  updatable?: boolean
  /** When it cannot self-install, the direct download link to reinstall from. */
  downloadUrl?: string
}
