/**
 * Reading a carrier's page, and deciding what to believe.
 *
 * The status shown on a card is scraped off somebody else's web page. That is
 * the only way to do it without an account, and it means every one of these
 * rules exists to stop a bad read becoming a confident wrong answer:
 *
 *   1. NOTHING IS GUESSED. A page that loaded but says nothing we recognise
 *      produces null, not a status. "Delivered" on a package that is not is the
 *      one outcome worth any amount of caution — somebody stops looking for it.
 *
 *   2. "OUT FOR DELIVERY" IS NOT "DELIVERED". They share a word, they mean
 *      opposite things to whoever is waiting, and a substring match gets it
 *      wrong. Specific phrases are tested before loose ones.
 *
 *   3. STATUS ONLY MOVES FORWARD. Carriers post late scans. A page briefly
 *      showing an earlier event must not walk a delivered package back to in
 *      transit, because that word decides whether somebody opens a claim.
 *
 *   4. A FAILED READ NEVER TOUCHES THE STATUS or `checkedAt`. A status that
 *      kept its old value but got a fresh "checked just now" would claim the
 *      carrier confirmed something it never said. The ATTEMPT is recorded
 *      separately, so a card can distinguish "nobody has checked yet" from "we
 *      checked and the carrier refused" — a blank card cannot, and those two
 *      need different reactions from a person.
 *
 *   5. FINISHED PACKAGES ARE LEFT ALONE. Delivered and returned cannot change,
 *      and re-reading them every hour spends the whole budget on pages with no
 *      news — which is how a carrier starts refusing the reads that matter.
 *
 * Run: npm run test:tracking
 */
/* eslint-disable @typescript-eslint/no-var-requires */
const {
  TRACKING_INTERVAL_MS,
  asShipStatus,
  dueForCheck,
  humanAge,
  isStale,
  isTrackable,
  looksUnreadable,
  parseTrackingStatus,
  shouldAdvance,
  trackingLineTone,
  trackingSummary,
  trackingTone
} = require('../src/shared/tracking')

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
console.log('=== 1. reading a status off a page ===')
// ---------------------------------------------------------------------------
ok(parseTrackingStatus('Your item was delivered at 3:14 pm') === 'delivered', 'USPS delivered')
ok(parseTrackingStatus('Delivered\nSigned for by: J SMITH') === 'delivered', 'UPS delivered')

// THE ONE THAT MATTERS. These share a word and mean opposite things.
ok(
  parseTrackingStatus('Out for Delivery, Expected by 8:00pm') === 'out_for_delivery',
  'out for delivery is NOT delivered',
  String(parseTrackingStatus('Out for Delivery, Expected by 8:00pm'))
)
ok(
  parseTrackingStatus('On FedEx vehicle for delivery — Out for delivery') === 'out_for_delivery',
  'even on a page that says "for delivery" twice'
)

ok(parseTrackingStatus('In Transit to Next Facility') === 'in_transit', 'USPS in transit')
ok(parseTrackingStatus('Arrived at USPS Regional Facility') === 'in_transit', 'an arrival scan')
ok(parseTrackingStatus('Departed FedEx location') === 'in_transit', 'a departure scan')
ok(parseTrackingStatus('Shipping Label Created, USPS Awaiting Item') === 'label_created', 'a label')
ok(parseTrackingStatus('Pre-Shipment Info Sent to USPS') === 'label_created', 'pre-shipment')
ok(parseTrackingStatus('Return to Sender') === 'returned', 'a return')
ok(parseTrackingStatus('Delivery Exception — Address unknown') === 'exception', 'an exception')

// An exception page still lists movement. The exception is the actionable fact,
// so it must win over the in-transit scans printed underneath it.
ok(
  parseTrackingStatus('Delivery Exception\nArrived at facility\nDeparted facility') === 'exception',
  'and it beats the movement history printed below it'
)

// NOTHING IS GUESSED.
ok(parseTrackingStatus('') === null, 'an empty page is not a status')
ok(parseTrackingStatus('Track another package. Sign in. Help.') === null, 'nor is a nav bar')
ok(parseTrackingStatus('Ship a package today with FedEx One Rate') === null, 'nor is marketing')

