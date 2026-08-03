/**
 * The ways the SOP checklist could corrupt stock, and the proof that it does not.
 *
 * Every case here was found by an adversarial review of v0.0.69 and REPRODUCED
 * against real SQLite before it was fixed. They are kept apart from
 * shipSop.test.ts on purpose: that file says the feature works, this one says it
 * does not destroy anything when the world moves underneath it — a product gets
 * re-pointed, unlinked, deleted, the date gets corrected, two shows land on one
 * day, a case of sleeves arrives mid-show.
 *
 * Run: npm run test:sop-hazards
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/sop-haz-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const sop = require('../src/main/db/shipSop')
const supplies = require('../src/main/db/supplies')
const domain = require('../src/main/db/shippingDomain')
const stations = require('../src/main/db/shipStations')
const fin = require('../src/main/db/financeStreaming')
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
const ONE = [
  slip('alpha', '9300120762602315706741', ['1 Boston Red Sox Order 8000000001 $20.00', BOX + '4']),
  slip('bravo', '9300120762602315706742', ['1 New York Yankees Order 8000000002 $0.00', 'GIVEAWAY'])
]
const TWO = [
  ...ONE,
  slip('charlie', '9300120762602315706743', ['1 Chicago Cubs Order 8000000003 $15.00', BOX + '9'])
]

const load = (pages: string[], name: string, date: string): void => {
  ship.importDataset(parsePages(pages, { sport: 'mlb', eventName: name, eventDate: date }), {
    filename: 'haz.pdf'
  })
  ship.setShipEvent(name, date)
}

let seq = 0
const mk = (name: string, qty: number, cost: number, role: string | null): string => {
  const s = supplies.createSupply(
    {
      name: `${name} ${++seq}`,
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
  if (role) supplies.setSupplyShipRole(s.id, role)
  return s.id
}
const onHand = (id: string): number => supplies.getSupply(id)?.quantity ?? null
const packing = (d: string): number => sop.packingCostByDay().get(d) ?? 0

const SOP_ORDER = ['sleeve', 'sort', 'team_bag', 'break_sticker', 'ship', 'scan', 'confirm']

/**
 * Tick everything in front of `step`, so the order gate lets it through.
 *
 * The list is a line now, and every hazard below is about STOCK rather than
 * about order — so each of them opens its own step through the ordinary public
 * path instead of pretending the gate is not there. Nothing here bypasses it.
 */
