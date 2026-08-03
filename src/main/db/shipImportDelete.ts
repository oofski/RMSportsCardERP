import type Database from 'better-sqlite3'
import type {
  ShipImportDeletePlan,
  ShipImportDeleteResult,
  ShipImportDeleteSupply,
  ShipImportDeleteWorker
} from '@shared/shippingViews'
import { holderOf } from '@shared/shipStations'
import { getDb } from './database'
import { getEmployeeById } from './employees'
import { claimsForOrder } from './shipClaims'
import { getShipSopDay, releaseShipSopDay, shipSopShowName } from './shipSop'
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
 * The same reason `shipClaims.ts` is: it would close a cycle. Handing a show's
 * supplies back means calling into `shipSop.ts`, and `shipSop.ts` imports
 * `shipping.ts` and `shippingDomain.ts` — so the delete cannot live in either of
 * them. It sits above all three instead and orchestrates them, which is also
 * what it is: an orchestration, not a DELETE.
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
 * ## Supplies are the dangerous half
 *
 * Ticking a SOP step takes real stock off the shelf and books its cost to the
 * show's DAY, where the P&L reads it. Three things could be done with that on a
 * delete and two of them are wrong:
 *
 *   KEEP IT, DETACHED   leaves cost booked against a show that no longer exists
 *                       — and unreachable, because the checklist is drawn from
 *                       `ship_event` and the delete clears it. Nobody could ever
 *                       untick it again. This is the worst of the three.
 *   REVERSE IT SILENTLY puts stock back that may genuinely have been used.
 *   REVERSE IT, TOLD    what this does.
 *
 * The delete hands the supplies back, and it will not run until the caller has
 * passed `releaseSupplies` — which the confirmation only offers after showing
 * the quantities and the money by name. Main refuses without it rather than
 * trusting the screen to have asked, because the screen is not a trust boundary
 * and this is inventory.
 *
 * The reasoning: deleting an upload says the upload should not have happened,
 * and a show that did not happen consumed nothing. A show that DID happen is one
 * to snapshot and leave alone, not to delete. And when the day's checklist
 * belongs to a different show — two shows can share a date — nothing is touched
 * at all and the plan says whose it is.
 *
 * Nothing here is attributed for an EARLIER import: the SOP is keyed by day, the
 * log row carries no day, and guessing which of two shows on a date a stock
 * movement belonged to is exactly the guess that corrupts a P&L. So an earlier
 * import's delete touches no supply row, and the plan says so.
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

  // Only the live import can name a day, so only the live import can be shown
  // to own a stock movement. Everything else is a guess, and this is the P&L.
  const sopDay = isLive && eventDate ? getShipSopDay(eventDate) : null
  // An unnamed day is treated as this show's, following the same rule the tick
  // guard follows: rows written before the column existed carry NULL, and those
  // must not lock a show out of its own night in either direction.
  const sopIsOurs =
    sopDay && event ? sopDay.owner === null || sopDay.owner === shipSopShowName(event) : false
  const sopDayOwner = sopDay && !sopIsOurs ? sopDay.owner : null
  const sopSupplies: ShipImportDeleteSupply[] =
    sopDay && sopIsOurs
      ? sopDay.lines.map((l) => ({
          role: l.role,
          label: l.label,
          supplyName: l.supplyName,
          quantity: l.quantity,
          cost: l.cost
        }))
      : []

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
  const sopSteps = sopDay && sopIsOurs ? sopDay.steps.length : 0

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
    sopDayOwner,
    sopSteps,
    sopSupplies,
    sopCost: money(sopSupplies.reduce((n, l) => n + l.cost, 0)),
    snapshots,
    // Two clicks for a mis-import nobody has touched; an acknowledgement the
    // moment the delete would move stock, interrupt somebody, or throw away
    // work that was really done.
    needsAcknowledgement: sopSteps > 0 || working.length > 0 || cardsPicked > 0 || packagesPacked > 0
  }
}