// ---------------------------------------------------------------------------
console.log('\n=== 2. pages that are not answers ===')
// ---------------------------------------------------------------------------
ok(looksUnreadable(''), 'blank')
ok(looksUnreadable('short'), 'nearly blank')
ok(
  looksUnreadable('We could not locate the shipment details for this tracking number. Try again.'),
  'a not-found page'
)
ok(
  looksUnreadable('Please enable JavaScript to continue using this application right now.'),
  'a page that never ran'
)
ok(
  looksUnreadable('Verify you are a human by completing the action below to continue browsing.'),
  'a bot wall'
)
ok(
  !looksUnreadable('Delivered\nSigned for by: J SMITH\nLeft at front door, 123 Main Street.'),
  'and a real tracking page is readable'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. what is allowed to overwrite what ===')
// ---------------------------------------------------------------------------
ok(shouldAdvance(null, 'in_transit'), 'a first reading always writes')
ok(shouldAdvance('label_created', 'in_transit'), 'and forward movement writes')
ok(shouldAdvance('in_transit', 'delivered'), 'right through to delivered')

// THE CLAIM GUARD. Carriers post late scans; a delivered package must not walk
// backwards because one did.
ok(!shouldAdvance('delivered', 'in_transit'), 'a late scan does NOT un-deliver a package')
ok(!shouldAdvance('out_for_delivery', 'label_created'), 'nor reopen one that is out')
ok(!shouldAdvance('in_transit', null), 'and an unreadable page never overwrites anything')

// Same rank writes: that is "checked again, still in transit", which refreshes
// the clock without changing the claim.
ok(shouldAdvance('in_transit', 'in_transit'), 'an unchanged status still counts as a check')
// exception/returned/delivered are all terminal rank, so a real exception read
// on a delivered package is recorded rather than swallowed.
ok(shouldAdvance('delivered', 'returned'), 'a delivered package can still come back')

// ---------------------------------------------------------------------------
console.log('\n=== 4. who gets asked, and how often ===')
// ---------------------------------------------------------------------------
ok(isTrackable('9400111899223197428490', null), 'a number with no status is trackable')
ok(isTrackable('1Z999AA10123456784', 'in_transit'), 'so is one on the move')
ok(!isTrackable('', 'in_transit'), 'an order with no number is not')
ok(!isTrackable(null, null), 'nor one with null')
ok(!isTrackable('9400111899223197428490', 'delivered'), 'a delivered package is finished')
ok(!isTrackable('9400111899223197428490', 'returned'), 'and so is a returned one')

const NOW = Date.parse('2026-08-08T12:00:00.000Z')
ok(isStale(null, NOW), 'never checked is stale')
ok(isStale('nonsense', NOW), 'and an unparseable timestamp is stale, not fresh')
ok(isStale('2026-08-08T10:59:00.000Z', NOW), 'an hour and one minute old is stale')
ok(!isStale('2026-08-08T11:30:00.000Z', NOW), 'half an hour old is not')
ok(TRACKING_INTERVAL_MS === 3600000, 'the interval is one hour')

const orders = [
  { id: 'fresh', trackingNumber: '111111111111', status: 'in_transit', checkedAt: '2026-08-08T11:45:00.000Z' },
  { id: 'stale', trackingNumber: '222222222222', status: 'in_transit', checkedAt: '2026-08-08T09:00:00.000Z' },
  { id: 'never', trackingNumber: '333333333333', status: null, checkedAt: null },
  { id: 'done', trackingNumber: '444444444444', status: 'delivered', checkedAt: null },
  { id: 'nonum', trackingNumber: null, status: null, checkedAt: null }
]
const due = dueForCheck(orders, NOW).map((o: { id: string }) => o.id)
ok(
  JSON.stringify(due) === JSON.stringify(['stale', 'never']),
  'an hourly sweep asks only about stale, unfinished, numbered orders',
  due.join(',')
)

// A FORCED check ignores freshness — but still not the finished ones. Spending
// a request confirming a delivered package is exactly the waste that gets a
// carrier to start refusing us.
const forced = dueForCheck(orders, NOW, true).map((o: { id: string }) => o.id)
ok(
  JSON.stringify(forced) === JSON.stringify(['fresh', 'stale', 'never']),
  'a forced check adds the fresh ones but never the finished ones',
  forced.join(',')
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. how it reads on a card ===')
// ---------------------------------------------------------------------------
ok(trackingSummary(null, null, NOW) === 'Not checked yet', 'nothing read yet says so')
ok(
  trackingSummary('in_transit', '2026-08-08T11:58:00.000Z', NOW) === 'In transit · checked 2 min ago',
  'a reading carries its age',
  trackingSummary('in_transit', '2026-08-08T11:58:00.000Z', NOW)
)
// THE AGE IS THE POINT. A status with no age invites somebody to trust a
// reading from Tuesday as though it were from this morning.
ok(
  trackingSummary('delivered', '2026-08-05T12:00:00.000Z', NOW).includes('3d ago'),
  'and an old one admits it',
  trackingSummary('delivered', '2026-08-05T12:00:00.000Z', NOW)
)
ok(humanAge(30_000) === 'just now', 'under a minute')
ok(humanAge(5 * 60_000) === '5 min ago', 'minutes')
ok(humanAge(3 * 3_600_000) === '3h ago', 'hours')
ok(humanAge(2 * 86_400_000) === '2d ago', 'days')

// THE BLANK-CARD BUG. A card that renders nothing cannot tell "nobody has
// checked yet" from "we checked and the carrier refused" — and those need
// different reactions from a person. Every one of these is a distinct sentence.
ok(
  trackingSummary(null, null, NOW, 'FedEx refused the read', '2026-08-08T11:55:00.000Z') ===
    'Could not read the carrier page · tried 5 min ago',
  'a failed check with no status says so, and when it tried',
  trackingSummary(null, null, NOW, 'x', '2026-08-08T11:55:00.000Z')
)
ok(
  trackingSummary(null, null, NOW) === 'Not checked yet',
  'and "never tried" is a different sentence from "tried and failed"'
)
// A STATUS WE HAVE still leads, with the failure as a caveat — the useful fact
// first. Without the caveat the age quietly stops advancing and nobody notices.
ok(
  trackingSummary('in_transit', '2026-08-08T10:00:00.000Z', NOW, 'blocked', '2026-08-08T11:59:00.000Z') ===
    'In transit · checked 2h ago · check failing',
  'an old reading behind a failing check says both',
  trackingSummary('in_transit', '2026-08-08T10:00:00.000Z', NOW, 'blocked', '2026-08-08T11:59:00.000Z')
)
ok(
  !trackingSummary('in_transit', '2026-08-08T11:58:00.000Z', NOW).includes('failing'),
  'and a working check says nothing about failing'
)

// A failing check with nothing to show is AMBER, not grey: it is a thing
// somebody has to look at, and rendering it like "not checked yet" is how a
// broken feature sits unnoticed behind a quiet-looking card.
ok(trackingLineTone(null, 'blocked') === 'warn', 'a failing check with no status is amber')
ok(trackingLineTone(null, null) === 'idle', 'and not-yet-checked stays quiet')
ok(trackingLineTone('delivered', 'blocked') === 'ok', 'a delivered package stays green')

ok(trackingTone('delivered') === 'ok', 'delivered is green')
ok(trackingTone('exception') === 'warn', 'an exception wants attention')
ok(trackingTone('returned') === 'warn', 'so does a return')
ok(trackingTone('in_transit') === 'live', 'moving is its own tone')
ok(trackingTone(null) === 'idle', 'and unknown is quiet')

ok(asShipStatus('delivered') === 'delivered', 'a real code survives the boundary')
ok(asShipStatus('teleported') === null, 'and an invented one does not')
ok(asShipStatus(undefined) === null, 'nor does undefined')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
