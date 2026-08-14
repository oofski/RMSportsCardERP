/**
 * My account: the two things everybody has to be able to do for themselves, and
 * the privacy line that opening them up must not cross.
 *
 * ## The bug this feature exists to fix
 *
 * Registering a phone was gated on `notifications.clock`, a permission only
 * owners and operations hold. So staff, the packing bench and breakers could
 * not turn notifications on AT ALL — not "could not see punches", could not
 * receive anything. Messaging shipped into a floor that was structurally
 * unreachable: every notify call found zero subscriptions for exactly the people
 * it was built to reach.
 *
 * ## The line that must not move while fixing it
 *
 * The clock feed fans out to EVERY subscription but the puncher's. So simply
 * dropping the gate would have handed a live account of when named colleagues
 * start and finish work to the entire company — which is the thing
 * `notifications.clock` was protecting in the first place.
 *
 * The split: enrolment is open to anybody signed in, and the permission moves
 * onto the subscription row as `clock_ok`, which the clock query filters on.
 * Section 3 is that assertion at the relay, and section 4 is the half that would
 * be a firing offence — a message must still reach a packer, because messages
 * are addressed to explicit employee ids and must never consult that column.
 *
 * Every name here is invented.
 *
 * Run: npm run test:account
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/account-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const auth = require('../src/main/services/auth')
const { registerPushIpc } = require('../src/main/pushIpc')
const { registeredHandlers } = require('../src/main/ipcRegistry')
const { IPC } = require('../src/shared/ipc')
const { permissionsForRole, roleHas, ROLES } = require('../src/shared/permissions')
const { MODULES, getModule } = require('../src/shared/modules')
const worker = require('../cloud/worker.js')
const { syncStateSet } = require('../src/main/db/sync')
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

const PASSWORD = 'a-long-enough-password'
const hire = (first: string, companyId: string, role: string): string => {
  const res = employees.insertEmployee(
    {
      firstName: first,
      lastName: 'Invented',
      companyId,
      title: role === 'owner' ? 'Owner' : 'Packer',
      email: role === 'owner' ? `${companyId.toLowerCase()}@example.invalid` : '',
      role,
      status: 'active'
    },
    null,
    PASSWORD,
    false
  )
  return res.employee.id
}

const OWNER = hire('Owen', 'RM-001', 'owner')
const PACKER = hire('Ada', 'RM-100', 'shipping')
const STAFFER = hire('Cai', 'RM-300', 'staff')

registerPushIpc()
const handler = (channel: string): any => {
  const h = registeredHandlers().get(channel)
  if (!h) throw new Error(`no handler for ${channel}`)
  return h
}
const call = (channel: string, ...args: unknown[]): any =>
  handler(channel)({ sender: null }, ...args)
const signInWith = (companyId: string, password: string): void => {
  const res = auth.login(companyId, password)
  if (!res.ok) throw new Error(`could not sign in ${companyId}: ${res.error}`)
}
const signIn = (companyId: string): void => signInWith(companyId, PASSWORD)

/**
 * A D1 stand-in that records every statement and answers PRAGMA.
 *
 * The point is not to emulate SQLite — it is to see the SQL the Worker actually
 * builds. The clock filter is one clause in one string, and a fake that executed
 * it would prove less than one that shows it was written.
 */
function fakeDb(columns: string[]): { env: any; sql: string[]; ran: string[]; args: unknown[][] } {
  const sql: string[] = []
  const ran: string[] = []
  const args: unknown[][] = []
  const prepare = (text: string): any => {
    sql.push(text)
    let bound: unknown[] = []
    const stmt: any = {
      bind: (...a: unknown[]) => {
        bound = a
        args.push(a)
        return stmt
      },
      all: async () => {
        if (text.includes('PRAGMA table_info')) {
          return { results: columns.map((name) => ({ name })) }
        }
        return { results: [] }
      },
      run: async () => {
        ran.push(text)
        return { success: true, meta: { bound } }
      }
    }
    return stmt
  }
  return {
    env: { DB: { prepare, batch: async (list: unknown[]) => list.map(() => ({ success: true })) } },
    sql,
    ran,
    args
  }
}

