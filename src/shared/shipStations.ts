/**
 * The shipping floor's two stations, and the handoff between them.
 *
 * SOP step 5 is one line of prose — "one person gathers the team bags for each
 * order, the shipper checks the break and username line up, then one bubble
 * mailer, double wrapped in a second, with the matching label" — and this is
 * that sentence turned into two screens.
 *
 *   PICKER   works the whole run, one order at a time with the slip beside it,
 *            gathering that customer's bags. Finishing hands the order off.
 *   PACKER   sees ONLY what has been handed over. Never the night's list, so
 *            there is nothing to be confused by.
 *
 * The pure half lives here so both processes and the tests agree on what a
 * claim MEANS without a database in the room.
 */

import type { ShipOrderRow } from './shippingViews'

export type ShipStationRole = 'pick' | 'pack'

export const SHIP_STATION_ROLES: ShipStationRole[] = ['pick', 'pack']

export function isShipStationRole(v: unknown): v is ShipStationRole {
  return v === 'pick' || v === 'pack'
}

/**
 * How long a claim survives without a heartbeat before anyone else may take it.
 *
 * Ten minutes is deliberately generous — long enough that a picker working a
 * forty-card order, or one whose laptop slept, does not lose it — and
 * deliberately finite, because the alternative is an order claimed at 7pm by
 * somebody who went home, invisible to everyone else for the rest of the night.
 */
export const CLAIM_LEASE_MS = 10 * 60 * 1000

/** Past this with no heartbeat a claim is shown as stale. Display only. */
export const CLAIM_STALE_MS = 90 * 1000

/** How often a station touches its own claims. */
export const CLAIM_BEAT_MS = 30 * 1000

/** A station session is abandoned after this even if nobody said so. */
export const STATION_SESSION_MAX_MS = 12 * 60 * 60 * 1000

/** One claim row, exactly as stored. Every field written by ONE device. */
export interface ShipWorkClaim {
  id: string
  orderId: string
  customerId: string
  importId: string
  role: ShipStationRole
  stationId: string
  operatorId: string | null
  loginUserId: string | null
  claimedAt: string
  heartbeatAt: string
  /** Pick: THE HANDOFF. Pack: the order is packed. */
  finishedAt: string | null
  releasedAt: string | null
  /** The claim this one displaced. Makes a loss permanent. */
  supersedes: string | null
  note: string | null
}

export type ClaimState = 'live' | 'stale' | 'expired' | 'finished' | 'dead'

/**
 * What one claim is, right now.
 *
 * `now` is passed rather than read so this stays pure and testable — and so the
 * expiry decision is never WRITTEN anywhere. A machine that thinks a claim has
 * expired only ever acts locally on that belief; it never publishes it as a
 * fact, which is what keeps a clock difference from becoming a lie everyone
 * else has to believe.
 */
export function claimState(claim: ShipWorkClaim, deadIds: ReadonlySet<string>, now: number): ClaimState {
  if (claim.releasedAt || deadIds.has(claim.id)) return 'dead'
  if (claim.finishedAt) return 'finished'
  const age = now - Date.parse(claim.heartbeatAt)
  if (!Number.isFinite(age)) return 'live'
  if (age > CLAIM_LEASE_MS) return 'expired'
  if (age > CLAIM_STALE_MS) return 'stale'
  return 'live'
}

/** Every claim that some other claim has superseded — permanently dead. */
export function supersededIds(claims: readonly ShipWorkClaim[]): Set<string> {
  const out = new Set<string>()
  for (const c of claims) if (c.supersedes) out.add(c.supersedes)
  return out
}

/**
 * Who holds this order — the pure function the whole design rests on.
 *
 * Every machine runs this over the same row set and gets the same answer, which
 * is what makes a claim safe without a lock. Earliest claim wins; a tie is
 * broken by id, following the same reasoning as the sync layer's duplicate
 * resolution: the rule is arbitrary, being IDENTICAL everywhere is the point.
 */
export function holderOf(
  claims: readonly ShipWorkClaim[],
  role: ShipStationRole,
  now: number
): ShipWorkClaim | null {
  const dead = supersededIds(claims)
  const live = claims.filter((c) => {
    if (c.role !== role) return false
    const s = claimState(c, dead, now)
    return s === 'live' || s === 'stale'
  })
  if (live.length === 0) return null
  return live.reduce((best, c) => {
    const d = c.claimedAt.localeCompare(best.claimedAt)
    if (d !== 0) return d < 0 ? c : best
    return c.id < best.id ? c : best
  })
}

