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
  ShipWarning,
  ShippingDataset
} from '@shared/shippingTypes'
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
  event_name: string | null
  event_date: string | null
  status: string
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
  checked_off: number
  checked_off_at: string | null
  checked_off_by: string | null
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

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toBreak(r: BreakRow): ShipBreak {
  return {
    id: r.id,
    // A row written before v31 has no label; its number IS its label.
    breakLabel: str(r.break_label) || String(num(r.break_number)),
    breakNumber: num(r.break_number),
    eventName: str(r.event_name),
    eventDate: str(r.event_date),
    status: (r.status || 'pending') as ShipBreakStatus
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
    checkedOff: bool(r.checked_off),
    checkedOffAt: r.checked_off_at ?? null,
    checkedOffBy: r.checked_off_by ?? null
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
  return {
    breakLabel: str(r.break_label) || String(r.break_number),
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

const BREAK_SELECT = `SELECT id, break_label, break_number, event_name, event_date, status FROM ship_breaks`

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

const SLOT_SELECT = `
  SELECT id, break_id, break_label, break_number, team_name, customer_id, order_id, price,
         is_giveaway, top_sleeved, checked_off, checked_off_at, checked_off_by
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
  SELECT break_label, break_number, team_count, distinct_team_count, max_teams, missing_count,
         missing_teams, has_all, collisions
  FROM ship_break_audit
`

export function listShipBreakAudit(): ShipBreakAudit[] {
  const rows = getDb()
    .prepare(`${AUDIT_SELECT} ORDER BY break_number ASC, break_label ASC`)
    .all() as BreakAuditRow[]
  return rows.map(toBreakAudit)
}

/** By the PRINTED LABEL — "11" and "11A" have separate slates. */
export function getShipBreakAudit(breakLabel: string): ShipBreakAudit | null {
  const row = getDb().prepare(`${AUDIT_SELECT} WHERE break_label = ?`).get(breakLabel) as
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
    checkedSlots: countOf(database, 'ship_team_slots', 'WHERE checked_off = 1')
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

export function setTeamSlotTopSleeved(id: string, on: boolean): ShipTeamSlot | null {
  const res = getDb()
    .prepare(`UPDATE ship_team_slots SET top_sleeved = ? WHERE id = ?`)
    .run(flag(on), id)
  if (res.changes === 0) return null
  return getShipTeamSlot(id)
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

/** Top-sleeve (or un-sleeve) every slot in a break. Returns the rows touched. */
export function setBreakSlotsTopSleeved(breakId: string, on: boolean): number {
  return getDb()
    .prepare(`UPDATE ship_team_slots SET top_sleeved = ? WHERE break_id = ?`)
    .run(flag(on), breakId).changes
}

export function setBreakStatus(id: string, status: ShipBreakStatus): ShipBreak | null {
  const res = getDb().prepare(`UPDATE ship_breaks SET status = ? WHERE id = ?`).run(status, id)
  if (res.changes === 0) return null
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
         (id, break_id, break_number, employee_id, assigned_at, assigned_by, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(break_id, employee_id) DO UPDATE
           SET break_number = excluded.break_number,
               assigned_at  = excluded.assigned_at,
               assigned_by  = excluded.assigned_by,
               note         = excluded.note`
    )
    .run(newId(), breakId, input.breakNumber ?? null, employeeId, nowIso(), input.assignedBy, note)
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

  return db
    .prepare(
      `DELETE FROM ship_break_assignments
        WHERE break_id NOT IN (SELECT id FROM ship_breaks)`
    )
    .run().changes
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
  'ship_warnings'
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
      `INSERT INTO ship_breaks (id, break_label, break_number, event_name, event_date, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const b of dataset.breaks) {
      insBreak.run(
        b.id,
        b.breakLabel || String(b.breakNumber),
        b.breakNumber,
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
          is_giveaway, top_sleeved, checked_off, checked_off_at, checked_off_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        s.checkedOff ? (s.checkedOffBy ?? null) : null
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
         (break_label, break_number, team_count, distinct_team_count, max_teams, missing_count,
          missing_teams, has_all, collisions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const a of dataset.breakAudit) {
      insAudit.run(
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
    database
      .prepare(
        `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        importId,
        importName,
        str(opts.filename),
        kind,
        createdAt,
        JSON.stringify({ ...counts, carriedForward: sameEvent })
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
    // Nothing to carry for a slot that was never touched.
    if (!s.checkedOff && !s.topSleeved) continue
    const key = slotKey(s.customerId, s.breakLabel, s.teamName)
    const list = queues.get(key)
    if (list) list.push(s)
    else queues.set(key, [s])
  }
  if (queues.size > 0) {
    const updSlot = database.prepare(
      `UPDATE ship_team_slots
          SET checked_off = ?, checked_off_at = ?, checked_off_by = ?, top_sleeved = ?
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

export function deleteShipImport(id: string): boolean {
  return getDb().prepare(`DELETE FROM ship_imports WHERE id = ?`).run(id).changes > 0
}

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
export function putShipDocument(input: {
  importId: string | null
  name: string
  pageCount: number
  bytes: Buffer
}): ShipDocument {
  const database = getDb()
  const id = newId()
  const createdAt = nowIso()
  database.transaction(() => {
    database.prepare(`DELETE FROM ship_documents`).run()
    database
      .prepare(
        `INSERT INTO ship_documents (id, import_id, name, page_count, byte_size, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.importId,
        str(input.name) || 'packing-slips.pdf',
        Math.max(0, Math.trunc(num(input.pageCount))),
        input.bytes.byteLength,
        input.bytes,
        createdAt
      )
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
    .prepare(`SELECT bytes FROM ship_documents ORDER BY created_at DESC LIMIT 1`)
    .get() as { bytes: Buffer | null } | undefined
  return row?.bytes ?? null
}

/** Drop the stored file. The dataset — the actual work — is untouched. */
export function clearShipDocument(): number {
  return getDb().prepare(`DELETE FROM ship_documents`).run().changes
}