const run = async (): Promise<void> => {
  // ---------------------------------------------------------------------------
  console.log('=== 1. the module everybody can open ===')
  // ---------------------------------------------------------------------------
  const account = getModule('account')
  ok(!!account, 'there is an account module')
  ok(account.permission === null, 'AND IT HAS NO PERMISSION ON IT', String(account?.permission))
  ok(account.workspace === 'both', 'in both workspaces', String(account?.workspace))
  ok(account.status === 'active', 'and it is a real screen, not a placeholder')

  // The whole point, stated per role rather than in the abstract: there is no
  // role in the file that this module is hidden from.
  for (const r of ROLES) {
    const visible = account.permission === null || roleHas(r.id, account.permission)
    ok(visible, `${r.id} can open their own account`)
  }

  // The ungated set, pinned. These three are exactly the modules that are about
  // the PERSON rather than the business — what you are owed, when you are on,
  // and your own password — and being about the person is precisely why there is
  // nothing to gate. A fourth name appearing here is a permission somebody
  // removed, so this asserts the whole set rather than just the new member.
  const ungated = MODULES.filter((m: any) => m.permission === null)
    .map((m: any) => m.id)
    .sort()
  ok(
    ungated.join(',') === 'account,schedule,timepay',
    'and the ungated modules are exactly the three that are about you',
    ungated.join(', ')
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 2. the clock permission did NOT widen ===')
  // ---------------------------------------------------------------------------
  // Opening enrolment must not have quietly granted the feed. This is the
  // assertion that would fail if somebody "simplified" the fix by deleting the
  // permission instead of moving it.
  ok(roleHas('owner', 'notifications.clock'), 'the owner still gets clock-ins')
  ok(roleHas('operations', 'notifications.clock'), 'and whoever runs the floor')
  ok(!roleHas('staff', 'notifications.clock'), 'STAFF STILL DO NOT')
  ok(!roleHas('shipping', 'notifications.clock'), 'nor the packing bench')
  ok(!roleHas('breaker', 'notifications.clock'), 'nor a breaker')
  ok(
    !permissionsForRole('shipping').includes('notifications.clock'),
    'and the narrowest role is not carrying it by another name'
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 3. the relay enforces the line, in the query ===')
  // ---------------------------------------------------------------------------
  const send = fakeDb(['endpoint', 'employee_id', 'clock_ok'])
  await worker.subscriptionsForSend(send.env, 'emp-puncher')
  const selects = send.sql.filter((s) => s.includes('SELECT') && s.includes('push_subscriptions'))
  ok(selects.length > 0, 'the clock fan-out reads the subscription table')
  ok(
    selects.some((s) => s.includes('clock_ok = 1')),
    'AND IT FILTERS ON clock_ok — a device without the permission is never selected',
    selects.join(' | ')
  )
  ok(
    selects.some((s) => s.includes('employee_id <> ')),
    'and it still excludes the person who punched'
  )

  // The message route must NOT have picked the filter up. A packer cannot see
  // everybody's hours, and that is no reason to stop a message addressed to them.
  const src = require('node:fs').readFileSync(join(process.cwd(), 'cloud/worker.js'), 'utf8')
  const pushSendBody = src.slice(src.indexOf('async function pushSend('))
  const pushSendOnly = pushSendBody.slice(0, pushSendBody.indexOf('\n}\n'))
  ok(
    pushSendOnly.includes('employee_id IN ('),
    'the message route selects by explicit employee id'
  )
  ok(
    !pushSendOnly.includes('clock_ok'),
    'AND NEVER CONSULTS clock_ok — being unable to see hours must not silence a message'
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 4. the column arrives without breaking what is there ===')
  // ---------------------------------------------------------------------------
  // Already migrated: asking twice must be silent, because ensurePushTable runs
  // on a cold worker and ALTER throws on the second call.
  const already = fakeDb(['endpoint', 'employee_id', 'clock_ok'])
  await worker.addClockOkColumn(already.env)
  ok(
    already.ran.every((s) => !s.includes('ALTER TABLE')),
    'a table that already has the column is left alone',
    already.ran.join(' | ')
  )
  ok(
    already.sql.some((s) => s.includes('PRAGMA table_info')),
    'and it asked rather than pattern-matching an error string'
  )

  // Not yet migrated: the ALTER runs, and the backfill is 1 rather than 0.
  const old = fakeDb(['endpoint', 'employee_id', 'p256dh', 'auth', 'label', 'created_at'])
  await worker.addClockOkColumn(old.env)
  const alter = old.ran.find((s) => s.includes('ALTER TABLE'))
  ok(!!alter, 'a table without it gets the column added', old.ran.join(' | '))
  ok(
    !!alter && alter.includes('DEFAULT 1'),
    'BACKFILLED TO 1, not 0 — every existing row was written under the old rule, ' +
      'which only let people who already had the permission subscribe at all',
    String(alter)
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 5. a packer can register a phone ===')
  // ---------------------------------------------------------------------------
  // Driven through the REAL handler. There is no relay in a test build, so the
  // honest proof is WHICH refusal comes back: a permission error means the gate
  // is still there, a relay error means it is not and the request got as far as
  // the network.
  signIn('RM-100')
  const sub = await call(IPC.pushSubscribe, {
    endpoint: 'https://push.example.invalid/x',
    p256dh: 'k',
    auth: 'a',
    label: 'Ada phone'
  })
  ok(sub.ok === false, 'there is no relay in a test build, so it cannot succeed')
  ok(
    !/permission/i.test(String(sub.error)),
    'AND THE REFUSAL IS NOT ABOUT PERMISSION — the bench got past the gate',
    String(sub.error)
  )

  // The state call is the one that used to return a permission complaint in
  // place of a screen.
  const state = await call(IPC.pushState)
  ok(!!state, 'a packer gets a notifications state back')
  ok(
    !/permission/i.test(String(state.problem ?? '')),
    'and is not told they may not use notifications',
    String(state.problem)
  )

  // Signed out is still refused. Enrolment is open to everybody SIGNED IN, which
  // is not the same as open.
  auth.logout()
  const anon = await call(IPC.pushSubscribe, { endpoint: 'e', p256dh: 'k', auth: 'a' })
  ok(anon.ok === false, 'a signed-out caller cannot register a device')
  ok(/signed in/i.test(String(anon.error)), 'and is told why', String(anon.error))

  // ---------------------------------------------------------------------------
  console.log('\n=== 5b. and the flag that rides with it is the CALLER’S ===')
  // ---------------------------------------------------------------------------
  // The line under test is one boolean in pushIpc, and it is the whole boundary:
  // get it wrong in the permissive direction and every packer's phone joins the
  // clock feed, with nothing on any screen to show it happened. So this stands a
  // fake relay up and reads what actually went over the wire.
  // The state rows directly rather than setSyncConfig, which restarts the sync
  // loop and reaches for a BrowserWindow that does not exist here. The relay
  // address is all `call` reads, and the key is invented — the point is what
  // this build SENDS, not that anything answers.
  syncStateSet('url', 'https://relay.example.invalid')
  syncStateSet('key', 'not-a-real-key')

  const sent: any[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    // A CURRENT relay. Without the capability the enrolment is refused before a
    // subscribe is ever sent, which is section 6c's subject rather than this
    // one's — here the question is what the flag says, not whether it travels.
    const body = String(url).includes('/v1/push-notify/key')
      ? { ok: true, configured: true, publicKey: 'k', capabilities: ['clock-scope'] }
      : { ok: true }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    }
  }) as any

  const enrol = async (companyId: string): Promise<any> => {
    sent.length = 0
    signIn(companyId)
    await call(IPC.pushSubscribe, {
      endpoint: 'https://push.example.invalid/' + companyId,
      p256dh: 'k',
      auth: 'a',
      label: 'phone'
    })
    return sent.find((s) => s.url.includes('/v1/push-notify/subscribe'))
  }

  try {
    const packerBody = await enrol('RM-100')
    ok(!!packerBody, 'the packer’s subscription reached the relay', JSON.stringify(sent))
    ok(
      packerBody?.body.clock === false,
      'AND IT CARRIES clock:false — the bench is reachable, not subscribed to everyone’s hours',
      JSON.stringify(packerBody?.body)
    )

    const ownerBody = await enrol('RM-001')
    ok(!!ownerBody, 'the owner’s subscription reached the relay')
    ok(
      ownerBody?.body.clock === true,
      'and the owner’s carries clock:true — the feed they already had is not taken away',
      JSON.stringify(ownerBody?.body)
    )
  } finally {
    globalThis.fetch = realFetch
    syncStateSet('url', '')
    syncStateSet('key', '')
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 6. changing your own password ===')
  // ---------------------------------------------------------------------------
  // A STAFF account, not the bench. See section 6b for why the bench is
  // deliberately excluded from this entirely.
  signIn('RM-300')
  const short = auth.changeOwnPassword(PASSWORD, 'short')
  ok(short.ok === false, 'a password under 8 characters is refused')

  const wrong = auth.changeOwnPassword('not-the-current-one', 'a-brand-new-password')
  ok(wrong.ok === false, 'AND SO IS A CHANGE THAT CANNOT PROVE THE OLD ONE')
  ok(
    /current password/i.test(String(wrong.error)),
    'which is what stands between an unlocked laptop and a takeover',
    String(wrong.error)
  )

  const good = auth.changeOwnPassword(PASSWORD, 'a-brand-new-password')
  ok(good.ok === true, 'the real change goes through', String(good.error))
  ok(auth.login('RM-300', 'a-brand-new-password').ok === true, 'and the new password works')
  ok(auth.login('RM-300', PASSWORD).ok === false, 'while the old one no longer does')

  // Somebody with no email address can still do this. The whole reason the
  // module exists is that the alternative was asking an administrator, and the
  // people most likely to need it are the ones with no company mailbox to send
  // a reset link to.
  const stafferRow = db.prepare('SELECT email FROM employees WHERE id = ?').get(STAFFER) as {
    email: string
  }
  ok(
    employees.isPlaceholderEmail(stafferRow.email),
    'the account has a placeholder where a mailbox would be',
    stafferRow.email
  )
  ok(
    !stafferRow.email.includes('@'),
    'AND STILL CHANGED ITS OWN PASSWORD WITH NOWHERE TO SEND A RESET LINK',
    stafferRow.email
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 6b. the shared bench is NOT given that button ===')
  // ---------------------------------------------------------------------------
  // A bench account is a PLACE, not a person: `insertEmployee` types its
  // password and reads it out, and `setTemporaryPassword` skips the
  // must-change prompt, both because "the four people using the computer"
  // cannot agree on one. Handing that account a change-password form lets
  // whoever sits down first take a shared credential hostage — and
  // `setChosenPassword` revokes every other session for the same employee id,
  // so the other benches are signed out mid-shift.
  const acctSrc = require('node:fs').readFileSync(
    join(process.cwd(), 'src/renderer/src/modules/account/AccountModule.tsx'),
    'utf8'
  )
  ok(
    acctSrc.includes("user?.role === 'shipping'"),
    'THE ACCOUNT SCREEN CHECKS FOR THE SHARED BENCH before offering the form'
  )
  ok(
    /shared bench account/i.test(acctSrc),
    'and says so in words rather than showing an empty space'
  )
  // The rule it mirrors, asserted at the source so the two cannot drift apart.
  signIn('RM-001')
  const benchReset = employees.setTemporaryPassword(PACKER, 'another-long-password')
  ok(benchReset === true, 'an administrator can still reset the bench password')
  const benchRow = db
    .prepare('SELECT must_change_password, role FROM employees WHERE id = ?')
    .get(PACKER) as { must_change_password: number; role: string }
  ok(benchRow.role === 'shipping', 'the bench account is the shipping role')
  ok(
    benchRow.must_change_password === 0,
    'AND IS NEVER ASKED TO PICK ITS OWN — which is the same rule, kept in one place',
    String(benchRow.must_change_password)
  )

  // ---------------------------------------------------------------------------
  console.log('\n=== 6c. an old relay cannot be enrolled against ===')
  // ---------------------------------------------------------------------------
  // The app redeploys on every push; cloud/worker.js is pasted in by hand. In
  // the window between, this build sends clock:false to a relay that drops the
  // field and fans every punch out to everybody. Enrolling an unentitled device
  // there IS subscribing them, so it must be refused rather than attempted.
  syncStateSet('url', 'https://relay.example.invalid')
  syncStateSet('key', 'not-a-real-key')
  const realFetch2 = globalThis.fetch
  const answerKeyWith = (capabilities: unknown): void => {
    globalThis.fetch = (async (url: any) => {
      const body = String(url).includes('/v1/push-notify/key')
        ? { ok: true, configured: true, publicKey: 'k', capabilities }
        : { ok: true }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }) as any
  }
  try {
    // An OLD relay: no capabilities field at all.
    answerKeyWith(undefined)
    signInWith('RM-300', 'a-brand-new-password')
    const stale = await call(IPC.pushSubscribe, { endpoint: 'https://p/1', p256dh: 'k', auth: 'a' })
    ok(stale.ok === false, 'A STAFF DEVICE IS REFUSED AGAINST A RELAY THAT CANNOT ENFORCE')
    ok(
      /older version/i.test(String(stale.error)),
      'and the message names the relay rather than blaming the phone',
      String(stale.error)
    )

    // The owner is entitled either way, so a stale relay does not lock them out
    // of their own notifications.
    signIn('RM-001')
    const ownerStale = await call(IPC.pushSubscribe, {
      endpoint: 'https://p/2',
      p256dh: 'k',
      auth: 'a'
    })
    ok(
      ownerStale.ok === true,
      'while somebody who IS entitled is unaffected by the relay being old',
      String(ownerStale.error)
    )

    // A CURRENT relay: the staff device goes through.
    answerKeyWith(['clock-scope'])
    signInWith('RM-300', 'a-brand-new-password')
    const fresh = await call(IPC.pushSubscribe, { endpoint: 'https://p/3', p256dh: 'k', auth: 'a' })
    ok(fresh.ok === true, 'and once the relay is updated the same device enrols', String(fresh.error))
  } finally {
    globalThis.fetch = realFetch2
    syncStateSet('url', '')
    syncStateSet('key', '')
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 7. the screen it came from no longer half-exists ===')
  // ---------------------------------------------------------------------------
  const adminSrc = require('node:fs').readFileSync(
    join(process.cwd(), 'src/renderer/src/modules/admin/AdminModule.tsx'),
    'utf8'
  )
  ok(
    !adminSrc.includes('NotificationsTab'),
    'Admin no longer imports a tab that moved',
    'AdminModule.tsx still references NotificationsTab'
  )
  ok(
    !adminSrc.includes("id: 'notifications'"),
    'and does not offer a tab that renders nothing'
  )
  ok(
    require('node:fs').existsSync(
      join(process.cwd(), 'src/renderer/src/modules/account/NotificationsPanel.tsx')
    ),
    'the panel itself moved rather than being deleted'
  )

  signIn('RM-001')
  ok(auth.currentUser()?.id === OWNER, 'and the owner is still who they were throughout')

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void run()
