/**
 * Dropship and per-line routing — a purchase order whose units are not all
 * coming here.
 *
 * A PO used to be "one supplier, one destination, all of it lands on our shelf".
 * It is now a document whose every line, and every slice of a line, can name its
 * own supplier and its own destination — and a destination is WIDER than a
 * location: it is RM, or AM, or the name of a shop the boxes go straight to.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. A DROPSHIP NEVER TOUCHES STOCK. `addStock` does not validate its
 *      location argument, so given a customer's name it would open a real
 *      inventory_stock row and a real FIFO layer keyed to that name — and
 *      `lotWeightedAvgCost` averages `inventory_lots` across ALL locations, so a
 *      phantom layer at "Fenwick Cards" would move the unit cost, and therefore
 *      the reported margin, of boxes physically sitting on the RM shelf.
 *      `assertStockLotsConsistent` would still pass, because the phantom row is
 *      internally consistent with itself. Nothing in the app would catch it.
 *      This suite is what catches it.
 *
 *   2. EVERY ORDER RAISED BEFORE THIS FEATURE BEHAVES IDENTICALLY. The whole
 *      mechanism is that a line with no allocation rows IS one implicit
 *      allocation of its whole quantity at the header's destination, and the
 *      migration writes no allocation row for any existing order. If that
 *      identity ever stops holding, every progress bar, completion test and
 *      incoming count in the app moves at once.
 *
 *   3. THE DESTINATION IS NOT COERCED. `createPurchaseOrder` used to rewrite
 *      anything that was not RM or AM to 'RM', which would turn every dropship
 *      into an ordinary purchase order and put every unit on the shelf.
 *
 *   4. THE STOCK DECISION IS MADE PER ALLOCATION, NEVER PER ORDER. There is no
 *      "this is a dropship PO" branch anywhere in the receiving code, because a
 *      mixed order is both at once.
 *
 *   5. THE REVERSAL PATHS READ THE RECEIPT'S OWN SHELF. Cancelling an order
 *      whose units went to AM under a header that says RM must hand them back to
 *      AM — a header-derived location unwinds against the wrong shelf and leaves
 *      both of them wrong.
 *
 * Run: npm run test:dropship
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/dropship-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/inventory')
const lots = require('../src/main/db/lots')
const scan = require('../src/main/db/scanning')
const owner = require('../src/main/db/ownerDashboard')
const { LOCATION_IDS } = require('../src/shared/inventory')
const {
  canonicalDestination,
  destinationHoldsStock,
  displayOrderNumber,
  orderKindOf
} = require('../src/shared/purchaseOrders')
const { receivableProgressOf } = require('../src/shared/receiving')
const db = getDb()

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

const ACTOR = 'emp_owner'
const DROP = 'Fenwick Cards'

const mkProduct = (id: string, name: string, sku: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, name, sku, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 0, '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
  ).run(id, name, sku)
}
;['a', 'b', 'c', 'd', 'e', 'f'].forEach((k, i) =>
  mkProduct(`p_${k}`, `Case Product ${k.toUpperCase()}`, `DRP-00${i + 1}`)
)

/**
 * This order's view rows. DELIBERATELY UNORDERED, and every assertion over them
 * is written to not care.
 *
 * The obvious ORDER BY po_line_id sorts by UUID, which is stable within a run
 * and arbitrary between them — a flake that passes locally and fails in CI every
 * other Tuesday. Ordering by the view's `position` is no better: that column
 * means the LINE's place in the order on one arm and the ALLOCATION's place
 * within its line on the other, so it is not a total order across lines at all.
 * The invariant worth pinning is per row, so it is asserted per row.
 */
const unitRows = (poId: string): Array<Record<string, unknown>> =>
  db.prepare('SELECT * FROM po_unit_destinations WHERE po_id = ?').all(poId)
const allocationCount = (poId: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM purchase_order_allocations WHERE po_id = ?').get(poId) as {
    n: number
  }).n
const cogsFor = (poId: string): number | null =>
  (db.prepare('SELECT amount FROM finance_cogs WHERE po_id = ?').get(poId) as { amount: number } | undefined)
    ?.amount ?? null
