/**
 * RM Cardz Shipping Workspace — the DOMAIN layer.
 *
 * This is the port of the architecture doc's `Db` module: the single place that
 * owns every derivation and every operator mutation. `shipping.ts` is the store
 * (rows in, rows out); `shippingIpc.ts` is a thin transport that only validates
 * input, checks a permission and calls into here. Nothing above this file is
 * allowed to compute a stage, a break status or a queue position.
 *
 * Doc sections implemented here:
 *   4   `_orderRow` + the order operations (stage, hold, move, special request)
 *   4.1 `_deriveStage` / `setOrderStage` — ONE source of truth with Shipping
 *   5   the Checker: break list/detail + the never-downgrade status recompute
 *   6   `bulkSetShipmentStatusByTracking` — "manual is truth" with the two
 *       forward exceptions (AUTO_SETTERS / humanSet / forwardFromPreship /
 *       forwardScan / RANK)
 *   8   sales + ledger derivation and the CSV exports
 */

import {
  SHIP_STATUS_CODES,
  SHIP_STATUS_LABELS,
  SHIP_STATUS_RANK,
  type ShipBreak,
  type ShipBreakAssignment,
  type ShipBreakAudit,
  type ShipBreakStatus,
  type ShipCustomer,
  type ShipEvent,
  type ShipImportRecord,
  type ShipShipment,
  type ShipSnapshot,
  type ShipStatusCode,
  type ShipTeamSlot,
  type ShipWarning
} from '@shared/shippingTypes'
import {
  SHIP_STAGES,
  type ShipAssignmentBoard,
  type ShipAssignmentEmployee,
  type ShipBreakAssignee,
  type ShipBreakAssignmentUpdate,
  type ShipBreakDetail,
  type ShipBreakSlotRow,
  type ShipBreakSummary,
  type ShipBulkStatusEntry,
  type ShipBulkStatusResult,
  type ShipCustomerRow,
  type ShipExportKind,
  type ShipFulfillmentStage,
  type ShipLedgerRow,
  type ShipOrderBreak,
  type ShipOrderRow,
  type ShipOrderTeam,
  type ShipQueueDirection,
  type ShipSalesBreakRow,
  type ShipSalesCustomerRow,
  type ShipSalesSummary,
  type ShipShipmentRow,
  type ShipSlotUpdate,
  type ShipSnapshotContents,
  type ShipWorkspaceSummary
} from '@shared/shippingViews'
import {
  assignShipBreak,
  countShipBreakAssignments,
  createShipSnapshot,
  deleteShipBreakAssignment,
  deleteShipBreakAssignmentFor,
  getShipBreak,
  getShipBreakAssignment,
  getShipBreakAudit,
  getShipCustomer,
  getShipDataCounts,
  getShipEvent,
  getShipShipment,
  getShipShipmentByCustomer,
  hasShipDataset,
  listShipBatchUrls,
  listShipBreakAssignments,
  listShipBreakAssignmentsByBreak,
  listShipBreakAudit,
  listShipBreaks,
  listShipCustomers,
  listShipImports,
  listShipShipments,
  listShipTeamSlots,
  listShipTeamSlotsByBreak,
  listShipTeamSlotsByCustomer,
  listShipTrackingNumbers,
  listShipWarnings,
  setShipWarningStatus,
  recomputeBreakStatus,
  resetShipQueueOrder,
  listBreakIdsForCustomer,
  setBreakSlotsChecked,
  setCustomerSlotsChecked,
  setBreakSlotsTopSleeved,
  setBreakStatus,
  setTeamSlotChecked as storeSetTeamSlotChecked,
  setTeamSlotTopSleeved as storeSetTeamSlotTopSleeved,
  updateShipment
} from './shipping'
import {
  SHIP_SOP_STEPS,
  computeSupplyPlan,
  costSupplyPlan,
  type ShipSupplyPlan,
  type ShipSupplyPlanCosted
} from '@shared/shippingSupplies'
import { listSupplies } from './supplies'
import type { Supply } from '@shared/types'
import { getEmployeeById, listEmployees } from './employees'
import { getDb } from './database'
import type { Employee } from '@shared/types'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

