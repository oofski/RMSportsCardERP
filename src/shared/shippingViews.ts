/**
 * RM Cardz Shipping Workspace — DERIVED view models.
 *
 * `shippingTypes.ts` holds the stored data model (what the parser emits and the
 * `ship_*` tables persist). This file holds what the domain layer
 * (src/main/db/shippingDomain.ts) *derives* from it and hands to the renderer:
 * the Orders row, the Checker break summary/detail, the Shipping tracker row,
 * the sales/ledger derivation, the background parse job and the export kinds.
 *
 * Both the preload bridge and the renderer import from here, so the IPC surface
 * can never drift from what the UI renders.
 */

import type {
  ShipBreakAssignment,
  ShipBreakAudit,
  ShipBreakStatus,
  ShipCustomer,
  ShipEvent,
  ShipImportCounts,
  ShipImportRecord,
  ShipManualStatus,
  ShipSnapshotSummary,
  ShipSpecialRequest,
  ShipSport,
  ShipSportOption,
  ShipStatusCode,
  ShipTeamSlot,
  ShipWarning
} from './shippingTypes'
import type { ShipShow } from './shows'
import type { ShipStationRole } from './shipStations'
import type { UploadedFile } from './types'

// ---------------------------------------------------------------------------
// Fulfillment stage (architecture doc section 4.1)
// ---------------------------------------------------------------------------

/**
 * The Orders pipeline. `to_pick -> put_together -> sent -> all_good` is the
 * happy path; `exception` and `returned` are side-states the stage dropdown also
 * offers. Every one of the six MUST be handled by `setOrderStage` — a missing
 * case is an error the UI cannot recover from.
 */
export type ShipFulfillmentStage =
  | 'to_pick'
  | 'put_together'
  | 'sent'
  | 'all_good'
  | 'exception'
  | 'returned'

export const SHIP_STAGES: ShipFulfillmentStage[] = [
  'to_pick',
  'put_together',
  'sent',
  'all_good',
  'exception',
  'returned'
]

export const SHIP_STAGE_LABELS: Record<ShipFulfillmentStage, string> = {
  to_pick: 'To pick',
  put_together: 'Put together',
  sent: 'Sent',
  all_good: 'All good',
  exception: 'Exception',
  returned: 'Returned'
}

/** The four pipeline stages, in order — side-states are excluded. */
export const SHIP_PIPELINE_STAGES: ShipFulfillmentStage[] = [
  'to_pick',
  'put_together',
  'sent',
  'all_good'
]

// ---------------------------------------------------------------------------
// Orders — ONE row per shipment (package)
// ---------------------------------------------------------------------------

export interface ShipOrderCustomer {
  handle: string
  realName: string
  address: string
  isNew: boolean
  /** Where this customer's slip sits in the uploaded PDF. Empty if unknown. */
  pages: number[]
}

/** One physical card inside an order's break group. */
export interface ShipOrderTeam {
  slotId: string
  teamName: string
  price: number
  /** Bagged at the break bench (step 3). Break-side screens read this. */
  checkedOff: boolean
  checkedOffAt: string | null
  checkedOffBy: string | null
  /**
   * Gathered into this buyer's package (step 4). ORDER-side screens read this,
   * and it is what an order's `pick` count is made of.
   */
  picked: boolean
  pickedAt: string | null
  pickedBy: string | null
  topSleeved: boolean
  isGiveaway: boolean
  orderId: string | null
}

/** The customer's cards from one break. `breakNumber` is null for a
 * break-less giveaway (its `breakId` is `giveaway_<handle>`). */
export interface ShipOrderBreak {
  breakId: string
  breakLabel: string | null
  breakNumber: number | null
  teams: ShipOrderTeam[]
  value: number
  checked: number
  total: number
}

export interface ShipOrderRow {
  /** The shipment id — `ship_<handle>`. */
  id: string
  customerId: string
  customer: ShipOrderCustomer
  trackingNumber: string | null
  carrier: string | null
  serviceType: string | null
  weightOz: number | null
  uspsUrl: string | null
  notes: string | null
  specialRequest: ShipSpecialRequest | null
  manualStatus: ShipManualStatus
  stage: ShipFulfillmentStage
  onHold: boolean
  heldReason: string | null
  queueOrder: number
  packedAt: string | null
  packedBy: string | null
  breaks: ShipOrderBreak[]
  breakCount: number
  /** Sum of every card price, giveaways ($0) included. */
  value: number
  /** Distinct Whatnot order ids on this package — searchable. */
  orderIds: string[]
  cardCount: number
  multiCard: boolean
  topSleevedCount: number
  giveawayCount: number
  hasGiveaway: boolean
  pick: { checked: number; total: number }
  lastUpdated: string | null
}

