/**
 * Partial purchase-order receiving — the delivery that turns up in two vans.
 *
 * Nine items, thirty-eight units, twenty-three of them on Tuesday. The
 * arithmetic underneath was always partial-aware, but there was no way to SAY
 * it: the only controls were a UPC scan (needs a barcode most of this catalog
 * does not have) and "Scanned in", which takes the whole order at once. So a
 * half delivery had to be recorded as complete — inventing fifteen units of
 * stock at a cost basis — or left alone, hiding twenty-three real ones.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. A PART DELIVERY DOES NOT CLOSE THE ORDER. If completePoIfFullyReceived
 *      fired on the first receipt, the PO would leave the Incoming panel with
 *      fifteen units still on a truck and nobody chasing them.
 *
 *   2. WHAT LANDED IS WHAT IS BOOKED. Twenty-three units means twenty-three
 *      units of stock at the line's unit price. Off-by-one here is a wrong
 *      cost basis on a FIFO layer, which misstates margin on every sale from
 *      that layer afterwards.
 *
 *   3. OVER-RECEIPT IS REFUSED, NAMED, AND ROLLS BACK THE WHOLE FORM. Silently
 *      clamping a typed number leaves somebody believing twelve landed when
 *      eight were booked. And a refusal on line seven must not leave lines one
 *      to six committed — half a delivery from a form about to be corrected is
 *      worse than none.
 *
 *   4. THE SECOND DELIVERY COMPLETES IT. The order closes exactly when the last
 *      unit lands, not before and not never.
 *
 *   5. THE PERCENTAGE NEVER ROUNDS TO A LIE. 379 of 380 is not 100%, and 1 of
 *      380 is not 0%. Both readings are wrong at exactly the moment they matter
 *      — one closes a shipment still owed, the other hides one that has begun
 *      arriving.
 *
 * Run: npm run test:receiving
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/receiving-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/inventory')
const {
  receiveProgress,
  receiveProgressOf,
  receiveShort,
  receiveSummary,
  receiveTone
} = require('../src/shared/receiving')
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

// ---------------------------------------------------------------------------
console.log('\n=== 1. the arithmetic, and the rounding rule ===')
// ---------------------------------------------------------------------------

const none = receiveProgress(38, 0)
ok(none.state === 'none', 'nothing in is "none"', none.state)
ok(none.percent === 0 && none.fraction === 0, 'and reads zero')
ok(none.outstanding === 38, 'with everything outstanding', String(none.outstanding))

const part = receiveProgress(38, 23)
ok(part.state === 'partial', '23 of 38 is partial', part.state)
ok(part.percent === 61, 'at 61%', String(part.percent))
ok(part.outstanding === 15, 'with 15 left', String(part.outstanding))
ok(receiveTone(part) === 'partial', 'and is NEVER painted green', receiveTone(part))
ok(receiveShort(part) === '23/38', 'the short form is the two counts', receiveShort(part))
ok(/23 of 38 units/.test(receiveSummary(part)), 'and the long form leads with them', receiveSummary(part))

const done = receiveProgress(38, 38)
ok(done.state === 'complete', 'all in is complete', done.state)
ok(done.percent === 100 && done.outstanding === 0, 'at 100% with nothing left')
ok(receiveTone(done) === 'done', 'and only THIS is green', receiveTone(done))

// Reason 5. Both of these round to a lie under a plain Math.round.
const nearlyAll = receiveProgress(380, 379)
ok(nearlyAll.percent === 99, '379 of 380 is 99%, not 100', String(nearlyAll.percent))
ok(nearlyAll.state === 'partial', 'and is still partial', nearlyAll.state)
const barelyAny = receiveProgress(380, 1)
ok(barelyAny.percent === 1, '1 of 380 is 1%, not 0', String(barelyAny.percent))
ok(barelyAny.state === 'partial', 'and is already partial', barelyAny.state)

// Over-receipt: a discrepancy, not progress, and never quietly hidden.
const over = receiveProgress(10, 12)
ok(over.state === 'over', 'more than ordered is its own state', over.state)
ok(over.excess === 2, 'naming how many more', String(over.excess))
ok(over.fraction === 1, 'the bar stops at full rather than overflowing', String(over.fraction))
ok(receiveTone(over) === 'over', 'painted as a discrepancy', receiveTone(over))

// Zero of zero is not "finished". An empty order has nothing to be finished.
const empty = receiveProgress(0, 0)
ok(empty.state === 'none', 'zero of zero is none, not complete', empty.state)

// Rubbish in does not become NaN in a style width — a NaN there blanks the bar.
const rubbish = receiveProgress(Number.NaN, Number.NaN)
ok(Number.isFinite(rubbish.fraction), 'a nonsense count still yields a drawable bar')

// Summing lines is the PO-level figure, and it adds up in UNITS not lines.
const summed = receiveProgressOf([
  { quantity: 5, qtyReceived: 5 },
  { quantity: 30, qtyReceived: 18 },
  { quantity: 3, qtyReceived: 0 }
])
ok(summed.ordered === 38 && summed.received === 23, 'lines sum in units', receiveShort(summed))
ok(summed.state === 'partial', 'one finished line does not finish the order', summed.state)

// ---------------------------------------------------------------------------
console.log('\n=== 2. nine items, thirty-eight units, twenty-three arrive ===')
// ---------------------------------------------------------------------------

// Nine products. Quantities chosen to total 38 so the arithmetic below is a
// real sum and not a single line in disguise.
const QTYS = [5, 8, 4, 6, 3, 2, 4, 3, 3]
ok(
  QTYS.reduce((a, b) => a + b, 0) === 38,
  'the fixture really is 38 units across 9 items',
  String(QTYS.reduce((a, b) => a + b, 0))
)
QTYS.forEach((_q, i) => {
  db.prepare(
    `INSERT INTO inventory_products (id, name, sku, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 0, '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
  ).run(`p_rc${i}`, `Case Product ${i + 1}`, `RCV-00${i + 1}`)
})

const po = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: QTYS.map((q, i) => ({ productId: `p_rc${i}`, quantity: q, unitPrice: 100 + i }))
  },
  'emp_owner'
)
ok(po.lines.length === 9, 'nine lines', String(po.lines.length))

const headerOf = (id: string): Record<string, number> =>
  poRepo.listPurchaseOrders().find((p: { id: string }) => p.id === id)
ok(headerOf(po.id).orderedUnits === 38, 'the header states 38 units ordered', String(headerOf(po.id).orderedUnits))
ok(headerOf(po.id).receivedUnits === 0, 'and none received', String(headerOf(po.id).receivedUnits))
ok(headerOf(po.id).lineCount === 9, 'nine ITEMS, which is a different number', String(headerOf(po.id).lineCount))

// Tuesday: 23 units turn up. The first four lines in full (5+8+4+6 = 23),
// which is how a real delivery arrives — whole cases of some things, none of
// others — rather than evenly spread.
const first = poRepo.receivePurchaseOrderLines(
  po.id,
  po.lines.slice(0, 4).map((l: { id: string; quantity: number }) => ({
    lineId: l.id,
    quantity: l.quantity
  })),
  'emp_owner'
)
ok(!first.error, 'the part delivery is accepted', String(first.error))

const afterFirst = headerOf(po.id)
ok(afterFirst.receivedUnits === 23, '23 units are recorded', String(afterFirst.receivedUnits))
ok(afterFirst.orderedUnits === 38, 'against the same 38 ordered', String(afterFirst.orderedUnits))
ok(afterFirst.receivedLineCount === 4, 'four lines are complete', String(afterFirst.receivedLineCount))

// REASON 1. The order stays open. This is the assertion that fails loudest if
// completePoIfFullyReceived ever loosens its "every line" test.
ok(afterFirst.status !== 'received', 'the PO is NOT marked received', String(afterFirst.status))
ok(!afterFirst.scannedAt, 'and not stamped scanned-in', String(afterFirst.scannedAt))
ok(!afterFirst.receivedAt, 'and carries no received date', String(afterFirst.receivedAt))

// It is still in the Incoming panel, which is the operational consequence of
// the three above: a closed PO's box disappears from the shelf-side screen.
const boxes = poRepo.listActivePurchaseOrderBoxes()
ok(
  boxes.some((b: { id: string }) => b.id === po.id),
  'and is still listed as incoming'
)

const progress = receiveProgressOf(poRepo.getPurchaseOrder(po.id).lines)
ok(progress.percent === 61, 'the screen reads 61%', String(progress.percent))
ok(progress.outstanding === 15, 'with 15 units still to come', String(progress.outstanding))

// REASON 2. The stock is really there, at the price on the line.
const stocked = QTYS.slice(0, 4).every((q, i) => {
  const p = inv.getProduct(`p_rc${i}`)
  return p && p.unitCost === 100 + i && inv.stockQty(`p_rc${i}`, 'RM') === q
})
ok(stocked, 'the 23 units are on the shelf at their line price')
// And nothing was booked for the lines that did not arrive.
ok(inv.stockQty('p_rc4', 'RM') === 0, 'nothing landed for the lines that did not come')

// A receipt row per line, which is what makes an exact reversal possible.
const receipts = db
  .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(quantity), 0) AS q FROM po_line_receipts WHERE po_id = ?')
  .get(po.id) as { n: number; q: number }
ok(receipts.n === 4, 'one receipt row per line received', String(receipts.n))
ok(receipts.q === 23, 'totalling the units that landed', String(receipts.q))

// ---------------------------------------------------------------------------
console.log('\n=== 3. over-receipt is refused, and takes the whole form with it ===')
// ---------------------------------------------------------------------------

const line5 = poRepo.getPurchaseOrder(po.id).lines[4] // 3 ordered, 0 in
const line6 = poRepo.getPurchaseOrder(po.id).lines[5] // 2 ordered, 0 in

// A form where the FIRST line is fine and the second is not. Reason 3: the
// first must not survive the refusal.
const refused = poRepo.receivePurchaseOrderLines(
  po.id,
  [
    { lineId: line5.id, quantity: 3 },
    { lineId: line6.id, quantity: 9 } // only 2 outstanding
  ],
  'emp_owner'
)
ok(!!refused.error, 'a count above what is outstanding is refused', String(refused.error))
ok(/only 2 of 2/.test(refused.error ?? ''), 'and says how many there actually are', String(refused.error))
ok(
  (refused.error ?? '').includes(line6.productName),
  'naming the product, not just a line id',
  String(refused.error)
)
ok(headerOf(po.id).receivedUnits === 23, 'and the good line did NOT go in', String(headerOf(po.id).receivedUnits))
ok(inv.stockQty(line5.productId, 'RM') === 0, 'no stock was booked for it either')

// An already-finished line cannot take another unit.
const doneLine = poRepo.getPurchaseOrder(po.id).lines[0]
const twice = poRepo.receivePurchaseOrderLines(po.id, [{ lineId: doneLine.id, quantity: 1 }], 'emp_owner')
ok(!!twice.error, 'a fully received line refuses more', String(twice.error))
ok(/already fully received/.test(twice.error ?? ''), 'and says so plainly', String(twice.error))

// A line from a different order is not on this one.
const other = poRepo.createPurchaseOrder(
  { location: 'RM', lines: [{ productId: 'p_rc0', quantity: 1, unitPrice: 50 }] },
  'emp_owner'
)
const foreign = poRepo.receivePurchaseOrderLines(
  po.id,
  [{ lineId: other.lines[0].id, quantity: 1 }],
  'emp_owner'
)
ok(!!foreign.error, 'a line from another PO is refused', String(foreign.error))
ok(headerOf(other.id).receivedUnits === 0, 'and nothing lands on the other order either')

// An empty form is an error, not a silent no-op that looks like it worked.
const nothing = poRepo.receivePurchaseOrderLines(po.id, [], 'emp_owner')
ok(!!nothing.error, 'an empty delivery is refused', String(nothing.error))
// All zeros is the same thing said differently.
const zeros = poRepo.receivePurchaseOrderLines(po.id, [{ lineId: line5.id, quantity: 0 }], 'emp_owner')
ok(!!zeros.error, 'a form of zeros is refused too', String(zeros.error))

// A negative is a typo, not an un-receive. Un-receiving is the cancel path.
const negative = poRepo.receivePurchaseOrderLines(po.id, [{ lineId: line5.id, quantity: -2 }], 'emp_owner')
ok(!!negative.error, 'a negative count is refused', String(negative.error))
ok(headerOf(po.id).receivedUnits === 23, 'and nothing moved', String(headerOf(po.id).receivedUnits))

// ---------------------------------------------------------------------------
console.log('\n=== 4. Friday: the rest arrives and the order closes ===')
// ---------------------------------------------------------------------------

// One unit short of the rest first, to prove the order does NOT close early.
const rest = poRepo.getPurchaseOrder(po.id).lines.filter((l: { qtyOutstanding: number }) => l.qtyOutstanding > 0)
ok(rest.length === 5, 'five lines are still outstanding', String(rest.length))

const almost = poRepo.receivePurchaseOrderLines(
  po.id,
  rest.map((l: { id: string; qtyOutstanding: number }, i: number) => ({
    lineId: l.id,
    quantity: i === 0 ? l.qtyOutstanding - 1 : l.qtyOutstanding
  })),
  'emp_owner'
)
ok(!almost.error, 'a delivery one unit short is accepted', String(almost.error))
const nearly = headerOf(po.id)
ok(nearly.receivedUnits === 37, '37 of 38 are in', String(nearly.receivedUnits))
ok(nearly.status !== 'received', 'and the order is STILL open on one unit', String(nearly.status))
ok(!nearly.scannedAt, 'still not stamped scanned-in')
const nearlyProgress = receiveProgressOf(poRepo.getPurchaseOrder(po.id).lines)
ok(nearlyProgress.percent === 97, 'reading 97%, not 100', String(nearlyProgress.percent))

// The last unit.
const lastLine = poRepo
  .getPurchaseOrder(po.id)
  .lines.find((l: { qtyOutstanding: number }) => l.qtyOutstanding > 0)
const last = poRepo.receivePurchaseOrderLines(
  po.id,
  [{ lineId: lastLine.id, quantity: lastLine.qtyOutstanding }],
  'emp_owner'
)
ok(!last.error, 'the last unit goes in', String(last.error))

const closed = headerOf(po.id)
ok(closed.receivedUnits === 38, 'all 38 are received', String(closed.receivedUnits))
ok(closed.status === 'received', 'and NOW the order closes', String(closed.status))
ok(!!closed.scannedAt, 'stamped scanned-in', String(closed.scannedAt))
ok(!!closed.receivedAt, 'and dated', String(closed.receivedAt))
ok(receiveProgressOf(poRepo.getPurchaseOrder(po.id).lines).state === 'complete', 'the screen says complete')

// It leaves the Incoming panel, which is what scanned_at is for.
ok(
  !poRepo.listActivePurchaseOrderBoxes().some((b: { id: string }) => b.id === po.id),
  'and drops out of the incoming boxes'
)

// Every ordered unit is on the shelf, once. Not twice — the double-add this
// whole design guards against is receiving the same line through two paths.
const shelved = QTYS.every((q, i) => inv.stockQty(`p_rc${i}`, 'RM') === q)
ok(shelved, 'every product holds exactly what was ordered — nothing double-added')

// A closed order takes nothing more.
const afterClose = poRepo.receivePurchaseOrderLines(
  po.id,
  [{ lineId: po.lines[0].id, quantity: 1 }],
  'emp_owner'
)
ok(!!afterClose.error, 'a closed order refuses another unit', String(afterClose.error))

// ---------------------------------------------------------------------------
console.log('\n=== 5. the whole-order button still works, and does not double ===')
// ---------------------------------------------------------------------------

// "Scanned in" over a PART-received order must add only the remainder. Under a
// pre-v15 implementation this button re-added everything.
const mixed = poRepo.createPurchaseOrder(
  {
    location: 'AM',
    lines: [
      { productId: 'p_rc0', quantity: 4, unitPrice: 10 },
      { productId: 'p_rc1', quantity: 6, unitPrice: 20 }
    ]
  },
  'emp_owner'
)
poRepo.receivePurchaseOrderLines(mixed.id, [{ lineId: mixed.lines[0].id, quantity: 1 }], 'emp_owner')
ok(headerOf(mixed.id).receivedUnits === 1, 'one unit in by hand', String(headerOf(mixed.id).receivedUnits))
const swept = poRepo.scanInPurchaseOrder(mixed.id, 'emp_owner')
ok(!swept.error, '"scanned in" takes the rest', String(swept.error))
ok(headerOf(mixed.id).receivedUnits === 10, 'totalling 10, not 11', String(headerOf(mixed.id).receivedUnits))
ok(inv.stockQty('p_rc0', 'AM') === 4, 'and the hand-received line is not doubled', String(inv.stockQty('p_rc0', 'AM')))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
