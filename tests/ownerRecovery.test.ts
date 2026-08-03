/**
 * Getting back into your own app.
 *
 * The request that produced this was "hardcode an RM-Reset owner with password
 * welcome123". It cannot be done: the repository and the installer are both
 * public, so a constant password is a login every reader already knows, on
 * every install, and Owner carries the customer export. What the request wanted
 * was to never be stuck without help, which needs a gate — not a secret.
 *
 * The gate is the filesystem. These assertions are about the two things that
 * makes it safe to ship: the password is different every time and appears
 * nowhere but the hash, and the trigger cannot fire twice.
 *
 * Run: npm run test:recovery
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/recovery-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const bcrypt = require('bcryptjs')
const { getDb } = require('../src/main/db/database')
const { honourOwnerReset } = require('../src/main/services/ownerRecovery')
const { nowIso, newId } = require('../src/main/util')

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

const TRIGGER = join(DIR, 'reset-owner.txt')
const arm = (): void => writeFileSync(TRIGGER, 'reset please')
interface Row {
  id: string
  company_id: string
  role: string
  status: string
  password_hash: string | null
  must_change_password: number
}
const owners = (): Row[] =>
  db.prepare("SELECT * FROM employees WHERE role = 'owner' ORDER BY created_at").all() as Row[]

// The dialog is the only thing here that needs a real Electron; the stub in
// tests/support returns a fixed answer, so the reset runs headless.
const shown = (): string => (global as unknown as { __lastDialogDetail?: string }).__lastDialogDetail ?? ''

// ---------------------------------------------------------------------------
console.log('=== 1. no trigger file, no reset ===')
// ---------------------------------------------------------------------------
const seedId = newId()
const ts = nowIso()
db.prepare(
  `INSERT INTO employees (id, first_name, last_name, company_id, title, email, role,
     status, password_hash, must_change_password, created_at, updated_at)
   VALUES (?, 'Real', 'Owner', 'RM-001', 'Owner', 'owner@rm.test', 'owner', 'active', ?, 0, ?, ?)`
).run(seedId, bcrypt.hashSync('the-real-one', 10), ts, ts)

const before = owners()[0]
ok(!existsSync(TRIGGER), 'no trigger file to begin with')
honourOwnerReset()
ok(
  owners()[0].password_hash === before.password_hash,
  'an ordinary launch does not touch the password'
)
ok(owners().length === 1, 'and invents no second owner')

// ---------------------------------------------------------------------------
console.log('\n=== 2. the trigger resets the EXISTING owner ===')
// ---------------------------------------------------------------------------
arm()
honourOwnerReset()
const after = owners()
ok(after.length === 1, 'still exactly one owner — the real one was reset, not replaced', String(after.length))
ok(after[0].id === seedId, 'and it is the same account, so history and permissions survive')
ok(after[0].password_hash !== before.password_hash, 'the password changed')
ok(after[0].must_change_password === 1, 'and must be changed on the way in')
ok(after[0].status === 'active', 'the account is active')
ok(!bcrypt.compareSync('the-real-one', after[0].password_hash!), 'the old password no longer works')

// The password is shown once and stored only as a hash.
const detail = shown()
const m = detail.match(/Password:\s+(\S+)/)
const shownPassword = m ? m[1] : ''
ok(!!shownPassword, 'a password was shown to the operator', detail.slice(0, 80))
ok(
  bcrypt.compareSync(shownPassword, after[0].password_hash!),
  'and it is the one that actually signs in'
)
ok(
  after[0].password_hash !== shownPassword,
  'the row holds a hash, never the password itself'
)
ok(/^\$2[aby]\$/.test(after[0].password_hash ?? ''), 'stored as bcrypt')

// ---------------------------------------------------------------------------
console.log('\n=== 3. it cannot fire twice ===')
// ---------------------------------------------------------------------------
ok(!existsSync(TRIGGER), 'the trigger file is consumed')
const settled = owners()[0].password_hash
honourOwnerReset()
ok(owners()[0].password_hash === settled, 'a second launch leaves the new password alone')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the password is different every time ===')
// ---------------------------------------------------------------------------
// A constant would be the very thing this exists to avoid, so prove it moves.
const seen = new Set<string>()
for (let i = 0; i < 5; i++) {
  arm()
  honourOwnerReset()
  const p = shown().match(/Password:\s+(\S+)/)
  if (p) seen.add(p[1])
}
ok(seen.size === 5, 'five resets produced five different passwords', String(seen.size))
ok(![...seen].some((p) => /welcome/i.test(p)), 'and none of them is a guessable constant')
ok([...seen].every((p) => p.length >= 12), 'each is long enough to be worth having', [...seen][0])

// ---------------------------------------------------------------------------
console.log('\n=== 5. nothing in the shipped source carries a password ===')
// ---------------------------------------------------------------------------
const src: string = require('node:fs').readFileSync(
  join(process.cwd(), 'src/main/services/ownerRecovery.ts'),
  'utf8'
)
ok(!/welcome123/i.test(src), 'the source does not contain welcome123')
ok(
  !/(password|pass)\s*[:=]\s*['"][A-Za-z0-9!@#$%^&*]{6,}['"]/.test(src),
  'the source assigns no literal password at all'
)
ok(src.includes('generateTempPassword'), 'it generates one per run instead')

// ---------------------------------------------------------------------------
console.log('\n=== 6. with no owner at all, one is created ===')
// ---------------------------------------------------------------------------
db.prepare("DELETE FROM employees WHERE role = 'owner'").run()
ok(owners().length === 0, 'no owner to start')
arm()
honourOwnerReset()
const made = owners()
ok(made.length === 1, 'a recovery owner exists', String(made.length))
ok(made[0].company_id === 'RM-RESET', 'under a company id you can actually type')
ok(made[0].must_change_password === 1, 'and it demands a new password immediately')
const p6 = shown().match(/Password:\s+(\S+)/)
ok(!!p6 && bcrypt.compareSync(p6[1], made[0].password_hash!), 'the shown password signs in')

// A disabled owner must not be quietly reactivated by a reset — that is a
// different decision from "I forgot my password" and belongs to a person.
db.prepare("UPDATE employees SET role = 'owner', status = 'disabled'").run()
arm()
honourOwnerReset()
const afterDisabled = db
  .prepare("SELECT COUNT(*) AS c FROM employees WHERE status = 'disabled'")
  .get() as { c: number }
ok(afterDisabled.c === 1, 'a disabled owner stays disabled')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