export type ShipQueueDirection = 'up' | 'down'

// ---------------------------------------------------------------------------
// Break assignments — the resolved, display-ready form of the stored row
// ---------------------------------------------------------------------------

/**
 * A stored assignment with the employee resolved for display. The Checker card
 * and the Admin board both render this straight into `<Avatar text={initials}
 * src={avatarUrl} />`.
 */
export interface ShipBreakAssignee extends ShipBreakAssignment {
  /** "Maya Ortiz", or the raw employee id when the record has been removed. */
  name: string
  /** Two-letter fallback for the Avatar component. */
  initials: string
  title: string
  avatarUrl: string | null
  /** False when the employee record no longer exists (assignment is orphaned). */
  found: boolean
}

/** One pickable person for the Admin assign control. */
export interface ShipAssignmentEmployee {
  id: string
  name: string
  initials: string
  title: string
  avatarUrl: string | null
}

/**
 * Everything the Admin assignment tab needs in ONE read: the current dataset's
 * breaks (each already carrying its assignees) plus the roster to pick from.
 *
 * `employees` is populated only for a caller who can `shipping.manage` — a
 * read-only fulfillment user sees who is assigned but is not handed the roster.
 */
export interface ShipAssignmentBoard {
  event: ShipEvent
  breaks: ShipBreakSummary[]
  employees: ShipAssignmentEmployee[]
  totalAssignments: number
  /** Breaks in the current dataset with nobody assigned. */
  unassignedBreaks: number
  /** True when the caller may assign/unassign (drives the Admin tab's controls). */
  canManage: boolean
}

/**
 * What an assign/unassign hands back. Both the Admin board and the Checker card
 * show assignments, so the freshly derived break comes back with the whole-board
 * totals and either screen reconciles without a refetch.
 */
export interface ShipBreakAssignmentUpdate {
  breakId: string
  assignees: ShipBreakAssignee[]
  /** The re-derived break summary; null only if the break vanished mid-flight. */
  break: ShipBreakSummary | null
  totalAssignments: number
  unassignedBreaks: number
}

// ---------------------------------------------------------------------------
// Checker — the inverse view: one pick list per break
// ---------------------------------------------------------------------------

export interface ShipBreakSummary {
  id: string
  /** The printed label — "11A". What every screen shows. */
  breakLabel: string
  /** Ordering only. Two summaries can share it and differ by their letter. */
  breakNumber: number
  eventName: string
  eventDate: string
  /**
   * The league THIS break was read against, or null for "whatever the import as
   * a whole was" — which is every break imported before per-break detection.
   * The screen offers it as a correction: see ShipBreak.sport.
   */
  sport: ShipSport | null
  /**
   * WHICH SHOW this break ran in. The bench groups by it — several slips can be
   * on the floor at once now, and a flat grid of break cards across two nights
   * is a pile, not a list. NULL on a break imported before the workspace could
   * hold more than one show; the screen falls back to its event name and date.
   */
  showId: string | null
  status: ShipBreakStatus
  totalTeams: number
  checkedTeams: number
  topSleevedTeams: number
  giveawayCount: number
  customerCount: number
  value: number
  /** The fidelity audit for this break — null when the import produced none. */
  audit: ShipBreakAudit | null
  /** Who is sorting this break. Empty when nobody has been assigned. */
  assignees: ShipBreakAssignee[]
}

/** A pick row: the slot plus who it belongs to. */
export interface ShipBreakSlotRow extends ShipTeamSlot {
  handle: string
  realName: string
  address: string
  isNew: boolean
  onHold: boolean
  trackingNumber: string | null
  /** The owning package's fulfillment stage, so a picker sees what's already out. */
  stage: ShipFulfillmentStage
}

export interface ShipBreakDetail extends ShipBreakSummary {
  slots: ShipBreakSlotRow[]
}

/**
 * What a slot mutation hands back. Team slots are shared between Orders and the
 * Checker, so BOTH freshly derived rows come back and either screen can
 * reconcile without a refetch.
 */
