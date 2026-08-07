import { randomUUID } from 'crypto'
import type { Database } from 'better-sqlite3'
import { getDb } from './database'
import { SYNCED_BY_TABLE, SYNCED_TABLES, KEY_SEP, type SyncedTable } from './syncTables'
import { normQty, lotWeightedAvgCost } from './lots'
import type { StockDrift, SyncReject } from '@shared/sync'

/**
 * The local half of sync: what goes up, what comes down, and what has to be
 * recomputed once it lands.
 *
 * Everything here is ordinary SQLite against the machine's own database. The
 * network lives in services/cloudSync.ts; this file would work identically
 * against a USB stick.
 */

/** One record in transit. `data` is the row as JSON, or null for a tombstone. */
export interface SyncRow {
  kind: string
  id: string
  updated_at: string
  deleted: 0 | 1
  data: string | null
}

/** A record coming down, which additionally carries its place in the log. */
export interface IncomingRow extends SyncRow {
  seq: number
}

// ---------------------------------------------------------------------------
// Local bookkeeping
// ---------------------------------------------------------------------------

export function syncStateGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined
  return row?.value ?? null
}

export function syncStateSet(key: string, value: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO sync_state (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

/**
 * This machine's stable identity in the change log.
 *
 * Minted once and kept. It is what lets a laptop ignore the echo of its own
 * push, and what makes "who changed this" answerable without a login — the
 * device is a property of the machine, the employee is a property of the row.
 */
export function deviceId(): string {
  let id = syncStateGet('device_id')
  if (!id) {
    id = randomUUID()
    syncStateSet('device_id', id)
  }
  return id
}

export function cursor(): number {
  return Number(syncStateGet('cursor') ?? 0) || 0
}

export function setCursor(value: number): void {
  syncStateSet('cursor', String(value))
}

export function pendingCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// Outbound: turning a queued key back into a row
// ---------------------------------------------------------------------------

/** Split a wire id back into its column values. */
function keyValues(spec: SyncedTable, id: string): string[] {
  if (spec.key.length === 1) return [id]
  const parts = id.split(KEY_SEP)
  if (parts.length !== spec.key.length) {
    throw new Error(`Malformed key "${id}" for ${spec.table}`)
  }
  return parts
}

function whereKey(spec: SyncedTable): string {
  return spec.key.map((c) => `${c} = ?`).join(' AND ')
}

/**
 * Read the next batch of queued changes, each with its current row contents.
 *
 * The snapshot is taken at send time rather than at change time on purpose: a
 * row edited five times while offline goes up once, in its final state. That is
 * both smaller and more correct than replaying an edit history whose
 * intermediate states nobody ever needs.
 */
export function takeOutbox(limit: number): SyncRow[] {
  const db = getDb()
  const queued = db
    .prepare(
      `SELECT kind, id, updated_at, deleted FROM sync_outbox
       ORDER BY updated_at ASC, kind ASC, id ASC LIMIT ?`
    )
    .all(limit) as Array<{ kind: string; id: string; updated_at: string; deleted: number }>

  const out: SyncRow[] = []
  for (const q of queued) {
    const spec = SYNCED_BY_TABLE.get(q.kind)
    if (!spec) {
      // The manifest shrank under a queued row (a table stopped syncing).
      // Dropping it is right: it is no longer anyone else's business.
      db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ?').run(q.kind, q.id)
      continue
    }
    if (q.deleted) {
      out.push({ kind: q.kind, id: q.id, updated_at: q.updated_at, deleted: 1, data: null })
      continue
    }
    const row = db
      .prepare(`SELECT * FROM ${spec.table} WHERE ${whereKey(spec)}`)
      .get(...keyValues(spec, q.id)) as Record<string, unknown> | undefined
    if (!row) {
      // Queued as changed, gone by send time. A tombstone is the honest report:
      // the last thing that happened to this record locally was that it left.
      out.push({ kind: q.kind, id: q.id, updated_at: q.updated_at, deleted: 1, data: null })
      continue
    }
    out.push({
      kind: q.kind,
      id: q.id,
      updated_at: q.updated_at,
      deleted: 0,
      data: JSON.stringify(row)
    })
  }
  return out
}

/**
 * Drop the rows the relay accepted.
 *
 * Matched on updated_at as well as the key, so a row edited again while its
 * push was in flight stays queued and goes up on the next round instead of
 * being quietly forgotten.
 */
export function clearOutbox(rows: SyncRow[]): void {
  const db = getDb()
  const stmt = db.prepare(
    'DELETE FROM sync_outbox WHERE kind = ? AND id = ? AND updated_at = ?'
  )
  const run = db.transaction(() => {
    for (const r of rows) stmt.run(r.kind, r.id, r.updated_at)
  })
  run()
}

// ---------------------------------------------------------------------------
// Inbound: landing rows from everyone else
// ---------------------------------------------------------------------------

const columnCache = new Map<string, Set<string>>()

function columnsOf(db: Database, table: string): Set<string> {
  let cols = columnCache.get(table)
  if (!cols) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    cols = new Set(info.map((c) => c.name))
    columnCache.set(table, cols)
  }
  return cols
}

/**
 * Columns that travel but are never allowed to LAND on an existing row.
 *
 * `supplies.quantity` is a count, and a count must not be arbitrated. Whoever
 * wrote the supply row last would otherwise decide how many team bags exist —
 * so a rename typed offline carries that machine's stale number and lands on top
 * of a deduction somebody else made an hour ago, putting the stock back.
 *
 * The number still arrives on an INSERT, because a supply this machine has never
 * seen has to start somewhere and the sender's figure is the best guess
 * available. From then on it is maintained the way inventory_stock is: derived
 * from the movement rows, which have their own ids, never collide, and are the
 * actual record of what happened. See rebuildDerivedSupplyStock.
 */
const NEVER_OVERWRITE: Record<string, ReadonlySet<string>> = {
  supplies: new Set(['quantity'])
}

/**
 * Build the upsert for one incoming row.
 *
 * Only columns this database actually has are used. A laptop on a newer version
 * will push columns an older one has never heard of, and the older one must land
 * everything it understands rather than refusing the row — otherwise a staggered
 * rollout stops sync dead for whoever updates last.
 *
 * ON CONFLICT ... DO UPDATE rather than INSERT OR REPLACE: REPLACE deletes the
 * conflicting row first, and half these tables are parents in an ON DELETE
 * CASCADE. Replacing a product would silently take its lots, transactions and
 * stock with it.
 */
function upsertFor(db: Database, spec: SyncedTable, data: Record<string, unknown>): {
  sql: string
  values: unknown[]
} {
  const known = columnsOf(db, spec.table)
  const cols = Object.keys(data).filter((c) => known.has(c))
  if (cols.length === 0) throw new Error('no recognised columns')
  for (const k of spec.key) {
    if (!cols.includes(k)) throw new Error(`missing key column ${k}`)
  }
  const keep = NEVER_OVERWRITE[spec.table]
  const assignable = cols.filter((c) => !spec.key.includes(c) && !keep?.has(c))
  const sql =
    `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT (${spec.key.join(', ')}) DO UPDATE SET ` +
    (assignable.length > 0
      ? assignable.map((c) => `${c} = excluded.${c}`).join(', ')
      : `${spec.key[0]} = excluded.${spec.key[0]}`)
  return { sql, values: cols.map((c) => data[c] ?? null) }
}

// ---------------------------------------------------------------------------
// Natural-key collisions
// ---------------------------------------------------------------------------

/**
 * The same real thing, created twice, under two different ids.
 *
 * Every install seeds the same 122-product catalog, and every install mints its
 * own random ids for it — so laptop A's "2025 Prizm Hobby Box" and laptop B's
 * are the same box with different primary keys and the same UPC. When A's row
 * arrives at B it does not conflict on the id (they differ); it conflicts on the
 * UNIQUE column that says what the thing actually IS.
 *
 * The listed columns are those natural keys.
 */
const NATURAL_KEYS: Record<string, string[]> = {
  inventory_products: ['upc'],
  employees: ['email', 'company_id'],
  intake_links: ['token']
}

/** Where a row's children point, so the loser's history can be carried over. */
const CHILD_REFS: Record<string, Array<{ table: string; column: string }>> = {
  inventory_products: [
    { table: 'inventory_stock', column: 'product_id' },
    { table: 'inventory_transactions', column: 'product_id' },
    { table: 'inventory_product_images', column: 'product_id' },
    { table: 'inventory_incoming', column: 'product_id' },
    { table: 'inventory_lots', column: 'product_id' },
    { table: 'purchase_order_lines', column: 'product_id' },
    { table: 'inventory_scans', column: 'product_id' },
    { table: 'stream_items', column: 'product_id' }
  ],
  employees: [{ table: 'time_entries', column: 'employee_id' }]
}

/**
 * Find the local row that already claims one of the incoming row's natural keys.
 */
function findNaturalTwin(
  db: Database,
  table: string,
  data: Record<string, unknown>,
  incomingId: string
): string | null {
  for (const column of NATURAL_KEYS[table] ?? []) {
    const value = data[column]
    if (value === null || value === undefined || value === '') continue
    const row = db
      .prepare(`SELECT id FROM ${table} WHERE ${column} = ? AND id <> ?`)
      .get(value, incomingId) as { id: string } | undefined
    if (row) return row.id
  }
  return null
}

/**
 * Decide which of two ids for the same thing survives — and give the same answer
 * on every machine.
 *
 * The smaller id wins, compared as text. The rule is arbitrary; being IDENTICAL
 * everywhere is the whole point. Anything that depended on which row arrived
 * first, or on which machine was asking, would have two laptops each keep the
 * other's row and delete their own, and the product would vanish from both.
 */
function resolveTwin(
  db: Database,
  table: string,
  incomingId: string,
  localId: string
): 'incoming' | 'local' {
  if (incomingId >= localId) return 'local'

  // The incoming id wins: carry the local row's history across before the local
  // row goes, so a lot booked here under the old id keeps its stock and cost.
  for (const ref of CHILD_REFS[table] ?? []) {
    try {
      const moving = db
        .prepare(`SELECT id FROM ${ref.table} WHERE ${ref.column} = ?`)
        .all(localId) as Array<{ id: string }>
      db.prepare(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`).run(
        incomingId,
        localId
      )
      // Publish the re-point.
      //
      // This runs inside an apply, where the capture triggers are muted so
      // pulled rows do not echo back. But moving a lot onto the surviving id is
      // not an echo — it is a decision this machine made about its own data, and
      // nobody else can reach it any other way. Left unqueued, everyone else
      // keeps a lot pointing at an id that no longer exists, so the receipt it
      // represents silently disappears from their shelf count.
      for (const child of moving) enqueue(db, ref.table, child.id, 0)
    } catch {
      // A child table this version does not have, or a row that would now
      // duplicate one already pointing at the winner (inventory_stock is unique
      // per product+location). Either way the delete below removes what is left
      // and rebuildDerivedStock recomputes the totals from the surviving lots.
    }
  }
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId)
  // Likewise the tombstone. Only the machine that HELD the losing row announces
  // its death, and only after re-pointing what hung off it — a machine that
  // never had it must stay quiet, or its tombstone could reach the holder before
  // the holder has moved its children off and take them down too.
  enqueue(db, table, localId, 1)
  return 'incoming'
}

/** Queue a row for upload from inside an apply, where the triggers are muted. */
function enqueue(db: Database, kind: string, id: string, deleted: 0 | 1): void {
  if (!SYNCED_BY_TABLE.has(kind)) return
  db.prepare(
    `INSERT INTO sync_outbox (kind, id, updated_at, deleted) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE
       SET updated_at = excluded.updated_at, deleted = excluded.deleted`
  ).run(kind, id, new Date().toISOString(), deleted)
}

export interface ApplyResult {
  applied: number
  deleted: number
  rejected: number
  /** Rows that turned out to be the same real thing under a second id. */
  duplicates: number
  /** Products whose lots moved, so the caller knows the numbers changed. */
  touchedProducts: string[]
  /**
   * Supplies whose row or movements arrived in this batch.
   *
   * Reported for diagnostics only. It is TEMPTING to rebuild their on-hand from
   * supply_transactions here, the way inventory_stock is rebuilt from its lots —
   * that would fix `supplies.quantity` being a last-write-wins column. It was
   * tried, and it is worse than the problem:
   *
   *   - Tier ordering only holds INSIDE a batch, so a supply arriving with its
   *     movements still in a later batch rebuilds against a partial history and
   *     lands on a negative count that persists until the next completed pull.
   *   - A `supply_transactions` row that gets quarantined is never retried — the
   *     cursor advances past it — so a rebuild would erase that deduction for
   *     good rather than temporarily.
   *   - Any count that legitimately is not the sum of its movements (a row
   *     damaged by an older version, a hand-edit) is silently rewritten with no
   *     flag.
   *
   * The real fix is to stop arbitrating the count at all: apply each incoming
   * movement's delta once, on first sight, so the number is a counter rather
   * than a value two machines overwrite. That is a bigger change than a rebuild
   * and is not in this release.
   */
  touchedSupplies: string[]
  /** Kinds that actually changed something — what the UI refetches on. */
  kinds: string[]
}

/**
 * Land a batch.
 *
 * Two passes by design. The first tries the whole batch as one transaction with
 * foreign keys deferred, which is the only way a set of rows that reference each
 * other can land in any order. If any single row is bad, the transaction takes
 * the whole batch down with it — so the second pass replays row by row in
 * dependency order, keeping what works and quarantining what does not.
 *
 * The alternative (row by row always) is both slower and worse: it drops a child
 * whose parent happens to come later in the same batch, every time.
 */
export function applyRows(rows: IncomingRow[]): ApplyResult {
  const db = getDb()
  const result: ApplyResult = {
    applied: 0,
    deleted: 0,
    rejected: 0,
    duplicates: 0,
    touchedProducts: [],
    touchedSupplies: [],
    kinds: []
  }
  if (rows.length === 0) return result

  const tierOf = (kind: string): number => SYNCED_BY_TABLE.get(kind)?.tier ?? 99
  const ordered = [...rows].sort((a, b) => tierOf(a.kind) - tierOf(b.kind) || a.seq - b.seq)
  const kinds = new Set<string>()
  const products = new Set<string>()
  const supplies = new Set<string>()
  const landed: Array<[string, string]> = []

  const landOne = (row: IncomingRow): void => {
    const spec = SYNCED_BY_TABLE.get(row.kind)
    if (!spec) throw new Error(`unknown record type "${row.kind}"`)

    if (row.deleted) {
      const info = db
        .prepare(`DELETE FROM ${spec.table} WHERE ${whereKey(spec)}`)
        .run(...keyValues(spec, row.id))
      landed.push([row.kind, row.id])
      if (info.changes > 0) {
        result.deleted += info.changes
        kinds.add(row.kind)
      }
      return
    }

    const data = JSON.parse(row.data ?? '{}') as Record<string, unknown>
    const { sql, values } = upsertFor(db, spec, data)
    try {
      db.prepare(sql).run(...values)
    } catch (err) {
      // The id did not conflict but something that says what this row IS did —
      // the same product created independently on two machines. Settle it and
      // retry once; anything else is a genuine fault and belongs in rejects.
      if (!/UNIQUE constraint failed/i.test(err instanceof Error ? err.message : String(err))) {
        throw err
      }
      const twin = findNaturalTwin(db, spec.table, data, row.id)
      if (!twin) throw err
      if (resolveTwin(db, spec.table, row.id, twin) === 'local') {
        // The local row is the agreed survivor. Drop the incoming copy; the
        // machine that sent it will reach the same verdict and delete its own.
        result.duplicates += 1
        return
      }
      db.prepare(sql).run(...values)
      result.duplicates += 1
    }
    result.applied += 1
    landed.push([row.kind, row.id])
    kinds.add(row.kind)
    if (spec.table === 'inventory_lots' && typeof data.product_id === 'string') {
      products.add(data.product_id)
    }
    if (spec.table === 'inventory_products') products.add(row.id)
    // Supplies touched by this batch. REPORTED, not acted on — see the note on
    // touchedSupplies in ApplyResult for why recomputing them here is not safe.
    if (spec.table === 'supplies') supplies.add(row.id)
    if (spec.table === 'supply_transactions' && typeof data.supply_id === 'string') {
      supplies.add(data.supply_id)
    }
  }

  // A lot row being deleted has no payload to read product_id from, so note the
  // products of any lots about to go before they do.
  const lotIds = ordered.filter((r) => r.kind === 'inventory_lots' && r.deleted).map((r) => r.id)
  if (lotIds.length > 0) {
    const placeholders = lotIds.map(() => '?').join(',')
    const owners = db
      .prepare(`SELECT DISTINCT product_id FROM inventory_lots WHERE id IN (${placeholders})`)
      .all(...lotIds) as Array<{ product_id: string }>
    for (const o of owners) products.add(o.product_id)
  }

  const batch = db.transaction((items: IncomingRow[]) => {
    // Deferring foreign keys is what lets a child arrive before its parent
    // inside the same batch: the constraints are checked once, at COMMIT, by
    // which time the whole consistent set is present.
    db.pragma('defer_foreign_keys = ON')
    setApplying(db, true)
    try {
      for (const row of items) landOne(row)
    } finally {
      setApplying(db, false)
    }
  })

  try {
    batch(ordered)
  } catch {
    // Reset the counters the failed attempt inflated; the transaction rolled
    // back, so nothing it counted actually happened.
    //
    // `landed` included. It is not a counter — it is the list used below to
    // clear the quarantine, and leaving the rolled-back attempt's entries in it
    // meant a row that failed BOTH passes had its quarantine record deleted the
    // instant it was written. The reject was counted in the result and then
    // vanished from the store, so the Sync screen under-reported and nothing
    // could ever be retried. It matters more now that a count is derived from
    // these rows: a movement that quietly disappears is a wrong number on a
    // shelf that nobody can trace.
    result.applied = 0
    result.deleted = 0
    result.duplicates = 0
    landed.length = 0
    kinds.clear()
    for (const row of ordered) {
      try {
        const one = db.transaction((r: IncomingRow) => {
          setApplying(db, true)
          try {
            landOne(r)
          } finally {
            setApplying(db, false)
          }
        })
        one(row)
      } catch (err) {
        result.rejected += 1
        recordReject(db, row, err instanceof Error ? err.message : String(err))
      }
    }
  }

  // A row that failed once and succeeded later must stop being reported as a
  // problem. This is the ordinary shape of a fix arriving: a lot is refused
  // because its product has not landed yet, then lands the moment it does.
  if (landed.length > 0 && rejectCount() > 0) {
    const clear = db.prepare('DELETE FROM sync_rejects WHERE kind = ? AND id = ?')
    const run = db.transaction(() => {
      for (const [kind, id] of landed) clear.run(kind, id)
    })
    run()
  }

  result.kinds = [...kinds]
  result.touchedProducts = [...products]
  result.touchedSupplies = [...supplies]
  return result
}

/**
 * The echo brake. Set for the duration of an apply so the capture triggers stay
 * quiet: a row that arrived from someone else is not a change this machine made,
 * and queueing it back up would have two laptops trading it forever.
 */
function setApplying(db: Database, on: boolean): void {
  db.prepare('UPDATE sync_control SET applying = ? WHERE id = 1').run(on ? 1 : 0)
}

function recordReject(db: Database, row: IncomingRow, reason: string): void {
  db.prepare(
    `INSERT INTO sync_rejects (kind, id, seq, reason, data, at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE
       SET seq = excluded.seq, reason = excluded.reason,
           data = excluded.data, at = excluded.at`
  ).run(row.kind, row.id, row.seq, reason, row.data, new Date().toISOString())
}

export function listRejects(limit = 100): SyncReject[] {
  return (
    getDb()
      .prepare(
        `SELECT kind, id, seq, reason, at FROM sync_rejects ORDER BY at DESC LIMIT ?`
      )
      .all(limit) as Array<{ kind: string; id: string; seq: number; reason: string; at: string }>
  ).map((r) => ({ kind: r.kind, id: r.id, seq: r.seq, reason: r.reason, at: r.at }))
}

export function rejectCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM sync_rejects').get() as { n: number }
  return row.n
}

export function clearRejects(): number {
  return getDb().prepare('DELETE FROM sync_rejects').run().changes
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/**
 * Recompute on-hand quantity and average cost from the lots that just landed.
 *
 * This is what makes concurrent stock work safe. The lots are the authored
 * facts — one row per receipt, each with its own id, so two people receiving the
 * same product at the same moment create two different rows and neither is lost.
 * The quantity is arithmetic over those rows, so it is recomputed here rather
 * than shipped and arbitrated.
 *
 * Only the products a batch touched are rebuilt. Rebuilding everything would
 * zero the on-hand of every product whose lots have not synced down yet, which
 * on a laptop's first pull is most of the catalog.
 */
export function rebuildDerivedStock(productIds: string[]): number {
  if (productIds.length === 0) return 0
  const db = getDb()
  let changed = 0

  const run = db.transaction(() => {
    setApplying(db, true)
    try {
      for (const productId of productIds) {
        const exists = db
          .prepare('SELECT 1 FROM inventory_products WHERE id = ?')
          .get(productId)
        if (!exists) continue

        const perLocation = db
          .prepare(
            `SELECT location, COALESCE(SUM(qty_remaining), 0) AS qty
             FROM inventory_lots WHERE product_id = ? GROUP BY location`
          )
          .all(productId) as Array<{ location: string; qty: number }>
        const wanted = new Map(perLocation.map((r) => [r.location, normQty(r.qty)]))

        const current = db
          .prepare('SELECT id, location, quantity FROM inventory_stock WHERE product_id = ?')
          .all(productId) as Array<{ id: string; location: string; quantity: number }>

        for (const row of current) {
          const target = wanted.get(row.location) ?? 0
          if (Math.abs(row.quantity - target) > 1e-9) {
            db.prepare('UPDATE inventory_stock SET quantity = ? WHERE id = ?').run(target, row.id)
            changed += 1
          }
          wanted.delete(row.location)
        }
        // Locations that have lots here but no stock row yet — a product first
        // received on another laptop.
        for (const [location, qty] of wanted) {
          db.prepare(
            'INSERT INTO inventory_stock (id, product_id, location, quantity) VALUES (?, ?, ?, ?)'
          ).run(randomUUID(), productId, location, qty)
          changed += 1
        }

        // Average cost follows the same rule: derived from the surviving lots,
        // not from whichever laptop wrote the product row most recently.
        const total = db
          .prepare(
            'SELECT COALESCE(SUM(qty_remaining), 0) AS q FROM inventory_lots WHERE product_id = ?'
          )
          .get(productId) as { q: number }
        if (total.q > 0) {
          db.prepare('UPDATE inventory_products SET unit_cost = ? WHERE id = ?').run(
            lotWeightedAvgCost(db, productId),
            productId
          )
        }
      }
    } finally {
      setApplying(db, false)
    }
  })
  run()
  return changed
}

/**
 * Recompute a supply's on-hand from its own movements.
 *
 * `supplies.quantity` cannot be arbitrated between machines — see NEVER_OVERWRITE
 * above. The movements can: every purchase, use and adjustment is a row with its
 * own id, they all sync, and none of them collide. So the count is recovered by
 * adding them up, exactly as inventory_stock is recovered from its lots.
 * `createSupply` logs its opening quantity as a purchase precisely so this
 * identity holds from the first row.
 *
 * TIMING IS PART OF THE CORRECTNESS. This must run only when a pull has fully
 * drained, never per batch: tier ordering holds INSIDE a batch, not across them,
 * so a supply landing in one batch with its purchases still in the next would
 * rebuild against half a history and settle on a negative count. Call it once,
 * at the end, when there is no more to come.
 *
 * A supply with no movements at all is left alone. That is not the same as "it
 * holds zero" — it is a row nobody has recorded anything for on any machine, and
 * rewriting its count to zero would be inventing a fact.
 */
export function rebuildDerivedSupplyStock(supplyIds: string[]): number {
  if (supplyIds.length === 0) return 0
  const db = getDb()
  let changed = 0

  const run = db.transaction(() => {
    setApplying(db, true)
    try {
      for (const id of supplyIds) {
        const row = db.prepare('SELECT quantity FROM supplies WHERE id = ?').get(id) as
          | { quantity: number }
          | undefined
        if (!row) continue
        const agg = db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(quantity_change), 0) AS q
               FROM supply_transactions WHERE supply_id = ?`
          )
          .get(id) as { n: number; q: number }
        if (agg.n === 0) continue
        const target = Math.round(agg.q)
        if (target !== row.quantity) {
          db.prepare('UPDATE supplies SET quantity = ? WHERE id = ?').run(target, id)
          changed += 1
        }
      }
    } finally {
      setApplying(db, false)
    }
  })
  run()
  return changed
}

