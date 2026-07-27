/**
 * RM Cardz Shipping Workspace — the History CALENDAR derivation.
 *
 * Deliberately DERIVED. There is no `ship_calendar` / per-day rollup table and
 * v17 does not add one, because every number a day cell shows already exists:
 *
 *   - WHAT happened that day  -> `ship_imports.created_at` (name, filename,
 *     kind, counts) and `ship_snapshots.created_at`.
 *   - HOW FAR it got          -> the live dataset for the day whose import is
 *     still loaded, and that day's newest snapshot payload for every earlier
 *     day (a snapshot stores the orders + shipments + sales as captured).
 *
 * A rollup table would only duplicate those rows, and would go stale the moment
 * an import or snapshot is renamed or deleted — both of which the History tab
 * already offers. So the calendar reads the source of truth every time.
 *
 * The one thing that genuinely cannot be recovered is the fulfilment progress
 * of a day that was overwritten without anyone taking a snapshot. That is
 * reported honestly as `source: 'import'` with zeroed progress rather than
 * guessed at.
 *
 * DAYS ARE LOCAL. `created_at` is an ISO/UTC instant; bucketing it by UTC would
 * push a 7pm import onto tomorrow for anyone west of Greenwich. Every date key
 * here is the main process's local calendar date.
 */

