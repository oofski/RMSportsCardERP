import {
  CLAIM_LEASE_MS,
  STATION_SESSION_MAX_MS,
  claimState,
  holderOf,
  needsRepick,
  readyToPackAt,
  sendBackReason,
  supersededIds,
  type ShipStationBoard,
  type ShipStationOrder,
  type ShipStationRole,
  type ShipStationSession,
  type ShipWorkClaim
} from '@shared/shipStations'
import type { ShipOrderRow } from '@shared/shippingViews'
import { getDb } from './database'
import { deviceId } from './sync'
import { listBreakIdsForCustomer, setCustomerSlotsChecked } from './shipping'
import { _orderRow, _recomputeBreakStatus, listOrders, setOrderStage } from './shippingDomain'
import { getShipShipmentByCustomer } from './shipping'
import { completeShipSopStepOnce } from './shipSop'
import { newId, nowIso } from '../util'

/**
 * The pick → pack pipeline.
 *
 * ## The one idea
 *
 * Every row in `ship_work_claims` is written by exactly one device. Nothing is
 * ever arbitrated between two machines, so last-write-wins has nothing to
 * decide. Who holds an order is DERIVED — `holderOf` in the shared contract —
 * and every machine computes the same answer from the same rows.
 *
 * The consequence worth stating plainly: **two stations can briefly both think
 * they hold an order.** That is the chosen failure. Within one sync round both
 * see both rows, both compute the same winner, and the loser releases ITS OWN
 * row and moves on. The alternative — a lock the relay cannot provide — fails
 * by losing an order out of both queues, which is the one outcome that must
 * never happen.
 *
 * ## Claims are advisory
 *
 * Delete this whole table and the night is unchanged. Picking lives in
 * `ship_team_slots.checked_off`; packing lives in `ship_shipments.packed_at`.
 * A claim only answers "who has this right now", so a race costs duplicated
 * effort and never a lost card — `setCustomerSlotsChecked`'s `onlyUnchecked`
 * guard already keeps the first finder's name and timestamp.
 */

interface ClaimRow {
  id: string
  order_id: string
  customer_id: string
  import_id: string
  role: string
  station_id: string
  operator_id: string | null
  login_user_id: string | null
  claimed_at: string
  heartbeat_at: string
  finished_at: string | null
  released_at: string | null
  supersedes: string | null
  note: string | null
}

function toClaim(r: ClaimRow): ShipWorkClaim {
  return {
    id: r.id,
    orderId: r.order_id,
    customerId: r.customer_id,
    importId: r.import_id,
    role: r.role === 'pack' ? 'pack' : 'pick',
    stationId: r.station_id,
    operatorId: r.operator_id,
    loginUserId: r.login_user_id,
    claimedAt: r.claimed_at,
    heartbeatAt: r.heartbeat_at,
    finishedAt: r.finished_at,
    releasedAt: r.released_at,
    supersedes: r.supersedes,
    note: r.note
  }
}

/**
 * The chain of imports whose claims are still live.
 *
 * Walks `carried_from` back from the newest import. A claim made against an
 * import on this chain survives; one made against anything else is inert, with
 * no row anywhere having been written to say so.
 *
 * Capped, because corrupt data must not spin. A cycle can only arise if two
 * machines somehow minted the same import id, which they cannot — but a loop
 * guard costs nothing and an infinite one costs the app.
 */
export function liveImportChain(): string[] {
  const db = getDb()
  const newest = db
    .prepare(`SELECT id, carried_from FROM ship_imports ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get() as { id: string; carried_from: string | null } | undefined
  if (!newest) return []
  const chain: string[] = []
  const seen = new Set<string>()
  let cur: { id: string; carried_from: string | null } | undefined = newest
  while (cur && !seen.has(cur.id) && chain.length < 20) {
    chain.push(cur.id)
    seen.add(cur.id)
    cur = cur.carried_from
      ? (db
          .prepare(`SELECT id, carried_from FROM ship_imports WHERE id = ?`)
          .get(cur.carried_from) as { id: string; carried_from: string | null } | undefined)
      : undefined
  }
  return chain
}

/**
 * Claims for one order, scoped to the live chain and re-homed by handle.
 *
 * The re-home is v0.0.59's lesson applied at READ time. That release changed
 * break ids from `break_11` to `break_11A` and silently deleted every
 * assignment pointing at the old shape — "the person sorting that break simply
 * vanished from it". Order ids are `ship_<handle>`, so the same trap exists
 * here; resolving by handle when the id misses means a shape change re-points
 * itself with no migration and no write.
 *
 * EXACTLY one match, for the same reason the assignment prune requires it: two
 * shipments for one handle is precisely where a guess puts somebody on the
 * wrong package.
 */
function claimsForOrder(orderId: string, customerId: string): ShipWorkClaim[] {
  const chain = liveImportChain()
  if (chain.length === 0) return []
  const marks = chain.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT * FROM ship_work_claims
        WHERE import_id IN (${marks}) AND (order_id = ? OR customer_id = ?)`
    )
    .all(...chain, orderId, customerId) as ClaimRow[]
  return rows.map(toClaim)
}