const openTo = (step: string): void => {
  for (const s of SOP_ORDER) {
    if (s === step) return
    sop.setShipSopStep(s, true, null)
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. re-pointing a role pays the OLD product back ===')
// ---------------------------------------------------------------------------
// Was: the reversal read the ledger row, which is keyed by ROLE, so it paid
// back whichever product the role pointed at NOW — destroying stock on one and
// inventing it on another.
load(ONE, 'Show A', '2026-09-06')
const bagsA = mk('Team bags A', 2000, 0.02, 'team_bag')
openTo('team_bag')
sop.setShipSopStep('team_bag', true, null)
ok(onHand(bagsA) === 1965, 'A gave up 35', String(onHand(bagsA)))

const bagsB = mk('Team bags B', 0, 0.05, null)
supplies.setSupplyShipRole(bagsB, 'team_bag') // releases A
let res = sop.setShipSopStep('team_bag', false, null)
ok(onHand(bagsA) === 2000, 'A got its 35 back', String(onHand(bagsA)))
ok(onHand(bagsB) === 0, 'and B never had any invented for it', String(onHand(bagsB)))
ok(res.released.length === 1, 'the move was reported, not silent', JSON.stringify(res.released))

// Re-tick now takes from B and only from B.
sop.setShipSopStep('team_bag', true, null)
ok(onHand(bagsA) === 2000, 'A is untouched by the re-tick', String(onHand(bagsA)))
ok(onHand(bagsB) === -35, 'B gave up all 35 (and is allowed to go under)', String(onHand(bagsB)))
sop.setShipSopStep('team_bag', false, null)
supplies.setSupplyShipRole(bagsA, 'team_bag')

// ---------------------------------------------------------------------------
console.log('\n=== 2. unlinking a role while ticked still gives the stock back ===')
// ---------------------------------------------------------------------------
// Was: the unmapped branch deleted the usage row without reversing, so the
// units were stranded and the ledger row orphaned.
const mailers = mk('Bubble mailers', 500, 0.3, 'bubble_mailer')
const labels = mk('4x6 labels', 1000, 0.5, 'shipping_label_4x6')
openTo('ship')
sop.setShipSopStep('ship', true, null)
ok(onHand(mailers) === 497 && onHand(labels) === 998, 'shipping took 3 and 2')
supplies.setSupplyShipRole(mailers, null)
sop.setShipSopStep('ship', false, null)
ok(onHand(mailers) === 500, 'the unlinked product still got its 3 back', String(onHand(mailers)))
ok(onHand(labels) === 1000, 'and the linked one got its 2 back', String(onHand(labels)))
// Scoped to THIS step's rows. Opening the gate ticked the four steps in front,
// and team bagging's ledger row is a live one that belongs to a step nobody has
// unticked — counting it here would be measuring the wrong thing.
const orphan = getDb()
  .prepare(`SELECT COUNT(*) AS n FROM supply_transactions WHERE id LIKE 'shipsop|%|ship|%'`)
  .get() as { n: number }
ok(orphan.n === 0, 'no orphaned ledger rows left behind', String(orphan.n))
supplies.setSupplyShipRole(mailers, 'bubble_mailer')

// ---------------------------------------------------------------------------
console.log('\n=== 3. deleting a product mid-show says so instead of losing it ===')
// ---------------------------------------------------------------------------
// Was: deleting cascaded the ledger row away, `already` reset to 0, and the
// untick silently erased the day's cost while returning nothing.
const sleeves = mk('Top sleeves', 100, 0.01, 'top_sleeve')
sop.setShipSopStep('sleeve', true, null)
ok(onHand(sleeves) === 100 - 29, '29 sleeves left the shelf', String(onHand(sleeves)))
supplies.deleteSupply(sleeves)
res = sop.setShipSopStep('sleeve', false, null)
ok(
  res.stranded.length === 1 && res.stranded[0].quantity === 29,
  'the 29 that cannot go anywhere are reported',
  JSON.stringify(res.stranded)
)
ok(onHand(sleeves) === null, 'the product really is gone')

// ---------------------------------------------------------------------------
console.log('\n=== 4. correcting the show date does not deduct the night twice ===')
// ---------------------------------------------------------------------------
// Was: the rows were keyed by date and left behind, the checklist read empty,
// and re-ticking took everything a second time.
sop.setShipSopStep('ship', true, null)
const mailersAfter = onHand(mailers)
ok(packing('2026-09-06') > 0, 'the cost is on the typed date')
ship.setShipEvent('Show A', '2026-09-08') // the real date
ok(packing('2026-09-06') === 0, 'nothing is left on the wrong date', String(packing('2026-09-06')))
ok(packing('2026-09-08') > 0, 'it moved to the right one', String(packing('2026-09-08')))
ok(sop.getShipSop().steps.find((s: any) => s.step === 'ship').done === true,
   'and the checklist came with it')
sop.setShipSopStep('ship', true, null) // the operator re-ticks anyway
ok(onHand(mailers) === mailersAfter, 'a re-tick after the move moves nothing', String(onHand(mailers)))

// ---------------------------------------------------------------------------
console.log('\n=== 5. a second show on the same day is refused, not merged ===')
// ---------------------------------------------------------------------------
// Was: it silently overwrote the first show's rows and handed back stock the
// first show had physically used.
const beforeSecond = onHand(bagsA)
const packBefore = packing('2026-09-08')
load(ONE, 'Show B', '2026-09-08')
let threw = ''
try {
  sop.setShipSopStep('ship', true, null)
} catch (err: any) {
  threw = String(err?.message ?? err)
}
ok(threw.includes('Show A'), 'the refusal names who owns the day', threw || '(no error)')
ok(onHand(bagsA) === beforeSecond, 'no stock moved', String(onHand(bagsA)))
ok(packing('2026-09-08') === packBefore, "and show A's cost is intact", String(packing('2026-09-08')))
load(ONE, 'Show B', '2026-09-15') // give it its own day

// ---------------------------------------------------------------------------
console.log('\n=== 6. a free-text date never becomes a P&L day ===')
// ---------------------------------------------------------------------------
ship.setShipEvent('Show B', 'TBD')
threw = ''
try {
  sop.setShipSopStep('ship', true, null)
} catch (err: any) {
  threw = String(err?.message ?? err)
}
ok(threw.includes('YYYY-MM-DD'), 'ticking is refused and says what is wanted', threw || '(no error)')
ok(
  fin.streamingFinanceView().days.every((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(d.streamDate)),
  'every day in the statement is a real date'
)
ship.setShipEvent('Show B', '2026-09-15')

// ---------------------------------------------------------------------------
console.log('\n=== 7. a mid-show price rise does not restate a published day ===')
// ---------------------------------------------------------------------------
// Was: total_cost = whole quantity x today's average, so a case arriving at a
// higher price re-priced the entire night retroactively.
load(ONE, 'Show C', '2026-10-04')
const bags2 = mk('Team bags C', 5000, 0.02, 'team_bag')
openTo('team_bag')
sop.setShipSopStep('team_bag', true, null) // 35 @ 0.02 = 0.70
ok(Math.abs(packing('2026-10-04') - 0.7) < 0.005, '$0.70 booked', String(packing('2026-10-04')))
// A case arrives at a much higher price, dragging the moving average up.
supplies.purchaseSupply(bags2, { units: 1, itemsPerUnit: 1000, total: 500, note: null }, null)
// The show is corrected upward: 60 packs, so 65 bags.
load(TWO, 'Show C', '2026-10-04')
sop.setShipSopStep('team_bag', true, null)
const unit2 = supplies.getSupply(bags2).unitCost
const expected = 0.7 + 30 * unit2
ok(
  Math.abs(packing('2026-10-04') - Math.round(expected * 100) / 100) < 0.02,
  'only the extra 30 are priced at the new rate',
  `${packing('2026-10-04')} vs ${expected.toFixed(2)}`
)
ok(packing('2026-10-04') < 65 * unit2 - 0.01, 'and NOT the whole night at the new rate')

// ---------------------------------------------------------------------------
console.log('\n=== 8. the screen and the P&L agree on what is booked ===')
// ---------------------------------------------------------------------------
// Was: bookedCost summed only steps flagged done, while the P&L summed every
// usage row — two independently-synced tables, so a partial pull split them.
getDb()
  .prepare(`UPDATE ship_sop_steps SET done = 0 WHERE event_date = ? AND step = 'team_bag'`)
  .run('2026-10-04')
ok(
  Math.abs(sop.getShipSop().bookedCost - packing('2026-10-04')) < 0.005,
  'they still match with the step row out of step',
  `${sop.getShipSop().bookedCost} vs ${packing('2026-10-04')}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. the P&L reconciles through all of it ===')
// ---------------------------------------------------------------------------
const view = fin.streamingFinanceView()
ok(view.reconciled === true, 'reconciled', JSON.stringify(view.reconcileNote))
ok(
  view.days.every((d: any) => d.packingSupplies <= 0),
  'and packing is a cost on every day that has one'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9b. the two-show guard, on the paths that got past it ===')
// ---------------------------------------------------------------------------
// The first version of this guard was defeated four ways. Each is a separate
// route to the same corruption: a second show reduces the first show's recorded
// usage, and the difference is handed back to a shelf that never received it.

const bagsG = mk('Team bags guard', 5000, 0.02, 'team_bag')
const gday = '2027-07-03'

// (a) BOTH SHOWS UNNAMED — the common case, since these slips rarely carry a
// name. Both would answer to "Show <date>", so a name check cannot see them.
load(TWO, '', gday) // 60 packs -> 65 bags
openTo('team_bag')
sop.setShipSopStep('team_bag', true, null)
const afterBig = onHand(bagsG)
const costBig = packing(gday)
ok(afterBig === 5000 - 65, 'the big show took 65', String(afterBig))
load(ONE, '', gday) // 30 packs -> 35 bags, same day, no name
threw = ''
try {
  sop.setShipSopStep('team_bag', true, null)
} catch (err: any) {
  threw = String(err?.message ?? err)
}
ok(threw !== '', 'an unnamed second show is refused', threw || '(no error)')
ok(onHand(bagsG) === afterBig, 'no stock handed back', String(onHand(bagsG)))
ok(packing(gday) === costBig, "and the first show's cost is intact", String(packing(gday)))

// (b) TWO SHOWS THAT SHARE A REAL NAME — same hole, with a name in it.
load(ONE, 'Finest Baseball', gday)
threw = ''
try {
  sop.setShipSopStep('team_bag', true, null)
} catch (err: any) {
  threw = String(err?.message ?? err)
}
ok(threw !== '', 'a same-named second show is refused too', threw || '(no error)')
ok(onHand(bagsG) === afterBig, 'still no stock handed back', String(onHand(bagsG)))

// (c) A SHOW MOVED ONTO AN OCCUPIED DAY. The re-key declines when the target is
// taken — which used to leave "the date changed" true, so the relabel adopted
// the sitting show's rows and switched the guard off on its own trigger case.
load(ONE, 'Latecomer', '2027-07-10')
ship.setShipEvent('Latecomer', gday) // move it onto the occupied day
const ownerRow = getDb()
  .prepare(`SELECT event_name FROM ship_supply_usage WHERE event_date = ? LIMIT 1`)
  .get(gday) as { event_name: string | null }
ok(
  ownerRow.event_name !== 'Latecomer',
  'the sitting show keeps its own name on its rows',
  String(ownerRow.event_name)
)
threw = ''
try {
  sop.setShipSopStep('team_bag', true, null)
} catch (err: any) {
  threw = String(err?.message ?? err)
}
ok(threw !== '', 'and the arrival is refused', threw || '(no error)')
ok(onHand(bagsG) === afterBig, 'nothing moved', String(onHand(bagsG)))
ok(packing(gday) === costBig, 'and the cost never changed', String(packing(gday)))

// (d) A GENUINELY SMALLER RE-IMPORT is not deadlocked by the guard: untick puts
// it all back, then the smaller number ticks cleanly.
sop.setShipSopStep('team_bag', false, null)
ok(onHand(bagsG) === 5000, 'unticking still returns everything', String(onHand(bagsG)))
sop.setShipSopStep('team_bag', true, null)
ok(onHand(bagsG) === 5000 - 35, 'and the smaller show can then tick', String(onHand(bagsG)))

// ---------------------------------------------------------------------------
console.log('\n=== 9c. step 5 closes itself, and pays for itself ONCE ===')
// ---------------------------------------------------------------------------
// Nobody ticks the shipping off. It is finished when the last order has been
// picked, which means the completing condition is re-evaluated on every single
// "Picked · next order", by every bench in the room, all night. This is the one
// hazard that pattern creates: a second mailer for the same night.
//
// Two things stop it and both are checked here — the transition is CLAIMED with
// a conditional write, so only one caller ever goes on to move stock; and the
// quantities are ABSOLUTE, so even a claim landing twice would write the same
// number rather than add to it.
const AUTO_DAY = '2027-09-19'
load(ONE, 'Auto close', AUTO_DAY)
const autoMailers = mk('Bubble mailers auto', 500, 0.3, 'bubble_mailer')
const autoLabels = mk('4x6 labels auto', 1000, 0.5, 'shipping_label_4x6')
openTo('ship') // steps 1-4, the ordinary way

const orders = domain.listOrders()
ok(orders.length === 2, 'two orders to pick', String(orders.length))
ok(sop.getShipSop().steps.find((s: any) => s.step === 'ship').done === false, 'shipping is open')

const completions: boolean[] = []
for (const o of orders) {
  completions.push(stations.pickAdvance(o.customerId, null).sopShipCompleted === true)
}
ok(
  completions.filter(Boolean).length === 1 && completions[completions.length - 1] === true,
  'exactly one pick reported closing it — the LAST one',
  JSON.stringify(completions)
)
ok(sop.getShipSop().steps.find((s: any) => s.step === 'ship').done === true, 'and step 5 is ticked')
// 1 carded package (2 mailers) + 1 giveaway-only (1) = 3; one label per package.
ok(onHand(autoMailers) === 497, 'three mailers left the shelf', String(onHand(autoMailers)))
ok(onHand(autoLabels) === 998, 'and two labels', String(onHand(autoLabels)))

// Now hammer the completing condition the way a real night would: a picker
// re-advancing an order they already finished, a double-click, a second bench
// arriving at the same moment. Every one of them re-evaluates "is picking done?"
// and every one of them must find the transition already taken.
const afterFirst = onHand(autoMailers)
for (const o of orders) {
  ok(
    stations.pickAdvance(o.customerId, null).sopShipCompleted === false,
    `re-advancing @${o.customer.handle} does not close it a second time`
  )
}
for (let i = 0; i < 5; i++) {
  ok(sop.completeShipSopStepOnce('ship', null) === null, `direct call ${i + 1} is refused`)
}
ok(
  onHand(autoMailers) === afterFirst && onHand(autoLabels) === 998,
  'and not one extra mailer or label moved',
  `${onHand(autoMailers)}/${onHand(autoLabels)}`
)
const shipTxns = getDb()
  .prepare(`SELECT COUNT(*) AS n FROM supply_transactions WHERE supply_id = ? AND type = 'use'`)
  .get(autoMailers) as { n: number }
ok(shipTxns.n === 1, 'one use row for the mailers, not a pile', String(shipTxns.n))

// The gate applies to the automatic path too, and refusing is silent: a step 5
// that cannot be ticked is never a reason for a pick to fail. A fresh show with
// nothing ticked in front of it proves both halves at once.
load(ONE, 'Auto blocked', '2027-09-26')
const blockedOrders = domain.listOrders()
const blockedResult = stations.pickAdvance(blockedOrders[0].customerId, null)
ok(!!blockedResult.finished, 'the pick still goes through with step 4 undone')
ok(blockedResult.sopShipCompleted === false, 'and step 5 quietly does not close')
stations.pickAdvance(blockedOrders[1].customerId, null)
ok(
  sop.getShipSop().steps.find((s: any) => s.step === 'ship').done === false,
  'even once every order is picked — the order gate holds on the automatic path'
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. on-hand IS the sum of the movements ===')
// ---------------------------------------------------------------------------
// The load-bearing assumption behind rebuildDerivedSupplyStock, which runs on
// every pull. If any mutation path can move `quantity` without logging a
// matching movement, that rebuild does not repair drift — it CREATES it, on
// every laptop, silently. So the invariant is checked here rather than assumed,
// against every supply left standing after the hazards above.
const drift = (id: string): number => {
  const q = supplies.getSupply(id)?.quantity ?? 0
  const s = (
    getDb()
      .prepare(
        'SELECT COALESCE(SUM(quantity_change), 0) AS q FROM supply_transactions WHERE supply_id = ?'
      )
      .get(id) as { q: number }
  ).q
  return q - s
}
const everySupply = supplies.listSupplies()
const drifting = everySupply.filter((s: any) => drift(s.id) !== 0)
ok(
  drifting.length === 0,
  `${everySupply.length} supplies, none drifting from their movements`,
  JSON.stringify(drifting.map((s: any) => [s.name, drift(s.id)]))
)

// And on the paths that do not involve the checklist at all, since the rebuild
// does not know or care which code moved the number.
const solo = mk('Invariant check', 100, 0.5, null)
supplies.purchaseSupply(solo, { units: 2, itemsPerUnit: 50, total: 60, note: null }, null)
ok(drift(solo) === 0, 'purchase', String(drift(solo)))
supplies.useSupply(solo, { quantity: 30, note: null }, null)
ok(drift(solo) === 0, 'use', String(drift(solo)))
supplies.adjustSupply(solo, -5, 'recount', null)
supplies.adjustSupply(solo, 12, 'found a box', null)
ok(drift(solo) === 0, 'adjustments both ways', String(drift(solo)))
const order = supplies.createSupplyOrder(
  { supplyId: solo, units: 1, itemsPerUnit: 100, total: 40, note: null, source: 'manual' },
  null
)
supplies.setSupplyOrderStatus(order.order.id, 'delivered', null)
ok(drift(solo) === 0, 'a delivered purchase order', String(drift(solo)))
supplies.updateSupply({ id: solo, name: 'Invariant check renamed', reorderPoint: 10 })
ok(drift(solo) === 0, 'and a plain rename moves nothing', String(drift(solo)))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
