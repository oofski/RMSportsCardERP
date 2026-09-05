/**
 * PRICING STOCK FROM THE SHELF REACHES THE PURCHASE ORDER IT CAME IN ON.
 *
 * The owner, about PO-0458: "when I went and I placed the price of this item, it
 * went through and it registered in the inventory correctly. But on the PO, it
 * didn't update ... it's important that when we update the price that we buy it
 * at, it updates the PO that it came through so we know how much the PO [cost].
 * This is just a linkage issue."
 *
 * It was exactly that. Two doors onto one fact and only one of them wired:
 * `setLinePrice` (the roadshow "price it later" flow) did the whole job, and
 * `setZeroCostBasis` (the Inventory zero-cost banner) wrote the product average
 * and the cost layers and stopped — leaving the purchase order reading $0.00 a
 * unit and $0.00 total for a case that cost real money, the COGS row keyed to it
 * untouched, and the cost of goods on anything already sold from that stock
 * still at zero.
 *
 * ## The half that stops this becoming a different bug
 *
 * Section 3. A line that already carries a REAL price must NOT be restated from
 * an inventory screen: that figure is a stated fact about what was agreed, and
 * silently rewriting it is how a closed month moves. The refusal is tested as
 * hard as the fix.
 *
 * Every name here is invented.
 *
 * Run: npm run test:cost-linkage
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/costlink-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const invDb = require('../src/main/db/inventory')
const po = require('../src/main/db/purchaseOrders')
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
   VALUES ('p_c', 'SKU-C', 'Invented Chrome Update Blaster Case', 'Basketball', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const lineOf = (poId: string): any =>
  db
    .prepare(
      `SELECT unit_price, COALESCE(price_pending, 0) AS price_pending
         FROM purchase_order_lines WHERE po_id = ?`
    )
    .get(poId)
const totalOf = (poId: string): number =>
  (db.prepare(`SELECT total FROM purchase_orders WHERE id = ?`).get(poId) as { total: number }).total

/** A roadshow order received at an unknown price — the PO-0458 shape. */
const receivedAtNoPrice = (): string => {
  const made = po.createPurchaseOrder(
    {
      supplier: 'New York Roadshow',
      location: 'RM',
      lines: [{ productId: 'p_c', quantity: 1, unitPrice: 0, pricePending: true }]
    },
    null
  )
  const id = made?.id ?? made?.po?.id ?? made?.data?.id
  po.scanInPurchaseOrder(id, null)
  return id
}

// ---------------------------------------------------------------------------
console.log('=== 1. THE PO-0458 CASE — priced from the shelf, PO left at $0.00 ===')
// ---------------------------------------------------------------------------
const poId = receivedAtNoPrice()
ok(!!poId, 'a roadshow order was received with no price', String(poId))
const before = lineOf(poId)
ok(Number(before.unit_price) === 0, 'the line starts at $0.00', String(before?.unit_price))
ok(totalOf(poId) === 0, 'and so does the order total', String(totalOf(poId)))

// The owner's action: type the cost on the Inventory zero-cost banner.
const fixed = invDb.setZeroCostBasis('p_c', 900)
ok(!!fixed, 'the cost is accepted from the Inventory side')
ok(fixed.costValue > 0, 'and the shelf now carries a cost — this part always worked', String(fixed.costValue))

const after = lineOf(poId)
ok(
  Number(after.unit_price) === 900,
  'AND THE PURCHASE ORDER LINE NOW SAYS $900 — the linkage that was missing',
  String(after.unit_price)
)
ok(
  Number(after.price_pending) === 0,
  'the line is no longer waiting for a price',
  String(after.price_pending)
)
ok(totalOf(poId) === 900, 'AND THE ORDER TOTAL FOLLOWED IT', String(totalOf(poId)))
ok(
  fixed.ordersPriced.linesPriced === 1 && fixed.ordersPriced.ordersRestated === 1,
  'and the result reports what it moved, so the screen can say so',
  JSON.stringify(fixed.ordersPriced)
)

// The COGS row keyed on the order has to move with the total, or Finance reports
// a purchase that cost nothing.
const cogs = db.prepare(`SELECT amount FROM finance_cogs WHERE po_id = ?`).get(poId) as
  | { amount: number }
  | undefined
ok(!cogs || cogs.amount === 900, 'the cost-of-goods row for the order moved too', JSON.stringify(cogs))

