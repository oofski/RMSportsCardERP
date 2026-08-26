/**
 * PRESSING "CHECK QUICKBOOKS" ON AN INVOICE SOMEBODY ALREADY TICKED PAID.
 *
 * The owner's report, with screenshots of both sides: QuickBooks' own invoice
 * list showed 2362 (Howard East, $5,200) and 2367 (Ryan Drew, $4,699) with a
 * green check and the word "Paid". This app showed both in the Paid column above
 * an EMPTY payment rail reading "$0.00 of $5,200.00", under the note "Marked paid
 * here — QuickBooks still shows $5,200.00 owing". Pressing Check QuickBooks
 * changed nothing, over and over.
 *
 * Two separate defects, and either one alone reproduces the whole symptom, which
 * is why this suite drives the REGISTERED IPC HANDLER rather than the repo: it is
 * the button that was broken, and the button is the sum of the two.
 *
 *   · THE SWEEP DID NOT INCLUDE THE ROW. `listPostedInvoices` stopped asking
 *     about an invoice once `status = 'paid' AND qbo_status_checked_at IS NOT
 *     NULL`. Neither half is about the payment — `qbo_status_checked_at` is
 *     stamped by every check including ones from days earlier while the invoice
 *     was still open, and `status = 'paid'` is the Mark paid button on this
 *     floor. So the tick itself ended the invoice's life on the sweep, carrying
 *     whatever balance had been read before anybody paid.
 *
 *   · THE BOARD DID NOT REDRAW. It re-read itself only when a card changed
 *     COLUMN, and a card already in Paid does not change column when the money
 *     turns up — `nextStageFromQbo` returns null as soon as Intuit agrees with
 *     where the card is. So even a fixed sweep would have written the new balance
 *     to SQLite and left the old one on the screen, under a toast reading
 *     "nothing has changed".
 *
 * No real credential is in this file. The client id, secret, tokens and realm are
 * invented, the customers are invented, and nothing here reaches the internet:
 * global fetch is replaced for the whole run.
 *
 * Run: npm run test:qbo-sweep
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/qbo-sweep-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const repo = require('../src/main/db/invoices')
const employees = require('../src/main/db/employees')
const auth = require('../src/main/services/auth')
const { registerInvoicesIpc } = require('../src/main/invoicesIpc')
const { registeredHandlers } = require('../src/main/ipcRegistry')
const { IPC } = require('../src/shared/ipc')
const { invoicePaymentProgress, paidHereNotThere } = require('../src/shared/invoices')
const store = require('../src/main/quickbooks/store')
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
// A signed-in owner, the handlers wired up, and a QuickBooks that answers
// ---------------------------------------------------------------------------
const OWNER_PASSWORD = 'owner-password-1'
employees.insertEmployee(
  {
    firstName: 'Owen',
    lastName: 'Boss',
    companyId: 'RM-001',
    title: 'Owner',
    email: 'owen@rmcardz.test',
    role: 'owner',
    status: 'active'
  },
  null,
  OWNER_PASSWORD,
  false
)
ok(auth.login('RM-001', OWNER_PASSWORD).ok === true, 'an owner is signed in')
registerInvoicesIpc()
const sync = (): Promise<any> =>
  Promise.resolve(registeredHandlers().get(IPC.invoiceSyncQboStatus)({ sender: null }, {}))

store.setQboConfig('invented-client-id', 'invented-client-secret', 'production')
store.setQboTokens({
  accessToken: 'invented-access-token',
  refreshToken: 'invented-refresh-token',
  realmId: '4620000000000000001',
  expiresAt: Date.now() + 60 * 60 * 1000,
  refreshExpiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000
})

/**
 * What QuickBooks currently says, keyed by its invoice id. The test rewrites
 * these between presses — which is the whole point, since the bug is about a
 * second press seeing something the first one could not.
 */
const remote = new Map<string, any>()
const remotePayments = new Map<string, any>()

