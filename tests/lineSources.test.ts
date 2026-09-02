/**
 * "Where did these units come from" on a sold line.
 *
 * The owner's ask: "in sales orders I can hover over units and see where they
 * are coming from in terms of inventory". The chain already existed and was
 * unreachable — a sale records the cost layers it consumed, a layer records the
 * purchase order receipt that opened it — so this is a read, not new bookkeeping.
 *
 * ## The assertion that carries the feature
 *
 * Section 2. A line of five drawn from two purchase orders at two prices must
 * report BOTH, with the right units against each. One number on the document
 * covers up to five different facts, and a popover that showed only the first or
 * summed them at one price would be worse than none: it would look like an
 * answer.
 *
 * ## The trap
 *
 * Section 3. `po_line_receipts` holds one row per delivery against a layer, so a
 * layer received in two deliveries has two rows. Joining it doubles every
 * quantity — and these are the same units the P&L counts, so a screen that
 * doubles them starts an argument about whether the books are wrong. The read
 * uses a subquery for exactly this reason and section 3 is what stops somebody
 * "simplifying" it back into a join.
 *
 * Every name here is invented.
 *
 * Run: npm run test:line-sources
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/linesrc-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const inv = require('../src/main/db/invoices')
const invStock = require('../src/main/db/inventory')
const { invoiceLineSources } = require('../src/main/db/lineSources')
const {
  describeLineSources,
  sourceName,
  sourcedCost,
  sourcedUnits
} = require('../src/shared/lineSources')
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

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_s', 'SKU-S', 'Invented Chrome Hobby Case', 'Basketball', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

/**
 * A cost layer that a purchase order opened, wired the way a real receipt wires
 * it — the layer, the order, the line, and the receipt row joining them.
 */
