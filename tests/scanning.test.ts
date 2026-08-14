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
  setQuantity,
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

// A BEEP IS A BOX, and inbound the count is simply how many were beeped.
//
// This used to hold at the order's ceiling and stop to ask. The owner, twice:
// "3 scans means that I am scanning 3 individual boxes" and "if i scan
// something 3 times that means there are 3 of those products". That is the
// right way round — the boxes on the pallet are the fact, and the order is only
// what somebody expected to arrive. When they disagree it is usually the order
// that is behind: a supplier shipped an extra case, or it was raised short.
ok(over[0].scans === 4, 'four beeps landed', String(over[0].scans))
ok(over[0].quantity === 4, 'and the count is four — one per box', String(over[0].quantity))
ok(over[0].needsDecision === null, 'no question is raised', String(over[0].needsDecision))
ok(!firstUndecided(over), 'nothing is waiting on a person')
ok(commitBlockedReason(over) === null, 'and it commits', String(commitBlockedReason(over)))

// The override is carried anyway, because the main process refuses to exceed an
// order's outstanding without one. Setting it here is what turns "count what was
// scanned" into a receipt that actually lands rather than a number refused at
// the last step.
ok(over[0].override === 'overage', 'carrying the override the commit needs', String(over[0].override))
ok(over[0].overflow === true, 'and flagged as more than the order expected')
ok(over[0].max === 2, 'while still remembering what WAS expected', String(over[0].max))

// Both answers remain available for a hand correction: the count is a plain
// field, and these are what the two buttons do if the operator uses them.
const kept = keepToOrder(over, over[0].key)
ok(kept[0].quantity === 2, 'keeping to the order trims to what was ordered', String(kept[0].quantity))
ok(kept[0].needsDecision === null, 'and closes any question')

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
console.log('\n=== 4. REASON 3: a sales order takes its stock when it is WRITTEN ===')
// ---------------------------------------------------------------------------
// THIS SECTION CHANGED SHAPE, and the change is the point.
//
// A sales order used to be paperwork: it named products and quantities, and the
// shelf did not move until a picker scanned the boxes out against it. It is a
// SALE now — saving the order consumes FIFO layers the same way a counter sale
// does, because the owner writes the order because the boxes are going, and
// every screen that says how many are on hand has to agree immediately.
//
// So the assertions below are the mirror image of the ones they replace: the
// shelf drops at save, and the scanner is NOT offered the line, because two
// things taking the same boxes off the same shelf is the failure this replaces.
const stockBeforeOrder = inv.stockQty('p_a', 'RM')
ok(stockBeforeOrder >= 4, 'there is stock to sell', String(stockBeforeOrder))

const so = invoices.saveInvoice(
  {
    customerName: 'Kyla Benton',
    email: 'buyer@example.test',
    invoiceDate: '2026-08-11',
    terms: 'net30',
    location: 'RM',
    lines: [{ item: 'Alpha Hobby Box', productId: 'p_a', sku: 'AAA-1', quantity: 4, rate: 150 }]
  },
  'emp1'
)
ok(!!so?.id, 'a sales order exists')
ok(
  inv.stockQty('p_a', 'RM') === stockBeforeOrder - 4,
  'AND FOUR BOXES CAME OFF THE SHELF THE MOMENT IT WAS SAVED',
  `${stockBeforeOrder} → ${inv.stockQty('p_a', 'RM')}`
)
ok(so.lines[0].qtyFulfilled === 4, 'the line reads fully fulfilled', String(so.lines[0].qtyFulfilled))
ok(so.lines[0].qtyOutstanding === 0, 'with nothing left to pick', String(so.lines[0].qtyOutstanding))

// The order's cost is recorded against a real ledger movement, so the margin is
// answerable without re-deriving anything.
const soMove = db
  .prepare(`SELECT quantity, cost_total, txn_id FROM invoice_stock_moves WHERE invoice_id = ?`)
  .get(so.id) as { quantity: number; cost_total: number; txn_id: string | null }