import type {
  ShipEvent,
  ShipImportRecord,
  ShipSnapshot,
  ShipSnapshotSummary,
  ShipStatusCode
} from '@shared/shippingTypes'
import type {
  ShipCalendarBreakRow,
  ShipCalendarDay,
  ShipCalendarDayDetail,
  ShipCalendarMonth,
  ShipCalendarMonthTotals,
  ShipCalendarSource,
  ShipOrderRow,
  ShipShipmentRow,
  ShipSnapshotContents
} from '@shared/shippingViews'
import {
  getShipDataCounts,
  getShipEvent,
  getShipSnapshot,
  hasShipDataset,
  listShipImports,
  listShipShipments,
  listShipSnapshots,
  listShipTeamSlots
} from './shipping'
import { listBreaks } from './shippingDomain'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cents(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` in the main process's LOCAL timezone. */
export function localDateKey(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days in a 1-12 month (day 0 of the NEXT month is the last of this one). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** Codes that mean the package has physically left the building. */
const SENT_CODES: ShipStatusCode[] = ['in_transit', 'out_for_delivery', 'delivered', 'returned']

// ---------------------------------------------------------------------------
// Per-day statistics
// ---------------------------------------------------------------------------

interface DayStats {
  value: number
  cards: number
  cardsPicked: number
  packages: number
  packagesWithTracking: number
  packagesSent: number
  packagesDelivered: number
}

const ZERO_STATS: DayStats = {
  value: 0,
  cards: 0,
  cardsPicked: 0,
  packages: 0,
  packagesWithTracking: 0,
  packagesSent: 0,
  packagesDelivered: 0
}

function hasTracking(t: string | null | undefined): boolean {
  return !!t && t.trim() !== ''
}

/**
 * The live dataset — used for the ONE day whose import is still loaded, where
 * every figure is current rather than remembered.
 */
function liveStats(): DayStats {
  const counts = getShipDataCounts()
  let packagesWithTracking = 0
  let packagesSent = 0
  let packagesDelivered = 0
  for (const sh of listShipShipments()) {
    if (hasTracking(sh.trackingNumber)) packagesWithTracking += 1
    const code = sh.manualStatus?.code ?? 'not_shipped'
    if (SENT_CODES.includes(code)) packagesSent += 1
    if (code === 'delivered') packagesDelivered += 1
  }
  let value = 0
  for (const s of listShipTeamSlots()) value += s.price
  return {
    value: cents(value),
    cards: counts.teamSlots,
    cardsPicked: counts.checkedSlots,
    packages: counts.shipments,
    packagesWithTracking,
    packagesSent,
    packagesDelivered
  }
}

/**
 * Snapshot payloads are immutable once written (renaming touches only the
 * label), so the parse of one is safe to memoise. A month of history would
 * otherwise re-parse the same multi-hundred-KB blobs on every navigation.
 */
const snapshotStatsCache = new Map<string, DayStats>()
const SNAPSHOT_CACHE_LIMIT = 64

function rememberSnapshotStats(id: string, stats: DayStats): DayStats {
  snapshotStatsCache.set(id, stats)
  while (snapshotStatsCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotStatsCache.keys().next()
    if (oldest.done) break
    snapshotStatsCache.delete(oldest.value)
  }
  return stats
}

function snapshotOrders(snap: ShipSnapshot): ShipOrderRow[] {
  const contents = snap.payload as unknown as Partial<ShipSnapshotContents>
  return Array.isArray(contents?.orders) ? (contents.orders as ShipOrderRow[]) : []
}

function snapshotShipments(snap: ShipSnapshot): ShipShipmentRow[] {
  const contents = snap.payload as unknown as Partial<ShipSnapshotContents>
  return Array.isArray(contents?.shipments) ? (contents.shipments as ShipShipmentRow[]) : []
}

/**
 * Rebuild a day's figures from a stored capture. Written defensively: the
 * payload is a JSON blob whose shape is only a promise, so every field is
 * probed rather than trusted.
 */
function statsFromSnapshot(snap: ShipSnapshot): DayStats {
  const cached = snapshotStatsCache.get(snap.id)
  if (cached) return cached

  const contents = snap.payload as unknown as Partial<ShipSnapshotContents>
  const orders = snapshotOrders(snap)
  const shipments = snapshotShipments(snap)
  const sales = contents?.sales ?? null

  let cards = 0
  let cardsPicked = 0
  let orderValue = 0
  for (const o of orders) {
    cards += o?.pick?.total ?? 0
    cardsPicked += o?.pick?.checked ?? 0
    orderValue += typeof o?.value === 'number' ? o.value : 0
  }

  // The shipments array is the package-level truth; orders mirror it one-to-one
  // and stand in when an older capture stored only them.
  const packageRows: Array<{ trackingNumber: string | null; code: ShipStatusCode }> = (
    shipments.length > 0 ? shipments : orders
  ).map((r) => ({
    trackingNumber: r?.trackingNumber ?? null,
    code: (r?.manualStatus?.code ?? 'not_shipped') as ShipStatusCode
  }))

  let packagesWithTracking = 0
  let packagesSent = 0
  let packagesDelivered = 0
  for (const p of packageRows) {
    if (hasTracking(p.trackingNumber)) packagesWithTracking += 1
    if (SENT_CODES.includes(p.code)) packagesSent += 1
    if (p.code === 'delivered') packagesDelivered += 1
  }

  return rememberSnapshotStats(snap.id, {
    value: cents(typeof sales?.revenue === 'number' ? sales.revenue : orderValue),
    cards: cards > 0 ? cards : (sales?.cardCount ?? 0),
    cardsPicked,
    packages: packageRows.length,
    packagesWithTracking,
    packagesSent,
    packagesDelivered
  })
}

/** All that is known when an import ran but nothing captured its progress. */
function statsFromImport(record: ShipImportRecord): DayStats {
  return {
    ...ZERO_STATS,
    value: cents(record.counts.cardValue),
    cards: record.counts.teamSlots,
    packages: record.counts.shipments
  }
}

/** Cards + packages: how much physical work the day represents. */
function activityOf(stats: DayStats): number {
  return stats.cards + stats.packages
}

// ---------------------------------------------------------------------------
// Month assembly
// ---------------------------------------------------------------------------

interface MonthContext {
  importsByDay: Map<string, ShipImportRecord[]>
  snapshotsByDay: Map<string, ShipSnapshotSummary[]>
  /** The day whose dataset is currently loaded, or '' when there is none. */
  activeDate: string
  activeImportId: string
}

function buildContext(): MonthContext {
  const importsByDay = new Map<string, ShipImportRecord[]>()
  // listShipImports is newest-first; each day's array is reversed to
  // chronological order below so "the day's last import" is simply the last.
  const imports = listShipImports()
  for (const rec of imports) {
    const key = localDateKey(rec.createdAt)
    if (!key) continue
    const list = importsByDay.get(key)
    if (list) list.push(rec)
    else importsByDay.set(key, [rec])
  }
  for (const list of importsByDay.values()) list.reverse()

  const snapshotsByDay = new Map<string, ShipSnapshotSummary[]>()
  for (const snap of listShipSnapshots()) {
    const key = localDateKey(snap.createdAt)
    if (!key) continue
    const list = snapshotsByDay.get(key)
    if (list) list.push(snap)
    else snapshotsByDay.set(key, [snap])
  }
  for (const list of snapshotsByDay.values()) list.reverse()

  // The newest import is the one whose rows are in the ship_* tables right now —
  // but only while a dataset actually exists (it can have been cleared).
  const newest = imports[0]
  const active = newest && hasShipDataset() ? newest : null
  return {
    importsByDay,
    snapshotsByDay,
    activeDate: active ? localDateKey(active.createdAt) : '',
    activeImportId: active?.id ?? ''
  }
}

interface ResolvedDay {
  stats: DayStats
  source: ShipCalendarSource
  /** The snapshot the figures came from, when they came from one. */
  snapshotId: string | null
  /** The import whose dataset the figures describe. */
  importId: string | null
}

/**
 * Pick the best available truth for a day:
 *   live (still loaded) > that day's newest snapshot > the day's last import.
 */
function resolveDay(
  date: string,
  ctx: MonthContext,
  imports: ShipImportRecord[],
  snapshots: ShipSnapshotSummary[]
): ResolvedDay {
  const lastImport = imports.length > 0 ? imports[imports.length - 1] : null

  if (date === ctx.activeDate && ctx.activeDate !== '') {
    return {
      stats: liveStats(),
      source: 'live',
      snapshotId: snapshots.length > 0 ? snapshots[snapshots.length - 1].id : null,
      importId: ctx.activeImportId || (lastImport?.id ?? null)
    }
  }

  // Newest capture of the day wins: it saw the most work. `snapshots` is
  // CHRONOLOGICAL (buildContext reverses the newest-first query so the UI can
  // list a day's captures in the order they were taken), so the newest is the
  // LAST element — walk backwards, not forwards.
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snap = getShipSnapshot(snapshots[i].id)
    if (!snap) continue
    return {
      stats: statsFromSnapshot(snap),
      source: 'snapshot',
      snapshotId: snap.id,
      importId: lastImport?.id ?? null
    }
  }

  if (lastImport) {
    return {
      stats: statsFromImport(lastImport),
      source: 'import',
      snapshotId: null,
      importId: lastImport.id
    }
  }

  return { stats: { ...ZERO_STATS }, source: 'none', snapshotId: null, importId: null }
}

function makeDay(
  date: string,
  ctx: MonthContext,
  imports: ShipImportRecord[],
  snapshots: ShipSnapshotSummary[],
  resolved: ResolvedDay
): ShipCalendarDay {
  return {
    date,
    imports,
    snapshots,
    ...resolved.stats,
    source: resolved.source,
    isActive: date === ctx.activeDate && ctx.activeDate !== '',
    hasActivity: imports.length > 0 || snapshots.length > 0,
    // Filled in once the month's peak is known.
    intensity: 0
  }
}

function validMonth(year: number, month: number): { year: number; month: number } {
  const y = Math.trunc(Number(year))
  const m = Math.trunc(Number(month))
  if (!Number.isFinite(y) || !Number.isFinite(m) || y < 1970 || y > 9999 || m < 1 || m > 12) {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  }
  return { year: y, month: m }
}

interface BuiltMonth {
  month: ShipCalendarMonth
  /** Where each day's figures came from — the detail call's extra context. */
  resolved: Map<string, ResolvedDay>
}

/**
 * Assemble a month once. The detail call reuses this rather than rebuilding, so
 * a day panel and the grid behind it can never disagree about intensity.
 */
function buildMonth(year: number, month: number): BuiltMonth {
  const { year: y, month: m } = validMonth(year, month)
  const ctx = buildContext()
  const last = daysInMonth(y, m)
  const prefix = `${y}-${pad2(m)}`

  const days: ShipCalendarDay[] = []
  const totals: ShipCalendarMonthTotals = {
    imports: 0,
    snapshots: 0,
    activeDays: 0,
    value: 0,
    cards: 0,
    packages: 0
  }

  let peak = 0
  let busiestDate: string | null = null
  let importedValue = 0
  const resolvedByDay = new Map<string, ResolvedDay>()

  for (let d = 1; d <= last; d++) {
    const date = `${prefix}-${pad2(d)}`
    const imports = ctx.importsByDay.get(date) ?? []
    const snapshots = ctx.snapshotsByDay.get(date) ?? []
    const resolved = resolveDay(date, ctx, imports, snapshots)
    resolvedByDay.set(date, resolved)
    const day = makeDay(date, ctx, imports, snapshots, resolved)
    days.push(day)

    totals.imports += imports.length
    totals.snapshots += snapshots.length
    if (day.hasActivity) totals.activeDays += 1
    // Volume and money are summed from the IMPORTS, never from the day figures:
    // one dataset shows on its import day AND on every day it was snapshotted.
    for (const rec of imports) {
      importedValue += rec.counts.cardValue
      totals.cards += rec.counts.teamSlots
      totals.packages += rec.counts.shipments
    }

    const activity = activityOf(resolved.stats)
    if (activity > peak) {
      peak = activity
      busiestDate = date
    }
  }

  totals.value = cents(importedValue)

  if (peak > 0) {
    for (const day of days) {
      const activity = day.cards + day.packages
      day.intensity = activity > 0 ? Math.round((activity / peak) * 1000) / 1000 : 0
    }
  }

  const activeDate = ctx.activeDate.startsWith(`${prefix}-`) ? ctx.activeDate : null

  return {
    month: {
      year: y,
      month: m,
      start: `${prefix}-01`,
      end: `${prefix}-${pad2(last)}`,
      today: todayKey(),
      startWeekday: new Date(y, m - 1, 1).getDay(),
      days,
      totals,
      busiestDate,
      peak,
      activeDate
    },
    resolved: resolvedByDay
  }
}

/**
 * One entry per day of the month — including the empty ones, so the UI lays out
 * a grid without inventing placeholders — plus the totals and the peak the
 * cells' visual weight is normalised against.
 */
export function listShipCalendar(year: number, month: number): ShipCalendarMonth {
  return buildMonth(year, month).month
}

// ---------------------------------------------------------------------------
// Day detail
// ---------------------------------------------------------------------------

/** The live dataset's breaks, flattened for the day panel. */
function liveBreakRows(): ShipCalendarBreakRow[] {
  return listBreaks().map((br) => ({
    breakId: br.id,
    breakNumber: br.breakNumber,
    status: br.status,
    cards: br.totalTeams,
    picked: br.checkedTeams,
    customers: br.customerCount,
    value: br.value
  }))
}

/**
 * Rebuild the break rows from a capture. Snapshots store orders (one per
 * package) each carrying its per-break groups, so the breakdown is recovered by
 * regrouping them; break STATUS is not captured, hence null.
 */
function snapshotBreakRows(snap: ShipSnapshot): ShipCalendarBreakRow[] {
  const agg = new Map<string, ShipCalendarBreakRow & { customerSet: Set<string> }>()
  for (const order of snapshotOrders(snap)) {
    for (const group of order?.breaks ?? []) {
      if (!group?.breakId) continue
      let row = agg.get(group.breakId)
      if (!row) {
        row = {
          breakId: group.breakId,
          breakNumber: group.breakNumber ?? null,
          status: null,
          cards: 0,
          picked: 0,
          customers: 0,
          value: 0,
          customerSet: new Set<string>()
        }
        agg.set(group.breakId, row)
      }
      row.cards += group.total ?? 0
      row.picked += group.checked ?? 0
      row.value += typeof group.value === 'number' ? group.value : 0
      if (order.customerId) row.customerSet.add(order.customerId)
    }
  }
  return [...agg.values()]
    .map((r) => ({
      breakId: r.breakId,
      breakNumber: r.breakNumber,
      status: r.status,
      cards: r.cards,
      picked: r.picked,
      customers: r.customerSet.size,
      value: cents(r.value)
    }))
    .sort((a, b) => {
      if (a.breakNumber === null && b.breakNumber === null) {
        return a.breakId.localeCompare(b.breakId)
      }
      if (a.breakNumber === null) return 1
      if (b.breakNumber === null) return -1
      return a.breakNumber - b.breakNumber
    })
}

function snapshotEvent(snap: ShipSnapshot): ShipEvent | null {
  const contents = snap.payload as unknown as Partial<ShipSnapshotContents>
  const ev = contents?.event
  if (!ev || typeof ev !== 'object') return null
  return {
    name: typeof ev.name === 'string' ? ev.name : '',
    date: typeof ev.date === 'string' ? ev.date : '',
    updatedAt: typeof ev.updatedAt === 'string' ? ev.updatedAt : null
  }
}

/**
 * One day, expanded: which import(s) ran, what the dataset was worth, how far
 * fulfilment got, the per-break breakdown and the snapshot to jump to.
 *
 * A day with nothing in it still returns a (zeroed) entry rather than null, so
 * clicking an empty cell shows "nothing happened" instead of an error.
 */
export function getShipCalendarDay(date: string): ShipCalendarDayDetail {
  const match = DATE_RE.exec((date ?? '').trim())
  if (!match) throw new Error('Choose a day.')
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw new Error('That is not a real date.')
  const key = `${y}-${pad2(m)}-${pad2(d)}`

  // Built from the whole month so the panel's intensity matches the grid behind
  // it, and so the snapshot parses are shared with the cell that was clicked.
  const built = buildMonth(y, m)
  const day = built.month.days.find((x) => x.date === key)
  const resolved = built.resolved.get(key)
  if (!day || !resolved) throw new Error('That day is not in this month.')

  let breaks: ShipCalendarBreakRow[] = []
  let event: ShipEvent | null = null
  if (resolved.source === 'live') {
    breaks = liveBreakRows()
    event = getShipEvent()
  } else if (resolved.source === 'snapshot' && resolved.snapshotId) {
    const snap = getShipSnapshot(resolved.snapshotId)
    if (snap) {
      breaks = snapshotBreakRows(snap)
      event = snapshotEvent(snap)
    }
  }

  return {
    ...day,
    year: y,
    month: m,
    event,
    breaks,
    snapshotId: resolved.snapshotId,
    importId: resolved.importId
  }
}