/**
 * Re-attempt everything currently quarantined.
 *
 * A rejected row used to be rejected forever: the cursor advances past it, and
 * nothing ever fetches it again. That is survivable when the row is merely
 * missing from a screen — and not survivable once a COUNT is derived from those
 * rows, because one quarantined movement becomes a permanently wrong number on
 * the shelf.
 *
 * Most rejections are a child arriving before its parent, which fixes itself the
 * moment the parent lands. Replaying costs nothing when the quarantine is empty
 * and clears itself when it is not; a row that still fails simply stays put with
 * its reason updated.
 */
export function retryRejects(): {
  retried: number
  recovered: number
  touchedProducts: string[]
  touchedSupplies: string[]
} {
  const rows = getDb()
    .prepare(`SELECT kind, id, seq, data FROM sync_rejects WHERE data IS NOT NULL ORDER BY seq ASC`)
    .all() as Array<{ kind: string; id: string; seq: number; data: string | null }>
  if (rows.length === 0) {
    return { retried: 0, recovered: 0, touchedProducts: [], touchedSupplies: [] }
  }
  const before = rejectCount()
  // What the replay touched is REPORTED, not swallowed. A lot that lands here
  // rather than on its first attempt is a lot whose product's on-hand is now
  // wrong, and the caller is the only thing positioned to rebuild it — this
  // returning nothing but a count is what left shelves reading "0 counted, 11 in
  // layers" on a machine that had every lot and no quantity to go with them.
  const applied = applyRows(
    rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      seq: r.seq,
      updated_at: '',
      deleted: 0 as const,
      data: r.data
    }))
  )
  return {
    retried: rows.length,
    recovered: Math.max(0, before - rejectCount()),
    touchedProducts: applied.touchedProducts,
    touchedSupplies: applied.touchedSupplies
  }
}

