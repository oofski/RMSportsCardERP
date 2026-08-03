/**
 * Deleting a packing-slip upload.
 *
 * A delete is the one operation in this module that can destroy more than it
 * names. Six things have to be true at once, and every section below is one of
 * them:
 *
 *   THE CHAIN SURVIVES     `carried_from` is what a work claim's liveness is
 *                          derived from. Deleting a link in the middle must
 *                          splice it, not truncate it — otherwise every import
 *                          behind the hole silently goes inert.
 *   STOCK IS ACCOUNTED FOR ticking a SOP step took real supplies and booked
 *                          real money to a day. The delete refuses until the
 *                          caller has agreed to hand it back, and then hands
 *                          back exactly what left.
 *   NOBODY IS STRANDED     a claim must never end up naming an order that is
 *                          gone.
 *   THE WORKSPACE IS WHOLE deleting the live import leaves it genuinely empty,
 *                          never half-counted.
 *   SNAPSHOTS ARE SAFE     the one artifact that outlives a dataset is not
 *                          swept by a delete.
 *   IT IS ONE TRANSACTION  a forced failure part-way leaves the database
 *                          byte-identical.
 *
 * Run: npm run test:import-delete
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/import-delete-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const sop = require('../src/main/db/shipSop')
const supplies = require('../src/main/db/supplies')
const stations = require('../src/main/db/shipStations')
const del = require('../src/main/db/shipImportDelete')
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

// ---------------------------------------------------------------------------
// Fixtures
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

const SHOW_ONE = [
  slip('alpha', '9300120762602315706741', ['1 Boston Red Sox Order 1000000001 $20.00', BOX + '4']),
  slip('bravo', '9300120762602315706742', ['1 New York Yankees Order 1000000002 $25.00', BOX + '4'])
]
const SHOW_TWO = [
  slip('carol', '9300120762602315706751', ['1 Chicago Cubs Order 1000000003 $30.00', BOX + '7']),
  slip('dave', '9300120762602315706752', ['1 Detroit Tigers Order 1000000004 $35.00', BOX + '7']),
  slip('erin', '9300120762602315706753', ['1 Houston Astros Order 1000000005 $40.00', BOX + '8'])
]
const SHOW_THREE = [
  slip('frank', '9300120762602315706761', ['1 Atlanta Braves Order 1000000006 $45.00', BOX + '2'])
]

const importShow = (
  pages: string[],
  name: string,
  date: string,
  carryForward = false
): { id: string } => {
  const res = ship.importDataset(
    parsePages(pages, { sport: 'mlb', eventName: name, eventDate: date }),
    { filename: `${name}.pdf`, name, carryForward }
  )
  return res.record
}

const count = (table: string, where = ''): number =>
  (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n

const importIds = (): string[] => ship.listShipImports().map((r: any) => r.id)

// Become a named station before claiming: a claim row records whichever device
// id was live when it was written.
getDb().prepare(`UPDATE sync_state SET value = 'STATION-A' WHERE key = 'device_id'`).run()

// ---------------------------------------------------------------------------
console.log('=== 1. the plan states what would go, and writes nothing ===')
// ---------------------------------------------------------------------------
const one = importShow(SHOW_ONE, 'Alpha night', '2026-09-01')
ship.setShipEvent('Alpha night', '2026-09-01')

const beforePlan = `${count('ship_orders')}/${count('ship_team_slots')}/${count('ship_imports')}`
let plan = del.planShipImportDelete(one.id)
ok(!!plan, 'the newest import has a plan')
ok(plan.isLive === true, 'and it is the live one — its rows ARE the workspace')
ok(plan.packages === 2, 'two packages would go', String(plan.packages))
ok(plan.cards === 2, 'two cards with them', String(plan.cards))
ok(Math.abs(plan.value - 45) < 0.005, 'worth $45', String(plan.value))
ok(plan.sopSteps === 0, 'nothing has been ticked off yet')
ok(
  plan.needsAcknowledgement === false,
  'so a mis-import nobody has touched is still two clicks',
  JSON.stringify({ picked: plan.cardsPicked, packed: plan.packagesPacked })
)
ok(
  `${count('ship_orders')}/${count('ship_team_slots')}/${count('ship_imports')}` === beforePlan,
  'and drawing the plan wrote nothing',
  beforePlan
)
ok(del.planShipImportDelete('nope') === null, 'an import that does not exist has no plan')

// ---------------------------------------------------------------------------
console.log('\n=== 2. a live claim and an assignment are named, then go ===')
// ---------------------------------------------------------------------------
const firstOrder = stations.pickableOrders()[0]
const claimed = stations.claimOrder(firstOrder.orderId, firstOrder.customerId, 'pick', null)
ok(claimed.ok === true, 'an order is claimed', JSON.stringify(claimed.error))
ship.assignShipBreak({ breakId: 'break_4', breakNumber: 4, employeeId: 'emp-1', assignedBy: null, note: null })
ok(count('ship_break_assignments') === 1, 'and somebody is on break 4')

plan = del.planShipImportDelete(one.id)
ok(plan.working.length === 1, 'the plan names the person holding an order', JSON.stringify(plan.working))
ok(plan.working[0].role === 'pick', 'and what they are doing')
ok(plan.working[0].handle === firstOrder.customerId, 'and which package', String(plan.working[0].handle))
ok(plan.claims === 1 && plan.assignments === 1, 'with the claim and assignment counted')
ok(plan.needsAcknowledgement === true, 'so the confirmation now has to be acknowledged')
ok(plan.carriedToId === null, 'nothing carried forward from it, so there is nowhere to move them')

// ---------------------------------------------------------------------------
console.log('\n=== 3. a second show, then deleting the live one ===')
// ---------------------------------------------------------------------------
// SHOW_ONE's claim is left in place on purpose: after the delete below it names
// an order and a customer that both no longer exist, and a claim pointing at
// nothing is exactly what must never survive.
const two = importShow(SHOW_TWO, 'Bravo night', '2026-09-02')
ship.setShipEvent('Bravo night', '2026-09-02')
ok(importIds().length === 2, 'two imports on the log')
ok(count('ship_work_claims') === 1, "and show one's claim is still on the table")

const nextOrder = stations.pickableOrders()[0]
stations.claimOrder(nextOrder.orderId, nextOrder.customerId, 'pick', null)
ship.assignShipBreak({ breakId: 'break_7', breakNumber: 7, employeeId: 'emp-2', assignedBy: null, note: null })
ok(count('ship_work_claims') === 2, 'show two has a claim of its own')

const res2 = del.deleteShipImport(two.id, { releaseSupplies: false, userId: null })
ok(res2.workspaceCleared === true, 'deleting the live import empties the workspace')
ok(ship.hasShipDataset() === false, 'and it really is empty')
ok(count('ship_orders') === 0 && count('ship_team_slots') === 0, 'no orders, no cards')
ok(count('ship_shipments') === 0 && count('ship_breaks') === 0, 'no packages, no breaks')
ok(count('ship_customers') === 0, 'and no customers')
ok(count('ship_break_assignments') === 0, 'every break assignment went with its break')
ok(
  count('ship_work_claims') === 0,
  'and NO claim is left pointing at an order that is gone',
  String(count('ship_work_claims'))
)
ok(importIds().length === 1 && importIds()[0] === one.id, 'the other import log row is untouched')
ok(ship.getShipImport(one.id).counts.teamSlots === 2, 'including its counts')
ok(stations.liveImportChain().length === 1, 'the chain heads at what is left', JSON.stringify(stations.liveImportChain()))

// The summary is the screen's read, and it must not count rows that are gone.
const summary = domain.getWorkspaceSummary()
ok(summary.hasDataset === false, 'the workspace summary agrees there is no dataset')
ok(
  summary.counts.shipments === 0 && summary.counts.teamSlots === 0 && summary.counts.breaks === 0,
  'with nothing counted anywhere',
  JSON.stringify(summary.counts)
)
ok(summary.lastImport?.id === one.id, 'and the newest import is the earlier one')
ok(stations.getStationBoard().others.length === 0, 'no phantom worker on the bench board')

// ---------------------------------------------------------------------------
console.log('\n=== 4. deleting an EARLIER import touches no dataset ===')
// ---------------------------------------------------------------------------
const three = importShow(SHOW_THREE, 'Charlie night', '2026-09-03')
ship.setShipEvent('Charlie night', '2026-09-03')
const snapshot = domain.createSnapshot('Charlie capture')
ok(!!snapshot, 'a capture is taken of the live show')

const datasetBefore = `${count('ship_orders')}/${count('ship_team_slots')}/${count('ship_shipments')}/${count('ship_breaks')}`
plan = del.planShipImportDelete(one.id)
ok(plan.isLive === false, 'the older import is not the live one')
ok(
  plan.packages === 0 && plan.cards === 0 && plan.breaks === 0,
  'so it claims no dataset rows — they were overwritten when it was replaced',
  JSON.stringify({ p: plan.packages, c: plan.cards, b: plan.breaks })
)
ok(plan.eventDate === null, 'and it can name no day, so no supply row can be attributed to it')

del.deleteShipImport(one.id, { userId: null })
ok(importIds().length === 1 && importIds()[0] === three.id, 'the old log row is gone')
ok(
  `${count('ship_orders')}/${count('ship_team_slots')}/${count('ship_shipments')}/${count('ship_breaks')}` ===
    datasetBefore,
  'and not one dataset row moved',
  datasetBefore
)
ok(ship.listShipSnapshots().length === 1, 'the capture survives a delete — it always does')

// ---------------------------------------------------------------------------
console.log('\n=== 5. deleting a MID-CHAIN import splices, never truncates ===')
// ---------------------------------------------------------------------------
// Three imports of one show, each carrying the last one forward. The middle one
// is a log row: the dataset on the floor belongs to the third. Deleting it must
// leave the first still live and must not take anybody off a break.
del.deleteShipImport(three.id, { userId: null })
ok(importIds().length === 0, 'starting from an empty log')

const DAY = '2026-09-10'
const p1 = importShow(SHOW_TWO, 'Chain night', DAY)
ship.setShipEvent('Chain night', DAY)
const p2 = importShow(SHOW_TWO, 'Chain night', DAY, true)
ok(
  stations.liveImportChain().join(',') === `${p2.id},${p1.id}`,
  'the second carried the first forward',
  JSON.stringify(stations.liveImportChain())
)

// Work done while p2 was the newest is stamped p2.
const chainOrder = stations.pickableOrders()[0]
const chainClaim = stations.claimOrder(chainOrder.orderId, chainOrder.customerId, 'pick', null)
ok(chainClaim.ok === true, 'an order is claimed under the middle import')
ship.assignShipBreak({ breakId: 'break_7', breakNumber: 7, employeeId: 'emp-3', assignedBy: null, note: null })

const p3 = importShow(SHOW_TWO, 'Chain night', DAY, true)
ok(
  stations.liveImportChain().join(',') === `${p3.id},${p2.id},${p1.id}`,
  'three on the chain',
  JSON.stringify(stations.liveImportChain())
)
ok(stations.allLiveClaims().length === 1, "and the middle import's claim is still live")

plan = del.planShipImportDelete(p2.id)
ok(plan.isLive === false, 'the middle one is not live')
ok(plan.carriedToId === p3.id, 'and the plan names where its work will move', String(plan.carriedToId))

const datasetMid = `${count('ship_orders')}/${count('ship_team_slots')}/${count('ship_shipments')}`
del.deleteShipImport(p2.id, { userId: null })
ok(importIds().length === 2, 'the middle log row is gone', JSON.stringify(importIds()))
ok(
  stations.liveImportChain().join(',') === `${p3.id},${p1.id}`,
  'the chain is spliced — one shorter and still whole',
  JSON.stringify(stations.liveImportChain())
)
const spliced = getDb().prepare(`SELECT carried_from FROM ship_imports WHERE id = ?`).get(p3.id) as {
  carried_from: string | null
}
ok(spliced.carried_from === p1.id, 'the successor took over the deleted one’s predecessor')
ok(
  count('ship_work_claims', `WHERE import_id = '${p3.id}'`) === 1,
  'the claim was re-homed onto the successor rather than dropped',
  String(count('ship_work_claims'))
)
ok(stations.allLiveClaims().length === 1, 'so it is STILL live — nobody lost the order they hold')
ok(
  count('ship_break_assignments', `WHERE import_id = '${p3.id}'`) === 1,
  'and nobody came off the break they are standing at',
  String(count('ship_break_assignments'))
)
ok(
  `${count('ship_orders')}/${count('ship_team_slots')}/${count('ship_shipments')}` === datasetMid,
  'with the dataset on the floor untouched',
  datasetMid
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. ticked SOP steps: refused, then handed back exactly ===')
// ---------------------------------------------------------------------------
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
const onHand = (id: string): number => supplies.getSupply(id).quantity

const bagsAtRest = onHand(BAGS)
const mailersAtRest = onHand(MAILERS)
// The list is a line, so team bagging waits for sleeving and sorting.
sop.setShipSopStep('sleeve', true, null)
sop.setShipSopStep('sort', true, null)
sop.setShipSopStep('team_bag', true, null)
const bagsUsed = bagsAtRest - onHand(BAGS)
ok(bagsUsed > 0, 'team bagging took real bags off the shelf', String(bagsUsed))
const bookedDay = sop.packingCostByDay().get(DAY) ?? 0
ok(bookedDay > 0, 'and booked real money to the show’s day', String(bookedDay))

plan = del.planShipImportDelete(p3.id)
ok(plan.isLive === true, 'the show on the floor is the live import')
ok(plan.sopSteps === 3, 'the plan counts all three ticked steps', String(plan.sopSteps))
ok(plan.sopDayOwner === null, 'the day belongs to this show, so it is this show’s to hand back')
const bagLine = plan.sopSupplies.find((l: any) => l.role === 'team_bag')
ok(!!bagLine && bagLine.quantity === bagsUsed, 'and names the exact quantity', JSON.stringify(bagLine))
ok(Math.abs(plan.sopCost - bookedDay) < 0.005, 'and the exact money', `${plan.sopCost} vs ${bookedDay}`)
ok(plan.needsAcknowledgement === true, 'so it cannot be confirmed without saying so')

// --- direction one: refused, and the refusal moves nothing ------------------
let refusal = ''
try {
  del.deleteShipImport(p3.id, { userId: null })
} catch (err: any) {
  refusal = String(err?.message ?? err)
}
ok(refusal !== '', 'a delete that has not agreed to the supplies is refused')
ok(refusal.includes(String(bagsUsed)), 'and the refusal states the quantity', refusal)
ok(refusal.includes(DAY), 'and the day it is booked to', refusal)
ok(onHand(BAGS) === bagsAtRest - bagsUsed, 'the shelf did not move', String(onHand(BAGS)))
ok((sop.packingCostByDay().get(DAY) ?? 0) === bookedDay, 'nor the booked cost')
ok(importIds().includes(p3.id), 'and the import is still there')

// --- direction two: agreed, and everything comes back -----------------------
const res6 = del.deleteShipImport(p3.id, { releaseSupplies: true, userId: null })
ok(res6.workspaceCleared === true, 'agreed, the show goes')
ok(res6.stranded.length === 0, 'with nothing stranded')
ok(onHand(BAGS) === bagsAtRest, 'every bag is back on the shelf', `${onHand(BAGS)} vs ${bagsAtRest}`)
ok(onHand(MAILERS) === mailersAtRest, 'and nothing that never left was invented')
ok(sop.packingCostByDay().has(DAY) === false, 'the day carries no packing cost any more')
ok(count('ship_supply_usage', `WHERE event_date = '${DAY}'`) === 0, 'no usage row survives it')
ok(
  count('ship_sop_steps', `WHERE event_date = '${DAY}'`) === 0,
  'and no checklist row either — a ghost owner would refuse the next import of that day its own list',
  String(count('ship_sop_steps'))
)
ok(sop.getShipSopDay(DAY).owner === null, 'so the day is free again')
ok(count('supply_transactions', `WHERE id LIKE 'shipsop|${DAY}|%'`) === 0, 'and the ledger rows went with it')

// ---------------------------------------------------------------------------
console.log('\n=== 7. a day owned by ANOTHER show is never touched ===')
// ---------------------------------------------------------------------------
const SHARED = '2026-09-20'
const q1 = importShow(SHOW_TWO, 'Morning show', SHARED)
ship.setShipEvent('Morning show', SHARED)
sop.setShipSopStep('sleeve', true, null)
sop.setShipSopStep('sort', true, null)
sop.setShipSopStep('team_bag', true, null)
const morningBags = bagsAtRest - onHand(BAGS)
ok(morningBags > 0, 'the morning show bagged its teams', String(morningBags))

// The afternoon show lands on the same day. It cannot tick anything (the day is
// taken), and deleting it must not hand the morning's stock back.
const q2 = importShow(SHOW_THREE, 'Afternoon show', SHARED)
ship.setShipEvent('Afternoon show', SHARED)
plan = del.planShipImportDelete(q2.id)
ok(plan.sopDayOwner === 'Morning show', 'the plan says whose checklist that day is', String(plan.sopDayOwner))
ok(plan.sopSteps === 0 && plan.sopSupplies.length === 0, 'and claims none of it')

del.deleteShipImport(q2.id, { userId: null })
ok(onHand(BAGS) === bagsAtRest - morningBags, 'the morning show still has its bags out', String(onHand(BAGS)))
ok((sop.packingCostByDay().get(SHARED) ?? 0) > 0, 'and its cost is still booked to the day')
ok(sop.getShipSopDay(SHARED).owner === 'Morning show', 'owned by the show that really used it')

// The morning show's own log row outlives its dataset, and deleting it now
// changes nothing about that day: once a show has been overwritten there is no
// way left to PROVE the day's consumption was its, and guessing is how a P&L
// gets corrupted. Stated here so the limit is deliberate rather than discovered.
plan = del.planShipImportDelete(q1.id)
ok(plan.isLive === false, 'the overwritten show no longer owns the workspace')
ok(plan.eventDate === null, 'so it can name no day')
del.deleteShipImport(q1.id, { userId: null })
ok(onHand(BAGS) === bagsAtRest - morningBags, 'and its booked stock stays exactly where it is')
ok((sop.packingCostByDay().get(SHARED) ?? 0) > 0, 'along with the day’s packing cost')

// ---------------------------------------------------------------------------
console.log('\n=== 8. one transaction: a forced failure changes nothing ===')
// ---------------------------------------------------------------------------
// A live show with three steps ticked and stock out: the hardest possible thing
// to half-delete, because the failure has to unwind returned stock, a spliced
// chain and a cleared dataset all at once.
const HARD = '2026-09-25'
const h1 = importShow(SHOW_TWO, 'Hard night', HARD)
ship.setShipEvent('Hard night', HARD)
const bagsBeforeHard = onHand(BAGS)
sop.setShipSopStep('sleeve', true, null)
sop.setShipSopStep('sort', true, null)
sop.setShipSopStep('team_bag', true, null)
const hardBags = bagsBeforeHard - onHand(BAGS)
ok(hardBags > 0, 'the hard show has stock out', String(hardBags))

const TABLES = [
  'ship_imports',
  'ship_event',
  'ship_breaks',
  'ship_customers',
  'ship_team_slots',
  'ship_shipments',
  'ship_orders',
  'ship_batch_urls',
  'ship_break_audit',
  'ship_warnings',
  'ship_work_claims',
  'ship_break_assignments',
  'ship_documents',
  'ship_sop_steps',
  'ship_supply_usage',
  'ship_snapshots',
  'supplies',
  'supply_transactions',
  'sync_outbox'
]
const dump = (): string =>
  TABLES.map((t) => `${t}:${JSON.stringify(getDb().prepare(`SELECT * FROM ${t}`).all())}`).join('\n')

const before8 = dump()
ok(before8.length > 0, 'there is a database to compare against')

// Fail at the LAST step of the delete, after the stock has gone back, the chain
// has been spliced and the dataset has been cleared. Nothing may survive it.
getDb().exec(
  `CREATE TRIGGER test_block_import_delete BEFORE DELETE ON ship_imports
     BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`
)
let threw = ''
try {
  del.deleteShipImport(h1.id, { releaseSupplies: true, userId: null })
} catch (err: any) {
  threw = String(err?.message ?? err)
}
getDb().exec(`DROP TRIGGER test_block_import_delete`)

ok(threw.includes('forced failure'), 'the delete failed part-way through', threw || '(no error)')
ok(dump() === before8, 'and the database is byte-identical to before it ran')
ok(onHand(BAGS) === bagsBeforeHard - hardBags, 'the returned stock was rolled back too', String(onHand(BAGS)))
ok((sop.packingCostByDay().get(HARD) ?? 0) > 0, 'and the day still carries its cost')
ok(ship.hasShipDataset() === true, 'the workspace was not cleared behind the failure')
ok(importIds().includes(h1.id), 'and the import is still on the log')

// And with the trigger gone the same call goes all the way through.
const res8 = del.deleteShipImport(h1.id, { releaseSupplies: true, userId: null })
ok(res8.workspaceCleared === true, 'the retry succeeds')
ok(onHand(BAGS) === bagsBeforeHard, 'the stock comes back exactly once', String(onHand(BAGS)))
ok(!importIds().includes(h1.id), 'the log row is gone')
ok(ship.hasShipDataset() === false, 'with an empty workspace')
ok(sop.packingCostByDay().has(HARD) === false, 'and no cost left on that day')
ok(ship.listShipSnapshots().length === 1, 'while the capture from section 4 is still standing')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
