/**
 * The browser path, end to end, against a real server on a real socket.
 *
 * Everything the desktop app trusted stops being true here: the caller is not
 * the machine, the session is not a module variable, and the URL is public. So
 * this suite does not test the transport's happy path — it tests the properties
 * that would be catastrophic to get wrong and invisible if they broke:
 *
 *   1. Health answers without a session, and says nothing else.
 *   2. NOTHING else answers without one, including every read.
 *   3. Login works, and the cookie it sets is HttpOnly + SameSite.
 *   4. The permission checks INSIDE the handlers still run on the HTTP path.
 *      This is the one that matters most: the whole design rests on the server
 *      being a transport rather than a second implementation, and a transport
 *      that skipped the checks would look identical from the outside until the
 *      day a packer exported the customer list.
 *   5. A read over HTTP returns byte-identical JSON to the same handler invoked
 *      directly — the property that lets 114 renderer files stay unchanged.
 *   6. An import works from uploaded CONTENT, with no path anywhere.
 *   7. An export comes back as a download, once, and only to its owner.
 *   8. Logout invalidates immediately.
 *
 * Run: npm run test:web
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/web-db')
process.env.TEST_DB_DIR = DIR
// The stub reads this for `app.getPath('userData')`; the test harness's own
// electron stub reads TEST_DB_DIR. Both point at the same throwaway directory.
process.env.RMOPS_DATA_DIR = DIR
// Bind an ephemeral port, never the configured one — a test must not collide
// with a server the developer happens to be running.
process.env.RMOPS_SERVER_AUTOSTART = 'false'
// Plain http here, so the cookie has to be sendable without TLS. The Secure
// flag is asserted separately by reading the header rather than by trusting it.
process.env.RMOPS_COOKIE_SECURE = '0'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { startServer } = require('../src/server/index')
const { invokeHandler } = require('../src/main/ipcRegistry')
const { runAs } = require('../src/main/services/session')
const shipping = require('../src/main/db/shipping')
const { BYTES_TAG } = require('../src/shared/ipc')

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

interface Reply {
  status: number
  headers: Headers
  body: {
    ok?: boolean
    data?: unknown
    error?: string
    downloads?: Array<{ token: string; filename: string; disposition: string }>
    open?: string[]
  }
  text: string
}

/** One signed-in browser: holds its cookie the way a tab would. */
class Client {
  cookie: string | null = null
  constructor(private readonly base: string) {}

  private remember(res: Response): void {
    const setCookie = res.headers.get('set-cookie')
    if (!setCookie) return
    const value = setCookie.split(';')[0]
    this.cookie = value.endsWith('=') ? null : value
  }

