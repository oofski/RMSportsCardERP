/**
 * ONE INVOICE, ONE INVOICE IN QUICKBOOKS.
 *
 * This suite exists for a single failure, and it is the worst one in the app: an
 * invoice posted TWICE to a real company's books. It doubles revenue on the P&L,
 * it asks a buyer for the money twice, and it is undone by hand in QuickBooks —
 * nothing here can take it back.
 *
 * The old code's only guard was `if (invoice.qboId)`, read off a snapshot taken
 * BEFORE the network call. Two overlapping pushes both read that snapshot, both
 * saw no id, and both posted. That is not a theoretical race: the Retry button
 * on the board had no busy state at all, so a double-click did it, and on the web
 * build two browser tabs on the same invoice did it without anybody clicking
 * twice.
 *
 * So this drives the REGISTERED IPC HANDLER — not the repo, not a helper — with
 * a QuickBooks that answers slowly, and counts the POSTs Intuit would have seen.
 * A guard that only works when the network is instant is not a guard, which is
 * why the stub sleeps: a fetch that resolves in the same microtask never lets the
 * second caller reach the claim, and the suite would pass against the broken
 * code.
 *
 * Two separate windows are covered, because they are closed by two different
 * mechanisms and either one alone leaves the bug:
 *
 *   · STILL IN THE AIR — the in-flight set in invoicesIpc. Sections 2 and 3.
 *   · ALREADY LANDED — the atomic claim in db/invoices. Sections 1 and 4.
 *
 * No real credential is in this file. The client id, secret, tokens and realm are
 * invented, the customer is invented, and nothing here reaches the internet:
 * global fetch is replaced for the whole run.
 *
 * Run: npm run test:qbo-duplicate
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/qbo-duplicate-db')
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
// A signed-in owner, and the handlers wired up
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
const handler = (channel: string) => {
  const h = registeredHandlers().get(channel)
  if (!h) throw new Error(`no handler registered for ${channel}`)
  return h
}
const retryPush = (id: string): Promise<any> =>
  Promise.resolve(handler(IPC.invoiceRetryQboPush)({ sender: null }, { id, open: false }))

// ---------------------------------------------------------------------------
// A QuickBooks connection this machine holds, and a QuickBooks that answers
// ---------------------------------------------------------------------------
// The LOCAL holder, on purpose: the relay is not configured in a test build, so
// `chooseQboHolder` picks local and every call goes through the fetch below.
// Nothing here is a real credential.
store.setQboConfig('invented-client-id', 'invented-client-secret', 'production')
store.setQboTokens({
  accessToken: 'invented-access-token',
  refreshToken: 'invented-refresh-token',
  realmId: '4620000000000000001',
  expiresAt: Date.now() + 60 * 60 * 1000,
  refreshExpiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000
})

const BUYER = 'Ana Ruiz'
let invoicePosts = 0
/** Every POST body Intuit would have received, in order. */
const postedPayloads: any[] = []
/** How long the invoice POST takes to answer. Zero would hide the race. */
let postDelayMs = 60
/** Set to a message to make the next POST fail. */
let postFails: string | null = null

const realFetch = globalThis.fetch
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(String(input))
  const path = url.pathname
  const method = String(init.method ?? 'GET').toUpperCase()

  if (path.endsWith('/query')) {
    const sql = url.searchParams.get('query') ?? ''
    if (/from Customer/i.test(sql)) {
      return json({ QueryResponse: { Customer: [{ Id: '58', DisplayName: BUYER }] } })
    }
    if (/from Item/i.test(sql)) {
      return json({
        QueryResponse: { Item: [{ Id: '19', Name: 'Design', FullyQualifiedName: 'Design' }] }
      })
    }
    if (/from Term/i.test(sql)) {
      return json({ QueryResponse: { Term: [{ Id: '3', Name: 'Due on receipt', Active: true }] } })
    }
    if (/from Class/i.test(sql)) {
      return json({ QueryResponse: { Class: [{ Id: '7', Name: 'United States' }] } })
    }
    return json({ QueryResponse: {} })
  }

  if (path.endsWith('/preferences')) {
    return json({ Preferences: { AccountingInfoPrefs: { ClassTrackingPerTxn: true } } })
  }

  if (path.endsWith('/invoice') && method === 'POST') {
    invoicePosts++
    const mine = invoicePosts
    postedPayloads.push(JSON.parse(String(init.body ?? '{}')))
    // SLOWER THAN INSTANT, deliberately. The whole race lives in the gap between
    // the request leaving and the reply arriving; a stub that answers in the same
    // microtask closes that gap and the suite would go green against the bug.
    await new Promise((r) => setTimeout(r, postDelayMs))
    if (postFails) return json({ Fault: { Error: [{ Message: postFails }] } }, 400)
    return json({ Invoice: { Id: `qbo-${mine}`, DocNumber: `900${mine}` } })
  }

  // The PDF attachment. Refused, and that is fine: attachInvoiceDocument turns a
  // failure here into a NOTE and never into a failed post, which is itself the
  // behaviour that stops a retry creating the invoice twice.
  if (path.includes('/upload')) return json({ Fault: {} }, 400)

  return json({}, 404)
}) as typeof fetch

