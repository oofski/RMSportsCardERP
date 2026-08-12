/**
 * Will QuickBooks take this invoice — asked before it is sent, and answered the
 * same way it would be answered after.
 *
 * ## The bug this suite is about
 *
 * QuickBooks does not accept names. Every invoice line has to resolve to a real
 * Product/Service id in the connected company, and this app cannot invent one.
 * So an invoice naming a case QuickBooks has never heard of is refused — which
 * is correct, and which used to arrive at the worst possible moment: after Save,
 * as a toast, from a button labelled "Create in QuickBooks". The invoice existed
 * here and not there, and the message was about a product name.
 *
 * The information was knowable a minute earlier, so now it is asked for earlier.
 *
 * ## THE PROPERTY THAT MATTERS MOST
 *
 * A check that runs while somebody is typing and a refusal that fires at post
 * time must give the SAME answer. Two functions applying "the same" matching
 * rule is exactly how they come to disagree — over a line whose SKU matches and
 * whose name does not, say — and the failure mode is the worst kind of all: a
 * green tick followed by a refusal, which teaches people to ignore the tick.
 *
 * So section 2 asserts the equivalence directly, over every shape of line this
 * app can produce: `missingQboItems` is empty if and only if `toQboInvoice`
 * builds a payload. Break the matcher in one place and this suite goes red even
 * though the other place still "works".
 *
 * ## AND THE THINGS THAT TOUCH REAL BOOKS
 *
 * Creating a Product/Service writes to somebody's accounting system. Two
 * decisions in that payload are pinned here because getting either wrong is
 * discovered by an accountant rather than by a user:
 *
 *   NonInventory, never Inventory — or QuickBooks starts counting stock this app
 *   already counts against FIFO cost lots, and the two disagree forever.
 *
 *   The income account is passed in, never chosen — same rule the whole
 *   integration runs on. A guessed account id posts real revenue somewhere
 *   nobody picked.
 *
 * Run: npm run test:qbo-readiness
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  QBO_ITEM_NAME_MAX,
  describeMissingQboItems,
  missingQboItems,
  resolveLineItemRef,
  toQboCustomerPayload,
  toQboInvoice,
  toQboItemPayload
} = require('../src/shared/invoices')

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
const threw = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

interface Match {
  id: string
  name?: string
  sku?: string | null
}

/** The company's catalog, as the two lookup maps the matcher is given. */
const byName = new Map<string, Match>([
  ['2024 topps series 1 hobby box', { id: '10', name: '2024 Topps Series 1 Hobby Box', sku: 'TS1-HOB' }],
  ['grading submission fee', { id: '11', name: 'Grading submission fee', sku: null }],
  ['renamed in quickbooks', { id: '12', name: 'Renamed in QuickBooks', sku: 'OLD-SKU' }]
])
const bySku = new Map<string, Match>([
  ['ts1-hob', { id: '10', name: '2024 Topps Series 1 Hobby Box', sku: 'TS1-HOB' }],
  ['old-sku', { id: '12', name: 'Renamed in QuickBooks', sku: 'OLD-SKU' }]
])

// The case the owner actually hit, named exactly as their toast named it.
const MEGA = '2025 Bowman Draft Baseball Mega 20-Box Case'

// ---------------------------------------------------------------------------
console.log('=== 1. what is missing ===')
// ---------------------------------------------------------------------------

ok(missingQboItems([], byName, bySku).length === 0, 'no lines, nothing missing')

ok(
  missingQboItems([{ item: '2024 Topps Series 1 Hobby Box', sku: null }], byName, bySku).length === 0,
  'a name the company has is not missing'
)

ok(
  missingQboItems([{ item: 'Whatever they called it', sku: 'TS1-HOB' }], byName, bySku).length === 0,
  'a SKU match is enough even when the name is nothing like it'
)

ok(
  missingQboItems([{ item: 'Renamed in QuickBooks', sku: 'NOT-A-SKU' }], byName, bySku).length === 0,
  'a SKU miss falls back to the name rather than reporting the line missing'
)