function allLiveClaims(): ShipWorkClaim[] {
  const chain = liveImportChain()
  if (chain.length === 0) return []
  const marks = chain.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT * FROM ship_work_claims WHERE import_id IN (${marks})`)
    .all(...chain) as ClaimRow[]
  return rows.map(toClaim)
}

// ---------------------------------------------------------------------------
// Station sessions — who is standing here, and doing which job
// ---------------------------------------------------------------------------

interface SessionRow {
  station_id: string
  operator_id: string
  role: string
  login_user_id: string | null
  started_at: string
  seen_at: string
  ended_at: string | null
}

function employeeName(id: string | null): string | null {
  if (!id) return null
  const r = getDb()
    .prepare(`SELECT first_name, last_name FROM employees WHERE id = ?`)
    .get(id) as { first_name: string | null; last_name: string | null } | undefined
  if (!r) return null
  return `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null
}

/**
 * Is this operator still on the clock?
 *
 * The roster is an existing synced fact — an open `time_entries` row — so a
 * station needs no second credential and no second password. Somebody already
 * authenticated to punch in; the floor screen only asks which of the people on
 * shift is standing here.
 */
function stillClockedIn(operatorId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM time_entries WHERE employee_id = ? AND clock_out IS NULL LIMIT 1`)
    .get(operatorId)
  return !!row
}

export function getStationSession(): ShipStationSession | null {
  const row = getDb()
    .prepare(`SELECT * FROM ship_station_sessions WHERE station_id = ?`)
    .get(deviceId()) as SessionRow | undefined
  if (!row || row.ended_at) return null
  // Three ways a session stops being true, all checked on read rather than
  // swept by a timer: they punched out, half a day went by, or somebody ended
  // it. A stale session silently attributing work to whoever was here this
  // morning is worse than asking again.
  if (Date.now() - Date.parse(row.started_at) > STATION_SESSION_MAX_MS) return null
  if (!stillClockedIn(row.operator_id)) return null
  return {
    stationId: row.station_id,
    operatorId: row.operator_id,
    operatorName: employeeName(row.operator_id),
    role: row.role === 'pack' ? 'pack' : 'pick',
    startedAt: row.started_at
  }
}

export function startStationSession(
  operatorId: string,
  role: ShipStationRole,
  loginUserId: string | null
): ShipStationSession | null {
  const ts = nowIso()
  // Switching job releases whatever this station is holding FIRST. A silent
  // switch strands a claimed order: nobody else can take it and the person who
  // had it is now looking at a different queue.
  releaseAllForStation('switched job')
  getDb()
    .prepare(
      `INSERT INTO ship_station_sessions
         (station_id, operator_id, role, login_user_id, started_at, seen_at, ended_at)
       VALUES (@station, @op, @role, @login, @ts, @ts, NULL)
       ON CONFLICT (station_id) DO UPDATE SET
         operator_id = excluded.operator_id, role = excluded.role,
         login_user_id = excluded.login_user_id, started_at = excluded.started_at,
         seen_at = excluded.seen_at, ended_at = NULL`
    )
    .run({ station: deviceId(), op: operatorId, role, login: loginUserId, ts })
  return getStationSession()
}

export function endStationSession(): void {
  releaseAllForStation('left the bench')
  getDb()
    .prepare(`UPDATE ship_station_sessions SET ended_at = ? WHERE station_id = ?`)
    .run(nowIso(), deviceId())
}

/**
 * Who to stamp on the work.
 *
 * The station account AUTHORISES; the person ATTRIBUTES. Never the reverse —
 * the operator id is never an input to a permission decision, so choosing a
 * name from the roster grants nothing. It only changes whose name lands in
 * `checked_off_by`.
 *
 * Without this, a bench shared by three people all evening stamps one login on
 * every card, and every attribution column in the module quietly becomes
 * furniture.
 */
export function operatorFor(loginUserId: string | null): string | null {
  return getStationSession()?.operatorId ?? loginUserId
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

export interface ClaimOutcome {
  ok: boolean
  claim: ShipWorkClaim | null
  /** Set when somebody else holds it — advisory, so the caller can say who. */
  heldByName?: string | null
  error?: string
}

/**
 * Take an order, or find out who already has it.
 *
 * One local transaction, no network, never blocks. Two stations can both find
 * it free and both insert; within a sync round both see both rows, `holderOf`
 * gives them the same winner, and the loser releases its own row.
 */
export function claimOrder(
  orderId: string,
  customerId: string,
  role: ShipStationRole,
  loginUserId: string | null
): ClaimOutcome {
  const station = deviceId()
  const chain = liveImportChain()
  if (chain.length === 0) return { ok: false, claim: null, error: 'No show is loaded.' }
  const now = Date.now()
  const ts = nowIso()
  const claims = claimsForOrder(orderId, customerId)
  const held = holderOf(claims, role, now)

  if (held && held.stationId === station) {
    // Re-claiming my own is a touch, not a new episode.
    getDb().prepare(`UPDATE ship_work_claims SET heartbeat_at = ? WHERE id = ?`).run(ts, held.id)
    return { ok: true, claim: { ...held, heartbeatAt: ts } }
  }
  if (held) {
    return {
      ok: false,
      claim: held,
      heldByName: employeeName(held.operatorId),
      error: 'Somebody else has that one.'
    }
  }

  // Nobody live holds it. If an EXPIRED claim was the last holder, name it in
  // `supersedes` — that makes the loss permanent, so a laptop that wakes up
  // hours later does not quietly take the order back.
  const dead = supersededIds(claims)
  const expired = claims
    .filter((c) => c.role === role && claimState(c, dead, now) === 'expired')
    .sort((a, b) => b.claimedAt.localeCompare(a.claimedAt))[0]

  const id = newId()
  getDb()
    .prepare(
      `INSERT INTO ship_work_claims
         (id, order_id, customer_id, import_id, role, station_id, operator_id,
          login_user_id, claimed_at, heartbeat_at, supersedes)
       VALUES (@id, @order, @cust, @import, @role, @station, @op, @login, @ts, @ts, @sup)`
    )
    .run({
      id,
      order: orderId,
      cust: customerId,
      import: chain[0],
      role,
      station,
      op: operatorFor(loginUserId),
      login: loginUserId,
      ts,
      sup: expired?.id ?? null
    })
  const row = getDb().prepare(`SELECT * FROM ship_work_claims WHERE id = ?`).get(id) as ClaimRow
  return { ok: true, claim: toClaim(row) }
}

/** Give up a claim. MY OWN ROW ONLY — never anybody else's. */
export function releaseClaim(claimId: string, note?: string): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE ship_work_claims SET released_at = ?, note = COALESCE(?, note)
          WHERE id = ? AND station_id = ? AND released_at IS NULL`
      )
      .run(nowIso(), note ?? null, claimId, deviceId()).changes > 0
  )
}

