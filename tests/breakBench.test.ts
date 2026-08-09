/**
 * The bench checklist: sleeve, sort, then team-bag every team in the break.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE ORDER IS THE POINT. Bagging a break whose cards are not sleeved
 *      means opening every bag again; sorting an unsleeved pile means handling
 *      every card twice. The gates are enforced in the MAIN PROCESS, so a stale
 *      tab, a second laptop and the web client all hit the same refusal — a
 *      gate that only greys out a button is not a gate.
 *
 *   2. STEP 3 IS THE PICK LIST'S OWN CHECKMARK. Bagging a sold team ticks the
 *      exact flag the pick list has always used. A second parallel flag would
 *      let the two screens disagree about whether a card is accounted for,
 *      which is the disagreement that sends people to look in the boxes.
 *
 *   3. ALL THIRTY TEAMS COUNT. The teams nobody bought are still physically in
 *      the box and still get bagged. They have no card row, so they live in
 *      ship_break_team_bags — and a break is not finished until they are done
 *      too.
 *
 *   4. NOTHING SHIPS EARLY. A package cannot move forward past picking while
 *      any break it touches is unfinished, and the refusal NAMES the break and
 *      what it still needs. "Not ready" sends somebody hunting.
 *
 *   5. UN-TICKING IS NEVER BLOCKED. A correction to work already recorded must
 *      stay possible whatever state the checklist is in, or a mis-tick is
 *      permanent.
 *
 * Run: npm run test:bench
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/bench-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const bench = require('../src/main/db/breakBench')
const { parsePages } = require('../src/main/shipping/parser')
const {
  BREAK_STEPS,
  bagRowId,
  breakProgress,
  canStartStep,
  compareBagRows,
  currentStep,
  isBreakReady,
  notReadyMessage,
  SHIP_STEPS,
  shipGate,
  sortBagRows,
  stepsClearedBy,
  teamSlug
} = require('../src/shared/breakSteps')

let pass = 0
let fail = 0
const ok = (c: boolean, name: string, extra = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}
const threw = (fn: () => unknown): string => {
  try {
    fn()
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

getDb()

// ---------------------------------------------------------------------------
console.log('=== 1. the vocabulary ===')
// ---------------------------------------------------------------------------
ok(BREAK_STEPS.length === 3, 'three steps')
ok(BREAK_STEPS[0].id === 'sleeve' && BREAK_STEPS[2].id === 'bag', 'in the order they happen')
ok(!BREAK_STEPS[0].perTeam && BREAK_STEPS[2].perTeam, 'only the last one is per team')

const blank = {
  breakId: 'b',
  breakLabel: '1',
  sleeve: { at: null, by: null },
  sort: { at: null, by: null },
  baggedTeams: 0,
  totalTeams: 30
}
const stamped = (at: string): { at: string; by: string } => ({ at, by: 'emp1' })

ok(canStartStep('sleeve', blank), 'sleeving can always start')
ok(!canStartStep('sort', blank), 'sorting cannot start on an unsleeved break')
ok(!canStartStep('bag', blank), 'nor can bagging')
const sleeved = { ...blank, sleeve: stamped('2026-08-01T12:00:00.000Z') }
ok(canStartStep('sort', sleeved), 'sorting opens once it is sleeved')
ok(!canStartStep('bag', sleeved), 'but bagging still waits for the sort')
const sorted = { ...sleeved, sort: stamped('2026-08-01T13:00:00.000Z') }
ok(canStartStep('bag', sorted), 'and opens when both are done')

ok(currentStep(blank) === 'sleeve', 'a fresh break is on step 1')
ok(currentStep(sorted) === 'bag', 'a sorted one is on step 3')
ok(currentStep({ ...sorted, baggedTeams: 30 }) === null, 'a finished one is on nothing')
ok(isBreakReady({ ...sorted, baggedTeams: 30 }), 'and reads as ready')
ok(!isBreakReady({ ...sorted, baggedTeams: 29 }), 'twenty-nine of thirty is not ready')

// UN-TICKING CASCADES. Sorted-on-top-of-unsleeved is a state the checklist says
// cannot exist, so it must not be recordable.
ok(stepsClearedBy('sleeve').includes('sort'), 'un-sleeving un-sorts')
ok(!stepsClearedBy('sleeve').includes('bag'), 'but never throws away the bagging')

// THE BAR. Two clicks must not read as most of the way done when every card is
// still loose — that is the one reading a progress bar must never give.
ok(breakProgress(sorted) <= 0.25, 'sleeved and sorted is a small part of the job', String(breakProgress(sorted)))
ok(breakProgress({ ...sorted, baggedTeams: 30 }) === 1, 'and all bagged is all of it')

ok(teamSlug('New York Yankees') === 'new_york_yankees', 'team slugs are stable')
ok(teamSlug('St. Louis Cardinals') === 'st_louis_cardinals', 'punctuation and all')
ok(
  bagRowId('break_4', 'Boston Red Sox') === bagRowId('break_4', 'Boston Red Sox'),
  'the bag id is DERIVED, so two benches write one row'
)
ok(
  bagRowId('break_4', 'Boston Red Sox') !== bagRowId('break_5', 'Boston Red Sox'),
  'and the same team in another break is another row'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. slip order, and where the unsold ones go ===')
// ---------------------------------------------------------------------------
const rows = [
  { teamName: 'Zebras', slipPage: 1, slipPosition: 2 },
  { teamName: 'Aardvarks', slipPage: null, slipPosition: null },
  { teamName: 'Mongoose', slipPage: 1, slipPosition: 1 },
  { teamName: 'Badgers', slipPage: 2, slipPosition: 0 }
]
const order = sortBagRows(rows).map((r: { teamName: string }) => r.teamName)
ok(
  JSON.stringify(order) === JSON.stringify(['Mongoose', 'Zebras', 'Badgers', 'Aardvarks']),
  'page then line, and the team on no slip comes last',
  order.join(' > ')
)
// Deliberately NOT alphabetical: the list has to match the stack of paper.
ok(order[0] !== 'Aardvarks', 'which is not the same as alphabetical')
// A stable tie-break, so the list cannot reshuffle between two renders of the
// same data while somebody is working down it.
ok(
  compareBagRows(
    { teamName: 'A', slipPage: 1, slipPosition: 1 },
    { teamName: 'B', slipPage: 1, slipPosition: 1 }
  ) < 0,
  'ties break on name so the order never wobbles'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. a real break, through all three steps ===')
// ---------------------------------------------------------------------------
const BOX = '1x 2026 FINEST BASEBALL HOBBY BOX- Break #'
const slip = (handle: string, tracking: string, lines: string[]): string =>
  [
    'Whatnot Packing Slip 1/1',
    `To: ${handle} From: rm_cardz`,
    'Buyer Name',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    ...lines,
    `${Math.ceil(lines.length / 2)} Items $0.00`,
    `USPS Ground Advantage #${tracking} 3.0 oz`
  ].join('\n')

ship.importDataset(
  parsePages(
    [
      slip('alpha', '9300120762602315706741', [
        '1 Boston Red Sox Order 6000000001 $20.00',
        BOX + '7',
        '1 New York Yankees Order 6000000002 $25.00',
        BOX + '7'
      ]),
      slip('bravo', '9300120762602315706742', [
        '1 Chicago Cubs Order 6000000003 $30.00',
        BOX + '7'
      ])
    ],
    { sport: 'mlb', eventName: 'Bench test', eventDate: '2026-08-02' }
  ),
  { filename: 'bench.pdf' }
)

const br = domain.listBreaks().find((b: { breakLabel: string }) => b.breakLabel === '7')
ok(!!br, 'the break imported')
const id = br.id

let detail = domain.getBench(id)
ok(!!detail, 'it has a bench detail')
ok(detail.state.totalTeams === 30, 'measured against the full MLB slate', String(detail.state.totalTeams))
ok(detail.state.baggedTeams === 0, 'nothing bagged yet')
ok(detail.rows.length === 30, 'and thirty rows to work through', String(detail.rows.length))
ok(
  detail.rows.filter((r: { handle: string | null }) => r.handle).length === 3,
  'three of which somebody bought',
  String(detail.rows.filter((r: { handle: string | null }) => r.handle).length)
)
ok(
  detail.rows.filter((r: { slotId: string | null }) => !r.slotId).length === 27,
  'and twenty-seven nobody did — still in the box, still to be bagged'
)
ok(!!detail.bagBlockedReason, 'step 3 starts locked', String(detail.bagBlockedReason))

// SLIP POSITION SURVIVED THE IMPORT. Without this the list falls back to team
// name and stops matching the stack of paper.
const sold = detail.rows.filter((r: { slotId: string | null }) => r.slotId)
ok(
  sold.every((r: { slipPage: number | null }) => typeof r.slipPage === 'number'),
  'every sold team knows which page it printed on'
)

// --- the gates, from the main process -------------------------------------
ok(
  threw(() => domain.setBreakStep(id, 'sort', true, 'emp1')).includes('Sleeve'),
  'sorting is refused before sleeving, and says why',
  threw(() => domain.setBreakStep(id, 'sort', true, 'emp1'))
)
ok(
  threw(() => domain.setTeamBagged(id, 'Boston Red Sox', true, 'emp1')).length > 0,
  'and bagging is refused too'
)
// The one button that would walk around the whole checklist at once.
ok(
  threw(() => domain.setBreakChecked(id, true, 'emp1')).length > 0,
  'even "check every card", which touches all of them in one go'
)
ok(
  threw(() => domain.setOrderChecked('alpha', true, 'emp1')).length > 0,
  'and "next order", which writes the same flag across a package'
)
// THE EASIEST BYPASS: one card at a time. On a thirty-card break that is not
// even a slow way round the checklist, so the single-card tick answers to the
// same gate as every bulk path.
const oneCard = ship
  .listShipTeamSlotsByBreak(id)
  .find((s: { teamName: string }) => s.teamName === 'Boston Red Sox')
ok(
  threw(() => domain.setTeamSlotChecked(oneCard.id, true, 'emp1')).length > 0,
  'and ticking a single card straight from the pick list'
)
// Un-ticking is never gated, even here.
ok(
  threw(() => domain.setTeamSlotChecked(oneCard.id, false, 'emp1')) === '',
  'though un-ticking one is always allowed'
)

// --- step 1 ----------------------------------------------------------------
detail = domain.setBreakStep(id, 'sleeve', true, 'emp1')
ok(!!detail.state.sleeve.at, 'sleeving stamps a time')
ok(detail.state.sleeve.by === 'emp1', 'and WHO — the only question ever asked about a bad break')
ok(!!detail.bagBlockedReason, 'step 3 is still locked after step 1')

// --- step 2 ----------------------------------------------------------------
detail = domain.setBreakStep(id, 'sort', true, 'emp1')
ok(!!detail.state.sort.at, 'sorting stamps too')
ok(detail.bagBlockedReason === null, 'and step 3 finally opens')

// --- step 3, a SOLD team: the pick list's own checkmark --------------------
detail = domain.setTeamBagged(id, 'Boston Red Sox', true, 'emp1')
ok(detail.state.baggedTeams === 1, 'bagging a sold team counts')
const slot = ship
  .listShipTeamSlotsByBreak(id)
  .find((s: { teamName: string }) => s.teamName === 'Boston Red Sox')
ok(slot.checkedOff === true, 'and it IS the pick list flag, not a second one')
ok(
  domain.getBreak(id).checkedTeams === 1,
  'so the pick list agrees without being told separately',
  String(domain.getBreak(id).checkedTeams)
)

// --- step 3, an UNSOLD team: its own record --------------------------------
const unsold = detail.rows.find((r: { slotId: string | null }) => !r.slotId).teamName
detail = domain.setTeamBagged(id, unsold, true, 'emp1')
ok(detail.state.baggedTeams === 2, `bagging ${unsold} counts too, though nobody bought it`)
ok(
  ship.listBreakTeamBags(id).length === 1,
  'it lands in its own table, not as a phantom card'
)
// A phantom slot would show up in sales and the ledger as an order at zero.
ok(
  ship.listShipTeamSlotsByBreak(id).length === 3,
  'and the card rows are untouched — still three',
  String(ship.listShipTeamSlotsByBreak(id).length)
)

// UN-TICKING IS NEVER GATED. Un-sleeve the break, then correct a bag.
domain.setBreakStep(id, 'sleeve', false, 'emp1')
ok(
  domain.getBench(id).state.sort.at === null,
  'un-sleeving un-sorts — the cascade'
)
ok(
  domain.getBench(id).state.baggedTeams === 2,
  'but the two bags already done are NOT thrown away'
)
ok(
  threw(() => domain.setTeamBagged(id, unsold, false, 'emp1')) === '',
  'and un-bagging still works with the steps un-ticked'
)
ok(domain.getBench(id).state.baggedTeams === 1, 'the correction landed')

// Put it back and finish the break.
domain.setBreakStep(id, 'sleeve', true, 'emp1')
domain.setBreakStep(id, 'sort', true, 'emp1')
ok(
  threw(() => domain.setBreakStep(id, 'bag', true, 'emp1')).length > 0,
  'there is no "bag them all" button — thirty things happen, thirty get ticked'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. nothing ships until the break is off the bench ===')
// ---------------------------------------------------------------------------
ok(
  threw(() => domain.setOrderStage('ship_alpha', 'put_together', 'emp1')).length > 0,
  'a package cannot be put together over an unfinished break'
)
const why = threw(() => domain.setOrderStage('ship_alpha', 'sent', 'emp1'))
ok(why.includes('#7'), 'and the refusal NAMES the break', why)
ok(/bagged/.test(why), 'and says what it still needs', why)

// The way BACK is never blocked, and neither is recording something that has
// already happened out in the world.
ok(
  threw(() => domain.setOrderStage('ship_alpha', 'to_pick', 'emp1')) === '',
  'moving back to picking is always allowed'
)
ok(
  threw(() => domain.setOrderStage('ship_alpha', 'exception', 'emp1')) === '',
  'and a package genuinely lost in the post can still be recorded as one'
)

// Finish every team in the break.
for (const r of domain.getBench(id).rows) {
  if (!r.bagged) domain.setTeamBagged(id, r.teamName, true, 'emp1')
}
const finished = domain.getBench(id).state
ok(isBreakReady(finished), 'the break is off the bench', `${finished.baggedTeams}/${finished.totalTeams}`)
ok(bench.packBlockedReason([id]) === null, 'so it blocks nothing')
ok(
  threw(() => domain.setOrderStage('ship_alpha', 'put_together', 'emp1')) === '',
  'and the package can finally be packed'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. the board, and what it says is blocking ===')
// ---------------------------------------------------------------------------
const states = domain.listBenchStates()
ok(states.length >= 1, 'every break has a state')
const mine = states.find((s: { breakId: string }) => s.breakId === id)
ok(mine.baggedTeams === 30, 'the board agrees with the detail', String(mine.baggedTeams))
ok(notReadyMessage(states.filter((s: { breakId: string }) => s.breakId === id)) === null,
  'a finished break produces no complaint')
ok(
  (notReadyMessage([blank]) ?? '').includes('#1'),
  'and an unfinished one is named',
  String(notReadyMessage([blank]))
)
ok(bench.benchWorkRemaining().breaks === 0, 'nothing left on the bench')

// ---------------------------------------------------------------------------
console.log('\n=== 6. a new show does not inherit the last one ===')
// ---------------------------------------------------------------------------
// Break ids are `break_<label>` and labels repeat every week. If the bags
// survived an import, next week's #7 would open with 30 teams already bagged
// and the bench would skip an entire break's worth of real work.
ship.importDataset(
  parsePages(
    [
      slip('charlie', '9300120762602315706743', [
        '1 Boston Red Sox Order 7000000001 $20.00',
        BOX + '7'
      ])
    ],
    { sport: 'mlb', eventName: 'Next week', eventDate: '2026-08-09' }
  ),
  { filename: 'bench2.pdf' }
)
const fresh = domain.getBench(id)
ok(!!fresh, 'the new show has a #7 as well')
ok(fresh.state.baggedTeams === 0, 'and it starts at zero bagged', String(fresh.state.baggedTeams))
ok(fresh.state.sleeve.at === null, 'with nothing sleeved')
ok(ship.listBreakTeamBags(id).length === 0, 'last week’s bags are gone')

// ---------------------------------------------------------------------------
console.log('\n=== 7. steps 4 and 5, and the three things they can say ===')
// ---------------------------------------------------------------------------
// The checklist used to stop at step 3, so somebody working a break could not
// see what came next or what was holding it up — the gate refused them later,
// from a different screen. These two are on the list now, never tickable.
ok(SHIP_STEPS.length === 2, 'there are two of them')
ok(SHIP_STEPS[0].n === BREAK_STEPS.length + 1, 'numbered on from the bench steps', String(SHIP_STEPS[0].n))
ok(SHIP_STEPS[1].n === BREAK_STEPS.length + 2, 'consecutively')
// They must never be mistaken for per-break steps: canStartStep and isStepDone
// decide whether a BREAK is finished, and a pack step answering there would
// make every break permanently unfinished and nothing would ever ship.
ok(
  BREAK_STEPS.every((s: { id: string }) => s.id !== 'pack' && s.id !== 'scan'),
  'and they are NOT in the per-break list'
)

// Three states, built by hand so each one is unambiguous.
const doneState = (bid: string): Record<string, unknown> => ({
  breakId: bid,
  breakLabel: bid.toUpperCase(),
  sleeve: { at: '2026-08-09T12:00:00.000Z', by: 'emp1' },
  sort: { at: '2026-08-09T12:00:00.000Z', by: 'emp1' },
  baggedTeams: 30,
  totalTeams: 30
})
const openState = (bid: string): Record<string, unknown> => ({
  ...doneState(bid),
  baggedTeams: 11
})

const alone = shipGate('a', [doneState('a')])
ok(alone.status === 'go', 'a finished break with nothing else outstanding says go', alone.status)
ok(alone.reason.includes('packing can start'), 'and says so in words')

const mineOpen = shipGate('a', [openState('a'), doneState('b')])
ok(mineOpen.status === 'locked', 'an unfinished break is locked', mineOpen.status)
ok(/step 3/.test(mineOpen.reason), 'and is told which step it is on', mineOpen.reason)
// It must NOT be told about other breaks while its own work is outstanding —
// that is noise aimed at somebody who has something else to do first.
ok(!mineOpen.reason.includes('#B'), 'and not about anyone else’s break yet', mineOpen.reason)

// THE state this was built for. A break that is finished, with others still
// going, used to read as a flat "locked" — which says the work failed.
const waiting = shipGate('a', [doneState('a'), openState('b'), openState('c')])
ok(waiting.status === 'waiting', 'a finished break waiting on others is its own state', waiting.status)
ok(waiting.reason.startsWith('This break is boxed'), 'and is told its own work is done', waiting.reason)
ok(waiting.reason.includes('#B') && waiting.reason.includes('#C'), 'and which breaks to go help', waiting.reason)

// A break the caller does not know about cannot be reported as ready.
ok(shipGate('nope', [doneState('a')]).status === 'locked', 'an unknown break is locked, not go')

// And the real thing, off the database rather than hand-built. Section 6 has
// just re-imported this break for a new show, which resets it — so the gate
// must have swung back to locked. That is the assertion worth making: a gate
// computed once and cached would still be saying "go" here.
const liveGate = domain.getBench(id).shipGate
ok(!!liveGate, 'the bench detail carries a gate')
ok(liveGate.status === 'locked', 'and the re-imported break is locked again', String(liveGate.status))
ok(/step 1/.test(liveGate.reason), 'back at step 1', liveGate.reason)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
