/**
 * Scheduled-stream reminders, at the level where they can actually be wrong.
 *
 * The crypto that carries these is already covered by tests/webPush.test.ts —
 * this suite is about the half that decides WHETHER to send, and that half has
 * exactly two ways to fail, both of them silent:
 *
 *   · It sends the same reminder over and over. A cron re-examines the same show
 *     every five minutes, so the naive version of this feature buzzes a dozen
 *     times an hour, after which everybody mutes the app — and the clock-in
 *     notifications, which share the permission, go with it. Nothing errors.
 *   · It sends nothing. A window narrower than the cron interval leaves gaps a
 *     show can fall through, and the only evidence is somebody eventually
 *     mentioning that they never get reminded. Nothing errors here either.
 *
 * So the two central tests are properties rather than examples: over EVERY start
 * offset within a cron period, every show gets exactly one hour-reminder and
 * exactly one quarter-hour reminder — never zero, never two — including when
 * invocations overlap, when the relay has been down, and when a show is moved.
 *
 * ## And the duplication this is really guarding
 *
 * cloud/worker.js is PASTED into a Cloudflare dashboard and can import nothing,
 * so it carries a hand-copied mirror of src/shared/streamReminders.ts. A
 * hand-copied rule drifts. Section 7 runs both copies over the same cases and
 * fails the moment they disagree — including walking every role in
 * @shared/permissions through both admin checks, so the day somebody grants a
 * new role admin access in the app and not in the Worker, this says so.
 *
 * No fixture is a real person, a real show or a real key. Every name is invented.
 *
 * Run: npm run test:reminders
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

import {
  REMINDER_CRON_MINUTES,
  REMINDER_LEADS,
  REMINDER_WINDOW_MINUTES,
  buildStreamReminderPayload,
  dueReminders,
  grantsAdminAccess,
  impliedZoneOffsetMinutes,
  isValidDayKey,
  isValidLocalTime,
  reminderDue,
  reminderKey,
  reminderLookaheadMinutes,
  reminderRecipients,
  type ReminderCandidate
} from '@shared/streamReminders'
import { ROLES, roleHas } from '@shared/permissions'

/* eslint-disable @typescript-eslint/no-var-requires */
// The Worker itself, not a reimplementation of it. The named exports on that
// file exist so this suite can reach the code that actually ships.
const worker = require('../cloud/worker.js')
const {
  STREAM_REMINDER_LEADS,
  STREAM_REMINDER_WINDOW_MINUTES,
  buildStreamReminderPayload: workerBuildPayload,
  grantsAdminAccess: workerGrantsAdminAccess,
  pushTtlUntil,
  streamReminderDue,
  streamReminderKey,
  streamReminderLookaheadMinutes,
  streamReminderRecipients,
  streamRemindersDue
} = worker

// cwd, not __dirname: this file is bundled to out/tests before it runs, so
// __dirname points into the build output rather than at the repository.
const PUBLIC_DIR = join(process.cwd(), 'src/renderer/public')

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

const MIN = 60_000
/** An arbitrary but fixed Friday evening. Nothing here depends on the real clock. */
const SHOW = Date.parse('2026-08-21T01:00:00.000Z')

function plan(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    id: 'plan-1',
    title: 'Friday Night Rip',
    startsAt: new Date(SHOW).toISOString(),
    hostId: 'emp-host',
    status: 'planned',
    ...over
  }
}

// ---------------------------------------------------------------------------
console.log('\n1. Wall clock and instant — the conversion, and what checks it')
// ---------------------------------------------------------------------------
// A planned show is "9:00 PM on Friday", an intention. "One hour before" is an
// instant. The conversion happens once, in the browser; main cannot repeat it
// (in the web build it is a server, possibly in another zone) so all it can do
// is check that what it was handed is a PLAUSIBLE conversion of the pair beside
// it. This section pins what that check does and does not prove.

