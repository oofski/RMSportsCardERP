/**
 * A Durable Object SQL storage stand-in, backed by node:sqlite.
 *
 * WHY NOT JUST USE better-sqlite3 AND CALL IT PROVEN
 * --------------------------------------------------
 * Because that would prove nothing. better-sqlite3 supports everything, so an
 * adapter tested against it passes whether or not a Durable Object could run it.
 * The point of this file is to be DELIBERATELY AS POOR as the real thing: it
 * enforces every restriction found in workerd's own source, so a test that goes
 * green here is evidence about Cloudflare, not about node:sqlite.
 *
 * Restrictions enforced, each traced to workerd:
 *
 *  1. Bindings are positional only, and the count must equal the statement's
 *     parameter count.                       (util/sqlite.c++ Query::checkRequirements)
 *  2. BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE are rejected from
 *     `sql.exec`.                            (api/sql.c++ SqlStorageRegulator::allowTransactions)
 *  3. Multiple statements per exec are allowed, but only the LAST may carry
 *     parameters.                            (util/sqlite.c++ prepareSql, case MULTI)
 *  4. Only allowlisted PRAGMAs run.          (util/sqlite.c++ ALLOWED_PRAGMAS)
 *  5. Names beginning `_cf_` are reserved.   (api/sql.c++ isAllowedName)
 *  6. BLOBs come back as ArrayBuffer, never Buffer. (api/sql.h SqlValue)
 *  7. transactionSync is a depth-numbered SAVEPOINT, and nests.
 *                                            (api/actor-state.c++ transactionSync)
 *
 * node:sqlite is the right host for this because DatabaseSync is synchronous,
 * which is the property under test. Where its API differs from the Durable
 * Object's (it binds named parameters by NAME, the DO binds by INDEX) the
 * difference is bridged here, using the same index rules the DO applies.
 */
import { DatabaseSync } from 'node:sqlite'
import { planParameters } from '../../src/server/sqlAdapter'
import type { DurableStorageLike, SqlStorageCursor, SqlStorageLike } from '../../src/server/sqlAdapter'

// Verbatim from workerd util/sqlite.c++ ALLOWED_PRAGMAS.
const ALLOWED_PRAGMAS = new Set([
  'data_version',
  'page_size',
  'case_sensitive_like',
  'foreign_keys',
  'defer_foreign_keys',
  'ignore_check_constraints',
  'legacy_alter_table',
  'recursive_triggers',
  'reverse_unordered_selects',
  'foreign_key_check',
  'foreign_key_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'quick_check',
  'optimize',
  // Special-cased above the allowlist in the authorizer.
  'table_list',
  'table_info',
  'table_xinfo'
])

const TXN_KEYWORDS = /^\s*(begin|commit|end\s+transaction|rollback|savepoint|release)\b/i

/**
 * Split a SQL blob into individual statements.
 *
 * workerd gets this free from sqlite3_prepare_v2's tail pointer; node:sqlite
 * exposes no such thing, and — worse — its `prepare()` silently ACCEPTS a
 * multi-statement string and then runs only the first one. Splitting by hand is
 * the only way to avoid a test that appears to install the schema and actually
 * installs one table.
 *
 * The subtlety is CREATE TRIGGER: its body is full of semicolons that must not
 * split (syncTriggers.ts emits three such triggers per synced table). A trigger
 * body ends at `END`, so inside one we only break on a `;` whose preceding token
 * is exactly `END`.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let start = 0
  let inTriggerBody = false
  let sawCreateTrigger = false

  const push = (end: number): void => {
    const s = sql.slice(start, end).trim()
    if (s) out.push(s)
    start = end + 1
    inTriggerBody = false
    sawCreateTrigger = false
  }

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]

    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) i++
          else break
        }
        i++
      }
      continue
    }
    if (c === '[') {
      while (i < sql.length && sql[i] !== ']') i++
      continue
    }

    if (/[A-Za-z]/.test(c)) {
      let j = i
      while (j < sql.length && /[A-Za-z_]/.test(sql[j])) j++
      const word = sql.slice(i, j).toUpperCase()
      if (word === 'TRIGGER') sawCreateTrigger = true
      else if (word === 'BEGIN' && sawCreateTrigger) inTriggerBody = true
      i = j - 1
      continue
    }

    if (c === ';') {
      if (!inTriggerBody) {
        push(i)
      } else {
        // Inside a trigger body: only an `END;` closes it.
        const before = sql.slice(Math.max(0, i - 4), i).trim().toUpperCase()
        if (before.endsWith('END')) push(i)
      }
    }
  }

  const tail = sql.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

function assertAllowed(statement: string): void {
  if (TXN_KEYWORDS.test(statement)) {
    // The exact failure a Durable Object produces. Reproduced verbatim so a
    // test failure reads the way production would.
    throw new Error(
      'To execute a transaction, please use the state.storage.transaction() or ' +
        'state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT ' +
        'statements.'
    )
  }
  const pragma = /^\s*pragma\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement)
  if (pragma && !ALLOWED_PRAGMAS.has(pragma[1].toLowerCase())) {
    throw new Error(`not authorized: PRAGMA ${pragma[1]} is not on the Durable Object allowlist`)
  }
  if (/_cf_/i.test(statement) && /\b(create|drop|alter)\b/i.test(statement)) {
    throw new Error('not authorized: names beginning with _cf_ are reserved')
  }
}

/**
 * The Durable Object accepts an ArrayBuffer as a BLOB binding; node:sqlite wants
 * a TypedArray. Bridging that here rather than in the adapter is deliberate: the
 * adapter must keep emitting what a real Durable Object takes, or the test stops
 * testing the thing it claims to.
 */
