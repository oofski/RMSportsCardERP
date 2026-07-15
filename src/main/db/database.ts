import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'

let db: Database.Database | null = null

/**
 * Initialise (and memoise) the SQLite database. The file lives in the app's
 * per-user data directory so it survives updates and uninstalls (unless the
 * user opts to wipe app data).
 *
 * SQLite is used deliberately: it shares a dialect with Cloudflare D1, so when
 * RM Cardz moves to a shared cloud database the schema and queries port over
 * with minimal change.
 */
export function getDb(): Database.Database {
  if (db) return db

  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = join(dir, 'rm-operations.db')

  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

/** Idempotent schema setup. Uses a schema_version row so future migrations can
 * be layered in without destroying existing data. */
function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS employees (
      id                   TEXT PRIMARY KEY,
      first_name           TEXT NOT NULL,
      last_name            TEXT NOT NULL,
      company_id           TEXT NOT NULL UNIQUE COLLATE NOCASE,
      title                TEXT NOT NULL DEFAULT '',
      email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role                 TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'invited',
      password_hash        TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      permissions_json     TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      created_by           TEXT
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id          TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL,
      clock_in    TEXT NOT NULL,
      clock_out   TEXT,
      note        TEXT,
      source      TEXT NOT NULL DEFAULT 'manual',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_time_entries_employee
      ON time_entries (employee_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         TEXT PRIMARY KEY,
      actor_id   TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
  `)

  if (getMeta(database, 'schema_version') === null) {
    setMeta(database, 'schema_version', '1')
  }

  // --- Migration to v2: geolocation on time entries -----------------------
  // Additive columns, applied idempotently so existing v0.0.0 databases
  // upgrade cleanly on first launch of a newer build.
  addColumnIfMissing(database, 'time_entries', 'clock_in_lat', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_in_lng', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_in_place', 'TEXT')
  addColumnIfMissing(database, 'time_entries', 'clock_out_lat', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_out_lng', 'REAL')
  addColumnIfMissing(database, 'time_entries', 'clock_out_place', 'TEXT')
  setMeta(database, 'schema_version', '2')
}

/** Add a column only if the table doesn't already have it (safe re-run). */
function addColumnIfMissing(
  database: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}

export function getMeta(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
