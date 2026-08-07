import type Database from 'better-sqlite3'
import type {
  ShipImportDeletePlan,
  ShipImportDeleteResult,
  ShipImportDeleteWorker
} from '@shared/shippingViews'
import { holderOf } from '@shared/shipStations'
import { getDb } from './database'
import { getEmployeeById } from './employees'
import { claimsForOrder } from './shipClaims'
import {
  clearShipDataset,
  clearShipDocument,
  getShipDataCounts,
  getShipEvent,
  getShipImport,
  hasShipDataset,
  listShipImports,
  listShipShipments,
  listShipSnapshots,
  listShipTeamSlots,
  pruneShipBreakAssignments
} from './shipping'
import { localDateKey } from './shippingCalendar'
import { listOrders } from './shippingDomain'

/**
 * Undoing an upload.
 *
 * A packing slip could be imported and never removed, so a wrong PDF — or the
 * second copy of a show somebody uploaded twice — sat in the workspace for good.
 * This is the way back out.
 *
 * ## Why this is its own file
 *
 * The same reason `shipClaims.ts` is: it would close a cycle. Clearing a show
 * means reaching into `shipping.ts`, `shippingDomain.ts` and the claim reads at
 * once, and every one of those is imported by one of the others — so the delete
 * cannot live in any of them. It sits above all three instead and orchestrates
 * them, which is also what it is: an orchestration, not a DELETE.
 *
 * ## What an import actually owns
 *
 * Less than the History tab's wording implied, and the difference decides almost
 * everything below. **The workspace holds ONE dataset at a time.** `ship_orders`,
 * `ship_team_slots`, `ship_customers` and the rest carry no `import_id` because
 * they do not need one: they belong to the newest import, and every earlier
 * import's rows were overwritten the moment it was replaced.
 *
 * So there are two deletes wearing one name:
 *
 *   THE LIVE IMPORT   owns the dataset on the floor. Deleting it empties the
 *                     workspace — genuinely empties it, because the import it
 *                     replaced left no rows to fall back to. Nothing can
 *                     "become live again"; pretending otherwise would put a
 *                     summary on screen counting rows that do not exist.
 *   AN EARLIER ONE    owns a log row, its work claims and its break assignments,
 *                     and nothing else. Deleting it must be almost inert — in
 *                     particular it must not sweep somebody off a break they are
 *                     standing at right now.
 *
 * ## The chain is spliced, never broken
 *
 * `ship_imports.carried_from` is the edge a work claim's liveness is derived
 * from. Deleting a link in the middle of it and leaving the successor pointing
 * at a row that no longer exists would truncate the chain there — every import
 * behind it falls off, and every claim and assignment made against those goes
 * inert with no row anywhere having been written to say so. So the successor is
 * re-pointed at the deleted import's own predecessor. That is what deleting a
 * link in a chain means, and the chain comes out one shorter and still whole.
 *
 * The rows stamped with the deleted import move the same way, and for the same
 * reason: carry-forward means the two imports describe ONE continuing run of
 * work on one show, so a claim or an assignment made under the earlier one is
 * still true under the later one. Only when nothing carried forward from it —
 * which is always the case for the live import, since it is the head — is there
 * nowhere to move them to, and they go with it.
 *
 * ## It moves no stock, and there is none for it to move
 *
 * A delete used to hand a show's consumables back, because ticking a checklist
 * step had taken them off the shelf and booked their cost to the show's day.
 * Nothing takes stock off the shelf for a show any more, so there is nothing to
 * return and nothing to ask the operator to agree to. Packaging is modelled from
 * the shape of the night instead — and no longer booked anywhere, since the owner
 * took the cost off the P&L — so a delete has no cost to reverse either way.
 *
 * ## Snapshots are left alone
 *
 * `ship_snapshots` is deliberately not cleared by an import, and for the same
 * reason it is not cleared by a delete: it is the ONE artifact that lets a show
 * stay reportable after its dataset is gone. Sweeping it here would mean the
 * delete destroys the only surviving record of the night, silently, as a side
 * effect of removing a log row. The History tab already offers deleting a
 * capture on its own, with its own confirmation.
 */

