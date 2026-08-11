/**
 * The three things that happen to a break, in order, before anything ships.
 *
 * A packing slip lands and every break in it goes through the same sequence on
 * the bench:
 *
 *   1. SLEEVE   Every card in the break goes into a penny sleeve and a top
 *               loader. One tick for the break — it is one motion over one pile.
 *   2. SORT     The sleeved cards are laid into trays, one team per tray. Also
 *               one tick, for the same reason.
 *   3. BAG      Team by team: take the sticker, read off the buyer the system
 *               pulled for that team in that break, team-bag it, sticker it,
 *               and put it in the break box. THIRTY ticks, because thirty
 *               separate things happen and each one can be got wrong on its own.
 *
 * Only when every break has finished all three does packing and scanning start.
 *
 * ## Why the third step is per team and the first two are not
 *
 * Steps 1 and 2 are true of the PILE. There is no useful state between "started
 * sleeving" and "finished sleeving" that a screen could act on — nothing
 * downstream branches on half a pile being sleeved, and a per-card sleeve tick
 * would be thirty clicks that never get read.
 *
 * Step 3 is different: each team is matched against a named buyer, and getting
 * one wrong sends a stranger's card to somebody. That is a per-team fact worth
 * recording per team, and it is ALREADY recorded — the pick list's existing
 * checkmark is exactly "this team's card is accounted for". So step 3 reuses it
 * rather than inventing a second tick people would have to hit twice.
 *
 * ## Unsold teams
 *
 * All thirty (or thirty-two) teams are physically in the box, whether or not
 * anybody bought them, and all thirty get bagged. The teams nobody bought have
 * no card row to tick — they exist only in the import's slate audit — so they
 * get their own small record. They are still real work, so they still count.
 *
 * ## Order
 *
 * Teams are listed in the order the paperwork prints them, so the screen and
 * the sticker stack are walked the same way. A team nobody bought appears on no
 * slip, so it has no printed position and sorts after the ones that do. See
 * `compareBagRows`.
 */

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

export type BreakStepId = 'sleeve' | 'sort' | 'bag'

export interface BreakStepDef {
  id: BreakStepId
  /** 1, 2, 3 — printed on the screen, and the order they must happen in. */
  n: number
  label: string
  /** What the person actually does. Shown under the label. */
  detail: string
  /** True when the step is ticked team-by-team rather than once. */
  perTeam: boolean
}

export const BREAK_STEPS: BreakStepDef[] = [
  {
    id: 'sleeve',
    n: 1,
    label: 'Sleeve & top-load',
    detail: 'Every card in this break into a sleeve and a top loader.',
    perTeam: false
  },
  {
    id: 'sort',
    n: 2,
    label: 'Sort into trays',
    detail: 'Lay the sleeved cards into trays, one team per tray.',
    perTeam: false
  },
  {
    id: 'bag',
    n: 3,
    label: 'Sticker & team-bag',
    detail: 'Team by team: match the buyer, bag it, sticker it, into the break box.',
    perTeam: true
  }
]

/**
 * The two that are NOT per break: they happen once, to packages, after every
 * break on the floor is boxed.
 *
 * They live on the same numbered list as steps 1-3 even though nothing about
 * them is ticked here, because the checklist ending at "team-bagged" made the
 * bench look like the whole job. Somebody working down a break had no way to
 * see what came next or what was still holding it up — the gate existed and
 * refused them, but only at the moment they tried to pack, from a different
 * screen. Shown here, greyed, with the breaks that are holding it named.
 */
export type ShipStepId = 'pack' | 'scan'

/**
 * Deliberately NOT a BreakStepDef. These carry no per-break state and must
 * never reach `canStartStep` or `isStepDone`, both of which decide whether a
 * BREAK is finished — a pack step answering "done?" there would make every
 * break permanently unfinished and nothing would ever ship.
 */
export interface ShipStepDef {
  id: ShipStepId
  n: number
  label: string
  detail: string
}

