import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import type { RestoreOutcome } from '@shared/restore'
import { databasePath } from '../db/database'

/**
 * THE SWAP. It happens at startup, before anything opens the database.
 *
 * ## Why it cannot happen when the button is pressed
 *
 * A process holding an open SQLite handle keeps serving from it after the file
 * underneath is replaced — the handle points at an inode, not a name — so the
 * app would carry on showing the OLD data, writing it back over the new file's
 * pages, until something forced it to reopen. `docs/WEB.md` already prescribes
 * stopping the writer first for exactly this reason. Nothing in this app
 * quiesces in-flight work and building something that could would be a large
 * and separate piece of engineering.
 *
 * So pressing the button writes a MARKER and ends the process. The next boot
 * finds the marker before `getDb()` is reached, does the swap against a file
 * nobody has opened, and clears the marker. This is the same shape as
 * `ownerRecovery.ts`, which resets a lost Owner password by finding a file next
 * to the database at startup, and for the same reason: startup is the only
 * moment the app can safely touch its own foundations.
 *
 * ## Ending the process is a restart, on both transports
 *
 * On the desktop, `app.relaunch()` then `app.exit()`. On Render the server is a
 * web service behind a health check: a process that exits is restarted
 * automatically, which turns "restart the service" from something the owner has
 * to go and find in a dashboard into something that just happens.
 *
 * ## The displaced database is KEPT
 *
 * Renamed, never deleted. A restore is somebody acting on incomplete
 * information at a stressful moment, and the failure mode of getting it wrong —
 * discovering the backup was older than they thought — must not be terminal.
 * The old file sits beside the new one as `rm-operations-replaced-<stamp>.db`
 * and can be restored right back through the same screen.
 */

const MARKER = 'restore-pending.json'

export interface RestoreMarker {
  stageId: string
  filename: string
  /** Who asked, so the log after the restart can say. */
  requestedBy: string
  requestedAt: string
}


function markerPath(): string {
  return join(dirname(databasePath()), MARKER)
}

function stagedPath(): string {
  return join(dirname(databasePath()), 'restore-staged.db')
}

function stageStatePath(): string {
  return join(dirname(databasePath()), 'restore-staged.json')
}

/** Where the result of the last swap is left for the app to report afterwards. */
function outcomePath(): string {
  return join(dirname(databasePath()), 'restore-result.json')
}

function discard(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best effort */
  }
}

/**
 * Arm the swap. Called by the handler once the owner has confirmed.
 *
 * Writes only the marker — the staged file is already on disk and already
 * validated. Nothing is moved here, so an app that crashes between this call
 * and the restart simply performs the restore on its next start, which is the
 * behaviour somebody who pressed Restore would expect anyway.
 */
export function armRestore(marker: RestoreMarker): void {
  writeFileSync(markerPath(), JSON.stringify(marker), 'utf8')
}

export function restoreIsArmed(): boolean {
  return existsSync(markerPath())
}

/** Stand down — used when the owner cancels before the restart. */
export function disarmRestore(): void {
  discard(markerPath())
}

/** `rm-operations-replaced-2026-08-31T014500.db` — sorts, and says what it is. */
function replacedName(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '').slice(0, 15)
  return `rm-operations-replaced-${stamp}.db`
}

/**
 * Do the swap, if one is armed. Returns what happened, or null for the ordinary
 * boot where nothing is pending.
 *
 * MUST be called before `getDb()`. Calling it afterwards is not an error that
 * announces itself — it works, and then the process keeps serving the database
 * it opened a moment earlier, which is the one that was just moved aside.
 */
export function applyPendingRestore(): RestoreOutcome | null {
  const marker = markerPath()
  if (!existsSync(marker)) return null

  const at = new Date().toISOString()
  let intent: RestoreMarker | null = null
  try {
    intent = JSON.parse(readFileSync(marker, 'utf8')) as RestoreMarker
  } catch {
    intent = null
  }
  const filename = intent?.filename ?? 'a backup'

  const live = databasePath()
  const staged = stagedPath()

  const finish = (outcome: RestoreOutcome): RestoreOutcome => {
    // The marker goes FIRST and unconditionally. A marker that survived a
    // failure would retry the same swap on every subsequent boot, which turns
    // one bad file into an app that will not start.
    discard(marker)
    discard(stageStatePath())
    try {
      writeFileSync(outcomePath(), JSON.stringify(outcome), 'utf8')
    } catch {
      /* the result is a courtesy; the swap is what matters */
    }
    return outcome
  }

  if (!existsSync(staged)) {
    return finish({
      ok: false,
      filename,
      at,
      error: 'The uploaded backup was gone by the time the app restarted.'
    })
  }

  try {
    const now = new Date()
    const replaced = join(dirname(live), replacedName(now))

    /**
     * Move the current database aside rather than deleting it, and take the WAL
     * and the shared-memory file with it.
     *
     * Leaving a stale `-wal` beside the NEW file is the subtle disaster here:
     * SQLite would find a write-ahead log belonging to a different database and
     * replay it, which is how a restore turns into corruption. They are deleted
     * rather than moved because a WAL without its database is not useful to
     * anybody, and the copy being preserved was checkpointed by the very act of
     * the old process shutting down.
     */
    if (existsSync(live)) renameSync(live, replaced)
    discard(`${live}-wal`)
    discard(`${live}-shm`)

    renameSync(staged, live)

    return finish({
      ok: true,
      filename,
      at,
      replacedPath: existsSync(replaced) ? replaced : undefined
    })
  } catch (err) {
    return finish({
      ok: false,
      filename,
      at,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

/** Read and clear the result of the last swap, for the panel to show once. */
export function takeRestoreOutcome(): RestoreOutcome | null {
  const path = outcomePath()
  if (!existsSync(path)) return null
  try {
    const outcome = JSON.parse(readFileSync(path, 'utf8')) as RestoreOutcome
    discard(path)
    return outcome
  } catch {
    discard(path)
    return null
  }
}

/**
 * How large the kept copies have grown, so the panel can offer to tidy up.
 *
 * A displaced database is a full copy, and somebody restoring repeatedly while
 * hunting for the right backup can fill a 10 GB Render disk with them without
 * ever seeing a number.
 */
export function replacedDatabases(): Array<{ path: string; bytes: number; at: string }> {
  const dir = dirname(databasePath())
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith('rm-operations-replaced-') && n.endsWith('.db'))
      .map((n) => {
        const p = join(dir, n)
        const s = statSync(p)
        return { path: p, bytes: s.size, at: s.mtime.toISOString() }
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  } catch {
    return []
  }
}
