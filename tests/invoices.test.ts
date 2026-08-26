/**
 * Invoices — the sell side.
 *
 * Three things are pinned here, and they fail in three different ways:
 *
 *   1. THE CSV IS INTUIT'S, EXACTLY. Their importer decides where one invoice
 *      ends and the next begins by seeing the header columns filled in ONCE,
 *      on the first line only. Fill the customer in on every row and a
 *      three-line invoice imports as three invoices — silently, and against a
 *      real company's books. So the shape is asserted cell by cell against the
 *      sample file the owner supplied.
 *
 *   2. THE AGREED PRICE WINS. quantity × rate is a suggestion; the amount is
 *      what was agreed, and an invoice that recomputed over the top of it would
 *      quietly overcharge somebody who was talked down to a round number.
 *
 *   3. NOTHING IS SILENTLY EDITABLE ONCE IT HAS POSTED. An invoice in
 *      QuickBooks is not this app's to change, and a local edit would leave two
 *      systems disagreeing with nothing to say which is right.
 *
 * Run: npm run test:invoices
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/invoices-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const repo = require('../src/main/db/invoices')
const inv = require('../src/main/db/inventory')
const { assertStockLotsConsistent } = require('../src/main/db/lots')
const {
  INVOICE_CSV_HEADERS,
  DEFAULT_INVOICE_TERMS,
  INVOICE_TERMS,
  INVOICE_TERMS_OFFERED,
  TERM_DAYS,
  termsOptionsFor,
  dueDateFor,
  invoiceTotal,
  invoicesToCsv,
  lineAmount,
  money,
  nextInvoiceNumber,
  qboInvoiceUrl,
  toQboInvoice,
  toUsDate,
  validateCustomer,
  validateInvoice
} = require('../src/shared/invoices')
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
console.log('=== 1. money, and the agreed price ===')
// ---------------------------------------------------------------------------
// Binary floating point: 0.1 + 0.2 is 0.30000000000000004. An invoice total
// reading $170.00000000000003 is one somebody stops trusting even though it is
// only wrong by a rounding error nobody can see.
ok(money(0.1 + 0.2) === 0.3, 'a third of a dollar rounds to cents', String(money(0.1 + 0.2)))
ok(money(19.999) === 20, 'and up when it should')
ok(money(NaN) === 0, 'nonsense is zero, not NaN')
ok(lineAmount(2, 20) === 40, 'two at twenty is forty')
ok(lineAmount(0.5, 100) === 50, 'and half at a hundred is fifty')
ok(lineAmount(3, 19.99) === 59.97, 'three at 19.99 is 59.97', String(lineAmount(3, 19.99)))

// THE TOTAL IS THE SUM OF WHAT WAS AGREED, not of quantity × rate.
ok(
  invoiceTotal([{ amount: 40 }, { amount: 50 }]) === 90,
  'the total adds the agreed amounts'
)
ok(
  invoiceTotal([{ amount: 40 }, { amount: 35 }]) === 75,
  'including one talked down from 50',
  String(invoiceTotal([{ amount: 40 }, { amount: 35 }]))
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. dates and terms ===')
// ---------------------------------------------------------------------------
ok(dueDateFor('2022-11-21', 'Net 30') === '2022-12-21', 'Net 30 from 21 Nov is 21 Dec')
ok(dueDateFor('2022-11-22', 'Net 30') === '2022-12-22', 'and 22 Nov is 22 Dec')
ok(dueDateFor('2026-01-31', 'Net 30') === '2026-03-02', 'a month end rolls correctly')
ok(dueDateFor('2026-08-05', 'Due on receipt') === '2026-08-05', 'due on receipt is the same day')
ok(dueDateFor('2026-08-05', 'Net 15') === '2026-08-20', 'Net 15')
// THE DAYLIGHT-SAVING TRAP. US clocks go forward on 8 March 2026; a date-only
// string parsed as local midnight and shifted can land on 23:00 the day before
// and round down — a due date wrong by one, twice a year.
ok(dueDateFor('2026-03-07', 'Net 15') === '2026-03-22', 'across the spring forward')
ok(dueDateFor('2026-10-25', 'Net 15') === '2026-11-09', 'and the fall back')

// ---- Net 2, and the default ----------------------------------------------
// A buyer taking a case off the next stream gets the weekend, not a month. Two
// days is the shortest term that is not "now", which makes it the one most
// exposed to the trap above: a clock shift inside a 48-hour window is half of
// it, so an hour lost either way lands the due date on the wrong DAY.
ok(dueDateFor('2026-08-05', 'Net 2') === '2026-08-07', 'Net 2 is two days')
ok(dueDateFor('2026-03-07', 'Net 2') === '2026-03-09', 'Net 2 across the spring forward')
ok(dueDateFor('2026-10-31', 'Net 2') === '2026-11-02', 'Net 2 across the fall back AND a month end')
ok(dueDateFor('2026-12-30', 'Net 2') === '2027-01-01', 'and across a year end')

// The owner's instruction: a sale settles on receipt unless somebody says
// otherwise. Asserted as the CONSTANT rather than the string, because the whole
// point of DEFAULT_INVOICE_TERMS is that the invoice form, the new-customer form
// and the contact importer stop each writing their own answer.
ok(DEFAULT_INVOICE_TERMS === 'Due on receipt', 'due on receipt is the default')
ok(
  INVOICE_TERMS[0] === DEFAULT_INVOICE_TERMS,
  'and it leads the picker, so it is what nobody-changed-it means'
)
ok(TERM_DAYS[DEFAULT_INVOICE_TERMS] === 0, 'and it falls due the same day')

// Shortest first. A picker in an arbitrary order makes somebody read all five.
const days = INVOICE_TERMS.map((t: string) => TERM_DAYS[t])
ok(
  days.every((d: number, i: number) => i === 0 || d > days[i - 1]),
  'the terms are ordered shortest first',
  days.join(',')
)

// Every term can be dated. A term in the picker with no entry here would fall
// back to 0 via `?? 0` and quietly bill Net 60 as due immediately.
ok(
  INVOICE_TERMS.every((t: string) => typeof TERM_DAYS[t] === 'number'),
  'every term in the picker has a number of days'
)

// NOTHING IS EVER REMOVED. Terms are stored on invoices and customers as the
// words themselves, so dropping one orphans every record holding it — and a
// <select> renders a value it has no option for as BLANK, which reads as the
// terms having been wiped rather than as a menu having been tidied.
for (const historical of ['Due on receipt', 'Net 15', 'Net 30', 'Net 60']) {
  ok(
    INVOICE_TERMS.includes(historical),
    `“${historical}” still resolves, so invoices on it still show it`
  )
}

// ---- WHAT MAY BE CHOSEN, which is a shorter list ---------------------------
/**
 * The owner's words: "remove Net 30 as a payment option for all customers in
 * sales order and purchase orders."
 *
 * Two lists, on purpose. `INVOICE_TERMS` is everything that RESOLVES, so
 * `TERM_DAYS` can date a stored value and an old invoice still prints its terms.
 * `INVOICE_TERMS_OFFERED` is everything that may be CHOSEN. Collapsing them is
 * the mistake the block above exists to prevent.
 */
ok(
  !INVOICE_TERMS_OFFERED.includes('Net 30'),
  'NET 30 IS NOT ON OFFER — nor anything longer than Net 2',
  INVOICE_TERMS_OFFERED.join(', ')
)
ok(
  INVOICE_TERMS_OFFERED.every((t: string) => TERM_DAYS[t] <= 2),
  'and every term that IS on offer falls due within two days',
  INVOICE_TERMS_OFFERED.map((t: string) => `${t}=${TERM_DAYS[t]}`).join(', ')
)
ok(
  INVOICE_TERMS_OFFERED.every((t: string) => INVOICE_TERMS.includes(t)),
  'the offered list is a subset of the resolvable one, so nothing offered is undatable'
)

/**
 * A record ALREADY on a retired term is still shown it — but only that record,
 * and only while it holds it. Without this the select renders blank, which reads
 * as the terms having been wiped rather than as a policy having tightened.
 */
ok(
  termsOptionsFor('Net 30').includes('Net 30'),
  'AN INVOICE ALREADY ON NET 30 IS STILL OFFERED IT, so its own document is not silently rewritten'
)
ok(
  termsOptionsFor('Net 30').length === INVOICE_TERMS_OFFERED.length + 1,
  'and it is added to the short list rather than reopening the long one',
  termsOptionsFor('Net 30').join(', ')
)
ok(
  !termsOptionsFor('Due on receipt').includes('Net 30') &&
    !termsOptionsFor(null).includes('Net 30') &&
    !termsOptionsFor('').includes('Net 30'),
  'while everybody else — including a brand-new order — never sees it',
  termsOptionsFor(null).join(', ')
)

/**
 * The grandfathering is a narrow exception and has to STAY narrow: it fires only
 * when the held term is real AND retired. Widen it and the menu breaks in two
 * quiet ways — a record already on an offered term gets that term listed twice,
 * and a record holding nothing at all (every new order) gets an EMPTY option,
 * which is the blank entry the whole two-list arrangement exists to prevent.
 */
for (const held of [null, '', 'Due on receipt', 'Net 2', 'Net 30', 'Net 60', 'nonsense']) {
  const opts = termsOptionsFor(held)
  ok(
    opts.every((t: string) => !!t && INVOICE_TERMS.includes(t)),
    `no blank or unknown option is offered to a record on ${JSON.stringify(held)}`,
    JSON.stringify(opts)
  )
  ok(
    new Set(opts).size === opts.length,
    `and nothing is listed twice for a record on ${JSON.stringify(held)}`,
    JSON.stringify(opts)
  )
}

// Intuit's importer only accepts MM/DD/YYYY.
ok(toUsDate('2022-11-21') === '11/21/2022', 'dates export American')
ok(toUsDate('') === '', 'and a blank stays blank rather than becoming 1970')

// THE SERIES DID NOT START HERE. Invoices were raised in QuickBooks by hand
// first, so the app carries on from the owner's real next number rather than
// opening a second series that collides with it. max+1 off local rows alone
// would re-issue numbers a customer has already been billed under.
ok(nextInvoiceNumber([]) === '2293', 'the first invoice is the owner\u2019s real next number')
ok(nextInvoiceNumber(['1001', '1002']) === '2293', 'and history below the floor does not lower it')
ok(nextInvoiceNumber(['2293']) === '2294', 'once it is reached, it counts on')
ok(nextInvoiceNumber(['2400', '2293']) === '2401', 'from the highest, whatever order they arrive in')
ok(nextInvoiceNumber(['1002', '1001'], 1001) === '1003', 'an explicit floor still wins for a caller that sets one')
// A custom series is not guessed at: deciding which digits of "INV-0042" are
// the counter and getting it wrong on somebody's real numbering is worse than
// starting a series they can type over.
ok(nextInvoiceNumber(['INV-0042']) === '2293', 'a non-numeric series is not guessed at')

