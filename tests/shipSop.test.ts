/**
 * The SOP checklist, against a real database.
 *
 * Every assertion here is about the one dangerous property this feature has:
 * ticking a box moves real stock. The arithmetic being right is not enough — it
 * has to be right when the box is ticked twice, when the show is re-imported
 * bigger, when two benches tick the same step, when the shelf is short, and when
 * somebody takes the tick back. Those are the cases that turn a helpful
 * checklist into a corrupted inventory.
 *
 * Run: npm run test:sop
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/sop-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const sop = require('../src/main/db/shipSop')
const supplies = require('../src/main/db/supplies')
const { parsePages } = require('../src/main/shipping/parser')
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

/** One MLB break (30-team slate), two packages: one carded, one giveaway-only. */
const ONE_BREAK = [
  slip('alpha', '9300120762602315706741', ['1 Boston Red Sox Order 7000000001 $20.00', BOX + '4']),
  slip('bravo', '9300120762602315706742', ['1 New York Yankees Order 7000000002 $0.00', 'GIVEAWAY'])
]
/** The same show re-imported with a SECOND break — 60 packs instead of 30. */
const TWO_BREAKS = [
  ...ONE_BREAK,
  slip('charlie', '9300120762602315706743', ['1 Chicago Cubs Order 7000000003 $15.00', BOX + '9'])
]

const DAY = '2026-07-19'
ship.importDataset(parsePages(ONE_BREAK, { sport: 'mlb', eventName: 'SOP test', eventDate: DAY }), {
  filename: 'sop.pdf'
})
ship.setShipEvent('SOP test', DAY)

const mk = (name: string, qty: number, cost: number, role: string): string => {
  const s = supplies.createSupply(
    {
      name,
      unit: 'each',
      unitCost: cost,
      itemsPerUnit: 1,
      reorderPoint: 0,
      recurring: true,
      notes: null,
      openingQuantity: qty
    },
    null
  )
  supplies.setSupplyShipRole(s.id, role)
  return s.id
}

const BAGS = mk('Team bags', 2000, 0.02, 'team_bag')
const MAILERS = mk('Bubble mailers 6x9', 500, 0.3, 'bubble_mailer')
const LABELS = mk('4x6 thermal labels', 1000, 0.5, 'shipping_label_4x6')
const SLEEVES = mk('Top sleeves', 40, 0.01, 'top_sleeve') // deliberately SHORT of 29
// toploader and break_label_2x1 are left unlinked on purpose.

const onHand = (id: string): number => supplies.getSupply(id).quantity
const step = (s: string): any => sop.getShipSop().steps.find((x: any) => x.step === s)

