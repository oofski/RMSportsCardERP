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
  let bookedCost = 0
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
    if (done) bookedCost += lines.reduce((n, l) => n + l.usedCost, 0)

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

  const plan = getSupplyPlanCosted()
  const planByRole = new Map(plan.lines.map((l) => [l.role, l]))
  const db = getDb()
  const ts = nowIso()

  const wentNegative: ShipSopResult['wentNegative'] = []
  const skippedRoles: ShipSupplyRole[] = []

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO ship_sop_steps (id, event_date, step, done, done_at, done_by, updated_at)
       VALUES (@id, @date, @step, @done, @at, @by, @ts)
       ON CONFLICT (id) DO UPDATE SET
         done       = excluded.done,
         done_at    = excluded.done_at,
         done_by    = excluded.done_by,
         updated_at = excluded.updated_at`
    ).run({
      id: `${date}|${step}`,
      date,
      step,
      done: done ? 1 : 0,
      at: done ? ts : null,
      by: done ? userId : null,
      ts
    })

    for (const role of def.consumes) {
      const line = planByRole.get(role)
      const want = done ? (line?.quantity ?? 0) : 0
      const id = usageId(date, step, role)

      if (!line?.supplyId) {
        // Nothing to move stock in. The count is still worth remembering — it is
        // what the step called for — but it costs nothing, because a guessed
        // unit price in a P&L is worse than a missing one.
        skippedRoles.push(role)
        if (want > 0) {
          db.prepare(
            `INSERT INTO ship_supply_usage
               (id, event_date, step, role, supply_id, supply_name, quantity, unit_cost, total_cost, actor_id, created_at, updated_at)
             VALUES (@id, @date, @step, @role, NULL, NULL, @qty, 0, 0, @by, @ts, @ts)
             ON CONFLICT (id) DO UPDATE SET
               supply_id = NULL, supply_name = NULL, quantity = excluded.quantity,
               unit_cost = 0, total_cost = 0, actor_id = excluded.actor_id,
               updated_at = excluded.updated_at`
          ).run({ id, date, step, role, qty: want, by: userId, ts })
        } else {
          db.prepare(`DELETE FROM ship_supply_usage WHERE id = ?`).run(id)
        }
        continue
      }

      const res = setShipSupplyUsage(db, {
        supplyId: line.supplyId,
        txnId: usageTxnId(date, step, role),
        quantity: want,
        note: `${def.title} · ${event.name || 'show'} ${date}`,
        actorId: userId
      })
      if (!res.ok) throw new Error(res.error ?? 'Could not move that supply.')
      if (res.wentNegative) {
        wentNegative.push({ role, supplyName: line.supplyName ?? role, onHand: res.onHand })
      }

      if (want > 0) {
        // Cost is frozen at the unit price of the moment the work happened.
        // Re-pricing a past show because the next case of sleeves cost more
        // would rewrite a P&L that has already been read.
        db.prepare(
          `INSERT INTO ship_supply_usage
             (id, event_date, step, role, supply_id, supply_name, quantity, unit_cost, total_cost, actor_id, created_at, updated_at)
           VALUES (@id, @date, @step, @role, @sid, @sname, @qty, @unit, @total, @by, @ts, @ts)
           ON CONFLICT (id) DO UPDATE SET
             supply_id = excluded.supply_id, supply_name = excluded.supply_name,
             quantity = excluded.quantity, unit_cost = excluded.unit_cost,
             total_cost = excluded.total_cost, actor_id = excluded.actor_id,
             updated_at = excluded.updated_at`
        ).run({
          id,
          date,
          step,
          role,
          sid: line.supplyId,
          sname: line.supplyName,
          qty: want,
          unit: line.unitCost,
          total: money(want * line.unitCost),
          by: userId,
          ts
        })
      } else {
        db.prepare(`DELETE FROM ship_supply_usage WHERE id = ?`).run(id)
      }
    }
  })
  run()

  return { state: getShipSop(), wentNegative, skippedRoles }
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
    if (r.cost > 0) out.set(r.d, money(r.cost))
  }
  return out
}
