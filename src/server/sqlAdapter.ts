/**
 * A better-sqlite3-shaped facade over a Cloudflare Durable Object's SQL storage.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/main/db/*` is ~32k lines written against better-sqlite3, and only ONE of
 * those lines touches Electron. If the db layer can be pointed at a different
 * SQLite engine without editing it, the whole thing transplants to the web; if
 * it cannot, the web app is a rewrite. This adapter is the seam that decides it.
 *
 * The target is Durable Object SQLite (`ctx.storage.sql`), NOT D1. That choice is
 * load-bearing: D1 is async, so every one of the ~526 `.prepare(...).get()` call
 * sites would have to grow an `await` and every calling function would go async —
 * that is the rewrite we are trying to avoid. DO SQL storage is genuinely
 * synchronous, which is the only reason a drop-in facade is possible at all.
 *
 * WHAT THE DURABLE OBJECT ACTUALLY GIVES US (verified against workerd source,
 * not from memory — see src/workerd/api/sql.c++ and src/workerd/util/sqlite.c++):
 *
 *   - `sql.exec(query, ...bindings)` returns a synchronous forward-only cursor.
 *   - Bindings are STRICTLY POSITIONAL variadic values. There is no named-binding
 *     API. The engine still assigns indices to `@name` parameters the normal
 *     SQLite way, so this adapter recovers named binding by resolving names to
 *     indices itself (see `planParameters`). Nothing in the SQL is rewritten.
 *   - Multiple statements per exec ARE supported, but only the LAST statement may
 *     carry parameters. The schema block and the trigger installer both rely on
 *     this, and both are parameterless, so they are fine.
 *   - BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE are HARD-REJECTED from
 *     `sql.exec` — `SqlStorageRegulator::allowTransactions()` unconditionally
 *     throws. Transactions exist only as `ctx.storage.transactionSync(fn)`.
 *     Fortunately that primitive is itself implemented as a depth-numbered
 *     SAVEPOINT, so nesting it reproduces better-sqlite3's nested-transaction
 *     semantics exactly — which this codebase depends on in 67 places.
 *   - The cursor exposes `rowsRead`/`rowsWritten`, which are NOT `changes`:
 *     they count btree row touches including index rows, so an INSERT into a
 *     table with two indexes reports 3. `.changes` is therefore recovered with a
 *     follow-up `SELECT changes()` (that function is on the engine's allowlist).
 *   - Values come back as `ArrayBuffer | string | number | null`. BLOBs arrive as
 *     ArrayBuffer, but the db layer types them as Node `Buffer`
 *     (db/shipping.ts getShipDocumentBytes), so reads are normalised here.
 *
 * This file deliberately knows nothing about node:sqlite, workerd, or Electron.
 * It takes an injected executor so the same facade can run against a real Durable
 * Object in production and against a restricted node:sqlite stand-in in tests.
 */

// ---------------------------------------------------------------------------
// The low-level surface. This mirrors Cloudflare's `SqlStorage` /
// `DurableObjectStorage` types exactly; anything wider would let the adapter
// quietly depend on a capability the Durable Object does not have, which is the
// specific failure mode this spike exists to rule out.
// ---------------------------------------------------------------------------

/** One value as it crosses the Durable Object boundary. Note: no bigint, no Buffer. */
export type SqlStorageValue = ArrayBuffer | string | number | null

export interface SqlStorageCursor<T = Record<string, SqlStorageValue>> {
  toArray(): T[]
  columnNames: string[]
  readonly rowsRead: number
  readonly rowsWritten: number
}

export interface SqlStorageLike {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): SqlStorageCursor<T>
  readonly databaseSize: number
}

export interface DurableStorageLike {
  readonly sql: SqlStorageLike
  /**
   * Runs `fn` inside a savepoint. Must be nestable: the db layer composes
   * transactions (scanning.commitScan opens one and calls inventory.addStock,
   * which opens its own), and a non-nesting implementation would either throw or
   * — far worse — commit the inner half of a failed outer transaction.
   */
  transactionSync<T>(fn: () => T): T
}

// ---------------------------------------------------------------------------
// Parameter planning
// ---------------------------------------------------------------------------

/**
 * Where each SQLite parameter index gets its value from.
 * `null` means the index belongs to an anonymous `?`; a string is the bare name
 * of an `@x` / `:x` / `$x` parameter.
 */