/** Every stock row, lot and ledger movement that is NOT on a real shelf. */
const strayStockRows = (): number => {
  const inList = LOCATION_IDS.map((l: string) => `'${l}'`).join(',')
  const q = (t: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE location NOT IN (${inList})`).get() as { n: number }).n
  return q('inventory_stock') + q('inventory_lots') + q('inventory_transactions')
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. an ordinary order is byte-for-byte what it always was ===')
// ---------------------------------------------------------------------------

const legacy = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      { productId: 'p_a', quantity: 5, unitPrice: 100 },
      { productId: 'p_b', quantity: 3, unitPrice: 200 }
    ]
  },
  ACTOR
)

// T1. THE WHOLE BACK-COMPAT MECHANISM IN ONE ASSERTION. An unsplit line writes
// no allocation row at all — not one row of the full quantity, zero rows — so
// the code path that reads "no rows" produces exactly what the code path that
// read the header used to produce.
ok(allocationCount(legacy.id) === 0, 'T1 an unsplit order writes ZERO allocation rows', String(allocationCount(legacy.id)))

// T2. The view's second arm is that invariant in SQL.
const legacyUnits = unitRows(legacy.id)
ok(legacyUnits.length === 2, 'T2 the view returns exactly one row per line', String(legacyUnits.length))
ok(
  legacyUnits.every((u) => u.destination === 'RM' && u.allocation_id === null),
  'T2 at the header location, with no allocation id',
  JSON.stringify(legacyUnits.map((u) => [u.destination, u.allocation_id]))
)
// Each row carries the quantity of the LINE IT POINTS AT — checked by looking
// the line up, not by trusting the order rows come back in.
const lineQty = (id: unknown): number =>
  (db.prepare('SELECT quantity FROM purchase_order_lines WHERE id = ?').get(id) as {
    quantity: number
  }).quantity
ok(
  legacyUnits.every((u) => u.quantity === lineQty(u.po_line_id)),
  'T2 each carrying the quantity of the line it points at',
  JSON.stringify(legacyUnits.map((u) => [u.quantity, lineQty(u.po_line_id)]))
)
ok(
  legacyUnits.map((u) => u.quantity).reduce((a, b) => (a as number) + (b as number), 0) === 8,
  'T2 and the eight ordered units are materialised exactly once',
  String(legacyUnits.map((u) => u.quantity).reduce((a, b) => (a as number) + (b as number), 0))
)
ok(
  legacyUnits.every((u) => u.supplier === 'Steel City'),
  'T2 and the header supplier, inherited not copied',
  JSON.stringify(legacyUnits.map((u) => u.supplier))
)
ok(
  (db.prepare('SELECT supplier, destination FROM purchase_order_lines WHERE po_id = ?').all(legacy.id) as Array<
    Record<string, unknown>
  >).every((r) => r.supplier === null && r.destination === null),
  'T2 the stored line columns are NULL — the inheritance, not a copy'
)

// T3.
const legacyDetail = poRepo.getPurchaseOrder(legacy.id)
ok(legacyDetail.orderKind === 'stock', 'T3 orderKind is stock', String(legacyDetail.orderKind))
ok(
  legacyDetail.receivableUnits === legacyDetail.orderedUnits && legacyDetail.orderedUnits === 8,
  'T3 every ordered unit is receivable',
  `${legacyDetail.receivableUnits}/${legacyDetail.orderedUnits}`
)
ok(legacyDetail.dropshipUnits === 0, 'T3 and none is drop-shipped', String(legacyDetail.dropshipUnits))
ok(
  legacyDetail.lines.every((l: { qtyReceivable: number; quantity: number }) => l.qtyReceivable === l.quantity),
  'T3 qtyReceivable equals quantity on every line — the identity the whole migration rests on'
)
ok(
  legacyDetail.lines.every((l: { allocations: unknown[] }) => l.allocations.length === 0),
  'T3 and no line reports an allocation'
)
ok(legacyDetail.destinationCount === 1, 'T3 one destination', String(legacyDetail.destinationCount))

// T4. The number on the document is the number in the database.
ok(legacy.poNumber === 'PO-0001', 'T4 the first order is PO-0001', legacy.poNumber)
ok(
  displayOrderNumber(legacy.poNumber, legacyDetail.orderKind) === 'PO-0001',
  'T4 and displays as itself',
  displayOrderNumber(legacy.poNumber, legacyDetail.orderKind)
)

// T5. It receives exactly as tests/receiving.test.ts asserts today.
const legacyReceipt = poRepo.receivePurchaseOrderLines(
  legacy.id,
  legacy.lines.map((l: { id: string; quantity: number }) => ({ lineId: l.id, quantity: l.quantity })),
  ACTOR
)
ok(!legacyReceipt.error, 'T5 the whole delivery is accepted', String(legacyReceipt.error))
ok(inv.stockQty('p_a', 'RM') === 5 && inv.stockQty('p_b', 'RM') === 3, 'T5 the stock is on the RM shelf')
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM inventory_lots WHERE product_id = ?').get('p_a') as { n: number }).n === 1,
  'T5 and a cost layer was opened'
)
ok(poRepo.getPurchaseOrder(legacy.id).status === 'received', 'T5 the order completes itself')
ok(
  receivableProgressOf(poRepo.getPurchaseOrder(legacy.id).lines).percent === 100,
  'T5 and reads 100%',
  String(receivableProgressOf(poRepo.getPurchaseOrder(legacy.id).lines).percent)
)
// Every receipt row now carries the shelf it landed on, backfilled or written.
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM po_line_receipts WHERE po_id = ? AND location IS NULL').get(
    legacy.id
  ) as { n: number }).n === 0,
  'T5 every receipt row names its own shelf'
)

// T6. The proof that existing behaviour is untouched is the two suites that
// describe it, run UNEDITED. They are in `npm test`; what is checked here is
// that they were not quietly adapted to this change.
const untouched = ['receiving', 'scanning'].every((name) => {
  const src = readFileSync(join(process.cwd(), `tests/${name}.test.ts`), 'utf8')
  return !/allocation|dropship|drop-ship/i.test(src)
})
ok(untouched, 'T6 receiving.test.ts and scanning.test.ts mention nothing of this change')

// ---------------------------------------------------------------------------
console.log('\n=== 2. the destination is kept, not coerced ===')
// ---------------------------------------------------------------------------

const storedLocation = (id: string): string =>
  (db.prepare('SELECT location FROM purchase_orders WHERE id = ?').get(id) as { location: string }).location

// T7. THE LINE THAT USED TO KILL THE FEATURE. `isLocation(x) ? x : 'RM'` turned
// every dropship into an RM purchase order, silently.
const fenwick = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: DROP, lines: [{ productId: 'p_c', quantity: 4, unitPrice: 250 }] },
  ACTOR
)
ok(storedLocation(fenwick.id) === DROP, 'T7 a party name is stored as typed', storedLocation(fenwick.id))

// T8. R2: a hand-typed location id folds back to its canonical spelling, or the
// units silently stop being receivable and the order can never complete.
const lower = poRepo.createPurchaseOrder(
  { location: 'rm', lines: [{ productId: 'p_c', quantity: 1, unitPrice: 10 }] },
  ACTOR
)
ok(storedLocation(lower.id) === 'RM', 'T8 "rm" is stored as RM', storedLocation(lower.id))

// T9. The unchanged fallback.
const blank = poRepo.createPurchaseOrder(
  { location: '', lines: [{ productId: 'p_c', quantity: 1, unitPrice: 10 }] },
  ACTOR
)
ok(storedLocation(blank.id) === 'RM', 'T9 an empty destination still falls back to RM', storedLocation(blank.id))

// ---------------------------------------------------------------------------
console.log('\n=== 3. a dropship never touches stock ===')
// ---------------------------------------------------------------------------

// A product with REAL stock and a real cost basis, so the hazard is measurable:
// a phantom layer at a shop's name would move this average.
const priming = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_d', quantity: 4, unitPrice: 100 }] },
  ACTOR
)
poRepo.receivePurchaseOrderLines(
  priming.id,
  [{ lineId: priming.lines[0].id, quantity: 4 }],
  ACTOR
)
const costBefore = lots.lotWeightedAvgCost(db, 'p_d')
const qtyBefore = inv.getProduct('p_d').quantity
ok(costBefore === 100, 'the shelf holds 4 units at $100', String(costBefore))

const dropPo = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: DROP,
    lines: [{ productId: 'p_d', quantity: 10, unitPrice: 500 }]
  },
  ACTOR
)

// T10.
ok(strayStockRows() === 0, 'T10 no stock row, lot or movement exists anywhere but RM and AM')
ok(inv.getProduct('p_d').quantity === qtyBefore, 'T10 the product holds exactly what it held', String(inv.getProduct('p_d').quantity))
ok(lots.lotWeightedAvgCost(db, 'p_d') === costBefore, 'T10 at exactly the cost it held', String(lots.lotWeightedAvgCost(db, 'p_d')))
ok(allocationCount(dropPo.id) === 0, 'T10 and a whole-order drop needs no allocation row either')

// T11. Receiving a drop line THROWS — it does not return an error, so the
// caller's transaction rolls back and a delivery form naming a drop line
// commits none of its other lines either.
let threw = ''
try {
  poRepo.receivePoLine(db, dropPo.lines[0].id, 5, null, ACTOR)
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
ok(!!threw, 'T11 receivePoLine against a drop allocation throws', threw)
ok(threw.includes('Case Product D'), 'T11 naming the product', threw)
ok(threw.includes(DROP), 'T11 and the destination it is going to instead', threw)
ok(/not received into stock/.test(threw), 'T11 and saying plainly what that means', threw)
// The delivery form refuses it too, by name, rather than appearing to work.
const dropForm = poRepo.receivePurchaseOrderLines(
  dropPo.id,
  [{ lineId: dropPo.lines[0].id, quantity: 5 }],
  ACTOR
)
ok(!!dropForm.error, 'T11 and the delivery form refuses it as well', String(dropForm.error))
ok(strayStockRows() === 0, 'T11 with nothing written anywhere')

// T12. Moving a pure-drop order to Received is how it is closed by hand. It
// stamps the status and books no stock at all.
poRepo.setPurchaseOrderStatus(dropPo.id, 'paid', ACTOR)
const dropReceived = poRepo.setPurchaseOrderStatus(dropPo.id, 'received', ACTOR)
ok(!dropReceived.error, 'T12 a drop order can be marked received', String(dropReceived.error))
ok(dropReceived.po.status === 'received', 'T12 and the stage is stamped', String(dropReceived.po.status))
ok(strayStockRows() === 0, 'T12 with no stock row and no lot anywhere off-shelf')
ok(inv.getProduct('p_d').quantity === qtyBefore, 'T12 and no unit was added to a real shelf either')
ok(dropReceived.po.receivedUnits === 0, 'T12 nothing was received', String(dropReceived.po.receivedUnits))

/**
 * T13. THE PREDICATE ASKS THE TABLE, and this pins that it does.
 *
 * It used to be generated from LOCATION_IDS — a live binding, so in principle
 * the SQL could never drift from the TypeScript. In practice half its callers
 * are module-level template literals evaluated at import, when the registry
 * holds only the two built-ins, so every shelf registered afterwards read as a
 * supplier's address to the header queries while every function knew better.
 *
 * A string check alone could never have caught that: the old string was exactly
 * what the old test demanded. So this pins the SHAPE — the built-ins as
 * literals, plus a lookup against stock_locations — and roadshowStock.test.ts
 * section 8 pins the BEHAVIOUR the shape exists for.
 */
ok(
  poRepo.STOCK_DESTINATION_SQL.includes("destination IN ('RM', 'AM')"),
  'T13 the two built-in shelves are still literals, so a database with no stock_locations rows behaves as it always did',
  poRepo.STOCK_DESTINATION_SQL
)
ok(
  /EXISTS\s*\(\s*SELECT 1 FROM stock_locations/.test(poRepo.STOCK_DESTINATION_SQL),
  'T13 AND EVERY OTHER SHELF IS LOOKED UP, not baked in at import time',
  poRepo.STOCK_DESTINATION_SQL
)
ok(
  LOCATION_IDS.every((id: string) => destinationHoldsStock(id)) && !destinationHoldsStock(DROP),
  'T13 and destinationHoldsStock agrees with it'
)

// T14. THE COST-BASIS HAZARD, PINNED. The whole lifecycle of a drop order over a
// product that has real stock leaves that stock's cost basis untouched.
poRepo.setPurchaseOrderStatus(dropPo.id, 'cancelled', ACTOR)
ok(
  lots.lotWeightedAvgCost(db, 'p_d') === costBefore,
  'T14 create -> paid -> received -> cancelled moves the average not one cent',
  String(lots.lotWeightedAvgCost(db, 'p_d'))
)
ok(inv.stockQty('p_d', 'RM') === 4, 'T14 and the four real units are still on the shelf')

// ---------------------------------------------------------------------------
console.log('\n=== 4. those boxes are not in the building ===')
// ---------------------------------------------------------------------------

const pureDrop = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: DROP, lines: [{ productId: 'p_e', quantity: 10, unitPrice: 40 }] },
  ACTOR
)
// A MIXED order: 20 units, 12 to the RM shelf and 8 straight to the shop.
const mixed = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_f',
        quantity: 20,
        unitPrice: 50,
        allocations: [
          { quantity: 12, supplier: null, destination: 'RM' },
          { quantity: 8, supplier: null, destination: DROP }
        ]
      }
    ]
  },
  ACTOR
)

const boxIds = (): string[] => poRepo.listActivePurchaseOrderBoxes().map((b: { id: string }) => b.id)

// T15.
ok(!boxIds().includes(pureDrop.id), 'T15 a pure-drop order has no box in Incoming — not greyed, absent')

// T16.
const mixedBox = poRepo.listActivePurchaseOrderBoxes().find((b: { id: string }) => b.id === mixed.id)
ok(!!mixedBox, 'T16 a mixed order DOES have one — twelve of it is arriving')
ok(mixedBox.lines[0].quantity === 20, 'T16 the line still says 20 ordered', String(mixedBox.lines[0]?.quantity))
ok(mixedBox.lines[0].qtyReceivable === 12, 'T16 and 12 receivable — never 20', String(mixedBox.lines[0]?.qtyReceivable))
ok(mixedBox.receivableUnits === 12 && mixedBox.dropshipUnits === 8, 'T16 the header splits the same way', `${mixedBox.receivableUnits}/${mixedBox.dropshipUnits}`)
ok(
  receivableProgressOf(mixedBox.lines).ordered === 12,
  'T16 and the progress bar measures against 12',
  String(receivableProgressOf(mixedBox.lines).ordered)
)

// T17. A product ordered only for dropship produces no scan candidate at all,
// so a scan of it resolves as no_order — the honest answer.
ok(
  poRepo.outstandingLinesForProduct('p_e').length === 0,
  'T17 a drop-only product yields zero scan candidates',
  String(poRepo.outstandingLinesForProduct('p_e').length)
)
const mixedCandidates = poRepo.outstandingLinesForProduct('p_f')
ok(mixedCandidates.length === 1, 'T17 while the mixed line offers exactly its stock half', String(mixedCandidates.length))
ok(mixedCandidates[0].qtyOutstanding === 12, 'T17 of 12 units', String(mixedCandidates[0]?.qtyOutstanding))
ok(mixedCandidates[0].location === 'RM', 'T17 bound for RM', String(mixedCandidates[0]?.location))

// T18. One line, two shelves, TWO candidates. The shelf is the operator's
// choice; silently picking one would misplace six boxes.
const twoShelf = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_a',
        quantity: 12,
        unitPrice: 20,
        allocations: [
          { quantity: 6, supplier: null, destination: 'RM' },
          { quantity: 6, supplier: null, destination: 'AM' }
        ]
      }
    ]
  },
  ACTOR
)
const shelves = poRepo
  .outstandingLinesForProduct('p_a')
  .filter((c: { poId: string }) => c.poId === twoShelf.id)
ok(shelves.length === 2, 'T18 a 6/6 split yields two candidates', String(shelves.length))
ok(
  shelves[0].allocationId && shelves[1].allocationId && shelves[0].allocationId !== shelves[1].allocationId,
  'T18 with distinct allocation ids',
  JSON.stringify(shelves.map((s: { allocationId: string }) => s.allocationId))
)
ok(
  [shelves[0].location, shelves[1].location].sort().join(',') === 'AM,RM',
  'T18 and one for each shelf',
  JSON.stringify(shelves.map((s: { location: string }) => s.location))
)
ok(
  shelves.every((s: { lineId: string }) => s.lineId === twoShelf.lines[0].id),
  'T18 both against the same line'
)

// T19. The owner's dashboard counts what is coming HERE.
const board = owner.getOwnerBoard({
  finance: false,
  invoicing: true,
  inventory: true,
  streaming: false,
  fulfillment: false,
  hours: false
})
const mixedIncoming = board.incoming.items.find((i: { id: string }) => i.id === mixed.id)
ok(!!mixedIncoming, 'T19 the mixed order is on the incoming list')
ok(mixedIncoming.units === 12, 'T19 counting 12 units, not 20', String(mixedIncoming?.units))
ok(
  !board.incoming.items.some((i: { id: string }) => i.id === pureDrop.id),
  'T19 and the pure-drop order is not on it at all'
)

// T20. A zero-line PO has no receivable units AND no drop units, so the filter
// is phrased as "pure dropship" rather than "has receivable units" — and it
// keeps rendering exactly as it does today.
const empty = poRepo.createPurchaseOrder({ location: 'RM', lines: [] }, ACTOR)
ok(boxIds().includes(empty.id), 'T20 a zero-line order still appears in Incoming')
ok(poRepo.getPurchaseOrder(empty.id).orderKind === 'stock', 'T20 reading as a stock order from its header')

// ---------------------------------------------------------------------------
console.log('\n=== 5. the badge, the number, and the one counter ===')
// ---------------------------------------------------------------------------

// T21.
const pureDropDetail = poRepo.getPurchaseOrder(pureDrop.id)
ok(pureDropDetail.orderKind === 'drop', 'T21 an all-drop order is kind drop', String(pureDropDetail.orderKind))
ok(
  displayOrderNumber(pureDropDetail.poNumber, pureDropDetail.orderKind) ===
    pureDropDetail.poNumber.replace('PO-', 'Drop-'),
  'T21 and displays as Drop-nnnn',
  displayOrderNumber(pureDropDetail.poNumber, pureDropDetail.orderKind)
)

// T22. Mixed keeps PO, because the prefix answers one question — are boxes
// coming to this building? — and on a mixed order they are.
const mixedDetail = poRepo.getPurchaseOrder(mixed.id)
ok(mixedDetail.orderKind === 'mixed', 'T22 a mixed order is kind mixed', String(mixedDetail.orderKind))
ok(
  displayOrderNumber(mixedDetail.poNumber, mixedDetail.orderKind) === mixedDetail.poNumber,
  'T22 and keeps its PO number — a glow, not a rename',
  displayOrderNumber(mixedDetail.poNumber, mixedDetail.orderKind)
)
ok(mixedDetail.destinationCount === 2, 'T22 across two destinations', String(mixedDetail.destinationCount))

// T23. One counter, no gaps, no branches.
const seqA = poRepo.createPurchaseOrder(
  { location: 'RM', lines: [{ productId: 'p_a', quantity: 1, unitPrice: 1 }] },
  ACTOR
)
const seqB = poRepo.createPurchaseOrder(
  { location: DROP, lines: [{ productId: 'p_a', quantity: 1, unitPrice: 1 }] },
  ACTOR
)
const seqC = poRepo.createPurchaseOrder(
  { location: 'AM', lines: [{ productId: 'p_a', quantity: 1, unitPrice: 1 }] },
  ACTOR
)
const nums = [seqA, seqB, seqC].map((p: { poNumber: string }) => Number(p.poNumber.slice(3)))
ok(nums[1] === nums[0] + 1 && nums[2] === nums[1] + 1, 'T23 a PO, a Drop and a PO take consecutive numbers', JSON.stringify(nums))
ok(poRepo.getPurchaseOrder(seqB.id).orderKind === 'drop', 'T23 and the middle one really is a drop')

// T24.
const stored = db.prepare("SELECT COUNT(*) AS n FROM purchase_orders WHERE po_number LIKE 'Drop%'").get() as {
  n: number
}
ok(stored.n === 0, 'T24 no Drop- string is ever written to po_number', String(stored.n))

// ---------------------------------------------------------------------------
console.log('\n=== 6. splits, and the invariants that hold them together ===')
// ---------------------------------------------------------------------------

const poCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get() as { n: number }).n

// T25. I1 — the splits must add up to the line.
const before25 = poCount()
let refused25 = ''
try {
  poRepo.createPurchaseOrder(
    {
      location: 'RM',
      lines: [
        {
          productId: 'p_b',
          quantity: 20,
          unitPrice: 10,
          allocations: [
            { quantity: 12, supplier: null, destination: 'RM' },
            { quantity: 7, supplier: null, destination: DROP }
          ]
        }
      ]
    },
    ACTOR
  )
} catch (err) {
  refused25 = err instanceof Error ? err.message : String(err)
}
ok(!!refused25, 'T25 splits that add up to 19 of 20 are refused', refused25)
ok(/19/.test(refused25) && /20/.test(refused25), 'T25 naming both numbers', refused25)
ok(/Case Product B/.test(refused25), 'T25 and the product', refused25)
ok(poCount() === before25, 'T25 and nothing at all is written', `${before25} -> ${poCount()}`)

// T26. I5 — a zero-quantity split is deleted, never stored.
let refused26 = ''
try {
  poRepo.createPurchaseOrder(
    {
      location: 'RM',
      lines: [
        {
          productId: 'p_b',
          quantity: 5,
          unitPrice: 10,
          allocations: [
            { quantity: 5, supplier: null, destination: 'RM' },
            { quantity: 0, supplier: null, destination: DROP }
          ]
        }
      ]
    },
    ACTOR
  )
} catch (err) {
  refused26 = err instanceof Error ? err.message : String(err)
}
ok(!!refused26, 'T26 a zero-quantity split is refused', refused26)
ok(/at least 1/.test(refused26), 'T26 and says what a split needs', refused26)

// T27. I2 — the allocation's counter and the line's move together.
const mixedLine = poRepo.getPurchaseOrder(mixed.id).lines[0]
const rmAllocation = mixedLine.allocations.find((a: { destination: string }) => a.destination === 'RM')
const dropAllocation = mixedLine.allocations.find((a: { destination: string }) => a.destination === DROP)
ok(!!rmAllocation && !!dropAllocation, 'T27 the mixed line reports both of its allocations')
ok(rmAllocation.holdsStock === true && dropAllocation.holdsStock === false, 'T27 and only one of them holds stock')

const partial = scan.commitScan(
  {
    kind: 'po_line',
    rawCode: 'manual-mixed',
    mode: 'manual',
    lineId: mixedLine.id,
    allocationId: rmAllocation.id,
    quantity: 5,
    clientToken: 'tok-mixed-5'
  },
  ACTOR
)
ok(!partial.error, 'T27 five units of the RM half are scanned in', String(partial.error))
const afterFive = poRepo.getPurchaseOrder(mixed.id)
ok(afterFive.lines[0].qtyReceived === 5, 'T27 the LINE records 5', String(afterFive.lines[0].qtyReceived))
ok(
  afterFive.lines[0].allocations.find((a: { id: string }) => a.id === rmAllocation.id).qtyReceived === 5,
  'T27 and so does the allocation'
)
ok(
  afterFive.lines[0].allocations.find((a: { id: string }) => a.id === dropAllocation.id).qtyReceived === 0,
  'T27 while the drop allocation stays at zero, permanently (I4)'
)
ok(inv.stockQty('p_f', 'RM') === 5, 'T27 with five real units on the RM shelf', String(inv.stockQty('p_f', 'RM')))
ok(strayStockRows() === 0, 'T27 and nothing written off-shelf')
ok(
  (db.prepare('SELECT location FROM po_line_receipts WHERE po_line_id = ?').get(mixedLine.id) as {
    location: string
  }).location === 'RM',
  'T27 the receipt names the shelf it landed on'
)

// T28. Undo puts BOTH counters back, or I2 breaks the moment anything is undone.
const undone = scan.undoScan(partial.result.scanId, ACTOR)
ok(!undone.error, 'T28 the scan is undone', String(undone.error))
const afterUndo = poRepo.getPurchaseOrder(mixed.id)
ok(afterUndo.lines[0].qtyReceived === 0, 'T28 the line is back to 0', String(afterUndo.lines[0].qtyReceived))
ok(
  afterUndo.lines[0].allocations.every((a: { qtyReceived: number }) => a.qtyReceived === 0),
  'T28 and so is every allocation',
  JSON.stringify(afterUndo.lines[0].allocations.map((a: { qtyReceived: number }) => a.qtyReceived))
)
ok(inv.stockQty('p_f', 'RM') === 0, 'T28 with the stock handed back', String(inv.stockQty('p_f', 'RM')))

// T29. Re-routing units that already landed would mean moving stock, which is
// Inventory's job.
const routable = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_c', quantity: 12, unitPrice: 30 }] },
  ACTOR
)
const routeOk = poRepo.setPurchaseOrderRouting(routable.id, {
  splits: [
    {
      lineId: routable.lines[0].id,
      allocations: [
        { quantity: 4, supplier: null, destination: 'AM' },
        { quantity: 8, supplier: 'Bramble Wholesale', destination: DROP }
      ]
    }
  ]
})
ok(!routeOk.error, 'T29 an untouched line can be re-routed', String(routeOk.error))
ok(routeOk.po.orderKind === 'mixed', 'T29 and the order becomes mixed', String(routeOk.po.orderKind))
ok(routeOk.po.receivableUnits === 4, 'T29 with 4 units still coming here', String(routeOk.po.receivableUnits))
ok(
  routeOk.po.lines[0].allocations.find((a: { destination: string }) => a.destination === DROP).supplier ===
    'Bramble Wholesale',
  'T29 carrying its own supplier'
)
// Undo the split entirely: an empty array means "not split", and the rows go.
const unsplit = poRepo.setPurchaseOrderRouting(routable.id, {
  splits: [{ lineId: routable.lines[0].id, allocations: [] }]
})
ok(!unsplit.error && allocationCount(routable.id) === 0, 'T29 and an empty split deletes the rows rather than storing one')
ok(unsplit.po.lines[0].qtyReceivable === 12, 'T29 leaving the line whole again', String(unsplit.po.lines[0].qtyReceivable))

poRepo.receivePurchaseOrderLines(routable.id, [{ lineId: routable.lines[0].id, quantity: 12 }], ACTOR)
const refusedRoute = poRepo.setPurchaseOrderRouting(routable.id, {
  lines: [{ lineId: routable.lines[0].id, destination: DROP }]
})
ok(!!refusedRoute.error, 'T29 a received line cannot be re-routed', String(refusedRoute.error))
ok(/12 unit/.test(refusedRoute.error ?? ''), 'T29 the refusal counts them', String(refusedRoute.error))
ok(/Case Product C/.test(refusedRoute.error ?? ''), 'T29 names the product', String(refusedRoute.error))
ok(/adjusting stock in Inventory/.test(refusedRoute.error ?? ''), 'T29 and says where the operation really lives', String(refusedRoute.error))
ok(
  storedLocation(routable.id) === 'RM' &&
    (db.prepare('SELECT destination FROM purchase_order_lines WHERE id = ?').get(routable.lines[0].id) as {
      destination: string | null
    }).destination === null,
  'T29 and the routing is unchanged'
)

// T30. A mixed order completes when everything DUE HERE is here.
const mixedFinish = poRepo.receivePurchaseOrderLines(
  mixed.id,
  [{ lineId: mixedLine.id, quantity: 12 }],
  ACTOR
)
ok(!mixedFinish.error, 'T30 the twelve receivable units go in', String(mixedFinish.error))
ok(mixedFinish.po.status === 'received', 'T30 and the mixed order completes', String(mixedFinish.po.status))
ok(!!mixedFinish.po.scannedAt, 'T30 stamped scanned-in, so its box leaves Incoming')
ok(mixedFinish.po.receivedUnits === 12, 'T30 with 12 received against 20 ordered', String(mixedFinish.po.receivedUnits))
ok(mixedFinish.po.dropshipUnits === 8, 'T30 and 8 still drop-shipped', String(mixedFinish.po.dropshipUnits))
ok(inv.stockQty('p_f', 'RM') === 12, 'T30 twelve real units on the shelf', String(inv.stockQty('p_f', 'RM')))
ok(strayStockRows() === 0, 'T30 and not one unit anywhere else')
// A pure-drop order can NEVER auto-complete: there is no receivable line to
// finish, so it is closed by hand or not at all.
const stillOpen = poRepo.getPurchaseOrder(pureDrop.id)
ok(stillOpen.status === 'ordered', 'T30 a pure-drop order never auto-completes', String(stillOpen.status))
ok(!stillOpen.scannedAt, 'T30 and is never stamped scanned-in by itself')

// ---------------------------------------------------------------------------
console.log('\n=== 7. money, and unwinding against the right shelf ===')
// ---------------------------------------------------------------------------

// T31. The COGS entry is the WHOLE order, drop lines included — the money left
// the business whoever the boxes were addressed to.
const dropTotal = poRepo.getPurchaseOrder(pureDrop.id).total
ok(dropTotal === 400, 'T31 a 10 × $40 drop order totals $400', String(dropTotal))
ok(cogsFor(pureDrop.id) === dropTotal, 'T31 and its COGS row is that same total', String(cogsFor(pureDrop.id)))

// T32.
const cancelled = poRepo.setPurchaseOrderStatus(pureDrop.id, 'cancelled', ACTOR)
ok(!cancelled.error, 'T32 a drop order cancels cleanly', String(cancelled.error))
ok(cogsFor(pureDrop.id) === null, 'T32 the money comes back out of COGS')
ok(strayStockRows() === 0, 'T32 and no stock was touched, because none ever was')

// T33. THE HEADER SAYS RM AND THE UNITS WENT TO AM. Reversing against the header
// would take five units off a shelf they were never on and leave five on the one
// they are.
const crossShelf = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_e',
        quantity: 10,
        unitPrice: 60,
        allocations: [
          { quantity: 5, supplier: null, destination: 'AM' },
          { quantity: 5, supplier: null, destination: DROP }
        ]
      }
    ]
  },
  ACTOR
)
poRepo.setPurchaseOrderStatus(crossShelf.id, 'paid', ACTOR)
const crossReceived = poRepo.setPurchaseOrderStatus(crossShelf.id, 'received', ACTOR)
ok(!crossReceived.error, 'T33 moving it to Received books only the stock half', String(crossReceived.error))
ok(inv.stockQty('p_e', 'AM') === 5, 'T33 five units land on AM', String(inv.stockQty('p_e', 'AM')))
ok(inv.stockQty('p_e', 'RM') === 0, 'T33 and none on RM, whatever the header says', String(inv.stockQty('p_e', 'RM')))
ok(strayStockRows() === 0, 'T33 with nothing at the drop destination')

const crossCancel = poRepo.setPurchaseOrderStatus(crossShelf.id, 'cancelled', ACTOR)
ok(!crossCancel.error, 'T33 cancelling it is accepted', String(crossCancel.error))
ok(inv.stockQty('p_e', 'AM') === 0, 'T33 and the five units come back off AM — the receipt named the shelf', String(inv.stockQty('p_e', 'AM')))
ok(inv.stockQty('p_e', 'RM') === 0, 'T33 with RM never touched in either direction', String(inv.stockQty('p_e', 'RM')))
ok(cogsFor(crossShelf.id) === null, 'T33 and the money is out of COGS')

// T34. The same shape again, force-deleted rather than cancelled.
const forced = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_e',
        quantity: 10,
        unitPrice: 60,
        allocations: [
          { quantity: 5, supplier: null, destination: 'AM' },
          { quantity: 5, supplier: null, destination: DROP }
        ]
      }
    ]
  },
  ACTOR
)
poRepo.setPurchaseOrderStatus(forced.id, 'paid', ACTOR)
poRepo.setPurchaseOrderStatus(forced.id, 'received', ACTOR)
ok(inv.stockQty('p_e', 'AM') === 5, 'T34 five units on AM again', String(inv.stockQty('p_e', 'AM')))
const forceRes = poRepo.forceDeletePurchaseOrder(forced.id, true, ACTOR)
ok(forceRes.ok, 'T34 force delete succeeds', String(forceRes.error))
ok(forceRes.removedUnits === 5, 'T34 reporting five units removed', String(forceRes.removedUnits))
ok(forceRes.soldUnits === 0, 'T34 and none unaccounted for', String(forceRes.soldUnits))
ok(inv.stockQty('p_e', 'AM') === 0, 'T34 taken off AM, not off the header shelf', String(inv.stockQty('p_e', 'AM')))
ok(inv.stockQty('p_e', 'RM') === 0, 'T34 RM untouched', String(inv.stockQty('p_e', 'RM')))

// T35. Delete is always available on a drop order, because nothing ever landed.
const deletable = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: DROP, lines: [{ productId: 'p_e', quantity: 3, unitPrice: 20 }] },
  ACTOR
)
ok(poRepo.getPurchaseOrder(deletable.id).receivedUnits === 0, 'T35 a drop order has nothing received')
const deleted = poRepo.deletePurchaseOrder(deletable.id, ACTOR)
ok(deleted.ok, 'T35 so deleting it is allowed', String(deleted.error))
ok(poRepo.getPurchaseOrder(deletable.id) === null, 'T35 and it is gone')

// ---------------------------------------------------------------------------
console.log('\n=== 8. who units can be sent to ===')
// ---------------------------------------------------------------------------

const mkContact = (id: string, name: string, isVendor: number, isCustomer: number, city: string): void => {
  db.prepare(
    `INSERT INTO invoice_customers (id, name, email, bill_city, bill_region, is_vendor, is_customer,
                                    active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PA', ?, ?, 1, '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
  ).run(id, name, `${id}@example.test`, city, isVendor, isCustomer)
}
mkContact('c_1', 'Bramble Wholesale', 1, 0, 'Ashfield')
mkContact('c_2', 'Kyla Benton', 0, 1, 'Millvale')
mkContact('c_3', 'Copperpot Cards', 1, 1, 'Kiln Row')

// T36. RM and AM first, always, and never removable.
const parties = poRepo.listOrderParties()
ok(parties[0].name === 'RM' && parties[1].name === 'AM', 'T36 RM and AM lead the list', JSON.stringify(parties.slice(0, 2).map((p: { name: string }) => p.name)))
ok(parties[0].holdsStock === true && parties[1].holdsStock === true, 'T36 and both hold stock')
/**
 * THE HOME SHELVES ARE NO LONGER THE ONLY SHELVES, and this used to say they
 * were.
 *
 * It was true when it was written and it stopped being true when the four
 * roadshow shops became a seeded list — see ROADSHOW_SHOPS. A shop IS a place
 * stock sits, that is the entire point of the feature, and a party list that
 * called Kentucky a dropship destination would put the app back where it was
 * when a week's buying produced a bill and no inventory.
 *
 * What the rule actually is, and what is pinned now: holding stock follows
 * REGISTRATION, not the two built-in names. Everything a person or a business
 * — a supplier, a buyer, a name off a document — still holds nothing.
 */
const shops = parties.filter((p: { name: string }) => /Roadshow/i.test(p.name))
ok(shops.length === 4, 'T36 the four roadshow shops are in the list', String(shops.length))
ok(
  shops.every((p: { holdsStock: boolean; kind: string }) => p.holdsStock && p.kind === 'location'),
  'T36 AND THEY HOLD STOCK, like the shelves they are — not like the suppliers they used to read as'
)
ok(
  parties
    .filter((p: { kind: string }) => p.kind !== 'location')
    .every((p: { holdsStock: boolean }) => p.holdsStock === false),
  'T36 while nothing that is a PERSON or a BUSINESS holds stock — the rule is registration, not the name'
)
ok(parties[0].pinnable === false && parties[1].pinnable === false, 'T36 and neither built-in can be unpinned')
ok(parties[0].kind === 'location', 'T36 they are locations, not parties', String(parties[0].kind))

// T37.
const pinnedList = poRepo.setPartyPinned('Bramble Wholesale', true)
/**
 * PINNED MEANS ABOVE THE UNPINNED, not at a fixed index. The index moved when
 * the four shops were seeded, and an assertion keyed on the number 2 was
 * measuring how many places happened to exist rather than what pinning does.
 */
const pinnedAt = pinnedList.findIndex((p: { name: string }) => p.name === 'Bramble Wholesale')
const firstUnpinned = pinnedList.findIndex((p: { pinned: boolean }) => !p.pinned)
ok(
  pinnedAt > -1 && pinnedAt < firstUnpinned,
  'T37 a pinned party sits above every unpinned one',
  `${pinnedAt} of ${pinnedList.length}, first unpinned at ${firstUnpinned}`
)
ok(pinnedList[pinnedAt].pinned === true, 'T37 marked as pinned')
ok(pinnedList[pinnedAt].pinnable === true, 'T37 and this one CAN be unpinned')
const unpinned = poRepo.setPartyPinned('Bramble Wholesale', false)
ok(
  unpinned.findIndex((p: { name: string }) => p.name === 'Bramble Wholesale') > 1,
  'T37 unpinning drops it back into the body of the list'
)
poRepo.setPartyPinned('Bramble Wholesale', true)

// T38. A business that both buys and sells is ONE row — the v62 decision.
const both = poRepo
  .listOrderParties()
  .filter((p: { name: string }) => /Copperpot/i.test(p.name))
ok(both.length === 1, 'T38 a vendor who is also a customer appears exactly once', String(both.length))
ok(both[0].kind === 'both', 'T38 marked as both', String(both[0]?.kind))
ok(!!both[0].detail && /Kiln Row/.test(both[0].detail), 'T38 carrying its contact detail', String(both[0]?.detail))
// A customer who was never a vendor is still offered — a dropship destination is
// very often somebody this business SELLS to, which is the whole point.
ok(
  poRepo.listOrderParties().some((p: { name: string; kind: string }) => p.name === 'Kyla Benton' && p.kind === 'customer'),
  'T38 and a plain customer is offered as a destination'
)
// A name known only from a document is offered too.
ok(
  poRepo.listOrderParties().some((p: { name: string }) => p.name === DROP),
  'T38 as is a shop known only from an order'
)

// T39.
let refused39 = ''
try {
  poRepo.setPartyPinned('RM', false)
} catch (err) {
  refused39 = err instanceof Error ? err.message : String(err)
}
ok(!!refused39, 'T39 RM cannot be unpinned', refused39)
ok(/stock location/.test(refused39), 'T39 and the refusal says why', refused39)

// T40. The pin id is DERIVED, so two laptops pinning the same shop write one row.
poRepo.setPartyPinned('BRAMBLE WHOLESALE', true)
const pinRows = db.prepare('SELECT id, name FROM order_party_pins').all() as Array<{
  id: string
  name: string
}>
ok(pinRows.length === 1, 'T40 two spellings of one shop produce ONE pin row', JSON.stringify(pinRows))
ok(pinRows[0].id === 'pin:bramble wholesale', 'T40 keyed on the lower-cased name', pinRows[0]?.id)

// ---------------------------------------------------------------------------
console.log('\n=== 9. the guards that outlive this suite ===')
// ---------------------------------------------------------------------------

// T41. tests/mobileLayout.test.ts asserts no class in mobile.css appears in the
// desktop sheets. The three dropship classes are DESKTOP-only, so naming any of
// them in mobile.css would fail that suite — checked here as well, because the
// failure it produces there names a rule rather than this feature.
const mobileCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/mobile.css'), 'utf8')
ok(
  !/po-card-drop|po-card-mixed|po-receipt-drop/.test(mobileCss),
  'T41 the dropship classes are absent from the phone stylesheet'
)

// T42 is `npm run test:vendors`, unedited: line-level suppliers add NAMES to the
// vendor list and change no existing figure. Pinned here from the other side —
// an order whose line names its own supplier must not move the header supplier's
// money.
const vendorBefore = poRepo.listVendors().find((v: { name: string }) => /Steel City/i.test(v.name))
const lineSupplied = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [{ productId: 'p_a', quantity: 2, unitPrice: 25, supplier: 'Marlow Distribution' }]
  },
  ACTOR
)
const vendorAfter = poRepo.listVendors().find((v: { name: string }) => /Steel City/i.test(v.name))
ok(
  vendorAfter.ordered === vendorBefore.ordered + poRepo.getPurchaseOrder(lineSupplied.id).total,
  'T42 the header supplier still carries the whole order total',
  `${vendorBefore.ordered} -> ${vendorAfter.ordered}`
)
const marlow = poRepo.listVendors().find((v: { name: string }) => /Marlow/i.test(v.name))
ok(!!marlow, 'T42 a line-level supplier appears on the vendor list')
ok(marlow.orders === 0 && marlow.ordered === 0, 'T42 with no money attributed to it — names and dates only', JSON.stringify(marlow))
ok(!!marlow.lastAt, 'T42 but a date, so it sorts among the active ones', String(marlow.lastAt))

