/**
 * The floor's work log: which two instants each step is measured between.
 *
 * @shared/performance is tested separately and knows nothing about a database.
 * This suite is about the half that cannot be pure — the moment a completion
 * stamp is written, the matching START has to be derived from rows that the
 * next import will delete. Get it wrong here and the arithmetic downstream is
 * impeccable arithmetic on the wrong numbers.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE LOG SURVIVES AN IMPORT. This is the whole reason the table exists.
 *      Every stamp the bench writes lives on a table the next upload deletes
 *      wholesale, so a date range over anything but tonight would have been
 *      answered with silence. If ship_work_log ever joins DATASET_TABLES, the
 *      module reports every past show as a night nobody worked.
 *
 *   2. EACH STEP'S TWO ENDPOINTS ARE THE DOCUMENTED ONES. Sort measures from
 *      the sleeve stamp; a team bag from the previous team's tick; a package
 *      from its pack-station claim; shipping from the pack stamp. Silently
 *      swapping one for another produces numbers that still look plausible.
 *
 *   3. NO START MEANS NO DURATION. Where nothing earlier is on record the row
 *      stores NULL and the basis 'none' — never the finish instant, which would
 *      make every unmeasurable step read as instantaneous.
 *
 *   4. UN-TICKING FORGETS. A step withdrawn did not take any time, and the
 *      measurements that depended on it go with it.
 *
 *   5. THE ROW ID IS DERIVED. Two machines recording one tick write one row.
 *      A minted id would double-count every event the relay carries twice.
 *
 * Every name below is invented. This repository is public.
 *
 * Run: npm run test:work-log
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/worklog-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const workLog = require('../src/main/db/workLog')
const { backfillWorkLog, workLogId } = require('../src/main/db/workLogStore')
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

/**
 * Stand still for a few milliseconds.
 *
 * Every stamp in this file is a real clock reading, and the derivation refuses
 * a start that is not STRICTLY before its finish — two ticks inside one
 * millisecond are not a measurement of anything. Real bench work is minutes
 * apart; a test that fires two calls back to back is not, so it waits.
 */
const waitMs = (ms: number): void => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* deliberately busy: setTimeout would need the whole suite to be async */
  }
}

const db = getDb()
const logRows = (): Array<Record<string, unknown>> =>
  db.prepare('SELECT * FROM ship_work_log ORDER BY finished_at ASC').all()
const findLog = (kind: string, subjectId: string): Record<string, unknown> | undefined =>
  db.prepare('SELECT * FROM ship_work_log WHERE id = ?').get(workLogId(kind, subjectId))

// ---------------------------------------------------------------------------
// A show: one break, two customers, three cards.
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

const dataset = (eventName: string): unknown =>
  parsePages(
    [
      slip('quillfeather', '9300120762602315706741', [
        '1 Boston Red Sox Order 6000000001 $20.00',
        BOX + '4',
        '1 New York Yankees Order 6000000002 $25.00',
        BOX + '4'
      ]),
      slip('marrowgate', '9300120762602315706742', [
        '1 Chicago Cubs Order 6000000003 $30.00',
        BOX + '4'
      ])
    ],
    { sport: 'mlb', eventName, eventDate: '2026-08-02' }
  )

ship.importDataset(dataset('Work log test'), { filename: 'worklog.pdf' })

const br = domain.listBreaks().find((b: { breakLabel: string }) => b.breakLabel === '4')
ok(!!br, 'the break imported')
const breakId = br.id

/** Invented people. */
const HOLLIS = 'emp_hollis_venn'
const ODETTE = 'emp_odette_prynne'

// ---------------------------------------------------------------------------
console.log('=== 1. step 1 has no predecessor, and says so ===')
// ---------------------------------------------------------------------------
domain.setBreakStep(breakId, 'sleeve', true, HOLLIS)
const sleeveRow = findLog('sleeve', breakId)
ok(!!sleeveRow, 'sleeving a break records an event')
ok(sleeveRow?.employee_id === HOLLIS, 'attributed to whoever ticked it')
ok(
  sleeveRow?.start_basis === 'none' && sleeveRow?.started_at === null,
  'with NO start, because nothing earlier is on record',
  String(sleeveRow?.start_basis)
)
ok(
  sleeveRow?.finished_at === domain.getBench(breakId).state.sleeve.at,
  'and a finish equal to the stamp on the break itself'
)
ok(sleeveRow?.units === 3, 'carrying the number of cards it covered', String(sleeveRow?.units))
ok(sleeveRow?.break_label === '4', 'and the break LABEL, so the row still reads after a re-import')

