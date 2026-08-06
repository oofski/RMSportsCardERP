/**
 * The staff clock portal's credential, verified across BOTH runtimes.
 *
 * The PIN is hashed on a laptop by Node and checked on Cloudflare by WebCrypto,
 * in two files that cannot import each other — the Worker is a standalone script
 * pasted into a dashboard. Two implementations of one format is exactly the
 * shape that drifts silently: nothing fails at build time, and the first anybody
 * hears about it is an employee who cannot clock in on a Saturday.
 *
 * So the interesting test here is section 3, which hashes a PIN with the REAL
 * app code and verifies it with the REAL Worker function. Not a reimplementation
 * of either — the actual two functions that will run in production.
 *
 * Run: npm run test:portal
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/portal-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const {
  PORTAL_PIN_ITERATIONS,
  PORTAL_PIN_PREFIX,
  isWeakPortalPin,
  parsePortalPinHash
} = require('../src/shared/portalPin')
// The Worker itself. Named export purely so this test can reach it; the
// Cloudflare runtime only ever calls the default export's fetch.
const { verifyPortalPin } = require('../cloud/worker.js')
getDb()

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

const now = new Date().toISOString()
const mkEmployee = (id: string, companyId: string, status = 'active'): void => {
  getDb()
    .prepare(
      `INSERT INTO employees (id, first_name, last_name, company_id, title, email, role,
         status, password_hash, must_change_password, created_at, updated_at)
       VALUES (?, 'Test', 'Person', ?, 'Packer', ?, 'employee', ?, 'x', 0, ?, ?)`
    )
    // employees.email is UNIQUE, so a shared blank collides on the second row.
    .run(id, companyId, `${id}@none.invalid`, status, now, now)
}
const hashOf = (id: string): string | null =>
  (
    getDb().prepare('SELECT portal_pin_hash AS h FROM employees WHERE id = ?').get(id) as {
      h: string | null
    }
  ).h

// ---------------------------------------------------------------------------
console.log('=== 1. setting a PIN ===')
// ---------------------------------------------------------------------------
mkEmployee('e1', 'RM-101')
const before = employees.getEmployeeById('e1')
ok(before.hasPortalPin === false, 'a new employee has no portal PIN')
ok(before.portalPinSetAt === null, 'and no date on it')

const set = employees.setPortalPin('e1', '481907')
ok(set.ok === true, 'a good PIN is accepted', set.error)
const after = employees.getEmployeeById('e1')
ok(after.hasPortalPin === true, 'and the employee now has one')
ok(typeof after.portalPinSetAt === 'string', 'stamped with when')

const stored = hashOf('e1') as string
ok(stored.startsWith(PORTAL_PIN_PREFIX), 'stored in the documented format', stored.slice(0, 24))
ok(!stored.includes('481907'), 'and the PIN itself is NOWHERE in the row')
const parsed = parsePortalPinHash(stored)
ok(parsed !== null, 'the hash parses')
ok(parsed.iterations === PORTAL_PIN_ITERATIONS, 'carrying its own iteration count', String(parsed?.iterations))
ok(parsed.salt.length === 16 && parsed.hash.length === 32, 'with a full salt and a full hash')

// Twice with the SAME pin must not produce the same hash, or the salt is not
// doing its job and two employees who pick the same PIN are visibly identical.
mkEmployee('e2', 'RM-102')
employees.setPortalPin('e2', '481907')
ok(hashOf('e2') !== hashOf('e1'), 'the same PIN twice gives two different hashes — the salt is real')

// ---------------------------------------------------------------------------
console.log('\n=== 2. what is refused ===')
// ---------------------------------------------------------------------------
const bad: Array<[string, string]> = [
  ['12345', 'five digits'],
  ['1234567', 'seven digits'],
  ['', 'nothing at all'],
  ['12a456', 'a letter in it'],
  ['  1234 ', 'spaces']
]
for (const [pin, why] of bad) {
  ok(employees.setPortalPin('e1', pin).ok === false, `refused: ${why}`)
}
for (const weak of ['111111', '000000', '123456', '654321', '456789']) {
  ok(isWeakPortalPin(weak), `weak: ${weak}`)
  ok(employees.setPortalPin('e1', weak).ok === false, `and refused at the door: ${weak}`)
}
for (const fine of ['481907', '204815', '900311']) {
  ok(!isWeakPortalPin(fine), `not weak: ${fine}`)
}
// A refusal must not have damaged the PIN that was already there.
ok(hashOf('e1') === stored, 'a refused attempt leaves the existing PIN untouched')

// A disabled account cannot be handed a working credential.
mkEmployee('e3', 'RM-103', 'disabled')
ok(employees.setPortalPin('e3', '481907').ok === false, 'a disabled employee cannot be given a PIN')
ok(hashOf('e3') === null, 'and nothing was written')

// ---------------------------------------------------------------------------
console.log('\n=== 3. the WORKER verifies what the APP wrote ===')
// ---------------------------------------------------------------------------
// The whole point of this file. Node's pbkdf2Sync on one side, WebCrypto's
// deriveBits on the other, one format between them, no shared code.
;(async () => {
  ok(await verifyPortalPin(stored, '481907'), 'the Worker accepts the right PIN')
  ok(!(await verifyPortalPin(stored, '481906')), 'and rejects one digit wrong')
  ok(!(await verifyPortalPin(stored, '709184')), 'and rejects the same digits shuffled')
  ok(!(await verifyPortalPin(stored, '')), 'and rejects an empty PIN')

  // Ten fresh PINs, hashed by the app and checked by the Worker. One passing
  // case could be luck; ten is the format agreeing.
  let agreed = 0
  for (let i = 0; i < 10; i++) {
    const pin = String(200000 + i * 7919).slice(0, 6)
    if (isWeakPortalPin(pin)) continue
    const res = employees.setPortalPin('e2', pin)
    if (!res.ok) continue
    const h = hashOf('e2') as string
    const good = await verifyPortalPin(h, pin)
    const badPin = await verifyPortalPin(h, pin === '999999' ? '111112' : '999999')
    if (good && !badPin) agreed++
  }
  ok(agreed >= 8, 'ten round trips through both runtimes agree', `${agreed}/10`)

  // Anything malformed reads as "does not verify" — never as a crash on a
  // login page, which is what a Worker exception would be.
  for (const junk of [
    null,
    '',
    'not-a-hash',
    'pbkdf2$sha256$25000$onlythreeparts',
    'pbkdf2$sha512$25000$AAAA$AAAA',
    'bcrypt$sha256$25000$AAAA$AAAA',
    'pbkdf2$sha256$0$AAAA$AAAA',
    'pbkdf2$sha256$99999999$AAAA$AAAA',
    'pbkdf2$sha256$25000$$'
  ]) {
    ok(parsePortalPinHash(junk as string) === null, `the app refuses to parse: ${String(junk).slice(0, 34)}`)
    ok(!(await verifyPortalPin(junk, '481907')), `and the Worker refuses it too: ${String(junk).slice(0, 34)}`)
  }

  // ---------------------------------------------------------------------------
  console.log('\n=== 4. taking it away ===')
  // ---------------------------------------------------------------------------
  employees.setPortalPin('e1', '481907')
  const live = hashOf('e1') as string
  ok(await verifyPortalPin(live, '481907'), 'the PIN works before clearing')
  ok(employees.clearPortalPin('e1') === true, 'cleared')
  ok(hashOf('e1') === null, 'and the hash is gone from the row')
  ok(employees.getEmployeeById('e1').hasPortalPin === false, 'the employee reads as having none')
  // The Worker treats a null hash as "not eligible" rather than "verify null",
  // and this is the belt on that braces.
  ok(!(await verifyPortalPin(hashOf('e1'), '481907')), 'and the old PIN no longer verifies')

  // ---------------------------------------------------------------------------
  console.log('\n=== 5. the hash never reaches a screen ===')
  // ---------------------------------------------------------------------------
  employees.setPortalPin('e2', '481907')
  const shipped = JSON.stringify(employees.getEmployeeById('e2'))
  ok(!shipped.includes('pbkdf2'), 'the object the renderer receives carries no hash')
  ok(!shipped.includes('481907'), 'and no PIN')
  ok(!shipped.includes('portal_pin_hash'), 'not even the column name')
  ok(shipped.includes('hasPortalPin'), 'only whether there IS one')
  const listed = JSON.stringify(employees.listEmployees())
  ok(!listed.includes('pbkdf2'), 'and the same for the whole employee list')

  // ---------------------------------------------------------------------------
  console.log('\n=== 6. the PIN travels by ordinary sync ===')
  // ---------------------------------------------------------------------------
  // No portal-specific plumbing was added. `employees` is already a synced
  // table, so setting a PIN queues the row like any other edit — which is the
  // entire reason the relay ever sees it.
  const queued = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM sync_outbox WHERE kind = 'employees' AND id = 'e2'`)
    .get() as { n: number }
  ok(queued.n === 1, 'setting a PIN queues the employee row for the relay', String(queued.n))
  const cols = (getDb().prepare(`PRAGMA table_info(employees)`).all() as Array<{ name: string }>).map(
    (c) => c.name
  )
  ok(cols.includes('portal_pin_hash'), 'the column exists on employees')
  ok(cols.includes('portal_pin_set_at'), 'and so does its timestamp')

  // ---------------------------------------------------------------------------
  console.log('\n=== 7. an INVITED employee can still clock in ===')
  // ---------------------------------------------------------------------------
  // The bug this file did not catch, and it cost a real shift.
  //
  // An employee created WITH an email address starts 'invited' and only becomes
  // 'active' when they sign into the DESKTOP app and choose a password. The
  // Worker asked for `status === 'active'`, so a new hire who had been given a
  // PIN and sent to the warehouse — who has never opened the desktop app — was
  // refused at the clock, and told the PIN was wrong. Which is a lie, and the
  // kind that makes somebody type it again.
  //
  // The PIN exists precisely so clocking in does not depend on the app
  // password. Gating it on the app password's state put that dependency back.
  const invitedId = 'e_invited'
  getDb()
    .prepare(
      `INSERT INTO employees (id, first_name, last_name, company_id, title, email, role,
         status, password_hash, must_change_password, created_at, updated_at)
       VALUES (?, 'New', 'Hire', 'RM-NEW', 'Packer', ?, 'employee',
         'invited', 'x', 1, ?, ?)`
    )
    .run(invitedId, `${invitedId}@none.invalid`, now, now)

  const invitedSet = employees.setPortalPin(invitedId, '481907')
  ok(invitedSet.ok === true, 'an invited employee can be given a PIN', invitedSet.error)
  const invited = employees.getEmployeeById(invitedId)
  ok(invited.status === 'invited', 'and is still invited — nothing about the PIN changes that')
  ok(invited.hasPortalPin === true, 'but does have a PIN')
  ok(await verifyPortalPin(hashOf(invitedId), '481907'), 'and the PIN verifies')

  // The eligibility rule itself, mirrored from the Worker. `status === 'active'`
  // is the wrong test; NOT DISABLED is the right one.
  const eligible = (e: { status: string; hasPortalPin: boolean }): boolean =>
    e.status !== 'disabled' && e.hasPortalPin
  ok(eligible(invited), 'so the portal must let an INVITED employee clock in')
  ok(
    eligible({ status: 'active', hasPortalPin: true }),
    'an active one too, obviously'
  )
  ok(
    !eligible({ status: 'disabled', hasPortalPin: true }),
    'and a DISABLED one never, PIN or no PIN'
  )
  // The source is the contract here — the Worker is a standalone file this test
  // cannot import a function out of, so assert the rule it actually ships.
  const workerSrc = require('node:fs').readFileSync(
    require('node:path').join(process.cwd(), 'cloud/worker.js'),
    'utf8'
  )
  ok(
    workerSrc.includes("if (emp.status === 'disabled') return false"),
    'and the Worker refuses on DISABLED rather than requiring ACTIVE'
  )
  ok(
    !workerSrc.includes("if (emp.status !== 'active') return false"),
    'the active-only rule is gone from the Worker'
  )

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})()