export interface ShipSlotUpdate {
  slot: ShipTeamSlot
  break: ShipBreakDetail | null
  order: ShipOrderRow | null
}

// ---------------------------------------------------------------------------
// Shipping tracker
// ---------------------------------------------------------------------------

export interface ShipShipmentRow {
  id: string
  customerId: string
  customer: ShipOrderCustomer
  trackingNumber: string | null
  carrier: string | null
  serviceType: string | null
  weightOz: number | null
  uspsUrl: string | null
  manualStatus: ShipManualStatus
  stage: ShipFulfillmentStage
  notes: string | null
  onHold: boolean
  heldReason: string | null
  queueOrder: number
  packedAt: string | null
  packedBy: string | null
  specialRequest: ShipSpecialRequest | null
  cardCount: number
  value: number
  lastUpdated: string | null
}

/** One `tracking number -> status` pair for a bulk manual status update. */
export interface ShipBulkStatusEntry {
  trackingNumber: string
  code: ShipStatusCode
}

/**
 * The outcome of `bulkSetShipmentStatusByTracking` — the doc's section 6
 * precedence means some entries are deliberately SKIPPED (a human status is
 * truth), so the UI has to be able to say which.
 */
export interface ShipBulkStatusResult {
  updated: number
  skipped: number
  unmatched: string[]
  rows: ShipShipmentRow[]
}

/**
 * How a run of slip pages is written: "27–31", or "15", or "4, 9" when the run
 * has a hole in it. Lives here rather than beside the viewer so it can be tested
 * without pulling a PDF engine into a Node test.
 */
export function pageRangeLabel(pages: number[]): string {
  if (pages.length === 0) return ''
  if (pages.length === 1) return String(pages[0])
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1)
  // A gap must never be described as a range — that would claim pages the
  // order does not own.
  return contiguous ? `${pages[0]}–${pages[pages.length - 1]}` : pages.join(', ')
}

// ---------------------------------------------------------------------------
// Sales / ledger derivation
// ---------------------------------------------------------------------------

export interface ShipSalesBreakRow {
  breakId: string
  breakLabel: string | null
  breakNumber: number | null
  cards: number
  paidCards: number
  giveaways: number
  customers: number
  revenue: number
  avgCardPrice: number
}

export interface ShipSalesCustomerRow {
  customerId: string
  handle: string
  realName: string
  cards: number
  paidCards: number
  giveaways: number
  breaks: number
  revenue: number
  stage: ShipFulfillmentStage
  onHold: boolean
  isNew: boolean
}

/** One line item — the ledger is the flattened card-level truth. */
export interface ShipLedgerRow {
  orderRowId: string
  customerId: string
  handle: string
  realName: string
  breakId: string
  breakLabel: string | null
  breakNumber: number | null
  teamName: string
  orderId: string | null
  price: number
  isGiveaway: boolean
  checkedOff: boolean
  topSleeved: boolean
  stage: ShipFulfillmentStage
  trackingNumber: string | null
}

export interface ShipSalesSummary {
  event: ShipEvent
  revenue: number
  cardCount: number
  paidCardCount: number
  giveawayCount: number
  customerCount: number
  breakCount: number
  avgOrderValue: number
  avgCardPrice: number
  /** Top-20%-by-value cutoff — the VIP / big-spender highlight (doc 4.2). */
  vipThreshold: number
  stageCounts: Record<ShipFulfillmentStage, number>
  statusCounts: Record<ShipStatusCode, number>
  byBreak: ShipSalesBreakRow[]
  byCustomer: ShipSalesCustomerRow[]
  topCustomers: ShipSalesCustomerRow[]
}

// ---------------------------------------------------------------------------
// Workspace summary (the Upload tab banner + tab badges)
// ---------------------------------------------------------------------------

export interface ShipWorkspaceSummary {
  hasDataset: boolean
  event: ShipEvent
  counts: {
    customers: number
    breaks: number
    teamSlots: number
    orders: number
    shipments: number
    warnings: number
    checkedSlots: number
  }
  stageCounts: Record<ShipFulfillmentStage, number>
  breakStatusCounts: Record<ShipBreakStatus, number>
  value: number
  /**
   * Cards that belong to NO break — a promo rider with no break number on the
   * slip. Real, checkable work that lives in Find's "Loose giveaways" section
   * and appears in no break's pick list, so any screen totalling "cards" off
   * the breaks alone is short by exactly this many.
   */
  looseCards: number
  looseChecked: number
  /**
   * How many of `looseCards` are giveaways — which is nearly always all of
   * them, because a promo rider having no break number is what a giveaway IS,
   * not a fault. The split exists so a screen can say "29 giveaways" (normal,
   * say it plainly) instead of "29 cards outside any break" (alarming, and
   * wrong). A PAID card with no break is the unusual one, and the import
   * already raises a flag for it.
   */
  looseGiveawayCards: number
  trackingCount: number
  onHoldCount: number
  specialRequestCount: number
  warnings: ShipWarning[]
  audit: ShipBreakAudit[]
  /** True when any break audit reported a team owned by two customers. */
  hasCollisions: boolean
  lastImport: ShipImportRecord | null
}

