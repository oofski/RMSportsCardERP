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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
