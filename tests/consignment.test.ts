/**
 * STOCK THIS BUSINESS STILL OWNS AND NO LONGER HAS.
 *
 * The owner's words: "for cases of certain cards I can mark it as I have sent
 * that case to consignment ... a popup that just lets me say who I gave it to
 * ... and basically if something is in consignment means we cannot use it for
 * streaming or for selling it."
 *
 * ## The one assertion this whole feature rests on
 *
 * Section 2. A consigned case CANNOT BE SOLD AND CANNOT BE BROKEN, and not
 * because either path was taught about consignment — neither knows the word.
 * Sending consumes the cost lots exactly as a break or a giveaway does, so the
 * units are not in a lot, and `consumeFifo` cannot find what is not there.
 *
 * That is worth testing directly rather than trusting, because the alternative
 * design — a `consigned` flag plus a guard in applyInvoiceStock, plus one in
 * addItem, plus one in the scan queue — is the one where the guard somebody
 * forgets is the one that bills a customer for a case in another shop. If this
 * section ever goes red, the model has been changed to that one.
 *
 * ## And the round trip has to be free
 *
 * Section 3. A case that comes back goes into the EXACT layers it left, at the
 * exact price. Re-costing a return at today's average would be a different
 * number, and a shelf that quietly changed value while a box sat in a van.
 *
 * Every name here is invented.
 *
 * Run: npm run test:consignment
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/consign-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const inventory = require('../src/main/db/inventory')
const consign = require('../src/main/db/consignment')
const invoices = require('../src/main/db/invoices')
const streaming = require('../src/main/db/streaming')
const {
  consignedCost,
  consignedUnits,
  consignmentSummary,
  settleRefusal,
  validateConsignment
} = require('../src/shared/consignment')

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
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, unit_type,
                                   boxes_per_case, packs_per_box, created_at, updated_at)
   VALUES ('p_c', 'SKU-C', 'Consign Hobby Case', 'Baseball', 0, 'case', 12, 12,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const onHand = (loc = 'RM'): number => inventory.stockQty('p_c', loc)
const layers = (): Array<{ id: string; qty: number; cost: number }> =>
  (
    db
      .prepare(
        `SELECT id, qty_remaining AS qty, unit_cost AS cost FROM inventory_lots
          WHERE product_id = 'p_c' AND location = 'RM'
          ORDER BY received_at ASC, rowid ASC`
      )
      .all() as any[]
  ).map((r) => ({ id: r.id, qty: Number(r.qty), cost: Number(r.cost) }))

// TWO LAYERS AT TWO PRICES. One layer would let a wrong cost pass unnoticed —
// every figure would be the same number whichever way it was computed.
inventory.addStock('p_c', 'RM', 2, 1000, null)
inventory.addStock('p_c', 'RM', 3, 1500, null)
ok(onHand() === 5, 'five cases on the RM shelf', String(onHand()))

// ---------------------------------------------------------------------------
console.log('=== 1. sending it out ===')
// ---------------------------------------------------------------------------
ok(
  validateConsignment({ productId: 'p_c', consignee: '', location: 'RM', quantity: 1 }, 5) !== null,
  'a consignment with nobody to give it to is refused'
)
ok(
  validateConsignment({ productId: 'p_c', consignee: 'X', location: 'RM', quantity: 0 }, 5) !== null,
  'and so is one of nothing'
)
ok(
  validateConsignment({ productId: 'p_c', consignee: 'X', location: 'RM', quantity: 9 }, 5) !== null,
  'MORE THAN THE SHELF HOLDS IS REFUSED HERE, while somebody is looking at the box — it would otherwise throw inside consumeFifo with a message about cost lots'
)
ok(
  validateConsignment({ productId: 'p_c', consignee: 'X', location: 'AM', quantity: 1 }, 0) !== null,
  'and a shelf with nothing on it says so rather than quoting a number'
)
ok(
  validateConsignment({ productId: 'p_c', consignee: 'X', location: 'RM', quantity: 5 }, 5) === null,
  'exactly what is there is fine'
)

const sent = consign.sendOnConsignment(
  { productId: 'p_c', consignee: 'Fenwick Card Shop', location: 'RM', quantity: 3 },
  'emp_owner'
)
ok(!sent.error, 'three cases go out on consignment', String(sent.error))
ok(sent.consignment.consignee === 'Fenwick Card Shop', 'to the shop that was named')
ok(sent.consignment.status === 'out', 'and it is out')

// THE SHELF IS DOWN BY THREE. Not flagged — gone.
ok(onHand() === 2, 'THE SHELF IS DOWN TO TWO', String(onHand()))
ok(
  layers().reduce((n, l) => n + l.qty, 0) === 2,
  'AND SO ARE THE COST LAYERS — the invariant the whole FIFO engine rests on',
  JSON.stringify(layers())
)

// FIFO, OLDEST FIRST: both $1,000 cases and one of the $1,500s.
ok(
  Math.abs(sent.consignment.costTotal - 3500) < 0.005,
  'costed off the layers it actually took — 2 × 1000 + 1 × 1500',
  String(sent.consignment.costTotal)
)
ok(
  Math.abs(sent.consignment.unitCost - 3500 / 3) < 0.01,
  'with a per-unit figure divided down from that, never the product average',
  String(sent.consignment.unitCost)
)
// Filtered to layers with something in them: consumeFifo empties a layer to
// zero rather than deleting it, and the spent $1,000 row is still there.
ok(
  layers().filter((l) => l.qty > 0).every((l) => l.cost === 1500),
  'and what is LEFT is the dearer layer',
  JSON.stringify(layers())
)

// The ledger stays the one complete account of what happened to a product.
const txns = db
  .prepare(`SELECT type, quantity_change, counterparty FROM inventory_transactions
             WHERE product_id = 'p_c' ORDER BY rowid DESC LIMIT 1`)
  .all() as any[]
ok(txns[0].quantity_change === -3, 'the stock ledger records three going out', String(txns[0].quantity_change))
ok(
  txns[0].type === 'adjustment',
  'AS AN ADJUSTMENT, NOT A SALE — no money changed hands, and calling it revenue would put a sale in the P&L that nobody made',
  txns[0].type
)
ok(txns[0].counterparty === 'Fenwick Card Shop', 'against the consignee')

// ---------------------------------------------------------------------------
console.log('\n=== 2. IT CANNOT BE SOLD AND IT CANNOT BE BROKEN ===')
// ---------------------------------------------------------------------------
/**
 * Neither path was taught the word "consignment". They cannot reach these units
 * because the units are not in a lot. See the header.
 */