/**
 * Is the night's packing done?
 *
 * ## PACKED, not picked, and that is the whole distinction
 *
 * `to_pick` is an order nobody has pulled the cards for. Everything past it —
 * `put_together`, `sent`, `all_good` — has been PACKED: the cards are in a
 * bag with a slip and the paper has done its job. So the test is that nothing
 * is still waiting to be picked, not that everything has shipped. Waiting for
 * `sent` would mean the button never appeared until the carrier scans came
 * back, which is the next morning at best and days later at worst — long after
 * the bench has gone home and the paper is in the way.
 *
 * ## The side states are deliberately not counted
 *
 * `exception` and `returned` are not stages on the way to anywhere; they are
 * where an order goes when something is wrong with it. An order held for a
 * missing card can sit there for a week, and blocking the whole night on it
 * would mean the one screen that says "you are finished" never says it on any
 * night that had a single problem — which is most nights.
 *
 * ## Zero orders is not "finished"
 *
 * An empty dataset trivially has nothing left to pick. Offering to finish a
 * night that never started would put a destructive button in front of somebody
 * who has just opened the app.
 */
export function allOrdersPacked(summary: {
  hasDataset: boolean
  counts: { orders: number }
  stageCounts: Record<ShipFulfillmentStage, number>
} | null): boolean {
  if (!summary || !summary.hasDataset) return false
  if ((summary.counts?.orders ?? 0) <= 0) return false
  return (summary.stageCounts?.to_pick ?? 0) === 0
}

/** What finishing a night actually did, so the screen can say it. */
export interface ShipFinishResult {
  /** The capture that became the report. */
  snapshotId: string
  snapshotName: string
  /** How many document rows were dropped — 0 when the slip was already put away. */
  documentsCleared: number
  orders: number
}

// ---------------------------------------------------------------------------
// Background parse job
// ---------------------------------------------------------------------------

export interface ShipParseRequest {
  sport?: ShipSportOption
  eventName?: string | null
  eventDate?: string | null
  /** Human label for the import-history row; defaults to the filename. */
  name?: string | null
  /** Optional pre-chosen path — omit and the main process opens a file dialog.
   *  Desktop only: a browser has no path to give, and a server that accepted
   *  one would be reading its own disk on a caller's say-so. */
  filePath?: string | null
  /** The PDF itself, base64, when the caller is a browser. */
  upload?: UploadedFile
  /**
   * SEVERAL PDFs, base64, in one go.
   *
   * A Saturday can be two streams, and a bench can be working Thursday's slips
   * and Saturday's together. Each file is parsed as its OWN show — its own
   * league detection, its own breaks — and the results are merged into one
   * workspace before anything is written, so two nights that both ran a
   * "Break #4" stay two breaks. See @shared/shows.
   *
   * Takes precedence over `upload` when both are present. One file here behaves
   * exactly like `upload` did.
   */
  uploads?: UploadedFile[]
  /**
   * Several pre-chosen paths, desktop only — the multi-file counterpart of
   * `filePath`, with the same reason for existing and the same restriction.
   */
  filePaths?: string[]
  /**
   * Keep the pick/pack progress from the dataset this import replaces.
   *
   * OFF unless the operator asks. Carry-forward used to be inferred from the
   * event name and date matching, which two shows on the same day satisfy by
   * coincidence — especially once the name is auto-generated as
   * "[Sport] - [Date]". The second show then arrived with the first show's
   * packages already stamped packed, already carrying its holds, notes and
   * manual statuses, and left the To Pick queue without anyone touching them.
   */
  carryForward?: boolean
}

export type ShipParseJobStatus = 'running' | 'done' | 'error'

