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
import {
  allLiveClaims,
  claimsForOrder,
  liveImportChain,
  packingRemaining,
  pickingRemaining,
  toClaim,
  type ClaimRow
} from './shipClaims'
import { deviceId } from './sync'
import { listBreakIdsForCustomer, setCustomerSlotsPicked } from './shipping'
import { _orderRow, _recomputeBreakStatus, listOrders, setOrderStage } from './shippingDomain'
import { getShipShipmentByCustomer } from './shipping'
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
 * `ship_team_slots.picked_at`; packing lives in `ship_shipments.packed_at`.
 * A claim only answers "who has this right now", so a race costs duplicated
 * effort and never a lost card — `setCustomerSlotsPicked`'s `onlyUnpicked`
 * guard already keeps the first finder's name and timestamp.
 *
 * ## Where the reads went
 *
 * Walking the live import chain, finding one order's claims, and the two "how
 * much is left" counts live in `./shipClaims`, one layer down — below both this
 * module and `./shippingDomain`, which is what keeps the two counts reachable
 * from either without a cycle. They are re-exported below: to anybody outside,
 * this is still the one module that answers questions about claims.
 */

export {
  allLiveClaims,
  claimsForOrder,
  liveImportChain,
  // Siblings, and they belong side by side — one says how much the picking side
  // of the night still owes, the other how much the packing side does.
  packingRemaining,
  pickingRemaining
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
 * `picked_by`.
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
      `SELECT MAX(picked_at) AS t FROM ship_team_slots
        WHERE customer_id = ? AND picked_at IS NOT NULL`
    )
    .get(customerId) as { t: string | null } | undefined
  return r?.t ?? null
}

/**
 * `withDetail` is off by default, and that default is the load-bearing part.
 *
 * `pickableOrders` and `packQueue` run this over every order in the night and
 * are then almost always reduced to a `.length`. Attaching the full break-and-
 * team list to each would push the whole show down the IPC channel every time
 * anybody ticked a card — for two numbers. Only the order a bench is actually
 * holding is drawn, so only that one carries its detail.
 */
function toStationOrder(o: ShipOrderRow, now: number, withDetail = false): ShipStationOrder {
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
    sentBackReason: sendBackReason(claims),
    detail: withDetail ? o : null
  }
}

/**
 * Orders a picker may take: not finished, not held by anyone else, not on hold.
 *
 * IN PAGE ORDER, because `listOrders` is, and nothing here re-orders it.
 *
 * There used to be a station-derived rotation: every bench opened the same list
 * and started at a different deterministic index, so two pickers would not
 * contend on the same order all night. That is in direct conflict with walking
 * the slip from page 1 — a rotation is precisely "starts somewhere else" — and
 * the slip wins, because a picker holding the paper is the person this list is
 * for.
 *
 * Dropping it costs nothing, and the reason is the `mine || not held` filter
 * two lines down. It already hides every order another station is holding, so
 * two benches never SEE the same head: A takes page 1, and page 1 stops being in
 * B's list before B looks. Contention is confined to the moment two stations
 * read before either has written, which is exactly what the claim protocol is
 * for and exactly what the rotation could never eliminate either.
 *
 * What the rotation really bought was two pickers working from opposite ends of
 * a long list. Two pickers now work from the same end, one order apart — which
 * is also how two people share a stack of paper.
 */
export function pickableOrders(): ShipStationOrder[] {
  const now = Date.now()
  return (
    listOrders()
      // Still to pick, OR sent back. A rejected order has every card ticked —
      // the whole point is that one of them is wrong — so filtering on "not
      // finished" alone would leave it in neither queue, and it would simply be
      // forgotten.
      .filter((o) => !o.onHold && !o.packedAt)
      .filter(
        (o) => o.pick.checked < o.pick.total || needsRepick(claimsForOrder(o.id, o.customerId))
      )
      .map((o) => toStationOrder(o, now))
      .filter((o) => o.mine || (!o.heldByName && !o.heldByStation))
      .filter((o) => o.readyAt === null || o.mine)
  )
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
   * There is nothing left in the room to pick, and this click is what did it.
   *
   * It used to be reported by the SOP checklist's fifth step closing, which was
   * a conditional row write and therefore true for exactly one caller ever. That
   * row is gone, so the fact is read straight off the work instead: the picking
   * count is zero the moment after this station handed its order over.
   *
   * Losing the exactly-once property costs nothing, because nothing is deducted
   * from it any more. It is a statement about the ROOM — "there is no picking
   * left" — and a second picker who reads it a moment later reads something that
   * is still true and still means their run is over.
   */
  pickingCompleted: boolean
  error?: string
}