export interface ParameterPlan {
  /** One entry per SQLite parameter index, in index order (1-based → offset 0). */
  readonly order: ReadonlyArray<string | null>
  readonly hasNamed: boolean
}

const IDENT = /[A-Za-z0-9_]/

/**
 * Work out the parameter indices SQLite will assign to a statement.
 *
 * This has to be a real scanner rather than a regex because the schema and the
 * sync triggers are full of string literals and `--` comments, and a stray `@`
 * or `?` inside one of those would otherwise be counted as a parameter and throw
 * the whole index assignment off by one — a corruption bug, not a crash.
 *
 * The index rules are SQLite's own: parameters are numbered in order of first
 * appearance, and a repeated NAMED parameter reuses the index it was first
 * given (`WHERE a = @x OR b = @x` has ONE parameter, not two). Repeated
 * anonymous `?` always take a fresh index.
 */
export function planParameters(sql: string): ParameterPlan {
  const order: Array<string | null> = []
  const assigned = new Map<string, number>()
  let hasNamed = false

  const take = (name: string | null): void => {
    if (name !== null) {
      const seen = assigned.get(name)
      if (seen !== undefined) return
      assigned.set(name, order.length + 1)
      hasNamed = true
    }
    order.push(name)
  }

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]

    // -- line comment
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i++
      continue
    }
    // 'string literal' — '' is an escaped quote, not a terminator.
    if (c === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i++
          else break
        }
        i++
      }
      continue
    }
    // "quoted identifier" / [bracketed] / `backticked`
    if (c === '"' || c === '`') {
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

    if (c === '?') {
      // `?NNN` pins an explicit index. Nothing in this codebase uses it, but
      // silently mis-numbering it would be a data bug, so it is handled.
      let j = i + 1
      let digits = ''
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') digits += sql[j++]
      if (digits) {
        const idx = Number(digits)
        while (order.length < idx) order.push(null)
        i = j - 1
      } else {
        order.push(null)
      }
      continue
    }

    if (c === '@' || c === ':' || c === '$') {
      // `::` is not SQLite, but a lone ':' can appear in odd places; only treat
      // it as a parameter when a real identifier follows.
      let j = i + 1
      let name = ''
      while (j < sql.length && IDENT.test(sql[j])) name += sql[j++]
      if (name) {
        take(name)
        i = j - 1
      }
      continue
    }
  }

  return { order, hasNamed }
}

// ---------------------------------------------------------------------------
// Value marshalling
// ---------------------------------------------------------------------------

/**
 * Normalise a value on its way OUT of the Durable Object.
 *
 * BLOB columns arrive as ArrayBuffer, but the db layer declares them `Buffer`
 * (db/shipping.ts stores parsed PDF bytes). Handing a raw ArrayBuffer to code
 * that calls `.length` or `.subarray()` fails in a way that only shows up on the
 * one screen that reads a shipping document back, so it is converted here.
 */
function fromSqlValue(v: unknown): unknown {
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v))
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const view = v as Uint8Array
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
  }
  return v
}

function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  let needsCopy = false
  for (const k in row) {
    const v = row[k]
    if (v instanceof ArrayBuffer || (ArrayBuffer.isView(v) && !(v instanceof DataView))) {
      needsCopy = true
      break
    }
  }
  if (!needsCopy) return row
  const out: Record<string, unknown> = {}
  for (const k in row) out[k] = fromSqlValue(row[k])
  return out
}

/**
 * Normalise a value on its way IN.
 *
 * The Durable Object accepts only `ArrayBuffer | string | number | null`, so
 * everything else has to be converted or refused here. The rules deliberately
 * mirror better-sqlite3's rather than being "helpful", because the db layer was
 * written against those rules and a laxer adapter would let a real bug through:
 *
 *   - `undefined` binds as NULL. It looks sloppy, but better-sqlite3 does this,
 *     and db/inventory.ts createProduct passes `notes: input.notes` straight
 *     through for an optional field. Refusing it breaks product creation.
 *   - booleans are REFUSED, exactly as better-sqlite3 refuses them. SQLite has no
 *     boolean, the db layer always writes flags as `x ? 1 : 0`, and silently
 *     coercing here would hide the one call site that forgot.
 */
