/**
 * RM Cardz Shipping Workspace — the store / repository.
 *
 * Ported from the architecture doc's `Db` module: this file owns EVERY mutation
 * of the `ship_*` tables and the full row <-> object mapping. Nothing above it
 * (domain derivations, IPC, renderer) may touch SQL directly.
 *
 * The workspace holds ONE active dataset at a time. `importDataset` implements
 * section 7 of the doc exactly:
 *   1. capture the outgoing shipments / team slots / breaks + the previous event
 *   2. overwrite every dataset array
 *   3. carry operator state forward ONLY on a confirmed same-named-event
 *      re-import — otherwise everything starts fresh (all To Pick)
 *   4. append an import-history row
 * The whole thing runs inside a single db.transaction(), so any throw rolls the
 * import back and leaves the previous dataset intact.
 */

import type Database from 'better-sqlite3'
import type {
  ShipBatchUrl,
  ShipBreak,
  ShipBreakAssignment,
  ShipBreakAssignmentInput,
  ShipBreakAudit,
  ShipBreakCollision,
  ShipBreakStatus,
  ShipCustomer,
  ShipDataCounts,
  ShipEvent,
  ShipImportCounts,
  ShipImportKind,
  ShipImportRecord,
  ShipImportResult,
  ShipManualStatus,
  ShipOrder,
  ShipShipment,
  ShipShipmentPatch,
  ShipSnapshot,
  ShipSnapshotPayload,
  ShipSnapshotSummary,
  ShipSpecialRequest,
  ShipStatusCode,
  ShipDocument,
  ShipTeamSlot,
  ShipSport,
  ShipWarning,
  ShippingDataset
} from '@shared/shippingTypes'
import { SHIP_SPORTS } from '@shared/shippingTypes'
import { bagRowId } from '@shared/breakSteps'
import { auditOneBreak } from '../shipping/parser'
import { createTeamMatcher } from '../shipping/teams'
import { getDb } from './database'
import { newId, nowIso } from '../util'

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface EventRow {
  name: string | null
  date: string | null
  updated_at: string | null
}

interface BreakRow {
  id: string
  break_label: string | null
  break_number: number | null
  sport: string | null
  show_id: string | null
  event_name: string | null
  event_date: string | null
  status: string
  sleeved_at: string | null
  sleeved_by: string | null
  sorted_at: string | null
  sorted_by: string | null
}

interface CustomerRow {
  id: string
  whatnot_handle: string | null
  real_name: string | null
  address: string | null
  is_new: number
  pages: string | null
}

interface TeamSlotRow {
  id: string
  break_id: string | null
  break_label: string | null
  break_number: number | null
  team_name: string | null
  customer_id: string | null
  order_id: string | null
  price: number
  is_giveaway: number
  top_sleeved: number
  sleeved: number
  sleeved_at: string | null
  sleeved_by: string | null
  top_sleeved_at: string | null
  top_sleeved_by: string | null
  checked_off: number
  checked_off_at: string | null
  checked_off_by: string | null
  picked_at: string | null
  picked_by: string | null
  slip_page: number | null
  slip_position: number | null
}

interface ShipmentRow {
  id: string
  customer_id: string | null
  tracking_number: string | null
  carrier: string | null
  service_type: string | null
  weight_oz: number | null
  usps_url: string | null
  status_code: string
  status_set_at: string | null
  status_set_by: string | null
  notes: string | null
  packed_at: string | null
  packed_by: string | null
  on_hold: number
  held_reason: string | null
  queue_order: number
  special_request: string | null
  special_request_at: string | null
  special_request_by: string | null
  last_updated: string | null
}

interface OrderRow {
  id: string
  customer_id: string | null
  break_id: string | null
  break_number: number | null
  team_name: string | null
  price: number
  is_giveaway: number
}

interface BatchUrlRow {
  batch_number: number
  count: number | null
  url: string | null
}

interface BreakAuditRow {
  break_id: string | null
  break_label: string | null
  break_number: number
  team_count: number | null
  distinct_team_count: number | null
  max_teams: number | null
  missing_count: number | null
  missing_teams: string | null
  has_all: number | null
  collisions: string | null
}

interface WarningRow {
  id: string
  page: number | null
  message: string | null
  raw_text: string | null
  status: string | null
  note: string | null
  resolved_at: string | null
  resolved_by: string | null
}

interface ImportRow {
  id: string
  name: string | null
  filename: string | null
  kind: string | null
  created_at: string | null
  counts: string | null
}

interface SnapshotRow {
  id: string
  name: string | null
  created_at: string | null
  payload: string | null
}

interface BreakAssignmentRow {
  id: string
  break_id: string
  break_number: number | null
  employee_id: string
  assigned_at: string | null
  assigned_by: string | null
  note: string | null
}

// ---------------------------------------------------------------------------
// Small coercion helpers (SQLite has no booleans; JSON columns can be garbage)
// ---------------------------------------------------------------------------

const bool = (n: number | null | undefined): boolean => n === 1
const flag = (b: boolean | undefined): number => (b ? 1 : 0)
const str = (s: string | null | undefined): string => s ?? ''
const num = (n: number | null | undefined): number => (typeof n === 'number' && isFinite(n) ? n : 0)

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw) as T
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

/** Round money to whole cents so summed prices never carry float drift. */
const cents = (n: number): number => Math.round(num(n) * 100) / 100

/**
 * A stored league string, or null.
 *
 * Coerced on READ rather than trusted, for the same reason every other status
 * column in this file is: the value can arrive from an older build, from sync,
 * or from a hand-edited row, and an unrecognised league would otherwise be
 * handed to `createTeamMatcher`, which has no answer for it. Null is the safe
 * one — it reads as "the upload's league", which is what every break before v83
 * already means.
 */
function asShipSport(v: unknown): ShipSport | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return (SHIP_SPORTS as readonly string[]).includes(s) ? (s as ShipSport) : null
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toBreak(r: BreakRow): ShipBreak {
  return {
    id: r.id,
    // A row written before v31 has no label; its number IS its label.
    breakLabel: str(r.break_label) || String(num(r.break_number)),
    breakNumber: num(r.break_number),
    // NULL on every break imported before v83, which reads as "the upload's
    // league" rather than as a fifth one. See ShipBreak.sport.
    sport: asShipSport(r.sport),
    showId: str(r.show_id) || null,
    eventName: str(r.event_name),
    eventDate: str(r.event_date),
    status: (r.status || 'pending') as ShipBreakStatus,
    sleeve: { at: r.sleeved_at ?? null, by: r.sleeved_by ?? null },
    sort: { at: r.sorted_at ?? null, by: r.sorted_by ?? null }
  }
}

function toCustomer(r: CustomerRow): ShipCustomer {
  return {
    id: r.id,
    whatnotHandle: str(r.whatnot_handle) || r.id,
    realName: str(r.real_name),
    address: str(r.address),
    isNew: bool(r.is_new),
    pages: parseJson<number[]>(r.pages, [])
  }
}

function toTeamSlot(r: TeamSlotRow): ShipTeamSlot {
  return {
    id: r.id,
    breakId: str(r.break_id),
    breakLabel: r.break_label ?? (r.break_number === null || r.break_number === undefined ? null : String(r.break_number)),
    breakNumber: r.break_number === null || r.break_number === undefined ? null : r.break_number,
    teamName: str(r.team_name),
    customerId: str(r.customer_id),
    orderId: r.order_id ?? null,
    price: num(r.price),
    isGiveaway: bool(r.is_giveaway),
    topSleeved: bool(r.top_sleeved),
    sleeved: bool(r.sleeved),
    sleevedAt: r.sleeved_at ?? null,
    sleevedBy: r.sleeved_by ?? null,
    topSleevedAt: r.top_sleeved_at ?? null,
    topSleevedBy: r.top_sleeved_by ?? null,
    checkedOff: bool(r.checked_off),
    checkedOffAt: r.checked_off_at ?? null,
    checkedOffBy: r.checked_off_by ?? null,
    // Picked has no boolean column of its own: the stamp IS the fact, and one
    // fewer column is one fewer way for a flag and its timestamp to disagree.
    picked: !!r.picked_at,
    pickedAt: r.picked_at ?? null,
    pickedBy: r.picked_by ?? null,
    slipPage: r.slip_page ?? null,
    slipPosition: r.slip_position ?? null
  }
}

function toShipment(r: ShipmentRow): ShipShipment {
  const manualStatus: ShipManualStatus = {
    code: (r.status_code || 'not_shipped') as ShipStatusCode,
    setAt: r.status_set_at ?? null,
    setBy: r.status_set_by ?? null
  }
  const specialRequest: ShipSpecialRequest | null =
    r.special_request && r.special_request.trim() !== ''
      ? { text: r.special_request, setAt: r.special_request_at ?? null, setBy: r.special_request_by ?? null }
      : null
  return {
    id: r.id,
    customerId: str(r.customer_id),
    trackingNumber: r.tracking_number ?? null,
    carrier: r.carrier ?? null,
    serviceType: r.service_type ?? null,
    weightOz: r.weight_oz ?? null,
    uspsUrl: r.usps_url ?? null,
    manualStatus,
    notes: r.notes ?? null,
    packedAt: r.packed_at ?? null,
    packedBy: r.packed_by ?? null,
    onHold: bool(r.on_hold),
    heldReason: r.held_reason ?? null,
    queueOrder: num(r.queue_order),
    specialRequest,
    lastUpdated: r.last_updated ?? null
  }
}

function toOrder(r: OrderRow): ShipOrder {
  return {
    id: r.id,
    customerId: str(r.customer_id),
    breakId: str(r.break_id),
    breakNumber: r.break_number === null || r.break_number === undefined ? null : r.break_number,
    teamName: str(r.team_name),
    price: num(r.price),
    isGiveaway: bool(r.is_giveaway)
  }
}

function toBatchUrl(r: BatchUrlRow): ShipBatchUrl {
  return { batchNumber: r.batch_number, count: num(r.count), url: str(r.url) }
}