function cents(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

const EMPTY_CUSTOMER: ShipCustomer = {
  id: '',
  whatnotHandle: '',
  realName: '',
  address: '',
  isNew: false,
  pages: []
}

/** A missing customer row must never crash a screen — fall back to the handle. */
function customerOf(map: Map<string, ShipCustomer>, customerId: string): ShipCustomer {
  return map.get(customerId) ?? { ...EMPTY_CUSTOMER, id: customerId, whatnotHandle: customerId }
}

interface DerivationContext {
  customers: Map<string, ShipCustomer>
  slotsByCustomer: Map<string, ShipTeamSlot[]>
}

/** Load the joins an order row needs, once, for a whole-list derivation. */
function buildContext(): DerivationContext {
  const customers = new Map<string, ShipCustomer>()
  for (const c of listShipCustomers()) customers.set(c.id, c)
  const slotsByCustomer = new Map<string, ShipTeamSlot[]>()
  for (const s of listShipTeamSlots()) {
    const list = slotsByCustomer.get(s.customerId)
    if (list) list.push(s)
    else slotsByCustomer.set(s.customerId, [s])
  }
  return { customers, slotsByCustomer }
}

/** Context for ONE customer — cheap enough for a single-row re-derivation. */
function contextFor(customerId: string): DerivationContext {
  const customers = new Map<string, ShipCustomer>()
  const c = getShipCustomer(customerId)
  if (c) customers.set(c.id, c)
  const slotsByCustomer = new Map<string, ShipTeamSlot[]>()
  slotsByCustomer.set(customerId, listShipTeamSlotsByCustomer(customerId))
  return { customers, slotsByCustomer }
}

// ---------------------------------------------------------------------------
// 4.1 — Fulfillment stage. ONE source of truth shared with the tracker.
// ---------------------------------------------------------------------------

/**
 * Derive the Orders stage from the shipment's manual status, so the Orders tab
 * and the Shipping tracker can never disagree (doc 4.1).
 *
 * A printed label means the package is packed and ready — it is never "to pick"
 * again — which is why `label_created` maps to `put_together` regardless of
 * whether `packedAt` was ever stamped.
 */
export function _deriveStage(sh: Pick<ShipShipment, 'manualStatus' | 'packedAt'>): ShipFulfillmentStage {
  const code: ShipStatusCode = sh.manualStatus?.code ?? 'not_shipped'
  switch (code) {
    case 'returned':
      return 'returned'
    case 'exception':
      return 'exception'
    case 'delivered':
      return 'all_good'
    case 'in_transit':
    case 'out_for_delivery':
      return 'sent'
    case 'label_created':
      return 'put_together'
    case 'not_shipped':
    default:
      return sh.packedAt ? 'put_together' : 'to_pick'
  }
}

// ---------------------------------------------------------------------------
// 4 — the order row
// ---------------------------------------------------------------------------

function orderBreaksFor(slots: ShipTeamSlot[]): ShipOrderBreak[] {
  const groups = new Map<string, ShipOrderBreak>()
  for (const s of slots) {
    let g = groups.get(s.breakId)
    if (!g) {
      g = {
        breakId: s.breakId,
        breakLabel: s.breakLabel,
        breakNumber: s.breakNumber,
        teams: [],
        value: 0,
        checked: 0,
        total: 0
      }
      groups.set(s.breakId, g)
    }
    const team: ShipOrderTeam = {
      slotId: s.id,
      teamName: s.teamName,
      price: s.price,
      checkedOff: s.checkedOff,
      checkedOffAt: s.checkedOffAt,
      checkedOffBy: s.checkedOffBy,
      topSleeved: s.topSleeved,
      isGiveaway: s.isGiveaway,
      orderId: s.orderId
    }
    g.teams.push(team)
    g.value = cents(g.value + s.price)
    g.total += 1
    if (s.checkedOff) g.checked += 1
  }
  // Break-less giveaways (breakNumber === null) sort to the bottom.
  return [...groups.values()].sort((a, b) => {
    if (a.breakNumber === null && b.breakNumber === null) return a.breakId.localeCompare(b.breakId)
    if (a.breakNumber === null) return 1
    if (b.breakNumber === null) return -1
    // Same number, different letter — #11 before #11A, stable everywhere.
    return a.breakNumber - b.breakNumber || (a.breakLabel ?? '').localeCompare(b.breakLabel ?? '')
  })
}

/**
 * Everything the Orders UI needs for one package, derived from the customer's
 * team slots + the shipment (doc section 4).
 */
export function _orderRow(sh: ShipShipment, ctx?: DerivationContext): ShipOrderRow {
  const context = ctx ?? contextFor(sh.customerId)
  const slots = context.slotsByCustomer.get(sh.customerId) ?? []
  const customer = customerOf(context.customers, sh.customerId)

  let value = 0
  let topSleevedCount = 0
  let giveawayCount = 0
  let checked = 0
  const orderIds: string[] = []
  const seenOrderIds = new Set<string>()
  for (const s of slots) {
    value += s.price
    if (s.topSleeved) topSleevedCount += 1
    if (s.isGiveaway) giveawayCount += 1
    if (s.checkedOff) checked += 1
    if (s.orderId && !seenOrderIds.has(s.orderId)) {
      seenOrderIds.add(s.orderId)
      orderIds.push(s.orderId)
    }
  }

  const breaks = orderBreaksFor(slots)

  return {
    id: sh.id,
    customerId: sh.customerId,
    customer: {
      handle: customer.whatnotHandle || customer.id,
      realName: customer.realName,
      address: customer.address,
      isNew: customer.isNew,
      // So a screen can turn to this customer's page in the uploaded slip.
      pages: customer.pages ?? []
    },
    trackingNumber: sh.trackingNumber,
    carrier: sh.carrier,
    serviceType: sh.serviceType,
    weightOz: sh.weightOz,
    uspsUrl: sh.uspsUrl,
    notes: sh.notes,
    specialRequest: sh.specialRequest,
    manualStatus: sh.manualStatus,
    stage: _deriveStage(sh),
    onHold: sh.onHold,
    heldReason: sh.heldReason,
    queueOrder: sh.queueOrder,
    packedAt: sh.packedAt,
    packedBy: sh.packedBy,
    breaks,
    breakCount: breaks.length,
    value: cents(value),
    orderIds,
    cardCount: slots.length,
    multiCard: slots.length > 1,
    topSleevedCount,
    giveawayCount,
    hasGiveaway: giveawayCount > 0,
    pick: { checked, total: slots.length },
    lastUpdated: sh.lastUpdated
  }
}

/** Display order: held rows sink to the bottom, then the manual queue. */
function sortShipments(rows: ShipShipment[]): ShipShipment[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.onHold !== b.r.onHold) return a.r.onHold ? 1 : -1
      if (a.r.queueOrder !== b.r.queueOrder) return a.r.queueOrder - b.r.queueOrder
      return a.i - b.i
    })
    .map((x) => x.r)
}

export function listOrders(): ShipOrderRow[] {
  const ctx = buildContext()
  return sortShipments(listShipShipments()).map((sh) => _orderRow(sh, ctx))
}

export function getOrder(id: string): ShipOrderRow | null {
  const sh = getShipShipment(id)
  return sh ? _orderRow(sh) : null
}

function requireShipment(id: string): ShipShipment {
  const sh = getShipShipment(id)
  if (!sh) throw new Error('Order not found.')
  return sh
}

// ---------------------------------------------------------------------------
// 4.1 — setOrderStage. EVERY stage is handled; a missing case would be an
// unrecoverable error for the dropdown, so the switch is exhaustive.
// ---------------------------------------------------------------------------

export function setOrderStage(
  id: string,
  stage: ShipFulfillmentStage,
  userId: string | null
): ShipOrderRow {
  const sh = requireShipment(id)
  const at = nowIso()
  const status = (code: ShipStatusCode): { code: ShipStatusCode; setAt: string; setBy: string | null } => ({
    code,
    setAt: at,
    setBy: userId
  })

  switch (stage) {
    case 'to_pick':
      // Deliberately unconditional: a printed label derives back to
      // `put_together`, so anything but `not_shipped` here would make the
      // dropdown appear stuck.
      updateShipment(id, { packedAt: null, packedBy: null, manualStatus: status('not_shipped') })
      break

    case 'put_together': {
      // A label already printed IS "put together" — keep the richer status
      // rather than regressing it to not_shipped.
      const keepLabel = sh.manualStatus.code === 'label_created'
      updateShipment(id, {
        packedAt: sh.packedAt ?? at,
        packedBy: sh.packedAt ? sh.packedBy : userId,
        manualStatus: keepLabel ? sh.manualStatus : status('not_shipped')
      })
      break
    }

    case 'sent':
      updateShipment(id, {
        packedAt: sh.packedAt ?? at,
        packedBy: sh.packedAt ? sh.packedBy : userId,
        manualStatus: status('in_transit')
      })
      break

    case 'all_good':
      updateShipment(id, {
        packedAt: sh.packedAt ?? at,
        packedBy: sh.packedAt ? sh.packedBy : userId,
        manualStatus: status('delivered')
      })
      break

    case 'exception':
      updateShipment(id, { manualStatus: status('exception') })
      break

    case 'returned':
      updateShipment(id, { manualStatus: status('returned') })
      break

    default: {
      const never: never = stage
      throw new Error(`Unknown stage: ${String(never)}`)
    }
  }

  return _orderRow(requireShipment(id))
}

// ---------------------------------------------------------------------------
// 4.2 — hold, queue move, special request, notes
// ---------------------------------------------------------------------------

export function setOrderHold(
  id: string,
  onHold: boolean,
  reason: string | null
): ShipOrderRow {
  requireShipment(id)
  const trimmed = reason?.trim() ?? ''
  updateShipment(id, { onHold, heldReason: onHold ? trimmed || null : null })
  return _orderRow(requireShipment(id))
}

/** Empty text clears the request (doc 4.2). */
export function setOrderSpecialRequest(
  id: string,
  text: string,
  userId: string | null
): ShipOrderRow {
  requireShipment(id)
  const trimmed = (text ?? '').trim()
  updateShipment(id, {
    specialRequest: trimmed ? { text: trimmed, setAt: nowIso(), setBy: userId } : null
  })
  return _orderRow(requireShipment(id))
}

export function setOrderNotes(id: string, notes: string): ShipOrderRow {
  requireShipment(id)
  const trimmed = (notes ?? '').trim()
  updateShipment(id, { notes: trimmed || null })
  return _orderRow(requireShipment(id))
}