function toHostBinding(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  return v
}

/** DO hands back ArrayBuffer for BLOBs; node:sqlite hands back Uint8Array. */
function toDoValue(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
  }
  if (typeof v === 'bigint') return Number(v)
  return v
}

class Cursor implements SqlStorageCursor<Record<string, unknown>> {
  constructor(
    private readonly rows: Array<Record<string, unknown>>,
    readonly columnNames: string[],
    readonly rowsRead: number,
    readonly rowsWritten: number
  ) {}
  toArray(): Array<Record<string, unknown>> {
    return this.rows
  }
}

export class DoSqlStorageStub implements SqlStorageLike {
  constructor(private readonly db: DatabaseSync) {}

  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T> {
    const statements = splitStatements(query)
    if (statements.length === 0) throw new Error('SQL code did not contain a statement.')

    for (let i = 0; i < statements.length - 1; i++) {
      const s = statements[i]
      assertAllowed(s)
      if (planParameters(s).order.length > 0) {
        throw new Error(
          'When executing multiple SQL statements in a single call, only the last statement ' +
            'can have parameters.'
        )
      }
      this.db.prepare(s).run()
    }

    const last = statements[statements.length - 1]
    assertAllowed(last)
    const plan = planParameters(last)
    if (plan.order.length !== bindings.length) {
      throw new Error('Wrong number of parameter bindings for SQL query.')
    }

    const stmt = this.db.prepare(last)
    let rows: Array<Record<string, unknown>>
    if (plan.hasNamed) {
      // The DO binds these by index. node:sqlite insists on names, so map the
      // positional array the adapter produced back onto the names SQLite would
      // have assigned those very indices.
      const named: Record<string, unknown> = {}
      plan.order.forEach((name, i) => {
        if (name !== null) named[name] = toHostBinding(bindings[i])
      })
      rows = stmt.all(named as never) as Array<Record<string, unknown>>
    } else {
      rows = stmt.all(...(bindings.map(toHostBinding) as never[])) as Array<
        Record<string, unknown>
      >
    }

    const mapped = rows.map((r) => {
      const o: Record<string, unknown> = {}
      for (const k of Object.keys(r)) o[k] = toDoValue(r[k])
      return o
    })
    const columnNames = mapped.length > 0 ? Object.keys(mapped[0]) : []
    return new Cursor(mapped, columnNames, mapped.length, 0) as unknown as SqlStorageCursor<T>
  }

  get databaseSize(): number {
    const row = this.db.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get() as
      | { n: number }
      | undefined
    return row?.n ?? 0
  }
}

/**
 * The `ctx.storage` surface.
 *
 * `transactionSync` is a transcription of workerd's implementation, savepoint
 * naming and all, because the nesting behaviour is the single property the whole
 * transplant depends on. Note that it runs its SAVEPOINT through the raw
 * database rather than through `exec()` — mirroring workerd, which uses the
 * TRUSTED regulator here and so bypasses the ban that applies to user SQL.
 */
export class DoStorageStub implements DurableStorageLike {
  readonly sql: DoSqlStorageStub
  private depth = 0

  constructor(private readonly db: DatabaseSync) {
    this.sql = new DoSqlStorageStub(db)
  }

  transactionSync<T>(fn: () => T): T {
    const depth = this.depth++
    const name = `_cf_sync_savepoint_${depth}`
    this.db.exec(`SAVEPOINT ${name}`)
    try {
      const result = fn()
      this.db.exec(`RELEASE ${name}`)
      return result
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${name}`)
      this.db.exec(`RELEASE ${name}`)
      throw err
    } finally {
      this.depth--
    }
  }
}

export function openDoStorage(path: string): { storage: DoStorageStub; db: DatabaseSync } {
  const db = new DatabaseSync(path)
  return { storage: new DoStorageStub(db), db }
}
