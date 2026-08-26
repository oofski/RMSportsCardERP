/**
 * WHEN an invoice was paid, how much of it has been, and binding an order to the
 * QuickBooks invoice that carries its number.
 *
 * ## The three things that are genuinely easy to get wrong
 *
 *   1. A ZERO-DOLLAR PAYMENT IS NOT A PAYMENT. QuickBooks materialises the
 *      application of a credit memo as a Payment of $0.00 carrying a perfectly
 *      real TxnDate. Follow the link naively and the board prints "paid 12 Aug"
 *      on an invoice against which no money has ever moved — the single most
 *      misleading thing this feature could do, since answering when the money
 *      arrived is the whole point of it.
 *
 *   2. ONE PAYMENT IS NOT ONE INVOICE. A buyer clearing three cases with one
 *      transfer produces one Payment with three lines. The share belonging to
 *      any single invoice is that LINE's amount; taking Payment.TotalAmt would
 *      credit all three with the whole transfer and report every one overpaid.
 *
 *   3. AN EMPTY PAYMENT LIST IS AMBIGUOUS. It means "there are none" or "the
 *      second round trip never happened", and those must not be written to the
 *      database the same way — one is a fact and the other would blank a true
 *      date on the strength of an answer nobody got. `linkedPayments` comes off
 *      the invoice itself and is what separates them.
 *
 * ## And the thing that is dangerous rather than merely wrong
 *
 * Matching a local order to a QuickBooks invoice by number is a UNIQUENESS test
 * wearing an identity test's clothes. Both systems compute max+1 from disjoint
 * knowledge of the same range, so one invoice raised by hand is enough for them
 * to offer the same next number for two unrelated documents. The id a match
 * writes is what Delete sends operation=delete against, what Send emails to this
 * buyer, and what the status pull reads a stage from — where a bound VOID reads
 * back as 'void', releases the order's stock and erases its stock ledger.
 *
 * Section 7 is every guard standing in front of that, one assertion each, so a
 * guard that gets deleted takes a named test with it.
 *
 * Run: npm run test:qbo-paid
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/qbo-paid-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const repo = require('../src/main/db/invoices')
const { paymentsByInvoice } = require('../src/main/quickbooks/invoiceStatus')
const {
  clearedWithoutPayment,
  describeMatchRefusal,
  invoicePaymentProgress,
  latestPaymentDate,
  matchInvoiceByDocNumber,
  MATCH_DAY_WINDOW,
  observedPaid,
  paidHereNotThere,
  paymentsApplied,
  paymentSummary,
  paymentTone
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

const cash = (n: number): string => `$${n.toFixed(2)}`

// ---------------------------------------------------------------------------
console.log('=== 1. splitting a payment across the invoices it settles ===')
// ---------------------------------------------------------------------------
// The Invoice entity carries { TxnId, TxnType } and nothing else. Everything
// below comes off the Payment those ids point at.
const split = paymentsByInvoice([
  {
    Id: '500',
    TxnDate: '2026-08-12',
    // ONE TRANSFER, THREE CASES. TotalAmt is 1000; no invoice here got 1000.
    TotalAmt: 1000,
    Line: [
      { Amount: 600, LinkedTxn: [{ TxnId: '10', TxnType: 'Invoice' }] },
      { Amount: 300, LinkedTxn: [{ TxnId: '11', TxnType: 'Invoice' }] },
      { Amount: 100, LinkedTxn: [{ TxnId: '12', TxnType: 'Invoice' }] }
    ]
  }
])
ok(split.get('10')?.[0].amount === 600, 'each invoice gets ITS line, not the payment total', String(split.get('10')?.[0].amount))
ok(split.get('11')?.[0].amount === 300, 'the second invoice gets its own share')
ok(split.get('12')?.[0].amount === 100, 'and so does the third')
ok(split.get('10')?.[0].date === '2026-08-12', 'the date is the payment TxnDate, verbatim')
ok(split.get('10')?.[0].id === '500', 'and it remembers which payment it was')

// TWO LINES, ONE INVOICE, ONE PAYMENT. Merged, because a payment carrying two
// lines against the same invoice is still one payment — emitting two entries
// would make the count say two and the "latest" tie-break meaningless.
const merged = paymentsByInvoice([
  {
    Id: '501',
    TxnDate: '2026-08-13',
    Line: [
      { Amount: 40, LinkedTxn: [{ TxnId: '20', TxnType: 'Invoice' }] },
      { Amount: 60, LinkedTxn: [{ TxnId: '20', TxnType: 'Invoice' }] }
    ]
  }
])
ok(merged.get('20')?.length === 1, 'two lines against one invoice are ONE payment', String(merged.get('20')?.length))
ok(merged.get('20')?.[0].amount === 100, 'with the amounts added', String(merged.get('20')?.[0].amount))

// A payment line can point at a Deposit or a CreditMemo. Counting those would
// report money against an invoice that never went to it.
const noise = paymentsByInvoice([
  {
    Id: '502',
    TxnDate: '2026-08-14',
    Line: [
      { Amount: 75, LinkedTxn: [{ TxnId: '30', TxnType: 'Invoice' }] },
      { Amount: 999, LinkedTxn: [{ TxnId: '31', TxnType: 'Deposit' }] },
      { Amount: 888, LinkedTxn: [{ TxnId: '32', TxnType: 'CreditMemo' }] }
    ]
  }
])
ok(noise.size === 1, 'only Invoice links are followed', [...noise.keys()].join(','))
ok(noise.get('30')?.[0].amount === 75, 'and the invoice line is untouched by them')

ok(paymentsByInvoice([{ TxnDate: '2026-08-12' } as any]).size === 0, 'a payment with no id is skipped')
ok(paymentsByInvoice([]).size === 0, 'and nothing at all is nothing at all')

// ---------------------------------------------------------------------------
console.log('\n=== 2. WHICH DATE, and the zero-dollar trap ===')
// ---------------------------------------------------------------------------
const three = [
  { id: '1', date: '2026-08-01', amount: 100 },
  { id: '2', date: '2026-08-20', amount: 100 },
  { id: '3', date: '2026-08-11', amount: 100 }
]
ok(latestPaymentDate(three) === '2026-08-20', 'three instalments take the LATEST date', String(latestPaymentDate(three)))
ok(latestPaymentDate([]) === null, 'no payments means no date, not today')

// THE TRAP. A credit memo applied against an invoice shows up as a Payment of
// $0.00 with a real TxnDate. Letting it be the date prints "paid" on an invoice
// nobody has paid.
ok(
  latestPaymentDate([
    { id: '1', date: '2026-08-01', amount: 250 },
    { id: '2', date: '2026-09-09', amount: 0 }
  ]) === '2026-08-01',
  'A ZERO-DOLLAR PAYMENT NEVER SUPPLIES THE DATE — that is a credit memo, not money',
  String(
    latestPaymentDate([
      { id: '1', date: '2026-08-01', amount: 250 },
      { id: '2', date: '2026-09-09', amount: 0 }
    ])
  )
)
ok(
  latestPaymentDate([{ id: '2', date: '2026-09-09', amount: 0 }]) === null,
  'and a zero-dollar payment on its own leaves the date null rather than inventing one'
)
ok(
  latestPaymentDate([{ id: '9', date: 'yesterday', amount: 50 }]) === null,
  'anything not shaped like a calendar day is skipped, not coerced'
)
ok(paymentsApplied(three) === 300, 'applied is the sum of the shares', String(paymentsApplied(three)))
ok(
  paymentsApplied([{ id: '2', date: '2026-09-09', amount: 0 }]) === 0,
  'and a zero-dollar payment adds nothing — it still counts as looked-at, just not as money'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. how far through being paid ===')
// ---------------------------------------------------------------------------
const bill = (over: any = {}): any => ({
  status: 'sent',
  total: 1000,
  qboBalance: null,
  qboTotalAmt: null,
  qboVoided: false,
  qboPaidAt: null,
  ...over
})

const nothingKnown = invoicePaymentProgress(bill())
ok(nothingKnown.state === 'unknown', 'no reading is UNKNOWN, never "nothing paid"', nothingKnown.state)
ok(nothingKnown.source === 'none', 'and nobody is credited with having said it', nothingKnown.source)

const unpaid = invoicePaymentProgress(bill({ qboTotalAmt: 1000, qboBalance: 1000 }))
ok(unpaid.state === 'unpaid', 'a full balance is unpaid', unpaid.state)
ok(unpaid.fraction === 0 && unpaid.percent === 0, 'at exactly zero')
ok(unpaid.outstanding === 1000, 'with the whole thing owed', String(unpaid.outstanding))

const part = invoicePaymentProgress(bill({ qboTotalAmt: 1000, qboBalance: 400 }))
ok(part.state === 'partial', 'money in but not all of it is PARTIAL', part.state)
ok(part.paid === 600, 'paid is total minus balance', String(part.paid))
ok(part.outstanding === 400, 'and the rest is still owed', String(part.outstanding))
ok(part.percent === 60, 'sixty per cent', String(part.percent))
ok(paymentTone(part) === 'partial', 'PARTIAL IS AMBER, never green — green means nothing is owed')

const settled = invoicePaymentProgress(bill({ qboTotalAmt: 1000, qboBalance: 0, qboPaidAt: '2026-08-12' }))
ok(settled.state === 'paid', 'a zero balance is paid', settled.state)
ok(settled.percent === 100 && settled.fraction === 1, 'at a hundred')
ok(settled.paidOn === '2026-08-12', 'carrying the day it landed', String(settled.paidOn))
ok(paymentTone(settled) === 'done', 'and only THIS is green')

const over = invoicePaymentProgress(bill({ qboTotalAmt: 1000, qboBalance: -50 }))
ok(over.state === 'over', 'a negative balance is over-payment', over.state)
ok(over.excess === 50, 'by the amount past zero', String(over.excess))
ok(over.outstanding === 0, 'and nothing is owed', String(over.outstanding))
ok(over.fraction === 1, 'the rail stops at full rather than overflowing')
ok(paymentTone(over) === 'over', 'painted as a discrepancy, because that is what it is')

// THE ROUNDING RULE, which is the only subtle arithmetic here. Copied from the
// receiving bar for the same reason it exists there: rounding lies exactly where
// it matters most.
const almost = invoicePaymentProgress(bill({ qboTotalAmt: 1000, qboBalance: 0.5 }))
ok(almost.state === 'partial', 'fifty cents owed is still partial', almost.state)
ok(
  almost.percent === 99,
  'AND IT PRINTS 99, NOT 100 — a hundred per cent with money owed stops somebody chasing it',
  String(almost.percent)
)
const barely = invoicePaymentProgress(bill({ qboTotalAmt: 1000, qboBalance: 999.5 }))
ok(
  barely.percent === 1,
  'and fifty cents PAID prints 1, not 0 — zero sends somebody chasing a buyer who has already sent something',
  String(barely.percent)
)

// A voided invoice tells us nothing about payment, and a zero total tells us
// nothing either — it is what an empty or voided document looks like.
ok(
  invoicePaymentProgress(bill({ qboTotalAmt: 0, qboBalance: 0 })).state === 'unknown',
  'a zero total is not "paid in full"'
)
ok(
  invoicePaymentProgress(bill({ qboTotalAmt: 100, qboBalance: 0, qboVoided: true })).state ===
    'unknown',
  'and neither is a voided one'
)

// THE LOCAL FALLBACK. Plenty of invoices here settle in cash QuickBooks never
// sees, and the tick on the board is a real fact — just a different KIND of one,
// so it is labelled rather than dressed up as a balance.
const cashSale = invoicePaymentProgress(bill({ status: 'paid', total: 250 }))
ok(cashSale.state === 'paid', 'an invoice ticked paid with no reading still reads paid')
ok(cashSale.source === 'local', 'BUT SOURCED LOCALLY, not claimed as QuickBooks', cashSale.source)
ok(cashSale.total === 250, 'using our own total, which is the only one there is', String(cashSale.total))
ok(
  paymentSummary(cashSale, cash).includes('not read from QuickBooks'),
  'and the sentence says so',
  paymentSummary(cashSale, cash)
)

// QuickBooks' reading WINS over the tick when there is one, because the
// disagreement is the interesting part.
const disputed = bill({ status: 'paid', qboTotalAmt: 1000, qboBalance: 1000 })
ok(
  invoicePaymentProgress(disputed).state === 'unpaid',
  'a card ticked paid still shows the balance QuickBooks reports'
)
ok(paidHereNotThere(disputed) === true, 'AND THE DISAGREEMENT IS FLAGGED rather than hidden')
ok(
  paidHereNotThere(bill({ status: 'sent', qboTotalAmt: 1000, qboBalance: 1000 })) === false,
  'an open invoice with a balance is not a disagreement, it is just open'
)
ok(
  paidHereNotThere(bill({ status: 'paid', qboTotalAmt: 1000, qboBalance: 0 })) === false,
  'and two systems agreeing is not one either'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. settled WITHOUT anybody sending money ===')
// ---------------------------------------------------------------------------
// observedPaid keys on the balance, and a balance reaches zero by several routes
// that are not a payment. The card must be able to say which happened, or a
// settled invoice with no date looks like the date went missing.
const credited = {
  qboTotalAmt: 1000,
  qboBalance: 0,
  qboVoided: false,
  qboPaymentsApplied: 0
}
ok(
  observedPaid({ balance: 0, totalAmt: 1000, voided: false } as any) === true,
  'QuickBooks reports it settled — that part is unchanged'
)
ok(clearedWithoutPayment(credited) === true, 'AND WE CAN SAY NO MONEY CAME IN')
ok(
  clearedWithoutPayment({ ...credited, qboPaymentsApplied: 1000 }) === false,
  'an invoice actually paid is not a clearance'
)
ok(
  clearedWithoutPayment({ ...credited, qboPaymentsApplied: 400 }) === true,
  'and part-paid, part-credited counts — some of it was cleared without money'
)
ok(
  clearedWithoutPayment({ ...credited, qboPaymentsApplied: null }) === false,
  'NULL MEANS NOBODY LOOKED, which is not evidence of anything'
)
ok(
  clearedWithoutPayment({ ...credited, qboBalance: 300 }) === false,
  'and an invoice still owing money has not been cleared at all'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. writing it down, and refusing to un-write it ===')
// ---------------------------------------------------------------------------
const buyer = repo.saveCustomer({ name: 'Ada Okonkwo', email: 'ada@example.test' })
const made = repo.saveInvoice(
  {
    invoiceNumber: '3001',
    customerId: buyer.id,
    customerName: 'Ada Okonkwo',
    invoiceDate: '2026-08-01',
    lines: [{ item: 'Case break', quantity: 1, rate: 1000 }]
  },
  'emp_owner'
)
db.prepare(`UPDATE invoices SET qbo_id = '9001', status = 'sent' WHERE id = ?`).run(made.id)

const observed = (over: any = {}): any => ({
  qboId: '9001',
  docNumber: '3001',
  emailStatus: 'EmailSent',
  deliveredAt: null,
  balance: 400,
  totalAmt: 1000,
  linkedPayments: 1,
  payments: [{ id: '77', date: '2026-08-12', amount: 600 }],
  voided: false,
  ...over
})

repo.recordQboObservation(made.id, observed())
let row = repo.getInvoice(made.id)
ok(row.qboPaidAt === '2026-08-12', 'the payment date is written down', String(row.qboPaidAt))
ok(row.qboPaymentsApplied === 600, 'with what the payments came to', String(row.qboPaymentsApplied))
ok(row.qboPaymentCount === 1, 'and how many there were', String(row.qboPaymentCount))
ok(row.qboBalance === 400, 'alongside the balance, as before')

// THE ONE THAT MATTERS. A failed or throttled Payment query hands back an empty
// list, and writing it through would blank a true date on the strength of an
// answer nobody ever got. linkedPayments still says there is a payment there.
repo.recordQboObservation(made.id, observed({ payments: [], linkedPayments: 1, balance: 350 }))
row = repo.getInvoice(made.id)
ok(
  row.qboPaidAt === '2026-08-12',
  'A LOOK THAT DID NOT HAPPEN LEAVES THE DATE ALONE — stale-but-true beats fresh-and-wrong',
  String(row.qboPaidAt)
)
ok(row.qboPaymentsApplied === 600, 'and leaves the amount alone')
ok(row.qboPaymentCount === 1, 'and the count')
ok(row.qboBalance === 350, 'while the balance, which we DID get, is updated', String(row.qboBalance))

// But QuickBooks positively saying there are none IS an answer, and a payment
// deleted over there should take its date with it.
repo.recordQboObservation(made.id, observed({ payments: [], linkedPayments: 0, balance: 1000 }))
row = repo.getInvoice(made.id)
ok(row.qboPaidAt === null, 'ZERO LINKS IS A REAL ANSWER — a deleted payment takes the date with it')
ok(row.qboPaymentsApplied === 0, 'and the amount goes to zero, not to null')
ok(row.qboPaymentCount === 0, 'and the count says zero rather than unknown')

// ---------------------------------------------------------------------------
console.log('\n=== 6. WHAT TAKES AN INVOICE OFF THE SWEEP IS QUICKBOOKS, NOT THE TICK ===')
// ---------------------------------------------------------------------------
/**
 * THE OWNER'S BUG, and the assertion that used to guarantee it.
 *
 * There has to be a stopping rule — a cash sale QuickBooks never saw would
 * otherwise be asked about forever — and it used to be
 * `NOT (status = 'paid' AND qbo_status_checked_at IS NOT NULL)`. This section
 * asserted that rule approvingly. Both halves of it look like they are about the
 * payment and neither is: `qbo_status_checked_at` is stamped by every check,
 * including ones that ran days earlier while the invoice was still open, and
 * `status = 'paid'` is the Mark paid button on this floor.
 *
 * So the instant an operator ticked Mark paid, the invoice left the sweep
 * carrying whatever balance had been read while it was still unpaid. The money
 * then landed in QuickBooks and nothing here ever asked again. The owner's
 * invoices 2362 and 2367 showed "Paid" in QuickBooks and an EMPTY payment rail
 * here, reading "$0.00 of $5,200.00 — QuickBooks still shows $5,200.00 owing",
 * and pressing Check QuickBooks could not mend it because the row was not in the
 * sweep to begin with.
 *
 * The rule is QuickBooks' own reading now: a zero balance, or a void.
 */
