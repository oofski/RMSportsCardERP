import { BrowserWindow, dialog } from 'electron'
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { ExportResult } from '@shared/types'
import type { BackupPreview } from '@shared/backup'
import { backupFilename } from '@shared/backup'
import { currentUser } from './services/auth'
import { backupPreview, writeBackupTo } from './db/backup'

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
