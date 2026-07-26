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
  ShipBreakAudit,
  ShipBreakStatus,
  ShipCustomer,
  ShipEvent,
  ShipImportCounts,
  ShipImportRecord,
  ShipManualStatus,
  ShipSpecialRequest,
  ShipSportOption,
  ShipStatusCode,
  ShipTeamSlot,
  ShipWarning
} from './shippingTypes'

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
}

/** One physical card inside an order's break group. */
export interface ShipOrderTeam {
  slotId: string
  teamName: string
  price: number
  checkedOff: boolean
  checkedOffAt: string | null
  checkedOffBy: string | null
  topSleeved: boolean
  isGiveaway: boolean
  orderId: string | null
}

/** The customer's cards from one break. `breakNumber` is null for a
 * break-less giveaway (its `breakId` is `giveaway_<handle>`). */
export interface ShipOrderBreak {
  breakId: string
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
// Checker — the inverse view: one pick list per break
// ---------------------------------------------------------------------------

export interface ShipBreakSummary {
  id: string
  breakNumber: number
  eventName: string
  eventDate: string
  status: ShipBreakStatus
  totalTeams: number
  checkedTeams: number
  topSleevedTeams: number
  giveawayCount: number
  customerCount: number
  value: number
  /** The fidelity audit for this break — null when the import produced none. */
  audit: ShipBreakAudit | null
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

// ---------------------------------------------------------------------------
// Sales / ledger derivation
// ---------------------------------------------------------------------------

export interface ShipSalesBreakRow {
  breakId: string
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
  trackingCount: number
  onHoldCount: number
  specialRequestCount: number
  warnings: ShipWarning[]
  audit: ShipBreakAudit[]
  /** True when any break audit reported a team owned by two customers. */
  hasCollisions: boolean
  lastImport: ShipImportRecord | null
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
  /** Optional pre-chosen path — omit and the main process opens a file dialog. */
  filePath?: string | null
}

export type ShipParseJobStatus = 'running' | 'done' | 'error'

export interface ShipParseJob {
  id: string
  status: ShipParseJobStatus
  filename: string
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
}

/** `startParse` either began a job or the operator cancelled the file dialog. */
export interface ShipParseStart {
  jobId: string
  filename: string
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
