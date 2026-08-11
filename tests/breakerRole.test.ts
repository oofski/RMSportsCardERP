/**
 * The Breaker role: the packing floor, plus the camera.
 *
 * The person in front of the camera is not the person running the Streaming
 * module. Starting a show required `streaming.manage`, which is ALSO the
 * permission for entering what each box cost, recording giveaway losses and
 * deleting a night — so the only way to let a breaker go live was to hand them
 * the profit and loss of every show the business has ever run.
 *
 * `streaming.run` is the narrow answer: start and end, and nothing else.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. A BREAKER CAN GO LIVE. If start/end still needed `streaming.manage`,
 *      the role would be decoration and the button would refuse every press.
 *
 *   2. A BREAKER CANNOT READ THE MONEY. `module.streaming` is the P&L — the
 *      cost of every case opened. Granting it "so the button works" would be
 *      the whole reason this role exists, undone.
 *
 *   3. A BREAKER IS A SHIPPING PERSON OTHERWISE. Same floor, same bench, same
 *      refusals: no imports, no exports carrying customer addresses, no
 *      inventory. Anything else is scope creep dressed as a job title.
 *
 *   4. MANAGERS KEEP THE BUTTON. `streaming.manage` implies the right to open
 *      a session; writing `streaming.run` into every manager's role as well
 *      would be a second place to forget it.
 *
 *   5. IT IS ASSIGNABLE BY THE PEOPLE WHO HIRE. Same rank as Shipping — a
 *      sibling, not a rung — so Operations can assign it and a breaker cannot
 *      hand it out.
 *
 * Run: npm run test:breaker
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/breaker-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  assignableRoles,
  permissionsForRole,
  ROLES,
  ROLE_PERMISSIONS,
  PERMISSIONS,
  roleLabel
} = require('../src/shared/permissions')

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

const breaker: string[] = permissionsForRole('breaker')
const shipping: string[] = permissionsForRole('shipping')
const has = (role: string, p: string): boolean => permissionsForRole(role).includes(p)

// ---------------------------------------------------------------------------
console.log('\n=== 1. the role exists and is a real one ===')
// ---------------------------------------------------------------------------
const def = ROLES.find((r: { id: string }) => r.id === 'breaker')
ok(!!def, 'Breaker is in the role list')
ok(roleLabel('breaker') === 'Breaker', 'and prints as a job', roleLabel('breaker'))
ok(def.rank === ROLES.find((r: { id: string }) => r.id === 'shipping').rank,
  'at the same rank as Shipping — a sibling, not a rung', String(def.rank))
ok(Array.isArray(ROLE_PERMISSIONS.breaker), 'with a permission set of its own')

// The permission is declared, not just granted — the Admin screen renders from
// PERMISSIONS, so a key granted but undeclared is invisible to whoever is
// auditing who can do what.
const runDef = PERMISSIONS.find((p: { key: string }) => p.key === 'streaming.run')
ok(!!runDef, 'streaming.run is a declared permission')
ok(runDef.group === 'Modules', 'in the Modules group', String(runDef.group))

// ---------------------------------------------------------------------------
console.log('\n=== 2. REASON 1 and 2: the camera, but not the money ===')
// ---------------------------------------------------------------------------
ok(has('breaker', 'streaming.run'), 'a breaker may start and end a stream')
ok(!has('breaker', 'module.streaming'), 'and may NOT open the Streaming module')
ok(!has('breaker', 'streaming.manage'), 'and may NOT manage sessions, items or costs')
ok(!has('breaker', 'module.finance'), 'no finance')
ok(!has('breaker', 'finance.manage'), 'and nothing that writes to it')

// ---------------------------------------------------------------------------
console.log('\n=== 3. REASON 3: otherwise a shipping person, exactly ===')
// ---------------------------------------------------------------------------
// Set-equal to Shipping's, plus streaming.run and nothing else. Written as a
// difference rather than a list so a permission added to Shipping later is
// inherited here instead of being silently left behind.
const extra = breaker.filter((p) => !shipping.includes(p))
const missing = shipping.filter((p) => !breaker.includes(p))
ok(extra.length === 1 && extra[0] === 'streaming.run',
  'the ONLY thing a breaker has that a shipping person does not is streaming.run',
  JSON.stringify(extra))
ok(missing.length === 0, 'and nothing a shipping person has is taken away', JSON.stringify(missing))

// The boundaries Shipping was given on purpose, restated here because this is
// the role most likely to have them quietly widened.
ok(has('breaker', 'module.fulfillment'), 'they work the floor')
ok(has('breaker', 'shipping.find') && has('breaker', 'shipping.pack'), 'picking and packing')
ok(!has('breaker', 'shipping.manage'), 'but not the exports carrying customer addresses')
ok(!has('breaker', 'module.inventory'), 'and not inventory')
ok(!has('breaker', 'admin.access'), 'and not Admin')

// ---------------------------------------------------------------------------
console.log('\n=== 4. REASON 4: whoever runs the shows keeps the button ===')
// ---------------------------------------------------------------------------
ok(has('owner', 'streaming.run'), 'the owner may open a session')
ok(has('operations', 'streaming.run'), 'so may operations')
ok(has('operations', 'streaming.manage'), 'who also manage them')
// The main process accepts EITHER, which is what makes the pair safe: nobody
// who may edit a session's costs can be locked out of opening one.
ok(
  ['owner', 'operations'].every((r) => has(r, 'streaming.run') && has(r, 'streaming.manage')),
  'and hold both, so neither gate can lock the other out'
)
ok(!has('staff', 'streaming.run'), 'ordinary staff may not go live')
ok(!has('shipping', 'streaming.run'), 'nor a shipping account')

// ---------------------------------------------------------------------------
console.log('\n=== 5. REASON 5: who may hand the role out ===')
// ---------------------------------------------------------------------------
ok(assignableRoles('owner').includes('breaker'), 'the owner may assign it')
ok(assignableRoles('operations').includes('breaker'), 'operations may assign it')
ok(!assignableRoles('breaker').includes('owner'), 'a breaker cannot make an owner')
ok(!assignableRoles('breaker').includes('operations'), 'nor an operations manager')
// Rank equality means a breaker can nominally assign sibling roles; what they
// cannot do is reach Admin at all, which is the gate that actually holds.
ok(!has('breaker', 'admin.employees.manage'), 'and cannot open the screen that assigns anything')

// ---------------------------------------------------------------------------
console.log('\n=== 6. an unknown role is still the narrowest set ===')
// ---------------------------------------------------------------------------
// Adding a role must not change the fallback: stale or corrupt data reads as
// LEAST ACCESS, and a breaker's set is now not the smallest one in the file.
const unknown: string[] = permissionsForRole('nonsense-role')
ok(!unknown.includes('streaming.run'), 'an unrecognised role cannot go live', JSON.stringify(unknown))
ok(!unknown.includes('module.streaming'), 'and cannot read the module')
ok(
  unknown.length === shipping.length && unknown.every((p) => shipping.includes(p)),
  'it falls back to the shipping set, as it did before',
  JSON.stringify(unknown)
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
