/**
 * WHAT A BOARD SAYS ABOUT AN ORDER WITHOUT BEING OPENED.
 *
 * The owner's three, in their words:
 *
 *   · "clearly be able to see what is paid vs unpaid, shipped vs not shipped,
 *     payment up front / payment upon delivery"
 *   · "be able to see what is ready to be packed / what has been paid so that
 *     the label can be sent to the dropship source"
 *   · "be able to see who the source is on a dropship sales order and who the
 *     destination is on a dropship purchase order"
 *
 * Every one of those facts was already in the database. What none of them had
 * was a WORD on the card — each was shown by something being present, and
 * absence is not something anybody scans for.
 *
 * ## What is pinned here, and how each fails if it is wrong
 *
 *   1. NO STATE IS EXPRESSED BY A MISSING CHIP. All three slots are always
 *      filled, including the boring answers — Not shipped, Terms not set. A slot
 *      that vanished would be a card that looks like it has less to say rather
 *      than one saying "no".
 *
 *   2. SHIPPED READS BOTH PLACES A TRACKING NUMBER LIVES. The header column and
 *      order_shipments. A four-box order split across two labels has two parcels
 *      and can carry nothing on the header, so a chip reading only the header
 *      reports a fully shipped order as not shipped — which is the exact lie
 *      this chip exists to stop.
 *
 *   3. THE FILTERS AND THE CHIPS SHARE ONE RULE. A filter whose idea of
 *      "shipped" differs from the chip's hides the card it claims to show, and
 *      nothing on screen would say why.
 *
 *   4. FILTERS COMBINE WITH AND. "Unpaid" alone answers nothing useful; "unpaid
 *      AND not shipped" is the pile where nothing has happened and "paid AND
 *      ready to pack" is the list of labels to buy. OR would return everything.
 *
 *   5. A DROPSHIP LABEL GOES TO THE SUPPLIER. They have the boxes. The buyer's
 *      address must NOT be the fallback when the supplier is unknown — a
 *      plausible wrong party in the To box of a message about to be sent is
 *      worse than an empty one.
 *
 * Every name here is invented.
 *
 * Run: npm run test:order-status
 */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  ORDER_FILTERS,
  isDropship,
  isShipped,
  moneyChip,
  orderStatusChips,
  passesOrderFilters,
  shipChip,
  termsChip
} = require('../src/shared/orderStatus')
const { labelRecipientFor } = require('../src/shared/orders')

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

const PAID = '2026-08-20T15:00:00.000Z'

/** An ordinary sale off our own shelf: unpaid, unshipped, no terms said. */
const order = (over: Record<string, unknown> = {}): any => ({
  status: 'created',
  paidAt: null,
  qboPaidAt: null,
  qboVoided: false,
  paymentTiming: null,
  paidUpFront: false,
  trackingNumber: null,
  trackingStatus: null,
  trackedParcels: 0,
  dropshipUnits: 0,
  sourcePoId: null,
  readyToPack: false,
  ...over
})