// ---------------------------------------------------------------------------
// The delete
// ---------------------------------------------------------------------------

export interface DeleteShipImportOptions {
  /**
   * The operator has been shown what the show's ticked steps took and has
   * agreed to it going back on the shelf. Required — main refuses without it
   * rather than trusting a renderer to have asked.
   */
  releaseSupplies?: boolean
  userId?: string | null
}

/** The refusal, worded with the actual numbers rather than a policy sentence. */
function supplyRefusal(plan: ShipImportDeletePlan): string {
  const parts = plan.sopSupplies
    .map((l) => `${l.quantity.toLocaleString()} ${l.label.toLowerCase()}`)
    .join(', ')
  return (
    `"${plan.name}" has ${plan.sopSteps} SOP ${plan.sopSteps === 1 ? 'step' : 'steps'} ticked off, ` +
    `and ${parts || 'stock'} left the shelf against ${plan.eventDate}` +
    (plan.sopCost > 0 ? ` at a cost of $${plan.sopCost.toFixed(2)}` : '') +
    '. Deleting the show puts all of it back and takes that cost off the day — confirm that first.'
  )
}

/**
 * Delete an import and everything that exists only because of it.
 *
 * ONE transaction. A half-deleted import is a workspace nobody can reconcile:
 * a chain with a hole in it, claims naming orders that are gone, stock returned
 * to a shelf whose show is still on the floor. better-sqlite3 nests the inner
 * transactions (the SOP release, the dataset clear) as savepoints, so a throw
 * anywhere unwinds the lot.
 *
 * The order is load-bearing. The supplies go back BEFORE the dataset is cleared:
 * the release reads its own rows and so would survive either order, but doing it
 * first means a failure to put stock back is a failure to delete, rather than a
 * cleared workspace with the shelf still short.
 */
export function deleteShipImport(
  id: string,
  opts: DeleteShipImportOptions = {}
): ShipImportDeleteResult {
  const plan = planShipImportDelete(id)
  if (!plan) throw new Error('Import not found.')
  if (plan.sopSteps > 0 && opts.releaseSupplies !== true) throw new Error(supplyRefusal(plan))

  const db = getDb()
  const userId = opts.userId ?? null
  const stranded: ShipImportDeleteSupply[] = []

  const run = db.transaction((): ShipImportDeleteResult => {
    const row = importRow(db, id)
    if (!row) throw new Error('Import not found.')
    const successor = successorOf(db, id)

    // --- 1. the supplies, back where they came from -----------------------
    if (plan.sopSteps > 0 && plan.eventDate) {
      const released = releaseShipSopDay(plan.eventDate, userId)
      for (const s of released.stranded) {
        stranded.push({
          role: s.role,
          label: s.label,
          supplyName: s.supplyName,
          quantity: s.quantity,
          cost: s.cost
        })
      }
    }

    // --- 2. the work stamped with this import -----------------------------
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

    // --- 3. splice the chain ----------------------------------------------
    // The successor takes over this import's predecessor. `carried_from` only
    // ever points backwards in time, so this can never close a loop.
    db.prepare(`UPDATE ship_imports SET carried_from = ? WHERE carried_from = ?`).run(
      row.carried_from,
      id
    )

    // --- 4. the file, and the dataset it was parsed into -------------------
    db.prepare(`DELETE FROM ship_documents WHERE import_id = ?`).run(id)
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

    // --- 5. the log row itself --------------------------------------------
    const res = db.prepare(`DELETE FROM ship_imports WHERE id = ?`).run(id)
    if (res.changes === 0) throw new Error('Import not found.')

    // Assignments whose break went with the dataset, and any left pointing at
    // an import that is no longer on the chain.
    pruneShipBreakAssignments(db)

    return { plan, workspaceCleared: plan.isLive, stranded }
  })

  return run()
}
