/**
 * The jobs the app works out for itself.
 *
 * Nearly all of this file is date arithmetic, which is the part that is easy to
 * get subtly wrong and impossible to notice: a fortnightly job that slips a day
 * per cycle looks fine for a month. So the series is pinned against hand-checked
 * dates rather than against itself.
 *
 * The owner's own example is the fixture: payroll every second Wednesday,
 * anchored on Wednesday 5 August 2026.
 *
 * Run: npm run test:home-tasks
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/hometasks-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const tasks = require('../src/main/db/homeTasks')
const {
  addDays,
  daysBetween,
  nextOccurrence,
  recurringDue,
  recurringLabel,
  validateRecurring
} = require('../src/shared/homeTasks')
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

// ---------------------------------------------------------------------------
console.log('=== 1. the day maths, hand-checked ===')
// ---------------------------------------------------------------------------
ok(daysBetween('2026-08-05', '2026-08-19') === 14, 'a fortnight is 14 days')
ok(daysBetween('2026-08-19', '2026-08-05') === -14, 'and -14 the other way')
ok(addDays('2026-08-05', 14) === '2026-08-19', 'adding a fortnight lands on the 19th')
// Month and year ends, which is where naive arithmetic gives up.
ok(addDays('2026-08-31', 1) === '2026-09-01', 'the end of a month rolls over')
ok(addDays('2026-12-31', 1) === '2027-01-01', 'and the end of a year')
ok(addDays('2026-02-28', 1) === '2026-03-01', '2026 is not a leap year')
ok(addDays('2028-02-28', 1) === '2028-02-29', 'and 2028 is')
// THE DAYLIGHT-SAVING TRAP. US clocks go forward on 8 March 2026 and back on 1
// November. A date-only string parsed as LOCAL midnight and shifted across
// either boundary can land on 23:00 the day before and round down a day; every
// key here is parsed at UTC noon, twelve hours from either edge.
ok(daysBetween('2026-03-07', '2026-03-09') === 2, 'across the spring forward')
ok(daysBetween('2026-10-31', '2026-11-02') === 2, 'and across the fall back')
ok(addDays('2026-03-07', 1) === '2026-03-08', 'and a single day either side of it')
ok(addDays('2026-10-31', 1) === '2026-11-01', 'both ways')

// ---------------------------------------------------------------------------
console.log('\n=== 2. every second Wednesday, from 05/08/2026 ===')
// ---------------------------------------------------------------------------
const ANCHOR = '2026-08-05'
// Hand-checked against a calendar. All Wednesdays, 14 days apart.
ok(nextOccurrence(ANCHOR, 14, '2026-08-05') === '2026-08-05', 'the anchor day IS an occurrence')
ok(nextOccurrence(ANCHOR, 14, '2026-08-06') === '2026-08-19', 'the day after, the next is the 19th')
ok(nextOccurrence(ANCHOR, 14, '2026-08-19') === '2026-08-19', 'and the 19th is itself')
ok(nextOccurrence(ANCHOR, 14, '2026-09-01') === '2026-09-02', 'then the 2nd of September')
ok(nextOccurrence(ANCHOR, 14, '2026-12-25') === '2027-01-06', 'and the series crosses the year')
// Backwards from the anchor: "every second Wednesday from the 5th" is a series
// in both directions, so a date entered for next month means the same one.
ok(nextOccurrence(ANCHOR, 14, '2026-07-01') === '2026-07-08', 'it runs backwards too')
// Every occurrence must still be a Wednesday. A single day of drift anywhere in
// the series is the whole bug this checks for.
let cursor = ANCHOR
let allWednesdays = true
for (let i = 0; i < 26; i++) {
  cursor = nextOccurrence(ANCHOR, 14, addDays(cursor, 1))
  if (new Date(`${cursor}T12:00:00Z`).getUTCDay() !== 3) allWednesdays = false
}
ok(allWednesdays, 'a year of occurrences are all still Wednesdays', cursor)

// ---------------------------------------------------------------------------
console.log('\n=== 3. when it appears, and when it stops ===')
// ---------------------------------------------------------------------------
const payroll = {
  id: 'rt1',
  title: 'Run payroll',
  everyDays: 14,
  anchorDate: ANCHOR,
  leadDays: 2,
  lastDoneOn: null,
  active: true
}
ok(recurringDue(payroll, '2026-08-01') === null, 'four days out it is not asking yet')
ok(recurringDue(payroll, '2026-08-03')?.dueOn === '2026-08-05', 'two days out it appears')
ok(recurringDue(payroll, '2026-08-03')?.daysLate === -2, 'and says it is two days off')
ok(recurringLabel(recurringDue(payroll, '2026-08-03')) === 'Due in 2 days', 'in words')
ok(recurringLabel(recurringDue(payroll, '2026-08-04')) === 'Due tomorrow', 'and tomorrow')
ok(recurringLabel(recurringDue(payroll, '2026-08-05')) === 'Due today', 'and today')

// THE ONE THAT MATTERS. A payroll run missed on Wednesday is not less due on
// Thursday, and a job that quietly rolls forward to the next fortnight is
// exactly the failure a recurring reminder exists to prevent.
const late = recurringDue(payroll, '2026-08-10')
ok(late?.dueOn === '2026-08-05', 'five days later it is STILL asking for the 5th', String(late?.dueOn))
ok(late?.daysLate === 5, 'and says how late', String(late?.daysLate))
ok(recurringLabel(late) === '5 days overdue', 'in words')

// ---------------------------------------------------------------------------
console.log('\n=== 4. ticking one occurrence brings back the next ===')
// ---------------------------------------------------------------------------
const done = { ...payroll, lastDoneOn: '2026-08-05' }
ok(recurringDue(done, '2026-08-06') === null, 'ticked, it goes quiet for the cycle')
ok(recurringDue(done, '2026-08-16') === null, 'still quiet ten days later')
ok(recurringDue(done, '2026-08-17')?.dueOn === '2026-08-19', 'and returns two days before the next')
// Ticking Wednesday's payroll on Friday completes WEDNESDAY'S. Recording Friday
// would push the whole series two days out of step for ever.
const doneLate = { ...payroll, lastDoneOn: '2026-08-05' }
ok(
  recurringDue(doneLate, '2026-08-19')?.dueOn === '2026-08-19',
  'the series keeps its own dates whenever it was ticked'
)
ok(recurringDue({ ...payroll, active: false }, '2026-08-05') === null, 'a paused job asks nothing')

// A series is infinite in both directions, so the anchor is NOT a start date.
// A job made today against a date last year must not announce itself as
// twenty-six occurrences overdue — it asks for the occurrence that has just
// come round, and never more than one cycle of backlog.
const stale = recurringDue(payroll, '2027-01-01')
ok(stale !== null, 'a long-untouched job still asks')
ok(
  stale !== null && stale.daysLate < 14,
  'but never for more than one cycle of backlog',
  String(stale?.daysLate) + ' late, due ' + String(stale?.dueOn)
)
ok(
  stale !== null && new Date(`${stale.dueOn}T12:00:00Z`).getUTCDay() === 3,
  'and it is still a Wednesday',
  String(stale?.dueOn)
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. validation ===')
// ---------------------------------------------------------------------------
ok(validateRecurring({ title: '', everyDays: 14, anchorDate: ANCHOR }) !== null, 'a name is required')
ok(validateRecurring({ title: 'x', everyDays: 0, anchorDate: ANCHOR }) !== null, 'so is a real stride')
ok(validateRecurring({ title: 'x', everyDays: 14, anchorDate: '5 Aug' }) !== null, 'and a real date')
ok(validateRecurring({ title: 'Run payroll', everyDays: 14, anchorDate: ANCHOR }) === null, 'the real one passes')

// ---------------------------------------------------------------------------
console.log('\n=== 6. the same series through the database ===')
// ---------------------------------------------------------------------------
const mine = tasks.createRecurring('emp_owner', {
  title: 'Run payroll',
  everyDays: 14,
  anchorDate: ANCHOR,
  leadDays: 2
})
tasks.createRecurring('emp_other', { title: 'Not mine', everyDays: 7, anchorDate: ANCHOR })
ok(tasks.listRecurring('emp_owner').length === 1, 'one job on my list')
ok(
  !tasks.listRecurring('emp_owner').some((t: any) => t.title === 'Not mine'),
  "and nobody else's"
)
ok(tasks.recurringDueNow('emp_owner', '2026-08-05').length === 1, 'it is due on the day')
ok(tasks.recurringDueNow('emp_owner', '2026-08-01').length === 0, 'and quiet four days out')

ok(tasks.completeRecurring('emp_owner', mine.id, '2026-08-05') === true, 'ticking the 5th works')
ok(tasks.recurringDueNow('emp_owner', '2026-08-06').length === 0, 'and it goes quiet')
ok(tasks.recurringDueNow('emp_owner', '2026-08-19').length === 1, 'then returns for the 19th')
// Scoped to the caller on every operation, same rule as the to-do list.
ok(tasks.completeRecurring('emp_other', mine.id, '2026-08-19') === false, 'somebody else cannot tick it')
ok(tasks.deleteRecurring('emp_other', mine.id) === false, 'nor delete it')
ok(tasks.deleteRecurring('emp_owner', mine.id) === true, 'but I can')

// ---------------------------------------------------------------------------
console.log('\n=== 7. a stream with no packing slip ===')
// ---------------------------------------------------------------------------
const db = getDb()
const dayOf = (back: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - back)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const isoOf = (back: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - back)
  d.setHours(21, 0, 0, 0)
  return d.toISOString()
}

ok(tasks.slipsOutstanding().length === 0, 'no streams, nothing to chase')

// A show three nights ago, and no import anywhere.
db.prepare(
  `INSERT INTO stream_sessions
     (id, title, started_at, ended_at, stream_date, status, source, created_at, updated_at)
   VALUES ('ss1', 'Thursday Night Rip', ?, ?, ?, 'ended', 'live', ?, ?)`
).run(isoOf(3), isoOf(3), dayOf(3), isoOf(3), isoOf(3))
const chasing = tasks.slipsOutstanding()
ok(chasing.length === 1, 'a show with no slip is a job', JSON.stringify(chasing))
ok(chasing[0].day === dayOf(3), 'named by its day', chasing[0]?.day)
ok(chasing[0].ageDays === 3, 'and how long it has been waiting', String(chasing[0]?.ageDays))
ok(chasing[0].title.includes(dayOf(3)), 'the title says which day', chasing[0]?.title)

// The slip arrives the NEXT MORNING, which is the normal case — nights end late.
db.prepare(
  `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts)
   VALUES ('imp1', 'Thu', 'slips.pdf', 'pdf', ?, '{}')`
).run(isoOf(2))
ok(tasks.slipsOutstanding().length === 0, 'and a slip uploaded the next morning clears it')

// AN IMPORT THAT PREDATES THE SHOW CANNOT BE THAT SHOW'S SLIP.
// Uploading last night's slips this morning is the routine, so a day-level
// match let every morning upload silently clear that same evening's show — the
// signal failing in exactly the case it exists for.
db.prepare(`DELETE FROM ship_imports`).run()
db.prepare(
  `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts)
   VALUES ('imp_early', 'Morning', 'yesterday.pdf', 'pdf', ?, '{}')`
).run(
  (() => {
    const d = new Date()
    d.setDate(d.getDate() - 3)
    d.setHours(8, 0, 0, 0)
    return d.toISOString()
  })()
)
ok(
  tasks.slipsOutstanding().some((t: any) => t.day === dayOf(3)),
  'a file uploaded the MORNING of the show is not that show\'s slip'
)

// AND ONE UPLOAD CANNOT CLEAR THREE NIGHTS. Each import is claimed by the first
// show it can belong to; the rest stay on the list.
db.prepare(`DELETE FROM ship_imports`).run()
db.prepare(
  `INSERT INTO stream_sessions
     (id, title, started_at, ended_at, stream_date, status, source, created_at, updated_at)
   VALUES ('ss4', 'Night two', ?, ?, ?, 'ended', 'live', ?, ?)`
).run(isoOf(2), isoOf(2), dayOf(2), isoOf(2), isoOf(2))
db.prepare(
  `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts)
   VALUES ('imp_one', 'One', 'one.pdf', 'pdf', ?, '{}')`
).run(isoOf(1))
const twoNights = tasks.slipsOutstanding()
ok(
  twoNights.length === 1,
  'two shows and one upload leaves one still outstanding',
  JSON.stringify(twoNights.map((t: any) => t.day))
)
ok(twoNights[0].day === dayOf(2), 'and it is the night the upload did not cover', twoNights[0]?.day)

// The demo dataset is not a packing slip.
db.prepare(`DELETE FROM ship_imports`).run()
db.prepare(
  `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts)
   VALUES ('imp_demo', 'Demo', 'demo', 'demo', ?, '{}')`
).run(isoOf(2))
ok(
  tasks.slipsOutstanding().length >= 1,
  'loading the demo dataset does not clear real slip work',
  JSON.stringify(tasks.slipsOutstanding().map((t: any) => t.day))
)
db.prepare(`DELETE FROM ship_imports`).run()
db.prepare(`DELETE FROM stream_sessions WHERE id = 'ss4'`).run()
db.prepare(
  `INSERT INTO ship_imports (id, name, filename, kind, created_at, counts)
   VALUES ('imp1', 'Thu', 'slips.pdf', 'pdf', ?, '{}')`
).run(isoOf(2))

// TONIGHT'S show is not late. The night may not have finished.
db.prepare(
  `INSERT INTO stream_sessions
     (id, title, started_at, ended_at, stream_date, status, source, created_at, updated_at)
   VALUES ('ss2', 'Tonight', ?, NULL, ?, 'live', 'live', ?, ?)`
).run(isoOf(0), dayOf(0), isoOf(0), isoOf(0))
ok(
  !tasks.slipsOutstanding().some((t: any) => t.day === dayOf(0)),
  "tonight's own show is not chased yet"
)

// A show from months ago is history, not a task — a list that never empties is
// a list nobody reads.
db.prepare(
  `INSERT INTO stream_sessions
     (id, title, started_at, ended_at, stream_date, status, source, created_at, updated_at)
   VALUES ('ss3', 'Ancient', ?, ?, ?, 'ended', 'live', ?, ?)`
).run(isoOf(60), isoOf(60), dayOf(60), isoOf(60), isoOf(60))
ok(
  !tasks.slipsOutstanding().some((t: any) => t.day === dayOf(60)),
  'and a show from two months ago has fallen off'
)

// ---------------------------------------------------------------------------
console.log("\n=== 8. pay periods, and one person's own hours ===")
// ---------------------------------------------------------------------------
// THE FOUR DATES, exactly as the owner stated them:
//
//     work     Sun 02 Aug -> Sat 15 Aug
//     run on   Wed 19 Aug
//     paid on  Fri 21 Aug
//     next     Sun 16 Aug -> Sat 29 Aug
//
// This is what Gusto is handed. A period that ends on the day it is paid — the
// shape this used to have — exports a fortnight shifted three days off the one
// the hours were actually worked in, and nothing downstream can tell.
const {
  payrollPeriodFor,
  recentPayrollPeriods,
  lastClosedPayrollPeriod,
  PAYROLL_ANCHOR,
  PAYROLL_EVERY_DAYS,
  PAYROLL_RUN_LAG_DAYS,
  PAYROLL_PAY_LAG_DAYS
} = require('../src/shared/homeTasks')

ok(PAYROLL_ANCHOR === '2026-08-02', 'the series starts where the pay period does', PAYROLL_ANCHOR)
ok(PAYROLL_EVERY_DAYS === 14, 'a fortnight of work', String(PAYROLL_EVERY_DAYS))
ok(PAYROLL_RUN_LAG_DAYS === 4, 'run four days after it closes', String(PAYROLL_RUN_LAG_DAYS))
ok(PAYROLL_PAY_LAG_DAYS === 6, 'paid six days after it closes', String(PAYROLL_PAY_LAG_DAYS))

const p1 = payrollPeriodFor('2026-08-02')
ok(p1.start === '2026-08-02', 'the period opens on 2 August', p1.start)
ok(p1.end === '2026-08-15', 'and closes on the 15th — fourteen days of work', p1.end)
ok(p1.runOn === '2026-08-19', 'payroll is RUN on the 19th', p1.runOn)
ok(p1.paidOn === '2026-08-21', 'and the money lands on the 21st', p1.paidOn)

// The days of the week are the reason those two lags are 4 and 6 rather than
// arithmetic. If the anchor ever moves off a Sunday these break, which is the
// point.
const dow = (d: string): number => new Date(`${d}T12:00:00Z`).getUTCDay()
ok(dow(p1.start) === 0, 'a period starts on a Sunday')
ok(dow(p1.end) === 6, 'and closes on a Saturday')
ok(dow(p1.runOn) === 3, 'payroll runs on a Wednesday')
ok(dow(p1.paidOn) === 5, 'and pays on a Friday')

// The next period, stated by the owner as 16 Aug – 29 Aug.
const p2 = payrollPeriodFor('2026-08-16')
ok(p2.start === '2026-08-16', 'the next period opens on the 16th', p2.start)
ok(p2.end === '2026-08-29', 'and closes on the 29th', p2.end)
ok(p2.runOn === '2026-09-02', 'run on 2 September', p2.runOn)
ok(p2.paidOn === '2026-09-04', 'paid on the 4th', p2.paidOn)

// The boundary, both sides. Off by one here and somebody's last shift is paid a
// fortnight late.
ok(payrollPeriodFor('2026-08-15').start === '2026-08-02', 'the 15th still belongs to the first')
ok(payrollPeriodFor('2026-08-16').start === '2026-08-16', 'and the 16th opens the second')
ok(payrollPeriodFor('2026-08-01').start === '2026-07-19', 'the day before falls in the one before')

// THE RUN DATE IS NOT A BOUNDARY. 19 August is when payroll is run for the
// period that ENDED on the 15th — it sits in the middle of the period after it,
// and reading it as a start is exactly the old bug.
ok(
  payrollPeriodFor('2026-08-19').start === '2026-08-16',
  'the 19th is mid-period, not the start of one',
  payrollPeriodFor('2026-08-19').start
)

const recent = recentPayrollPeriods('2026-08-20', 3)
ok(recent.length === 3, 'three periods back', String(recent.length))
ok(recent[0].current === true, 'newest first, and it is the current one')
ok(recent[0].start === '2026-08-16', 'starting the 16th', recent[0].start)
ok(recent[1].start === '2026-08-02', 'then the 2nd', recent[1].start)
ok(recent[2].start === '2026-07-19', 'then the 19th of July', recent[2].start)
ok(
  recent.every((p: any) => dow(p.start) === 0),
  'and every period starts on a Sunday'
)
ok(
  recent.every((p: any) => p.runOn < p.paidOn && p.end < p.runOn),
  'with close, run and pay always in that order'
)

// "Last payroll" is the CLOSED fortnight, never the one being worked.
const closed = lastClosedPayrollPeriod('2026-08-20')
ok(closed.start === '2026-08-02', 'on 20 August the last closed period began 2 August', closed.start)
ok(closed.end === '2026-08-15', 'and ended on the 15th', closed.end)
ok(closed.paidOn === '2026-08-21', 'paid on the 21st — the day after this reading', closed.paidOn)
ok(
  lastClosedPayrollPeriod('2026-08-02').start === '2026-07-19',
  'and on the first day of a period it is the one before',
  lastClosedPayrollPeriod('2026-08-02').start
)

// One person's own hours. Scoped to them and taken from the session, never an
// argument — the same rule as the to-do list, for the same reason.
const meId = 'emp_dana_hours'
const stampNow = new Date().toISOString()
getDb()
  .prepare(
    `INSERT INTO employees
       (id, company_id, first_name, last_name, email, role, status, created_at, updated_at)
     VALUES (?, 'RM-HRS', 'Dana', 'Hours', 'dana.hours@none.invalid', 'shipping', 'active', ?, ?)`
  )
  .run(meId, stampNow, stampNow)

const shift = (id: string, back: number, hoursLong: number): void => {
  const start = new Date()
  start.setDate(start.getDate() - back)
  start.setHours(9, 0, 0, 0)
  const end = new Date(start.getTime() + hoursLong * 3600 * 1000)
  getDb()
    .prepare(
      `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, note, source, created_at)
       VALUES (?, ?, ?, ?, NULL, 'clock', ?)`
    )
    .run(id, meId, start.toISOString(), end.toISOString(), start.toISOString())
}
shift('th1', 1, 6)
shift('th2', 1, 2)
shift('th3', 40, 8)

const myOwn = tasks.myHours(meId)
ok(myOwn.totalMinutes === 16 * 60, 'every shift adds up', String(myOwn.totalMinutes))
ok(myOwn.days.length === 2, 'two days worked', String(myOwn.days.length))
// Two shifts in one day are ONE day with both in it, not two rows.
const yesterday = myOwn.days.find((d: any) => d.shifts === 2)
ok(!!yesterday, 'two shifts in a day merge into one day')
ok(yesterday?.minutes === 8 * 60, 'carrying both', String(yesterday?.minutes))
ok(myOwn.periods.length === 8, 'eight pay periods back', String(myOwn.periods.length))
ok(myOwn.periods[0].current === true, 'newest first')
ok(
  myOwn.periods.reduce((n: number, p: any) => n + p.minutes, 0) <= myOwn.totalMinutes,
  'and no period claims hours from outside itself'
)
ok(tasks.myHours('emp_nobody').totalMinutes === 0, "somebody else's hours are not mine")

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
