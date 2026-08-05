/**
 * The pick → pack handoff, and the claim protocol underneath it.
 *
 * The claim exists on a relay with NO compare-and-swap, so there is no lock to
 * be had. What is tested here is that the design does not need one: every row
 * is written by exactly one device, and who holds an order is a pure function
 * over the row set that every machine evaluates the same way.
 *
 * The load-bearing property, and the first thing checked: **delete every claim
 * and the night is unchanged.** Picking lives in ship_team_slots.checked_off,
 * packing in ship_shipments.packed_at. A claim only answers "who has this right
 * now", so a race can cost duplicated effort and must never cost a card.
 *
 * Run: npm run test:stations
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/stations-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const stations = require('../src/main/db/shipStations')
const { parsePages } = require('../src/main/shipping/parser')
const {
  holderOf,
  readyToPackAt,
  claimState,
  supersededIds,
  CLAIM_LEASE_MS
} = require('../src/shared/shipStations')
getDb()

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. holderOf is pure, total and identical everywhere ===')
// ---------------------------------------------------------------------------
// This function IS the concurrency design. If two machines can disagree about
// its answer for the same rows, the whole thing collapses.
const mkClaim = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: 'c1',
  orderId: 'ship_alpha',
  customerId: 'alpha',
  importId: 'imp1',
  role: 'pick',
  stationId: 'A',
  operatorId: null,
  loginUserId: null,
  claimedAt: '2026-08-01T10:00:00.000Z',
  heartbeatAt: '2026-08-01T10:00:00.000Z',
  finishedAt: null,
  releasedAt: null,
  supersedes: null,
  note: null,
  ...over
})
const NOW = Date.parse('2026-08-01T10:00:30.000Z')

ok(holderOf([], 'pick', NOW) === null, 'no claims, no holder')
ok(holderOf([mkClaim({})], 'pick', NOW)?.id === 'c1', 'one claim holds it')
ok(holderOf([mkClaim({})], 'pack', NOW) === null, 'a pick claim does not hold the pack role')

// EARLIEST wins. Two stations racing must agree, and the rule has to be total.
const raceA = mkClaim({ id: 'a', stationId: 'A', claimedAt: '2026-08-01T10:00:00.000Z' })
const raceB = mkClaim({ id: 'b', stationId: 'B', claimedAt: '2026-08-01T10:00:01.000Z' })
ok(holderOf([raceA, raceB], 'pick', NOW)?.id === 'a', 'the earlier claim wins')
ok(
  holderOf([raceB, raceA], 'pick', NOW)?.id === 'a',
  'and the ORDER THE ROWS ARRIVED IN cannot change that',
  'this is the whole convergence argument'
)
// An exact tie must still be total, or two machines pick different winners.
const tieA = mkClaim({ id: 'aaa', stationId: 'A' })
const tieB = mkClaim({ id: 'bbb', stationId: 'B' })
ok(holderOf([tieA, tieB], 'pick', NOW)?.id === 'aaa', 'an exact timestamp tie breaks by id')
ok(holderOf([tieB, tieA], 'pick', NOW)?.id === 'aaa', 'the same way, whichever order they arrive')

// Released, superseded and finished claims hold nothing.
ok(holderOf([mkClaim({ releasedAt: '2026-08-01T10:00:10.000Z' })], 'pick', NOW) === null, 'a released claim holds nothing')
ok(holderOf([mkClaim({ finishedAt: '2026-08-01T10:00:10.000Z' })], 'pick', NOW) === null, 'nor a finished one')
const dead = mkClaim({ id: 'old' })
const killer = mkClaim({ id: 'new', stationId: 'B', supersedes: 'old', claimedAt: '2026-08-01T10:00:05.000Z' })
ok(holderOf([dead, killer], 'pick', NOW)?.id === 'new', 'a superseded claim loses to the one that took it')

// ---------------------------------------------------------------------------
console.log('\n=== 2. the lease, and why it cannot be published ===')
// ---------------------------------------------------------------------------
const fresh = mkClaim({ heartbeatAt: '2026-08-01T10:00:29.000Z' })
const stale = mkClaim({ heartbeatAt: '2026-08-01T09:58:00.000Z' })
const gone = mkClaim({ heartbeatAt: '2026-08-01T09:40:00.000Z' })
const none = new Set<string>()
ok(claimState(fresh, none, NOW) === 'live', 'a beating claim is live')
ok(claimState(stale, none, NOW) === 'stale', 'a quiet one goes stale (display only)')
ok(claimState(gone, none, NOW) === 'expired', 'and past the lease, expired')
// Stale still HOLDS — going quiet for two minutes must not hand your order away.
ok(holderOf([stale], 'pick', NOW)?.id === 'c1', 'a stale claim still holds the order')
ok(holderOf([gone], 'pick', NOW) === null, 'an expired one does not')
ok(CLAIM_LEASE_MS === 600000, 'the lease is ten minutes', String(CLAIM_LEASE_MS))

// ---------------------------------------------------------------------------
console.log('\n=== 3. readiness to pack ===')
// ---------------------------------------------------------------------------
// An EMPTY order can only arrive by the explicit handoff. Deriving readiness
// from "every card is checked" alone would put every zero-card order in the
// pack queue the instant the PDF landed — and empty orders are a real, counted
// case, not a hypothetical.
ok(
  readyToPackAt({ claims: [], cardsTotal: 0, cardsChecked: 0, lastCheckedAt: null }) === null,
  'a zero-card order is NOT automatically ready'
)
ok(
  readyToPackAt({
    claims: [mkClaim({ finishedAt: '2026-08-01T10:00:20.000Z' })],
    cardsTotal: 0,
    cardsChecked: 0,
    lastCheckedAt: null
  }) === '2026-08-01T10:00:20.000Z',
  'but an explicit handoff makes it ready'
)
ok(
  readyToPackAt({ claims: [], cardsTotal: 3, cardsChecked: 3, lastCheckedAt: 'T' }) === 'T',
  'a fully-checked order is ready even without a handoff'
)
ok(
  readyToPackAt({ claims: [], cardsTotal: 3, cardsChecked: 2, lastCheckedAt: 'T' }) === null,
  'a half-picked one is not'
)
ok(
  readyToPackAt({
    claims: [mkClaim({ finishedAt: 'T1', releasedAt: 'T2' })],
    cardsTotal: 3,
    cardsChecked: 1,
    lastCheckedAt: null
  }) === null,
  'a handoff that was sent back stops counting'
)
// The rejection outranks every handoff BEFORE it, not merely the earliest one.
// A packer releases its OWN rows only, so after a cross-bench send-back the
// picker's original handoff is still standing when the repick lands. If that
// stale row were allowed to answer, the order would read as never handed over
// again — out of the pack queue, and out of the picking run too once its repick
// was done.
ok(
  readyToPackAt({
    claims: [
      mkClaim({ id: 'h1', finishedAt: '2026-08-01T10:00:05.000Z' }),
      mkClaim({
        id: 'b1',
        role: 'pack',
        stationId: 'B',
        releasedAt: '2026-08-01T10:00:10.000Z',
        note: 'sent back: missing card'
      }),
      mkClaim({ id: 'h2', finishedAt: '2026-08-01T10:00:20.000Z' })
    ],
    cardsTotal: 3,
    cardsChecked: 3,
    lastCheckedAt: '2026-08-01T10:00:01.000Z'
  }) === '2026-08-01T10:00:20.000Z',
  'and the repick after it is ready again, with the first handoff still standing'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. against a real database ===')
// ---------------------------------------------------------------------------
const BOX = '1x 2026 FINEST BASEBALL HOBBY BOX- Break #'
const slip = (h: string, t: string, lines: string[]): string =>
  [
    'Whatnot Packing Slip 1/1',
    `To: ${h} From: rm_cardz`,
    'Buyer Name',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    ...lines,
    `${Math.ceil(lines.length / 2)} Items $0.00`,
    `USPS Ground Advantage #${t} 3.0 oz`
  ].join('\n')
const PAGES = [
  slip('alpha', '9300120762602315706741', ['1 Boston Red Sox Order 1000000001 $20.00', BOX + '4']),
  slip('bravo', '9300120762602315706742', ['1 New York Yankees Order 1000000002 $25.00', BOX + '4']),
  slip('charlie', '9300120762602315706743', ['1 Chicago Cubs Order 1000000003 $30.00', BOX + '5'])
]
ship.importDataset(parsePages(PAGES, { sport: 'mlb', eventName: 'Stations', eventDate: '2026-08-01' }), {
  filename: 'stations.pdf'
})
ship.setShipEvent('Stations', '2026-08-01')

ok(domain.listOrders().length === 3, 'three orders imported', String(domain.listOrders().length))
ok(stations.liveImportChain().length === 1, 'one import on the chain')

const board0 = stations.getStationBoard()
ok(board0.toPick === 3, 'three to pick', String(board0.toPick))
ok(board0.packQueue === 0, 'nothing to pack yet', String(board0.packQueue))
ok(board0.session === null, 'and nobody is at this bench')

// ---------------------------------------------------------------------------
console.log('\n=== 5. claiming is idempotent for its owner ===')
// ---------------------------------------------------------------------------
// Become a named station BEFORE claiming anything — the rows record whichever
// device id was live when they were written, so switching afterwards would make
// this machine a stranger to its own claim.
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()
const first = stations.pickableOrders()[0]
ok(!!first, 'there is something to pick')
const c1 = stations.claimOrder(first.orderId, first.customerId, 'pick', 'user1')
ok(c1.ok === true, 'it can be claimed', JSON.stringify(c1.error))
const c2 = stations.claimOrder(first.orderId, first.customerId, 'pick', 'user1')
ok(c2.ok === true && c2.claim.id === c1.claim.id, 'claiming my own again is a touch, not a new row')
const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM ship_work_claims`).get() as { n: number }
ok(rows.n === 1, 'still exactly one claim row', String(rows.n))

// Another station cannot take it.
getDb().prepare(`UPDATE sync_state SET value = 'STATION-B' WHERE key = 'device_id'`).run()
const other = stations.claimOrder(first.orderId, first.customerId, 'pick', 'user2')
ok(other.ok === false, 'a second station is refused while it is held')
ok(other.claim !== null, 'and is told who has it')
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()

// ---------------------------------------------------------------------------
console.log('\n=== 6. an expired claim is taken over PERMANENTLY ===')
// ---------------------------------------------------------------------------
// The anti-resurrection rule: a laptop that wakes hours later must not quietly
// take the order back, or two people end up packing the same box.
const old = new Date(Date.now() - CLAIM_LEASE_MS - 60000).toISOString()
getDb().prepare(`UPDATE ship_work_claims SET heartbeat_at = ? WHERE id = ?`).run(old, c1.claim.id)
getDb().prepare(`UPDATE sync_state SET value = 'STATION-B' WHERE key = 'device_id'`).run()
const takeover = stations.claimOrder(first.orderId, first.customerId, 'pick', 'user2')
ok(takeover.ok === true, 'an expired claim can be taken over', JSON.stringify(takeover.error))
ok(takeover.claim.supersedes === c1.claim.id, 'naming the claim it displaced', String(takeover.claim.supersedes))

// Station A wakes up and heartbeats. It must NOT get the order back.
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()
stations.heartbeatStation()
const afterWake = stations.claimOrder(first.orderId, first.customerId, 'pick', 'user1')
ok(afterWake.ok === false, 'the woken station does NOT get it back', JSON.stringify(afterWake.claim?.stationId))
const lost = stations.reconcileClaims()
ok(lost.includes(first.customerId), 'and reconcile tells it what it lost', JSON.stringify(lost))
getDb().prepare(`UPDATE sync_state SET value = 'STATION-B' WHERE key = 'device_id'`).run()

// ---------------------------------------------------------------------------
console.log('\n=== 7. the handoff ===')
// ---------------------------------------------------------------------------
const before = stations.packQueue().length
const adv = stations.pickAdvance(first.customerId, 'user2')
ok(!!adv.finished, 'the order was finished', JSON.stringify(adv.error))
ok(stations.packQueue().length === before + 1, 'and it landed in the pack queue', String(stations.packQueue().length))
const order = domain.listOrders().find((o: any) => o.customerId === first.customerId)
ok(order.pick.checked === order.pick.total, 'every card in it is marked found')
ok(order.packedAt === null, 'but it is NOT packed yet — that is the packer\'s job')
// It must leave the picking run, or the picker walks it again.
ok(
  !stations.pickableOrders().some((o: any) => o.customerId === first.customerId),
  'and it is gone from the picking run'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. the packer sees ONLY the queue ===')
// ---------------------------------------------------------------------------
const taken = stations.packNext('user2')
ok(taken?.customerId === first.customerId, 'the packer is handed the queued order', String(taken?.customerId))
ok(stations.packQueue().length === 1, 'it stays in the queue as MINE while I hold it')
// A second station must not be handed the same box.
getDb().prepare(`UPDATE sync_state SET value = 'STATION-C' WHERE key = 'device_id'`).run()
const second = stations.packNext('user3')
ok(second === null, 'a second packer gets nothing — there is only one order ready', String(second?.customerId))
getDb().prepare(`UPDATE sync_state SET value = 'STATION-B' WHERE key = 'device_id'`).run()

const packed = stations.packDone(first.customerId, 'user2')
ok(!!packed, 'the packer can finish it')
const afterPack = domain.listOrders().find((o: any) => o.customerId === first.customerId)
ok(afterPack.packedAt !== null, 'packed_at is stamped — the first UI ever to write it', String(afterPack.packedAt))
ok(stations.packQueue().length === 0, 'and it leaves the queue')

// ---------------------------------------------------------------------------
console.log('\n=== 9. send back ===')
// ---------------------------------------------------------------------------
const nextPick = stations.pickableOrders()[0]
stations.claimOrder(nextPick.orderId, nextPick.customerId, 'pick', 'user2')
stations.pickAdvance(nextPick.customerId, 'user2')
const toPack = stations.packNext('user2')
ok(toPack?.customerId === nextPick.customerId, 'a second order reaches packing')
ok(stations.sendBack(nextPick.customerId, 'missing the Yankees card') === true, 'the packer can send it back')
ok(stations.packQueue().length === 0, 'it leaves the pack queue', String(stations.packQueue().length))
ok(
  stations.packQueue().every((o: any) => o.customerId !== nextPick.customerId),
  'and does not silently come straight back'
)
// The rejection has to land it somewhere. Every card in it is still ticked, so
// "not finished" would leave it in NEITHER queue — forgotten on a bench.
const backInPicking = stations.pickableOrders().find((o: any) => o.customerId === nextPick.customerId)
ok(!!backInPicking, 'it goes back into the picking run', JSON.stringify(stations.pickableOrders().map((o: any) => o.customerId)))
ok(
  backInPicking?.sentBackReason === 'missing the Yankees card',
  'carrying the reason, so the next picker knows BEFORE they start',
  String(backInPicking?.sentBackReason)
)

// ---------------------------------------------------------------------------
console.log('\n=== 9b. a send-back ACROSS two benches, then the repick ===')
// ---------------------------------------------------------------------------
// The case above has one station doing both jobs, which hides the hazard: a
// packer releases its OWN rows only, so a rejection at the packing bench leaves
// the picker's original handoff standing. If that stale row is allowed to answer
// "has this been handed over", the repick that follows is invisible — the order
// is not ready to pack, and its repick is done so it is not to pick either. It
// would sit in NEITHER queue, which is the one outcome the whole claim design
// exists to prevent.
const third = domain
  .listOrders()
  .find((o: any) => o.customerId !== first.customerId && o.customerId !== nextPick.customerId)
ok(!!third, 'a third order to work with', String(third?.customerId))

// The bench above went home holding its next order — release it, or the pack
// queue would hide this one behind a picker who is not standing there.
stations.releaseAllForStation('end of shift')

getDb().prepare(`UPDATE sync_state SET value = 'STATION-P' WHERE key = 'device_id'`).run()
stations.claimOrder(third.id, third.customerId, 'pick', 'user4')
stations.pickAdvance(third.customerId, 'user4')
getDb().prepare(`UPDATE sync_state SET value = 'STATION-Q' WHERE key = 'device_id'`).run()
ok(stations.packNext('user5')?.customerId === third.customerId, 'the packer at the OTHER bench takes it')
ok(stations.sendBack(third.customerId, 'sleeve is split') === true, 'and rejects it')
ok(
  stations.packQueue().every((o: any) => o.customerId !== third.customerId),
  'it leaves the pack queue'
)
getDb().prepare(`UPDATE sync_state SET value = 'STATION-P' WHERE key = 'device_id'`).run()
ok(
  stations.pickableOrders().some((o: any) => o.customerId === third.customerId),
  'and lands back in the picking run, even though the picker never released a thing'
)

// The picker fixes it and hands it over again.
stations.pickAdvance(third.customerId, 'user4')
ok(
  stations.packQueue().some((o: any) => o.customerId === third.customerId),
  'the repick puts it back in the PACK queue',
  JSON.stringify(stations.packQueue().map((o: any) => o.customerId))
)
ok(
  !stations.pickableOrders().some((o: any) => o.customerId === third.customerId),
  'and takes it out of the picking run — one queue, never neither'
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. an import decides liveness with ZERO writes ===')
// ---------------------------------------------------------------------------
const claimsBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM ship_work_claims`).get() as { n: number }).n
ok(claimsBefore > 0, 'there are claims on the board', String(claimsBefore))

// A NON-carry-forward import: a new night. Every old claim falls off the chain.
ship.importDataset(parsePages(PAGES, { sport: 'mlb', eventName: 'Next night', eventDate: '2026-08-08' }), {
  filename: 'next.pdf'
})
ship.setShipEvent('Next night', '2026-08-08')
const claimsAfter = (getDb().prepare(`SELECT COUNT(*) AS n FROM ship_work_claims`).get() as { n: number }).n
ok(claimsAfter === claimsBefore, 'not one claim row was written to', `${claimsBefore} -> ${claimsAfter}`)
ok(stations.getStationBoard().packQueue === 0, 'yet the pack queue is empty for the new show')
ok(
  stations.pickableOrders().every((o: any) => !o.mine),
  'and nothing is still claimed from last week'
)

// ---------------------------------------------------------------------------
console.log('\n=== 11. the bench is handed the order it has to DRAW ===')
// ---------------------------------------------------------------------------
// The bench renders the same pane as the Orders tab, and that pane needs every
// break and every team — not a count of them. It used to show a handle and
// "3/12 cards", which meant the one screen the checklist sends a picker to was
// the one screen that never said WHICH teams to gather.
//
// The other half of the rule matters just as much: EVERY OTHER order stays
// lean. `pickableOrders` runs over the whole night and is nearly always reduced
// to a length, so attaching a break list to each would push the entire show
// down the IPC channel every time anybody anywhere ticked a card.
// A station session is only real while its operator is ON THE CLOCK — that is
// the whole reason the bench needs no second password. So the picker has to be
// punched in before any of this is true.
const NOW_ISO = new Date().toISOString()
getDb()
  .prepare(
    `INSERT INTO employees (id, first_name, last_name, company_id, title, email, role,
       status, password_hash, must_change_password, created_at, updated_at)
     VALUES ('emp_picker', 'Bench', 'Picker', 'RM-900', 'Picker', '', 'employee',
       'active', 'x', 0, ?, ?)`
  )
  .run(NOW_ISO, NOW_ISO)
getDb()
  .prepare(
    `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, source, created_at)
     VALUES ('te_picker', 'emp_picker', ?, NULL, 'manual', ?)`
  )
  .run(NOW_ISO, NOW_ISO)

stations.endStationSession()
const bench = stations.startStationSession('emp_picker', 'pick', null)
ok(!!bench, 'a picker is at the bench, and on the clock')
const took = stations.pickNext(null)
ok(!!took, 'and is holding an order', String(took?.handle))

const boardNow = stations.getStationBoard()
const held = boardNow.current
ok(!!held, 'the board says which one')
ok(held?.detail != null, 'and hands over the whole order, not a summary')
ok(
  Array.isArray((held?.detail as any)?.breaks) && (held?.detail as any).breaks.length > 0,
  'with its breaks',
  String((held?.detail as any)?.breaks?.length)
)
const teamCount = ((held?.detail as any)?.breaks ?? []).reduce(
  (n: number, b: any) => n + b.teams.length,
  0
)
ok(teamCount > 0, 'and the teams inside them — the actual pick list', String(teamCount))
ok(
  ((held?.detail as any)?.breaks ?? []).every((b: any) =>
    b.teams.every((t: any) => typeof t.slotId === 'string' && t.slotId.length > 0)
  ),
  'every team carries the slot id the bench ticks it off by'
)
// The counts on the lean shape and the detail must be the same number. Two
// sources for "how many cards" is how a header comes to disagree with the list
// printed directly underneath it.
ok(
  (held?.detail as any).pick.checked === held?.cardsChecked &&
    (held?.detail as any).cardCount === held?.cardsTotal,
  'the summary and the detail agree about the count',
  `${held?.cardsChecked}/${held?.cardsTotal}`
)

ok(
  stations.pickableOrders().every((o: any) => o.detail === null),
  'and no other order in the run carries one'
)
ok(
  stations.packQueue().every((o: any) => o.detail === null),
  'nor anything sitting in the pack queue'
)

// ---------------------------------------------------------------------------
console.log('\n=== 12. one order pane, mounted by both screens ===')
// ---------------------------------------------------------------------------
// A source check, because the thing being protected is that there is only ONE
// of these. The bench and the Orders tab drifted apart by each owning its own
// copy of "draw an order" — one grew a break-by-break pick list, the other
// stayed at "3/12 cards" — and nothing failed, because nothing was comparing
// them. This does.
const readSrc = (p: string): string =>
  require('node:fs').readFileSync(require('node:path').join(process.cwd(), p), 'utf8')
const floorSrc = readSrc('src/renderer/src/modules/fulfillment/FloorView.tsx')
const walkerSrc = readSrc('src/renderer/src/modules/fulfillment/OrderWalker.tsx')

for (const [name, src] of [
  ['the bench', floorSrc],
  ['the Orders tab', walkerSrc]
] as Array<[string, string]>) {
  ok(/<OrderCard\b/.test(src), `${name} mounts OrderCard`)
  ok(src.includes('"walk-split"'), `${name} lays it out in walk-split — same widths, same sides`)
}
// The bench's old private layout must be gone, not merely unused: a stylesheet
// that still answers for `floor-work` is one somebody re-reaches for.
for (const gone of ['floor-work', 'floor-order-head', 'floor-handle', 'floor-cards']) {
  ok(!floorSrc.includes(`"${gone}"`), `the bench no longer draws its own ${gone}`)
}
const cssSrc = readSrc('src/renderer/src/styles/app.css')
for (const gone of ['.floor-work {', '.floor-order {', '.floor-handle {', '.floor-slip {']) {
  ok(!cssSrc.includes(gone), `and the stylesheet has dropped ${gone.replace(' {', '')}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 13. the night is over: the bench says so, once ===')
// ---------------------------------------------------------------------------
// A picker cannot see the end of the night from the order in their hands — the
// run in front of them empties the moment anybody else takes what is left. So
// the handoff reports it, and the screen uses that to say "every order is
// picked" and walk the picker off the bench.
//
// It used to be reported by the shipping checklist closing its fifth step,
// which was a claimed row write. There is no step to tick now, so the fact is
// read straight off `pickingRemaining`, and what has to be true of it is that it
// is FALSE on every pick but the last and TRUE on that one.
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()
ship.importDataset(
  parsePages(
    [
      slip('one', '9300120762602315706801', ['1 Boston Red Sox Order 1300000001 $10.00', BOX + '2']),
      slip('two', '9300120762602315706802', ['1 Chicago Cubs Order 1300000002 $10.00', BOX + '2']),
      slip('three', '9300120762602315706803', ['1 Houston Astros Order 1300000003 $10.00', BOX + '2'])
    ],
    { sport: 'mlb', eventName: 'Last pick', eventDate: '2026-08-04' }
  ),
  { filename: 'last-pick.pdf' }
)
ship.setShipEvent('Last pick', '2026-08-04')
ok(domain.listOrders().length === 3, 'three fresh orders', String(domain.listOrders().length))

const completions: boolean[] = []
for (let i = 0; i < 3; i++) {
  const next = stations.pickableOrders()[0]
  stations.claimOrder(next.orderId, next.customerId, 'pick', null)
  completions.push(stations.pickAdvance(next.customerId, null).pickingCompleted)
}
ok(
  completions.join(',') === 'false,false,true',
  'only the pick that emptied the room reports it',
  completions.join(',')
)
ok(stations.pickingRemaining() === 0, 'and nothing is left to pick')
// Picking done is not packing done. The three boxes are still stacked at the
// mailing end, which is what the toast has to say alongside it.
ok(stations.packQueue().length === 3, 'while three boxes still wait for a mailer',
   String(stations.packQueue().length))

// An empty workspace must never announce that it has been picked: there is
// nothing to have picked. `pickAdvance` cannot even be reached without a
// shipment, so the guard is asserted where it lives.
ship.clearShipDataset()
ok(domain.listOrders().length === 0, 'the workspace is empty')
ok(
  stations.pickAdvance('nobody', null).pickingCompleted === false,
  'and an advance against a package that is gone claims nothing'
)

// ---------------------------------------------------------------------------
console.log('\n=== 14. orders come back in PDF PAGE ORDER ===')
// ---------------------------------------------------------------------------
// The owner's complaint, in one sentence: "it should be in order from page 1 of
// the pdf onward per order". Every screen that walks orders reads `listOrders`,
// so this is the one place it has to be true.
//
// The handles here are deliberately in the WRONG order alphabetically and the
// slips are deliberately not one page each — zulu opens on page 1, alpha on
// page 2, and mike's order runs across pages 3, 4 and 5. Sorting by anything
// but the first page gets a different answer for at least one of them.
const twoPage = (h: string, t: string, lines: string[]): string[] => [
  slip(h, t, lines),
  // A continuation page: the same customer, more items, no address block.
  ['Whatnot Packing Slip 1/1', `To: ${h} From: rm_cardz`, 'QTY Name & Description Attributes Subtotal', ...lines].join(
    '\n'
  )
]
ship.importDataset(
  parsePages(
    [
      slip('zulu', '9300120762602315706901', ['1 Boston Red Sox Order 1400000001 $10.00', BOX + '2']),
      slip('alpha', '9300120762602315706902', ['1 Chicago Cubs Order 1400000002 $10.00', BOX + '2']),
      ...twoPage('mike', '9300120762602315706903', [
        '1 Houston Astros Order 1400000003 $10.00',
        BOX + '3'
      ]),
      slip('bravo', '9300120762602315706904', ['1 Atlanta Braves Order 1400000004 $10.00', BOX + '3'])
    ],
    { sport: 'mlb', eventName: 'Page order', eventDate: '2026-08-05' }
  ),
  { filename: 'page-order.pdf' }
)
ship.setShipEvent('Page order', '2026-08-05')

const handles = (rows: any[]): string => rows.map((o: any) => o.customer?.handle ?? o.handle).join(',')
const walked = domain.listOrders()
ok(
  handles(walked) === 'zulu,alpha,mike,bravo',
  'the walk follows the slip, not the alphabet and not the insert order',
  handles(walked)
)
ok(
  walked.map((o: any) => o.customer.pages[0]).join(',') === '1,2,3,5',
  'which is first pages 1, 2, 3, 5 ascending',
  walked.map((o: any) => JSON.stringify(o.customer.pages)).join(' ')
)
ok(
  walked[2].customer.pages.length === 2,
  "and a customer whose slip runs on sorts by where it BEGINS, carrying all its pages",
  JSON.stringify(walked[2].customer.pages)
)

// The bench walks the same order. It used to rotate the list by a hash of the
// station id so two pickers would not contend; page order and a rotation cannot
// both be true, and the slip wins.
ok(
  handles(stations.pickableOrders()) === 'zulu,alpha,mike,bravo',
  'the picking run is the same walk, unrotated',
  handles(stations.pickableOrders())
)
getDb().prepare(`UPDATE sync_state SET value = 'STATION-Q' WHERE key = 'device_id'`).run()
ok(
  handles(stations.pickableOrders()) === 'zulu,alpha,mike,bravo',
  'and a different station id no longer starts somewhere else',
  handles(stations.pickableOrders())
)
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()

// The Orders tab walks this list BY INDEX — Previous and Next move a cursor by
// one, and its only transform is a filter — so page order in `listOrders` is
// page order under the operator's hands. A source check, for the same reason
// section 12's are: a `.sort(` creeping into the walker would silently undo
// everything above and nothing else in the app compares the two.
const walkerSrc2 = readSrc('src/renderer/src/modules/fulfillment/OrderWalker.tsx')
ok(!walkerSrc2.includes('.sort('), 'the Orders tab does not re-order what it was handed')
ok(
  walkerSrc2.includes('run[index]'),
  'it draws run[index] — a cursor into the list, in the list’s own order'
)

// --- an order with no pages ------------------------------------------------
//
// A customer the parser could not place — a hand-added row, or a slip whose page
// markers did not survive. It must sort LAST (a walk starts on page 1) and it
// must not throw on the way.
getDb().prepare(`UPDATE ship_customers SET pages = '[]' WHERE id = 'alpha'`).run()
const withOrphan = domain.listOrders()
ok(withOrphan.length === 4, 'still four orders — nothing was dropped', String(withOrphan.length))
ok(
  handles(withOrphan) === 'zulu,mike,bravo,alpha',
  'the pageless order sorts to the end rather than to the front',
  handles(withOrphan)
)
// Every one of them pageless is the degenerate case, and the handle is what
// keeps it stable — two machines rebuilding this list must agree.
getDb().prepare(`UPDATE ship_customers SET pages = '[]'`).run()
const allOrphans = domain.listOrders()
ok(
  handles(allOrphans) === 'alpha,bravo,mike,zulu',
  'with nothing placed at all it falls back to the handle, in one stable order',
  handles(allOrphans)
)
ok(
  handles(domain.listOrders()) === handles(allOrphans),
  'and the same list twice running is the same list'
)

// --- two stations, both walking page order ---------------------------------
//
// The rotation is gone, so both benches now read the SAME head. What stops them
// being handed the same order is the filter that hides anything another station
// holds — asserted here rather than argued, because it is now the only thing
// doing that job.
ship.importDataset(
  parsePages(
    [
      slip('one', '9300120762602315707001', ['1 Boston Red Sox Order 1500000001 $10.00', BOX + '2']),
      slip('two', '9300120762602315707002', ['1 Chicago Cubs Order 1500000002 $10.00', BOX + '2']),
      slip('three', '9300120762602315707003', ['1 Houston Astros Order 1500000003 $10.00', BOX + '2']),
      slip('four', '9300120762602315707004', ['1 Atlanta Braves Order 1500000004 $10.00', BOX + '2'])
    ],
    { sport: 'mlb', eventName: 'Two benches', eventDate: '2026-08-06' }
  ),
  { filename: 'two-benches.pdf' }
)
ship.setShipEvent('Two benches', '2026-08-06')

const handedOut: string[] = []
const takeAt = (station: string): string | null => {
  getDb().prepare(`UPDATE sync_state SET value = ? WHERE key = 'device_id'`).run(station)
  const got = stations.pickNext(null)
  return got?.customerId ?? null
}
// Alternating, which is the worst case: each bench looks at a list the other has
// just written to.
for (let i = 0; i < 2; i++) {
  const a = takeAt('BENCH-1')
  const b = takeAt('BENCH-2')
  if (a) handedOut.push(a)
  if (b) handedOut.push(b)
  // Finish what each is holding so the next round asks for a new one.
  getDb().prepare(`UPDATE sync_state SET value = 'BENCH-1' WHERE key = 'device_id'`).run()
  if (a) stations.pickAdvance(a, null)
  getDb().prepare(`UPDATE sync_state SET value = 'BENCH-2' WHERE key = 'device_id'`).run()
  if (b) stations.pickAdvance(b, null)
}
ok(handedOut.length === 4, 'both benches between them took every order', handedOut.join(','))
ok(
  new Set(handedOut).size === handedOut.length,
  'and NO order was handed to both of them',
  handedOut.join(',')
)
// And they went out in page order across the two benches, which is the whole
// point: one stack of paper, worked from the top by two people.
ok(handedOut.join(',') === 'one,two,three,four', 'in page order, across both', handedOut.join(','))
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