// ---------------------------------------------------------------------------
console.log('\n=== 3. what an invoice must have ===')
// ---------------------------------------------------------------------------
const goodLine = { item: 'Trimming', quantity: 2, rate: 20, amount: 40 }
const base = { customerName: 'Chris Smith', invoiceDate: '2022-11-21', lines: [goodLine] }
ok(validateInvoice(base) === null, 'a complete invoice passes')
ok(validateInvoice({ ...base, customerName: '  ' }) !== null, 'it needs a buyer')
ok(validateInvoice({ ...base, invoiceDate: 'soon' }) !== null, 'and a real date')
ok(validateInvoice({ ...base, lines: [] }) !== null, 'and at least one line')
ok(
  validateInvoice({ ...base, lines: [{ ...goodLine, item: '' }] }) !== null,
  'every line needs a product'
)
ok(
  validateInvoice({ ...base, lines: [{ ...goodLine, quantity: 0 }] }) !== null,
  'and a quantity above zero'
)
// A due date BEFORE the invoice date is the one combination that is certainly a
// mistake: QuickBooks accepts it and then reports the invoice overdue on the
// day it was written.
ok(
  validateInvoice({ ...base, dueDate: '2022-11-01' }) !== null,
  'a due date before the invoice date is refused'
)
ok(validateInvoice({ ...base, dueDate: '2022-11-21' }) === null, 'the same day is fine')

ok(validateCustomer({ name: '' }) !== null, 'a buyer needs a name')
ok(validateCustomer({ name: 'Chris Smith' }) === null, 'a name is enough')
ok(validateCustomer({ name: 'X', email: 'not-an-email' }) !== null, 'a bad email is caught')
ok(validateCustomer({ name: 'X', email: 'a@b.co' }) === null, 'a good one passes')

// ---------------------------------------------------------------------------
console.log('\n=== 4. buyers ===')
// ---------------------------------------------------------------------------
const chris = repo.saveCustomer({
  name: 'Chris Smith',
  email: 'email1@intuit.com',
  terms: 'Net 30',
  location: 'West',
  className: 'Class A:Subclass B',
  message: 'Thank you for your business!'
})
ok(chris.name === 'Chris Smith', 'a buyer is saved')
ok(chris.terms === 'Net 30', 'with their terms')
ok(chris.active === true, 'and active')

// SAVING THE SAME NAME AGAIN MERGES. Somebody adding "Chris Smith" from the
// invoice screen without checking the list first must not produce a second
// record that then diverges from the first.
const again = repo.saveCustomer({ name: 'chris smith', email: 'new@intuit.com' })
ok(again.id === chris.id, 'the same name merges rather than duplicating', again.id)
ok(again.email === 'new@intuit.com', 'taking the newer detail')
// But NOT the typed casing. Restyling a buyer's name as a side effect of
// writing an invoice would then appear on every future document.
ok(again.name === 'Chris Smith', 'while the matched record keeps its own name', again.name)
ok(repo.listCustomers().length === 1, 'still one buyer', String(repo.listCustomers().length))

const karuna = repo.saveCustomer({ name: 'Karuna Ramachandran', email: 'email2@intuit.com' })
ok(repo.listCustomers().length === 2, 'a different name is a different buyer')
ok(repo.listCustomers()[0].name === 'Chris Smith', 'listed alphabetically')

// ---------------------------------------------------------------------------
console.log('\n=== 5. saving an invoice ===')
// ---------------------------------------------------------------------------
const inv1 = repo.saveInvoice(
  {
    invoiceNumber: '1001',
    customerId: chris.id,
    customerName: 'Chris Smith',
    email: 'email1@intuit.com',
    terms: 'Net 30',
    invoiceDate: '2022-11-21',
    location: 'West',
    memo: 'First invoice of 3 month contract.',
    message: 'Thank you for your business!',
    sendLater: true,
    className: 'Class A:Subclass B',
    lines: [
      { item: 'Trimming', description: '2 hours of Trimming.', quantity: 2, rate: 20 },
      { item: 'Design', description: '0.5 hours of Design.', quantity: 0.5, rate: 100 }
    ]
  },
  'emp_owner'
)
ok(inv1.lines.length === 2, 'two lines saved', String(inv1.lines.length))
// The due date is DERIVED from the terms when nobody gave one.
ok(inv1.dueDate === '2022-12-21', 'the due date comes from the terms', inv1.dueDate)
ok(inv1.lines[0].amount === 40, 'the first line works out its own amount')
ok(inv1.lines[1].amount === 50, 'and so does the second')
ok(inv1.total === 90, 'the total is the sum', String(inv1.total))
ok(inv1.status === 'draft', 'a new invoice is a draft')
ok(inv1.lines[0].position === 0 && inv1.lines[1].position === 1, 'positions are 0 then 1')

// AN AGREED PRICE OVERRIDES THE ARITHMETIC.
const haggled = repo.saveInvoice(
  {
    ...inv1,
    id: inv1.id,
    lines: [
      { item: 'Trimming', quantity: 2, rate: 20, amount: 35 },
      { item: 'Design', quantity: 0.5, rate: 100, amount: 50 }
    ]
  },
  'emp_owner'
)
ok(haggled.lines[0].amount === 35, 'the agreed amount is kept, not recomputed')
ok(haggled.total === 85, 'and the total follows it', String(haggled.total))

// Lines are REPLACED, not merged: removing one leaves no orphan and no gap.
const trimmed = repo.saveInvoice(
  { ...inv1, id: inv1.id, lines: [{ item: 'Trimming', quantity: 1, rate: 20 }] },
  'emp_owner'
)
ok(trimmed.lines.length === 1, 'a removed line is gone', String(trimmed.lines.length))
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?`).get(inv1.id) as any)
    .n === 1,
  'and left no orphan row behind'
)

// The buyer's name is SNAPSHOTTED. Renaming them next year must not rewrite a
// document that has already been sent.
repo.saveCustomer({ id: chris.id, name: 'Christopher Smith' })
ok(
  repo.getInvoice(inv1.id).customerName === 'Chris Smith',
  'renaming the buyer does not rewrite the invoice',
  repo.getInvoice(inv1.id).customerName
)
ok(repo.getInvoice(inv1.id).customerId === chris.id, 'but they are still linked')
repo.saveCustomer({ id: chris.id, name: 'Chris Smith' })

// The invoices above were numbered by the test in the old series, which sits
// below the floor — so the floor is what comes back, and that IS the rule: the
// app must not hand out a number the business has already used.
ok(repo.suggestInvoiceNumber() === '2293', 'the next number never drops below the floor',
  repo.suggestInvoiceNumber())

// ---------------------------------------------------------------------------
console.log('\n=== 6. Intuit\'s import template, cell by cell ===')
// ---------------------------------------------------------------------------
// Rebuilt to match the owner's sample file exactly.
repo.saveInvoice(
  {
    id: inv1.id,
    invoiceNumber: '1001',
    customerId: chris.id,
    customerName: 'Chris Smith',
    email: 'email1@intuit.com',
    terms: 'Net 30',
    invoiceDate: '2022-11-21',
    dueDate: '2022-12-21',
    location: 'West',
    memo: 'First invoice of 3 month contract.',
    message: 'Thank you for your business!',
    sendLater: true,
    lines: [
      { item: 'Trimming', description: '2 hours of Trimming.', quantity: 2, rate: 20, className: 'Class A:Subclass B' },
      { item: 'Design', description: '0.5 hours of Design.', quantity: 0.5, rate: 100 }
    ]
  },
  'emp_owner'
)
const csv = invoicesToCsv([repo.getInvoice(inv1.id)])
const rows = csv.trim().split('\n')

ok(rows[0] === INVOICE_CSV_HEADERS.join(','), 'the header row is Intuit\'s', rows[0])
ok(rows.length === 3, 'a two-line invoice is three rows', String(rows.length))

const first = rows[1].split(',')
ok(first[0] === '1001', 'the number is on the first line')
ok(first[1] === 'Chris Smith', 'and the customer')
ok(first[3] === 'Net 30', 'and the terms')
ok(first[4] === '11/21/2022', 'the date is American', first[4])
ok(first[5] === '12/21/2022', 'and so is the due date')
ok(first[9] === 'TRUE', 'Send Later reads TRUE')
ok(first[10] === 'Trimming', 'the product is on the same row')
ok(first[14] === '40.00', 'the amount is to two places', first[14])

// THE RULE THE WHOLE FILE TURNS ON. Their importer groups rows by seeing the
// header columns ONCE. Filling the customer in on every line imports a
// three-line invoice as three invoices — silently, against real books.
const second = rows[2].split(',')
ok(second[0] === '1001', 'the second line repeats the number')
ok(second[1] === '', 'and leaves the customer BLANK')
ok(second[3] === '' && second[4] === '' && second[5] === '', 'and terms and both dates')
ok(second[9] === '', 'and Send Later')
ok(second[10] === 'Design', 'while carrying its own product')
ok(second[14] === '50.00', 'and its own amount')

// A cell containing a comma has to survive, or every column after it shifts.
repo.saveInvoice(
  {
    invoiceNumber: '1004',
    customerName: 'Ana Ruiz',
    invoiceDate: '2026-01-05',
    lines: [{ item: 'Design', description: 'Logo, cards, and signage', quantity: 1, rate: 100 }]
  },
  'emp_owner'
)
const commaCsv = invoicesToCsv(repo.getInvoices([repo.listInvoices().find((i: any) => i.invoiceNumber === '1004').id]))
ok(
  commaCsv.includes('"Logo, cards, and signage"'),
  'a comma in a description is quoted',
  commaCsv.split('\n')[1]
)
ok(commaCsv.trim().split('\n')[1].split('","').length === 1, 'and only that cell is quoted')

// ---------------------------------------------------------------------------
console.log('\n=== 7. the QuickBooks payload ===')
// ---------------------------------------------------------------------------
const detail = repo.getInvoice(inv1.id)
const itemRefs = new Map([
  ['trimming', { id: '5', name: 'Trimming' }],
  ['design', { id: '9', name: 'Design' }]
])
const payload = toQboInvoice(detail, { id: '17', name: 'Chris Smith' }, itemRefs)
ok(payload.CustomerRef.value === '17', 'the customer is a QuickBooks id, not a name')
ok(payload.TxnDate === '2022-11-21', 'the API takes ISO dates, unlike the CSV')
ok(payload.DueDate === '2022-12-21', 'both of them')
ok(payload.Line.length === 2, 'both lines travel')
ok(payload.Line[0].SalesItemLineDetail.ItemRef.value === '5', 'each line resolves its item')
ok(payload.Line[0].Amount === 40, 'carrying the agreed amount')
ok(payload.Line[0].SalesItemLineDetail.Qty === 2, 'and the quantity')
// Intuit's names are the wrong way round from how they read, and putting an
// internal memo in front of a customer is only noticed after it is sent.
ok(payload.CustomerMemo?.value === 'Thank you for your business!', 'CustomerMemo is what they SEE')
ok(payload.PrivateNote === 'First invoice of 3 month contract.', 'PrivateNote is internal')
ok(payload.BillEmail?.Address === 'email1@intuit.com', 'the email travels')
ok(payload.DocNumber === '1001', 'and our number is offered')

// AN ITEM QUICKBOOKS DOES NOT KNOW IS REFUSED BY NAME, before anything is sent.
// Half an invoice is not a useful thing to have created in somebody's books.
let refused = ''
try {
  toQboInvoice(detail, { id: '17' }, new Map([['trimming', { id: '5' }]]))
} catch (err) {
  refused = err instanceof Error ? err.message : String(err)
}
ok(refused !== '', 'a missing item is refused')
ok(/Design/.test(refused), 'and named in the message', refused)

ok(
  qboInvoiceUrl('production', '42') === 'https://qbo.intuit.com/app/invoice?txnId=42',
  'the production URL'
)
ok(
  qboInvoiceUrl('sandbox', '42') === 'https://sandbox.qbo.intuit.com/app/invoice?txnId=42',
  'and the sandbox one — a sandbox invoice does not exist in production'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. once it has posted, it is not ours ===')
// ---------------------------------------------------------------------------
repo.markPosted(inv1.id, { id: 'qbo-991', docNumber: '1055' })
const posted = repo.getInvoice(inv1.id)
ok(posted.status === 'created', 'posting moves it out of draft')
ok(posted.qboId === 'qbo-991', 'recording what QuickBooks called it')
// QuickBooks silently replaces DocNumber unless custom transaction numbers are
// on — Intuit's own template warns about it — so what came BACK is recorded.
ok(posted.qboDocNumber === '1055', 'including a number it renumbered', posted.qboDocNumber)
ok(posted.invoiceNumber === '1001', 'while ours is kept for the record')

let editRefused = ''
try {
  repo.saveInvoice({ ...posted, id: inv1.id, lines: [{ item: 'X', quantity: 1, rate: 1 }] }, 'e')
} catch (err) {
  editRefused = err instanceof Error ? err.message : String(err)
}
ok(editRefused !== '', 'editing a posted invoice is refused', editRefused)
ok(repo.getInvoice(inv1.id).lines.length === 2, 'and it is unchanged')

// DELETING IS NEVER REFUSED, whatever the QuickBooks state — unlike editing
// just above, which still is. It used to be refused too, and the button did
// nothing at all on real data: saving posts immediately so every invoice has a
// QuickBooks id within seconds, and Intuit will not delete an invoice that has
// a payment applied — it answers 401 Access Denied, which reads like a broken
// connection rather than a business rule. The remote delete is attempted by the
// caller and its refusal reported; it never blocks the local one.
//
// On a THROWAWAY invoice rather than inv1, which the assertions further down
// still need. A test that quietly destroys a fixture it shares fails somewhere
// else entirely, and the failure names the wrong thing.
const spare = repo.saveInvoice({
  customerId: chris.id,
  customerName: 'Chris Smith',
  invoiceNumber: '8999',
  terms: 'Due on receipt',
  invoiceDate: '2026-08-09',
  dueDate: '2026-08-09',
  lines: [{ item: 'Anything', quantity: 1, rate: 10, amount: 10 }]
})
repo.markPosted(spare.id, { id: '901', docNumber: '901' })
let deleteRefused = ''
try {
  repo.deleteInvoice(spare.id)
} catch (err) {
  deleteRefused = err instanceof Error ? err.message : String(err)
}
ok(deleteRefused === '', 'a posted invoice can still be deleted here', deleteRefused)
ok(repo.getInvoice(spare.id) === null, 'and it is actually gone')
ok(repo.getInvoice(inv1.id) !== null, 'without touching anything else')


// A DRAFT deletes cleanly, lines and all.
const scratch = repo.saveInvoice(
  { customerName: 'Ben Okafor', invoiceDate: '2026-02-01', lines: [{ item: 'Design', quantity: 1, rate: 10 }] },
  'emp_owner'
)
repo.deleteInvoice(scratch.id)
ok(repo.getInvoice(scratch.id) === null, 'a draft deletes')
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?`).get(scratch.id) as any)
    .n === 0,
  'and takes its lines with it'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. buyers with history are retired, not erased ===')
