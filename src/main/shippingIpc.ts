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
import { uploadedBytes, uploadedName } from './util'
import { IPC } from '@shared/ipc'
import type { ExportResult, Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { BreakBenchDetail, BreakStepState } from '@shared/breakSteps'
import {
  type ShipDocument,
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
  type ShipSport,
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
  type ShipFinishResult,
  type ShipFulfillmentStage,
  type ShipImportDeletePlan,
  type ShipImportDeleteResult,
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
  clearShipDocument,
  deleteShipSnapshot,
  getShipSettings,
  getShipSnapshot,
  importDataset,
  listShipImports,
  listShipSnapshots,
  renameShipImport,
  getShipDocument,
  getShipDocumentBytes,
  shipDocumentArrival,
  putShipDocument,
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
  finishNight,
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
  setWarningStatus,
  markBreakPacked,
  moveOrder,
  resetOrderQueue,
  getBench,
  listBenchStates,
  setBreakStep,
  setTeamBagged,
  setBreakChecked,
  setBreakLeague,
  setBreakStage,
  setBreakTopSleeved,
  setOrderHold,
  setOrderNotes,
  setOrderSpecialRequest,
  getSupplyPlan,
  getSupplyPlanCosted,
  setOrderChecked,
  setOrderStage,
  setShipmentNotes,
  setShipmentStatus,
  setTeamSlotChecked,
  setSlotPicked,
  setTeamSlotTopSleeved,
  unassignBreak,
  bulkSetShipmentStatusByTracking
} from './db/shippingDomain'
import { getShipCalendarDay, listShipCalendar } from './db/shippingCalendar'
import { deleteShipImport, planShipImportDelete } from './db/shipImportDelete'
import type { ShipSupplyPlan, ShipSupplyPlanCosted } from '@shared/shippingSupplies'
import {
  claimOrder,
  endStationSession,
  getStationBoard,
  heartbeatStation,
  operatorFor,
  packBack,
  packDone,
  packNext,
  pickAdvance,
  pickNext,
  releaseClaim,
  sendBack,
  startStationSession,
  stationRoster,
  type AdvanceResult,
  type ClaimOutcome
} from './db/shipStations'
import {
  isShipStationRole,
  type ShipStationBoard,
  type ShipStationOrder
} from '@shared/shipStations'
import { setTeamSlotSleeve } from './db/shippingDomain'
import { mergeShows, type ParsedShow } from '@shared/shows'

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

/**
 * The floor guards.
 *
 * Doing the work is not the same as running the show. A sorter has to be able to
 * check a card off; they have no business importing a PDF, reassigning breaks or
 * setting a shipment's status. Before this split every write here required
 * shipping.manage, which Staff does not have — so a hired sorter could open the
 * Shipping workspace and change nothing in it.
 *
 * shipping.manage still implies both, so every existing account keeps working
 * exactly as it did.
 */
function requireAny(permissions: Permission[], what: string): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!permissions.some((p) => user.permissions.includes(p))) {
    throw new Error(`You do not have permission to ${what}.`)
  }
  return { id: user.id }
}

/** Pulling cards for a break. */
function requireFind(): { id: string } {
  return requireAny(['shipping.find', 'shipping.manage'], 'check cards off')
}

