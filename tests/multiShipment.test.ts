/**
 * ONE PURCHASE, SEVERAL BUYERS.
 *
 * A case of boxes is bought from one distributor and shipped straight out to
 * several people, each of whom needs their own invoice. The purchase board could
 * already express "this ships to a third party"; what it could not do was divide
 * one purchase between more than one of them. `DropshipSaleStep` looked at an
 * order going to two places and REFUSED — "that is 2 separate sales to 2
 * separate people, raise each one from the Sales Orders board" — which was true
 * about the documents and left the retyping and the linking to a person.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE SENTINEL FOLDS. "multi-shipment" typed by hand and left alone is a
 *      dropship to a shop of that name: the order looks right, the assignment
 *      screen never opens, and the sales orders are never raised. The deal is
 *      lost rather than visibly broken, which is the worst kind of wrong.
 *
 *   2. IT IS NOT A SHELF. If `destinationHoldsStock` ever said yes to it, units
 *      would be received against a location called "Multi-shipment" and a
 *      phantom FIFO layer would move the reported cost of real boxes on the real
 *      RM shelf.
 *
 *   3. EVERY UNIT IS ASSIGNED. These boxes are already bought and already
 *      shipping. A unit nobody is assigned is a parcel addressed to nobody and
 *      an invoice that never gets raised — and nothing on screen would say which
 *      one, because the assignment is spent the moment the modal closes.
 *
 *   4. ONE ORDER PER BUYER, NOT PER ROW. Somebody taking two off one line and
 *      three off another is one person owing one amount. Two invoices would bill
 *      the same deal twice and post two documents to QuickBooks for it.
 *
 *   5. ALL OF THEM OR NONE. A half-written batch leaves buyers uninvoiced for
 *      boxes already in the post.
 *
 *   6. THE PURCHASE HOLDS THEM ALL. `linked_invoice_id` is one column and there
 *      are five sales; read through it, a purchase with five buyers reports one
 *      of them with nothing to say the other four exist.
 *
 * Every name here is invented.
 *
 * Run: npm run test:multi-shipment
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/multi-shipment-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const database = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/invoices')
const inventory = require('../src/main/db/inventory')
const {
  MULTI_SHIPMENT,
  buyerKey,
  buyerShares,
  isMultiShipment,
  salesOrdersFromShipment,
  shipmentProblem,
  shipmentRowsFrom,
  unassignedUnits
} = require('../src/shared/multiShipment')
const { canonicalDestination, destinationHoldsStock, orderKindOf } = require('../src/shared/purchaseOrders')

const db = database.getDb()

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

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_ms1', 'MS-1', 'Split Hobby Box', 'Baseball', 40,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('p_ms2', 'MS-2', 'Split Jumbo Box', 'Baseball', 90,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const SOURCES = [
  { key: 's1', productId: 'p_ms1', item: 'Split Hobby Box', sku: 'MS-1', quantity: 10, buyer: null },
  { key: 's2', productId: 'p_ms2', item: 'Split Jumbo Box', sku: 'MS-2', quantity: 3, buyer: null }
]

const row = (sourceKey: string, buyer: string, quantity: number): any => ({
  key: `r-${sourceKey}-${buyer}-${quantity}`,
  sourceKey,
  buyer,
  quantity
})

// ---------------------------------------------------------------------------
console.log('=== 1. the sentinel ===')
// ---------------------------------------------------------------------------
ok(isMultiShipment(MULTI_SHIPMENT), 'the sentinel is itself')
ok(isMultiShipment('multi-shipment'), 'TYPED IN LOWER CASE IT IS STILL THE SENTINEL')
ok(isMultiShipment('  MULTI-SHIPMENT  '), 'and shouted with spaces round it')
ok(!isMultiShipment('Multi Shipment'), 'but a different name is a different name')
ok(!isMultiShipment(''), 'and nothing is not it')
ok(!isMultiShipment(null), 'nor is null')

// The fold, on the OTHER door. A hand-typed spelling stored as-is would leave
// isMultiShipment answering yes while every screen printed something else.
ok(
  canonicalDestination('multi-shipment') === MULTI_SHIPMENT,
  'a hand-typed spelling folds back to the canonical one',
  canonicalDestination('multi-shipment')
)
ok(canonicalDestination('rm') === 'RM', 'and the shelf fold it already did still works')
ok(
  canonicalDestination('Fenwick Cards') === 'Fenwick Cards',
  'while an ordinary name is left alone'
)

/**
 * NOT A SHELF, and this is the assertion that keeps the stock engine safe.
 *
 * `destinationHoldsStock` is the ONE place deciding what may be written to
 * stock. If it ever said yes here, `addStock` — which does not validate its
 * location argument — would open a real FIFO layer keyed to "Multi-shipment",
 * and `syncProductAvgCost` averages lots across ALL locations, so that phantom
 * layer would move the unit cost and the reported margin of boxes physically
 * sitting on the RM shelf.
 */
