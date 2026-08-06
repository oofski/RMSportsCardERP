/**
 * Feasibility spike: can src/main/db run against Cloudflare Durable Object SQL?
 *
 * This suite does NOT test the adapter against a friendly mock. It runs the real
 * `getDb()` — every migration, every trigger — against a database restricted to
 * exactly what a Durable Object permits (tests/support/doSqlStorage.ts), and then
 * diffs the resulting schema against what better-sqlite3 produces from the same
 * code. If those two schemas match, the transplant is real; if they diverge, the
 * divergence is the answer.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import BetterSqlite3 from 'better-sqlite3'
import { AdaptedDatabase, planParameters } from '../src/server/sqlAdapter'
import { DoStorageStub, splitStatements } from './support/doSqlStorage'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function eq(a: unknown, b: unknown, msg: string): void {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) throw new Error(`${msg}\n  actual:   ${sa}\n  expected: ${sb}`)
}

function freshAdapter(): AdaptedDatabase {
  return new AdaptedDatabase(new DoStorageStub(new DatabaseSync(':memory:')), ':memory:')
}

// ---------------------------------------------------------------------------
// 1. Parameter planning — the piece that makes `@named` work over a positional-
//    only API. Getting an index wrong here writes the right value to the wrong
//    column, which no test downstream would notice.
// ---------------------------------------------------------------------------

check('planParameters: anonymous', () => {
  eq(planParameters('SELECT * FROM t WHERE a = ? AND b = ?').order, [null, null], 'two slots')
})

check('planParameters: named, first-appearance order', () => {
  const p = planParameters('UPDATE t SET a = @alpha, b = @beta WHERE id = @id')
  eq(p.order, ['alpha', 'beta', 'id'], 'three named in order')
  assert(p.hasNamed, 'hasNamed')
})

check('planParameters: repeated named reuses its index', () => {
  // SQLite gives @x ONE index even though it appears twice. A naive scanner
  // reports two and every subsequent binding shifts by one.
  eq(planParameters('SELECT * FROM t WHERE a = @x OR b = @x OR c = @y').order, ['x', 'y'], 'dedup')
})

check('planParameters: ignores @ and ? inside literals and comments', () => {
  const sql = `
    -- an email like a@b.example and a question?
    /* @block comment ? */
    SELECT '@not-a-param', "col?name" FROM t WHERE id = @real`
  eq(planParameters(sql).order, ['real'], 'only the real parameter counts')
})

check('planParameters: matches SQLite own numbering', () => {
  // Ground truth: better-sqlite3 exposes what SQLite actually decided.
  const probe = new BetterSqlite3(':memory:')
  probe.exec('CREATE TABLE t (a, b, c)')
  const sql = 'SELECT * FROM t WHERE a = @x AND b = @y AND c = @x'
  const stmt = probe.prepare(sql)
  // better-sqlite3 exposes parameter count indirectly: binding the wrong number
  // of named keys throws. Two distinct names must satisfy it.
  stmt.all({ x: 1, y: 2 })
  eq(planParameters(sql).order.length, 2, 'SQLite sees 2 parameters, so must we')
  probe.close()
})

// ---------------------------------------------------------------------------
// 2. Statement splitting — the schema arrives as one block, triggers included.
// ---------------------------------------------------------------------------

check('splitStatements: keeps trigger bodies intact', () => {
  const sql = `
    CREATE TABLE a (x);
    CREATE TRIGGER tr AFTER INSERT ON a
    WHEN (SELECT 1) = 1
    BEGIN
      INSERT INTO a VALUES (1);
      INSERT INTO a VALUES (2);
    END;
    CREATE INDEX i ON a (x);`
  const parts = splitStatements(sql)
  eq(parts.length, 3, 'three statements, not six')
  assert(parts[1].includes('END'), 'trigger body survived whole')
})

// ---------------------------------------------------------------------------
// 3. The Durable Object restrictions are actually enforced by the stub. If these
//    fail, every test below is meaningless.
// ---------------------------------------------------------------------------

check('stub rejects BEGIN/SAVEPOINT via exec, as a Durable Object does', () => {
  const db = freshAdapter()
  let threw = false
  try {
    db.exec('BEGIN')
  } catch {
    threw = true
  }
  assert(threw, 'BEGIN must be refused')
  threw = false
  try {
    db.exec('SAVEPOINT sp1')
  } catch {
    threw = true
  }
  assert(threw, 'SAVEPOINT must be refused')
})

check('stub rejects non-allowlisted PRAGMA', () => {
  const db = freshAdapter()
  let threw = false
  try {
    db.pragma('user_version = 5')
  } catch {
    threw = true
  }
  assert(threw, 'user_version is not on the Durable Object allowlist')
})

check('stub rejects parameters on a non-final statement', () => {
  const db = freshAdapter()
  let threw = false
  try {
    db.exec('CREATE TABLE z (a)')
    ;(db as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => void } })
      .prepare('INSERT INTO z VALUES (?); SELECT 1')
      .run(1)
  } catch {
    threw = true
  }
  assert(threw, 'only the last statement may take parameters')
})

// ---------------------------------------------------------------------------
// 4. Core better-sqlite3 contract over the restricted engine.
// ---------------------------------------------------------------------------

check('journal_mode pragma is absorbed rather than fatal', () => {
  const db = freshAdapter()
  // db/database.ts line 35 does this on every open. If it throws, nothing boots.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
})

check('get/all/run and info.changes', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, s TEXT COLLATE NOCASE)`)
  const ins = db.prepare('INSERT INTO t (id, n, s) VALUES (?, ?, ?)')
  eq(ins.run('a', 1, 'Alpha').changes, 1, 'one row inserted')
  ins.run('b', 2, 'Beta')
  eq(db.prepare('SELECT COUNT(*) AS c FROM t').get(), { c: 2 }, 'count')
  eq(db.prepare('SELECT id FROM t ORDER BY id').all(), [{ id: 'a' }, { id: 'b' }], 'all')
  eq(db.prepare('SELECT id FROM t WHERE id = ?').get('nope'), undefined, 'get misses → undefined')
  eq(db.prepare('UPDATE t SET n = n + 1').run().changes, 2, 'changes counts rows, not index writes')
  eq(db.prepare('DELETE FROM t WHERE id = ?').run('zzz').changes, 0, 'no-op delete reports 0')
})