const sale = invoices.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-06-01',
    location: 'RM',
    lines: [{ item: 'Consign Hobby Case', productId: 'p_c', quantity: 5, rate: 2000 }]
  },
  null
)
const soldLine = invoices.getInvoice(sale.id).lines[0]
ok(
  onHand() === 0,
  'a sale for five draws only the two that are here',
  String(onHand())
)
ok(
  soldLine.qtyFulfilled === 2,
  'THE CONSIGNED THREE COULD NOT BE SOLD — applyInvoiceStock takes MIN(asked, on hand) and there were two',
  String(soldLine.qtyFulfilled)
)
ok(
  soldLine.qtyOutstanding === 3,
  'so three are still owed on the order rather than quietly billed off somebody else’s shelf',
  String(soldLine.qtyOutstanding)
)

// Put the two back so the stream half starts from a known shelf.
invoices.setInvoiceStatus(sale.id, 'void', null)
ok(onHand() === 2, 'voiding the sale puts its two back', String(onHand()))

/**
 * A LIVE session, not a past-dated one.
 *
 * The first draft of this test typed in a show for June 2026 and addItem
 * refused the break with "that show is already history, so its stock is long
 * gone" — a refusal that has nothing to do with consignment. It would have gone
 * green while proving nothing, which is the worst kind of passing test: the
 * assertion said "the consigned three are not on the shelf to rip" and the
 * reason was the date.
 */
const show = streaming.startSession({ title: 'Consignment test show', hostId: null, note: null }, null)
ok(show.ok, 'a show is live to break on', show.error ?? '')
const tooMany = streaming.addItem(
  { sessionId: show.data.id, kind: 'break', productId: 'p_c', location: 'RM', quantity: 5 },
  null
)
ok(
  !tooMany.ok,
  'AND A BREAK FOR FIVE IS REFUSED — the three with Fenwick are not on the shelf to rip',
  JSON.stringify(tooMany).slice(0, 120)
)
ok(onHand() === 2, 'and the refusal moved nothing', String(onHand()))

const two = streaming.addItem(
  { sessionId: show.data.id, kind: 'break', productId: 'p_c', location: 'RM', quantity: 2 },
  null
)
ok(two.ok, 'while the two that ARE here break fine', JSON.stringify(two).slice(0, 100))
ok(onHand() === 0, 'taking the shelf to nothing', String(onHand()))