/** The most recent send-back on this order, or null. */
export function sentBackAt(claims: readonly ShipWorkClaim[]): string | null {
  const dead = supersededIds(claims)
  const backs = claims
    .filter((c) => c.role === 'pack' && c.releasedAt && isSendBack(c) && !dead.has(c.id))
    .map((c) => c.releasedAt as string)
    .sort()
  return backs.length > 0 ? backs[backs.length - 1] : null
}

/** A release that was a rejection, not somebody stepping away. */
export function isSendBack(claim: ShipWorkClaim): boolean {
  return !!claim.note && claim.note.startsWith(SEND_BACK_PREFIX)
}

export const SEND_BACK_PREFIX = 'sent back:'

export function sendBackReason(claims: readonly ShipWorkClaim[]): string | null {
  const dead = supersededIds(claims)
  const latest = claims
    .filter((c) => c.role === 'pack' && c.releasedAt && isSendBack(c) && !dead.has(c.id))
    .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))[0]
  if (!latest) return null
  return latest.note?.slice(SEND_BACK_PREFIX.length).trim() || 'no reason given'
}

/**
 * When this order became ready to pack, or null if it is not.
 *
 * Two ways in, and the second is why an EMPTY order cannot slip through: an
 * order with no cards at all is a real and counted case, and deriving readiness
 * purely from "every card is checked" would put every one of them in the pack
 * queue the moment the PDF landed. So a zero-card order can only arrive by the
 * explicit handoff.
 *
 * A SEND-BACK OUTRANKS BOTH. Without that, a packer who rejects an order for a
 * missing card watches it reappear in their own queue a second later — because
 * every card in it is still ticked, and "all checked" reads as ready. The
 * rejection has to survive until somebody hands the order over again.
 */
export function readyToPackAt(args: {
  claims: readonly ShipWorkClaim[]
  cardsTotal: number
  cardsChecked: number
  lastCheckedAt: string | null
}): string | null {
  const handoff = handedOverAt(args.claims)
  if (handoff) return handoff
  if (sentBackAt(args.claims)) return null
  if (args.cardsTotal > 0 && args.cardsChecked >= args.cardsTotal) return args.lastCheckedAt
  return null
}

/**
 * When a picker handed this order to the packing bench, or null.
 *
 * The first branch of `readyToPackAt`, split out because two questions need it
 * and only one of them may fall back to "every card is ticked".
 *
 * READINESS may fall back: an order whose cards were all found on the Orders
 * screen really is ready for whoever is packing, and belongs in the queue.
 * HAS IT REACHED A BENCH may not — that fallback is true of every fully-picked
 * order on a night where nobody ever stood at one, and reading it as outstanding
 * bench work would hold such a night open against a packer who does not exist.
 *
 * One implementation rather than two, because a second copy of "a handoff only
 * counts if it happened after the last rejection" is a second copy that drifts.
 */
export function handedOverAt(claims: readonly ShipWorkClaim[]): string | null {
  const dead = supersededIds(claims)
  const back = sentBackAt(claims)
  const handoffs = claims
    .filter((c) => c.role === 'pick' && c.finishedAt && !c.releasedAt && !dead.has(c.id))
    .map((c) => c.finishedAt as string)
    // A handoff only counts if it happened AFTER the last rejection. Filtered
    // BEFORE the earliest is taken, and that ordering is load-bearing: a packer
    // only releases its OWN rows, so a rejection at bench B leaves the original
    // handoff from bench A standing. Taking the earliest first and then testing
    // it would let that stale row answer for the re-pick that followed — the
    // order would read as never handed over again, drop out of the pack queue,
    // and — its repick now done — out of the picking run as well. An order
    // vanishing from both queues is the one outcome this whole design exists to
    // prevent.
    .filter((t) => !back || t > back)
    .sort()
  // The EARLIEST of the handoffs that still count, so an order that has been
  // round twice keeps its place in the queue rather than going to the back.
  return handoffs.length > 0 ? handoffs[0] : null
}

