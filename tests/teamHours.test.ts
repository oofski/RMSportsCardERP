/**
 * The Team tab's period picker, which for a long time picked nothing.
 *
 * The owner's report: "in the pay module under the team tab, when I actually
 * click the different options for filtering — this week, last week, last
 * fourteen days — it doesn't actually change the number of hours."
 *
 * ## Why this was worse than a dead control
 *
 * `hoursSummary()` took no arguments and summed EVERY time entry ever recorded.
 * So the picker moved, the state moved, and the figures underneath did not —
 * they were lifetime totals wearing a fortnight's label.
 *
 * The dangerous half is what else was on that screen. "Export team to Gusto"
 * DID honour the picker. So the operator read one number on screen and sent a
 * different one to payroll, and nothing anywhere said the two were answers to
 * different questions. Section 3 is that assertion: the figure on the table and
 * the figure in the export are now the same number, for the same window.
 *
 * ## The two things the fix had to avoid breaking
 *
 * The window goes on the JOIN, not on a WHERE — on a WHERE, an employee with no
 * hours in the period drops out of the result entirely and the team list would
 * shrink and grow as the period changed. Section 2.
 *
 * And the bound has to be the one `listInRange` already uses — filed by when
 * the shift STARTED, end exclusive — or the totals and the timesheet land a
 * shift apart on exactly the night-shift days people care about. Section 4.
 *
 * Every name here is invented.
 *
 * Run: npm run test:team-hours
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/teamhours-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const employees = require('../src/main/db/employees')
const te = require('../src/main/db/timeEntries')
const { computePayroll, gustoCsv } = require('../src/main/services/csv')
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

const hire = (first: string, companyId: string): string => {
  const res = employees.insertEmployee(
    {
      firstName: first,
      lastName: 'Invented',
      companyId,
      title: 'Packer',
      email: '',
      role: 'staff',
      status: 'active'
    },
    null,
    'a-long-enough-password',
    false
  )
  return res.employee.id
}

const ADA = hire('Ada', 'RM-100')
const BEN = hire('Ben', 'RM-200')
// Exists only to be clocked in at the exact instant two windows meet.
const CAI = hire('Cai', 'RM-300')

/**
 * A shift on a local day.
 *
 * Local, deliberately: the picker's periods are built from local midnights (see
 * lib/payperiod), so a fixture written at a UTC hour would drift in and out of
 * the window depending on the machine's offset. The suite pins TZ to
 * America/Chicago, and this builds the same kind of instant the clock does.
 */
const shift = (employeeId: string, day: string, fromHour: number, hours: number): void => {
  const start = new Date(`${day}T00:00:00`)
  start.setHours(fromHour, 0, 0, 0)
  const end = new Date(start)
  end.setMinutes(end.getMinutes() + hours * 60)
  te.insertTimeEntry({
    employeeId,
    clockIn: start.toISOString(),
    clockOut: end.toISOString()
  })
}

const localMidnight = (day: string): string => new Date(`${day}T00:00:00`).toISOString()

// Ada works in two different weeks; Ben works in only one of them.
shift(ADA, '2026-03-02', 9, 8) // Monday
shift(ADA, '2026-03-03', 9, 8) // Tuesday
shift(ADA, '2026-03-10', 9, 6) // the following Tuesday
shift(BEN, '2026-03-10', 9, 5)

const WEEK_ONE = { start: localMidnight('2026-03-02'), end: localMidnight('2026-03-09') }
const WEEK_TWO = { start: localMidnight('2026-03-09'), end: localMidnight('2026-03-16') }
const BOTH = { start: localMidnight('2026-03-02'), end: localMidnight('2026-03-16') }

const forEmployee = (rows: any[], id: string): any => rows.find((r) => r.employeeId === id)

// ---------------------------------------------------------------------------
console.log('=== 1. THE PICKER CHANGES THE NUMBER ===')
// ---------------------------------------------------------------------------
const one = te.hoursSummary(WEEK_ONE.start, WEEK_ONE.end)
const two = te.hoursSummary(WEEK_TWO.start, WEEK_TWO.end)
const both = te.hoursSummary(BOTH.start, BOTH.end)