const realFetch = globalThis.fetch
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: any) => {
  const url = new URL(String(input))
  if (!url.pathname.endsWith('/query')) return json({}, 404)
  const sql = url.searchParams.get('query') ?? ''
  const ids = [...sql.matchAll(/'(\d+)'/g)].map((m) => m[1])
  if (/from Invoice/i.test(sql)) {
    return json({
      QueryResponse: { Invoice: ids.map((id) => remote.get(id)).filter(Boolean) }
    })
  }
  if (/from Payment/i.test(sql)) {
    return json({
      QueryResponse: { Payment: ids.map((id) => remotePayments.get(id)).filter(Boolean) }
    })
  }
  return json({ QueryResponse: {} })
}) as typeof fetch

// ---------------------------------------------------------------------------
// Two invoices, both posted, both still owing
// ---------------------------------------------------------------------------
const make = (number: string, name: string, rate: number, qboId: string, date: string): any => {
  const inv = repo.saveInvoice(
    {
      invoiceNumber: number,
      customerName: name,
      invoiceDate: date,
      lines: [{ item: 'Case break', quantity: 1, rate }]
    },
    'emp_owner'
  )
  db.prepare(`UPDATE invoices SET qbo_id = ?, status = 'sent' WHERE id = ?`).run(qboId, inv.id)
  remote.set(qboId, {
    Id: qboId,
    DocNumber: number,
    EmailStatus: 'EmailSent',
    DeliveryInfo: { DeliveryTime: '2026-08-20T10:00:00-05:00' },
    Balance: rate,
    TotalAmt: rate,
    LinkedTxn: []
  })
  return inv
}

// The owner's own two, by number and by figure.
const howard = make('2362', 'Howard East', 5200, '9362', '2026-08-24')
const zack = make('2359', 'Zack Makray', 13665, '9359', '2026-08-24')

