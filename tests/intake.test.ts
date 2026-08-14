/**
 * The public check-in form, laptop side.
 *
 * This is the one table in the app a STRANGER can write to. The form cannot be
 * authenticated — customers have no logins — so anything it could write
 * directly, anybody with the link could write. The whole security model is that
 * it writes to its own table and a person decides, and this suite is about that
 * decision, because until now nothing tested any of it: 323 lines, a token, a
 * public URL and zero coverage.
 *
 * What is pinned, and how each fails if it is wrong:
 *
 *   1. THE TOKEN IS A CREDENTIAL. It is the only thing standing between a
 *      stranger and the form, it goes in a URL people read aloud, and it is
 *      matched against a restricted alphabet in the Worker. A short one, a
 *      predictable one, or one carrying a character that means something to a
 *      URL or to SQL is the whole surface.
 *
 *   2. ACCEPTING WRITES A REAL CUSTOMER. `ship_customers` is keyed on the
 *      Whatnot handle and is what every packing slip joins against, so accept is
 *      not a label — it is a row in the shipping list.
 *
 *   3. THE STATE MACHINE ONLY GOES ONE WAY. Accept already refused to run
 *      twice. Reject did not refuse to run AFTER an accept, so a submission
 *      could end up reading "rejected" while the customer it created sat in the
 *      shipping list, with `customer_id` still naming them. Nothing on either
 *      screen said the two disagreed.
 *
 * Every name, handle and address here is invented.
 *
 * Run: npm run test:intake
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/intake-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const intake = require('../src/main/db/intake')
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

const stamp = '2026-08-14T15:00:00.000Z'
let seq = 0
/** A submission as the Worker would land it: straight into the table, no auth. */
const submit = (linkId: string, over: Record<string, unknown> = {}): string => {
  const id = `sub_${++seq}`
  const row = {
    id,
    link_id: linkId,
    handle: '@InventedBuyer',
    real_name: 'Invented Buyer',
    email: 'buyer@example.invalid',
    phone: '',
    address1: '1 Invented Street',
    address2: '',
    city: 'Springfield',
    state: 'IL',
    postal_code: '62701',
    country: 'US',
    request: '',
    status: 'new',
    created_at: stamp,
    updated_at: stamp,
    ...over
  }
  db.prepare(
    `INSERT INTO intake_submissions
       (id, link_id, handle, real_name, email, phone, address1, address2, city, state,
        postal_code, country, request, status, created_at, updated_at)
     VALUES (@id, @link_id, @handle, @real_name, @email, @phone, @address1, @address2,
             @city, @state, @postal_code, @country, @request, @status, @created_at, @updated_at)`
  ).run(row)
  return id
}

// ---------------------------------------------------------------------------
console.log('=== 1. the token is the only thing guarding a public URL ===')
// ---------------------------------------------------------------------------
const link = intake.createIntakeLink(
  { label: 'August show', eventName: 'Invented Show', eventDate: '2026-08-20' },
  'emp_owner'
)
ok(!!link.id, 'a link is created')
ok(link.active === true, 'and starts open')
ok(link.token.length === 32, 'the token is 32 characters', String(link.token.length))
ok(/^[A-Za-z0-9]+$/.test(link.token), 'letters and digits only — nothing a URL or SQL could read', link.token)
ok(
  !/[0O1lI]/.test(link.token),
  'and none of the characters people mistype when reading one aloud',
  link.token
)

// Two links minted back to back must not resemble each other. A token drawn
// from anything predictable is a form a stranger can find by guessing.
const tokens = new Set<string>()
for (let i = 0; i < 50; i++) {
  tokens.add(
    intake.createIntakeLink({ label: `bulk ${i}`, eventName: 'Invented Show', eventDate: null }, null).token
  )
}
ok(tokens.size === 50, 'fifty tokens are fifty different tokens', String(tokens.size))

// Closing the form is a flag on the synced row, not a delete, so the
// submissions it already took stay attached to something.
ok(intake.setIntakeLinkActive(link.id, false) === true, 'a link can be closed')
ok(
  intake.listIntakeLinks().find((l: any) => l.id === link.id)?.active === false,
  'and reads as closed'
)
intake.setIntakeLinkActive(link.id, true)

// ---------------------------------------------------------------------------
console.log('\n=== 2. accepting writes a real customer ===')
// ---------------------------------------------------------------------------
const first = submit(link.id)
ok(intake.newSubmissionCount() === 1, 'the submission is waiting', String(intake.newSubmissionCount()))

const accepted = intake.acceptIntakeSubmission(first, 'emp_owner')
ok(accepted.ok === true, 'it can be accepted', accepted.error)
ok(accepted.submission?.status === 'accepted', 'and reads accepted')
const customer = db
  .prepare('SELECT * FROM ship_customers WHERE id = ?')
  .get('inventedbuyer') as any
ok(!!customer, 'a shipping customer now exists, keyed on the handle')
ok(customer.whatnot_handle === '@InventedBuyer', 'keeping the handle exactly as typed', customer.whatnot_handle)
ok(customer.real_name === 'Invented Buyer', 'with the name they gave')
ok(
  customer.address.includes('1 Invented Street') && customer.address.includes('Springfield, IL'),
  'and their address on one line',
  customer.address
)
ok(accepted.submission?.customerId === 'inventedbuyer', 'the submission records who it became')
ok(intake.newSubmissionCount() === 0, 'and it is off the waiting list')