ok(forEmployee(one, ADA).totalMinutes === 16 * 60, 'week one is Ada’s two eight-hour days', String(forEmployee(one, ADA).totalMinutes))
ok(forEmployee(two, ADA).totalMinutes === 6 * 60, 'week two is her six-hour day', String(forEmployee(two, ADA).totalMinutes))
ok(
  forEmployee(one, ADA).totalMinutes !== forEmployee(two, ADA).totalMinutes,
  'AND THE TWO ARE DIFFERENT — which is the entire bug report'
)
ok(forEmployee(both, ADA).totalMinutes === 22 * 60, 'a window covering both adds up', String(forEmployee(both, ADA).totalMinutes))

ok(forEmployee(one, ADA).entryCount === 2, 'the entry count is bounded too', String(forEmployee(one, ADA).entryCount))
ok(forEmployee(two, ADA).entryCount === 1, 'and moves with the window', String(forEmployee(two, ADA).entryCount))

// The team total on the stat tile is the sum of the rows, so it moves with them.
const teamMinutes = (rows: any[]): number => rows.reduce((n, r) => n + r.totalMinutes, 0)
ok(teamMinutes(one) === 16 * 60, 'the team total for week one', String(teamMinutes(one)))
ok(teamMinutes(two) === 11 * 60, 'and for week two — Ada’s six plus Ben’s five', String(teamMinutes(two)))

// ---------------------------------------------------------------------------
console.log('\n=== 2. somebody who did not work still appears, with a zero ===')
// ---------------------------------------------------------------------------
// The window is on the JOIN rather than a WHERE. On a WHERE, Ben would vanish
// from week one entirely and the roster would shrink and grow as the period
// changed — which reads as an employee being deleted.
const benWeekOne = forEmployee(one, BEN)
ok(!!benWeekOne, 'BEN IS STILL ON THE LIST IN A WEEK HE DID NOT WORK')
ok(benWeekOne.totalMinutes === 0, 'with no hours against him', String(benWeekOne.totalMinutes))
ok(benWeekOne.entryCount === 0, 'and no entries', String(benWeekOne.entryCount))
ok(one.length === two.length, 'so the roster is the same length in both windows', `${one.length} vs ${two.length}`)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the screen and the export now agree ===')
// ---------------------------------------------------------------------------
// The assertion that matters most. These are two independent code paths — the
// table reads hoursSummary, the export reads listInRange through computePayroll
// — and before the fix they answered different questions on the same screen.
for (const [label, period] of [
  ['week one', WEEK_ONE],
  ['week two', WEEK_TWO],
  ['both weeks', BOTH]
] as Array<[string, { start: string; end: string }]>) {
  const table = te.hoursSummary(period.start, period.end)
  for (const id of [ADA, BEN]) {
    const onScreen = forEmployee(table, id).totalMinutes
    const exported = computePayroll(te.listInRange(period.start, period.end, id)).totalMinutes
    ok(
      onScreen === exported,
      `${label}: the table and the Gusto export agree for ${id === ADA ? 'Ada' : 'Ben'}`,
      `${onScreen} vs ${exported}`
    )
  }
}

// And through the real file, end to end.
const sheet = gustoCsv(
  [ADA, BEN].map((id) => ({
    employee: employees.getEmployeeById(id),
    totals: computePayroll(te.listInRange(WEEK_TWO.start, WEEK_TWO.end, id))
  })),
  WEEK_TWO.start,
  WEEK_TWO.end
)
ok(sheet.includes('6.00'), 'the exported sheet carries Ada’s six hours for week two', sheet)
ok(sheet.includes('5.00'), 'and Ben’s five')
ok(!sheet.includes('16.00'), 'AND NOT THE 16 HOURS FROM A WEEK THAT WAS NOT SELECTED')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the bound is the one the rest of the app uses ===')
// ---------------------------------------------------------------------------
// End EXCLUSIVE, and filed by when the shift STARTED. A night shift beginning
// at 22:00 on the last day of a period belongs to that period, all of it, even
// though most of the hours fall after midnight — because that is how
// listInRange files it, and the timesheet a person opens is built from that.
shift(ADA, '2026-03-15', 22, 4) // Sunday night, running into Monday
const closing = te.hoursSummary(WEEK_TWO.start, WEEK_TWO.end)
ok(
  forEmployee(closing, ADA).totalMinutes === 10 * 60,
  'A SHIFT STARTING BEFORE THE BOUNDARY COUNTS IN FULL — six plus four',
  String(forEmployee(closing, ADA).totalMinutes)
)
ok(
  forEmployee(closing, ADA).totalMinutes ===
    computePayroll(te.listInRange(WEEK_TWO.start, WEEK_TWO.end, ADA)).totalMinutes,
  'and the export files that night the same way'
)
// The first instant of the next window does not double-count it.
const next = te.hoursSummary(localMidnight('2026-03-16'), localMidnight('2026-03-23'))
ok(
  forEmployee(next, ADA).totalMinutes === 0,
  'and the following week does not claim it too',
  String(forEmployee(next, ADA).totalMinutes)
)

