/**
 * Starting the paperwork over: every order and every deal ticket, deleted.
 *
 * The owner's words: "a hard reset and delete the history of all PO's and deal
 * tickets as well as all the physical PO's, deal tickets and SO's in each of
 * their modules".
 *
 * This is the most destructive thing in the app and it cannot be undone from
 * inside it, so what is pinned here is mostly what it must NOT do:
 *
 *   1. THE SHELF SURVIVES. Deleting ONE sale hands its units back, because that
 *      means it did not happen. Doing that for every sale ever made would put
 *      every unit ever sold back on the shelf and double the warehouse. So a
 *      reset restores nothing — on-hand, the FIFO layers and the inventory
 *      ledger are left exactly as they stand. If that ever inverts, the
 *      valuation on the dashboard doubles overnight and nothing else says why.
 *
 *   2. NOTHING ELSE GOES WITH IT. Products, buyers, suppliers, employees and
 *      the stream history are untouched. A "reset" that took the catalog would
 *      be unrecoverable in a way nobody would have consented to.
 *
 *   3. THE ATTACHMENTS GO. order_events, parcels, uploaded labels and deal
 *      tickets hang off an order by a kind-and-id PAIR with no foreign key —
 *      SQLite cannot express one — so nothing cleans them up. Left behind they
 *      are not harmless: a document row still carries a label's bytes and an
 *      events row still syncs.
 *
 *   4. ALL OR NOTHING. One transaction. A half-applied reset leaves tickets
 *      pointing at documents that are not there, which no screen is written to
 *      survive.
 *
 *   5. THE COUNT ONLY RESTARTS WHEN ASKED. Wiping the documents and restarting
 *      the numbering are two intentions. A number that has been on a supplier's
 *      paperwork must not come round twice by accident.
 *
 * Every name here is invented.
 *
 * Run: npm run test:order-reset
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/order-reset-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb, getMeta } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const inv = require('../src/main/db/invoices')
const invStock = require('../src/main/db/inventory')
const reset = require('../src/main/db/orderReset')
const {
  ORDER_RESET_PHRASE,
  describeOrderReset,
  orderResetArmed,
  orderResetIsEmpty,
  orderResetTotal
} = require('../src/shared/orderReset')
const { DEAL_TICKET_FLOOR } = require('../src/shared/dealTickets')

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

const count = (sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n) || 0

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_r', 'SKU-R', 'Reset Hobby Box', 'Baseball', 50,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
invStock.addStock('p_r', 'RM', 100, 50, null)

// A working month: purchases, sales, a dropship pair, parcels and a log.
for (let i = 0; i < 3; i++) {
  poRepo.createPurchaseOrder(
    {
      supplier: 'Invented Distribution Co',
      location: 'RM',
      lines: [{ productId: 'p_r', quantity: 2, unitPrice: 50 }]
    },
    null
  )
}
for (let i = 0; i < 4; i++) {
  inv.saveInvoice(
    {
      customerName: `Invented Buyer ${i}`,
      invoiceDate: '2026-05-01',
      location: 'RM',
      lines: [{ item: 'Reset Hobby Box', productId: 'p_r', quantity: 3, rate: 120 }]
    },
    null
  )
}
const shipPo = poRepo.createPurchaseOrder(
  {
    supplier: 'Invented Distribution Co',
    location: 'RM',
    lines: [{ productId: 'p_r', quantity: 1, unitPrice: 50 }]
  },
  null
)
require('../src/main/db/orderExtras').saveShipment(
  'po',
  shipPo.id,
  { trackingNumber: '1Z999AA10123456784', carrier: 'ups' },
  null
)

const shelfBefore = invStock.stockQty('p_r', 'RM')
const lotsBefore = count(`SELECT COUNT(*) AS n FROM inventory_lots`)
const txnsBefore = count(`SELECT COUNT(*) AS n FROM inventory_transactions`)
const productsBefore = count(`SELECT COUNT(*) AS n FROM inventory_products`)

// ---------------------------------------------------------------------------
console.log('\n=== 1. the preview counts what the delete deletes ===')
// ---------------------------------------------------------------------------

const before = reset.previewOrderReset()
ok(before.purchaseOrders === 4, 'every purchase order is counted', String(before.purchaseOrders))
ok(before.salesOrders === 4, 'and every sales order', String(before.salesOrders))
ok(before.dealTickets === 8, 'and every deal ticket', String(before.dealTickets))
ok(before.shipments === 1, 'and the parcels', String(before.shipments))
ok(before.events > 0, 'and the log entries', String(before.events))
ok(orderResetTotal(before) === 16, 'the total is the three headline counts', String(orderResetTotal(before)))
ok(!orderResetIsEmpty(before), 'and there is something to do')
ok(
  before.stockUnitsKept > 0,
  'THE PREVIEW STATES WHAT THE SHELF KEEPS, in units — the commonest fear about a button like this is that it empties the warehouse',
  String(before.stockUnitsKept)
)
ok(
  /4 purchase orders, 4 sales orders and 8 deal tickets/.test(describeOrderReset(before)),
  'and it reads as a sentence somebody can check',
  describeOrderReset(before)
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the phrase has to be typed ===')
// ---------------------------------------------------------------------------

ok(orderResetArmed(ORDER_RESET_PHRASE), 'the exact phrase arms it')
ok(orderResetArmed('  delete all orders  '), 'case and surrounding space are forgiven')
ok(!orderResetArmed('delete'), 'half of it does not')
ok(!orderResetArmed(''), 'and nor does nothing')
ok(!orderResetArmed('DELETE ALL ORDER'), 'nor a near miss')

// ---------------------------------------------------------------------------
console.log('\n=== 3. it deletes the documents and everything hanging off them ===')
// ---------------------------------------------------------------------------

const res = reset.applyOrderReset({}, null)
ok(res.ok === true, 'the reset runs', String(res.error))
ok(count(`SELECT COUNT(*) AS n FROM purchase_orders`) === 0, 'no purchase orders left')
ok(count(`SELECT COUNT(*) AS n FROM invoices`) === 0, 'no sales orders left')
ok(count(`SELECT COUNT(*) AS n FROM deal_tickets`) === 0, 'no deal tickets left')
ok(count(`SELECT COUNT(*) AS n FROM order_events`) === 0, 'and no history')
ok(count(`SELECT COUNT(*) AS n FROM order_shipments`) === 0, 'no parcels')
ok(count(`SELECT COUNT(*) AS n FROM order_documents`) === 0, 'no uploaded labels')
// The cascades. Worth asserting rather than trusting: a line orphaned from its
// order is a row nothing lists and nothing can delete.
ok(count(`SELECT COUNT(*) AS n FROM invoice_lines`) === 0, 'invoice lines went with their orders')
ok(
  count(`SELECT COUNT(*) AS n FROM purchase_order_lines`) === 0,
  'and so did purchase order lines'
)
ok(
  count(`SELECT COUNT(*) AS n FROM invoice_stock_moves`) === 0,
  'and the stock-move receipts'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. AND THE SHELF IS EXACTLY WHERE IT WAS ===')
// ---------------------------------------------------------------------------
/**
 * The assertion this whole feature lives or dies on. deleteInvoice hands units
 * back because deleting ONE sale means it did not happen; doing that for every
 * sale would put every unit ever sold back on the shelf. If this ever inverts,
 * the dashboard's valuation doubles overnight and nothing else says why.
 */
