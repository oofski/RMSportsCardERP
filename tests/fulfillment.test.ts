/**
 * Getting a sold order out of the building.
 *
 * The owner's rules, in their words:
 *
 *   · ready to ship "when a sales order is either payment up front and paid, or
 *     payment on delivery and paid or unpaid"
 *   · awaiting items — "used when a sale is made, however we (or whoever the
 *     dropship vendor is) doesn't have the case in hand"
 *   · awaiting dims — the box has not been weighed and measured
 *   · "should be able to manually move items to ready to ship ... specifically
 *     for when a customer has up front payment terms but we are sending the
 *     package anyway"
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE PAYMENT GATE RUNS THE RIGHT WAY ROUND. Delivery terms are admitted
 *      whether or not the money has arrived — the buyer pays when it lands, so
 *      waiting for payment first is waiting for something that cannot happen.
 *      Up-front terms wait. Getting this backwards either holds every delivery
 *      order off the bench for ever, or ships every unpaid one.
 *
 *   2. A SHELF SHORTFALL IS REAL AND IS READ, NOT ASSUMED. applyInvoiceStock
 *      takes MIN(asked, on hand), so an order for ten against three draws three
 *      and quietly owes seven. Without comparing the two, Awaiting items could
 *      only ever speak for dropships and a short stock order would sit in Ready
 *      to ship with nothing to put in the box.
 *
 *   3. A DROPSHIP CANNOT ANSWER FOR ITSELF. Nothing here knows whether a
 *      supplier has a case, so it waits to be told. Defaulting it to "in hand"
 *      sends a card to the bench that nobody can pack.
 *
 *   4. THE GATES ARE ASKED IN ORDER. There is nothing to measure until the case
 *      is in the building, so an order missing both reads as awaiting ITEMS —
 *      otherwise the board asks somebody to weigh a box that has not arrived.
 *
 *   5. THE MANUAL OVERRIDE CLEARS EVERYTHING, and is its own stored fact rather
 *      than a fake payment. It is the only way an unpaid up-front order reaches
 *      the bench, and six months later somebody has to be able to see that a
 *      person decided it.
 *
 * Every name here is invented.
 *
 * Run: npm run test:fulfillment
 */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  FULFILLMENT_COLUMNS,
  FULFILLMENT_STAGE_TONE,
  describeDims,
  fulfillmentBlockedReason,
  fulfillmentColumnOf,
  fulfillmentNextStep,
  fulfillmentNextStepDetail,
  fulfillmentStageOf,
  fulfillmentTickShort,
  hasDims,
  itemsInHand,
  paymentClearsFulfillment,
  shelfShortfall
} = require('../src/shared/fulfillment')
const { INVOICE_TERMS, INVOICE_TERMS_OFFERED, termsOptionsFor } = require('../src/shared/invoices')
const {
  PO_STAGES,
  PO_TRANSITIONS,
  poColumnOf,
  poColumnStatus
} = require('../src/shared/purchaseOrders')

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

const DIMS = { weightLb: 6.5, lengthIn: 12, widthIn: 9, heightIn: 4 }
const NO_DIMS = { weightLb: null, lengthIn: null, widthIn: null, heightIn: null }

/** A sale off our own shelf that the shelf covered, measured, on delivery terms. */
const order = (over: Record<string, unknown> = {}): any => ({
  status: 'draft',
  paymentTiming: 'delivery',
  stockUnits: 4,
  dropshipUnits: 0,
  drawnUnits: 4,
  itemsInHandAt: null,
  forceReadyAt: null,
  paidAt: null,
  qboPaidAt: null,
  ...DIMS,
  ...over
})

// ---------------------------------------------------------------------------
console.log('\n=== 1. the payment gate ===')
// ---------------------------------------------------------------------------