// ---------------------------------------------------------------------------
// An invoice keeps the name it was raised under, so deleting the record would
// not corrupt a document — but it would break "everything this buyer bought",
// which is the one question a customer list exists to answer.
const kept = repo.removeCustomer(chris.id)
ok(kept.deleted === false, 'a buyer with invoices is deactivated')
ok(repo.getCustomer(chris.id)?.active === false, 'and marked inactive')
ok(!repo.listCustomers().some((c: any) => c.id === chris.id), 'so they are off the picker')
ok(repo.getInvoice(inv1.id).customerName === 'Chris Smith', 'while their invoice still reads right')

const gone = repo.removeCustomer(karuna.id)
ok(gone.deleted === true, 'a buyer with no history is deleted outright')
ok(repo.getCustomer(karuna.id) === null, 'and is really gone')

// ---------------------------------------------------------------------------
console.log('\n=== 10. the headline numbers ===')
// ---------------------------------------------------------------------------
const stats = repo.invoiceStats()
ok(stats.created === 1, 'one invoice is in QuickBooks', String(stats.created))
ok(stats.draft >= 1, 'and at least one draft', String(stats.draft))
// Voided invoices are money nobody is waiting on.
const voided = repo.saveInvoice(
  { customerName: 'Ghost', invoiceDate: '2026-02-01', lines: [{ item: 'Design', quantity: 1, rate: 500 }] },
  'emp_owner'
)
const before = repo.invoiceStats().outstanding
repo.setInvoiceStatus(voided.id, 'void')
ok(
  repo.invoiceStats().outstanding === money(before - 500),
  'voiding takes it out of the outstanding total',
  `${before} → ${repo.invoiceStats().outstanding}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 11. paid is a tick, and the board moves forward ===')
// ---------------------------------------------------------------------------
const { INVOICE_STAGES, canMoveInvoice } = require('../src/shared/invoices')

ok(INVOICE_STAGES.length === 4, 'four columns', String(INVOICE_STAGES.length))
ok(
  INVOICE_STAGES.map((s: any) => s.id).join('>') === 'draft>created>sent>paid',
  'in pipeline order',
  INVOICE_STAGES.map((s: any) => s.id).join('>')
)

// FORWARD ONLY. An invoice posted to QuickBooks cannot be un-posted from here,
// and one marked paid in error is fixed there rather than by dragging a card.
ok(canMoveInvoice('draft', 'sent') === true, 'a draft can be sent')
ok(canMoveInvoice('sent', 'paid') === true, 'and a sent invoice can be paid')
ok(canMoveInvoice('paid', 'sent') === false, 'but paid does not go backwards')
ok(canMoveInvoice('created', 'draft') === false, 'nor does posted')
ok(canMoveInvoice('void', 'draft') === false, 'and void is terminal')
// THE CASE THAT MATTERS ON THIS FLOOR: plenty of invoices are settled in cash
// without ever going near QuickBooks, and a board that forced somebody to post
// one they had already been paid for would simply be lied to.
ok(canMoveInvoice('draft', 'paid') === true, 'a draft can go straight to paid — cash happens')

const cash = repo.saveInvoice(
  { customerName: 'Ana Ruiz', invoiceDate: '2026-03-01', lines: [{ item: 'Design', quantity: 1, rate: 250 }] },
  'emp_owner'
)
/**
 * THE STAGE AND THE MONEY CAME APART.
 *
 * This block used to assert that moving an order into what was then called Paid
 * stamped paid_at, and that moving it back wiped it — one gesture doing two
 * jobs. The owner asked for the last bucket to be PAYMENT, the settling-up step,
 * with paid-or-not marked inside it, so reaching it no longer claims the money
 * arrived and leaving it no longer erases a date somebody recorded.
 */
ok(cash.paidAt === null, 'a new invoice is not paid')
repo.setInvoiceStatus(cash.id, 'paid', 'emp_owner')
const atPayment = repo.getInvoice(cash.id)
ok(atPayment.status === 'paid', 'it reaches the Payment stage')
ok(
  atPayment.paidAt === null,
  'AND ARRIVING THERE DOES NOT CLAIM THE MONEY — the column is a step, not a receipt',
  String(atPayment.paidAt)
)

repo.setInvoicePaid(cash.id, true, 'emp_owner')
const paid = repo.getInvoice(cash.id)
ok(typeof paid.paidAt === 'string' && paid.paidAt.length > 0, 'marking it stamps when', String(paid.paidAt))
ok(paid.paidBy === 'emp_owner', 'and who')

// A DRAG MUST NOT ERASE A DATE SOMEBODY RECORDED. The old rule wiped paid_at on
// any move off that column, silently — including a correction that had nothing
// to do with the money.
repo.setInvoiceStatus(cash.id, 'sent', 'emp_owner')
const movedBack = repo.getInvoice(cash.id)
ok(movedBack.status === 'sent', 'moving it back works')
ok(movedBack.paidAt === paid.paidAt, 'AND THE PAYMENT SURVIVES THE MOVE', String(movedBack.paidAt))

// Withdrawing it is a decision, taken on purpose.
repo.setInvoicePaid(cash.id, false, 'emp_owner')
const unpaid = repo.getInvoice(cash.id)
ok(unpaid.paidAt === null, 'and it clears when somebody says so', String(unpaid.paidAt))
ok(unpaid.paidBy === null, 'along with who ticked it')

/**
 * THE MONEY TILES COUNT MONEY, NOT COLUMNS.
 *
 * This order is now sitting in the PAYMENT column with its payment explicitly
 * WITHDRAWN — which is the exact shape the old arithmetic got backwards. It
 * summed `status = 'paid'` into the Paid tile, so $250 nobody had sent read as
 * money received, and the same order was missing from Awaiting payment where it
 * belonged. Both figures wrong, in opposite directions, off one order.
 */
repo.setInvoiceStatus(cash.id, 'paid', 'emp_owner')
const inPaymentUnpaid = repo.getInvoice(cash.id)
ok(inPaymentUnpaid.status === 'paid', 'the card is in the Payment column')
ok(inPaymentUnpaid.paidAt === null, 'with nothing recorded against it', String(inPaymentUnpaid.paidAt))

const withdrawn = repo.invoiceStats()
const paidWithout = withdrawn.paidTotal
const owedWithout = withdrawn.outstanding

/**
 * Now the money actually arrives. The same order, in the same column, with
 * nothing else on the board touched — so the two figures below can only have
 * moved because of this payment, and they must move by its total EXACTLY.
 *
 * A delta of 250 in each direction is what proves the old rule is gone: under
 * it this order was ALREADY in the paid total before the tick, so recording the
 * payment would have moved nothing at all.
 */
repo.setInvoicePaid(cash.id, true, 'emp_owner')
const settled = repo.invoiceStats()
ok(
  Math.abs(settled.paidTotal - (paidWithout + 250)) < 0.005,
  'recording the payment moves exactly $250 into the paid total',
  `${paidWithout} -> ${settled.paidTotal}`
)
ok(
  Math.abs(settled.outstanding - (owedWithout - 250)) < 0.005,
  'and takes exactly $250 out of what is owed',
  `${owedWithout} -> ${settled.outstanding}`
)
ok(settled.paid >= 1, 'the Payment column still counts its cards', String(settled.paid))

// THE OTHER DIRECTION: paid, and NOT in the Payment column. An order QuickBooks
// has settled while the boxes are still on the bench used to be reported as
// money owed — a figure the owner reads as "chase these people".
repo.setInvoiceStatus(cash.id, 'sent', 'emp_owner')
const onTheBench = repo.invoiceStats()
ok(
  Math.abs(onTheBench.paidTotal - settled.paidTotal) < 0.005,
  'MOVING A PAID ORDER OFF THE PAYMENT COLUMN DOES NOT UN-PAY IT',
  `${settled.paidTotal} -> ${onTheBench.paidTotal}`
)
ok(
  Math.abs(onTheBench.outstanding - settled.outstanding) < 0.005,
  'and it is still not owed',
  `${settled.outstanding} -> ${onTheBench.outstanding}`
)

// ---------------------------------------------------------------------------
console.log('\n=== 12. the document a buyer reads ===')
// ---------------------------------------------------------------------------
const { buildInvoiceHtml } = require('../src/main/invoicePdf')
const pdfInvoice = repo.getInvoice(inv1.id)
const html = buildInvoiceHtml(pdfInvoice)

ok(html.includes('Chris Smith'), 'the buyer is on it')
ok(html.includes('email1@intuit.com'), 'with their email')
ok(html.includes('Trimming') && html.includes('Design'), 'every line is on it')
ok(html.includes('Net 30'), 'and the terms')
ok(html.includes('$90.00'), 'and the total in money', /\$[\d.,]+/.exec(html)?.[0] ?? '')
// The MESSAGE is for the buyer; the MEMO is internal and must never appear on
// a document that gets sent to them.
ok(html.includes('Thank you for your business!'), 'the message they should see is there')
ok(
  !html.includes('First invoice of 3 month contract.'),
  'and the internal memo is NOT'
)

// A DRAFT is stamped. An unfinished invoice that looks exactly like a real one
// is the single most damaging thing this file could produce — somebody pays it.
const draftDoc = repo.saveInvoice(
  { customerName: 'Ben Okafor', invoiceDate: '2026-03-02', lines: [{ item: 'Design', quantity: 1, rate: 10 }] },
  'emp_owner'
)
ok(
  buildInvoiceHtml(repo.getInvoice(draftDoc.id)).includes('class="mark"'),
  'a draft is watermarked'
)
ok(
  !buildInvoiceHtml(pdfInvoice).includes('class="mark"'),
  'and a real invoice is not'
)

// Anything operator-typed is escaped — an invoice is a document that gets sent,
// and a buyer name with a bracket in it must not become markup.
const nasty = repo.saveInvoice(
  {
    customerName: 'Ruiz <script>alert(1)</script>',
    invoiceDate: '2026-03-03',
    lines: [{ item: 'Design', quantity: 1, rate: 10 }]
  },
  'emp_owner'
)
const nastyHtml = buildInvoiceHtml(repo.getInvoice(nasty.id))
ok(!nastyHtml.includes('<script>'), 'a script tag in a name is escaped')
ok(nastyHtml.includes('&lt;script&gt;'), 'and rendered as text', 'escaped')

// ---------------------------------------------------------------------------
console.log('\n=== 13. field parity with the QuickBooks invoice form ===')
// ---------------------------------------------------------------------------
// The owner's QBO invoice screen shows a customer, their email, a bill-to
// address, an invoice number, terms, both dates, and lines with a product, a
// SKU, a description, qty, rate, amount and a class. Everything on that list
// that has a home on Intuit's Invoice entity has to be IN THE PAYLOAD — a field
// this app quietly never sent looks identical, on our side, to one it did.
const {
  EMPTY_ADDRESS,
  hasAddress,
  looksVoidedInQbo,
  nextStageFromQbo,
  observedInvoiceStage,
  observedPaid,
  observedPartiallyPaid,
  observedSent,
  resolveLineItemRef
} = require('../src/shared/invoices')

ok(hasAddress(null) === false, 'no address is no address')
ok(hasAddress(EMPTY_ADDRESS) === false, 'and neither is one with every field blank')
ok(hasAddress({ ...EMPTY_ADDRESS, city: 'Marlow' }) === true, 'a city alone counts')
// Whitespace is not an address. If it counted, the posting code would decide it
// HAS one and send QuickBooks a blank BillAddr, erasing the address they hold.
ok(hasAddress({ ...EMPTY_ADDRESS, city: '   ' }) === false, 'and spaces do not')

const kestrelAddr = {
  line1: '18 Kestrel Row',
  line2: null,
  city: 'Marlow',
  region: 'CA',
  postalCode: '43000',
  country: null
}
const iris = repo.saveCustomer({
  name: 'Iris Vandermeer (Kestrel Sportscards)',
  email: 'iris@kestrelcards.example',
  terms: 'Due on receipt',
  billAddr: kestrelAddr
})
ok(iris.billAddr?.city === 'Marlow', 'a buyer keeps their bill-to', String(iris.billAddr?.city))
ok(iris.billAddr?.region === 'CA', 'including the state')

// AN EDIT THAT CARRIES NO ADDRESS LEAVES THE STORED ONE ALONE. Saving a
// customer from the invoice screen passes a name and an email and nothing else,
// and that must not wipe an address somebody typed on the buyer form.
const irisAgain = repo.saveCustomer({ id: iris.id, name: iris.name, email: 'iris@kestrelcards.example' })
ok(irisAgain.billAddr?.line1 === '18 Kestrel Row', 'an address survives an unrelated edit')

// A catalog product, so a line can be picked rather than typed.
const stamp13 = new Date().toISOString()
db.prepare(
  `INSERT INTO inventory_products (id, sku, upc, name, category, brand, set_name, year,
                                   unit_type, unit_cost, reorder_point, created_at, updated_at)
   VALUES ('prod_topps', 'TOPPS-2024-HOB', '000000000001', '2024 Topps Series 1 Hobby Box',
           'Baseball', 'Topps', 'Series 1', '2024', 'box', 80, 0, ?, ?)`
).run(stamp13, stamp13)

const parity = repo.saveInvoice(
  {
    invoiceNumber: '2258',
    customerId: iris.id,
    customerName: 'Iris Vandermeer (Kestrel Sportscards)',
    email: 'iris@kestrelcards.example',
    terms: 'Due on receipt',
    invoiceDate: '2026-08-09',
    lines: [
      {
        item: '2024 Topps Series 1 Hobby Box',
        productId: 'prod_topps',
        description: 'Sealed hobby box',
        quantity: 4,
        rate: 125
      }
    ]
  },
  'emp_owner'
)

// THE SKU AUTO-POPULATES FROM THE CHOSEN PRODUCT. Nothing typed it — the line
// carried a product id and the SKU came off the catalog at save time.
ok(parity.lines[0].sku === 'TOPPS-2024-HOB', 'the SKU fills itself in', String(parity.lines[0].sku))
ok(parity.lines[0].productId === 'prod_topps', 'and the product stays linked')
// The bill-to is SNAPSHOTTED off the buyer, not joined. Otherwise a buyer who
// moves next year silently rewrites where last year's document says it went.
ok(parity.billAddr?.line1 === '18 Kestrel Row', 'the invoice snapshots the bill-to')
repo.saveCustomer({ id: iris.id, name: iris.name, billAddr: { ...kestrelAddr, city: 'Glendale' } })
ok(
  repo.getInvoice(parity.id).billAddr?.city === 'Marlow',
  'and moving the buyer does not rewrite it',
  String(repo.getInvoice(parity.id).billAddr?.city)
)

// A line typed freehand still works, and carries no product and no SKU.
const freehand = repo.saveInvoice(
  {
    customerName: 'Ana Ruiz',
    invoiceDate: '2026-08-09',
    lines: [{ item: 'Grading submission fee', quantity: 1, rate: 45 }]
  },
  'emp_owner'
)
ok(freehand.lines[0].productId === null, 'a typed line has no product')
ok(freehand.lines[0].sku === null, 'and no SKU')

// A SKU somebody typed is KEPT — a one-off is allowed to carry a code that is
// not in this catalog, and overwriting it from the product would lose it.
const typedSku = repo.saveInvoice(
  {
    customerName: 'Ana Ruiz',
    invoiceDate: '2026-08-09',
    lines: [
      { item: '2024 Topps Series 1 Hobby Box', productId: 'prod_topps', sku: 'CUSTOM-9', quantity: 1, rate: 10 }
    ]
  },
  'emp_owner'
)
ok(typedSku.lines[0].sku === 'CUSTOM-9', 'a typed SKU beats the catalog one', String(typedSku.lines[0].sku))

const parityDetail = repo.getInvoice(parity.id)
const parityItems = new Map([
  ['2024 topps series 1 hobby box', { id: '42', name: '2024 Topps Series 1 Hobby Box', sku: 'TOPPS-2024-HOB' }]
])
const full = toQboInvoice(
  parityDetail,
  { id: '77', name: 'Iris Vandermeer (Kestrel Sportscards)' },
  parityItems,
  {
    termRef: { value: '3', name: 'Due on receipt' },
    classRef: { value: '5000000000000123456', name: 'United States' },
    classOn: 'line',
    itemsBySku: new Map([['topps-2024-hob', { id: '42', name: '2024 Topps Series 1 Hobby Box', sku: 'TOPPS-2024-HOB' }]])
  }
)

ok(full.DocNumber === '2258', 'the invoice number travels', String(full.DocNumber))
ok(full.CustomerRef.value === '77', 'the customer is an id')
ok(full.CustomerRef.name === 'Iris Vandermeer (Kestrel Sportscards)', 'with the display name beside it')
ok(full.BillEmail?.Address === 'iris@kestrelcards.example', 'the email is on the invoice')
ok(full.TxnDate === '2026-08-09', 'the invoice date')
ok(full.DueDate === '2026-08-09', 'and due on receipt means the same day', String(full.DueDate))
// TERMS ARE A REFERENCE, NEVER THE WORDS. Sending "Due on receipt" as a string
// does nothing at all: QuickBooks takes the customer's default terms instead and
// computes a due date from those, so the two systems disagree about when the
// money is owed with nothing on either screen saying so.
ok(full.SalesTermRef?.value === '3', 'the terms are a SalesTermRef', JSON.stringify(full.SalesTermRef))
// BILL-TO, field by field. CountrySubDivisionCode is Intuit's name for the
// state; putting the zip in it is the kind of mistake that posts happily.
ok(full.BillAddr?.Line1 === '18 Kestrel Row', 'the street', String(full.BillAddr?.Line1))
ok(full.BillAddr?.City === 'Marlow', 'the city')
ok(full.BillAddr?.CountrySubDivisionCode === 'CA', 'the STATE goes in CountrySubDivisionCode')
ok(full.BillAddr?.PostalCode === '43000', 'and the zip in PostalCode')
ok(full.BillAddr?.Line2 === undefined, 'a blank line is omitted, not sent empty')
ok(full.Line[0].SalesItemLineDetail.ItemRef.value === '42', 'the product resolves to an id')
ok(full.Line[0].Description === 'Sealed hobby box', 'the description travels')
ok(full.Line[0].SalesItemLineDetail.Qty === 4, 'the quantity')
ok(full.Line[0].SalesItemLineDetail.UnitPrice === 125, 'the rate')
ok(full.Line[0].Amount === 500, 'and the amount', String(full.Line[0].Amount))
ok(
  full.Line[0].SalesItemLineDetail.ClassRef?.value === '5000000000000123456',
  'the class is on the line',
  JSON.stringify(full.Line[0].SalesItemLineDetail.ClassRef)
)

// THE ADDRESS FALLS BACK TO THE ONE QUICKBOOKS HOLDS. An invoice with none of
// its own must still go up addressed — which is exactly what their form does
// when you pick a customer — rather than posting a document with no bill-to.
const noAddr = repo.getInvoice(freehand.id)
const fellBack = toQboInvoice(noAddr, { id: '77' }, new Map([['grading submission fee', { id: '9' }]]), {
  billAddr: { ...EMPTY_ADDRESS, line1: '9 QuickBooks Way', city: 'Los Angeles', region: 'CA' },
  billEmail: 'fallback@example.com'
})
ok(fellBack.BillAddr?.Line1 === '9 QuickBooks Way', 'a missing address falls back to QuickBooks')
ok(fellBack.BillEmail?.Address === 'fallback@example.com', 'and so does a missing email')
// But the invoice's OWN address wins when it has one — a correction typed here
// is the newer fact.
const ownWins = toQboInvoice(parityDetail, { id: '77' }, parityItems, {
  billAddr: { ...EMPTY_ADDRESS, line1: '9 QuickBooks Way' }
})
ok(ownWins.BillAddr?.Line1 === '18 Kestrel Row', "the invoice's own address wins")

// ---------------------------------------------------------------------------
console.log('\n=== 14. the SKU decides which item a line points at ===')
// ---------------------------------------------------------------------------
// There is NO SKU field on a QuickBooks invoice line. The SKU printed on the
// document is read off the ITEM, so the only way to get it right is to point the
// line at the right item — which means matching on the SKU first, because an
// item renamed in QuickBooks still carries the same one.
const byName = new Map([['old name', { id: '1', name: 'Old Name', sku: 'SKU-A' }]])
const bySku = new Map([['sku-a', { id: '7', name: 'Renamed In QuickBooks', sku: 'SKU-A' }]])

ok(
  resolveLineItemRef({ item: 'Old Name', sku: 'SKU-A' }, byName, bySku).id === '7',
  'the SKU wins over the name',
  resolveLineItemRef({ item: 'Old Name', sku: 'SKU-A' }, byName, bySku).id
)
ok(
  resolveLineItemRef({ item: 'Old Name', sku: 'sku-a' }, byName, bySku).id === '7',
  'and the match is case-insensitive'
)
// A line with no SKU still resolves by name, exactly as it always did — plenty
// of what gets billed here is a service that was never stock.
ok(
  resolveLineItemRef({ item: 'Old Name', sku: null }, byName, bySku).id === '1',
  'no SKU falls back to the name'
)
// A SKU QuickBooks does not know falls back too, rather than failing: the name
// is still a real match, and refusing would block an invoice over a code.
ok(
  resolveLineItemRef({ item: 'Old Name', sku: 'SKU-NOPE' }, byName, bySku).id === '1',
  'an unknown SKU falls back to the name'
)
ok(resolveLineItemRef({ item: 'Nothing', sku: null }, byName, bySku) === null, 'and nothing is null')

// A line that resolves to nothing is still refused BY NAME before anything is
// posted. Half an invoice is not a useful thing to have created.
let skuRefused = ''
try {
  toQboInvoice(parityDetail, { id: '1' }, new Map(), { itemsBySku: new Map() })
} catch (err) {
  skuRefused = err instanceof Error ? err.message : String(err)
}
ok(/Topps/.test(skuRefused), 'an unresolvable line is refused by name', skuRefused)

// ---------------------------------------------------------------------------
console.log('\n=== 15. the class, and never guessing one ===')
// ---------------------------------------------------------------------------
// Putting a ClassRef in the slot a company does not use is NOT an error:
// QuickBooks accepts the invoice and drops the reference silently. So where it
// goes is read from their preferences, and 'both' is what an unreadable
// preference falls back to — the ignored one is discarded without complaint.
const klass = { value: '900', name: 'United States' }
const onTxn = toQboInvoice(parityDetail, { id: '1' }, parityItems, { classRef: klass, classOn: 'transaction' })
ok(onTxn.ClassRef?.value === '900', 'per-transaction puts it on the header')
ok(onTxn.Line[0].SalesItemLineDetail.ClassRef === undefined, 'and not on the line')

const onLine = toQboInvoice(parityDetail, { id: '1' }, parityItems, { classRef: klass, classOn: 'line' })
ok(onLine.ClassRef === undefined, 'per-line leaves the header alone')
ok(onLine.Line[0].SalesItemLineDetail.ClassRef?.value === '900', 'and puts it on the line')

const onBoth = toQboInvoice(parityDetail, { id: '1' }, parityItems, { classRef: klass, classOn: 'both' })
ok(
  onBoth.ClassRef?.value === '900' && onBoth.Line[0].SalesItemLineDetail.ClassRef?.value === '900',
  'both sends it twice, so whichever slot is live gets it'
)

// THE RULE THAT MATTERS MOST IN THIS FILE. A class that could not be resolved is
// OMITTED, never invented. An id we made up either bounces with an error naming
// nothing, or lands on a different record that happens to hold it — and posts
// real revenue against the wrong class, which nobody finds until year end.
const noClass = toQboInvoice(parityDetail, { id: '1' }, parityItems, { classRef: null, classOn: 'line' })
ok(noClass.ClassRef === undefined, 'an unresolved class puts nothing on the header')
ok(
  noClass.Line[0].SalesItemLineDetail.ClassRef === undefined,
  'and nothing on the line — omitted, not guessed'
)
const classOff = toQboInvoice(parityDetail, { id: '1' }, parityItems, { classRef: klass, classOn: 'none' })
ok(
  classOff.ClassRef === undefined && classOff.Line[0].SalesItemLineDetail.ClassRef === undefined,
  'and class tracking switched off sends none of it'
)
// Same rule for terms: no match means QuickBooks' own default, not a made-up id.
const noTerm = toQboInvoice(parityDetail, { id: '1' }, parityItems, { termRef: null })
ok(noTerm.SalesTermRef === undefined, 'an unresolved term is omitted too')

// ---------------------------------------------------------------------------
console.log('\n=== 16. a QuickBooks failure must not lose the invoice ===')
// ---------------------------------------------------------------------------
// The local write is committed BEFORE the network call, so the worst a refused
// push can cost is the push. These three columns are what turn that into a
// retry rather than a re-type.
const pushMe = repo.saveInvoice(
  {
    customerName: 'Ana Ruiz',
    invoiceDate: '2026-08-09',
    lines: [{ item: 'Design', quantity: 1, rate: 60 }]
  },
  'emp_owner'
)
ok(pushMe.qboPushState === 'none', 'a fresh invoice has never been pushed', pushMe.qboPushState)
ok(pushMe.qboPushAttempts === 0, 'and has no attempts')

ok(repo.claimPushSlot(pushMe.id) === true, 'the push slot is there to be claimed')
const pending = repo.getInvoice(pushMe.id)
// PENDING IS STAMPED BEFORE THE CALL, on purpose. A process killed mid-flight
// leaves a row saying "this may be in QuickBooks", which is what makes somebody
// look before pushing again. Written afterwards it would read "never tried",
// and that claim leads straight to the same invoice existing twice.
ok(pending.qboPushState === 'pending', 'the attempt is recorded before the call', pending.qboPushState)
ok(pending.qboPushAttempts === 1, 'and counted', String(pending.qboPushAttempts))
ok(typeof pending.qboPushAttemptedAt === 'string', 'and stamped')

repo.markPushFailed(pushMe.id, 'QuickBooks: Invalid Reference Id — no such item.')
const failed = repo.getInvoice(pushMe.id)
ok(failed.qboPushState === 'failed', 'a refusal is recorded')
ok(/Invalid Reference Id/.test(failed.qboPushError), 'with what Intuit said', failed.qboPushError)
// THE DOCUMENT IS UNTOUCHED. This is the whole point of the ordering.
ok(failed.status === 'draft', 'and the invoice is still a draft somebody can retry')
ok(failed.lines.length === 1, 'with its lines intact')
ok(failed.total === 60, 'and its total')
ok(repo.listInvoicesNeedingPush().some((i: any) => i.id === pushMe.id), 'and it is on the retry list')

// A successful push clears the failure, or it would sit on the retry list for
// ever and get posted a second time.
repo.markPosted(pushMe.id, { id: 'qbo-4242', docNumber: '2259' })
const pushed = repo.getInvoice(pushMe.id)
ok(pushed.qboPushState === 'ok', 'a success records ok', pushed.qboPushState)
ok(pushed.qboPushError === null, 'and clears the error')
ok(pushed.status === 'created', 'and moves it out of draft')
ok(
  !repo.listInvoicesNeedingPush().some((i: any) => i.id === pushMe.id),
  'and takes it off the retry list'
)
// Nothing already in QuickBooks may appear on that list, whatever its push
// state says — a retry would create the invoice twice.
db.prepare(`UPDATE invoices SET qbo_push_state = 'failed' WHERE id = ?`).run(pushMe.id)
ok(
  !repo.listInvoicesNeedingPush().some((i: any) => i.id === pushMe.id),
  'an invoice with a QuickBooks id is never offered for retry'
)
db.prepare(`UPDATE invoices SET qbo_push_state = 'ok' WHERE id = ?`).run(pushMe.id)

// ---------------------------------------------------------------------------
console.log('\n=== 17. reading a status back out of QuickBooks ===')
// ---------------------------------------------------------------------------
// THREE OF THE OWNER'S FIVE STATES ARE REAL. Open, sent and paid come off the
// Invoice entity. Viewed-by-payer and payout-sent are NOT exposed by the
// Accounting API at all, so nothing here invents them.
const seen = (over: any = {}): any => ({
  qboId: '9',
  docNumber: '2258',
  emailStatus: null,
  deliveredAt: null,
  balance: null,
  totalAmt: null,
  linkedPayments: 0,
  // Empty is AMBIGUOUS on purpose — "there are none" and "we did not follow the
  // links" look the same, and linkedPayments beside it is what separates them.
  // See tests/qboPaid.test.ts, which is where that pair is exercised properly.
  payments: [],
  voided: false,
  ...over
})

// OPEN — derived from Balance against TotalAmt. There is no status string to
// read instead; "Open" on their screen is exactly these two numbers.
ok(observedInvoiceStage(seen({ balance: 500, totalAmt: 500 })) === 'created', 'an open invoice reads created')
// SENT — EmailStatus, or a DeliveryInfo time. Both are real fields.
ok(observedSent(seen({ emailStatus: 'EmailSent' })) === true, 'EmailSent means sent')
ok(observedSent(seen({ emailStatus: 'NeedToSend' })) === false, 'NeedToSend does not')
ok(observedSent(seen({ emailStatus: 'NotSet' })) === false, 'and NotSet does not')
ok(observedSent(seen({ deliveredAt: '2026-08-09T10:35:20-07:00' })) === true, 'a delivery time does')
ok(
  observedInvoiceStage(seen({ balance: 500, totalAmt: 500, emailStatus: 'EmailSent' })) === 'sent',
  'so an emailed open invoice reads sent'
)
// PAID — a zero balance against a NON-ZERO total.
ok(observedPaid(seen({ balance: 0, totalAmt: 500 })) === true, 'a cleared balance is paid')
ok(observedPaid(seen({ balance: 250, totalAmt: 500 })) === false, 'half of it is not')
ok(observedPartiallyPaid(seen({ balance: 250, totalAmt: 500 })) === true, 'it is partially paid')
ok(observedPartiallyPaid(seen({ balance: 0, totalAmt: 500 })) === false, 'and fully paid is not partial')
// ZERO OVER ZERO IS NOT PAID. That is what a voided or empty invoice looks
// like, and calling it paid would put money in the paid total nobody ever sent.
ok(observedPaid(seen({ balance: 0, totalAmt: 0 })) === false, 'zero of zero is not paid')
// A reading we could not get is not a reading. Null must never be coerced to 0.
ok(observedPaid(seen({ balance: null, totalAmt: null })) === false, 'and no answer is not paid')
ok(observedInvoiceStage(seen()) === null, 'an empty observation implies nothing at all')
// VOIDED HAS NO FIELD. v3 gives no status for it, so the signature is a zeroed
// invoice whose private note starts with the word — and BOTH halves are
// required, or ordinary notes start voiding invoices.
ok(
  looksVoidedInQbo({ totalAmt: 0, balance: 0, privateNote: 'Voided - RC 93' }) === true,
  "QuickBooks' own voided note is recognised"
)
ok(looksVoidedInQbo({ totalAmt: 0, balance: 0, privateNote: 'Voided' }) === true, 'bare and annotated alike')
// A note that MENTIONS voiding is not a void. "do not void this one" contains
// the word and means the opposite, which is why the test is on the start.
ok(
  looksVoidedInQbo({ totalAmt: 0, balance: 0, privateNote: 'Do not void this one' }) === false,
  'a note that merely mentions voiding is not a void'
)
// And a zeroed invoice with an ordinary note is just a zeroed invoice.
ok(
  looksVoidedInQbo({ totalAmt: 0, balance: 0, privateNote: 'Comped for the show' }) === false,
  'a zero-value invoice with an ordinary note is not voided'
)
// A live invoice does not become void because somebody wrote the word on it.
ok(
  looksVoidedInQbo({ totalAmt: 500, balance: 500, privateNote: 'Voided the last one' }) === false,
  'and an invoice with a balance is never voided by its note'
)
ok(looksVoidedInQbo({}) === false, 'an absent invoice is not a voided one')

// VOID beats everything, including a zero balance that would otherwise look paid.
ok(observedInvoiceStage(seen({ voided: true, balance: 0, totalAmt: 0 })) === 'void', 'voided reads void')
ok(observedPaid(seen({ voided: true, balance: 0, totalAmt: 500 })) === false, 'and voided is never paid')
// Highest-water-mark order: a paid invoice was also emailed, and reporting it as
// merely sent would walk the board backwards on every refresh.
ok(
  observedInvoiceStage(seen({ balance: 0, totalAmt: 500, emailStatus: 'EmailSent' })) === 'paid',
  'paid outranks sent'
)

// Only ever FORWARD, and only along a legal transition.
ok(nextStageFromQbo('created', seen({ balance: 0, totalAmt: 500 })) === 'paid', 'created can go to paid')
ok(nextStageFromQbo('created', seen({ balance: 500, totalAmt: 500 })) === null, 'and stays put otherwise')
// A LOCALLY PAID INVOICE IS NEVER DRAGGED BACK. Paid is operator-recorded here —
// cash and Zelle settle plenty of these without QuickBooks ever seeing the money
// — so an outstanding balance over there is not evidence it did not arrive.
ok(
  nextStageFromQbo('paid', seen({ balance: 500, totalAmt: 500, emailStatus: 'EmailSent' })) === null,
  'and a paid invoice is never walked backwards'
)
ok(nextStageFromQbo('sent', seen({ balance: 500, totalAmt: 500 })) === null, 'nor is a sent one')
ok(nextStageFromQbo('void', seen({ balance: 0, totalAmt: 500 })) === null, 'and void is terminal')
// An observation that implies nothing changes nothing.
ok(nextStageFromQbo('created', seen()) === null, 'an unreadable answer moves no card')

// The observation is written down, with provenance.
const watched = repo.saveInvoice(
  { customerName: 'Ana Ruiz', invoiceDate: '2026-08-09', lines: [{ item: 'Design', quantity: 1, rate: 500 }] },
  'emp_owner'
)
repo.markPosted(watched.id, { id: '9', docNumber: '2260' })
repo.recordQboObservation(watched.id, seen({ balance: 500, totalAmt: 500, emailStatus: 'EmailSent', deliveredAt: '2026-08-09T17:35:20Z' }))
const observed = repo.getInvoice(watched.id)
ok(observed.qboEmailStatus === 'EmailSent', 'the email status is kept verbatim', String(observed.qboEmailStatus))
ok(observed.qboDeliveredAt === '2026-08-09T17:35:20Z', 'and when QuickBooks sent it')
ok(observed.qboBalance === 500 && observed.qboTotalAmt === 500, 'and both numbers')
ok(typeof observed.qboStatusCheckedAt === 'string', 'and when we got an answer')
ok(observed.qboStatusError === null, 'with no error hanging over from before')

// A FAILED READ MUST NOT OVERWRITE ONE THAT WORKED. Stale-but-true beats
// fresh-and-wrong: an invoice QuickBooks said was paid last week is still paid
// during an outage, and blanking it because the network was down would take a
// true answer off the screen and put nothing in its place.
// Both writes stamp ISO milliseconds, and a test fast enough to land them in the
// same millisecond cannot tell "attempted-at moved" from "attempted-at was never
// touched" — the exact thing being asserted. So the clock is given room.
const spinUntil = Date.now() + 3
while (Date.now() < spinUntil) {
  /* deliberately busy: sleeping would need this whole file to be async */
}
repo.recordQboStatusFailure(watched.id, 'QuickBooks is rate limiting requests.')
const afterFailure = repo.getInvoice(watched.id)
ok(afterFailure.qboBalance === 500, 'a failed read leaves the last good balance alone')
ok(afterFailure.qboEmailStatus === 'EmailSent', 'and the last good email status')
ok(afterFailure.qboStatusCheckedAt === observed.qboStatusCheckedAt, 'and does not move checked-at')
ok(/rate limiting/.test(afterFailure.qboStatusError), 'while saying what went wrong')
ok(
  afterFailure.qboStatusAttemptedAt > afterFailure.qboStatusCheckedAt,
  'and recording that we asked, more recently than we last got an answer',
  `${afterFailure.qboStatusCheckedAt} → ${afterFailure.qboStatusAttemptedAt}`
)

// TICKING IT PAID HERE DOES NOT TAKE IT OFF THE SWEEP. This asserted the
// opposite for a while and that WAS the bug: `watched` has a balance of 500
// sitting in QuickBooks, so it is precisely the invoice worth asking about
// again, and dropping it froze its payment rail at the pre-payment figure for
// good. What ends the question is QuickBooks' own answer — see qboPaid section 6.
repo.setInvoiceStatus(watched.id, 'paid', 'emp_owner')
ok(
  repo.listPostedInvoices().some((i: any) => i.id === watched.id),
  'an invoice ticked paid here is STILL re-checked while QuickBooks shows a balance',
  String(repo.getInvoice(watched.id).qboBalance)
)

// ---------------------------------------------------------------------------
console.log('\n=== deleting an invoice that reached QuickBooks ===')
// ---------------------------------------------------------------------------
// LAST, because it destroys its fixture.
//
// The remote copy is the caller's problem, not this function's. deleteInvoice
// used to refuse anything with a qbo_id and later demanded the caller prove the
// remote copy was gone; both amounted to "you may never delete an invoice",
// because saving posts immediately and Intuit refuses to delete an invoice with
// a payment applied. The IPC layer attempts QuickBooks and REPORTS what
// happened; this stays a plain local delete so the button always works.
const doomed = repo.saveInvoice({
  customerId: chris.id,
  customerName: 'Chris Smith',
  invoiceNumber: '9001',
  terms: 'Due on receipt',
  invoiceDate: '2026-08-09',
  dueDate: '2026-08-09',
  lines: [{ item: 'Anything', quantity: 1, rate: 10, amount: 10 }]
})
repo.markPosted(doomed.id, { id: '77', docNumber: '77' })
ok(repo.getInvoice(doomed.id)?.qboId === '77', 'a posted invoice knows its QuickBooks id')
repo.deleteInvoice(doomed.id)
ok(repo.getInvoice(doomed.id) === null, 'and being posted does not stop it going')

// ---- editing a draft must not forget what has already SHIPPED -------------
// The bug this pins lost real stock. saveInvoice replaces every line rather than
// diffing them, and the INSERT did not name `qty_fulfilled` — whose schema
// default is 0 — so any edit to a draft, even a memo, reset the picking to
// nothing. The scan queue then offered the whole order again and a second
// scan-out took the units off the shelf a second time: sixteen boxes gone
// against a ten-box sale, with no error anywhere.
{
  const buyer = repo.saveCustomer({ id: null, name: 'Fulfilment Buyer', terms: 'Net 30' })
  const inv = repo.saveInvoice(
    {
      id: null,
      customerId: buyer.id,
      customerName: 'Fulfilment Buyer',
      invoiceDate: '2026-08-12',
      dueDate: '2026-09-11',
      terms: 'Net 30',
      lines: [
        { item: 'Mega Case', productId: null, sku: 'MEGA-1', quantity: 10, rate: 100, amount: 1000 },
        { item: 'Grading fee', productId: null, sku: null, quantity: 2, rate: 25, amount: 50 }
      ]
    },
    null
  )

  // Six of the ten are picked and physically leave the building.
  const line = inv.lines.find((l: { item: string }) => l.item === 'Mega Case')
  db.prepare(`UPDATE invoice_lines SET qty_fulfilled = 6, fulfilled_at = ? WHERE id = ?`)
    .run('2026-08-12T18:00:00.000Z', line.id)

  // Somebody edits the memo. Nothing else about the order changes.
  const after = repo.saveInvoice(
    {
      id: inv.id,
      customerId: buyer.id,
      customerName: 'Fulfilment Buyer',
      invoiceDate: '2026-08-12',
      dueDate: '2026-09-11',
      terms: 'Net 30',
      memo: 'called about the address',
      lines: [
        { item: 'Mega Case', productId: null, sku: 'MEGA-1', quantity: 10, rate: 100, amount: 1000 },
        { item: 'Grading fee', productId: null, sku: null, quantity: 2, rate: 25, amount: 50 }
      ]
    },
    null
  )
  const mega = after.lines.find((l: { item: string }) => l.item === 'Mega Case')
  const fee = after.lines.find((l: { item: string }) => l.item === 'Grading fee')
  ok(mega.qtyFulfilled === 6, 'a memo edit does not forget the six boxes already picked', String(mega.qtyFulfilled))
  ok(mega.qtyOutstanding === 4, 'so only the remaining four are still owed', String(mega.qtyOutstanding))
  ok(fee.qtyFulfilled === 0, 'and a line that never shipped still reads zero', String(fee.qtyFulfilled))

  // Editing the order DOWN below what already went out. The honest record is
  // that the line is fully fulfilled, not that six of four left.
  const shrunk = repo.saveInvoice(
    {
      id: inv.id,
      customerId: buyer.id,
      customerName: 'Fulfilment Buyer',
      invoiceDate: '2026-08-12',
      dueDate: '2026-09-11',
      terms: 'Net 30',
      lines: [
        { item: 'Mega Case', productId: null, sku: 'MEGA-1', quantity: 4, rate: 100, amount: 400 }
      ]
    },
    null
  )
  const small = shrunk.lines[0]
  ok(small.qtyFulfilled === 4, 'shrinking the order below what shipped clamps rather than over-claiming', String(small.qtyFulfilled))
  ok(small.qtyOutstanding === 0, 'and nothing is left outstanding', String(small.qtyOutstanding))
}

// ---- TWO LINES OF THE SAME PRODUCT, and the carry-forward that split them --
// The carry-forward is keyed on the PRODUCT, because the rewrite mints new line
// ids and nothing else survives it. That makes it a POOL, and the first version
// handed the whole pool to the first matching line and then dropped the key —
// so an order listing the same box twice, three at one price and three at
// another, came back from a memo edit as 3 fulfilled and 3 outstanding after all
// six had shipped.
//
// That is not a display problem. `outstandingSalesLinesForProduct` reads exactly
// this column, so the scan queue offered three units that were already in a box
// on a van, and the picker taking them off the shelf again is the same
// stock-emptying failure the carry-forward was written to stop.
{
  const buyer = repo.saveCustomer({ id: null, name: 'Split Line Buyer', terms: 'Net 30' })
  const twoLines = [
    { item: 'Split Case', productId: 'prod-split', sku: 'SPLIT-1', quantity: 3, rate: 100, amount: 300 },
    { item: 'Split Case', productId: 'prod-split', sku: 'SPLIT-1', quantity: 3, rate: 80, amount: 240 }
  ]
  const order = repo.saveInvoice(
    {
      id: null,
      customerId: buyer.id,
      customerName: 'Split Line Buyer',
      invoiceDate: '2026-08-13',
      terms: 'Net 30',
      lines: twoLines
    },
    null
  )
  ok(order.lines.length === 2, 'an order may list the same product twice at two prices')

  // All six ship.
  for (const l of order.lines) {
    db.prepare(`UPDATE invoice_lines SET qty_fulfilled = 3, fulfilled_at = ? WHERE id = ?`)
      .run('2026-08-13T18:00:00.000Z', l.id)
  }

  const edited = repo.saveInvoice(
    {
      id: order.id,
      customerId: buyer.id,
      customerName: 'Split Line Buyer',
      invoiceDate: '2026-08-13',
      terms: 'Net 30',
      memo: 'customer asked for a copy',
      lines: twoLines
    },
    null
  )
  const shipped = edited.lines.reduce((n: number, l: any) => n + l.qtyFulfilled, 0)
  const owed = edited.lines.reduce((n: number, l: any) => n + l.qtyOutstanding, 0)
  ok(shipped === 6, 'ALL SIX ARE STILL RECORDED AS PICKED after the edit', String(shipped))
  ok(owed === 0, 'and the scan queue is offered nothing to pick again', String(owed))
  ok(
    edited.lines.every((l: any) => l.qtyFulfilled === 3),
    'the pool is drawn down line by line rather than spent on the first',
    JSON.stringify(edited.lines.map((l: any) => l.qtyFulfilled))
  )

  // A pool bigger than the lines can absorb still clamps rather than overflows.
  const shrunk2 = repo.saveInvoice(
    {
      id: order.id,
      customerId: buyer.id,
      customerName: 'Split Line Buyer',
      invoiceDate: '2026-08-13',
      terms: 'Net 30',
      lines: [{ item: 'Split Case', productId: 'prod-split', sku: 'SPLIT-1', quantity: 2, rate: 100, amount: 200 }]
    },
    null
  )
  ok(shrunk2.lines[0].qtyFulfilled === 2, 'a single shorter line clamps to what it now sells', String(shrunk2.lines[0].qtyFulfilled))
  ok(shrunk2.lines[0].qtyOutstanding === 0, 'with nothing left owed')
}

// ---- terms survive a round trip through the DATABASE ----------------------
// The suite used to test dueDateFor('...', 'Net 2') as a pure function and stop
// there. It passed while `asTerms` in main/db/invoices.ts — a second, hand-typed
// copy of the terms list — silently mapped Net 2 to Net 30 on write AND on read,
// so the value could never be stored and a buyer given two days got thirty.
// A pure-function test over a value the database refuses to keep is a green
// suite over a broken feature.
for (const term of INVOICE_TERMS) {
  const c = repo.saveCustomer({ id: null, name: `Terms ${term}`, terms: term })
  const readBack = repo.listCustomers().find((x: { id: string }) => x.id === c.id)
  ok(readBack?.terms === term, `a customer on ${term} is stored and read back as ${term}`, String(readBack?.terms))
}


// ---------------------------------------------------------------------------
console.log('\n=== 20. a sales order IS a sale: the shelf moves when it is saved ===')
// ---------------------------------------------------------------------------
// A sales order used to be paperwork — it named products and quantities and the
// shelf did not move until a picker scanned the boxes out against it. It is a
// sale now: saving one consumes FIFO layers the same way a counter sale does,
// because the owner writes the order because the boxes are going.
//
// The reconcile is RELEASE-THEN-APPLY on every save rather than a per-line
// delta, and that choice is what the section below is really testing: a delta is
// where an off-by-one becomes a box that does not exist. Every assertion is an
// ABSOLUTE shelf count, because a delta assertion would pass against code that
// double-counted a create and double-released an edit.
{
  const shelf = (id: string): number => inv.stockQty(id, 'RM')
  const product = inv.createProduct(
    {
      sku: 'SO-STOCK-1',
      upc: null,
      name: 'Order Stock Hobby Box',
      category: 'Baseball',
      brand: 'Invented',
      setName: '',
      year: '2026',
      unitType: 'box',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 0,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null
    },
    null
  )
  // Two layers at two prices, so FIFO has something to be right about.
  inv.addStock(product.id, 'RM', 4, 100, 'first buy', null, null)
  inv.addStock(product.id, 'RM', 2, 250, 'second buy', null, null)
  ok(shelf(product.id) === 6, 'six on the shelf to start', String(shelf(product.id)))

  const buyer = repo.saveCustomer({ id: null, name: 'Wholesale Buyer', terms: 'Net 30' })
  const order = (id: string | null, quantity: number, rate = 200): any =>
    repo.saveInvoice(
      {
        id,
        customerId: buyer.id,
        customerName: 'Wholesale Buyer',
        invoiceDate: '2026-08-14',
        terms: 'Net 30',
        location: 'RM',
        lines: quantity > 0
          ? [{ item: 'Order Stock Hobby Box', productId: product.id, quantity, rate, amount: quantity * rate }]
          : [{ item: 'Handling', productId: null, quantity: 1, rate: 10, amount: 10 }]
      },
      'emp_owner'
    )

  // --- Sell four of six ---------------------------------------------------
  const sold = order(null, 4)
  ok(shelf(product.id) === 2, 'SELLING FOUR OF SIX LEAVES TWO', String(shelf(product.id)))
  ok(sold.lines[0].qtyFulfilled === 4, 'the line records four gone', String(sold.lines[0].qtyFulfilled))
  ok(sold.lines[0].qtyOutstanding === 0, 'and nothing outstanding')
  assertStockLotsConsistent(db)

  // FIFO, and the cost is the OLDEST layers — four at $100, not a blend and not
  // the dear layer. This is the number the Wholesale margin is computed from.
  const move = db
    .prepare(`SELECT quantity, cost_total FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(sold.id) as { quantity: number; cost_total: number }
  ok(move?.quantity === 4, 'the receipt says four left', String(move?.quantity))
  ok(move?.cost_total === 400, 'AT $400 — the four oldest boxes, FIFO', String(move?.cost_total))

  // --- Edit UP: 4 → 5 -----------------------------------------------------
  // The release has to run first or this would see an empty-ish shelf and take
  // only what was left rather than the five it now sells.
  const up = order(sold.id, 5)
  ok(shelf(product.id) === 1, 'editing up to five leaves one', String(shelf(product.id)))
  ok(up.lines[0].qtyFulfilled === 5, 'and the line says five', String(up.lines[0].qtyFulfilled))
  const upMove = db
    .prepare(`SELECT cost_total FROM invoice_stock_moves WHERE invoice_id = ?`)
    .get(sold.id) as { cost_total: number }
  ok(upMove?.cost_total === 650, 'costing $650 — four at $100 and one at $250', String(upMove?.cost_total))
  assertStockLotsConsistent(db)

  // --- Edit DOWN: 5 → 1 ---------------------------------------------------
  const down = order(sold.id, 1)
  ok(shelf(product.id) === 5, 'editing down to one puts four back', String(shelf(product.id)))
  ok(down.lines[0].qtyFulfilled === 1, 'and the line says one', String(down.lines[0].qtyFulfilled))
  // The units went back into the layers they came from, so the dear layer is
  // whole again and the next sale is priced FIFO from the top.
  ok(
    (db.prepare(`SELECT cost_total AS c FROM invoice_stock_moves WHERE invoice_id = ?`).get(sold.id) as any).c === 100,
    'at $100, off the cheap layer'
  )
  assertStockLotsConsistent(db)

  // --- Saving the SAME order again changes nothing ------------------------
  // The one property that makes release-then-apply safe. A save that is not
  // idempotent turns every reopened-and-closed order into a missing box.
  order(sold.id, 1)
  order(sold.id, 1)
  ok(shelf(product.id) === 5, 'THREE SAVES OF THE SAME ORDER STILL LEAVE FIVE', String(shelf(product.id)))
  assertStockLotsConsistent(db)

  // --- The product line is removed entirely -------------------------------
  order(sold.id, 0)
  ok(shelf(product.id) === 6, 'dropping the line hands the last box back', String(shelf(product.id)))
  ok(
    (db.prepare(`SELECT COUNT(*) AS n FROM invoice_stock_moves WHERE invoice_id = ?`).get(sold.id) as any).n === 0,
    'and the receipt is gone with it'
  )
  assertStockLotsConsistent(db)

  // --- Deleting an order hands everything back ----------------------------
  const doomed = order(null, 3)
  ok(shelf(product.id) === 3, 'a second order takes three', String(shelf(product.id)))
  repo.deleteInvoice(doomed.id)
  ok(shelf(product.id) === 6, 'DELETING IT PUTS ALL THREE BACK', String(shelf(product.id)))
  assertStockLotsConsistent(db)

  // --- More than the shelf holds: clamp, never refuse and never go negative -
  // An order written the day before the pallet lands is a real thing somebody
  // does. Refusing the save would push the work into a notebook.
  const ahead = order(null, 10)
  ok(shelf(product.id) === 0, 'an order for ten takes the six that exist', String(shelf(product.id)))
  ok(ahead.lines[0].qtyFulfilled === 6, 'recording six as gone', String(ahead.lines[0].qtyFulfilled))
  ok(ahead.lines[0].qtyOutstanding === 4, 'and four still owed', String(ahead.lines[0].qtyOutstanding))
  assertStockLotsConsistent(db)

  // The pallet lands and the order is saved again: it takes what it is still
  // owed, and no more.
  inv.addStock(product.id, 'RM', 10, 120, 'the pallet', null, null)
  const filled = order(ahead.id, 10)
  ok(shelf(product.id) === 6, 'the next save takes the four it was owed', String(shelf(product.id)))
  ok(filled.lines[0].qtyOutstanding === 0, 'and the order is complete')
  assertStockLotsConsistent(db)

  // --- Two lines of the same product split one shelf ----------------------
  repo.deleteInvoice(filled.id)
  ok(shelf(product.id) === 16, 'the shelf is back to sixteen', String(shelf(product.id)))
  const split = repo.saveInvoice(
    {
      id: null,
      customerId: buyer.id,
      customerName: 'Wholesale Buyer',
      invoiceDate: '2026-08-14',
      terms: 'Net 30',
      location: 'RM',
      lines: [
        { item: 'Order Stock Hobby Box', productId: product.id, quantity: 3, rate: 200, amount: 600 },
        { item: 'Order Stock Hobby Box', productId: product.id, quantity: 2, rate: 150, amount: 300 }
      ]
    },
    'emp_owner'
  )
  ok(shelf(product.id) === 11, 'two lines of one product take five between them', String(shelf(product.id)))
  const moves = db
    .prepare(`SELECT line_position, quantity FROM invoice_stock_moves WHERE invoice_id = ? ORDER BY line_position`)
    .all(split.id) as Array<{ line_position: number; quantity: number }>
  ok(moves.length === 2, 'with a receipt per LINE, not per product', String(moves.length))
  ok(moves[0]?.quantity === 3 && moves[1]?.quantity === 2, 'each carrying its own line', JSON.stringify(moves))
  ok(split.lines.every((l: any) => l.qtyOutstanding === 0), 'and both lines fully taken')
  assertStockLotsConsistent(db)

  // --- Voiding hands them back --------------------------------------------
  repo.setInvoiceStatus(split.id, 'void', 'emp_owner')
  ok(shelf(product.id) === 16, 'VOIDING PUTS THE FIVE BACK', String(shelf(product.id)))
  assertStockLotsConsistent(db)
}