/**
 * Report (do not throw on) any product whose stock and lots disagree.
 *
 * The app's own invariant check throws, which is right inside a transaction that
 * should not have happened. After a sync it is the wrong shape: a disagreement
 * here means two people did contradictory things to the same product while
 * offline, which is a fact to show someone, not a crash.
 */
export function stockDrift(): StockDrift[] {
  return (
    getDb()
      .prepare(
        `SELECT k.product_id AS pid, p.name AS name, k.location AS loc,
                COALESCE(s.quantity, 0) AS stock,
                COALESCE(l.qty, 0) AS lots
           FROM (SELECT product_id, location FROM inventory_stock
                 UNION
                 SELECT product_id, location FROM inventory_lots WHERE qty_remaining > 0) k
           JOIN inventory_products p ON p.id = k.product_id
           LEFT JOIN inventory_stock s
             ON s.product_id = k.product_id AND s.location = k.location
           LEFT JOIN (SELECT product_id, location, SUM(qty_remaining) AS qty
                        FROM inventory_lots WHERE qty_remaining > 0
                       GROUP BY product_id, location) l
             ON l.product_id = k.product_id AND l.location = k.location
          ORDER BY p.name COLLATE NOCASE, k.location`
      )
      .all() as Array<{ pid: string; name: string; loc: string; stock: number; lots: number }>
  )
    .filter((r) => Math.abs(r.stock - r.lots) > 1e-6)
    .map((r) => ({
      productId: r.pid,
      name: r.name,
      location: r.loc,
      stock: r.stock,
      lots: r.lots
    }))
}