function toBreakAudit(r: BreakAuditRow): ShipBreakAudit {
  const label = str(r.break_label) || String(r.break_number)
  return {
    breakId: str(r.break_id) || `break_${label}`,
    breakLabel: label,
    breakNumber: r.break_number,
    teamCount: num(r.team_count),
    distinctTeamCount: num(r.distinct_team_count),
    maxTeams: num(r.max_teams),
    missingCount: num(r.missing_count),
    missingTeams: parseJson<string[]>(r.missing_teams, []),
    hasAll: bool(r.has_all),
    collisions: parseJson<ShipBreakCollision[]>(r.collisions, [])
  }
}

function toWarning(r: WarningRow): ShipWarning {
  return {
    id: r.id,
    page: r.page ?? null,
    message: str(r.message),
    rawText: r.raw_text ?? null,
    status: r.status === 'handled' ? 'handled' : 'open',
    note: r.note ?? null,
    handledAt: r.resolved_at ?? null,
    handledBy: r.resolved_by ?? null
  }
}

const EMPTY_COUNTS: ShipImportCounts = {
  customers: 0,
  breaks: 0,
  teamSlots: 0,
  orders: 0,
  shipments: 0,
  warnings: 0,
  giveaways: 0,
  cardValue: 0
}

/**
 * The `counts` column carries the count blob plus the `carriedForward` flag —
 * the v16 schema has no dedicated column for it, and the two are only ever read
 * together.
 */
function toImportRecord(r: ImportRow): ShipImportRecord {
  const blob = parseJson<Record<string, unknown>>(r.counts, {})
  const counts: ShipImportCounts = { ...EMPTY_COUNTS }
  for (const key of Object.keys(EMPTY_COUNTS) as Array<keyof ShipImportCounts>) {
    const v = blob[key]
    if (typeof v === 'number' && isFinite(v)) counts[key] = v
  }
  return {
    id: r.id,
    name: str(r.name),
    filename: str(r.filename),
    kind: (r.kind || 'pdf') as ShipImportKind,
    createdAt: str(r.created_at),
    counts,
    carriedForward: blob.carriedForward === true
  }
}

function toBreakAssignment(r: BreakAssignmentRow): ShipBreakAssignment {
  return {
    id: r.id,
    breakId: str(r.break_id),
    breakNumber: r.break_number === null || r.break_number === undefined ? null : r.break_number,
    employeeId: str(r.employee_id),
    assignedAt: str(r.assigned_at),
    assignedBy: r.assigned_by ?? null,
    note: r.note && r.note.trim() !== '' ? r.note : null
  }
}

function toSnapshot(r: SnapshotRow): ShipSnapshot {
  return {
    id: r.id,
    name: str(r.name),
    createdAt: str(r.created_at),
    payload: parseJson<ShipSnapshotPayload>(r.payload, {})
  }
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

/** The active dataset's event. Always returns a row-shaped object. */
export function getShipEvent(): ShipEvent {
  const row = getDb().prepare(`SELECT name, date, updated_at FROM ship_event WHERE id = 1`).get() as
    | EventRow
    | undefined
  return {
    name: str(row?.name),
    date: str(row?.date),
    updatedAt: row?.updated_at ?? null
  }
}

/** Overwrite the single event row. */
export function setShipEvent(name: string, date: string): ShipEvent {
  getDb()
    .prepare(
      `INSERT INTO ship_event (id, name, date, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                       date = excluded.date,
                                       updated_at = excluded.updated_at`
    )
    .run(str(name).trim(), str(date).trim(), nowIso())
  return getShipEvent()
}

// ---------------------------------------------------------------------------
// Reads — breaks
// ---------------------------------------------------------------------------

// `sport` is selected because the import WRITES it and setBreakSport writes it
// again. Left out, toBreak mapped `undefined` and every break read back with no
// league however many had been detected — the same trap SLOT_SELECT carries a
// note about, and it made per-break detection invisible to every screen.
const BREAK_SELECT = `SELECT id, break_label, break_number, sport, show_id,
                             event_name, event_date, status,
                             sleeved_at, sleeved_by, sorted_at, sorted_by
                      FROM ship_breaks`

export function listShipBreaks(): ShipBreak[] {
  const rows = getDb()
    .prepare(`${BREAK_SELECT} ORDER BY break_number ASC, break_label ASC, id ASC`)
    .all() as BreakRow[]
  return rows.map(toBreak)
}

export function getShipBreak(id: string): ShipBreak | null {
  const row = getDb().prepare(`${BREAK_SELECT} WHERE id = ?`).get(id) as BreakRow | undefined
  return row ? toBreak(row) : null
}

export function getShipBreakByNumber(breakNumber: number): ShipBreak | null {
  const row = getDb().prepare(`${BREAK_SELECT} WHERE break_number = ?`).get(breakNumber) as
    | BreakRow
    | undefined
  return row ? toBreak(row) : null
}

// ---------------------------------------------------------------------------
// Reads — customers
// ---------------------------------------------------------------------------

const CUSTOMER_SELECT = `SELECT id, whatnot_handle, real_name, address, is_new, pages FROM ship_customers`

export function listShipCustomers(): ShipCustomer[] {
  const rows = getDb()
    .prepare(`${CUSTOMER_SELECT} ORDER BY id COLLATE NOCASE ASC`)
    .all() as CustomerRow[]
  return rows.map(toCustomer)
}

export function getShipCustomer(id: string): ShipCustomer | null {
  const row = getDb().prepare(`${CUSTOMER_SELECT} WHERE id = ?`).get(id) as CustomerRow | undefined
  return row ? toCustomer(row) : null
}

// ---------------------------------------------------------------------------
// Reads — team slots
// ---------------------------------------------------------------------------

// The sleeve columns are selected because setTeamSlotSleeve WRITES them. Left
// out, toTeamSlot mapped `undefined` and every slot read back sleeved:false
// however many had been sleeved — a store that cannot read back what it writes
// is a trap for whoever first depends on the field.
const SLOT_SELECT = `
  SELECT id, break_id, break_label, break_number, team_name, customer_id, order_id, price,
         is_giveaway, top_sleeved, top_sleeved_at, top_sleeved_by,
         sleeved, sleeved_at, sleeved_by,
         checked_off, checked_off_at, checked_off_by,
         picked_at, picked_by,
         slip_page, slip_position
  FROM ship_team_slots
`

/** Every slot in dataset (insertion) order — the order carry-forward consumes. */
export function listShipTeamSlots(): ShipTeamSlot[] {
  const rows = getDb().prepare(`${SLOT_SELECT} ORDER BY rowid ASC`).all() as TeamSlotRow[]
  return rows.map(toTeamSlot)
}

export function getShipTeamSlot(id: string): ShipTeamSlot | null {
  const row = getDb().prepare(`${SLOT_SELECT} WHERE id = ?`).get(id) as TeamSlotRow | undefined
  return row ? toTeamSlot(row) : null
}

export function listShipTeamSlotsByBreak(breakId: string): ShipTeamSlot[] {
  const rows = getDb()
    .prepare(`${SLOT_SELECT} WHERE break_id = ? ORDER BY team_name COLLATE NOCASE ASC, rowid ASC`)
    .all(breakId) as TeamSlotRow[]
  return rows.map(toTeamSlot)
}

export function listShipTeamSlotsByCustomer(customerId: string): ShipTeamSlot[] {
  const rows = getDb()
    .prepare(`${SLOT_SELECT} WHERE customer_id = ? ORDER BY break_number ASC, break_label ASC, rowid ASC`)
    .all(customerId) as TeamSlotRow[]
  return rows.map(toTeamSlot)
}

// ---------------------------------------------------------------------------
// Reads — shipments
// ---------------------------------------------------------------------------

const SHIPMENT_SELECT = `
  SELECT id, customer_id, tracking_number, carrier, service_type, weight_oz, usps_url,
         status_code, status_set_at, status_set_by, notes, packed_at, packed_by,
         on_hold, held_reason, queue_order, special_request, special_request_at,
         special_request_by, last_updated
  FROM ship_shipments
`

export function listShipShipments(): ShipShipment[] {
  const rows = getDb()
    .prepare(`${SHIPMENT_SELECT} ORDER BY queue_order ASC, rowid ASC`)
    .all() as ShipmentRow[]
  return rows.map(toShipment)
}

export function getShipShipment(id: string): ShipShipment | null {
  const row = getDb().prepare(`${SHIPMENT_SELECT} WHERE id = ?`).get(id) as ShipmentRow | undefined
  return row ? toShipment(row) : null
}

export function getShipShipmentByCustomer(customerId: string): ShipShipment | null {
  const row = getDb().prepare(`${SHIPMENT_SELECT} WHERE customer_id = ?`).get(customerId) as
    | ShipmentRow
    | undefined
  return row ? toShipment(row) : null
}

/** Every shipment carrying a tracking number, in queue order. */
export function listShipTrackingNumbers(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT tracking_number FROM ship_shipments
        WHERE tracking_number IS NOT NULL AND TRIM(tracking_number) <> ''
        ORDER BY queue_order ASC, rowid ASC`
    )
    .all() as Array<{ tracking_number: string }>
  return rows.map((r) => r.tracking_number.trim())
}

// ---------------------------------------------------------------------------
// Reads — orders / batch urls / audit / warnings
// ---------------------------------------------------------------------------

const ORDER_SELECT = `
  SELECT id, customer_id, break_id, break_number, team_name, price, is_giveaway
  FROM ship_orders
`

export function listShipOrders(): ShipOrder[] {
  const rows = getDb().prepare(`${ORDER_SELECT} ORDER BY rowid ASC`).all() as OrderRow[]
  return rows.map(toOrder)
}

export function listShipOrdersByCustomer(customerId: string): ShipOrder[] {
  const rows = getDb()
    .prepare(`${ORDER_SELECT} WHERE customer_id = ? ORDER BY rowid ASC`)
    .all(customerId) as OrderRow[]
  return rows.map(toOrder)
}

export function listShipBatchUrls(): ShipBatchUrl[] {
  const rows = getDb()
    .prepare(`SELECT batch_number, count, url FROM ship_batch_urls ORDER BY batch_number ASC`)
    .all() as BatchUrlRow[]
  return rows.map(toBatchUrl)
}

const AUDIT_SELECT = `
  SELECT break_id, break_label, break_number, team_count, distinct_team_count, max_teams,
         missing_count, missing_teams, has_all, collisions
  FROM ship_break_audit
`

export function listShipBreakAudit(): ShipBreakAudit[] {
  const rows = getDb()
    .prepare(`${AUDIT_SELECT} ORDER BY break_number ASC, break_label ASC`)
    .all() as BreakAuditRow[]
  return rows.map(toBreakAudit)
}

/**
 * By the BREAK ID. "11" and "11A" have separate slates and so do Thursday's #4
 * and Saturday's — the id is the only key that tells all four apart.
 */
export function getShipBreakAudit(breakId: string): ShipBreakAudit | null {
  const row = getDb().prepare(`${AUDIT_SELECT} WHERE break_id = ?`).get(breakId) as
    | BreakAuditRow
    | undefined
  return row ? toBreakAudit(row) : null
}

export function listShipWarnings(): ShipWarning[] {
  const rows = getDb()
    .prepare(
      `SELECT id, page, message, raw_text, status, note, resolved_at, resolved_by
       FROM ship_warnings
       ORDER BY CASE WHEN status = 'handled' THEN 1 ELSE 0 END, page ASC, rowid ASC`
    )
    .all() as WarningRow[]
  return rows.map(toWarning)
}

/**
 * Mark a flag handled, or put it back.
 *
 * Reversible on purpose: "handled" is somebody's judgement, and the person who
 * clears the wrong one at 1am needs to be able to undo it.
 */
export function setShipWarningStatus(
  id: string,
  status: 'open' | 'handled',
  note: string | null,
  actorId: string | null
): ShipWarning | null {
  const db = getDb()
  db.prepare(
    `UPDATE ship_warnings
       SET status = ?, note = ?, resolved_at = ?, resolved_by = ?
     WHERE id = ?`
  ).run(
    status,
    note?.trim() ? note.trim().slice(0, 500) : null,
    status === 'handled' ? new Date().toISOString() : null,
    status === 'handled' ? actorId : null,
    id
  )
  const row = db
    .prepare(
      `SELECT id, page, message, raw_text, status, note, resolved_at, resolved_by
       FROM ship_warnings WHERE id = ?`
    )
    .get(id) as WarningRow | undefined
  return row ? toWarning(row) : null
}

/** How many flags still want a human. Drives the tab badge. */
export function openShipWarningCount(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM ship_warnings WHERE status <> 'handled'`)
    .get() as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

function countOf(database: Database.Database, table: string, where = ''): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }
  return row.n
}

