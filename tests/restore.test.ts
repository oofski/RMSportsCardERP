/**
 * PUTTING A BACKUP BACK.
 *
 * The owner downloaded a backup and then asked the question the download half
 * does not answer: "how do I re-upload the database that I download, just in
 * case". A backup nobody can restore is a hypothesis.
 *
 * Restore is not the mirror image of backup, and the tests here are shaped by
 * the difference: taking a copy touches nothing, putting one back destroys the
 * present. So the interesting assertions are not "does it work" — they are the
 * four ways it must REFUSE, and the one ordering that makes every refusal
 * meaningful.
 *
 * ## The ordering: nothing is moved until everything has been checked
 *
 * Section 3 is the heart of this file. A file that is corrupt, from another
 * program, or from a NEWER version of the app must be rejected while the live
 * database is still sitting there untouched. Every one of those tests asserts
 * both halves — that the verdict is no, AND that the live database still has
 * its rows. A validator that rejected a file after moving it would pass the
 * first half of each and lose somebody's business.
 *
 * ## The refusal that protects OTHER people
 *
 * A backup from a newer build is the one hard blocker with a victim who is not
 * in the room. Loaded into an older app it would run migrate(), stamp the
 * schema version DOWNWARD, and then push column-truncated rows at the relay —
 * `syncTables.ts` calls that "how you corrupt every database at once". It
 * cannot be a warning somebody clicks through, because the person clicking does
 * not receive the damage. Section 3 proves it is a blocker.
 *
 * ## The sync reset, which has no visible symptom
 *
 * Section 6. After a restore the outbox must be empty, the cursor zero and the
 * device id new. Skip it and everything LOOKS fine — the app opens, the data is
 * there — and then this machine pushes a month-old row at the relay, which
 * resolves last-write-wins, and quietly overwrites everybody else's current
 * work. There is no error, no banner and no way to notice until the damage is
 * done, which is precisely why it is asserted here.
 *
 * ## Through the CHANNEL, not the repository
 *
 * Section 5 registers the real handlers and calls them under `runAs`. That is
 * where a defect hid earlier in this codebase: working code behind a handler
 * that dropped a field, with every test passing because every test called the
 * repository directly.
 *
 * Every name here is invented.
 *
 * Run: npm run test:restore
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/restore-db')
process.env.TEST_DB_DIR = DIR
// Both, because this suite runs under the server stub, which resolves
// app.getPath('userData') from RMOPS_DATA_DIR and ignores TEST_DB_DIR. Setting
// only the latter points the whole suite at the repo's own ./data folder and
// writes test rows into the developer's database.
process.env.RMOPS_DATA_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const Database = require('better-sqlite3')
const { closeDb, getDb, databasePath } = require('../src/main/db/database')
const { writeBackupTo, backupCounts } = require('../src/main/db/backup')
const {
  clearStagedRestore,
  stageRestoreFromPath,
  stagedRestore,
  stagedDatabasePath
} = require('../src/main/db/restore')
const {
  applyPendingRestore,
  armRestore,
  disarmRestore,
  replacedDatabases,
  restoreIsArmed,
  takeRestoreOutcome
} = require('../src/main/services/restoreOnBoot')
const {
  RESTORE_CONFIRM_WORD,
  describeBackupAge,
  restoreConfirmed,
  restoreLosses,
  schemaIsRestorable
} = require('../src/shared/restore')
const { CURRENT_SCHEMA_VERSION } = require('../src/shared/backup')

/**
 * Resolved on every call, never captured.
 *
 * A restore REPLACES the database, so a handle held in a variable is stale from
 * the moment the swap happens — and a test that kept one would be asserting
 * against the file that was moved aside. Every read here goes through getDb()
 * for the same reason the app does.
 */
const db = (): any => getDb()

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

const WORK = join(DIR, 'work')
mkdirSync(WORK, { recursive: true })
let seq = 0
const tmp = (name: string): string => join(WORK, `${++seq}-${name}`)

const product = (id: string, sku: string, name: string): void => {
  db().prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, sku, name)
}

