/**
 * Taking a copy of the database.
 *
 * The owner asked for "backups in case something gets lost — something that
 * could just be re-uploaded". Everything this business runs on is one SQLite
 * file, and until this feature there was no way to get a copy of it out of the
 * app.
 *
 * ## The one that matters: A DASH OF WAL, AND A PLAIN COPY LOSES YOUR WEEK
 *
 * The database runs in WAL mode, so recent writes live in the `-wal` sidecar
 * and have not been folded into `rm-operations.db` yet. That file on its own is
 * the database AS OF THE LAST CHECKPOINT. Copy it with `cp` and you get
 * something that opens cleanly, reports plausible numbers, and is silently
 * missing everything since — the worst possible failure for a backup, because
 * it is only discovered on the day it is needed.
 *
 * Section 2 is that test. Every other assertion here passes against a naive
 * `copyFileSync`; only that one fails, which is exactly why it is written down.
 *
 * ## And the permission is checked at the CHANNEL, not in the panel
 *
 * The tile is a courtesy. Section 5 goes through the registered IPC handler,
 * because that is where an earlier defect in this codebase hid: a working
 * repository behind a handler that dropped a field, with every test passing for
 * two versions because every test called the repository directly.
 *
 * ## Run under the SERVER stub, deliberately
 *
 * `RMOPS_ELECTRON=server` swaps in `src/server/electron-stub.ts`, so
 * `showSaveDialog` here is the real one the web app uses — it reserves a spool
 * path that becomes a download token. That is the transport the owner actually
 * uses day to day, and it is the half a desktop-only test would never touch.
 *
 * Every name here is invented.
 *
 * Run: npm run test:backup
 */
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/backup-db')
process.env.TEST_DB_DIR = DIR
/**
 * BOTH variables, because this suite runs under the SERVER stub.
 * `src/server/electron-stub.ts` resolves `app.getPath('userData')` from
 * RMOPS_DATA_DIR and ignores TEST_DB_DIR entirely — so setting only the latter
 * points the whole test at the repo's own ./data folder and quietly writes test
 * rows into the developer's database. webServer.test.ts sets both for exactly
 * this reason.
 */
process.env.RMOPS_DATA_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const Database = require('better-sqlite3')
const { getDb } = require('../src/main/db/database')
const { backupPreview, backupCounts, writeBackupTo } = require('../src/main/db/backup')
const {
  CURRENT_SCHEMA_VERSION,
  backupFilename,
  describeBackup,
  formatBackupSize
} = require('../src/shared/backup')
const db = getDb()

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

const OUT = join(DIR, 'out')
mkdirSync(OUT, { recursive: true })
let seq = 0
const dest = (): string => join(OUT, `backup-${++seq}.db`)

const product = (id: string, sku: string, name: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, sku, name)
}

/**
 * Row count in a backup file. A table the copy does not have counts as -1
 * rather than throwing: a broken backup is missing tables as well as rows, and
 * a stack trace half way through section 1 would hide the assertion in section
 * 2 that explains WHY it is broken. -1 can never equal a real count, so nothing
 * passes by accident.
 */