const settledRow = repo.saveInvoice(
  {
    invoiceNumber: '3002',
    customerName: 'Ada Okonkwo',
    invoiceDate: '2026-08-02',
    lines: [{ item: 'Case break', quantity: 1, rate: 500 }]
  },
  'emp_owner'
)
const onSweep = (id: string): boolean =>
  repo.listPostedInvoices().some((i: any) => i.id === id)

db.prepare(
  `UPDATE invoices SET qbo_id = '9002', status = 'sent', qbo_status_checked_at = NULL WHERE id = ?`
).run(settledRow.id)
ok(onSweep(settledRow.id), 'an invoice with no answer yet is asked about')

// It has been checked once, while genuinely unpaid. This is the state every
// invoice passes through, and it is where the old rule was armed and waiting.
db.prepare(
  `UPDATE invoices
      SET qbo_status_checked_at = '2026-08-18T00:00:00.000Z', qbo_balance = 500, qbo_total_amt = 500
    WHERE id = ?`
).run(settledRow.id)
ok(onSweep(settledRow.id), 'a checked-but-still-owing invoice is asked about again')

// Somebody ticks Mark paid on the board. The money is real; QuickBooks has not
// heard about it yet. THIS is the line that used to end the invoice's life.
repo.setInvoiceStatus(settledRow.id, 'paid', 'emp_owner')
ok(
  onSweep(settledRow.id),
  'MARKING IT PAID HERE DOES NOT END THE QUESTION — Intuit still shows 500 owing, which is exactly the invoice worth asking about',
  String(repo.getInvoice(settledRow.id).qboBalance)
)