/**
 * A fresh import leaves every `queue_order` at 0, so normalise before any move —
 * otherwise a swap of two equal values is a no-op the operator can see.
 */
function ensureQueueNormalized(): void {
  const database = getDb()
  const row = database
    .prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT queue_order) AS distinctOrders FROM ship_shipments`
    )
    .get() as { total: number; distinctOrders: number }
  if (row.total > 0 && row.total !== row.distinctOrders) resetShipQueueOrder()
}

/**
 * Move one package up or down the pick queue. Held rows live at the bottom as
 * their own group and a move only ever swaps WITHIN a group, so an arrow can
 * never teleport a row across the hold boundary (doc 4.2).
 */
export function moveOrder(id: string, direction: ShipQueueDirection): ShipOrderRow[] {
  requireShipment(id)
  ensureQueueNormalized()
  const ordered = sortShipments(listShipShipments())
  const target = ordered.find((s) => s.id === id)
  if (!target) throw new Error('Order not found.')

  const group = ordered.filter((s) => s.onHold === target.onHold)
  const i = group.findIndex((s) => s.id === id)
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= group.length) {
    throw new Error(direction === 'up' ? 'Already at the top.' : 'Already at the bottom.')
  }

  const a = group[i]
  const b = group[j]
  const database = getDb()
  database.transaction(() => {
    updateShipment(a.id, { queueOrder: b.queueOrder })
    updateShipment(b.id, { queueOrder: a.queueOrder })
  })()
  return listOrders()
}

export function resetOrderQueue(): ShipOrderRow[] {
  resetShipQueueOrder()
  return listOrders()
}

// ---------------------------------------------------------------------------
// Break assignments (v17) — "who is sorting break #12"
//
// Framework only, deliberately: assign / unassign / list, surfaced on the break
// summary the Checker already consumes. No auto-assignment, no balancing, no
// notifications.
// ---------------------------------------------------------------------------

function initialsOf(first: string, last: string, fallback: string): string {
  const a = first.trim().charAt(0)
  const b = last.trim().charAt(0)
  const pair = `${a}${b}`.trim()
  if (pair) return pair.toUpperCase()
  return (fallback.trim().slice(0, 2) || '?').toUpperCase()
}

function employeeName(emp: Employee): string {
  return `${emp.firstName} ${emp.lastName}`.trim() || emp.companyId || emp.id
}

/** The display-ready form of one employee for the Admin picker. */
function toAssignmentEmployee(emp: Employee): ShipAssignmentEmployee {
  return {
    id: emp.id,
    name: employeeName(emp),
    initials: initialsOf(emp.firstName, emp.lastName, emp.companyId || emp.id),
    title: emp.title,
    avatarUrl: emp.avatarUrl
  }
}

/**
 * Resolve one stored assignment for display. A removed employee does NOT drop
 * the row — it comes back with `found: false` so the board can show (and let
 * someone clear) the orphan instead of silently losing who was on the break.
 */
function toAssignee(a: ShipBreakAssignment, emp: Employee | undefined): ShipBreakAssignee {
  if (!emp) {
    return {
      ...a,
      name: a.employeeId,
      initials: initialsOf('', '', a.employeeId),
      title: '',
      avatarUrl: null,
      found: false
    }
  }
  return {
    ...a,
    name: employeeName(emp),
    initials: initialsOf(emp.firstName, emp.lastName, emp.companyId || emp.id),
    title: emp.title,
    avatarUrl: emp.avatarUrl,
    found: true
  }
}

/**
 * Every assignment in the workspace, grouped by break id, with the employee
 * roster resolved ONCE. `listBreaks` derives a whole dataset in one pass, so it
 * must never hit the employees table per break.
 */
function assigneesByBreak(): Map<string, ShipBreakAssignee[]> {
  const assignments = listShipBreakAssignments()
  const out = new Map<string, ShipBreakAssignee[]>()
  if (assignments.length === 0) return out
  const employees = new Map<string, Employee>()
  for (const e of listEmployees()) employees.set(e.id, e)
  for (const a of assignments) {
    const row = toAssignee(a, employees.get(a.employeeId))
    const list = out.get(a.breakId)
    if (list) list.push(row)
    else out.set(a.breakId, [row])
  }
  return out
}

/** The assignees on ONE break — cheap enough for a single-row re-derivation. */
export function listBreakAssignees(breakId: string): ShipBreakAssignee[] {
  return listShipBreakAssignmentsByBreak(breakId).map((a) =>
    toAssignee(a, getEmployeeById(a.employeeId) ?? undefined)
  )
}

/** Every assignment in the workspace, newest break first. */
export function listAllBreakAssignees(): ShipBreakAssignee[] {
  const grouped = assigneesByBreak()
  const rows: ShipBreakAssignee[] = []
  for (const list of grouped.values()) rows.push(...list)
  return rows.sort((a, b) => {
    const an = a.breakNumber ?? Number.MAX_SAFE_INTEGER
    const bn = b.breakNumber ?? Number.MAX_SAFE_INTEGER
    if (an !== bn) return an - bn
    return a.assignedAt.localeCompare(b.assignedAt)
  })
}

/** Breaks in the current dataset that nobody is on. */
function unassignedBreakCount(grouped: Map<string, ShipBreakAssignee[]>): number {
  let n = 0
  for (const br of listShipBreaks()) {
    if ((grouped.get(br.id)?.length ?? 0) === 0) n += 1
  }
  return n
}

/**
 * Everything the Admin assignment tab needs in ONE read.
 *
 * `includeEmployees` is the caller's `shipping.manage` check: a read-only
 * fulfillment user still sees who is assigned, but is not handed the roster.
 */
export function getAssignmentBoard(includeEmployees: boolean): ShipAssignmentBoard {
  const breaks = listBreaks()
  let totalAssignments = 0
  let unassignedBreaks = 0
  for (const br of breaks) {
    totalAssignments += br.assignees.length
    if (br.assignees.length === 0) unassignedBreaks += 1
  }
  return {
    event: getShipEvent(),
    breaks,
    employees: includeEmployees ? listEmployees().map(toAssignmentEmployee) : [],
    totalAssignments,
    unassignedBreaks,
    canManage: includeEmployees
  }
}

/** The reconcile payload both the Admin board and the Checker card consume. */
function assignmentUpdate(breakId: string): ShipBreakAssignmentUpdate {
  const grouped = assigneesByBreak()
  return {
    breakId,
    assignees: grouped.get(breakId) ?? [],
    break: getBreakSummary(breakId),
    totalAssignments: countShipBreakAssignments(),
    unassignedBreaks: unassignedBreakCount(grouped)
  }
}

/** Put an employee on a break. Re-assigning the same person refreshes the note. */
export function assignBreak(
  breakId: string,
  employeeId: string,
  note: string | null,
  actorId: string | null
): ShipBreakAssignmentUpdate {
  const br = requireBreak(breakId)
  const employee = getEmployeeById(employeeId)
  if (!employee) throw new Error('Employee not found.')
  assignShipBreak({
    breakId: br.id,
    breakNumber: br.breakNumber,
    employeeId: employee.id,
    note,
    assignedBy: actorId
  })
  return assignmentUpdate(br.id)
}

/**
 * Take someone off a break — by assignment id (what the UI holds) or by the
 * (break, employee) pair (what a toggle naturally knows). An orphaned row whose
 * break is long gone can still be cleared: the break lookup is only used to
 * report back, never to authorise the delete.
 */
export function unassignBreak(target: {
  id?: string | null
  breakId?: string | null
  employeeId?: string | null
}): ShipBreakAssignmentUpdate {
  const id = (target.id ?? '').trim()
  const breakId = (target.breakId ?? '').trim()
  const employeeId = (target.employeeId ?? '').trim()

  if (id) {
    const existing = getShipBreakAssignment(id)
    if (!existing) throw new Error('That assignment is no longer there.')
    deleteShipBreakAssignment(id)
    return assignmentUpdate(existing.breakId)
  }
  if (!breakId || !employeeId) throw new Error('No assignment specified.')
  if (!deleteShipBreakAssignmentFor(breakId, employeeId)) {
    throw new Error('That assignment is no longer there.')
  }
  return assignmentUpdate(breakId)
}

// ---------------------------------------------------------------------------
// 5 — the Checker
// ---------------------------------------------------------------------------

function summarizeBreak(
  br: ShipBreak,
  slots: ShipTeamSlot[],
  audit: ShipBreakAudit | null,
  assignees: ShipBreakAssignee[]
): ShipBreakSummary {
  let checkedTeams = 0
  let topSleevedTeams = 0
  let giveawayCount = 0
  let value = 0
  const customers = new Set<string>()
  for (const s of slots) {
    if (s.checkedOff) checkedTeams += 1
    if (s.topSleeved) topSleevedTeams += 1
    if (s.isGiveaway) giveawayCount += 1
    value += s.price
    customers.add(s.customerId)
  }
  return {
    id: br.id,
    breakLabel: br.breakLabel,
    breakNumber: br.breakNumber,
    eventName: br.eventName,
    eventDate: br.eventDate,
    status: br.status,
    totalTeams: slots.length,
    checkedTeams,
    topSleevedTeams,
    giveawayCount,
    customerCount: customers.size,
    value: cents(value),
    audit,
    assignees
  }
}

export function listBreaks(): ShipBreakSummary[] {
  const slotsByBreak = new Map<string, ShipTeamSlot[]>()
  for (const s of listShipTeamSlots()) {
    const list = slotsByBreak.get(s.breakId)
    if (list) list.push(s)
    else slotsByBreak.set(s.breakId, [s])
  }
  const auditByLabel = new Map<string, ShipBreakAudit>()
  for (const a of listShipBreakAudit()) auditByLabel.set(a.breakLabel, a)
  const assignees = assigneesByBreak()

  // Only real breaks appear: a break-less giveaway's `giveaway_<handle>` id has
  // no `ship_breaks` row, so it is never shown as a phantom break (doc 5).
  return listShipBreaks().map((br) =>
    summarizeBreak(
      br,
      slotsByBreak.get(br.id) ?? [],
      auditByLabel.get(br.breakLabel) ?? null,
      assignees.get(br.id) ?? []
    )
  )
}

/** The summary for ONE break, without its slot rows. */
export function getBreakSummary(id: string): ShipBreakSummary | null {
  const br = getShipBreak(id)
  if (!br) return null
  return summarizeBreak(
    br,
    listShipTeamSlotsByBreak(id),
    getShipBreakAudit(br.breakLabel),
    listBreakAssignees(id)
  )
}

export function getBreak(id: string): ShipBreakDetail | null {
  const br = getShipBreak(id)
  if (!br) return null
  const slots = listShipTeamSlotsByBreak(id)
  const summary = summarizeBreak(br, slots, getShipBreakAudit(br.breakLabel), listBreakAssignees(id))

  const customers = new Map<string, ShipCustomer>()
  const shipments = new Map<string, ShipShipment>()
  for (const s of slots) {
    if (!customers.has(s.customerId)) {
      const c = getShipCustomer(s.customerId)
      if (c) customers.set(s.customerId, c)
    }
    if (!shipments.has(s.customerId)) {
      const sh = getShipShipmentByCustomer(s.customerId)
      if (sh) shipments.set(s.customerId, sh)
    }
  }

  const rows: ShipBreakSlotRow[] = slots.map((s) => {
    const c = customerOf(customers, s.customerId)
    const sh = shipments.get(s.customerId) ?? null
    return {
      ...s,
      handle: c.whatnotHandle || c.id,
      realName: c.realName,
      address: c.address,
      isNew: c.isNew,
      onHold: sh?.onHold ?? false,
      trackingNumber: sh?.trackingNumber ?? null,
      stage: sh ? _deriveStage(sh) : 'to_pick'
    }
  })

  return { ...summary, slots: rows }
}

/**
 * Section 5's recompute, routed through the store so the sticky rule lives in
 * exactly one place: a `packed` or `shipped` break is NEVER silently downgraded
 * by a check-off edit — un-packing is a deliberate action (`clearBreak`).
 */
export function _recomputeBreakStatus(breakId: string): ShipBreak | null {
  return recomputeBreakStatus(breakId)
}

/** Flip one card. Returns the fresh slot AND both views that show it. */
export function setTeamSlotChecked(
  slotId: string,
  checked: boolean,
  userId: string | null
): ShipSlotUpdate {
  const slot = storeSetTeamSlotChecked(slotId, checked, userId)
  if (!slot) throw new Error('Card not found.')
  _recomputeBreakStatus(slot.breakId)
  const shipment = getShipShipmentByCustomer(slot.customerId)
  return {
    slot,
    break: getBreak(slot.breakId),
    order: shipment ? _orderRow(shipment) : null
  }
}

export function setTeamSlotTopSleeved(slotId: string, on: boolean): ShipSlotUpdate {
  const slot = storeSetTeamSlotTopSleeved(slotId, on)
  if (!slot) throw new Error('Card not found.')
  const shipment = getShipShipmentByCustomer(slot.customerId)
  return {
    slot,
    break: getBreak(slot.breakId),
    order: shipment ? _orderRow(shipment) : null
  }
}

function requireBreak(id: string): ShipBreak {
  const br = getShipBreak(id)
  if (!br) throw new Error('Break not found.')
  return br
}

/** Check (or un-check) every card in a break at once. */
export function setBreakChecked(
  breakId: string,
  checked: boolean,
  userId: string | null
): ShipBreakDetail {
  requireBreak(breakId)
  setBreakSlotsChecked(breakId, checked, userId)
  _recomputeBreakStatus(breakId)
  return getBreak(breakId) as ShipBreakDetail
}

/**
 * Mark an entire package picked (or un-picked) and re-derive everything it
 * touched.
 *
 * This is what "Next order" means. Somebody at a bench has the customer's cards
 * in front of them, the slip beside them, and the whole order in hand — asking
 * them to tick forty-seven boxes and THEN press Next is asking them to do the
 * job twice. Pressing Next IS the confirmation.
 *
 * A package spans several breaks, so every one of them has to be re-derived:
 * the break's own progress, and its pending/picking status. Missing that is how
 * the Find board ends up claiming cards are still out that somebody is already
 * holding.
 */
export function setOrderChecked(
  customerId: string,
  checked: boolean,
  userId: string | null,
  /** Leave already-ticked cards alone, attribution intact. */
  onlyUnchecked = false
): ShipOrderRow {
  const shipment = getShipShipmentByCustomer(customerId)
  if (!shipment) throw new Error('That package is no longer there.')
  // Read the breaks BEFORE the write: they do not change, but reading after
  // would depend on the update having landed, which is a needless coupling.
  const breakIds = listBreakIdsForCustomer(customerId)
  setCustomerSlotsChecked(customerId, checked, userId, onlyUnchecked)
  for (const id of breakIds) _recomputeBreakStatus(id)
  return _orderRow(shipment)
}

/**
 * What tonight's show will consume in supplies.
 *
 * READ ONLY. Nothing here moves stock — see the note on the trigger below.
 *
 * The slate size comes from each break's own audit (`maxTeams`), which is the
 * league's real roster size, so a show is costed against every team that was
 * pulled rather than only the ones that sold. A break with no audit row falls
 * back to the cards it actually holds; that under-counts, but inventing a slate
 * for a break we could not measure would be worse.
 */
export function getSupplyPlan(): ShipSupplyPlan {
  const auditByLabel = new Map<string, ShipBreakAudit>()
  for (const a of listShipBreakAudit()) auditByLabel.set(a.breakLabel, a)

  const breaks = listBreaks().map((b) => ({
    label: b.breakLabel,
    slateSize: auditByLabel.get(b.breakLabel)?.maxTeams || b.totalTeams
  }))

  const orders = listOrders().map((o) => ({
    cardCount: o.cardCount,
    giveawayCount: o.giveawayCount
  }))

  return computeSupplyPlan({ breaks, orders })
}

/**
 * The same plan, with the supplies list behind it: what each line costs at
 * today's average unit cost, and where the show would run short.
 *
 * Still read only. A role nobody has linked yet contributes a quantity and no
 * cost — never a guessed one, because a made-up number in a P&L is worse than a
 * missing one.
 */
export function getSupplyPlanCosted(): ShipSupplyPlanCosted {
  const byRole = new Map<string, Supply>()
  for (const s of listSupplies()) {
    if (s.shipRole) byRole.set(s.shipRole, s)
  }
  return costSupplyPlan(getSupplyPlan(), (role) => {
    const s = byRole.get(role)
    return s ? { id: s.id, name: s.name, quantity: s.quantity, unitCost: s.unitCost } : null
  })
}

export function markBreakPacked(breakId: string): ShipBreakDetail {
  requireBreak(breakId)
  setBreakStatus(breakId, 'packed')
  return getBreak(breakId) as ShipBreakDetail
}

/**
 * The deliberate un-pack: clears every check-off AND resets the break to
 * `pending`. This is the only path that lowers a sticky `packed`/`shipped`
 * break, which is exactly why it is an explicit action rather than a side
 * effect of un-checking cards.
 */
export function clearBreak(breakId: string): ShipBreakDetail {
  requireBreak(breakId)
  const database = getDb()
  database.transaction(() => {
    setBreakSlotsChecked(breakId, false, null)
    setBreakStatus(breakId, 'pending')
  })()
  return getBreak(breakId) as ShipBreakDetail
}

export function setBreakTopSleeved(breakId: string, on: boolean): ShipBreakDetail {
  requireBreak(breakId)
  setBreakSlotsTopSleeved(breakId, on)
  return getBreak(breakId) as ShipBreakDetail
}

/** Explicit status set (the UI's "mark shipped"/"reopen"). */
export function setBreakStage(breakId: string, status: ShipBreakStatus): ShipBreakDetail {
  requireBreak(breakId)
  setBreakStatus(breakId, status)
  return getBreak(breakId) as ShipBreakDetail
}

// ---------------------------------------------------------------------------
// 6 — Shipment tracking. "Manual is truth" with a forward exception.
// ---------------------------------------------------------------------------

function shipmentRow(sh: ShipShipment, ctx: DerivationContext): ShipShipmentRow {
  const slots = ctx.slotsByCustomer.get(sh.customerId) ?? []
  const customer = customerOf(ctx.customers, sh.customerId)
  let value = 0
  for (const s of slots) value += s.price
  return {
    id: sh.id,
    customerId: sh.customerId,
    customer: {
      handle: customer.whatnotHandle || customer.id,
      realName: customer.realName,
      address: customer.address,
      isNew: customer.isNew,
      // So a screen can turn to this customer's page in the uploaded slip.
      pages: customer.pages ?? []
    },
    trackingNumber: sh.trackingNumber,
    carrier: sh.carrier,
    serviceType: sh.serviceType,
    weightOz: sh.weightOz,
    uspsUrl: sh.uspsUrl,
    manualStatus: sh.manualStatus,
    stage: _deriveStage(sh),
    notes: sh.notes,
    onHold: sh.onHold,
    heldReason: sh.heldReason,
    queueOrder: sh.queueOrder,
    packedAt: sh.packedAt,
    packedBy: sh.packedBy,
    specialRequest: sh.specialRequest,
    cardCount: slots.length,
    value: cents(value),
    lastUpdated: sh.lastUpdated
  }
}

export function listShipments(): ShipShipmentRow[] {
  const ctx = buildContext()
  return sortShipments(listShipShipments()).map((sh) => shipmentRow(sh, ctx))
}

export function getShipmentRow(id: string): ShipShipmentRow | null {
  const sh = getShipShipment(id)
  return sh ? shipmentRow(sh, contextFor(sh.customerId)) : null
}

/**
 * A human picking a status from the tracker. This ALWAYS writes — the
 * precedence rules exist to stop automated writers from clobbering a person,
 * never the other way round.
 */
export function setShipmentStatus(
  id: string,
  code: ShipStatusCode,
  userId: string | null
): ShipShipmentRow {
  const sh = getShipShipment(id)
  if (!sh) throw new Error('Shipment not found.')
  updateShipment(id, { manualStatus: { code, setAt: nowIso(), setBy: userId } })
  return getShipmentRow(id) as ShipShipmentRow
}

export function setShipmentNotes(id: string, notes: string): ShipShipmentRow {
  const sh = getShipShipment(id)
  if (!sh) throw new Error('Shipment not found.')
  const trimmed = (notes ?? '').trim()
  updateShipment(id, { notes: trimmed || null })
  return getShipmentRow(id) as ShipShipmentRow
}

/** Writers that are NOT a person. Anything else in `setBy` is a human. */
export const AUTO_SETTERS = ['auto', '17track', 'usps'] as const

/**
 * Codes a carrier scan can produce. Everything except `not_shipped` — which is
 * only ever an operator/app state, never something a carrier reports.
 */
const CARRIER_CODES: ShipStatusCode[] = SHIP_STATUS_CODES.filter((c) => c !== 'not_shipped')

/** Pre-shipment states a real carrier code may always advance past. */
const PRESHIP_CODES: ShipStatusCode[] = ['not_shipped', 'label_created']

function isAutoSetter(by: string | null | undefined): boolean {
  return !!by && (AUTO_SETTERS as readonly string[]).includes(by)
}

/**
 * Apply a batch of `tracking number -> status` updates (doc section 6),
 * verbatim:
 *
 *   humanSet           = cur.setBy && !AUTO_SETTERS.includes(cur.setBy)
 *   forwardFromPreship = cur.code in [not_shipped, label_created] && code is a carrier code
 *   forwardScan        = AUTO_SETTERS.includes(by) && RANK[code] > RANK[cur.code]
 *   if humanSet && !forwardFromPreship && !forwardScan  -> SKIP, else write
 *
 * This is the fix for "clicking Sent freezes the order": a human `in_transit`
 * may still be advanced to `delivered` by a real scan, while a human
 * `delivered` / `returned` / `exception` (all rank 4) is never regressed.
 */
export function bulkSetShipmentStatusByTracking(
  entries: ShipBulkStatusEntry[],
  opts: { by?: string | null } = {}
): ShipBulkStatusResult {
  const by = opts.by ?? 'auto'
  const shipments = listShipShipments()
  const byTracking = new Map<string, ShipShipment>()
  for (const sh of shipments) {
    const t = sh.trackingNumber?.trim()
    if (t) byTracking.set(t, sh)
  }

  let updated = 0
  let skipped = 0
  const unmatched: string[] = []
  const at = nowIso()

  const database = getDb()
  database.transaction(() => {
    for (const entry of entries) {
      const tracking = entry?.trackingNumber?.trim()
      const code = entry?.code
      if (!tracking || !code || !SHIP_STATUS_CODES.includes(code)) continue
      const sh = byTracking.get(tracking)
      if (!sh) {
        unmatched.push(tracking)
        continue
      }

      const cur = sh.manualStatus
      const humanSet = !!cur.setBy && !isAutoSetter(cur.setBy)
      const forwardFromPreship =
        PRESHIP_CODES.includes(cur.code) && CARRIER_CODES.includes(code)
      const forwardScan = isAutoSetter(by) && SHIP_STATUS_RANK[code] > SHIP_STATUS_RANK[cur.code]

      if (humanSet && !forwardFromPreship && !forwardScan) {
        skipped += 1
        continue
      }
      updateShipment(sh.id, { manualStatus: { code, setAt: at, setBy: by } })
      updated += 1
    }
  })()

  return { updated, skipped, unmatched, rows: listShipments() }
}

/** The USPS "open all" bulk-tracking URLs produced by the parse. */
export function listBatchUrls(): ReturnType<typeof listShipBatchUrls> {
  return listShipBatchUrls()
}

export function listTrackingNumbers(): string[] {
  return listShipTrackingNumbers()
}

// ---------------------------------------------------------------------------
// 8 — sales + ledger derivation
// ---------------------------------------------------------------------------

function emptyStageCounts(): Record<ShipFulfillmentStage, number> {
  return {
    to_pick: 0,
    put_together: 0,
    sent: 0,
    all_good: 0,
    exception: 0,
    returned: 0
  }
}

function emptyStatusCounts(): Record<ShipStatusCode, number> {
  return {
    not_shipped: 0,
    label_created: 0,
    in_transit: 0,
    out_for_delivery: 0,
    delivered: 0,
    exception: 0,
    returned: 0
  }
}

/**
 * The top-20%-by-value cutoff used to highlight big spenders:
 * `vals.sort(desc)[ceil(n * 0.2) - 1]` (doc 4.2).
 */
export function vipThreshold(values: number[]): number {
  const vals = values.filter((v) => Number.isFinite(v)).sort((a, b) => b - a)
  if (vals.length === 0) return 0
  const idx = Math.ceil(vals.length * 0.2) - 1
  return cents(vals[Math.max(0, Math.min(idx, vals.length - 1))])
}

export function getSales(): ShipSalesSummary {
  const ctx = buildContext()
  const shipments = sortShipments(listShipShipments())
  const stageCounts = emptyStageCounts()
  const statusCounts = emptyStatusCounts()

  const byCustomer: ShipSalesCustomerRow[] = []
  const breakAgg = new Map<string, ShipSalesBreakRow & { customerSet: Set<string> }>()

  let revenue = 0
  let cardCount = 0
  let paidCardCount = 0
  let giveawayCount = 0
  const orderValues: number[] = []

  for (const sh of shipments) {
    const stage = _deriveStage(sh)
    stageCounts[stage] += 1
    statusCounts[sh.manualStatus.code] += 1

    const slots = ctx.slotsByCustomer.get(sh.customerId) ?? []
    const customer = customerOf(ctx.customers, sh.customerId)
    let custRevenue = 0
    let custPaid = 0
    let custGiveaways = 0
    const custBreaks = new Set<string>()

    for (const s of slots) {
      custRevenue += s.price
      if (s.isGiveaway) custGiveaways += 1
      else custPaid += 1
      custBreaks.add(s.breakId)

      let row = breakAgg.get(s.breakId)
      if (!row) {
        row = {
          breakId: s.breakId,
          breakLabel: s.breakLabel,
          breakNumber: s.breakNumber,
          cards: 0,
          paidCards: 0,
          giveaways: 0,
          customers: 0,
          revenue: 0,
          avgCardPrice: 0,
          customerSet: new Set<string>()
        }
        breakAgg.set(s.breakId, row)
      }
      row.cards += 1
      if (s.isGiveaway) row.giveaways += 1
      else row.paidCards += 1
      row.revenue += s.price
      row.customerSet.add(s.customerId)
    }

    revenue += custRevenue
    cardCount += slots.length
    paidCardCount += custPaid
    giveawayCount += custGiveaways
    orderValues.push(cents(custRevenue))

    byCustomer.push({
      customerId: sh.customerId,
      handle: customer.whatnotHandle || customer.id,
      realName: customer.realName,
      cards: slots.length,
      paidCards: custPaid,
      giveaways: custGiveaways,
      breaks: custBreaks.size,
      revenue: cents(custRevenue),
      stage,
      onHold: sh.onHold,
      isNew: customer.isNew
    })
  }

  const byBreak: ShipSalesBreakRow[] = [...breakAgg.values()]
    .map((r) => ({
      breakId: r.breakId,
      breakLabel: r.breakLabel,
      breakNumber: r.breakNumber,
      cards: r.cards,
      paidCards: r.paidCards,
      giveaways: r.giveaways,
      customers: r.customerSet.size,
      revenue: cents(r.revenue),
      avgCardPrice: r.paidCards > 0 ? cents(r.revenue / r.paidCards) : 0
    }))
    .sort((a, b) => {
      if (a.breakNumber === null && b.breakNumber === null) return a.breakId.localeCompare(b.breakId)
      if (a.breakNumber === null) return 1
      if (b.breakNumber === null) return -1
      return a.breakNumber - b.breakNumber || (a.breakLabel ?? '').localeCompare(b.breakLabel ?? '')
    })

  const sortedCustomers = [...byCustomer].sort((a, b) => b.revenue - a.revenue)

  return {
    event: getShipEvent(),
    revenue: cents(revenue),
    cardCount,
    paidCardCount,
    giveawayCount,
    customerCount: shipments.length,
    breakCount: listShipBreaks().length,
    avgOrderValue: shipments.length > 0 ? cents(revenue / shipments.length) : 0,
    avgCardPrice: paidCardCount > 0 ? cents(revenue / paidCardCount) : 0,
    vipThreshold: vipThreshold(orderValues),
    stageCounts,
    statusCounts,
    byBreak,
    byCustomer: sortedCustomers,
    topCustomers: sortedCustomers.slice(0, 10)
  }
}

/** The flattened card-level ledger — one row per physical card. */
export function getLedger(): ShipLedgerRow[] {
  const ctx = buildContext()
  const shipmentsByCustomer = new Map<string, ShipShipment>()
  for (const sh of listShipShipments()) shipmentsByCustomer.set(sh.customerId, sh)

  const rows: ShipLedgerRow[] = []
  for (const slot of listShipTeamSlots()) {
    const customer = customerOf(ctx.customers, slot.customerId)
    const sh = shipmentsByCustomer.get(slot.customerId) ?? null
    rows.push({
      orderRowId: sh?.id ?? '',
      customerId: slot.customerId,
      handle: customer.whatnotHandle || customer.id,
      realName: customer.realName,
      breakId: slot.breakId,
      breakLabel: slot.breakLabel,
      breakNumber: slot.breakNumber,
      teamName: slot.teamName,
      orderId: slot.orderId,
      price: slot.price,
      isGiveaway: slot.isGiveaway,
      checkedOff: slot.checkedOff,
      topSleeved: slot.topSleeved,
      stage: sh ? _deriveStage(sh) : 'to_pick',
      trackingNumber: sh?.trackingNumber ?? null
    })
  }
  return rows.sort((a, b) => {
    if (a.breakNumber === null && b.breakNumber !== null) return 1
    if (b.breakNumber === null && a.breakNumber !== null) return -1
    if (a.breakNumber !== null && b.breakNumber !== null && a.breakNumber !== b.breakNumber) {
      return a.breakNumber - b.breakNumber
    }
    // Same number: #11 before #11A. Two breaks, so their cards must not
    // interleave in the export somebody reconciles against.
    const byLabel = (a.breakLabel ?? '').localeCompare(b.breakLabel ?? '')
    return byLabel !== 0 ? byLabel : a.teamName.localeCompare(b.teamName)
  })
}

export function listCustomerRows(): ShipCustomerRow[] {
  const ctx = buildContext()
  const shipmentsByCustomer = new Map<string, ShipShipment>()
  for (const sh of listShipShipments()) shipmentsByCustomer.set(sh.customerId, sh)
  return listShipCustomers().map((c) => {
    const slots = ctx.slotsByCustomer.get(c.id) ?? []
    let value = 0
    for (const s of slots) value += s.price
    return {
      ...c,
      shipmentId: shipmentsByCustomer.get(c.id)?.id ?? null,
      cardCount: slots.length,
      value: cents(value)
    }
  })
}

// ---------------------------------------------------------------------------
// Workspace summary
// ---------------------------------------------------------------------------

/**
 * How much of the SOP is ticked for the show's day.
 *
 * Queried here rather than imported from shipSop, which reads the costed plan
 * from this file — a cycle for the sake of one COUNT(*). The seven steps are the
 * shared constant, so the two cannot drift on what "all done" means.
 */
function sopCounts(): { sopDone: number; sopTotal: number } {
  const total = SHIP_SOP_STEPS.length
  const date = getShipEvent().date.trim()
  if (!date) return { sopDone: 0, sopTotal: total }
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM ship_sop_steps WHERE event_date = ? AND done = 1`)
    .get(date) as { n: number }
  return { sopDone: Math.min(total, row?.n ?? 0), sopTotal: total }
}

