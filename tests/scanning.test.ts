/**
 * Scanning, both directions, and the two questions a scan can raise.
 *
 * The floor reported three things, and they turned out to be one design fault
 * seen from three sides:
 *
 *   "I scan it several times, the scan count goes up, the quantity does not."
 *   "It should match a PO, and prompt for an override when it does not."
 *   "It cannot scan several products at a time without going wrong."
 *
 * Every one of them is the software deciding something silently. A count that
 * hit the order's ceiling stopped moving while the beeps kept coming; a product
 * on no open order quietly became a stock movement; and one bad line abandoned
 * every line queued behind it.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE CEILING IS A QUESTION, NOT A CLAMP. Scanning past what an order
 *      asked for raises a decision and blocks the commit until somebody answers
 *      it. Silently dropping the extra beeps is how four boxes on a bench get
 *      recorded as one.
 *
 *   2. AN OVERRIDE IS RECORDED, NEVER INFERRED. The commit refuses a bare stock
 *      movement and refuses to exceed an order — both need the operator's
 *      answer on the input. A commit that worked it out for itself would put
 *      the silence straight back.
 *
 *   3. OUT MATCHES A SALES ORDER, exactly as IN matches a purchase order, and
 *      counts units off its lines the same way.
 *
 *   4. SEVERAL PRODUCTS AT ONCE, and a failure part-way does not lose the rest.
 *
 *   5. THE COUNTS ARE REAL. What was scanned is what lands on the shelf and
 *      what the order records — off by one here is a wrong cost basis on a FIFO
 *      layer, which misstates margin on every sale out of it afterwards.
 *
 * Run: npm run test:scanning
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/scanning-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const invoices = require('../src/main/db/invoices')
const scan = require('../src/main/db/scanning')
const inv = require('../src/main/db/inventory')
const { normalizeUpc } = require('../src/shared/upc')
const {
  acceptOverage,
  commitBlockedReason,
  firstUndecided,
  keepToOrder,
  lineFromScan,
  mergeScan,
  toCommitInput
} = require('../src/renderer/src/modules/inventory/scanLines')
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

const mk = (id: string, name: string, sku: string, upc: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, name, sku, upc, upc_norm, category, unit_cost,
                                     created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Baseball', 0, '2026-03-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z')`
  ).run(id, name, sku, upc, normalizeUpc(upc))
}
mk('p_a', 'Alpha Hobby Box', 'AAA-1', '0000000000017')
mk('p_b', 'Bravo Hobby Box', 'BBB-1', '0000000000024')
mk('p_c', 'Charlie Hobby Box', 'CCC-1', '0000000000031')

/** The renderer's loop: resolve the code, fold it into the pending list. */
const beep = (lines: unknown[], upc: string, dir = 'in'): any[] => {
  const res = scan.resolveScan(upc, dir)
  if (!res.product || res.status === 'no_order' || res.status === 'unknown') return lines as any[]
  return mergeScan(
    lines,
    lineFromScan({
      resolution: res,
      product: res.product,
      direction: dir,
      mode: 'scanner',
      candidate: res.candidates[0] ?? null,
      soCandidate: res.soCandidates[0] ?? null,
      now: 1
    })
  )
}
const commit = (line: any, override?: string): { result?: any; error?: string } =>
  scan.commitScan({ ...toCommitInput(line, null), override: override ?? line.override }, 'emp1')

// ---------------------------------------------------------------------------
console.log('\n=== 1. scanning IN against a purchase order ===')
// ---------------------------------------------------------------------------
const po = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    lines: [
      { productId: 'p_a', quantity: 5, unitPrice: 100 },
      { productId: 'p_b', quantity: 3, unitPrice: 200 }
    ]
  },
  'emp1'
)

let lines = beep([], '0000000000017')
ok(lines.length === 1, 'one line', String(lines.length))
ok(lines[0].kind === 'po_line', 'matched to the purchase order', lines[0].kind)
ok(lines[0].poNumber === po.poNumber, 'and names it', String(lines[0].poNumber))
ok(lines[0].max === 5, 'with the order’s outstanding as the ceiling', String(lines[0].max))

