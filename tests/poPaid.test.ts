/**
 * Paying for an order that already arrived.
 *
 * The owner's words: "sometimes we receive an order before we pay so if we
 * receive it, just add a button or keep the button active for mark as paid for
 * all invoices in received, just so we can assure that actually happened."
 *
 * Two things were wrong, and the second is the one that made the first matter.
 *
 * A received order could not be marked paid at all — 'paid' is a STAGE, and a
 * received PO's only remaining move was to cancel. And an order could not reach
 * Received without passing through Paid, so the only way to record a delivery
 * that had not been paid for was to click Paid anyway. The paid date on every
 * such order was therefore a lie the app had required, which is exactly why
 * somebody wanted a way to "assure that actually happened".
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. PAYMENT DOES NOT MOVE THE ORDER. A received PO marked paid stays in
 *      Received. If it moved, the board would tell the receiving desk that
 *      stock already on the shelf had not arrived — and the trip back through
 *      the received branch would re-run stock handling.
 *
 *   2. STOCK ARRIVES BEFORE MONEY. Ordered goes straight to Received, booking
 *      the same stock, the same lots and the same average cost as the route
 *      through Paid. Without it, the false Paid click is still mandatory and
 *      nothing above has been fixed.
 *
 *   3. MONEY IS NOT TOUCHED. COGS is booked once when the order is raised and
 *      voided only by cancel or delete. Paying an invoice is neither, and a
 *      second booking here would double-count every order paid this way.
 *
 *   4. IT IS REVERSIBLE, AND IDEMPOTENT. A payment recorded against the wrong
 *      order has to come off without cancelling the order and handing back
 *      stock that is really on the shelf; and pressing the button twice is one
 *      payment, not two moving dates.
 *
 *   5. A CANCELLED ORDER REFUSES. Its money is already back out of COGS, so
 *      stamping a payment would assert a spend the ledger no longer carries.
 *
 * Run: npm run test:po-paid
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/popaid-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const po = require('../src/main/db/purchaseOrders')
const { PO_TRANSITIONS, canTransition, poColumnOf } = require('../src/shared/purchaseOrders')
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

db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_pay', 'SKU-PAY', 'Payable Case', 'Baseball', 100,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const make = (): any =>
  po.createPurchaseOrder(
    { supplier: 'Steel City', location: 'RM', lines: [{ productId: 'p_pay', quantity: 4, unitPrice: 25 }] },
    ACTOR
  )
const cogsFor = (id: string): number | null =>
  (db.prepare('SELECT amount FROM finance_cogs WHERE po_id = ?').get(id) as { amount: number } | undefined)
    ?.amount ?? null
const stockAt = (loc: string): number =>
  (db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE product_id = 'p_pay' AND location = ?`)
    .get(loc) as { q: number }).q

// ---------------------------------------------------------------------------
console.log('\n=== 1. REASON 2: stock can arrive before the money ===')
// ---------------------------------------------------------------------------
ok(canTransition('ordered', 'received'), 'an ordered PO may go straight to Received')
ok(canTransition('ordered', 'paid'), 'and the ordinary route through Paid still exists')
/**
 * RECEIVED IS NO LONGER A ONE-WAY DOOR, and this assertion used to say it was.
 *
 * The old rule left `cancelled` as the only move out, so an order checked in by
 * mistake could be escaped exactly one way: cancel it. That does three wrong
 * things at once — reverses the stock (right), voids the purchase's COGS row
 * (wrong, the money is still committed to a supplier who is still shipping) and
 * records a cancellation that never happened (wrong, the buy was fine and the
 * receipt was the mistake). Reopening afterwards then wiped `paid_at`, so fixing
 * a mis-click could delete a payment that really happened.
 *
 * What has NOT changed is what the Paid COLUMN means, which is the thing the old
 * assertion was really defending: payment is still recorded by
 * setPurchaseOrderPaid without moving anything — see section 2 — and the card
 * still does not go backwards up the board when the money lands. This is the
 * separate act of saying the boxes never arrived.
 */