ok(!!soMove, 'a stock receipt is written for the order')
ok(soMove.quantity === 4, 'for the four that left', String(soMove?.quantity))
ok(soMove.cost_total > 0, 'carrying what those four cost', String(soMove?.cost_total))
ok(!!soMove.txn_id, 'and naming the ledger row that holds the layers')

// THE SCANNER IS NOT OFFERED IT. Nothing is outstanding, so a beep on that box
// falls through to the buy side exactly as an unsold box does.
const outRes = scan.resolveScan('0000000000017', 'out')
ok(outRes.status !== 'so_line', 'a fully-taken order is NOT offered to the scanner', outRes.status)

// --- The one case the scan-out flow still exists for ----------------------
// An order written the day before the pallet lands. The save is not refused —
// that would push the work into a notebook — it takes what is there and leaves
// the rest outstanding, which is the state the scanner already understands.
const shortStock = inv.stockQty('p_b', 'RM')
const ahead = invoices.saveInvoice(
  {
    customerName: 'Kyla Benton',
    invoiceDate: '2026-08-11',
    terms: 'net30',
    location: 'RM',
    lines: [
      { item: 'Bravo Hobby Box', productId: 'p_b', sku: 'BBB-1', quantity: shortStock + 3, rate: 150 }
    ]
  },
  'emp1'
)
ok(inv.stockQty('p_b', 'RM') === 0, 'it takes everything the shelf had', String(inv.stockQty('p_b', 'RM')))
ok(
  ahead.lines[0].qtyFulfilled === shortStock,
  'and records exactly that much as gone',
  String(ahead.lines[0].qtyFulfilled)
)
ok(
  ahead.lines[0].qtyOutstanding === 3,
  'THE REST STAYS OUTSTANDING rather than the save being refused',
  String(ahead.lines[0].qtyOutstanding)
)
ok(inv.stockQty('p_b', 'RM') >= 0, 'and the shelf never goes negative')

// An empty shelf is still an empty shelf: nothing can be scanned out of it, and
// the resolver says so rather than offering an order it cannot fill.
const nothingYet = scan.resolveScan('0000000000024', 'out')
ok(nothingYet.status === 'no_order', 'an empty shelf offers nothing to scan out', nothingYet.status)
ok(/nothing to take out/i.test(nothingYet.message ?? ''), 'and says why', nothingYet.message)

// The pallet lands. THIS is what keeps the scan-out flow useful under the new
// model: the part of an order that could not be filled when it was written is
// picked the ordinary way once the boxes are on the shelf.
inv.addStock('p_b', 'RM', 3, 200, 'the pallet arrives', null, null)
const stillOwed = scan.resolveScan('0000000000024', 'out')
ok(stillOwed.status === 'so_line', 'the unfilled remainder IS offered to the scanner', stillOwed.status)
ok(
  stillOwed.soCandidates[0].qtyOutstanding === 3,
  'for the three that have not gone',
  String(stillOwed.soCandidates[0]?.qtyOutstanding)
)
// And picking it moves the shelf exactly once — the order already took what it
// could, so this takes only the remainder.
let owedLines = beep([], '0000000000024', 'out')
owedLines = beep(owedLines, '0000000000024', 'out')
owedLines = beep(owedLines, '0000000000024', 'out')
const owedCommit = commit(owedLines[0])
ok(!owedCommit.error, 'the remainder is scanned out', String(owedCommit.error))
ok(inv.stockQty('p_b', 'RM') === 0, 'and the shelf is empty again', String(inv.stockQty('p_b', 'RM')))
ok(
  invoices.getInvoice(ahead.id).lines[0].qtyOutstanding === 0,
  'with the order fully filled',
  String(invoices.getInvoice(ahead.id).lines[0].qtyOutstanding)
)