// ---------------------------------------------------------------------------
console.log('\n=== 10. the delivery form against a line split across two shelves ===')
// ---------------------------------------------------------------------------

// Products of their own, so an assertion about one section's shelves can never
// be answered by another section's stock.
;['g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w'].forEach(
  (k, i) => mkProduct(`p_${k}`, `Case Product ${k.toUpperCase()}`, `DRP-1${String(i + 1).padStart(2, '0')}`)
)

/**
 * T44. A LINE SPLIT ACROSS RM AND AM RECEIVES FROM THE ONE BOX THE FORM DRAWS.
 *
 * The form asks one question per line — "how many arrived?" — and validates the
 * answer against the line's whole RECEIVABLE figure, which for a 6/6 split is
 * 12. `receivePoLine` books against ONE allocation and refuses anything larger
 * than that allocation's own outstanding, which is 6. So the honest answer to
 * the question on the screen was refused with "only 6 of 6", two numbers that
 * appear nowhere on it — and every delivery of a two-shelf line was unbookable.
 *
 * The quantity is now spread across the line's stock allocations in position
 * order, the same guess "Scanned in" and the scan queue already make. If that
 * spreading is ever lost, this section fails at the first assertion; if it is
 * ever applied to an unsplit line, T5 and tests/receiving.test.ts fail instead.
 */