ok(isValidDayKey('2026-08-21') && !isValidDayKey('2026-13-01'), 'a day key is validated, month included')
ok(isValidDayKey('2026-08-21') && !isValidDayKey('21/08/2026'), 'and only in the one format')
ok(isValidLocalTime('21:00') && !isValidLocalTime('25:00'), 'a local time is validated, hour included')
ok(!isValidLocalTime('9:00'), 'and demands two digits, so "9:00" cannot mean 09 or 21')

// UTC-04:00 — a summer evening on the east coast. 21:00 local is 01:00 UTC next day.
ok(
  impliedZoneOffsetMinutes('2026-08-20', '21:00', '2026-08-21T01:00:00.000Z') === 240,
  'the instant beside a wall clock implies the offset it was converted in',
  String(impliedZoneOffsetMinutes('2026-08-20', '21:00', '2026-08-21T01:00:00.000Z'))
)
ok(
  impliedZoneOffsetMinutes('2026-08-21', '21:00', '2026-08-21T21:00:00.000Z') === 0,
  'UTC is a real offset and passes — which is exactly what this check cannot catch'
)
ok(
  impliedZoneOffsetMinutes('2026-08-21', '21:00', '2026-08-24T01:00:00.000Z') === null,
  'but an instant three days from its own wall clock is refused'
)
ok(
  impliedZoneOffsetMinutes('2026-08-21', '21:00', 'not-a-date') === null,
  'and so is one that cannot be read at all'
)
ok(
  impliedZoneOffsetMinutes('2026-08-21', '21:00', '2026-08-21T21:00:30.000Z') === null,
  'a half-minute gap is not a timezone and is refused'
)
// Nepal is UTC+05:45 and India is UTC+05:30. A check that only allowed whole
// hours would refuse a legitimate conversion from either. Sign follows
// getTimezoneOffset: minutes to add to LOCAL to get UTC, so east of Greenwich
// is negative.
ok(
  impliedZoneOffsetMinutes('2026-08-21', '21:00', '2026-08-21T15:15:00.000Z') === -345,
  'a 45-minute zone is still a zone',
  String(impliedZoneOffsetMinutes('2026-08-21', '21:00', '2026-08-21T15:15:00.000Z'))
)

// ---------------------------------------------------------------------------
console.log('\n2. The window — never early, never stale')
// ---------------------------------------------------------------------------

ok(reminderDue(SHOW - 60 * MIN, SHOW, 60), 'the hour reminder is due at exactly T-60')
ok(!reminderDue(SHOW - 60 * MIN - 1, SHOW, 60), 'and not one millisecond before it')
ok(
  reminderDue(SHOW - 60 * MIN + REMINDER_WINDOW_MINUTES * MIN - 1, SHOW, 60),
  'it is still due at the last millisecond of its window'
)
ok(
  !reminderDue(SHOW - 60 * MIN + REMINDER_WINDOW_MINUTES * MIN, SHOW, 60),
  'and not at the first millisecond after it — a late reminder is a false one'
)
ok(!reminderDue(SHOW - 20 * MIN, SHOW, 60), 'a cron catching up 40 minutes late does not fire the hour one')
ok(reminderDue(SHOW - 15 * MIN, SHOW, 15), 'the quarter-hour reminder is due at T-15')
ok(!reminderDue(SHOW, SHOW, 15), 'nothing fires once the show has started')
ok(!reminderDue(SHOW + 60 * MIN, SHOW, 60), 'and nothing fires an hour after it started')
ok(!reminderDue(Number.NaN, SHOW, 60), 'an unreadable clock fires nothing')
ok(!reminderDue(SHOW - 60 * MIN, Number.NaN, 60), 'and neither does an unreadable start')

// THE INVARIANT THAT MAKES THE WHOLE THING WORK. A window narrower than the cron
// interval leaves gaps that a show can start in the middle of, and the failure is
// total silence for that show.
ok(
  REMINDER_WINDOW_MINUTES >= REMINDER_CRON_MINUTES,
  'the window is at least one cron interval wide, or shows fall through the gaps',
  `window ${REMINDER_WINDOW_MINUTES}, cron ${REMINDER_CRON_MINUTES}`
)
ok(
  REMINDER_WINDOW_MINUTES < Math.min(...REMINDER_LEADS),
  'and narrower than the shortest lead, so no window can outlive the start it precedes'
)