export function releaseAllForStation(note?: string): number {
  return getDb()
    .prepare(
      `UPDATE ship_work_claims SET released_at = ?, note = COALESCE(?, note)
        WHERE station_id = ? AND released_at IS NULL AND finished_at IS NULL`
    )
    .run(nowIso(), note ?? null, deviceId()).changes
}

/** Keep this station's live claims alive. Cheap, local, no network. */
export function heartbeatStation(): number {
  return getDb()
    .prepare(
      `UPDATE ship_work_claims SET heartbeat_at = ?
        WHERE station_id = ? AND released_at IS NULL AND finished_at IS NULL`
    )
    .run(nowIso(), deviceId()).changes
}

/**
 * After a pull: did I lose anything while I was not looking?
 *
 * Releases my own rows for any order whose derived holder is no longer me. This
 * is how the loser of a race gets out of the way without anybody writing to its
 * row from another machine.
 */
export function reconcileClaims(): string[] {
  const station = deviceId()
  const now = Date.now()
  const mine = allLiveClaims().filter(
    (c) => c.stationId === station && !c.releasedAt && !c.finishedAt
  )
  const lost: string[] = []
  for (const c of mine) {
    const holder = holderOf(claimsForOrder(c.orderId, c.customerId), c.role, now)
    if (holder && holder.id !== c.id) {
      releaseClaim(c.id, 'lost the race')
      lost.push(c.customerId)
    }
  }
  return lost
}