check('COLLATE NOCASE still applies', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE e (email TEXT UNIQUE COLLATE NOCASE)`)
  db.prepare('INSERT INTO e VALUES (?)').run('Sid@Example.com')
  eq(
    db.prepare('SELECT COUNT(*) AS c FROM e WHERE email = ?').get('sid@example.com'),
    { c: 1 },
    'case-insensitive match'
  )
})

check('named @parameters bind correctly over a positional-only API', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE p (id TEXT PRIMARY KEY, a TEXT, b TEXT, c TEXT)`)
  db.prepare('INSERT INTO p (id, a, b, c) VALUES (@id, @a, @b, @c)').run({
    id: 'x',
    a: 'AAA',
    b: 'BBB',
    c: 'CCC'
  })
  eq(db.prepare('SELECT * FROM p').get(), { id: 'x', a: 'AAA', b: 'BBB', c: 'CCC' }, 'values landed in the right columns')
  // Repeated name: one index, used twice.
  const row = db.prepare('SELECT * FROM p WHERE a = @v OR b = @v').get({ v: 'BBB' })
  assert(row, 'repeated named parameter resolved')
})

check('missing named key is an error, not a silent NULL', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE q (a TEXT, b TEXT)`)
  let threw = false
  try {
    db.prepare('INSERT INTO q VALUES (@a, @b)').run({ a: '1' })
  } catch {
    threw = true
  }
  assert(threw, 'a typo’d key must fail loudly')
})

check('ON CONFLICT upsert with excluded', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE u (k TEXT PRIMARY KEY, v INTEGER)`)
  const up = db.prepare(
    'INSERT INTO u (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v'
  )
  up.run('a', 1)
  up.run('a', 9)
  eq(db.prepare('SELECT v FROM u WHERE k = ?').get('a'), { v: 9 }, 'upserted')
})