/**
 * Put every drifted shelf back onto its cost layers.
 *
 * The deliberate hammer, and the reason it is manual rather than part of the
 * sync round: the two directions of drift do not look different from here. A
 * shelf holding lots and no quantity is the fingerprint of a lot that reached
 * this machine while its rebuild did not — and it is ALSO what an orphan layer
 * on a shelf somebody emptied looks like, which `zeroShelf` sweeps and this
 * would resurrect. Running it automatically would mean guessing which; running
 * it from a screen that lists the shelves first means somebody reads them and
 * decides.
 *
 * On a machine that only ever received this data — the web server, a laptop
 * that joined — there is nothing to decide: every quantity there is derived,
 * so the layers are simply right.
 */
export function repairDerivedStock(): { shelves: number; changed: number } {
  const drift = stockDrift()
  if (drift.length === 0) return { shelves: 0, changed: 0 }
  const products = [...new Set(drift.map((d) => d.productId))]
  return { shelves: drift.length, changed: rebuildDerivedStock(products) }
}

/**
 * Is this a blank machine about to join an existing installation?
 *
 * "Blank" means nobody has ever set it up: zero employees, and no data pulled
 * yet. Everything such a database contains is the boilerplate every install
 * seeds for itself — the 122-product starter catalog — carrying ids this machine
 * invented that nobody else has ever seen.
 *
 * Those ids are the problem. Left in place, every one of them collides with the
 * relay's copy of the same product on its UPC, and the second laptop starts life
 * with a hundred conflicts to resolve for no reason.
 */