// ---------------------------------------------------------------------------
// The two queues
// ---------------------------------------------------------------------------

function myClaim(role: ShipStationRole): ShipWorkClaim | null {
  const station = deviceId()
  const now = Date.now()
  const mine = allLiveClaims().filter(
    (c) => c.stationId === station && c.role === role && !c.releasedAt && !c.finishedAt
  )
  for (const c of mine) {
    const holder = holderOf(claimsForOrder(c.orderId, c.customerId), role, now)
    if (holder?.id === c.id) return c
  }
  return null
}

function lastCheckedAtFor(customerId: string): string | null {
  const r = getDb()
    .prepare(
      `SELECT MAX(checked_off_at) AS t FROM ship_team_slots
        WHERE customer_id = ? AND checked_off = 1`
    )
    .get(customerId) as { t: string | null } | undefined
  return r?.t ?? null
}

function toStationOrder(o: ShipOrderRow, now: number): ShipStationOrder {
  const claims = claimsForOrder(o.id, o.customerId)
  const station = deviceId()
  const pickHolder = holderOf(claims, 'pick', now)
  const packHolder = holderOf(claims, 'pack', now)
  const held = packHolder ?? pickHolder
  const dead = supersededIds(claims)
  return {
    orderId: o.id,
    customerId: o.customerId,
    handle: o.customer.handle,
    realName: o.customer.realName || null,
    pages: o.customer.pages ?? [],
    cardsTotal: o.cardCount,
    cardsChecked: o.pick.checked,
    onHold: o.onHold,
    heldByName: held && held.stationId !== station ? employeeName(held.operatorId) : null,
    heldByStation: held && held.stationId !== station ? held.stationId : null,
    heldStale: held ? claimState(held, dead, now) === 'stale' : false,
    mine: held?.stationId === station,
    readyAt: readyToPackAt({
      claims,
      cardsTotal: o.cardCount,
      cardsChecked: o.pick.checked,
      lastCheckedAt: lastCheckedAtFor(o.customerId)
    }),
    sentBackReason: sendBackReason(claims)
  }
}

/**
 * Orders a picker may take: not finished, not held by anyone else, not on hold.
 *
 * The station-derived start offset is the difference between two pickers who
 * contend on every single order all night and two who mostly never meet. Both
 * open the same list in the same order; starting them at deterministic but
 * different places means the claim protocol only has to settle the tail.
 */
export function pickableOrders(): ShipStationOrder[] {
  const now = Date.now()
  const station = deviceId()
  const all = listOrders()
    // Still to pick, OR sent back. A rejected order has every card ticked — the
    // whole point is that one of them is wrong — so filtering on "not finished"
    // alone would leave it in neither queue, and it would simply be forgotten.
    .filter((o) => !o.onHold && !o.packedAt)
    .filter(
      (o) =>
        o.pick.checked < o.pick.total ||
        needsRepick(claimsForOrder(o.id, o.customerId))
    )
    .map((o) => toStationOrder(o, now))
    .filter((o) => o.mine || (!o.heldByName && !o.heldByStation))
    .filter((o) => o.readyAt === null || o.mine)
  if (all.length === 0) return all
  let offset = 0
  for (let i = 0; i < station.length; i++) offset = (offset * 31 + station.charCodeAt(i)) % 997
  const start = offset % all.length
  return [...all.slice(start), ...all.slice(0, start)]
}

/** Handed over and waiting, oldest first. Never browsable — a depth and a head. */
export function packQueue(): ShipStationOrder[] {
  const now = Date.now()
  return listOrders()
    .filter((o) => !o.onHold && !o.packedAt)
    .map((o) => toStationOrder(o, now))
    .filter((o) => o.readyAt !== null)
    .filter((o) => o.mine || (!o.heldByName && !o.heldByStation))
    .sort((a, b) => (a.readyAt ?? '').localeCompare(b.readyAt ?? '') || a.orderId.localeCompare(b.orderId))
}

export interface AdvanceResult {
  finished: ShipOrderRow | null
  next: ShipStationOrder | null
  queueDepth: number
  /**
   * This pick was the last one, and it is the one that closed SOP step 5.
   *
   * True for exactly one caller ever, which is what makes it safe to act on:
   * the bench that sees it is the bench that finished the night, so that is the
   * screen — and only that screen — sent back to the checklist.
   */
  sopShipCompleted: boolean
  error?: string
}