/**
 * "Picked · next order" — the handoff.
 *
 * Marks the order's cards found (unchanged behaviour, `onlyUnchecked` so a card
 * somebody else found keeps their name), stamps `finished_at` on MY OWN claim
 * row — which is what puts the order in the pack pool — and claims the next one.
 *
 * It moves NO stock. Nothing on this path ever did and nothing anywhere does
 * now; a pick is a record of what was found, never a deduction.
 *
 * What it does do is notice when this was the LAST order to pick, because that
 * is the one thing a picker cannot read off the order in their hands: their own
 * queue empties the moment somebody else takes what is left, and "nothing for
 * me" and "nothing at all" are the difference between waiting and going home.
 */
export function pickAdvance(customerId: string, loginUserId: string | null): AdvanceResult {
  const db = getDb()
  const shipment = getShipShipmentByCustomer(customerId)
  if (!shipment) {
    return {
      finished: null,
      next: null,
      queueDepth: 0,
      pickingCompleted: false,
      error: 'That package is gone.'
    }
  }
  const operator = operatorFor(loginUserId)
  const mine = myClaim('pick')

  const run = db.transaction(() => {
    const breakIds = listBreakIdsForCustomer(customerId)
    // PICKED, not bagged. Pressing "Picked · next order" says the buyer's cards
    // are collected into their package; it says nothing about the bagging the
    // break bench recorded for itself.
    setCustomerSlotsPicked(customerId, true, operator, true)
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

  // Did that finish the night's picking? Asked AFTER the handoff has landed, so
  // the order this station just put down is already out of the count.
  //
  // `pickingRemaining` is the room's figure rather than this bench's queue, on
  // purpose: `pickableOrders` hides an order somebody else is holding, so two
  // pickers working the tail would each be told the night was over while the
  // other was still on it.
  //
  // The empty-workspace guard is what stops a show with no orders in it — a
  // cleared dataset, a delete mid-shift — announcing that it has been picked.
  const pickingCompleted = listOrders().length > 0 && pickingRemaining() === 0

  const next = pickableOrders()[0] ?? null
  if (next) claimOrder(next.orderId, next.customerId, 'pick', loginUserId)
  return {
    finished: _orderRow(shipment),
    next: next ? toStationOrder(listOrders().find((o) => o.id === next.orderId) as ShipOrderRow, Date.now()) : null,
    queueDepth: packQueue().length,
    pickingCompleted
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
  // THE ROOM'S FIGURE, not a count of unticked cards.
  //
  // Counting `checked < total` misses the one case the send-back exists for: a
  // packer rejecting an order leaves every card still ticked — that is what
  // makes it a REJECTION rather than an unpick — so the order read as finished
  // and disappeared from both counts at once. The bench then said "0 orders to
  // pick" about work it had just created, and pickingRemaining, which already
  // handles it, was sitting one import away.
  const toPick = pickingRemaining()
  const queue = packQueue()
  const mine = session ? myClaim(session.role) : null
  const current = mine
    ? (() => {
        const o = orders.find((x) => x.customerId === mine.customerId)
        // WITH detail: this is the one order that gets drawn, and the bench
        // draws the same full pane the Orders tab does.
        return o ? toStationOrder(o, now, true) : null
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
    // The room's figure, not this bench's: `queue` is what a packer standing
    // here may take, so it hides an order somebody else is holding. Anything
    // asking "is the packing finished" reads this one, because that is a
    // question about the night rather than about a screen.
    packingRemaining: packingRemaining(),
    current,
    others,
    // Asked of the ROOM, for exactly the reason stated three lines above.
    //
    // `queue.length` is what a packer standing HERE may take, so it hides an
    // order another bench is holding — and this screen used that to announce
    // "every order is picked and packed" while the last mailer was open on
    // somebody else's table. "Is the night over" is a question about the night.
    allDone: toPick === 0 && packingRemaining() === 0 && orders.length > 0
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