// ---------------------------------------------------------------------------
console.log('=== 1. the checklist before anything is ticked ===')
// ---------------------------------------------------------------------------
let state = sop.getShipSop()
ok(state.steps.length === 7, 'seven steps', String(state.steps.length))
ok(state.doneCount === 0, 'none of them ticked')
ok(state.eventDate === DAY, 'booked to the show day', String(state.eventDate))
ok(
  state.steps.every((s: any) => !s.done && s.lines.every((l: any) => l.used === 0)),
  'and nothing has been consumed'
)
ok(state.bookedCost === 0, 'so nothing is booked', String(state.bookedCost))
ok(
  state.unmappedRoles.includes('toploader') && state.unmappedRoles.includes('break_label_2x1'),
  'the two unlinked roles are named',
  JSON.stringify(state.unmappedRoles)
)
// 30 packs + 5 spares.
ok(step('team_bag').lines[0].quantity === 35, 'team bagging wants 35 bags', String(step('team_bag').lines[0].quantity))
// 2 packages: 1 carded (2 mailers) + 1 giveaway-only (1 mailer) = 3; 2 labels.
const shipLines = step('ship').lines
ok(shipLines.find((l: any) => l.role === 'bubble_mailer').quantity === 3, 'shipping wants 3 mailers')
ok(shipLines.find((l: any) => l.role === 'shipping_label_4x6').quantity === 2, 'and 2 labels')
ok(
  Math.abs(step('ship').cost - 1.9) < 0.005,
  'which comes to $1.90',
  String(step('ship').cost)
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. ticking a step moves exactly that step ===')
// ---------------------------------------------------------------------------
const bagsBefore = onHand(BAGS)
const mailersBefore = onHand(MAILERS)
let res = sop.setShipSopStep('team_bag', true, null)
ok(onHand(BAGS) === bagsBefore - 35, 'the bags left the shelf', `${bagsBefore} -> ${onHand(BAGS)}`)
ok(onHand(MAILERS) === mailersBefore, 'and nothing else moved', String(onHand(MAILERS)))
ok(step('team_bag').done === true, 'the step reads as done')
ok(step('team_bag').lines[0].used === 35, 'and remembers what it took')
ok(Math.abs(sop.getShipSop().bookedCost - 0.7) < 0.005, '$0.70 is booked', String(sop.getShipSop().bookedCost))
ok(res.wentNegative.length === 0, 'nothing went negative')

// ---------------------------------------------------------------------------
console.log('\n=== 3. ticking it again is not a second deduction ===')
// ---------------------------------------------------------------------------
// The single most expensive bug this feature could have: a double-click, a
// re-render, two people on the same step — any of them taking another 35 bags.
const afterFirst = onHand(BAGS)
sop.setShipSopStep('team_bag', true, null)
sop.setShipSopStep('team_bag', true, null)
ok(onHand(BAGS) === afterFirst, 'the count is unchanged after two more ticks', String(onHand(BAGS)))
ok(step('team_bag').lines[0].used === 35, 'and the record still says 35')
ok(
  Math.abs(sop.getShipSop().bookedCost - 0.7) < 0.005,
  'and the money did not triple',
  String(sop.getShipSop().bookedCost)
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. unticking gives it all back ===')
// ---------------------------------------------------------------------------
sop.setShipSopStep('team_bag', false, null)
ok(onHand(BAGS) === bagsBefore, 'the shelf is where it started', `${onHand(BAGS)} vs ${bagsBefore}`)
ok(step('team_bag').done === false, 'the step is unticked')
ok(step('team_bag').lines[0].used === 0, 'with nothing recorded against it')
ok(sop.getShipSop().bookedCost === 0, 'and nothing booked', String(sop.getShipSop().bookedCost))
// Re-tick for the rest of the run.
sop.setShipSopStep('team_bag', true, null)

// ---------------------------------------------------------------------------
console.log('\n=== 5. a corrected re-import moves only the difference ===')
// ---------------------------------------------------------------------------
// Somebody notices a break was missing and re-imports. 60 packs now, so 65
// bags. The step is already ticked for 35 — re-ticking must take 30 more, not
// another 65.
ship.importDataset(parsePages(TWO_BREAKS, { sport: 'mlb', eventName: 'SOP test', eventDate: DAY }), {
  filename: 'sop-fixed.pdf'
})
ship.setShipEvent('SOP test', DAY)
ok(domain.getSupplyPlan().packs === 60, 'the re-import doubled the packs', String(domain.getSupplyPlan().packs))
ok(step('team_bag').done === true, 'the tick survived the re-import')
const beforeTopUp = onHand(BAGS)
sop.setShipSopStep('team_bag', true, null)
ok(
  onHand(BAGS) === beforeTopUp - 30,
  'only the extra 30 bags left',
  `${beforeTopUp} -> ${onHand(BAGS)}`
)
ok(step('team_bag').lines[0].used === 65, 'and the record now says 65', String(step('team_bag').lines[0].used))
ok(
  Math.abs(sop.getShipSop().bookedCost - 1.3) < 0.005,
  'the booked cost followed it to $1.30',
  String(sop.getShipSop().bookedCost)
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. short stock is deducted anyway, and flagged ===')
// ---------------------------------------------------------------------------
// 60 packs × 95% = 57 sleeves, against 40 on hand. The sleeving happened; the
// sleeves are gone whether or not the count agreed. Refusing the tick would
// leave the floor unable to record work it has already done.
res = sop.setShipSopStep('sleeve', true, null)
ok(onHand(SLEEVES) === -17, 'stock went below zero rather than blocking', String(onHand(SLEEVES)))
ok(res.wentNegative.length === 1, 'and the shortfall came back to the caller', JSON.stringify(res.wentNegative))
ok(res.wentNegative[0].onHand === -17, 'saying how far below', String(res.wentNegative[0]?.onHand))
ok(
  res.skippedRoles.includes('toploader'),
  'the unlinked toploaders are reported as skipped',
  JSON.stringify(res.skippedRoles)
)
ok(sop.getShipSop().negatives.length === 1, 'the screen state carries the negative too')
// Unticking has to bring it back to exactly 40 — not clamp at zero.
sop.setShipSopStep('sleeve', false, null)
ok(onHand(SLEEVES) === 40, 'and unticking restores the real number, not zero', String(onHand(SLEEVES)))

// ---------------------------------------------------------------------------
console.log('\n=== 6b. a finished step does not report itself short ===')
// ---------------------------------------------------------------------------
// The trap: the costed plan measures 65 bags against a shelf that 65 bags have
// already left, so a done step would light up amber for stock it correctly
// took. Short means STILL TO COME OUT.
ok(step('team_bag').done === true, 'team bagging is done')
ok(step('team_bag').lines[0].used === 65, 'having taken 65')
ok(
  step('team_bag').lines[0].shortBy === 0,
  'and it is not short of anything',
  String(step('team_bag').lines[0].shortBy)
)
// While a step that has NOT been ticked and cannot be covered still says so.
ok(
  step('sleeve').lines.find((l: any) => l.role === 'top_sleeve').shortBy === 17,
  'an untouched step still reports the real shortfall',
  String(step('sleeve').lines.find((l: any) => l.role === 'top_sleeve').shortBy)
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. an unlinked role records the count and moves nothing ===')
// ---------------------------------------------------------------------------
res = sop.setShipSopStep('break_sticker', true, null)
ok(res.skippedRoles.length === 1, 'the one unlinked role is named', JSON.stringify(res.skippedRoles))
ok(step('break_sticker').lines[0].used === 60, 'the count is remembered', String(step('break_sticker').lines[0].used))
ok(step('break_sticker').lines[0].usedCost === 0, 'and it costs nothing rather than being guessed at')

// ---------------------------------------------------------------------------
console.log('\n=== 8. steps with no supplies still tick ===')
// ---------------------------------------------------------------------------
sop.setShipSopStep('sort', true, null)
sop.setShipSopStep('scan', true, null)
sop.setShipSopStep('confirm', true, null)
ok(step('sort').done && step('scan').done && step('confirm').done, 'sort, scan and confirm all tick')
ok(step('sort').lines.length === 0, 'with nothing under them to move')

// ---------------------------------------------------------------------------
console.log('\n=== 9. the ledger reads as one row per step, not a pile ===')
// ---------------------------------------------------------------------------
const bagTxns = getDb()
  .prepare(`SELECT COUNT(*) AS n FROM supply_transactions WHERE supply_id = ? AND type = 'use'`)
  .get(BAGS) as { n: number }
ok(bagTxns.n === 1, 'six ticks of team bagging left ONE use row', String(bagTxns.n))
const bagRow = getDb()
  .prepare(`SELECT quantity_change FROM supply_transactions WHERE supply_id = ? AND type = 'use'`)
  .get(BAGS) as { quantity_change: number }
ok(bagRow.quantity_change === -65, 'holding the absolute total', String(bagRow.quantity_change))
// Which is what makes two laptops converge: same id, same absolute number.
const usageIds = getDb()
  .prepare(`SELECT id FROM ship_supply_usage WHERE event_date = ? ORDER BY id`)
  .all(DAY) as Array<{ id: string }>
ok(
  usageIds.every((r) => r.id.startsWith(`${DAY}|`)),
  'and every usage row is keyed by the show day',
  JSON.stringify(usageIds.map((r) => r.id))
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. the badge count agrees with the checklist ===')
// ---------------------------------------------------------------------------
const summary = domain.getWorkspaceSummary()
state = sop.getShipSop()
ok(summary.sopTotal === 7, 'the summary says seven steps', String(summary.sopTotal))
ok(
  summary.sopDone === state.doneCount,
  'and agrees with the checklist on how many are done',
  `${summary.sopDone} vs ${state.doneCount}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 11. last week does not follow this week home ===')
// ---------------------------------------------------------------------------
// A new show, on a new day. Its checklist starts empty; the old day's ticks and
// the stock it took stay exactly where they were.
const NEXT = '2026-07-26'
ship.importDataset(parsePages(ONE_BREAK, { sport: 'mlb', eventName: 'Next show', eventDate: NEXT }), {
  filename: 'next.pdf'
})
ship.setShipEvent('Next show', NEXT)
const fresh = sop.getShipSop()
ok(fresh.doneCount === 0, "the new show's checklist is empty", String(fresh.doneCount))
ok(fresh.bookedCost === 0, 'and nothing is booked against it')
const byDay = sop.packingCostByDay()
ok(byDay.has(DAY), "last week's packing is still on last week", JSON.stringify([...byDay]))
ok(!byDay.has(NEXT), 'and this week has none yet')
ok(onHand(BAGS) === bagsBefore - 65, 'the bags stayed off the shelf', String(onHand(BAGS)))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