// QuickBooks finally reports the payment. NOW there is nothing left to learn.
db.prepare(`UPDATE invoices SET qbo_balance = 0 WHERE id = ?`).run(settledRow.id)
ok(
  !onSweep(settledRow.id),
  'and it drops off once QUICKBOOKS says the balance is zero',
  String(repo.getInvoice(settledRow.id).qboBalance)
)

// A cash sale QuickBooks never sees keeps a real balance forever, so the date
// ordering and the limit are what carry it off the end — not a rule that
// pretends it was answered. Proven by putting the balance back.
db.prepare(`UPDATE invoices SET qbo_balance = 500 WHERE id = ?`).run(settledRow.id)
ok(
  onSweep(settledRow.id),
  'a balance that comes back puts the invoice back on the sweep',
  String(repo.getInvoice(settledRow.id).qboBalance)
)

// A void is the other terminal answer: nothing about it will change either.
db.prepare(`UPDATE invoices SET qbo_voided = 1 WHERE id = ?`).run(settledRow.id)
ok(!onSweep(settledRow.id), 'a voided invoice drops off even with a balance on it')

db.prepare(`UPDATE invoices SET qbo_voided = 0, status = 'void' WHERE id = ?`).run(settledRow.id)
ok(!onSweep(settledRow.id), 'and a locally void invoice is never asked about')

