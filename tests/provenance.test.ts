/**
 * Where these cases came from, and what is still on order.
 *
 * ## The question, in the owner's words
 *
 * "When I am trying to figure out where cases came from and then go from there,
 * and then I can see which POs which ones are going to be there."
 *
 * Every part of that answer was already in the database and none of it was on a
 * screen. The catalog said how many; the cost-lot picker said what each layer
 * cost; the purchase-order board said what had been ordered. Getting from a case
 * in your hand to the document that bought it meant three screens and matching
 * dates by eye.
 *
 * ## What this suite is really guarding
 *
 * NOTHING WAS MIGRATED FOR THIS. `po_line_receipts` already records one row per
 * receipt carrying the exact `lot_id` that receipt opened — it exists so
 * cancelling a received PO can hand back precisely what each commit took in.
 * Reading it backwards is the whole feature. So the assertions below are about
 * a JOIN telling the truth on the shapes that actually occur:
 *
 *   A PO RECEIVED IN TWO COMMITS AT TWO PRICES is two cost layers and one
 *   delivery. Both layers have to name the same PO, and the grouping has to
 *   present them as one arrival rather than two mystery deliveries.
 *
 *   A LAYER WITH NO PAPERWORK is ordinary — opening balances, count sheets and
 *   found stock all open real layers holding real cases. An inner join would
 *   silently drop exactly the stock somebody most needs explaining, so the
 *   suite plants one and insists it survives.
 *
 *   A PART-RECEIVED LINE is still bringing something, and a FULLY received one
 *   is not. The difference is the entire "which POs are going to be there"
 *   half, and getting it backwards either hides a case that is coming or has
 *   somebody waiting for one that already landed.
 *
 *   A CANCELLED ORDER BRINGS NOTHING and must never appear under a heading that
 *   says what is on the way.
 *
 * Run: npm run test:provenance
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/provenance-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/inventory')
const { productProvenance } = require('../src/main/db/provenance')
const {
  groupSources,
  incomingCost,
  incomingUnits,
  onHandCost,
  onHandUnits,
  sourceLabel,
  unaccounted
} = require('../src/shared/provenance')

const db = getDb()

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

const product = (id: string, name: string, sku: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, name, sku, category, unit_type, boxes_per_case,
                                     unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 'case', 12, 0, '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
  ).run(id, name, sku)
}

product('p_topps', '2026 Topps Chrome Case', 'PRV-001')
product('p_prizm', '2026 Prizm Case', 'PRV-002')

// ---------------------------------------------------------------------------
console.log('\n=== 1. one delivery, two commits, two prices ===')
// ---------------------------------------------------------------------------
/**
 * The shape that makes a single `po_id` column on the lot impossible: a line
 * received in two partial commits opens TWO cost layers, at whatever each
 * commit cost. Both came off the same document.
 */
const po1 = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [{ productId: 'p_topps', quantity: 4, unitPrice: 1400 }]
  },
  'emp_owner'
)
const line1 = po1.lines[0]

const firstCommit = poRepo.receivePurchaseOrderLines(
  po1.id,
  [{ lineId: line1.id, quantity: 2 }],
  'emp_owner'
)
ok(!firstCommit.error, 'two cases land on Tuesday', String(firstCommit.error))

const secondCommit = poRepo.receivePurchaseOrderLines(
  po1.id,
  [{ lineId: line1.id, quantity: 2 }],
  'emp_owner'
)
ok(!secondCommit.error, 'and two more on Friday', String(secondCommit.error))

const topps = productProvenance('p_topps')
ok(topps.onHand.length === 2, 'TWO COST LAYERS, one per commit', String(topps.onHand.length))
ok(
  topps.onHand.every((s: { poNumber: string | null }) => s.poNumber === po1.poNumber),
  'AND BOTH NAME THE PURCHASE ORDER THEY CAME OFF',
  topps.onHand.map((s: { poNumber: string | null }) => String(s.poNumber)).join(', ')
)
ok(
  topps.onHand.every((s: { poId: string | null }) => s.poId === po1.id),
  'by id, which is what makes the row somewhere to go',
  topps.onHand.map((s: { poId: string | null }) => String(s.poId)).join(', ')
)
ok(
  topps.onHand.every((s: { vendor: string | null }) => s.vendor === 'Steel City'),
  'carrying the supplier the units were bought from',
  topps.onHand.map((s: { vendor: string | null }) => String(s.vendor)).join(', ')
)
ok(onHandUnits(topps) === 4, 'four cases on the shelf', String(onHandUnits(topps)))
ok(onHandCost(topps) === 5600, 'at what they actually cost', String(onHandCost(topps)))

/**
 * ONE DOCUMENT, ONE ARRIVAL. The question "where did these come from" is asked
 * about the delivery, not the commit — two rows both reading PO-0001 is the
 * screen asking the reader to do the grouping.
 */