const receiveFromPo = (poNumber: string, qty: number, cost: number, when: string): string => {
  const lot = invStock.addStock('p_s', 'RM', qty, cost, null)
  const lotId =
    typeof lot === 'string'
      ? lot
      : (db
          .prepare(
            `SELECT id FROM inventory_lots WHERE product_id='p_s' AND unit_cost=?
              ORDER BY created_at DESC LIMIT 1`
          )
          .get(cost) as { id: string }).id
  const poId = `po_${poNumber}`
  const lineId = `pol_${poNumber}`
  db.prepare(
    `INSERT INTO purchase_orders (id, po_number, supplier, status, location, total, created_at, updated_at)
     VALUES (?, ?, 'Invented Supply Co', 'received', 'RM', 0, ?, ?)`
  ).run(poId, poNumber, when, when)
  db.prepare(
    `INSERT INTO purchase_order_lines (id, po_id, product_id, quantity, unit_price, position,
                                       created_at, qty_received)
     VALUES (?, ?, 'p_s', ?, ?, 0, ?, ?)`
  ).run(lineId, poId, qty, cost, when, qty)
  db.prepare(
    `INSERT INTO po_line_receipts (id, po_id, po_line_id, lot_id, quantity, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`rcpt_${poNumber}`, poId, lineId, lotId, qty, when)
  // The layer's own age drives the order the sources are listed in, and FIFO
  // consumes them in that order too.
  db.prepare(`UPDATE inventory_lots SET received_at = ? WHERE id = ?`).run(when, lotId)
  return lotId
}

// Two orders, two prices, oldest first — so FIFO takes PO-0001 before PO-0002.
receiveFromPo('PO-0001', 3, 1000, '2026-02-01T00:00:00.000Z')
receiveFromPo('PO-0002', 4, 1500, '2026-03-01T00:00:00.000Z')

// ---------------------------------------------------------------------------
console.log('=== 1. a line that drew one purchase order names it ===')
// ---------------------------------------------------------------------------
const one = inv.saveInvoice(
  {
    customerName: 'Invented Wholesale Co',
    invoiceDate: '2026-04-01',
    location: 'RM',
    lines: [{ item: 'Invented Chrome Hobby Case', productId: 'p_s', quantity: 2, rate: 2000 }]
  },
  null
)
const oneSrc = invoiceLineSources(one.id)
ok(oneSrc.length === 1, 'one line, one entry', String(oneSrc.length))
ok(oneSrc[0].sources.length === 1, 'drawn from a single layer', String(oneSrc[0].sources.length))
ok(oneSrc[0].sources[0].poNumber === 'PO-0001', 'AND IT NAMES THE PURCHASE ORDER', String(oneSrc[0].sources[0].poNumber))
ok(oneSrc[0].sources[0].quantity === 2, 'with the units it took', String(oneSrc[0].sources[0].quantity))
ok(oneSrc[0].sources[0].unitCost === 1000, 'and what each one cost', String(oneSrc[0].sources[0].unitCost))
ok(oneSrc[0].sources[0].location === 'RM', 'and the shelf it left', oneSrc[0].sources[0].location)

// ---------------------------------------------------------------------------
console.log('\n=== 2. A LINE SPANNING TWO ORDERS REPORTS BOTH ===')
// ---------------------------------------------------------------------------
// One case left on PO-0001 and four on PO-0002. A sale of three crosses the
// boundary, which is the case the whole feature exists for: "3" on the document
// is one case at $1,000 and two at $1,500, and nothing ever showed that.
const two = inv.saveInvoice(
  {
    customerName: 'Invented Wholesale Co',
    invoiceDate: '2026-04-02',
    location: 'RM',
    lines: [{ item: 'Invented Chrome Hobby Case', productId: 'p_s', quantity: 3, rate: 2000 }]
  },
  null
)
const twoSrc = invoiceLineSources(two.id)[0]
ok(twoSrc.sources.length === 2, 'TWO SOURCES FOR ONE LINE', String(twoSrc.sources.length))
ok(twoSrc.sources[0].poNumber === 'PO-0001', 'the older layer first, as FIFO took it', String(twoSrc.sources[0].poNumber))
ok(twoSrc.sources[0].quantity === 1, 'one case off the old order', String(twoSrc.sources[0].quantity))
ok(twoSrc.sources[1].poNumber === 'PO-0002', 'then the newer one', String(twoSrc.sources[1].poNumber))
ok(twoSrc.sources[1].quantity === 2, 'for the other two', String(twoSrc.sources[1].quantity))
ok(sourcedUnits(twoSrc) === 3, 'THE UNITS SUM TO THE LINE — never more, never fewer', String(sourcedUnits(twoSrc)))
// 1 x 1000 + 2 x 1500 = 4000. The line's real COGS, which no screen showed.
ok(sourcedCost(twoSrc) === 4000, 'and the cost is the layers, not an average', String(sourcedCost(twoSrc)))
ok(/2 places/.test(describeLineSources(twoSrc)), 'the sentence says it came from two places', describeLineSources(twoSrc))
ok(/\$4,000\.00/.test(describeLineSources(twoSrc)), 'and what it cost', describeLineSources(twoSrc))

// ---------------------------------------------------------------------------
console.log('\n=== 3. A LAYER RECEIVED TWICE MUST NOT DOUBLE THE UNITS ===')
// ---------------------------------------------------------------------------
// po_line_receipts holds one row per delivery, so a second row against the same
// layer is ordinary. Joining that table instead of sub-selecting from it returns
// the layer twice and doubles the quantity — against the same numbers the P&L
// reports. This is what stops the join coming back.
const lot2 = (db
  .prepare(`SELECT lot_id FROM po_line_receipts WHERE po_id='po_PO-0002'`)
  .get() as { lot_id: string }).lot_id
db.prepare(
  `INSERT INTO po_line_receipts (id, po_id, po_line_id, lot_id, quantity, created_at)
   VALUES ('rcpt_second', 'po_PO-0002', 'pol_PO-0002', ?, 1, '2026-03-02T00:00:00.000Z')`
).run(lot2)
const afterDouble = invoiceLineSources(two.id)[0]
ok(
  afterDouble.sources.length === 2,
  'a layer with two receipt rows is still ONE source',
  String(afterDouble.sources.length)
)
ok(
  sourcedUnits(afterDouble) === 3,
  'AND THE UNITS ARE STILL THREE — the number on the document',
  String(sourcedUnits(afterDouble))
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. stock with no purchase order behind it ===')
// ---------------------------------------------------------------------------
// Counted in by hand, or carried over. It has a real cost and no order, and
// saying so beats hiding it — a total that silently drops units is worse.
invStock.addStock('p_s', 'AM', 2, 800, null)
const hand = inv.saveInvoice(
  {
    customerName: 'Invented Wholesale Co',
    invoiceDate: '2026-04-03',
    location: 'AM',
    lines: [{ item: 'Invented Chrome Hobby Case', productId: 'p_s', quantity: 2, rate: 1900 }]
  },
  null
)
const handSrc = invoiceLineSources(hand.id)[0]
ok(handSrc.sources.length === 1, 'the hand-counted layer is reported', String(handSrc.sources.length))
ok(handSrc.sources[0].poNumber === null, 'with no purchase order', String(handSrc.sources[0].poNumber))
ok(
  sourceName(handSrc.sources[0]) === 'No purchase order',
  'AND IS NAMED FOR WHAT IT IS, not "unknown" — the cost and shelf are known',
  sourceName(handSrc.sources[0])
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. a line that took nothing says so ===')
// ---------------------------------------------------------------------------
const drop = inv.saveInvoice(
  {
    customerName: 'Invented Wholesale Co',
    invoiceDate: '2026-04-04',
    location: 'RM',
    lines: [
      {
        item: 'Invented Chrome Hobby Case',
        productId: 'p_s',
        quantity: 2,
        rate: 2000,
        destination: 'Fenwick Distribution',
        supplier: 'Invented Supply Co'
      }
    ]
  },
  null
)
ok(invoiceLineSources(drop.id).length === 0, 'a dropship has no sources — it touched no shelf')
// An empty popover is indistinguishable from one that failed to load.
ok(
  /drop-shipped/i.test(describeLineSources(null)),
  'and the empty case gets a sentence rather than a blank',
  describeLineSources(null)
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
