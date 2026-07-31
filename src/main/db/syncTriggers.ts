import type { Database } from 'better-sqlite3'
import { SYNCED_TABLES, keyExpr, type SyncedTable } from './syncTables'

/**
 * Capture triggers: how a change gets noticed.
 *
 * The app writes to the database from roughly 180 IPC handlers, plus migrations,
 * plus raw SQL in a dozen repositories. Instrumenting every one of those call
 * sites to also record "I changed product X" would be a week of work and would
 * be wrong within a month, because the one call site somebody forgets is the one
 * whose changes silently never leave the building.
 *
 * Triggers sit underneath all of it. Anything that modifies a synced table —
 * a handler, a migration, a cascade, a hand-typed UPDATE — lands in the outbox,
 * with no cooperation required from the code that did it.
 */

const TS = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

function enqueue(kind: string, key: string, deleted: 0 | 1): string {
  return `
    INSERT INTO sync_outbox (kind, id, updated_at, deleted)
    VALUES ('${kind}', ${key}, ${TS}, ${deleted})
    ON CONFLICT (kind, id) DO UPDATE
      SET updated_at = excluded.updated_at, deleted = excluded.deleted;`
}

/**
 * The guard every trigger carries.
 *
 * Applying a row pulled from the relay is an ordinary write, so without this it
 * would be queued straight back up and the same row would ping-pong between two
 * laptops forever, each round marking it changed again.
 */
const NOT_APPLYING = `WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0`

function triggersFor(spec: SyncedTable): string {
  const t = spec.table
  return `
    DROP TRIGGER IF EXISTS sync_out_${t}_ins;
    CREATE TRIGGER sync_out_${t}_ins AFTER INSERT ON ${t}
    ${NOT_APPLYING}
    BEGIN${enqueue(t, keyExpr(spec, 'NEW'), 0)}
    END;

    DROP TRIGGER IF EXISTS sync_out_${t}_upd;
    CREATE TRIGGER sync_out_${t}_upd AFTER UPDATE ON ${t}
    ${NOT_APPLYING}
    BEGIN${enqueue(t, keyExpr(spec, 'NEW'), 0)}
    END;

    DROP TRIGGER IF EXISTS sync_out_${t}_del;
    CREATE TRIGGER sync_out_${t}_del AFTER DELETE ON ${t}
    ${NOT_APPLYING}
    BEGIN${enqueue(t, keyExpr(spec, 'OLD'), 1)}
    END;
  `
}

/**
 * (Re)install every capture trigger. Idempotent, and safe to run on each launch:
 * the DROP/CREATE pair means an app version that adds a synced table, or changes
 * a key, gets correct triggers without a bespoke migration.
 */
export function installSyncTriggers(db: Database): void {
  // Foreign-key cascades must fire triggers too, or deleting a product would
  // remove its stock, lots and transactions locally while every other laptop
  // kept them. SQLite only fires triggers for cascade actions when recursive
  // triggers are on, and this database has no other triggers for the setting to
  // affect.
  db.pragma('recursive_triggers = ON')

  const present = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  )

  const sql = SYNCED_TABLES.filter((s) => present.has(s.table)).map(triggersFor).join('\n')
  if (sql.trim()) db.exec(sql)
}

/**
 * Queue every existing row for upload.
 *
 * Triggers only see changes made from now on, so the first laptop to connect
 * would otherwise share nothing but its future edits. This seeds the outbox with
 * the whole database once, which is what makes "turn it on and everyone sees the
 * catalog" true rather than "everyone sees the catalog eventually, as it is
 * edited".
 *
 * Runs on the machine holding the real data. Every other laptop pulls the result
 * rather than repeating this.
 */
export function queueEverything(db: Database): number {
  const present = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  )

  let total = 0
  const run = db.transaction(() => {
    for (const spec of SYNCED_TABLES) {
      if (!present.has(spec.table)) continue
      const key =
        spec.key.length === 1
          ? `CAST(${spec.key[0]} AS TEXT)`
          : spec.key.map((c) => `CAST(${c} AS TEXT)`).join(` || '|' || `)
      const info = db
        .prepare(
          `INSERT INTO sync_outbox (kind, id, updated_at, deleted)
           SELECT '${spec.table}', ${key}, ${TS}, 0 FROM ${spec.table}
           WHERE true
           ON CONFLICT (kind, id) DO UPDATE
             SET updated_at = excluded.updated_at, deleted = 0`
        )
        .run()
      total += info.changes
    }
  })
  run()
  return total
}
