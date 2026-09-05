import { existsSync, renameSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { BackupCounts, BackupPreview } from '@shared/backup'
import { CURRENT_SCHEMA_VERSION } from '@shared/backup'
import { getDb } from './database'
import { nowIso } from '../util'

/**
 * Taking a copy of a database that people are still using.
 *
 * ## VACUUM INTO, and never a file copy
 *
 * This is the whole correctness story and it is worth stating plainly, because
 * the wrong version works perfectly until the day it matters.
 *
 * The database runs in WAL mode. Recent writes live in `rm-operations.db-wal`
 * and have not been folded into the main file yet, so `rm-operations.db` on
 * its own is NOT the database — it is the database as of the last checkpoint.
 * Copying that file with `cp` produces something that opens, reports plausible
 * numbers, and is quietly missing whatever happened since. `docs/WEB.md` warns
 * about it in those terms; a test in `tests/backup.test.ts` fails on it.
 *
 * `VACUUM INTO` asks SQLite to write a complete, consistent database to a new
 * path, reading through the WAL, holding a read transaction while it goes. It
 * is safe against a live database with other readers and writers, it compacts
 * as it copies, and it is the same statement the manual procedure in
 * `docs/RENDER.md` has always used.
 */

/**
 * `VACUUM INTO` refuses a destination that already exists, and the save dialog
 * hands back paths the operator has chosen to overwrite. So the copy is always
 * written to a name nothing can be holding, then moved onto the target.
 *
 * The temp file is made in the DESTINATION's directory, not the system temp
 * dir: a rename within one filesystem is atomic and instant, and across two it
 * is a copy that can half-finish. The download spool and the operator's Desktop
 * are frequently not the same volume.
 */
function stagingPathFor(destPath: string): string {
  return join(dirname(destPath), `.rmops-backup-${randomUUID()}.tmp`)
}

/** Best-effort cleanup. A failed unlink must not mask the error that caused it. */
function discard(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* nothing useful to do, and the caller has a real error to report */
  }
}

function countOf(table: string): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n: number }
      | undefined
    return Number(row?.n) || 0
  } catch {
    // A table that does not exist on this build is a zero, not a crash. The
    // panel's job is to say roughly what is in there, and it must not fail to
    // render because one name moved.
    return 0
  }
}

export function backupCounts(): BackupCounts {
  return {
    products: countOf('inventory_products'),
    purchaseOrders: countOf('purchase_orders'),
    salesOrders: countOf('invoices'),
    timeEntries: countOf('time_entries'),
    ledgerRows: countOf('ledger_rows')
  }
}

/**
 * What is in the database right now, and roughly how big the file will be.
 *
 * The size comes from SQLite's own page count rather than `statSync` on the
 * file: the file on disk excludes the WAL, so it under-reports exactly when
 * there has been a lot of recent activity — the moment somebody is most likely
 * to be taking a backup.
 */
export function backupPreview(): BackupPreview {
  const db = getDb()
  const pageCount = Number(db.pragma('page_count', { simple: true })) || 0
  const pageSize = Number(db.pragma('page_size', { simple: true })) || 0
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    takenAt: nowIso(),
    estimatedBytes: pageCount * pageSize,
    counts: backupCounts()
  }
}

/**
 * Write a complete copy of the database to `destPath`. Returns its size.
 *
 * Throws rather than returning a Result: the caller is an IPC handler that
 * already wraps everything in a try/catch, and a backup that half-worked has
 * nothing useful to report except what went wrong.
 */
export function writeBackupTo(destPath: string): number {
  const staging = stagingPathFor(destPath)
  try {
    // The path is interpolated because SQLite takes no parameter here. It is
    // ours, not the caller's — a UUID under a directory we derived — so there
    // is nothing user-supplied in the statement. The quote-doubling is for
    // paths containing an apostrophe, which is an ordinary thing for a folder
    // named after a person to have.
    getDb().exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`)
    renameSync(staging, destPath)
    return statSync(destPath).size
  } catch (err) {
    discard(staging)
    throw err
  }
}
