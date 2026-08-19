/**
 * Where the three document series start, and the one direction they can move.
 *
 * The owner's words: "this would just allow me to change the number at which I
 * want the deal ticket numbers to start at, invoice numbers to start at, and
 * then also purchase orders to start at".
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. READING NEVER MINTS. `nextPoNumber` and `nextDealTicketSeq` both write
 *      their counter back as they answer — that is what makes a number spent the
 *      moment it is handed out. Opening the numbering screen calls the PEEKS
 *      instead, and if it ever called the real generators the app would burn a
 *      purchase order number every time somebody looked at Admin.
 *
 *   2. "START AT" MEANS THE NEXT NUMBER, in all three. Two of them store the
 *      LAST number used and one stores the next; that difference must not reach
 *      the operator, or the same intent needs two different values typed into
 *      two boxes.
 *
 *   3. A SERIES ONLY MOVES FORWARD. Every counter takes the higher of its stored
 *      floor and what has actually been issued, so a start below that would be
 *      silently ignored — the screen would say 400 while the app issued 351.
 *      Refusing, and naming the number to clear, is the whole point.
 *
 *   4. THE NEW START IS REAL. Setting one and then raising a document has to
 *      produce a document carrying that number, on all three paths.
 *
 * Run: npm run test:numbering
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/numbering-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb, getMeta } = require('../src/main/db/database')
const numbering = require('../src/main/db/numbering')
const poRepo = require('../src/main/db/purchaseOrders')
const invRepo = require('../src/main/db/invoices')
const tickets = require('../src/main/db/dealTickets')
const {
  formatSeriesNumber,
  seriesFloor,
  seriesLabel,
  validateSeriesStart
} = require('../src/shared/numbering')
const { DEAL_TICKET_FIRST } = require('../src/shared/dealTickets')
const { INVOICE_NUMBER_START } = require('../src/shared/invoices')

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

const ACTOR = 'emp_owner'
db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_n', 'SKU-N', 'Numbering Case', 'Baseball', 40,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

const state = (s: string): any => numbering.readNumbering().find((r: any) => r.series === s)

const makePo = (): any =>
  poRepo.createPurchaseOrder(
    {
      supplier: 'Numbering Supply',
      location: 'RM',
      lines: [{ productId: 'p_n', item: 'Numbering Case', quantity: 1, unitPrice: 10 }]
    },
    ACTOR
  )

const makeInvoice = (): any =>
  invRepo.saveInvoice(
    {
      invoiceNumber: invRepo.suggestInvoiceNumber(),
      customerName: 'Invented Buyer',
      invoiceDate: '2026-08-19',
      lines: [{ item: 'Numbering Case', productId: 'p_n', quantity: 1, rate: 50 }]
    },
    ACTOR
  )

// ---------------------------------------------------------------------------
console.log('\n=== 1. an untouched database reads its documented starts ===')
// ---------------------------------------------------------------------------

const all = numbering.readNumbering()
ok(all.length === 3, 'three series', String(all.length))
ok(
  all.map((r: any) => r.series).join(',') === 'deal_ticket,invoice,purchase_order',
  'in a stable order',
  all.map((r: any) => r.series).join(',')
)
ok(state('deal_ticket').next === DEAL_TICKET_FIRST, 'deal tickets start at 337', String(state('deal_ticket').next))
ok(state('purchase_order').next === 1, 'purchase orders start at 1', String(state('purchase_order').next))
ok(
  state('invoice').next === INVOICE_NUMBER_START,
  'invoices start where the shipped default says',
  String(state('invoice').next)
)
ok(
  all.every((r: any) => r.issued === 0),
  'and nothing has been issued yet'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. READING NEVER MINTS ===')
// ---------------------------------------------------------------------------
// The failure this catches: wiring the screen to nextPoNumber/nextDealTicketSeq,
// which advance their counter as they answer. Reading twenty times must leave
// the series exactly where it was.
const poBefore = getMeta(db, 'po_seq')
const dtBefore = getMeta(db, 'deal_ticket_seq')
for (let i = 0; i < 20; i++) numbering.readNumbering()
ok(getMeta(db, 'po_seq') === poBefore, 'twenty reads did not move the PO counter', String(getMeta(db, 'po_seq')))
ok(
  getMeta(db, 'deal_ticket_seq') === dtBefore,
  'nor the deal ticket counter',
  String(getMeta(db, 'deal_ticket_seq'))
)
ok(state('purchase_order').next === 1, 'and the next PO number is still 1', String(state('purchase_order').next))

// ---------------------------------------------------------------------------
console.log('\n=== 3. setting a start, and the document that follows it ===')
// ---------------------------------------------------------------------------

const setPo = numbering.setSeriesStart('purchase_order', 5000)
ok(setPo.ok === true, 'purchase orders can be moved to 5000', setPo.error ?? '')
ok(state('purchase_order').next === 5000, 'the next one reads 5000', String(state('purchase_order').next))
const po1 = makePo()
ok(po1.poNumber === 'PO-5000', 'AND THE ORDER RAISED NEXT IS PO-5000', po1.poNumber)
ok(state('purchase_order').next === 5001, 'then 5001 follows', String(state('purchase_order').next))
ok(state('purchase_order').issued === 5000, 'and 5000 reads as issued', String(state('purchase_order').issued))

// The deal ticket struck for that same purchase order proves the other series.
const t1 = tickets.readTicketFor(db, 'po', po1.id)
ok(t1?.number === 'DT-000337', 'its deal ticket is still the first one', String(t1?.number))

const setDt = numbering.setSeriesStart('deal_ticket', 900)
ok(setDt.ok === true, 'deal tickets can be moved to 900', setDt.error ?? '')
const po2 = makePo()
ok(
  tickets.readTicketFor(db, 'po', po2.id)?.number === 'DT-000900',
  'and the next ticket struck is DT-000900',
  String(tickets.readTicketFor(db, 'po', po2.id)?.number)
)

const setInv = numbering.setSeriesStart('invoice', 7000)
ok(setInv.ok === true, 'invoices can be moved to 7000', setInv.error ?? '')
ok(invRepo.suggestInvoiceNumber() === '7000', 'the suggestion is 7000', invRepo.suggestInvoiceNumber())
const inv1 = makeInvoice()
ok(inv1.invoiceNumber === '7000', 'AND THE ORDER RAISED NEXT IS 7000', String(inv1.invoiceNumber))
ok(state('invoice').next === 7001, 'then 7001 follows', String(state('invoice').next))

// ---------------------------------------------------------------------------
console.log('\n=== 4. A SERIES ONLY MOVES FORWARD ===')
// ---------------------------------------------------------------------------

const back = numbering.setSeriesStart('purchase_order', 100)
ok(back.ok === false, 'a start below what is issued is REFUSED')
// PO-5000 and PO-5001 have gone out by now — po1 and po2 above — so the series
// stands at 5002 and that is the number a refusal has to name.
ok(
  (back.error ?? '').includes('PO-5002'),
  'and the message names the number it has to clear',
  back.error ?? ''
)
ok(state('purchase_order').next === 5002, 'nothing moved', String(state('purchase_order').next))
const po3 = makePo()
ok(po3.poNumber === 'PO-5002', 'and the next order is unaffected', po3.poNumber)

// Exactly AT a number already issued is a re-issue, so it is refused too.
ok(
  numbering.setSeriesStart('purchase_order', 5002).ok === false,
  'the number already spoken for is refused as well'
)
ok(numbering.setSeriesStart('purchase_order', 5003).ok === true, 'the one after it is accepted')

// A deal ticket can never go below the business floor, even on an empty series.
ok(seriesFloor('deal_ticket') === DEAL_TICKET_FIRST, 'the deal ticket floor is 337')
ok(seriesFloor('invoice') === 1, 'the other two have no business floor')
ok(numbering.setSeriesStart('deal_ticket', 100).ok === false, 'and 100 is refused for tickets')

// ---------------------------------------------------------------------------
console.log('\n=== 5. what the field refuses before anything is sent ===')
// ---------------------------------------------------------------------------

const fresh = { series: 'purchase_order', next: 10, issued: 9, minimum: 10 }
ok(validateSeriesStart(fresh, 10) === null, 'the current next number is allowed')
ok(validateSeriesStart(fresh, 11) === null, 'and anything above it')
ok(validateSeriesStart(fresh, 9) !== null, 'but not one below the minimum')
ok(
  (validateSeriesStart(fresh, 9) ?? '').includes('PO-0009'),
  'which says what has already gone out',
  validateSeriesStart(fresh, 9) ?? ''
)
ok(validateSeriesStart(fresh, 10.5) !== null, 'a fraction is refused')
ok(validateSeriesStart(fresh, 0) !== null, 'so is zero')
ok(validateSeriesStart(fresh, -1) !== null, 'and a negative')
ok(validateSeriesStart(fresh, NaN) !== null, 'and something that is not a number')

// An untouched series says so differently — there is no "already issued" to name.
const empty = { series: 'deal_ticket', next: 337, issued: 0, minimum: 337 }
ok(
  !(validateSeriesStart(empty, 100) ?? '').includes('already been issued'),
  'a series with nothing issued does not claim something was',
  validateSeriesStart(empty, 100) ?? ''
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. formatting is the series own, not one shared shape ===')
// ---------------------------------------------------------------------------

ok(formatSeriesNumber('deal_ticket', 337) === 'DT-000337', 'tickets carry their prefix and six digits')
ok(formatSeriesNumber('purchase_order', 42) === 'PO-0042', 'purchase orders four digits')
ok(formatSeriesNumber('invoice', 2293) === '2293', 'AND AN INVOICE NUMBER IS BARE — it goes to QuickBooks as typed')
ok(seriesLabel('invoice') === 'Invoice numbers', 'each series has a label')

// ---------------------------------------------------------------------------
console.log('\n=== 7. an unknown series changes nothing ===')
// ---------------------------------------------------------------------------

const bogus = numbering.setSeriesStart('not_a_series' as any, 10)
ok(bogus.ok === false, 'an unknown series is refused')
ok(state('purchase_order').next === 5003, 'and nothing else moved', String(state('purchase_order').next))


// ---------------------------------------------------------------------------
console.log('\n=== 8. the invoice number is the one QuickBooks is SENT ===')
// ---------------------------------------------------------------------------
/**
 * The owner's question: does the number set here become the invoice number in
 * QuickBooks?
 *
 * It is what gets SENT — `toQboInvoice` puts it in `DocNumber` — and QuickBooks
 * silently replaces it unless the company has "Custom transaction numbers"
 * switched on. So the app cannot promise the buyer sees it, and this pins both
 * halves: the number does travel, and the divergence is counted so the screen
 * can say when it is not being honoured.
 */