// ---------------------------------------------------------------------------
console.log('\n3. What is due, and the four refusals')
// ---------------------------------------------------------------------------

const atT60 = SHOW - 60 * MIN
ok(dueReminders([plan()], atT60).length === 1, 'one show, one reminder at T-60')
ok(dueReminders([plan()], atT60)[0].lead === 60, 'and it is the hour one')
ok(dueReminders([plan()], SHOW - 15 * MIN)[0].lead === 15, 'the quarter-hour one at T-15')
ok(dueReminders([plan()], SHOW - 40 * MIN).length === 0, 'nothing at all between the two windows')

ok(dueReminders([plan({ status: 'cancelled' })], atT60).length === 0, 'a cancelled show is never reminded about')
ok(dueReminders([plan({ status: 'started' })], atT60).length === 0, 'nor one somebody already started')
ok(dueReminders([plan({ startsAt: 'whenever' })], atT60).length === 0, 'nor one whose start cannot be read')
ok(
  dueReminders([plan({ startsAt: new Date(SHOW - 5 * 60 * MIN).toISOString() })], atT60).length === 0,
  'nor one that started five hours ago'
)

// Two shows five minutes apart, at a tick where BOTH hour windows are open.
const twoShows = dueReminders(
  [
    plan({ id: 'later', startsAt: new Date(SHOW + 5 * MIN).toISOString() }),
    plan({ id: 'sooner' })
  ],
  SHOW - 52 * MIN
)
ok(
  twoShows.length === 2 && twoShows[0].scheduleId === 'sooner',
  'with a budget to spend, the show closest to going live comes first',
  twoShows.map((r) => r.scheduleId).join(',')
)

ok(
  reminderLookaheadMinutes() === Math.max(...REMINDER_LEADS) + REMINDER_WINDOW_MINUTES,
  'the relay looks exactly as far ahead as the longest window reaches'
)

// ---------------------------------------------------------------------------
console.log('\n4. Sent exactly once — the property, not an example')
// ---------------------------------------------------------------------------
// A stand-in for the relay: `sent` is push_reminders_sent, and refusing a key
// already in it is the primary-key INSERT failing. Everything about the
// once-only guarantee is in these four lines.
function makeRelay() {
  const sent = new Set<string>()
  const log: Array<{ key: string; lead: number }> = []
  return {
    tick(rows: ReminderCandidate[], nowMs: number): void {
      for (const r of dueReminders(rows, nowMs)) {
        if (sent.has(r.key)) continue
        sent.add(r.key)
        log.push({ key: r.key, lead: r.lead })
      }
    },
    log
  }
}

/** Cron ticks on the wall-clock five-minute marks, which is where they land. */
function ticks(fromMs: number, toMs: number): number[] {
  const step = REMINDER_CRON_MINUTES * MIN
  const out: number[] = []
  for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) out.push(t)
  return out
}

// EVERY start offset inside one cron period. This is the test that would have
// caught a window narrower than the interval: some offsets simply never get a
// tick inside their window, and only a sweep finds them.
let missed = 0
let doubled = 0
for (let offsetSeconds = 0; offsetSeconds < REMINDER_CRON_MINUTES * 60; offsetSeconds += 1) {
  const start = SHOW + offsetSeconds * 1000
  const relay = makeRelay()
  const rows = [plan({ startsAt: new Date(start).toISOString() })]
  for (const t of ticks(start - 3 * 60 * MIN, start + 60 * MIN)) relay.tick(rows, t)
  const sixty = relay.log.filter((e) => e.lead === 60).length
  const fifteen = relay.log.filter((e) => e.lead === 15).length
  if (sixty === 0 || fifteen === 0) missed += 1
  if (sixty > 1 || fifteen > 1) doubled += 1
}
ok(missed === 0, 'every possible start time gets both reminders', `${missed} start(s) got fewer`)
ok(doubled === 0, 'and no start time gets either of them twice', `${doubled} start(s) got more`)