const splitFull = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_g',
        quantity: 12,
        unitPrice: 10,
        allocations: [
          { quantity: 6, supplier: null, destination: 'RM' },
          { quantity: 6, supplier: null, destination: 'AM' }
        ]
      }
    ]
  },
  ACTOR
)
const splitFullReceipt = poRepo.receivePurchaseOrderLines(
  splitFull.id,
  [{ lineId: splitFull.lines[0].id, quantity: 12 }],
  ACTOR
)
ok(!splitFullReceipt.error, 'T44 all twelve of a 6/6 line are accepted in one answer', String(splitFullReceipt.error))
const splitFullAfter = poRepo.getPurchaseOrder(splitFull.id)
ok(splitFullAfter.lines[0].qtyReceived === 12, 'T44 and all twelve are booked', String(splitFullAfter.lines[0].qtyReceived))
ok(
  inv.stockQty('p_g', 'RM') === 6 && inv.stockQty('p_g', 'AM') === 6,
  'T44 six on each shelf — never twelve on the first one',
  `RM=${inv.stockQty('p_g', 'RM')} AM=${inv.stockQty('p_g', 'AM')}`
)
ok(
  splitFullAfter.lines[0].allocations.every((a: { qtyOutstanding: number }) => a.qtyOutstanding === 0),
  'T44 with both allocations counted out (I2)',
  JSON.stringify(splitFullAfter.lines[0].allocations.map((a: { qtyReceived: number }) => a.qtyReceived))
)
ok(splitFullAfter.status === 'received', 'T44 and the order completes itself', String(splitFullAfter.status))

