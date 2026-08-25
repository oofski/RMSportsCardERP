/**
 * Editing a purchase order that already exists.
 *
 * The feedback, in the owner's team's own words: "Need to add ability to edit
 * PO completely", and — looking straight at a receipt that said "No supplier" —
 * "PO says no supplier, how do I change it to a name?"
 *
 * A PO was very nearly write-once. Lines could be ADDED, freight and payment
 * could be edited, and everything else about the document was fixed at
 * creation: a wrong quantity, a wrong price or a missing supplier meant
 * cancelling the order and retyping it under a new number.
 *
 * ## What must NOT become editable, and why each one is a different rule
 *
 * The refusals here are the whole point of the feature. Opening a document up
 * is easy; the work is knowing which parts are load-bearing.
 *
 *   1. QUANTITY MAY NOT FALL BELOW WHAT LANDED. Units on the shelf came from
 *      this line. Typing a smaller number does not send them back — it just
 *      makes the document disagree with the building.
 *
 *   2. UNIT PRICE FREEZES THE MOMENT ANYTHING IS RECEIVED, and this is the
 *      stricter rule. Receiving stamps the price into a FIFO cost lot, and that
 *      lot is what every future sale of those units is costed against. Editing
 *      the line afterwards moves the header total and the COGS row while
 *      leaving the lot where it is, so the order claims one cost and the stock
 *      carries another. Section 4 is that assertion.
 *
 *   3. A LINE WITH STOCK AGAINST IT CANNOT BE REMOVED. Deleting the row would
 *      leave units on a shelf whose origin cannot be explained.
 *
 *   4. THE LAST LINE CANNOT BE REMOVED. An order with nothing on it is not a
 *      corrected order, it is a deleted one wearing a number.
 *
 * ## And the one thing that is deliberately editable in EVERY state
 *
 * The supplier. It has no money attached — no total, no lot, no ledger row —
 * and the commonest moment to notice the name is missing is while filing an
 * order that is already closed. Section 2 pins that, including what it does to
 * lines that inherit it.
 *
 * Every name here is invented.
 *
 * Run: npm run test:po-edit
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/poedit-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const po = require('../src/main/db/purchaseOrders')
const db = getDb()
const ACTOR = null

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

const product = (id: string, sku: string, name: string): void => {
  db.prepare(
    `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
     VALUES (?, ?, ?, 'Baseball', 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, sku, name)
}
product('p_a', 'SKU-A', '2026 Topps Chrome Baseball Hobby Box')
product('p_b', 'SKU-B', '2026 Bowman Draft Jumbo Case')

const cogsFor = (id: string): number | null =>
  (db.prepare('SELECT amount FROM finance_cogs WHERE po_id = ?').get(id) as
    | { amount: number }
    | undefined)?.amount ?? null

const make = (supplier: string | null = 'Steel City'): any =>
  po.createPurchaseOrder(
    {
      supplier,
      location: 'RM',
      lines: [
        { productId: 'p_a', quantity: 4, unitPrice: 25 },
        { productId: 'p_b', quantity: 2, unitPrice: 50 }
      ]
    },
    ACTOR
  )

// ---------------------------------------------------------------------------
console.log('=== 1. quantity and price, on an order nothing has arrived on ===')
// ---------------------------------------------------------------------------
const order = make()
ok(order.total === 200, 'the order starts at 4 × 25 + 2 × 50', String(order.total))
ok(cogsFor(order.id) === 200, 'and the ledger agrees', String(cogsFor(order.id)))

const lineA = order.lines.find((l: any) => l.productId === 'p_a')
const lineB = order.lines.find((l: any) => l.productId === 'p_b')

const qtyUp = po.updatePurchaseOrderLine(order.id, lineA.id, { quantity: 10 })
ok(!qtyUp.error, 'a quantity can be raised', String(qtyUp.error))
ok(qtyUp.po.lines.find((l: any) => l.id === lineA.id).quantity === 10, 'to the number typed')
ok(qtyUp.po.total === 350, 'AND THE HEADER TOTAL FOLLOWS — 10 × 25 + 2 × 50', String(qtyUp.po.total))
ok(cogsFor(order.id) === 350, 'and so does the ledger row, in place', String(cogsFor(order.id)))

const priceDown = po.updatePurchaseOrderLine(order.id, lineA.id, { unitPrice: 20 })
ok(!priceDown.error, 'a price can be corrected', String(priceDown.error))
ok(priceDown.po.total === 300, 'the total follows that too — 10 × 20 + 2 × 50', String(priceDown.po.total))
ok(cogsFor(order.id) === 300, 'and the ledger again', String(cogsFor(order.id)))

// The COGS row is UPDATED, never re-booked. A second row would double-count the
// order, and a re-booked one would move the spend into the month of the edit.
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM finance_cogs WHERE po_id = ?').get(order.id) as { n: number })
    .n === 1,
  'THERE IS STILL EXACTLY ONE COGS ROW — editing restates it, it does not re-book it'
)

ok(
  !!po.updatePurchaseOrderLine(order.id, lineA.id, { quantity: 0 }).error,
  'a quantity of zero is refused — that is a removal, and it has its own rules'
)
ok(
  !!po.updatePurchaseOrderLine(order.id, lineA.id, { unitPrice: -1 }).error,
  'and a negative price is refused'
)
ok(
  !!po.updatePurchaseOrderLine(order.id, 'not-a-line', { quantity: 3 }).error,
  'a line that is not on this order is refused rather than silently created'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. the supplier, which is what was actually asked for ===')
// ---------------------------------------------------------------------------
const nameless = make(null)
ok(nameless.supplier === null, 'an order can be raised with no supplier at all')

const named = po.updatePurchaseOrderHeader(nameless.id, { supplier: 'Fenwick Distribution' })
ok(!named.error, 'AND THE NAME CAN BE PUT ON AFTERWARDS', String(named.error))
ok(named.po.supplier === 'Fenwick Distribution', 'reading back as typed', String(named.po.supplier))
ok(
  named.po.lines.every((l: any) => l.supplier === 'Fenwick Distribution'),
  'and every line that never named its own supplier follows the header',
  JSON.stringify(named.po.lines.map((l: any) => l.supplier))
)

// A line that names a DIFFERENT vendor is not touched by a header rename. This
// is the whole reason lines store the inheritance rather than a copy.
db.prepare('UPDATE purchase_order_lines SET supplier = ? WHERE id = ?').run(
  'Braddock Cards',
  nameless.lines[1].id
)
const renamed = po.updatePurchaseOrderHeader(nameless.id, { supplier: 'Steel City' })
const after = renamed.po.lines
ok(after[0].supplier === 'Steel City', 'a renamed header carries the inheriting line with it')
ok(
  after[1].supplier === 'Braddock Cards',
  'AND LEAVES A LINE THAT NAMED ITS OWN VENDOR ALONE',
  String(after[1].supplier)
)

// A line whose explicit value ends up matching the new header collapses back to
// inheriting. Otherwise the two say the same thing by coincidence and drift
// apart at the NEXT rename, which is the drift the inheritance exists to avoid.
const echo = make('Old Vendor')
db.prepare('UPDATE purchase_order_lines SET supplier = ? WHERE po_id = ?').run('New Vendor', echo.id)
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ? AND supplier IS NOT NULL').get(echo.id) as any).n === 2,
  'both lines start out naming a vendor explicitly'
)
const collapsed = po.updatePurchaseOrderHeader(echo.id, { supplier: 'New Vendor' })
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ? AND supplier IS NOT NULL').get(echo.id) as any).n === 0,
  'AND COLLAPSE BACK TO INHERITING once the header says the same thing',
  JSON.stringify(collapsed.po.lines.map((l: any) => l.supplier))
)
ok(
  collapsed.po.lines.every((l: any) => l.supplier === 'New Vendor'),
  'while still reading as that vendor, because inheriting resolves to it'
)
// And they follow the header from then on, which is what collapsing bought.
ok(
  po
    .updatePurchaseOrderHeader(echo.id, { supplier: 'Third Vendor' })
    .po.lines.every((l: any) => l.supplier === 'Third Vendor'),
  'so the NEXT rename carries them too'
)

// Notes travel the same route, and clearing is a real value rather than a no-op.
const noted = po.updatePurchaseOrderHeader(echo.id, { notes: 'Split shipment, second half Friday.' })
ok(noted.po.notes === 'Split shipment, second half Friday.', 'the note can be written')
ok(po.updatePurchaseOrderHeader(echo.id, { notes: '' }).po.notes === null, 'and cleared')
ok(
  po.updatePurchaseOrderHeader(echo.id, {}).po.supplier === 'Third Vendor',
  'an empty patch changes nothing rather than blanking the row'
)
ok(!!po.updatePurchaseOrderHeader('nope', { supplier: 'X' }).error, 'an unknown order is refused')

// ---------------------------------------------------------------------------
console.log('\n=== 3. removing a line ===')
// ---------------------------------------------------------------------------
const trim = make()
const trimA = trim.lines[0]
const gone = po.removePurchaseOrderLine(trim.id, trimA.id)
ok(!gone.error, 'a line can be taken off', String(gone.error))
ok(gone.po.lines.length === 1, 'leaving the rest of the order', String(gone.po.lines.length))
ok(gone.po.total === 100, 'and the total is restated to 2 × 50', String(gone.po.total))
ok(cogsFor(trim.id) === 100, 'with the ledger following', String(cogsFor(trim.id)))

ok(
  !!po.removePurchaseOrderLine(trim.id, gone.po.lines[0].id).error,
  'THE LAST LINE CANNOT GO — an empty order is a deleted one wearing a number'
)
ok(po.getPurchaseOrder(trim.id).lines.length === 1, 'so the order still has its line')

// ---------------------------------------------------------------------------
console.log('\n=== 4. once stock has landed, the money stops moving ===')
// ---------------------------------------------------------------------------
// The rule that matters most. A received unit is costed against a FIFO lot
// carrying the price at receive time; letting the line be edited afterwards
// would leave the order and the valuation disagreeing with each other.
const landed = make()
const landedA = landed.lines.find((l: any) => l.productId === 'p_a')
const recv = po.receivePurchaseOrderLines(
  landed.id,
  [{ lineId: landedA.id, quantity: 2 }],
  ACTOR
)
ok(!recv.error, 'two of the four arrive', String(recv.error))
const partly = po.getPurchaseOrder(landed.id)
const partlyA = partly.lines.find((l: any) => l.id === landedA.id)
ok(partlyA.qtyReceived === 2, 'and are recorded against the line', String(partlyA.qtyReceived))

const lotCost = (
  db
    .prepare(`SELECT unit_cost AS c FROM inventory_lots WHERE product_id = 'p_a' ORDER BY rowid DESC LIMIT 1`)
    .get() as { c: number } | undefined
)?.c
ok(lotCost === 25, 'the cost lot carries the price they were bought at', String(lotCost))

const repriced = po.updatePurchaseOrderLine(landed.id, landedA.id, { unitPrice: 99 })
ok(!!repriced.error, 'THE PRICE IS NOW FROZEN — it cannot be edited under the stock')
ok(
  /already been received/i.test(String(repriced.error)),
  'and the refusal says why, naming the units',
  String(repriced.error)
)
ok(
  po.getPurchaseOrder(landed.id).lines.find((l: any) => l.id === landedA.id).unitPrice === 25,
  'the stored price is untouched'
)
ok(cogsFor(landed.id) === 200, 'AND THE LEDGER DID NOT MOVE EITHER', String(cogsFor(landed.id)))

// Quantity is the softer rule: it may not go BELOW what landed, but it may move.
const tooFew = po.updatePurchaseOrderLine(landed.id, landedA.id, { quantity: 1 })
ok(!!tooFew.error, 'a quantity below what has already been checked in is refused')
ok(
  /cannot go below 2/i.test(String(tooFew.error)),
  'naming the number it cannot go below',
  String(tooFew.error)
)
const exactly = po.updatePurchaseOrderLine(landed.id, landedA.id, { quantity: 2 })
ok(!exactly.error, 'DOWN TO EXACTLY WHAT LANDED IS ALLOWED — a short delivery, closed out', String(exactly.error))
ok(
  po.getPurchaseOrder(landed.id).lines.find((l: any) => l.id === landedA.id).quantity === 2,
  'and the line now says what actually came'
)

const killLanded = po.removePurchaseOrderLine(landed.id, landedA.id)
ok(!!killLanded.error, 'A LINE WITH STOCK AGAINST IT CANNOT BE REMOVED')
ok(
  /already on the shelf/i.test(String(killLanded.error)),
  'because those units would have no origin left',
  String(killLanded.error)
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. a closed or cancelled order refuses edits to what was bought ===')
// ---------------------------------------------------------------------------
const closed = make()
po.setPurchaseOrderStatus(closed.id, 'received', ACTOR)
ok(po.getPurchaseOrder(closed.id).status === 'received', 'an order can be closed')
ok(
  !!po.updatePurchaseOrderLine(closed.id, closed.lines[0].id, { quantity: 9 }).error,
  'and then refuses a line edit'
)
ok(!!po.removePurchaseOrderLine(closed.id, closed.lines[0].id).error, 'and a removal')
// The exception, and it is the one the feedback asked for.
const lateName = po.updatePurchaseOrderHeader(closed.id, { supplier: 'Named Late' })
ok(!lateName.error, 'BUT THE SUPPLIER CAN STILL BE PUT ON', String(lateName.error))
ok(lateName.po.supplier === 'Named Late', 'because a name has no money attached')

const dead = make()
po.setPurchaseOrderStatus(dead.id, 'cancelled', ACTOR)
ok(
  !!po.updatePurchaseOrderLine(dead.id, dead.lines[0].id, { quantity: 9 }).error,
  'a cancelled order refuses a line edit — its cost is out of the ledger'
)
ok(!!po.removePurchaseOrderLine(dead.id, dead.lines[0].id).error, 'and a removal')
ok(
  !po.updatePurchaseOrderHeader(dead.id, { supplier: 'Filed Later' }).error,
  'while its paperwork can still be corrected for the records'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. the receipt can be read ===')
// ---------------------------------------------------------------------------
// The other half of the report — "Also cant read anything" — was a CSS bug, so
// it is asserted at the source. A product name ellipsed to "2025 Topp…" in a
// 110px column renders nine different products as nine identical strings, which
// defeats the one job the document has.
const css = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/styles/app.css'),
  'utf8'
)
const pname = css.slice(css.indexOf('.po-rl-pname {'))
const pnameBlock = pname.slice(0, pname.indexOf('}'))
ok(
  !/white-space:\s*nowrap/.test(pnameBlock),
  'THE PRODUCT NAME NO LONGER REFUSES TO WRAP',
  pnameBlock.replace(/\s+/g, ' ')
)
ok(
  /line-clamp/.test(pnameBlock),
  'it is clamped to keep the rows even rather than truncated to one line'
)
ok(css.includes('.modal-po {'), 'and the receipt has a width of its own')
const poWidth = Number((/\.modal-po \{[^}]*max-width:\s*(\d+)px/.exec(css) ?? [])[1] ?? 0)
ok(poWidth >= 800, 'wider than the 620px that caused it', String(poWidth))

const receipt = require('node:fs').readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/invoicing/PurchaseOrderReceipt.tsx'),
  'utf8'
)
ok(
  !/className=\{routed \? 'modal-xl' : ''\}/.test(receipt),
  'and a plain stock PO no longer falls back to the narrow modal'
)

// ---------------------------------------------------------------------------
// NUDGING A QUANTITY, AND WHERE IT STOPS
// ---------------------------------------------------------------------------
/**
 * Both order screens already let a quantity be changed — the number is a box you
 * click into, select and retype. That is the right control for "make it 40" and
 * the wrong one for "make it one more", which is the change somebody actually
 * makes standing at a shelf.
 *
 * The arithmetic of a step is trivial. What is not is WHERE IT STOPS, and the
 * two documents stop in different places for different reasons:
 *
 *   A PURCHASE line stops at what has already been RECEIVED. Three cases are
 *   checked in and costed against real FIFO layers; taking the order down to two
 *   would leave stock on the shelf whose paperwork says it was never bought.
 *
 *   A SALES line stops at ONE. Below one is not a smaller sale, it is no sale,
 *   and a minus that silently deletes a row is a control somebody presses once
 *   and then never trusts.
 *
 * The repository refuses a bad quantity either way — that is asserted above.
 * These assertions are about the SCREEN knowing the floor before the press, so
 * the button is greyed out instead of firing a refusal.
 */