ok(
  paymentClearsFulfillment({ status: 'draft', paymentTiming: 'delivery', paidAt: null }),
  'DELIVERY TERMS ARE ADMITTED UNPAID — the buyer pays when it lands, so waiting for the money first waits for something that cannot happen'
)
ok(
  paymentClearsFulfillment({
    status: 'paid',
    paymentTiming: 'delivery',
    paidAt: '2026-08-20T00:00:00.000Z'
  }),
  'and still admitted once they have paid'
)
ok(
  !paymentClearsFulfillment({ status: 'sent', paymentTiming: 'front', paidAt: null }),
  'UP-FRONT TERMS WAIT for the money'
)
ok(
  paymentClearsFulfillment({
    status: 'sent',
    paymentTiming: 'front',
    paidAt: '2026-08-20T00:00:00.000Z'
  }),
  'and are admitted the moment it arrives'
)
/**
 * THE FACT, NOT THE COLUMN.
 *
 * The last bucket is called Payment now — the settling-up step — and reaching
 * it is not being paid. A gate that read the stage would open the packing floor
 * for any order somebody dragged into that column, which is precisely the drag
 * that means "chase this one for the money".
 */
ok(
  !paymentClearsFulfillment({ status: 'paid', paymentTiming: 'front', paidAt: null }),
  'AN ORDER SITTING IN PAYMENT UNPAID DOES NOT CLEAR THE GATE — the column is a step, not a receipt'
)
ok(
  paymentClearsFulfillment({
    status: 'paid',
    paymentTiming: 'front',
    paidAt: null,
    qboPaidAt: '2026-08-20T00:00:00.000Z'
  }),
  'while QUICKBOOKS SAYING SO DOES — the books are the record for money, not this board'
)
ok(
  !paymentClearsFulfillment({
    status: 'paid',
    paymentTiming: 'front',
    paidAt: '2026-08-20T00:00:00.000Z',
    qboVoided: true
  }),
  'and a voided QuickBooks copy un-pays it'
)
ok(
  !paymentClearsFulfillment({ status: 'sent', paymentTiming: null, paidAt: null }),
  'AN ORDER WITH NO TERMS SAID BEHAVES AS UP-FRONT — the other reading ships goods against a term nobody chose'
)
ok(fulfillmentStageOf(order({ status: 'void' })) === null, 'a void is never on the board')
ok(
  fulfillmentStageOf(order({ paymentTiming: 'front', status: 'sent', paidAt: null })) === null,
  'and neither is an unpaid up-front order'
)
ok(
  /has not paid yet/.test(
    fulfillmentBlockedReason(order({ paymentTiming: 'front', status: 'sent', paidAt: null })) ?? ''
  ),
  'which the board can say in words, because "where is my order" has no answer on a list that omits it'
)
ok(
  fulfillmentBlockedReason(order()) === null,
  'and an order that IS on the board has no reason to give'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. are the goods in the building ===')
// ---------------------------------------------------------------------------

ok(itemsInHand(order()), 'a stock order the shelf covered is in hand')
ok(
  !itemsInHand(order({ stockUnits: 10, drawnUnits: 3 })),
  'A SHORT SHELF IS NOT — applyInvoiceStock takes what it can, so ten asked against three on hand owes seven'
)
ok(
  shelfShortfall(order({ stockUnits: 10, drawnUnits: 3 })) === 7,
  'and the shortfall is countable, so the card can say how many',
  String(shelfShortfall(order({ stockUnits: 10, drawnUnits: 3 })))
)
ok(shelfShortfall(order()) === 0, 'a covered order is short of nothing')
// A shelf that gave MORE than was asked cannot happen, but a negative shortfall
// would read as "in credit" and quietly admit a short order somewhere else.
ok(
  shelfShortfall({ stockUnits: 2, drawnUnits: 5 }) === 0,
  'and a shortfall never goes negative'
)

const drop = order({ stockUnits: 0, dropshipUnits: 6, drawnUnits: 0 })
ok(
  !itemsInHand(drop),
  'A DROPSHIP IS NOT IN HAND UNTIL SOMEBODY SAYS — nothing here knows whether a supplier has a case, and guessing sends a card to a bench that cannot pack it'
)
ok(itemsInHand({ ...drop, itemsInHandAt: '2026-08-20T12:00:00.000Z' }), 'and is once they do')
ok(
  itemsInHand(order({ stockUnits: 0, dropshipUnits: 0, drawnUnits: 0 })),
  'an order with no lines has nothing to wait for'
)
// A MIXED order is both at once, and the stricter half wins.
ok(
  !itemsInHand(order({ stockUnits: 4, drawnUnits: 4, dropshipUnits: 2 })),
  'a mixed order still waits on its dropshipped half'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. has the box been measured ===')
// ---------------------------------------------------------------------------

ok(hasDims(DIMS), 'all four is measured')
ok(!hasDims(NO_DIMS), 'none is not')
ok(
  !hasDims({ ...DIMS, widthIn: null }),
  'AND NOR IS THREE OF THE FOUR — a carrier prices a case on dimensional weight, so a partial answer buys nothing'
)
ok(!hasDims({ ...DIMS, weightLb: 0 }), 'a zero is not a measurement')
ok(!hasDims({ ...DIMS, heightIn: -2 }), 'and neither is a negative one')
ok(
  describeDims(DIMS) === '12 × 9 × 4 in · 6.5 lb',
  'measured, it reads as a parcel',
  String(describeDims(DIMS))
)
ok(describeDims(NO_DIMS) === null, 'and unmeasured it says nothing rather than printing zeroes')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the gates are asked in order ===')
// ---------------------------------------------------------------------------

ok(fulfillmentStageOf(order()) === 'ready', 'cleared, in hand and measured is ready')
ok(
  fulfillmentStageOf(order({ ...NO_DIMS })) === 'awaiting_dims',
  'in hand but unmeasured is awaiting dims'
)
ok(
  fulfillmentStageOf(order({ stockUnits: 10, drawnUnits: 3 })) === 'awaiting_items',
  'short on the shelf is awaiting items'
)
ok(
  fulfillmentStageOf(order({ stockUnits: 10, drawnUnits: 3, ...NO_DIMS })) === 'awaiting_items',
  'MISSING BOTH READS AS AWAITING ITEMS — there is nothing to measure until the case is in the building'
)
ok(
  /short on the shelf/.test(fulfillmentNextStep(order({ stockUnits: 10, drawnUnits: 3 })) ?? ''),
  'and the card says how many it is short'
)
ok(
  /supplier/.test(fulfillmentNextStep(drop) ?? ''),
  'while a dropship is told to chase the supplier instead',
  String(fulfillmentNextStep(drop))
)
ok(
  /[Ww]eigh/.test(fulfillmentNextStep(order({ ...NO_DIMS })) ?? ''),
  'and an unmeasured one is told to weigh it'
)
ok(fulfillmentNextStep(order()) === null, 'a ready order has no next step')

/**
 * SHORT ON THE CARD, LONG ON HOVER.
 *
 * The first draft printed full sentences on a card in a column and they wrapped
 * to three lines, pushing the buttons off the bottom. Nothing was cut — the
 * advice moved to the tooltip — and this is what stops it creeping back.
 */
const shortOrder = order({ stockUnits: 10, drawnUnits: 3 })
ok(
  (fulfillmentNextStep(shortOrder) ?? '').length < 30,
  'the card line is short enough to fit on one',
  fulfillmentNextStep(shortOrder) ?? ''
)
ok(
  (fulfillmentNextStepDetail(shortOrder) ?? '').length >
    (fulfillmentNextStep(shortOrder) ?? '').length,
  'AND THE ADVICE IS NOT LOST — the tooltip carries the long form'
)
ok(
  /not enough on hand/.test(fulfillmentNextStepDetail(shortOrder) ?? ''),
  'which says WHY the shelf came up short, not just that it did'
)
ok(
  /all four/i.test(fulfillmentNextStepDetail(order({ ...NO_DIMS })) ?? ''),
  'and why three measurements are not enough'
)
ok(fulfillmentNextStepDetail(order()) === null, 'a ready order has nothing to explain')
ok(
  fulfillmentTickShort('awaiting_items') === 'In hand' &&
    fulfillmentTickShort('awaiting_dims') === 'Measure',
  'the button wears two words while the tooltip keeps the sentence'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. sending it anyway ===')
// ---------------------------------------------------------------------------

const forced = { forceReadyAt: '2026-08-20T12:00:00.000Z' }
ok(
  fulfillmentStageOf(order({ paymentTiming: 'front', status: 'sent', ...forced })) === 'ready',
  'THE OVERRIDE CLEARS THE PAYMENT GATE — which is the case the owner asked for by name'
)
ok(
  fulfillmentStageOf(order({ ...NO_DIMS, ...forced })) === 'ready',
  'and the dims gate, because the request was to move it to Ready to ship, not one column along'
)
ok(
  fulfillmentStageOf(order({ stockUnits: 10, drawnUnits: 3, ...forced })) === 'ready',
  'and the items gate'
)
ok(
  fulfillmentStageOf(order({ status: 'void', ...forced })) === null,
  'BUT NOT A VOID — there are no boxes left to pick, whoever said otherwise'
)
// It must not be confused with the thing it overrides: an order forced onto the
// bench with no measurements still cannot have a label bought for it.
ok(
  !hasDims(order({ ...NO_DIMS, ...forced })),
  'and a forced order with no measurements still has none, so the card can say so'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. two columns, three states ===')
// ---------------------------------------------------------------------------

ok(FULFILLMENT_COLUMNS.length === 2, 'the board has two columns', String(FULFILLMENT_COLUMNS.length))
ok(
  FULFILLMENT_COLUMNS[0].id === 'ordered' && FULFILLMENT_COLUMNS[1].id === 'ready',
  'Ordered then Ready to ship'
)
ok(
  fulfillmentColumnOf('awaiting_items') === 'ordered' &&
    fulfillmentColumnOf('awaiting_dims') === 'ordered',
  'BOTH WAITING STATES SHARE THE ORDERED COLUMN — the work differs while the situation does not'
)
ok(fulfillmentColumnOf('ready') === 'ready', 'and ready has its own')
ok(
  FULFILLMENT_STAGE_TONE.awaiting_items !== FULFILLMENT_STAGE_TONE.awaiting_dims,
  'AND THEY ARE TOLD APART BY COLOUR, which is the whole reason one column can hold two states'
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. nothing longer than Net 2 is offered ===')
// ---------------------------------------------------------------------------

ok(
  INVOICE_TERMS_OFFERED.join(' | ') === 'Due on receipt | Net 2',
  'the picker offers two terms',
  INVOICE_TERMS_OFFERED.join(' | ')
)
ok(
  INVOICE_TERMS.includes('Net 30') && INVOICE_TERMS.includes('Net 60'),
  'WHILE THE LONGER ONES STILL EXIST — the words are stored on invoices and on customers, and a select renders a value it has no option for as BLANK, which reads as the terms having been wiped'
)
ok(
  termsOptionsFor(null).join(' | ') === 'Due on receipt | Net 2',
  'a new record is offered the short list'
)
ok(
  termsOptionsFor('Net 30').includes('Net 30'),
  'A RECORD ALREADY ON NET 30 STILL SEES IT — that is a fact about a deal that was struck, not a policy to rewrite'
)
ok(
  termsOptionsFor('Net 30').length === 3,
  'and only that one, not the whole retired list',
  termsOptionsFor('Net 30').join(' | ')
)
ok(
  !termsOptionsFor('Due on receipt').includes('Net 30'),
  'and it disappears the moment the record moves off it'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. Received sits before Paid on the purchase board ===')
// ---------------------------------------------------------------------------

const order2 = PO_STAGES.map((s: any) => s.id).join(' | ')
ok(
  order2 === 'ordered | received | paid | completed',
  'RECEIVED COMES BEFORE PAID — stock turns up and gets checked in, and the invoice is settled after',
  order2
)
/**
 * AND THE LAST COLUMN IS COMPLETED, NOT CANCELLED.
 *
 * Cancelled was a lane for the rarest thing on the board, sitting in the place a
 * reader's eye goes for "what finished?" — while an order that was received AND
 * paid for had nowhere to land and sat in Paid, a live column, until the sweep
 * took it. So the board could not tell "settled up, done" from "paid, boxes
 * still coming".
 */
ok(
  !PO_STAGES.some((s: any) => s.id === 'cancelled'),
  'THERE IS NO CANCELLED COLUMN — a cancelled order is finished business and files under Completed with everything else'
)
ok(
  PO_TRANSITIONS.ordered.includes('received'),
  'which is the order the transitions already allowed — ordered goes straight to received'
)
ok(
  PO_TRANSITIONS.ordered.includes('paid') && PO_TRANSITIONS.paid.includes('received'),
  'AND MOVING THROUGH PAID STILL WORKS — this changed where the columns are drawn, not which moves are legal'
)

/**
 * PAID AND RECEIVED IS COMPLETED.
 *
 * Payment is its own fact — setPurchaseOrderPaid stamps paid_at without moving
 * the stage — precisely so that stock arriving before the invoice is settled
 * does not make somebody click Paid for a payment that has not happened. Once
 * BOTH are true there is nothing left to do about the order, and it moves one
 * column right to say so.
 */
const IS = '2026-08-20T00:00:00.000Z'
ok(poColumnOf({ status: 'ordered', paidAt: null }) === 'ordered', 'an ordered order draws in Ordered')
ok(
  poColumnOf({ status: 'received', paidAt: null, receivedAt: IS }) === 'received',
  'a received one that is unpaid stays in Received — the money is still owed'
)
ok(
  poColumnOf({ status: 'ordered', paidAt: IS, receivedAt: null }) === 'paid',
  'one paid for before it arrived draws in Paid — the boxes are still coming'
)
ok(
  poColumnOf({ status: 'received', paidAt: IS, receivedAt: IS }) === 'completed',
  'AND ONE THAT IS PAID FOR AND RECEIVED DRAWS IN COMPLETED — nothing left to do about it'
)
ok(
  poColumnOf({ status: 'cancelled', paidAt: IS, receivedAt: IS }) === 'completed',
  'a cancelled order is finished business too, and files in the same column'
)
// Derived, never stored: both facts have to survive, or cancelling can no
// longer reverse the receipt and the completion test loses its input.
const bothFacts: any = { status: 'received', paidAt: IS, receivedAt: IS }
ok(poColumnOf(bothFacts) === 'completed', 'a received-and-paid order draws in Completed')
ok(
  bothFacts.status === 'received',
  'AND STILL KNOWS IT WAS RECEIVED — the column is derived and the status is left alone, or cancelling could no longer reverse the receipt',
  bothFacts.status
)

/**
 * COMPLETED TAKES NO DROPS.
 *
 * It is derived from two dates the order already carries, so dragging a card
 * into it would have to invent them both — or store a flag that then disagrees
 * with them, which is the exact failure this codebase derives everything to
 * avoid. poColumnStatus is what tells the board so.
 */
ok(poColumnStatus('completed') === null, 'Completed is not a drop target — it is derived, not set')
ok(
  PO_STAGES.filter((s: any) => poColumnStatus(s.id) !== null).map((s: any) => s.id).join(' | ') ===
    'ordered | received | paid',
  'the other three are, and each one is its own status'
)
// Which is what stops a card being dragged there: the board asks canTransition
// with the drop target, and there is no target to ask about.
ok(
  !PO_STAGES.some((s: any) => s.id === 'completed' && poColumnStatus(s.id)),
  'so no drag can reach it'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. one board, not two ===')
// ---------------------------------------------------------------------------
/**
 * The fulfilment state had a board of its own for two versions. It was a second
 * place to look for the same orders, so the owner asked for it to fold back
 * into the main one — "can u not have the new tab just have it on the main tab
 * ... and that just like have the color represent something".
 *
 * The STATE did not go anywhere; only the board did. So what this pins is that
 * the fold happened completely: no orphan tab, and the actions that board owned
 * still reachable, or the colour would name something with no way to answer it.
 */
const read = (rel: string): string =>
  require('node:fs').readFileSync(require('node:path').join(process.cwd(), rel), 'utf8')
const invoicesModule = read('src/renderer/src/modules/invoices/InvoicesModule.tsx')
const shippingModule = read('src/renderer/src/modules/fulfillment/ShippingModule.tsx')
ok(
  !/ReadyToShipBoard/.test(invoicesModule) && !/ReadyToShipBoard/.test(shippingModule),
  'NO SEPARATE BOARD IS MOUNTED ANYWHERE — it folded into the orders list rather than moving again'
)
ok(
  !require('node:fs').existsSync(
    require('node:path').join(process.cwd(), 'src/renderer/src/modules/invoices/ReadyToShipBoard.tsx')
  ),
  'and the component is gone rather than left orphaned for somebody to re-mount'
)
ok(
  !/Ready to Ship/.test(invoicesModule),
  'so Sales Orders is back to two tabs'
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. the same state, said on the two order boards ===')
// ---------------------------------------------------------------------------
/**
 * The owner asked for awaiting items and awaiting dims to show up on the Sales
 * Orders and Purchase Orders boards too, highlighted the way a dropship is.
 *
 * A STRIPE, not a tint, and the distinction is the whole reason it works: the
 * card BACKGROUND already says whether the order is a dropship, and an order can
 * be a dropship and be waiting on measurements at once. Tinting for both would
 * make one of them invisible — which is what this pins.
 */
const soBoard = read('src/renderer/src/modules/invoices/InvoicesBoard.tsx')
const poBoard = read('src/renderer/src/modules/invoicing/PurchaseOrderBoard.tsx')
const css = read('src/renderer/src/styles/app.css')

// THE COLOUR HAS TO BE ANSWERABLE. Naming what is missing on a card with no way
// to act on it just moves the dead end onto the main board.
ok(/<DimsModal/.test(soBoard), 'the card can open the measuring box')
ok(/setItemsInHand/.test(soBoard), 'and confirm the goods arrived')
ok(/setForceReady/.test(soBoard), 'and send it anyway')
// TWO guards, not one: the chip in the header and the buttons in the footer are
// separately gated, and asserting the bare string matched the chip's guard while
// the footer's had been removed — a green test over a card offering "In hand" on
// every order on the board.
ok(
  (soBoard.match(/\{fxTone && \(/g) ?? []).length >= 2,
  'AND ONLY WHILE IT IS WAITING — the chip AND the buttons are each gated, so a ready card has nothing there to press',
  String((soBoard.match(/\{fxTone && \(/g) ?? []).length)
)
ok(
  /inv-move-\$\{fxTone\}/.test(soBoard),
  'and the button wears the same colour as the chip that says why it is there'
)

ok(/fulfillmentStageOf/.test(soBoard), 'the Sales Orders card reads the fulfilment stage')
ok(/fx-lane-\$\{fxTone\}/.test(soBoard), 'and wears it as a stripe')
ok(
  /po-card-drop/.test(soBoard) && /fx-lane/.test(soBoard),
  'ALONGSIDE THE DROPSHIP TINT, not instead of it — an order can be both'
)
ok(/fx-chip fx-chip-\$\{fxTone\}/.test(soBoard), 'and names it, so the colour is readable')
ok(
  /saleAwaitsItems \? ' fx-lane fx-lane-items'/.test(poBoard),
  'THE PURCHASE CARD LIGHTS UP WHEN THE SALE IT SUPPLIES HAS NOTHING — that is the order somebody has to chase'
)
// One definition of each colour, shared by all three boards.
ok(
  /\.fx-lane-items \{[^}]*--info/.test(css) && /\.fx-lane-dims \{[^}]*--warning/.test(css),
  'blue for items and amber for dims, defined once'
)
ok(
  /\.fx-lane \{[^}]*border-left-width/.test(css),
  'and applied as a border rather than a background, so the dropship tint survives underneath'
)

// ---------------------------------------------------------------------------
console.log('\n=== 11. the sales order buckets ===')
// ---------------------------------------------------------------------------
/**
 * The owner's words: "we can add a bucket which is draft in QuickBooks and then
 * it should be ready to ship and then payment and then in the payment section
 * we can mark if a sales order has been paid or not yet".
 *
 * The stage VALUES are untouched — nothing stored moves and nothing re-syncs —
 * and what the last two MEAN has narrowed. `paid` is the payment step; whether
 * money arrived is its own fact.
 */
const { INVOICE_STAGES, isInvoicePaid } = require('../src/shared/invoices')
ok(
  INVOICE_STAGES.map((s: any) => s.label).join(' | ') ===
    'Draft | In QuickBooks | Ready to ship | Payment',
  'the board reads Draft, In QuickBooks, Ready to ship, Payment',
  INVOICE_STAGES.map((s: any) => s.label).join(' | ')
)
ok(
  INVOICE_STAGES.map((s: any) => s.id).join(' | ') === 'draft | created | sent | paid',
  'ON THE SAME STORED VALUES — a relabel, not a migration, so nothing already written moves',
  INVOICE_STAGES.map((s: any) => s.id).join(' | ')
)

ok(!isInvoicePaid({ paidAt: null }), 'an order nobody has marked is not paid')
ok(isInvoicePaid({ paidAt: '2026-08-20T00:00:00.000Z' }), 'a tick on the board makes it paid')
ok(
  isInvoicePaid({ paidAt: null, qboPaidAt: '2026-08-20T00:00:00.000Z' }),
  'AND SO DOES QUICKBOOKS ON ITS OWN — an order settled over there needs no tick here'
)
ok(
  !isInvoicePaid({ paidAt: '2026-08-20T00:00:00.000Z', qboVoided: true }),
  'a voided QuickBooks copy un-pays it, whatever the board said'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
