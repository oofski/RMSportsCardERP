/**
 * The year's ledger of orders, and the two-day sweep that fills it.
 *
 * A board is a place where work is done. A purchase order that has been received
 * and settled has no work left on it, so it leaves the board two days after the
 * boxes land and lands in History instead.
 *
 * The three things that would each be a disaster if they were wrong:
 *
 *   1. NOTHING IS DELETED. "Get rid of it" means off the board, and off the
 *      board only. The order, its lines, its dates and the FIFO cost layers its
 *      receipts opened all stay exactly where they were — a purchase order is
 *      the document every layer's cost basis points at, and deleting one would
 *      leave stock on a shelf with nothing to say what it cost.
 *
 *   2. THE SWEEP IS TWO DAYS, NOT ZERO. An order received an hour ago is the
 *      one most likely to need a correction: a short shipment turns up the next
 *      morning, a scan gets fixed, a price does not match the invoice. It stays
 *      on the board until that window has passed.
 *
 *   3. THE HISTORY IS THE WHOLE YEAR. It would read more tidily as "the board
 *      has the live work, history has the rest", and it would be wrong the first
 *      time somebody looks up an order that happens to be in transit.
 *
 * The dates here are written directly into the database rather than waited for,
 * because a suite that needs two days to run is a suite nobody runs.
 *
 * Run: npm run test:order-history
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/order-history-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const invoices = require('../src/main/db/invoices')
const inv = require('../src/main/db/inventory')
const history = require('../src/main/db/orderHistory')
const {
  PO_SETTLE_DAYS,
  isSettledPurchaseOrder
} = require('../src/shared/purchaseOrders')
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

const DAY = 24 * 60 * 60 * 1000
const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString()
const thisYear = new Date().getFullYear()

const product = (name: string, sku: string): string =>
  inv.createProduct(
    {
      sku,
      upc: null,
      name,
      category: 'Baseball',
      brand: 'Invented',
      setName: '',
      year: '2026',
      unitType: 'box',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 0,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null
    },
    null
  ).id

const P1 = product('History Hobby Box', 'HIST-1')
const P2 = product('History Jumbo Box', 'HIST-2')

const raise = (lines: Array<{ productId: string; quantity: number; unitPrice: number }>): any =>
  poRepo.createPurchaseOrder({ supplier: 'Invented Distributors', location: 'RM', lines }, null)

/** Stamp an order as received N milliseconds ago, the way time would have. */
const receivedAgo = (id: string, ms: number): void => {
  db.prepare(`UPDATE purchase_orders SET status = 'received', received_at = ? WHERE id = ?`).run(
    agoIso(ms),
    id
  )
}

// ---------------------------------------------------------------------------
console.log('=== 1. the rule itself ===')
// ---------------------------------------------------------------------------
ok(PO_SETTLE_DAYS === 2, 'a received order stays on the board for two days', String(PO_SETTLE_DAYS))
const rule = (over: any): boolean =>
  isSettledPurchaseOrder({ status: 'received', receivedAt: agoIso(3 * DAY), ...over })