/**
 * Orders still needing a picker, whoever is currently holding them.
 *
 * Deliberately NOT `pickableOrders().length`: that list is what *I* may take,
 * so it hides the order in somebody else's hands, and the last two pickers in
 * the room would each see an empty run while the other was still working.
 *
 * A sent-back order counts, even though every card in it is ticked. The whole
 * point of the rejection is that one of those ticks is wrong, so picking is not
 * finished while one is outstanding.
 */
export function pickingRemaining(): number {
  return listOrders().filter(
    (o) =>
      !o.onHold &&
      !o.packedAt &&
      (o.pick.checked < o.pick.total || needsRepick(claimsForOrder(o.id, o.customerId)))
  ).length
}

/**
 * "Picked · next order" — the handoff.
 *
 * Marks the order's cards found (unchanged behaviour, `onlyUnchecked` so a card
 * somebody else found keeps their name), stamps `finished_at` on MY OWN claim
 * row — which is what puts the order in the pack pool — and claims the next one.
 *
 * It deducts NO supplies PER ORDER. Step 5's tick does that, once, for the whole
 * show; doing it per order as well would double-deduct every mailer and label
 * and leave a P&L day nobody can reconcile by hand.
 *
 * What it does do is notice when this was the LAST order to pick, because that
 * is what step 5 being finished means — nobody ticks it, the work does. The tick
 * is claimed rather than written, so of two pickers finishing seconds apart only
 * one moves the stock and only one gets sent back to the checklist.
 */
export function pickAdvance(customerId: string, loginUserId: string | null): AdvanceResult {
  const db = getDb()
  const shipment = getShipShipmentByCustomer(customerId)
  if (!shipment) {
    return {
      finished: null,
      next: null,
      queueDepth: 0,
      sopShipCompleted: false,
      error: 'That package is gone.'
    }
  }
  const operator = operatorFor(loginUserId)
  const mine = myClaim('pick')

  const run = db.transaction(() => {
    const breakIds = listBreakIdsForCustomer(customerId)
    setCustomerSlotsChecked(customerId, true, operator, true)
    for (const id of breakIds) _recomputeBreakStatus(id)
    if (mine && mine.customerId === customerId) {
      db.prepare(`UPDATE ship_work_claims SET finished_at = ? WHERE id = ? AND station_id = ?`).run(
        nowIso(),
        mine.id,
        deviceId()
      )
    } else {
      // Finished an order this station never claimed — somebody worked ahead of
      // the queue. Record the handoff anyway, or the order would never reach a
      // packer and would sit looking picked and untouched.
      const chain = liveImportChain()
      if (chain.length > 0) {
        const ts = nowIso()
        db.prepare(
          `INSERT INTO ship_work_claims
             (id, order_id, customer_id, import_id, role, station_id, operator_id,
              login_user_id, claimed_at, heartbeat_at, finished_at)
           VALUES (?, ?, ?, ?, 'pick', ?, ?, ?, ?, ?, ?)`
        ).run(newId(), shipment.id, customerId, chain[0], deviceId(), operator, loginUserId, ts, ts, ts)
      }
    }
  })
  run()

  // The night's last pick closes step 5. Outside the transaction above on
  // purpose: the handoff is this station's own row and must land whatever the
  // checklist decides, and `completeShipSopStepOnce` runs its own transaction
  // over stock. It never throws — a show with no day set, or a step whose
  // predecessor is still open, is a reason for the tick not to happen and never
  // a reason for the pick not to.
  const sopShipCompleted =
    pickingRemaining() === 0 && listOrders().length > 0
      ? completeShipSopStepOnce('ship', loginUserId) !== null
      : false

  const next = pickableOrders()[0] ?? null
  if (next) claimOrder(next.orderId, next.customerId, 'pick', loginUserId)
  return {
    finished: _orderRow(shipment),
    next: next ? toStationOrder(listOrders().find((o) => o.id === next.orderId) as ShipOrderRow, Date.now()) : null,
    queueDepth: packQueue().length,
    sopShipCompleted
  }
}

/**
 * Take the next order to pick, or resume the one I already hold.
 *
 * Symmetric with packNext, and the reason both exist: arriving at a bench and
 * pressing nothing should still put work in front of you.
 */
export function pickNext(loginUserId: string | null): ShipStationOrder | null {
  const mine = myClaim('pick')
  if (mine) {
    const o = listOrders().find((x) => x.customerId === mine.customerId)
    return o ? toStationOrder(o, Date.now()) : null
  }
  for (const cand of pickableOrders()) {
    const res = claimOrder(cand.orderId, cand.customerId, 'pick', loginUserId)
    if (res.ok) return { ...cand, mine: true }
  }
  return null
}