// ---------------------------------------------------------------------------
console.log('\n=== 6b. THE CHECK REPORTS WHETHER ANYTHING ACTUALLY MOVED ===')
// ---------------------------------------------------------------------------
/**
 * The other half of the same bug, on the screen rather than in the sweep.
 *
 * The board re-read itself only when a card changed COLUMN. A card already in
 * Paid because somebody ticked it does not change column when the money shows up
 * — `nextStageFromQbo` returns null the moment Intuit agrees with where the card
 * already is — so the rail went on drawing the old balance and the toast said
 * "nothing has changed" over a row that had just been settled.
 *
 * `recordQboObservation` answers "did a figure a person can see move", which is
 * what the board watches now.
 */
const watchRow = repo.saveInvoice(
  {
    invoiceNumber: '3003',
    customerName: 'Ada Okonkwo',
    invoiceDate: '2026-08-03',
    lines: [{ item: 'Case break', quantity: 1, rate: 800 }]
  },
  'emp_owner'
)
db.prepare(`UPDATE invoices SET qbo_id = '9003', status = 'sent' WHERE id = ?`).run(watchRow.id)
const seenOn9003 = (over: any = {}): any => ({
  qboId: '9003',
  docNumber: '3003',
  emailStatus: 'EmailSent',
  deliveredAt: null,
  balance: 800,
  totalAmt: 800,
  linkedPayments: 0,
  payments: [],
  voided: false,
  ...over
})

