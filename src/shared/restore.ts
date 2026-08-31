import type { BackupCounts } from './backup'
import { CURRENT_SCHEMA_VERSION, describeBackup } from './backup'

/**
 * PUTTING A BACKUP BACK.
 *
 * The download half of this feature shipped first, and the owner's next
 * question was the right one: "how do I re-upload the database that I
 * download, just in case". Until this, the honest answer was bad. On a laptop
 * you could swap the file by hand. On the web app the database sits on a Render
 * disk and Render's Shell is a TERMINAL — there is no upload button — so
 * putting a file back meant hosting it somewhere public and fetching it with
 * curl, invented from scratch on the worst day of the year. A backup nobody can
 * restore is, as the docs already said about an untested one, a hypothesis.
 *
 * ## Restore is not the mirror image of backup, and pretending it is would be dangerous
 *
 * Taking a copy touches nothing. Putting one back destroys the present. Three
 * specific hazards drove every decision in this file, and none of them are
 * visible from the outside:
 *
 * **1. It can silently roll the whole team backwards.** The relay resolves
 * conflicts last-write-wins on `updated_at`. Restore a month-old file and let
 * this machine push, and every stale row beats everybody's current work — a
 * one-machine recovery becomes a company-wide data loss. So a restore puts THIS
 * machine back and then catches up: the outbox is emptied, the cursor reset,
 * the device re-identified. The restored rows are never announced as news.
 *
 * That is also the honest limit, and the screen says it out loud: this fixes
 * YOUR copy. It does not roll everyone else back. Rolling a whole company back
 * is a different operation with a different blast radius, and quietly doing it
 * because somebody clicked Restore would be indefensible.
 *
 * **2. A newer file in an older app corrupts everyone.** `migrate()` would run,
 * stamp `schema_version` DOWNWARD, and then push column-truncated rows at the
 * relay. `syncTables.ts` names this exactly: "how you corrupt every database at
 * once". A newer file is therefore a hard refusal — not a warning somebody can
 * click through, because the person clicking cannot see the consequence and it
 * lands on other people.
 *
 * **3. The file cannot be swapped under a running process.** Nothing quiesces
 * in-flight work, and a process holding handles to a database that no longer
 * exists keeps serving from them until it doesn't. So the swap happens at boot,
 * before anything opens the database, armed by a marker on disk.
 *
 * ## Every refusal happens BEFORE anything is moved
 *
 * The staged file is checked while the live database is still untouched, so a
 * bad upload costs nothing but the upload. That ordering is the whole safety
 * argument, and it is why staging and swapping are separate steps rather than
 * one convenient function.
 */

/**
 * Why a file cannot be restored, or what to be careful of if it can.
 *
 * Split into two kinds deliberately. A `blocker` is the app refusing; a
 * `warning` is the app making sure somebody has seen something before they
 * agree to it. Collapsing them into one list would either let a corrupting file
 * through behind a checkbox, or make an ordinary older backup look forbidden.
 */
export type RestoreBlockerCode =
  | 'not-a-database'
  | 'corrupt'
  | 'not-rmops'
  | 'schema-too-new'
  | 'empty'

export interface RestoreProblem {
  code: RestoreBlockerCode | 'older-schema' | 'fewer-rows' | 'no-employees'
  /** Said in the words of somebody who runs a card business, not a database. */
  message: string
}

/** What the uploaded file turned out to be. */
export interface RestoreFileFacts {
  filename: string
  bytes: number
  schemaVersion: number | null
  counts: BackupCounts
  /**
   * When the backup was taken, if the file says.
   *
   * Read from the newest `updated_at` in the file rather than the filesystem
   * timestamp: a file that has been copied between machines and cloud drives
   * carries whatever mtime the last copy gave it, which is routinely today.
   * "Taken today" printed over a file from March is precisely the reassurance
   * somebody must not be given here.
   */
  takenAt: string | null
}

/**
 * The answer to "what happens if I press the button", computed before it is
 * pressed.
 */
export interface RestoreCheck {
  ok: boolean
  file: RestoreFileFacts
  /** What this machine holds right now — the thing being traded away. */
  current: BackupCounts
  blockers: RestoreProblem[]
  warnings: RestoreProblem[]
  /** Opaque handle for the staged file, passed back to confirm. */
  stageId: string | null
}

/**
 * Is this file safe to load into a build writing `runningVersion`?
 *
 * OLDER IS FINE, NEWER IS NOT, and the asymmetry is the point. An older file is
 * the ordinary case — every backup becomes older the moment it is taken — and
 * `migrate()` exists precisely to bring it forward. A newer file is the
 * dangerous one, and there is no safe way to handle it in an older build, so it
 * is refused rather than negotiated.
 */