/** Take the next thing waiting to be packed, or resume what I already hold. */
export function packNext(loginUserId: string | null): ShipStationOrder | null {
  const mine = myClaim('pack')
  if (mine) {
    const o = listOrders().find((x) => x.customerId === mine.customerId)
    return o ? toStationOrder(o, Date.now()) : null
  }
  for (const cand of packQueue()) {
    const res = claimOrder(cand.orderId, cand.customerId, 'pack', loginUserId)
    if (res.ok) return { ...cand, mine: true }
  }
  return null
}

/** The packer is done: the box is sealed and labelled. */
export function packDone(customerId: string, loginUserId: string | null): ShipOrderRow | null {
  const shipment = getShipShipmentByCustomer(customerId)
  if (!shipment) return null
  const operator = operatorFor(loginUserId)
  const mine = myClaim('pack')
  const row = setOrderStage(shipment.id, 'put_together', operator)
  if (mine && mine.customerId === customerId) {
    getDb()
      .prepare(`UPDATE ship_work_claims SET finished_at = ? WHERE id = ? AND station_id = ?`)
      .run(nowIso(), mine.id, deviceId())
  }
  return row
}

/**
 * The packer found something wrong — wrong card, missing card, damaged.
 *
 * Goes back to the picking pool with the reason attached, so whoever takes it
 * next knows before they start rather than after. Deliberately NOT the existing
 * `on_hold`, which needs manage and means "a lead stopped this package" — a
 * different fact, told by a different person, for a different reason.
 */
export function sendBack(customerId: string, reason: string): boolean {
  const mine = myClaim('pack')
  if (!mine || mine.customerId !== customerId) return false
  const clean = reason.trim().slice(0, 200) || 'no reason given'
  releaseClaim(mine.id, `sent back: ${clean}`)
  // The pick handoff has to die too, or the order would still read as ready and
  // drop straight back into the pack queue instead of the picking run.
  const claims = claimsForOrder(mine.orderId, mine.customerId)
  for (const c of claims) {
    if (c.role === 'pick' && c.finishedAt && !c.releasedAt && c.stationId === deviceId()) {
      releaseClaim(c.id, 'sent back')
    }
  }
  return true
}

export function getStationBoard(): ShipStationBoard {
  const session = getStationSession()
  const now = Date.now()
  const orders = listOrders()
  const toPick = orders.filter((o) => !o.onHold && o.pick.checked < o.pick.total).length
  const queue = packQueue()
  const mine = session ? myClaim(session.role) : null
  const current = mine
    ? (() => {
        const o = orders.find((x) => x.customerId === mine.customerId)
        return o ? toStationOrder(o, now) : null
      })()
    : null

  const station = deviceId()
  const others = allLiveClaims()
    .filter((c) => c.stationId !== station && !c.releasedAt && !c.finishedAt)
    .filter((c) => claimState(c, supersededIds(allLiveClaims()), now) !== 'expired')
    .map((c) => ({
      operatorName: employeeName(c.operatorId),
      role: c.role,
      orderHandle: orders.find((o) => o.customerId === c.customerId)?.customer.handle ?? null
    }))

  return {
    session,
    toPick,
    packQueue: queue.length,
    current,
    others,
    allDone: toPick === 0 && queue.length === 0 && orders.length > 0
  }
}

/**
 * Who could be standing at this bench.
 *
 * People currently ON THE CLOCK. That is an existing authenticated act —
 * somebody signed in somewhere to punch in — so a shared station needs no
 * second password and no PIN, and the list cannot offer somebody who is not at
 * work. Stations themselves are excluded: a computer does not pick cards.
 */
export function stationRoster(): Array<{ id: string; name: string }> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT e.id, e.first_name, e.last_name
         FROM time_entries t
         JOIN employees e ON e.id = t.employee_id
        WHERE t.clock_out IS NULL
          AND e.status = 'active'
          AND COALESCE(e.account_kind, 'person') <> 'station'
        ORDER BY e.first_name COLLATE NOCASE`
    )
    .all() as Array<{ id: string; first_name: string | null; last_name: string | null }>
  return rows.map((r) => ({
    id: r.id,
    name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || 'Unnamed'
  }))
}

/** How long a claim may sit without a heartbeat. Exposed for the tests. */
export const LEASE_MS = CLAIM_LEASE_MS