export interface ShipParseJob {
  id: string
  status: ShipParseJobStatus
  /**
   * The file being read RIGHT NOW. With several slips in one upload this moves
   * from one to the next, so the progress line always names the one it is
   * counting pages through.
   */
  filename: string
  /** Every file in this upload, in the order they are read. */
  filenames?: string[]
  /** 1-based position of `filename` within `filenames`. */
  fileIndex?: number
  phase: 'extract' | 'parse' | 'done' | 'error'
  page: number
  totalPages: number
  message: string
  startedAt: string
  finishedAt: string | null
  error: string | null
  /** Populated once `status === 'done'`. */
  counts: ShipImportCounts | null
  carriedForward: boolean
  event: ShipEvent | null
  /** The shows this upload put on the bench. Populated once `status === 'done'`. */
  shows?: ShipShow[]
  /**
   * Set only when the dataset imported fine but the PDF could not be filed
   * alongside it. The import still succeeded — this is "you will not have the
   * slip to look at", not "the show did not load".
   */
  documentError?: string | null
}

/** `startParse` either began a job or the operator cancelled the file dialog. */
export interface ShipParseStart {
  jobId: string
  /** The first file's name — what the caller shows while the job spins up. */
  filename: string
  /** Every file the job will read. */
  filenames: string[]
}

// ---------------------------------------------------------------------------
// Snapshots + CSV export
// ---------------------------------------------------------------------------

export interface ShipSnapshotContents {
  createdAt: string
  event: ShipEvent
  orders: ShipOrderRow[]
  shipments: ShipShipmentRow[]
  sales: ShipSalesSummary
}

/** What `api.shipping.export(kind)` can write. */
export type ShipExportKind =
  | 'orders'
  | 'shipments'
  | 'ledger'
  | 'sales'
  | 'customers'
  | 'checker'
  | 'warnings'
  | 'imports'
  | 'tracking'

export const SHIP_EXPORT_KINDS: ShipExportKind[] = [
  'orders',
  'shipments',
  'ledger',
  'sales',
  'customers',
  'checker',
  'warnings',
  'imports',
  'tracking'
]

export const SHIP_EXPORT_LABELS: Record<ShipExportKind, string> = {
  orders: 'Orders',
  shipments: 'Shipments',
  ledger: 'Card ledger',
  sales: 'Sales by break',
  customers: 'Sales by customer',
  checker: 'Pick lists',
  warnings: 'Parse warnings',
  imports: 'Import history',
  tracking: 'Tracking numbers'
}

/** A customer row with its shipment id, for lookups the UI needs. */
export interface ShipCustomerRow extends ShipCustomer {
  shipmentId: string | null
  cardCount: number
  value: number
}

// ---------------------------------------------------------------------------
// History calendar — a month of real, persisted activity
// ---------------------------------------------------------------------------

/**
 * Where a day's numbers came from. The calendar is DERIVED from
 * `ship_imports` + `ship_snapshots` + the live dataset — there is no rollup
 * table — so the UI has to be able to say how solid a day's figures are:
 *
 *   'live'     — this day holds the dataset currently loaded in the workspace,
 *                so every number is the real, up-to-the-second truth.
 *   'snapshot' — the dataset has since been replaced; the numbers come from the
 *                newest snapshot captured that day.
 *   'import'   — an import ran that day but nothing captured its progress, so
 *                only the imported volume/value is known (progress reads 0).
 *   'none'     — nothing happened. A calm, empty cell.
 */
export type ShipCalendarSource = 'live' | 'snapshot' | 'import' | 'none'

/**
 * One calendar cell. Every day of the requested month gets one, including the
 * empty ones, so the UI can lay out a grid without inventing placeholders.
 *
 * `packagesSent` counts packages that have physically left (in transit, out for
 * delivery, delivered or returned); `packagesDelivered` is the delivered subset.
 */
export interface ShipCalendarDay {
  /** Local date, `YYYY-MM-DD`. Bucketing is LOCAL, not UTC, so a 7pm import
   *  lands on the day the operator actually did it. */
  date: string
  /** The import run(s) done that day — name, filename, counts and all. */
  imports: ShipImportRecord[]
  /** Dated captures taken that day; the UI's "jump to snapshot" targets. */
  snapshots: ShipSnapshotSummary[]
  /** The value of the day's dataset (live > snapshot > the day's last import). */
  value: number
  cards: number
  cardsPicked: number
  packages: number
  packagesWithTracking: number
  packagesSent: number
  packagesDelivered: number
  source: ShipCalendarSource
  /** True when this day's dataset is the one currently loaded. */
  isActive: boolean
  /** False for a day with no import and no snapshot — render it calm. */
  hasActivity: boolean
  /** 0..1 against the busiest day of the month — the cell's visual weight. */
  intensity: number
}