const one = missingQboItems([{ item: MEGA, sku: 'BOWDR-25-MEGA' }], byName, bySku)
ok(one.length === 1, 'a name and SKU the company has neither of is missing', JSON.stringify(one))
ok(one[0].kind === 'item', 'reported as an item')
ok(one[0].name === MEGA, 'named EXACTLY as typed, so it can be created from the report')
ok(one[0].sku === 'BOWDR-25-MEGA', 'carrying our SKU, which is what makes the next send match')

ok(
  missingQboItems([{ item: MEGA, sku: null }], byName, bySku)[0].sku === null,
  'a line with no SKU reports null rather than an empty string'
)
ok(
  missingQboItems([{ item: MEGA, sku: '   ' }], byName, bySku)[0].sku === null,
  'and whitespace is not a SKU'
)

// ---- deduplication --------------------------------------------------------
// The same missing case on four lines of one invoice is ONE thing to go and
// create. Saying it four times reads as four separate problems, and the panel
// would show four buttons that each create the same item — the second of which
// fails, because QuickBooks enforces unique item names.
const repeated = missingQboItems(
  [
    { item: MEGA, sku: 'BOWDR-25-MEGA' },
    { item: MEGA, sku: 'BOWDR-25-MEGA' },
    { item: MEGA, sku: 'BOWDR-25-MEGA' }
  ],
  byName,
  bySku
)
ok(repeated.length === 1, 'the same missing item on three lines is reported once')

const twoDifferent = missingQboItems(
  [
    { item: MEGA, sku: 'BOWDR-25-MEGA' },
    { item: 'Another Missing Case', sku: 'OTHER-SKU' }
  ],
  byName,
  bySku
)
ok(twoDifferent.length === 2, 'two genuinely different misses are both reported')

// Same SKU, two spellings of the name — one item to create, not two. Deduping on
// the SKU rather than the name is what gets this right.
const sameSku = missingQboItems(
  [
    { item: 'Mega Case', sku: 'BOWDR-25-MEGA' },
    { item: 'Mega  Case', sku: 'BOWDR-25-MEGA' }
  ],
  byName,
  bySku
)
ok(sameSku.length === 1, 'one SKU spelled two ways is one thing to create')

// Same name, no SKUs — also one.
const sameName = missingQboItems(
  [
    { item: MEGA, sku: null },
    { item: mixedCase(MEGA), sku: null }
  ],
  byName,
  bySku
)
ok(sameName.length === 1, 'one name in two cases is one thing to create')

function mixedCase(s: string): string {
  return s.toUpperCase()
}

// ---------------------------------------------------------------------------
console.log('=== 2. the check and the refusal cannot disagree ===')
// ---------------------------------------------------------------------------
// The load-bearing assertion of this file. See the header.

const detailFor = (lines: Array<{ item: string; sku: string | null }>): unknown => ({
  id: 'inv-1',
  invoiceNumber: '1001',
  invoiceDate: '2026-08-12',
  dueDate: '2026-09-11',
  customerName: 'Test Buyer',
  email: null,
  billAddr: null,
  terms: 'net30',
  message: null,
  memo: null,
  lines: lines.map((l, i) => ({
    id: `l${i}`,
    item: l.item,
    sku: l.sku,
    description: null,
    quantity: 1,
    rate: 100,
    amount: 100
  }))
})