const newInvoice = (over: Record<string, unknown> = {}): any =>
  repo.saveInvoice(
    {
      customerName: BUYER,
      invoiceDate: '2026-08-09',
      lines: [{ item: 'Design', quantity: 1, rate: 60 }],
      ...over
    },
    'emp_owner'
  )

const run = async (): Promise<void> => {
  // -------------------------------------------------------------------------
  console.log('\n=== 1. the claim is atomic, and it is the only thing that is ===')
  // -------------------------------------------------------------------------
  // Read this section against the code it replaced: an unconditional UPDATE that
  // always "succeeded". Every assertion below was true of that version too,
  // EXCEPT that it never once said no.
  {
    const inv = newInvoice()
    ok(repo.claimPushSlot(inv.id) === true, 'a fresh invoice can be claimed')
    const claimed = repo.getInvoice(inv.id)
    ok(claimed.qboPushState === 'pending', 'the claim stamps pending BEFORE any call')
    ok(claimed.qboPushAttempts === 1, 'and counts the attempt', String(claimed.qboPushAttempts))

    // Still claimable while pending — and that is deliberate, not an oversight.
    // 'pending' survives a process killed mid-flight, and refusing it here would
    // make a crashed push unretryable for ever.
    ok(
      repo.claimPushSlot(inv.id) === true,
      'a row left pending by a crash can still be retried later'
    )

    repo.markPosted(inv.id, { id: 'qbo-manual', docNumber: '8000' })
    ok(
      repo.claimPushSlot(inv.id) === false,
      'AN INVOICE ALREADY IN QUICKBOOKS CANNOT BE CLAIMED — this is the duplicate guard'
    )
    const after = repo.getInvoice(inv.id)
    ok(after.qboId === 'qbo-manual', 'and the refused claim did not disturb the id')
    ok(after.qboPushState === 'ok', 'nor the push state')
    ok(after.qboPushAttempts === 2, 'nor the attempt count', String(after.qboPushAttempts))
  }
  {
    const voided = newInvoice()
    repo.setInvoiceStatus(voided.id, 'void', 'emp_owner')
    ok(repo.claimPushSlot(voided.id) === false, 'a void invoice cannot be claimed')
    ok(repo.claimPushSlot('no-such-invoice') === false, 'and neither can one that is gone')
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 2. two pushes at once post ONCE ===')
  // -------------------------------------------------------------------------
  // The real thing: the registered IPC handler, called twice, exactly as a
  // double-clicked Retry or a second browser tab calls it.
  {
    const inv = newInvoice()
    invoicePosts = 0
    postedPayloads.length = 0

    const [a, b] = await Promise.all([retryPush(inv.id), retryPush(inv.id)])

    ok(invoicePosts === 1, 'QUICKBOOKS WAS ASKED TO CREATE THE INVOICE ONCE', String(invoicePosts))
    const results = [a, b]
    const won = results.filter((r) => r.ok && r.data?.pushed)
    const lost = results.filter((r) => !(r.ok && r.data?.pushed))
    ok(won.length === 1, 'exactly one caller reports a push', String(won.length))
    ok(lost.length === 1, 'and exactly one is turned away', String(lost.length))
    ok(
      /already on its way|already in QuickBooks/i.test(String(lost[0]?.data?.error ?? lost[0]?.error)),
      'with a sentence that says why',
      String(lost[0]?.data?.error ?? lost[0]?.error)
    )
    ok(lost[0]?.data?.pushed === false, 'and does NOT claim to have pushed')

    const saved = repo.getInvoice(inv.id)
    ok(saved.qboId === 'qbo-1', 'the stored id is the one the single POST returned', saved.qboId)
    ok(saved.qboPushState === 'ok', 'and the row reads posted')
    ok(saved.status === 'created', 'and the invoice has left draft')
    ok(postedPayloads.length === 1, 'and one payload crossed the wire', String(postedPayloads.length))
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 3. the guard is per invoice, not a queue ===')
  // -------------------------------------------------------------------------
  // A global mutex would also make section 2 pass, and would be wrong: two
  // operators billing two different buyers must not wait behind each other.
  {
    const one = newInvoice({ invoiceDate: '2026-08-10' })
    const two = newInvoice({ invoiceDate: '2026-08-11' })
    invoicePosts = 0

    const [a, b] = await Promise.all([retryPush(one.id), retryPush(two.id)])

    ok(invoicePosts === 2, 'two different invoices post twice', String(invoicePosts))
    ok(a.ok && a.data?.pushed === true, 'the first went')
    ok(b.ok && b.data?.pushed === true, 'and so did the second')
    ok(
      repo.getInvoice(one.id).qboId !== repo.getInvoice(two.id).qboId,
      'and they carry different QuickBooks ids'
    )
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 4. a settled invoice is refused without a call ===')
  // -------------------------------------------------------------------------
  // The stale-board case. Somebody left the page open, the invoice posted from
  // another machine, and they press Retry. No POST may leave.
  {
    const inv = newInvoice()
    const first = await retryPush(inv.id)
    ok(first.data?.pushed === true, 'it posts the first time')

    invoicePosts = 0
    const again = await retryPush(inv.id)
    ok(invoicePosts === 0, 'a second press sends NOTHING to QuickBooks', String(invoicePosts))
    ok(again.data?.pushed === false, 'and reports no push')
    ok(
      /already in QuickBooks/i.test(String(again.data?.error)),
      'saying it is already there',
      String(again.data?.error)
    )
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 5. a FAILED push releases the slot ===')
  // -------------------------------------------------------------------------
  // The guard must not become a lock that a refusal leaves shut. An invoice
  // QuickBooks rejected is exactly the one somebody retries a minute later.
  {
    const inv = newInvoice()
    postFails = 'Business Validation Error: invented refusal'
    invoicePosts = 0
    const refused = await retryPush(inv.id)
    ok(refused.data?.pushed === false, 'a refusal comes back as no push')
    const failedRow = repo.getInvoice(inv.id)
    ok(failedRow.qboPushState === 'failed', 'and the row records the failure')
    ok(failedRow.qboId === null, 'with no QuickBooks id')
    ok(
      repo.listInvoicesNeedingPush().some((i: any) => i.id === inv.id),
      'and it is offered for retry'
    )

    postFails = null
    const retried = await retryPush(inv.id)
    ok(retried.data?.pushed === true, 'AND THE RETRY GOES THROUGH — the slot was released')
    ok(invoicePosts === 2, 'having reached QuickBooks twice in total', String(invoicePosts))
    ok(repo.getInvoice(inv.id).qboPushError === null, 'and the failure text is cleared')
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 6. four at once is still one ===')
  // -------------------------------------------------------------------------
  // Two callers is the case that happens; four is the case that proves the guard
  // is a claim and not luck about the ordering of two promises.
  {
    const inv = newInvoice()
    invoicePosts = 0
    const results = await Promise.all([
      retryPush(inv.id),
      retryPush(inv.id),
      retryPush(inv.id),
      retryPush(inv.id)
    ])
    ok(invoicePosts === 1, 'four simultaneous pushes create ONE invoice', String(invoicePosts))
    ok(
      results.filter((r) => r.data?.pushed).length === 1,
      'and exactly one of the four says so',
      String(results.filter((r) => r.data?.pushed).length)
    )
    ok(
      results.filter((r) => !r.data?.pushed).every((r) => typeof r.data?.error === 'string'),
      'the other three each carry a reason'
    )
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 7. the board no longer leaves Retry live ===')
  // -------------------------------------------------------------------------
  // The main process refuses the duplicate now, which is the guard that matters.
  // The button is still worth pinning: it is the thing that produced the second
  // call in the first place, and it was the ONE action on that card with no busy
  // state. Read as source rather than rendered, because there is no DOM here.
  {
    const board = require('node:fs').readFileSync(
      join(process.cwd(), 'src/renderer/src/modules/invoices/InvoicesBoard.tsx'),
      'utf8'
    )
    const retry = board.slice(board.indexOf('onRetryPush={async'))
    const body = retry.slice(0, retry.indexOf('onDelete='))
    ok(/if \(busy\) return/.test(body), 'a retry while another action is running is dropped')
    ok(/setBusy\(inv\.id\)/.test(body), 'and the card goes busy for the length of the push')
    ok(/finally\s*\{[\s\S]*setBusy\(null\)/.test(body), 'and is released in a finally')
  }
}

run()
  .catch((err) => {
    fail++
    console.error('\nUNCAUGHT', err)
  })
  .finally(() => {
    globalThis.fetch = realFetch
    db.close?.()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