// A PART delivery fills in position order and stops. Asserted because the
// spreading is a GUESS about which shelf got what, and the guess is only
// defensible if it is the same one everywhere: first shelf first, no averaging.
const splitPart = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_h',
        quantity: 12,
        unitPrice: 10,
        allocations: [
          { quantity: 6, supplier: null, destination: 'RM' },
          { quantity: 6, supplier: null, destination: 'AM' }
        ]
      }
    ]
  },
  ACTOR
)
const partReceipt = poRepo.receivePurchaseOrderLines(
  splitPart.id,
  [{ lineId: splitPart.lines[0].id, quantity: 8 }],
  ACTOR
)
ok(!partReceipt.error, 'T44 eight of the twelve are accepted too', String(partReceipt.error))
ok(poRepo.getPurchaseOrder(splitPart.id).lines[0].qtyReceived === 8, 'T44 booking eight')
ok(
  inv.stockQty('p_h', 'RM') === 6 && inv.stockQty('p_h', 'AM') === 2,
  'T44 filling the first shelf before the second, and stopping',
  `RM=${inv.stockQty('p_h', 'RM')} AM=${inv.stockQty('p_h', 'AM')}`
)
ok(poRepo.getPurchaseOrder(splitPart.id).status === 'ordered', 'T44 and a part delivery does NOT close the order')