export function getWorkspaceSummary(): ShipWorkspaceSummary {
  const ctx = buildContext()
  const shipments = listShipShipments()
  const stageCounts = emptyStageCounts()
  let value = 0
  let trackingCount = 0
  let onHoldCount = 0
  let specialRequestCount = 0

  for (const sh of shipments) {
    stageCounts[_deriveStage(sh)] += 1
    if (sh.trackingNumber?.trim()) trackingCount += 1
    if (sh.onHold) onHoldCount += 1
    if (sh.specialRequest) specialRequestCount += 1
    for (const s of ctx.slotsByCustomer.get(sh.customerId) ?? []) value += s.price
  }

  const breakStatusCounts: Record<ShipBreakStatus, number> = {
    pending: 0,
    picking: 0,
    packed: 0,
    shipped: 0
  }
  for (const br of listShipBreaks()) breakStatusCounts[br.status] += 1

  const audit = listShipBreakAudit()
  const imports = listShipImports()

  // Break-less giveaways. `listBreaks()` cannot see them — they have no
  // `ship_breaks` row on purpose, so they never show up as a phantom break —
  // which is exactly why the count has to travel separately instead of a screen
  // quietly leaving them out of its total.
  const realBreakIds = new Set(listShipBreaks().map((b) => b.id))
  let looseCards = 0
  let looseChecked = 0
  let looseGiveawayCards = 0
  for (const s of listShipTeamSlots()) {
    if (realBreakIds.has(s.breakId)) continue
    looseCards += 1
    if (s.checkedOff) looseChecked += 1
    if (s.isGiveaway) looseGiveawayCards += 1
  }

  return {
    hasDataset: hasShipDataset(),
    event: getShipEvent(),
    counts: getShipDataCounts(),
    stageCounts,
    breakStatusCounts,
    value: cents(value),
    looseCards,
    looseChecked,
    looseGiveawayCards,
    trackingCount,
    onHoldCount,
    specialRequestCount,
    warnings: listShipWarnings(),
    audit,
    hasCollisions: audit.some((a) => a.collisions.length > 0),
    lastImport: imports[0] ?? null,
    ...sopCounts()
  }
}