// ---------------------------------------------------------------------------
console.log('\n=== 2. STOCK WITH NO ORDER BEHIND IT IS FINE ===')
// ---------------------------------------------------------------------------
// Hand-counted stock has a real cost and no purchase order. Reporting zero here
// is the honest answer, not a failure.
db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_hand', 'SKU-H', 'Invented Hand Counted Box', 'Baseball', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
invDb.addStock('p_hand', 'RM', 4, 0, null)
const hand = invDb.setZeroCostBasis('p_hand', 120)
ok(!!hand && hand.costValue > 0, 'it takes a cost like anything else', String(hand?.costValue))
ok(
  hand.ordersPriced.linesPriced === 0 && hand.ordersPriced.poNumbers.length === 0,
  'and no purchase order is invented for it',
  JSON.stringify(hand.ordersPriced)
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. A LINE THAT ALREADY HAS A REAL PRICE IS NOT RESTATED ===')
// ---------------------------------------------------------------------------
// The refusal that keeps this from becoming a worse bug than the one it fixes.
// A price typed on a purchase order is a stated fact about what was agreed; a
// cost typed on an inventory screen is a statement about a shelf. Where the
// document already says something, the document wins.
db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_d', 'SKU-D', 'Invented Priced Case', 'Football', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
const madePriced = po.createPurchaseOrder(
  {
    supplier: 'Invented Supply Co',
    location: 'RM',
    lines: [{ productId: 'p_d', quantity: 2, unitPrice: 500 }]
  },
  null
)
const pricedId = madePriced?.id ?? madePriced?.po?.id ?? madePriced?.data?.id
po.scanInPurchaseOrder(pricedId, null)
ok(Number(lineOf(pricedId).unit_price) === 500, 'it was bought at $500 a unit', String(lineOf(pricedId).unit_price))

// THE COLLISION HAS TO BE BUILT DELIBERATELY, and an earlier version of this
// test failed to build it: it added a separate zero-cost shelf, which the
// re-base picks up while the PRICED lot from the order is left alone — so the
// guard was never reached and removing it broke nothing. Mutation testing is
// what found that; the test was passing for the wrong reason.
//
// The state that actually reaches the guard is a lot sitting at zero whose
// purchase order line carries a real price. Force exactly that.
db.prepare(`UPDATE inventory_products SET unit_cost = 0 WHERE id = 'p_d'`).run()
db.prepare(
  `UPDATE inventory_lots SET unit_cost = 0
     WHERE id IN (SELECT lot_id FROM po_line_receipts WHERE po_id = ?)`
).run(pricedId)
const rebasedLot = db
  .prepare(
    `SELECT unit_cost FROM inventory_lots
      WHERE id IN (SELECT lot_id FROM po_line_receipts WHERE po_id = ?)`
  )
  .get(pricedId) as { unit_cost: number }
ok(Number(rebasedLot.unit_cost) === 0, 'the order’s own layer is now sitting at zero', String(rebasedLot.unit_cost))

const collided = invDb.setZeroCostBasis('p_d', 111)
ok(!!collided, 'the inventory cost is accepted and the layer is re-based')
ok(
  collided.layersRevalued > 0,
  'AND THAT LAYER IS ONE OF THE ONES RE-BASED — so the guard is genuinely reached',
  String(collided.layersRevalued)
)
ok(
  Number(lineOf(pricedId).unit_price) === 500,
  'AND THE $500 ON THE PURCHASE ORDER IS UNTOUCHED — a stated price is not restated from here',
  String(lineOf(pricedId).unit_price)
)
ok(
  collided.ordersPriced.linesPriced === 0,
  'and nothing reports having priced it',
  JSON.stringify(collided.ordersPriced)
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. THE CATALOG PRICE REACHES THE PO TOO — either door ===')
// ---------------------------------------------------------------------------
// The owner: "if I adjusted the price in inventory that price should be
// automatically fed into the POs ... it can be either or."
//
// AND THE CASE THAT USED TO BE SKIPPED: a product holding BOTH priced and
// unpriced stock. The catalog path used to require the product to have no cost
// anywhere before it would touch the layers, so five cases already costed from
// an old order meant the one roadshow case at zero was silently ignored — the
// one case that needed it. That gate is gone; the layer and line guards are what
// keep it safe.
{
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_mix', 'SKU-M', 'Invented Mixed Basis Case', 'Basketball', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()

  // Stock already carrying a real cost — this is what used to block everything.
  invDb.addStock('p_mix', 'RM', 5, 900, null)
  const basis = db
    .prepare(
      `SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS v
         FROM inventory_lots WHERE product_id = 'p_mix'`
    )
    .get() as { v: number }
  ok(basis.v > 0, 'the product already has a real cost basis — what used to block everything', String(basis.v))

  // And a roadshow case in at no price, on its own purchase order.
  const madeMix = po.createPurchaseOrder(
    {
      supplier: 'New York Roadshow',
      location: 'RM',
      lines: [{ productId: 'p_mix', quantity: 1, unitPrice: 0, pricePending: true }]
    },
    null
  )
  const mixPo = madeMix?.id ?? madeMix?.po?.id ?? madeMix?.data?.id
  po.scanInPurchaseOrder(mixPo, null)
  ok(Number(lineOf(mixPo).unit_price) === 0, 'the roadshow line is at $0.00', String(lineOf(mixPo).unit_price))

  // Type the price into the CATALOG, not the banner.
  invDb.updateProduct({ id: 'p_mix', unitCost: 750 })

  ok(
    Number(lineOf(mixPo).unit_price) === 750,
    'AND THE CATALOG PRICE REACHED THE PURCHASE ORDER — the case the old gate skipped',
    String(lineOf(mixPo).unit_price)
  )
  ok(totalOf(mixPo) === 750, 'and its total followed', String(totalOf(mixPo)))

  // AND THE $900 STOCK IS UNTOUCHED. Only layers carrying nothing are re-based,
  // so a catalog edit still cannot reprice a purchase that already has one.
  const priced = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inventory_lots
        WHERE product_id = 'p_mix' AND ROUND(unit_cost, 2) = 900`
    )
    .get() as { n: number }
  ok(priced.n > 0, 'AND THE $900 LAYERS ARE STILL AT $900 — a catalog edit reprices nothing', String(priced.n))
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. RE-TYPING THE PRICE FIXES AN ORDER ALREADY LEFT AT $0.00 ===')
// ---------------------------------------------------------------------------
// The state the owner's data was actually in, and the one both earlier fixes
// missed: the layer was costed by the OLD code and the purchase order was left
// blank. Re-typing the price used to move nothing — there was no zero-cost layer
// left to re-base, so the push had nothing to push, and PO-0457/PO-0458 were
// stuck at $0.00 with no way back through the app at all.
{
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_stuck', 'SKU-ST', 'Invented Stuck Case', 'Basketball', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  const madeStuck = po.createPurchaseOrder(
    {
      supplier: 'California Roadshow',
      location: 'RM',
      lines: [{ productId: 'p_stuck', quantity: 2, unitPrice: 0, pricePending: true }]
    },
    null
  )
  const stuckPo = madeStuck?.id ?? madeStuck?.po?.id ?? madeStuck?.data?.id
  po.scanInPurchaseOrder(stuckPo, null)

  // EXACTLY what the old code left behind: layer costed, document blank.
  db.prepare(`UPDATE inventory_lots SET unit_cost = 640 WHERE product_id = 'p_stuck'`).run()
  db.prepare(`UPDATE inventory_products SET unit_cost = 640 WHERE id = 'p_stuck'`).run()
  ok(Number(lineOf(stuckPo).unit_price) === 0, 'the order is stuck at $0.00 with the stock costed', String(lineOf(stuckPo).unit_price))

  const repaired = invDb.setZeroCostBasis('p_stuck', 640)
  ok(
    Number(lineOf(stuckPo).unit_price) === 640,
    'AND RE-TYPING THE PRICE NOW REPAIRS IT — the case both earlier fixes missed',
    String(lineOf(stuckPo).unit_price)
  )
  ok(totalOf(stuckPo) === 1280, 'the total is the two units at $640', String(totalOf(stuckPo)))
  ok(
    repaired.ordersPriced.linesPriced === 1,
    'and it reports the line it priced',
    JSON.stringify(repaired.ordersPriced)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. THE PRICE COMES FROM THE LAYER, NOT FROM WHAT WAS TYPED ===')
// ---------------------------------------------------------------------------
// A product bought at different prices on different orders. Handing every blank
// line the newest typed figure would quietly restate what the older one cost, so
// each line takes the cost of the units IT received.
{
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES ('p_two', 'SKU-2', 'Invented Two Prices Case', 'Baseball', 0,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run()
  const mk = (): string => {
    const m = po.createPurchaseOrder(
      {
        supplier: 'Invented Supply Co',
        location: 'RM',
        lines: [{ productId: 'p_two', quantity: 1, unitPrice: 0, pricePending: true }]
      },
      null
    )
    const pid = m?.id ?? m?.po?.id ?? m?.data?.id
    po.scanInPurchaseOrder(pid, null)
    return pid
  }
  const poA = mk()
  const poB = mk()
  // Two layers at two different costs, one per order — as two real deliveries
  // bought at different prices would be.
  const lots = db
    .prepare(
      `SELECT r.po_id, r.lot_id FROM po_line_receipts r
         JOIN purchase_order_lines l ON l.id = r.po_line_id
        WHERE l.product_id = 'p_two'`
    )
    .all() as Array<{ po_id: string; lot_id: string }>
  for (const l of lots) {
    db.prepare(`UPDATE inventory_lots SET unit_cost = ? WHERE id = ?`).run(l.po_id === poA ? 300 : 700, l.lot_id)
  }

  invDb.setZeroCostBasis('p_two', 999)
  ok(
    Number(lineOf(poA).unit_price) === 300,
    'the first order takes ITS layer’s $300, not the $999 typed',
    String(lineOf(poA).unit_price)
  )
  ok(
    Number(lineOf(poB).unit_price) === 700,
    'and the second takes its own $700',
    String(lineOf(poB).unit_price)
  )
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