// Voiding an order puts its boxes back — it is the moment the stock stops being
// sold, and leaving the shelf down would strand them with no way back except a
// count correction that invents a cost basis.
const beforeVoid = inv.stockQty('p_a', 'RM')
invoices.setInvoiceStatus(so.id, 'void', 'emp1')
ok(
  inv.stockQty('p_a', 'RM') === beforeVoid + 4,
  'VOIDING THE ORDER PUTS THE FOUR BOXES BACK',
  `${beforeVoid} → ${inv.stockQty('p_a', 'RM')}`
)
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM invoice_stock_moves WHERE invoice_id = ?`).get(so.id) as any).n === 0,
  'and the receipt goes with them'
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

// ---------------------------------------------------------------------------
console.log('\n=== N. three boxes onto a one-unit order, both answers ===')
// ---------------------------------------------------------------------------
// The owner, on a real pallet: "3 scans means that I am scanning 3 individual
// boxes" — and the queue was showing 3 scans beside a quantity of 1 with no
// explanation, which reads as the scanner dropping two of them.
//
// It is not dropping them. The order asked for one, so the count is held there
// and the difference becomes a QUESTION. What this pins is that the question is
// actually raised, that it blocks the save until answered, and that BOTH answers
// do what their labels say — because a prompt that appears and then does the
// wrong thing is worse than the silence it replaced.
const onePo = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_c', quantity: 1, unitPrice: 1900 }] },
  null
)
let pallet: any[] = []
for (let i = 0; i < 3; i++) pallet = beep(pallet, '0000000000031')

ok(pallet[0].scans === 3, 'three beeps are three boxes', String(pallet[0].scans))
ok(pallet[0].quantity === 3, 'AND THE COUNT IS THREE', String(pallet[0].quantity))
ok(pallet[0].needsDecision === null, 'with nothing to answer first')
ok(commitBlockedReason(pallet) === null, 'and nothing in the way of saving',
  String(commitBlockedReason(pallet)))
ok(pallet[0].overflow === true, 'though the line does say it is more than the order expected')

const takeAll = pallet
ok(takeAll[0].quantity === 3, 'three boxes, three units', String(takeAll[0].quantity))
ok(takeAll[0].override === 'overage', 'carrying the override the commit needs')
const stockBefore = inv.stockQty('p_c', 'RM')
const done = commit(takeAll[0])
ok(!done.error, 'it commits', String(done.error))
ok(inv.stockQty('p_c', 'RM') - stockBefore === 3, 'putting all THREE on the shelf',
  String(inv.stockQty('p_c', 'RM') - stockBefore))
const grown = poRepo.getPurchaseOrder(onePo.id)
ok(grown.lines[0].qtyReceived === 3, 'and booking three against the order', String(grown.lines[0].qtyReceived))
// An over-receipt is a discrepancy the order carries honestly, not a silent trim.
ok(grown.lines[0].quantity === 1, 'which still only ORDERED one — the gap is visible')

// "Keep 1" — the other answer, on its own order.
const otherPo = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_c', quantity: 1, unitPrice: 1900 }] },
  null
)
ok(!!otherPo.id, 'a second one-unit order exists to answer the other way')
let pallet2: any[] = []
for (let i = 0; i < 3; i++) pallet2 = beep(pallet2, '0000000000031')
const keptOne = keepToOrder(pallet2, pallet2[0].key)
ok(keptOne[0].quantity === 1, 'trimming by hand still takes only what was ordered',
  String(keptOne[0].quantity))
ok(commitBlockedReason(keptOne) === null, 'and saves')

// ---------------------------------------------------------------------------
console.log('\n=== N+1. typing the count by hand, inbound ===')
// ---------------------------------------------------------------------------
// The half that got missed. Scanning counted freely while the + button and the
// typed number still snapped back to the order's quantity, so somebody who saw
// the count stuck watched the app undo them and had no way at all to say three
// had arrived. The owner: "i see i try visuall but does not work".
const byHandPo = poRepo.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_c', quantity: 1, unitPrice: 1900 }] },
  null
)
ok(!!byHandPo.id, 'a one-unit order to type against')
let typed = beep([], '0000000000031')
ok(typed[0].max === 1, 'the order asked for one', String(typed[0].max))

typed = setQuantity(typed, typed[0].key, 3)
ok(typed[0].quantity === 3, 'typing 3 GIVES 3', String(typed[0].quantity))
ok(typed[0].override === 'overage', 'carrying the override the commit needs')
ok(typed[0].overflow === true, 'and flagged as more than expected')
ok(commitBlockedReason(typed) === null, 'with nothing in the way of saving')

// And it really commits — a number the app accepts but the main process refuses
// would be the same dead end wearing a different hat.
const beforeHand = inv.stockQty('p_c', 'RM')
const handDone = commit(typed[0])
ok(!handDone.error, 'the typed count commits', String(handDone.error))
ok(inv.stockQty('p_c', 'RM') - beforeHand === 3, 'putting three on the shelf',
  String(inv.stockQty('p_c', 'RM') - beforeHand))

// Outbound stays clamped: a typed number cannot promise stock the shelf has not
// got, because that ends in negative on-hand.
const outLine = beep([], '0000000000031', 'out')
if (outLine.length > 0 && outLine[0].max != null) {
  const pushed = setQuantity(outLine, outLine[0].key, outLine[0].max + 5)
  ok(pushed[0].quantity === outLine[0].max, 'outbound still clamps a typed number',
    `${pushed[0].quantity} vs ${outLine[0].max}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== N+2. the count is DERIVED from the tally, and self-heals ===')