const grouped = groupSources(topps.onHand)
ok(grouped.length === 1, 'AND THE SCREEN SHOWS ONE DELIVERY, NOT TWO', String(grouped.length))
ok(grouped[0].qty === 4, 'holding all four cases', String(grouped[0].qty))
ok(grouped[0].layers.length === 2, 'made of the two commits underneath', String(grouped[0].layers.length))
ok(grouped[0].poId === po1.id, 'and it is the purchase order that is clickable', String(grouped[0].poId))
ok(sourceLabel(topps.onHand[0]) === po1.poNumber, 'labelled by its PO number', sourceLabel(topps.onHand[0]))

// The order is fully received, so it is bringing nothing more.
ok(topps.incoming.length === 0, 'a finished order is NOT still coming', String(topps.incoming.length))

// ---------------------------------------------------------------------------
console.log('\n=== 2. what is still on the way ===')
// ---------------------------------------------------------------------------
const po2 = poRepo.createPurchaseOrder(
  {
    supplier: 'Blowout',
    location: 'AM',
    lines: [{ productId: 'p_topps', quantity: 6, unitPrice: 1450 }]
  },
  'emp_owner'
)
const partial = poRepo.receivePurchaseOrderLines(
  po2.id,
  [{ lineId: po2.lines[0].id, quantity: 2 }],
  'emp_owner'
)
ok(!partial.error, 'two of six arrive early', String(partial.error))

const withIncoming = productProvenance('p_topps')
ok(withIncoming.incoming.length === 1, 'ONE PURCHASE ORDER IS STILL BRINGING CASES', String(withIncoming.incoming.length))
const coming = withIncoming.incoming[0]
ok(coming.poNumber === po2.poNumber, 'and it says which', String(coming.poNumber))
ok(coming.ordered === 6, 'six ordered', String(coming.ordered))
ok(coming.received === 2, 'two already here', String(coming.received))
ok(coming.outstanding === 4, 'FOUR STILL TO COME — the number somebody is actually asking for', String(coming.outstanding))
ok(coming.supplier === 'Blowout', 'from the supplier who owes them', String(coming.supplier))
ok(coming.destination === 'AM', 'headed to a named shelf', String(coming.destination))
ok(incomingUnits(withIncoming) === 4, 'four units on order across everything', String(incomingUnits(withIncoming)))
ok(incomingCost(withIncoming) === 5800, 'at the price already agreed', String(incomingCost(withIncoming)))

/**
 * ON HAND AND ON ORDER ARE NEVER ADDED TOGETHER. The two units that landed early
 * are on the shelf; the four still owed are not. A screen that reports six would
 * have somebody schedule a break against cases that have not shipped.
 */
ok(onHandUnits(withIncoming) === 6, 'the shelf holds six — four plus the two that came early', String(onHandUnits(withIncoming)))
ok(
  onHandUnits(withIncoming) !== onHandUnits(withIncoming) + incomingUnits(withIncoming),
  'and the outstanding four are counted separately, never folded in'
)

/**
 * AN ORDER SPLIT ACROSS TWO SHELVES HAS NO SINGLE DESTINATION.
 *
 * "to RM" on an order half of which is going to AM sends somebody to the wrong
 * building for a case that was never going to be there. The honest answer is to
 * say nothing and let them open the order, which is one press away.
 */
const split = poRepo.createPurchaseOrder(
  {
    supplier: 'Dave & Adams',
    location: 'RM',
    lines: [
      {
        productId: 'p_topps',
        quantity: 4,
        unitPrice: 1500,
        allocations: [
          { quantity: 2, supplier: null, destination: 'RM' },
          { quantity: 2, supplier: null, destination: 'AM' }
        ]
      }
    ]
  },
  'emp_owner'
)
const splitRow = productProvenance('p_topps').incoming.find(
  (i: { poId: string }) => i.poId === split.id
)
ok(!!splitRow, 'a split order is listed as coming', String(splitRow))
ok(splitRow.outstanding === 4, 'with all four units outstanding', String(splitRow?.outstanding))
ok(
  splitRow.destination === null,
  'AND NAMES NO SINGLE SHELF — half of it is going somewhere else',
  String(splitRow?.destination)
)

/**
 * THE SHAPE THAT NEEDS THE GUARD: one line split across two shelves, and one
 * line that is not. The unsplit line supplies a perfectly good single
 * destination, so counting distinct destinations alone says "one" and the
 * screen prints "to RM" — for an order half of which is going to AM. The split
 * line has to veto the whole answer, not just decline to contribute one.
 */