check('WITHOUT ROWID tables', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE w (a TEXT, b TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID`)
  db.prepare('INSERT INTO w VALUES (?, ?)').run('x', 'y')
  eq(db.prepare('SELECT COUNT(*) AS c FROM w').get(), { c: 1 }, 'row stored')
})

check('BLOB round-trips as a Buffer', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE docs (id TEXT PRIMARY KEY, bytes BLOB)`)
  const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
  db.prepare('INSERT INTO docs VALUES (?, ?)').run('d1', payload)
  const got = db.prepare('SELECT bytes FROM docs WHERE id = ?').get('d1') as { bytes: Buffer }
  // db/shipping.ts getShipDocumentBytes() declares Buffer and callers use it as
  // one; an ArrayBuffer here would break PDF download at runtime only.
  assert(Buffer.isBuffer(got.bytes), 'must be a Buffer, not an ArrayBuffer')
  eq([...got.bytes], [...payload], 'bytes intact')
})

check('PRAGMA table_info via prepare().all()', () => {
  const db = freshAdapter()
  db.exec(`CREATE TABLE ti (a TEXT, b INTEGER)`)
  const cols = db.prepare('PRAGMA table_info(ti)').all() as Array<{ name: string }>
  eq(cols.map((c) => c.name), ['a', 'b'], 'migration column probing works')
})

check('date/time functions used by the db layer', () => {
  const db = freshAdapter()
  const r = db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-02 03:04:05') AS s,
              CAST((julianday('2024-01-02') - julianday('2024-01-01')) * 24 AS INTEGER) AS h,
              date('2024-03-05') AS d`
    )
    .get() as { s: string; h: number; d: string }
  assert(r.s.startsWith('2024-01-02T03:04:05'), 'strftime')
  eq(r.h, 24, 'julianday difference in hours')
  eq(r.d, '2024-03-05', 'date()')
})

check('foreign keys cascade', () => {
  const db = freshAdapter()
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE parent (id TEXT PRIMARY KEY);
    CREATE TABLE child (id TEXT PRIMARY KEY, p TEXT REFERENCES parent(id) ON DELETE CASCADE);`)
  db.prepare('INSERT INTO parent VALUES (?)').run('p1')
  db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', 'p1')
  db.prepare('DELETE FROM parent WHERE id = ?').run('p1')
  eq(db.prepare('SELECT COUNT(*) AS c FROM child').get(), { c: 0 }, 'cascade fired')
})

// ---------------------------------------------------------------------------
// 5. Transactions — the property the whole plan rests on.
// ---------------------------------------------------------------------------

check('transaction commits and returns the callback value', () => {
  const db = freshAdapter()
  db.exec('CREATE TABLE t (a TEXT)')
  const run = db.transaction((): string => {
    db.prepare('INSERT INTO t VALUES (?)').run('one')
    return 'ok'
  })
  eq(run(), 'ok', 'return value passes through')
  eq(db.prepare('SELECT COUNT(*) AS c FROM t').get(), { c: 1 }, 'committed')
})

check('transaction takes arguments, like better-sqlite3', () => {
  const db = freshAdapter()
  db.exec('CREATE TABLE t (a TEXT)')
  // db/inventorySeed.ts spells it exactly this way.
  const insertAll = db.transaction((rows: string[]) => {
    for (const r of rows) db.prepare('INSERT INTO t VALUES (?)').run(r)
  })
  insertAll(['a', 'b', 'c'])
  eq(db.prepare('SELECT COUNT(*) AS c FROM t').get(), { c: 3 }, 'batch inserted')
})

check('a throw rolls the transaction back', () => {
  const db = freshAdapter()
  db.exec('CREATE TABLE t (a TEXT)')
  const run = db.transaction(() => {
    db.prepare('INSERT INTO t VALUES (?)').run('one')
    throw new Error('boom')
  })
  let threw = false
  try {
    run()
  } catch {
    threw = true
  }
  assert(threw, 'error propagates')
  eq(db.prepare('SELECT COUNT(*) AS c FROM t').get(), { c: 0 }, 'rolled back')
})