ok(
  (PO_TRANSITIONS.received ?? []).join(',') === 'ordered,paid,cancelled',
  'A RECEIVED PO CAN GO BACK — cancelling is no longer the only way out of a mis-click',
  JSON.stringify(PO_TRANSITIONS.received)
)
ok(
  canTransition('received', 'ordered'),
  'undoing the receipt is a move it can make'
)

const before = stockAt('RM')
const direct = make()
const moved = po.setPurchaseOrderStatus(direct.id, 'received', ACTOR)
ok(!moved.error, 'and the move is accepted', String(moved.error))
ok(stockAt('RM') - before === 4, 'booking the stock exactly as the route through Paid does', String(stockAt('RM') - before))
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM inventory_lots WHERE product_id = 'p_pay'`).get() as { n: number }).n > 0,
  'and opening a real cost lot'
)
// The whole point: it got here without anybody claiming it was paid for.
ok(po.getPurchaseOrder(direct.id).paidAt === null, 'with NO payment claimed on the way')

// ---------------------------------------------------------------------------
console.log('\n=== 2. REASON 1: paying does not move the order ===')
// ---------------------------------------------------------------------------
const paidRes = po.setPurchaseOrderPaid(direct.id, true)
ok(!paidRes.error, 'a received order can be marked paid', String(paidRes.error))
const afterPay = po.getPurchaseOrder(direct.id)
ok(afterPay.status === 'received', 'and STAYS in Received — it did not go backwards', afterPay.status)
ok(!!afterPay.paidAt, 'carrying the date the money went')
ok(afterPay.receivedAt !== null, 'and keeps the date its stock landed')

// REASON 3: nothing about the money book moved.
ok(cogsFor(direct.id) === 100, 'REASON 3: the COGS row is unchanged — 4 × 25', String(cogsFor(direct.id)))
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM finance_cogs WHERE po_id = ?').get(direct.id) as { n: number }).n === 1,
  'and there is exactly ONE of it — paying does not book a second'
)
ok(stockAt('RM') - before === 4, 'and no stock moved when the invoice was settled')

// ---------------------------------------------------------------------------
console.log('\n=== 3. REASON 4: reversible, and idempotent ===')
// ---------------------------------------------------------------------------
const stamped = po.getPurchaseOrder(direct.id).paidAt
const again = po.setPurchaseOrderPaid(direct.id, true)
ok(!again.error, 'pressing it twice is not an error')
ok(po.getPurchaseOrder(direct.id).paidAt === stamped, 'and does not move the date already recorded')

const cleared = po.setPurchaseOrderPaid(direct.id, false)
ok(!cleared.error, 'the mark can be taken back off', String(cleared.error))
ok(po.getPurchaseOrder(direct.id).paidAt === null, 'and the date goes with it')
ok(po.getPurchaseOrder(direct.id).status === 'received', 'while the order still has not moved')
ok(cogsFor(direct.id) === 100, 'and the money book is STILL untouched', String(cogsFor(direct.id)))
ok(stockAt('RM') - before === 4, 'as is the stock — un-paying is not un-receiving')

// ---------------------------------------------------------------------------
console.log('\n=== 4. it works from every live stage, not only Received ===')
// ---------------------------------------------------------------------------
const early = make()
ok(!po.setPurchaseOrderPaid(early.id, true).error, 'an ORDERED po can be marked paid')
const e = po.getPurchaseOrder(early.id)
ok(e.status === 'ordered', 'and stays in Ordered', e.status)
ok(!!e.paidAt, 'with the date recorded')

// ---------------------------------------------------------------------------
console.log('\n=== 5. REASON 5: a cancelled order refuses ===')
// ---------------------------------------------------------------------------
const dead = make()
po.setPurchaseOrderStatus(dead.id, 'cancelled', ACTOR)
ok(cogsFor(dead.id) === null, 'cancelling took its money back out of COGS')
const refused = po.setPurchaseOrderPaid(dead.id, true)
ok(!!refused.error, 'and it cannot then be marked paid')
ok(
  String(refused.error).includes('cancelled'),
  'with a message that says why',
  String(refused.error)
)
ok(po.getPurchaseOrder(dead.id).paidAt === null, 'and nothing was written')

// A PO that does not exist is an error, not a silent success.
ok(!!po.setPurchaseOrderPaid('nope', true).error, 'an unknown order is refused')

// ---------------------------------------------------------------------------
console.log('\n=== 6. the ordinary route is untouched ===')
// ---------------------------------------------------------------------------
// The sequence that always worked has to keep working identically, or this
// change bought one workflow by breaking the common one.
const normal = make()
po.setPurchaseOrderStatus(normal.id, 'paid', ACTOR)
const n1 = po.getPurchaseOrder(normal.id)
ok(n1.status === 'paid' && !!n1.paidAt, 'moving to Paid still stamps the date')
const nBefore = stockAt('RM')
po.setPurchaseOrderStatus(normal.id, 'received', ACTOR)
const n2 = po.getPurchaseOrder(normal.id)
ok(n2.status === 'received', 'and Received still follows')
ok(stockAt('RM') - nBefore === 4, 'booking its stock', String(stockAt('RM') - nBefore))
ok(!!n2.paidAt, 'and the payment date survives the move')

// Undo back to Ordered still clears the stage stamps when it comes FROM PAID,
// which is what that move means there — "this was not paid after all".
const undone = make()
po.setPurchaseOrderStatus(undone.id, 'paid', ACTOR)
po.setPurchaseOrderStatus(undone.id, 'ordered', ACTOR)
const u = po.getPurchaseOrder(undone.id)
ok(u.paidAt === null, 'undoing Paid back to Ordered still clears the date')

/**
 * BUT UNDOING A RECEIPT MUST NOT WIPE A PAYMENT, and that used to be guaranteed
 * only by the move being impossible.
 *
 * Received can now go back — a mis-click on Received should not have to be
 * escaped by cancelling the order. The safety that came for free from refusing
 * the move has to be written down instead: the boxes turning up by mistake says
 * NOTHING about whether the invoice was settled, so `paid_at` survives. If it
 * did not, fixing one mistake would silently create another, and the only record
 * that the supplier had been paid would be gone.
 *
 * And then nothing has to choose a column: `poColumnOf` reads the surviving
 * payment date and draws the card in Paid. The right stage, derived.
 */
const misReceived = make()
po.setPurchaseOrderPaid(misReceived.id, true, ACTOR)
const mrBefore = stockAt('RM')
po.setPurchaseOrderStatus(misReceived.id, 'received', ACTOR)
ok(stockAt('RM') - mrBefore === 4, 'a mis-received order books its stock like any other')

const undoRes = po.setPurchaseOrderStatus(misReceived.id, 'ordered', ACTOR)
ok(!undoRes.error, 'and can be sent back without cancelling it', String(undoRes.error))
const mr = po.getPurchaseOrder(misReceived.id)
ok(
  !!mr.paidAt,
  'UNDOING THE RECEIPT KEEPS THE PAYMENT — the boxes arriving by mistake says nothing about the money'
)
ok(mr.receivedAt === null, 'while the receipt date goes')
ok(mr.status === 'ordered', 'the stage is ordered', mr.status)
ok(
  poColumnOf(mr) === 'paid',
  'AND THE CARD LANDS IN PAID, derived from the date that survived rather than chosen',
  poColumnOf(mr)
)
ok(
  stockAt('RM') === mrBefore,
  'THE STOCK IS HANDED BACK — an order with nothing checked in must not leave units on the shelf',
  `${mrBefore} -> ${stockAt('RM')}`
)
ok(
  cogsFor(misReceived.id) === 100,
  'AND THE COST STAYS ON THE BOOKS — the money is still committed to a supplier who is still shipping; only cancelling voids it',
  String(cogsFor(misReceived.id))
)
ok(
  (db.prepare(`SELECT qty_received AS q FROM purchase_order_lines WHERE po_id = ?`).get(misReceived.id) as any).q === 0,
  'and the line is receivable again from scratch'
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. reverting a cancelled order ===')
// ---------------------------------------------------------------------------
// A PO cancelled by mistake had no way back at all: 'cancelled' was terminal,
// so the only remedy was retyping the whole order under a new number, losing
// the original number, its dates and any paperwork already sent.
const oops = make()
po.setPurchaseOrderStatus(oops.id, 'received', ACTOR)
const stockBeforeCancel = stockAt('RM')
po.setPurchaseOrderStatus(oops.id, 'cancelled', ACTOR)
ok(cogsFor(oops.id) === null, 'cancelling voids the COGS row')
ok(stockAt('RM') === stockBeforeCancel - 4, 'and hands the stock back', String(stockAt('RM')))

const back = po.setPurchaseOrderStatus(oops.id, 'ordered', ACTOR)
ok(!back.error, 'and it can now be reverted', String(back.error))
const r = po.getPurchaseOrder(oops.id)
ok(r.status === 'ordered', 'landing in Ordered', r.status)
ok(r.cancelledAt === null, 'with the cancellation cleared')

// THE POINT OF THE WHOLE THING. Cancelling deleted the purchase from the money
// book; making it a live order again without putting the cost back would leave
// the board showing an open order the accounts have no record of.
ok(cogsFor(oops.id) === 100, 'and its cost back in the money book', String(cogsFor(oops.id)))
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM finance_cogs WHERE po_id = ?').get(oops.id) as { n: number }).n === 1,
  'exactly once — a second row would double-count the purchase in every P&L'
)
// Booked on the day the money was committed, not the day somebody fixed the
// mistake: today's date would move the purchase into this month and silently
// restate two months at once.
ok(
  (db.prepare('SELECT occurred_at AS o FROM finance_cogs WHERE po_id = ?').get(oops.id) as { o: string }).o ===
    r.orderedAt,
  'on the date the order was raised, not today'
)

// The stock is deliberately NOT restored: the cancel handed every unit back and
// zeroed the lines, so the order really does have nothing checked in. It is
// receivable again from scratch, which is the only state its lines can describe.
ok(stockAt('RM') === stockBeforeCancel - 4, 'the stock stays handed back', String(stockAt('RM')))
ok(r.receivedUnits === 0, 'and the order reports nothing received', String(r.receivedUnits))
ok(r.orderedUnits === 4, 'while still ordering its 4 units', String(r.orderedUnits))

// Reverting twice must not book the cost twice.
po.setPurchaseOrderStatus(oops.id, 'cancelled', ACTOR)
po.setPurchaseOrderStatus(oops.id, 'ordered', ACTOR)
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM finance_cogs WHERE po_id = ?').get(oops.id) as { n: number }).n === 1,
  'a second round trip still leaves exactly one COGS row'
)

// Cancelled reverts to Ordered and NOWHERE else — Received would claim stock
// that was handed back when it was cancelled.
ok(canTransition('cancelled', 'ordered'), 'cancelled may go back to Ordered')
ok(!canTransition('cancelled', 'received'), 'but NOT straight to Received')
ok(!canTransition('cancelled', 'paid'), 'nor to Paid')

// ---------------------------------------------------------------------------
console.log('\n=== 8. the PDF actually renders ===')
// ---------------------------------------------------------------------------
// v0.0.158 shipped with EVERY purchase-order PDF throwing, because
// lookupPartyAddress selected a column (bill_postal) that does not exist —
// invoice_customers calls it bill_postal_code. Nothing caught it: the query is
// a hand-written string, so it typechecks, builds, and only fails when somebody
// presses the button.
//
// buildPoHtml is the whole document-generating path short of Chromium's
// printToPDF, which needs Electron and cannot run here. Exercising it on each
// SHAPE of order is what would have caught that, and is the point of this
// section — not the HTML it produces.
const { buildPoHtml } = require('../src/main/poPdf')
db.prepare(
  `INSERT INTO invoice_customers (id, name, terms, active, created_at, updated_at,
                                  bill_line1, bill_city, bill_region, bill_postal_code)
   VALUES ('c_pdf', 'Fenwick Cards', 'Net 30', 1, '2026-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', '12 Mill Road', 'Dayton', 'OH', '45402')`
).run()

const renders = (label: string, id: string, wants: string[]): void => {
  try {
    const html = buildPoHtml(po.getPurchaseOrder(id))
    const missing = wants.filter((w) => !html.includes(w))
    ok(missing.length === 0, label, JSON.stringify(missing))
  } catch (err) {
    ok(false, label, `THREW ${(err as Error).message}`)
  }
}

const plain = make()
renders('an ordinary order renders', plain.id, ['<html', 'RM Sportscards', 'class="status'])

// The top-right block. The owner asked for it by name — "that was a feature we
// had, don't get rid of it" — so it is pinned rather than left to survive by
// luck through the next edit to this header.
renders('with the status in the top right', plain.id, ['class="right"'])
po.setPurchaseOrderPaid(plain.id, true)
renders('and PAID beside it once it is paid', plain.id, ['paidmark'])

// The shape that actually broke: a destination that is a party, which is the
// only path that reaches lookupPartyAddress at all.
const dropPdf = po.createPurchaseOrder(
  { supplier: 'Steel City', location: 'Fenwick Cards',
    lines: [{ productId: 'p_pay', quantity: 2, unitPrice: 50 }] },
  ACTOR
)
renders('a dropship renders, address and all', dropPdf.id, ['Drop ship', '12 Mill Road', '45402'])

// A destination with no contact record must not throw — most one-off drops are
// to somebody who was typed straight onto the order.
const stranger = po.createPurchaseOrder(
  { supplier: 'Steel City', location: 'Somebody Not On File',
    lines: [{ productId: 'p_pay', quantity: 1, unitPrice: 10 }] },
  ACTOR
)
renders('and so does one to a party with no address on file', stranger.id, ['Somebody Not On File'])

// ---------------------------------------------------------------------------
console.log('\n=== 9. adding a product to an order that already exists ===')
// ---------------------------------------------------------------------------
// A PO was write-once: a missed case meant cancelling and retyping the whole
// order under a new number, losing the number, the dates and any paperwork
// already sent to the supplier.
//
// The header total is a STORED SNAPSHOT and a COGS row was written from it, so
// the risk here is not the line — it is those two drifting apart. A receipt and
// a set of accounts quoting different figures for the same document, with
// nothing on either screen to say which is right, is worse than no edit button.
db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_add', 'SKU-ADD', 'Added Case', 'Football', 60,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const grow = make()   // 4 x 25 = 100
ok(po.getPurchaseOrder(grow.id).total === 100, 'the order starts at 100', String(po.getPurchaseOrder(grow.id).total))
ok(cogsFor(grow.id) === 100, 'and its COGS row agrees')

const added = po.addPurchaseOrderLines(grow.id, [{ productId: 'p_add', quantity: 3, unitPrice: 60 }])
ok(!added.error, 'a product can be added to a live order', String(added.error))
const g = po.getPurchaseOrder(grow.id)
ok(g.lineCount === 2, 'the line is on the order', String(g.lineCount))
ok(g.orderedUnits === 7, 'the units follow — 4 + 3', String(g.orderedUnits))
ok(g.total === 280, 'THE HEADER TOTAL FOLLOWS — 100 + 180', String(g.total))
ok(cogsFor(grow.id) === 280, 'AND SO DOES THE MONEY BOOK', String(cogsFor(grow.id)))
ok(
  (db.prepare('SELECT COUNT(*) AS n FROM finance_cogs WHERE po_id = ?').get(grow.id) as { n: number }).n === 1,
  'as one row, not a second entry'
)
// Booked on the day the order was raised. Re-writing the row would move the
// cost to today and restate two months at once.
ok(
  (db.prepare('SELECT occurred_at AS o FROM finance_cogs WHERE po_id = ?').get(grow.id) as { o: string }).o ===
    g.orderedAt,
  'still dated when the order was raised'
)
// The new line inherits the header rather than copying it — NULL is what every
// line written before line-level routing existed carries, and what keeps a
// later change of header destination from leaving stale values behind.
const rawAdded = db
  .prepare(`SELECT supplier, destination, position FROM purchase_order_lines WHERE po_id = ? AND product_id = 'p_add'`)
  .get(grow.id) as { supplier: string | null; destination: string | null; position: number }
ok(rawAdded.supplier === null && rawAdded.destination === null, 'inheriting the header, not copying it')
ok(rawAdded.position === 1, 'and landing after the lines already there', String(rawAdded.position))
// It is a real, receivable line — not decoration on the header.
ok(g.lines.find((l: { productId: string }) => l.productId === 'p_add')?.qtyReceivable === 3,
  'and it is receivable like any other')

// Adding a line is paperwork; the units have not turned up. Asserted on the
// ADDED product, whose stock must still be nothing at all — measuring the other
// product against a baseline taken at the top of this file would only prove
// that the sections in between behaved, which is not what this is about.
const addedStock = (db
  .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE product_id = 'p_add'`)
  .get() as { q: number }).q