product('p_mosaic', '2026 Mosaic Case', 'PRV-004')
const mixedDest = poRepo.createPurchaseOrder(
  {
    supplier: 'Dave & Adams',
    location: 'RM',
    lines: [
      {
        productId: 'p_mosaic',
        quantity: 4,
        unitPrice: 1500,
        allocations: [
          { quantity: 2, supplier: null, destination: 'RM' },
          { quantity: 2, supplier: null, destination: 'AM' }
        ]
      },
      // Unsplit, and headed to RM — the line that makes the naive count say 1.
      { productId: 'p_mosaic', quantity: 2, unitPrice: 1500, destination: 'RM' }
    ]
  },
  'emp_owner'
)
const mixedRow = productProvenance('p_mosaic').incoming.find(
  (i: { poId: string }) => i.poId === mixedDest.id
)
ok(mixedRow.ordered === 6, 'six units across both lines, counted once each', String(mixedRow?.ordered))
ok(
  mixedRow.destination === null,
  'AND ONE SPLIT LINE VETOES THE WHOLE ORDER’S SHELF, however tidy the other line is',
  String(mixedRow?.destination)
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. a case nobody can account for ===')
// ---------------------------------------------------------------------------
/**
 * Opening balances, count-sheet corrections and found stock all open real cost
 * layers holding real cases, and none of them has a document behind it. An inner
 * join would drop exactly the stock somebody most needs explaining.
 */
inv.addStock('p_prizm', 'RM', 1, 1500, 'Found on the shelf', 'emp_owner')
const prizm = productProvenance('p_prizm')
ok(prizm.onHand.length === 1, 'A LAYER WITH NO PURCHASE ORDER STILL APPEARS', String(prizm.onHand.length))
ok(prizm.onHand[0].poId === null, 'with nothing invented for its paperwork', String(prizm.onHand[0].poId))
ok(unaccounted(prizm.onHand[0]) === true, 'and it is MARKED as unaccounted for', 'a case with no origin is the most useful thing this screen says')
ok(
  sourceLabel(prizm.onHand[0]) === 'Found on the shelf',
  'described by whatever the receipt did write down',
  sourceLabel(prizm.onHand[0])
)
ok(onHandUnits(prizm) === 1, 'and it is counted', String(onHandUnits(prizm)))

/** A layer with a supplier is accounted for, even without a document. */
inv.addStock('p_prizm', 'RM', 1, 1500, 'Bought at the show', 'emp_owner', 'Card Barn')
const withVendor = productProvenance('p_prizm').onHand.find(
  (s: { vendor: string | null }) => s.vendor === 'Card Barn'
)
ok(!!withVendor, 'a layer bought from a named supplier is recorded as such', String(withVendor?.vendor))
ok(
  unaccounted(withVendor) === false,
  'and is NOT flagged — somebody typed where it came from',
  'a vendor is an account of its origin even with no PO'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. a cancelled order brings nothing ===')
// ---------------------------------------------------------------------------
const po3 = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [{ productId: 'p_prizm', quantity: 10, unitPrice: 1500 }]
  },
  'emp_owner'
)
ok(
  productProvenance('p_prizm').incoming.some((i: { poId: string }) => i.poId === po3.id),
  'an open order is listed as coming'
)
poRepo.setPurchaseOrderStatus(po3.id, 'cancelled', 'emp_owner')
ok(
  !productProvenance('p_prizm').incoming.some((i: { poId: string }) => i.poId === po3.id),
  'A CANCELLED ORDER IS GONE FROM WHAT IS COMING — it is over, not late',
  productProvenance('p_prizm')
    .incoming.map((i: { poNumber: string }) => i.poNumber)
    .join(', ')
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. breaking a case does not lose its paperwork ===')
// ---------------------------------------------------------------------------
/**
 * FIFO consumes the OLDEST layer first, so opening a case eats into the earliest
 * delivery. What is left has to keep naming the order it came off — the whole
 * point of the screen is answering the question about the cases still in the
 * room, not the ones already broken.
 */
const before = productProvenance('p_topps')
const oldest = before.onHand[0]
inv.adjustStock('p_topps', 'RM', -1, 'Broken on stream', 'emp_owner')
const after = productProvenance('p_topps')
ok(onHandUnits(after) === onHandUnits(before) - 1, 'one case leaves the shelf', String(onHandUnits(after)))
ok(
  after.onHand.every((s: { poNumber: string | null }) => s.poNumber !== null || s.vendor !== null),
  'AND EVERY LAYER LEFT STILL KNOWS WHERE IT CAME FROM'
)
const oldestAfter = after.onHand.find((s: { lotId: string }) => s.lotId === oldest.lotId)
ok(
  !oldestAfter || oldestAfter.qtyRemaining < oldest.qtyRemaining,
  'and it came out of the oldest layer, which is the one FIFO takes',
  `${oldest.qtyRemaining} -> ${String(oldestAfter?.qtyRemaining)}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. a product nobody has touched ===')
// ---------------------------------------------------------------------------
product('p_empty', 'Never Bought Case', 'PRV-003')
const empty = productProvenance('p_empty')
ok(empty.onHand.length === 0 && empty.incoming.length === 0, 'reads as empty rather than throwing')
ok(onHandUnits(empty) === 0 && incomingUnits(empty) === 0, 'and totals to nothing')
ok(productProvenance('').productId === '', 'and an empty id is answered, not queried')

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
