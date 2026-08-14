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
const {
  INVOICE_CSV_HEADERS,
  DEFAULT_INVOICE_TERMS,
  INVOICE_TERMS,
  TERM_DAYS,
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
    `“${historical}” is still offered, so invoices on it still show it`
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
ok(cash.paidAt === null, 'a new invoice is not paid')
repo.setInvoiceStatus(cash.id, 'paid', 'emp_owner')
const paid = repo.getInvoice(cash.id)
ok(paid.status === 'paid', 'ticking it records paid')
ok(typeof paid.paidAt === 'string' && paid.paidAt.length > 0, 'and stamps when', String(paid.paidAt))
ok(paid.paidBy === 'emp_owner', 'and who')

// THE DATE MUST NOT OUTLIVE THE CLAIM. A stale "paid 3 March" on an invoice no
// longer marked paid is the kind of thing somebody reads out to a buyer.
repo.setInvoiceStatus(cash.id, 'sent', 'emp_owner')
const unpaid = repo.getInvoice(cash.id)
ok(unpaid.status === 'sent', 'moving it off paid works')
ok(unpaid.paidAt === null, 'and clears the paid date', String(unpaid.paidAt))
ok(unpaid.paidBy === null, 'and who ticked it')

// Ticking twice keeps the FIRST date — the money arrived when it arrived.
repo.setInvoiceStatus(cash.id, 'paid', 'emp_owner')
const firstStamp = repo.getInvoice(cash.id).paidAt
repo.setInvoiceStatus(cash.id, 'paid', 'emp_other')
ok(repo.getInvoice(cash.id).paidAt === firstStamp, 'ticking paid twice keeps the first date')

// Paid money is no longer outstanding; it moves to the paid total.
const s2 = repo.invoiceStats()
ok(s2.paid >= 1, 'the paid count includes it', String(s2.paid))
ok(s2.paidTotal >= 250, 'and the paid total', String(s2.paidTotal))

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

repo.markPushPending(pushMe.id)
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

// A settled invoice is off the sweep — there is nothing left to learn about it.
repo.setInvoiceStatus(watched.id, 'paid', 'emp_owner')
ok(
  !repo.listPostedInvoices().some((i: any) => i.id === watched.id),
  'a paid invoice is not re-checked'
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


console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
