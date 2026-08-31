/**
 * A COPY OF THE DATABASE THE OWNER CAN KEEP.
 *
 * Every figure this business runs on lives in one SQLite file — the products,
 * the cost layers, every order, every timesheet, the whole ledger. On the web
 * app that file is a single Render disk; on a laptop it is one folder. Until
 * this feature there was no way to get a copy of it out of the app: the only
 * procedure was a `VACUUM INTO` typed into a Render shell, which is correct and
 * which nobody does at the moment they need it.
 *
 * ## Sync is not a backup, and this is the distinction the whole feature rests on
 *
 * The relay carries 73 tables between machines so that everybody sees the same
 * data — which means a mistake PROPAGATES rather than being contained. Delete
 * the catalog and the deletion is on every other machine within seconds. A
 * backup is the opposite property: a moment frozen where nothing that happens
 * afterwards can reach it.
 *
 * ## What it deliberately does not hold
 *
 * The product photos. They are files in `product-images/`, not rows, and the
 * owner's call was that a smaller file taken often beats a large one taken
 * rarely. The screen says so plainly rather than leaving somebody to discover
 * it during a restore — see docs/RENDER.md, which backs the folder up
 * separately.
 *
 * ## It is credential material
 *
 * The QuickBooks refresh token and the payment instructions are rows in `meta`,
 * so they are in the file. That is why the whole surface is owner-only, and why
 * the panel says where not to put it.
 */

/**
 * The schema this build writes.
 *
 * It had no name before this. The number existed only as the last of sixty-odd
 * string literals inside a four-thousand-line `migrate()`, and was READ exactly
 * once — a null check to tell a fresh database from an existing one. Nothing
 * ever compared it to anything.
 *
 * Naming it is what lets a backup file say which build produced it, and it is
 * the guard restore will need: an older app opening a newer file today runs its
 * migrations, stamps this number DOWNWARD, and then pushes column-truncated
 * rows at the relay. `syncTables.ts` calls that "how you corrupt every database
 * at once", which is a fair description.
 *
 * KEEP IN STEP with the last `setMeta(database, 'schema_version', …)` in
 * `src/main/db/database.ts`. A test asserts the two agree, because a constant
 * that silently falls behind the thing it names is worse than no constant.
 */
export const CURRENT_SCHEMA_VERSION = 92

/** What the database holds right now, in the words an owner recognises. */
export interface BackupCounts {
  products: number
  purchaseOrders: number
  salesOrders: number
  timeEntries: number
  ledgerRows: number
}

export interface BackupPreview {
  /** The schema the running build writes. See CURRENT_SCHEMA_VERSION. */
  schemaVersion: number
  /** When this reading was taken, as a UTC instant. */
  takenAt: string
  /**
   * Roughly how large the file will be, from SQLite's own page count.
   *
   * An ESTIMATE and named as one: `VACUUM INTO` compacts as it copies, so the
   * file that lands is usually a little smaller than the database in place. A
   * figure that promised exactness and then missed would be worse than one that
   * says what it is.
   */
  estimatedBytes: number
  counts: BackupCounts
}

/** `rmops-backup-2026-08-31.db` — sorts chronologically in any folder. */
export function backupFilename(takenAt: string | Date = new Date()): string {
  const d = typeof takenAt === 'string' ? new Date(takenAt) : takenAt
  const iso = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString()
  return `rmops-backup-${iso.slice(0, 10)}.db`
}

/** "1.4 MB" / "812 KB". Deliberately coarse — this is a size, not a measurement. */
export function formatBackupSize(bytes: number): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 KB'
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One sentence naming what is in the file.
 *
 * Used by the panel BEFORE the download and by the toast AFTER it, from this
 * one function — the same rule `describeOrderReset` follows, and for the same
 * reason: a summary that says something different before and after is how
 * somebody comes to believe a different thing happened.
 *
 * Zero counts are dropped rather than printed. "0 sales orders" on a business
 * that has not raised one is noise, and a list of real numbers reads faster
 * without it.
 */
export function describeBackup(counts: BackupCounts): string {
  const parts: Array<[number, string, string]> = [
    [counts.products, 'product', 'products'],
    [counts.purchaseOrders, 'purchase order', 'purchase orders'],
    [counts.salesOrders, 'sales order', 'sales orders'],
    [counts.timeEntries, 'timesheet entry', 'timesheet entries'],
    [counts.ledgerRows, 'ledger row', 'ledger rows']
  ]
  const said = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n.toLocaleString()} ${n === 1 ? one : many}`)
  if (said.length === 0) return 'an empty database'
  if (said.length === 1) return said[0]
  return `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`
}
