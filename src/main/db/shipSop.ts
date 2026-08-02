import {
  SHIP_SOP,
  type ShipSopLine,
  type ShipSopResult,
  type ShipSopState,
  type ShipSopStep,
  type ShipSopStepView,
  type ShipSupplyRole
} from '@shared/shippingSupplies'
import { getDb } from './database'
import { getShipEvent } from './shipping'
import { getSupplyPlanCosted } from './shippingDomain'
import { setShipSupplyUsage } from './supplies'
import { nowIso } from '../util'

/**
 * The seven steps of the shipping SOP, and the stock they take with them.
 *
 * ## Why the checklist is the trigger
 *
 * Supplies have to leave stock at SOME moment, and every candidate moment
 * except this one is a lie. At import nothing has been touched yet. At "mark
 * shipped" the sleeves went four hours earlier. On a button somebody presses in
 * Inventory, it happens whenever they remember, which is to say sometimes never.
 *
 * Ticking "sleeving and top loading" is the floor saying the sleeving is done.
 * That is the same sentence as "the sleeves are gone", so it is the same event.
 *
 * ## Keyed by the show's DATE, on purpose
 *
 * The dataset gets replaced every show; the cost of last week's packing does
 * not stop being real when it does. So both tables here hang off the event
 * date, survive an import, and are what the P&L reads — which is also what
 * makes historical days show their packing instead of a blank.
 *
 * The consequence is a rule worth stating plainly: **a show with no day
 * assigned cannot be ticked off.** There is nowhere to book stock that leaves,
 * and deducting into a day we would have to guess at is worse than asking.
 *
 * ## Absolute quantities, never deltas
 *
 * A ticked step records the TOTAL it consumed, and the stock move is the
 * difference from whatever it recorded before. Tick twice and the second tick
 * moves nothing. Re-import a corrected show with two more breaks and re-tick,
 * and only the difference leaves. Untick and all of it comes back. This is also
 * what lets two laptops tick the same step and converge on one answer rather
 * than on twice the night.
 */

/** A day the statement can key on. Free text would become a day named "TBD". */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** How a show identifies itself on its checklist rows. */
function showName(event: { name: string; date: string }): string {
  return event.name.trim() || `Show ${event.date.trim()}`
}

/**
 * Which show already owns this day's checklist, or null if nobody does.
 *
 * Rows written before this column existed carry NULL, and those must not lock
 * anyone out of their own night — an upgrade that bricks a half-ticked show is
 * worse than the collision it is guarding against.
 */
