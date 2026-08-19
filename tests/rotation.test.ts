/**
 * The rotation: one row per person, grouped by the job — and a rota that is a
 * DRAFT until somebody publishes it.
 *
 * ## The thing that would have been catastrophic and silent
 *
 * `published_at` arrives on a table the floor has been reading for months. A
 * nullable column arrives NULL, `myShifts` filters on it, and the first launch
 * after the update empties every packer's schedule — total data loss as far as
 * anybody holding a phone is concerned, with nothing in a log to say so. The
 * migration backfills every pre-existing row, and section 4 checks both halves:
 * that a NULL row really is invisible (so the hazard is real), and that the
 * backfill is still in the migration (so it stays fixed).
 *
 * ## The second-order one
 *
 * A shift published on Monday and MOVED on Wednesday is not "published". The
 * person working it is holding an answer that is no longer true, which is worse
 * than holding none, because they have no reason to go and look. A boolean
 * cannot express that, which is why this is a pair of timestamps.
 *
 * Run: npm run test:rotation
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/rotation-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const sched = require('../src/main/db/schedule')
const {
  describeOwnWeek,
  groupByRole,
  hoursLabel,
  ROTATION_ROLE_ORDER,
  shiftNeedsPublishing,
  totalShiftMinutes
} = require('../src/shared/schedule')
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
const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')

const PASSWORD = 'a-long-enough-password'
const hire = (first: string, companyId: string, role: string): string =>
  employees.insertEmployee(
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
  ).employee.id

const OWEN = hire('Owen', 'RM-001', 'owner')
const ADA = hire('Ada', 'RM-100', 'shipping')
const BEN = hire('Ben', 'RM-200', 'shipping')
const CAI = hire('Cai', 'RM-300', 'breaker')
const DEV = hire('Dev', 'RM-400', 'staff')

const MON = '2026-08-24'
const TUE = '2026-08-25'
const SUN = '2026-08-30'

// ---------------------------------------------------------------------------
console.log('=== 1. who sits under which heading ===')
// ---------------------------------------------------------------------------
const person = (firstName: string, role: string): any => ({ firstName, lastName: 'X', role })

const groups = groupByRole([
  person('Owen', 'owner'),
  person('Dev', 'staff'),
  person('Ben', 'shipping'),
  person('Cai', 'breaker'),
  person('Ada', 'shipping')
])
ok(
  groups.map((g: any) => g.role).join(',') === 'shipping,breaker,staff,owner',
  'THE FLOOR COMES FIRST — a rotation is about who is packing and who is on camera, not about who outranks whom',
  groups.map((g: any) => g.role).join(',')
)
ok(groups[0].label === 'Shipping', 'headings use the role labels people already know', groups[0].label)
ok(groups[0].people.length === 2, 'two shipping people', String(groups[0].people.length))
ok(
  groups[0].people.map((p: any) => p.firstName).join(',') === 'Ada,Ben',
  'sorted by first name inside a heading',
  groups[0].people.map((p: any) => p.firstName).join(',')
)
ok(
  !groups.some((g: any) => g.role === 'operations'),
  'A HEADING NOBODY IS UNDER IS NOT DRAWN — on a floor of a dozen people that would be most of the screen'
)
ok(groupByRole([]).length === 0, 'nobody is no headings')

// A role added later and forgotten in the order list still appears, at the end,
// rather than vanishing off a screen somebody schedules from.
const withStranger = groupByRole([person('Zed', 'auditor' as any), person('Ada', 'shipping')])
ok(withStranger.length === 2, 'an unknown role still gets a heading')
ok(
  withStranger[withStranger.length - 1].role === 'auditor',
  'AND SORTS LAST rather than being dropped',
  withStranger[withStranger.length - 1].role
)
ok(
  ROTATION_ROLE_ORDER[0] === 'shipping',
  'the order is stated in one place, not derived from rank',
  ROTATION_ROLE_ORDER.join(',')
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. hours, and the ones that cannot be counted ===')
// ---------------------------------------------------------------------------
ok(
  totalShiftMinutes([{ startTime: '16:00', endTime: '20:00' }]) === 240,
  'four hours is four hours',
  String(totalShiftMinutes([{ startTime: '16:00', endTime: '20:00' }]))
)
ok(
  totalShiftMinutes([{ startTime: '21:00', endTime: '01:00' }]) === 240,
  'and a show that wraps after midnight is four hours, not minus twenty',
  String(totalShiftMinutes([{ startTime: '21:00', endTime: '01:00' }]))
)
ok(
  totalShiftMinutes([{ startTime: '16:00', endTime: null }]) === 0,
  'A SHIFT WITH NO END CONTRIBUTES NOTHING — inventing eight hours would put a figure nobody agreed to in a column people read as pay'
)
ok(totalShiftMinutes([]) === 0, 'nothing is nothing')
ok(hoursLabel(0) === '—', 'zero prints as a dash, not as "0h"', hoursLabel(0))
ok(hoursLabel(480) === '8h', 'whole hours print plainly', hoursLabel(480))
ok(hoursLabel(390) === '6h 30m', 'and part hours say the minutes', hoursLabel(390))
ok(hoursLabel(45) === '45m', 'under an hour is minutes alone', hoursLabel(45))

// ---------------------------------------------------------------------------
console.log('\n=== 3. WHAT STILL OWES SOMEBODY A MESSAGE ===')
// ---------------------------------------------------------------------------
ok(
  shiftNeedsPublishing({ publishedAt: null, updatedAt: '2026-08-20T10:00:00.000Z' }) === true,
  'never published is unsent'
)
ok(
  shiftNeedsPublishing({
    publishedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z'
  }) === false,
  'published and untouched is sent'
)
ok(
  shiftNeedsPublishing({
    publishedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-21T09:00:00.000Z'
  }) === true,
  'PUBLISHED AND THEN MOVED IS UNSENT — they are holding an answer that is no longer true and no reason to check'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. the migration hazard, from both ends ===')
// ---------------------------------------------------------------------------
// FIRST: prove the hazard is real. A row whose published_at is NULL — which is
// the shape every pre-existing shift would have had — is invisible to the person
// it is about.
db.prepare(
  `INSERT INTO shifts (id, employee_id, shift_date, start_time, end_time, note,
                       published_at, created_by, created_at, updated_at)
   VALUES ('legacy_1', ?, ?, '16:00', '20:00', NULL, NULL, NULL,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run(ADA, MON)
ok(
  !sched.myShifts(ADA).some((s: any) => s.id === 'legacy_1'),
  'A ROW WITH NO PUBLISHED STAMP IS INVISIBLE — which is exactly what every existing shift would have become'
)
ok(
  sched.listShifts(MON, SUN).some((s: any) => s.id === 'legacy_1'),
  'though the lead still sees it, because the lead has to see what is there'
)

// SECOND: prove it stays fixed. The backfill is the one line standing between
// this release and every packer's schedule emptying, and it is exactly the kind
// of line a later tidy-up deletes as "a migration that does nothing".
const migration = read('src/main/db/database.ts')
ok(
  migration.includes("addColumnIfMissing(database, 'shifts', 'published_at', 'TEXT')"),
  'the column is added by the migration'
)
ok(
  /UPDATE shifts SET published_at = created_at WHERE published_at IS NULL/.test(migration),
  'AND EVERY PRE-EXISTING SHIFT IS BACKFILLED AS PUBLISHED — without this line the update empties every packer’s schedule silently'
)
ok(
  /runOnce\(database, 'shifts_published_backfill_v1'/.test(migration),
  'runOnce, so a week deliberately left in draft is not published by a restart'
)
db.prepare(`DELETE FROM shifts WHERE id = 'legacy_1'`).run()

// ---------------------------------------------------------------------------
console.log('\n=== 5. a new shift is a DRAFT ===')
// ---------------------------------------------------------------------------
const made = sched.createShift({ employeeId: ADA, day: MON, startTime: '16:00', endTime: '22:00' }, OWEN)
ok(made.publishedAt === null, 'a shift somebody just typed is not published', String(made.publishedAt))
ok(sched.myShifts(ADA).length === 0, 'AND IS ON NOBODY’S PHONE — the floor sees the answer, not the working out')
ok(
  sched.listShifts(MON, SUN).some((s: any) => s.id === made.id),
  'while the lead building the week can see it'
)
ok(
  sched.unpublishedShifts(MON, SUN).length === 1,
  'and it counts as owing somebody a message',
  String(sched.unpublishedShifts(MON, SUN).length)
)

sched.createShift({ employeeId: BEN, day: TUE, startTime: '14:00', endTime: '22:00' }, OWEN)
sched.createShift({ employeeId: CAI, day: TUE, startTime: '18:00', endTime: null }, OWEN)

// ---------------------------------------------------------------------------
console.log('\n=== 6. publishing, and what it hands back ===')
// ---------------------------------------------------------------------------
const out = sched.publishShifts(MON, SUN)
ok(out.length === 3, 'all three drafts publish', String(out.length))
ok(
  out.every((s: any) => !!s.publishedAt),
  'AND COME BACK STAMPED — the caller has to tell each person, and asking again would find nothing'
)
ok(
  out.every((s: any) => !!s.employeeName),
  'carrying the name, so a message can be addressed'
)
ok(sched.myShifts(ADA).length === 1, 'now it is on her phone', String(sched.myShifts(ADA).length))
ok(sched.myShifts(BEN).length === 1, 'and his')
ok(sched.unpublishedShifts(MON, SUN).length === 0, 'and nothing is owed')

ok(
  sched.publishShifts(MON, SUN).length === 0,
  'PUBLISHING TWICE TELLS NOBODY TWICE — the second press is a no-op, not a second round of notifications'
)

// An edit to a published shift stays VISIBLE — the worst thing this screen can
// show somebody already told they are in at 4pm is the old time — but it owes
// them a message again.
const moved = sched.createShift(
  { employeeId: ADA, day: MON, startTime: '18:00', endTime: '22:00' },
  OWEN
)
ok(moved.publishedAt !== null, 'moving a published shift does not un-publish it', String(moved.publishedAt))
ok(
  sched.myShifts(ADA)[0].startTime === '18:00',
  'SO SHE SEES THE NEW TIME IMMEDIATELY, never the old one',
  String(sched.myShifts(ADA)[0].startTime)
)
ok(
  sched.unpublishedShifts(MON, SUN).length === 1,
  'AND IT OWES HER A MESSAGE AGAIN — this is the case a boolean cannot express',
  String(sched.unpublishedShifts(MON, SUN).length)
)
ok(
  sched.publishShifts(MON, SUN).length === 1,
  'which the next publish sends, and only that one'
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. a copied week is a draft ===')
// ---------------------------------------------------------------------------
// Copying last week is the FIRST step in building this one, not the last. A copy
// that published itself would tell the floor about a week nobody has looked at.
const NEXT_MON = '2026-08-31'
const NEXT_SUN = '2026-09-06'
const copied = sched.copyWeek(MON, NEXT_MON, OWEN)
ok(copied === 3, 'three shifts copied forward', String(copied))
ok(
  sched.unpublishedShifts(NEXT_MON, NEXT_SUN).length === 3,
  'ALL OF THEM DRAFTS — copying is where building a week starts',
  String(sched.unpublishedShifts(NEXT_MON, NEXT_SUN).length)
)
ok(
  sched.myShifts(ADA).every((s: any) => s.day !== NEXT_MON),
  'so next week is not on her phone yet'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. the line that lands on a lock screen ===')
// ---------------------------------------------------------------------------
const week = [
  { day: '2026-08-25', startTime: '14:00', endTime: '22:00', note: 'Pack bench with Ada' },
  { day: '2026-08-24', startTime: '16:00', endTime: '22:00', note: null }
]
const line = describeOwnWeek(week)
ok(
  line.indexOf('24 Aug') >= 0 && line.indexOf('24 Aug') < line.indexOf('25 Aug'),
  'days come out in order whatever order they went in',
  line
)
ok(line.includes('2 shifts'), 'it says how many', line)
ok(line.includes('14h'), 'and how long they come to', line)
ok(
  !line.includes('Pack bench'),
  'A NOTE NEVER TRAVELS — this is read on a phone lying face-up on a packing bench, not by one person',
  line
)
ok(describeOwnWeek([]) === 'Nothing this week.', 'an empty week says so rather than printing a stray dash')
ok(
  describeOwnWeek([{ day: '2026-08-24', startTime: '16:00', endTime: '22:00' }]).includes('1 shift'),
  'one shift is singular'
)
ok(
  describeOwnWeek([{ day: '2026-08-24', startTime: null, endTime: null }]).includes(
    'Time to be confirmed'
  ),
  'a day with no time says so instead of printing nothing'
)

// The relay trims the body at 300 characters, so a long week has to stop itself
// rather than be cut mid-word into something that reads as a different time.
const busy = Array.from({ length: 7 }, (_, i) => ({
  day: `2026-08-2${4 + i}`,
  startTime: '16:00',
  endTime: '22:00'
}))
const long = describeOwnWeek(busy, 60)
ok(long.length < 140, 'a long week is trimmed rather than sent whole', String(long.length))
ok(long.includes('more'), 'AND SAYS WHAT DID NOT FIT, so the last thing read is not half of Thursday', long)
ok(long.includes('7 shifts'), 'while still saying how many there really are', long)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