// Two cron invocations overlapping is a thing Cloudflare permits, and a slow
// push service makes it likely.
const overlap = makeRelay()
const overlapRows = [plan()]
overlap.tick(overlapRows, atT60)
overlap.tick(overlapRows, atT60)
overlap.tick(overlapRows, atT60 + MIN)
ok(overlap.log.length === 1, 'a cron that overlaps itself still sends once', String(overlap.log.length))

// Ten laptops pulling the same unchanged row is the ordinary case, and it must
// be silent.
const resync = makeRelay()
for (const t of ticks(atT60, atT60 + 9 * MIN)) resync.tick([plan()], t)
ok(resync.log.length === 1, 'a row that re-syncs unchanged inside the window sends once', String(resync.log.length))

// The relay was down. Its hour reminder is stale and must be dropped; the short
// one is still ahead of the show and must not be.
const late = makeRelay()
late.tick([plan()], SHOW - 25 * MIN)
ok(late.log.length === 0, 'a relay waking up 35 minutes late fires no stale hour reminder')
for (const t of ticks(SHOW - 15 * MIN, SHOW)) late.tick([plan()], t)
ok(late.log.length === 1 && late.log[0].lead === 15, 'but the quarter-hour one still goes out on time')

// ---------------------------------------------------------------------------
console.log('\n5. Moving a show re-arms it; correcting its title does not')
// ---------------------------------------------------------------------------

const moved = makeRelay()
const original = plan()
moved.tick([original], atT60)
ok(moved.log.length === 1, 'the hour reminder for the original time went out')

// Same show, same lead, a title correction. The key is unchanged, so nothing
// fires again — which is the whole reason a resync is silent.
moved.tick([{ ...original, title: 'Friday Night Rip (rescheduled from Thursday)' }], atT60 + MIN)
ok(moved.log.length === 1, 'correcting the title sends nothing new')

// Now the show actually moves, two hours later. The earlier reminder was about a
// time that is no longer true, so this one has to be told about again.
const newStart = SHOW + 2 * 60 * MIN
const movedRow = { ...original, startsAt: new Date(newStart).toISOString() }
for (const t of ticks(newStart - 65 * MIN, newStart)) moved.tick([movedRow], t)
ok(moved.log.length === 3, 'moving it re-arms both reminders', String(moved.log.length))
ok(
  reminderKey('a', '2026-08-21T01:00:00.000Z', 60) !== reminderKey('a', '2026-08-21T03:00:00.000Z', 60),
  'because the start instant is part of the key'
)
ok(
  reminderKey('a', '2026-08-21T01:00:00.000Z', 60) !== reminderKey('a', '2026-08-21T01:00:00.000Z', 15),
  'and so is which reminder it is'
)
ok(
  reminderKey('a', '2026-08-21T01:00:00.000Z', 60) !== reminderKey('b', '2026-08-21T01:00:00.000Z', 60),
  'and which show'
)

// A show started between ticks stops reminding, without needing its key.
const started = makeRelay()
started.tick([plan()], SHOW - 20 * MIN)
for (const t of ticks(SHOW - 15 * MIN, SHOW)) started.tick([plan({ status: 'started' })], t)
ok(started.log.length === 0, 'a show started before its short reminder is never nagged about it')

// ---------------------------------------------------------------------------
console.log('\n6. Who hears about it')
// ---------------------------------------------------------------------------

ok(
  reminderRecipients(['admin-a', 'admin-b'], 'emp-host').length === 3,
  'every admin, plus a host who is not one of them'
)
ok(
  reminderRecipients(['admin-a', 'emp-host'], 'emp-host').length === 2,
  'a host who IS an admin is told once, not twice'
)
ok(reminderRecipients(['admin-a'], null).length === 1, 'a show with no host still reaches the admins')
ok(reminderRecipients([], 'emp-host')[0] === 'emp-host', 'and a host with no admins anywhere still hears')
ok(reminderRecipients(['', '  ', 'admin-a'], null).length === 1, 'blank ids are not people')
ok(reminderRecipients(['admin-a', 'admin-a'], null).length === 1, 'and a duplicated admin is still one person')

