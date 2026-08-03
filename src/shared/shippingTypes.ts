/**
 * RM Cardz Shipping Workspace — the canonical data model.
 *
 * Ported from the RM Cardz architecture doc (section 1). The PDF parser emits a
 * `ShippingDataset`; the store (src/main/db/shipping.ts) persists it into the
 * `ship_*` tables and hands typed objects back out. Every layer above — domain
 * derivations, IPC, renderer — speaks these types.
 *
 * Identity keys that matter (do not change them; carry-forward depends on them):
 *   - customerId  = the Whatnot handle
 *   - shipment id = `ship_<handle>`
 *   - break id    = `break_<n>`  (a break-less giveaway uses `giveaway_<handle>`,
 *                                 which intentionally has NO `breaks` record)
 *   - a team slot is keyed for carry-forward by `handle|breakNumber|teamName`
 */

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

/** The four supported leagues. */
export type ShipSport = 'nfl' | 'mlb' | 'nba' | 'nhl'

/** What an upload may request: a specific league, or auto-detection. */
export type ShipSportOption = ShipSport | 'auto'

export const SHIP_SPORTS: ShipSport[] = ['nfl', 'mlb', 'nba', 'nhl']

export const SHIP_SPORT_LABELS: Record<ShipSport, string> = {
  nfl: 'NFL',
  mlb: 'MLB',
  nba: 'NBA',
  nhl: 'NHL'
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

/**
 * The active dataset's event. Most Whatnot PDFs carry no event name, which is
 * exactly why carry-forward is gated on a NON-EMPTY name (section 7).
 */
export interface ShipEvent {
  name: string
  date: string
  updatedAt: string | null
}

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

export type ShipBreakStatus = 'pending' | 'picking' | 'packed' | 'shipped'

export const SHIP_BREAK_STATUSES: ShipBreakStatus[] = ['pending', 'picking', 'packed', 'shipped']

export interface ShipBreak {
  id: string
  /**
   * The label as printed on the slip — "11A" is a DIFFERENT break from "11".
   *
   * `breakNumber` is kept alongside it purely for ordering; two breaks can share
   * a number and differ only by their letter, and both are real breaks with a
   * full slate of their own.
   */
  breakLabel: string
  breakNumber: number
  eventName: string
  eventDate: string
  status: ShipBreakStatus
}

/** What the parser emits — status defaults to 'pending'. */
export interface ShipBreakDraft {
  id: string
  /**
   * The label as printed — "11A" is a different break from "11".
   *
   * breakNumber is kept alongside it purely for ordering; two breaks can share
   * a number and differ only by their letter.
   */
  breakLabel: string
  breakNumber: number
  eventName?: string | null
  eventDate?: string | null
  status?: ShipBreakStatus
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface ShipCustomer {
  /** The Whatnot handle — the join key between the two slip types. */
  id: string
  whatnotHandle: string
  realName: string
  address: string
  isNew: boolean
  /**
   * The 1-based PDF pages this customer's packing slip occupies, in order.
   *
   * This is what lets a picker keep the original slip open beside the pick list
   * and have "next order" move the paper as well as the cards. Empty for a
   * dataset imported before the pages were recorded, or restored from a
   * snapshot — every screen treats that as "no document to show", never as an
   * error.
   */
  pages: number[]
}

// ---------------------------------------------------------------------------
// Team slots — ONE per physical card. The atomic unit of work.
// ---------------------------------------------------------------------------

export interface ShipTeamSlot {
  id: string
  breakId: string
  /** The printed label of the break this card came out of ("11A"). Null for a
   * break-less giveaway. Prefer this over `breakNumber` for anything a person
   * reads — the number alone cannot tell #11 from #11A. */
  breakLabel: string | null
  /** null for a break-less giveaway (a promo rider with no break). */
  breakNumber: number | null
  teamName: string
  customerId: string
  orderId: string | null
  price: number
  isGiveaway: boolean
  /**
   * Top-loaded. Kept under its original name because the column is synced and
   * renaming it would strand every laptop on an older build.
   *
   * Implies `sleeved`: a card goes into a sleeve and then into the loader.
   */
  topSleeved: boolean
  topSleevedAt: string | null
  topSleevedBy: string | null
  /**
   * Sleeved but not necessarily top-loaded — about half of them are not.
   *
   * Split from `topSleeved` because SOP step 1 consumes TWO supplies at two
   * different rates (95% sleeves, 50% loaders) and one flag could not say which
   * had happened.
   */
  sleeved: boolean
  sleevedAt: string | null
  sleevedBy: string | null
  checkedOff: boolean
  checkedOffAt: string | null
  checkedOffBy: string | null
}

/** What the parser emits — operator state is absent on a fresh parse. */
export interface ShipTeamSlotDraft {
  id: string
  breakId: string
  breakLabel?: string | null
  breakNumber: number | null
  teamName: string
  customerId: string
  orderId?: string | null
  price?: number
  isGiveaway?: boolean
  topSleeved?: boolean
  checkedOff?: boolean
  checkedOffAt?: string | null
  checkedOffBy?: string | null
}

// ---------------------------------------------------------------------------
// Shipments — ONE per customer package. This is what actually ships.
// ---------------------------------------------------------------------------

export type ShipStatusCode =
  | 'not_shipped'
  | 'label_created'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'returned'

export const SHIP_STATUS_CODES: ShipStatusCode[] = [
  'not_shipped',
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned'
]

export const SHIP_STATUS_LABELS: Record<ShipStatusCode, string> = {
  not_shipped: 'Not shipped',
  label_created: 'Label created',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  returned: 'Returned'
}

/**
 * Progress rank used by the "manual is truth, with a forward exception" rule
 * (architecture doc section 6). delivered / exception / returned all sit at 4 so
 * a human-set terminal state is never regressed by an automated writer.
 */
export const SHIP_STATUS_RANK: Record<ShipStatusCode, number> = {
  not_shipped: 0,
  label_created: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
  exception: 4,
  returned: 4
}

export interface ShipManualStatus {
  code: ShipStatusCode
  setAt: string | null
  setBy: string | null
}

export interface ShipSpecialRequest {
  text: string
  setAt: string | null
  setBy: string | null
}

export interface ShipShipment {
  /** `ship_<handle>` */
  id: string
  customerId: string
  trackingNumber: string | null
  carrier: string | null
  serviceType: string | null
  weightOz: number | null
  uspsUrl: string | null
  manualStatus: ShipManualStatus
  notes: string | null
  packedAt: string | null
  packedBy: string | null
  onHold: boolean
  heldReason: string | null
  queueOrder: number
  specialRequest: ShipSpecialRequest | null
  lastUpdated: string | null
}

/** What the parser emits — operator state is absent on a fresh parse. */
export interface ShipShipmentDraft {
  id: string
  customerId: string
  trackingNumber?: string | null
  carrier?: string | null
  serviceType?: string | null
  weightOz?: number | null
  uspsUrl?: string | null
  manualStatus?: ShipManualStatus | null
  notes?: string | null
  packedAt?: string | null
  packedBy?: string | null
  onHold?: boolean
  heldReason?: string | null
  queueOrder?: number
  specialRequest?: ShipSpecialRequest | null
  lastUpdated?: string | null
}

/** Field-level patch accepted by the store's `updateShipment`. */
export interface ShipShipmentPatch {
  trackingNumber?: string | null
  carrier?: string | null
  serviceType?: string | null
  weightOz?: number | null
  uspsUrl?: string | null
  manualStatus?: ShipManualStatus
  notes?: string | null
  packedAt?: string | null
  packedBy?: string | null
  onHold?: boolean
  heldReason?: string | null
  queueOrder?: number
  specialRequest?: ShipSpecialRequest | null
}

// ---------------------------------------------------------------------------
// Orders — the line-item mirror of team slots (drives sales / ledger math).
// ---------------------------------------------------------------------------

export interface ShipOrder {
  id: string
  customerId: string
  breakId: string
  breakNumber: number | null
  teamName: string
  price: number
  isGiveaway: boolean
}

// ---------------------------------------------------------------------------
// Batch URLs, audit, warnings
// ---------------------------------------------------------------------------

/** A USPS "open all" bulk-tracking URL for one batch of tracking numbers. */
export interface ShipBatchUrl {
  batchNumber: number
  count: number
  url: string
}

/** One team claimed by two customers in the same break — a real data error. */
export interface ShipBreakCollision {
  teamName: string
  handles: string[]
}

export interface ShipBreakAudit {
  /**
   * The audit is keyed by the printed LABEL, not the number.
   *
   * Auditing by number folds #11 and #11A into one 60-card pile measured
   * against a 30-team slate: every team appears twice, so the screen reports
   * thirty collisions that never happened and a break nobody can trust.
   */
  breakLabel: string
  breakNumber: number
  teamCount: number
  distinctTeamCount: number
  /** Full slate size for the detected league (32 NFL/NHL, 30 MLB/NBA). */
  maxTeams: number
  missingCount: number
  missingTeams: string[]
  /** Every team in the slate was captured. */
  hasAll: boolean
  collisions: ShipBreakCollision[]
}

export interface ShipWarningInput {
  page: number | null
  message: string
  rawText: string | null
}

export interface ShipWarning extends ShipWarningInput {
  id: string
  /**
   * Open until somebody says otherwise.
   *
   * A flag is a thing for a person to look at, never a thing that stops work —
   * a slot titled "#30" instead of a team is a real occurrence and the card
   * still has to be found and shipped. Being able to clear one is what stops
   * the list turning into wallpaper.
   */
  status: 'open' | 'handled'
  note: string | null
  handledAt: string | null
  handledBy: string | null
}

// ---------------------------------------------------------------------------
// The dataset the parser emits
// ---------------------------------------------------------------------------

export interface ShippingDataset {
  event: { name: string; date: string }
  /** The league the team matcher resolved against (after auto-detection). */
  sport?: ShipSport | null
  breaks: ShipBreakDraft[]
  customers: ShipCustomer[]
  teamSlots: ShipTeamSlotDraft[]
  shipments: ShipShipmentDraft[]
  orders: ShipOrder[]
  batchUrls: ShipBatchUrl[]
  breakAudit: ShipBreakAudit[]
  warnings: ShipWarningInput[]
}

// ---------------------------------------------------------------------------
// Import history
// ---------------------------------------------------------------------------

export type ShipImportKind = 'pdf' | 'demo' | 'manual'

export interface ShipImportCounts {
  customers: number
  breaks: number
  teamSlots: number
  orders: number
  shipments: number
  warnings: number
  giveaways: number
  cardValue: number
}

export interface ShipImportRecord {
  id: string
  name: string
  filename: string
  kind: ShipImportKind
  createdAt: string
  counts: ShipImportCounts
  /** True when this import carried operator state forward (same named event). */
  carriedForward: boolean
}

/**
 * The uploaded PDF, kept so the floor can work against the original paper.
 * `bytes` is deliberately absent here — the metadata is small and travels with
 * every summary; the file itself is fetched only when a screen is about to show
 * it.
 */
export interface ShipDocument {
  id: string
  importId: string | null
  name: string
  pageCount: number
  byteSize: number
  createdAt: string
}

/** What `importDataset` hands back to the caller. */
export interface ShipImportResult {
  record: ShipImportRecord
  counts: ShipImportCounts
  carriedForward: boolean
  event: ShipEvent
}

// ---------------------------------------------------------------------------
// Snapshots (a dated capture that survives re-imports)
// ---------------------------------------------------------------------------

export type ShipSnapshotPayload = Record<string, unknown>

export interface ShipSnapshotSummary {
  id: string
  name: string
  createdAt: string
}

export interface ShipSnapshot extends ShipSnapshotSummary {
  payload: ShipSnapshotPayload
}

// ---------------------------------------------------------------------------
// Break assignments (v17) — "who is sorting break #12"
// ---------------------------------------------------------------------------

/**
 * One employee assigned to one break, as stored in `ship_break_assignments`.
 *
 * The pair (breakId, employeeId) is UNIQUE, so assigning the same person twice
 * updates the existing row rather than creating a duplicate.
 *
 * Assignments are operator state, NOT dataset rows: an import does not wipe
 * them, it only PRUNES the ones whose break no longer exists. Break ids are
 * `break_<n>` and therefore stable across re-imports, so "Maya is sorting
 * break 12" survives a re-upload of the same show.
 */
export interface ShipBreakAssignment {
  id: string
  breakId: string
  /** Denormalised from the break so a pruned/renumbered row still reads well. */
  breakNumber: number | null
  employeeId: string
  assignedAt: string
  /** The employee id of whoever made the assignment. */
  assignedBy: string | null
  note: string | null
}

/** What the domain layer accepts when assigning someone to a break. */
export interface ShipBreakAssignmentInput {
  breakId: string
  employeeId: string
  note?: string | null
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Cheap row counts for the Upload tab's "current dataset" banner. */
export interface ShipDataCounts {
  customers: number
  breaks: number
  teamSlots: number
  orders: number
  shipments: number
  warnings: number
  checkedSlots: number
}

/** Progress emitted while a big PDF parses (a 200-page export takes 10–30s). */
export interface ShipParseProgress {
  phase: 'extract' | 'parse' | 'done' | 'error'
  page: number
  totalPages: number
  message: string
}