export function schemaIsRestorable(
  fileVersion: number | null,
  runningVersion: number = CURRENT_SCHEMA_VERSION
): boolean {
  if (fileVersion === null || !Number.isFinite(fileVersion)) return false
  return fileVersion <= runningVersion
}

/**
 * The sentence shown where the file's age matters.
 *
 * Days rather than a date, because "23 days old" is a judgement somebody can
 * make instantly and "2026-08-08" is one they have to do arithmetic on while
 * worried.
 */
export function describeBackupAge(takenAt: string | null, now: Date = new Date()): string {
  if (!takenAt) return 'from an unknown date'
  const then = new Date(takenAt)
  if (!Number.isFinite(then.getTime())) return 'from an unknown date'
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000)
  if (days <= 0) return 'taken today'
  if (days === 1) return 'taken yesterday'
  if (days < 45) return `taken ${days} days ago`
  const months = Math.round(days / 30)
  return `taken about ${months} months ago`
}

/**
 * "128 products and 12 purchase orders, taken 23 days ago" — one line naming
 * what is about to REPLACE what is here.
 *
 * Deliberately built from the same `describeBackup` the download panel and its
 * toast use. The owner has already read that sentence describing their live
 * database; meeting it again describing the incoming file is what makes the
 * comparison land without a legend.
 */
export function describeRestore(file: RestoreFileFacts, now: Date = new Date()): string {
  return `${describeBackup(file.counts)}, ${describeBackupAge(file.takenAt, now)}`
}

/**
 * The counts that will FALL if this file is restored, loudest first.
 *
 * This exists because a bare pair of numbers does not read as a loss. Somebody
 * looking at "products 335" beside "products 128" has to notice the direction
 * themselves, and people confirming a restore are rarely calm. Naming the drops
 * turns a table into a sentence: you are about to lose 207 products.
 *
 * Only DROPS are listed. A restore that brings more rows than it removes is not
 * the failure anybody needs warning about.
 */
export function restoreLosses(
  current: BackupCounts,
  incoming: BackupCounts
): Array<{ label: string; from: number; to: number; lost: number }> {
  const rows: Array<[keyof BackupCounts, string]> = [
    ['products', 'products'],
    ['purchaseOrders', 'purchase orders'],
    ['salesOrders', 'sales orders'],
    ['timeEntries', 'timesheet entries'],
    ['ledgerRows', 'ledger rows']
  ]
  return rows
    .map(([key, label]) => ({
      label,
      from: current[key],
      to: incoming[key],
      lost: current[key] - incoming[key]
    }))
    .filter((r) => r.lost > 0)
    .sort((a, b) => b.lost - a.lost)
}

/**
 * What the owner has to type to confirm.
 *
 * A typed word rather than a second button, following the order-reset card. The
 * cost of a mis-click here is the current database, and the whole value of a
 * typed confirmation is that it cannot be produced by muscle memory — you
 * cannot type RESTORE while thinking about something else.
 */
export const RESTORE_CONFIRM_WORD = 'RESTORE'

export function restoreConfirmed(typed: string): boolean {
  return typed.trim().toUpperCase() === RESTORE_CONFIRM_WORD
}

/**
 * What the swap did, left on disk by the boot that performed it and read back
 * once by the panel afterwards.
 *
 * It has to survive a process restart, which is why it is a file rather than a
 * return value: the code that performs the restore and the screen that reports
 * it are separated by the app shutting down and starting again. Without this
 * the owner presses Restore, the app disappears, it comes back, and nothing
 * anywhere says whether it worked.
 */
export interface RestoreOutcome {
  ok: boolean
  filename: string
  /** Where the database that was replaced now lives, when one was. */
  replacedPath?: string
  error?: string
  at: string
}

/** Everything the Restore panel needs in one read. */
export interface RestoreStatus {
  /** The upload waiting to be judged, or null when none is. */
  staged: RestoreCheck | null
  /** True between confirming and the restart actually happening. */
  armed: boolean
  /** The result of the last swap, shown once and then forgotten. */
  lastOutcome: RestoreOutcome | null
  /**
   * The databases previous restores displaced, newest first.
   *
   * Surfaced because they are full copies of the database and nothing else in
   * the app would ever mention them. Somebody hunting through three backups for
   * the right one can quietly put three more copies on the disk.
   */
  keptCopies: Array<{ name: string; bytes: number; at: string }>
}
