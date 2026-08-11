/**
 * The numbers the shipping board shows, and who is standing on each break.
 *
 * Every case here is one where two screens disagreed about the same fact on a
 * real import. A count that contradicts another count is worse than no count:
 * people stop trusting the screen and go and look in the boxes.
 *
 * Run: npm run test:board
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/board-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const employees = require('../src/main/db/employees')
const { parsePages } = require('../src/main/shipping/parser')
const { readyAllBreaks } = require('./support/bench')

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

// A show with two breaks AND a giveaway that came with no break number — the
// promo rider that has no `ship_breaks` row by design.
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

const PAGES = [
  slip('alpha', '9300120762602315706741', [
    '1 Boston Red Sox Order 5000000001 $20.00',
    BOX + '4',
    '1 New York Yankees Order 5000000002 $25.00',
    BOX + '5',
    // No break marker on this one: a break-less giveaway.
    '1 Chicago Cubs Order 5000000003 $0.00',
    'GIVEAWAY'
  ]),
  slip('bravo', '9300120762602315706742', [
    '1 Chicago Cubs Order 5000000004 $30.00',
    BOX + '4',
    // Not an MLB team. Kept as printed and still pickable — and flagged, which
    // is what section 2 needs something to clear.
    '1 Springfield Isotopes Order 5000000005 $10.00',
    BOX + '5'
  ])
]

const opts = { sport: 'mlb', eventName: 'Board test', eventDate: '2026-08-01' }
ship.importDataset(parsePages(PAGES, opts), { filename: 'board.pdf' })

// ---------------------------------------------------------------------------
// 1. Every card is on the board somewhere
// ---------------------------------------------------------------------------
console.log('\n=== 1. the board accounts for every card ===')
const summary = domain.getWorkspaceSummary()
const breaks = domain.listBreaks()

const onBreaks = breaks.reduce((n: number, b: { totalTeams: number }) => n + b.totalTeams, 0)
ok(summary.counts.teamSlots === 5, 'the show has 5 cards', String(summary.counts.teamSlots))
ok(onBreaks === 4, 'four of them sit in a break', String(onBreaks))
ok(summary.looseCards === 1, 'and one belongs to no break at all', String(summary.looseCards))

// This is the bug: the Find badge counts every slot, the board used to total
// only the breaks, so the badge claimed a card was still out while the board
// showed everything found — with no screen anywhere reconciling the two.
ok(
  onBreaks + summary.looseCards === summary.counts.teamSlots,
  'breaks + loose == the badge total, so the two can never drift',
  `${onBreaks} + ${summary.looseCards} vs ${summary.counts.teamSlots}`
)

// Pick everything that lives in a break; the badge must still show the loose
// one as outstanding rather than reading zero.
//
// The breaks go through the bench first because checking a card off is gated on
// it — see tests/breakBench.test.ts. Done through the real calls rather than by
// writing the columns, so this would start failing if the gate ever stopped
// being reachable from a legitimate flow.
readyAllBreaks()
for (const b of breaks) domain.setBreakChecked(b.id, true)
const mid = domain.getWorkspaceSummary()
ok(
  mid.counts.teamSlots - mid.counts.checkedSlots === 1,
  'with every break picked, one card is still out',
  String(mid.counts.teamSlots - mid.counts.checkedSlots)
)
ok(
  mid.looseCards - mid.looseChecked === 1,
  'and the board can say which one it is',
  `${mid.looseCards - mid.looseChecked}`
)

// ---------------------------------------------------------------------------
// 2. A flag marked handled leaves the badge
// ---------------------------------------------------------------------------
console.log('\n=== 2. handling a flag moves the badge ===')
const flags = domain.listWarnings()
ok(flags.length > 0, 'the import raised at least one flag', String(flags.length))
const openBefore = domain.getWorkspaceSummary().counts.warnings
ok(openBefore === flags.length, 'the badge starts at the open count', String(openBefore))
for (const f of flags) domain.setWarningStatus(f.id, 'handled', null, 'tester')
const afterFlags = domain.getWorkspaceSummary()
ok(afterFlags.counts.warnings === 0, 'clearing every flag empties the badge', String(afterFlags.counts.warnings))
ok(domain.listWarnings().length === flags.length, 'and the flags are still there to reopen')

// ---------------------------------------------------------------------------
// 3. Nobody falls off a break they are standing on
// ---------------------------------------------------------------------------
console.log('\n=== 3. assignments survive an import ===')
employees.insertEmployee(
  {
    firstName: 'Maya',
    lastName: 'Ortiz',
    companyId: 'RM-002',
    title: 'Sorter',
    email: 'maya@rmcardz.test',
    role: 'staff'
  },
  null,
  'temp-password'
)
const maya = employees.listEmployees()[0]
for (const b of domain.listBreaks()) domain.assignBreak(b.id, maya.id, null, maya.id)
ok(
  domain.listBreaks().every((b: { assignees: unknown[] }) => b.assignees.length === 1),
  'everyone is on a break'
)

ship.importDataset(parsePages(PAGES, opts), { filename: 'board.pdf', carryForward: true })
readyAllBreaks()
const afterImport = domain.listBreaks()
ok(
  afterImport.every((b: { assignees: unknown[] }) => b.assignees.length === 1),
  're-importing the same show keeps the crew on it',
  JSON.stringify(afterImport.map((b: { breakLabel: string; assignees: unknown[] }) => [b.breakLabel, b.assignees.length]))
)

// The upgrade case: the assignment was written when this break's id was
// `break_4`, and the slip is now read as the "#4A" it was actually printed as.
// Deleting it took the person off a break they were standing over.
console.log('\n=== 4. a break whose id changed shape keeps its crew ===')
const db = getDb()
db.prepare(`DELETE FROM ship_break_assignments`).run()
db.prepare(
  `INSERT INTO ship_break_assignments
     (id, break_id, break_number, employee_id, assigned_at, assigned_by, note)
   VALUES ('a_old', 'break_4', 4, ?, '2026-08-01T10:00:00Z', NULL, NULL)`
).run(maya.id)

const LETTERED = PAGES.map((p) => p.replace(new RegExp(`${BOX}4$`, 'm'), BOX + '4A'))
ship.importDataset(parsePages(LETTERED, opts), { filename: 'board.pdf' })
readyAllBreaks()
const relabelled = domain.listBreaks()
const four = relabelled.find((b: { breakLabel: string }) => b.breakLabel === '4A')
ok(!!four, 'the break re-imported as #4A', JSON.stringify(relabelled.map((b: { breakLabel: string }) => b.breakLabel)))
ok(four?.assignees.length === 1, 'and Maya is still on it rather than silently dropped', String(four?.assignees.length))

// Ambiguity is NOT guessed at: with both #4 and #4A in the dataset there is no
// safe answer, so the orphan goes and the lead re-assigns in the open.
console.log('\n=== 5. an ambiguous re-home is refused, not guessed ===')
db.prepare(`DELETE FROM ship_break_assignments`).run()
db.prepare(
  `INSERT INTO ship_break_assignments
     (id, break_id, break_number, employee_id, assigned_at, assigned_by, note)
   VALUES ('a_amb', 'break_4X', 4, ?, '2026-08-01T10:00:00Z', NULL, NULL)`
).run(maya.id)
const BOTH = [
  slip('alpha', '9300120762602315706741', [
    '1 Boston Red Sox Order 5000000001 $20.00',
    BOX + '4',
    '1 New York Yankees Order 5000000002 $25.00',
    BOX + '4A'
  ])
]
ship.importDataset(parsePages(BOTH, opts), { filename: 'board.pdf' })
const both = domain.listBreaks()
ok(both.length === 2, 'both #4 and #4A exist', JSON.stringify(both.map((b: { breakLabel: string }) => b.breakLabel)))
ok(
  both.every((b: { assignees: unknown[] }) => b.assignees.length === 0),
  'and the ambiguous assignment is dropped rather than put on the wrong pile'
)

// ---------------------------------------------------------------------------
// 6. "Picked · next order" — one press finishes a package
// ---------------------------------------------------------------------------
//
// The bench has the customer's cards in hand and the slip beside them. Ticking
// every card AND THEN pressing next is doing the job twice, and the second time
// is the one that gets skipped — after which the board claims cards are out that
// are already in a box. So moving on IS the confirmation.
console.log('\n=== 6. marking a whole package picked ===')
ship.importDataset(parsePages(PAGES, opts), { filename: 'board.pdf' })
// An import resets the bench, so the breaks go back through it before any card
// can be ticked.
readyAllBreaks()

const alphaBefore = domain
  .listOrders()
  .find((o: { customerId: string }) => o.customerId === 'alpha')
ok(alphaBefore?.pick.total === 3, "alpha's package holds three cards", String(alphaBefore?.pick.total))
ok(alphaBefore?.pick.checked === 0, 'none of them picked yet')

// One of them is already BAGGED, by somebody else, at the break bench.
const firstSlot = alphaBefore.breaks[0].teams[0].slotId
domain.setTeamSlotChecked(firstSlot, true, 'maya')
const beforeWho = domain
  .listOrders()
  .find((o: { customerId: string }) => o.customerId === 'alpha')
  .breaks.flatMap((b: { teams: unknown[] }) => b.teams)
  .find((t: { slotId: string }) => t.slotId === firstSlot)
ok(beforeWho.checkedOffBy === 'maya', 'and it carries her name', String(beforeWho.checkedOffBy))

// THE SEPARATION. Bagging a card at the break bench does not pick it into
// anybody's package — the bag is still sitting in the break's tray. While these
// shared one column, this line read 1, and a floor that had bagged its breaks
// reported most of its orders as fully picked and waiting at the mailing bench.
const stillUnpicked = domain
  .listOrders()
  .find((o: { customerId: string }) => o.customerId === 'alpha')
ok(stillUnpicked.pick.checked === 0, 'bagging a card does NOT pick it', String(stillUnpicked.pick.checked))
ok(beforeWho.picked === false, 'and the card itself says so')

const after = domain.setOrderChecked('alpha', true, 'sam', true)
ok(after.pick.checked === after.pick.total, 'one press picks the whole package',
  `${after.pick.checked}/${after.pick.total}`)
const keptWho = after.breaks
  .flatMap((b: { teams: unknown[] }) => b.teams)
  .find((t: { slotId: string }) => t.slotId === firstSlot)
ok(keptWho.checkedOffBy === 'maya',
  "a card somebody else bagged keeps THEIR name on the bagging",
  String(keptWho.checkedOffBy))
ok(keptWho.pickedBy === 'sam', 'while the person who collected it owns the pick', String(keptWho.pickedBy))

// THE OTHER HALF OF THE SEPARATION. Picking a package collects bags out of the
// trays; it bags nothing. The break bench's own progress must not move, or a
// sorter would be told work was done that nobody did.
const breaksAfter = domain.listBreaks()
const b4 = breaksAfter.find((b: { breakLabel: string }) => b.breakLabel === '4')
const b5 = breaksAfter.find((b: { breakLabel: string }) => b.breakLabel === '5')
ok(b4.checkedTeams === 1, "break #4 still shows only the one team maya bagged", String(b4.checkedTeams))
ok(b5.checkedTeams === 0, 'and break #5 shows none, because none were bagged', String(b5.checkedTeams))
ok(b5.status === 'pending', 'picking an order leaves the break where it was', String(b5.status))

// The whole-show bagging counts are bench counts, and they did not move either.
const summaryAfter = domain.getWorkspaceSummary()
ok(summaryAfter.looseChecked === 0,
  "the package's break-less giveaway was picked, not bagged", String(summaryAfter.looseChecked))
ok(summaryAfter.counts.checkedSlots === 1,
  'one card bagged across the whole show — the one that was', String(summaryAfter.counts.checkedSlots))

// Idempotent: pressing it again on a finished package changes nothing.
const again = domain.setOrderChecked('alpha', true, 'sam', true)
ok(again.pick.checked === again.pick.total, 'pressing it again is harmless')
ok(
  again.breaks
    .flatMap((b: { teams: unknown[] }) => b.teams)
    .find((t: { slotId: string }) => t.slotId === firstSlot).pickedBy === 'sam',
  'and still does not steal attribution'
)

// Bravo is untouched — one package at a time means one package.
const bravo = domain
  .listOrders()
  .find((o: { customerId: string }) => o.customerId === 'bravo')
ok(bravo.pick.checked === 0, 'the next package is untouched', String(bravo.pick.checked))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