/**
 * Month-level roll-up. Volume and money are summed from the month's IMPORTS
 * (what came in), deliberately not from the per-day figures: the same dataset
 * shows on its import day and again on every day it was snapshotted, so adding
 * day values would double count. Fulfilment progress is per-dataset and so is
 * only ever reported per day.
 */
export interface ShipCalendarMonthTotals {
  imports: number
  snapshots: number
  /** Days with at least one import or snapshot. */
  activeDays: number
  /** Σ every import's card value this month. */
  value: number
  /** Σ every import's cards this month. */
  cards: number
  /** Σ every import's packages this month. */
  packages: number
}

export interface ShipCalendarMonth {
  year: number
  /** 1-12. */
  month: number
  /** First and last day of the month, `YYYY-MM-DD`. */
  start: string
  end: string
  /** The main process's local "today" — the UI never has to guess a timezone. */
  today: string
  /** 0 = Sunday. The weekday the 1st falls on, so the grid can pad correctly. */
  startWeekday: number
  /** One entry per day of the month, in order. */
  days: ShipCalendarDay[]
  totals: ShipCalendarMonthTotals
  /** The heaviest day, or null when the month is empty. */
  busiestDate: string | null
  /** The raw activity score `intensity` was normalised against. */
  peak: number
  /** The day holding the live dataset, when it falls inside this month. */
  activeDate: string | null
}

/** One break inside a day's detail. */
export interface ShipCalendarBreakRow {
  breakId: string
  breakNumber: number | null
  /** Null when the row was rebuilt from a snapshot (which stores no status). */
  status: ShipBreakStatus | null
  cards: number
  picked: number
  customers: number
  value: number
}

/** What a day cell expands into when clicked. */
export interface ShipCalendarDayDetail extends ShipCalendarDay {
  year: number
  /** 1-12. */
  month: number
  /** The event behind the day's numbers, when it can be resolved. */
  event: ShipEvent | null
  breaks: ShipCalendarBreakRow[]
  /** Newest snapshot captured that day — what "open this snapshot" should load. */
  snapshotId: string | null
  /** The import whose dataset these numbers describe. */
  importId: string | null
}

// ---------------------------------------------------------------------------
// Deleting an import — what goes with it
// ---------------------------------------------------------------------------

/** Somebody with an order in their hands at the moment the plan was drawn. */
export interface ShipImportDeleteWorker {
  name: string | null
  role: ShipStationRole
  handle: string | null
}

/**
 * Everything a delete would destroy, priced, before anything is written.
 *
 * The confirmation is built entirely from this — an operator throwing away a
 * show's work is owed the actual numbers, not an "are you sure?".
 */
export interface ShipImportDeletePlan {
  importId: string
  name: string
  filename: string
  createdAt: string
  /**
   * True when this import is the newest — the one whose rows ARE the workspace.
   *
   * Only one dataset exists at a time, so every earlier import's cards and
   * packages were already overwritten by whatever replaced them. Deleting one
   * of those removes a log entry and the operator state stamped with it, and
   * touches no dataset row at all.
   */
  isLive: boolean
  /** The import that carried forward from this one — where its work moves to. */
  carriedToId: string | null
  carriedToName: string | null

  // The active dataset. All zero unless `isLive`.
  packages: number
  packagesPacked: number
  cards: number
  cardsPicked: number
  breaks: number
  value: number

  /** Work claims and break assignments stamped with this import. */
  claims: number
  assignments: number
  /** Empty unless somebody is holding an order right now. */
  working: ShipImportDeleteWorker[]

  /** The show's day, when this import still owns one. */
  eventName: string | null
  eventDate: string | null

  /** Captures of this show that SURVIVE the delete. */
  snapshots: number
  /**
   * True when the confirmation has to be acknowledged in writing: somebody is
   * working, or real progress is being thrown away.
   */
  needsAcknowledgement: boolean
}

export interface ShipImportDeleteResult {
  /** The plan as it stood when the delete ran. */
  plan: ShipImportDeletePlan
  /** True when the workspace is empty afterwards. */
  workspaceCleared: boolean
}