// ---------------------------------------------------------------------------
console.log('\n=== 21. the Wholesale ledger: sold for, minus what it cost ===')
// ---------------------------------------------------------------------------
// The tab said "not built yet" for five releases, and the reason was honest: a
// sales order moved no stock, so nothing sold off-stream had a cost attached and
// any margin would have been invented. Now that an order takes its own FIFO
// layers, every row is a subtraction between two numbers the app holds.
//
// The three things that would each silently misstate a month:
//
//   1. THE QUANTITY IS WHAT LEFT, not what was ordered. An order for ten
//      against a shelf of six reports six units of revenue against six units of
//      cost. Reporting the ordered quantity would show a margin nobody earned.
//   2. ONE ROW PER LINE. The same box on two lines at two prices is two
//      margins, and rolling them together reports one that is neither.
//   3. A COST THAT CANNOT BE RECOVERED IS NOT ZERO. A line shipped under the old
//      fulfilment model has no record of its layers; counting it at zero cost
//      would overstate profit by its entire revenue.
{
  const { listWholesaleSales } = require('../src/main/db/invoiceStock')
  const shelf = (id: string): number => inv.stockQty(id, 'RM')
  const p = inv.createProduct(
    {
      sku: 'WS-1',
      upc: null,
      name: 'Wholesale Case',
      category: 'Baseball',
      brand: 'Invented',
      setName: '',
      year: '2026',
      unitType: 'case',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 0,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null
    },
    null
  )
  inv.addStock(p.id, 'RM', 5, 1000, 'cheap layer', null, null)
  inv.addStock(p.id, 'RM', 5, 1400, 'dear layer', null, null)
  const buyer = repo.saveCustomer({ id: null, name: 'Bulk Buyer', terms: 'Net 30' })

  const ws = repo.saveInvoice(
    {
      id: null,
      customerId: buyer.id,
      customerName: 'Bulk Buyer',
      invoiceNumber: 'WS-1001',
      invoiceDate: '2026-08-14',
      terms: 'Net 30',
      location: 'RM',
      lines: [
        { item: 'Wholesale Case', productId: p.id, quantity: 3, rate: 1600, amount: 4800 },
        { item: 'Wholesale Case', productId: p.id, quantity: 2, rate: 1500, amount: 3000 }
      ]
    },
    'emp_owner'
  )
  ok(shelf(p.id) === 5, 'five cases went out', String(shelf(p.id)))

  const mine = listWholesaleSales(db).filter((r: any) => r.invoiceNumber === 'WS-1001')
  ok(mine.length === 2, 'ONE ROW PER LINE', String(mine.length))
  ok(mine[0].quantity === 3 && mine[1].quantity === 2, 'each with its own quantity', JSON.stringify(mine.map((r: any) => r.quantity)))
  ok(mine[0].revenue === 4800, 'the first line sold for $4,800', String(mine[0].revenue))
  // FIFO: the first line takes three of the cheap layer, the second takes the
  // last cheap case and one dear one.
  ok(mine[0].cost === 3000, 'costing $3,000 — three at $1,000, oldest first', String(mine[0].cost))
  ok(mine[0].margin === 1800, 'for a margin of $1,800', String(mine[0].margin))
  ok(mine[1].revenue === 3000, 'the second line sold for $3,000', String(mine[1].revenue))
  // Still inside the cheap layer: line one took three of the five, so line two's
  // two cases are the last two at $1,000. The dear layer is untouched until the
  // next order.
  ok(mine[1].cost === 2000, 'costing $2,000 — the last two at $1,000', String(mine[1].cost))
  ok(mine[1].margin === 1000, 'for a margin of $1,000', String(mine[1].margin))
  ok(mine.every((r: any) => r.costKnown === true), 'and both costs are real, not assumed')
  ok(mine[0].productName === 'Wholesale Case' && mine[0].sku === 'WS-1', 'named and SKU-ed for the report')

  // --- What was ORDERED is not what is reported ---------------------------
  const over = repo.saveInvoice(
    {
      id: null,
      customerId: buyer.id,
      customerName: 'Bulk Buyer',
      invoiceNumber: 'WS-1002',
      invoiceDate: '2026-08-15',
      terms: 'Net 30',
      location: 'RM',
      lines: [{ item: 'Wholesale Case', productId: p.id, quantity: 9, rate: 1600, amount: 14400 }]
    },
    'emp_owner'
  )
  ok(shelf(p.id) === 0, 'it takes the five that were left', String(shelf(p.id)))
  const overRow = listWholesaleSales(db).find((r: any) => r.invoiceNumber === 'WS-1002')
  ok(overRow?.quantity === 5, 'THE ROW REPORTS THE FIVE THAT LEFT, not the nine ordered', String(overRow?.quantity))
  ok(overRow?.revenue === 8000, 'so revenue is five units of it', String(overRow?.revenue))
  // And NOW the dear layer: the cheap five are gone, so these five are $1,400
  // each — which is exactly the point of pricing a sale against its own layers
  // rather than against an average.
  ok(overRow?.cost === 7000, 'against the cost of those five, all at $1,400', String(overRow?.cost))
  ok(over.lines[0].qtyOutstanding === 4, 'and four are still owed on the order', String(over.lines[0].qtyOutstanding))

  // --- A void order leaves the report entirely ----------------------------
  repo.setInvoiceStatus(over.id, 'void', 'emp_owner')
  ok(
    !listWholesaleSales(db).some((r: any) => r.invoiceNumber === 'WS-1002'),
    'VOIDING TAKES THE SALE OFF THE REPORT — its stock went back'
  )
  ok(shelf(p.id) === 5, 'and the five cases are on the shelf again', String(shelf(p.id)))

  // --- A cost that cannot be recovered is flagged, never zero -------------
  // What a pre-v68 line looks like: a receipt with no ledger row behind it.
  db.prepare(
    `INSERT INTO invoice_stock_moves
       (id, invoice_id, line_position, product_id, location, quantity, cost_total, txn_id, created_at)
     VALUES ('legacy-move-1', ?, 0, ?, 'RM', 2, 0, NULL, '2026-01-01T00:00:00.000Z')`
  ).run(ws.id, p.id)
  const legacy = listWholesaleSales(db).find((r: any) => r.costKnown === false)
  ok(!!legacy, 'a line with no recoverable cost still appears')
  ok(legacy.cost === 0, 'carrying no cost figure', String(legacy?.cost))
  ok(legacy.costKnown === false, 'AND FLAGGED AS UNKNOWN, so the screen can leave it out of the totals')
  db.prepare(`DELETE FROM invoice_stock_moves WHERE id = 'legacy-move-1'`).run()
}

