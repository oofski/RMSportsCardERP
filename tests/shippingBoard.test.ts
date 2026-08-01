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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
