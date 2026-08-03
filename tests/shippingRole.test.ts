/**
 * The shipping role, and the employee who has no email address.
 *
 * Two things get built here and they lean on each other. The role exists so a
 * person at a packing computer can sign in and do the SOP and the bench without
 * being handed the rest of the shop; the blank email exists because most of
 * those people have no company address to be handed one with.
 *
 * The part worth being careful about is the second one. `employees.email` is
 * NOT NULL UNIQUE, so "no email" is stored as a synthetic value — and a
 * synthetic value in a column the login query searches is a way in if nobody
 * checks. Section 4 is that check: it is the only section here where a failure
 * is a security bug rather than a cosmetic one.
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
  'shipping.pack',
  'module.sops'
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
ok(noEmail.mustChangePassword === true, 'and still picks their own password on first sign-in')
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

// Stations were already storing a synthetic address; the same rule covers them.
employees.insertEmployee(
  {
    firstName: 'Packing bench 1',
    lastName: '',
    companyId: 'bench-1',
    title: 'Shipping station',
    email: employees.stationEmailFor('bench-1'),
    role: 'shipping',
    status: 'active',
    accountKind: 'station'
  },
  null,
  'bench-password'
)
ok(authed('bench-1') !== undefined, 'a station is found by its sign-in code')
ok(authed('station:bench-1') === undefined, 'but not by the address behind it')

// The password check is a separate gate, and it is still shut. A row that
// cannot be found cannot be verified against, which is the point — but assert
// the whole path, not just the lookup.
const { verifyPassword } = employees
const row = employees.getEmployeeRowForAuth('RM-950')
ok(verifyPassword(row, 'temp-password-2') === true, 'the right password verifies')
ok(verifyPassword(row, 'temp-password-1') === false, 'the superseded one does not')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