// ---------------------------------------------------------------------------
console.log('\n=== NOBODY IS LEFT SITTING ON NET 30 ===')
// ---------------------------------------------------------------------------
/**
 * The v88 migration, as a named function so it can be tested rather than only
 * run once at startup inside a five-thousand-line schema file.
 *
 * Retiring Net 30 from the picker changed almost nothing on its own, because
 * `termsOptionsFor` hands a retired term back on any record already holding one
 * — and almost every record did. The vendor import wrote `'Net 30'` as a SQL
 * literal on every supplier it created, and both `terms` columns were declared
 * `DEFAULT 'Net 30'`. So the menu tightened and the owner went on seeing Net 30
 * on customer after customer.
 */
{
  const stamp = '2026-01-02T03:04:05.000Z'
  const seed = (name: string, terms: string): string => {
    const id = `term-fix-${name.replace(/\W+/g, '-')}`
    db.prepare(
      `INSERT INTO invoice_customers (id, name, terms, active, is_customer, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, ?, ?)`
    ).run(id, name, terms, stamp, stamp)
    return id
  }
  const termsOf = (id: string): string =>
    (db.prepare(`SELECT terms FROM invoice_customers WHERE id = ?`).get(id) as any).terms
  const touchedAt = (id: string): string =>
    (db.prepare(`SELECT updated_at FROM invoice_customers WHERE id = ?`).get(id) as any).updated_at

  const onNet30 = seed('Longwood Wax Co', 'Net 30')
  const onNet60 = seed('Sixty Day Cards', 'Net 60')
  const onNet15 = seed('Fifteen Day Cards', 'Net 15')
  const onNet2 = seed('Weekend Buyer', 'Net 2')
  const onReceipt = seed('Cash Buyer', 'Due on receipt')

  // An invoice ALREADY written on Net 30, with the due date it was sent under.
  const oldSale = repo.saveInvoice(
    {
      invoiceNumber: '2101',
      customerName: 'Longwood Wax Co',
      customerId: onNet30,
      invoiceDate: '2026-01-05',
      terms: 'Net 30',
      lines: [{ item: 'Case break', quantity: 1, rate: 400 }]
    },
    'emp_owner'
  )
  ok(oldSale.terms === 'Net 30', 'an invoice can still be written on Net 30 by an old record')
  ok(oldSale.dueDate === '2026-02-04', 'thirty days out', oldSale.dueDate)

  const stranded = (): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM invoice_customers
            WHERE terms NOT IN (${INVOICE_TERMS_OFFERED.map(() => '?').join(', ')})`
        )
        .get(...INVOICE_TERMS_OFFERED) as any
    ).n

  ok(stranded() >= 3, 'before: several contacts sit on a term nobody may choose', String(stranded()))
  const moved = repo.retireUnofferedCustomerTerms(db)
  ok(moved >= 3, 'the run reports how many it moved', String(moved))
  ok(
    stranded() === 0,
    'AND NOBODY ANYWHERE IS LEFT ON A TERM THE PICKER DOES NOT OFFER — Net 60 and Net 15 sit behind the same door as Net 30',
    String(stranded())
  )
  ok(termsOf(onNet30) === 'Due on receipt', 'the Net 30 customer is on the default now', termsOf(onNet30))
  ok(termsOf(onNet60) === 'Due on receipt', 'and so is the Net 60 one')
  ok(termsOf(onNet15) === 'Due on receipt', 'and the Net 15 one')
  ok(termsOf(onNet2) === 'Net 2', 'while Net 2 — which IS on offer — is left exactly alone', termsOf(onNet2))
  ok(termsOf(onReceipt) === 'Due on receipt', 'as is Due on receipt')

  /**
   * THE INVOICE IS NOT REWRITTEN. Its due date was computed from those terms and
   * sent to a buyer; changing the words would either contradict the date beside
   * them or move a date somebody has already been told.
   */
  const after = repo.getInvoice(oldSale.id)
  ok(
    after.terms === 'Net 30' && after.dueDate === '2026-02-04',
    'THE INVOICE ALREADY WRITTEN ON NET 30 STILL SAYS SO, due date and all',
    `${after.terms} / ${after.dueDate}`
  )

  /**
   * Idempotent AND quiet. invoice_customers is a synced table, so a second run
   * that touched all five rows would push all five to every other machine for a
   * change nobody made.
   */
  ok(repo.retireUnofferedCustomerTerms(db) === 0, 'a second run moves nothing')
  ok(touchedAt(onNet2) === stamp, 'and never touched updated_at on a row it left alone', touchedAt(onNet2))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