lines = beep(lines, '0000000000017')
lines = beep(lines, '0000000000017')
ok(lines[0].quantity === 3, 'three beeps, three units', String(lines[0].quantity))
ok(lines[0].scans === 3, 'and three scans', String(lines[0].scans))
ok(lines[0].needsDecision === null, 'nothing to ask — it fits inside the order')

// REASON 4: a second product joins the list rather than replacing it.
lines = beep(lines, '0000000000024')
lines = beep(lines, '0000000000024')
ok(lines.length === 2, 'a second product is its own line', String(lines.length))
ok(lines[1].quantity === 2, 'counted separately', String(lines[1].quantity))
ok(commitBlockedReason(lines) === null, 'and the list can be committed', String(commitBlockedReason(lines)))

for (const l of lines) {
  const r = commit(l)
  ok(!r.error, `${l.productName} commits`, String(r.error))
}
const afterPo = poRepo.getPurchaseOrder(po.id)
ok(afterPo.lines[0].qtyReceived === 3, 'the PO records 3 of 5', String(afterPo.lines[0].qtyReceived))
ok(afterPo.lines[1].qtyReceived === 2, 'and 2 of 3', String(afterPo.lines[1].qtyReceived))
ok(inv.stockQty('p_a', 'RM') === 3, 'and the stock is really there', String(inv.stockQty('p_a', 'RM')))
ok(afterPo.status !== 'received', 'a part delivery leaves the order open', String(afterPo.status))

// ---------------------------------------------------------------------------
console.log('\n=== 2. REASON 1: scanning past what the order asked for ===')
// ---------------------------------------------------------------------------
// Two units outstanding on line A. Four beeps.
let over = beep([], '0000000000017')
ok(over[0].max === 2, 'the ceiling followed the receipts', String(over[0].max))
over = beep(over, '0000000000017')
ok(over[0].quantity === 2 && over[0].needsDecision === null, 'two fits')
over = beep(over, '0000000000017')
over = beep(over, '0000000000017')

// THE BUG. The count holds at the ceiling — but it now SAYS so and stops the run.
ok(over[0].scans === 4, 'four beeps landed', String(over[0].scans))
ok(over[0].quantity === 2, 'the count holds at the ceiling', String(over[0].quantity))
ok(over[0].needsDecision === 'overage', 'and raises a question', String(over[0].needsDecision))
ok(!!firstUndecided(over), 'which the list reports as outstanding')
ok(
  /more was scanned than the order asked for/i.test(commitBlockedReason(over) ?? ''),
  'and nothing commits until it is answered',
  String(commitBlockedReason(over))
)

// Answer A: stick to the order.
const kept = keepToOrder(over, over[0].key)
ok(kept[0].quantity === 2, 'keeping to the order leaves the count at 2', String(kept[0].quantity))
ok(kept[0].needsDecision === null, 'and closes the question')
ok(kept[0].override === null, 'with no override recorded — nothing was overridden')
ok(commitBlockedReason(kept) === null, 'the list commits again')

// Answer B: take the overage.
const took = acceptOverage(over, over[0].key)
ok(took[0].quantity === 4, 'taking the overage counts every beep', String(took[0].quantity))
ok(took[0].override === 'overage', 'and records WHY', String(took[0].override))
ok(took[0].max === null, 'lifting the ceiling for this line', String(took[0].max))
ok(commitBlockedReason(took) === null, 'and the list commits')

// REASON 2: the commit refuses the same quantity WITHOUT the override.
const refused = scan.commitScan(
  { ...toCommitInput(took[0], null), override: null, clientToken: 'tok-refuse' },
  'emp1'
)
ok(!!refused.error, 'the same 4 units are refused with no override', String(refused.error))
ok(
  /already been fully received|only|outstanding/i.test(refused.error ?? ''),
  'and says why',
  String(refused.error)
)
ok(poRepo.getPurchaseOrder(po.id).lines[0].qtyReceived === 3, 'and nothing moved')

