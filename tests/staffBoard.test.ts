/**
 * The floor's home board, and the rota behind one of its cards.
 *
 * Three things are checked here and they fail in three different ways:
 *
 *   1. THE CALENDAR MATHS. A rota is wall-clock — a local day plus a local
 *      HH:MM — and every bug this class has is invisible for eleven months.
 *      Month grids, daylight-saving boundaries and the Sunday-vs-Monday week
 *      start are all pinned against hand-checked dates.
 *
 *   2. THE ROTA IS SOMEBODY'S. `myShifts` takes an employee id the caller
 *      cannot choose. There is no operation anywhere that reads a NAMED
 *      person's shifts, and this asserts that one person's rota is not
 *      another's.
 *
 *   3. "TO SORT" MEANS ONE SPECIFIC THING. A package with a card not yet
 *      checked off. Not "not shipped", not "not packed", and never a held
 *      package — every one of those would tell a sorter there is work
 *      outstanding when their part is finished.
 *
 * Run: npm run test:staff-board
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/staffboard-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const schedule = require('../src/main/db/schedule')
const staffBoard = require('../src/main/db/staffBoard')
const {
  addMonths,
  dayLabel,
  formatClock,
  minutesOfDay,
  monthGrid,
  monthLabel,
  monthOf,
  shiftMinutes,
  shiftTimeLabel,
  sortShifts,
  validateShift
} = require('../src/shared/schedule')
const { dayKey, payrollPeriodFor } = require('../src/shared/homeTasks')
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

const stamp = new Date().toISOString()
const addPerson = (id: string, first: string, last: string, role = 'shipping'): void => {
  db.prepare(
    `INSERT INTO employees
       (id, company_id, first_name, last_name, email, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(id, `RM-${id.slice(-4)}`, first, last, `${id}@none.invalid`, role, stamp, stamp)
}

// ---------------------------------------------------------------------------
console.log('=== 1. the calendar maths, hand-checked ===')
// ---------------------------------------------------------------------------
ok(minutesOfDay('16:00') === 960, '16:00 is 960 minutes in')
ok(minutesOfDay('00:00') === 0, 'and midnight is zero — not falsy-null')
ok(minutesOfDay('24:00') === null, '24:00 is not a time of day')
ok(minutesOfDay('9:00') === null, 'nor is an unpadded hour')
ok(minutesOfDay(null) === null, 'and nothing is nothing')

ok(formatClock('16:00') === '4:00pm', 'four in the afternoon reads as 4:00pm')
ok(formatClock('00:30') === '12:30am', 'half past midnight is 12:30am, not 0:30am')
ok(formatClock('12:00') === '12:00pm', 'and noon is 12:00pm, not 0:00pm')
ok(formatClock('23:59') === '11:59pm', 'the last minute of the day')

ok(shiftMinutes({ startTime: '16:00', endTime: '21:30' }) === 330, 'a five-and-a-half hour shift')
// A show that goes on at nine and wraps at one is the normal night here. An end
// before the start is read as running past midnight, not as an error.
ok(shiftMinutes({ startTime: '21:00', endTime: '01:00' }) === 240, 'and one that runs past midnight')
ok(shiftMinutes({ startTime: '16:00', endTime: null }) === null, 'an open end cannot be measured')

ok(shiftTimeLabel({ startTime: '16:00', endTime: '21:30' }) === '4:00pm – 9:30pm', 'both ends read')
ok(shiftTimeLabel({ startTime: '16:00', endTime: null }) === 'From 4:00pm', 'one end reads')
ok(
  shiftTimeLabel({ startTime: null, endTime: null }) === 'Time to be confirmed',
  'and neither says so rather than showing a blank'
)

// THE MONTH GRID. Six weeks always, Sunday first, and the leading cells come
// from the month before rather than being blank — a grid that changes height
// makes everything under it jump when you page through.
const aug = monthGrid('2026-08')
ok(aug.length === 42, 'six weeks of cells', String(aug.length))
ok(aug.filter((c: any) => c.inMonth).length === 31, 'thirty-one days in August')
// 1 August 2026 is a Saturday, so the row starts on Sunday 26 July.
ok(aug[0].day === '2026-07-26', 'the grid opens on the Sunday before', aug[0].day)
ok(aug[6].day === '2026-08-01', 'and the 1st lands on the Saturday', aug[6].day)
ok(aug[6].inMonth === true && aug[5].inMonth === false, 'the boundary is where it should be')
const feb = monthGrid('2026-02')
ok(feb.filter((c: any) => c.inMonth).length === 28, '2026 February has 28 days')
ok(
  monthGrid('2028-02').filter((c: any) => c.inMonth).length === 29,
  'and 2028 has 29'
)
// THE DAYLIGHT-SAVING TRAP, in the grid this time. US clocks go forward on 8
// March 2026. Every cell is arithmetic on a UTC instant, so no cell may repeat
// or vanish across the boundary.
const mar = monthGrid('2026-03')
const marDays = new Set(mar.map((c: any) => c.day))
ok(marDays.size === 42, 'no cell repeats across the spring forward', String(marDays.size))
ok(
  mar.some((c: any) => c.day === '2026-03-08') && mar.some((c: any) => c.day === '2026-03-09'),
  'and no day is skipped'
)
const nov = monthGrid('2026-11')
ok(new Set(nov.map((c: any) => c.day)).size === 42, 'nor across the fall back')

ok(addMonths('2026-12', 1) === '2027-01', 'December rolls into January')
ok(addMonths('2026-01', -1) === '2025-12', 'and January back into December')
ok(addMonths('2026-08', 12) === '2027-08', 'a year on is the same month')
ok(monthOf('2026-08-19') === '2026-08', 'the month of a day')
ok(monthLabel('2026-08') === 'August 2026', 'and it reads in words')
// 19 August 2026 is a Wednesday — the payroll anchor's fortnight.
ok(dayLabel('2026-08-19') === 'Wed 19 Aug', 'a day reads with its weekday', dayLabel('2026-08-19'))

// ---------------------------------------------------------------------------
console.log('\n=== 2. what a shift may be ===')
// ---------------------------------------------------------------------------
ok(validateShift({ employeeId: '', day: '2026-08-19' }) !== null, 'a shift needs somebody')
ok(validateShift({ employeeId: 'e1', day: 'soon' }) !== null, 'and a real day')
ok(
  validateShift({ employeeId: 'e1', day: '2026-08-19', startTime: '25:00' }) !== null,
  'and a real time'
)
ok(validateShift({ employeeId: 'e1', day: '2026-08-19' }) === null, 'a day with no time is fine')
ok(
  validateShift({ employeeId: 'e1', day: '2026-08-19', endTime: '21:00' }) === null,
  'and so is an end with no start — "off at nine" is a real thing to put on a rota'
)
ok(
  validateShift({ employeeId: 'e1', day: '2026-08-19', note: 'x'.repeat(200) }) !== null,
  'a note has a limit'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the rota is somebody\'s ===')
// ---------------------------------------------------------------------------
addPerson('emp_pat', 'Pat', 'Ferrer')
addPerson('emp_robin', 'Robin', 'Oyelaran')
addPerson('emp_lead', 'Lee', 'Marchetti', 'operations')

const today = dayKey(new Date())
const plus = (n: number): string => {
  const t = Date.parse(`${today}T12:00:00Z`)
  return new Date(t + n * 86400000).toISOString().slice(0, 10)
}

schedule.createShift(
  { employeeId: 'emp_pat', day: plus(1), startTime: '16:00', endTime: '21:00', note: 'Pack bench' },
  'emp_lead'
)
schedule.createShift({ employeeId: 'emp_pat', day: plus(3), startTime: '17:00' }, 'emp_lead')
schedule.createShift({ employeeId: 'emp_robin', day: plus(1), startTime: '16:00' }, 'emp_lead')
// Already worked. It stays on the rota — history is history — but it is not
// "coming up".
schedule.createShift({ employeeId: 'emp_pat', day: plus(-4), startTime: '16:00' }, 'emp_lead')

const patAll = schedule.myShifts('emp_pat')
ok(patAll.length === 3, "Pat's whole rota is three shifts", String(patAll.length))
ok(
  patAll.every((s: any) => s.employeeId === 'emp_pat'),
  "and none of them are Robin's"
)
ok(patAll[0].day === plus(-4), 'oldest first', patAll[0].day)

const patNext = schedule.upcomingShifts('emp_pat')
ok(patNext.length === 2, 'two are still ahead', String(patNext.length))
ok(
  patNext.every((s: any) => s.day >= today),
  'and nothing behind us is offered as coming up'
)

// TODAY COUNTS AS AHEAD. Somebody opening the app at nine in the morning wants
// the four o'clock they are in for, and a cutoff at "after today" hides exactly
// the shift they most need.
schedule.createShift({ employeeId: 'emp_robin', day: today, startTime: '16:00' }, 'emp_lead')
ok(
  schedule.upcomingShifts('emp_robin').some((s: any) => s.day === today),
  "today's own shift is still coming up"
)

ok(schedule.myShifts('emp_nobody').length === 0, "a stranger's rota is empty")

// ADDING AGAIN REPLACES. The floor works one shift a night and the realistic way
// a second row appears is somebody clicking Add twice, which would put the same
// evening on the calendar twice with nothing to say which is right.
schedule.createShift(
  { employeeId: 'emp_pat', day: plus(1), startTime: '18:00', note: 'Breaking' },
  'emp_lead'
)
const patAfter = schedule.myShifts('emp_pat')
ok(patAfter.length === 3, 'adding the same day again does not make a second row', String(patAfter.length))
const moved = patAfter.find((s: any) => s.day === plus(1))
ok(moved?.startTime === '18:00', 'it corrects the time in place', String(moved?.startTime))
ok(moved?.note === 'Breaking', 'and the note with it')
ok(moved?.endTime === null, 'and clears what was not restated rather than keeping a stale end')

// Somebody who is not on the roster cannot be rostered. There is no foreign key
// on this table, so this check is the only thing standing between a typo'd id
// and a shift that appears on nobody's screen.
let refused = false
try {
  schedule.createShift({ employeeId: 'emp_ghost', day: plus(2) }, 'emp_lead')
} catch {
  refused = true
}
ok(refused, 'a shift for somebody who does not exist is refused')

// The team view carries names, and a shift whose person has gone still renders.
const week = schedule.listShifts(plus(-7), plus(7))
ok(week.length >= 4, 'the team view spans everybody', String(week.length))
ok(
  week.some((s: any) => s.employeeName === 'Pat Ferrer'),
  'with names attached'
)
db.prepare(`INSERT INTO shifts
   (id, employee_id, shift_date, start_time, end_time, note, created_by, created_at, updated_at)
   VALUES ('sh_orphan', 'emp_vanished', ?, '16:00', NULL, NULL, 'emp_lead', ?, ?)`).run(
  plus(2),
  stamp,
  stamp
)
const orphan = schedule.listShifts(plus(-7), plus(7)).find((s: any) => s.id === 'sh_orphan')
ok(!!orphan, 'a shift whose employee row is gone still renders')
ok(orphan?.employeeName === 'Someone', 'named honestly rather than dropped', orphan?.employeeName)
db.prepare(`DELETE FROM shifts WHERE id = 'sh_orphan'`).run()

// Sorting: by day, then by start, and an untimed shift sorts AFTER the timed
// ones on its day — it is the least specific thing on that line.
const mixed = sortShifts([
  { id: 'c', day: '2026-08-20', startTime: null, endTime: null },
  { id: 'b', day: '2026-08-19', startTime: '18:00', endTime: null },
  { id: 'a', day: '2026-08-19', startTime: '09:00', endTime: null },
  { id: 'd', day: '2026-08-19', startTime: null, endTime: null }
])
ok(mixed.map((s: any) => s.id).join('') === 'abdc', 'shifts sort by day then start', mixed.map((s: any) => s.id).join(''))

// ---------------------------------------------------------------------------
console.log('\n=== 4. copying a week ===')
// ---------------------------------------------------------------------------
// A fixed Monday, so the assertions do not depend on what day the suite runs.
db.prepare(`DELETE FROM shifts`).run()
const MON = '2026-08-03'
const NEXT_MON = '2026-08-10'
schedule.createShift({ employeeId: 'emp_pat', day: '2026-08-03', startTime: '16:00' }, 'emp_lead')
schedule.createShift({ employeeId: 'emp_pat', day: '2026-08-06', startTime: '16:00' }, 'emp_lead')
schedule.createShift({ employeeId: 'emp_robin', day: '2026-08-06', startTime: '17:00' }, 'emp_lead')
// Already on the target week, deliberately different. The copy must LEAVE IT
// ALONE: a row already there was put there on purpose, most likely because that
// week is the one that differs.
schedule.createShift({ employeeId: 'emp_pat', day: '2026-08-10', startTime: '12:00' }, 'emp_lead')

const made = schedule.copyWeek(MON, NEXT_MON, 'emp_lead')
ok(made === 2, 'two of the three shifts copy; the clash is skipped', String(made))
const nextWeek = schedule.listShifts(NEXT_MON, '2026-08-16')
ok(nextWeek.length === 3, 'the target week has three shifts', String(nextWeek.length))
const kept = nextWeek.find((s: any) => s.day === '2026-08-10')
ok(kept?.startTime === '12:00', 'and the one already there kept its own time', String(kept?.startTime))
// The weekday has to survive the copy — a shift on Thursday must land on
// Thursday, not seven days after whatever the row happened to say.
const copiedThursday = nextWeek.filter((s: any) => s.day === '2026-08-13')
ok(copiedThursday.length === 2, "Thursday's two shifts land on Thursday", String(copiedThursday.length))
ok(schedule.copyWeek('2026-01-05', '2026-01-12', 'emp_lead') === 0, 'copying an empty week does nothing')

// ---------------------------------------------------------------------------
console.log('\n=== 5. what "to sort" means ===')
// ---------------------------------------------------------------------------
const meId = 'emp_pat'
const board0 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId })
ok(board0.sorting?.imported === false, 'with no slip imported it says so')
ok(
  board0.sorting?.orders === 0 && board0.sorting?.cardsLeft === 0,
  'rather than claiming everything is sorted'
)

const customer = (id: string, handle: string): void => {
  db.prepare(
    `INSERT INTO ship_customers (id, whatnot_handle, real_name, address, is_new)
     VALUES (?, ?, ?, '1 Nowhere Lane', 0)`
  ).run(id, handle, handle)
}
const shipment = (id: string, cid: string, opts: { hold?: boolean; packed?: boolean } = {}): void => {
  db.prepare(
    `INSERT INTO ship_shipments (id, customer_id, status_code, on_hold, packed_at)
     VALUES (?, ?, 'not_shipped', ?, ?)`
  ).run(id, cid, opts.hold ? 1 : 0, opts.packed ? stamp : null)
}
let slotN = 0
const slot = (cid: string, breakId: string, checked: boolean): void => {
  db.prepare(
    `INSERT INTO ship_team_slots
       (id, break_id, break_number, team_name, customer_id, order_id, price, is_giveaway,
        top_sleeved, checked_off)
     VALUES (?, ?, 1, 'Boston Red Sox', ?, 'ord', 25, 0, 0, ?)`
  ).run(`slot_${++slotN}`, breakId, cid, checked ? 1 : 0)
}

customer('c_ana', 'anaruiz')
customer('c_ben', 'benokafor')
customer('c_hold', 'heldone')
customer('c_done', 'alldone')
shipment('sh_ana', 'c_ana')
shipment('sh_ben', 'c_ben')
shipment('sh_hold', 'c_hold', { hold: true })
shipment('sh_done', 'c_done')

slot('c_ana', 'break_1', false)
slot('c_ana', 'break_2', false)
slot('c_ana', 'break_1', true) // already sorted
slot('c_ben', 'break_2', false)
slot('c_hold', 'break_3', false) // HELD — not tonight's work
slot('c_done', 'break_1', true) // finished
db.prepare(`INSERT INTO ship_event (id, name, date, updated_at) VALUES (1, 'Friday Night Rip', '2026-08-14', ?)`).run(stamp)

const board1 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId })
const s1 = board1.sorting
ok(s1.imported === true, 'a slip has been imported')
ok(s1.orders === 2, 'two orders need sorting — not the held one, not the finished one', String(s1.orders))
ok(s1.cardsLeft === 3, 'three cards are still to check off', String(s1.cardsLeft))
// TWO breaks, not three. The held package's break is not tonight's work either.
ok(s1.breaks === 2, 'off two breaks — the held one does not count', String(s1.breaks))
ok(s1.cardsTotal === 5, 'out of five cards on the slip, held excluded', String(s1.cardsTotal))
ok(s1.eventDate === '2026-08-14', 'and it says which night it is from')
ok(s1.eventName === 'Friday Night Rip', 'by name too')

// Packing does not un-sort anything, but a packed order is no longer waiting on
// a sorter — its remaining cards belong to whoever packs, not whoever sorts.
db.prepare(`UPDATE ship_shipments SET packed_at = ? WHERE id = 'sh_ben'`).run(stamp)
const s2 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId }).sorting
ok(s2.orders === 1, 'a packed order drops off the sorting list', String(s2.orders))
ok(s2.cardsLeft === 2, 'and its cards with it', String(s2.cardsLeft))

// Somebody who cannot open the fulfilment module is not shown the pile.
const noFloor = staffBoard.getStaffBoard({ fulfillment: false, viewerId: meId })
ok(noFloor.sorting === null, 'without the module the card is null, not zero')

// ---------------------------------------------------------------------------
console.log('\n=== 6. this fortnight ===')
// ---------------------------------------------------------------------------
// The board's period must be the same fortnight payroll runs on. A figure that
// adds up over a different window from the one that pays is worse than none.
const period = payrollPeriodFor(today)
const hours0 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId }).hours
ok(hours0.start === period.start, 'the period is the payroll period', hours0.start)
ok(hours0.end === period.end, 'both ends', hours0.end)
ok(hours0.minutes === 0, 'and nothing worked is zero')
ok(hours0.onTheClock === false, 'nobody is on the clock')

const clock = (id: string, who: string, startsAt: Date, hoursLong: number | null): void => {
  const end = hoursLong === null ? null : new Date(startsAt.getTime() + hoursLong * 3600_000)
  db.prepare(
    `INSERT INTO time_entries (id, employee_id, clock_in, clock_out, note, source, created_at)
     VALUES (?, ?, ?, ?, NULL, 'clock', ?)`
  ).run(id, who, startsAt.toISOString(), end ? end.toISOString() : null, startsAt.toISOString())
}

// Two shifts today, one of them still open, plus one belonging to somebody else.
const at = (dayBack: number, hour: number): Date => {
  const d = new Date()
  d.setDate(d.getDate() - dayBack)
  d.setHours(hour, 0, 0, 0)
  return d
}
clock('te1', meId, at(0, 9), 3)
clock('te2', 'emp_robin', at(0, 9), 8)
const hours1 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId }).hours
ok(hours1.minutes === 180, "somebody else's shift is not mine", String(hours1.minutes))
ok(hours1.minutesToday === 180, 'and today reads the same')
ok(hours1.daysWorked === 1, 'one day in')

// AN OPEN SHIFT COUNTS WHAT IT HAS RUN. Somebody who clocked in an hour ago
// reading as having done nothing this fortnight is the bug this catches.
const openStart = new Date(Date.now() - 90 * 60_000)
clock('te3', meId, openStart, null)
const hours2 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId }).hours
ok(hours2.onTheClock === true, 'an open entry means on the clock')
ok(hours2.minutes >= 268 && hours2.minutes <= 272, 'and the running time counts', String(hours2.minutes))

// A shift OUTSIDE the period does not leak in. One a fortnight back is in the
// previous period by construction.
clock('te4', meId, at(15, 9), 8)
const hours3 = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId }).hours
ok(
  hours3.minutes === hours2.minutes,
  'a shift from the previous fortnight stays there',
  `${hours3.minutes} vs ${hours2.minutes}`
)

// And the board carries the person's OWN shifts, nobody else's.
db.prepare(`DELETE FROM shifts`).run()
schedule.createShift({ employeeId: meId, day: plus(2), startTime: '16:00' }, 'emp_lead')
schedule.createShift({ employeeId: 'emp_robin', day: plus(2), startTime: '16:00' }, 'emp_lead')
const mine = staffBoard.getStaffBoard({ fulfillment: true, viewerId: meId })
ok(mine.shifts.length === 1, 'one shift coming up', String(mine.shifts.length))
ok(mine.shifts[0].employeeId === meId, "and it is mine, not Robin's")
ok(mine.allShifts.length === 1, 'the calendar sees only mine too', String(mine.allShifts.length))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