// THE BOUNDARY INSTANT ITSELF, which is the case an inclusive end bound gets
// wrong. A shift clocking in at exactly the moment one window ends and the next
// begins belongs to ONE of them. With `<=` it would be counted in both, and a
// fortnight's payroll would quietly pay somebody twice for the same night.
shift(CAI, '2026-03-16', 0, 3) // clock-in is exactly WEEK_TWO's exclusive end
const caiClosing = te.hoursSummary(WEEK_TWO.start, WEEK_TWO.end)
const caiNext = te.hoursSummary(localMidnight('2026-03-16'), localMidnight('2026-03-23'))
ok(
  forEmployee(caiClosing, CAI).totalMinutes === 0,
  'A SHIFT AT THE EXACT BOUNDARY IS NOT IN THE WINDOW THAT ENDS THERE',
  String(forEmployee(caiClosing, CAI).totalMinutes)
)
ok(
  forEmployee(caiNext, CAI).totalMinutes === 3 * 60,
  'it belongs to the window that starts there',
  String(forEmployee(caiNext, CAI).totalMinutes)
)
ok(
  forEmployee(caiClosing, CAI).totalMinutes + forEmployee(caiNext, CAI).totalMinutes === 3 * 60,
  'so consecutive periods add up to the shift exactly once — never twice'
)
// And the export files it the same way, or the screen and the file disagree at
// precisely the boundary payroll is run on.
ok(
  computePayroll(te.listInRange(WEEK_TWO.start, WEEK_TWO.end, CAI)).totalMinutes === 0,
  'the export agrees it is not in the closing window'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. no window still means all time ===')
// ---------------------------------------------------------------------------
// Admin → Hours has no period picker, so its all-time reading is the honest one
// and must not have changed underneath it.
const all = te.hoursSummary()
ok(forEmployee(all, ADA).totalMinutes === 26 * 60, 'every hour Ada has logged', String(forEmployee(all, ADA).totalMinutes))
ok(forEmployee(all, BEN).totalMinutes === 5 * 60, 'and every hour Ben has', String(forEmployee(all, BEN).totalMinutes))
ok(
  te.hoursSummary(undefined, undefined).length === all.length,
  'an explicitly empty range is the same as none'
)
// A half-given range is not a half-applied filter.
ok(
  te.hoursSummary(WEEK_ONE.start, undefined)[0].totalMinutes ===
    forEmployee(all, te.hoursSummary(WEEK_ONE.start, undefined)[0].employeeId).totalMinutes,
  'and a start with no end falls back to all time rather than filtering on half a bound'
)

// An open shift — clocked in, not yet out — contributes no minutes but is a
// real entry, in every window. Unchanged by this, and worth pinning.
te.insertTimeEntry({ employeeId: BEN, clockIn: localMidnight('2026-03-10'), clockOut: null })
const withOpen = te.hoursSummary(WEEK_TWO.start, WEEK_TWO.end)
ok(forEmployee(withOpen, BEN).totalMinutes === 5 * 60, 'an open shift adds no hours', String(forEmployee(withOpen, BEN).totalMinutes))
ok(forEmployee(withOpen, BEN).entryCount === 2, 'but is counted as an entry', String(forEmployee(withOpen, BEN).entryCount))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
