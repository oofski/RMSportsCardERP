/**
 * Deleting a packing-slip upload.
 *
 * A delete is the one operation in this module that can destroy more than it
 * names. Five things have to be true at once, and every section below is one of
 * them:
 *
 *   THE CHAIN SURVIVES     `carried_from` is what a work claim's liveness is
 *                          derived from. Deleting a link in the middle must
 *                          splice it, not truncate it — otherwise every import
 *                          behind the hole silently goes inert.
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

const res2 = del.deleteShipImport(two.id)
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
ok(plan.eventDate === null, 'and an overwritten import can name no day at all')

del.deleteShipImport(one.id)
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
del.deleteShipImport(three.id)
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
del.deleteShipImport(p2.id)
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
console.log('\n=== 6. one transaction: a forced failure changes nothing ===')
// ---------------------------------------------------------------------------
// The live show, with cards picked and a package packed: the hardest thing to
// half-delete, because the failure has to unwind a spliced chain and a cleared
// dataset at once.
const HARD = '2026-09-25'
const h1 = importShow(SHOW_TWO, 'Hard night', HARD)
ship.setShipEvent('Hard night', HARD)
const hardOrder = stations.pickableOrders()[0]
stations.claimOrder(hardOrder.orderId, hardOrder.customerId, 'pick', null)
stations.pickAdvance(hardOrder.customerId, null)
ok(del.planShipImportDelete(h1.id).cardsPicked > 0, 'the hard show has real progress on it')

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
  'ship_snapshots',
  'supplies',
  'supply_transactions',
  'sync_outbox'
]
const dump = (): string =>
  TABLES.map((t) => `${t}:${JSON.stringify(getDb().prepare(`SELECT * FROM ${t}`).all())}`).join('\n')

const before6 = dump()
ok(before6.length > 0, 'there is a database to compare against')

// Fail at the LAST step of the delete, after the chain has been spliced and the
// dataset has been cleared. Nothing may survive it.
getDb().exec(
  `CREATE TRIGGER test_block_import_delete BEFORE DELETE ON ship_imports
     BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`
)
let threw = ''
try {
  del.deleteShipImport(h1.id)
} catch (err: any) {
  threw = String(err?.message ?? err)
}
getDb().exec(`DROP TRIGGER test_block_import_delete`)

ok(threw.includes('forced failure'), 'the delete failed part-way through', threw || '(no error)')
ok(dump() === before6, 'and the database is byte-identical to before it ran')
ok(ship.hasShipDataset() === true, 'the workspace was not cleared behind the failure')
ok(importIds().includes(h1.id), 'and the import is still on the log')

// And with the trigger gone the same call goes all the way through.
const res6 = del.deleteShipImport(h1.id)
ok(res6.workspaceCleared === true, 'the retry succeeds')
ok(!importIds().includes(h1.id), 'the log row is gone')
ok(ship.hasShipDataset() === false, 'with an empty workspace')
ok(ship.listShipSnapshots().length === 1, 'while the capture from section 4 is still standing')

// ---------------------------------------------------------------------------
console.log('\n=== 7. no delete moves stock, whatever the show did ===')
// ---------------------------------------------------------------------------
// The checklist that used to take supplies off the shelf when a step was ticked
// is gone, and with it the whole "agree to put it back" bargain. Nothing in a
// delete may touch Supplies again — asserted rather than assumed, because this
// is the one place in the module that ever wrote to that table.
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

const STOCK = '2026-10-02'
const s1 = importShow(SHOW_TWO, 'Stock night', STOCK)
ship.setShipEvent('Stock night', STOCK)
const bagsBefore = onHand(BAGS)
const mailersBefore = onHand(MAILERS)
const txnsBefore = count('supply_transactions')

del.deleteShipImport(s1.id)
ok(onHand(BAGS) === bagsBefore, 'not a bag moved', String(onHand(BAGS)))
ok(onHand(MAILERS) === mailersBefore, 'nor a mailer', String(onHand(MAILERS)))
ok(count('supply_transactions') === txnsBefore, 'and no supply ledger row was written')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