// THE GUARD THAT STOPS THE FIX BEING A HOLE. Spreading must not turn an
// over-receipt into something that quietly fits: 13 against 12 is still refused,
// still names both numbers, and still books nothing at all.
const splitOver = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_i',
        quantity: 12,
        unitPrice: 10,
        allocations: [
          { quantity: 6, supplier: null, destination: 'RM' },
          { quantity: 6, supplier: null, destination: 'AM' }
        ]
      },
      { productId: 'p_j', quantity: 5, unitPrice: 10 }
    ]
  },
  ACTOR
)
const overLine = splitOver.lines.find((l: { productId: string }) => l.productId === 'p_i')
const plainLine = splitOver.lines.find((l: { productId: string }) => l.productId === 'p_j')
const overRes = poRepo.receivePurchaseOrderLines(
  splitOver.id,
  [{ lineId: plainLine.id, quantity: 5 }, { lineId: overLine.id, quantity: 13 }],
  ACTOR
)
ok(!!overRes.error, 'T44 GUARD thirteen of twelve is still refused', String(overRes.error))
ok(/12/.test(overRes.error ?? '') && /13/.test(overRes.error ?? ''), 'T44 GUARD naming both numbers', String(overRes.error))
ok(
  poRepo.getPurchaseOrder(splitOver.id).lines.every((l: { qtyReceived: number }) => l.qtyReceived === 0),
  'T44 GUARD and the WHOLE form rolls back — the good line books nothing either'
)
ok(
  inv.stockQty('p_i', 'RM') === 0 && inv.stockQty('p_i', 'AM') === 0 && inv.stockQty('p_j', 'RM') === 0,
  'T44 GUARD with no stock moved by the refused delivery'
)

// The same atomicity, proven from INSIDE the write loop rather than from the
// form's validation: three answers of 6 against a 12-unit line each pass
// validation on their own, the first two book, and the third finds nothing
// outstanding and throws. Everything the transaction had already written goes.
const overSpill = poRepo.receivePurchaseOrderLines(
  splitOver.id,
  [
    { lineId: overLine.id, quantity: 6 },
    { lineId: overLine.id, quantity: 6 },
    { lineId: overLine.id, quantity: 6 }
  ],
  ACTOR
)
ok(!!overSpill.error, 'T44 GUARD an over-receipt spread across three answers is refused', String(overSpill.error))
ok(
  poRepo.getPurchaseOrder(splitOver.id).lines.every((l: { qtyReceived: number }) => l.qtyReceived === 0),
  'T44 GUARD and the two answers that had already booked are rolled back'
)
ok(
  inv.stockQty('p_i', 'RM') === 0 && inv.stockQty('p_i', 'AM') === 0,
  'T44 GUARD with both shelves left exactly as they were',
  `RM=${inv.stockQty('p_i', 'RM')} AM=${inv.stockQty('p_i', 'AM')}`
)
ok(strayStockRows() === 0, 'T44 and nothing anywhere off-shelf')

// ---------------------------------------------------------------------------
console.log('\n=== 11. deleting a Drop order that was closed the documented way ===')
// ---------------------------------------------------------------------------

/**
 * T45. A PURE-DROP ORDER THAT WAS MOVED TO RECEIVED CAN STILL BE DELETED.
 *
 * A Drop order can never auto-complete — there is no receivable line to finish —
 * so moving it to Received by hand is the documented and only way to close one.
 * Refusing Delete on the status alone therefore made closing a Drop order the
 * same act as losing its Delete button, while the receipt's own tooltip promised
 * the opposite. The refusal exists to protect stock that carries a cost record;
 * on an order where no unit was ever checked in there is nothing to protect.
 */
