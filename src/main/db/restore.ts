import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import type { BackupCounts } from '@shared/backup'
import { CURRENT_SCHEMA_VERSION } from '@shared/backup'
import type { RestoreCheck, RestoreFileFacts, RestoreProblem } from '@shared/restore'
import { schemaIsRestorable } from '@shared/restore'
import { databasePath, getDb } from './database'
import { backupCounts } from './backup'

/**
 * Receiving a database file and deciding whether it may replace the live one.
 *
 * NOTHING IN THIS FILE TOUCHES THE LIVE DATABASE. Everything here writes to,
 * reads from and deletes a staging file that sits beside it, and the very worst
 * outcome of a bad upload is a rejected upload. The swap itself is a separate
 * module that runs at boot — see `restoreOnBoot.ts` — and it will not run at
 * all unless this file has already said yes.
 *
 * That split is not tidiness. Validating and swapping in one function means the
 * only way to test the refusals is to survive them, and the first refusal that
 * turns out to be checked one line too late costs somebody their business data.
 */

/** The upload, waiting to be judged. Beside the database, never in the temp dir. */
export function stagedDatabasePath(): string {
  return join(dirname(databasePath()), 'restore-staged.db')
}

/**
 * What the staged file claims to be, written when it lands.
 *
 * On the desktop this could be a module variable — stage and confirm happen
 * seconds apart in one process. On the web they do not: the upload is one
 * request, the confirmation is another, and a page refresh in between is
 * ordinary behaviour for somebody nervous enough to be restoring a backup. A
 * file on disk survives that; a variable does not.
 */
function stageStatePath(): string {
  return join(dirname(databasePath()), 'restore-staged.json')
}

interface StageState {
  stageId: string
  filename: string
  bytes: number
  stagedAt: string
}

