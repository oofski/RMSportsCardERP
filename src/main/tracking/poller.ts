/**
 * The hourly sweep, and the Check now button.
 *
 * Every active purchase order and invoice with a tracking number gets its
 * carrier page read once an hour, and on demand. What "active" means, what
 * "once an hour" means and what may overwrite what all live in
 * @shared/tracking as pure functions — this file is the part that touches the
 * database and the browser.
 *
 * ## Rules that are not negotiable
 *
 * A FAILED READ NEVER TOUCHES THE STATUS, nor `checked_at`. If a status kept
 * its old value but got a fresh "checked just now", the screen would claim the
 * carrier confirmed something it never said.
 *
 * It DOES record the attempt, separately: `attempted_at` means "we asked",
 * `checked_at` means "we got an answer". Writing nothing at all left the card
 * blank, and a blank card cannot tell "nobody has checked yet" from "we checked
 * and the carrier refused" — which need different reactions from a person. A
 * successful read clears the error, or one bad afternoon would leave "check
 * failing" on the card for the rest of the shipment's life.
 *
 * STATUS ONLY MOVES FORWARD. Carriers post late scans, and a page briefly
 * showing an earlier event must not walk a delivered package back to in
 * transit — somebody uses that word to decide whether to open a claim.
 *
 * ONE AT A TIME, WITH A GAP. Fifteen packages an hour read sequentially looks
 * like a person. Fifteen at once looks like a script, and getting blocked takes
 * the working ones down with it.
 *
 * FINISHED PACKAGES ARE NOT RE-READ. Delivered and returned cannot change, and
 * polling them forever spends the whole hour on pages with no news.
 */
import type { ShipStatusCode } from '@shared/shippingTypes'
import { TRACKING_INTERVAL_MS, dueForCheck, shouldAdvance } from '@shared/tracking'
import type { TrackableOrder } from '@shared/tracking'
import { getDb } from '../db/database'
import { readTracking, canRead, trackingGap } from './read'

interface Row extends TrackableOrder {
  table: 'purchase_orders' | 'invoices'
  carrier: string | null
  label: string
}

/**
 * Everything with a tracking number that has not finished its journey.
 *
 * Both tables in one list because the sweep does not care which side of the
 * money a package is on — it is the same carrier, the same page and the same
 * gap between reads, and two separate sweeps would double the request rate for
 * no reason.
 */
export function trackableOrders(): Row[] {
  const db = getDb()
  const pos = db
    .prepare(
      `SELECT id, po_number AS label, carrier, tracking_number, tracking_status, tracking_checked_at
         FROM purchase_orders
        WHERE tracking_number IS NOT NULL AND TRIM(tracking_number) <> ''
          AND status <> 'cancelled'`
    )
    .all() as Array<Record<string, string | null>>
  const invs = db
    .prepare(
      `SELECT id, COALESCE(qbo_doc_number, invoice_number, '') AS label, carrier, tracking_number,
              tracking_status, tracking_checked_at
         FROM invoices
        WHERE tracking_number IS NOT NULL AND TRIM(tracking_number) <> ''
          AND status <> 'void'`
    )
    .all() as Array<Record<string, string | null>>

  const map = (r: Record<string, string | null>, table: Row['table']): Row => ({
    table,
    id: String(r.id),
    label: String(r.label ?? ''),
    carrier: r.carrier ?? null,
    trackingNumber: r.tracking_number ?? null,
    status: (r.tracking_status as ShipStatusCode | null) ?? null,
    checkedAt: r.tracking_checked_at ?? null
  })

  return [...pos.map((r) => map(r, 'purchase_orders')), ...invs.map((r) => map(r, 'invoices'))]
}

function writeStatus(
  table: Row['table'],
  id: string,
  status: ShipStatusCode,
  detail: string | null
): void {
  const at = new Date().toISOString()
  getDb()
    .prepare(
      `UPDATE ${table}
          SET tracking_status = @status,
              tracking_status_detail = @detail,
              tracking_status_at = @at,
              tracking_checked_at = @at,
              -- Cleared on success, or "check failing" would stick to the card
              -- for the rest of the shipment's life after one bad read.
              tracking_error = NULL,
              tracking_attempted_at = @at,
              updated_at = @at
        WHERE id = @id`
    )
    .run({ id, status, detail, at })
}

export interface SweepResult {
  checked: number
  updated: number
  failed: number
  /** Set when the whole sweep could not run at all. */
  error: string | null
}

/**
 * Read every order that is due, one at a time.
 *
 * `force` skips the freshness test but still skips finished packages: a Check
 * now on a delivered order would spend a request confirming what cannot change.
 */
export async function sweepTracking(force = false): Promise<SweepResult> {
  if (!canRead()) {
    return { checked: 0, updated: 0, failed: 0, error: 'Tracking is read by the desktop app.' }
  }
  const due = dueForCheck(trackableOrders(), Date.now(), force)
  let updated = 0
  let failed = 0

  for (const row of due) {
    const read = await readTracking(row.carrier, row.trackingNumber ?? '')
    if (!read.ok || !read.status) {
      // The STATUS is untouched — that rule stands. But the attempt is
      // recorded, because a card that shows nothing cannot tell "nobody has
      // checked" from "we checked and the carrier refused", and those need
      // different reactions from a person.
      writeFailure(row.table, row.id, read.error ?? 'Could not read the carrier page.')
      failed++
    } else if (shouldAdvance(row.status, read.status)) {
      writeStatus(row.table, row.id, read.status, read.detail)
      updated++
    } else {
      // A real read that reports something older than what we hold. The reading
      // succeeded, so the check DID happen and the clock is refreshed; the
      // claim is left alone.
      touchChecked(row.table, row.id)
    }
    await trackingGap()
  }

  return { checked: due.length, updated, failed, error: null }
}

/** Record that we asked and could not get an answer. Never touches the status. */
function writeFailure(table: Row['table'], id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE ${table} SET tracking_error = ?, tracking_attempted_at = ? WHERE id = ?`
    )
    .run(error, new Date().toISOString(), id)
}

function touchChecked(table: Row['table'], id: string): void {
  getDb()
    .prepare(
      `UPDATE ${table}
          SET tracking_checked_at = ?, tracking_attempted_at = ?, tracking_error = NULL
        WHERE id = ?`
    )
    .run(new Date().toISOString(), new Date().toISOString(), id)
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * Start the hourly sweep.
 *
 * Guarded against overlap: a sweep of fifteen packages with a gap between each
 * takes under a minute, but a carrier hanging every request could outlast the
 * hour, and two sweeps reading the same pages at once is exactly the burst this
 * is shaped to avoid.
 *
 * The first sweep is deliberately delayed. Firing at startup would put a burst
 * of carrier requests into the same moment as the app opening its database,
 * restoring its window and starting its sync.
 */
export function startTrackingPoller(): void {
  if (timer || !canRead()) return
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await sweepTracking(false)
    } catch {
      // A sweep that throws must not kill the schedule — the next hour is a
      // perfectly good time to try again.
    } finally {
      running = false
    }
  }
  timer = setInterval(() => void tick(), TRACKING_INTERVAL_MS)
  setTimeout(() => void tick(), 90_000)
}

export function stopTrackingPoller(): void {
  if (timer) clearInterval(timer)
  timer = null
}