ok(
  repo.recordQboObservation(watchRow.id, seenOn9003()) === true,
  'the first answer about an invoice is a change'
)
ok(
  repo.recordQboObservation(watchRow.id, seenOn9003()) === false,
  'THE SAME ANSWER TWICE IS NOT — or every quarter-hour sweep would redraw the board and claim news',
)
ok(
  repo.recordQboObservation(
    watchRow.id,
    seenOn9003({ balance: 0, linkedPayments: 1, payments: [{ id: '81', date: '2026-08-24', amount: 800 }] })
  ) === true,
  'A PAYMENT LANDING IS A CHANGE, even though the card does not move column'
)
ok(
  repo.getInvoice(watchRow.id).qboBalance === 0 &&
    repo.getInvoice(watchRow.id).qboPaidAt === '2026-08-24',
  'and the balance and the date are what got written',
  `${repo.getInvoice(watchRow.id).qboBalance} / ${repo.getInvoice(watchRow.id).qboPaidAt}`
)
// A throttled payment fetch leaves the date alone (section 5), so it must not
// report itself as having changed one either.
ok(
  repo.recordQboObservation(
    watchRow.id,
    seenOn9003({ balance: 0, linkedPayments: 1, payments: [] })
  ) === false,
  'A LOOK THAT DID NOT HAPPEN REPORTS NO CHANGE — it did not write one'
)

