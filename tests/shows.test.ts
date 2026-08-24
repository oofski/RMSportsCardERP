/**
 * Several packing slips on the bench at once.
 *
 * The workspace held one upload. A Saturday that ran two streams, or a bench
 * still working Thursday when Saturday's slip arrives, meant uploading the
 * second one threw the first one away — and the case that made it urgent is
 * quieter than that: two shows BOTH have a break 4, so without a show in the
 * key the second night's #4 lands on the first night's row.
 *
 * Every case here is one of those collisions.
 *
 * Run: npm run test:shows
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/shows-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const { parsePages } = require('../src/main/shipping/parser')
const { mergeShows, scopeToShow, showOfId, unscopedId, showLabel } = require('../src/shared/shows')

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

getDb()

// ---------------------------------------------------------------------------
// 1. The show token on an id
// ---------------------------------------------------------------------------
console.log('\n=== 1. an id that carries its show ===')

ok(scopeToShow('break_4', 's2') === 'break_4~s2', 'a break id carries the show it ran in')
ok(showOfId('break_4~s2') === 's2', 'and the show reads back out of it')
ok(unscopedId('break_4~s2') === 'break_4', 'and so does the id the slip printed')
ok(showOfId('break_4') === null, 'an unscoped id has no show, rather than a made-up one')
ok(unscopedId('break_4') === 'break_4', 'and comes back unchanged')

/**
 * THE PREFIX TESTS MUST SURVIVE. Screens tell a real break from a promo rider
 * with `id.startsWith('giveaway_')`, so the token goes on the END. A leading
 * one would turn every one of those tests false at once and quietly reclassify
 * every giveaway in the workspace as a break.
 */
ok(
  scopeToShow('giveaway_alpha', 's1').startsWith('giveaway_'),
  'A GIVEAWAY ID IS STILL RECOGNISABLE AS ONE',
  scopeToShow('giveaway_alpha', 's1')
)
ok(scopeToShow('break_4~s2', 's9') === 'break_4~s2', 'and scoping twice does not nest the token')
ok(scopeToShow('break_4', '') === 'break_4', 'no show means no change')

// ---------------------------------------------------------------------------
// 2. Two nights, and they both ran a break 4
// ---------------------------------------------------------------------------
console.log('\n=== 2. two nights that both ran a break 4 ===')

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

const BOX = '1x 2026 FINEST BASEBALL HOBBY BOX- Break #'

const thursday = parsePages(
  [
    slip('alpha', '9300120762602315700001', [
      '1 Boston Red Sox Order 7000000001 $20.00',
      BOX + '4',
      '1 New York Yankees Order 7000000002 $25.00',
      BOX + '4'
    ])
  ],
  { sport: 'mlb', eventName: 'Thursday rip', eventDate: '2026-08-06' }
)

const saturday = parsePages(
  [
    // The SAME buyer, in the SAME break number, buying the SAME team. Every
    // identity the old workspace had collides at once.
    slip('alpha', '9300120762602315700002', [
      '1 Boston Red Sox Order 7000000003 $22.00',
      BOX + '4',
      '1 Chicago Cubs Order 7000000004 $30.00',
      BOX + '4'
    ]),
    slip('bravo', '9300120762602315700003', [
      '1 Chicago Cubs Order 7000000005 $30.00',
      BOX + '9'
    ])
  ],
  { sport: 'mlb', eventName: 'Saturday rip', eventDate: '2026-08-08' }
)

const merged = mergeShows([
  { id: 's1', filename: 'thursday.pdf', dataset: thursday },
  { id: 's2', filename: 'saturday.pdf', dataset: saturday }
])

const breakIds = merged.dataset.breaks.map((b: { id: string }) => b.id).sort()
ok(
  new Set(breakIds).size === breakIds.length,
  'TWO NIGHTS, TWO BREAK #4s, AND NO COLLISION',
  breakIds.join(', ')
)
ok(breakIds.length === 3, 'three breaks in all — #4 twice and #9 once', String(breakIds.length))
ok(
  merged.dataset.breaks.filter((b: { breakLabel: string }) => b.breakLabel === '4').length === 2,
  'and both of them still print as “4” — the show is in the id, not the label'
)
ok(
  merged.dataset.breaks.every((b: { showId: string | null }) => b.showId === 's1' || b.showId === 's2'),
  'every break knows which night it ran on'
)

const slotIds = merged.dataset.teamSlots.map((s: { id: string }) => s.id)
ok(new Set(slotIds).size === slotIds.length, 'and no two cards share an id either', String(slotIds.length))
const orderIds = merged.dataset.orders.map((o: { id: string }) => o.id)
ok(new Set(orderIds).size === orderIds.length, 'nor any two orders', String(orderIds.length))

/**
 * ONE BUYER, ONE BOX. A person who bought on Thursday and again on Saturday
 * gets one package with both nights in it — that is what the floor already
 * does. Duplicating them would put two boxes on the queue for one address.
 */
const alphas = merged.dataset.customers.filter((c: { id: string }) => c.id === 'alpha')
ok(alphas.length === 1, 'ONE BUYER ACROSS BOTH NIGHTS IS ONE BUYER', String(alphas.length))
const alphaShipments = merged.dataset.shipments.filter((s: { customerId: string }) => s.customerId === 'alpha')
ok(alphaShipments.length === 1, 'and one package, not two', String(alphaShipments.length))
ok(
  alphaShipments[0].trackingNumber === '9300120762602315700001',
  'keeping the tracking the floor already put on it',
  String(alphaShipments[0].trackingNumber)
)

