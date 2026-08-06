/**
 * Drop-in stand-in for `better-sqlite3`, backed by the Durable Object adapter.
 *
 * This is the whole experiment. `tests/build.mjs` can alias the `better-sqlite3`
 * import to this module, which means every existing test suite runs the REAL
 * src/main/db code — unedited, all 45 schema versions, every trigger — against a
 * database that can only do what a Durable Object can do. Nothing in src/main is
 * modified, so a suite that passes here passes for the right reason.
 *
 * Enabled by RMOPS_SQL_ADAPTER=1. Absent that, tests use the real better-sqlite3
 * exactly as before.
 */
import { DatabaseSync } from 'node:sqlite'
import { AdaptedDatabase } from '../../src/server/sqlAdapter'
import { DoStorageStub } from './doSqlStorage'

class DurableObjectBackedDatabase extends AdaptedDatabase {
  constructor(path: string, _options?: unknown) {
    // A Durable Object has no file path; the test keeps one so suites that open
    // the same TEST_DB_DIR twice see the same data, which some of them rely on.
    super(new DoStorageStub(new DatabaseSync(path)), path)
  }
}

export = DurableObjectBackedDatabase