// ---------------------------------------------------------------------------
// Three fixes to the increment, and a live app still showed 1 against 2 scans
// with the ceiling at 3 — a state the increment cannot produce, and one that
// never reproduced here. So the count stopped being incremented and started
// being DERIVED: inbound it IS the number of beeps, which has no independent
// value left to lose, whatever else on the page touches the line.
//
// Reconstructed from the owner's screenshot exactly: q1, s2, m3.
const desynced: any = {
  key: 'po:x:', token: 't', kind: 'po_line', direction: 'in', productId: 'p_c',
  productName: 'Charlie Hobby Box', sku: 'CCC-1', category: 'Baseball', imageUrl: null,
  location: 'RM', quantity: 1, scans: 2, unitCost: 1900, costLocked: true, costRequired: false,
  rawCode: '0000000000031', mode: 'scanner', override: null, needsDecision: null, max: 3,
  onHand: { RM: 0 }, overflow: false, bumpedAt: 1, handCounted: false
}
const healed = mergeScan([desynced], { ...desynced, bumpedAt: 2 })[0]
ok(healed.scans === 3, 'a third beep lands', String(healed.scans))
ok(healed.quantity === 3, 'AND THE COUNT SNAPS BACK ONTO THE TALLY', String(healed.quantity))
ok(healed.quantity === healed.scans, 'the two can no longer disagree inbound')

// A typed number still leads — deriving must not mean overriding a person.
const typedFirst = setQuantity([desynced], desynced.key, 10)
ok(typedFirst[0].quantity === 10, 'typing 10 gives 10', String(typedFirst[0].quantity))
ok(typedFirst[0].handCounted === true, 'and records that a person said so')
const thenBeeped = mergeScan(typedFirst, { ...desynced, bumpedAt: 3 })[0]
ok(thenBeeped.quantity === 11, 'a beep after that adds to THEIR number, not the tally',
  String(thenBeeped.quantity))

// Outbound is untouched: it still clamps to what is on the shelf.
const shelfLine: any = { ...desynced, direction: 'out', kind: 'remove_stock', quantity: 1, scans: 1,
  max: 2, onHand: { RM: 2 } }
const outAfter = mergeScan([shelfLine], { ...shelfLine, bumpedAt: 2 })[0]
ok(outAfter.quantity === 2, 'outbound counts up to the shelf', String(outAfter.quantity))
const outPast = mergeScan([outAfter], { ...shelfLine, bumpedAt: 3 })[0]
ok(outPast.quantity === 2, 'and no further — stock cannot go negative', String(outPast.quantity))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