// Accepting twice is refused — it already was, and it stays that way.
const twice = intake.acceptIntakeSubmission(first, 'emp_owner')
ok(twice.ok === false, 'accepting the same submission twice is refused')

// A submission with no handle cannot become a customer: ship_customers is keyed
// on it, so the row would be one nothing could ever match to an order.
const anon = submit(link.id, { handle: '  @  ' })
const anonRes = intake.acceptIntakeSubmission(anon, 'emp_owner')
ok(anonRes.ok === false, 'a submission with no usable handle is refused')
ok(/handle/i.test(anonRes.error ?? ''), 'and says why', anonRes.error)

// ---------------------------------------------------------------------------
console.log('\n=== 3. reject does not run after accept ===')
// ---------------------------------------------------------------------------
// THE ASSERTION THIS SECTION EXISTS FOR. Accept WRITES a row into the shipping
// list. Rejecting afterwards left that customer sitting there while the
// submission that created them read "rejected", with customer_id still naming
// the row somebody had just declined — and the record of why that customer
// exists pointed at a rejection. Two reviewers on the same queue, or one person
// double-tapping, is all it needs.
const late = intake.rejectIntakeSubmission(first, 'changed my mind', 'emp_owner')
ok(late.ok === false, 'REJECTING AN ACCEPTED SUBMISSION IS REFUSED', JSON.stringify(late))
ok(
  /already accepted/i.test(late.error ?? ''),
  'and says the customer is already in the list',
  late.error
)
const stillThere = db.prepare('SELECT id FROM ship_customers WHERE id = ?').get('inventedbuyer')
ok(!!stillThere, 'the customer is left alone rather than half-removed')
const unchanged = intake
  .listIntakeSubmissions()
  .find((s: any) => s.id === first)
ok(unchanged?.status === 'accepted', 'and the submission still reads accepted', unchanged?.status)
ok(unchanged?.customerId === 'inventedbuyer', 'still naming the customer it created')

// An ordinary rejection of an untouched submission still works.
const spam = submit(link.id, { handle: '@SomebodyElse', real_name: 'Somebody Else' })
const rejected = intake.rejectIntakeSubmission(spam, 'not a real customer', 'emp_owner')
ok(rejected.ok === true, 'a new submission can still be rejected', rejected.error)
ok(rejected.submission?.status === 'rejected', 'and reads rejected')
ok(rejected.submission?.statusNote === 'not a real customer', 'with the note kept')
ok(
  !db.prepare('SELECT id FROM ship_customers WHERE id = ?').get('somebodyelse'),
  'AND NO CUSTOMER IS CREATED — a rejection writes nothing to the shipping list'
)

// A rejected one can still be accepted afterwards: that direction is a change of
// mind about somebody nothing has been written for, which is the whole point of
// the review step.
const reconsidered = intake.acceptIntakeSubmission(spam, 'emp_owner')
ok(reconsidered.ok === true, 'and a rejection can be reconsidered', reconsidered.error)
ok(
  !!db.prepare('SELECT id FROM ship_customers WHERE id = ?').get('somebodyelse'),
  'which is the point at which the customer is written'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. accepting an existing customer updates rather than duplicates ===')
// ---------------------------------------------------------------------------
// One person is one customer. A returning buyer filling the form in again at the
// next show must correct their address, not create a second row that half the
// packing slips join to.
const moved = submit(link.id, {
  handle: 'inventedbuyer',
  real_name: 'Invented Buyer',
  address1: '9 New Road',
  city: 'Peoria'
})
const update = intake.acceptIntakeSubmission(moved, 'emp_owner')
ok(update.ok === true, 'a returning buyer is accepted', update.error)
const after = db.prepare('SELECT * FROM ship_customers WHERE id = ?').get('inventedbuyer') as any
ok(
  (db.prepare(`SELECT COUNT(*) AS n FROM ship_customers WHERE id = 'inventedbuyer'`).get() as any).n === 1,
  'and is still ONE customer'
)
ok(after.address.includes('9 New Road'), 'with the new address', after.address)
ok(!after.address.includes('1 Invented Street'), 'and not the old one')

// A blank field does not erase what is already known — and "blank" is decided
// on the STREET, not on whatever the fragments compose to. A form submitted with
// nothing but a state and a zip composes to "IL · 62701", which is non-empty, so
// it REPLACED a complete stored address with two fragments and the next packing
// slip for that buyer had nowhere to send the cards.
const partial = submit(link.id, { handle: 'inventedbuyer', real_name: '', address1: '', city: '' })
intake.acceptIntakeSubmission(partial, 'emp_owner')
const kept = db.prepare('SELECT * FROM ship_customers WHERE id = ?').get('inventedbuyer') as any
ok(kept.real_name === 'Invented Buyer', 'a blank name leaves the stored one alone', kept.real_name)
ok(
  kept.address.includes('9 New Road'),
  'AND A FORM WITH NO STREET LEAVES THEIR ADDRESS ALONE',
  kept.address
)

// A real correction still lands, so the guard is not simply "never update".
const corrected = submit(link.id, {
  handle: 'inventedbuyer',
  real_name: '',
  address1: '400 Corrected Avenue',
  city: 'Peoria'
})
intake.acceptIntakeSubmission(corrected, 'emp_owner')
const fixed = db.prepare('SELECT * FROM ship_customers WHERE id = ?').get('inventedbuyer') as any
ok(fixed.address.includes('400 Corrected Avenue'), 'a submission with a street still corrects it', fixed.address)
ok(fixed.real_name === 'Invented Buyer', 'while the blank name is still left alone', fixed.real_name)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