export function listWarnings(): ShipWarning[] {
  return listShipWarnings()
}

/**
 * Clear a flag, or put it back.
 *
 * A flag never blocks the floor — it is a note that a person should look at
 * something. Being able to clear one is what keeps the list readable; without
 * it every flag from every import accumulates until nobody reads any of them.
 */
export function setWarningStatus(
  id: string,
  status: 'open' | 'handled',
  note: string | null,
  actorId: string | null
): ShipWarning | null {
  return setShipWarningStatus(id, status, note, actorId)
}

export function listBreakAudit(): ShipBreakAudit[] {
  return listShipBreakAudit()
}

export function getEvent(): ShipEvent {
  return getShipEvent()
}

// ---------------------------------------------------------------------------
// Snapshots — a dated capture that survives a re-import (doc 7)
// ---------------------------------------------------------------------------

export function snapshotContents(): ShipSnapshotContents {
  return {
    createdAt: nowIso(),
    event: getShipEvent(),
    orders: listOrders(),
    shipments: listShipments(),
    sales: getSales()
  }
}

export function createSnapshot(name: string): ShipSnapshot {
  const contents = snapshotContents()
  const label = (name ?? '').trim() || `${contents.event.name || 'Snapshot'} ${contents.createdAt.slice(0, 10)}`
  return createShipSnapshot(label, contents as unknown as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  // A trailing newline keeps Excel and `wc -l` happy.
  return `${lines.join('\r\n')}\r\n`
}

function money(n: number): string {
  return (Math.round((Number.isFinite(n) ? n : 0) * 100) / 100).toFixed(2)
}

function stageLabel(stage: ShipFulfillmentStage): string {
  const labels: Record<ShipFulfillmentStage, string> = {
    to_pick: 'To pick',
    put_together: 'Put together',
    sent: 'Sent',
    all_good: 'All good',
    exception: 'Exception',
    returned: 'Returned'
  }
  return labels[stage]
}

const ORDER_CSV_HEADERS = [
  'Queue',
  'Handle',
  'Name',
  'Address',
  'Stage',
  'Status',
  'Tracking',
  'Service',
  'Cards',
  'Checked',
  'Value',
  'Breaks',
  'Order IDs',
  'Has giveaway',
  'Top sleeved',
  'On hold',
  'Held reason',
  'Special request',
  'Notes',
  'Packed at'
]

function orderCsv(orders: ShipOrderRow[]): string {
  return toCsv(
    ORDER_CSV_HEADERS,
    orders.map((o, i) => [
      i + 1,
      o.customer.handle,
      o.customer.realName,
      o.customer.address,
      stageLabel(o.stage),
      SHIP_STATUS_LABELS[o.manualStatus.code],
      o.trackingNumber,
      o.serviceType,
      o.cardCount,
      o.pick.checked,
      money(o.value),
      o.breakCount,
      o.orderIds.join(' '),
      o.hasGiveaway,
      o.topSleevedCount,
      o.onHold,
      o.heldReason,
      o.specialRequest?.text ?? '',
      o.notes,
      o.packedAt
    ])
  )
}

/**
 * Rebuild a snapshot's orders CSV from its stored payload — deliberately from
 * the capture, not from live data, so a snapshot still exports correctly after
 * a re-import has replaced the dataset (doc 7).
 */
export function buildSnapshotCsv(snapshot: ShipSnapshot): { csv: string; filename: string } {
  const contents = snapshot.payload as unknown as Partial<ShipSnapshotContents>
  const orders = Array.isArray(contents?.orders) ? (contents.orders as ShipOrderRow[]) : []
  const stamp = (contents?.createdAt ?? snapshot.createdAt ?? nowIso()).slice(0, 10)
  const slug = snapshot.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return { csv: orderCsv(orders), filename: `rmcardz-snapshot-${slug || 'orders'}-${stamp}.csv` }
}

/** Build the CSV text for one export kind. The IPC layer writes it to disk. */
export function buildCsv(kind: ShipExportKind): { csv: string; filename: string } {
  const stamp = nowIso().slice(0, 10)
  switch (kind) {
    case 'orders':
      return { csv: orderCsv(listOrders()), filename: `rmcardz-orders-${stamp}.csv` }

    case 'shipments': {
      const rows = listShipments().map((s) => [
        s.customer.handle,
        s.customer.realName,
        s.trackingNumber,
        s.carrier,
        s.serviceType,
        s.weightOz,
        SHIP_STATUS_LABELS[s.manualStatus.code],
        s.manualStatus.setAt,
        s.manualStatus.setBy,
        stageLabel(s.stage),
        s.cardCount,
        money(s.value),
        s.onHold,
        s.notes,
        s.uspsUrl
      ])
      return {
        csv: toCsv(
          [
            'Handle',
            'Name',
            'Tracking',
            'Carrier',
            'Service',
            'Weight (oz)',
            'Status',
            'Status set at',
            'Status set by',
            'Stage',
            'Cards',
            'Value',
            'On hold',
            'Notes',
            'USPS URL'
          ],
          rows
        ),
        filename: `rmcardz-shipments-${stamp}.csv`
      }
    }

    case 'ledger': {
      const rows = getLedger().map((l) => [
        l.breakLabel ?? '',
        l.teamName,
        l.handle,
        l.realName,
        l.orderId,
        money(l.price),
        l.isGiveaway,
        l.checkedOff,
        l.topSleeved,
        stageLabel(l.stage),
        l.trackingNumber
      ])
      return {
        csv: toCsv(
          [
            'Break',
            'Team',
            'Handle',
            'Name',
            'Order ID',
            'Price',
            'Giveaway',
            'Checked off',
            'Top sleeved',
            'Stage',
            'Tracking'
          ],
          rows
        ),
        filename: `rmcardz-ledger-${stamp}.csv`
      }
    }

    case 'sales': {
      const sales = getSales()
      const rows = sales.byBreak.map((b) => [
        b.breakLabel ?? 'Giveaway',
        b.cards,
        b.paidCards,
        b.giveaways,
        b.customers,
        money(b.revenue),
        money(b.avgCardPrice)
      ])
      rows.push([
        'TOTAL',
        sales.cardCount,
        sales.paidCardCount,
        sales.giveawayCount,
        sales.customerCount,
        money(sales.revenue),
        money(sales.avgCardPrice)
      ])
      return {
        csv: toCsv(
          ['Break', 'Cards', 'Paid cards', 'Giveaways', 'Customers', 'Revenue', 'Avg card'],
          rows
        ),
        filename: `rmcardz-sales-${stamp}.csv`
      }
    }

    case 'customers': {
      const rows = getSales().byCustomer.map((c) => [
        c.handle,
        c.realName,
        c.cards,
        c.paidCards,
        c.giveaways,
        c.breaks,
        money(c.revenue),
        stageLabel(c.stage),
        c.onHold,
        c.isNew
      ])
      return {
        csv: toCsv(
          [
            'Handle',
            'Name',
            'Cards',
            'Paid cards',
            'Giveaways',
            'Breaks',
            'Revenue',
            'Stage',
            'On hold',
            'New buyer'
          ],
          rows
        ),
        filename: `rmcardz-customers-${stamp}.csv`
      }
    }

    case 'checker': {
      const rows: unknown[][] = []
      for (const br of listBreaks()) {
        const detail = getBreak(br.id)
        for (const s of detail?.slots ?? []) {
          rows.push([
            br.breakNumber,
            br.status,
            s.teamName,
            s.handle,
            s.realName,
            s.address,
            money(s.price),
            s.isGiveaway,
            s.checkedOff,
            s.checkedOffAt,
            s.checkedOffBy,
            s.topSleeved
          ])
        }
      }
      return {
        csv: toCsv(
          [
            'Break',
            'Break status',
            'Team',
            'Handle',
            'Name',
            'Address',
            'Price',
            'Giveaway',
            'Checked off',
            'Checked at',
            'Checked by',
            'Top sleeved'
          ],
          rows
        ),
        filename: `rmcardz-picklists-${stamp}.csv`
      }
    }

    case 'warnings': {
      const rows = listShipWarnings().map((w) => [w.page ?? '', w.message, w.rawText])
      return {
        csv: toCsv(['Page', 'Message', 'Raw text'], rows),
        filename: `rmcardz-warnings-${stamp}.csv`
      }
    }

    case 'imports': {
      const rows = listShipImports().map((r: ShipImportRecord) => [
        r.createdAt,
        r.name,
        r.filename,
        r.kind,
        r.carriedForward,
        r.counts.customers,
        r.counts.breaks,
        r.counts.teamSlots,
        r.counts.shipments,
        r.counts.giveaways,
        r.counts.warnings,
        money(r.counts.cardValue)
      ])
      return {
        csv: toCsv(
          [
            'Imported at',
            'Name',
            'File',
            'Kind',
            'Carried forward',
            'Customers',
            'Breaks',
            'Cards',
            'Shipments',
            'Giveaways',
            'Warnings',
            'Card value'
          ],
          rows
        ),
        filename: `rmcardz-imports-${stamp}.csv`
      }
    }

    case 'tracking': {
      const ctx = buildContext()
      const rows = sortShipments(listShipShipments())
        .filter((s) => s.trackingNumber?.trim())
        .map((s) => {
          const c = customerOf(ctx.customers, s.customerId)
          return [
            s.trackingNumber,
            c.whatnotHandle || c.id,
            c.realName,
            SHIP_STATUS_LABELS[s.manualStatus.code],
            s.uspsUrl
          ]
        })
      return {
        csv: toCsv(['Tracking', 'Handle', 'Name', 'Status', 'USPS URL'], rows),
        filename: `rmcardz-tracking-${stamp}.csv`
      }
    }

    default: {
      const never: never = kind
      throw new Error(`Unknown export: ${String(never)}`)
    }
  }
}

/** Every stage the dropdown may offer — exported so the IPC layer can validate. */
export const VALID_STAGES: ShipFulfillmentStage[] = SHIP_STAGES