const liveProducts = (): number =>
  (db().prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n

// ---------------------------------------------------------------------------
console.log('=== 1. the shared rules, before any file exists ===')
// ---------------------------------------------------------------------------
ok(schemaIsRestorable(CURRENT_SCHEMA_VERSION), 'a backup from this exact version is restorable')
ok(schemaIsRestorable(CURRENT_SCHEMA_VERSION - 30), 'and an older one is — that is the normal case')
ok(
  !schemaIsRestorable(CURRENT_SCHEMA_VERSION + 1),
  'A NEWER ONE IS NOT. Loaded into an older build it stamps the schema version ' +
    'downward and then pushes truncated rows at every other machine'
)
ok(!schemaIsRestorable(null), 'and a file that does not say is not trusted either')

ok(restoreConfirmed(RESTORE_CONFIRM_WORD), 'the confirm word is accepted')
ok(restoreConfirmed('  restore  '), 'trimmed and case-insensitive — this is typed under stress')
ok(!restoreConfirmed('yes'), 'and anything else is not')
ok(!restoreConfirmed(''), 'empty least of all')

ok(describeBackupAge(null) === 'from an unknown date', 'an undated backup says so')
{
  const now = new Date('2026-08-31T12:00:00.000Z')
  ok(
    describeBackupAge('2026-08-31T09:00:00.000Z', now) === 'taken today',
    'today reads as today'
  )
  ok(
    describeBackupAge('2026-08-08T09:00:00.000Z', now) === 'taken 23 days ago',
    'and an older one in days, which is a judgement somebody can make instantly',
    describeBackupAge('2026-08-08T09:00:00.000Z', now)
  )
}

{
  const losses = restoreLosses(
    { products: 335, purchaseOrders: 12, salesOrders: 4, timeEntries: 90, ledgerRows: 500 },
    { products: 128, purchaseOrders: 12, salesOrders: 9, timeEntries: 40, ledgerRows: 500 }
  )
  ok(losses.length === 2, 'only the counts that FALL are named', JSON.stringify(losses))
  ok(losses[0].label === 'products' && losses[0].lost === 207, 'biggest loss first', JSON.stringify(losses[0]))
  ok(
    !losses.some((l: any) => l.label === 'sales orders'),
    'a count that GOES UP is not a loss and is not warned about'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. a real backup, staged and understood ===')
// ---------------------------------------------------------------------------
product('rs_a', 'RS-A', '2026 Topps Chrome Hobby Box')
product('rs_b', 'RS-B', '2026 Bowman Draft Jumbo Case')
const beforeCount = liveProducts()

const good = tmp('good-backup.db')
writeBackupTo(good)
ok(existsSync(good), 'a backup was taken to restore from')

const staged = stageRestoreFromPath(good, 'rmops-backup-2026-08-31.db')
ok(staged.ok === true, 'it is accepted', JSON.stringify(staged.blockers))
ok(staged.blockers.length === 0, 'with nothing blocking it')
ok(staged.stageId !== null, 'and it gets a handle to confirm against')
ok(
  staged.file.counts.products === beforeCount,
  'the counts read out of the FILE match what is in it',
  `${staged.file.counts.products} vs ${beforeCount}`
)
ok(
  staged.file.schemaVersion === CURRENT_SCHEMA_VERSION,
  'and it knows which version wrote it',
  String(staged.file.schemaVersion)
)
ok(
  staged.current.products === beforeCount,
  'while `current` reports the live database — the thing being traded away'
)
ok(
  staged.file.takenAt !== null,
  'when it was taken is read from the CONTENT, not the file timestamp',
  String(staged.file.takenAt)
)
ok(existsSync(stagedDatabasePath()), 'the upload is sitting beside the database, staged')

// A refresh must find it again — on the web, staging and confirming are two
// separate requests and a reload between them is ordinary behaviour.
const reread = stagedRestore()
ok(reread !== null && reread.ok === true, 'and it survives a reload')
ok(reread.stageId === staged.stageId, 'with the same handle, so a confirm still matches')

// ---------------------------------------------------------------------------
console.log('\n=== 3. THE REFUSALS — and the live database is untouched by all of them ===')
// ---------------------------------------------------------------------------
const survives = (label: string): void =>
  ok(
    liveProducts() === beforeCount,
    `  ...and the live database still has its ${beforeCount} products after ${label}`,
    String(liveProducts())
  )

// -- not a database at all
{
  const junk = tmp('holiday-photo.jpg')
  writeFileSync(junk, Buffer.alloc(4096, 7))
  const res = stageRestoreFromPath(junk, 'holiday-photo.jpg')
  ok(res.ok === false, 'a file that is not a database is refused')
  ok(
    res.blockers.some((b: any) => b.code === 'not-a-database'),
    'and named as such, rather than as a mystery',
    JSON.stringify(res.blockers)
  )
  ok(res.stageId === null, 'no handle is issued, so nothing can confirm it')
  survives('a junk file')
}

// -- a valid SQLite database belonging to something else
{
  const alien = tmp('someone-elses.db')
  const other = new Database(alien)
  other.exec(`CREATE TABLE recipes (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO recipes (name) VALUES ('soup')`)
  other.close()
  const res = stageRestoreFromPath(alien, 'someone-elses.db')
  ok(res.ok === false, 'A REAL DATABASE FROM ANOTHER PROGRAM IS REFUSED — it would open fine')
  survives('an unrelated database')
}

/**
 * The one that isolates the "not this app's database" check.
 *
 * The recipes file above is refused twice over — it has none of this app's
 * tables AND therefore counts as empty — so it cannot tell the two rules apart,
 * and a test that only used it would keep passing with the table check deleted.
 * (It did, when that mutant was run.)
 *
 * This file is the awkward middle: a genuine RM Operations backup with the
 * staff table dropped, as a partial export or a half-finished recovery would
 * be. It has products, so it is not empty, and the ONLY thing standing between
 * it and the live database is looksLikeRmops.
 */
{
  const partial = tmp('missing-employees.db')
  copyFileSync(good, partial)
  const gutted = new Database(partial)
  gutted.exec('PRAGMA foreign_keys = OFF')
  gutted.exec('DROP TABLE employees')
  gutted.close()
  const res = stageRestoreFromPath(partial, 'missing-employees.db')
  ok(
    res.file.counts.products > 0,
    'this one still has products, so nothing else can refuse it',
    String(res.file.counts.products)
  )
  ok(
    res.ok === false && res.blockers.some((b: any) => b.code === 'not-rmops'),
    'A DATABASE MISSING THE APP’S OWN TABLES IS REFUSED, on that ground alone',
    JSON.stringify(res.blockers)
  )
  survives('a database missing the staff table')
}

// -- a backup from a NEWER version of the app
{
  const newer = tmp('from-the-future.db')
  copyFileSync(good, newer)
  const bumped = new Database(newer)
  bumped.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(
    String(CURRENT_SCHEMA_VERSION + 5)
  )
  bumped.close()
  const res = stageRestoreFromPath(newer, 'from-the-future.db')
  ok(
    res.ok === false,
    'A BACKUP FROM A NEWER BUILD IS REFUSED — this is the one whose victim is not in the room'
  )
  ok(
    res.blockers.some((b: any) => b.code === 'schema-too-new'),
    'as a BLOCKER, not a warning somebody can click through',
    JSON.stringify(res.blockers)
  )
  ok(
    res.warnings.every((w: any) => w.code !== 'schema-too-new'),
    'it is never demoted to a warning — the person clicking cannot see the damage, ' +
      'which lands on every other machine through the relay'
  )
  survives('a newer backup')
}

// -- a truncated download
{
  const cut = tmp('half-downloaded.db')
  const whole = require('node:fs').readFileSync(good)
  writeFileSync(cut, whole.subarray(0, Math.floor(whole.length / 2)))
  const res = stageRestoreFromPath(cut, 'half-downloaded.db')
  ok(res.ok === false, 'A HALF-DOWNLOADED BACKUP IS REFUSED')
  ok(
    res.blockers.some((b: any) => b.code === 'corrupt' || b.code === 'not-a-database'),
    'caught by the integrity check, which reads every page rather than trusting that it opened',
    JSON.stringify(res.blockers)
  )
  survives('a truncated file')
}

// -- an empty but perfectly valid RM Operations database
{
  const blank = tmp('empty.db')
  copyFileSync(good, blank)
  const wiped = new Database(blank)
  wiped.exec('PRAGMA foreign_keys = OFF')
  for (const t of ['inventory_products', 'purchase_orders', 'invoices', 'time_entries', 'ledger_rows']) {
    try {
      wiped.exec(`DELETE FROM ${t}`)
    } catch {
      /* a table this build may not have */
    }
  }
  wiped.close()
  const res = stageRestoreFromPath(blank, 'empty.db')
  ok(
    res.ok === false && res.blockers.some((b: any) => b.code === 'empty'),
    'an EMPTY backup is refused — restoring it would leave the owner with nothing, ' +
      'and it is exactly what a failed backup produces',
    JSON.stringify(res.blockers)
  )
  survives('an empty backup')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. the swap itself, at boot ===')
// ---------------------------------------------------------------------------
clearStagedRestore()
disarmRestore()

// Re-stage the good file and arm it, exactly as confirming would.
const armedCheck = stageRestoreFromPath(good, 'rmops-backup-2026-08-31.db')
ok(armedCheck.ok === true, 'the good backup is staged again')
ok(!restoreIsArmed(), 'nothing is armed until it is armed')
armRestore({
  stageId: armedCheck.stageId,
  filename: 'rmops-backup-2026-08-31.db',
  requestedBy: 'Marla Quint',
  requestedAt: new Date().toISOString()
})
ok(restoreIsArmed(), 'arming is a file on disk, so it survives the process ending')

// Add a row AFTER the backup was taken and after arming — this is the row that
// proves the swap really happened rather than the app carrying on as before.
product('rs_after', 'RS-AFTER', 'Bought after the backup was taken')
const withExtra = liveProducts()
ok(withExtra === beforeCount + 1, 'a product is added after the backup was taken')

// The live handle has to be released first, and closeDb() is the honest way:
// it also clears the memo, so the next getDb() opens the file that is there
// RATHER than handing back a stale handle to the file that was moved aside.
// That is precisely what a real restart does, and calling db.close() directly
// would leave getDb() returning a dead connection — a mistake this test made
// once and which is worth the comment.
closeDb()

/**
 * Leave a stale write-ahead log behind, because a CLEAN shutdown does not.
 *
 * closeDb() checkpoints and removes the -wal, so after a tidy close there is
 * nothing for the swap to clean up and an assertion that it was removed proves
 * nothing at all. (It didn't: the mutant that stopped deleting the WAL passed
 * this suite untouched until these two lines were added.)
 *
 * The case that matters is the process being KILLED — a crash, an OOM, a Render
 * instance recycled mid-write — which is both the ordinary way a database ends
 * up needing restoring and the state that leaves a -wal on disk. Put the new
 * database in place under that log and SQLite finds a write-ahead log belonging
 * to a DIFFERENT database and replays it into this one. That is a restore that
 * ends in corruption.
 */
writeFileSync(`${databasePath()}-wal`, Buffer.alloc(4096, 3))
writeFileSync(`${databasePath()}-shm`, Buffer.alloc(1024, 3))
ok(existsSync(`${databasePath()}-wal`), 'a stale WAL is sitting there, as a killed process leaves one')

const outcome = applyPendingRestore()
ok(outcome !== null && outcome.ok === true, 'the swap runs at boot', JSON.stringify(outcome))
ok(!restoreIsArmed(), 'and the marker is cleared, so it cannot repeat on every future start')
ok(!existsSync(stagedDatabasePath()), 'the staged upload is consumed')

ok(
  typeof outcome.replacedPath === 'string' && existsSync(outcome.replacedPath),
  'THE DATABASE THAT WAS REPLACED IS KEPT, not deleted — a restore is somebody ' +
    'acting on incomplete information, and getting it wrong must not be terminal',
  String(outcome.replacedPath)
)
ok(
  replacedDatabases().length === 1,
  'and it is findable, so the panel can offer it back',
  JSON.stringify(replacedDatabases().map((c: any) => c.path))
)

// The stale WAL is the subtle one: left beside the NEW file, SQLite would
// replay a log belonging to a different database.
ok(!existsSync(`${databasePath()}-wal`), 'NO STALE -wal IS LEFT BESIDE THE NEW DATABASE')
ok(!existsSync(`${databasePath()}-shm`), 'nor a stale -shm')

{
  const restored = new Database(databasePath(), { readonly: true })
  const n = (restored.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n
  const after = (
    restored.prepare(`SELECT COUNT(*) AS n FROM inventory_products WHERE id = 'rs_after'`).get() as {
      n: number
    }
  ).n
  restored.close()
  ok(n === beforeCount, 'the database in place is now the BACKUP’s', `${n} vs ${beforeCount}`)
  ok(
    after === 0,
    'AND THE ROW ADDED AFTER THE BACKUP IS GONE — which is what restoring means, ' +
      'and is why the screen says out loud what will be lost',
    String(after)
  )
}

{
  const result = takeRestoreOutcome()
  ok(
    result !== null && result.ok === true,
    'the result is left on disk for the panel to report after the restart',
    JSON.stringify(result)
  )
  ok(
    takeRestoreOutcome() === null,
    'and read exactly once, so it is not re-announced on every later boot'
  )
}

ok(applyPendingRestore() === null, 'an ordinary boot with nothing armed does nothing at all')

// ---------------------------------------------------------------------------
console.log('\n=== 5. owner only, at the CHANNEL ===')
// ---------------------------------------------------------------------------
// The database was closed and swapped above, so everything from here works
// against the restored file through a fresh handle.
const registry = require('../src/main/ipcRegistry')
const { runAs } = require('../src/main/services/session')
const { insertEmployee } = require('../src/main/db/employees')

const channels = new Map<string, any>()
registry.setRegistrationSink((channel: string, handler: any) => channels.set(channel, handler))
require('../src/main/backupIpc').registerRestoreIpc()

ok(channels.has('restore:stage'), 'the stage channel is registered, so the server serves it too')
ok(channels.has('restore:confirm'), 'and the confirm channel')

const mkEmployee = (first: string, last: string, companyId: string, role: string): string =>
  insertEmployee(
    {
      firstName: first,
      lastName: last,
      companyId,
      title: role,
      email: `${companyId}@example.invalid`,
      role
    },
    null,
    null,
    false
  ).employee.id

const OWNER = mkEmployee('Marla', 'Quint', 'RM-RS-OWNER', 'owner')
const OPERATIONS = mkEmployee('Dara', 'Vance', 'RM-RS-OPS', 'operations')

const via = (who: string | null, channel: string, payload?: any): any =>
  runAs({ userId: who, origin: 'test' }, () => channels.get(channel)({ sender: null }, payload))

ok(via(OWNER, 'restore:status') !== null, 'the owner can read the restore panel')
ok(
  via(OPERATIONS, 'restore:status') === null,
  'AN OPERATIONS ADMIN CANNOT — restoring replaces the business, and the file ' +
    'carries the QuickBooks token',
  JSON.stringify(via(OPERATIONS, 'restore:status'))
)
ok(via(null, 'restore:status') === null, 'and neither can somebody not signed in')

// Stage a good file as the owner so there is something an intruder could try to
// confirm. This is the state a real attempt would find.
clearStagedRestore()
const ownerStaged = stageRestoreFromPath(good, 'rmops-backup-2026-08-31.db')
ok(ownerStaged.ok === true, 'a valid backup is staged and waiting')

{
  const res = via(OPERATIONS, 'restore:confirm', {
    stageId: ownerStaged.stageId,
    typed: RESTORE_CONFIRM_WORD
  })
  ok(res?.ok === false, 'OPERATIONS IS REFUSED THE CONFIRM', JSON.stringify(res))
  ok(
    String(res?.error ?? '').toLowerCase().includes('owner'),
    'and told why, in words',
    String(res?.error)
  )
  ok(!restoreIsArmed(), 'AND NOTHING WAS ARMED — the refusal happens before anything is scheduled')
}

{
  const res = via(OPERATIONS, 'restore:cancel')
  ok(res?.ok === false, 'operations cannot throw the owner’s upload away either')
  ok(
    existsSync(stagedDatabasePath()),
    'AND THE STAGED FILE SURVIVES — a refused cancel that deleted the file anyway ' +
      'would let anybody with a session interrupt a restore'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. the confirm gate, and what it will not accept ===')
// ---------------------------------------------------------------------------
{
  const res = via(OWNER, 'restore:confirm', { stageId: ownerStaged.stageId, typed: 'ok' })
  ok(res?.ok === false, 'the owner is refused without the typed word')
  ok(!restoreIsArmed(), 'and nothing is armed')
}
{
  const res = via(OWNER, 'restore:confirm', {
    stageId: 'a-handle-from-some-other-upload',
    typed: RESTORE_CONFIRM_WORD
  })
  ok(
    res?.ok === false,
    'A STALE HANDLE IS REFUSED — a panel left open while a different file was ' +
      'uploaded from another tab would otherwise confirm a decision about a file ' +
      'that is no longer there',
    JSON.stringify(res)
  )
  ok(!restoreIsArmed(), 'and still nothing is armed')
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. the sync reset, which has no visible symptom ===')
// ---------------------------------------------------------------------------
const { resetSyncAfterRestore, cursor, deviceId, pendingCount } = require('../src/main/db/sync')

const idBefore = deviceId()
db().prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('cursor', '4210')`).run()
ok(cursor() === 4210, 'the restored file carries a cursor from the day it was taken')

// Queue something, as a restored outbox would arrive carrying.
product('rs_queued', 'RS-QUEUED', 'A row the backup had queued to push')
ok(pendingCount() > 0, 'and an outbox with rows still queued to push', String(pendingCount()))

const { cleared } = resetSyncAfterRestore()
ok(cleared > 0, 'the reset reports what it dropped', String(cleared))
ok(
  pendingCount() === 0,
  'THE OUTBOX IS EMPTIED. The relay is last-write-wins on updated_at, so pushing ' +
    'a month-old row does not lose politely — it overwrites the current one on ' +
    'every other machine',
  String(pendingCount())
)
ok(
  cursor() === 0,
  'THE CURSOR GOES BACK TO ZERO. The one it carried points into a change log that ' +
    'has moved on; trusting it would skip everything recorded since the backup, ' +
    'and the machine would come back looking healthy having missed a month',
  String(cursor())
)
ok(
  deviceId() !== idBefore,
  'AND THE DEVICE IS NEW. A device ignores the echo of its own pushes, so the old ' +
    'id would make this machine decline exactly the rows it most needs',
  `${idBefore} -> ${deviceId()}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. a failed swap leaves the app able to start ===')
// ---------------------------------------------------------------------------
clearStagedRestore()
disarmRestore()
// Arm a restore whose staged file has vanished — a disk that filled, a cleanup
// script, a crash between upload and restart.
armRestore({
  stageId: 'gone',
  filename: 'vanished.db',
  requestedBy: 'Marla Quint',
  requestedAt: new Date().toISOString()
})
const failed = applyPendingRestore()
ok(failed !== null && failed.ok === false, 'the swap reports failure rather than pretending')
ok(
  !restoreIsArmed(),
  'AND THE MARKER IS CLEARED ANYWAY. A marker that survived its own failure would ' +
    'retry on every boot, which turns one bad file into an app that will not start'
)
ok(existsSync(databasePath()), 'the database is still there, and still the restored one')
{
  const still = new Database(databasePath(), { readonly: true })
  const n = (still.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }).n
  still.close()
  ok(n > 0, 'with its rows intact', String(n))
}
{
  const result = takeRestoreOutcome()
  ok(
    result !== null && result.ok === false && !!result.error,
    'and the reason is left for the panel to show',
    JSON.stringify(result)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 9. nothing was left lying about ===')
// ---------------------------------------------------------------------------
{
  const stray = readdirSync(DIR).filter(
    (n) => n.startsWith('restore-staged') || n.startsWith('restore-pending') || n.endsWith('.tmp')
  )
  ok(
    stray.length === 0,
    'no staged upload, marker or temp file is left behind — a stray copy of the ' +
      'database is exactly the wrong thing to leave in a data directory',
    stray.join(', ')
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
