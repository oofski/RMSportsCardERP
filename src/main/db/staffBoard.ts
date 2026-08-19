import { dayKey, payrollPeriodFor } from '@shared/homeTasks'
import { upcomingFrom } from '@shared/schedule'
import type { StaffBoard, StaffPeriodHours, StaffSorting } from '@shared/staffBoard'
import { getDb } from './database'
import { myShifts } from './schedule'

/**
 * The floor's home board.
 *
 * Three questions and no others — what is waiting for me, what have I earned
 * this fortnight, when am I next in. See the note in @shared/staffBoard for why
 * this is a different screen rather than a subset of the owner's.
 *
 * Every read here is aggregate SQL rather than a call into the shipping domain,
 * for the same reason the owner's board is: this is the screen that has to paint
 * first, and `listOrders()` builds a whole-table context plus a claims query per
 * package. The fidelity that buys belongs on the bench board that acts on it.
 */

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Tonight's pile.
 *
 * "Needs sorting" is ONE specific thing: a package with at least one card not
 * yet checked off. Deliberately not "not shipped" and not "not packed" — those
 * are later stages, done by other people, and a card counting them would tell a
 * sorter that work is outstanding when their part of it is finished.
 *
 * Held packages are excluded, matching the owner's board: a lead stopping a
 * package has decided it is not tonight's work, and a list that includes it
 * invites somebody to work it anyway.
 */
function sorting(): StaffSorting {
  const db = getDb()

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS packages,
              SUM(CASE WHEN COALESCE(on_hold, 0) = 0 AND packed_at IS NULL THEN 1 ELSE 0 END) AS live
         FROM ship_shipments`
    )
    .get() as { packages: number; live: number | null }

  // One pass over the outstanding cards. The three numbers on the card —
  // packages, cards, breaks — are three aggregates of the same row set, so
  // taking them apart into three queries would be three chances for them to
  // disagree with each other on screen.
  const agg = db
    .prepare(
      `SELECT COUNT(DISTINCT s.customer_id)                                   AS orders,
              COUNT(*)                                                        AS cards_left,
              COUNT(DISTINCT CASE WHEN t.break_id IS NOT NULL AND t.break_id <> ''
                                  THEN t.break_id END)                        AS breaks
         FROM ship_team_slots t
         JOIN ship_shipments s ON s.customer_id = t.customer_id
        WHERE COALESCE(s.on_hold, 0) = 0
          AND s.packed_at IS NULL
          AND COALESCE(t.checked_off, 0) = 0`
    )
    .get() as { orders: number; cards_left: number; breaks: number }

  const cardsTotal = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM ship_team_slots t
           JOIN ship_shipments s ON s.customer_id = t.customer_id
          WHERE COALESCE(s.on_hold, 0) = 0`
      )
      .get() as { n: number }
  ).n

  const event = db.prepare(`SELECT name, date FROM ship_event WHERE id = 1`).get() as
    | { name: string | null; date: string | null }
    | undefined

  // "When was it from", answered honestly. The event date is what the slip
  // claims about itself and is very often blank — these PDFs rarely carry one —
  // so the upload time travels alongside it rather than instead of it, and the
  // screen can fall back without inventing a date.
  const lastImport = db
    .prepare(
      `SELECT name, created_at FROM ship_imports
        WHERE kind = 'pdf' AND created_at IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { name: string | null; created_at: string } | undefined

  return {
    // An empty table is "no slip has been imported", which is a completely
    // different sentence from "everything is sorted" — and the second one is
    // reassurance the data does not support.
    imported: totals.packages > 0,
    orders: agg.orders ?? 0,
    cardsLeft: agg.cards_left ?? 0,
    cardsTotal,
    breaks: agg.breaks ?? 0,
    eventDate: event?.date?.trim() || null,
    eventName: event?.name?.trim() || null,
    importedAt: lastImport?.created_at ?? null,
    importName: lastImport?.name?.trim() || null
  }
}

/**
 * What this fortnight has come to, for one person.
 *
 * The period is the SAME fortnight payroll runs on — anchored on 5 August 2026,
 * every fourteen days — because a figure that adds up over a different window
 * from the one that pays is worse than no figure.
 *
 * A shift belongs to the day it STARTED, in local time. One that runs past
 * midnight belongs to the night it began: that is how the floor talks about it,
 * and it is what stops a Saturday night landing in the following period.
 */
function periodHours(employeeId: string): StaffPeriodHours {
  const today = dayKey(new Date())
  const period = payrollPeriodFor(today)

  const rows = getDb()
    .prepare(
      `SELECT clock_in, clock_out FROM time_entries WHERE employee_id = ?`
    )
    .all(employeeId) as Array<{ clock_in: string; clock_out: string | null }>

  let minutes = 0
  let minutesToday = 0
  let onTheClock = false
  const days = new Set<string>()
  for (const r of rows) {
    const started = new Date(r.clock_in)
    if (Number.isNaN(started.getTime())) continue
    const day = dayKey(started)
    if (day < period.start || day > period.end) continue
    // An open shift counts what it has run so far, or somebody who clocked in
    // an hour ago reads as having done nothing this fortnight.
    if (!r.clock_out) onTheClock = true
    const endedAt = r.clock_out ? new Date(r.clock_out).getTime() : Date.now()
    const mins = Math.max(0, Math.round((endedAt - started.getTime()) / 60000))
    minutes += mins
    if (day === today) minutesToday += mins
    if (mins > 0) days.add(day)
  }

  return {
    start: period.start,
    end: period.end,
    runOn: period.runOn,
    paidOn: period.paidOn,
    minutes,
    daysWorked: days.size,
    onTheClock,
    minutesToday
  }
}

export function getStaffBoard(scope: {
  fulfillment: boolean
  viewerId: string
}): StaffBoard {
  // ONE read of the rota, sliced twice. The whole thing travels so the calendar
  // can page backwards without a second round trip — one person's shifts are a
  // handful of rows a month, and the request that lazy-loading would save costs
  // more than the rows do — and "coming up" is a filter over what already
  // arrived rather than a second query that could disagree with it.
  const all = myShifts(scope.viewerId)
  return {
    sorting: scope.fulfillment ? sorting() : null,
    hours: periodHours(scope.viewerId),
    shifts: upcomingFrom(all, dayKey(new Date())),
    allShifts: all,
    generatedAt: nowIso()
  }
}