/**
 * The two figures move independently, so each has to count on its own.
 *
 * A PART PAYMENT moves the balance and nothing else — no new payment date if the
 * Payment query was throttled, same email status, same total. A RE-DATED payment
 * moves the date and nothing else — somebody in QuickBooks correcting the day a
 * transfer was booked leaves the balance at zero. Either one alone must redraw
 * the rail, and a change test that only watched the other would sit there
 * reporting that nothing had happened.
 */
db.prepare(
  `UPDATE invoices SET qbo_balance = 800, qbo_paid_at = NULL, qbo_payments_applied = NULL WHERE id = ?`
).run(watchRow.id)
ok(
  repo.recordQboObservation(
    watchRow.id,
    seenOn9003({ balance: 300, linkedPayments: 1, payments: [] })
  ) === true,
  'A PART PAYMENT IS A CHANGE ON THE BALANCE ALONE — no date came with it',
  String(repo.getInvoice(watchRow.id).qboBalance)
)

const settledOn = (day: string): any =>
  seenOn9003({ balance: 0, linkedPayments: 1, payments: [{ id: '82', date: day, amount: 800 }] })
repo.recordQboObservation(watchRow.id, settledOn('2026-08-24'))
ok(
  repo.recordQboObservation(watchRow.id, settledOn('2026-08-24')) === false,
  'the same settled answer twice is still not a change'
)
ok(
  repo.recordQboObservation(watchRow.id, settledOn('2026-08-25')) === true,
  'A PAYMENT RE-DATED IN QUICKBOOKS IS A CHANGE ON THE DATE ALONE — the balance never moved off zero',
  String(repo.getInvoice(watchRow.id).qboPaidAt)
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. EVERY GUARD ON BINDING BY NUMBER ===')
// ---------------------------------------------------------------------------
// One assertion per guard, named for the guard, so deleting one takes a named
// test with it rather than quietly widening what gets bound.
const local = (over: any = {}): any => ({
  invoiceNumber: '2301',
  customerName: 'Ada Okonkwo',
  invoiceDate: '2026-08-01',
  total: 1000,
  status: 'sent',
  qboPushState: 'ok',
  ...over
})
const theirs = (over: any = {}): any => ({
  qboId: '7001',
  docNumber: '2301',
  customerName: 'Ada Okonkwo',
  txnDate: '2026-08-01',
  totalAmt: 1000,
  balance: 0,
  voided: false,
  ...over
})
const ctx = (over: any = {}): any => ({ localsWithNumber: 1, claimed: new Set(), ...over })

const good = matchInvoiceByDocNumber(local(), [theirs()], ctx())
ok(good.ok === true, 'everything agreeing is a match')
ok(good.ok && good.match.qboId === '7001', 'naming the QuickBooks invoice to bind to')

const refuses = (
  l: any,
  candidates: any[],
  c: any,
  reason: string,
  why: string
): void => {
  const v = matchInvoiceByDocNumber(l, candidates, c)
  ok(v.ok === false && v.reason === reason, why, v.ok ? 'MATCHED' : v.reason)
}

refuses(local({ invoiceNumber: '  ' }), [theirs()], ctx(), 'no-number', 'no number to match on')
refuses(local({ status: 'void' }), [theirs()], ctx(), 'not-eligible', 'a void order is never bound — it has already released its stock')
refuses(local({ status: 'paid' }), [theirs()], ctx(), 'not-eligible', 'nor a paid one, which is terminal')
refuses(local({ qboPushState: 'pending' }), [theirs()], ctx(), 'not-eligible', 'nor one mid-push, which may already have an invoice over there')
refuses(local(), [], ctx(), 'none', 'nothing in QuickBooks under that number')
refuses(local(), [theirs(), theirs({ qboId: '7002' })], ctx(), 'ambiguous-there', 'TWO INVOICES THERE — QuickBooks allows a duplicate number')
refuses(local(), [theirs()], ctx({ localsWithNumber: 2 }), 'ambiguous-here', 'two orders HERE carrying the number — which one binds would be a coin toss')
refuses(local(), [theirs()], ctx({ claimed: new Set(['7001']) }), 'claimed', 'that QuickBooks invoice already belongs to another order')
refuses(local(), [theirs({ voided: true })], ctx(), 'voided', 'A VOID SHELL IS NEVER BOUND — binding one voids the order here and erases its stock ledger')
refuses(local(), [theirs({ customerName: 'Someone Else' })], ctx(), 'customer', 'a different buyer')
refuses(local(), [theirs({ customerName: null })], ctx(), 'customer', 'or no buyer named at all')
refuses(local(), [theirs({ totalAmt: 600 })], ctx(), 'total', 'A DIFFERENT AMOUNT — this is what catches one order billed as two invoices')
refuses(local(), [theirs({ totalAmt: null })], ctx(), 'total', 'or no amount to compare')
refuses(local(), [theirs({ txnDate: '2026-09-30' })], ctx(), 'date', 'dated far from ours — the same number in a different year')
refuses(local(), [theirs({ txnDate: null })], ctx(), 'date', 'or not dated at all')

// The window is a window, not an exact match: an order typed on Friday and
// invoiced on Monday is the same document.
ok(
  matchInvoiceByDocNumber(local(), [theirs({ txnDate: '2026-08-08' })], ctx()).ok === true,
  `${MATCH_DAY_WINDOW} days apart still matches`
)
ok(
  matchInvoiceByDocNumber(local(), [theirs({ txnDate: '2026-08-09' })], ctx()).ok === false,
  'and one day past the window does not'
)
// Case and padding are typing, not identity.
ok(
  matchInvoiceByDocNumber(local(), [theirs({ customerName: '  ada okonkwo ' })], ctx()).ok === true,
  'the buyer is compared trimmed and case-insensitively, as the push itself does'
)
// A cent apart is a different document, and this is deliberate: the guard is
// what stops half an order reading as collected in full.
ok(
  matchInvoiceByDocNumber(local(), [theirs({ totalAmt: 1000.01 })], ctx()).ok === false,
  'ONE CENT APART IS REFUSED'
)

ok(
  describeMatchRefusal('voided').toLowerCase().includes('void'),
  'every refusal has a sentence somebody can read'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. the database side of binding ===')
// ---------------------------------------------------------------------------
const orphan = repo.saveInvoice(
  {
    invoiceNumber: '4001',
    customerName: 'Ada Okonkwo',
    invoiceDate: '2026-08-05',
    lines: [{ item: 'Case break', quantity: 1, rate: 800 }]
  },
  'emp_owner'
)
ok(
  repo.listInvoicesForDocNumberMatch().some((i: any) => i.id === orphan.id),
  'an order with no QuickBooks id is offered for matching'
)
ok(
  !repo.listInvoicesForDocNumberMatch().some((i: any) => i.id === made.id),
  'and one that already has an id is not'
)

/**
 * A TWIN CAN NO LONGER BE MADE, which is the v77 change: saveInvoice claims the
 * number inside its transaction and a partial unique index backs it up. Asking
 * for a number somebody already holds moves this order rather than duplicating
 * it — that is what stopped 2337 appearing in two columns at once.
 */
const wouldBeTwin = repo.saveInvoice(
  {
    invoiceNumber: '4001',
    customerName: 'Someone Else',
    invoiceDate: '2026-08-05',
    lines: [{ item: 'Case break', quantity: 1, rate: 800 }]
  },
  'emp_owner'
)
ok(
  wouldBeTwin.invoiceNumber !== '4001',
  'ASKING FOR A TAKEN NUMBER MOVES THE NEW ORDER instead of making a twin',
  String(wouldBeTwin.invoiceNumber)
)
ok(
  repo.countInvoiceNumbers(['4001']).get('4001') === 1,
  'so the number still names exactly one document',
  String(repo.countInvoiceNumbers(['4001']).get('4001'))
)
db.prepare(`DELETE FROM invoices WHERE id = ?`).run(wouldBeTwin.id)

/**
 * The ambiguity guard itself still has to WORK, because the constraint is what
 * prevents the situation and a guard that is never exercised is a guard nobody
 * knows is broken. The index is lifted for exactly as long as it takes to build
 * the state it defends against — a duplicate is otherwise unreachable now, and
 * an untested branch here would be one that silently rots.
 *
 * Counted across EVERY status: a voided second row still makes the number name
 * two documents, so it must not be discounted.
 */
db.exec('DROP INDEX IF EXISTS idx_invoices_number_unique')
const twinId = 'inv_forced_twin'
db.prepare(
  `INSERT INTO invoices (id, invoice_number, customer_name, invoice_date, due_date,
                         terms, status, total, created_at, updated_at)
   VALUES (?, '4001', 'Someone Else', '2026-08-05', '2026-08-05', 'net_30', 'void', 800,
           '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z')`
).run(twinId)
ok(
  repo.countInvoiceNumbers(['4001']).get('4001') === 2,
  'A VOIDED TWIN STILL COUNTS — it still makes the number name two documents',
  String(repo.countInvoiceNumbers(['4001']).get('4001'))
)
db.prepare(`DELETE FROM invoices WHERE id = ?`).run(twinId)
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number_unique
     ON invoices (invoice_number)
   WHERE invoice_number IS NOT NULL AND invoice_number != ''`
)
ok(repo.countInvoiceNumbers(['4001']).get('4001') === 1, 'and one row is one row again')
ok(repo.countInvoiceNumbers([]).size === 0, 'asking about nothing asks nothing')

ok(repo.claimedQboIds(['9001', '7777']).has('9001'), 'a taken QuickBooks id is reported taken')
ok(!repo.claimedQboIds(['9001', '7777']).has('7777'), 'and a free one is not')

ok(repo.adoptQboInvoice(orphan.id, '7001', '4001') === true, 'binding writes the id')
let bound = repo.getInvoice(orphan.id)
ok(bound.qboId === '7001', 'which is now on the order', String(bound.qboId))
ok(bound.qboPushState === 'ok', 'and there is nothing left to push')
ok(bound.status === 'draft', 'BINDING DOES NOT MOVE THE CARD — the next QuickBooks check does that', bound.status)
ok(bound.qboSyncedAt === null, 'and it does not claim we put the invoice there')

// The guard in the SQL. Between a screen listing a proposal and somebody
// pressing the button, a push can give the row an id — and overwriting one
// qbo_id with another silently re-points Delete and Send at a different document
// in somebody's real books.
ok(
  repo.adoptQboInvoice(orphan.id, '7009', '4001') === false,
  'A ROW THAT ALREADY HAS AN ID REFUSES A SECOND ONE'
)
ok(repo.getInvoice(orphan.id).qboId === '7001', 'and keeps the one it had', String(repo.getInvoice(orphan.id).qboId))

// The premise of the whole feature, checked against evidence the app already has.
ok(repo.countRenumberedInvoices() === 0, 'nothing has been renumbered yet', String(repo.countRenumberedInvoices()))
db.prepare(`UPDATE invoices SET qbo_doc_number = '88888' WHERE id = ?`).run(made.id)
ok(
  repo.countRenumberedInvoices() === 1,
  'QUICKBOOKS GIVING AN INVOICE A DIFFERENT NUMBER IS DETECTED — matching on a number is a coincidence in that company',
  String(repo.countRenumberedInvoices())
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