/**
 * Is a packer holding this order right now — or did one walk away with it?
 *
 * Deliberately NOT `holderOf('pack')`, which drops an expired claim so that
 * somebody else may take the order over. That is the right answer to "whose is
 * it"; it is the wrong answer to "is there work left in it". A bench abandoned
 * at 8pm leaves a box that is still not in a mailer, and a claim going quiet
 * must never be what makes the work disappear.
 */
export function packUnderway(claims: readonly ShipWorkClaim[]): boolean {
  const dead = supersededIds(claims)
  return claims.some((c) => c.role === 'pack' && !c.finishedAt && !c.releasedAt && !dead.has(c.id))
}

/**
 * Does this order need picking again?
 *
 * True when a packer rejected it and nobody has handed it over since. Its cards
 * are all still ticked — the point is that one of them is wrong or missing — so
 * without this it would sit in neither queue and simply be forgotten.
 */
export function needsRepick(claims: readonly ShipWorkClaim[]): boolean {
  const dead = supersededIds(claims)
  const back = sentBackAt(claims)
  if (!back) return false
  const later = claims.some(
    (c) => c.role === 'pick' && c.finishedAt && !c.releasedAt && !dead.has(c.id) && c.finishedAt > back
  )
  return !later
}

/** What a floor screen needs to draw one order. */
export interface ShipStationOrder {
  orderId: string
  customerId: string
  handle: string
  realName: string | null
  /** Where this customer's slip sits in the uploaded PDF. Empty if unknown. */
  pages: number[]
  cardsTotal: number
  cardsChecked: number
  onHold: boolean
  /** Set when somebody else has it. Null when it is free or yours. */
  heldByName: string | null
  heldByStation: string | null
  heldStale: boolean
  mine: boolean
  /** Pack queue only: when it was handed over. */
  readyAt: string | null
  /** Set when a packer sent it back, with their reason. */
  sentBackReason: string | null
  /**
   * The whole order — every break, every team — for the ONE order a bench is
   * holding, and null for every other.
   *
   * The bench draws the same pane as the Orders tab, and that pane needs the
   * teams, not a count of them. Carrying it on the board rather than fetching it
   * separately is what keeps the two screens showing the same thing at the same
   * moment; carrying it ONLY for `current` is what keeps a two-hundred-order
   * night from shipping two hundred break lists down a channel that fires every
   * time anyone anywhere ticks a card.
   *
   * The import below is `import type` in both directions — shippingViews already
   * names ShipStationRole from this file — so the cycle is erased at compile
   * time and nothing circular exists at runtime.
   */
  detail: ShipOrderRow | null
}

/**
 * What one "Picked · next order" did, as the bench needs to read it.
 *
 * The main process returns more than this — the finished row, the next order —
 * but a screen only has to know two things: whether the night's picking just
 * ended on THIS click, and how much is still stacked up behind it at the mailing
 * bench. The second matters because the first does not wait for it: picking can
 * finish with boxes still to pack, and saying so is better than pretending the
 * bench is empty.
 */
export interface ShipPickAdvanced {
  /** True for the ONE caller whose pick closed SOP step 5. */
  sopShipCompleted: boolean
  /** Orders handed over and still waiting for a packer. */
  queueDepth: number
}

export interface ShipStationSession {
  stationId: string
  operatorId: string
  operatorName: string | null
  role: ShipStationRole
  startedAt: string
}

/** The whole floor view in one read. */
export interface ShipStationBoard {
  session: ShipStationSession | null
  /** Orders still to pick — what a picker walks. */
  toPick: number
  /** Handed over and waiting for a packer. */
  packQueue: number
  /**
   * Orders the bench still owes a mailer, whoever is holding them.
   *
   * NOT `packQueue`, which is what a packer standing here may take next and so
   * hides an order in somebody else's hands. This is the whole room's figure,
   * and it is what SOP steps 6 and 7 wait for.
   */
  packingRemaining: number
  /** The order this station is holding, if any. */
  current: ShipStationOrder | null
  /** Everyone working right now, for the "who else is on" strip. */
  others: Array<{ operatorName: string | null; role: ShipStationRole; orderHandle: string | null }>
  /** True when every order is picked AND packed. */
  allDone: boolean
}