function readStageState(): StageState | null {
  try {
    const raw = readFileSync(stageStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as StageState
    return typeof parsed?.stageId === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** Best-effort cleanup. A failed unlink must never mask the real error. */
function discard(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* nothing useful to do here */
  }
}

/** Throw away the staged upload and everything that described it. */
export function clearStagedRestore(): void {
  discard(stagedDatabasePath())
  discard(stageStatePath())
}

/**
 * The first sixteen bytes of every SQLite file ever written.
 *
 * Checked before better-sqlite3 is allowed near the file, purely so the refusal
 * can say something true. Handing a PDF to the driver produces
 * "file is not a database" from somewhere deep in a query, several steps after
 * the point where the answer was already knowable.
 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')

function looksLikeSqlite(path: string): boolean {
  try {
    if (statSync(path).size < 512) return false
    const head = Buffer.alloc(16)
    // Read just the header rather than the file: a restore candidate is a whole
    // database, and reading it into memory to check 16 bytes is how a 200 MB
    // upload becomes an out-of-memory crash on a 512 MB Render instance.
    const fd = openSync(path, 'r')
    try {
      readSync(fd, head, 0, 16, 0)
    } finally {
      closeSync(fd)
    }
    return head.equals(SQLITE_MAGIC)
  } catch {
    return false
  }
}

function countIn(db: Database.Database, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined
    return Number(row?.n) || 0
  } catch {
    return 0
  }
}

/**
 * The newest `updated_at` anywhere that matters — when this backup was taken.
 *
 * Read from the CONTENT, never from the file's timestamp. A backup that has
 * been through a cloud drive, a USB stick and an email carries whatever mtime
 * the last copy gave it, which is routinely today. "Taken today" printed over a
 * file from March is exactly the reassurance nobody must be given at this
 * screen.
 */
function newestUpdate(db: Database.Database): string | null {
  const tables = ['invoices', 'purchase_orders', 'inventory_products', 'employees', 'time_entries']
  let best: string | null = null
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT MAX(updated_at) AS m FROM ${t}`).get() as
        | { m: string | null }
        | undefined
      const m = row?.m
      if (typeof m === 'string' && m && (best === null || m > best)) best = m
    } catch {
      // A table this file does not have. An older backup is allowed to be older
      // than some of these names.
    }
  }
  return best
}

function schemaVersionOf(db: Database.Database): number | null {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    const n = Number(row?.value)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Is this an RM Operations database, or just some SQLite file?
 *
 * A perfectly valid database belonging to another program passes the header
 * check and the integrity check and would then be restored into place, leaving
 * the app facing a file with none of its tables — which reads to the operator
 * as "the app deleted everything". Two tables the app has had since its first
 * version are enough to tell them apart.
 */
function looksLikeRmops(db: Database.Database): boolean {
  try {
    const names = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string
        }>
      ).map((r) => r.name)
    )
    return names.has('meta') && names.has('employees')
  } catch {
    return false
  }
}

function countsIn(db: Database.Database): BackupCounts {
  return {
    products: countIn(db, 'inventory_products'),
    purchaseOrders: countIn(db, 'purchase_orders'),
    salesOrders: countIn(db, 'invoices'),
    timeEntries: countIn(db, 'time_entries'),
    ledgerRows: countIn(db, 'ledger_rows')
  }
}

/**
 * Read the staged file and decide.
 *
 * Every problem is collected rather than thrown on the first one, because a
 * screen that reveals objections one at a time makes somebody upload the same
 * wrong file four times.
 */
function inspect(state: StageState): RestoreCheck {
  const path = stagedDatabasePath()
  const current = backupCounts()
  const blockers: RestoreProblem[] = []
  const warnings: RestoreProblem[] = []

  const facts: RestoreFileFacts = {
    filename: state.filename,
    bytes: state.bytes,
    schemaVersion: null,
    counts: { products: 0, purchaseOrders: 0, salesOrders: 0, timeEntries: 0, ledgerRows: 0 },
    takenAt: null
  }

  if (!existsSync(path)) {
    blockers.push({ code: 'not-a-database', message: 'The upload did not finish. Try again.' })
    return { ok: false, file: facts, current, blockers, warnings, stageId: null }
  }

  if (!looksLikeSqlite(path)) {
    blockers.push({
      code: 'not-a-database',
      message: 'That file is not a database. A backup is the .db file this app gives you.'
    })
    return { ok: false, file: facts, current, blockers, warnings, stageId: null }
  }

  let db: Database.Database | null = null
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })

    /**
     * The integrity check reads every page. It is the difference between a file
     * that opens and a file that is whole — a truncated download opens fine,
     * answers the first few queries, and falls apart weeks later on a page
     * nobody has visited since.
     */
    const integrity = db.pragma('integrity_check', { simple: true })
    if (String(integrity) !== 'ok') {
      blockers.push({
        code: 'corrupt',
        message: 'That backup is damaged — it was probably cut short while copying. Try another.'
      })
    }

    if (!looksLikeRmops(db)) {
      blockers.push({
        code: 'not-rmops',
        message: 'That is a database, but not one from this app.'
      })
    }

    facts.schemaVersion = schemaVersionOf(db)
    facts.counts = countsIn(db)
    facts.takenAt = newestUpdate(db)

    /**
     * THE ONE REFUSAL THAT PROTECTS OTHER PEOPLE.
     *
     * A file from a newer build cannot be loaded into this one. `migrate()`
     * would run against it, stamp `schema_version` downward, and then push rows
     * missing whatever columns the newer build added — at the relay, at every
     * other machine. It is a blocker rather than a warning precisely because
     * the person clicking cannot see the damage and does not receive it.
     */
    if (facts.schemaVersion !== null && !schemaIsRestorable(facts.schemaVersion)) {
      blockers.push({
        code: 'schema-too-new',
        message:
          `That backup came from a newer version of the app (v${facts.schemaVersion} vs ` +
          `v${CURRENT_SCHEMA_VERSION}). Update this app first, then restore it.`
      })
    }

    const total =
      facts.counts.products +
      facts.counts.purchaseOrders +
      facts.counts.salesOrders +
      facts.counts.timeEntries +
      facts.counts.ledgerRows
    if (total === 0 && blockers.length === 0) {
      blockers.push({
        code: 'empty',
        message: 'That backup is empty. Restoring it would leave you with nothing.'
      })
    }

    // A file with no staff cannot be signed into. It is not corrupt and it is
    // not refused — an owner may genuinely be recovering a very early copy —
    // but nobody should meet that surprise after the restart.
    if (countIn(db, 'employees') === 0 && blockers.length === 0) {
      warnings.push({
        code: 'no-employees',
        message: 'This backup has no staff accounts in it, so nobody will be able to sign in.'
      })
    }

    if (
      facts.schemaVersion !== null &&
      facts.schemaVersion < CURRENT_SCHEMA_VERSION &&
      blockers.length === 0
    ) {
      warnings.push({
        code: 'older-schema',
        message: `Taken on an older version (v${facts.schemaVersion}). It will be brought up to date automatically.`
      })
    }
  } catch (err) {
    blockers.push({
      code: 'not-a-database',
      message: `That file could not be opened as a backup. ${
        err instanceof Error ? err.message : String(err)
      }`
    })
  } finally {
    try {
      db?.close()
    } catch {
      /* closing a file we only read */
    }
  }

  const ok = blockers.length === 0
  return { ok, file: facts, current, blockers, warnings, stageId: ok ? state.stageId : null }
}

function writeStageState(filename: string, bytes: number): StageState {
  const state: StageState = {
    stageId: randomUUID(),
    filename,
    bytes,
    stagedAt: new Date().toISOString()
  }
  writeFileSync(stageStatePath(), JSON.stringify(state), 'utf8')
  return state
}

/**
 * Take a file from a path on this machine — the desktop's open dialog.
 *
 * Copied rather than read into memory and written back out: a database is
 * exactly the kind of file that is bigger than anybody expects, and the app
 * gains nothing from holding all of it at once.
 */
export function stageRestoreFromPath(srcPath: string, filename?: string): RestoreCheck {
  clearStagedRestore()
  const dir = dirname(databasePath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  copyFileSync(srcPath, stagedDatabasePath())
  const bytes = statSync(stagedDatabasePath()).size
  return inspect(writeStageState(filename ?? srcPath.split(/[\\/]/).pop() ?? 'backup.db', bytes))
}

/**
 * Adopt a file the server has already streamed to a temp path.
 *
 * The web upload does not buffer either — see the `/api/restore` route, which
 * pipes the request body straight to disk. This moves that file into the
 * staging slot, falling back to a copy when the temp dir is on another volume.
 */
export function stageRestoreFromFile(tmpPath: string, filename: string): RestoreCheck {
  clearStagedRestore()
  const dest = stagedDatabasePath()
  try {
    renameSync(tmpPath, dest)
  } catch {
    copyFileSync(tmpPath, dest)
    discard(tmpPath)
  }
  return inspect(writeStageState(filename, statSync(dest).size))
}

/** Re-read whatever is staged — the answer after a page refresh. */
export function stagedRestore(): RestoreCheck | null {
  const state = readStageState()
  if (!state || !existsSync(stagedDatabasePath())) return null
  return inspect(state)
}

/** The database in front of the operator right now, for the comparison. */
export function liveCounts(): BackupCounts {
  return backupCounts()
}

/** Only used to prove the live database is still open and answering. */
export function liveSchemaVersion(): number {
  try {
    const row = getDb().prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined
    const n = Number(row?.value)
    return Number.isFinite(n) ? n : CURRENT_SCHEMA_VERSION
  } catch {
    return CURRENT_SCHEMA_VERSION
  }
}
