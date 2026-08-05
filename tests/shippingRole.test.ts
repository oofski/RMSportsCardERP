/**
 * The shipping role, the employee who has no email address, and the bench
 * password an administrator types.
 *
 * Three things get built here and they lean on each other. The role exists so a
 * person at a packing computer can sign in and do the SOP and the bench without
 * being handed the rest of the shop; the blank email exists because most of
 * those people have no company address to be handed one with; the typed
 * password exists because the computer is shared, so the usual "here is a
 * temporary one, now choose your own" has nobody to address.
 *
 * The parts worth being careful about are the second and third. `employees.email`
 * is NOT NULL UNIQUE, so "no email" is stored as a synthetic value — and a
 * synthetic value in a column the login query searches is a way in if nobody
 * checks. And a password that arrives from a form is only as safe as the check
 * on the far side of the IPC boundary, because a form is not one. Sections 4
 * and 6 are those checks: they are the sections where a failure is a security
 * bug rather than a cosmetic one.
 *
 * Section 5 covers the mechanism this replaced. Station ACCOUNTS —
 * `account_kind = 'station'` rows that were their own kind of login — are gone;
 * the shipping role does that job. (Not to be confused with station SESSIONS
 * and work claims, which are the live picking/packing bench and are tested in
 * tests/shipStations.test.ts.) What survives is the ability to READ a station
 * row somebody already created, because deleting employee rows that own time
 * entries to tidy up a column would be a poor trade.
 *
 * Run: npm run test:shipping-role
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/shipping-role-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const auth = require('../src/main/services/auth')
const { registerIpcHandlers } = require('../src/main/ipc')
const { registeredHandlers } = require('../src/main/ipcRegistry')
const { IPC } = require('../src/shared/ipc')
const {
  ROLES,
  ROLE_PERMISSIONS,
  permissionsForRole,
  assignableRoles,
  roleHas,
  roleLabel,
  effectivePermissions
} = require('../src/shared/permissions')

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

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

// ---------------------------------------------------------------------------
console.log('=== 1. the role, and exactly what it grants ===')
// ---------------------------------------------------------------------------
ok(
  ROLES.some((r: { id: string }) => r.id === 'shipping'),
  'shipping is a role'
)
ok(roleLabel('shipping') === 'Shipping', 'and it has a label', roleLabel('shipping'))

// A sibling of staff, not a rung below it.
const rankOf = (id: string): number => ROLES.find((r: { id: string }) => r.id === id).rank
ok(rankOf('shipping') === rankOf('staff'), 'it ranks level with staff')

// The whole point of the role, spelled out. If this list ever grows by accident
// the diff is the alarm.
const EXPECTED = [
  'updates.check',
  'module.fulfillment',
  'shipping.find',
  'shipping.pack'
]
ok(
  same(permissionsForRole('shipping'), EXPECTED),
  'it grants the bench and nothing else',
  permissionsForRole('shipping').join(', ')
)
ok(same(ROLE_PERMISSIONS.shipping, EXPECTED), 'wired into ROLE_PERMISSIONS as the same set')

// The privacy boundary. shipping.manage gates the exports carrying customer
// names and addresses; it was closed deliberately and this role does not
// reopen it.
ok(!roleHas('shipping', 'shipping.manage'), 'it does NOT grant shipping.manage')
ok(!roleHas('shipping', 'module.inventory'), 'nor Inventory')
ok(!roleHas('shipping', 'admin.access'), 'nor Admin')
ok(!roleHas('shipping', 'module.finance'), 'nor Finance')

// It can still be raised one permission at a time, like any other role.
ok(
  effectivePermissions('shipping', ['shipping.manage']).includes('shipping.manage'),
  'an individual override still adds to it'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. a fourth role does not fall through a gap ===')
// ---------------------------------------------------------------------------
ok(assignableRoles('owner').includes('shipping'), 'an Owner can assign it')
ok(assignableRoles('operations').includes('shipping'), 'so can Operations')
ok(!assignableRoles('operations').includes('owner'), 'and Operations still cannot make an Owner')
ok(
  assignableRoles('staff').every((r: string) => rankOf(r) <= rankOf('staff')),
  'staff can assign nothing above their own rank',
  assignableRoles('staff').join(', ')
)
ok(!assignableRoles('shipping').includes('operations'), 'nor can a shipping account')
// Every role in the file resolves to a real set — a Record<Role, …> that grew a
// member without a matching entry would land here as undefined.
ok(
  ROLES.every((r: { id: string }) => Array.isArray(ROLE_PERMISSIONS[r.id])),
  'every declared role has a permission set'
)
// An unrecognised role — stale data, a downgrade — gets the narrowest set in
// the file, which is no longer staff's.
ok(
  same(permissionsForRole('archivist' as never), EXPECTED),
  'an unknown role falls back to the narrowest set, not staff'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. an employee with no email address ===')
// ---------------------------------------------------------------------------
const { isPlaceholderEmail, placeholderEmailFor, emailExists } = employees

const rawEmail = (id: string): string =>
  (db.prepare('SELECT email FROM employees WHERE id = ?').get(id) as { email: string }).email

const add = (over: Record<string, unknown>): { id: string; companyId: string } => {
  const { employee } = employees.insertEmployee(
    {
      firstName: 'Packer',
      lastName: 'One',
      companyId: 'RM-900',
      title: 'Shipping',
      email: '',
      role: 'shipping',
      ...over
    },
    null,
    'temp-password-1'
  )
  return employee
}

const noEmail = add({ firstName: 'Dee', companyId: 'RM-901' })
ok(isPlaceholderEmail(rawEmail(noEmail.id)), 'a blank email stores a placeholder', rawEmail(noEmail.id))
ok(rawEmail(noEmail.id) === 'no-email:rm-901', 'derived from the Company ID, lowercased')
ok(placeholderEmailFor('RM-901') === 'no-email:rm-901', 'and placeholderEmailFor agrees')
ok(isPlaceholderEmail('station:bench-1'), 'the predicate also catches the station form')
ok(!isPlaceholderEmail('dee@rmcardz.test'), 'and leaves a real address alone')

// Nothing that leaves the main process carries the synthetic value.
ok(noEmail.email === '', 'the record handed to the app has a blank email', JSON.stringify(noEmail.email))
const listed = employees.listEmployees().find((e: { id: string }) => e.id === noEmail.id)
ok(listed.email === '', 'and so does the one in the directory')

// Unique by construction: the column is UNIQUE, so a second no-email employee
// colliding would throw rather than fail an assertion.
const noEmail2 = add({ firstName: 'Ray', companyId: 'RM-902' })
ok(
  rawEmail(noEmail.id) !== rawEmail(noEmail2.id),
  'two no-email employees do not collide',
  `${rawEmail(noEmail.id)} vs ${rawEmail(noEmail2.id)}`
)

// Not parked in 'invited', waiting on an email that will never be sent.
ok(noEmail.status === 'active', 'a no-email employee lands active, not invited', noEmail.status)
// The repository's default is still "you must choose your own" — having no
// address was never a reason to skip the prompt, because somebody still owns
// the account. Opting out is explicit, and section 6 is where that happens.
ok(noEmail.mustChangePassword === true, 'and by default still picks their own password')
const optedOut = employees.insertEmployee(
  {
    firstName: 'Bench',
    lastName: 'Two',
    companyId: 'RM-904',
    title: 'Shipping',
    email: '',
    role: 'shipping',
    status: 'active'
  },
  null,
  'typed-by-an-admin',
  false
).employee
ok(optedOut.mustChangePassword === false, 'unless the caller says otherwise')
ok(optedOut.status === 'active', 'and that account is usable immediately', optedOut.status)
const withEmail = add({ firstName: 'Sam', companyId: 'RM-903', email: 'sam@rmcardz.test', role: 'staff' })
ok(withEmail.status === 'invited', 'someone with an address is still invited')

// A password reset must not put them back in 'invited' either.
employees.setTemporaryPassword(noEmail.id, 'temp-password-2')
ok(
  employees.getEmployeeById(noEmail.id).status === 'active',
  'a reset leaves a no-email employee active',
  employees.getEmployeeById(noEmail.id).status
)
employees.setTemporaryPassword(withEmail.id, 'temp-password-2')
ok(employees.getEmployeeById(withEmail.id).status === 'invited', 'and re-invites the one with an address')

// emailExists is asked about what a human typed. Neither nothing nor a
// synthetic value is an address anybody can claim.
ok(emailExists('') === false, "emailExists('') is false")
ok(emailExists('   ') === false, 'and blank-ish is too')
ok(emailExists('no-email:rm-901') === false, 'a placeholder is not a taken address')
ok(emailExists('station:bench-1') === false, 'nor is a station address')
ok(emailExists('sam@rmcardz.test') === true, 'a real one in use still is')
ok(emailExists('sam@rmcardz.test', withEmail.id) === false, 'except to its own owner')
ok(emailExists('nobody@rmcardz.test') === false, 'and an unused one is not')

// An edit that leaves the box empty re-stores the placeholder rather than ''.
employees.updateEmployee({ id: noEmail.id, email: '', title: 'Shipping lead' })
ok(isPlaceholderEmail(rawEmail(noEmail.id)), 'saving with the box empty keeps the placeholder')
ok(employees.getEmployeeById(noEmail.id).title === 'Shipping lead', 'and the rest of the edit landed')

// Moving the Company ID moves the placeholder with it, or the ID it was built
// from could be handed to somebody else and collide.
employees.updateEmployee({ id: noEmail.id, companyId: 'RM-950' })
ok(rawEmail(noEmail.id) === 'no-email:rm-950', 'a new Company ID re-derives it', rawEmail(noEmail.id))
const reuser = add({ firstName: 'Jo', companyId: 'RM-901' })
ok(rawEmail(reuser.id) === 'no-email:rm-901', 'so the freed Company ID can be given out again')

// Giving them a real address later replaces it outright.
employees.updateEmployee({ id: noEmail2.id, email: 'ray@rmcardz.test' })
ok(rawEmail(noEmail2.id) === 'ray@rmcardz.test', 'a real address replaces the placeholder')
ok(employees.getEmployeeById(noEmail2.id).email === 'ray@rmcardz.test', 'and is shown as itself')

// ---------------------------------------------------------------------------
console.log('\n=== 4. what may and may not be signed in as ===')
// ---------------------------------------------------------------------------
// The login lookup searches company_id OR email. The placeholder lives in the
// email column and is derived from the Company ID — a value written on a badge
// and typed at a bench all day. If it were accepted as an identifier it would
// be a second name for the account that nobody chose and nobody can change.
const authed = (identifier: string): string | undefined =>
  employees.getEmployeeRowForAuth(identifier)?.id

ok(authed('RM-950') === noEmail.id, 'a no-email employee is found by their Company ID')
ok(authed('rm-950') === noEmail.id, 'case-insensitively')
ok(authed('sam@rmcardz.test') === withEmail.id, 'and a real address still finds its owner')

ok(authed('') === undefined, 'a blank identifier matches NOBODY')
ok(authed('   ') === undefined, 'and neither does whitespace')
ok(authed('no-email:rm-950') === undefined, 'the placeholder is not a way in')
ok(authed('NO-EMAIL:RM-950') === undefined, 'in any case')
ok(authed('no-email:') === undefined, 'nor is the bare prefix')

// A station ACCOUNT, exactly as the retired mechanism left one on the owner's
// machine: a `station:` address in the email column and 'station' in
// account_kind. Nothing creates this any more — which is precisely why it is
// written by hand here, because the row still exists and the rules still have
// to hold for it. It is not deleted in the app either: it may own time entries
// and SOP ticks, and throwing those away to tidy up a column is a poor trade.
const legacy = employees.insertEmployee(
  {
    firstName: 'Packing bench 1',
    lastName: '',
    companyId: 'bench-1',
    title: 'Shipping station',
    email: 'station:bench-1',
    role: 'shipping',
    status: 'active'
  },
  null,
  'bench-password'
).employee
db.prepare(`UPDATE employees SET account_kind = 'station' WHERE id = ?`).run(legacy.id)

ok(authed('bench-1') !== undefined, 'a station is found by its sign-in code')
ok(authed('station:bench-1') === undefined, 'but not by the address behind it')
ok(authed('STATION:BENCH-1') === undefined, 'in any case')
// The reason the prefix is still recognised at all: drop it from the predicate
// and this row starts printing "station:bench-1" where an address goes.
ok(
  employees.getEmployeeById(legacy.id).email === '',
  'and it still renders blank rather than showing the synthetic value',
  JSON.stringify(employees.getEmployeeById(legacy.id).email)
)
ok(
  emailExists('station:bench-1') === false,
  'and is still not a taken address even now a real row carries it'
)
ok(
  employees.getEmployeeById(legacy.id).accountKind === 'station',
  'the row still reports what it is'
)

// The password check is a separate gate, and it is still shut. A row that
// cannot be found cannot be verified against, which is the point — but assert
// the whole path, not just the lookup.
const { verifyPassword } = employees
const row = employees.getEmployeeRowForAuth('RM-950')
ok(verifyPassword(row, 'temp-password-2') === true, 'the right password verifies')
ok(verifyPassword(row, 'temp-password-1') === false, 'the superseded one does not')

// ---------------------------------------------------------------------------
console.log('\n=== 5. station ACCOUNTS are retired ===')
// ---------------------------------------------------------------------------
// Two mechanisms for one job is one too many. Everything that existed only to
// mint and manage `account_kind = 'station'` logins is gone; the shipping role
// puts a person at the bench instead. Reading an old row still works — that is
// section 4 — but there is no longer any way to make a new one.
for (const gone of [
  'stationEmailFor',
  'listStations',
  'setStationPassword',
  'setStationStatus',
  'syntheticEmailTaken'
]) {
  ok(employees[gone] === undefined, `employees.${gone} is gone`)
}
for (const gone of ['stationsList', 'stationsCreate', 'stationsSetPassword', 'stationsSetStatus']) {
  ok(IPC[gone] === undefined, `IPC.${gone} is gone`)
}

registerIpcHandlers()
const channels = [...registeredHandlers().keys()]
ok(channels.length > 0, 'the handlers registered at all', String(channels.length))
ok(
  !channels.some((c: string) => c.startsWith('stations:')),
  'and not one of them is a stations: channel',
  channels.filter((c: string) => c.startsWith('stations:')).join(', ')
)
// The bench claim system is a different thing that shares the word. Its
// channels live under `shipping:station:` and are registered by shippingIpc.ts,
// not here — so this asserts the map, which is what both ends read.
const benchChannels = Object.keys(IPC).filter((k) =>
  String(IPC[k]).startsWith('shipping:station:')
)
ok(
  benchChannels.length >= 10 && IPC.shipStationBoard === 'shipping:station:board',
  'the picking/packing bench channels are untouched',
  String(benchChannels.length)
)

// Nothing writes the marker any more, whatever the role.
const fresh = employees.insertEmployee(
  {
    firstName: 'Nia',
    lastName: 'Park',
    companyId: 'RM-905',
    title: 'Shipping',
    email: '',
    role: 'shipping'
  },
  null,
  'typed-by-an-admin',
  false
).employee
ok(fresh.accountKind === 'person', 'a new account is a person', fresh.accountKind)
const kinds = db
  .prepare(`SELECT COUNT(*) AS n FROM employees WHERE account_kind = 'station'`)
  .get() as { n: number }
ok(kinds.n === 1, 'and the only station row left is the one written by hand', String(kinds.n))

// ---------------------------------------------------------------------------
console.log('\n=== 6. the password an administrator types ===')
// ---------------------------------------------------------------------------
// Everything below goes through the real create handler rather than the
// repository, because the renderer is not a trust boundary and the point of
// these assertions is what happens on the far side of the IPC call.
const BOSS_PASSWORD = 'owner-password-1'
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
  BOSS_PASSWORD,
  false
)
ok(auth.login('RM-001', BOSS_PASSWORD).ok === true, 'an owner is signed in to do the creating')

/* eslint-disable @typescript-eslint/no-explicit-any */
const BENCH_PASSWORD = 'bench-2-shared'
const create = (over: Record<string, unknown>): any => {
  // The registered handler itself, called the way the IPC layer calls it. No
  // renderer, no form, no preload — which is the whole point of the section.
  const handler = registeredHandlers().get(IPC.employeesCreate)
  return handler({ sender: null }, {
    firstName: 'Bench',
    lastName: 'Three',
    companyId: 'RM-960',
    title: 'Packing',
    email: '',
    role: 'shipping',
    ...over
  })
}

