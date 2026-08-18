/**
 * Finishing the night: capture it, then put the paper away.
 *
 * The owner's words: "once all the orders are finished being packed not picked
 * but packed then have a button popup that says finish these orders and then
 * they click finish and it removes the PDF and just has a reports tab on the
 * page like how it is for history".
 *
 * ## The distinction the whole feature turns on
 *
 * PACKED, not picked, and not shipped either. `to_pick` is an order nobody has
 * pulled the cards for; everything past it has been bagged with its slip, and
 * at that moment the uploaded PDF has done its job. Waiting for `sent` would
 * mean the button never appeared until the carrier scans came back — the next
 * morning at best, long after the bench went home. Section 1.
 *
 * ## What "finish" must NOT be
 *
 * A delete. Every package, card, claim and assignment stays exactly where it
 * is: an order that has not shipped can still be tracked and marked sent
 * tomorrow. What goes is the megabyte of scanned slips. Section 3 is that
 * assertion, and it is the one that would be a disaster to get wrong.
 *
 * ## Why the two halves share a transaction
 *
 * A capture that succeeded with a clear that did not is a night reported twice;
 * a clear with no capture is a report that lost what it was reporting on.
 * Section 4.
 *
 * Run: npm run test:ship-finish
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/shipfinish-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { allOrdersPacked, SHIP_PIPELINE_STAGES } = require('../src/shared/shippingViews')

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

const summary = (orders: number, stages: Record<string, number>, hasDataset = true): any => ({
  hasDataset,
  counts: { orders },
  stageCounts: {
    to_pick: 0,
    put_together: 0,
    sent: 0,
    all_good: 0,
    exception: 0,
    returned: 0,
    ...stages
  }
})

// ---------------------------------------------------------------------------
console.log('=== 1. PACKED, not picked, and not shipped ===')
// ---------------------------------------------------------------------------
ok(
  allOrdersPacked(summary(5, { put_together: 5 })) === true,
  'EVERYTHING PACKED AND NOTHING SHIPPED IS FINISHED — the slip has done its job'
)
ok(
  allOrdersPacked(summary(5, { to_pick: 1, put_together: 4 })) === false,
  'one order still to pick is not',
  'the bench still needs the paper'
)
ok(
  allOrdersPacked(summary(5, { to_pick: 5 })) === false,
  'and a night nobody has started certainly is not'
)

// Shipping is not required. This is the assertion that stops somebody
// "tightening" the rule into one that never fires on the night it is for.
ok(
  allOrdersPacked(summary(5, { sent: 3, put_together: 2 })) === true,
  'a half-shipped night is still finished — sent is PAST packed, not a condition of it'
)
ok(
  allOrdersPacked(summary(4, { all_good: 4 })) === true,
  'and one that completed days ago obviously is'
)

// The side states are not stages on the way to anywhere.
ok(
  allOrdersPacked(summary(5, { put_together: 4, exception: 1 })) === true,
  'AN ORDER HELD AS AN EXCEPTION DOES NOT BLOCK THE NIGHT — it can sit there a week'
)
ok(
  allOrdersPacked(summary(5, { all_good: 4, returned: 1 })) === true,
  'nor does one that came back'
)
ok(
  allOrdersPacked(summary(5, { to_pick: 1, exception: 4 })) === false,
  'while a real unpicked order still does, however many exceptions surround it'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. nothing to finish is not "finished" ===')
// ---------------------------------------------------------------------------
// An empty dataset trivially has nothing left to pick. Offering a destructive
// button to somebody who has just opened the app would be the worst version of
// this feature.
ok(allOrdersPacked(summary(0, {})) === false, 'A NIGHT WITH NO ORDERS IS NOT FINISHED')
ok(
  allOrdersPacked(summary(5, { put_together: 5 }, false)) === false,
  'and neither is one with no dataset at all'
)
ok(allOrdersPacked(null) === false, 'a summary that has not loaded yet is not finished')
ok(
  allOrdersPacked({ hasDataset: true, counts: {}, stageCounts: {} } as any) === false,
  'nor is a malformed one — it does not throw, it declines'
)

// to_pick is the FIRST pipeline stage, which is what makes "nothing left in it"
// the right test. If the pipeline is ever reordered this is the assertion that
// catches the predicate silently meaning something else.
ok(
  SHIP_PIPELINE_STAGES[0] === 'to_pick',
  'to_pick is still the first pipeline stage',
  SHIP_PIPELINE_STAGES.join(' -> ')
)
ok(
  SHIP_PIPELINE_STAGES[1] === 'put_together',
  'and packed is the one straight after it',
  SHIP_PIPELINE_STAGES.join(' -> ')
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. FINISHING IS NOT A DELETE ===')
// ---------------------------------------------------------------------------
// Driven against the real database, because this is the assertion that would be
// a disaster to get wrong: the work has to survive the paper being put away.
const { getDb } = require('../src/main/db/database')
const domain = require('../src/main/db/shippingDomain')
const shipping = require('../src/main/db/shipping')
const db = getDb()

const seedDocument = (): void => {
  shipping.putShipDocument({
    name: 'slips.pdf',
    pageCount: 12,
    bytes: Buffer.from('%PDF-1.4 pretend scan'),
    importId: null
  })
}
seedDocument()
ok(!!shipping.getShipDocument(), 'a slip PDF is on this machine to begin with')

const countRows = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const before = {
  orders: countRows('ship_orders'),
  shipments: countRows('ship_shipments'),
  slots: countRows('ship_team_slots'),
  docs: countRows('ship_documents'),
  parts: countRows('ship_document_parts')
}
ok(before.docs > 0, 'and the document table has a row in it', String(before.docs))

const result = domain.finishNight('Tuesday night')
ok(!!result, 'the night can be finished')
ok(result.snapshotName === 'Tuesday night', 'under the name that was typed', result?.snapshotName)
ok(result.documentsCleared === before.docs, 'and it reports what it cleared', String(result?.documentsCleared))

ok(countRows('ship_documents') === 0, 'THE PDF IS GONE', String(countRows('ship_documents')))
ok(
  countRows('ship_document_parts') === 0,
  'and so are its synced slices — otherwise the next pull rebuilds it'
)
ok(!shipping.getShipDocument(), 'so no slip is offered any more')

// The work itself is untouched. Each of these is a table the bench spent the
// night filling in.
ok(countRows('ship_orders') === before.orders, 'EVERY ORDER IS STILL THERE', String(countRows('ship_orders')))
ok(countRows('ship_shipments') === before.shipments, 'every package too')
ok(countRows('ship_team_slots') === before.slots, 'and every card')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the capture is what makes it safe to put the paper away ===')
// ---------------------------------------------------------------------------
const snaps = shipping.listShipSnapshots()
ok(snaps.length >= 1, 'a snapshot was written', String(snaps.length))
ok(
  snaps.some((s: any) => s.name === 'Tuesday night'),
  'named as asked',
  snaps.map((s: any) => s.name).join(', ')
)
const full = shipping.getShipSnapshot(result.snapshotId)
ok(!!full, 'and it can be read back by id')

// A COPY, not a pointer. This is the property that lets tomorrow's import
// overwrite the dataset while tonight's report still opens.
ok(
  !!full && typeof full.payload === 'object' && full.payload !== null,
  'it carries a rendered payload rather than a reference'
)

// Left unnamed, it names itself — the button's field is optional.
seedDocument()
const auto = domain.finishNight('')
ok(!!auto.snapshotName && auto.snapshotName.trim().length > 0, 'an unnamed report still gets a name', auto?.snapshotName)
ok(countRows('ship_documents') === 0, 'and the paper is put away again')

// Finishing a night whose paper is already gone is not an error — somebody
// pressing it twice, or on a machine the document never reached, should get the
// same answer rather than a failure.
const again = domain.finishNight('Second pass')
ok(again.documentsCleared === 0, 'finishing with no document left clears nothing', String(again?.documentsCleared))
ok(!!again.snapshotId, 'but still writes the report')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
