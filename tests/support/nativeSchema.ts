/**
 * Prints the schema the REAL better-sqlite3 driver produces from the app's own
 * migrations, as JSON on stdout.
 *
 * Exists so the adapter spike can diff its schema against ground truth in a
 * separate process — the two drivers cannot be loaded into one bundle, because
 * `better-sqlite3` resolves to exactly one thing per build.
 */
import type { Database } from 'better-sqlite3'
import { getDb } from '../../src/main/db/database'

const db: Database = getDb() as unknown as Database
const rows = db
  .prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
  )
  .all() as Array<{ type: string; name: string; sql: string | null }>

process.stdout.write(
  JSON.stringify(rows.map((r) => `${r.type} ${r.name} ${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`))
)
