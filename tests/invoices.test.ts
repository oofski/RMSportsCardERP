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

// Intuit's importer only accepts MM/DD/YYYY.
ok(toUsDate('2022-11-21') === '11/21/2022', 'dates export American')
ok(toUsDate('') === '', 'and a blank stays blank rather than becoming 1970')

ok(nextInvoiceNumber([]) === '1001', 'the first invoice is 1001')
ok(nextInvoiceNumber(['1001', '1002']) === '1003', 'then it counts on')
ok(nextInvoiceNumber(['1002', '1001']) === '1003', 'whatever order they arrive in')
// A custom series is not guessed at: deciding which digits of "INV-0042" are
// the counter and getting it wrong on somebody's real numbering is worse than
// starting a series they can type over.
ok(nextInvoiceNumber(['INV-0042']) === '1001', 'a non-numeric series is not guessed at')

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

ok(repo.suggestInvoiceNumber() === '1002', 'the next number follows the highest')

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

let deleteRefused = ''
try {
  repo.deleteInvoice(inv1.id)
} catch (err) {
  deleteRefused = err instanceof Error ? err.message : String(err)
}
ok(deleteRefused !== '', 'and so is deleting it')
ok(/void/i.test(deleteRefused), 'pointing at voiding instead', deleteRefused)

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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
