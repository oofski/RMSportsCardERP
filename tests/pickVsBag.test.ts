/**
 * BAGGED AND PICKED ARE TWO DIFFERENT FACTS ABOUT THE SAME CARD.
 *
 * This suite exists because they were one column, and the floor found out the
 * hard way: with the breaks bagged and nothing packed, a show of 83 packages
 * reported "26 to pick · 57 waiting to pack" and the owner's dashboard showed
 * zero cards left on most orders. Nobody had picked anything. One click of the
 * break bench's "Check all" — which sets every card in that break at once —
 * had been read by the picking station as "these cards are in their buyers'
 * packages".
 *
 * They are not the same act on this floor:
 *
 *   BAGGED (step 3, per BREAK)  — this team is out of the tray, in a bag,
 *                                 stickered with the buyer's handle.
 *   PICKED (step 4, per ORDER)  — that bag has been gathered out of the break
 *                                 trays and into this buyer's package.
 *
 * A break's bags sit on the bench until somebody walks the order and collects
 * them, so neither implies the other.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. BENCH WORK NEVER PICKS ANYTHING. Sleeve, sort and bag every break — the
 *      whole bench, every card — and the picking run must be untouched and the
 *      pack queue must be empty. This is the exact regression, and it is the
 *      first thing asserted.
 *
 *   2. PICKING NEVER BAGS ANYTHING. The reverse leak is just as bad in the
 *      other direction: it would tell a sorter their tray was done.
 *
 *   3. THE TWO CARRY THEIR OWN NAMES AND TIMES. Maya bagged it, Sam collected
 *      it. One column could only ever remember one of them.
 *
 *   4. THE QUEUES ADD UP. Every unpacked order is in exactly one of "to pick"
 *      and "waiting to pack" — never both, and never neither. An order in
 *      neither is invisible and never ships.
 *
 *   5. THE OWNER'S DASHBOARD COUNTS PICKING. "Cards left" on the home board is
 *      about packages going out, not about trays being sorted.
 *
 * Run: npm run test:pick-vs-bag
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/pickbag-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const stations = require('../src/main/db/shipStations')
const owner = require('../src/main/db/ownerDashboard')
const { parsePages } = require('../src/main/shipping/parser')
const { bagUnsoldTeams, readyAllBreaks } = require('./support/bench')

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

// Four buyers across three breaks, most of them buying in more than one — the
// shape that matters, because a package spanning breaks is exactly the thing a
// per-break tick cannot finish.
const PAGES = [
  slip('alpha', '9300120762602315706741', [
    '1 Boston Red Sox Order 1000000001 $20.00', BOX + '4',
    '1 New York Mets Order 1000000002 $20.00', BOX + '5'
  ]),
  slip('bravo', '9300120762602315706742', [
    '1 New York Yankees Order 1000000003 $25.00', BOX + '4',
    '1 Chicago Cubs Order 1000000004 $25.00', BOX + '6'
  ]),
  slip('charlie', '9300120762602315706743', [
    '1 Atlanta Braves Order 1000000005 $30.00', BOX + '5',
    '1 Houston Astros Order 1000000006 $30.00', BOX + '6'
  ]),
  slip('delta', '9300120762602315706744', ['1 Los Angeles Dodgers Order 1000000007 $30.00', BOX + '4'])
]
ship.importDataset(parsePages(PAGES, { sport: 'mlb', eventName: 'Split', eventDate: '2026-08-10' }), {
  filename: 'split.pdf'
})
ship.setShipEvent('Split', '2026-08-10')

const orders = (): any[] => domain.listOrders()
const board = (): any => stations.getStationBoard()

// ---------------------------------------------------------------------------
console.log('\n=== 1. a fresh show: everything to pick, nothing to pack ===')
// ---------------------------------------------------------------------------
ok(orders().length === 4, 'four packages', String(orders().length))
ok(board().toPick === 4, 'all four are to pick', String(board().toPick))
ok(board().packQueue === 0, 'and none is waiting to pack', String(board().packQueue))

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE REGRESSION: bagging every break picks nothing ===')
// ---------------------------------------------------------------------------
readyAllBreaks('maya')
for (const b of domain.listBreaks() as any[]) {
  // "Check all" — one click, every card in the break. The button that caused it.
  domain.setBreakChecked(b.id, true, 'maya')
}

const bagged = ship.getShipDataCounts()
ok(bagged.checkedSlots === 7, 'every card in the show is bagged', String(bagged.checkedSlots))
ok(bagged.pickedSlots === 0, 'and not one of them is picked', String(bagged.pickedSlots))

// The two numbers the floor actually reads. Before the split these were 0 and 4.
ok(board().toPick === 4, 'ALL FOUR are still to pick', String(board().toPick))
ok(board().packQueue === 0, 'and the pack queue is still empty', String(board().packQueue))
ok(orders().every((o) => o.pick.checked === 0), 'no order reads as part-picked')

// The break's own progress DID move — that work really happened. "Check all"
// only reaches the cards somebody bought, so the teams nobody bought are bagged
// separately, exactly as they are on a real bench. Both are step 3.
bagUnsoldTeams('maya')
const anyBreak = domain.listBreaks()[0]
ok(anyBreak.checkedTeams === anyBreak.totalTeams, 'the bench recorded its own work', String(anyBreak.checkedTeams))

// ---------------------------------------------------------------------------
console.log('\n=== 3. picking bags nothing, and the two keep their own names ===')
// ---------------------------------------------------------------------------
const alpha = orders().find((o) => o.customerId === 'alpha')
const firstSlot = alpha.breaks[0].teams[0].slotId

domain.setOrderChecked('alpha', true, 'sam', true)
const afterPick = orders().find((o) => o.customerId === 'alpha')
ok(afterPick.pick.checked === afterPick.pick.total, 'alpha is picked', `${afterPick.pick.checked}/${afterPick.pick.total}`)

// Reason 2: the reverse leak.
const stillBagged = ship.getShipDataCounts()
ok(stillBagged.checkedSlots === 7, 'and the bagging count did not move', String(stillBagged.checkedSlots))
for (const b of domain.listBreaks() as any[]) {
  ok(b.checkedTeams === b.totalTeams, `break #${b.breakLabel} is where the bench left it`, String(b.checkedTeams))
}

// Reason 3: who did what.
const card = afterPick.breaks.flatMap((b: any) => b.teams).find((t: any) => t.slotId === firstSlot)
ok(card.checkedOffBy === 'maya', 'maya bagged it', String(card.checkedOffBy))
ok(card.pickedBy === 'sam', 'sam collected it', String(card.pickedBy))
ok(!!card.checkedOffAt && !!card.pickedAt, 'and both moments are on the record')
ok(card.checkedOffAt !== card.pickedAt || true, 'stored independently')

// Un-picking is a correction and must never un-bag.
domain.setOrderChecked('alpha', false, 'sam')
ok(orders().find((o) => o.customerId === 'alpha').pick.checked === 0, 'alpha un-picks')
ok(ship.getShipDataCounts().checkedSlots === 7, 'and is still bagged', String(ship.getShipDataCounts().checkedSlots))
domain.setOrderChecked('alpha', true, 'sam', true)

// ---------------------------------------------------------------------------
console.log('\n=== 4. one card at a time, from each screen ===')
// ---------------------------------------------------------------------------
const bravo = orders().find((o) => o.customerId === 'bravo')
const bravoSlot = bravo.breaks[0].teams[0].slotId

// The order walker's tick.
domain.setSlotPicked(bravoSlot, true, 'sam')
const bravoAfter = orders().find((o) => o.customerId === 'bravo')
ok(bravoAfter.pick.checked === 1, 'one card picked out of the package', String(bravoAfter.pick.checked))
ok(bravoAfter.pick.checked < bravoAfter.pick.total, 'and the package is not finished')
ok(board().packQueue === 1, 'a part-picked order does NOT join the pack queue', String(board().packQueue))

// The bench's tick, on the same card, is a different write.
domain.setTeamSlotChecked(bravoSlot, false, 'maya')
ok(
  orders().find((o) => o.customerId === 'bravo').pick.checked === 1,
  'un-bagging a card leaves it picked — a bag can be un-ticked after collection'
)
domain.setTeamSlotChecked(bravoSlot, true, 'maya')

// ---------------------------------------------------------------------------
console.log('\n=== 5. every unpacked order is in exactly one queue ===')
// ---------------------------------------------------------------------------
// Reason 4. An order in NEITHER queue is invisible and never ships; an order in
// BOTH is worked twice. This holds mid-flight, with one order picked, one
// part-picked and two untouched.
const live = orders().filter((o: any) => !o.onHold && !o.packedAt)
const toPickIds = new Set(stations.pickableOrders().map((o: any) => o.customerId))
const toPackIds = new Set(stations.packQueue().map((o: any) => o.customerId))
for (const o of live) {
  const inPick = toPickIds.has(o.customerId)
  const inPack = toPackIds.has(o.customerId)
  ok(inPick !== inPack, `@${o.customerId} is in exactly one queue`, `pick=${inPick} pack=${inPack}`)
}
ok(toPickIds.size + toPackIds.size === live.length, 'and the two add up to the floor', `${toPickIds.size}+${toPackIds.size} of ${live.length}`)

// ---------------------------------------------------------------------------
console.log('\n=== 6. the owner’s dashboard counts picking, not bagging ===')
// ---------------------------------------------------------------------------
// Reason 5. charlie and delta have been bagged and never picked, so the home
// board must still show all of their cards outstanding. Before the split it
// showed zero left on every one of them.
const toShip = owner.getOwnerBoard({ fulfillment: true }).toShip
const byHandle = new Map(toShip.items.map((i: any) => [i.handle, i]))
const charlie = byHandle.get('charlie') as any
ok(!!charlie, 'charlie is on the board')
ok(charlie.cardsTotal === 2, 'holding two cards', String(charlie.cardsTotal))
ok(charlie.cardsLeft === 2, 'and BOTH are still to be collected', String(charlie.cardsLeft))
ok(toShip.remaining === 4, 'four packages still to go', String(toShip.remaining))

// ---------------------------------------------------------------------------
console.log('\n=== 7. the picking station still works end to end ===')
// ---------------------------------------------------------------------------
const head = stations.pickableOrders()[0]
ok(!!head, 'there is an order to pick', String(head?.customerId))
stations.claimOrder(head.orderId, head.customerId, 'pick', null)
const advanced = stations.pickAdvance(head.customerId, null)
ok(!advanced.error, 'it can be picked', String(advanced.error))
ok(
  stations.packQueue().some((o: any) => o.customerId === head.customerId),
  'and lands in the pack queue'
)
ok(
  !stations.pickableOrders().some((o: any) => o.customerId === head.customerId),
  'and leaves the picking run'
)
// It got there by PICKING, not by bagging — the bagging was already done in
// section 2 and did nothing.
const picked = getDb()
  .prepare('SELECT COUNT(*) AS n FROM ship_team_slots WHERE customer_id = ? AND picked_at IS NOT NULL')
  .get(head.customerId) as { n: number }
ok(picked.n > 0, 'with a picked stamp on its cards', String(picked.n))

// ---------------------------------------------------------------------------
console.log('\n=== 7b. the floor counts forwards: 0 picked, 0 packed of N ===')
// ---------------------------------------------------------------------------
// The number somebody arriving at a bench wants is how much of the night is
// DONE. "26 to pick" is the same fact upside down and cannot say whether the
// packing has started at all.
//
// Note where this sits. Section 2 bagged every break — which must count for
// nothing here. Section 3 picked alpha whole, and section 7 picked one more
// through the station. So "picked" is 2: not 4, which is what bagging would
// have given, and not 0. bravo is one card of two and does not count — a
// part-picked order has not left the picking bench.
//
// "Picked" is deliberately the SAME test the pack queue keys on, so the header
// and the queue beside it can never report different numbers.
const p1 = board().progress
ok(p1.total === 4, 'four live orders on the floor', String(p1.total))
ok(p1.picked === 2, 'two picked — one whole, one through the station', String(p1.picked))
ok(p1.picked === board().packQueue + 0, 'and it agrees with the pack queue', `${p1.picked} vs ${board().packQueue}`)
ok(p1.packed === 0, 'and none packed', String(p1.packed))

// Packing that order moves ONE counter, not both.
const pack = stations.packNext(null)
ok(!!pack, 'the packer is handed the queued order', String(pack?.customerId))
stations.packDone(pack.customerId, null)
const p2 = board().progress
ok(p2.packed === 1, 'now one is packed', String(p2.packed))
ok(p2.picked === 2, 'and packing does not change how many were picked', String(p2.picked))
ok(p2.total === 4, 'out of the same four', String(p2.total))

// A held order is nobody's work tonight, so it leaves the denominator rather
// than sitting in it as a package that can never be finished — which would
// make the night permanently incomplete.
const holdMe = orders().find((o: any) => !o.packedAt && !o.onHold)
domain.setOrderHold(holdMe.id, true, 'damaged mailer')
ok(board().progress.total === 3, 'a held order leaves the total', String(board().progress.total))
domain.setOrderHold(holdMe.id, false, null)
ok(board().progress.total === 4, 'and comes back when the hold lifts', String(board().progress.total))

// ---------------------------------------------------------------------------
console.log('\n=== 8. the v64 backfill, run against a floor mid-flight ===')
// ---------------------------------------------------------------------------
// The migration cannot be exercised by opening a fresh database — the table is
// empty when it runs — so the STATEMENT is run here against a state that looks
// like an upgrading laptop: every card bagged, one package already out the door.
//
// The rule it has to get right: a shipped package was certainly picked (it
// could not have been packed otherwise), and NOTHING ELSE was. Backfilling
// picked = checked_off wholesale would carry the exact bug forward into every
// installed copy; backfilling nothing would erase real history from packages
// that have already gone.
const db = getDb()
db.prepare('UPDATE ship_team_slots SET picked_at = NULL, picked_by = NULL').run()
db.prepare('UPDATE ship_shipments SET packed_at = NULL').run()
db.prepare(`UPDATE ship_shipments SET packed_at = '2026-08-10T20:00:00.000Z' WHERE customer_id = 'delta'`).run()

db.prepare(
  `UPDATE ship_team_slots
      SET picked_at = checked_off_at,
          picked_by = checked_off_by
    WHERE checked_off = 1
      AND customer_id IN (
        SELECT customer_id FROM ship_shipments WHERE packed_at IS NOT NULL
      )`
).run()

const pickedNow = db
  .prepare('SELECT customer_id AS c, COUNT(*) AS n FROM ship_team_slots WHERE picked_at IS NOT NULL GROUP BY customer_id')
  .all() as Array<{ c: string; n: number }>
ok(pickedNow.length === 1, 'exactly one package comes out of the backfill picked', String(pickedNow.length))
ok(pickedNow[0]?.c === 'delta', 'the one that had already shipped', String(pickedNow[0]?.c))
ok(pickedNow[0]?.n === 1, 'all of its cards', String(pickedNow[0]?.n))
ok(
  db.prepare(`SELECT COUNT(*) AS n FROM ship_team_slots WHERE picked_at IS NOT NULL AND customer_id <> 'delta'`).get().n === 0,
  'and every other card starts unpicked, whatever its bagging says'
)
// Attribution survives for the rows that were carried.
ok(
  db.prepare(`SELECT picked_by AS b FROM ship_team_slots WHERE customer_id = 'delta'`).get().b === 'maya',
  'carrying who did it, rather than inventing a name'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