ok(!destinationHoldsStock(MULTI_SHIPMENT), 'THE SENTINEL IS NOT A SHELF — nothing can be received against it')
ok(!destinationHoldsStock('multi-shipment'), 'in either spelling')
ok(
  orderKindOf(0, 10, MULTI_SHIPMENT) === 'drop',
  'so an order bound for it reads as a dropship',
  orderKindOf(0, 10, MULTI_SHIPMENT)
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. every unit has to be assigned ===')
// ---------------------------------------------------------------------------
const full = [row('s1', 'Alice Trading', 4), row('s1', 'Bob Cards', 6), row('s2', 'Alice Trading', 3)]
ok(shipmentProblem(full, SOURCES) === null, 'a complete assignment is allowed', String(shipmentProblem(full, SOURCES)))

const short = [row('s1', 'Alice Trading', 4), row('s2', 'Alice Trading', 3)]
ok(
  (shipmentProblem(short, SOURCES) ?? '').includes('6 of 10'),
  'SIX UNASSIGNED BOXES ARE REFUSED, and the message says how many',
  String(shipmentProblem(short, SOURCES))
)

const over = [row('s1', 'Alice Trading', 8), row('s1', 'Bob Cards', 6), row('s2', 'Alice Trading', 3)]
ok(
  (shipmentProblem(over, SOURCES) ?? '').includes('4 more'),
  'and so is assigning more than the order bought',
  String(shipmentProblem(over, SOURCES))
)

ok(
  shipmentProblem([row('s1', 'Alice Trading', 10)], SOURCES) !== null,
  'A LINE WITH NOBODY ON IT AT ALL IS REFUSED — those boxes are bought and shipping'
)
ok(
  shipmentProblem([row('s1', '', 10), row('s2', 'Bob Cards', 3)], SOURCES) === 'Every row needs a buyer.',
  'a row with no buyer is refused'
)
ok(
  shipmentProblem([row('s1', MULTI_SHIPMENT, 10), row('s2', 'Bob Cards', 3)], SOURCES) ===
    'Every row needs a buyer.',
  'AND THE SENTINEL IS NOT A BUYER — left in, it would reach QuickBooks as a customer of that name'
)
ok(
  shipmentProblem([row('s1', 'Alice Trading', 0), row('s2', 'Bob Cards', 3)], SOURCES) !== null,
  'a row of zero is refused rather than silently dropped'
)
ok(shipmentProblem([], SOURCES) !== null, 'and nothing at all is not an assignment')

// What the screen sizes a new split row from.
ok(unassignedUnits([row('s1', 'Alice Trading', 4)], SOURCES[0]) === 6, 'six are still to hand out')
ok(unassignedUnits(full, SOURCES[0]) === 0, 'and none once the line is fully assigned')

// ---------------------------------------------------------------------------
console.log('\n=== 3. one order per BUYER, not per row ===')
// ---------------------------------------------------------------------------
const shares = buyerShares(full, SOURCES)
ok(shares.length === 2, 'three rows across two people is two sales orders', String(shares.length))

const alice = shares.find((s: any) => buyerKey(s.buyer) === 'alice trading')
ok(!!alice, 'Alice is one of them')
ok(
  alice?.lines.length === 2 && alice?.units === 7,
  'AND HER TWO ROWS ARE ONE ORDER — four boxes off one line and three off another is one person owing one amount',
  `${alice?.lines.length} lines / ${alice?.units} units`
)
const bob = shares.find((s: any) => buyerKey(s.buyer) === 'bob cards')
ok(bob?.units === 6 && bob?.lines.length === 1, 'and Bob gets only his six', String(bob?.units))

// Case and spacing must not make two people out of one — the name is snapshotted
// onto an invoice and offered to QuickBooks as a customer.
const sloppy = [row('s1', 'Alice Trading', 4), row('s1', '  alice trading ', 6), row('s2', 'Alice Trading', 3)]
const merged = buyerShares(sloppy, SOURCES)
ok(
  merged.length === 1,
  'TWO SPELLINGS OF ONE NAME ARE ONE BUYER — otherwise one deal becomes two customers in QuickBooks',
  String(merged.length)
)
ok(merged[0]?.buyer === 'Alice Trading', 'and the first spelling typed is the one kept', merged[0].buyer)
ok(
  merged[0]?.lines.length === 2 && merged[0]?.units === 13,
  'with every unit on it',
  `${merged[0]?.lines.length} / ${merged[0]?.units}`
)

// Same buyer, same product, twice: one line, not two.
const doubled = buyerShares([row('s1', 'Carla Co', 4), row('s1', 'Carla Co', 6)], [SOURCES[0]])
ok(
  doubled.length === 1 && doubled[0]?.lines.length === 1 && doubled[0]?.lines[0].quantity === 10,
  'the same product twice for the same buyer is ONE line of ten, not two lines to add up'
)

// A row already pre-filled from the purchase order needs no typing at all.
const preAssigned = [
  { key: 'a1', productId: 'p_ms1', item: 'Split Hobby Box', sku: 'MS-1', quantity: 5, buyer: 'Dana Sports' }
]
const preRows = shipmentRowsFrom(preAssigned)
ok(
  preRows.length === 1 && preRows[0].buyer === 'Dana Sports' && preRows[0].quantity === 5,
  'a slice that already names a buyer arrives assigned rather than being asked about again'
)
ok(shipmentProblem(preRows, preAssigned) === null, 'and is immediately valid')

// ---------------------------------------------------------------------------
console.log('\n=== 4. what the sales orders say ===')
// ---------------------------------------------------------------------------
const drafts = salesOrdersFromShipment({
  supplier: 'Invented Distribution Co',
  invoiceDate: '2026-08-21',
  firstNumber: '7100',
  rows: full,
  sources: SOURCES
})
ok(drafts.length === 2, 'two buyers, two orders', String(drafts.length))
ok(drafts[0].customerName === 'Alice Trading', 'the buyer is the CUSTOMER', drafts[0].customerName)
ok(
  drafts[0].invoiceNumber === '7100' && drafts[1].invoiceNumber === '7101',
  'they count up from the suggested number',
  `${drafts[0].invoiceNumber} / ${drafts[1].invoiceNumber}`
)

/**
 * THE ROUTING RULE, and it is the single-buyer one unchanged.
 *
 * Every line carries destination AND supplier, both the party that ships the
 * goods. The header cannot express it: the stock code collapses any header
 * location that is not a real shelf back to RM, so a sales order that said it
 * only on the header would take real boxes off the RM shelf for units this
 * business never held.
 */
const everyLine = drafts.flatMap((d: any) => d.lines)
ok(
  everyLine.every((l: any) => l.destination === 'Invented Distribution Co'),
  'EVERY LINE IS FULFILLED FROM THE SUPPLIER — set on the LINE, because a header that is not a shelf collapses back to RM and would draw real stock'
)
ok(
  everyLine.every((l: any) => l.supplier === 'Invented Distribution Co'),
  'and names who shipped it'
)
ok(
  everyLine.every((l: any) => !drafts.some((d: any) => l.destination === d.customerName)),
  'AND NEVER THE BUYER — on a sales order the destination means fulfilled-FROM, so the buyer there would say they shipped it to themselves'
)
ok(
  everyLine.every((l: any) => l.rate === 0),
  'PRICES ARE NOT CARRIED OVER — what we paid the distributor is not what any of these people pay us'
)
ok(
  everyLine.every((l: any) => !!l.productId && !!l.sku),
  'the product and its SKU travel with every line'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. writing them, all or nothing ===')
// ---------------------------------------------------------------------------
const raise = (): any =>
  poRepo.createPurchaseOrder(
    {
      supplier: 'Invented Distribution Co',
      location: MULTI_SHIPMENT,
      lines: [
        { productId: 'p_ms1', quantity: 10, unitPrice: 40 },
        { productId: 'p_ms2', quantity: 3, unitPrice: 90 }
      ]
    },
    null
  )

const msPo = raise()
ok(msPo.location === MULTI_SHIPMENT, 'the purchase order holds the sentinel', msPo.location)
ok(msPo.orderKind === 'drop', 'and reads as a dropship', msPo.orderKind)
ok(msPo.receivableUnits === 0, 'WITH NOTHING RECEIVABLE — no box ever arrives here', String(msPo.receivableUnits))

const shelfBefore = inventory.stockQty('p_ms1', 'RM')
const written = inv.splitDropshipSales(msPo.id, drafts, null)
ok(written.ok === true, 'the batch is written', String(written.error))
ok(written.created.length === 2, 'two sales orders exist', String(written.created?.length))
ok(
  inventory.stockQty('p_ms1', 'RM') === shelfBefore,
  'AND NO STOCK MOVED — we never held these units'
)

const sales = inv.dropshipSalesFor(msPo.id)
ok(sales.length === 2, 'the purchase order can see BOTH of them', String(sales.length))
ok(
  sales.every((s: any) => s.sourcePoId === msPo.id),
  'and each one points back at it'
)
ok(
  sales.every((s: any) => s.status === 'draft'),
  'THEY ARE DRAFTS — nothing was posted to QuickBooks from one button press'
)
ok(
  sales.every((s: any) => s.total === 0),
  'at zero, waiting for somebody to set each buyer’s own price',
  String(sales.map((s: any) => s.total).join(','))
)
ok(
  sales.every((s: any) => s.lines.every((l: any) => l.dropship === true)),
  'every line reads as a dropship, so none of them is pickable off a shelf'
)
const names = sales.map((s: any) => s.customerName).sort()
ok(
  names.join(' | ') === 'Alice Trading | Bob Cards',
  'one order each, to the two people who bought',
  names.join(' | ')
)
const aliceSale = sales.find((s: any) => s.customerName === 'Alice Trading')
ok(
  aliceSale?.lines.reduce((n: number, l: any) => n + l.quantity, 0) === 7,
  'ALICE IS BILLED FOR HER SEVEN AND NOBODY ELSE’S',
  String(aliceSale?.lines.reduce((n: number, l: any) => n + l.quantity, 0))
)

/**
 * THE FIRST SALE, not the last. `linked_invoice_id` is one column and there are
 * two sales; overwriting it per save would leave every caller still reading it
 * following a different order on each refresh.
 */
ok(
  poRepo.getPurchaseOrder(msPo.id).linkedInvoiceId === written.created[0].id,
  'the purchase order’s single pointer holds the FIRST sale',
  String(poRepo.getPurchaseOrder(msPo.id).linkedInvoiceId)
)

// Both logs, on both documents — the requirement that made this two records.
const poLog = require('../src/main/db/orderExtras').listOrderEvents('po', msPo.id)
ok(
  poLog.filter((e: any) => e.kind === 'link').length === 2,
  'THE PURCHASE ORDER’S LOG NAMES BOTH SALES',
  String(poLog.filter((e: any) => e.kind === 'link').length)
)

// ---- and the rollback -----------------------------------------------------
/**
 * ALL OF THEM OR NONE.
 *
 * The second order in this batch names no customer, which `saveInvoice` refuses.
 * The first is perfectly valid — and must not survive, because a half-written
 * split leaves a buyer uninvoiced for boxes already in the post and the
 * assignment that knew which one is gone the moment the screen closes.
 */
const rollbackPo = raise()
const before = (db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get() as any).n
const bad = inv.splitDropshipSales(
  rollbackPo.id,
  [
    { customerName: 'Eve Collectibles', invoiceDate: '2026-08-21', invoiceNumber: '7200',
      lines: [{ item: 'Split Hobby Box', productId: 'p_ms1', quantity: 4, rate: 0,
                destination: 'Invented Distribution Co', supplier: 'Invented Distribution Co' }] },
    { customerName: '', invoiceDate: '2026-08-21', invoiceNumber: '7201',
      lines: [{ item: 'Split Hobby Box', productId: 'p_ms1', quantity: 6, rate: 0,
                destination: 'Invented Distribution Co', supplier: 'Invented Distribution Co' }] }
  ],
  null
)
ok(bad.ok === false, 'a batch with one bad order fails', String(bad.error))
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM invoices`).get() as any).n === before,
  'AND NOTHING AT ALL IS WRITTEN — not even the valid first one, which would have left a buyer uninvoiced with nothing to say which'
)
ok(
  inv.dropshipSalesFor(rollbackPo.id).length === 0,
  'the purchase order is untouched'
)
ok(
  poRepo.getPurchaseOrder(rollbackPo.id).linkedInvoiceId === null,
  'and carries no pointer'
)

// An empty batch is refused rather than reported as a success that did nothing.
ok(inv.splitDropshipSales(raise().id, [], null).ok === false, 'an empty batch is refused')
ok(
  inv.splitDropshipSales('no-such-po', drafts, null).ok === false,
  'and so is one against a purchase order that is gone'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. the sale-side supplier survives losing its column ===')
// ---------------------------------------------------------------------------
/**
 * The Supplier column came off the sales order form — on a sales order it asked
 * the same question as "Fulfilled from" and got the same answer. The stored
 * FIELD stayed, because `dropshipSuppliersOf` reads it to work out who to raise
 * a purchase order against when a dropship sale is billed before it is bought.
 *
 * Dropping the field with the column would have broken that silently: it would
 * have found no supplier on any line and refused to prefill anything.
 */
const { dropshipSuppliersOf } = require('../src/shared/orders')
const soLines = inv.getInvoice(aliceSale?.id ?? '')?.lines ?? []
ok(
  soLines.every((l: any) => l.supplier === 'Invented Distribution Co'),
  'a dropship line still stores who shipped it'
)
ok(
  dropshipSuppliersOf(soLines).join(',') === 'Invented Distribution Co',
  'SO THE RAISE-A-PURCHASE-ORDER PROMPT STILL FINDS ONE SUPPLIER',
  dropshipSuppliersOf(soLines).join(',')
)

// A line off our own shelf must NOT name a supplier — that would offer to buy
// what we already own.
const shelfSale = inv.saveInvoice(
  {
    customerName: 'Frank Retail',
    invoiceDate: '2026-08-21',
    location: 'RM',
    lines: [{ item: 'Split Hobby Box', productId: 'p_ms1', quantity: 1, rate: 50, destination: 'RM' }]
  },
  null
)
ok(
  dropshipSuppliersOf(inv.getInvoice(shelfSale.id).lines).length === 0,
  'while a sale off our own shelf names none — it is not a dropship and there is nothing to buy'
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. the guards that outlive this suite ===')
// ---------------------------------------------------------------------------
/**
 * READ OFF THE SOURCE, because these rules live in a React component and there
 * is no DOM here to render one into. Every one of them is a rule that fails
 * SILENTLY — no exception, no wrong number, just a form that quietly stores the
 * wrong thing — so a source read is worth more than nothing and is how this repo
 * already pins the board's fulfilment stripe.
 */
const { readFileSync } = require('node:fs')
const soForm = readFileSync('src/renderer/src/modules/invoices/CreateInvoiceModal.tsx', 'utf8')
const poForm = readFileSync('src/renderer/src/modules/invoicing/CreatePurchaseOrderModal.tsx', 'utf8')
const phone = readFileSync('src/renderer/src/styles/mobile.css', 'utf8')

ok(
  !/<th>Supplier<\/th>/.test(soForm),
  'THE SALES ORDER FORM HAS NO SUPPLIER COLUMN — on a sales order it asked the same question as Fulfilled from'
)
ok(/<th>Fulfilled from<\/th>/.test(soForm), 'and keeps Fulfilled from, which is the universal one')
/**
 * The one that M8 caught nothing for until this existed. Removing the column
 * WITHOUT deriving the field would leave every dropship line storing no
 * supplier, and `dropshipSuppliersOf` would then refuse to prefill a purchase
 * order for any sale raised through the form — silently, with an interstitial
 * that just says it cannot proceed.
 */
ok(
  /shipsItself \? null : l\.supplier \|\| from/.test(soForm),
  'AND THE STORED SUPPLIER IS DERIVED FROM IT — dropping the field with the column would break the raise-a-PO prompt silently'
)
ok(
  /const shipsItself = destinationHoldsStock\(from\)/.test(soForm),
  'using destinationHoldsStock, the one place that decides what a shelf is'
)
ok(
  /<th>Supplier<\/th>/.test(poForm) && /Destination for /.test(poForm),
  'WHILE THE PURCHASE ORDER KEEPS BOTH — there they are different parties answering different questions'
)

/**
 * The bug this nearly shipped: mobile.css hides routing columns BY POSITION, and
 * the sales order table is now one column shorter than the purchase order's.
 * Counted the same way, column 6 on the sales form is the BIN — so a phone would
 * have lost the only control that removes a line.
 */
ok(
  /po-lines-so/.test(soForm),
  'the sales order table is told apart from the purchase order table by a class'
)
ok(
  /\.po-lines-so th:nth-child\(6\)/.test(phone),
  'AND THE PHONE LAYER PUTS COLUMN 6 BACK FOR IT — hiding by position would otherwise take the Remove button with the routing column'
)

// The destination picker offers the sentinel on the ORDER and nowhere else: a
// split row exists to name ONE destination for a slice, so "several buyers"
// there is an unsplit line said twice.
const partySelect = readFileSync('src/renderer/src/modules/invoicing/PartySelect.tsx', 'utf8')
ok(
  /multi \? \[\{ label: 'Ships out to buyers', names: \[MULTI_SHIPMENT\] \}\] : \[\]/.test(partySelect),
  'the sentinel is offered only when a caller asks for it'
)
ok(
  (poForm.match(/multi\n/g) ?? []).length + (poForm.match(/^\s+multi$/gm) ?? []).length >= 1,
  'and the purchase order header is the caller that does'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