ok(addedStock === 0, 'no stock moved — the boxes have not arrived', String(addedStock))
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM inventory_lots WHERE product_id = 'p_add'`).get() as { n: number }).n === 0,
  'and no cost layer was opened'
)

// The two refusals, and why each one.
const closed = make()
po.setPurchaseOrderStatus(closed.id, 'received', ACTOR)
const onClosed = po.addPurchaseOrderLines(closed.id, [{ productId: 'p_add', quantity: 1, unitPrice: 10 }])
ok(!!onClosed.error, 'a RECEIVED order refuses — the line could never be checked in')
ok(po.getPurchaseOrder(closed.id).lineCount === 1, 'and nothing was written')

const killed = make()
po.setPurchaseOrderStatus(killed.id, 'cancelled', ACTOR)
const onDead = po.addPurchaseOrderLines(killed.id, [{ productId: 'p_add', quantity: 1, unitPrice: 10 }])
ok(!!onDead.error, 'a CANCELLED order refuses — its cost is out of the ledger')
ok(cogsFor(killed.id) === null, 'and no COGS row was resurrected by the attempt')

// Junk in must not corrupt the total.
const guard = make()
const noProduct = po.addPurchaseOrderLines(guard.id, [{ productId: 'nope', quantity: 1, unitPrice: 10 }])
ok(!!noProduct.error, 'an unknown product is named, not silently dropped')
ok(po.getPurchaseOrder(guard.id).total === 100, 'and the total is untouched', String(po.getPurchaseOrder(guard.id).total))
ok(!!po.addPurchaseOrderLines(guard.id, []).error, 'an empty add is refused')
ok(
  !!po.addPurchaseOrderLines(guard.id, [{ productId: 'p_add', quantity: 0, unitPrice: 10 }]).error,
  'so is a zero quantity'
)
ok(po.getPurchaseOrder(guard.id).lineCount === 1, 'none of which added a line', String(po.getPurchaseOrder(guard.id).lineCount))

// ---------------------------------------------------------------------------
console.log('\n=== 10. RECEIVING IS NOT PAYING, by every route that receives ===')
// ---------------------------------------------------------------------------
// The owner: "something can be received but unpaid so make sure that if it is
// received it does not mean that is paid".
//
// Stock arriving and money leaving are two different events that happen in
// either order, and the app has four separate ways to record the first. A
// single one of them stamping paid_at would put a payment on the record that
// nobody made — and it would be believed, because it looks exactly like one
// somebody did make.
const inv = require('../src/main/db/inventory')
const scanRepo = require('../src/main/db/scanning')

// Route 1: the board's Receive button.
const r1 = make()
po.setPurchaseOrderStatus(r1.id, 'received', ACTOR)
const a1 = po.getPurchaseOrder(r1.id)
ok(a1.status === 'received', 'ROUTE 1 board move: it is received', a1.status)
ok(a1.paidAt === null, 'and NOT paid', String(a1.paidAt))
ok(a1.receivedUnits === 4, 'with the stock really in', String(a1.receivedUnits))

// Route 2: the delivery form on Incoming Inventory.
const r2 = make()
const d2 = po.receivePurchaseOrderLines(r2.id, [{ lineId: r2.lines[0].id, quantity: 4 }], ACTOR)
ok(!d2.error, 'ROUTE 2 delivery form: it books', String(d2.error))
const a2 = po.getPurchaseOrder(r2.id)
ok(a2.receivedUnits === 4, 'all four in', String(a2.receivedUnits))
ok(a2.paidAt === null, 'and NOT paid', String(a2.paidAt))

// Route 3: a PARTIAL delivery — the case most likely to be sitting unpaid.
const r3 = make()
po.receivePurchaseOrderLines(r3.id, [{ lineId: r3.lines[0].id, quantity: 2 }], ACTOR)
const a3 = po.getPurchaseOrder(r3.id)
ok(a3.receivedUnits === 2, 'ROUTE 3 partial: two of four in', String(a3.receivedUnits))
ok(a3.paidAt === null, 'and NOT paid', String(a3.paidAt))
ok(a3.status === 'ordered', 'still open, because it is not all here', a3.status)

// Route 4: scan-in, which is how it happens on the floor.
const r4 = make()
const s4 = po.scanInPurchaseOrder(r4.id, ACTOR)
ok(!s4.error, 'ROUTE 4 scan-in: it books', String(s4.error))
const a4 = po.getPurchaseOrder(r4.id)
ok(a4.receivedUnits === 4, 'all four in', String(a4.receivedUnits))
ok(a4.paidAt === null, 'and NOT paid', String(a4.paidAt))

// The reverse must hold too: paying must not make anything arrive.
const r5 = make()
po.setPurchaseOrderPaid(r5.id, true)
const a5 = po.getPurchaseOrder(r5.id)
ok(!!a5.paidAt, 'paying stamps the payment')
ok(a5.receivedUnits === 0, 'and receives NOTHING', String(a5.receivedUnits))
ok(a5.receivedAt === null, 'with no arrival date invented', String(a5.receivedAt))
ok(a5.status === 'ordered', 'and the order has not moved', a5.status)

// And a received order that is genuinely unpaid must SAY so, not merely omit it.
ok(po.getPurchaseOrder(r1.id).paidAt === null, 'a received order can sit unpaid indefinitely')
const late = po.setPurchaseOrderPaid(r1.id, true)
ok(!late.error, 'and be paid later, from the Received column', String(late.error))
ok(po.getPurchaseOrder(r1.id).status === 'received', 'without moving off it')

// ---------------------------------------------------------------------------
console.log('\n=== 11. undoing a receipt REFUSES when the stock has gone ===')
// ---------------------------------------------------------------------------
/**
 * THE ONE CASE WHERE THE UNDO MUST NOT WORK.
 *
 * Handing stock back means unwinding the exact FIFO lot each receipt opened. If
 * part of that lot has already been sold there is nothing clean to unwind — the
 * boxes are gone — and pretending they never arrived would leave the shelf short
 * and the cost layers inconsistent. `reverseLotReceipt` throws, and because the
 * whole move runs in one transaction the order is left EXACTLY as it was rather
 * than half-undone.
 *
 * This is the same refusal cancelling has always made. It is worth its own test
 * here because undoing a receipt is a new door onto it, and a door that half-
 * worked would be worse than the one-way street it replaced.
 */
const soldPo = make()
const soldBefore = stockAt('RM')
po.setPurchaseOrderStatus(soldPo.id, 'received', ACTOR)
ok(stockAt('RM') - soldBefore === 4, 'four boxes land on the shelf')

// Sell two of them out of the lot this receipt opened.
const soldLot = db
  .prepare(`SELECT lot_id FROM po_line_receipts WHERE po_line_id IN
              (SELECT id FROM purchase_order_lines WHERE po_id = ?)`)
  .get(soldPo.id) as { lot_id: string }
db.prepare('UPDATE inventory_lots SET qty_remaining = qty_remaining - 2 WHERE id = ?').run(soldLot.lot_id)

const undoRefused = po.setPurchaseOrderStatus(soldPo.id, 'ordered', ACTOR)
ok(!!undoRefused.error, 'THE UNDO IS REFUSED once part of the stock has been sold', String(undoRefused.error))
ok(
  (undoRefused.error ?? '').toLowerCase().includes('already been sold'),
  'and says why, rather than failing silently',
  String(undoRefused.error)
)
const stillThere = po.getPurchaseOrder(soldPo.id)
ok(stillThere.status === 'received', 'THE ORDER IS UNCHANGED — not half-undone', stillThere.status)
ok(!!stillThere.receivedAt, 'it still carries its receipt date')
ok(
  (db.prepare(`SELECT qty_received AS q FROM purchase_order_lines WHERE po_id = ?`).get(soldPo.id) as any).q === 4,
  'and its line still reads as received — the transaction rolled back whole'
)

// ---------------------------------------------------------------------------
console.log('\n=== 12. received -> paid does not land in Completed ===')
// ---------------------------------------------------------------------------
/**
 * The stamps are what `poColumnOf` reads, and an order carrying BOTH a payment
 * date and a receipt date is drawn in COMPLETED — finished, a day from history.
 * Moving a received order to Paid stamps `paid_at`; leaving the stale
 * `received_at` behind would file an order whose stock was just handed back
 * under "nothing left to do".
 */
const toPaid = make()
const tpBefore = stockAt('RM')
po.setPurchaseOrderStatus(toPaid.id, 'received', ACTOR)
const tpMoved = po.setPurchaseOrderStatus(toPaid.id, 'paid', ACTOR)
ok(!tpMoved.error, 'a received order can be moved to Paid', String(tpMoved.error))
const tp = po.getPurchaseOrder(toPaid.id)
ok(tp.receivedAt === null, 'AND THE RECEIPT DATE IS CLEARED WITH IT', String(tp.receivedAt))
ok(!!tp.paidAt, 'while the payment date is stamped')
ok(
  poColumnOf(tp) === 'paid',
  'SO THE CARD DRAWS IN PAID, not Completed — it is not finished, its boxes never arrived',
  poColumnOf(tp)
)
ok(stockAt('RM') === tpBefore, 'and the stock went back', `${tpBefore} -> ${stockAt('RM')}`)

// ---------------------------------------------------------------------------
console.log('\n=== 13. the card offers the undo (guards that outlive this suite) ===')
// ---------------------------------------------------------------------------
/**
 * READ OFF THE SOURCE. `setPurchaseOrderPaid` has taken a boolean and logged
 * "Payment un-marked" since it was written — and NOTHING REACHED IT, because the
 * card hid the button the moment `paidAt` was set. A backend that can undo and a
 * screen with no way to ask is the same as no undo at all, and no test of the
 * repository could see it.
 */
const { readFileSync } = require('node:fs')
const boardSrc = readFileSync('src/renderer/src/modules/invoicing/PurchaseOrderBoard.tsx', 'utf8')
const moduleSrc = readFileSync('src/renderer/src/modules/invoicing/InvoicingModule.tsx', 'utf8')
ok(
  /const payable = onMarkPaid !== undefined && po\.status !== 'cancelled'/.test(boardSrc),
  'THE PAY BUTTON IS NO LONGER HIDDEN ONCE PAID — that is what made a mis-tick unfixable'
)
ok(
  /po\.paidAt \? 'Un-mark paid' : 'Mark paid'/.test(boardSrc),
  'and it says which way it goes'
)
ok(
  /onMarkPaid\?\.\(po\.id, po\.poNumber, !po\.paidAt\)/.test(boardSrc),
  'passing the opposite of what the card currently claims'
)
ok(
  /api\.purchaseOrders\.setPaid\(id, paid\)/.test(moduleSrc),
  'AND THE HANDLER PASSES IT THROUGH — it used to hardcode true, so the false case was unreachable'
)
ok(
  /po\.status === 'received' && to === 'ordered' \? 'Undo receipt'/.test(boardSrc),
  'undoing a receipt is called that, not "Reopen" — from Received it is a different act with different consequences'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