// ---------------------------------------------------------------------------
console.log('=== 1. all three slots are always filled ===')
// ---------------------------------------------------------------------------
const bare = orderStatusChips(order())
ok(bare.length === 3, 'three chips', String(bare.length))
ok(
  bare.map((c: any) => c.slot).join('>') === 'money>ship>terms',
  'in a fixed order, so a column reads down',
  bare.map((c: any) => c.slot).join('>')
)
ok(
  bare.every((c: any) => c.label.length > 0),
  'AND NONE OF THEM IS BLANK — a state is never expressed by a missing chip',
  JSON.stringify(bare.map((c: any) => c.label))
)
ok(
  bare.every((c: any) => c.title.length > 0 && c.title !== c.label),
  'each carries a longer answer that is not just the label again'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. money ===')
// ---------------------------------------------------------------------------
ok(moneyChip(order()).label === 'Unpaid', 'nothing recorded reads Unpaid')
ok(moneyChip(order()).tone === 'bad', 'in the colour of something to chase')
ok(moneyChip(order({ paidAt: PAID })).label === 'Paid', 'a tick on this floor is Paid')
ok(
  moneyChip(order({ qboPaidAt: '2026-08-20' })).label === 'Paid',
  'AND SO IS QUICKBOOKS ON ITS OWN — an invoice settled over there needs no tick here'
)
ok(
  moneyChip(order({ paidAt: PAID, qboVoided: true })).label === 'Unpaid',
  'a voided QuickBooks copy un-pays it, whatever the board said'
)
// A VOID ORDER IS NEITHER. Saying "Unpaid" on a cancelled sale sends somebody to
// chase money for boxes that went back on the shelf.
ok(moneyChip(order({ status: 'void' })).label === 'Void', 'a cancelled order is neither')
ok(
  moneyChip(order({ status: 'void', paidAt: PAID })).label === 'Void',
  'even one that was paid before it was cancelled'
)
// The up-front tooltip is the one worth saying more in: it is the order that
// cannot go on the packing list, and the chip is where somebody looks first.
ok(
  /packing list/i.test(moneyChip(order({ paymentTiming: 'front' })).title),
  'an unpaid up-front order says on its tooltip that it is held',
  moneyChip(order({ paymentTiming: 'front' })).title
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. shipped, and it reads BOTH places a number lives ===')
// ---------------------------------------------------------------------------
ok(shipChip(order()).label === 'Not shipped', 'nothing tracked reads Not shipped')
ok(shipChip(order()).tone === 'idle', 'in grey — it is the ordinary state of a young order, not a fault')
ok(!isShipped(order()), 'and the filter agrees')

ok(shipChip(order({ trackingNumber: '1Z999AA10123456784' })).label === 'Shipped', 'a header number is shipped')
ok(
  shipChip(order({ trackedParcels: 2 })).label === 'Shipped',
  'AND SO ARE PARCELS WITH AN EMPTY HEADER — a split shipment lives in order_shipments, and reading only the header reports a fully shipped order as not shipped'
)
ok(isShipped(order({ trackedParcels: 2 })), 'the filter agrees about parcels too')
ok(
  shipChip(order({ trackingNumber: '   ' })).label === 'Not shipped',
  'and whitespace is not a tracking number'
)

// The carrier's own word WINS once there is one: Delivered is a strictly better
// answer than Shipped, and this column is read for the furthest-along truth.
ok(
  shipChip(order({ trackingNumber: '1Z9', trackingStatus: 'delivered' })).label === 'Delivered',
  'the carrier’s word wins over the generic one'
)
ok(shipChip(order({ trackingNumber: '1Z9', trackingStatus: 'delivered' })).tone === 'good', 'and it is green')
ok(
  shipChip(order({ trackingNumber: '1Z9', trackingStatus: 'exception' })).tone === 'bad',
  'an exception is the one shipping state worth interrupting for'
)
// `not_shipped` FROM A CARRIER means "we have the label and not the box", which
// is genuinely not shipped — the existence of a number must not override it.
const labelOnly = shipChip(order({ trackingNumber: '1Z9', trackingStatus: 'not_shipped' }))
ok(labelOnly.label === 'Label made', 'a label the carrier has not collected says so', labelOnly.label)
ok(
  !isShipped(order({ trackingNumber: '1Z9', trackingStatus: 'not_shipped' })),
  'AND THE FILTER COUNTS IT AS NOT SHIPPED — a number is not a collection'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. terms — and "not said" is a real third answer ===')
// ---------------------------------------------------------------------------
ok(termsChip(order()).label === 'Terms not set', 'neither box ticked says so rather than going blank')
ok(termsChip(order()).tone === 'idle', 'in grey — nobody has decided, which is not a problem')
ok(termsChip(order({ paymentTiming: 'delivery' })).label === 'On delivery', 'delivery terms are named')
ok(termsChip(order({ paymentTiming: 'front' })).label === 'Pay up front', 'and so are up-front terms')
ok(
  termsChip(order({ paymentTiming: 'front' })).tone === 'warn',
  'an unpaid up-front order is the one with a wall in front of it'
)
// THE INTENTION AND WHAT HAPPENED ARE DIFFERENT SENTENCES. "Pays up front" is
// what was agreed; "Paid up front" is what the money did.
const settledUpFront = termsChip(order({ paymentTiming: 'front', paidUpFront: true }))
ok(settledUpFront.label === 'Paid up front', 'money that arrived first says so', settledUpFront.label)
ok(settledUpFront.tone === 'good', 'and it is no longer a warning')

// ---------------------------------------------------------------------------
console.log('\n=== 5. narrowing the board ===')
// ---------------------------------------------------------------------------
const none = new Set<string>()
ok(passesOrderFilters(order(), none as any), 'NOTHING TICKED SHOWS EVERYTHING — an empty filter is a question nobody asked yet')

const only = (...ids: string[]): any => new Set(ids)
ok(passesOrderFilters(order(), only('unpaid')), 'an unpaid order survives Unpaid')
ok(!passesOrderFilters(order({ paidAt: PAID }), only('unpaid')), 'a paid one does not')
ok(passesOrderFilters(order({ paidAt: PAID }), only('paid')), 'and the other way round')

ok(passesOrderFilters(order(), only('unshipped')), 'an untracked order survives Not shipped')
ok(
  !passesOrderFilters(order({ trackedParcels: 1 }), only('unshipped')),
  'ONE PARCEL TAKES IT OUT — the filter reads the same rule the chip does'
)

ok(passesOrderFilters(order({ paymentTiming: 'front' }), only('upfront')), 'up-front terms survive Pays up front')
ok(!passesOrderFilters(order({ paymentTiming: 'delivery' }), only('upfront')), 'delivery terms do not')
ok(!passesOrderFilters(order(), only('upfront')), 'and nor does an order with no terms said')

ok(passesOrderFilters(order({ dropshipUnits: 4 }), only('dropship')), 'dropped units make it a dropship')
ok(
  passesOrderFilters(order({ sourcePoId: 'po-1' }), only('dropship')),
  'AND SO DOES A LINK TO THE PURCHASE THAT SUPPLIES IT — a sale raised from a dropship purchase is one before anybody types a line'
)
ok(!passesOrderFilters(order(), only('dropship')), 'an ordinary sale is not')

ok(passesOrderFilters(order({ readyToPack: true }), only('readyToPack')), 'a cleared order survives Ready to pack')
ok(!passesOrderFilters(order(), only('readyToPack')), 'one that has not cleared does not')

/**
 * AND, NOT OR, and this is the pair the owner asked for by name: what has been
 * paid AND is ready to be packed, so the label can go to the dropship source.
 */
const readyPaidDrop = order({ paidAt: PAID, readyToPack: true, dropshipUnits: 3 })
ok(
  passesOrderFilters(readyPaidDrop, only('paid', 'readyToPack', 'dropship')),
  'PAID + READY TO PACK + DROPSHIP is one list, and this order is on it'
)
ok(
  !passesOrderFilters(order({ paidAt: PAID, readyToPack: true }), only('paid', 'readyToPack', 'dropship')),
  'a stock order that is paid and ready is NOT on it — nothing to send a supplier'
)
ok(
  !passesOrderFilters(order({ readyToPack: true, dropshipUnits: 3 }), only('paid', 'readyToPack', 'dropship')),
  'nor is an unpaid dropship, which is the whole point of asking for Paid'
)
// Contradictory ticks empty the board ON PURPOSE. Silently reading them as
// "either" would be a third meaning for AND that applies to one pair only.
ok(
  !passesOrderFilters(order(), only('paid', 'unpaid')),
  'Paid and Unpaid together is a contradiction and shows nothing'
)

ok(ORDER_FILTERS.length === 6, 'six filters offered', String(ORDER_FILTERS.length))
ok(
  ORDER_FILTERS.every((f: any) => f.label && f.hint && f.hint !== f.label),
  'each named and explained, so a chip is never a word nobody can act on'
)
ok(
  new Set(ORDER_FILTERS.map((f: any) => f.id)).size === ORDER_FILTERS.length,
  'and no two share an id'
)

ok(isDropship({ dropshipUnits: 0, sourcePoId: null }) === false, 'a stock sale is not a dropship')
ok(isDropship({ dropshipUnits: 0, sourcePoId: 'po-1' }) === true, 'a link alone makes one')

// ---------------------------------------------------------------------------
console.log('\n=== 6. the label goes to whoever has the boxes ===')
// ---------------------------------------------------------------------------
const sale = (over: Record<string, unknown> = {}): any => ({
  email: 'buyer@example.test',
  customerName: 'Marisol Vega',
  dropSupplier: null,
  dropSupplierCount: 0,
  dropshipUnits: 0,
  sourcePoId: null,
  ...over
})

const stock = labelRecipientFor(sale())
ok(stock.email === 'buyer@example.test', 'an ordinary sale pre-fills the buyer — we pack it, the label goes on the box')
ok(stock.name === 'Marisol Vega', 'and their name, for the directory lookup')
ok(stock.note === null, 'with no note: nothing surprising happened')

const drop = labelRecipientFor(
  sale({ dropshipUnits: 3, dropSupplier: 'Steel City Collectibles', dropSupplierCount: 1 })
)
ok(drop.name === 'Steel City Collectibles', 'A DROPSHIP POINTS AT THE SUPPLIER — they have the boxes', String(drop.name))
ok(
  drop.email === null,
  'AND NOT AT THE BUYER, even though their address is right there — a label emailed to the buyer reaches somebody who cannot put it on anything',
  String(drop.email)
)
ok(
  typeof drop.note === 'string' && drop.note.includes('Steel City Collectibles') && drop.note.includes('Marisol Vega'),
  'and the screen says which party it picked, and instead of whom',
  String(drop.note)
)

const unknown = labelRecipientFor(sale({ sourcePoId: 'po-1' }))
ok(
  unknown.email === null && unknown.name === null,
  'THE BUYER IS NOT THE FALLBACK when a dropship’s supplier is unknown — a plausible wrong party in the To box is worse than an empty one'
)
ok(typeof unknown.note === 'string' && unknown.note.length > 0, 'the empty box asks a question rather than going quiet')

const split = labelRecipientFor(
  sale({ dropshipUnits: 4, dropSupplier: null, dropSupplierCount: 2 })
)
ok(split.name === null, 'two suppliers on one sale names neither')
ok(
  typeof split.note === 'string' && split.note.includes('2'),
  'and says how many, so somebody knows to pick',
  String(split.note)
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
