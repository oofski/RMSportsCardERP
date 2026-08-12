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
const { PO_TRANSITIONS, canTransition } = require('../src/shared/purchaseOrders')
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
ok(!canTransition('received', 'paid'), 'a received PO still may NOT move to the Paid column')
ok(
  (PO_TRANSITIONS.received ?? []).join(',') === 'cancelled',
  'cancel remains its only move — payment is not one',
  JSON.stringify(PO_TRANSITIONS.received)
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

// Undo back to Ordered still clears the stage stamps, which is what that move
// MEANS — "this was not paid after all". It is only reachable from Paid, so it
// can never wipe a payment recorded by hand against a received order.
const undone = make()
po.setPurchaseOrderStatus(undone.id, 'paid', ACTOR)
po.setPurchaseOrderStatus(undone.id, 'ordered', ACTOR)
const u = po.getPurchaseOrder(undone.id)
ok(u.paidAt === null, 'undoing Paid back to Ordered still clears the date')
ok(!canTransition('received', 'ordered'), 'and Received has no route back to Ordered to wipe one')

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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
