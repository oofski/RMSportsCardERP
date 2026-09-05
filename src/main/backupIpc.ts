import { app, BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { ExportResult, Result } from '@shared/types'
import type { BackupPreview } from '@shared/backup'
import { backupFilename } from '@shared/backup'
import type { RestoreCheck, RestoreStatus } from '@shared/restore'
import { RESTORE_CONFIRM_WORD, restoreConfirmed } from '@shared/restore'
import { currentUser } from './services/auth'
import { backupPreview, writeBackupTo } from './db/backup'
import { databasePath } from './db/database'
import {
  clearStagedRestore,
  stageRestoreFromFile,
  stageRestoreFromPath,
  stagedRestore
} from './db/restore'
import {
  armRestore,
  disarmRestore,
  replacedDatabases,
  restoreIsArmed,
  takeRestoreOutcome
} from './services/restoreOnBoot'

/**
 * Where the web upload lands, and the only path the stage handler will adopt.
 *
 * A CLIENT NEVER NAMES A PATH. An earlier shape had the route pass the temp
 * path it had written to, which reads as harmless right up until you notice
 * that the channel would then copy any file on the server's disk into the
 * staging slot and report its contents back. The owner can download the whole
 * database anyway, so this is not the crown jewels — but a handler that opens
 * whatever path it is handed is the kind of thing that becomes a real hole the
 * moment somebody widens who may call it.
 */
export function uploadedRestorePath(): string {
  return join(dirname(databasePath()), 'restore-upload.tmp')
}

/** The name the browser gave the file, kept beside it. Display only. */
function uploadedRestoreName(): string {
  try {
    const raw = readFileSync(`${uploadedRestorePath()}.name`, 'utf8')
    const base = String(raw).trim().split(/[\\/]/).pop() ?? ''
    return base || 'backup.db'
  } catch {
    return 'backup.db'
  }
}

/**
 * Handing the owner a copy of the database.
 *
 * ## Owner only, and checked HERE
 *
 * The file carries the QuickBooks refresh token and the payment instructions as
 * ordinary rows in `meta`, so it is credential material rather than an export.
 *
 * The check is `role === 'owner'` rather than a permission key, and that is
 * deliberate. `ROLE_PERMISSIONS.owner` is defined as ALL_PERMISSIONS, so a new
 * key would be held by the owner automatically — but it would also appear in
 * Admin → Roles, where it could be granted to somebody else. A control the
 * screen can give away is not the control this needs. The app already has two
 * genuine owner-only rules written exactly this way: `assignableRoles()` and the
 * last-active-Owner guard in ipc.ts.
 *
 * The tile in Admin is a courtesy. This is the lock — anything that can reach
 * the channel skips the tile entirely.
 */
function isOwner(): boolean {
  return currentUser()?.role === 'owner'
}

export function registerBackupIpc(): void {
  /**
   * What is in the database right now.
   *
   * NULL rather than a thrown error for somebody who may not see it, matching
   * `orderResetPreview`: the panel renders an EmptyState from a null, and a
   * screen that nobody unauthorised opens on purpose should not throw a banner
   * over itself.
   */
  ipcMain.handle(IPC.backupPreview, (): BackupPreview | null =>
    isOwner() ? backupPreview() : null
  )

  /**
   * Write the copy and hand it over.
   *
   * The save-dialog-then-writeFileSync shape is the app's established way to
   * give somebody a file, and it works unchanged on both transports: on the
   * desktop it is a real dialog and a real path, and on the server the stub
   * spools to a temp path which becomes a single-use download token. Every
   * other exporter in this app is written this way.
   *
   * The permission is checked BEFORE anything is written, so a refusal leaves
   * no file anywhere — not even in the server's spool directory, where an
   * abandoned copy of the database would be exactly the wrong thing to leave
   * lying about.
   */
  ipcMain.handle(IPC.backupDownload, async (): Promise<ExportResult> => {
    try {
      if (!isOwner()) {
        return { ok: false, error: 'Only the owner can download a backup.' }
      }
      const defaultName = backupFilename(new Date())
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Save backup',
        defaultPath: defaultName,
        filters: [{ name: 'Database', extensions: ['db'] }]
      })
      if (canceled || !filePath) return { ok: false, canceled: true }

      /**
       * The dialog stub on the server creates nothing — it only reserves a
       * path — but `takeSpooledDownloads()` reads whatever is at that path
       * afterwards. `writeBackupTo` renames its staging file onto the target,
       * which satisfies both transports: a real file where the desktop
       * operator asked for one, and a readable file where the spool expects
       * one.
       */
      writeBackupTo(filePath)
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/**
 * PUTTING A BACKUP BACK.
 *
 * Four channels, because staging, judging and swapping are three different acts
 * with three different blast radii, and giving them one entry point would mean
 * the only way to test a refusal is to survive it.
 *
 *   · `restoreStage`   — take a file, write it beside the database, say what it is.
 *                        Touches nothing that matters.
 *   · `restoreStatus`  — re-read whatever is staged. Survives a page refresh.
 *   · `restoreConfirm` — the only one that can cost anybody data.
 *   · `restoreCancel`  — throw the upload away.
 *
 * All four are owner-only, checked here, for the same reason the download is:
 * the file is credential material, and restoring one replaces the business.
 */
export function registerRestoreIpc(): void {
  const refuse = (): Result<never> => ({
    ok: false,
    error: 'Only the owner can restore a backup.'
  })

  /**
   * Read a file in and report on it. Nothing is swapped, nothing is promised.
   *
   * Two ways in, and which one is used is decided by the ARGUMENT rather than by
   * sniffing the environment. The browser has already streamed its upload to a
   * known path — see the `/api/restore` route, which never lets a client name a
   * path — and passes `fromUpload`. The desktop passes nothing and gets a native
   * dialog. It is the same shape as every other file-picking handler in this
   * app.
   */
  ipcMain.handle(
    IPC.restoreStage,
    async (e, payload?: { fromUpload?: boolean }): Promise<Result<RestoreCheck>> => {
      try {
        if (!isOwner()) return refuse()

        if (payload?.fromUpload) {
          const uploaded = uploadedRestorePath()
          if (!existsSync(uploaded)) {
            return { ok: false, error: 'The upload did not arrive. Try again.' }
          }
          return { ok: true, data: stageRestoreFromFile(uploaded, uploadedRestoreName()) }
        }

        const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow()
        const opts: OpenDialogOptions = {
          title: 'Choose the backup to restore',
          properties: ['openFile'],
          filters: [
            { name: 'RM Operations backup', extensions: ['db'] },
            { name: 'All files', extensions: ['*'] }
          ]
        }
        const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'No file chosen.' }
        return { ok: true, data: stageRestoreFromPath(picked.filePaths[0]) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /**
   * Everything the panel needs in one read, including the result of the last
   * swap.
   *
   * That last part is not a nicety. Confirming a restore ends the process, so
   * the screen that asked for it is gone before it can report anything. Without
   * a result left on disk and read back here, the owner presses Restore, the app
   * vanishes, it returns — and nothing anywhere says whether it worked.
   */
  ipcMain.handle(IPC.restoreStatus, (): RestoreStatus | null => {
    if (!isOwner()) return null
    return {
      staged: stagedRestore(),
      armed: restoreIsArmed(),
      lastOutcome: takeRestoreOutcome(),
      keptCopies: replacedDatabases().map((c) => ({
        name: c.path.split(/[\\/]/).pop() ?? c.path,
        bytes: c.bytes,
        at: c.at
      }))
    }
  })

  /**
   * Arm the swap and end the process.
   *
   * ## Everything is re-checked here
   *
   * The stage id must still match, and the file is inspected AGAIN rather than
   * trusting the verdict the panel is showing. A screen left open while somebody
   * uploaded a different file from another tab would otherwise confirm a
   * decision that was made about a file that is no longer there.
   *
   * ## The typed word
   *
   * Checked on this side, not merely in the input box. A confirmation only
   * enforced by the screen is a confirmation anything reaching the channel skips.
   *
   * ## Why it exits rather than doing the work
   *
   * The database cannot be replaced under a process that has it open — see
   * restoreOnBoot.ts. Exiting is the restart: the desktop relaunches itself, and
   * on Render an exited web service is started again by the platform, which is
   * what makes this self-service instead of a support call.
   */
  ipcMain.handle(
    IPC.restoreConfirm,
    (_e, input?: { stageId?: string; typed?: string }): Result<{ filename: string }> => {
      try {
        if (!isOwner()) return refuse()
        const actor = currentUser()

        if (!restoreConfirmed(String(input?.typed ?? ''))) {
          return { ok: false, error: `Type ${RESTORE_CONFIRM_WORD} to confirm.` }
        }

        const check = stagedRestore()
        if (!check) return { ok: false, error: 'There is no backup waiting to be restored.' }
        if (!check.ok) {
          return { ok: false, error: check.blockers[0]?.message ?? 'That backup cannot be restored.' }
        }
        if (!input?.stageId || input.stageId !== check.stageId) {
          return {
            ok: false,
            error: 'That backup was replaced by a different upload. Check it again before restoring.'
          }
        }

        armRestore({
          stageId: check.stageId as string,
          filename: check.file.filename,
          requestedBy: actor ? `${actor.firstName} ${actor.lastName}` : 'the owner',
          requestedAt: new Date().toISOString()
        })

        /**
         * After the reply is on the wire, never before. Exiting inside the
         * handler kills the response, and the owner is left staring at a dead
         * tab with no idea whether anything was armed.
         */
        setTimeout(() => {
          try {
            // Throws on the server — the stub says so plainly, and quitting is
            // exactly right there: Render restarts an exited web service.
            app.relaunch()
          } catch {
            /* server: the platform brings it back */
          }
          app.quit()
        }, 600)

        return { ok: true, data: { filename: check.file.filename } }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  /** Throw the upload away, and stand down if it was already armed. */
  ipcMain.handle(IPC.restoreCancel, (): Result<true> => {
    if (!isOwner()) return refuse()
    disarmRestore()
    clearStagedRestore()
    return { ok: true, data: true }
  })
}