/** Every shape of line this app can produce, matching and not. */
const SHAPES: Array<{ label: string; lines: Array<{ item: string; sku: string | null }> }> = [
  { label: 'nothing at all', lines: [] },
  { label: 'one good name', lines: [{ item: '2024 Topps Series 1 Hobby Box', sku: null }] },
  { label: 'one good SKU, wrong name', lines: [{ item: 'Nope', sku: 'TS1-HOB' }] },
  { label: 'name match, SKU miss', lines: [{ item: 'Renamed in QuickBooks', sku: 'GONE' }] },
  { label: 'a service with no SKU', lines: [{ item: 'Grading submission fee', sku: null }] },
  { label: 'one missing', lines: [{ item: MEGA, sku: 'BOWDR-25-MEGA' }] },
  { label: 'missing with no SKU', lines: [{ item: MEGA, sku: null }] },
  {
    label: 'good and missing together',
    lines: [
      { item: '2024 Topps Series 1 Hobby Box', sku: 'TS1-HOB' },
      { item: MEGA, sku: 'BOWDR-25-MEGA' }
    ]
  },
  {
    label: 'two missing',
    lines: [
      { item: MEGA, sku: 'BOWDR-25-MEGA' },
      { item: 'Second Missing', sku: null }
    ]
  },
  {
    label: 'the same missing twice',
    lines: [
      { item: MEGA, sku: 'BOWDR-25-MEGA' },
      { item: MEGA, sku: 'BOWDR-25-MEGA' }
    ]
  },
  { label: 'case-insensitive name', lines: [{ item: '2024 TOPPS SERIES 1 HOBBY BOX', sku: null }] },
  { label: 'padded name', lines: [{ item: '  Grading submission fee  ', sku: null }] },
  { label: 'case-insensitive SKU', lines: [{ item: 'Nope', sku: 'ts1-hob' }] }
]

for (const shape of SHAPES) {
  const missing = missingQboItems(shape.lines, byName, bySku)
  const err = threw(() =>
    toQboInvoice(detailFor(shape.lines), { id: '99', name: 'Test Buyer' }, byName, {
      itemsBySku: bySku
    })
  )
  ok(
    (missing.length === 0) === (err === null),
    `${shape.label}: the check and the payload builder agree`,
    `check said ${missing.length} missing, builder said ${err ?? 'ok'}`
  )
  // And when they agree there IS a problem, they name it the same way. A warning
  // worded differently from the error reads as a second, separate problem.
  if (missing.length > 0) {
    ok(
      err === describeMissingQboItems(missing),
      `${shape.label}: word for word the same sentence`,
      `\n    warn: ${describeMissingQboItems(missing)}\n    err:  ${err}`
    )
  }
}

// The exact sentence the owner saw, reproduced from the check alone.
ok(
  describeMissingQboItems([{ kind: 'item', name: MEGA, sku: null }]) ===
    `QuickBooks has no product or service called “${MEGA}”. Add it in QuickBooks first, or ` +
      'export the CSV instead.',
  'the warning is the sentence the owner was shown'
)

// A line with no SKU still resolves by name, which is what keeps services working.
ok(
  resolveLineItemRef({ item: 'Grading submission fee', sku: null }, byName, bySku).id === '11',
  'a service with no SKU resolves by name'
)

// ---------------------------------------------------------------------------
console.log('=== 3. creating the missing item ===')
// ---------------------------------------------------------------------------

const item = toQboItemPayload({ name: MEGA, incomeAccountId: '79', sku: 'BOWDR-25-MEGA' })
ok(item.Name === MEGA, 'the name goes over exactly as typed')
ok(item.Sku === 'BOWDR-25-MEGA', 'and OUR SKU with it, so the next send matches on SKU')

// The decision an accountant would find later. QuickBooks tracking quantity on
// hand for a product this app already counts against FIFO cost lots is two
// systems disagreeing about the same boxes, forever.
ok(item.Type === 'NonInventory', 'created as NonInventory, never Inventory')
ok(
  (item.IncomeAccountRef as { value: string }).value === '79',
  'against the income account it was GIVEN'
)
ok(
  !('AssetAccountRef' in item) && !('InvOnHand' in item) && !('InvStartDate' in item),
  'and with none of the inventory fields, which is what NonInventory means'
)