const overdone = commit(took[0])
ok(!overdone.error, 'with the override it goes through', String(overdone.error))
const overLine = poRepo.getPurchaseOrder(po.id).lines[0]
ok(overLine.qtyReceived === 7, '7 received against 5 ordered', String(overLine.qtyReceived))
ok(overLine.qtyOutstanding === 0, 'outstanding floors at zero', String(overLine.qtyOutstanding))
ok(inv.stockQty('p_a', 'RM') === 7, 'and all 7 are on the shelf', String(inv.stockQty('p_a', 'RM')))
// The reason survives on the row, which is the whole point of recording it.
const overRow = db
  .prepare(`SELECT override_kind AS k FROM inventory_scans WHERE id = ?`)
  .get(overdone.result.scanId) as { k: string | null }
ok(overRow.k === 'overage', 'and the scan row remembers the override', String(overRow.k))

// ---------------------------------------------------------------------------
console.log('\n=== 3. REASON 2: a product on no open order ===')
// ---------------------------------------------------------------------------
const orphan = scan.resolveScan('0000000000031', 'in')
ok(orphan.status === 'no_order', 'resolves as a question, not a plan', orphan.status)
ok(!!orphan.product, 'the product is still identified')
ok(/no open purchase order/i.test(orphan.message), 'and says so', orphan.message)

const bare = {
  kind: 'add_stock',
  rawCode: '0000000000031',
  mode: 'scanner',
  productId: 'p_c',
  location: 'RM',
  quantity: 2,
  unitCost: 40,
  clientToken: 'tok-bare-1'
}
const noOverride = scan.commitScan({ ...bare }, 'emp1')
ok(!!noOverride.error, 'committing it with no override is refused', String(noOverride.error))
ok(/no open purchase order/i.test(noOverride.error ?? ''), 'naming the reason', String(noOverride.error))
ok(inv.stockQty('p_c', 'RM') === 0, 'and no stock was created')

const withOverride = scan.commitScan(
  { ...bare, clientToken: 'tok-bare-2', override: 'no_order' },
  'emp1'
)
ok(!withOverride.error, 'with the override it goes in', String(withOverride.error))
ok(inv.stockQty('p_c', 'RM') === 2, 'two units on the shelf', String(inv.stockQty('p_c', 'RM')))
const bareRow = db
  .prepare(`SELECT override_kind AS k FROM inventory_scans WHERE id = ?`)
  .get(withOverride.result.scanId) as { k: string | null }
ok(bareRow.k === 'no_order', 'recorded as an override', String(bareRow.k))

// ---------------------------------------------------------------------------
console.log('\n=== 4. REASON 3: scanning OUT against a sales order ===')
// ---------------------------------------------------------------------------
const so = invoices.saveInvoice(
  {
    customerName: 'Kyla Benton',
    email: 'buyer@example.test',
    invoiceDate: '2026-08-11',
    terms: 'net30',
    lines: [{ item: 'Alpha Hobby Box', productId: 'p_a', sku: 'AAA-1', quantity: 4, rate: 150 }]
  },
  'emp1'
)
ok(!!so?.id, 'a sales order exists')

const outRes = scan.resolveScan('0000000000017', 'out')
ok(outRes.status === 'so_line', 'scanning out matches the SALES order', outRes.status)
ok(outRes.soCandidates.length === 1, 'one candidate', String(outRes.soCandidates.length))
ok(outRes.soCandidates[0].qtyOutstanding === 4, 'four still to go out', String(outRes.soCandidates[0].qtyOutstanding))
ok(outRes.candidates.length === 0, 'and NO purchase orders are read on the way out')

let outLines = beep([], '0000000000017', 'out')
outLines = beep(outLines, '0000000000017', 'out')
ok(outLines[0].kind === 'so_line', 'the line is a sales-order line', outLines[0].kind)
ok(outLines[0].quantity === 2, 'two scanned', String(outLines[0].quantity))
ok(outLines[0].invoiceNumber === so.invoiceNumber, 'against that order', String(outLines[0].invoiceNumber))