export function getShipDataCounts(): ShipDataCounts {
  const database = getDb()
  return {
    customers: countOf(database, 'ship_customers'),
    breaks: countOf(database, 'ship_breaks'),
    teamSlots: countOf(database, 'ship_team_slots'),
    orders: countOf(database, 'ship_orders'),
    shipments: countOf(database, 'ship_shipments'),
    // OPEN flags only. The badge and the Today tile both say "to look at", and
    // counting handled ones meant clearing every flag on the list left the
    // badge sitting at its original number forever — which is how a badge stops
    // meaning anything and people stop opening the tab.
    warnings: countOf(database, 'ship_warnings', "WHERE status != 'handled'"),
    // BAGGED at the bench (step 3) and PICKED into a package (step 4) are two
    // different facts about a card — see the v64 note in database.ts. Both are
    // real work somebody did, so both are counted, separately.
    checkedSlots: countOf(database, 'ship_team_slots', 'WHERE checked_off = 1'),
    pickedSlots: countOf(database, 'ship_team_slots', 'WHERE picked_at IS NOT NULL')
  }
}

/** True when a dataset has been imported (the workspace has something to show). */
export function hasShipDataset(): boolean {
  return countOf(getDb(), 'ship_customers') > 0
}

// ---------------------------------------------------------------------------
// Mutations — shipments
// ---------------------------------------------------------------------------

/**
 * Patch a shipment. Only the keys present on `patch` are written; `lastUpdated`
 * is always stamped. Returns the fresh row so a caller can reconcile one order
 * without a full refetch.
 */
export function updateShipment(id: string, patch: ShipShipmentPatch): ShipShipment | null {
  const sets: string[] = []
  const vals: unknown[] = []
  const put = (col: string, val: unknown): void => {
    sets.push(`${col} = ?`)
    vals.push(val)
  }

  if (patch.trackingNumber !== undefined) put('tracking_number', patch.trackingNumber)
  if (patch.carrier !== undefined) put('carrier', patch.carrier)
  if (patch.serviceType !== undefined) put('service_type', patch.serviceType)
  if (patch.weightOz !== undefined) put('weight_oz', patch.weightOz)
  if (patch.uspsUrl !== undefined) put('usps_url', patch.uspsUrl)
  if (patch.manualStatus !== undefined) {
    put('status_code', patch.manualStatus.code)
    put('status_set_at', patch.manualStatus.setAt)
    put('status_set_by', patch.manualStatus.setBy)
  }
  if (patch.notes !== undefined) put('notes', patch.notes)
  if (patch.packedAt !== undefined) put('packed_at', patch.packedAt)
  if (patch.packedBy !== undefined) put('packed_by', patch.packedBy)
  if (patch.onHold !== undefined) put('on_hold', flag(patch.onHold))
  if (patch.heldReason !== undefined) put('held_reason', patch.heldReason)
  if (patch.queueOrder !== undefined) put('queue_order', Math.trunc(num(patch.queueOrder)))
  if (patch.specialRequest !== undefined) {
    const sr = patch.specialRequest
    put('special_request', sr && sr.text.trim() !== '' ? sr.text : null)
    put('special_request_at', sr && sr.text.trim() !== '' ? sr.setAt : null)
    put('special_request_by', sr && sr.text.trim() !== '' ? sr.setBy : null)
  }

  put('last_updated', nowIso())
  const res = getDb()
    .prepare(`UPDATE ship_shipments SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals, id)
  if (res.changes === 0) return null
  return getShipShipment(id)
}

/** Highest queue_order currently in use (0 when there are no shipments). */
export function maxShipQueueOrder(): number {
  const row = getDb().prepare(`SELECT MAX(queue_order) AS n FROM ship_shipments`).get() as {
    n: number | null
  }
  return num(row?.n)
}

/** Renumber the queue 0..n-1 in the current visual order (held rows last). */
export function resetShipQueueOrder(): number {
  const database = getDb()
  const rows = database
    .prepare(`SELECT id FROM ship_shipments ORDER BY on_hold ASC, queue_order ASC, rowid ASC`)
    .all() as Array<{ id: string }>
  const upd = database.prepare(`UPDATE ship_shipments SET queue_order = ? WHERE id = ?`)
  database.transaction(() => {
    rows.forEach((r, i) => upd.run(i, r.id))
  })()
  return rows.length
}

// ---------------------------------------------------------------------------
// Mutations — team slots + break status
// ---------------------------------------------------------------------------

export function setTeamSlotChecked(id: string, checked: boolean, by: string | null): ShipTeamSlot | null {
  const res = getDb()
    .prepare(
      `UPDATE ship_team_slots
          SET checked_off = ?, checked_off_at = ?, checked_off_by = ?
        WHERE id = ?`
    )
    .run(flag(checked), checked ? nowIso() : null, checked ? by : null, id)
  if (res.changes === 0) return null
  return getShipTeamSlot(id)
}

/**
 * Sleeved, top-loaded, or both — and who did it.
 *
 * Two flags because step 1 consumes two supplies at two different rates. A card
 * can be sleeved without being top-loaded (half of them are); the reverse is
 * not a real state, so top-loading a card sleeves it.
 *
 * Stamps a who and a when, which the single flag never did — a work record with
 * no name on it cannot answer the only question anybody asks it later.
 */
export function setTeamSlotSleeve(
  id: string,
  which: 'sleeved' | 'top_sleeved',
  on: boolean,
  by: string | null
): ShipTeamSlot | null {
  const ts = on ? nowIso() : null
  const db = getDb()
  const res =
    which === 'top_sleeved'
      ? db
          .prepare(
            `UPDATE ship_team_slots
                SET top_sleeved = ?, top_sleeved_at = ?, top_sleeved_by = ?,
                    -- Top-loading implies sleeving: the card goes in a sleeve
                    -- and then into the loader. Leaving the sleeved flag at 0
                    -- here would report the night as half done.
                    sleeved = CASE WHEN ? = 1 THEN 1 ELSE sleeved END,
                    sleeved_at = CASE WHEN ? = 1 AND sleeved = 0 THEN ? ELSE sleeved_at END,
                    sleeved_by = CASE WHEN ? = 1 AND sleeved = 0 THEN ? ELSE sleeved_by END
              WHERE id = ?`
          )
          .run(flag(on), ts, on ? by : null, flag(on), flag(on), ts, flag(on), by, id)
      : db
          .prepare(
            `UPDATE ship_team_slots
                SET sleeved = ?, sleeved_at = ?, sleeved_by = ?,
                    -- Un-sleeving a card cannot leave it top-loaded.
                    top_sleeved = CASE WHEN ? = 0 THEN 0 ELSE top_sleeved END
              WHERE id = ?`
          )
          .run(flag(on), ts, on ? by : null, flag(on), id)
  if (res.changes === 0) return null
  return getShipTeamSlot(id)
}

/** Kept for the break-level "sleeve them all" action. */
export function setTeamSlotTopSleeved(id: string, on: boolean): ShipTeamSlot | null {
  return setTeamSlotSleeve(id, 'top_sleeved', on, null)
}

/** Check (or clear) every slot in a break at once. Returns the rows touched. */
export function setBreakSlotsChecked(breakId: string, checked: boolean, by: string | null): number {
  return getDb()
    .prepare(
      `UPDATE ship_team_slots
          SET checked_off = ?, checked_off_at = ?, checked_off_by = ?
        WHERE break_id = ?`
    )
    .run(flag(checked), checked ? nowIso() : null, checked ? by : null, breakId).changes
}

/**
 * Check off (or un-check) every card in ONE customer's package.
 *
 * A single statement rather than a loop of round trips: an order can hold
 * forty-seven cards, and forty-seven separate writes is forty-seven chances to
 * be interrupted half way and leave a package that is neither picked nor not.
 *
 * `onlyUnchecked` is what makes this safe to fire from "Next order": it leaves
 * a card that was already ticked exactly as it was, attribution and timestamp
 * intact, so walking past a package does not rewrite who found what.
 */
export function setCustomerSlotsChecked(
  customerId: string,
  checked: boolean,
  by: string | null,
  onlyUnchecked = false
): number {
  const guard = onlyUnchecked ? ` AND checked_off = ${checked ? 0 : 1}` : ''
  return getDb()
    .prepare(
      `UPDATE ship_team_slots
          SET checked_off = ?, checked_off_at = ?, checked_off_by = ?
        WHERE customer_id = ?${guard}`
    )
    .run(flag(checked), checked ? nowIso() : null, checked ? by : null, customerId).changes
}

// ---------------------------------------------------------------------------
// Picking — step 4, per ORDER. A different fact from bagging; see the v64 note
// in database.ts for why these are not the same column.
// ---------------------------------------------------------------------------

/** Gather (or un-gather) ONE card into its buyer's package. */
export function setTeamSlotPicked(id: string, picked: boolean, by: string | null): ShipTeamSlot | null {
  const res = getDb()
    .prepare(
      `UPDATE ship_team_slots SET picked_at = ?, picked_by = ? WHERE id = ?`
    )
    .run(picked ? nowIso() : null, picked ? by : null, id)
  if (res.changes === 0) return null
  return getShipTeamSlot(id)
}

/**
 * Gather (or un-gather) every card in ONE customer's package.
 *
 * One statement rather than a loop, for the reason `setCustomerSlotsChecked`
 * gives: an order can hold forty-seven cards and forty-seven writes is
 * forty-seven chances to be interrupted half way.
 *
 * `onlyUnpicked` leaves an already-gathered card exactly as it was — its
 * timestamp and who did it intact — so walking past a package does not rewrite
 * the record of who collected what.
 */
export function setCustomerSlotsPicked(
  customerId: string,
  picked: boolean,
  by: string | null,
  onlyUnpicked = false
): number {
  const guard = onlyUnpicked ? (picked ? ' AND picked_at IS NULL' : ' AND picked_at IS NOT NULL') : ''
  return getDb()
    .prepare(
      `UPDATE ship_team_slots SET picked_at = ?, picked_by = ? WHERE customer_id = ?${guard}`
    )
    .run(picked ? nowIso() : null, picked ? by : null, customerId).changes
}

/** The breaks a customer's cards sit in — what has to be re-derived after. */
export function listBreakIdsForCustomer(customerId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT DISTINCT break_id FROM ship_team_slots WHERE customer_id = ?`)
    .all(customerId) as Array<{ break_id: string | null }>
  return rows.map((r) => str(r.break_id)).filter(Boolean)
}