export function isBlankJoiner(): boolean {
  const db = getDb()
  const employees = db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number }
  return employees.n === 0 && cursor() === 0
}

/**
 * Clear the local boilerplate so the shared version can land cleanly.
 *
 * Runs with the capture triggers suppressed and empties the outbox afterwards:
 * these deletions are this machine discarding its own placeholder data, not a
 * decision anyone else should hear about. Queueing them would push a hundred
 * tombstones at the relay and delete the real catalog for everybody.
 */
export function clearForJoin(): number {
  const db = getDb()
  let removed = 0
  const run = db.transaction(() => {
    setApplying(db, true)
    try {
      db.pragma('defer_foreign_keys = ON')
      // Reverse tier order: children first, so the deletes are legal even
      // without relying on cascades.
      const tables = [...SYNCED_TABLES].sort((a, b) => b.tier - a.tier)
      for (const spec of tables) {
        try {
          removed += db.prepare(`DELETE FROM ${spec.table}`).run().changes
        } catch {
          // A table this version does not have.
        }
      }
      db.prepare('DELETE FROM sync_outbox').run()
    } finally {
      setApplying(db, false)
    }
  })
  run()
  return removed
}

/** Every table the manifest covers that this database actually has. */
export function syncedTableNames(): string[] {
  const present = new Set(
    (
      getDb()
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  )
  return SYNCED_TABLES.filter((s) => present.has(s.table)).map((s) => s.table)
}

/** Column cache reset — only needed by tests that reopen the file. */
export function resetSyncCaches(): void {
  columnCache.clear()
}