// --- refused in MAIN, not merely in the form -------------------------------
// The form applies the same rule, and a form is a convenience. These calls skip
// it entirely, which is what a modified renderer or a stray script would do.
const noPassword = create({ password: undefined })
ok(noPassword.ok === false, 'a shipping account with no password is refused')
ok(/8 characters/.test(noPassword.error ?? ''), 'and says how long it has to be', noPassword.error)
const blank = create({ password: '        ' })
ok(blank.ok === false, 'so is one that is eight characters of nothing but space')
const short = create({ password: 'abc1234' })
ok(short.ok === false, 'and so is seven characters', short.error)
ok(
  employees.listEmployees().every((e: { companyId: string }) => e.companyId !== 'RM-960'),
  'and none of the three left a row behind'
)

// --- the account it does create --------------------------------------------
const made = create({ password: BENCH_PASSWORD })
ok(made.ok === true, 'a long enough password is accepted', made.error)
const bench = made.data.employee
ok(bench.status === 'active', 'the bench account lands active', bench.status)
ok(bench.mustChangePassword === false, 'and is never asked to change its password')
ok(bench.accountKind === 'person', 'and is a person, not a station', bench.accountKind)

// The whole point: it signs in with the Company ID and the typed password.
ok(auth.login('RM-960', BENCH_PASSWORD).ok === true, 'it authenticates with company ID + password')
ok(auth.login('RM-960', 'bench-2-shareD').ok === false, 'and not with a near miss')
ok(auth.login('RM-960', '').ok === false, 'nor with nothing')
auth.login('RM-001', BOSS_PASSWORD) // back to the owner for the rest of the section