// The permission the app already gates its admin screens on — not a second list.
ok(grantsAdminAccess('owner', null), 'an owner is an admin')
ok(grantsAdminAccess('operations', null), 'so is operations')
ok(!grantsAdminAccess('staff', null), 'staff is not')
ok(!grantsAdminAccess('shipping', null), 'nor is shipping')
ok(
  grantsAdminAccess('staff', JSON.stringify(['admin.access'])),
  'but a packer granted admin.access by hand IS one — that is what the override is for'
)
ok(!grantsAdminAccess('staff', JSON.stringify(['module.inventory'])), 'an unrelated override grants nothing')
ok(!grantsAdminAccess('staff', '{not json'), 'a permissions blob that will not parse is not a grant')
ok(!grantsAdminAccess('nonsense-role', null), 'and an unrecognised role gets the narrowest answer there is')

// ---------------------------------------------------------------------------
console.log('\n7. The Worker and the app agree — the hand-copied mirror')
// ---------------------------------------------------------------------------
// cloud/worker.js is pasted into a dashboard and can import nothing, so it
// carries its own copy of every rule above. This is what stops the two drifting.

ok(
  JSON.stringify([...STREAM_REMINDER_LEADS]) === JSON.stringify([...REMINDER_LEADS]),
  'the two copies remind at the same two lead times',
  `${JSON.stringify(STREAM_REMINDER_LEADS)} vs ${JSON.stringify(REMINDER_LEADS)}`
)
ok(
  STREAM_REMINDER_WINDOW_MINUTES === REMINDER_WINDOW_MINUTES,
  'and use the same window',
  `${STREAM_REMINDER_WINDOW_MINUTES} vs ${REMINDER_WINDOW_MINUTES}`
)
ok(
  streamReminderLookaheadMinutes() === reminderLookaheadMinutes(),
  'and look the same distance ahead'
)

let dueDrift = 0
for (const lead of REMINDER_LEADS) {
  for (let delta = -125 * MIN; delta <= 10 * MIN; delta += 30_000) {
    const now = SHOW + delta
    if (reminderDue(now, SHOW, lead) !== streamReminderDue(now, SHOW, lead)) dueDrift += 1
  }
}
ok(dueDrift === 0, 'both copies open and close each window at the same instant', `${dueDrift} disagreements`)

const caseTable: ReminderCandidate[] = [
  plan(),
  plan({ id: 'p2', status: 'cancelled' }),
  plan({ id: 'p3', status: 'started' }),
  plan({ id: 'p4', startsAt: 'nonsense' }),
  plan({ id: 'p5', hostId: null }),
  plan({ id: 'p6', startsAt: new Date(SHOW + 30 * MIN).toISOString() })
]
let dueListDrift = 0
for (let delta = -125 * MIN; delta <= 40 * MIN; delta += 60_000) {
  const now = SHOW + delta
  const a = JSON.stringify(dueReminders(caseTable, now))
  const b = JSON.stringify(streamRemindersDue(caseTable, now))
  if (a !== b) dueListDrift += 1
}
ok(dueListDrift === 0, 'and pick the same reminders out of the same table', `${dueListDrift} disagreements`)

ok(
  reminderKey('p', '2026-08-21T01:00:00.000Z', 60) === streamReminderKey('p', '2026-08-21T01:00:00.000Z', 60),
  'and file a sent reminder under the same key — a mismatch here would double every reminder once'
)

// The one that matters most: the Worker hard-codes the roles because it cannot
// read the permission table. This walks every role the app defines through both.
const roleDrift: string[] = []
for (const role of ROLES) {
  const expected = roleHas(role.id, 'admin.access')
  if (workerGrantsAdminAccess(role.id, null) !== expected) roleDrift.push(role.id)
  if (grantsAdminAccess(role.id, null) !== expected) roleDrift.push(role.id + ' (shared)')
}
ok(
  roleDrift.length === 0,
  'every role in @shared/permissions resolves the same way in the Worker as in the app',
  roleDrift.join(', ')
)
ok(
  workerGrantsAdminAccess('staff', JSON.stringify(['admin.access'])),
  'and the Worker honours an individual grant, not just the role'
)
ok(
  streamReminderRecipients(['admin-a', 'emp-host'], 'emp-host').length === 2,
  'and de-duplicates the host the same way'
)