check('NESTED transactions behave as savepoints', () => {
  // This is the load-bearing case. db/scanning.ts:368 opens a transaction and
  // calls inventory.addStock, which opens its own. If the inner one is not a
  // savepoint, an inner failure either explodes or — much worse — leaves the
  // outer transaction half-applied.
  const db = freshAdapter()
  db.exec('CREATE TABLE t (a TEXT)')

  const inner = db.transaction((v: string) => {
    db.prepare('INSERT INTO t VALUES (?)').run(v)
  })
  const outer = db.transaction(() => {
    inner('outer-1')
    inner('outer-2')
  })
  outer()
  eq(db.prepare('SELECT COUNT(*) AS c FROM t').get(), { c: 2 }, 'nested commit')

  const failingOuter = db.transaction(() => {
    inner('doomed')
    throw new Error('outer fails after inner succeeded')
  })
  try {
    failingOuter()
  } catch {
    /* expected */
  }
  eq(
    db.prepare('SELECT COUNT(*) AS c FROM t').get(),
    { c: 2 },
    'inner work is discarded when the OUTER transaction fails'
  )
})

check('inner failure caught by outer leaves outer work intact', () => {
  const db = freshAdapter()
  db.exec('CREATE TABLE t (a TEXT)')
  const inner = db.transaction(() => {
    db.prepare('INSERT INTO t VALUES (?)').run('inner')
    throw new Error('inner fails')
  })
  const outer = db.transaction(() => {
    db.prepare('INSERT INTO t VALUES (?)').run('outer')
    try {
      inner()
    } catch {
      /* swallowed, as several db/ call sites do */
    }
  })
  outer()
  eq(db.prepare('SELECT a FROM t').all(), [{ a: 'outer' }], 'only the inner half rolled back')
})

// ---------------------------------------------------------------------------
// 6. THE REAL THING: the app's own schema, migrations and triggers.
// ---------------------------------------------------------------------------

check('real getDb(): full schema + all migrations + sync triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rmops-adapter-'))
  process.env.TEST_DB_DIR = dir
  // Resolved lazily so the electron stub's TEST_DB_DIR is set first.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getDb } = require('../src/main/db/database') as { getDb: () => AdaptedDatabase }
  const db = getDb()

  const version = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined
  assert(version, 'schema_version row exists')
  eq(Number(version.value), 45, 'every migration ran')

  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
  assert(tables.length > 40, `expected the full schema, got ${tables.length} tables`)
  for (const t of ['employees', 'inventory_products', 'stream_sessions', 'sync_outbox']) {
    assert(tables.includes(t), `missing table ${t}`)
  }

  const triggers = db
    .prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger'`)
    .get() as { c: number }
  assert(triggers.c > 0, 'sync capture triggers installed')

  // And they actually fire.
  const before = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as { c: number }).c
  db.prepare(
    `INSERT INTO inventory_products (id, sku, upc, name, created_at, updated_at)
     VALUES (@id, @sku, @upc, @name, @now, @now)`
  ).run({ id: 'spike-1', sku: 'SPK', upc: '0000000000001', name: 'Spike Box', now: new Date().toISOString() })
  const after = (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as { c: number }).c
  assert(after > before, 'trigger enqueued the write to the outbox')
})

check('schema built via the adapter is IDENTICAL to better-sqlite3’s', () => {
  // The strongest available evidence. Same migration code, two engines; if the
  // resulting sqlite_master differs by one index or one trigger, something was
  // silently dropped.
  const adapterDir = process.env.TEST_DB_DIR as string
  const adapterDb = new DatabaseSync(join(adapterDir, 'rm-operations.db'))
  const adapterSchema = (
    adapterDb
      .prepare(
        `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((r) => `${r.type} ${r.name} ${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`)

  const nativeDir = mkdtempSync(join(tmpdir(), 'rmops-native-'))
  const out = require('node:child_process').execFileSync(
    process.execPath,
    [join(__dirname, 'nativeSchema.cjs')],
    { env: { ...process.env, TEST_DB_DIR: nativeDir }, encoding: 'utf8' }
  ) as string
  const nativeSchema = JSON.parse(out) as string[]

  eq(adapterSchema.length, nativeSchema.length, 'same number of schema objects')
  for (let i = 0; i < nativeSchema.length; i++) {
    eq(adapterSchema[i], nativeSchema[i], `schema object ${i} differs`)
  }
})

// ---------------------------------------------------------------------------

console.log(`\nsqlAdapter: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  FAIL ${f}`)
if (failures.length > 0) process.exit(1)