const run = async (): Promise<void> => {
  // -------------------------------------------------------------------------
  console.log('\n=== 1. the first check, while both are genuinely open ===')
  // -------------------------------------------------------------------------
  {
    const res = await sync()
    ok(res.ok === true, 'the check succeeds', String(res.error))
    ok(res.data.checked === 2, 'both invoices are asked about', String(res.data.checked))
    ok(res.data.missing === 0, 'and QuickBooks answered for both', String(res.data.missing))
    ok(res.data.updated === 2, 'a first answer about each is a change', String(res.data.updated))
    ok(res.data.moved.length === 0, 'neither card moves — both were already sent', JSON.stringify(res.data.moved))
    ok(
      repo.getInvoice(howard.id).qboBalance === 5200,
      'and the balance QuickBooks reported is written down',
      String(repo.getInvoice(howard.id).qboBalance)
    )
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 2. a SECOND identical check reports nothing ===')
  // -------------------------------------------------------------------------
  // Because the 15-minute timer runs this whether or not anything happened, and
  // a sweep that always claimed news would redraw the board every quarter hour
  // and train everybody to ignore the toast that matters.
  {
    const res = await sync()
    ok(res.data.checked === 2, 'both are still asked about — neither is settled', String(res.data.checked))
    ok(res.data.updated === 0, 'AND NOTHING IS REPORTED AS CHANGED', String(res.data.updated))
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 3. somebody ticks Mark paid. THE MONEY IS REAL; INTUIT HAS NOT HEARD ===')
  // -------------------------------------------------------------------------
  // This is the line that used to end the invoice's life on the sweep.
  {
    repo.setInvoiceStatus(howard.id, 'paid', 'emp_owner')
    const row = repo.getInvoice(howard.id)
    ok(row.status === 'paid', 'the card is in Paid')
    ok(
      paidHereNotThere(row) === true,
      'and the card says so: marked paid here, QuickBooks still shows it owing'
    )
    const res = await sync()
    ok(
      res.data.checked === 2,
      'THE TICK DOES NOT TAKE IT OFF THE SWEEP — it is the invoice most worth asking about',
      String(res.data.checked)
    )
    ok(res.data.updated === 0, 'and nothing has changed in QuickBooks yet, so nothing is claimed')
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 4. THE PAYMENT LANDS IN QUICKBOOKS, and the press picks it up ===')
  // -------------------------------------------------------------------------
  {
    remote.set('9362', {
      ...remote.get('9362'),
      Balance: 0,
      LinkedTxn: [{ TxnId: '4471', TxnType: 'Payment' }]
    })
    remotePayments.set('4471', {
      Id: '4471',
      TxnDate: '2026-08-24',
      TotalAmt: 5200,
      Line: [{ Amount: 5200, LinkedTxn: [{ TxnId: '9362', TxnType: 'Invoice' }] }]
    })

    const res = await sync()
    ok(res.data.checked === 2, 'both are checked one last time', String(res.data.checked))
    ok(
      res.data.updated === 1,
      'ONE OF THEM CHANGED, and the press says so instead of "nothing has changed"',
      String(res.data.updated)
    )
    ok(
      res.data.moved.length === 0,
      'while NOTHING MOVED COLUMN — the card was already in Paid, which is exactly why watching `moved` alone left the screen stale',
      JSON.stringify(res.data.moved)
    )

    const row = repo.getInvoice(howard.id)
    ok(row.qboBalance === 0, 'the stored balance is now zero', String(row.qboBalance))
    ok(row.qboPaidAt === '2026-08-24', 'and QuickBooks’ own payment date came with it', String(row.qboPaidAt))
    ok(paidHereNotThere(row) === false, 'so the "marked paid here" note is gone')

    const progress = invoicePaymentProgress(row)
    ok(
      progress.state === 'paid' && progress.fraction === 1 && progress.source === 'quickbooks',
      'AND THE RAIL IS FULL, on QuickBooks’ reading rather than on somebody’s word',
      `${progress.state}/${progress.fraction}/${progress.source}`
    )
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 5. settled in QuickBooks IS the end of the question ===')
  // -------------------------------------------------------------------------
  // There has to be a stopping rule or a cash sale Intuit never sees would be
  // asked about forever. It is Intuit's answer now, not the tick.
  {
    const res = await sync()
    ok(
      res.data.checked === 1,
      'the settled invoice drops off and only the still-owing one is asked about',
      String(res.data.checked)
    )
    ok(
      repo.getInvoice(zack.id).qboBalance === 13665,
      'which is the one that really is open',
      String(repo.getInvoice(zack.id).qboBalance)
    )
    ok(res.data.updated === 0, 'and it has not changed either')
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 6. a payment REVERSED in QuickBooks comes back onto the sweep ===')
  // -------------------------------------------------------------------------
  // The stopping rule is a fact about the books, not a one-way door. A payment
  // deleted over there puts the balance back, and the invoice with it.
  {
    remote.set('9362', { ...remote.get('9362'), Balance: 5200, LinkedTxn: [] })
    // It is off the sweep, so the balance in SQLite is what makes it eligible
    // again — put it back the way a bounced cheque would, through a per-invoice
    // check on the card.
    const one = await Promise.resolve(
      registeredHandlers().get(IPC.invoiceSyncQboStatus)({ sender: null }, { id: howard.id })
    )
    ok(one.data.checked === 1, 'A CARD CAN ALWAYS BE ASKED ABOUT BY NAME, sweep or no sweep')
    ok(one.data.updated === 1, 'and the reversal is picked up')
    ok(repo.getInvoice(howard.id).qboBalance === 5200, 'the balance is back')
    ok(repo.getInvoice(howard.id).qboPaidAt === null, 'and the paid date went with the payment')

    const res = await sync()
    ok(
      res.data.checked === 2,
      'so the sweep takes it up again — the rule reads the books, it is not a one-way door',
      String(res.data.checked)
    )
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 7. a VOID also ends the question, balance or no balance ===')
  // -------------------------------------------------------------------------
  {
    // The recognised signature: zeroed, with a PrivateNote beginning "Voided".
    remote.set('9362', {
      ...remote.get('9362'),
      Balance: 0,
      TotalAmt: 0,
      PrivateNote: 'Voided. {"description":"gone"}'
    })
    await sync()
    ok(repo.getInvoice(howard.id).qboVoided === true, 'the void is read', String(repo.getInvoice(howard.id).qboVoided))
    const res = await sync()
    ok(
      res.data.checked === 1,
      'and a voided invoice is not asked about again',
      String(res.data.checked)
    )
  }

  globalThis.fetch = realFetch
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

void run()
