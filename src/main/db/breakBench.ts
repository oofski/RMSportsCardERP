/**
 * The bench checklist: what happens to a break before anything ships.
 *
 * Three steps per break — sleeve and top-load, sort into trays by team, then
 * team-bag and sticker each team against its buyer — and packing does not start
 * until every break has finished all three. The vocabulary, the gates and the
 * ordering live in @shared/breakSteps; this is the part that touches the
 * database.
 *
 * ## The gates are enforced HERE, not on screen
 *
 * A greyed-out button is a hint. The rule that a break cannot be bagged before
 * it is sorted has to hold against a stale tab, a second laptop that synced
 * mid-edit, and the web client — none of which are the screen that greyed the
 * button out. So every mutation re-reads the break's state and refuses on its
 * own account.
 *
 * ## Step 3 rides on the pick list's existing checkmark
 *
 * A sold team's bag tick IS `ship_team_slots.checked_off` — the same flag the
 * pick list has always used, because "this team's card is accounted for" is the
 * same fact both screens are asserting. Reusing it means the two can never
 * disagree and nobody ticks anything twice. Only the teams NOBODY bought need
 * somewhere else to live, because they have no card row at all; those go in
 * ship_break_team_bags.
 */
import type { ShipBreak, ShipCustomer, ShipTeamSlot } from '@shared/shippingTypes'
import { SHIP_STATUS_RANK } from '@shared/shippingTypes'
import type {
  BreakBagRow,
  BreakBenchDetail,
  BreakStepId,
  BreakStepState,
  FloorPackages
} from '@shared/breakSteps'
import {
  bagRowId,
  blockedReason,
  breakStep,
  canStartStep,
  isBreakReady,
  notReadyMessage,
  shipGate,
  sortBagRows,
  stepsClearedBy
} from '@shared/breakSteps'
import {
  countBreakTeamBags,
  getShipBreak,
  getShipBreakAudit,
  getShipCustomer,
  getShipTeamSlot,
  listBreakTeamBags,
  listShipBreakAudit,
  listShipBreaks,
  listShipShipments,
  listShipTeamSlots,
  listShipTeamSlotsByBreak,
  setBreakStepStamp,
  setBreakTeamBagged
} from './shipping'
import { recordBagTick, recordBenchStep, recordBreakDone } from './workLog'

/**
 * How many teams a break has to account for.
 *
 * The league slate (30 or 32) when the import worked one out, because all of
 * them are physically in the box whether or not anybody bought them. When there
 * is no audit — an older import, or a dataset restored from a snapshot — the
 * only defensible answer is the number of cards actually recorded: claiming a
 * slate the data cannot support would leave a break permanently short of a
 * total it can never reach, and permanently un-shippable.
 */
function slateSize(breakLabel: string, soldCount: number): number {
  const audit = getShipBreakAudit(breakLabel)
  if (audit && audit.maxTeams > 0) return Math.max(audit.maxTeams, soldCount)
  return soldCount
}

function stateFrom(br: ShipBreak, slots: ShipTeamSlot[], unsoldBagged: number): BreakStepState {
  const checked = slots.filter((s) => s.checkedOff).length
  return {
    breakId: br.id,
    breakLabel: br.breakLabel,
    sleeve: br.sleeve,
    sort: br.sort,
    baggedTeams: checked + unsoldBagged,
    totalTeams: slateSize(br.breakLabel, slots.length)
  }
}

/**
 * Steps 4 and 5's counts: how many packages there are, and how many are through.
 *
 * Counted in PACKAGES, over the whole floor. Nothing on the bench feeds this —
 * see FloorPackages for why the two numbers are unrelated — so a floor with
 * every break bagged and boxed still reports 0 packed, which is the true answer
 * and the one the bench used to get wrong.
 *
 * `packed` is the union of two facts, not one: a package is packed if somebody
 * stamped it at the pack bench, and ALSO if a label has been printed for it.
 * A label means the box was built, whatever order the two happened in — the
 * same rule `_deriveStage` uses, so the bench and the Orders tab cannot report
 * different numbers for the same floor.
 */
export function floorPackages(): FloorPackages {
  let packed = 0
  let shipped = 0
  const all = listShipShipments()
  for (const sh of all) {
    const rank = SHIP_STATUS_RANK[sh.manualStatus?.code ?? 'not_shipped'] ?? 0
    // label_created and beyond.
    if (sh.packedAt || rank >= 1) packed++
    // in_transit and beyond — it has physically left. delivered, exception and
    // returned all sit above this, and every one of them means the package went.
    if (rank >= 2) shipped++
  }
  return { total: all.length, packed, shipped }
}

/** One break's checklist state. */
export function getBreakStepState(breakId: string): BreakStepState | null {
  const br = getShipBreak(breakId)
  if (!br) return null
  const bagged = listBreakTeamBags(breakId).length
  return stateFrom(br, listShipTeamSlotsByBreak(breakId), bagged)
}

