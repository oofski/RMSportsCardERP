/**
 * Finance → Streaming IPC.
 *
 * Thin: every handler checks one permission, coerces its input and calls
 * db/financeStreaming.ts. No SQL, no parsing and no derivation here.
 *
 * Reads are gated on 'module.finance' and resolve to an EMPTY view / [] when the
 * caller lacks it, matching every other read handler in the app — the UI shows
 * its permission empty state rather than an error. Writes are gated on
 * 'finance.manage' and return Result<T>, because each one changes what the P&L
 * says.
 *
 * Every write returns the freshly derived view so a screen can reconcile without
 * a refetch — and, more importantly, so the operator sees the reconciliation
 * flag and the warnings from the SAME derivation that just ran, not from a
 * second read that might disagree with it.
 */
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type {
  ImportDeleteImpact,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  RatePeriodInput,
  StreamingFinanceView,
  WhatnotRatePeriod
} from '@shared/financeStreaming'
import {
  deleteImport,
  emptyView,
  importDeleteImpact,
  importLedger,
  listImports,
  listRows,
  reattributeAll,
  streamingFinanceView,
  type LedgerRowFilter
} from './db/financeStreaming'
import { deleteRatePeriod, listRatePeriods, saveRatePeriod } from './db/whatnotRates'
import { currentUser } from './services/auth'

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

/** Every write in this module goes through here. */
function requireManage(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('finance.manage')) {
    throw new Error('You do not have permission to manage finance data.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

const CSV_FILTERS = [
  { name: 'Whatnot ledger (CSV)', extensions: ['csv'] },
  { name: 'All files', extensions: ['*'] }
]

export function registerFinanceIpc(): void {
  // ---- Reads (module.finance) ---------------------------------------------
  ipcMain.handle(IPC.finStreamView, (): StreamingFinanceView =>
    can('module.finance') ? streamingFinanceView() : emptyView()
  )

  ipcMain.handle(IPC.finLedgerImports, (): LedgerImport[] =>
    can('module.finance') ? listImports() : []
  )

  ipcMain.handle(IPC.finLedgerRows, (_e, filter: LedgerRowFilter): LedgerRow[] => {
    if (!can('module.finance')) return []
    const clean: LedgerRowFilter = {}
    if (filter?.streamDate) clean.streamDate = str(filter.streamDate).trim()
    if (filter?.sessionId) clean.sessionId = str(filter.sessionId).trim()
    if (filter?.bucket) clean.bucket = str(filter.bucket).trim()
    if (filter?.unattributed) clean.unattributed = true
    if (filter?.limit !== undefined) clean.limit = Number(filter.limit)
    return listRows(clean)
  })

  // ---- Writes (finance.manage) --------------------------------------------

  /**
   * Pick a Whatnot ledger CSV and import it.
   *
   * The picker lives in main because that is where the window is; the renderer
   * never sees a filesystem path. An import is idempotent — re-uploading a week
   * that overlaps an earlier one inserts nothing and says so — so cancelling and
   * retrying is always safe.
   */
  ipcMain.handle(IPC.finLedgerImport, async (e): Promise<Result<LedgerImportResult>> => {
    try {
      const actor = requireManage()
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
      const opts: OpenDialogOptions = {
        title: 'Choose the Whatnot ledger export (CSV)',
        properties: ['openFile'],
        filters: CSV_FILTERS
      }
      const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No file selected.' }
      return importLedger(picked.filePaths[0], actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Remove an upload and the rows it brought in. A correction, not a deletion of
   * history: that money leaves the P&L because it should never have been in it.
   */
  /**
   * What that removal would cost. A read, so it is gated like a read — and it is
   * called by the confirmation dialog rather than by the delete, which means the
   * operator sees the real number before committing rather than after.
   */
  ipcMain.handle(IPC.finLedgerImportImpact, (_e, id: string): ImportDeleteImpact => {
    if (!can('module.finance')) {
      return { exists: false, owned: 0, covered: 0, losing: 0, losingAmount: 0 }
    }
    return importDeleteImpact(str(id).trim())
  })

  ipcMain.handle(IPC.finLedgerDeleteImport, (_e, id: string): Result<StreamingFinanceView> => {
    try {
      const actor = requireManage()
      return deleteImport(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Re-run attribution over every stored row. This is how money that fell
   * outside every logged show finds its home after the operator adds the session
   * they forgot — no re-upload, no heuristic, and nothing is re-read from the
   * CSV (the file may be gone, and re-parsing risks a different repair).
   */
  ipcMain.handle(IPC.finLedgerReattribute, (): Result<StreamingFinanceView> => {
    try {
      const actor = requireManage()
      const done = reattributeAll(actor.id)
      if (!done.ok) return { ok: false, error: done.error }
      return { ok: true, data: streamingFinanceView() }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Whatnot's commission, by date range ---------------------------------
  //
  // Read like every other read: without `module.finance` the list comes back
  // empty and the screen shows its permission state. Writes need
  // `finance.manage`, because this number decides the top line of every show the
  // business has ever run.
  //
  // VALIDATION IS HERE, in `saveRatePeriod`, not in the form. The renderer
  // checks too so the operator finds out early, but a renderer is a convenience
  // and this is the trust boundary — every field is re-coerced and re-checked
  // against the stored rows inside the write transaction.

  ipcMain.handle(IPC.finRatesList, (): WhatnotRatePeriod[] =>
    can('module.finance') ? listRatePeriods() : []
  )

  ipcMain.handle(
    IPC.finRateSave,
    (_e, input: RatePeriodInput): Result<WhatnotRatePeriod[]> => {
      try {
        const actor = requireManage()
        // Numbers off the wire are whatever the renderer sent. `Number(...)`
        // here rather than a cast: a form string that will not parse must arrive
        // as NaN and be REFUSED by the validator, not land as a 0% commission
        // that silently doubles the reported gross of every show in the range.
        //
        // The three newer terms are passed through UNTOUCHED when absent rather
        // than coerced to NaN — `Number(undefined)` is NaN, and a renderer
        // packaged before they existed would then be unable to save anything at
        // all. `saveRatePeriod` fills an absent field with the default and still
        // refuses one that is present and unparseable.
        return saveRatePeriod(
          {
            id: input?.id ? str(input.id).trim() : undefined,
            fromDate: str(input?.fromDate).trim(),
            toDate: input?.toDate === null || input?.toDate === undefined
              ? null
              : str(input.toDate).trim() || null,
            rate: Number(input?.rate),
            taxRate: input?.taxRate as number,
            processingRate: input?.processingRate as number,
            processingFlatCents: input?.processingFlatCents as number,
            note: str(input?.note)
          },
          actor.id
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.finRateDelete, (_e, id: string): Result<WhatnotRatePeriod[]> => {
    try {
      requireManage()
      return deleteRatePeriod(str(id).trim())
    } catch (err) {
      return fail(err)
    }
  })
}
