/**
 * MONEY ON A PURCHASE ORDER THAT BOUGHT NO GOODS.
 *
 * The owner: "sometimes there might be like inventory that we add that is not
 * actual inventory ... like we wired some 5000 but actually paid them 4900
 * because of another deal ... add a line item as like a payment adjustment that
 * doesnt tie back to inventory but just we can add nothing to discrepancy."
 *
 * A credit carried over from a previous deal, a shortfall settled on the next
 * wire, a rebate. It changes what the ORDER cost and what was paid, and it must
 * change nothing that lands on a shelf.
 *
 * ## The two halves, and section 3 is the one that matters
 *
 * Section 2 is the easy half: the total moves, the COGS row keyed on the order
 * moves with it, and removing the adjustment puts both back exactly.
 *
 * Section 3 is the half that would be a silent disaster. An adjustment must NOT
 * reach a FIFO cost layer. A lot is costed at its LINE's unit price at the
 * moment of receipt, so a credit on the order cannot make the cases on the shelf
 * cheaper — if it ever did, every sale drawn from them would report the wrong
 * profit, and nothing on any screen would say why. It is asserted directly
 * against `inventory_lots` rather than through any figure that could be derived
 * from the total, because a derived figure could hide the very substitution this
 * is watching for.
 *
 * Every supplier and product name here is invented.
 *
 * Run: npm run test:po-adjustment
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/poadj-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
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
   VALUES ('p_case', 'SKU-CASE', 'Invented Chrome Update Blaster Case', 'Basketball', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const totalOf = (poId: string): number =>
  (db.prepare('SELECT total FROM purchase_orders WHERE id = ?').get(poId) as { total: number }).total
const cogsOf = (poId: string): number => {
  const row = db.prepare('SELECT amount FROM finance_cogs WHERE po_id = ?').get(poId) as
    | { amount: number }
    | undefined
  return row ? row.amount : NaN
}

/** Five cases at $1,000 — the owner's wired-$5,000 shape. */
const wiredFiveThousand = (): string => {
  const made = po.createPurchaseOrder(
    {
      supplier: 'Invented Card Distributors',
      location: 'RM',
      lines: [{ productId: 'p_case', quantity: 5, unitPrice: 1000 }]
    },
    null
  )
  return made.id
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. the owner’s case: wired 5,000, actually paid 4,900 ===')
// ---------------------------------------------------------------------------
{
  const id = wiredFiveThousand()
  ok(totalOf(id) === 5000, 'the order comes to 5,000 before anything is adjusted', String(totalOf(id)))

  const res = po.addPoAdjustment(id, -100, 'Credit from the March deal', null)
  ok(!res.error, 'a credit is accepted', res.error ?? '')
  ok(totalOf(id) === 4900, 'and the order now says what was actually paid', String(totalOf(id)))

  const rows = res.order.adjustments
  ok(rows.length === 1, 'it is one row on the order, not a change to a line', String(rows.length))
  ok(rows[0].amount === -100, 'carrying the signed amount', String(rows[0].amount))
  ok(
    rows[0].note === 'Credit from the March deal',
    'AND THE REASON, which is the part somebody needs six months later',
    String(rows[0].note)
  )

  // THE LINES ARE UNTOUCHED. The whole design is that this is not a line — if
  // the adjustment had been folded into one, the cases would each read $980.
  const line = db.prepare('SELECT quantity, unit_price FROM purchase_order_lines WHERE po_id = ?').get(id) as any
  ok(
    line.quantity === 5 && line.unit_price === 1000,
    'the five cases still say 1,000 each — the credit was not spread into them',
    `${line.quantity} × ${line.unit_price}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. the total and the COGS row move together, both ways ===')
// ---------------------------------------------------------------------------
{
  const id = wiredFiveThousand()
  ok(cogsOf(id) === 5000, 'COGS starts at the order total', String(cogsOf(id)))

  const added = po.addPoAdjustment(id, -250, 'Rebate', null)
  ok(totalOf(id) === 4750 && cogsOf(id) === 4750, 'a credit moves the total AND the ledger row', `${totalOf(id)}/${cogsOf(id)}`)

  // A CHARGE IS THE SAME FACT THE OTHER WAY. One signed column, so nothing
  // downstream has to ask which kind it is holding.
  po.addPoAdjustment(id, 75.5, 'Wire fee settled later', null)
  ok(totalOf(id) === 4825.5, 'a charge adds', String(totalOf(id)))
  ok(cogsOf(id) === 4825.5, 'and the ledger follows it too', String(cogsOf(id)))

  const two = po.getPurchaseOrder(id).adjustments
  ok(two.length === 2, 'two reasons stay two rows rather than netting into one', String(two.length))

  po.removePoAdjustment(added.order.adjustments[0].id)
  ok(totalOf(id) === 5075.5, 'removing one puts back exactly what it took', String(totalOf(id)))
  ok(cogsOf(id) === 5075.5, 'in the ledger as well', String(cogsOf(id)))
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. IT NEVER REACHES A COST LAYER ===')
// ---------------------------------------------------------------------------
// The silent-disaster case. A lot is costed at its LINE's unit price when it is
// received; an adjustment on the order must not move it, or every sale drawn
// from those layers reports the wrong profit and no screen says why.
{
  const id = wiredFiveThousand()
  const lineId = (db.prepare('SELECT id FROM purchase_order_lines WHERE po_id = ?').get(id) as any).id
  po.receivePoLine(db, lineId, 5, null, null)

  const lotsBefore = db
    .prepare(
      `SELECT lot.id, lot.unit_cost, lot.qty_received, lot.qty_remaining
         FROM po_line_receipts r JOIN inventory_lots lot ON lot.id = r.lot_id
        WHERE r.po_id = ?`
    )
    .all(id) as any[]
  ok(lotsBefore.length > 0, 'the receipt opened a cost layer', String(lotsBefore.length))
  ok(
    lotsBefore.every((l) => l.unit_cost === 1000),
    'costed at the line price',
    lotsBefore.map((l) => l.unit_cost).join(',')
  )

  po.addPoAdjustment(id, -100, 'Credit from the March deal', null)

  const lotsAfter = db
    .prepare(
      `SELECT lot.id, lot.unit_cost, lot.qty_received, lot.qty_remaining
         FROM po_line_receipts r JOIN inventory_lots lot ON lot.id = r.lot_id
        WHERE r.po_id = ?`
    )
    .all(id) as any[]
  ok(
    JSON.stringify(lotsAfter) === JSON.stringify(lotsBefore),
    'THE LAYERS ARE BYTE-FOR-BYTE UNCHANGED — the cases on the shelf did not get cheaper',
    JSON.stringify(lotsAfter)
  )
  ok(totalOf(id) === 4900, 'while the order still says what was paid', String(totalOf(id)))

  // And the product's average cost, which is what the valuation screens read.
  const avg = (db.prepare('SELECT unit_cost FROM inventory_products WHERE id = ?').get('p_case') as any).unit_cost
  ok(avg === 1000, 'and the catalog average is untouched', String(avg))
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. what it refuses ===')
// ---------------------------------------------------------------------------
{
  const id = wiredFiveThousand()
  const before = totalOf(id)

  // ZERO IS REFUSED. A row that changes no figure and explains nothing, and the
  // commonest way to write one is a half-typed number.
  const zero = po.addPoAdjustment(id, 0, 'nothing', null)
  ok(!!zero.error, 'zero is refused rather than stored', zero.error ?? '(accepted)')
  ok(totalOf(id) === before, 'and nothing moved')

  const nan = po.addPoAdjustment(id, Number.NaN, null, null)
  ok(!!nan.error, 'so is a value that is not a number', nan.error ?? '(accepted)')

  const gone = po.addPoAdjustment('no-such-order', -50, null, null)
  ok(!!gone.error && gone.order === null, 'an order that is gone says so', gone.error ?? '')

  // A CANCELLED ORDER HAS NO BILL LEFT TO CORRECT — its COGS row has already
  // been voided, the same reason the shipping editor refuses one.
  po.setPurchaseOrderStatus(id, 'cancelled', null)
  const cancelled = po.addPoAdjustment(id, -50, 'too late', null)
  ok(!!cancelled.error, 'and a cancelled order refuses', cancelled.error ?? '(accepted)')

  // Rounding: money is money, so a third of a dollar is not storable.
  const id2 = wiredFiveThousand()
  po.addPoAdjustment(id2, -100.005, null, null)
  ok(totalOf(id2) === 4899.99 || totalOf(id2) === 4900, 'an amount is rounded to the cent', String(totalOf(id2)))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