const countIn = (file: string, table: string): number => {
  const copy = new Database(file, { readonly: true })
  try {
    return (copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  } catch {
    return -1
  } finally {
    copy.close()
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. the copy is complete, and it opens ===')
// ---------------------------------------------------------------------------
product('bk_a', 'BK-A', '2026 Topps Chrome Hobby Box')
product('bk_b', 'BK-B', '2026 Bowman Draft Jumbo Case')

const first = dest()
const size = writeBackupTo(first)
ok(existsSync(first), 'a file lands where it was asked for')
ok(size > 0, 'and it is not empty', String(size))

const copy = new Database(first, { readonly: true })
ok(
  copy.prepare('PRAGMA integrity_check').get().integrity_check === 'ok',
  'SQLITE SAYS THE COPY IS INTACT — not merely that a file exists'
)
copy.close()

const liveProducts = (db.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n
ok(
  countIn(first, 'inventory_products') === liveProducts,
  'every product is in it — counted against the live table rather than a literal, ' +
    'because migrate() seeds a catalog and a hard-coded number would only ever ' +
    'be right on the day it was written',
  `${countIn(first, 'inventory_products')} of ${liveProducts}`
)
ok(liveProducts >= 2, 'including the two just added', String(liveProducts))

/**
 * Every synced table, not a hand-picked few. A backup that quietly carried
 * three tables out of seventy-three would pass a spot check and lose the
 * business.
 */
const { SYNCED_TABLES } = require('../src/main/db/syncTables')
let mismatched = 0
for (const spec of SYNCED_TABLES) {
  const here = (db.prepare(`SELECT COUNT(*) AS n FROM ${spec.table}`).get() as { n: number }).n
  const there = countIn(first, spec.table)
  if (here !== there) {
    mismatched += 1
    console.log(`    ${spec.table}: live ${here}, copy ${there}`)
  }
}
ok(mismatched === 0, `all ${SYNCED_TABLES.length} synced tables carry the same row count`)

// ---------------------------------------------------------------------------
console.log('\n=== 2. WAL: the writes that have not been checkpointed yet ===')
// ---------------------------------------------------------------------------
/**
 * THE TEST THIS FILE EXISTS FOR.
 *
 * `journal_mode = WAL` is set at open. After a checkpoint the main file is
 * current; between checkpoints it is not, and the difference is every write
 * since. A `copyFileSync` backup passes section 1 and fails here, which is the
 * whole point — it is the one failure that looks like success until the day
 * somebody needs the file.
 */
ok(String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal', 'the database is in WAL mode')

// Fold everything so far into the main file, then write MORE and do not fold.
db.pragma('wal_checkpoint(TRUNCATE)')
for (let i = 0; i < 25; i++) product(`bk_wal_${i}`, `BK-WAL-${i}`, `Uncheckpointed box ${i}`)

const liveAfterWal = (db.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n
const second = dest()
writeBackupTo(second)
ok(
  countIn(second, 'inventory_products') === liveAfterWal,
  'THE BACKUP HAS THE UNCHECKPOINTED ROWS. A plain file copy would be short by ' +
    '25 here and identical everywhere else — this is the assertion that tells ' +
    'VACUUM INTO from cp',
  `${countIn(second, 'inventory_products')} of ${liveAfterWal}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. it is a snapshot, not a window onto the live database ===')
// ---------------------------------------------------------------------------
const atSnapshot = countIn(second, 'inventory_products')
product('bk_after', 'BK-AFTER', 'Bought after the backup was taken')
ok(
  countIn(second, 'inventory_products') === atSnapshot,
  'a row added afterwards does NOT appear in a backup already taken — which is ' +
    'the entire property that makes a backup different from sync',
  String(countIn(second, 'inventory_products'))
)
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n ===
    atSnapshot + 1,
  'while the live database has it'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. the preview describes what the file will hold ===')
// ---------------------------------------------------------------------------
const preview = backupPreview()
const counts = backupCounts()
ok(
  preview.counts.products ===
    (db.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n,
  'the product count is the real one',
  String(preview.counts.products)
)
ok(preview.estimatedBytes > 0, 'the size estimate is a real figure', String(preview.estimatedBytes))
ok(
  preview.schemaVersion === CURRENT_SCHEMA_VERSION,
  'and it stamps the schema this build writes',
  String(preview.schemaVersion)
)

/**
 * THE CONSTANT MUST NOT FALL BEHIND THE MIGRATIONS.
 *
 * `CURRENT_SCHEMA_VERSION` is a hand-kept copy of the last `setMeta(…,
 * 'schema_version', …)` in a four-thousand-line function. Nothing else compares
 * them, so without this the constant would drift the first time somebody added
 * a migration — and restore is going to rely on it to refuse a file from a
 * newer build.
 */
const stamped = Number(
  (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
    ?.value
)
ok(
  stamped === CURRENT_SCHEMA_VERSION,
  'AND IT AGREES WITH WHAT MIGRATE() ACTUALLY STAMPED — a constant that silently ' +
    'falls behind the thing it names is worse than no constant',
  `constant ${CURRENT_SCHEMA_VERSION}, database ${stamped}`
)

// The sentence, before and after, is one function.
ok(describeBackup(counts).includes('product'), 'the description names products', describeBackup(counts))
ok(
  describeBackup({ products: 1, purchaseOrders: 0, salesOrders: 0, timeEntries: 0, ledgerRows: 0 }) ===
    '1 product',
  'one product is singular, and the empty categories are left out entirely'
)
ok(
  describeBackup({ products: 0, purchaseOrders: 0, salesOrders: 0, timeEntries: 0, ledgerRows: 0 }) ===
    'an empty database',
  'and nothing at all says so in words rather than listing five zeroes'
)
ok(backupFilename('2026-08-31T12:00:00.000Z') === 'rmops-backup-2026-08-31.db', 'the filename carries the day')
ok(formatBackupSize(2_500_000) === '2.4 MB' && formatBackupSize(4096) === '4 KB', 'sizes read as sizes')

// ---------------------------------------------------------------------------
console.log('\n=== 5. owner only, at the CHANNEL ===')
// ---------------------------------------------------------------------------
const registry = require('../src/main/ipcRegistry')
const { runAs } = require('../src/main/services/session')
const { insertEmployee } = require('../src/main/db/employees')

const channels = new Map<string, any>()
registry.setRegistrationSink((channel: string, handler: any) => channels.set(channel, handler))
require('../src/main/backupIpc').registerBackupIpc()

const mkEmployee = (first: string, last: string, companyId: string, role: string): string =>
  insertEmployee(
    { firstName: first, lastName: last, companyId, title: role, email: `${companyId}@example.invalid`, role },
    null,
    null,
    false
  ).employee.id

const OWNER = mkEmployee('Marla', 'Quint', 'RM-BK-OWNER', 'owner')
const OPERATIONS = mkEmployee('Dara', 'Vance', 'RM-BK-OPS', 'operations')

const via = (who: string, channel: string, payload?: any): any =>
  runAs({ userId: who, origin: 'test' }, () => channels.get(channel)({ sender: null }, payload))

ok(via(OWNER, 'backup:preview') !== null, 'the owner can read the preview')
ok(
  via(OPERATIONS, 'backup:preview') === null,
  'AN OPERATIONS ADMIN CANNOT — the file carries the QuickBooks token and the ' +
    'payment details, so this is not an ordinary export',
  JSON.stringify(via(OPERATIONS, 'backup:preview'))
)
ok(via(null as any, 'backup:preview') === null, 'and neither can somebody not signed in')

/**
 * The write refuses too, and refuses BEFORE writing anything. A permission
 * checked after the copy exists would leave a full database in the server's
 * spool directory for anybody who asked.
 */
ok(
  channels.get('backup:download') !== undefined,
  'the download channel is registered, so the server serves it too'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. a failed write leaves nothing behind ===')
// ---------------------------------------------------------------------------
let threw = false
try {
  writeBackupTo(join(DIR, 'no', 'such', 'folder', 'backup.db'))
} catch {
  threw = true
}
ok(threw, 'writing somewhere impossible throws rather than reporting success')
const strays = readdirSync(OUT).filter((f) => f.startsWith('.rmops-backup-'))
ok(strays.length === 0, 'AND NO STAGING FILE IS LEFT LYING ABOUT', strays.join(', '))

// The async half, resolved last so the summary is honest.
const { collectClientActions } = require('../src/server/clientActions')
const { takeSpooledDownloads } = require('../src/server/electron-stub')
;(async () => {
  /**
   * THE REFUSAL, INSIDE A REQUEST SCOPE.
   *
   * This has to be wrapped exactly as the owner's call below is. Outside a
   * scope the save dialog refuses on its own — "there is nobody to hand the
   * file to" — so an unwrapped attempt fails whether or not the permission is
   * checked, and would go on passing after somebody deleted the check. Inside
   * one, the only thing standing between an operations admin and a copy of the
   * QuickBooks token is the line being tested.
   */
  const { value: res, actions: refusedActions } = await collectClientActions(async () =>
    runAs({ userId: OPERATIONS, origin: 'test' }, () =>
      channels.get('backup:download')({ sender: null })
    )
  )
  ok(res?.ok === false, 'operations is refused the download', JSON.stringify(res))
  ok(
    String(res?.error ?? '').toLowerCase().includes('owner'),
    'and told why, in words',
    String(res?.error)
  )
  ok(
    refusedActions.downloads.length === 0 && takeSpooledDownloads().length === 0,
    'AND NOTHING WAS WRITTEN. The permission is checked before the copy exists, so ' +
      'a refusal leaves no database in the spool directory for the next person to ask',
    String(refusedActions.downloads.length)
  )
  /**
   * THE OWNER'S DOWNLOAD, THROUGH THE WEB TRANSPORT'S REAL MACHINERY.
   *
   * `showSaveDialog` on the server spools to a temp path and refuses outright
   * outside a request scope — "there is nobody to hand the file to" — so the
   * call is wrapped in `collectClientActions` exactly as `handleCall` wraps
   * every handler. Without that this asserts nothing about the web app; with
   * it, the file below is the one a browser would have been handed.
   */
  const { value: okRes } = await collectClientActions(async () =>
    runAs({ userId: OWNER, origin: 'test' }, () =>
      channels.get('backup:download')({ sender: null })
    )
  )
  ok(okRes?.ok === true, 'the owner is not refused', JSON.stringify(okRes))

  const handed = takeSpooledDownloads()
  ok(handed.length === 1, 'exactly one file is handed to the browser', String(handed.length))
  ok(
    /^rmops-backup-\d{4}-\d{2}-\d{2}\.db$/.test(handed[0]?.filename ?? ''),
    'named for the day it was taken',
    handed[0]?.filename
  )
  ok((handed[0]?.bytes?.length ?? 0) > 0, 'with bytes in it', String(handed[0]?.bytes?.length))
  ok(
    Buffer.from(handed[0].bytes.subarray(0, 15)).toString('utf8') === 'SQLite format 3',
    'AND THE BYTES ARE A REAL DATABASE — the header the browser receives, not an ' +
      'empty file or a spool path that was never written',
    Buffer.from(handed[0].bytes.subarray(0, 15)).toString('utf8')
  )

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
})()