function dayOwner(date: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT event_name FROM ship_supply_usage
        WHERE event_date = ? AND event_name IS NOT NULL AND event_name <> ''
        UNION
       SELECT event_name FROM ship_sop_steps
        WHERE event_date = ? AND event_name IS NOT NULL AND event_name <> ''
        LIMIT 1`
    )
    .get(date, date) as { event_name: string } | undefined
  return row?.event_name ?? null
}

/** The usage row's identity: one per (show, step, consumable). */
function usageId(date: string, step: string, role: string): string {
  return `${date}|${step}|${role}`
}

/** The supply-ledger row's identity. Same key, its own namespace. */
function usageTxnId(date: string, step: string, role: string): string {
  return `shipsop|${date}|${step}|${role}`
}

interface UsageRow {
  step: string
  role: string
  quantity: number
  total_cost: number
}

interface StepRow {
  step: string
  done: number
  done_at: string | null
  done_by: string | null
}

function employeeNames(): Map<string, string> {
  const rows = getDb()
    .prepare(`SELECT id, first_name, last_name FROM employees`)
    .all() as Array<{ id: string; first_name: string | null; last_name: string | null }>
  const out = new Map<string, string>()
  for (const r of rows) {
    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()
    if (name) out.set(r.id, name)
  }
  return out
}

function money(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}

/**
 * The checklist as a screen should draw it: the plan under each step, what that
 * step has already taken, and whether it can be ticked at all.
 */
export function getShipSop(): ShipSopState {
  const event = getShipEvent()
  const date = event.date.trim()
  const plan = getSupplyPlanCosted()
  const hasDataset = plan.packs > 0 || plan.orderCount > 0

  const stepRows = date
    ? (getDb()
        .prepare(`SELECT step, done, done_at, done_by FROM ship_sop_steps WHERE event_date = ?`)
        .all(date) as StepRow[])
    : []
  const byStep = new Map(stepRows.map((r) => [r.step, r]))

  const usageRows = date
    ? (getDb()
        .prepare(
          `SELECT step, role, quantity, total_cost FROM ship_supply_usage WHERE event_date = ?`
        )
        .all(date) as UsageRow[])
    : []
  const usage = new Map(usageRows.map((r) => [`${r.step}|${r.role}`, r]))

  const planByRole = new Map(plan.lines.map((l) => [l.role, l]))
  const names = employeeNames()

  let plannedCost = 0
  // Summed over the USAGE ROWS, not over the steps that say `done = 1`. The two
  // tables sync independently, so a pull that lands one and not the other would
  // otherwise have the screen report nothing booked while the P&L books money —
  // and the screen would be the one that is wrong. Same source, same answer.
  const bookedCost = usageRows.reduce((n, r) => n + (r.total_cost || 0), 0)
  let doneCount = 0
  const unmappedRoles: ShipSupplyRole[] = []
  const negatives: ShipSopState['negatives'] = []

  const steps: ShipSopStepView[] = SHIP_SOP.map((def) => {
    const row = byStep.get(def.step)
    const done = row?.done === 1
    if (done) doneCount += 1

    const stepUnmapped: ShipSupplyRole[] = []
    const stepShort: ShipSupplyRole[] = []
    let cost = 0

    const lines: ShipSopLine[] = def.consumes.map((role) => {
      const p = planByRole.get(role)
      const u = usage.get(`${def.step}|${role}`)
      const quantity = p?.quantity ?? 0
      const used = u?.quantity ?? 0
      // Short against what is STILL TO COME OUT, not against the whole plan.
      // The costed plan cannot know about the tick, so it measures 35 bags
      // against a shelf that 35 bags have already left — and a step reports
      // itself short of stock it correctly took an hour ago. A warning that
      // fires on the finished case is a warning people turn off.
      const outstanding = Math.max(0, quantity - used)
      const line: ShipSopLine = {
        role,
        label: p?.label ?? role,
        quantity,
        basis: p?.basis ?? '',
        supplyId: p?.supplyId ?? null,
        supplyName: p?.supplyName ?? null,
        onHand: p?.onHand ?? 0,
        unitCost: p?.unitCost ?? 0,
        lineCost: p?.lineCost ?? 0,
        shortBy: p?.supplyId ? Math.max(0, outstanding - (p.onHand ?? 0)) : 0,
        used,
        usedCost: money(u?.total_cost ?? 0)
      }
      cost += line.lineCost
      if (!line.supplyId) {
        stepUnmapped.push(role)
        if (!unmappedRoles.includes(role)) unmappedRoles.push(role)
      }
      if (line.shortBy > 0) stepShort.push(role)
      // Below zero is only possible because a tick was allowed through anyway,
      // so it is reported as a fact about now rather than a warning about later.
      if (line.supplyId && line.onHand < 0) {
        negatives.push({ role, supplyName: line.supplyName ?? role, onHand: line.onHand })
      }
      return line
    })

    plannedCost += cost

    return {
      step: def.step,
      title: def.title,
      detail: def.detail,
      done,
      doneAt: row?.done_at ?? null,
      doneBy: row?.done_by ?? null,
      doneByName: row?.done_by ? (names.get(row.done_by) ?? null) : null,
      lines,
      cost: money(cost),
      unmappedRoles: stepUnmapped,
      shortRoles: stepShort
    }
  })

  return {
    eventDate: date || null,
    eventName: event.name.trim() || null,
    hasDataset,
    steps,
    doneCount,
    plannedCost: money(plannedCost),
    bookedCost: money(bookedCost),
    unmappedRoles,
    negatives
  }
}

/**
 * Tick a step, or take the tick back.
 *
 * Ticking sets every consumable under that step to the plan's number and moves
 * the difference out of stock. Unticking sets them all to zero and gives it
 * back — the same code path, which is why the two can never drift.
 *
 * The whole thing is one transaction: seven roles' worth of stock and the tick
 * itself either all land or none do. A half-applied step would leave the floor
 * looking at a checklist that disagrees with the shelf.
 */
export function setShipSopStep(step: ShipSopStep, done: boolean, userId: string | null): ShipSopResult {
  const def = SHIP_SOP.find((s) => s.step === step)
  if (!def) throw new Error('Unknown step.')

  const event = getShipEvent()
  const date = event.date.trim()
  if (!date) {
    throw new Error('Assign this show to a day before ticking steps off — the supplies have to book somewhere.')
  }
  // A day the P&L can key on. "TBD" or "Friday" would sail through as a literal
  // and turn into a day, a week and a month in the statement, all named TBD.
  if (!ISO_DATE.test(date)) {
    throw new Error(
      `"${date}" is not a date the books can use. Set the show's day as YYYY-MM-DD before ticking steps off.`
    )
  }
  // Two shows on one day would share every row id, so the second one's ticks
  // would overwrite the first's and hand back stock the first show really used.
  // Refusing is not the eventual answer, but it is the honest one.
  const owner = dayOwner(date)
  if (owner !== null && owner !== showName(event)) {
    throw new Error(
      `${date} already has a checklist for "${owner}". Two shows cannot both book supplies to one day yet — finish and clear that one first, or give this show its own date.`
    )
  }

  const plan = getSupplyPlanCosted()
  const planByRole = new Map(plan.lines.map((l) => [l.role, l]))
  const db = getDb()
  const ts = nowIso()

  const wentNegative: ShipSopResult['wentNegative'] = []
  const skippedRoles: ShipSupplyRole[] = []
  const released: ShipSopResult['released'] = []
  const stranded: ShipSopResult['stranded'] = []

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO ship_sop_steps (id, event_date, event_name, step, done, done_at, done_by, updated_at)
       VALUES (@id, @date, @name, @step, @done, @at, @by, @ts)
       ON CONFLICT (id) DO UPDATE SET
         event_date = excluded.event_date,
         event_name = excluded.event_name,
         done       = excluded.done,
         done_at    = excluded.done_at,
         done_by    = excluded.done_by,
         updated_at = excluded.updated_at`
    ).run({
      id: `${date}|${step}`,
      date,
      name: showName(event),
      step,
      done: done ? 1 : 0,
      at: done ? ts : null,
      by: done ? userId : null,
      ts
    })

    // What this step has on record RIGHT NOW, per role. This — not the supply
    // ledger — is what the reversal is driven from, because it is the only row
    // that survives the product being re-pointed or deleted.
    const prevRows = db
      .prepare(
        `SELECT role, supply_id, quantity, total_cost FROM ship_supply_usage
          WHERE event_date = ? AND step = ?`
      )
      .all(date, step) as Array<{
      role: string
      supply_id: string | null
      quantity: number
      total_cost: number
    }>
    const prevByRole = new Map(prevRows.map((r) => [r.role, r]))

    for (const role of def.consumes) {
      const line = planByRole.get(role)
      const supplyId = line?.supplyId ?? null
      const want = done && supplyId ? (line?.quantity ?? 0) : done ? (line?.quantity ?? 0) : 0
      const id = usageId(date, step, role)
      const prevRow = prevByRole.get(role) ?? null
      const prev = prevRow ? { supplyId: prevRow.supply_id, quantity: prevRow.quantity } : null

      if (!supplyId) skippedRoles.push(role)

      // Called even when the role is now unlinked: the stock it took while it
      // WAS linked still has to go back, and only the usage row remembers where
      // from. Skipping this branch is what let an unlink strand real units.
      const res = setShipSupplyUsage(db, {
        supplyId,
        txnId: usageTxnId(date, step, role),
        quantity: want,
        prev,
        note: `${def.title} · ${event.name || 'show'} ${date}`,
        actorId: userId
      })
      if (!res.ok) throw new Error(res.error ?? 'Could not move that supply.')
      if (res.wentNegative) {
        wentNegative.push({ role, supplyName: line?.supplyName ?? role, onHand: res.onHand })
      }
      if (res.releasedFrom) {
        released.push({ role, quantity: res.releasedFrom.quantity })
      }
      if (res.strandedFrom) {
        stranded.push({ role, quantity: res.strandedFrom.quantity })
      }

      if (want > 0) {
        // Cost accumulates at the rate of the moment each unit LEFT, not at
        // today's average applied to the whole night. Re-ticking after a case
        // arrives at a higher price must not restate a P&L day that has already
        // been read — which is exactly what `want × today's unitCost` did.
        const carried = prevRow && prevRow.supply_id === supplyId ? prevRow.total_cost : 0
        const already = prev?.supplyId === supplyId ? prev.quantity : 0
        const unitCost = line?.unitCost ?? 0
        const total =
          already === 0
            ? money(want * unitCost)
            : want >= already
              ? money(carried + (want - already) * unitCost)
              : // Fewer than before: give back the same share that is leaving.
                money(carried * (want / already))
        db.prepare(
          `INSERT INTO ship_supply_usage
             (id, event_date, event_name, step, role, supply_id, supply_name, quantity, unit_cost, total_cost, actor_id, created_at, updated_at)
           VALUES (@id, @date, @name, @step, @role, @sid, @sname, @qty, @unit, @total, @by, @ts, @ts)
           ON CONFLICT (id) DO UPDATE SET
             event_date = excluded.event_date, event_name = excluded.event_name,
             supply_id = excluded.supply_id, supply_name = excluded.supply_name,
             quantity = excluded.quantity, unit_cost = excluded.unit_cost,
             total_cost = excluded.total_cost, actor_id = excluded.actor_id,
             updated_at = excluded.updated_at`
        ).run({
          id,
          date,
          name: showName(event),
          step,
          role,
          sid: supplyId,
          sname: line?.supplyName ?? null,
          qty: want,
          // The blended rate this quantity actually went out at.
          unit: want > 0 ? Math.round((total / want) * 1e6) / 1e6 : 0,
          total,
          by: userId,
          ts
        })
      } else {
        db.prepare(`DELETE FROM ship_supply_usage WHERE id = ?`).run(id)
      }
    }
  })
  run()

  return { state: getShipSop(), wentNegative, skippedRoles, released, stranded }
}

/**
 * What packing supplies cost, per show day, across every show ever ticked off.
 *
 * This is the P&L's read. It comes from the usage table rather than from
 * recomputing tonight's plan, which is the difference between "the packing cost
 * of the show whose slips happen to still be loaded" and "the packing cost of
 * that day".
 */
export function packingCostByDay(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT event_date AS d, COALESCE(SUM(total_cost), 0) AS cost
         FROM ship_supply_usage
        WHERE event_date IS NOT NULL AND event_date <> ''
        GROUP BY event_date`
    )
    .all() as Array<{ d: string; cost: number }>
  const out = new Map<string, number>()
  for (const r of rows) {
    // Round FIRST. A day that comes to a third of a cent is not a day worth
    // opening in the statement, and testing the unrounded figure creates one —
    // a P&L row with no session, no sales and $0.00 of packing on it.
    const cost = money(r.cost)
    // Guard the key as well as the value: a show whose date was typed as "TBD"
    // before that was refused would otherwise become a day, a week AND a month
    // named TBD in a statement that then claims to reconcile.
    if (cost > 0 && ISO_DATE.test(r.d)) out.set(r.d, cost)
  }
  return out
}