/** Assembling and closing a customer package. */
function requirePack(): { id: string } {
  return requireAny(['shipping.pack', 'shipping.manage'], 'pack orders')
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

/** One PDF waiting to be read, with the name it will be recognised by. */
interface ParseFile {
  filename: string
  buffer: Buffer
}

/**
 * Runs off the IPC call stack. Progress is throttled so a 200-page extract does
 * not flood the renderer with several hundred messages per second.
 *
 * SEVERAL SLIPS AT ONCE. Each file is parsed as its own show — its own league
 * detection, its own breaks, its own event — and only then are they merged and
 * written, in ONE transaction. Importing them one at a time would be wrong two
 * different ways: each import replaces the workspace, so the second slip would
 * delete the first; and the merge is where two nights that both ran a
 * "Break #4" are told apart, so nothing can be written until every slip is read.
 */
async function runParseJob(
  job: ShipParseJob,
  files: ParseFile[],
  opts: ParseJobOptions
): Promise<void> {
  let lastEmit = 0
  try {
    const parsed: ParsedShow[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      job.filename = file.filename
      job.fileIndex = i + 1
      emitJob(job)
      const dataset = await parsePdf(file.buffer, {
        sport: opts.sport,
        eventName: opts.eventName,
        eventDate: opts.eventDate,
        onProgress: (p) => {
          job.phase = p.phase === 'error' ? 'parse' : p.phase
          job.page = p.page
          job.totalPages = p.totalPages
          job.message =
            files.length > 1 ? `${file.filename} (${i + 1}/${files.length}) — ${p.message}` : p.message
          const now = Date.now()
          if (now - lastEmit >= 120) {
            lastEmit = now
            emitJob(job)
          }
        }
      })
      /**
       * The show id is the file's POSITION in this upload, not its name. Two
       * streams are routinely exported under the same filename, and a name
       * collision here would merge two different nights into one break list.
       */
      parsed.push({ id: `s${i + 1}`, filename: file.filename, dataset })
    }

    const merged = mergeShows(parsed)

    // The import is synchronous (better-sqlite3) and fully transactional: a
    // throw anywhere inside leaves the previous dataset untouched.
    const result = importDataset(merged.dataset, {
      filename: files.map((f) => f.filename).join(', '),
      name: opts.name ?? files[0]?.filename ?? 'Import',
      carryForward: opts.carryForward
    })

    // Keep the files themselves, now that the dataset they produced has landed.
    //
    // After the import, not before: a parse that throws must leave the previous
    // show — dataset AND slip — exactly as it was, so nobody is left holding a
    // pick list and a document that describe different nights.
    try {
      for (const file of files) {
        putShipDocument({
          importId: result.record?.id ?? null,
          name: file.filename,
          pageCount: job.totalPages,
          bytes: file.buffer
        })
      }
    } catch (err) {
      // The slip is a convenience; the dataset is the job. Never fail an import
      // that already succeeded because the paper could not be filed.
      job.documentError = err instanceof Error ? err.message : String(err)
    }

    job.status = 'done'
    job.phase = 'done'
    job.page = job.totalPages
    job.counts = result.counts
    job.carriedForward = result.carriedForward
    job.event = result.event
    job.shows = merged.shows
    job.finishedAt = nowIso()
    const showPart = merged.shows.length > 1 ? ` across ${merged.shows.length} shows` : ''
    job.message = result.carriedForward
      ? `Imported ${result.counts.customers} packages${showPart} and carried your progress forward.`
      : `Imported ${result.counts.customers} packages, ${result.counts.teamSlots} cards${showPart}.`
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

  /**
   * Clear a flag, or put it back.
   *
   * Gated on doing the work rather than running the show. The person who
   * notices that "#30" is a randomiser spot and not a team is the one holding
   * the card, and making them fetch a manager to dismiss a note is how a flag
   * list stops being read.
   */
  ipcMain.handle(
    IPC.shipWarningStatus,
    (
      _e,
      payload: { id: string; status: 'open' | 'handled'; note?: string | null }
    ): Result<ShipWarning> => {
      try {
        const actor = requireAny(
          ['shipping.find', 'shipping.pack', 'shipping.manage'],
          'clear flags'
        )
        const id = requireId(payload?.id, 'flag')
        const status = payload?.status === 'handled' ? 'handled' : 'open'
        const next = setWarningStatus(id, status, payload?.note ?? null, actor.id)
        if (!next) return { ok: false, error: 'That flag no longer exists.' }
        return { ok: true, data: next }
      } catch (err) {
        return fail(err)
      }
    }
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
  // What the night was WORTH, and every card's price. Lead-level, not floor.
  //
  // These were readable by anyone with the module, which was defensible while
  // every account belonged to a named person. It stops being defensible the
  // moment a shared bench login sits unattended on a work computer — so the
  // money moved behind `shipping.manage` at the same time stations arrived.
  ipcMain.handle(IPC.shipSales, (): ShipSalesSummary | null =>
    can('shipping.manage') ? getSales() : null
  )
  ipcMain.handle(IPC.shipLedger, (): ShipLedgerRow[] =>
    can('shipping.manage') ? getLedger() : []
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

        // Three ways the bytes arrive, in order of how much the caller knows:
        // a browser uploads them, a desktop caller names paths, and a desktop
        // caller who named nothing gets the native picker. Each way can now
        // carry SEVERAL slips — a Saturday that ran two streams, or Thursday's
        // night and Saturday's worked together — and each one becomes its own
        // show. See runParseJob.
        const files: ParseFile[] = []

        const uploads = [
          ...(Array.isArray(request?.uploads) ? request.uploads : []),
          ...(request?.upload ? [request.upload] : [])
        ]
        const uploadedFiles = uploads
          .map((u) => ({ filename: uploadedName(u, 'packing-slips.pdf'), buffer: uploadedBytes(u) }))
          .filter((f): f is ParseFile => f.buffer !== null)

        if (uploadedFiles.length > 0) {
          for (const f of uploadedFiles) {
            if (!/\.pdf$/i.test(f.filename)) return { ok: false, error: 'Choose PDF files.' }
            files.push(f)
          }
        } else {
          let paths = [
            ...(Array.isArray(request?.filePaths) ? request.filePaths : []),
            ...(str(request?.filePath).trim() ? [str(request?.filePath).trim()] : [])
          ].filter(Boolean)
          if (paths.length === 0) {
            const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
            const opts: OpenDialogOptions = {
              title: 'Choose the Whatnot packing-slip PDFs',
              // One night or several — the picker allows both, so the operator
              // never has to run the upload twice for one evening's work.
              properties: ['openFile', 'multiSelections'],
              filters: PDF_FILTERS
            }
            const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
            if (picked.canceled || picked.filePaths.length === 0) {
              return { ok: false, error: 'No file selected.' }
            }
            paths = picked.filePaths
          }
          for (const filePath of paths) {
            if (!/\.pdf$/i.test(filePath)) return { ok: false, error: 'Choose PDF files.' }
            files.push({ filename: basename(filePath), buffer: await readFile(filePath) })
          }
        }

        if (files.length === 0) return { ok: false, error: 'No file selected.' }
        /**
         * An empty file is refused rather than skipped. Dropping it silently
         * would import the OTHER slips and report success, and the operator
         * would go looking for a night that never landed.
         */
        const empty = files.find((f) => f.buffer.length === 0)
        if (empty) return { ok: false, error: `${empty.filename} is empty.` }

        const job: ShipParseJob = {
          id: randomUUID(),
          status: 'running',
          filename: files[0].filename,
          filenames: files.map((f) => f.filename),
          fileIndex: 1,
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
        void runParseJob(job, files, {
          sport: validSport(request?.sport),
          eventName: str(request?.eventName).trim() || null,
          eventDate: str(request?.eventDate).trim() || null,
          carryForward: request?.carryForward === true,
          name: str(request?.name).trim() || null
        })

        return {
          ok: true,
          data: { jobId: job.id, filename: files[0].filename, filenames: files.map((f) => f.filename) }
        }
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
      // The slip describes the dataset that just went away.
      clearShipDocument()
      return { ok: true, data: getWorkspaceSummary() }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Mark a whole package picked. The floor guard, not the manage one: this is
   * the finding job done in one press instead of forty-seven.
   */
  ipcMain.handle(
    IPC.shipOrderCheckAll,
    (
      _e,
      payload: { customerId?: unknown; checked?: unknown; onlyUnchecked?: unknown }
    ): Result<ShipOrderRow> => {
      try {
        const actor = requireFind()
        return {
          ok: true,
          data: setOrderChecked(
            requireId(payload?.customerId, 'package'),
            payload?.checked !== false,
            actor.id,
            payload?.onlyUnchecked === true
          )
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipSupplyPlan, (): ShipSupplyPlan | null =>
    can('module.fulfillment') ? getSupplyPlan() : null
  )

  /**
   * The costed plan needs the supplies list, so it is gated on BOTH modules —
   * somebody who cannot see Inventory does not get unit costs by another door.
   */
  ipcMain.handle(IPC.shipSupplyPlanCosted, (): ShipSupplyPlanCosted | null =>
    can('module.fulfillment') && can('module.inventory') ? getSupplyPlanCosted() : null
  )

  // ---- The floor: stations, and the pick -> pack handoff -------------------
  //
  // Reads need the module. Every write needs the floor permission for the job
  // being done — `requireFind` to pick, `requirePack` to pack — exactly as the
  // rest of this file already works. What is NEW is that the person stamped on
  // the work is not necessarily the account that authorised it: a bench login
  // is shared, so `operatorFor()` resolves the person standing there.
  //
  // The operator is never an input to a permission decision. Choosing a name
  // from the roster grants nothing; it only changes whose name lands on the
  // card. That line is what keeps this from becoming a second auth system.
  ipcMain.handle(IPC.shipStationBoard, (): ShipStationBoard | null =>
    can('module.fulfillment') ? getStationBoard() : null
  )

  /**
   * Who could be standing here.
   *
   * People currently ON THE CLOCK, which is an existing authenticated act —
   * somebody signed in somewhere to punch in. So a station needs no second
   * password and no PIN, and the list cannot name anybody who is not at work.
   */
  ipcMain.handle(IPC.shipStationRoster, (): Array<{ id: string; name: string }> =>
    can('module.fulfillment') ? stationRoster() : []
  )

  ipcMain.handle(
    IPC.shipStationStart,
    (_e, payload: { operatorId?: unknown; role?: unknown }): Result<ShipStationBoard> => {
      try {
        const role = str(payload?.role)
        if (!isShipStationRole(role)) throw new Error('Choose picking or packing.')
        // Authorise against the job they are about to do, not the module.
        const actor = role === 'pack' ? requirePack() : requireFind()
        const operatorId = str(payload?.operatorId).trim()
        if (!operatorId) throw new Error('Say who is at this bench.')
        const started = startStationSession(operatorId, role, actor.id)
        if (!started) throw new Error('That person is not clocked in.')
        return { ok: true, data: getStationBoard() }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipStationEnd, (): Result<ShipStationBoard> => {
    try {
      requireAny(['shipping.find', 'shipping.pack', 'shipping.manage'], 'work the floor')
      endStationSession()
      return { ok: true, data: getStationBoard() }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.shipStationClaim,
    (_e, payload: { orderId?: unknown; customerId?: unknown; role?: unknown }): Result<ClaimOutcome> => {
      try {
        const role = str(payload?.role)
        if (!isShipStationRole(role)) throw new Error('Unknown job.')
        const actor = role === 'pack' ? requirePack() : requireFind()
        return {
          ok: true,
          data: claimOrder(
            requireId(payload?.orderId, 'order'),
            requireId(payload?.customerId, 'customer'),
            role,
            actor.id
          )
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipStationRelease, (_e, claimId: unknown): Result<boolean> => {
    try {
      requireAny(['shipping.find', 'shipping.pack', 'shipping.manage'], 'work the floor')
      return { ok: true, data: releaseClaim(requireId(claimId, 'claim'), 'put back') }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.shipStationPickAdvance,
    (_e, customerId: unknown): Result<AdvanceResult> => {
      try {
        const actor = requireFind()
        return { ok: true, data: pickAdvance(requireId(customerId, 'package'), actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.shipStationPickNext, (): Result<ShipStationOrder | null> => {
    try {
      const actor = requireFind()
      return { ok: true, data: pickNext(actor.id) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.shipStationPackNext, (): Result<ShipStationOrder | null> => {
    try {
      const actor = requirePack()
      return { ok: true, data: packNext(actor.id) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.shipStationPackDone, (_e, customerId: unknown): Result<ShipOrderRow | null> => {
    try {
      const actor = requirePack()
      return { ok: true, data: packDone(requireId(customerId, 'package'), actor.id) }
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * STEP BACK ONE BOX, and open it again. See packBack.
   *
   * Behind `requirePack()` like the rest of the bench: the same authority that
   * seals a box may un-seal it. It answers with a Result rather than a bare
   * order, because this is the one bench control that can REFUSE — a parcel the
   * carrier already has is not something to quietly mark unpacked.
   */
  ipcMain.handle(IPC.shipStationPackBack, (): Result<ShipStationOrder | null> => {
    try {
      const actor = requirePack()
      const res = packBack(actor.id)
      if (!res.ok) return { ok: false, error: res.error ?? 'Could not step back.' }
      return { ok: true, data: res.order }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.shipStationSendBack,
    (_e, payload: { customerId?: unknown; reason?: unknown }): Result<boolean> => {
      try {
        requirePack()
        const reason = str(payload?.reason).trim()
        if (!reason) throw new Error('Say what is wrong with it.')
        return { ok: true, data: sendBack(requireId(payload?.customerId, 'package'), reason) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /** Cheap, local, no network. Keeps this station's claims from expiring. */
  ipcMain.handle(IPC.shipStationHeartbeat, (): number =>
    can('module.fulfillment') ? heartbeatStation() : 0
  )

  /**
   * Sleeved / top-loaded, per card.
   *
   * Two flags, because step 1 consumes two supplies at two different rates and
   * one boolean could not say which had happened. Recording it does NOT move
   * stock — step 1's tick still does that, once, for the whole show.
   */
  ipcMain.handle(
    IPC.shipSlotSleeve,
    (_e, payload: { slotId?: unknown; which?: unknown; on?: unknown }): Result<ShipSlotUpdate> => {
      try {
        const actor = requireFind()
        const which = payload?.which === 'top_sleeved' ? 'top_sleeved' : 'sleeved'
        return {
          ok: true,
          data: setTeamSlotSleeve(
            requireId(payload?.slotId, 'card'),
            which,
            payload?.on !== false,
            operatorFor(actor.id)
          )
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- The uploaded slip -------------------------------------------------
  //
  // Readable by anyone who can open the module: a picker who cannot see the
  // paper cannot do the job the paper is for. Only clearing it needs manage.
  ipcMain.handle(IPC.shipDocument, (): ShipDocument | null =>
    can('module.fulfillment') ? getShipDocument() : null
  )

  /**
   * The file, once, as raw bytes.
   *
   * Sent whole rather than page by page because the renderer's PDF view wants a
   * blob URL it can page around inside instantly — a picker moving down a
   * hundred orders cannot wait for a round trip per page. ~1MB for a 136-page
   * export, fetched once when the view opens.
   */
  ipcMain.handle(IPC.shipDocumentBytes, (): Uint8Array | null => {
    if (!can('module.fulfillment')) return null
    const bytes = getShipDocumentBytes()
    return bytes ? new Uint8Array(bytes) : null
  })

  /**
   * How much of an incoming slip has landed, when one is on its way.
   *
   * "No slip on this machine" and "the slip is four slices of twelve in" look
   * identical — a blank pane — and used to read the same, which told somebody to
   * re-import a file that was already arriving.
   */
  ipcMain.handle(
    IPC.shipDocumentArrival,
    (): { have: number; total: number; name: string } | null =>
      can('module.fulfillment') ? shipDocumentArrival() : null
  )

  ipcMain.handle(IPC.shipDocumentClear, (): Result<{ cleared: number }> => {
    try {
      requireManage()
      return { ok: true, data: { cleared: clearShipDocument() } }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Orders (shipping.manage) ------------------------------------------
  ipcMain.handle(
    IPC.shipOrderStage,
    (_e, payload: { id: string; stage: ShipFulfillmentStage }): Result<ShipOrderRow> => {
      try {
        const actor = requirePack()
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
        requirePack()
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
        const actor = requireFind()
        const id = requireId(payload?.id, 'card')
        return { ok: true, data: setTeamSlotChecked(id, !!payload?.checked, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  /**
   * Step 4's per-card tick, from the order walker.
   *
   * A separate channel from shipSlotChecked because they assert different
   * things about the same card — bagged at the bench, versus collected into
   * this buyer's package — and one endpoint serving both is exactly how they
   * came to share a column in the first place.
   */
  ipcMain.handle(
    IPC.shipSlotPicked,
    (_e, payload: { id: string; picked: boolean }): Result<ShipOrderRow> => {
      try {
        const actor = requireFind()
        const id = requireId(payload?.id, 'card')
        return { ok: true, data: setSlotPicked(id, !!payload?.picked, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipSlotTopSleeved,
    (_e, payload: { id: string; topSleeved: boolean }): Result<ShipSlotUpdate> => {
      try {
        requireFind()
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
        const actor = requireFind()
        const id = requireId(payload?.id, 'break')
        return { ok: true, data: setBreakChecked(id, !!payload?.checked, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // ---- The bench checklist -------------------------------------------------
  //
  // Gated on `module.fulfillment` for reads and on the same permission as the
  // pick list for writes: step 3 IS the pick list's checkmark, so anybody who
  // may tick a card may tick it from here.
  ipcMain.handle(IPC.shipBenchStates, (): BreakStepState[] =>
    can('module.fulfillment') ? listBenchStates() : []
  )

  ipcMain.handle(IPC.shipBenchGet, (_e, id: string): BreakBenchDetail | null =>
    can('module.fulfillment') ? getBench(str(id)) : null
  )

  ipcMain.handle(
    IPC.shipBenchSetStep,
    (
      _e,
      payload: { id: string; step: 'sleeve' | 'sort'; done: boolean }
    ): Result<BreakBenchDetail> => {
      try {
        const actor = requireFind()
        const id = requireId(payload?.id, 'break')
        if (payload?.step !== 'sleeve' && payload?.step !== 'sort') {
          return { ok: false, error: 'That is not a step that can be ticked all at once.' }
        }
        return { ok: true, data: setBreakStep(id, payload.step, !!payload?.done, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipBenchSetTeamBagged,
    (
      _e,
      payload: { id: string; teamName: string; bagged: boolean }
    ): Result<BreakBenchDetail> => {
      try {
        const actor = requireFind()
        const id = requireId(payload?.id, 'break')
        const teamName = str(payload?.teamName).trim()
        if (!teamName) return { ok: false, error: 'No team specified.' }
        return { ok: true, data: setTeamBagged(id, teamName, !!payload?.bagged, actor.id) }
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

  ipcMain.handle(
    IPC.shipBreakSetSport,
    (_e, payload: { id: string; sport: ShipSport | null }): Result<ShipBreakDetail> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'break')
        /**
         * `null` is a real answer here — it puts the break back on whatever
         * league the import as a whole was read as. Anything else has to be a
         * league the app actually has a slate for, or the re-match would run
         * against nothing and quietly wipe every name in the break.
         */
        const sport = payload?.sport ?? null
        if (sport !== null && !SHIP_SPORTS.includes(sport)) {
          return { ok: false, error: 'Unknown league.' }
        }
        return { ok: true, data: setBreakLeague(id, sport) }
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

  /**
   * What deleting this import would destroy. A read, but a lead's read: it
   * carries the show's value and who is standing at a bench, so it is gated
   * exactly as the delete is.
   */
  ipcMain.handle(
    IPC.shipImportDeletePlan,
    (_e, payload: { id: string }): Result<ShipImportDeletePlan> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'import')
        const plan = planShipImportDelete(id)
        return plan ? { ok: true, data: plan } : { ok: false, error: 'Import not found.' }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.shipImportDelete,
    (_e, payload: { id: string }): Result<ShipImportDeleteResult> => {
      try {
        requireManage()
        const id = requireId(payload?.id, 'import')
        return { ok: true, data: deleteShipImport(id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

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

  /**
   * The night is over.
   *
   * Guarded on the SAME test the button uses, and that is not belt-and-braces:
   * a screen can be stale — somebody else on another machine can push an order
   * back to picking between the summary rendering and the click landing — and
   * this is the boundary that decides. Refusing with the count in words means
   * the operator learns what changed rather than watching a button do nothing.
   */
  ipcMain.handle(
    IPC.shipFinishNight,
    (_e, payload?: { name?: string }): Result<ShipFinishResult> => {
      try {
        requireManage()
        const summary = getWorkspaceSummary()
        if (!summary.hasDataset) return { ok: false, error: 'There is no dataset to finish.' }
        if ((summary.counts?.orders ?? 0) <= 0) {
          return { ok: false, error: 'There are no orders on this dataset.' }
        }
        const left = summary.stageCounts?.to_pick ?? 0
        if (left > 0) {
          return {
            ok: false,
            error: `${left} order${left === 1 ? ' is' : 's are'} still waiting to be picked, so the slip is still needed.`
          }
        }
        return { ok: true, data: finishNight(str(payload?.name)) }
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
        // The customers and sales CSVs carry every buyer's real name, full
        // postal address and total spend. Writing that to a file is a lead's
        // decision, and a shared station must never be able to make it.
        if (!can('shipping.manage')) {
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