/** Top-sleeve (or un-sleeve) every slot in a break. Returns the rows touched. */
export function setBreakSlotsTopSleeved(breakId: string, on: boolean): number {
  return getDb()
    .prepare(`UPDATE ship_team_slots SET top_sleeved = ? WHERE break_id = ?`)
    .run(flag(on), breakId).changes
}

// ---------------------------------------------------------------------------
// The bench checklist — steps 1 and 2, and the bags for unsold teams
// ---------------------------------------------------------------------------

/**
 * Stamp (or clear) one of the two whole-break steps.
 *
 * A stamp rather than a boolean: the one question ever asked about a break that
 * came out wrong is who had it, and a `1` cannot answer that.
 */
export function setBreakStepStamp(
  breakId: string,
  step: 'sleeve' | 'sort',
  done: boolean,
  by: string | null
): ShipBreak | null {
  const atCol = step === 'sleeve' ? 'sleeved_at' : 'sorted_at'
  const byCol = step === 'sleeve' ? 'sleeved_by' : 'sorted_by'
  const res = getDb()
    .prepare(`UPDATE ship_breaks SET ${atCol} = ?, ${byCol} = ? WHERE id = ?`)
    .run(done ? nowIso() : null, done ? by : null, breakId)
  if (res.changes === 0) return null
  return getShipBreak(breakId)
}

export interface BreakTeamBagRow {
  breakId: string
  teamName: string
  baggedAt: string | null
  baggedBy: string | null
}

/** Every unsold-team bag recorded for a break. */
export function listBreakTeamBags(breakId: string): BreakTeamBagRow[] {
  const rows = getDb()
    .prepare(
      `SELECT break_id, team_name, bagged_at, bagged_by
         FROM ship_break_team_bags
        WHERE break_id = ? AND bagged_at IS NOT NULL`
    )
    .all(breakId) as Array<{
    break_id: string
    team_name: string
    bagged_at: string | null
    bagged_by: string | null
  }>
  return rows.map((r) => ({
    breakId: r.break_id,
    teamName: r.team_name,
    baggedAt: r.bagged_at,
    baggedBy: r.bagged_by
  }))
}

/** How many unsold teams are bagged, per break, in one pass. */
export function countBreakTeamBags(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT break_id, COUNT(*) AS n
         FROM ship_break_team_bags
        WHERE bagged_at IS NOT NULL
        GROUP BY break_id`
    )
    .all() as Array<{ break_id: string; n: number }>
  return new Map(rows.map((r) => [r.break_id, r.n]))
}

/**
 * Bag (or un-bag) a team that nobody bought.
 *
 * UPSERTS on the derived id so two benches doing the same team converge on one
 * row instead of racing to create two. Un-bagging clears the stamp rather than
 * deleting the row: a deleted row and a never-created row are indistinguishable
 * to a sync that arbitrates by comparing rows, so the tombstone has to be a
 * value rather than an absence.
 */
export function setBreakTeamBagged(
  breakId: string,
  teamName: string,
  bagged: boolean,
  by: string | null
): BreakTeamBagRow {
  const at = nowIso()
  getDb()
    .prepare(
      `INSERT INTO ship_break_team_bags
         (id, break_id, team_name, bagged_at, bagged_by, created_at, updated_at)
       VALUES (@id, @breakId, @teamName, @baggedAt, @baggedBy, @at, @at)
       ON CONFLICT(id) DO UPDATE SET
         bagged_at  = excluded.bagged_at,
         bagged_by  = excluded.bagged_by,
         updated_at = excluded.updated_at`
    )
    .run({
      id: bagRowId(breakId, teamName),
      breakId,
      teamName,
      baggedAt: bagged ? at : null,
      baggedBy: bagged ? by : null,
      at
    })
  return { breakId, teamName, baggedAt: bagged ? at : null, baggedBy: bagged ? by : null }
}

export function setBreakStatus(id: string, status: ShipBreakStatus): ShipBreak | null {
  const res = getDb().prepare(`UPDATE ship_breaks SET status = ? WHERE id = ?`).run(status, id)
  if (res.changes === 0) return null
  return getShipBreak(id)
}

/**
 * Correct a break's league by hand, and re-read its team names against it.
 *
 * Detection is a vote on the names the slip printed, so a break that sold four
 * cards can be called wrong — and once it is wrong it stays wrong, because the
 * raw slip text is not kept. This is the way back.
 *
 * The write is three things at once, and they have to move together or the
 * break is left describing itself in two leagues:
 *   1. the stored league,
 *   2. every team name in the break, re-matched against the new slate,
 *   3. the fidelity audit, which reads "how many teams should be here" off the
 *      league and would otherwise still be measuring against the old one.
 *
 * A name is only REPLACED when the new league recognises it. Anything it does
 * not recognise is left exactly as printed rather than blanked — a card the app
 * cannot name is still a card somebody has to pull, and the printed text is the
 * only thing left to find it by.
 *
 * `null` puts the break back on the import's own league, which is what every
 * break imported before per-break detection carries.
 */
export function setBreakSport(id: string, sport: ShipSport | null): ShipBreak | null {
  const db = getDb()
  const current = getShipBreak(id)
  if (!current) return null

  const matcher = sport ? createTeamMatcher(sport) : null
  const label = current.breakLabel || String(current.breakNumber ?? '')
  const slots = db
    .prepare(`SELECT id, team_name, customer_id FROM ship_team_slots WHERE break_id = ?`)
    .all(id) as { id: string; team_name: string | null; customer_id: string | null }[]

  const renamed = slots.map((s) => {
    const printed = (s.team_name ?? '').trim()
    return {
      id: s.id,
      customerId: s.customer_id ?? '',
      teamName: (matcher ? matcher.canonical(printed) : null) ?? printed
    }
  })

  const audit = auditOneBreak(
    id,
    label,
    Number(current.breakNumber ?? 0),
    renamed.map((r) => ({ teamName: r.teamName, customerId: r.customerId })),
    matcher
  )

  const write = db.transaction(() => {
    db.prepare(`UPDATE ship_breaks SET sport = ? WHERE id = ?`).run(sport, id)
    const rename = db.prepare(`UPDATE ship_team_slots SET team_name = ? WHERE id = ?`)
    for (const r of renamed) rename.run(r.teamName, r.id)
    /**
     * A break imported before the audit table gained a row for it has none — so
     * this is an upsert, not an update. Guarding on `changes === 0` and giving
     * up would leave the operator's correction half-applied: right league,
     * stale slate.
     */
    db.prepare(`DELETE FROM ship_break_audit WHERE break_id = ?`).run(id)
    db.prepare(
      `INSERT INTO ship_break_audit
         (break_id, break_label, break_number, team_count, distinct_team_count, max_teams,
          missing_count, missing_teams, has_all, collisions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      audit.breakId,
      audit.breakLabel,
      audit.breakNumber,
      audit.teamCount,
      audit.distinctTeamCount,
      audit.maxTeams,
      audit.missingCount,
      JSON.stringify(audit.missingTeams),
      audit.hasAll ? 1 : 0,
      JSON.stringify(audit.collisions)
    )
  })
  write()
  return getShipBreak(id)
}