// ---------------------------------------------------------------------------
console.log('\n=== 3. it comes back into the layers it left ===')
// ---------------------------------------------------------------------------
const back = consign.settleConsignment(sent.consignment.id, 'returned', 'emp_owner')
ok(!back.error, 'the consignment comes back', String(back.error))
ok(back.consignment.status === 'returned', 'and says so')
ok(onHand() === 3, 'THREE CASES ARE BACK ON THE SHELF', String(onHand()))

const after = layers()
ok(
  Math.abs(after.reduce((n, l) => n + l.qty * l.cost, 0) - 3500) < 0.005,
  'AT THE EXACT PRICES THEY LEFT AT — 2 × 1000 + 1 × 1500, not today’s average',
  JSON.stringify(after)
)
ok(
  after[0].cost === 1000 && after[0].qty === 2,
  'and in the exact layers, so FIFO order is what it would have been had the case never gone',
  JSON.stringify(after)
)

// APPEND-ONLY. The sending entry is not deleted; the opposite one is written,
// so either column sums to zero over a round trip.
const both = db
  .prepare(`SELECT SUM(quantity_change) AS n FROM inventory_transactions
             WHERE product_id = 'p_c' AND type = 'adjustment' AND counterparty = 'Fenwick Card Shop'`)
  .get() as any
ok(Number(both.n) === 0, 'the ledger sums to zero over the round trip', String(both.n))

// ---------------------------------------------------------------------------
console.log('\n=== 4. it can only be settled once ===')
// ---------------------------------------------------------------------------
const again = consign.settleConsignment(sent.consignment.id, 'returned', 'emp_owner')
ok(
  !!again.error,
  'A SECOND RETURN IS REFUSED — it would put a second copy of the units on the shelf, which is what a double click does',
  String(again.error)
)
ok(onHand() === 3, 'and the shelf is untouched by the refusal', String(onHand()))
ok(settleRefusal('returned') !== null, 'the shared rule says the same')
ok(settleRefusal('sold') !== null, 'about a sold one too')
ok(settleRefusal('out') === null, 'and an open one may still be settled')

// SOLD MOVES NO STOCK. The case is genuinely gone; its cost left when it was
// sent and stays gone.
const outAgain = consign.sendOnConsignment(
  { productId: 'p_c', consignee: 'Harborline Cards', location: 'RM', quantity: 1 },
  null
)
ok(!outAgain.error, 'one goes out to somebody else', String(outAgain.error))
const shelfWhileOut = onHand()
const soldOff = consign.settleConsignment(outAgain.consignment.id, 'sold', null)
ok(soldOff.consignment.status === 'sold', 'and they sell it')
ok(
  onHand() === shelfWhileOut,
  'MARKING IT SOLD MOVES NO STOCK — the case went when it was sent',
  `${shelfWhileOut} -> ${onHand()}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. what the screen reads ===')
// ---------------------------------------------------------------------------
const rows = consign.consignmentsForProduct('p_c')
ok(rows.length === 2, 'both consignments are on the product’s history', String(rows.length))
ok(
  consignedUnits(rows) === 0,
  'NOTHING IS COUNTED AS OUT — one came back and one sold, and counting either would double what the business believes it owns',
  String(consignedUnits(rows))
)
ok(consignmentSummary(rows, 'case') === null, 'so the card draws no line at all')

const live = consign.sendOnConsignment(
  { productId: 'p_c', consignee: 'Fenwick Card Shop', location: 'RM', quantity: 2 },
  null
)
ok(!live.error, 'two go out again', String(live.error))
const now = consign.consignmentsForProduct('p_c')
ok(consignedUnits(now) === 2, 'two units are out', String(consignedUnits(now)))
ok(consignedCost(now) > 0, 'carrying real money', String(consignedCost(now)))
ok(
  consignmentSummary(now, 'case') === '2 cases with Fenwick Card Shop',
  'and the line names who has them',
  String(consignmentSummary(now, 'case'))
)
ok(
  consign.listOpenConsignments().some((c: any) => c.id === live.consignment.id),
  'the open list carries it'
)
ok(
  consign.consignedUnitsByProduct()['p_c'] === 2,
  'and the whole-catalog roll-up agrees, in ONE read rather than one per row',
  String(consign.consignedUnitsByProduct()['p_c'])
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