// --- and what it does NOT leave lying around -------------------------------
const benchRow = db.prepare('SELECT * FROM employees WHERE id = ?').get(bench.id) as Record<
  string,
  unknown
>
ok(/^\$2[aby]\$/.test(String(benchRow.password_hash)), 'the password is stored as a bcrypt hash')
ok(
  !Object.values(benchRow).some((v) => typeof v === 'string' && v.includes(BENCH_PASSWORD)),
  'and the plaintext is in no column of the row'
)
// Nothing hands it back either — an invite modal that received one would put it
// on screen behind a clipboard button, for a password the admin just typed.
ok(
  made.data.temporaryPassword === null,
  'no temporary password comes back, so nothing can display or copy one'
)

// --- every other role is untouched ------------------------------------------
const person = create({
  companyId: 'RM-961',
  email: 'kit@rmcardz.test',
  role: 'staff',
  password: undefined
})
ok(person.ok === true, 'a staff account still needs no typed password', person.error)
ok(person.data.employee.status === 'invited', 'still lands invited')
ok(person.data.employee.mustChangePassword === true, 'still must choose its own password')
ok(
  typeof person.data.temporaryPassword === 'string' && person.data.temporaryPassword.length > 0,
  'and still gets a generated one to put in the invite'
)
// A typed password on a role that does not take one is ignored, not stored.
const ignored = create({
  companyId: 'RM-962',
  email: 'lee@rmcardz.test',
  role: 'staff',
  password: 'not-my-password'
})
const ignoredRow = db
  .prepare('SELECT * FROM employees WHERE id = ?')
  .get(ignored.data.employee.id) as Record<string, unknown>
ok(
  !Object.values(ignoredRow).some((v) => typeof v === 'string' && v.includes('not-my-password')),
  'a password sent for a non-shipping role is discarded'
)
ok(
  employees.verifyPassword(ignoredRow, 'not-my-password') === false,
  'and is emphatically not what that account signs in with'
)

// --- a reset must not strand the bench --------------------------------------
// The old reset unconditionally set must_change_password. On a shared computer
// that is a locked door: the prompt has nobody to answer it, and whoever does
// answer it changes the password out from under the other three.
employees.setTemporaryPassword(bench.id, 'reset-bench-pass')
const afterReset = employees.getEmployeeById(bench.id)
ok(afterReset.mustChangePassword === false, 'a reset leaves a bench account free to just sign in')
ok(afterReset.status === 'active', 'and active', afterReset.status)
ok(
  auth.login('RM-960', 'reset-bench-pass').ok === true,
  'with the new password and no change screen in the way'
)
auth.login('RM-001', BOSS_PASSWORD)
employees.setTemporaryPassword(withEmail.id, 'reset-person-pass')
ok(
  employees.getEmployeeById(withEmail.id).mustChangePassword === true,
  'while a person is still made to choose their own'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