const closedDrop = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: DROP, lines: [{ productId: 'p_k', quantity: 10, unitPrice: 10 }] },
  ACTOR
)
poRepo.setPurchaseOrderStatus(closedDrop.id, 'paid', ACTOR)
const closedDropReceived = poRepo.setPurchaseOrderStatus(closedDrop.id, 'received', ACTOR)
ok(!closedDropReceived.error, 'T45 a Drop order is closed by moving it to Received', String(closedDropReceived.error))
const closedDropDelete = poRepo.deletePurchaseOrder(closedDrop.id, ACTOR)
ok(closedDropDelete.ok, 'T45 and it can still be deleted afterwards', String(closedDropDelete.error))
ok(poRepo.getPurchaseOrder(closedDrop.id) === null, 'T45 the order is gone')
ok(cogsFor(closedDrop.id) === null, 'T45 and its COGS row went with it')

// THE GUARD. An order that really did take stock in is still refused, in the
// same words — the fix keys on units received, never on the order looking like a
// dropship, so an order that COULD have received stock and simply has not is
// still an order whose status is the thing being trusted.
const realReceived = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_l', quantity: 4, unitPrice: 10 }] },
  ACTOR
)
poRepo.setPurchaseOrderStatus(realReceived.id, 'paid', ACTOR)
poRepo.setPurchaseOrderStatus(realReceived.id, 'received', ACTOR)
const realDelete = poRepo.deletePurchaseOrder(realReceived.id, ACTOR)
ok(!realDelete.ok, 'T45 GUARD a genuinely received order still refuses Delete')
ok(
  /Cancel it instead/.test(realDelete.error ?? ''),
  'T45 GUARD with the same wording it always used',
  String(realDelete.error)
)
ok(!!poRepo.getPurchaseOrder(realReceived.id), 'T45 GUARD and the order is still there')
ok(inv.stockQty('p_l', 'RM') === 4, 'T45 GUARD with its stock untouched', String(inv.stockQty('p_l', 'RM')))

// ---------------------------------------------------------------------------
console.log('\n=== 12. re-routing an order that has already been closed ===')
// ---------------------------------------------------------------------------

/**
 * T46. A CLOSED ORDER'S ROUTING IS FROZEN, INCLUDING ITS DROP LINES.
 *
 * The per-line refusal keys on qty_received, and a drop line's counter is 0 for
 * ever by construction (I4) — so it waves through exactly the line that must not
 * move. A mixed order auto-completes when its RECEIVABLE units are in; re-route
 * one of its drop lines to RM afterwards and those units are stranded
 * permanently: the box is gone from Incoming and there are no scan candidates
 * (both filter on scanned_at IS NULL), scanInPurchaseOrder refuses with "already
 * been scanned in", and a received order transitions only to cancelled, so there
 * is no way to reopen it either. The document would say units are coming and
 * nothing in the app could ever check them in.
 */
const closedMixed = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      { productId: 'p_m', quantity: 5, unitPrice: 10 },
      { productId: 'p_n', quantity: 4, unitPrice: 10, destination: DROP }
    ]
  },
  ACTOR
)
const closedMixedStock = closedMixed.lines.find((l: { productId: string }) => l.productId === 'p_m')
const closedMixedDrop = closedMixed.lines.find((l: { productId: string }) => l.productId === 'p_n')
const closedMixedReceipt = poRepo.receivePurchaseOrderLines(
  closedMixed.id,
  [{ lineId: closedMixedStock.id, quantity: 5 }],
  ACTOR
)
ok(!closedMixedReceipt.error, 'T46 the five receivable units go in', String(closedMixedReceipt.error))
ok(closedMixedReceipt.po.status === 'received', 'T46 and the mixed order auto-completes', String(closedMixedReceipt.po.status))
ok(!!closedMixedReceipt.po.scannedAt, 'T46 stamped scanned-in, so its box has left Incoming')
// The trap, demonstrated before the guard is asserted: nothing could receive
// those four units if they were re-routed here.
ok(
  poRepo.outstandingLinesForProduct('p_n').length === 0,
  'T46 a closed order offers no scan candidate at all',
  String(poRepo.outstandingLinesForProduct('p_n').length)
)
ok(
  /already been scanned in/.test(String(poRepo.scanInPurchaseOrder(closedMixed.id, ACTOR).error)),
  'T46 and Scanned in refuses it outright',
  String(poRepo.scanInPurchaseOrder(closedMixed.id, ACTOR).error)
)
const closedRoute = poRepo.setPurchaseOrderRouting(closedMixed.id, {
  lines: [{ lineId: closedMixedDrop.id, destination: 'RM' }]
})
ok(!!closedRoute.error, 'T46 so re-routing its untouched drop line is refused', String(closedRoute.error))
ok(/PO-/.test(closedRoute.error ?? ''), 'T46 by name', String(closedRoute.error))
ok(/received and closed/.test(closedRoute.error ?? ''), 'T46 saying what is wrong with it', String(closedRoute.error))
ok(
  (db.prepare('SELECT destination FROM purchase_order_lines WHERE id = ?').get(closedMixedDrop.id) as {
    destination: string | null
  }).destination === DROP,
  'T46 and the line still goes where it went'
)
ok(
  poRepo.getPurchaseOrder(closedMixed.id).receivableUnits === 5,
  'T46 with no unit invented on a shelf nothing could deliver to',
  String(poRepo.getPurchaseOrder(closedMixed.id).receivableUnits)
)
ok(inv.stockQty('p_n', 'RM') === 0, 'T46 and no stock written by the refusal')

/**
 * T47. RE-ROUTING CAN BE THE ACT THAT FINISHES AN ORDER.
 *
 * The mirror of T46. Send the last line with units still due here off to a shop
 * and everything receivable is already in — but nothing runs the completion test
 * on a routing change, so the order stays open for ever showing a Receive panel
 * with nothing in it, and no button anywhere can close it.
 */
const finishByRoute = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      { productId: 'p_o', quantity: 3, unitPrice: 10 },
      { productId: 'p_p', quantity: 5, unitPrice: 10 }
    ]
  },
  ACTOR
)
const finishFirst = finishByRoute.lines.find((l: { productId: string }) => l.productId === 'p_o')
const finishSecond = finishByRoute.lines.find((l: { productId: string }) => l.productId === 'p_p')
poRepo.receivePurchaseOrderLines(finishByRoute.id, [{ lineId: finishFirst.id, quantity: 3 }], ACTOR)
ok(
  poRepo.getPurchaseOrder(finishByRoute.id).status === 'ordered',
  'T47 with one line still due the order stays open',
  String(poRepo.getPurchaseOrder(finishByRoute.id).status)
)
const finishRoute = poRepo.setPurchaseOrderRouting(finishByRoute.id, {
  lines: [{ lineId: finishSecond.id, destination: DROP }]
})
ok(!finishRoute.error, 'T47 routing the last outstanding line to a shop is accepted', String(finishRoute.error))
ok(finishRoute.po.status === 'received', 'T47 and THAT completes the order', String(finishRoute.po.status))
ok(!!finishRoute.po.scannedAt, 'T47 stamping scanned-in, so the empty box leaves Incoming')
ok(
  !poRepo.listActivePurchaseOrderBoxes().some((b: { id: string }) => b.id === finishByRoute.id),
  'T47 and it really is gone from the Incoming panel'
)
ok(finishRoute.po.receivedUnits === 3 && finishRoute.po.dropshipUnits === 5, 'T47 three received, five drop-shipped', `${finishRoute.po.receivedUnits}/${finishRoute.po.dropshipUnits}`)
ok(cogsFor(finishByRoute.id) === finishRoute.po.total, 'T47 and completing on a re-route books no second COGS row', String(cogsFor(finishByRoute.id)))

// THE GUARD. Completion is still the same test it always was: an order with
// units genuinely still due here is NOT closed by a routing change.
const stillDue = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      { productId: 'p_q', quantity: 2, unitPrice: 10 },
      { productId: 'p_w', quantity: 6, unitPrice: 10 }
    ]
  },
  ACTOR
)
const stillDueRoute = poRepo.setPurchaseOrderRouting(stillDue.id, {
  lines: [
    {
      lineId: stillDue.lines.find((l: { productId: string }) => l.productId === 'p_w').id,
      destination: DROP
    }
  ]
})
ok(!stillDueRoute.error, 'T47 GUARD a line can be routed away on an open order', String(stillDueRoute.error))
ok(stillDueRoute.po.status === 'ordered', 'T47 GUARD which stays open — two units are still coming', String(stillDueRoute.po.status))

// ---------------------------------------------------------------------------
console.log('\n=== 13. a fully-arrived mixed line is a finished line ===')
// ---------------------------------------------------------------------------

/**
 * T48. `receivedAt` AND `receivedLineCount` MEASURE AGAINST RECEIVABLE UNITS.
 *
 * Both used to compare against the ORDERED quantity, drop units included. A
 * 20-unit line split 12 to RM and 8 to a shop can never reach 20 — the other
 * eight were never addressed to this building — so a delivery that landed in
 * full left received_at NULL for ever and reported "0 of 1 lines received" on an
 * order whose own status says Received. Every line raised before v67 has
 * receivable === quantity, which is why this changes nothing for any of them.
 */
