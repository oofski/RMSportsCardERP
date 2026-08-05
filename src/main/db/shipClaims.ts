import {
  handedOverAt,
  needsRepick,
  packUnderway,
  type ShipWorkClaim
} from '@shared/shipStations'
import { getDb } from './database'
import { listOrders } from './shippingDomain'

/**
 * The claim rows as stored, and the two questions the rest of the app asks them.
 *
 * ## Why this is its own file
 *
 * `shipStations.ts` owns the pick → pack protocol and is imported by half the
 * module, so anything that both it and its own callers need cannot live in it
 * without closing a cycle. The reads in that position sit here instead, one
 * layer down: how the live import chain is walked, how one order's claims are
 * found, and the two "how much is left" counts. Nothing about the claim protocol
 * changed — `shipStations.ts` re-exports these, so a caller still sees one
 * module and the cycle simply never exists.
 *
 * ## Both counts answer "what does the ROOM still owe"
 *
 * Not "what may I take". The queue functions in `shipStations.ts` answer the
 * second question and hide anything in somebody else's hands, which is right for
 * a bench screen and wrong for a night's-end decision: the last two people in
 * the room would each read the night as finished while the other was working.
 */

export interface ClaimRow {
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

export function toClaim(r: ClaimRow): ShipWorkClaim {
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
export function claimsForOrder(orderId: string, customerId: string): ShipWorkClaim[] {
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

export function allLiveClaims(): ShipWorkClaim[] {
  const chain = liveImportChain()
  if (chain.length === 0) return []
  const marks = chain.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT * FROM ship_work_claims WHERE import_id IN (${marks})`)
    .all(...chain) as ClaimRow[]
  return rows.map(toClaim)
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
 * Orders the bench still owes a mailer, whoever is currently holding them.
 *
 * The sibling of `pickingRemaining`, asked of the other half of the bench, and
 * it has to be honest about the same four awkward cases:
 *
 *   WAITING FOR ANYONE   handed over and sitting in the pack queue. Counted by
 *                        the handoff, so it counts whether or not anybody has
 *                        picked it up yet.
 *   HELD ELSEWHERE       a packer at another bench has it. `packQueue()` hides
 *                        those and must not be the source here; a live claim is
 *                        outstanding work, not finished work.
 *   SENT BACK            a packer rejected it for a repick. A rejection outranks
 *                        every handoff before it, so the order stops reading as
 *                        handed over — and without `needsRepick` it would
 *                        silently vanish from this count while sitting on a
 *                        bench waiting to come round again. Exactly the trap
 *                        `pickingRemaining` names on its own side.
 *   STALE OR EXPIRED     resolved the way its sibling resolves it: the count
 *                        follows the WORK, never the liveness of a claim. An
 *                        abandoned bench keeps its box in the count, because the
 *                        box really is not in a mailer — and does not hold the
 *                        night open for ever, because the lease lets anybody
 *                        take that order over and finish it.
 *
 * ## It counts what has REACHED the bench, and `packed_at` is what clears it
 *
 * Readiness is not enough. An order whose cards were all ticked on the Orders
 * screen reads as ready to pack, and on a night nobody ever stood at a bench
 * that is true of every order in the show — counting those would leave a
 * one-person night reading as permanently unfinished, waiting on a packer who
 * does not exist and cannot be summoned. So the evidence has to come from the
 * claims: a handoff, a packer's hands, or a rejection.
 */
export function packingRemaining(): number {
  return listOrders().filter((o) => {
    // On hold is a lead stopping the package, exactly as picking reads it, and
    // packed is the durable fact that the box is sealed — the same standing
    // `checked_off` has for picking.
    if (o.onHold || o.packedAt) return false
    const claims = claimsForOrder(o.id, o.customerId)
    return handedOverAt(claims) !== null || packUnderway(claims) || needsRepick(claims)
  }).length
}