// The rule the whole integration runs on: an account id this app invented posts
// real revenue somewhere nobody chose.
const noAccount = threw(() => toQboItemPayload({ name: MEGA, incomeAccountId: '' }))
ok(noAccount !== null, 'a blank income account is refused rather than defaulted')
ok(
  (noAccount ?? '').includes('Break sales income'),
  'and the refusal names the setting to go and change',
  noAccount ?? ''
)
ok(
  (noAccount ?? '').includes('Account mapping'),
  'and where to find it'
)

ok(threw(() => toQboItemPayload({ name: '   ', incomeAccountId: '79' })) !== null, 'a blank name is refused')

const tooLong = threw(() =>
  toQboItemPayload({ name: 'x'.repeat(QBO_ITEM_NAME_MAX + 1), incomeAccountId: '79' })
)
ok(tooLong !== null, `over ${QBO_ITEM_NAME_MAX} characters is refused here`)
ok(
  (tooLong ?? '').includes(String(QBO_ITEM_NAME_MAX)),
  'saying the limit, rather than passing it on for a numbered Intuit fault'
)
ok(
  threw(() => toQboItemPayload({ name: 'x'.repeat(QBO_ITEM_NAME_MAX), incomeAccountId: '79' })) ===
    null,
  'and exactly the limit is fine'
)

// Optional fields are omitted rather than sent empty — QuickBooks stores an
// empty Description as a real, blank description.
const bare = toQboItemPayload({ name: 'Plain', incomeAccountId: '79' })
ok(!('Sku' in bare), 'no SKU means no Sku field')
ok(!('Description' in bare), 'no description means no Description field')
ok(!('UnitPrice' in bare), 'no rate means no UnitPrice field')

const priced = toQboItemPayload({ name: 'Priced', incomeAccountId: '79', rate: 249.99 })
ok(priced.UnitPrice === 249.99, 'a rate is carried')
ok(
  !('UnitPrice' in toQboItemPayload({ name: 'Zero', incomeAccountId: '79', rate: 0 })),
  'a zero rate is not a price and is left off'
)
ok(
  !('UnitPrice' in toQboItemPayload({ name: 'Nan', incomeAccountId: '79', rate: NaN })),
  'and neither is a NaN'
)

// ---------------------------------------------------------------------------
console.log('=== 4. creating the missing customer ===')
// ---------------------------------------------------------------------------

const cust = toQboCustomerPayload({ name: 'Riverside Cards LLC' })
ok(cust.DisplayName === 'Riverside Cards LLC', 'DisplayName is what an invoice matches on')
ok(
  !('GivenName' in cust) && !('FamilyName' in cust),
  'so the name parts are left alone — QuickBooks would compose a DIFFERENT display name'
)
ok(!('PrimaryEmailAddr' in cust), 'no email means no email field')
ok(!('BillAddr' in cust), 'no address means no address field')

const withEmail = toQboCustomerPayload({ name: 'Riverside Cards LLC', email: 'ap@example.test' })
ok(
  (withEmail.PrimaryEmailAddr as { Address: string }).Address === 'ap@example.test',
  'an email is carried'
)

const withAddr = toQboCustomerPayload({
  name: 'Riverside Cards LLC',
  billAddr: {
    line1: '18 Mill Road',
    line2: null,
    city: 'Ames',
    region: 'IA',
    postalCode: '50010',
    country: null
  }
})
const addr = withAddr.BillAddr as Record<string, string>
ok(addr.Line1 === '18 Mill Road' && addr.City === 'Ames', 'an address is carried')
ok(addr.CountrySubDivisionCode === 'IA', 'the state goes in Intuit’s oddly named field')
ok(!('Line2' in addr) && !('Country' in addr), 'and the blank parts are omitted, not sent empty')

ok(
  !(
    'BillAddr' in
    toQboCustomerPayload({
      name: 'Nobody',
      billAddr: {
        line1: null,
        line2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null
      }
    })
  ),
  'an address with nothing in it is no address'
)

ok(threw(() => toQboCustomerPayload({ name: '  ' })) !== null, 'a blank customer name is refused')

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