const mixedDone = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_r',
        quantity: 20,
        unitPrice: 10,
        allocations: [
          { quantity: 12, supplier: null, destination: 'RM' },
          { quantity: 8, supplier: null, destination: DROP }
        ]
      }
    ]
  },
  ACTOR
)
poRepo.receivePurchaseOrderLines(mixedDone.id, [{ lineId: mixedDone.lines[0].id, quantity: 5 }], ACTOR)
const mixedHalf = poRepo.getPurchaseOrder(mixedDone.id)
ok(mixedHalf.lines[0].receivedAt === null, 'T48 five of the twelve leaves the line unstamped', String(mixedHalf.lines[0].receivedAt))
ok(mixedHalf.receivedLineCount === 0, 'T48 and counted as no line finished', String(mixedHalf.receivedLineCount))
poRepo.receivePurchaseOrderLines(mixedDone.id, [{ lineId: mixedDone.lines[0].id, quantity: 7 }], ACTOR)
const mixedWhole = poRepo.getPurchaseOrder(mixedDone.id)
ok(!!mixedWhole.lines[0].receivedAt, 'T48 the twelfth unit stamps received_at on the line', String(mixedWhole.lines[0].receivedAt))
ok(mixedWhole.receivedLineCount === 1, 'T48 and the line counts as received', String(mixedWhole.receivedLineCount))
ok(
  mixedWhole.receivedLineCount === mixedWhole.lineCount,
  'T48 so the order reads "1 of 1", matching the Received it just stamped',
  `${mixedWhole.receivedLineCount}/${mixedWhole.lineCount}`
)
ok(mixedWhole.lines[0].quantity === 20 && mixedWhole.receivedUnits === 12, 'T48 while the order still says 20 ordered and 12 in', `${mixedWhole.lines[0].quantity}/${mixedWhole.receivedUnits}`)

// GUARD ONE: a legacy line is untouched, because receivable IS quantity there.
const legacyStamp = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_s', quantity: 4, unitPrice: 10 }] },
  ACTOR
)
poRepo.receivePurchaseOrderLines(legacyStamp.id, [{ lineId: legacyStamp.lines[0].id, quantity: 2 }], ACTOR)
ok(
  poRepo.getPurchaseOrder(legacyStamp.id).lines[0].receivedAt === null &&
    poRepo.getPurchaseOrder(legacyStamp.id).receivedLineCount === 0,
  'T48 GUARD half an unsplit line is still not a finished line'
)
poRepo.receivePurchaseOrderLines(legacyStamp.id, [{ lineId: legacyStamp.lines[0].id, quantity: 2 }], ACTOR)
ok(
  !!poRepo.getPurchaseOrder(legacyStamp.id).lines[0].receivedAt &&
    poRepo.getPurchaseOrder(legacyStamp.id).receivedLineCount === 1,
  'T48 GUARD and all of it still is'
)

// GUARD TWO: a line with NOTHING due here is not counted as finished either.
// Measuring against receivable without this would make 0 >= 0 true and report a
// pure-drop order as fully received the moment it was raised.
const dropCount = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: DROP, lines: [{ productId: 'p_t', quantity: 6, unitPrice: 10 }] },
  ACTOR
)
ok(
  poRepo.getPurchaseOrder(dropCount.id).receivedLineCount === 0,
  'T48 GUARD a pure-drop order reports zero lines received, not all of them',
  String(poRepo.getPurchaseOrder(dropCount.id).receivedLineCount)
)
ok(poRepo.getPurchaseOrder(dropCount.id).lineCount === 1, 'T48 GUARD out of the one line it has')

// ---------------------------------------------------------------------------
console.log('\n=== 14. "this one finishes the order" is counted per slice ===')
// ---------------------------------------------------------------------------

/**
 * T49. `completesPo` MEANS THE LAST OUTSTANDING SLICE, NOT THE LAST LINE.
 *
 * It was counted per LINE, so a line split 6 to RM and 6 to AM — one outstanding
 * line, two outstanding candidates — told BOTH candidates they were the last
 * thing the order was waiting for. The scan queue draws that as "completes this
 * PO" on a scan that leaves six boxes still due, which is the kind of quiet
 * wrongness this whole feature exists to remove. Advisory either way:
 * auto-completion is decided inside the commit transaction and this flag is
 * never asked, which is why getting it wrong was survivable and still worth
 * fixing.
 */
const sliceSplit = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_u',
        quantity: 12,
        unitPrice: 10,
        allocations: [
          { quantity: 6, supplier: null, destination: 'RM' },
          { quantity: 6, supplier: null, destination: 'AM' }
        ]
      }
    ]
  },
  ACTOR
)
const sliceCandidates = poRepo
  .outstandingLinesForProduct('p_u')
  .filter((c: { poId: string }) => c.poId === sliceSplit.id)
ok(sliceCandidates.length === 2, 'T49 a 6/6 split offers two candidates', String(sliceCandidates.length))
ok(
  sliceCandidates.every((c: { completesPo: boolean }) => c.completesPo === false),
  'T49 and NEITHER of them completes the order',
  JSON.stringify(sliceCandidates.map((c: { location: string; completesPo: boolean }) => [c.location, c.completesPo]))
)
ok(
  sliceCandidates.every((c: { poLinesOutstanding: number }) => c.poLinesOutstanding === 1),
  'T49 while the LINE count still says one outstanding line — that figure is unchanged',
  JSON.stringify(sliceCandidates.map((c: { poLinesOutstanding: number }) => c.poLinesOutstanding))
)
// Take one slice in full; the other becomes the last one, and now it does.
const firstSlice = sliceCandidates.find((c: { location: string }) => c.location === 'RM')
poRepo.receivePurchaseOrderLines(
  sliceSplit.id,
  [{ lineId: firstSlice.lineId, quantity: 6, allocationId: firstSlice.allocationId }],
  ACTOR
)
const lastSlice = poRepo
  .outstandingLinesForProduct('p_u')
  .filter((c: { poId: string }) => c.poId === sliceSplit.id)
ok(lastSlice.length === 1, 'T49 one candidate is left', String(lastSlice.length))
ok(lastSlice[0].completesPo === true, 'T49 and THAT one does complete the order', String(lastSlice[0]?.completesPo))
// The flag agreed with what actually happened, which is the only test of an
// advisory figure that means anything.
poRepo.receivePurchaseOrderLines(
  sliceSplit.id,
  [{ lineId: lastSlice[0].lineId, quantity: 6, allocationId: lastSlice[0].allocationId }],
  ACTOR
)
ok(
  poRepo.getPurchaseOrder(sliceSplit.id).status === 'received',
  'T49 receiving it really did complete it',
  String(poRepo.getPurchaseOrder(sliceSplit.id).status)
)

// GUARD ONE: an unsplit single-line order is exactly what it always was — one
// slice, one line, and the flag says true.
const soleLine = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_v', quantity: 5, unitPrice: 10 }] },
  ACTOR
)
const soleCandidates = poRepo
  .outstandingLinesForProduct('p_v')
  .filter((c: { poId: string }) => c.poId === soleLine.id)
ok(soleCandidates.length === 1 && soleCandidates[0].completesPo === true, 'T49 GUARD an unsplit sole line still completes its PO')
ok(soleCandidates[0].allocationId === null, 'T49 GUARD as the one implicit allocation it always was')

// GUARD TWO: drop slices are not outstanding candidates, so a mixed line's stock
// half is the last slice even though eight units will never arrive.
const mixedSlice = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      {
        productId: 'p_v',
        quantity: 20,
        unitPrice: 10,
        allocations: [
          { quantity: 12, supplier: null, destination: 'RM' },
          { quantity: 8, supplier: null, destination: DROP }
        ]
      }
    ]
  },
  ACTOR
)
const mixedSliceCandidates = poRepo
  .outstandingLinesForProduct('p_v')
  .filter((c: { poId: string }) => c.poId === mixedSlice.id)
ok(mixedSliceCandidates.length === 1, 'T49 GUARD a mixed line offers only its stock slice', String(mixedSliceCandidates.length))
ok(
  mixedSliceCandidates[0].completesPo === true,
  'T49 GUARD which does complete the order — the eight drop units are not waited for',
  String(mixedSliceCandidates[0]?.completesPo)
)

// The load-bearing invariant, over the whole database, at the end of everything
// this suite did. If ONE row of stock, ONE cost layer or ONE ledger movement
// exists at a destination that is not a shelf, the cost basis of real inventory
// is already wrong and nothing else in the app would say so.
ok(strayStockRows() === 0, 'NOTHING in this database sits at a location that is not RM or AM')
ok(
  canonicalDestination('rm') === 'RM' && canonicalDestination(' Fenwick Cards ') === 'Fenwick Cards',
  'and canonicalisation folds a shelf without touching a name'
)
ok(
  orderKindOf(0, 0, DROP) === 'drop' && orderKindOf(0, 0, 'RM') === 'stock',
  'an order with no lines reads as its header says'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
