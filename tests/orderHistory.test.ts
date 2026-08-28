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
  isSettledPurchaseOrder,
  poColumnOf
} = require('../src/shared/purchaseOrders')
const { INVOICE_SETTLE_DAYS, isSettledInvoice } = require('../src/shared/invoices')
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

/**
 * Stamp an order as FINISHED N milliseconds ago — the boxes here and the
 * supplier settled with, which since the Completed column is what starts the
 * clock. Receipt alone no longer does; see `owed` below.
 */
const completedAgo = (id: string, ms: number): void => {
  db.prepare(
    `UPDATE purchase_orders SET status = 'received', received_at = ?, paid_at = ? WHERE id = ?`
  ).run(agoIso(ms), agoIso(ms), id)
}

const HOUR = 60 * 60 * 1000

// ---------------------------------------------------------------------------
console.log('=== 1. the rule itself ===')
// ---------------------------------------------------------------------------
ok(
  PO_SETTLE_DAYS === 1,
  'a completed order sits in the Completed column for a day',
  String(PO_SETTLE_DAYS)
)
const rule = (over: any): boolean =>
  isSettledPurchaseOrder({
    status: 'received',
    receivedAt: agoIso(3 * DAY),
    paidAt: agoIso(3 * DAY),
    ...over
  })
ok(rule({}) === true, 'three days after it completed it is settled')
ok(rule({ receivedAt: agoIso(2 * HOUR), paidAt: agoIso(2 * HOUR) }) === false, 'two hours after, it is not')
ok(
  rule({ receivedAt: agoIso(1 * DAY + 1000), paidAt: agoIso(1 * DAY + 1000) }) === true,
  'the boundary is one day exactly'
)

/**
 * THE RULE THE OWNER ASKED FOR, stated as its two halves.
 *
 * Neither date on its own finishes an order. Received and unpaid is money still
 * owed on stock already on the shelf — the one combination on this board worth
 * interrupting for — and sweeping it off would file the invoice nobody has paid.
 */
ok(
  rule({ paidAt: null }) === false,
  'RECEIVED AND NOT PAID FOR IS NOT FINISHED — the money is still owed and the card stays'
)
ok(
  rule({ receivedAt: null }) === false,
  'AND PAID FOR WITH NOTHING DELIVERED IS NOT FINISHED EITHER — the boxes are still coming'
)
// The clock starts at the LATER of the two. Taking the earlier would settle an
// order the day it was paid for on stock that only turned up this morning.
ok(
  rule({ receivedAt: agoIso(9 * DAY), paidAt: agoIso(2 * HOUR) }) === false,
  'the clock starts at the LATER date — received last week, paid this morning, still on the board'
)
ok(
  rule({ receivedAt: agoIso(2 * HOUR), paidAt: agoIso(9 * DAY) }) === false,
  'and the same the other way round'
)
ok(rule({ receivedAt: 'not a date' }) === false, 'an unparseable date settles nothing')

// A CANCELLED ORDER SETTLES TOO, on its own date. It used to be exempt because
// there was a Cancelled column for it to sit in; there is not any more, so an
// exempt one would stay on the board for ever.
const cancelled = (over: any): boolean =>
  isSettledPurchaseOrder({
    status: 'cancelled',
    receivedAt: null,
    cancelledAt: agoIso(3 * DAY),
    ...over
  })