ok(
  invStock.stockQty('p_r', 'RM') === shelfBefore,
  'ON-HAND IS UNCHANGED — nothing was handed back',
  `${invStock.stockQty('p_r', 'RM')} vs ${shelfBefore}`
)
ok(
  count(`SELECT COUNT(*) AS n FROM inventory_lots`) === lotsBefore,
  'every FIFO cost layer survives — they reference products, never orders',
  `${count(`SELECT COUNT(*) AS n FROM inventory_lots`)} vs ${lotsBefore}`
)
ok(
  count(`SELECT COUNT(*) AS n FROM inventory_transactions`) === txnsBefore,
  'and so does the inventory ledger'
)
ok(
  count(`SELECT COUNT(*) AS n FROM inventory_products`) === productsBefore,
  'THE CATALOG IS UNTOUCHED — a reset that took the products would be unrecoverable in a way nobody consented to'
)
// The figure the confirmation promised, checked against what actually survived.
// A preview that under-reports what it keeps is the one somebody would act on.
ok(
  reset.previewOrderReset().stockUnitsKept === before.stockUnitsKept,
  'AND THE UNITS THE PREVIEW PROMISED TO KEEP ARE ALL STILL THERE',
  `${reset.previewOrderReset().stockUnitsKept} vs ${before.stockUnitsKept}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. the count only restarts when asked ===')
// ---------------------------------------------------------------------------

const afterWipe = poRepo.createPurchaseOrder(
  {
    supplier: 'Invented Distribution Co',
    location: 'RM',
    lines: [{ productId: 'p_r', quantity: 1, unitPrice: 50 }]
  },
  null
)
const ticketAfter = db
  .prepare(`SELECT number FROM deal_tickets WHERE document_id = ?`)
  .get(afterWipe.id) as { number: string } | undefined
ok(
  !!ticketAfter && ticketAfter.number > 'DT-000344',
  'THE NEXT TICKET CARRIES ON FROM WHERE THE COUNT WAS — a number already on somebody’s paperwork must not come round twice',
  String(ticketAfter?.number)
)

// Asked for explicitly, it goes back to the floor.
reset.applyOrderReset({ restartNumbering: true }, null)
ok(
  Number(getMeta(db, 'deal_ticket_seq')) === DEAL_TICKET_FLOOR,
  'ASKED FOR, the register goes back to its floor',
  String(getMeta(db, 'deal_ticket_seq'))
)
const restarted = poRepo.createPurchaseOrder(
  {
    supplier: 'Invented Distribution Co',
    location: 'RM',
    lines: [{ productId: 'p_r', quantity: 1, unitPrice: 50 }]
  },
  null
)
const firstAgain = db
  .prepare(`SELECT number FROM deal_tickets WHERE document_id = ?`)
  .get(restarted.id) as { number: string } | undefined
ok(
  firstAgain?.number === 'DT-000337',
  'and the first ticket after it is DT-000337 again',
  String(firstAgain?.number)
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. a reset with nothing to do ===')
// ---------------------------------------------------------------------------

reset.applyOrderReset({}, null)
const emptyNow = reset.previewOrderReset()
ok(orderResetIsEmpty(emptyNow), 'an empty register previews as empty')
ok(describeOrderReset(emptyNow) === 'There is nothing to delete.', 'and says so plainly')
const again = reset.applyOrderReset({}, null)
ok(again.ok === true, 'and running it anyway is harmless rather than an error')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