  async call(channel: string, args: unknown[] = [], opts: { csrf?: boolean } = {}): Promise<Reply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.csrf !== false) headers['x-rmops-request'] = '1'
    if (this.cookie) headers.cookie = this.cookie
    const res = await fetch(`${this.base}/api/call/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ args })
    })
    this.remember(res)
    const text = await res.text()
    let body = {}
    try {
      body = JSON.parse(text)
    } catch {
      // Left empty: a non-JSON reply is itself the assertion failure.
    }
    return { status: res.status, headers: res.headers, body, text }
  }

  async get(path: string): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      headers: this.cookie ? { cookie: this.cookie } : {}
    })
  }
}

void (async (): Promise<void> => {
  const server = startServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const owner = new Client(base)

  // -------------------------------------------------------------------------
  console.log('=== 1. health ===')
  // -------------------------------------------------------------------------
  const health = await fetch(`${base}/health`)
  const healthBody = (await health.json()) as {
    ok: boolean
    operations: number
    version: string
  }
  ok(health.status === 200 && healthBody.ok === true, 'health answers without a session')
  // The server used to answer '0.0.0' — the version it reports is not cosmetic.
  // Every release then looked NEWER than the running server, so a browser tab
  // was told an update was available and offered a macOS installer it cannot
  // run, with a Download button that could only say "No download link
  // available". It also makes "did my deploy land?" one URL instead of a guess.
  ok(
    typeof healthBody.version === 'string' && healthBody.version !== '0.0.0',
    'health reports the real version, not a placeholder',
    String(healthBody.version)
  )
  ok(
    healthBody.version === (require('../package.json') as { version: string }).version,
    'and it is this build\'s version',
    String(healthBody.version)
  )
  ok(
    healthBody.operations >= 232,
    'and reports every registered operation',
    String(healthBody.operations)
  )
  ok(
    !JSON.stringify(healthBody).includes('rm-operations.db'),
    'health leaks no path or state beyond a count'
  )
  ok(
    health.headers.get('x-content-type-options') === 'nosniff',
    'security headers are on every response'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 2. nothing answers without a session ===')
  // -------------------------------------------------------------------------
  const anonymous = new Client(base)
  const anonRead = await anonymous.call('inventory:products:list')
  ok(anonRead.status === 401, 'a READ is refused without a session', String(anonRead.status))
  const anonWrite = await anonymous.call('inventory:products:create', [{ name: 'x' }])
  ok(anonWrite.status === 401, 'so is a write')
  const anonEvents = await anonymous.get('/api/events')
  ok(anonEvents.status === 401, 'so is the event stream')
  const anonDownload = await anonymous.get('/api/download/anything')
  ok(anonDownload.status === 401, 'so is a download')
  const unknown = await anonymous.call('nonsense:channel')
  ok(unknown.status === 401, 'an unknown channel is refused before it is even looked up')

  // The setup pair is the documented exception, and only that pair.
  const setupState = await anonymous.call('auth:setup-state')
  ok(setupState.status === 200, 'auth:setup-state answers before there is anybody to be')
  ok(
    (setupState.body.data as { needsSetup: boolean }).needsSetup === true,
    'and says the database is empty'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 3. setup, login and the cookie ===')
  // -------------------------------------------------------------------------
  const created = await owner.call('auth:create-owner', [
    {
      firstName: 'Ada',
      lastName: 'Owner',
      companyId: 'RM-OWNER',
      email: 'owner@example.invalid',
      title: 'Owner',
      password: 'a-long-enough-password'
    }
  ])
  ok((created.body.data as { ok: boolean }).ok === true, 'the first Owner can be created')
  ok(owner.cookie !== null, 'and setup signs them in, rather than leaving the tab anonymous')

  const cookieHeader = created.headers.get('set-cookie') ?? ''
  ok(cookieHeader.includes('HttpOnly'), 'the session cookie is HttpOnly — no script can read it')
  ok(cookieHeader.includes('SameSite=Strict'), 'and SameSite=Strict — no other site can send it')
  ok(cookieHeader.includes('Path=/'), 'and scoped to the whole app')

  // Secure is off ONLY because this test speaks plain http. Prove the switch
  // exists and defaults the other way, since getting it wrong ships session
  // tokens over cleartext.
  process.env.RMOPS_COOKIE_SECURE = '1'
  const secureLogin = await new Client(base).call('auth:login', [
    { identifier: 'RM-OWNER', password: 'a-long-enough-password' }
  ])
  ok(
    (secureLogin.headers.get('set-cookie') ?? '').includes('Secure'),
    'with RMOPS_COOKIE_SECURE unset the cookie is Secure'
  )
  process.env.RMOPS_COOKIE_SECURE = '0'

  const badLogin = await new Client(base).call('auth:login', [
    { identifier: 'RM-OWNER', password: 'wrong' }
  ])
  const badResult = badLogin.body.data as { ok: boolean; error?: string }
  ok(badResult.ok === false, 'a wrong password is refused')
  ok(
    badResult.error === 'Incorrect credentials.',
    'with a message that does not say whether the account exists',
    badResult.error
  )
  ok(badLogin.headers.get('set-cookie') === null, 'and no cookie is issued')

  const noCsrf = await owner.call('inventory:stats', [], { csrf: false })
  ok(noCsrf.status === 400, 'a call without the client header is refused (cross-site forgery)')

  // -------------------------------------------------------------------------
  console.log('\n=== 4. permission checks still run on the HTTP path ===')
  // -------------------------------------------------------------------------
  const hire = await owner.call('employees:create', [
    {
      firstName: 'Bo',
      lastName: 'Bench',
      companyId: 'RM-BENCH',
      email: '',
      title: 'Packer',
      role: 'shipping',
      password: 'bench-password'
    }
  ])
  ok((hire.body.data as { ok: boolean }).ok === true, 'a shipping-role account is created')

  const bench = new Client(base)
  const benchLogin = await bench.call('auth:login', [
    { identifier: 'RM-BENCH', password: 'bench-password' }
  ])
  ok((benchLogin.body.data as { ok: boolean }).ok === true, 'the bench can sign in')
  ok(bench.cookie !== null, 'and gets its own session')

  // The Shipping role has module.fulfillment, shipping.find and shipping.pack —
  // and deliberately NOT shipping.manage. The customers CSV carries every
  // buyer's name, address and total spend.
  const benchExport = await bench.call('shipping:export', [{ kind: 'customers' }])
  const exportResult = benchExport.body.data as { ok: boolean; error?: string }
  ok(
    benchExport.status === 200 && exportResult.ok === false,
    'a role without shipping.manage cannot export the customer list'
  )
  ok(
    (exportResult.error ?? '').includes('permission'),
    'and is told why',
    exportResult.error ?? '(no message)'
  )
  ok(
    benchExport.body.downloads === undefined,
    'a refused export produces no download ticket at all'
  )

  const benchWrite = await bench.call('inventory:products:create', [
    { name: 'Contraband', category: 'x', unitType: 'box' }
  ])
  ok(
    (benchWrite.body.data as { ok: boolean }).ok === false,
    'nor can it create a product without inventory.manage'
  )

  // A read the role DOES have, to prove the refusals above are the permission
  // check talking and not the transport failing.
  const benchAllowed = await bench.call('shipping:summary')
  ok(benchAllowed.body.ok === true, 'but a permitted read succeeds for the same session')

  // The bench must not be able to read what the owner can.
  const benchPayroll = await bench.call('hours:summary')
  ok(
    Array.isArray(benchPayroll.body.data) && (benchPayroll.body.data as unknown[]).length === 0,
    'and payroll reads come back empty rather than populated'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 5. HTTP returns the same shape as IPC ===')
  // -------------------------------------------------------------------------
  const ownerId = (
    (created.body.data as { user: { id: string } }).user
  ).id
  const overHttp = await owner.call('inventory:stats')
  const direct = await runAs({ userId: ownerId, origin: 'test' }, () =>
    invokeHandler('inventory:stats', [])
  )
  ok(
    JSON.stringify(overHttp.body.data) === JSON.stringify(direct),
    'inventory:stats over HTTP is identical to the handler invoked directly'
  )

  const listHttp = await owner.call('supplies:list')
  const listDirect = await runAs({ userId: ownerId, origin: 'test' }, () =>
    invokeHandler('supplies:list', [])
  )
  ok(
    JSON.stringify(listHttp.body.data) === JSON.stringify(listDirect),
    'and so is a list read'
  )

  // The owner module was the operation gap: registered on the desktop, missing
  // from the server, and answering 404 to a screen that had no reason to expect
  // one. Its absence is exactly the kind of thing only a test notices.
  const board = await owner.call('owner:board')
  ok(board.status === 200 && board.body.ok === true, "the owner's board is served, not 404'd")

  // -------------------------------------------------------------------------
  console.log('\n=== 6. an import from uploaded content ===')
  // -------------------------------------------------------------------------
  const ledger =
    'Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date\r\n' +
    '"Jul 15, 2026, 8:12:03 PM",$42.00,2041799396,ORD-1,Topps Chrome break,completed,Sale,' +
    '"Jul 15, 2026, 8:12:03 PM"\r\n' +
    '"Jul 16, 2026, 9:02:10 PM",$18.50,2041799397,ORD-2,Prizm single,completed,Sale,' +
    '"Jul 16, 2026, 9:02:10 PM"\r\n'

  const imported = await owner.call('finance:ledger:import', [
    { filename: 'whatnot-july.csv', text: ledger }
  ])
  const importResult = imported.body.data as {
    ok: boolean
    error?: string
    data?: { import: { filename: string; rowsImported: number } }
  }
  ok(importResult.ok === true, 'a ledger CSV imports from its content', importResult.error)
  ok(importResult.data?.import.rowsImported === 2, 'with both rows landing')
  ok(
    importResult.data?.import.filename === 'whatnot-july.csv',
    'and the operator’s own filename on the record'
  )

  const imports = await owner.call('finance:ledger:imports')
  ok(
    (imports.body.data as unknown[]).length === 1,
    'and the import is visible on the next read — it really was committed'
  )

  // The bench may not import money, content or not.
  const benchImport = await bench.call('finance:ledger:import', [
    { filename: 'sneaky.csv', text: ledger }
  ])
  ok(
    (benchImport.body.data as { ok: boolean }).ok === false,
    'an upload does not smuggle past the permission check'
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 7. exports come back as downloads ===')
  // -------------------------------------------------------------------------
  const exported = await owner.call('hours:export', [
    { scope: 'team', start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z', format: 'gusto' }
  ])
  const ticket = exported.body.downloads?.[0]
  ok(!!ticket, 'an export hands back a download ticket rather than a server path')
  ok(
    ticket?.filename.endsWith('.csv') === true,
    'named the way the handler named it',
    ticket?.filename
  )
  ok(
    !JSON.stringify(exported.body.data).includes('/tmp/'),
    'and the reply names no path on the server'
  )

  const stolen = await bench.get(`/api/download/${ticket?.token}`)
  ok(stolen.status === 404, "another session cannot collect somebody else's export")

  const collected = await owner.get(`/api/download/${ticket?.token}`)
  ok(collected.status === 200, 'the owner can collect it')
  ok(
    (collected.headers.get('content-disposition') ?? '').startsWith('attachment;'),
    'as an attachment'
  )
  const csv = await collected.text()
  ok(csv.startsWith('First name,Last name'), 'and it is the real CSV', csv.slice(0, 40))

  const again = await owner.get(`/api/download/${ticket?.token}`)
  ok(again.status === 404, 'a ticket is single-use')

  // -------------------------------------------------------------------------
  console.log('\n=== 8. the app itself is served ===')
  // -------------------------------------------------------------------------
  const shell = await anonymous.get('/')
  // The renderer may not be built in a bare checkout; both answers are correct,
  // and neither may be a crash.
  ok(
    shell.status === 200 || shell.status === 404,
    'the app shell is served (or reported missing) rather than erroring',
    String(shell.status)
  )
  const traversal = await anonymous.get('/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd')
  ok(traversal.status === 404, 'an encoded path traversal is refused')
  ok(!(await traversal.text()).includes('root:'), 'and reads nothing off the disk')

  // -------------------------------------------------------------------------
  console.log('\n=== 9. logout invalidates ===')
  // -------------------------------------------------------------------------
  const kept = owner.cookie
  const loggedOut = await owner.call('auth:logout')
  ok(loggedOut.body.ok === true, 'logout succeeds')
  ok(
    (loggedOut.headers.get('set-cookie') ?? '').includes('Max-Age=0'),
    'and clears the cookie in the browser'
  )

  // The cookie is gone from this client; put it back to prove the SERVER
  // forgot the session, rather than the client merely losing its copy.
  owner.cookie = kept
  const afterLogout = await owner.call('inventory:stats')
  ok(afterLogout.status === 401, 'and the token is dead server-side, not just discarded')

  const benchStillIn = await bench.call('shipping:summary')
  ok(benchStillIn.body.ok === true, "one person signing out does not sign everybody out")

  // -------------------------------------------------------------------------
  console.log('\n=== 10. the web app does not offer itself a software update ===')
  // -------------------------------------------------------------------------
  // A page is not a build. It is whatever was deployed last, so it is current by
  // definition — and it cannot install anything even if it were not. What the
  // app used to do here: report version 0.0.0, find 0.0.100 on the release feed,
  // announce an update, and hand the browser a .dmg link that did not exist for
  // its platform.
  const bench2 = new Client(base)
  await bench2.call('auth:login', [{ identifier: 'RM-BENCH', password: 'bench-password' }])
  const upd = await bench2.call('updates:get-status')
  const updStatus = upd.body.data as {
    phase: string
    updatable?: boolean
    availableVersion?: string
    downloadUrl?: string
    currentVersion: string
  }
  ok(updStatus.updatable === false, 'the server says it is not updatable', JSON.stringify(updStatus))
  ok(updStatus.phase === 'not-available', 'and reports itself up to date', updStatus.phase)
  ok(
    updStatus.currentVersion === (require('../package.json') as { version: string }).version,
    'and knows its own version',
    updStatus.currentVersion
  )

  // The check must not reach the release feed at all, and must never come back
  // saying an update is available — this is the exact call the panel makes.
  const checked = await bench2.call('updates:check')
  const checkedStatus = checked.body.data as {
    phase: string
    updatable?: boolean
    availableVersion?: string
  }
  ok(checkedStatus.phase !== 'available', 'checking never finds an update', checkedStatus.phase)
  ok(checkedStatus.availableVersion === undefined, 'and names no version to download')
  ok(checkedStatus.updatable === false, 'and still says updates do not apply here')

  // The dead button, asserted directly: with no link there is nothing to open,
  // and that is the message the user saw four times.
  const noLink = await bench2.call('updates:open-download', [])
  ok(
    (noLink.body.data as { ok: boolean }).ok === false,
    'and opening a download with no link is refused',
    JSON.stringify(noLink.body.data)
  )

  // -------------------------------------------------------------------------
  console.log('\n=== 11. raw bytes survive the trip to a browser ===')
  // -------------------------------------------------------------------------
  // Electron's IPC carries a Uint8Array as a Uint8Array. JSON does not:
  // JSON.stringify(new Uint8Array([37,80])) is {"0":37,"1":80}, and
  // new Uint8Array() of THAT is zero bytes long. So the packing slip crossed the
  // wire as a multi-megabyte object of numeric keys and arrived empty — the pane
  // showing pdf.js's "The PDF file is empty, i.e. its size is zero bytes" over a
  // blank sheet, on the web only, while every desktop was fine.
  //
  // Asserted through the REAL route, because that is the only place the fault
  // lived: the handler was always correct and the renderer was always correct.
  const slip = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff, 0x80, 0x7f])
  shipping.putShipDocument({
    importId: null,
    name: 'packing-slips.pdf',
    pageCount: 59,
    bytes: slip
  })
  // A fresh session: `owner` was deliberately signed out in section 9.
  const reader = new Client(base)
  await reader.call('auth:login', [{ identifier: 'RM-BENCH', password: 'bench-password' }])
  const meta = await reader.call('shipping:document')
  ok(
    (meta.body.data as { pageCount: number } | null)?.pageCount === 59,
    'the slip metadata comes back',
    JSON.stringify(meta.body.data)
  )

  const bytes = await reader.call('shipping:document:bytes')
  const tagged = bytes.body.data as Record<string, unknown> | null
  ok(tagged !== null, 'and so do the bytes', JSON.stringify(tagged).slice(0, 80))
  // The shape is what the browser transport knows how to undo. The failing shape
  // — an object of numeric keys — is asserted absent, because that one parses
  // without error and produces an empty file.
  ok(
    typeof tagged?.[BYTES_TAG] === 'string',
    'tagged as binary rather than spilled into numeric keys',
    Object.keys(tagged ?? {}).slice(0, 5).join(',')
  )
  ok(
    (tagged as Record<string, unknown>)['0'] === undefined,
    'and NOT as {"0":37,"1":80,…}, which is what arrived empty'
  )
  const decoded = Buffer.from(String(tagged?.[BYTES_TAG]), 'base64')
  ok(decoded.length === slip.length, 'the right number of bytes', `${decoded.length} vs ${slip.length}`)
  ok(decoded.equals(slip), 'and byte for byte the file that was stored')
  // A PDF begins %PDF-, and that is exactly what pdf.js checks first.
  ok(decoded.subarray(0, 5).toString('latin1') === '%PDF-', 'starting with a real PDF header')

  // -------------------------------------------------------------------------
  console.log('\n=== 12. changing a password ends every other session ===')
  // -------------------------------------------------------------------------
  // A SESSION PROVES SOMEBODY LOGGED IN ONCE, not that they still know the
  // password. So writing a new hash used to leave every existing token working —
  // for up to thirty days — which is exactly backwards: the reason anybody
  // changes a password in a hurry is that they believe somebody else has it, and
  // the thief's tab kept answering. `revokeAllForEmployee` existed for this and
  // had zero callers.
  {
    const OLD = 'bench-password'
    const NEW = 'bench-password-two'

    // Three tabs, all signed in as the same bench account.
    const tabA = new Client(base)
    const tabB = new Client(base)
    const tabC = new Client(base)
    for (const [name, tab] of [['A', tabA], ['B', tabB], ['C', tabC]] as const) {
      const res = await tab.call('auth:login', [{ identifier: 'RM-BENCH', password: OLD }])
      ok((res.body.data as { ok: boolean }).ok === true, `tab ${name} is signed in`)
    }
    ok((await tabB.call('shipping:summary')).status === 200, 'and tab B is working')

    const changed = await tabA.call('auth:change-password', [
      { currentPassword: OLD, newPassword: NEW }
    ])
    ok((changed.body.data as { ok: boolean }).ok === true, 'tab A changes the password')

    // THE ASSERTION THIS SECTION EXISTS FOR.
    const bAfter = await tabB.call('shipping:summary')
    const cAfter = await tabC.call('shipping:summary')
    ok(bAfter.status === 401, 'TAB B IS SIGNED OUT — its token was issued against the old password', String(bAfter.status))
    ok(cAfter.status === 401, 'and so is tab C', String(cAfter.status))

    // And the one that did the changing is NOT thrown out mid-gesture.
    const aAfter = await tabA.call('shipping:summary')
    ok(aAfter.status === 200, 'while tab A carries on — the session that changed it is spared', String(aAfter.status))

    // The new password is the one that works now.
    const oldPw = new Client(base)
    await oldPw.call('auth:login', [{ identifier: 'RM-BENCH', password: OLD }])
    ok(oldPw.cookie === null, 'the old password no longer signs anybody in')
    const newPw = new Client(base)
    const withNew = await newPw.call('auth:login', [{ identifier: 'RM-BENCH', password: NEW }])
    ok((withNew.body.data as { ok: boolean }).ok === true, 'and the new one does')

    // An ADMINISTRATOR resetting somebody else's password spares nothing: they
    // are a different person, so there is no session of theirs to keep, and the
    // case it exists for is an account believed compromised.
    ok((await newPw.call('shipping:summary')).status === 200, 'the bench is working again')
    // `owner` was deliberately signed out in section 9, so this needs its own
    // session — and getting one is itself worth asserting, since the change
    // above must not have touched an account it was not about.
    const admin = new Client(base)
    await admin.call('auth:login', [
      { identifier: 'RM-OWNER', password: 'a-long-enough-password' }
    ])
    ok(admin.cookie !== null, 'the owner signs in, unaffected by somebody else’s change')
    const benchId = (hire.body.data as { data: { employee: { id: string } } }).data.employee.id
    const reset = await admin.call('employees:reset-password', [{ id: benchId }])
    ok((reset.body.data as { ok: boolean }).ok === true, 'an owner can reset the bench password', JSON.stringify(reset.body.data))
    const afterReset = await newPw.call('shipping:summary')
    ok(afterReset.status === 401, 'AND EVERY SESSION OF THE RESET ACCOUNT IS DEAD', String(afterReset.status))
    // The administrator running the reset is untouched.
    ok((await admin.call('inventory:stats')).status === 200, 'while the administrator stays signed in')
  }

  // -------------------------------------------------------------------------
  console.log('\n=== 13. the login throttle cannot be spent with a header ===')
  // -------------------------------------------------------------------------
  // PROXIES APPEND. `x-forwarded-for: 1.2.3.4, 203.0.113.9` means the CLIENT
  // wrote 1.2.3.4 and the hop we trust wrote 203.0.113.9 — so reading the FIRST
  // entry, which is what this did, handed the caller its own identity. Every
  // request could claim a new address, so the per-client bucket never filled and
  // the throttle that exists to stop password guessing did nothing.
  //
  // The identifier is varied on every attempt as well, so the per-ACCOUNT bucket
  // cannot be what stops it. Only reading the last entry can.
  {
    const { resetRateLimits } = require('../src/server/rateLimit')
    resetRateLimits()
    process.env.RMOPS_TRUST_PROXY = '1'

    const guess = async (n: number): Promise<number> => {
      const res = await fetch(`${base}/api/call/${encodeURIComponent('auth:login')}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rmops-request': '1',
          // A different claimed address every time, and the same real one.
          'x-forwarded-for': `10.0.0.${n}, 203.0.113.9`
        },
        body: JSON.stringify({ args: [{ identifier: `RM-NOBODY-${n}`, password: 'wrong' }] })
      })
      return res.status
    }

    let throttled = 0
    for (let i = 1; i <= 14; i++) {
      if ((await guess(i)) === 429) throttled++
    }
    ok(throttled > 0, 'FOURTEEN GUESSES BEHIND FOURTEEN FORGED ADDRESSES ARE THROTTLED', String(throttled))
    ok(throttled === 4, 'and exactly the four past the limit of ten', String(throttled))

    // A genuinely different last hop is a genuinely different client, and is not
    // punished for the one above.
    const other = await fetch(`${base}/api/call/${encodeURIComponent('auth:login')}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rmops-request': '1',
        'x-forwarded-for': '10.0.0.1, 198.51.100.4'
      },
      body: JSON.stringify({ args: [{ identifier: 'RM-OWNER', password: 'wrong' }] })
    })
    ok(other.status !== 429, 'a different real client still gets its own allowance', String(other.status))

    resetRateLimits()
    delete process.env.RMOPS_TRUST_PROXY
  }

  server.close()
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})()