const alphaSlots = merged.dataset.teamSlots.filter((s: { customerId: string }) => s.customerId === 'alpha')
ok(alphaSlots.length === 4, "and all four of that buyer's cards", String(alphaSlots.length))
ok(
  new Set(alphaSlots.map((s: { breakId: string }) => showOfId(s.breakId))).size === 2,
  'drawn from both nights',
  alphaSlots.map((s: { breakId: string }) => s.breakId).join(', ')
)

// ---------------------------------------------------------------------------
// 3. Two streams on ONE date
// ---------------------------------------------------------------------------
console.log('\n=== 3. two streams on one date ===')

const morning = parsePages(
  [slip('cara', '9300120762602315700004', ['1 Boston Red Sox Order 7000000006 $20.00', BOX + '1'])],
  { sport: 'mlb', eventName: 'Saturday', eventDate: '2026-08-08' }
)
const evening = parsePages(
  [slip('dana', '9300120762602315700005', ['1 New York Mets Order 7000000007 $20.00', BOX + '1'])],
  { sport: 'mlb', eventName: 'Saturday', eventDate: '2026-08-08' }
)
const sameDay = mergeShows([
  { id: 'a', filename: 'morning.pdf', dataset: morning },
  { id: 'b', filename: 'evening.pdf', dataset: evening }
])

ok(sameDay.shows[0].stream === 1 && sameDay.shows[1].stream === 2, 'the second stream on a date is stream 2')
ok(
  sameDay.shows.every((s: { streamsOnDate: number }) => s.streamsOnDate === 2),
  'and both know there were two'
)
ok(
  showLabel(sameDay.shows[1]) === 'Saturday · stream 2',
  'SO THE BENCH CAN TELL THE MORNING FROM THE EVENING',
  showLabel(sameDay.shows[1])
)
/**
 * A lone show says nothing about streams. "Thursday · stream 1" is noise about
 * a distinction that does not exist, and the operator reads it as a question.
 */
const alone = mergeShows([{ id: 'a', filename: 'one.pdf', dataset: morning }])
ok(showLabel(alone.shows[0]) === 'Saturday', 'while a lone show is just its name', showLabel(alone.shows[0]))

// ---------------------------------------------------------------------------
// 4. Through the store, and back out
// ---------------------------------------------------------------------------
console.log('\n=== 4. through the store, and back out ===')

ship.importDataset(merged.dataset, { filename: 'two-nights.pdf' })

const stored = ship.listShipBreaks()
ok(stored.length === 3, 'all three breaks land in the workspace', String(stored.length))
const fours = stored.filter((b: { breakLabel: string }) => b.breakLabel === '4')
ok(fours.length === 2, 'BOTH BREAK #4s SURVIVE THE IMPORT', String(fours.length))
ok(
  new Set(fours.map((b: { showId: string | null }) => b.showId)).size === 2,
  'on their own nights',
  fours.map((b: { showId: string | null }) => String(b.showId)).join(', ')
)

/**
 * THE AUDIT FOLLOWS ITS BREAK. It was keyed by the printed label, and the label
 * recurs — so with two shows loaded the second night's #4 landed on the first
 * night's primary key and one of the two slates was silently lost.
 */
const audits = ship.listShipBreakAudit()
ok(
  audits.filter((a: { breakLabel: string }) => a.breakLabel === '4').length === 2,
  'AND SO DO BOTH FIDELITY AUDITS — one slate per break, not one per label',
  String(audits.filter((a: { breakLabel: string }) => a.breakLabel === '4').length)
)
const thursdayFour = fours.find((b: { showId: string }) => b.showId === 's1')
const saturdayFour = fours.find((b: { showId: string }) => b.showId === 's2')
ok(
  ship.getShipBreakAudit(thursdayFour.id).breakId === thursdayFour.id,
  'each one reachable by its own break id',
  String(ship.getShipBreakAudit(thursdayFour.id)?.breakId)
)

/**
 * The counts are the point of all of it. Thursday's #4 sold two cards and
 * Saturday's sold two DIFFERENT cards; merged into one break the bench would be
 * told to pull four from a break that holds two.
 */
const summaries = domain.listBreaks()
const sumOf = (id: string): { totalTeams: number } =>
  summaries.find((b: { id: string }) => b.id === id)
ok(sumOf(thursdayFour.id).totalTeams === 2, "Thursday's #4 holds its own two cards", String(sumOf(thursdayFour.id).totalTeams))
ok(sumOf(saturdayFour.id).totalTeams === 2, "and Saturday's holds its own two", String(sumOf(saturdayFour.id).totalTeams))

/**
 * And the buyer who was in both nights has ONE package holding all four cards —
 * which is the thing the floor puts in one box and pays one postage on.
 */
const alphaOrder = domain.listOrders().find((o: { customerId: string }) => o.customerId === 'alpha')
ok(alphaOrder.cardCount === 4, 'ONE BOX, BOTH NIGHTS, FOUR CARDS', String(alphaOrder.cardCount))
ok(alphaOrder.breakCount === 2, 'drawn from two breaks', String(alphaOrder.breakCount))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