ok(cancelled({}) === true, 'a cancelled order files itself away a day later')
ok(
  cancelled({ cancelledAt: agoIso(2 * HOUR) }) === false,
  'BUT NOT THE MINUTE IT IS CANCELLED — the day in Completed is the window to undo a mis-click'
)
ok(
  cancelled({ cancelledAt: null, receivedAt: agoIso(9 * DAY), paidAt: agoIso(9 * DAY) }) === false,
  'and one with no cancellation date recorded stays put rather than settling on its receipt'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the board sweeps, and NOTHING is deleted ===')
// ---------------------------------------------------------------------------
const fresh = raise([{ productId: P1, quantity: 4, unitPrice: 100 }])
const stale = raise([{ productId: P1, quantity: 6, unitPrice: 90 }, { productId: P2, quantity: 2, unitPrice: 300 }])
const live = raise([{ productId: P2, quantity: 3, unitPrice: 280 }])
const owed = raise([{ productId: P1, quantity: 5, unitPrice: 120 }])

completedAgo(fresh.id, 6 * HOUR) // finished this morning
completedAgo(stale.id, 4 * DAY) // finished last week
receivedAgo(owed.id, 4 * DAY) // arrived last week, still not paid for

const board = poRepo.listPurchaseOrders()
const onBoard = (id: string): boolean => board.some((p: any) => p.id === id)
ok(onBoard(live.id), 'an order still in transit is on the board')
ok(onBoard(fresh.id), 'and one that completed this morning is TOO — the correction window')
ok(!onBoard(stale.id), 'ONE THAT COMPLETED FOUR DAYS AGO IS GONE FROM THE BOARD')
ok(
  onBoard(owed.id),
  'AND ONE RECEIVED FOUR DAYS AGO AND STILL UNPAID IS STILL THERE — receipt alone does not finish an order'
)
// Which column each of the survivors is drawn in, so the sweep and the board
// cannot disagree about what "finished" looks like.
const columnOf = (id: string): string | null => {
  const hit = board.find((p: any) => p.id === id)
  return hit ? poColumnOf(hit) : null
}
ok(columnOf(fresh.id) === 'completed', 'the fresh one sits in Completed', String(columnOf(fresh.id)))
ok(columnOf(owed.id) === 'received', 'the unpaid one sits in Received', String(columnOf(owed.id)))
ok(columnOf(live.id) === 'ordered', 'and the in-transit one in Ordered', String(columnOf(live.id)))

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
/**
 * THE TWO SCREENS HAVE TO AGREE, and this is where they used to stop.
 *
 * History built its `settled` flag from the status and the receipt date alone.
 * Once completion needed the payment date too, an order the board had already
 * swept came back here reading as live — so the one screen that can tell you
 * where an order went would have said it was still on a board it had left.
 */
ok(
  find(owed.id)?.settled === false,
  'the received-and-unpaid one is NOT filed here either — it is still on the board and the two screens say the same thing'
)

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
console.log('\n=== 4b. THE SALES BOARD SWEEPS TOO, and nothing is deleted ===')
// ---------------------------------------------------------------------------
/**
 * The owner asked why a sales order does not go to history a day after it is
 * finished, the way a purchase order does. It never did: the sweep was born as a
 * purchase-order feature and the sell-side board — a mirror of the PO board in
 * columns, cards and CSS — was never given one. A paid sales order sat in the
 * Payment column for ever, and 'paid' is terminal, so nobody could move it on.
 *
 * BOTH HALVES, chosen deliberately over "paid alone": money in AND boxes out.
 * An order paid up front on Monday and still on the packing bench on Wednesday
 * is not finished with, and sweeping it off would take work away from the floor
 * rather than clutter.
 */
{
  ok(INVOICE_SETTLE_DAYS === 1, 'a finished sale sits for a day', String(INVOICE_SETTLE_DAYS))

  // --- the rule itself, before any database ---------------------------------
  const settled = (over: any): boolean =>
    isSettledInvoice({
      status: 'paid',
      paidAt: agoIso(4 * DAY),
      lastTrackedAt: agoIso(4 * DAY),
      ...over
    })
  ok(settled({}) === true, 'paid and shipped four days ago is settled')
  ok(settled({ paidAt: null, qboPaidAt: null }) === false, 'NOT PAID IS NOT SETTLED, however long ago it shipped')
  ok(settled({ lastTrackedAt: null }) === false, 'AND NOT SHIPPED IS NOT SETTLED, however long ago it was paid')
  ok(settled({ paidAt: agoIso(2 * HOUR) }) === false, 'the clock runs from the LATER of the two — paid this morning is not settled')
  ok(settled({ lastTrackedAt: agoIso(2 * HOUR) }) === false, 'and neither is shipped this morning')
  ok(settled({ status: 'void' }) === false, 'a void sale never settles — it is already off the board')
  ok(settled({ qboVoided: true }) === false, 'nor one QuickBooks voided, which un-pays it')
  ok(
    settled({ paidAt: null, qboPaidAt: agoIso(4 * DAY) }) === true,
    'PAID IS THE FACT, NOT THE COLUMN — QuickBooks’ own date settles it just as well'
  )
  // The boundary is the day, exactly — the same assertion the buy side carries.
  ok(
    settled({ paidAt: agoIso(DAY + 1000), lastTrackedAt: agoIso(DAY + 1000) }) === true,
    'a second past the day settles'
  )
  ok(
    settled({ paidAt: agoIso(DAY - 60_000), lastTrackedAt: agoIso(DAY - 60_000) }) === false,
    'AND A MINUTE SHORT OF IT DOES NOT — the window is a day, not about a day'
  )
  // A date nothing can parse must settle nothing. Silently reading it as epoch
  // zero would sweep the order off the board the moment it was written.
  ok(settled({ paidAt: 'not a date', qboPaidAt: null }) === false, 'an unparseable paid date settles nothing')
  ok(settled({ lastTrackedAt: 'not a date' }) === false, 'nor an unparseable shipping one')

  // --- and against the real board -------------------------------------------
  inv.addStock(P1, 'RM', 40, 50, 'stock for the sweep', null, null)
  const sale = (number: string): any =>
    invoices.saveInvoice(
      {
        id: null,
        customerName: 'Sweep Buyer',
        invoiceNumber: number,
        invoiceDate: `${thisYear}-06-20`,
        terms: 'Due on receipt',
        location: 'RM',
        lines: [{ item: 'History Hobby Box', productId: P1, quantity: 2, rate: 120, amount: 240 }]
      },
      null
    )
  const payAgo = (id: string, ms: number): void => {
    db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).run(agoIso(ms), id)
  }
  const shipAgo = (id: string, ms: number): void => {
    db.prepare(
      `INSERT INTO order_shipments (id, order_kind, order_id, position, carrier, tracking_number, created_at, updated_at)
       VALUES (?, 'so', ?, 0, 'ups', '1Z999AA10123456784', ?, ?)`
    ).run(`shp_so_${id}_0`, id, agoIso(ms), agoIso(ms))
  }

  const done = sale('SO-9100')
  const justDone = sale('SO-9101')
  const paidNotGone = sale('SO-9102')
  const goneNotPaid = sale('SO-9103')

  payAgo(done.id, 4 * DAY)
  shipAgo(done.id, 4 * DAY)
  payAgo(justDone.id, 6 * HOUR)
  shipAgo(justDone.id, 6 * HOUR)
  payAgo(paidNotGone.id, 4 * DAY) // money in, still on the bench
  shipAgo(goneNotPaid.id, 4 * DAY) // out the door, nobody has paid

  /**
   * A SPLIT SHIPMENT IS OUT THE DOOR WHEN THE LAST BOX IS.
   *
   * Four boxes over two labels: the first went days ago, the second an hour ago.
   * Reading the FIRST parcel would start the settle clock while boxes were still
   * on the bench, and the order would vanish off the board with work left on it.
   */
  const split = sale('SO-9104')
  payAgo(split.id, 4 * DAY)
  shipAgo(split.id, 4 * DAY)
  db.prepare(
    `INSERT INTO order_shipments (id, order_kind, order_id, position, carrier, tracking_number, created_at, updated_at)
     VALUES (?, 'so', ?, 1, 'ups', '1Z999AA10123456785', ?, ?)`
  ).run(`shp_so_${split.id}_1`, split.id, agoIso(HOUR), agoIso(HOUR))

  const board = invoices.listOpenInvoices()
  const onBoard = (id: string): boolean => board.some((i: any) => i.id === id)
  ok(
    onBoard(split.id),
    'A SPLIT SHIPMENT WHOSE SECOND LABEL PRINTED AN HOUR AGO IS STILL ON THE BOARD — the clock runs from the LAST parcel'
  )
  ok(!onBoard(done.id), 'A SALE PAID AND SHIPPED FOUR DAYS AGO IS GONE FROM THE BOARD')
  ok(onBoard(justDone.id), 'one finished this morning is still there — the correction window')
  ok(
    onBoard(paidNotGone.id),
    'AND ONE PAID FOUR DAYS AGO THAT HAS NOT SHIPPED IS STILL THERE — money alone does not finish a sale'
  )
  ok(
    onBoard(goneNotPaid.id),
    'nor does shipping alone, so the unpaid one stays too'
  )

  // THE ASSERTION THAT MAKES THE SWEEP SAFE — the twin of the purchase-order one.
  ok(invoices.getInvoice(done.id) !== null, 'but the order itself still exists')
  ok(invoices.getInvoice(done.id)?.lines.length === 1, 'with its line')
  ok(
    (db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE id = ?`).get(done.id) as any).n === 1,
    'and one row on disk — swept, not deleted'
  )

  /**
   * THE UNFILTERED READ IS STILL UNFILTERED. It is what the CSV export asks when
   * somebody exports without selecting anything, and an export quietly missing
   * finished orders would be a different document from the one its name promises.
   */
  ok(
    invoices.listInvoices().some((i: any) => i.id === done.id),
    'listInvoices — which the export uses — still returns every order'
  )

  // And the history row says where it went.
  const swept = history.listSalesOrderHistory(db, thisYear).find((r: any) => r.id === done.id)
  ok(!!swept, 'the swept order is in the ledger')
  ok(swept.settled === true, 'FLAGGED AS FILED, which is what draws the chip beside its stage')
  const stillUp = history.listSalesOrderHistory(db, thisYear).find((r: any) => r.id === justDone.id)
  ok(stillUp.settled === false, 'while the one still on the board is not')
}

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

// ---------------------------------------------------------------------------
console.log('\n=== 6. where everything came from, and where it went ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "in Finance history, sales orders and purchase orders are good to
 * go — and then what needs to happen is that I can see where everything is
 * coming from."
 *
 * Everything needed to answer that was already stored and none of it reached
 * this screen. A sales order showed what was on it and never where it came
 * from; a purchase order showed what was bought and never who it was sold to.
 *
 * ## Three claims, and all three count
 *
 * A sale can name a purchase in three separate places, and reading only the
 * first — which is what every screen did — misses the two that matter most:
 *
 *   invoice_lines.source_po_id             this LINE's units came out of it
 *   invoice_line_allocations.source_po_id  these CASES of the line did
 *   sale_purchase_links                    this DOCUMENT was supplied by it
 *
 * The second is a split line. The third is every dropship, where the sale and
 * the purchase are one deal and often share no catalog product at all. Both are
 * pinned below, because both are invisible to the naive read.
 */
{
  const P3 = product('Origin Hobby Box', 'HIST-3')
  inv.addStock(P3, 'RM', 40, 50, 'stock for the origin tests', null, null)

  /** A roadshow tab, so the "star it in the picker" branch has something real. */
  const tab = poRepo.createPurchaseOrder(
    {
      supplier: 'Roadshow Wichita',
      location: 'RM',
      ongoing: true,
      lines: [{ productId: P3, quantity: 8, unitPrice: 50 }]
    },
    null
  )
  poRepo.setPurchaseOrderStatus(tab.id, 'received', null)

  // --- a line that names a purchase --------------------------------------
  const fromTab = invoices.saveInvoice(
    {
      customerName: 'Origin Buyer',
      invoiceNumber: 'SO-H100',
      invoiceDate: `${thisYear}-07-01`,
      location: 'RM',
      lines: [{ item: 'Origin Hobby Box', productId: P3, quantity: 3, rate: 200, sourcePoId: tab.id }]
    },
    null
  )
  const soRow = (id: string): any =>
    history.listSalesOrderHistory(db, thisYear).find((r: any) => r.id === id)
  const poRow = (id: string): any =>
    history.listPurchaseOrderHistory(db, thisYear).find((r: any) => r.id === id)

  const origin = soRow(fromTab.id).lines[0].sources
  ok(
    origin.length === 1 && origin[0].poNumber === tab.poNumber,
    'A SALES-ORDER LINE SAYS WHICH PURCHASE ITS UNITS CAME OUT OF — the fact was stored and no history screen showed it',
    JSON.stringify(origin)
  )
  ok(
    origin[0].fromShelf === true && origin[0].where === 'RM',
    'and that it came off our own shelf, which is a different fact from which purchase',
    `${origin[0].fromShelf} / ${origin[0].where}`
  )
  ok(
    origin[0].supplier === 'Roadshow Wichita',
    'named by the shop it was bought from, not by an id',
    String(origin[0].supplier)
  )
  ok(
    poRow(tab.id).suppliedSales.some((s: any) => s.number === 'SO-H100'),
    'AND THE PURCHASE SAYS WHERE ITS GOODS WENT — the half a purchase order could never show',
    JSON.stringify(poRow(tab.id).suppliedSales)
  )
  ok(
    poRow(tab.id).suppliedSales[0].customerName === 'Origin Buyer',
    'with the buyer named, which is the thing somebody is actually looking for'
  )
  ok(
    poRow(tab.id).lines.every((l: any) => l.sources.length === 0),
    'A PURCHASE ORDER LINE REPORTS NO ORIGIN — a purchase IS the origin, and asking it the question is asking the wrong document'
  )

  // --- an ordinary line off the shelf says nothing -------------------------
  const plain = invoices.saveInvoice(
    {
      customerName: 'Ordinary Buyer',
      invoiceNumber: 'SO-H101',
      invoiceDate: `${thisYear}-07-02`,
      location: 'RM',
      lines: [{ item: 'Origin Hobby Box', productId: P3, quantity: 1, rate: 200 }]
    },
    null
  )
  const plainOrigin = soRow(plain.id).lines[0].sources
  ok(
    plainOrigin.length === 1 && plainOrigin[0].fromShelf === true && plainOrigin[0].poId === null,
    'ORDINARY STOCK REPORTS ITSELF AS ORDINARY STOCK — one origin, our shelf, no purchase named',
    JSON.stringify(plainOrigin)
  )
  ok(
    soRow(plain.id).sourcePos.length === 0,
    'and an in-house sale is attached to nothing, which is most sales'
  )

  // --- a SPLIT line: two origins on one line ------------------------------
  /**
   * INVISIBLE TO THE NAIVE READ. The line's own column describes only its first
   * slice, so a history that read it would report three cases off the shelf and
   * silently lose the two that shipped direct.
   */
  const splitSale = invoices.saveInvoice(
    {
      customerName: 'Split Buyer',
      invoiceNumber: 'SO-H102',
      invoiceDate: `${thisYear}-07-03`,
      location: 'RM',
      lines: [{ item: 'Origin Hobby Box', productId: P3, quantity: 5, rate: 200 }]
    },
    null
  )
  db.prepare(`UPDATE invoices SET status = 'sent', qbo_id = 'qbo-h102' WHERE id = ?`).run(
    splitSale.id
  )
  invoices.setInvoiceLineRouting(
    splitSale.id,
    [
      {
        lineId: invoices.getInvoice(splitSale.id).lines[0].id,
        destination: 'RM',
        supplier: null,
        allocations: [
          { quantity: 3, destination: 'RM', sourcePoId: tab.id },
          { quantity: 2, destination: 'Kestrel Cards', sourcePoId: null }
        ]
      }
    ],
    null
  )
  const both = soRow(splitSale.id).lines[0].sources
  ok(
    both.length === 2,
    'A SPLIT LINE REPORTS BOTH ORIGINS — reading the line alone would lose one of them entirely',
    JSON.stringify(both)
  )
  ok(
    both[0].quantity === 3 && both[0].fromShelf === true && both[0].poNumber === tab.poNumber,
    'three off the shelf, out of the roadshow’s cases',
    JSON.stringify(both[0])
  )
  ok(
    both[1].quantity === 2 && both[1].fromShelf === false && both[1].where === 'Kestrel Cards',
    'and two shipped direct by a supplier',
    JSON.stringify(both[1])
  )

  // --- a DROPSHIP attached to a purchase it shares no product with --------
  /**
   * THE OTHER INVISIBLE ONE, and the commonest. A dropship's sale and purchase
   * are one deal; the sale may be a hand-typed line and the purchase a case
   * nobody put in the catalog, so nothing on any line connects them. The link
   * table is the only place that claim lives.
   */
  const dropPo = poRepo.createPurchaseOrder(
    {
      supplier: 'Kestrel Cards',
      location: 'Ordinary Buyer',
      lines: [{ productId: P3, quantity: 2, unitPrice: 60 }]
    },
    null
  )
  const dropSale = invoices.saveInvoice(
    {
      customerName: 'Direct Buyer',
      invoiceNumber: 'SO-H103',
      invoiceDate: `${thisYear}-07-04`,
      location: 'RM',
      lines: [{ item: 'A case nobody catalogued', quantity: 1, rate: 700 }]
    },
    null
  )
  ok(invoices.linkDropshipPair(dropPo.id, dropSale.id, null).ok, 'the pair is linked')
  ok(
    soRow(dropSale.id).sourcePos.some((p: any) => p.poNumber === dropPo.poNumber),
    'A DROPSHIP SALE NAMES THE PURCHASE THAT SUPPLIED IT — no line connects them, so the link table is the only place this lives',
    JSON.stringify(soRow(dropSale.id).sourcePos)
  )
  ok(
    poRow(dropPo.id).suppliedSales.some((s: any) => s.number === 'SO-H103'),
    'and the purchase says so too, in the other direction'
  )
  ok(
    soRow(dropSale.id).lines[0].sources.length === 0,
    'while its hand-typed line reports no origin — it was never stock, so "which shelf" is not a question about it'
  )

  // --- the picker, and what it offers -------------------------------------
  const sources = history.listHistorySources(db)
  const tabSource = sources.find((o: any) => o.poId === tab.id)
  ok(
    !!tabSource && tabSource.saleCount === 2,
    'THE PICKER COUNTS A LINE AND A PER-CASE SPLIT ALIKE — SO-H100 names it on its line, SO-H102 only inside a split, and reading the line alone would have counted one',
    JSON.stringify(tabSource)
  )
  ok(tabSource.roadshow === true, 'and marks a running tab as a roadshow, which is what gets starred')
  ok(
    sources.some((o: any) => o.poId === dropPo.id),
    'A PURCHASE THAT SHARES NO PRODUCT WITH ITS SALE IS STILL OFFERED — that is the dropship, and filtering it out would hide the case this exists for'
  )
  ok(
    !sources.some((o: any) => o.saleCount === 0),
    'AND A PURCHASE THAT SUPPLIED NOTHING IS NOT — a list of every order ever raised would bury the four that answer the question'
  )

  // --- filtering by a source ----------------------------------------------
  const filtered = history.listSalesOrderHistory(db, thisYear, tab.id)
  ok(
    filtered.length === 2 &&
      filtered.every((r: any) => r.number === 'SO-H100' || r.number === 'SO-H102'),
    'FILTERING BY A PURCHASE SHOWS EVERY SALE THAT DREW ON IT, and only those',
    filtered.map((r: any) => r.number).join()
  )
  ok(
    history.listPurchaseOrderHistory(db, thisYear, tab.id).length === 1,
    'and the purchase side narrows to the one purchase being asked about'
  )
  /**
   * THE YEAR IS IGNORED WHILE A SOURCE IS PICKED. What was bought in December is
   * mostly sold in January, so keeping the year on would answer the question
   * with half the answer and nothing on screen to say half was missing.
   */
  ok(
    history.listSalesOrderHistory(db, 1999, tab.id).length === 2,
    'A SOURCE REPLACES THE YEAR RATHER THAN NARROWING INSIDE IT — a December trip is sold in January',
    String(history.listSalesOrderHistory(db, 1999, tab.id).length)
  )
  ok(
    history.listSalesOrderHistory(db, 1999).length === 0,
    'while with no source the year still governs, exactly as it did'
  )

  // --- a void sale supplies nobody ----------------------------------------
  invoices.setInvoiceStatus(splitSale.id, 'void', null)
  ok(
    !poRow(tab.id).suppliedSales.some((s: any) => s.number === 'SO-H102'),
    'A VOIDED SALE DROPS OFF THE PURCHASE THAT SUPPLIED IT — it took nothing and sold nothing, and counting it would have a roadshow claiming a buyer it never had'
  )
  ok(
    history.listHistorySources(db).find((o: any) => o.poId === tab.id).saleCount === 1,
    'and the picker’s count follows it down',
    String(history.listHistorySources(db).find((o: any) => o.poId === tab.id).saleCount)
  )
}

console.log('\n=== the deletion backlog ===')
// ---------------------------------------------------------------------------
/**
 * "CAN YOU SEE IF WE DELETED ANY POs, OR WHERE I CAN SEE WHAT THE ISSUE IS."
 *
 * The answer was nowhere. A board lists what EXISTS, so an order somebody
 * removed left a gap in the number sequence and not one other trace: no name,
 * no date, no total, and — the part that made it unanswerable — no author. The
 * delete path read the operator's identity at the door and then threw it away
 * with a bare `void actorId`, and the comment beside it claimed the event log
 * "is the only place that would still say so" while nothing ever wrote the line.
 *
 * What is pinned here:
 *
 *   1. Deleting a purchase order writes ONE event that outlives it.
 *   2. It carries who, when, what it was called, who it was with, what it was
 *      worth and what stage it was in.
 *   3. Deleting a SALES order does the same.
 *   4. The backlog reads them back — the round trip through the sentence.
 *   5. A delete that is REFUSED writes nothing, so the log never claims a
 *      deletion that did not happen.
 */
{
  const extras = require('../src/main/db/orderExtras')
  const { describeDeletion } = require('../src/shared/orders')

  const before = extras.listDeletedOrders().length

  const doomedProduct = product('Backlog Test Case', 'SKU-BACKLOG')
  const doomed = poRepo.createPurchaseOrder(
    {
      supplier: 'Vanishing Distributors',
      location: 'RM',
      lines: [{ productId: doomedProduct, quantity: 4, unitPrice: 250 }]
    },
    null
  )
  const doomedNumber = poRepo.getPurchaseOrder(doomed.id).poNumber
  ok(poRepo.deletePurchaseOrder(doomed.id, 'u_deleter').ok, 'a purchase order is deleted')

  const log = extras.listDeletedOrders()
  ok(log.length === before + 1, 'THE BACKLOG GREW BY ONE — there is now a record that it existed', String(log.length))
  const row = log[0]
  ok(row.side === 'po', 'and it knows which side it was', String(row.side))
  ok(
    row.number === doomedNumber,
    'IT REMEMBERS THE NUMBER, which until now was only a gap in the sequence',
    `${row.number} vs ${doomedNumber}`
  )
  ok(row.party === 'Vanishing Distributors', 'and the supplier', String(row.party))
  ok(row.units === 4 && Math.round(row.total) === 1000, 'and what was on it, and what it was worth', `${row.units} / ${row.total}`)
  ok(row.stage === 'ordered', 'and the stage it was in when it went', String(row.stage))
  ok(
    row.actorId === 'u_deleter',
    'AND WHO PRESSED IT — the fact the old code read and then discarded with `void actorId`',
    String(row.actorId)
  )
  ok(!!row.deletedAt, 'and when')
  /**
   * THE ORDER IS REALLY GONE. The backlog is a record, not a recycle bin —
   * nothing here undeletes anything, and a row that still resolved to a live
   * purchase order would mean the delete had not happened.
   */
  ok(poRepo.getPurchaseOrder(doomed.id) === null, 'while the order itself is genuinely gone')

  // --- the sales side does the same ---------------------------------------
  const doomedSale = invoices.saveInvoice(
    {
      customerName: 'Vanishing Buyer',
      invoiceNumber: 'SO-GONE1',
      invoiceDate: '2026-08-27',
      location: 'RM',
      lines: [{ item: 'Backlog Test Case', productId: doomedProduct, quantity: 2, rate: 500 }]
    },
    null
  )
  invoices.deleteInvoice(doomedSale.id, 'u_other')
  const saleRow = extras.listDeletedOrders()[0]
  ok(saleRow.side === 'so', 'A DELETED SALES ORDER IS IN THE SAME BACKLOG — one question, not two', String(saleRow.side))
  ok(saleRow.number === 'SO-GONE1' && saleRow.party === 'Vanishing Buyer', 'with its number and its buyer', `${saleRow.number} / ${saleRow.party}`)
  ok(saleRow.actorId === 'u_other', 'and its own author, not the last one', String(saleRow.actorId))
  ok(extras.listDeletedOrders()[1].side === 'po', 'NEWEST FIRST, so the last thing that went is the first thing you see')

  /**
   * THE ROUND TRIP. `describeDeletion` writes the sentence and the read parses
   * it back; the two live in different modules and would drift silently, since
   * a mis-parse produces a plausible-looking row with blanks rather than an
   * error anybody sees.
   */
  const sentence = describeDeletion({
    number: 'PO-9999',
    party: 'Round Trip Supply',
    total: 1234.5,
    units: 7,
    stage: 'paid'
  })
  ok(
    sentence === 'Deleted PO-9999 with Round Trip Supply · 7 units · $1234.50 · was paid',
    'the sentence reads as a person would write it',
    sentence
  )

  /**
   * A REFUSED DELETE WRITES NOTHING. The record goes in the same transaction as
   * the delete, so an order that could not be removed — stock already checked
   * in — must leave the backlog untouched. A log that reports deletions that
   * did not happen is worse than no log.
   */
  const kept = poRepo.createPurchaseOrder(
    {
      supplier: 'Vanishing Distributors',
      location: 'RM',
      lines: [{ productId: doomedProduct, quantity: 2, unitPrice: 250 }]
    },
    null
  )
  poRepo.receivePurchaseOrderLines(
    kept.id,
    [{ lineId: poRepo.getPurchaseOrder(kept.id).lines[0].id, quantity: 2 }],
    null
  )
  const countBefore = extras.listDeletedOrders().length
  const refused = poRepo.deletePurchaseOrder(kept.id, 'u_deleter')
  ok(!refused.ok, 'an order with stock checked in still refuses to be deleted', String(refused.error))
  ok(
    extras.listDeletedOrders().length === countBefore,
    'AND THE BACKLOG DID NOT MOVE — it never claims a deletion that was refused',
    String(extras.listDeletedOrders().length)
  )
  ok(!!poRepo.getPurchaseOrder(kept.id), 'and the order is still there')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