/**
 * Every break's checklist state, in one pass.
 *
 * Built from three whole-table reads rather than a query per break: the board
 * shows all of them at once, and a per-break round trip turns one screen into
 * thirty queries on a machine that is also parsing a PDF.
 */
export function listBreakStepStates(): BreakStepState[] {
  const slotsByBreak = new Map<string, ShipTeamSlot[]>()
  for (const s of listShipTeamSlots()) {
    const list = slotsByBreak.get(s.breakId)
    if (list) list.push(s)
    else slotsByBreak.set(s.breakId, [s])
  }
  const bags = countBreakTeamBags()
  const slate = new Map<string, number>()
  for (const a of listShipBreakAudit()) slate.set(a.breakLabel, a.maxTeams)

  return listShipBreaks().map((br) => {
    const slots = slotsByBreak.get(br.id) ?? []
    const checked = slots.filter((s) => s.checkedOff).length
    const max = slate.get(br.breakLabel) ?? 0
    return {
      breakId: br.id,
      breakLabel: br.breakLabel,
      sleeve: br.sleeve,
      sort: br.sort,
      baggedTeams: checked + (bags.get(br.id) ?? 0),
      totalTeams: max > 0 ? Math.max(max, slots.length) : slots.length
    }
  })
}

/**
 * The step-3 work list for one break: every team, its buyer, and its tick.
 *
 * Sold teams come from the card rows and carry a real slip position. Unsold
 * teams come from the import's slate audit — they printed on no slip, so they
 * have no position and sort last rather than being scattered through the list
 * at a place they were never at.
 */