const { toQboInvoice } = require('../src/shared/invoices')

const posted = invRepo.getInvoice(inv1.id)
// itemRefs is a Map keyed on the lower-cased item name — toQboInvoice throws by
// name on any line QuickBooks could not resolve, before a byte is posted, so the
// one line on this invoice has to be resolvable for the payload to be built.
const itemRefs = new Map<string, any>([['numbering case', { id: '99', name: 'Numbering Case' }]])
const payload = toQboInvoice(posted, { id: '1', name: 'Invented Buyer' }, itemRefs, {})
ok(payload.DocNumber === '7000', 'the number set here is sent as DocNumber', String(payload.DocNumber))

// No number, no DocNumber — rather than sending an empty one, which QuickBooks
// would treat as "assign your own" in a way that looks like ours was rejected.
const unnumbered = { ...posted, invoiceNumber: null }
ok(
  !('DocNumber' in toQboInvoice(unnumbered, { id: '1', name: 'B' }, itemRefs, {})),
  'an invoice with no number sends no DocNumber at all'
)

// The evidence the screen shows. Nothing has been posted in this test database,
// so the honest answer is zero rather than an assumption either way.
ok(state('invoice').renumbered === 0, 'nothing has come back renumbered here', String(state('invoice').renumbered))
ok(state('purchase_order').renumbered === undefined, 'and the count is invoice-only')

// Now prove the counter actually detects a divergence: a posted invoice whose
// returned DocNumber differs from what was sent is exactly the state that means
// QuickBooks is running its own series.
db.prepare(
  `UPDATE invoices SET qbo_id = 'qbo_1', qbo_doc_number = '1043' WHERE id = ?`
).run(inv1.id)
ok(
  state('invoice').renumbered === 1,
  'a returned number that differs from ours is counted',
  String(state('invoice').renumbered)
)
db.prepare(`UPDATE invoices SET qbo_doc_number = '7000' WHERE id = ?`).run(inv1.id)
ok(
  state('invoice').renumbered === 0,
  'and one that matches is not',
  String(state('invoice').renumbered)
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