console.log('\n=== nudging a quantity, and where it stops ===')

const {
  SALES_QTY_FLOOR,
  canStep,
  purchaseQtyFloor,
  stepDownBlockedReason,
  stepQty
} = require('../src/shared/lineQty')

ok(purchaseQtyFloor({ qtyReceived: 0 }) === 1, 'nothing received yet: a purchase line floors at one')
ok(
  purchaseQtyFloor({ qtyReceived: 3 }) === 3,
  'THREE RECEIVED: THE LINE CANNOT GO BELOW THREE',
  String(purchaseQtyFloor({ qtyReceived: 3 }))
)
ok(purchaseQtyFloor({}) === 1, 'and a line that says nothing about receipts still floors at one')

ok(stepQty(4, 1, 1) === 5, 'plus one is one more', String(stepQty(4, 1, 1)))
ok(stepQty(4, -1, 1) === 3, 'minus one is one fewer', String(stepQty(4, -1, 1)))
ok(
  stepQty(3, -1, 3) === 3,
  'AND A STEP AT THE FLOOR IS A NO-OP, never a number below it',
  String(stepQty(3, -1, 3))
)
ok(canStep(4, -1, 3) === true, 'so the minus is live above the floor')
ok(canStep(3, -1, 3) === false, 'and dead at it — which is what greys the button out')
ok(canStep(3, 1, 3) === true, 'while the plus has no ceiling')