ok(rule({}) === true, 'three days after receipt it is settled')
ok(rule({ receivedAt: agoIso(1 * DAY) }) === false, 'one day after, it is not')
ok(rule({ receivedAt: agoIso(2 * DAY + 1000) }) === true, 'the boundary is two days exactly')
ok(rule({ receivedAt: null }) === false, 'an order that never arrived is never settled')
ok(
  rule({ status: 'cancelled' }) === false,
  'AND A CANCELLED ORDER IS NEVER SWEPT — cancelling is reversible, and it belongs where somebody can see it'
)
ok(rule({ receivedAt: 'not a date' }) === false, 'an unparseable date settles nothing')
// Keyed on the timestamp rather than the status, because an order can be both
// received AND paid and `status` only holds one of the two.
ok(
  isSettledPurchaseOrder({ status: 'paid', receivedAt: agoIso(5 * DAY) }) === true,
  'a received order marked paid still settles'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the board sweeps, and NOTHING is deleted ===')
// ---------------------------------------------------------------------------
const fresh = raise([{ productId: P1, quantity: 4, unitPrice: 100 }])
const stale = raise([{ productId: P1, quantity: 6, unitPrice: 90 }, { productId: P2, quantity: 2, unitPrice: 300 }])
const live = raise([{ productId: P2, quantity: 3, unitPrice: 280 }])

receivedAgo(fresh.id, 6 * 60 * 60 * 1000) // this morning
receivedAgo(stale.id, 4 * DAY) // last week

const board = poRepo.listPurchaseOrders()
const onBoard = (id: string): boolean => board.some((p: any) => p.id === id)
ok(onBoard(live.id), 'an order still in transit is on the board')
ok(onBoard(fresh.id), 'and one received this morning is TOO — the correction window')
ok(!onBoard(stale.id), 'ONE RECEIVED FOUR DAYS AGO IS GONE FROM THE BOARD')

// THE ASSERTION THAT MAKES THE SWEEP SAFE.
ok(poRepo.getPurchaseOrder(stale.id) !== null, 'but the order itself still exists')
ok(poRepo.getPurchaseOrder(stale.id)?.lines.length === 2, 'with both of its lines')
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM purchase_orders WHERE id = ?`).get(stale.id) as any).n === 1,
  'and one row on disk — swept, not deleted'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. history is the whole year, live orders included ===')
// ---------------------------------------------------------------------------
const pos = history.listPurchaseOrderHistory(db, thisYear)
const find = (id: string): any => pos.find((p: any) => p.id === id)
ok(pos.length >= 3, 'every order raised this year is listed', String(pos.length))
ok(!!find(stale.id), 'the settled one is here — this is where it went')
ok(!!find(live.id), 'AND SO IS THE LIVE ONE — a ledger of the year is a ledger of the year')
ok(find(stale.id)?.settled === true, 'the settled one says so on the row')
ok(find(live.id)?.settled === false, 'and the live one does not')

// Sorted by number descending, so the newest order is the first row — which is
// what "based off number" means when you are looking for the last one you did.
const numbers = pos.map((p: any) => p.number)
ok(
  JSON.stringify(numbers) === JSON.stringify([...numbers].sort().reverse()),
  'ordered by PO number, newest first',
  JSON.stringify(numbers.slice(0, 4))
)

// The row carries what somebody actually looks up.
const row = find(stale.id)
ok(row.supplier === 'Invented Distributors', 'the supplier is on the row')
ok(row.destination === 'RM', 'and where it went')
ok(row.unitsOrdered === 8, 'and the units ordered', String(row.unitsOrdered))
ok(row.total === 6 * 90 + 2 * 300, 'and what it cost', String(row.total))
ok(typeof row.date === 'string' && row.date.length === 10, 'filed under a plain date', row.date)

// And the lines travel WITH it, so expanding a row is not a second round trip.
ok(row.lines.length === 2, 'both lines come down with the row', String(row.lines.length))
ok(row.lines[0].item === 'History Hobby Box', 'named', row.lines[0]?.item)
ok(row.lines[0].sku === 'HIST-1', 'with its SKU', row.lines[0]?.sku)
ok(row.lines[0].quantity === 6 && row.lines[0].unitPrice === 90, 'quantity and unit price')
ok(row.lines[0].amount === 540, 'and the line amount', String(row.lines[0]?.amount))

// A year with nothing in it is empty rather than an error.
ok(history.listPurchaseOrderHistory(db, 1999).length === 0, 'a year with no orders is empty')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the sales side ===')
// ---------------------------------------------------------------------------
inv.addStock(P1, 'RM', 10, 50, 'stock to sell', null, null)
const buyer = invoices.saveCustomer({ id: null, name: 'History Buyer', terms: 'Net 30' })
const so = invoices.saveInvoice(
  {
    id: null,
    customerId: buyer.id,
    customerName: 'History Buyer',
    invoiceNumber: 'SO-9001',
    invoiceDate: `${thisYear}-06-15`,
    terms: 'Net 30',
    location: 'RM',
    lines: [
      { item: 'History Hobby Box', productId: P1, quantity: 4, rate: 120, amount: 480 },
      { item: 'Grading fee', productId: null, quantity: 1, rate: 25, amount: 25 }
    ]
  },
  null
)
const sos = history.listSalesOrderHistory(db, thisYear)
const soRow = sos.find((r: any) => r.id === so.id)
ok(!!soRow, 'the sales order is in the ledger')
ok(soRow.number === 'SO-9001', 'under its number', soRow?.number)
ok(soRow.customerName === 'History Buyer', 'with the buyer')
ok(soRow.total === 505, 'and the total', String(soRow?.total))
ok(soRow.unitsSold === 5, 'units on the document', String(soRow?.unitsSold))
ok(soRow.unitsOut === 4, 'and units that actually left the shelf', String(soRow?.unitsOut))
// The cost is the FIFO layers those four boxes came from — 4 × $50.
ok(soRow.cost === 200, 'costing what those exact boxes cost', String(soRow?.cost))
ok(soRow.margin === 305, 'so the margin is the subtraction', String(soRow?.margin))
ok(soRow.lines.length === 2, 'both lines travel with it')
// A line that was never stock has no "how many went out" — null, not zero,
// which would read as "none of it shipped".
ok(soRow.lines[1].settledQty === null, 'a service line reports no units out', String(soRow.lines[1]?.settledQty))

// A void order stays in the record. Somebody wrote it, and "why is there a gap
// between 9001 and 9003" is exactly what a history is for.
invoices.setInvoiceStatus(so.id, 'void', null)
const afterVoid = history
  .listSalesOrderHistory(db, thisYear)
  .find((r: any) => r.id === so.id)
ok(!!afterVoid, 'A VOID ORDER IS STILL IN THE LEDGER')
ok(afterVoid.status === 'void', 'flagged as void', afterVoid?.status)
ok(afterVoid.margin === null, 'and reports NO margin rather than its whole total as profit', String(afterVoid?.margin))

// ---------------------------------------------------------------------------
console.log('\n=== 5. the year picker reads the data ===')
// ---------------------------------------------------------------------------
const years = history.orderHistoryYears(db)
ok(years.purchase.includes(thisYear), 'this year has purchase orders in it')
ok(years.sales.includes(thisYear), 'and sales orders')
ok(
  JSON.stringify(years.purchase) === JSON.stringify([...years.purchase].sort((a: number, b: number) => b - a)),
  'newest first',
  JSON.stringify(years.purchase)
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