// ---------------------------------------------------------------------------
console.log('\n8. What travels, and how long it stays true')
// ---------------------------------------------------------------------------

const payload = buildStreamReminderPayload({
  scheduleId: 'plan-1',
  title: 'Friday Night Rip',
  startsAt: new Date(SHOW).toISOString(),
  lead: 60
})
ok(payload.kind === 'stream', 'the payload names itself so the phone can tell it from a punch')
ok(payload.at === new Date(SHOW).toISOString(), 'and carries the start as a UTC INSTANT, not a wall clock')
ok(payload.id === 'plan-1', 'with the plan id, so both reminders for one show share a tag')
ok(
  buildStreamReminderPayload({ scheduleId: 'x', title: '   ', startsAt: '', lead: 15 }).title === 'Stream',
  'an untitled show still says something'
)
ok(
  buildStreamReminderPayload({ scheduleId: 'x', title: 'y'.repeat(500), startsAt: '', lead: 15 }).title.length <= 80,
  'and a title nobody could read is cut to something a lock screen can hold'
)
ok(
  JSON.stringify(payload) ===
    JSON.stringify(
      workerBuildPayload({
        scheduleId: 'plan-1',
        title: 'Friday Night Rip',
        startsAt: new Date(SHOW).toISOString(),
        lead: 60
      })
    ),
  'and the Worker builds the identical object'
)

// A push service holds an undelivered notification for its TTL. "Start the
// stream" delivered after the stream should have started is not a reminder.
ok(
  pushTtlUntil(new Date(SHOW).toISOString(), SHOW - 15 * MIN) === 15 * 60,
  'a reminder expires exactly when the show starts',
  String(pushTtlUntil(new Date(SHOW).toISOString(), SHOW - 15 * MIN))
)
ok(
  pushTtlUntil(new Date(SHOW).toISOString(), SHOW) === 60,
  'never zero, because zero means deliver-now-or-never and a phone may be between towers'
)
ok(pushTtlUntil('not a date') > 0, 'and an unreadable start falls back rather than expiring instantly')

// ---------------------------------------------------------------------------
console.log('\n9. The diary, against a real database')
// ---------------------------------------------------------------------------
// Everything above is arithmetic. This is the part that decides whether the
// relay ever SEES a planned show, and whether a plan can break the thing it
// sits next to.
/* eslint-disable @typescript-eslint/no-var-requires */
const DB_DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/stream-schedule-db')
process.env.TEST_DB_DIR = DB_DIR
rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

const { getDb } = require('../src/main/db/database')
const {
  cancelScheduled,
  listUpcoming,
  rescheduleStream,
  scheduleStream,
  startScheduled
} = require('../src/main/db/streamSchedule')
const { getActiveSession, endSession, startSession } = require('../src/main/db/streaming')

const db = getDb()
const stamp = new Date().toISOString()
db.prepare(
  `INSERT INTO employees (id, first_name, last_name, company_id, title, email, role, status,
                          must_change_password, created_at, updated_at)
   VALUES ('emp-host', 'Wren', 'Ashgrove', 'RM-901', 'Host', 'wren@example.invalid', 'staff',
           'active', 0, ?, ?)`
).run(stamp, stamp)