// ---------------------------------------------------------------------------
console.log('\n=== 2. step 2 measures from step 1 on the same break ===')
// ---------------------------------------------------------------------------
waitMs(5)
domain.setBreakStep(breakId, 'sort', true, ODETTE)
const sortRow = findLog('sort', breakId)
const state = domain.getBench(breakId).state
ok(sortRow?.start_basis === 'prev-step', 'the sort measures from the previous step')
ok(sortRow?.started_at === state.sleeve.at, 'specifically from the sleeve stamp')
ok(sortRow?.finished_at === state.sort.at, 'to the sort stamp')
ok(
  sortRow?.employee_id === ODETTE,
  'and belongs to whoever ENDED it, not whoever sleeved it',
  String(sortRow?.employee_id)
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. step 3 chains team to team ===')
// ---------------------------------------------------------------------------
const bench = domain.getBench(breakId)
const teams = bench.rows.map((r: { teamName: string }) => r.teamName)
waitMs(5)
domain.setTeamBagged(breakId, teams[0], true, HOLLIS)
waitMs(5)
domain.setTeamBagged(breakId, teams[1], true, ODETTE)

const row0 = logRows().find((r) => r.kind === 'bag')
const bagRows = logRows().filter((r) => r.kind === 'bag')
ok(bagRows.length === 2, 'one event per team, not one per break', String(bagRows.length))
ok(row0?.start_basis === 'prev-step', 'the first team measures from the sort stamp')
ok(row0?.started_at === state.sort.at, 'specifically from it')
const row1 = bagRows[1]
ok(row1?.start_basis === 'prev-tick', 'and every team after it from the previous team')
ok(row1?.started_at === row0?.finished_at, 'start of one is the finish of the last')
ok(row1?.employee_id === ODETTE, 'each team belongs to whoever ticked THAT team')
ok(row0?.employee_id === HOLLIS, 'so one break splits across the people who worked it')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the break comes off the bench, once ===')
// ---------------------------------------------------------------------------
ok(!findLog('break_done', breakId), 'not finished with teams still to bag')
for (const t of teams.slice(2)) {
  domain.setTeamBagged(breakId, t, true, ODETTE)
}
const done = findLog('break_done', breakId)
ok(!!done, 'the last team closes the break')
ok(done?.start_basis === 'prev-step', 'timed across the whole bench')
ok(done?.started_at === state.sleeve.at, 'from the sleeve stamp to the closing tick')
ok(
  logRows().filter((r) => r.kind === 'break_done').length === 1,
  'and exactly one row, because the id is derived from the break'
)
ok(
  workLogId('break_done', breakId) === workLogId('break_done', breakId),
  'a derived id is the same on every machine that sees the same tick'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. un-ticking forgets ===')
// ---------------------------------------------------------------------------
domain.setTeamBagged(breakId, teams[0], false, HOLLIS)
ok(!findLog('break_done', breakId), 'un-bagging a team withdraws the break-done record')
ok(logRows().filter((r) => r.kind === 'bag').length === teams.length - 1, 'and that team’s own event')

domain.setBreakStep(breakId, 'sleeve', false, HOLLIS)
ok(!findLog('sleeve', breakId), 'un-sleeving forgets the sleeve measurement')
ok(
  !findLog('sort', breakId),
  'and the sort with it, because the checklist cascades and a sort measured from a withdrawn sleeve measures from nothing'
)
// The bag ticks are NOT thrown away: those are cards physically in bags, and
// the checklist deliberately keeps them across an upstream correction.
ok(
  logRows().filter((r) => r.kind === 'bag').length === teams.length - 1,
  'the bags already done are kept, exactly as the checklist keeps them'
)

// Put it back for the packing half.
domain.setBreakStep(breakId, 'sleeve', true, HOLLIS)
waitMs(5)
domain.setBreakStep(breakId, 'sort', true, HOLLIS)
waitMs(5)
domain.setTeamBagged(breakId, teams[0], true, HOLLIS)

// ---------------------------------------------------------------------------
console.log('\n=== 6. steps 4 and 5 — the packages ===')
// ---------------------------------------------------------------------------
const orders = domain.listOrders()
const order = orders[0]
ok(!!order, 'there is a package to pack')

waitMs(5)
domain.setOrderStage(order.id, 'put_together', HOLLIS)
const packRow = findLog('pack', order.id)
ok(!!packRow, 'packing a package records an event')
ok(
  packRow?.start_basis === 'none' && packRow?.started_at === null,
  'with no start, because this one was never claimed at a station',
  String(packRow?.start_basis)
)
ok(packRow?.employee_id === HOLLIS, 'attributed to whoever packed it')

waitMs(5)
domain.setOrderStage(order.id, 'sent', ODETTE)
const shipRow = findLog('ship', order.id)
ok(!!shipRow, 'sending it records step 5')
ok(shipRow?.start_basis === 'packed', 'measured from the pack stamp')
ok(
  shipRow?.started_at === packRow?.finished_at,
  'which is exactly when the pack event finished — the two steps meet, with no gap invented between them'
)
ok(shipRow?.employee_id === ODETTE, 'and belongs to whoever marked it gone')

// A package put back to the picking queue never shipped and was never packed.
domain.setOrderStage(order.id, 'to_pick', ODETTE)
ok(!findLog('pack', order.id), 'sending a package back forgets its pack measurement')
ok(!findLog('ship', order.id), 'and its ship measurement')

// ---------------------------------------------------------------------------
console.log('\n=== 7. a carrier scan is not somebody’s work ===')
// ---------------------------------------------------------------------------
const before = logRows().filter((r) => r.kind === 'ship').length
domain.bulkSetShipmentStatusByTracking(
  [{ trackingNumber: '9300120762602315706742', code: 'in_transit' }],
  { by: 'auto' }
)
ok(
  logRows().filter((r) => r.kind === 'ship').length === before,
  'the automated sweep records nothing: its timestamp is when the app read a tracking page, not when a box was handed over'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. the log survives an import ===')
// ---------------------------------------------------------------------------
const kept = logRows().length
ok(kept > 0, 'there is a night in the log', String(kept))
const breakLabelsBefore = new Set(logRows().map((r) => r.break_label))

ship.importDataset(dataset('A completely different show'), { filename: 'tuesday.pdf' })

ok(
  domain.listBreaks().every((b: { id: string }) => !domain.getBench(b.id).state.sleeve.at),
  'the new show starts with nothing ticked, as it should'
)
const after = logRows()
ok(
  after.length >= kept,
  'and the previous night is STILL IN THE LOG — this is the entire reason the table exists',
  `${after.length} vs ${kept}`
)
ok(
  [...breakLabelsBefore].filter((l) => l).every((l) => after.some((r) => r.break_label === l)),
  'including which break each row was about, long after that break was overwritten'
)

// A range that covers the log finds it; one that does not, does not.
const wide = workLog.listWorkEvents('2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
ok(wide.length === after.length, 'the range read returns every row in the window')
ok(
  workLog.listWorkEvents('2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z').length === 0,
  'and none outside it'
)
const span = workLog.workLogSpan()
ok(!!span.first && !!span.last, 'and the log can say how far back it goes')
ok(span.first <= span.last, 'with the ends the right way round')

// Every row a screen receives must carry a start basis it can act on. A row
// with a start and a basis of 'none' would be a duration nothing can explain.
ok(
  wide.every((e: { startedAt: string | null; startBasis: string }) =>
    e.startBasis === 'none' ? e.startedAt === null : true
  ),
  'no row claims a start under a basis that says there is none'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. the backfill, for the show already on the floor ===')
// ---------------------------------------------------------------------------
// Without it the module opens empty on the day it ships and reads as "nobody
// did anything" rather than "we only started recording today". It can see the
// ONE dataset that still exists; everything earlier is genuinely gone.
const br2 = domain.listBreaks()[0]
domain.setBreakStep(br2.id, 'sleeve', true, ODETTE)
waitMs(5)
domain.setBreakStep(br2.id, 'sort', true, ODETTE)
waitMs(5)
for (const r of domain.getBench(br2.id).rows) {
  domain.setTeamBagged(br2.id, r.teamName, true, ODETTE)
}
const order2 = domain.listOrders()[0]
waitMs(5)
domain.setOrderStage(order2.id, 'sent', HOLLIS)

// Wipe what the live path recorded and rebuild it from the dataset alone —
// which is exactly the situation an existing install is in when it upgrades.
db.prepare('DELETE FROM ship_work_log').run()
const rebuilt = backfillWorkLog(db)
ok(rebuilt > 0, 'the backfill finds work in the loaded show', String(rebuilt))
ok(!!findLog('sleeve', br2.id), 'it recovers step 1')
const bfSort = findLog('sort', br2.id)
ok(bfSort?.started_at === domain.getBench(br2.id).state.sleeve.at,
  'and step 2 between the same two stamps the live path uses')
ok(!!findLog('break_done', br2.id), 'and that the break came off the bench')
ok(!!findLog('pack', order2.id), 'and that the package was packed')
ok(!!findLog('ship', order2.id), 'and that it went')
// BAG IS DELIBERATELY NOT BACKFILLED. Step 3's tick is the pick list's own
// checkmark, and a picker's bulk check-off stamps a whole order at ONE instant
// — chaining those would hand one team a real interval and the rest of the
// order a string of zeros, under whoever happened to be picking.
ok(
  logRows().filter((r) => r.kind === 'bag').length === 0,
  'and it records NO team-bag timings, because a bulk pick stamp cannot be told from a bench tick after the fact'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
