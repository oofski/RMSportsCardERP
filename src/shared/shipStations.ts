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
  const dead = supersededIds(args.claims)
  const back = sentBackAt(args.claims)
  const handoffs = args.claims
    .filter((c) => c.role === 'pick' && c.finishedAt && !c.releasedAt && !dead.has(c.id))
    .map((c) => c.finishedAt as string)
    .sort()
  const handoff = handoffs.length > 0 ? handoffs[0] : null

  // A handoff only counts if it happened AFTER the last rejection.
  if (handoff && (!back || handoff > back)) return handoff
  if (back) return null
  if (args.cardsTotal > 0 && args.cardsChecked >= args.cardsTotal) return args.lastCheckedAt
  return null
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
  /** The order this station is holding, if any. */
  current: ShipStationOrder | null
  /** Everyone working right now, for the "who else is on" strip. */
  others: Array<{ operatorName: string | null; role: ShipStationRole; orderHandle: string | null }>
  /** True when every order is picked AND packed. */
  allDone: boolean
}