const stockBeforeOut = inv.stockQty('p_a', 'RM')
const outCommit = commit(outLines[0])
ok(!outCommit.error, 'and it commits', String(outCommit.error))
ok(
  inv.stockQty('p_a', 'RM') === stockBeforeOut - 2,
  'two units leave the shelf',
  `${stockBeforeOut} → ${inv.stockQty('p_a', 'RM')}`
)
const soAfter = invoices.getInvoice(so.id)
ok(soAfter.lines[0].qtyFulfilled === 2, 'the ORDER records 2 of 4 fulfilled', String(soAfter.lines[0].qtyFulfilled))

// Partial, so it is still open and still offered to the next scan.
const stillOpen = scan.resolveScan('0000000000017', 'out')
ok(stillOpen.status === 'so_line', 'still matching', stillOpen.status)
ok(stillOpen.soCandidates[0].qtyOutstanding === 2, 'with 2 left', String(stillOpen.soCandidates[0].qtyOutstanding))

// Finish it, and it drops out of the candidates.
let restLines = beep([], '0000000000017', 'out')
restLines = beep(restLines, '0000000000017', 'out')
const restCommit = commit(restLines[0])
ok(!restCommit.error, 'the rest goes out', String(restCommit.error))
ok(invoices.getInvoice(so.id).lines[0].qtyFulfilled === 4, 'all four fulfilled')
ok(
  scan.resolveScan('0000000000017', 'out').status === 'no_order',
  'a finished order stops being offered',
  scan.resolveScan('0000000000017', 'out').status
)

// A voided order is not fulfillable at all.
const voided = invoices.saveInvoice(
  {
    customerName: 'Nobody',
    invoiceDate: '2026-08-11',
    terms: 'net30',
    lines: [{ item: 'Bravo Hobby Box', productId: 'p_b', sku: 'BBB-1', quantity: 2, rate: 90 }]
  },
  'emp1'
)
invoices.setInvoiceStatus(voided.id, 'void', 'emp1')
ok(
  scan.resolveScan('0000000000024', 'out').status === 'no_order',
  'a voided order is never a candidate',
  scan.resolveScan('0000000000024', 'out').status
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. REASON 4: a failure part-way does not lose the rest ===')
// ---------------------------------------------------------------------------
// Two lines. The first is committed behind the run's back — as a second station
// would — so the second's commit is the one that fails.
const po2 = poRepo.createPurchaseOrder(
  { location: 'RM', lines: [{ productId: 'p_c', quantity: 1, unitPrice: 30 }] },
  'emp1'
)
const raceLine = beep([], '0000000000031')[0]
poRepo.scanInPurchaseOrder(po2.id, 'emp1') // somebody else took the whole order
const raced = commit(raceLine)
ok(!!raced.error, 'the stale line is refused', String(raced.error))

// And the OTHER line in the same run is unaffected — each commit is its own
// transaction, which is what lets the station carry on past a bad row.
//
// It lands on the OLDEST open order for that product, not the newest: purchase
// -side FIFO, the same rule `outstandingLinesForProduct` orders by. The newer
// order below exists only to prove the choice is deliberate.
poRepo.createPurchaseOrder(
  { location: 'RM', lines: [{ productId: 'p_b', quantity: 2, unitPrice: 60 }] },
  'emp1'
)
const goodLine = beep([], '0000000000024')[0]
ok(goodLine.poNumber === po.poNumber, 'the oldest open order is offered first', String(goodLine.poNumber))
const receivedBefore = poRepo.getPurchaseOrder(po.id).lines[1].qtyReceived
const good = commit(goodLine)
ok(!good.error, 'a healthy line still commits', String(good.error))
ok(
  poRepo.getPurchaseOrder(po.id).lines[1].qtyReceived === receivedBefore + 1,
  'and lands on that order',
  String(poRepo.getPurchaseOrder(po.id).lines[1].qtyReceived)
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. idempotency survives all of it ===')
// ---------------------------------------------------------------------------
// The same client token replays rather than applying twice — a retry after a
// dropped reply must not double-count a box.
const before = inv.stockQty('p_b', 'RM')
const replay = commit(goodLine)
ok(!replay.error, 'a retry is accepted', String(replay.error))
ok(replay.result.replayed === true, 'as a REPLAY', String(replay.result?.replayed))
ok(inv.stockQty('p_b', 'RM') === before, 'and moves no stock', String(inv.stockQty('p_b', 'RM')))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