/**
 * The two floors are reached for different reasons, and the tooltip says which.
 * "Use the bin" on a line with three checked in would be wrong AND destructive
 * advice.
 */
ok(
  (stepDownBlockedReason(3, 3, 3) ?? '').includes('already received'),
  'A LINE HELD UP BY RECEIPTS SAYS SO',
  String(stepDownBlockedReason(3, 3, 3))
)
ok(
  (stepDownBlockedReason(1, SALES_QTY_FLOOR, 0) ?? '').includes('bin'),
  'while a line at one is pointed at the bin instead',
  String(stepDownBlockedReason(1, SALES_QTY_FLOOR, 0))
)
ok(
  stepDownBlockedReason(4, 3, 3) === null,
  'and a line that CAN step down explains nothing, because there is nothing to explain',
  String(stepDownBlockedReason(4, 3, 3))
)

/**
 * The floor is the repository's rule, read the same way. If these two ever
 * disagree the screen offers a button that is refused — which is exactly the
 * wall this change is undoing.
 */
const held = po.createPurchaseOrder(
  { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_a', quantity: 4, unitPrice: 100 }] },
  'emp_owner'
)
po.receivePurchaseOrderLines(held.id, [{ lineId: held.lines[0].id, quantity: 3 }], 'emp_owner')
const heldLine = po.getPurchaseOrder(held.id).lines[0]
ok(heldLine.qtyReceived === 3, 'three of four have landed', String(heldLine.qtyReceived))
ok(
  purchaseQtyFloor(heldLine) === 3,
  'the screen floors that line at three',
  String(purchaseQtyFloor(heldLine))
)
ok(
  !!po.updatePurchaseOrderLine(held.id, heldLine.id, { quantity: 2 }).error,
  'AND THE REPOSITORY REFUSES TWO — the two agree, so no button is offered that would be refused'
)
ok(
  !po.updatePurchaseOrderLine(held.id, heldLine.id, { quantity: 3 }).error,
  'while three is accepted, which is what the minus lands on'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
