/**
 * Shipping and payment — the four facts that ride on both sides of the money.
 *
 * What is worth pinning here, and how each one fails if it is wrong:
 *
 *   1. CARRIER DETECTION MUST NOT GUESS. A 20-digit number is a valid FedEx
 *      SmartPost label AND a valid USPS one. Guessing sends somebody to a
 *      carrier's "not found" page, which reads as "your package does not
 *      exist" — strictly worse than showing no link at all. So the ambiguous
 *      cases must come back null.
 *
 *   2. AN EXPLICIT CHOICE IS NEVER OVERRULED. Detection fills a BLANK carrier.
 *      A person who picked FedEx because they know it shipped FedEx must not
 *      have that flipped by a pattern match on the number they then paste.
 *
 *   3. PAYMENT IS A CHOICE, NOT TWO FLAGS. Front and Upon Delivery are two
 *      checkboxes, but only one can be true, and "nobody has decided yet" is a
 *      real third state that must survive. Defaulting to either answer would
 *      put a claim on the record that no person made.
 *
 *   4. IT ACTUALLY PERSISTS, ON BOTH TABLES. purchase_orders and invoices got
 *      the same four columns in the same migration; a test that only covered
 *      one would let the other rot.
 *
 * Run: npm run test:freight
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/freight-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const poRepo = require('../src/main/db/purchaseOrders')
const invRepo = require('../src/main/db/invoices')
const {
  asCarrier,
  asPaymentTiming,
  carrierLabel,
  detectCarrier,
  looksLikeTracking,
  paymentLabel,
  servicesFor,
  togglePayment,
  trackingUrl
} = require('../src/shared/freight')
const { shipMeta } = require('../src/main/freightPdf')
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

// ---------------------------------------------------------------------------
console.log('=== 1. reading a carrier off a tracking number ===')
// ---------------------------------------------------------------------------
ok(detectCarrier('1Z999AA10123456784') === 'ups', 'a 1Z number is UPS')
ok(detectCarrier('1z999aa10123456784') === 'ups', 'and case does not matter')
ok(detectCarrier('1Z 999 AA1 01 2345 6784') === 'ups', 'nor do the spaces people paste')
ok(detectCarrier('1Z-999AA1-0123456784') === 'ups', 'nor hyphens')
ok(detectCarrier('123456789012') === 'fedex', '12 digits is FedEx')
ok(detectCarrier('123456789012345') === 'fedex', 'and 15 is FedEx Ground')
ok(detectCarrier('9400111899223197428490') === 'usps', 'a 94… number is USPS')
ok(detectCarrier('9205590164917312751089') === 'usps', 'and a 92… one')
ok(detectCarrier('1234567890123456789012') === 'usps', '22 bare digits is USPS alone')

// THE ONE THAT MATTERS: 20 digits belongs to both, so it belongs to neither.
ok(
  detectCarrier('12345678901234567890') === null,
  '20 digits is ambiguous, so nothing is claimed',
  String(detectCarrier('12345678901234567890'))
)
ok(detectCarrier('') === null, 'nothing in, nothing out')
ok(detectCarrier('   ') === null, 'and whitespace is nothing')
ok(detectCarrier('hello') === null, 'a word is not a tracking number')
ok(detectCarrier('1Z999AA1012345678') === null, 'a 1Z with the wrong length is refused')

// ---------------------------------------------------------------------------
console.log('\n=== 2. the link, and when there must not be one ===')
// ---------------------------------------------------------------------------
ok(
  trackingUrl('ups', '1Z999AA10123456784') ===
    'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  'UPS deep link'
)
ok(
  (trackingUrl('fedex', '123456789012') ?? '').startsWith('https://www.fedex.com/fedextrack/'),
  'FedEx deep link'
)
ok(
  (trackingUrl('usps', '9400111899223197428490') ?? '').startsWith('https://tools.usps.com/'),
  'USPS deep link'
)
// No carrier given? Fall back to reading the number.
ok(
  trackingUrl(null, '1Z999AA10123456784') ===
    'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  'a bare number that names itself still links'
)
// And when it does NOT name itself, there is no link — see reason 1 above.
ok(trackingUrl(null, '12345678901234567890') === null, 'an ambiguous number gets no link')
ok(trackingUrl('ups', '') === null, 'a carrier with no number gets no link')
ok(trackingUrl('dhl', '123456789012') === null, 'an unknown carrier is not guessed at')
// A number is put in a URL, so it has to be encoded.
ok(
  (trackingUrl('ups', 'A&B=C') ?? '').includes('A%26B%3DC'),
  'the number is URL-encoded',
  String(trackingUrl('ups', 'A&B=C'))
)

ok(looksLikeTracking('1Z999AA10123456784'), 'a real number looks like one')
ok(!looksLikeTracking('123'), 'three digits does not')
ok(!looksLikeTracking('has spaces in it!'), 'nor does a sentence')

// ---------------------------------------------------------------------------
console.log('\n=== 3. two checkboxes, one answer, and "not said" ===')
// ---------------------------------------------------------------------------
ok(togglePayment(null, 'front') === 'front', 'ticking Front from blank sets Front')
ok(togglePayment('front', 'delivery') === 'delivery', 'ticking the other one replaces it')
ok(togglePayment('front', 'front') === null, 'ticking the ticked one clears it')
ok(togglePayment('delivery', 'delivery') === null, 'both ways')
// Round trip: two clicks on the same box gets you back where you started.
ok(
  togglePayment(togglePayment(null, 'front'), 'front') === null,
  'so a mis-click is undoable with a second click'
)

ok(asPaymentTiming('front') === 'front', 'front survives the boundary')
ok(asPaymentTiming('delivery') === 'delivery', 'so does delivery')
ok(asPaymentTiming('later') === null, 'and anything else reads as not-said')
ok(asPaymentTiming(undefined) === null, 'including undefined')
ok(asCarrier('ups') === 'ups', 'a real carrier survives')
ok(asCarrier('dhl') === null, 'one we do not use does not')
ok(carrierLabel('fedex') === 'FedEx', 'carriers print with their own capitals')
ok(carrierLabel(null) === '', 'and nothing prints as nothing')
ok(paymentLabel('delivery') === 'Upon delivery', 'payment prints in words')

// The service list follows the carrier, and falls back to the three the owner
// named when no carrier has been picked yet.
ok(servicesFor('ups').includes('Next Day Air'), 'UPS sells Next Day Air')
ok(servicesFor('usps').includes('Priority Mail'), 'USPS sells Priority Mail')
ok(!servicesFor('usps').includes('Next Day Air'), 'and USPS does not sell UPS services')
ok(servicesFor(null).includes('Ground'), 'with no carrier, the common three are offered')

// ---------------------------------------------------------------------------
console.log('\n=== 4. a purchase order remembers it ===')
// ---------------------------------------------------------------------------
db.prepare(
  `INSERT INTO inventory_products (id, name, sku, category, unit_cost, created_at, updated_at)
   VALUES ('p_fr1', 'Test Hobby Box', 'TST-001', 'Baseball', 100, '2026-03-01T12:00:00.000Z',
           '2026-03-01T12:00:00.000Z')`
).run()

const po = poRepo.createPurchaseOrder(
  {
    supplier: 'Steel City',
    location: 'RM',
    carrier: 'ups',
    service: 'Next Day Air',
    trackingNumber: '1Z999AA10123456784',
    paymentTiming: 'front',
    lines: [{ productId: 'p_fr1', quantity: 2, unitPrice: 100 }]
  },
  'emp_owner'
)
ok(po.carrier === 'ups', 'the carrier comes back')
ok(po.service === 'Next Day Air', 'so does the service')
ok(po.trackingNumber === '1Z999AA10123456784', 'and the number')
ok(po.paymentTiming === 'front', 'and when it gets paid')
// The board reads from a different query than the detail view does.
const listed = poRepo.listPurchaseOrders().find((p: { id: string }) => p.id === po.id)
ok(listed?.trackingNumber === '1Z999AA10123456784', 'and the BOARD sees it too, not just the detail')
ok(listed?.carrier === 'ups', 'carrier included')

// A PO raised with only a number gets its carrier worked out — the usual case,
// because the number is what somebody has and the carrier is a fact about it.
const po2 = poRepo.createPurchaseOrder(
  { location: 'RM', trackingNumber: '9400111899223197428490', lines: [{ productId: 'p_fr1', quantity: 1, unitPrice: 5 }] },
  'emp_owner'
)
ok(po2.carrier === 'usps', 'a number alone names its own carrier')

// An explicit choice is NOT overruled by the number — reason 2 at the top.
const po3 = poRepo.createPurchaseOrder(
  {
    location: 'RM',
    carrier: 'fedex',
    trackingNumber: '1Z999AA10123456784',
    lines: [{ productId: 'p_fr1', quantity: 1, unitPrice: 5 }]
  },
  'emp_owner'
)
ok(po3.carrier === 'fedex', 'a chosen carrier beats what the number looks like')

// Nothing said stays nothing said.
const po4 = poRepo.createPurchaseOrder(
  { location: 'RM', lines: [{ productId: 'p_fr1', quantity: 1, unitPrice: 5 }] },
  'emp_owner'
)
ok(po4.carrier === null, 'a PO with no shipping details claims none')
ok(po4.paymentTiming === null, 'and no payment answer')

// ---------------------------------------------------------------------------
console.log('\n=== 5. adding tracking later, which is the normal case ===')
// ---------------------------------------------------------------------------
const later = poRepo.setPurchaseOrderFreight(po4.id, { trackingNumber: '123456789012' })
ok(later.error === undefined, 'the update succeeds', String(later.error))
ok(later.po.trackingNumber === '123456789012', 'the number lands')
ok(later.po.carrier === 'fedex', 'and the carrier is worked out from it')

// A patch touches only what it names. THIS is the point of the patch shape: a
// screen that knows the tracking number must not blank a payment choice.
poRepo.setPurchaseOrderFreight(po4.id, { paymentTiming: 'delivery' })
const afterPay = poRepo.setPurchaseOrderFreight(po4.id, { trackingNumber: '123456789013' }).po
ok(afterPay.paymentTiming === 'delivery', 'setting tracking leaves payment alone')
ok(afterPay.service === null, 'and does not invent a service')

// An explicit null CLEARS, which is different from not mentioning the field.
const cleared = poRepo.setPurchaseOrderFreight(po4.id, { paymentTiming: null }).po
ok(cleared.paymentTiming === null, 'an explicit null clears the answer')

// Changing the number re-derives the carrier, so the pair can never end up
// describing two different carriers.
const swapped = poRepo.setPurchaseOrderFreight(po4.id, {
  carrier: null,
  trackingNumber: '1Z999AA10123456784'
}).po
ok(swapped.carrier === 'ups', 'clearing the carrier and pasting a UPS number gives UPS')

ok(
  poRepo.setPurchaseOrderFreight('po_does_not_exist', { trackingNumber: 'x' }).error !== undefined,
  'an unknown PO is refused, not silently ignored'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. an invoice remembers it too ===')
// ---------------------------------------------------------------------------
const inv = invRepo.saveInvoice(
  {
    customerName: 'Dana Whitfield',
    invoiceDate: '2026-03-01',
    carrier: 'fedex',
    service: 'Ground',
    trackingNumber: '123456789012',
    paymentTiming: 'delivery',
    lines: [{ item: 'Test Hobby Box', quantity: 1, rate: 250 }]
  },
  'emp_owner'
)
ok(inv.carrier === 'fedex', 'the carrier comes back on an invoice')
ok(inv.service === 'Ground', 'and the service')
ok(inv.trackingNumber === '123456789012', 'and the number')
ok(inv.paymentTiming === 'delivery', 'and when it gets paid')
const invListed = invRepo.listInvoices().find((i: { id: string }) => i.id === inv.id)
ok(invListed?.trackingNumber === '123456789012', 'the invoices BOARD sees it too')

// An invoice raised with only a number names its own carrier, same rule as a PO.
const inv2 = invRepo.saveInvoice(
  {
    customerName: 'Dana Whitfield',
    invoiceDate: '2026-03-01',
    trackingNumber: '1Z999AA10123456784',
    lines: [{ item: 'Test Hobby Box', quantity: 1, rate: 10 }]
  },
  'emp_owner'
)
ok(inv2.carrier === 'ups', 'and the same detection runs on the sell side')

// EDITING a saved draft must work — the shipping details are the fields most
// likely to be added on a second pass, because the tracking number does not
// exist when the invoice is first raised.
let editThrew = ''
try {
  const edited = invRepo.saveInvoice(
    {
      id: inv2.id,
      customerName: 'Dana Whitfield',
      invoiceDate: '2026-03-01',
      trackingNumber: '9400111899223197428490',
      carrier: null,
      lines: [{ item: 'Test Hobby Box', quantity: 1, rate: 10 }]
    },
    'emp_owner'
  )
  ok(edited.trackingNumber === '9400111899223197428490', 'an existing draft can be re-saved')
  ok(edited.carrier === 'usps', 'and the new number re-derives the carrier')
} catch (e) {
  editThrew = e instanceof Error ? e.message : String(e)
}
ok(editThrew === '', 'editing a draft does not throw', editThrew)

// ---------------------------------------------------------------------------
console.log('\n=== 7. what gets printed ===')
// ---------------------------------------------------------------------------
const printed = shipMeta(
  { carrier: 'ups', service: 'Next Day Air', trackingNumber: '1Z999AA10123456784', paymentTiming: 'front' },
  { key: 'k', value: 'v' }
)
ok(printed.includes('UPS Next Day Air'), 'carrier and service print as one phrase')
ok(printed.includes('1Z999AA10123456784'), 'the number is printed')
ok(printed.includes('Front'), 'and how it is paid')
ok(printed.includes('class="k"'), 'using the classes the caller asked for')

// EMPTY MEANS ABSENT, not a dash. A header full of empty "Tracking" labels on
// every order is a header where nobody notices the orders that have one.
const bare = shipMeta(
  { carrier: null, service: null, trackingNumber: null, paymentTiming: null },
  { key: 'k', value: 'v' }
)
ok(bare === '', 'an order with no shipping details prints nothing at all', JSON.stringify(bare))
ok(
  !shipMeta(
    { carrier: 'ups', service: null, trackingNumber: null, paymentTiming: null },
    { key: 'k', value: 'v' }
  ).includes('Tracking'),
  'a carrier with no number does not print an empty Tracking cell'
)

// A tracking number is operator-typed and lands in a document that gets sent.
const nasty = shipMeta(
  {
    carrier: 'ups',
    service: '<script>alert(1)</script>',
    trackingNumber: '1Z999AA10123456784',
    paymentTiming: null
  },
  { key: 'k', value: 'v' }
)
ok(!nasty.includes('<script>'), 'a script tag in a service name is escaped')
ok(nasty.includes('&lt;script&gt;'), 'and rendered as text')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