/** A local day + HH:MM `days` from now, and the instant the browser would send. */
function future(days: number, hh: number, mm = 0): { day: string; time: string; iso: string } {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(hh, mm, 0, 0)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(hh)}:${pad(mm)}`,
    iso: d.toISOString()
  }
}

const friday = future(3, 21)
const made = scheduleStream(
  {
    title: 'Friday Night Rip',
    streamDate: friday.day,
    startTime: friday.time,
    startsAt: friday.iso,
    hostId: 'emp-host',
    note: null
  },
  'emp-host'
)
ok(made.ok === true, 'a show can be put in the diary', made.error || '')
ok(made.data?.startTime === friday.time, 'and keeps the wall clock it was typed in', made.data?.startTime)
ok(made.data?.startsAt === friday.iso, 'beside the instant the browser resolved it to')
ok(made.data?.hostName === 'Wren Ashgrove', 'with the host resolved for display', String(made.data?.hostName))

// THE WHOLE FEATURE DEPENDS ON THIS. The relay can only remind about rows that
// reach it, and rows reach it because a capture trigger queued them.
const queued = db
  .prepare("SELECT id FROM sync_outbox WHERE kind = 'stream_schedule' AND id = ?")
  .get(made.data?.id)
ok(!!queued, 'and it is queued for the relay — a plan the relay never sees is never announced')

ok(
  scheduleStream(
    { title: 'Last week', streamDate: '2020-01-01', startTime: '21:00', startsAt: '2020-01-02T02:00:00.000Z', hostId: null, note: null },
    null
  ).ok === false,
  'a start in the past is refused — it could never be reminded about'
)
ok(
  scheduleStream(
    { title: 'Muddled', streamDate: friday.day, startTime: friday.time, startsAt: new Date(Date.parse(friday.iso) + 3 * 86_400_000).toISOString(), hostId: null, note: null },
    null
  ).ok === false,
  'and so is an instant that is not a conversion of the wall clock beside it'
)

ok(listUpcoming().some((p: { id: string }) => p.id === made.data?.id), 'it shows up as upcoming')

// The argument for a separate table, tested rather than asserted: a plan with no
// end time would run to the end of time under the overlap rule, and parking it
// in stream_sessions would refuse Start stream from now on.
const live = startSession({ title: 'Something unrelated', hostId: null, note: null }, null)
ok(live.ok === true, 'a planned show does not block Start stream', live.error || '')
endSession(live.data.id, null)

const startedPlan = startScheduled(made.data?.id, 'emp-host')
ok(startedPlan.ok === true, 'going live on a plan works', startedPlan.error || '')
const nowLive = getActiveSession()
ok(nowLive?.title === 'Friday Night Rip', 'the session takes the plan’s title', String(nowLive?.title))
ok(nowLive?.hostId === 'emp-host', 'and its host')
// The plan said nine o'clock; the show went on now. The record has to be what
// happened, and the plan keeps its own intention.
ok(
  nowLive && Math.abs(Date.parse(nowLive.startedAt) - Date.now()) < 60_000,
  'but starts NOW, not at the planned time — the record is what happened'
)
ok(
  !listUpcoming().some((p: { id: string }) => p.id === made.data?.id),
  'and it drops out of upcoming, so nothing reminds about a show already on air'
)
ok(startScheduled(made.data?.id, null).ok === false, 'starting it twice is refused')
endSession(nowLive.id, null)

const saturday = future(4, 20, 30)
const second = scheduleStream(
  { title: 'Saturday', streamDate: saturday.day, startTime: saturday.time, startsAt: saturday.iso, hostId: null, note: null },
  null
)
const movedTo = future(4, 22)
const rescheduled = rescheduleStream(
  { id: second.data?.id, streamDate: movedTo.day, startTime: movedTo.time, startsAt: movedTo.iso },
  null
)
ok(rescheduled.ok === true && rescheduled.data?.startsAt === movedTo.iso, 'a show can be moved')
ok(rescheduled.data?.title === 'Saturday', 'and keeps everything that was not touched')

ok(cancelScheduled(second.data?.id, null).ok === true, 'and it can be called off')
ok(
  !listUpcoming().some((p: { id: string }) => p.id === second.data?.id),
  'after which it stops being upcoming — and stops being reminded about'
)
const kept = db.prepare('SELECT status FROM stream_schedule WHERE id = ?').get(second.data?.id)
ok(kept?.status === 'cancelled', 'though the row survives, so "did we cancel Saturday" is answerable')

// ---------------------------------------------------------------------------
// 10. The phone draws it.
//
// Wrapped in an async IIFE rather than using top-level await: this file is
// bundled to CJS to run under plain Node, and a CJS bundle has no top level to
// await at.
// ---------------------------------------------------------------------------

interface FakeNotification {
  title: string
  options: Record<string, unknown>
}
const notifications: FakeNotification[] = []
const listeners: Record<string, Array<(e: Record<string, unknown>) => void>> = {}
const workerSelf = {
  addEventListener: (type: string, fn: (e: Record<string, unknown>) => void): void => {
    ;(listeners[type] = listeners[type] || []).push(fn)
  },
  skipWaiting: (): void => {},
  registration: {
    showNotification: async (title: string, options: Record<string, unknown>): Promise<void> => {
      notifications.push({ title, options })
    }
  },
  clients: {
    claim: async (): Promise<void> => {},
    matchAll: async (): Promise<unknown[]> => [],
    openWindow: async (): Promise<unknown> => ({})
  }
}
vm.runInNewContext(readFileSync(join(PUBLIC_DIR, 'sw.js'), 'utf8'), { self: workerSelf, console })

async function firePush(payloadIn: unknown): Promise<void> {
  const waits: Array<Promise<unknown>> = []
  const event = { data: { json: () => payloadIn }, waitUntil: (p: Promise<unknown>) => waits.push(p) }
  for (const fn of listeners.push || []) fn(event)
  await Promise.all(waits)
}

void (async (): Promise<void> => {
  console.log('\n10. The phone draws it')

  const soon = new Date(Date.now() + 47 * MIN).toISOString()
  await firePush({ v: 1, kind: 'stream', id: 'plan-1', title: 'Friday Night Rip', at: soon, lead: 60 })
  const drawn = notifications[notifications.length - 1]
  ok(String(drawn.title).includes('Friday Night Rip'), 'the show is named in the title', drawn.title)
  // Computed from the instant against the phone's own clock, NOT from `lead`. A
  // push can sit in Apple's queue for minutes, and "in an hour" drawn forty
  // minutes later is a lie the phone was in a position not to tell.
  ok(/in 4[5-9] minutes/.test(String(drawn.title)), 'counted down from the instant, not from the lead', drawn.title)
  ok(
    /start the stream on the rm operations app/i.test(String(drawn.options.body)),
    'and the body says what to do about it',
    String(drawn.options.body)
  )
  ok(/\d{1,2}:\d{2}/.test(String(drawn.options.body)), 'with the start time in the phone’s own timezone')

  const before = notifications.length
  await firePush({ v: 1, kind: 'stream', id: 'plan-1', title: 'Friday Night Rip', at: soon, lead: 15 })
  ok(
    notifications[before].options.tag === drawn.options.tag,
    'the second reminder REPLACES the first rather than stacking two about one show'
  )
  ok(notifications[before].options.renotify === true, 'audibly, or the short warning goes unnoticed')

  await firePush({ v: 1, kind: 'stream', id: 'other', title: 'Friday Night Rip', at: soon, lead: 60 })
  ok(
    notifications[notifications.length - 1].options.tag !== drawn.options.tag,
    'while a different show with the same name gets its own tag'
  )

  // A reminder that sat in a queue past the start still has to draw something: a
  // push handler that displays nothing eventually costs the site its permission.
  await firePush({
    v: 1,
    kind: 'stream',
    id: 'late',
    title: 'Friday Night Rip',
    at: new Date(Date.now() - 20 * MIN).toISOString(),
    lead: 15
  })
  const stale = notifications[notifications.length - 1]
  ok(
    /was due to start/.test(String(stale.title)),
    'and one delivered late says so instead of counting down',
    stale.title
  )

  // The clock notifications must not have changed underneath this.
  await firePush({ v: 1, kind: 'in', name: 'Marisol Vandenberg', at: new Date().toISOString() })
  ok(
    String(notifications[notifications.length - 1].title).includes('clocked in'),
    'a clock-in still reads exactly as it did'
  )

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
})()