export function getBreakBench(breakId: string): BreakBenchDetail | null {
  const br = getShipBreak(breakId)
  if (!br) return null

  const slots = listShipTeamSlotsByBreak(breakId)
  const bagged = new Set(listBreakTeamBags(breakId).map((b) => b.teamName))
  const customers = new Map<string, ShipCustomer | null>()

  const rows: BreakBagRow[] = slots.map((s) => {
    if (!customers.has(s.customerId)) customers.set(s.customerId, getShipCustomer(s.customerId))
    const c = customers.get(s.customerId) ?? null
    return {
      teamName: s.teamName,
      handle: c?.whatnotHandle || s.customerId || null,
      realName: c?.realName ?? '',
      slotId: s.id,
      bagged: s.checkedOff,
      baggedAt: s.checkedOffAt,
      orderId: s.orderId,
      // Stamped by sortBagRows once the list is in purchase order.
      buyOrder: null,
      slipPage: s.slipPage,
      slipPosition: s.slipPosition,
      isGiveaway: s.isGiveaway
    }
  })

  // The teams nobody bought. Still in the box, still bagged, still counted.
  const audit = getShipBreakAudit(br.breakLabel)
  for (const teamName of audit?.missingTeams ?? []) {
    rows.push({
      teamName,
      handle: null,
      realName: '',
      slotId: null,
      bagged: bagged.has(teamName),
      baggedAt: null,
      orderId: null,
      buyOrder: null,
      slipPage: null,
      slipPosition: null,
      isGiveaway: false
    })
  }

  const state = stateFrom(br, slots, rows.filter((r) => !r.slotId && r.bagged).length)
  // Steps 4 and 5 are about the whole floor, so they need every break's state,
  // not this one's. listBreakStepStates is three whole-table reads rather than
  // a query per break — see its own note — so asking for all of them here costs
  // about what asking for one would.
  return {
    state,
    rows: sortBagRows(rows),
    bagBlockedReason: blockedReason('bag', state),
    shipGate: shipGate(breakId, listBreakStepStates(), floorPackages())
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Tick or un-tick one of the two whole-break steps.
 *
 * Refuses a step whose predecessor is not done. Un-ticking cascades forward —
 * see stepsClearedBy — because leaving "sorted" true under an un-ticked
 * "sleeved" would record a state the checklist says cannot happen.
 */
export function setBreakStep(
  breakId: string,
  step: BreakStepId,
  done: boolean,
  userId: string | null
): BreakBenchDetail {
  if (step === 'bag') {
    // Step 3 is thirty separate ticks and has no single switch: "all bagged"
    // as one button is exactly the click that gets pressed on a break where
    // four teams were never actually bagged.
    throw new Error('Team-bagging is ticked team by team, not all at once.')
  }
  const state = getBreakStepState(breakId)
  if (!state) throw new Error('Break not found.')

  if (done && !canStartStep(step, state)) {
    throw new Error(blockedReason(step, state) ?? 'That step cannot be started yet.')
  }
  const after = setBreakStepStamp(breakId, step, done, userId)
  // The stamp that was actually written, not a second call to the clock. Two
  // readings of `now` a millisecond apart would put the work log's idea of when
  // this happened next to the break's own and let them disagree — which is
  // exactly the kind of drift a duration derived from the pair would inherit.
  const stampedAt = (step === 'sleeve' ? after?.sleeve.at : after?.sort.at) ?? null
  recordBenchStep(breakId, step, done, userId, stampedAt ?? new Date().toISOString())
  if (!done) {
    for (const later of stepsClearedBy(step)) {
      if (later !== 'bag') {
        setBreakStepStamp(breakId, later, false, userId)
        recordBenchStep(breakId, later, false, userId, '')
      }
    }
  }
  return getBreakBench(breakId) as BreakBenchDetail
}

/**
 * Bag one team.
 *
 * A sold team routes to the pick list's checkmark; an unsold one to its own
 * record. The caller passes a team NAME rather than a slot id precisely so it
 * does not have to know which of those it is looking at — the two are the same
 * gesture on the bench and only differ in where the fact lands.
 */
export function setTeamBagged(
  breakId: string,
  teamName: string,
  bagged: boolean,
  userId: string | null,
  /** Injected so this file does not import the slot mutation from its caller. */
  checkSlot: (slotId: string, on: boolean, by: string | null) => void
): BreakBenchDetail {
  const state = getBreakStepState(breakId)
  if (!state) throw new Error('Break not found.')
  // Ticking is gated; UN-ticking never is. A correction to work already done
  // must not be blocked by a step somebody has since un-ticked, or the record
  // would be stuck wrong with no way to fix it.
  if (bagged && !canStartStep('bag', state)) {
    throw new Error(blockedReason('bag', state) ?? 'This break is not ready to be bagged.')
  }

  const slot = listShipTeamSlotsByBreak(breakId).find((s) => s.teamName === teamName)
  // The subject a measurement hangs off, and it has to be stable: the card
  // slot's id for a sold team, the derived bag row id for an unsold one. Both
  // survive a re-tick, so the work log's derived row id cannot split in two.
  let subjectId: string
  let stampedAt: string | null
  if (slot) {
    checkSlot(slot.id, bagged, userId)
    subjectId = slot.id
    // Re-read rather than reusing the pre-write row: `checkSlot` is injected and
    // stamps its own clock, and the whole point of the pair of endpoints is that
    // they come from the same place the screens read.
    stampedAt = getShipTeamSlot(slot.id)?.checkedOffAt ?? null
  } else {
    subjectId = bagRowId(breakId, teamName)
    stampedAt = setBreakTeamBagged(breakId, teamName, bagged, userId).baggedAt
  }
  recordBagTick({
    breakId,
    subjectId,
    bagged,
    by: userId,
    finishedAt: stampedAt ?? new Date().toISOString()
  })

  const detail = getBreakBench(breakId) as BreakBenchDetail
  // "How many breaks were done in the range" is the first thing the owner asked
  // for, and it is asked long after the dataset that could answer it has been
  // overwritten. So the moment a break comes off the bench is recorded as it
  // happens, by the tick that did it. Re-recording an already-finished break is
  // an upsert onto the same derived id, so a correction elsewhere on the break
  // cannot turn one break into two.
  if (bagged && isBreakReady(detail.state)) {
    recordBreakDone(breakId, userId, stampedAt ?? new Date().toISOString())
  }
  return detail
}

// ---------------------------------------------------------------------------
// The shipping gate
// ---------------------------------------------------------------------------

/**
 * Refuse to pack a package whose breaks are not off the bench.
 *
 * Checked against the breaks THIS package touches rather than all of them: a
 * bench working through twenty breaks would otherwise be unable to ship
 * anything until the last one was finished, which is not what "once all the
 * breaks are done" means for a package whose own breaks are all boxed.
 *
 * Returns null when packing may proceed, and a message NAMING the breaks and
 * what each still needs when it may not. "Not ready" sends somebody hunting;
 * "#11A still needs sorting" sends them to a tray.
 */
export function packBlockedReason(breakIds: string[]): string | null {
  const wanted = new Set(breakIds.filter(Boolean))
  if (!wanted.size) return null
  const states = listBreakStepStates().filter((s) => wanted.has(s.breakId))
  return notReadyMessage(states)
}

export function isBreakOffBench(breakId: string): boolean {
  const state = getBreakStepState(breakId)
  return !!state && isBreakReady(state)
}

/** Used by the tab badge: how many breaks still have bench work. */
export function benchWorkRemaining(): { breaks: number; teams: number } {
  const states = listBreakStepStates()
  const open = states.filter((s) => !isBreakReady(s))
  return {
    breaks: open.length,
    teams: open.reduce((sum, s) => sum + Math.max(0, s.totalTeams - s.baggedTeams), 0)
  }
}

/** The label of the step a break is on, for a one-line status on a card. */
export function stepLabel(step: BreakStepId): string {
  return breakStep(step).label
}