function toSqlValue(v: unknown, where: string): unknown {
  if (v === undefined || v === null) return null
  if (typeof v === 'string' || typeof v === 'number') return v
  if (typeof v === 'boolean') {
    throw new TypeError(
      `Cannot bind a boolean ${where}: SQLite has no boolean type (write 1/0 explicitly)`
    )
  }
  if (typeof v === 'bigint') {
    // DO SQL has no int64 binding path: everything numeric is a double. Anything
    // past 2^53 would be silently rounded, so refuse rather than corrupt.
    if (v > 9007199254740991n || v < -9007199254740991n) {
      throw new RangeError(`BigInt ${v} cannot be bound: Durable Object SQL binds numbers as doubles`)
    }
    return Number(v)
  }
  if (v instanceof ArrayBuffer) return v
  if (ArrayBuffer.isView(v)) {
    const view = v as Uint8Array
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
  }
  if (v instanceof Date) return v.toISOString()
  throw new TypeError(`Cannot bind ${typeof v} ${where}`)
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

export interface RunResult {
  changes: number
  lastInsertRowid: number
}

const CHANGES_SQL = 'SELECT changes() AS c, last_insert_rowid() AS r'

export class AdaptedStatement {
  readonly source: string
  private readonly storage: DurableStorageLike
  private readonly plan: ParameterPlan
  /** better-sqlite3 exposes this; a few libraries sniff it. Cheap to keep honest. */
  readonly reader: boolean

  constructor(storage: DurableStorageLike, sql: string) {
    this.storage = storage
    this.source = sql
    this.plan = planParameters(sql)
    this.reader = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(select|pragma|with)\b/i.test(sql)
  }

  /**
   * Turn a better-sqlite3 call signature into the positional array the Durable
   * Object requires.
   *
   * better-sqlite3 accepts either loose positional args (`stmt.get(a, b)`) or a
   * single object of named values (`stmt.run({ id, name })`), and the db layer
   * uses both — the named form 391 times. Keys may or may not carry the `@`.
   */
  private bindings(args: unknown[]): unknown[] {
    const { order, hasNamed } = this.plan
    if (order.length === 0) return []

    const named =
      hasNamed &&
      args.length === 1 &&
      args[0] !== null &&
      typeof args[0] === 'object' &&
      !Array.isArray(args[0]) &&
      !ArrayBuffer.isView(args[0]) &&
      !(args[0] instanceof ArrayBuffer)

    if (!named) {
      // Positional. A single array argument is also accepted, matching
      // better-sqlite3's `stmt.run([a, b])` spelling.
      const flat =
        args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
      if (flat.length !== order.length) {
        throw new RangeError(
          `Wrong number of parameter bindings: expected ${order.length}, got ${flat.length}`
        )
      }
      return flat.map((v, i) => toSqlValue(v, `at index ${i + 1}`))
    }

    const src = args[0] as Record<string, unknown>
    return order.map((name, i) => {
      if (name === null) {
        // A statement mixing `?` with `@x` cannot be filled from an object.
        // Saying so beats binding NULL into a column nobody notices for a week.
        throw new TypeError(
          `Statement mixes anonymous and named parameters; index ${i + 1} has no name`
        )
      }
      // A key that is PRESENT but undefined binds NULL; a key that is ABSENT is
      // an error. That distinction is better-sqlite3's, and it is what catches a
      // mistyped parameter name instead of quietly nulling a column.
      let v: unknown
      if (name in src) v = src[name]
      else if (`@${name}` in src) v = src[`@${name}`]
      else if (`:${name}` in src) v = src[`:${name}`]
      else if (`$${name}` in src) v = src[`$${name}`]
      else throw new TypeError(`Missing named parameter "${name}"`)
      return toSqlValue(v, `for @${name}`)
    })
  }

  private cursorFor(args: unknown[]): SqlStorageCursor<Record<string, unknown>> {
    return this.storage.sql.exec<Record<string, unknown>>(this.source, ...this.bindings(args))
  }

  all(...args: unknown[]): Array<Record<string, unknown>> {
    return this.cursorFor(args).toArray().map(normaliseRow)
  }

  get(...args: unknown[]): Record<string, unknown> | undefined {
    // The DO cursor has `.one()`, but it THROWS when the result set is empty or
    // has more than one row, whereas better-sqlite3's `.get()` returns the first
    // row or undefined. Roughly 249 call sites depend on the forgiving version.
    const rows = this.cursorFor(args).toArray()
    return rows.length === 0 ? undefined : normaliseRow(rows[0])
  }

  run(...args: unknown[]): RunResult {
    const cursor = this.cursorFor(args)
    // The cursor is lazy past the first row. Draining it is what actually
    // finishes a multi-row write (e.g. `INSERT ... SELECT`), and skipping it
    // would report changes from a half-executed statement.
    cursor.toArray()
    const meta = this.storage.sql.exec<{ c: number; r: number }>(CHANGES_SQL).toArray()[0]
    return { changes: meta?.c ?? 0, lastInsertRowid: meta?.r ?? 0 }
  }

  iterate(...args: unknown[]): IterableIterator<Record<string, unknown>> {
    // NOT lazy, unlike better-sqlite3. A DO cursor is invalidated as soon as the
    // same prepared statement runs again, so a half-consumed lazy iterator that
    // re-enters the db layer would blow up far from the cause. Buffering trades
    // memory for a failure mode nobody can debug. Nothing in src/main/db calls
    // this today; it exists so the facade is shaped right.
    return this.all(...args)[Symbol.iterator]()
  }

  /** better-sqlite3 compatibility no-ops — the db layer never uses these. */
  pluck(): this {
    throw new Error('pluck() is not supported by the Durable Object SQL adapter')
  }
  raw(): this {
    throw new Error('raw() is not supported by the Durable Object SQL adapter')
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type TransactionFunction<A extends unknown[], R> = ((...args: A) => R) & {
  deferred: (...args: A) => R
  immediate: (...args: A) => R
  exclusive: (...args: A) => R
}

/**
 * PRAGMAs the Durable Object engine refuses outright, which the adapter absorbs
 * instead of letting them throw.
 *
 * `journal_mode` is the one that matters: db/database.ts asks for WAL on every
 * open. Inside a Durable Object that request is not merely disallowed, it is
 * meaningless — Cloudflare owns durability and the storage engine is not a plain
 * file. Passing it through would make `getDb()` throw on the first call, i.e.
 * the app would not boot. Swallowing it changes nothing about correctness.
 */
const IGNORED_PRAGMAS = new Set([
  'journal_mode',
  'synchronous',
  'temp_store',
  'cache_size',
  'mmap_size',
  'locking_mode',
  'busy_timeout',
  'wal_autocheckpoint',
  'auto_vacuum',
  'secure_delete'
])

/** PRAGMAs workerd's allowlist accepts with a boolean argument. */
const ALLOWED_BOOLEAN_PRAGMAS = new Set([
  'case_sensitive_like',
  'foreign_keys',
  'defer_foreign_keys',
  'ignore_check_constraints',
  'legacy_alter_table',
  'recursive_triggers',
  'reverse_unordered_selects'
])

export class AdaptedDatabase {
  private readonly storage: DurableStorageLike
  private closed = false
  /**
   * Prepared statements are cached because the db layer calls `.prepare()` inside
   * hot loops (FIFO cost layering walks one statement per lot). The Durable
   * Object keeps its own statement cache keyed on the SQL string, so this cache
   * saves only the parameter-plan scan — but that scan runs over the full SQL
   * text, and doing it per row is the difference between an import that finishes
   * and one that times out.
   */
  private readonly cache = new Map<string, AdaptedStatement>()

  /** Shape-compat with better-sqlite3's `Database` fields. */
  readonly name: string
  readonly memory = false
  readonly readonly = false
  open = true
  inTransaction = false

  constructor(storage: DurableStorageLike, name = 'durable-object') {
    this.storage = storage
    this.name = name
  }

  prepare(sql: string): AdaptedStatement {
    if (this.closed) throw new TypeError('The database connection is not open')
    const hit = this.cache.get(sql)
    if (hit) return hit
    const stmt = new AdaptedStatement(this.storage, sql)
    // Unbounded growth would be a leak, but the db layer's SQL is generated from
    // a fixed set of templates, so the ceiling is the number of distinct queries
    // in the codebase. The cap only guards against dynamically built SQL (the
    // `set.push(...)` update builders in dedupe.ts) pathologically filling it.
    if (this.cache.size > 2000) this.cache.clear()
    this.cache.set(sql, stmt)
    return stmt
  }

  /**
   * Multi-statement DDL. This is the single most important thing the Durable
   * Object has to support, because db/database.ts ships the entire schema as one
   * ~1000-line `exec()` and syncTriggers.ts installs every capture trigger the
   * same way. DO does support it, with the caveat that only the last statement
   * may take parameters — both of these call sites are parameterless.
   */
  exec(sql: string): this {
    if (this.closed) throw new TypeError('The database connection is not open')
    this.storage.sql.exec(sql).toArray()
    return this
  }

  /**
   * `db.pragma(...)`.
   *
   * better-sqlite3 returns rows; the db layer ignores the result at all 7 call
   * sites and uses this purely to set `foreign_keys`, `defer_foreign_keys`,
   * `recursive_triggers` and `journal_mode`. The first three are on the Durable
   * Object's allowlist; the last is absorbed (see IGNORED_PRAGMAS).
   */
  pragma(source: string, options?: { simple?: boolean }): unknown {
    if (this.closed) throw new TypeError('The database connection is not open')
    const text = source.trim()
    const eq = text.indexOf('=')
    const head = (eq === -1 ? text : text.slice(0, eq)).trim()
    const bare = head.replace(/\(.*$/, '').trim().toLowerCase()

    if (IGNORED_PRAGMAS.has(bare)) {
      // Named failure mode: without this, `getDb()` throws on line 35 and the
      // server never starts.
      return options?.simple ? undefined : []
    }

    if (eq !== -1 && !ALLOWED_BOOLEAN_PRAGMAS.has(bare)) {
      throw new Error(
        `PRAGMA ${bare} cannot be set inside a Durable Object (engine allowlist rejects it)`
      )
    }

    const rows = this.storage.sql.exec<Record<string, unknown>>(`PRAGMA ${text}`).toArray()
    if (options?.simple) {
      const first = rows[0]
      return first ? Object.values(first)[0] : undefined
    }
    return rows.map(normaliseRow)
  }

  /**
   * `db.transaction(fn)` → a callable that runs `fn` atomically.
   *
   * Maps onto `ctx.storage.transactionSync`, which workerd implements as a
   * depth-numbered SAVEPOINT (`SAVEPOINT _cf_sync_savepoint_<n>` /
   * `ROLLBACK TO` / `RELEASE`). That is precisely better-sqlite3's nesting
   * behaviour, which this codebase leans on hard: scanning.commitScan opens a
   * transaction and calls inventory.addStock, which opens another, and the
   * comment at db/scanning.ts:368 says out loud that the inner one must degrade
   * to a savepoint. It does.
   *
   * The `.deferred` / `.immediate` / `.exclusive` variants are aliases: a Durable
   * Object is single-threaded and already holds the write lock, so the
   * distinction has no meaning. Nothing in the db layer calls them.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): TransactionFunction<A, R> {
    const run = (...args: A): R => {
      const outer = this.inTransaction
      this.inTransaction = true
      try {
        return this.storage.transactionSync(() => fn(...args))
      } finally {
        this.inTransaction = outer
      }
    }
    const wrapped = run as TransactionFunction<A, R>
    wrapped.deferred = run
    wrapped.immediate = run
    wrapped.exclusive = run
    return wrapped
  }

  /** Bytes on disk. Useful for the 10 GB per-object ceiling. */
  get databaseSize(): number {
    return this.storage.sql.databaseSize
  }

  close(): this {
    this.closed = true
    this.open = false
    this.cache.clear()
    return this
  }

  /** better-sqlite3 surface the db layer does not use. Fail loudly, not silently. */
  backup(): never {
    throw new Error('backup() is unavailable: a Durable Object has no filesystem')
  }
  function(): never {
    throw new Error('Custom SQL functions cannot be registered in a Durable Object')
  }
  aggregate(): never {
    throw new Error('Custom SQL aggregates cannot be registered in a Durable Object')
  }
  loadExtension(): never {
    throw new Error('Extensions cannot be loaded in a Durable Object')
  }
}

/** Build the facade. `name` is cosmetic — a Durable Object has no file path. */
export function createSqlAdapter(storage: DurableStorageLike, name?: string): AdaptedDatabase {
  return new AdaptedDatabase(storage, name)
}
