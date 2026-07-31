/**
 * RM Cardz Shipping Workspace — IPC transport.
 *
 * Thin by design: every handler validates its input, checks one permission and
 * calls the domain layer (src/main/db/shippingDomain.ts). No derivation, no
 * status logic and no SQL live here — that is the architecture doc's "routes are
 * thin; `Db` owns every mutation and every derivation" rule, ported.
 *
 * Reads are gated by `module.fulfillment`, every write by `shipping.manage`.
 * Every mutating handler returns the FRESHLY DERIVED row so the renderer can
 * reconcile one row instead of refetching a screen.
 *
 * Parsing a 200-page Whatnot export takes 10-30s, so it runs as a BACKGROUND
 * JOB: `startParse` returns a jobId immediately, progress arrives on
 * `shipping:parse:event`, and `shipping:parse:job` polls the same state for a
 * renderer that mounted late.
 */

import { BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { ipcMain } from './ipcRegistry'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { IPC } from '@shared/ipc'
import type { ExportResult, Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import {
  SHIP_BREAK_STATUSES,
  SHIP_SPORTS,
  SHIP_STATUS_CODES,
  type ShipBatchUrl,
  type ShipBreakAudit,
  type ShipBreakStatus,
  type ShipEvent,
  type ShipImportRecord,
  type ShipSnapshot,
  type ShipSnapshotSummary,
  type ShipSportOption,
  type ShipStatusCode,
  type ShipWarning
} from '@shared/shippingTypes'
import {
  SHIP_EXPORT_KINDS,
  SHIP_STAGES,
  type ShipAssignmentBoard,
  type ShipBreakAssignee,
  type ShipBreakAssignmentUpdate,
  type ShipBreakDetail,
  type ShipBreakSummary,
  type ShipBulkStatusEntry,
  type ShipBulkStatusResult,
  type ShipCalendarDayDetail,
  type ShipCalendarMonth,
  type ShipCustomerRow,
  type ShipExportKind,
  type ShipFulfillmentStage,
  type ShipLedgerRow,
  type ShipOrderRow,
  type ShipParseJob,
  type ShipParseRequest,
  type ShipParseStart,
  type ShipQueueDirection,
  type ShipSalesSummary,
  type ShipShipmentRow,
  type ShipSlotUpdate,
  type ShipWorkspaceSummary
} from '@shared/shippingViews'
import { currentUser } from './services/auth'
import { parsePdf } from './shipping/pdf'
import {
  clearShipDataset,
  deleteShipImport,
  deleteShipSnapshot,
  getShipSettings,
  getShipSnapshot,
  importDataset,
  listShipImports,
  listShipSnapshots,
  renameShipImport,
  renameShipSnapshot,
  setShipEvent,
  setShipSettings
} from './db/shipping'
import {
  assignBreak,
  buildCsv,
  buildSnapshotCsv,
  clearBreak,
  createSnapshot,
  getAssignmentBoard,
  getBreak,
  getEvent,
  getLedger,
  getOrder,
  getSales,
  getWorkspaceSummary,
  listAllBreakAssignees,
  listBatchUrls,
  listBreakAssignees,
  listBreakAudit,
  listBreaks,
  listCustomerRows,
  listOrders,
  listShipments,
  listTrackingNumbers,
  listWarnings,
  markBreakPacked,
  moveOrder,
  resetOrderQueue,
  setBreakChecked,
  setBreakStage,
  setBreakTopSleeved,
  setOrderHold,
  setOrderNotes,
  setOrderSpecialRequest,
  setOrderStage,
  setShipmentNotes,
  setShipmentStatus,
  setTeamSlotChecked,
  setTeamSlotTopSleeved,
  unassignBreak,
  bulkSetShipmentStatusByTracking
} from './db/shippingDomain'
import { getShipCalendarDay, listShipCalendar } from './db/shippingCalendar'

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

/** Every write in this module goes through here. */
function requireManage(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('shipping.manage')) {
    throw new Error('You do not have permission to manage shipping.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function nowIso(): string {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Background parse jobs
// ---------------------------------------------------------------------------

/** Keep a short history so a late-mounting renderer can still read the result. */
const JOB_LIMIT = 12
const jobs = new Map<string, ShipParseJob>()

function rememberJob(job: ShipParseJob): void {
  jobs.set(job.id, job)
  while (jobs.size > JOB_LIMIT) {
    const oldest = jobs.keys().next()
    if (oldest.done) break
    jobs.delete(oldest.value)
  }
}

function emitJob(job: ShipParseJob): void {
  const payload = { ...job }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.shipParseEvent, payload)
  }
}

const PDF_FILTERS: OpenDialogOptions['filters'] = [{ name: 'PDF', extensions: ['pdf'] }]

interface ParseJobOptions {
  sport: ShipSportOption
  eventName: string | null
  eventDate: string | null
  name: string | null
  /** Keep the outgoing dataset's pick/pack progress. Off unless asked. */
  carryForward: boolean
}

/**
 * Runs off the IPC call stack. Progress is throttled so a 200-page extract does
 * not flood the renderer with several hundred messages per second.
 */
async function runParseJob(
  job: ShipParseJob,
  buffer: Buffer,
  opts: ParseJobOptions
): Promise<void> {
  let lastEmit = 0
  try {
    const dataset = await parsePdf(buffer, {
      sport: opts.sport,
      eventName: opts.eventName,
      eventDate: opts.eventDate,
      onProgress: (p) => {
        job.phase = p.phase === 'error' ? 'parse' : p.phase
        job.page = p.page
        job.totalPages = p.totalPages
        job.message = p.message
        const now = Date.now()
        if (now - lastEmit >= 120) {
          lastEmit = now
          emitJob(job)
        }
      }
    })

    // The import is synchronous (better-sqlite3) and fully transactional: a
    // throw anywhere inside leaves the previous dataset untouched.
    const result = importDataset(dataset, {
      filename: job.filename,
      name: opts.name ?? job.filename,
      carryForward: opts.carryForward
    })

    job.status = 'done'
    job.phase = 'done'
    job.page = job.totalPages
    job.counts = result.counts
    job.carriedForward = result.carriedForward
    job.event = result.event
    job.finishedAt = nowIso()
    job.message = result.carriedForward
      ? `Imported ${result.counts.customers} packages and carried your progress forward.`
      : `Imported ${result.counts.customers} packages, ${result.counts.teamSlots} cards.`
  } catch (err) {
    job.status = 'error'
    job.phase = 'error'
    job.finishedAt = nowIso()
    job.error = err instanceof Error ? err.message : String(err)
    job.message = job.error
  }
  emitJob(job)
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const SPORT_OPTIONS: ShipSportOption[] = ['auto', ...SHIP_SPORTS]

function validSport(v: unknown): ShipSportOption {
  return SPORT_OPTIONS.includes(v as ShipSportOption) ? (v as ShipSportOption) : 'auto'
}

function requireId(v: unknown, what: string): string {
  const id = str(v).trim()
  if (!id) throw new Error(`No ${what} specified.`)
  return id
}

// ---------------------------------------------------------------------------

export function registerShippingIpc(): void {
  // ---- Reads (module.fulfillment) ----------------------------------------
  ipcMain.handle(IPC.shipSummary, (): ShipWorkspaceSummary | null =>
    can('module.fulfillment') ? getWorkspaceSummary() : null
  )
  ipcMain.handle(IPC.shipEvent, (): ShipEvent | null =>
    can('module.fulfillment') ? getEvent() : null
  )
  ipcMain.handle(IPC.shipWarnings, (): ShipWarning[] =>
    can('module.fulfillment') ? listWarnings() : []
  )
  ipcMain.handle(IPC.shipAudit, (): ShipBreakAudit[] =>
    can('module.fulfillment') ? listBreakAudit() : []
  )
  ipcMain.handle(IPC.shipCustomers, (): ShipCustomerRow[] =>
    can('module.fulfillment') ? listCustomerRows() : []
  )
  ipcMain.handle(IPC.shipOrdersList, (): ShipOrderRow[] =>
    can('module.fulfillment') ? listOrders() : []
  )
  ipcMain.handle(IPC.shipOrderGet, (_e, id: string): ShipOrderRow | null =>
    can('module.fulfillment') ? getOrder(str(id)) : null
  )
  ipcMain.handle(IPC.shipBreaksList, (): ShipBreakSummary[] =>
    can('module.fulfillment') ? listBreaks() : []
  )
  ipcMain.handle(IPC.shipBreakGet, (_e, id: string): ShipBreakDetail | null =>
    can('module.fulfillment') ? getBreak(str(id)) : null
  )
  ipcMain.handle(IPC.shipShipmentsList, (): ShipShipmentRow[] =>
    can('module.fulfillment') ? listShipments() : []
  )
  ipcMain.handle(IPC.shipBatchUrls, (): ShipBatchUrl[] =>
    can('module.fulfillment') ? listBatchUrls() : []
  )
  ipcMain.handle(IPC.shipTrackingNumbers, (): string[] =>
    can('module.fulfillment') ? listTrackingNumbers() : []
  )
  ipcMain.handle(IPC.shipSales, (): ShipSalesSummary | null =>
    can('module.fulfillment') ? getSales() : null
  )
  ipcMain.handle(IPC.shipLedger, (): ShipLedgerRow[] =>
    can('module.fulfillment') ? getLedger() : []
  )
  ipcMain.handle(IPC.shipImportsList, (): ShipImportRecord[] =>
    can('module.fulfillment') ? listShipImports() : []
  )
  /**
   * A month of history. `null` (rather than an empty month) when the caller has
   * no access, matching every other read here, so the UI shows its permission
   * empty state instead of an eerily blank calendar.
   */
  ipcMain.handle(
    IPC.shipCalendar,
    (_e, payload?: { year?: number; month?: number }): ShipCalendarMonth | null => {
      if (!can('module.fulfillment')) return null
      const now = new Date()
      const year = Number(payload?.year)
      const month = Number(payload?.month)
      return listShipCalendar(
        Number.isFinite(year) ? year : now.getFullYear(),
        Number.isFinite(month) ? month : now.getMonth() + 1
      )
    }
  )
  ipcMain.handle(IPC.shipCalendarDay, (_e, date: string): ShipCalendarDayDetail | null => {
    if (!can('module.fulfillment')) return null
    // A malformed date is a caller bug, not something to spin forever on.
    try {
      return getShipCalendarDay(str(date))
    } catch {
      return null
    }
  })
  ipcMain.handle(IPC.shipAssignmentsList, (_e, breakId?: string): ShipBreakAssignee[] => {
    if (!can('module.fulfillment')) return []
    const id = str(breakId).trim()
    return id ? listBreakAssignees(id) : listAllBreakAssignees()
  })
  /** The Admin tab's one read. The roster rides along only for a manager. */
  ipcMain.handle(IPC.shipAssignmentBoard, (): ShipAssignmentBoard | null =>
    can('module.fulfillment') ? getAssignmentBoard(can('shipping.manage')) : null
  )
  ipcMain.handle(IPC.shipSnapshotsList, (): ShipSnapshotSummary[] =>
    can('module.fulfillment') ? listShipSnapshots() : []
  )
  ipcMain.handle(IPC.shipSnapshotGet, (_e, id: string): ShipSnapshot | null =>
    can('module.fulfillment') ? getShipSnapshot(str(id)) : null
  )
  ipcMain.handle(IPC.shipSettingsGet, (): Record<string, string> =>
    can('module.fulfillment') ? getShipSettings() : {}
  )
  ipcMain.handle(IPC.shipParseJob, (_e, jobId: string): ShipParseJob | null => {
    if (!can('module.fulfillment')) return null
    return jobs.get(str(jobId)) ?? null
  })

  // ---- Upload / parse (shipping.manage) ----------------------------------
  ipcMain.handle(
    IPC.shipParseStart,
    async (e, request: ShipParseRequest): Promise<Result<ShipParseStart>> => {
      try {
        requireManage()

        let filePath = str(request?.filePath).trim()
        if (!filePath) {
          const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
          const opts: OpenDialogOptions = {
            title: 'Choose the Whatnot packing-slip PDF',
            properties: ['openFile'],
            filters: PDF_FILTERS
          }
          const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
          if (picked.canceled || !picked.filePaths[0]) {
            return { ok: false, error: 'No file selected.' }
          }
          filePath = picked.filePaths[0]
        }
        if (!/\.pdf$/i.test(filePath)) return { ok: false, error: 'Choose a PDF file.' }

        const buffer = await readFile(filePath)
        if (!buffer.length) return { ok: false, error: 'That PDF is empty.' }

        const filename = basename(filePath)
        const job: ShipParseJob = {
          id: randomUUID(),
          status: 'running',
          filename,
          phase: 'extract',
          page: 0,
          totalPages: 0,
          message: 'Reading the PDF…',
          startedAt: nowIso(),
          finishedAt: null,
          error: null,
          counts: null,
          carriedForward: false,
          event: null
        }
        rememberJob(job)
        emitJob(job)

        // Deliberately NOT awaited: the handler returns the jobId at once so a
        // 10-30s parse never blocks the IPC loop.
        void runParseJob(job, buffer, {
          sport: validSport(request?.sport),
          eventName: str(request?.eventName).trim() || null,
          eventDate: str(request?.eventDate).trim() || null,
          carryForward: request?.carryForward === true,
          name: str(request?.name).trim() || null
        })

        return { ok: true, data: { jobId: job.id, filename } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipSetEvent,
    (_e, payload: { name: string; date: string }): Result<ShipEvent> => {
      try {
        requireManage()
        return { ok: true, data: setShipEvent(str(payload?.name), str(payload?.date)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipDatasetClear, (): Result<ShipWorkspaceSummary> => {
    try {
      requireManage()
      clearShipDataset()
      return { ok: true, data: getWorkspaceSummary() }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Orders (shipping.manage) ------------------------------------------
  ipcMain.handle(
    IPC.shipOrderStage,
    (_e, payload: { id: string; stage: ShipFulfillmentStage }): Result<ShipOrderRow> => {
      try {
        const actor = requireManage()
        const id = requireId(payload?.id, 'order')
        if (!SHIP_STAGES.includes(payload?.stage)) return { ok: false, error: 'Unknown stage.' }
        return { ok: true, data: setOrderStage(id, payload.stage, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipOrderHold,
    (_e, payload: { id: string; onHold: boolean; reason?: string | null }): Result<ShipOrderRow> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'order')
        return { ok: true, data: setOrderHold(id, !!payload?.onHold, str(payload?.reason)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipOrderMove,
    (_e, payload: { id: string; direction: ShipQueueDirection }): Result<ShipOrderRow[]> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'order')
        if (payload?.direction !== 'up' && payload?.direction !== 'down') {
          return { ok: false, error: 'Choose a direction.' }
        }
        return { ok: true, data: moveOrder(id, payload.direction) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipOrderSpecialRequest,
    (_e, payload: { id: string; text: string }): Result<ShipOrderRow> => {
      try {
        const actor = requireManage()
        const id = requireId(payload?.id, 'order')
        return { ok: true, data: setOrderSpecialRequest(id, str(payload?.text), actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipOrderNotes,
    (_e, payload: { id: string; notes: string }): Result<ShipOrderRow> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'order')
        return { ok: true, data: setOrderNotes(id, str(payload?.notes)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipOrdersResetQueue, (): Result<ShipOrderRow[]> => {
    try {
      requireManage()
      return { ok: true, data: resetOrderQueue() }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Checker (shipping.manage) -----------------------------------------
  ipcMain.handle(
    IPC.shipSlotChecked,
    (_e, payload: { id: string; checked: boolean }): Result<ShipSlotUpdate> => {
      try {
        const actor = requireManage()
        const id = requireId(payload?.id, 'card')
        return { ok: true, data: setTeamSlotChecked(id, !!payload?.checked, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipSlotTopSleeved,
    (_e, payload: { id: string; topSleeved: boolean }): Result<ShipSlotUpdate> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'card')
        return { ok: true, data: setTeamSlotTopSleeved(id, !!payload?.topSleeved) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipBreakCheckAll,
    (_e, payload: { id: string; checked: boolean }): Result<ShipBreakDetail> => {
      try {
        const actor = requireManage()
        const id = requireId(payload?.id, 'break')
        return { ok: true, data: setBreakChecked(id, !!payload?.checked, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipBreakPack, (_e, payload: { id: string }): Result<ShipBreakDetail> => {
    try {
      requireManage()
      return { ok: true, data: markBreakPacked(requireId(payload?.id, 'break')) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.shipBreakClear, (_e, payload: { id: string }): Result<ShipBreakDetail> => {
    try {
      requireManage()
      return { ok: true, data: clearBreak(requireId(payload?.id, 'break')) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.shipBreakSleeveAll,
    (_e, payload: { id: string; topSleeved: boolean }): Result<ShipBreakDetail> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'break')
        return { ok: true, data: setBreakTopSleeved(id, !!payload?.topSleeved) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipBreakSetStatus,
    (_e, payload: { id: string; status: ShipBreakStatus }): Result<ShipBreakDetail> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'break')
        if (!SHIP_BREAK_STATUSES.includes(payload?.status)) {
          return { ok: false, error: 'Unknown break status.' }
        }
        return { ok: true, data: setBreakStage(id, payload.status) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- Break assignments (shipping.manage) -------------------------------
  ipcMain.handle(
    IPC.shipAssign,
    (
      _e,
      payload: { breakId: string; employeeId: string; note?: string | null }
    ): Result<ShipBreakAssignmentUpdate> => {
      try {
        const actor = requireManage()
        const breakId = requireId(payload?.breakId, 'break')
        const employeeId = requireId(payload?.employeeId, 'employee')
        const note = str(payload?.note).trim() || null
        return { ok: true, data: assignBreak(breakId, employeeId, note, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Accepts either the assignment id (what an assignee chip holds) or the
   * (breakId, employeeId) pair (what a toggle naturally knows).
   */
  ipcMain.handle(
    IPC.shipUnassign,
    (
      _e,
      payload: { id?: string | null; breakId?: string | null; employeeId?: string | null }
    ): Result<ShipBreakAssignmentUpdate> => {
      try {
        requireManage()
        const id = str(payload?.id).trim()
        const breakId = str(payload?.breakId).trim()
        const employeeId = str(payload?.employeeId).trim()
        if (!id && !(breakId && employeeId)) return { ok: false, error: 'No assignment specified.' }
        return { ok: true, data: unassignBreak({ id, breakId, employeeId }) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- Shipping tracker (shipping.manage) --------------------------------
  ipcMain.handle(
    IPC.shipShipmentStatus,
    (_e, payload: { id: string; code: ShipStatusCode }): Result<ShipShipmentRow> => {
      try {
        const actor = requireManage()
        const id = requireId(payload?.id, 'shipment')
        if (!SHIP_STATUS_CODES.includes(payload?.code)) {
          return { ok: false, error: 'Unknown shipment status.' }
        }
        return { ok: true, data: setShipmentStatus(id, payload.code, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipShipmentNotes,
    (_e, payload: { id: string; notes: string }): Result<ShipShipmentRow> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'shipment')
        return { ok: true, data: setShipmentNotes(id, str(payload?.notes)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipShipmentBulkStatus,
    (
      _e,
      payload: { entries: ShipBulkStatusEntry[]; by?: string | null }
    ): Result<ShipBulkStatusResult> => {
      try {
        const actor = requireManage()
        const entries = Array.isArray(payload?.entries) ? payload.entries : []
        if (entries.length === 0) return { ok: false, error: 'Paste at least one tracking number.' }
        // `by` defaults to the signed-in person, which makes this a HUMAN write
        // under the doc's section 6 precedence. Passing one of the AUTO_SETTERS
        // ('auto' / '17track' / 'usps') marks it as a machine scan instead.
        const by = str(payload?.by).trim() || actor.id
        return { ok: true, data: bulkSetShipmentStatusByTracking(entries, { by }) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Opening a tracking page is not a data mutation, so it only needs read
  // access. Only https URLs are ever handed to the OS.
  ipcMain.handle(IPC.shipOpenTracking, async (_e, trackingNumber: string): Promise<Result> => {
    try {
      if (!can('module.fulfillment')) return { ok: false, error: 'You do not have access.' }
      const t = str(trackingNumber).trim()
      if (!t) return { ok: false, error: 'No tracking number.' }
      await shell.openExternal(
        `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`
      )
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  })

  /** The batch "open all" USPS URLs (35 labels per tab). */
  ipcMain.handle(
    IPC.shipOpenBatch,
    async (_e, payload?: { batchNumber?: number }): Promise<Result<{ opened: number }>> => {
      try {
        if (!can('module.fulfillment')) return { ok: false, error: 'You do not have access.' }
        const all = listBatchUrls()
        const wanted =
          payload?.batchNumber != null
            ? all.filter((b) => b.batchNumber === payload.batchNumber)
            : all
        if (wanted.length === 0) return { ok: false, error: 'No tracking numbers to open.' }
        let opened = 0
        for (const batch of wanted) {
          if (!/^https:\/\//i.test(batch.url)) continue
          await shell.openExternal(batch.url)
          opened += 1
        }
        return { ok: true, data: { opened } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- History: imports, snapshots, exports -------------------------------
  ipcMain.handle(
    IPC.shipImportRename,
    (_e, payload: { id: string; name: string }): Result<ShipImportRecord> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'import')
        const name = str(payload?.name).trim()
        if (!name) return { ok: false, error: 'Enter a name.' }
        const rec = renameShipImport(id, name)
        return rec ? { ok: true, data: rec } : { ok: false, error: 'Import not found.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipImportDelete, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      const id = requireId(payload?.id, 'import')
      return deleteShipImport(id) ? { ok: true } : { ok: false, error: 'Import not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.shipSnapshotCreate,
    (_e, payload?: { name?: string }): Result<ShipSnapshot> => {
      try {
        requireManage()
        return { ok: true, data: createSnapshot(str(payload?.name)) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipSnapshotRename,
    (_e, payload: { id: string; name: string }): Result<ShipSnapshot> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'snapshot')
        const name = str(payload?.name).trim()
        if (!name) return { ok: false, error: 'Enter a name.' }
        const snap = renameShipSnapshot(id, name)
        return snap ? { ok: true, data: snap } : { ok: false, error: 'Snapshot not found.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipSnapshotDelete, (_e, payload: { id: string }): Result => {
    try {
      requireManage()
      const id = requireId(payload?.id, 'snapshot')
      return deleteShipSnapshot(id) ? { ok: true } : { ok: false, error: 'Snapshot not found.' }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.shipExport,
    async (
      e,
      payload: { kind?: ShipExportKind; snapshotId?: string | null }
    ): Promise<ExportResult> => {
      try {
        if (!can('module.fulfillment')) {
          return { ok: false, error: 'You do not have permission to export shipping data.' }
        }

        let built: { csv: string; filename: string }
        const snapshotId = str(payload?.snapshotId).trim()
        if (snapshotId) {
          const snap = getShipSnapshot(snapshotId)
          if (!snap) return { ok: false, error: 'Snapshot not found.' }
          built = buildSnapshotCsv(snap)
        } else {
          const kind = payload?.kind
          if (!kind || !SHIP_EXPORT_KINDS.includes(kind)) {
            return { ok: false, error: 'Choose what to export.' }
          }
          built = buildCsv(kind)
        }

        const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
        const opts = {
          title: 'Export shipping data',
          defaultPath: built.filename,
          filters: [{ name: 'CSV', extensions: ['csv'] }]
        }
        const picked = win
          ? await dialog.showSaveDialog(win, opts)
          : await dialog.showSaveDialog(opts)
        if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
        writeFileSync(picked.filePath, built.csv, 'utf8')
        return { ok: true, path: picked.filePath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // ---- Settings -----------------------------------------------------------
  ipcMain.handle(
    IPC.shipSettingsPatch,
    (_e, patch: Record<string, string | null>): Result<Record<string, string>> => {
      try {
        requireManage()
        if (!patch || typeof patch !== 'object') return { ok: false, error: 'Nothing to save.' }
        const clean: Record<string, string | null> = {}
        for (const [key, value] of Object.entries(patch)) {
          if (!key) continue
          clean[key] = value === null ? null : str(value)
        }
        return { ok: true, data: setShipSettings(clean) }
      } catch (err) {
        return fail(err)
      }
    }
  )
}