export const SHIP_STEPS: ShipStepDef[] = [
  {
    id: 'pack',
    n: BREAK_STEPS.length + 1,
    label: 'Pack',
    detail: 'Build each buyer’s package from the break boxes.'
  },
  {
    id: 'scan',
    n: BREAK_STEPS.length + 2,
    label: 'Scan & ship',
    detail: 'Label it, scan it out, and hand it to the carrier.'
  }
]

export function breakStep(id: BreakStepId): BreakStepDef {
  const found = BREAK_STEPS.find((s) => s.id === id)
  // Every id in the type has an entry, so this is unreachable — but returning a
  // real object beats a crash on a screen somebody is holding cards in front of.
  return found ?? BREAK_STEPS[0]
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Who did a one-tick step, and when. Null throughout means "not done". */
export interface StepStamp {
  at: string | null
  by: string | null
}

export const NO_STAMP: StepStamp = { at: null, by: null }

export function isStamped(stamp: StepStamp | null | undefined): boolean {
  return !!stamp?.at
}

/**
 * One team's line in step 3.
 *
 * `handle` is the buyer the import pulled for this team in this break — the
 * thing being matched against the sticker. It is null for a team nobody bought,
 * which is a different situation from a team whose buyer could not be read, and
 * the screen says so rather than printing an empty space.
 */
export interface BreakBagRow {
  teamName: string
  /** The Whatnot handle, or null when nobody bought this team. */
  handle: string | null
  /** Their real name, for the sticker. Empty when unsold or unknown. */
  realName: string
  /** The slot this ticks, or null for an unsold team (which has no card row). */
  slotId: string | null
  bagged: boolean
  baggedAt: string | null
  /**
   * The order id off the packing slip — "Order 7000000001".
   *
   * This is the sequence the teams were BOUGHT in, and therefore the order the
   * stickers come out in. Shown on the row so it can be read against the
   * sticker in hand, which is the only check that catches a sticker sheet
   * printed from a different break.
   */
  orderId: string | null
  /**
   * 1, 2, 3 … down the sticker stack, after sorting.
   *
   * Assigned over the sorted list rather than parsed, because the useful number
   * is "how far down the stack am I", not the ten-digit order id. Null for a
   * team nobody bought — those are not in the stack at all.
   */
  buyOrder: number | null
  /**
   * Where this team printed on the paperwork: the page, then the line.
   *
   * Null for a team nobody bought — it appears on no slip at all — and null for
   * anything imported before positions were recorded. Both sort last rather
   * than pretending to a position they do not have.
   */
  slipPage: number | null
  slipPosition: number | null
  /** A giveaway rides along in the same box and still has to be bagged. */
  isGiveaway: boolean
}

export interface BreakStepState {
  breakId: string
  breakLabel: string
  sleeve: StepStamp
  sort: StepStamp
  /** How many of the slate's teams are bagged, and how many there are. */
  baggedTeams: number
  totalTeams: number
}

/**
 * One break's whole checklist, as a screen receives it.
 *
 * Lives here rather than beside the query that builds it because the bridge and
 * the renderer both name this type, and neither may reach into the main
 * process to find it.
 */
export interface BreakBenchDetail {
  state: BreakStepState
  /** Every team in the slate, in the order the paperwork prints them. */
  rows: BreakBagRow[]
  /** Null when step 3 may be worked on; the reason when it may not. */
  bagBlockedReason: string | null
  /** What steps 4 and 5 say: locked, waiting on other breaks, or go. */
  shipGate: ShipGate
}

/**
 * The floor's PACKAGE counts — steps 4 and 5's denominator.
 *
 * This is a different number from anything on the bench, and that is the whole
 * reason it exists. Steps 1-3 are counted in teams inside one break; steps 4
 * and 5 are counted in packages across the whole floor, and one has no
 * arithmetic relationship to the other — thirty teams bagged in break 11 does
 * not put a single package on the pack bench, because a package is one buyer's
 * cards gathered from every break they bought in.
 *
 * Reading the bench as though it did was the bug: finishing the breaks made
 * steps 4 and 5 look like they had come along too, when nothing had been packed
 * at all. So they carry their own count, and it starts at zero.
 */
export interface FloorPackages {
  /** Every package in the dataset — the whole order amount. */
  total: number
  /** Built and set aside. A shipped package is also a packed one. */
  packed: number
  /** Scanned out and gone. */
  shipped: number
}

export const NO_PACKAGES: FloorPackages = { total: 0, packed: 0, shipped: 0 }

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * The order the teams were BOUGHT in — which is the order the stickers print in.
 *
 * The order id leads, because that is the only field on the slip that encodes
 * purchase time: Whatnot issues them in sequence as orders are placed, so
 * ascending order id within one break is the sequence the sales happened in.
 *
 * This is not the same as where a line printed. `slipPosition` is an ordinal
 * over PACKS — one customer who bought six teams occupies one position — so
 * sorting by it interleaved the six with everybody else's and the list stopped
 * matching the stack in the operator's hand. It stays as the tiebreak for
 * anything imported before order ids were captured, where it is still better
 * than alphabetical.
 *
 * Ties break on team name so the list can never reorder itself between two
 * renders of the same data — a list that shuffles while somebody is working
 * down it is worse than one in a slightly wrong order.
 */
export function orderSeq(orderId: string | null | undefined): number {
  // Ten digits fits a double exactly, so no precision games. Anything that is
  // not a clean number sorts last rather than to zero — sorting an unparseable
  // id to the FRONT would put the one row nobody can explain at the top of the
  // stack, which is where somebody starts working.
  const digits = (orderId ?? '').replace(/\D+/g, '')
  if (!digits) return Number.MAX_SAFE_INTEGER
  const n = Number(digits)
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER
}

export function compareBagRows(a: BreakBagRow, b: BreakBagRow): number {
  const ao = orderSeq(a.orderId)
  const bo = orderSeq(b.orderId)
  if (ao !== bo) return ao - bo
  const ap = a.slipPage ?? Number.MAX_SAFE_INTEGER
  const bp = b.slipPage ?? Number.MAX_SAFE_INTEGER
  if (ap !== bp) return ap - bp
  const ai = a.slipPosition ?? Number.MAX_SAFE_INTEGER
  const bi = b.slipPosition ?? Number.MAX_SAFE_INTEGER
  if (ai !== bi) return ai - bi
  return a.teamName.localeCompare(b.teamName)
}

/**
 * Sort, then number the stack.
 *
 * `buyOrder` is stamped here rather than parsed because it is a position in
 * THIS list — renumbering has to happen wherever the list is built, or the
 * number on screen stops agreeing with the row it sits on.
 *
 * Only rows that were actually bought get a number. A team nobody bought has no
 * sticker and is not in the stack, so numbering it would make the stack look
 * longer than the paper in somebody's hand.
 */
export function sortBagRows(rows: BreakBagRow[]): BreakBagRow[] {
  let n = 0
  return [...rows].sort(compareBagRows).map((r) => ({
    ...r,
    buyOrder: r.handle ? ++n : null
  }))
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * Whether a step may be worked on yet.
 *
 * The order is the point of the checklist: bagging a team whose cards are not
 * sleeved means opening the bag again, and sorting an unsleeved pile means
 * handling every card twice. So step 2 waits for step 1 and step 3 waits for
 * both — enforced in the main process, not only greyed out on screen, because a
 * gate that only exists in the UI is not a gate.
 */
export function canStartStep(step: BreakStepId, state: BreakStepState): boolean {
  switch (step) {
    case 'sleeve':
      return true
    case 'sort':
      return isStamped(state.sleeve)
    case 'bag':
      return isStamped(state.sleeve) && isStamped(state.sort)
    default: {
      const never: never = step
      throw new Error(`Unknown break step: ${String(never)}`)
    }
  }
}

/** Why a step cannot be started, phrased for the person holding the cards. */
export function blockedReason(step: BreakStepId, state: BreakStepState): string | null {
  if (canStartStep(step, state)) return null
  if (step === 'sort') return 'Sleeve and top-load this break first.'
  return isStamped(state.sleeve)
    ? 'Sort this break into trays first.'
    : 'Sleeve, top-load and sort this break first.'
}

/**
 * Un-ticking a step un-ticks the ones after it.
 *
 * If somebody says the sleeving was not actually finished, then the sorting
 * done on top of it was not finished either — leaving step 2 ticked under an
 * un-ticked step 1 would claim a state the checklist says cannot exist. The
 * per-team bag ticks are NOT cleared: those are cards physically in bags, and
 * throwing away that record because of a correction upstream would send
 * somebody back through thirty teams they already did.
 */
export function stepsClearedBy(step: BreakStepId): BreakStepId[] {
  if (step === 'sleeve') return ['sort']
  return []
}

export function isStepDone(step: BreakStepId, state: BreakStepState): boolean {
  if (step === 'sleeve') return isStamped(state.sleeve)
  if (step === 'sort') return isStamped(state.sort)
  return state.totalTeams > 0 && state.baggedTeams >= state.totalTeams
}

/** Every step finished — the break is in its box and ready to be packed from. */
export function isBreakReady(state: BreakStepState): boolean {
  return BREAK_STEPS.every((s) => isStepDone(s.id, state))
}

/** The step somebody should be working on, or null when the break is done. */
export function currentStep(state: BreakStepState): BreakStepId | null {
  return BREAK_STEPS.find((s) => !isStepDone(s.id, state))?.id ?? null
}

/**
 * 0..1 across all three steps, weighted so the thirty-tick step is most of it.
 *
 * Steps 1 and 2 are a click each; step 3 is thirty pieces of work. Giving them
 * a third of the bar each would show a break at 67% with every card still
 * loose, which is the one reading a progress bar must never give.
 */
export function breakProgress(state: BreakStepState): number {
  const bagShare = state.totalTeams > 0 ? state.baggedTeams / state.totalTeams : 0
  const done = (isStamped(state.sleeve) ? 1 : 0) + (isStamped(state.sort) ? 1 : 0)
  return Math.min(1, done * 0.1 + bagShare * 0.8)
}

// ---------------------------------------------------------------------------
// The shipping gate
// ---------------------------------------------------------------------------

/**
 * Which breaks are holding up packing.
 *
 * Packing is refused while any break a package touches is unfinished, and the
 * refusal has to NAME them: "not ready" sends somebody hunting, "#11A still
 * needs sorting" sends them to a tray.
 */
export function breaksNotReady(states: BreakStepState[]): BreakStepState[] {
  return states.filter((s) => !isBreakReady(s))
}

export function notReadyMessage(states: BreakStepState[]): string | null {
  const blocked = breaksNotReady(states)
  if (!blocked.length) return null
  const parts = blocked.map((s) => {
    const step = currentStep(s)
    const what = step === 'bag' ? `${s.baggedTeams}/${s.totalTeams} bagged` : breakStep(step ?? 'sleeve').label
    return `#${s.breakLabel} (${what})`
  })
  const list = parts.length <= 3 ? parts.join(', ') : `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more`
  return `${blocked.length === 1 ? 'This break is' : 'These breaks are'} not finished on the bench yet: ${list}.`
}

/**
 * What steps 4 and 5 say on ONE break's checklist.
 *
 * Three states, because there are genuinely three situations and collapsing
 * them loses the one that matters most:
 *
 *   locked   This break is not off the bench. Nothing to discuss.
 *   waiting  This break IS boxed, but others are not. The person who just
 *            finished it needs to know their break is not the hold-up — and
 *            WHICH ones are, so the floor can go help rather than stand around.
 *   go       Everything is boxed. Packing starts.
 *
 * The middle state is the reason this exists. Showing a flat "locked" on a
 * break somebody has just finished reads as though their own work failed, and
 * that is the reading that sends them back through thirty bags they already
 * did correctly.
 */
export type ShipGateStatus = 'locked' | 'waiting' | 'go'

export interface ShipGate {
  status: ShipGateStatus
  reason: string
  /**
   * How many packages there are and how far they have got.
   *
   * Carried on the gate rather than fetched separately by the screen so that
   * "am I allowed to pack" and "how much packing is there" arrive together and
   * cannot be rendered a render apart, showing a green go over a stale zero.
   */
  packages: FloorPackages
}

export function shipGate(
  breakId: string,
  all: BreakStepState[],
  packages: FloorPackages
): ShipGate {
  const mine = all.find((s) => s.breakId === breakId) ?? null
  if (!mine || !isBreakReady(mine)) {
    const step = mine ? currentStep(mine) : null
    return {
      packages,
      status: 'locked',
      reason: step
        ? `Finish this break first — step ${breakStep(step).n}, ${breakStep(step).label.toLowerCase()}.`
        : 'Finish this break on the bench first.'
    }
  }
  const others = all.filter((s) => s.breakId !== breakId && !isBreakReady(s))
  if (others.length) {
    return {
      packages,
      status: 'waiting',
      reason: `This break is boxed. ${notReadyMessage(others)}`
    }
  }
  return {
    packages,
    status: 'go',
    reason: 'Every break is off the bench — packing can start.'
  }
}

// ---------------------------------------------------------------------------
// Steps 4 and 5, as the bench shows them
// ---------------------------------------------------------------------------

/**
 * `locked` nothing can be done here yet. `ready` it can be started. `done`
 * every package has been through it.
 *
 * `done` is deliberately reachable ONLY through the package count, never
 * through the gate. The gate opening means "you are allowed to pack now",
 * which is the opposite of "packing is finished" — and the screen that
 * conflated the two is the one being fixed.
 */
export type ShipStepStatus = 'locked' | 'ready' | 'done'

export interface ShipStepView extends ShipStepDef {
  status: ShipStepStatus
  /** Packages through this step, and packages there are. Starts at 0 of N. */
  done: number
  total: number
  /** Why it cannot be started. Null when it can, or is already finished. */
  reason: string | null
}

/**
 * What steps 4 and 5 read on the bench, counted in packages.
 *
 * Step 5 has a second gate of its own: a package that has not been built cannot
 * be scanned out, so scanning stays locked until packing is finished, and says
 * how many packages are still to pack rather than repeating the bench's reason
 * — by then the bench is not what is holding it up.
 */
export function shipStepViews(gate: ShipGate): ShipStepView[] {
  const p = gate.packages
  const complete = (n: number): boolean => p.total > 0 && n >= p.total
  const open = gate.status === 'go'

  return SHIP_STEPS.map((s) => {
    if (s.id === 'pack') {
      const status: ShipStepStatus = complete(p.packed) ? 'done' : open ? 'ready' : 'locked'
      return {
        ...s,
        status,
        done: p.packed,
        total: p.total,
        reason: status === 'locked' ? gate.reason : null
      }
    }
    const packingLeft = Math.max(0, p.total - p.packed)
    const status: ShipStepStatus = complete(p.shipped)
      ? 'done'
      : open && p.total > 0 && packingLeft === 0
        ? 'ready'
        : 'locked'
    return {
      ...s,
      status,
      done: p.shipped,
      total: p.total,
      reason:
        status !== 'locked'
          ? null
          : !open
            ? gate.reason
            : p.total === 0
              ? 'No packages on the floor yet.'
              : `${packingLeft} of ${p.total} ${packingLeft === 1 ? 'package is' : 'packages are'} still to pack.`
    }
  })
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The id of an unsold team's bag record.
 *
 * DERIVED, not random. Two laptops ticking the same team of the same break must
 * produce the SAME row, so last-write-wins compares a row against an older copy
 * of itself rather than picking between two rows that both describe one bag.
 * The same reasoning as the availability and shift ids.
 */
export function bagRowId(breakId: string, teamName: string): string {
  return `bag_${breakId}_${teamSlug(teamName)}`
}

/** Lowercase, punctuation-free, single-underscore — stable across re-imports. */
export function teamSlug(teamName: string): string {
  return (teamName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