/**
 * Section 5's status recompute: `packed` / `shipped` are explicit human states
 * and are STICKY (un-packing is a deliberate action), so a check-off edit only
 * ever moves a break between `pending` and `picking`.
 */
export function recomputeBreakStatus(breakId: string): ShipBreak | null {
  const current = getShipBreak(breakId)
  if (!current) return null
  if (current.status === 'packed' || current.status === 'shipped') return current
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM ship_team_slots WHERE break_id = ? AND checked_off = 1`)
    .get(breakId) as { n: number }
  const next: ShipBreakStatus = row.n === 0 ? 'pending' : 'picking'
  if (next === current.status) return current
  return setBreakStatus(breakId, next)
}

// ---------------------------------------------------------------------------
// Break assignments (v17) — who is sorting which break
// ---------------------------------------------------------------------------

const ASSIGNMENT_SELECT = `
  SELECT id, break_id, break_number, employee_id, assigned_at, assigned_by, note
  FROM ship_break_assignments
`

/** Oldest first, so a break card reads in the order people were put on it. */
const ASSIGNMENT_ORDER = `ORDER BY assigned_at ASC, rowid ASC`

export function listShipBreakAssignments(): ShipBreakAssignment[] {
  const rows = getDb()
    .prepare(`${ASSIGNMENT_SELECT} ${ASSIGNMENT_ORDER}`)
    .all() as BreakAssignmentRow[]
  return rows.map(toBreakAssignment)
}

export function listShipBreakAssignmentsByBreak(breakId: string): ShipBreakAssignment[] {
  const rows = getDb()
    .prepare(`${ASSIGNMENT_SELECT} WHERE break_id = ? ${ASSIGNMENT_ORDER}`)
    .all(breakId) as BreakAssignmentRow[]
  return rows.map(toBreakAssignment)
}

export function getShipBreakAssignment(id: string): ShipBreakAssignment | null {
  const row = getDb().prepare(`${ASSIGNMENT_SELECT} WHERE id = ?`).get(id) as
    | BreakAssignmentRow
    | undefined
  return row ? toBreakAssignment(row) : null
}

export function findShipBreakAssignment(
  breakId: string,
  employeeId: string
): ShipBreakAssignment | null {
  const row = getDb()
    .prepare(`${ASSIGNMENT_SELECT} WHERE break_id = ? AND employee_id = ?`)
    .get(breakId, employeeId) as BreakAssignmentRow | undefined
  return row ? toBreakAssignment(row) : null
}

export function countShipBreakAssignments(): number {
  return countOf(getDb(), 'ship_break_assignments')
}

/**
 * Put an employee on a break. Idempotent by (break, person): re-assigning the
 * same person refreshes the stamp and note instead of stacking a duplicate row
 * on the card — the UNIQUE index makes that the database's rule, not a
 * caller's discipline.
 */
export function assignShipBreak(
  input: ShipBreakAssignmentInput & { breakNumber: number | null; assignedBy: string | null }
): ShipBreakAssignment {
  const breakId = str(input.breakId).trim()
  const employeeId = str(input.employeeId).trim()
  const note = str(input.note).trim() || null
  getDb()
    .prepare(
      `INSERT INTO ship_break_assignments
         (id, break_id, break_number, employee_id, assigned_at, assigned_by, note, import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(break_id, employee_id) DO UPDATE
           SET break_number = excluded.break_number,
               assigned_at  = excluded.assigned_at,
               assigned_by  = excluded.assigned_by,
               note         = excluded.note,
               import_id    = excluded.import_id`
    )
    .run(
      newId(),
      breakId,
      input.breakNumber ?? null,
      employeeId,
      nowIso(),
      input.assignedBy,
      note,
      // Which show this assignment belongs to. Break labels recur, so without
      // this an assignment silently follows its number onto the next show.
      liveImportIds(getDb())[0] ?? null
    )
  const saved = findShipBreakAssignment(breakId, employeeId)
  if (!saved) throw new Error('The assignment could not be saved.')
  return saved
}

export function deleteShipBreakAssignment(id: string): boolean {
  return getDb().prepare(`DELETE FROM ship_break_assignments WHERE id = ?`).run(id).changes > 0
}

export function deleteShipBreakAssignmentFor(breakId: string, employeeId: string): boolean {
  return (
    getDb()
      .prepare(`DELETE FROM ship_break_assignments WHERE break_id = ? AND employee_id = ?`)
      .run(breakId, employeeId).changes > 0
  )
}

/**
 * Drop assignments whose break is no longer in the dataset. Run after every
 * import and after a dataset clear: assignments deliberately SURVIVE a
 * re-import (break ids are stable), so pruning is what stops a break that
 * genuinely went away from leaving a ghost on the Admin board.
 */
/**
 * Drop assignments whose break is gone — but re-home the ones that only LOOK
 * gone first.
 *
 * A break's id is `break_<label>`, so the day a show's "#11" was read as the
 * "#11A" it was actually printed as, every assignment on it pointed at an id
 * that no longer existed and was deleted without a word. The person sorting
 * that break simply vanished from it, and the board read "nobody on this one"
 * for a break somebody was standing over.
 *
 * So: an orphan whose break_number matches exactly ONE break in the new dataset
 * is moved onto it. Exactly one, because two breaks sharing a number (#11 and
 * #11A both running) is precisely the case where guessing would put someone on
 * the wrong pile — there the orphan is dropped and the lead re-assigns, which
 * is visible. Anything that matches nothing is genuinely gone and goes too.
 */
export function pruneShipBreakAssignments(database?: Database.Database): number {
  const db = database ?? getDb()

  const orphans = db
    .prepare(
      `SELECT id, break_id, break_number, employee_id FROM ship_break_assignments
        WHERE break_id NOT IN (SELECT id FROM ship_breaks)`
    )
    .all() as Array<{ id: string; break_id: string; break_number: number | null; employee_id: string }>

  if (orphans.length > 0) {
    const candidates = db.prepare(`SELECT id FROM ship_breaks WHERE break_number = ?`)
    const taken = db.prepare(
      `SELECT 1 FROM ship_break_assignments WHERE break_id = ? AND employee_id = ?`
    )
    const rehome = db.prepare(`UPDATE ship_break_assignments SET break_id = ? WHERE id = ?`)
    for (const o of orphans) {
      if (o.break_number === null) continue
      const matches = candidates.all(o.break_number) as Array<{ id: string }>
      if (matches.length !== 1) continue
      // UNIQUE(break_id, employee_id): if they are already on the new break,
      // leave the orphan to be deleted rather than failing the whole import.
      if (taken.get(matches[0].id, o.employee_id)) continue
      rehome.run(matches[0].id, o.id)
    }
  }

  // Assignments made against a show that is no longer on the floor.
  //
  // THE BUG THIS FIXES: break ids are `break_<label>` and labels recur — every
  // show has a break 4 and a break 11. Deleting only ABSENT ids meant an
  // assignment from last Tuesday survived onto this Tuesday's break of the same
  // number, silently, with the board looking perfectly correct.
  //
  // Liveness is the same chain the work claims use: an assignment survives only
  // while its import is on the run of carry-forwards ending at the newest one.
  // A NULL import_id predates the column and is treated as this show's, so
  // upgrading mid-shift does not clear the board out from under anybody.
  const chain = liveImportIds(db)
  const stale =
    chain.length > 0
      ? db
          .prepare(
            `DELETE FROM ship_break_assignments
              WHERE import_id IS NOT NULL AND import_id NOT IN (${chain.map(() => '?').join(',')})`
          )
          .run(...chain).changes
      : 0

  return (
    stale +
    db
      .prepare(
        `DELETE FROM ship_break_assignments
          WHERE break_id NOT IN (SELECT id FROM ship_breaks)`
      )
      .run().changes
  )
}

/**
 * The imports whose operator state is still live — newest, plus every import it
 * carried forward from. Duplicated from shipStations.ts on purpose: that module
 * imports this one, and a cycle for six lines of SQL is a bad trade.
 */
function liveImportIds(db: Database.Database): string[] {
  const newest = db
    .prepare(`SELECT id, carried_from FROM ship_imports ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get() as { id: string; carried_from: string | null } | undefined
  if (!newest) return []
  const out: string[] = []
  const seen = new Set<string>()
  let cur: { id: string; carried_from: string | null } | undefined = newest
  while (cur && !seen.has(cur.id) && out.length < 20) {
    out.push(cur.id)
    seen.add(cur.id)
    cur = cur.carried_from
      ? (db.prepare(`SELECT id, carried_from FROM ship_imports WHERE id = ?`).get(cur.carried_from) as
          | { id: string; carried_from: string | null }
          | undefined)
      : undefined
  }
  return out
}

// ---------------------------------------------------------------------------
// Import — section 7
// ---------------------------------------------------------------------------

/** The dataset tables an import overwrites. Imports/snapshots/settings persist. */
const DATASET_TABLES = [
  'ship_breaks',
  'ship_customers',
  'ship_team_slots',
  'ship_shipments',
  'ship_orders',
  'ship_batch_urls',
  'ship_break_audit',
  'ship_warnings',
  // Dataset state, NOT operator state, despite being ticked by hand.
  //
  // Its id is derived from the break id and the team, and a break id is
  // `break_<label>` — which repeats every show. Left behind, next week's #11A
  // would open with last week's teams already bagged, and the bench would skip
  // real work because a previous show said it was done.
  'ship_break_team_bags'
] as const

/**
 * Wipe the active dataset (leaves import history, snapshots and settings).
 *
 * Break assignments are not in DATASET_TABLES — they are operator state — but
 * clearing the dataset removes every break, so the prune takes them all with it
 * rather than leaving orphans pointing at breaks that no longer exist.
 */
export function clearShipDataset(): void {
  const database = getDb()
  database.transaction(() => {
    for (const t of DATASET_TABLES) database.prepare(`DELETE FROM ${t}`).run()
    database.prepare(`DELETE FROM ship_event WHERE id = 1`).run()
    pruneShipBreakAssignments(database)
  })()
}

/** Carry-forward key for a team slot: `handle|breakNumber|teamName`. */
/**
 * The carry-forward identity of one card across a re-import.
 *
 * Keyed on the printed LABEL, not the number: re-importing a show that ran both
 * #11 and #11A would otherwise let a Yankees card picked in #11 hand its tick to
 * the Yankees card in #11A, and the floor would be told a card was found that
 * nobody has touched.
 */
function slotKey(customerId: string, breakLabel: string | null, teamName: string): string {
  const bl = breakLabel === null || breakLabel === undefined ? '' : String(breakLabel).trim()
  return `${customerId}|${bl}|${str(teamName).trim().toLowerCase()}`
}

function datasetCounts(dataset: ShippingDataset): ShipImportCounts {
  let giveaways = 0
  let cardValue = 0
  for (const s of dataset.teamSlots) {
    if (s.isGiveaway) giveaways += 1
    cardValue += num(s.price)
  }
  return {
    customers: dataset.customers.length,
    breaks: dataset.breaks.length,
    teamSlots: dataset.teamSlots.length,
    orders: dataset.orders.length,
    shipments: dataset.shipments.length,
    warnings: dataset.warnings.length,
    giveaways,
    cardValue: cents(cardValue)
  }
}

export interface ImportDatasetOptions {
  filename: string
  /** Human label for the import-history row; defaults to the filename. */
  name?: string
  sourceKind?: ShipImportKind
  /** The operator asked to keep the outgoing dataset's pick/pack progress. The
   *  identity check below still has to agree — this only permits it. */
  carryForward?: boolean
}

/**
 * Replace the active dataset with `dataset` (architecture doc section 7).
 *
 * Carry-forward is deliberately conservative: it happens ONLY when the previous
 * event name is non-empty AND identical to the incoming one AND the dates match.
 * A brand-new upload — or any PDF with no event name, which is most of them —
 * starts completely fresh: every order To Pick, nothing pre-checked.
 *
 * Everything runs in ONE transaction (better-sqlite3 nests it as a SAVEPOINT if
 * a caller already opened one), so a throw anywhere leaves the previous dataset
 * untouched.
 */
export function importDataset(
  dataset: ShippingDataset,
  opts: ImportDatasetOptions
): ShipImportResult {
  const database = getDb()
  const counts = datasetCounts(dataset)
  const createdAt = nowIso()
  const kind: ShipImportKind = opts.sourceKind ?? 'pdf'
  const importName = str(opts.name).trim() || str(opts.filename).trim() || 'Import'
  const importId = newId()

  const run = database.transaction((): ShipImportResult => {
    // --- 1. capture the outgoing operator state ---------------------------
    const prevEvent = getShipEvent()
    const prevShipments = listShipShipments()
    const prevSlots = listShipTeamSlots()
    const prevBreaks = listShipBreaks()

    // --- 2. overwrite every dataset array ---------------------------------
    for (const t of DATASET_TABLES) database.prepare(`DELETE FROM ${t}`).run()

    const eventName = str(dataset.event?.name).trim()
    const eventDate = str(dataset.event?.date).trim()
    database
      .prepare(
        `INSERT INTO ship_event (id, name, date, updated_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                         date = excluded.date,
                                         updated_at = excluded.updated_at`
      )
      .run(eventName, eventDate, createdAt)

    const insBreak = database.prepare(
      `INSERT INTO ship_breaks
         (id, break_label, break_number, sport, show_id, event_name, event_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const b of dataset.breaks) {
      insBreak.run(
        b.id,
        b.breakLabel || String(b.breakNumber),
        b.breakNumber,
        asShipSport(b.sport),
        str(b.showId) || null,
        str(b.eventName) || eventName,
        str(b.eventDate) || eventDate,
        b.status ?? 'pending'
      )
    }

    const insCustomer = database.prepare(
      `INSERT INTO ship_customers (id, whatnot_handle, real_name, address, is_new, pages)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const c of dataset.customers) {
      insCustomer.run(
        c.id,
        str(c.whatnotHandle) || c.id,
        str(c.realName),
        str(c.address),
        flag(c.isNew),
        JSON.stringify(Array.isArray(c.pages) ? c.pages : [])
      )
    }

    const insSlot = database.prepare(
      `INSERT INTO ship_team_slots
         (id, break_id, break_label, break_number, team_name, customer_id, order_id, price,
          is_giveaway, top_sleeved, checked_off, checked_off_at, checked_off_by,
          slip_page, slip_position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const s of dataset.teamSlots) {
      insSlot.run(
        s.id,
        s.breakId,
        s.breakLabel ?? (s.breakNumber === null || s.breakNumber === undefined ? null : String(s.breakNumber)),
        s.breakNumber ?? null,
        str(s.teamName),
        s.customerId,
        s.orderId ?? null,
        cents(num(s.price)),
        flag(s.isGiveaway),
        flag(s.topSleeved),
        flag(s.checkedOff),
        s.checkedOff ? (s.checkedOffAt ?? null) : null,
        s.checkedOff ? (s.checkedOffBy ?? null) : null,
        s.slipPage ?? null,
        s.slipPosition ?? null
      )
    }

    const insShipment = database.prepare(
      `INSERT INTO ship_shipments
         (id, customer_id, tracking_number, carrier, service_type, weight_oz, usps_url,
          status_code, status_set_at, status_set_by, notes, packed_at, packed_by,
          on_hold, held_reason, queue_order, special_request, special_request_at,
          special_request_by, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    dataset.shipments.forEach((sh, i) => {
      const sr = sh.specialRequest && sh.specialRequest.text.trim() !== '' ? sh.specialRequest : null
      insShipment.run(
        sh.id,
        sh.customerId,
        sh.trackingNumber ?? null,
        sh.carrier ?? null,
        sh.serviceType ?? null,
        sh.weightOz ?? null,
        sh.uspsUrl ?? null,
        sh.manualStatus?.code ?? 'not_shipped',
        sh.manualStatus?.setAt ?? null,
        sh.manualStatus?.setBy ?? null,
        sh.notes ?? null,
        sh.packedAt ?? null,
        sh.packedBy ?? null,
        flag(sh.onHold),
        sh.heldReason ?? null,
        sh.queueOrder === undefined ? i : Math.trunc(num(sh.queueOrder)),
        sr ? sr.text : null,
        sr ? sr.setAt : null,
        sr ? sr.setBy : null,
        sh.lastUpdated ?? createdAt
      )
    })

    const insOrder = database.prepare(
      `INSERT INTO ship_orders
         (id, customer_id, break_id, break_number, team_name, price, is_giveaway)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const o of dataset.orders) {
      insOrder.run(
        o.id,
        o.customerId,
        o.breakId,
        o.breakNumber ?? null,
        str(o.teamName),
        cents(num(o.price)),
        flag(o.isGiveaway)
      )
    }

    const insBatch = database.prepare(
      `INSERT INTO ship_batch_urls (batch_number, count, url) VALUES (?, ?, ?)`
    )
    for (const b of dataset.batchUrls) insBatch.run(b.batchNumber, num(b.count), str(b.url))

    const insAudit = database.prepare(
      `INSERT INTO ship_break_audit
         (break_id, break_label, break_number, team_count, distinct_team_count, max_teams,
          missing_count, missing_teams, has_all, collisions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const a of dataset.breakAudit) {
      insAudit.run(
        a.breakId || `break_${a.breakLabel || String(a.breakNumber)}`,
        a.breakLabel || String(a.breakNumber),
        a.breakNumber,
        num(a.teamCount),
        num(a.distinctTeamCount),
        num(a.maxTeams),
        num(a.missingCount),
        JSON.stringify(a.missingTeams ?? []),
        flag(a.hasAll),
        JSON.stringify(a.collisions ?? [])
      )
    }

    const insWarning = database.prepare(
      `INSERT INTO ship_warnings (id, page, message, raw_text) VALUES (?, ?, ?, ?)`
    )
    dataset.warnings.forEach((w, i) => {
      insWarning.run(`warn_${i + 1}`, w.page ?? null, str(w.message), w.rawText ?? null)
    })

    /**
     * --- 3. carry operator state forward, but only when ASKED and only when it
     * really is the same event.
     *
     * The name-and-date match alone was not evidence. RM runs two shows most
     * days, the event name is auto-suggested as "[Sport] - [Date]", and an
     * operator who does not retype it imports the second show under a string
     * identical to the first — so every repeat customer arrived already stamped
     * packed, already holding the earlier show's notes, holds and manual
     * statuses, and skipped the To Pick queue entirely. Silent, and exactly
     * wrong. The flag comes from a checkbox that is off by default.
     */
    const prevName = str(prevEvent.name).trim()
    const sameEvent =
      opts.carryForward === true &&
      prevName !== '' &&
      prevName === eventName &&
      str(prevEvent.date).trim() === eventDate
    if (sameEvent) {
      carryForwardOperatorState(database, prevShipments, prevSlots, prevBreaks)
    }

    // Break assignments survive an import (break ids are stable), but a break
    // that is no longer in the dataset must not keep one.
    pruneShipBreakAssignments(database)

    // --- 4. append the import-history row ---------------------------------
    //
    // `carried_from` is the EDGE, not the flag. `counts.carriedForward` says
    // that carry-forward happened; the floor pipeline needs to know what it
    // happened FROM, because a work claim is live only while its import is on
    // the chain of carry-forwards ending at the import on the floor now.
    //
    // Deriving liveness from an immutable chain is what lets an import make
    // every previous claim inert with ZERO writes to anyone's claim rows —
    // and that matters, because writing a "closed" flag onto a row a station is
    // concurrently heartbeating puts the two in a last-write-wins contest that
    // the close can simply lose.
    const previousImportId = sameEvent
      ? ((
          database
            .prepare(`SELECT id FROM ship_imports ORDER BY created_at DESC, rowid DESC LIMIT 1`)
            .get() as { id: string } | undefined
        )?.id ?? null)
      : null
    database
      .prepare(
        `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts, carried_from)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        importId,
        importName,
        str(opts.filename),
        kind,
        createdAt,
        JSON.stringify({ ...counts, carriedForward: sameEvent }),
        previousImportId
      )

    const record = getShipImport(importId)
    if (!record) throw new Error('Import history row could not be written')
    return { record, counts, carriedForward: sameEvent, event: getShipEvent() }
  })

  return run()
}

/**
 * Re-attach the previous run's operator state to the freshly imported rows.
 *
 * Shipment state (manual status, notes, holds, queue order, packed stamp,
 * special request) matches BY HANDLE. Slot state (checked off, top sleeved)
 * matches by `handle|breakNumber|teamName`, with duplicates consumed IN ORDER so
 * a customer who owns the same team twice in one break keeps the right count of
 * checked cards rather than double-applying one.
 *
 * Break status is then rebuilt: an explicit `packed`/`shipped` is sticky, and
 * everything else follows the carried check-offs.
 */
function carryForwardOperatorState(
  database: Database.Database,
  prevShipments: ShipShipment[],
  prevSlots: ShipTeamSlot[],
  prevBreaks: ShipBreak[]
): void {
  // --- shipments, by handle -------------------------------------------------
  const prevByHandle = new Map<string, ShipShipment>()
  for (const sh of prevShipments) {
    if (sh.customerId) prevByHandle.set(sh.customerId, sh)
  }
  const updShipment = database.prepare(
    `UPDATE ship_shipments
        SET status_code = ?, status_set_at = ?, status_set_by = ?,
            notes = ?, packed_at = ?, packed_by = ?,
            on_hold = ?, held_reason = ?, queue_order = ?,
            special_request = ?, special_request_at = ?, special_request_by = ?,
            last_updated = ?
      WHERE customer_id = ?`
  )
  const currentShipments = database
    .prepare(`SELECT customer_id FROM ship_shipments`)
    .all() as Array<{ customer_id: string | null }>
  for (const row of currentShipments) {
    const handle = str(row.customer_id)
    const prev = prevByHandle.get(handle)
    if (!prev) continue
    updShipment.run(
      prev.manualStatus.code,
      prev.manualStatus.setAt,
      prev.manualStatus.setBy,
      prev.notes,
      prev.packedAt,
      prev.packedBy,
      flag(prev.onHold),
      prev.heldReason,
      Math.trunc(num(prev.queueOrder)),
      prev.specialRequest ? prev.specialRequest.text : null,
      prev.specialRequest ? prev.specialRequest.setAt : null,
      prev.specialRequest ? prev.specialRequest.setBy : null,
      prev.lastUpdated,
      handle
    )
  }

  // --- team slots, by handle|breakNumber|teamName (duplicates in order) -----
  const queues = new Map<string, ShipTeamSlot[]>()
  for (const s of prevSlots) {
    // Nothing to carry for a slot that was never touched. `picked` counts as
    // touched: a re-import mid-night must not throw away the collecting a
    // packer has already done.
    if (!s.checkedOff && !s.topSleeved && !s.picked) continue
    const key = slotKey(s.customerId, s.breakLabel, s.teamName)
    const list = queues.get(key)
    if (list) list.push(s)
    else queues.set(key, [s])
  }
  if (queues.size > 0) {
    const updSlot = database.prepare(
      `UPDATE ship_team_slots
          SET checked_off = ?, checked_off_at = ?, checked_off_by = ?, top_sleeved = ?,
              picked_at = ?, picked_by = ?
        WHERE id = ?`
    )
    const cursor = new Map<string, number>()
    const currentSlots = database
      .prepare(
        `SELECT id, customer_id, break_label, team_name FROM ship_team_slots ORDER BY rowid ASC`
      )
      .all() as Array<{
      id: string
      customer_id: string | null
      break_label: string | null
      team_name: string | null
    }>
    for (const row of currentSlots) {
      const key = slotKey(str(row.customer_id), row.break_label ?? null, str(row.team_name))
      const list = queues.get(key)
      if (!list) continue
      const i = cursor.get(key) ?? 0
      if (i >= list.length) continue
      cursor.set(key, i + 1)
      const prev = list[i]
      updSlot.run(
        flag(prev.checkedOff),
        prev.checkedOff ? prev.checkedOffAt : null,
        prev.checkedOff ? prev.checkedOffBy : null,
        flag(prev.topSleeved),
        prev.picked ? prev.pickedAt : null,
        prev.picked ? prev.pickedBy : null,
        row.id
      )
    }
  }

  // --- break status: explicit packed/shipped is sticky ---------------------
  // By label — a "#11A packed" must not mark #11 packed when both ran.
  const prevStatusByLabel = new Map<string, ShipBreakStatus>()
  for (const b of prevBreaks) prevStatusByLabel.set(b.breakLabel, b.status)
  const updBreak = database.prepare(`UPDATE ship_breaks SET status = ? WHERE id = ?`)
  const checkedByBreak = new Map<string, number>()
  const checkedRows = database
    .prepare(
      `SELECT break_id, COUNT(*) AS n FROM ship_team_slots WHERE checked_off = 1 GROUP BY break_id`
    )
    .all() as Array<{ break_id: string | null; n: number }>
  for (const r of checkedRows) checkedByBreak.set(str(r.break_id), r.n)
  const breakRows = database
    .prepare(`SELECT id, break_label FROM ship_breaks`)
    .all() as Array<{ id: string; break_label: string | null }>
  for (const b of breakRows) {
    const prevStatus = b.break_label === null ? undefined : prevStatusByLabel.get(b.break_label)
    const next: ShipBreakStatus =
      prevStatus === 'packed' || prevStatus === 'shipped'
        ? prevStatus
        : (checkedByBreak.get(b.id) ?? 0) > 0
          ? 'picking'
          : 'pending'
    updBreak.run(next, b.id)
  }
}

// ---------------------------------------------------------------------------
// Import history
// ---------------------------------------------------------------------------

const IMPORT_SELECT = `SELECT id, name, filename, kind, created_at, counts FROM ship_imports`

export function listShipImports(): ShipImportRecord[] {
  const rows = getDb()
    .prepare(`${IMPORT_SELECT} ORDER BY created_at DESC, rowid DESC`)
    .all() as ImportRow[]
  return rows.map(toImportRecord)
}

export function getShipImport(id: string): ShipImportRecord | null {
  const row = getDb().prepare(`${IMPORT_SELECT} WHERE id = ?`).get(id) as ImportRow | undefined
  return row ? toImportRecord(row) : null
}

export function renameShipImport(id: string, name: string): ShipImportRecord | null {
  const res = getDb().prepare(`UPDATE ship_imports SET name = ? WHERE id = ?`).run(str(name).trim(), id)
  if (res.changes === 0) return null
  return getShipImport(id)
}

/**
 * Deleting an import is NOT here.
 *
 * It used to be this one line, and the line was a lie the History tab had to
 * explain away: it removed the log row and left the show — the cards, the
 * claims, the chain edge — exactly where it was. Doing it properly means
 * reaching into this file, `shippingDomain.ts` and the claim reads at once, and
 * each of those is imported by one of the others. So it lives in
 * `./shipImportDelete.ts`, above all three, for the same reason `shipClaims.ts`
 * sits below `shipStations.ts`.
 */

// ---------------------------------------------------------------------------
// Snapshots — dated captures that deliberately survive a re-import
// ---------------------------------------------------------------------------

export function createShipSnapshot(name: string, payload: ShipSnapshotPayload): ShipSnapshot {
  const id = newId()
  const createdAt = nowIso()
  getDb()
    .prepare(`INSERT INTO ship_snapshots (id, name, created_at, payload) VALUES (?, ?, ?, ?)`)
    .run(id, str(name).trim() || `Snapshot ${createdAt.slice(0, 10)}`, createdAt, JSON.stringify(payload ?? {}))
  const created = getShipSnapshot(id)
  if (!created) throw new Error('Snapshot could not be written')
  return created
}

export function listShipSnapshots(): ShipSnapshotSummary[] {
  const rows = getDb()
    .prepare(`SELECT id, name, created_at FROM ship_snapshots ORDER BY created_at DESC, rowid DESC`)
    .all() as Array<Omit<SnapshotRow, 'payload'>>
  return rows.map((r) => ({ id: r.id, name: str(r.name), createdAt: str(r.created_at) }))
}

export function getShipSnapshot(id: string): ShipSnapshot | null {
  const row = getDb()
    .prepare(`SELECT id, name, created_at, payload FROM ship_snapshots WHERE id = ?`)
    .get(id) as SnapshotRow | undefined
  return row ? toSnapshot(row) : null
}

export function renameShipSnapshot(id: string, name: string): ShipSnapshot | null {
  const res = getDb()
    .prepare(`UPDATE ship_snapshots SET name = ? WHERE id = ?`)
    .run(str(name).trim(), id)
  if (res.changes === 0) return null
  return getShipSnapshot(id)
}

export function deleteShipSnapshot(id: string): boolean {
  return getDb().prepare(`DELETE FROM ship_snapshots WHERE id = ?`).run(id).changes > 0
}

// ---------------------------------------------------------------------------
// Settings (workspace preferences: default sport, VIP threshold, batch size...)
// ---------------------------------------------------------------------------

export function getShipSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM ship_settings WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined
  return row ? (row.value ?? null) : null
}

export function setShipSetting(key: string, value: string | null): void {
  if (value === null) {
    getDb().prepare(`DELETE FROM ship_settings WHERE key = ?`).run(key)
    return
  }
  getDb()
    .prepare(
      `INSERT INTO ship_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export function getShipSettings(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM ship_settings`).all() as Array<{
    key: string
    value: string | null
  }>
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = str(r.value)
  return out
}

/** Apply a partial settings patch; a null value deletes the key. */
export function setShipSettings(patch: Record<string, string | null>): Record<string, string> {
  const database = getDb()
  database.transaction(() => {
    for (const [key, value] of Object.entries(patch)) setShipSetting(key, value)
  })()
  return getShipSettings()
}

// ---------------------------------------------------------------------------
// The uploaded document
// ---------------------------------------------------------------------------

/**
 * The PDF the show was imported from.
 *
 * There is at most ONE at a time, for the same reason there is at most one
 * dataset: the floor is working tonight's show, and a picker who can reach last
 * week's slip by accident is a picker who will. Storing a new one replaces the
 * old, which is also the "offload it when it is done" behaviour — the file stops
 * taking up room the moment it stops being the thing being worked.
 */
/**
 * How much of the file goes in one synced row.
 *
 * 512 KB raw, which base64 inflates to about 683 KB — comfortably inside the
 * relay's 8 MB request body and inside D1's 2 MB row limit, with room for the
 * batch to carry more than one. Smaller would mean more rows and more round
 * trips for the same bytes; larger starts betting on limits rather than sitting
 * well inside them.
 */
export const SHIP_DOC_PART_BYTES = 512 * 1024

export function putShipDocument(input: {
  importId: string | null
  name: string
  pageCount: number
  bytes: Buffer
}): ShipDocument {
  const database = getDb()
  const id = newId()
  const createdAt = nowIso()
  const name = str(input.name) || 'packing-slips.pdf'
  const pageCount = Math.max(0, Math.trunc(num(input.pageCount)))
  const total = Math.max(1, Math.ceil(input.bytes.byteLength / SHIP_DOC_PART_BYTES))
  database.transaction(() => {
    database.prepare(`DELETE FROM ship_documents`).run()
    // The old slices go too, and the delete is what tells everyone else theirs
    // are finished with — a tombstone per part, through the ordinary trigger.
    // There is one show on the floor at a time, so there is one slip.
    database.prepare(`DELETE FROM ship_document_parts`).run()
    database
      .prepare(
        `INSERT INTO ship_documents (id, import_id, name, page_count, byte_size, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.importId, name, pageCount, input.bytes.byteLength, input.bytes, createdAt)

    // And the travelling copy. Written in the same transaction as the document
    // so the two can never disagree about which slip is current.
    const part = database.prepare(
      `INSERT INTO ship_document_parts
         (id, document_id, import_id, name, page_count, byte_size, seq, total, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let seq = 0; seq < total; seq++) {
      const slice = input.bytes.subarray(seq * SHIP_DOC_PART_BYTES, (seq + 1) * SHIP_DOC_PART_BYTES)
      part.run(
        newId(),
        id,
        input.importId,
        name,
        pageCount,
        input.bytes.byteLength,
        seq,
        total,
        slice.toString('base64'),
        createdAt
      )
    }
  })()
  return {
    id,
    importId: input.importId,
    name: str(input.name) || 'packing-slips.pdf',
    pageCount: Math.max(0, Math.trunc(num(input.pageCount))),
    byteSize: input.bytes.byteLength,
    createdAt
  }
}

/**
 * Does the stored slip belong to the dataset currently on the floor?
 *
 * The pane draws THIS order's page numbers into whatever PDF is on the machine,
 * and page 27 of last week's export is a different customer's slip entirely. Two
 * ordinary situations put an old file beside a new dataset:
 *
 *   · the tiny rows of tonight's import reach a second machine in the first pull
 *     and the slip, which travels in half-megabyte slices, is still arriving —
 *     so for a minute the new customers sit next to the old paper;
 *   · somebody re-imports without the PDF, or the document was cleared.
 *
 * Both are silent, and a page that looks like a slip gets read as one. So the
 * document is checked against the live import chain and refused when it does not
 * belong — a blank pane that says why is recoverable; the wrong customer's
 * address next to a box that is about to be taped is not.
 */
function documentIsCurrent(db: Database.Database, importId: string | null): boolean {
  const chain = liveImportIds(db)
  // Nothing imported yet, or a document from before imports stamped their id:
  // there is no newer dataset to contradict it, so it stands.
  if (chain.length === 0 || !importId) return true
  return chain.includes(importId)
}

/** The document's metadata — cheap, and safe to put in every summary. */
export function getShipDocument(): ShipDocument | null {
  const row = getDb()
    .prepare(
      `SELECT id, import_id, name, page_count, byte_size, created_at
       FROM ship_documents ORDER BY created_at DESC LIMIT 1`
    )
    .get() as
    | {
        id: string
        import_id: string | null
        name: string | null
        page_count: number | null
        byte_size: number | null
        created_at: string | null
      }
    | undefined
  if (!row) return null
  // Refused rather than returned with a flag: every caller of this draws the
  // file, and a caller that forgets to read the flag draws last week's slip.
  if (!documentIsCurrent(getDb(), row.import_id ?? null)) return null
  return {
    id: row.id,
    importId: row.import_id ?? null,
    name: str(row.name) || 'packing-slips.pdf',
    pageCount: num(row.page_count),
    byteSize: num(row.byte_size),
    createdAt: str(row.created_at)
  }
}

/** The file itself. Only read when a screen is about to render it. */
export function getShipDocumentBytes(): Buffer | null {
  const row = getDb()
    .prepare(`SELECT bytes, import_id FROM ship_documents ORDER BY created_at DESC LIMIT 1`)
    .get() as { bytes: Buffer | null; import_id: string | null } | undefined
  if (!row) return null
  if (!documentIsCurrent(getDb(), row.import_id ?? null)) return null
  return row.bytes ?? null
}

/** Drop the stored file. The dataset — the actual work — is untouched. */
export function clearShipDocument(): number {
  const database = getDb()
  let cleared = 0
  database.transaction(() => {
    cleared = database.prepare(`DELETE FROM ship_documents`).run().changes
    // The slices go with it, which is also how every other machine learns the
    // slip was put away. Clearing here and leaving them would have the next pull
    // rebuild the document somebody just deleted.
    database.prepare(`DELETE FROM ship_document_parts`).run()
  })()
  return cleared
}

/**
 * How much of an incoming slip has landed, when one is on its way.
 *
 * Null when there is nothing to wait for — either the document is already here
 * or nobody has imported one. Only for the screen: "no slip on this machine" and
 * "the slip is 4 of 12 slices in" are the same blank pane and completely
 * different situations, and the first one used to be shown for both, telling
 * somebody to re-import a file that was already arriving.
 */
export function shipDocumentArrival(): { have: number; total: number; name: string } | null {
  const database = getDb()
  const row = database
    .prepare(
      `SELECT document_id AS id, MAX(total) AS total, COUNT(*) AS have,
              MAX(name) AS name, MAX(created_at) AS created_at
         FROM ship_document_parts
        GROUP BY document_id
        ORDER BY created_at DESC
        LIMIT 1`
    )
    .get() as
    | { id: string; total: number; have: number; name: string | null; created_at: string }
    | undefined
  if (!row || row.have >= row.total) return null
  const held = database.prepare(`SELECT id FROM ship_documents WHERE id = ?`).get(row.id)
  if (held) return null
  return { have: row.have, total: row.total, name: str(row.name) || 'packing-slips.pdf' }
}

/**
 * Rebuild the slip from the slices that have arrived, if they are all here.
 *
 * The counterpart to inventory_stock's rebuild, and for the same reason: the
 * thing that travels is the set of small immutable rows, and the big derived
 * artefact is reconstructed by whoever receives them. A PDF is not a value two
 * machines can arbitrate — it is either whole or it is not — so it is never sent
 * as one row and never merged.
 *
 * Called once after a pull has fully drained. Timing is part of the correctness:
 * parts land across several batches, and a document assembled from eleven of
 * twelve slices is a corrupt file that opens to a blank pane, which is worse
 * than the honest "no slip on this machine" that precedes it. So it waits for
 * COUNT(*) = total, and until then does nothing at all.
 *
 * Returns the number of documents rebuilt — 0 in the overwhelmingly common case
 * where nothing changed.
 */
export function rebuildShipDocument(): number {
  const database = getDb()
  // The newest complete set wins, which matches getShipDocument reading the
  // newest row: a second show imported tonight replaces the first.
  const ready = database
    .prepare(
      `SELECT p.document_id AS id, p.total AS total, COUNT(*) AS have,
              MAX(p.name) AS name, MAX(p.import_id) AS import_id,
              MAX(p.page_count) AS page_count, MAX(p.byte_size) AS byte_size,
              MAX(p.created_at) AS created_at
         FROM ship_document_parts p
        GROUP BY p.document_id, p.total
       HAVING COUNT(*) = p.total
        ORDER BY created_at DESC
        LIMIT 1`
    )
    .get() as
    | {
        id: string
        total: number
        have: number
        name: string | null
        import_id: string | null
        page_count: number | null
        byte_size: number | null
        created_at: string | null
      }
    | undefined
  if (!ready) return 0

  // Already holding this exact document: nothing to do. This is the ordinary
  // case on every sync after the first, and it must not rewrite the row — a
  // rewrite would churn the file on disk every four seconds.
  const current = database.prepare(`SELECT id FROM ship_documents WHERE id = ?`).get(ready.id) as
    | { id: string }
    | undefined
  if (current) return 0

  const slices = database
    .prepare(`SELECT data FROM ship_document_parts WHERE document_id = ? ORDER BY seq ASC`)
    .all(ready.id) as Array<{ data: string }>
  const bytes = Buffer.concat(slices.map((s) => Buffer.from(s.data, 'base64')))
  const expected = num(ready.byte_size)
  // A length that does not match what the sender recorded means a slice is
  // truncated or a seq is missing in a way COUNT could not see. Refusing is the
  // only safe answer: a corrupt PDF renders as a blank pane, which somebody
  // reads as "this order has nothing on it" and seals the box.
  if (expected > 0 && bytes.byteLength !== expected) return 0

  database.transaction(() => {
    database.prepare(`DELETE FROM ship_documents`).run()
    database
      .prepare(
        `INSERT INTO ship_documents (id, import_id, name, page_count, byte_size, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ready.id,
        ready.import_id,
        str(ready.name) || 'packing-slips.pdf',
        num(ready.page_count),
        bytes.byteLength,
        bytes,
        str(ready.created_at) || nowIso()
      )
  })()
  return 1
}