// ---------------------------------------------------------------------------
// Reading the chain
// ---------------------------------------------------------------------------

interface ChainRow {
  id: string
  name: string | null
  carried_from: string | null
}

function importRow(db: Database.Database, id: string): ChainRow | null {
  const row = db.prepare(`SELECT id, name, carried_from FROM ship_imports WHERE id = ?`).get(id) as
    | ChainRow
    | undefined
  return row ?? null
}

/** The import that carried forward FROM this one, if any. At most one exists. */
function successorOf(db: Database.Database, id: string): ChainRow | null {
  const row = db
    .prepare(
      `SELECT id, name, carried_from FROM ship_imports
        WHERE carried_from = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(id) as ChainRow | undefined
  return row ?? null
}

function countOf(db: Database.Database, table: string, column: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
    n: number
  }
  return row.n
}

function money(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

function employeeName(id: string | null): string | null {
  if (!id) return null
  const emp = getEmployeeById(id)
  if (!emp) return null
  return `${emp.firstName} ${emp.lastName}`.trim() || emp.companyId || null
}

/**
 * Who has an order in their hands right now.
 *
 * Derived, exactly as every other reader of this table derives it — `holderOf`
 * over the claim rows — rather than "rows with no finished_at", which would
 * count a bench somebody walked away from three hours ago as somebody working.
 */
function workingNow(): ShipImportDeleteWorker[] {
  const now = Date.now()
  const out: ShipImportDeleteWorker[] = []
  for (const order of listOrders()) {
    const claims = claimsForOrder(order.id, order.customerId)
    for (const role of ['pick', 'pack'] as const) {
      const held = holderOf(claims, role, now)
      if (!held) continue
      out.push({
        name: employeeName(held.operatorId ?? held.loginUserId),
        role,
        handle: order.customer.handle || order.customerId
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Everything the delete would destroy, before a single row is written.
 *
 * A pure read, and the only source the confirmation is allowed to draw on — the
 * numbers on the dialog and the numbers the delete acts on come from one
 * function, so the two can never say different things.
 */
export function planShipImportDelete(id: string): ShipImportDeletePlan | null {
  const db = getDb()
  const record = getShipImport(id)
  if (!record) return null
  const successor = successorOf(db, id)

  // The newest import owns the dataset — but only while there IS one. A
  // workspace that has already been emptied (its show deleted, or the dataset
  // cleared) leaves its newest import holding nothing, and calling that one
  // "live" would have the confirmation promise to empty a workspace that is
  // already empty and claim a day it can no longer prove is its.
  const isLive = (listShipImports()[0]?.id ?? null) === id && hasShipDataset()

  const counts = isLive ? getShipDataCounts() : null
  const shipments = isLive ? listShipShipments() : []
  const slots = isLive ? listShipTeamSlots() : []
  const event = isLive ? getShipEvent() : null
  const eventDate = event?.date.trim() || null

  const working = isLive ? workingNow() : []
  const claims = countOf(db, 'ship_work_claims', 'import_id', id)
  const assignments = countOf(db, 'ship_break_assignments', 'import_id', id)

  // Snapshots are attributed the way the calendar attributes them: the local
  // day they were captured on. They are counted to be REASSURING — the delete
  // does not touch them — so an approximate match is the right kind of wrong.
  const importDay = localDateKey(record.createdAt)
  const snapshots = importDay
    ? listShipSnapshots().filter((s) => localDateKey(s.createdAt) === importDay).length
    : 0

  const cardsPicked = counts?.checkedSlots ?? 0
  const packagesPacked = shipments.filter((s) => !!s.packedAt).length

  return {
    importId: record.id,
    name: record.name,
    filename: record.filename,
    createdAt: record.createdAt,
    isLive,
    carriedToId: successor?.id ?? null,
    carriedToName: successor?.name ?? null,
    packages: counts?.shipments ?? 0,
    packagesPacked,
    cards: counts?.teamSlots ?? 0,
    cardsPicked,
    breaks: counts?.breaks ?? 0,
    value: money(slots.reduce((n, s) => n + s.price, 0)),
    claims,
    assignments,
    working,
    eventName: event?.name.trim() || null,
    eventDate,
    snapshots,
    // Two clicks for a mis-import nobody has touched; an acknowledgement the
    // moment the delete would interrupt somebody or throw away work that was
    // really done.
    needsAcknowledgement: working.length > 0 || cardsPicked > 0 || packagesPacked > 0
  }
}

// ---------------------------------------------------------------------------
// The delete
// ---------------------------------------------------------------------------


/**
 * Delete an import and everything that exists only because of it.
 *
 * ONE transaction. A half-deleted import is a workspace nobody can reconcile:
 * a chain with a hole in it, claims naming orders that are gone, a dataset
 * cleared out from under a show that still has a log row. better-sqlite3 nests
 * the inner transaction (the dataset clear) as a savepoint, so a throw anywhere
 * unwinds the lot.
 */
export function deleteShipImport(id: string): ShipImportDeleteResult {
  const plan = planShipImportDelete(id)
  if (!plan) throw new Error('Import not found.')

  const db = getDb()

  const run = db.transaction((): ShipImportDeleteResult => {
    const row = importRow(db, id)
    if (!row) throw new Error('Import not found.')
    const successor = successorOf(db, id)

    // --- 1. the work stamped with this import -----------------------------
    //
    // Re-homed onto whatever carried forward from it, because that import is
    // the same run of work on the same show — the person on break 11 is still
    // on break 11, and deleting a log row from the middle of a chain has no
    // business taking them off it. Deleted only when nothing carried forward,
    // which is always true of the live import: it is the head of its own chain.
    if (successor) {
      db.prepare(`UPDATE ship_work_claims SET import_id = ? WHERE import_id = ?`).run(
        successor.id,
        id
      )
      db.prepare(`UPDATE ship_break_assignments SET import_id = ? WHERE import_id = ?`).run(
        successor.id,
        id
      )
    } else {
      db.prepare(`DELETE FROM ship_work_claims WHERE import_id = ?`).run(id)
      db.prepare(`DELETE FROM ship_break_assignments WHERE import_id = ?`).run(id)
    }

    // --- 2. splice the chain ----------------------------------------------
    // The successor takes over this import's predecessor. `carried_from` only
    // ever points backwards in time, so this can never close a loop.
    db.prepare(`UPDATE ship_imports SET carried_from = ? WHERE carried_from = ?`).run(
      row.carried_from,
      id
    )

    // --- 3. the file, and the dataset it was parsed into -------------------
    db.prepare(`DELETE FROM ship_documents WHERE import_id = ?`).run(id)
    // The travelling slices go with it. Leaving them would have the next pull
    // reassemble the slip on every OTHER machine — including this one, once the
    // relay handed its own rows back — restoring a document somebody deleted.
    db.prepare(`DELETE FROM ship_document_parts WHERE import_id = ?`).run(id)
    if (plan.isLive) {
      clearShipDataset()
      // The stored PDF belongs to the show, and a row written before imports
      // stamped their documents carries no import_id to match on above.
      clearShipDocument()
    }

    // Deleting the NEWEST import moves the head of the chain, and a claim is
    // live purely because its import sits on that chain — so an older import's
    // claims, inert a moment ago, wake up. Against a dataset that is gone they
    // would name orders nobody can open: the bench board would show people
    // working nothing, which is exactly the half-state a delete must not leave.
    //
    // Scoped to claims whose order AND customer are both absent, because a
    // claim is resolved by either. When the workspace has just been emptied
    // that is every one of them, and it has to be.
    if ((listShipImports()[0]?.id ?? null) === id) {
      db.prepare(
        `DELETE FROM ship_work_claims
          WHERE order_id NOT IN (SELECT id FROM ship_shipments)
            AND customer_id NOT IN (SELECT id FROM ship_customers)`
      ).run()
    }

    // --- 4. the log row itself --------------------------------------------
    const res = db.prepare(`DELETE FROM ship_imports WHERE id = ?`).run(id)
    if (res.changes === 0) throw new Error('Import not found.')

    // Assignments whose break went with the dataset, and any left pointing at
    // an import that is no longer on the chain.
    pruneShipBreakAssignments(db)

    return { plan, workspaceCleared: plan.isLive }
  })

  return run()
}
