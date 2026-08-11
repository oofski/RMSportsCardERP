/**
 * THE BUSINESS CLOCK, and the bug it was written to end.
 *
 * A ledger row is an INSTANT; a show is a WALL CLOCK. Converting between them
 * needs a timezone, and the app used to use the RUNNING MACHINE's — which is
 * Central on the owner's laptop and UTC in the Render container. Sessions are
 * written by the browser (Central, always) while a CSV uploaded through that
 * browser is parsed by the server, so on the web every row landed five hours
 * before the show that earned it and a three-hour evening show matched none of
 * its own sales.
 *
 * FOUR THINGS ARE PINNED HERE.
 *
 *   1. The conversion itself, mutation-tested: each assertion is checked to FAIL
 *      against a deliberately broken conversion, so a green line means the
 *      assertion can actually see the bug.
 *   2. An evening show crossing midnight Central — the exact shape that failed.
 *   3. THE REGRESSION: the same session and the same CSV bytes attribute
 *      IDENTICALLY whether the process runs in Central or in UTC. This is the
 *      one that would otherwise come straight back via the web app, so it runs
 *      the whole scenario in two real child processes with different TZ and
 *      compares the results byte for byte.
 *   4. The historical repair: an instant already stored by a UTC import is
 *      corrected, and only because its own fingerprint proves what the file said.
 *
 * Run: npm run test:business-time
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mode. The parent spawns itself twice; each child runs the scenario in its own
// timezone and prints one canonical line the parent compares.
// ---------------------------------------------------------------------------
const CHILD = process.env.RMOPS_TZ_CHILD === '1'

const DIR =
  process.env.TEST_DB_DIR ||
  join(process.cwd(), `out/tests/business-time-db${CHILD ? `-${process.env.TZ ?? 'x'}` : ''}`)
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const {
  DEFAULT_BUSINESS_TIME_ZONE,
  businessDayOf,
  businessStamp,
  instantFromWallClock,
  isValidTimeZone,
  setBusinessTimeZone,
  wallClockOf,
  zoneOffsetMs
} = require('../src/shared/businessTime')
const { canonicalLedgerTimestamp, parseLedgerDate } = require('../src/shared/financeStreaming')
const { streamDateOf } = require('../src/shared/streaming')
const { createSession } = require('../src/main/db/streaming')
const { importLedgerText, reattributeAll, listRows } = require('../src/main/db/financeStreaming')
const { getDb } = require('../src/main/db/database')

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

const Z = 'America/Chicago'

// ---------------------------------------------------------------------------
// The scenario, shared by both children. Everything is Central wall clock,
// which is what Whatnot writes and what the owner types into the session form.
// ---------------------------------------------------------------------------
/** An instant from a Central wall clock, computed WITHOUT the process's zone. */
const central = (day: number, hour: number, minute = 0): string =>
  new Date(
    instantFromWallClock({ year: 2026, month: 8, day, hour, minute, second: 0 }, Z)
  ).toISOString()

/** "Aug 6, 2026, 6:20:00 PM" — the shape Whatnot writes, in Central. */
const whatnot = (day: number, hour: number, minute = 0): string => {
  const h = hour % 12 === 0 ? 12 : hour % 12
  const p = (n: number): string => String(n).padStart(2, '0')
  return `Aug ${day}, 2026, ${h}:${p(minute)}:00 ${hour < 12 ? 'AM' : 'PM'}`
}

interface Sale {
  day: number
  hour: number
  minute: number
  amount: number
}

/**
 * An evening show, 6pm–11:30pm Central on 7 Aug 2026. In UTC that is
 * 23:00 on the 7th to 04:30 on the 8th — it crosses midnight UTC while sitting
 * entirely inside one Central evening, which is precisely the shape that broke.
 */
const SHOW = { start: central(7, 18), end: central(7, 23, 30) }

const SALES: Sale[] = [
  { day: 7, hour: 18, minute: 30, amount: 120.0 },
  { day: 7, hour: 20, minute: 15, amount: 340.5 },
  { day: 7, hour: 22, minute: 45, amount: 88.25 },
  // After midnight UTC, still firmly inside the Central evening show.
  { day: 7, hour: 23, minute: 15, amount: 210.0 }
]

const csv = (): string => {
  const head =
    'Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date'
  const body = SALES.map((s, i) => {
    const when = whatnot(s.day, s.hour, s.minute)
    return [
      `"${when}"`,
      `$${s.amount.toFixed(2)}`,
      '2041799396',
      `ORD${i + 1}`,
      `Earnings for selling a 1x 2026 FINEST BASEBALL HOBBY BOX- Break #${i + 1} - Boston Red Sox`,
      'completed',
      'SALES',
      `"${when}"`
    ].join(',')
  })
  return [head, ...body].join('\r\n') + '\r\n'
}

/**
 * Log the show, import the sales, and report what stuck. The digest is what the
 * parent compares between the two zones.
 */
function runScenario(): string {
  const s = createSession({ title: 'Evening show', startedAt: SHOW.start, endedAt: SHOW.end }, null)
  if (!s.ok) return `SESSION-FAILED:${s.error}`
  const res = importLedgerText(csv(), 'ledger.csv', null)
  if (!res.ok) return `IMPORT-FAILED:${res.error}`
  const rows = listRows({}) as Array<{
    occurredAt: string
    streamDate: string | null
    attribution: string
    amount: number
  }>
  const attributed = rows.filter((r) => r.attribution === 'in_window')
  const cents = attributed.reduce((a, r) => a + Math.round(r.amount * 100), 0)
  const days = [...new Set(rows.map((r) => r.streamDate ?? 'none'))].sort().join('|')
  return [
    `rows=${rows.length}`,
    `inWindow=${attributed.length}`,
    `cents=${cents}`,
    `days=${days}`,
    `instants=${rows.map((r) => r.occurredAt).sort().join(',')}`
  ].join(' ')
}

// ===========================================================================
if (CHILD) {
  // A child does one job: run the scenario and print the digest.
  process.stdout.write(runScenario())
  process.exit(0)
}
// ===========================================================================

console.log('\n=== 1. the conversion, and each assertion mutation-tested ===')

/**
 * MUTATION TESTING, and the reason it is here.
 *
 * An assertion that passes proves nothing on its own — it might be blind. Each
 * check below is therefore ALSO run against a deliberately broken conversion
 * (the old behaviour: the wall clock read as if it were UTC). A check that
 * passes under the mutant cannot see this bug and is reported as such.
 */
const broken = (day: number, hour: number, minute = 0): string =>
  new Date(Date.UTC(2026, 7, day, hour, minute, 0)).toISOString()

interface Case {
  name: string
  real: string
  mutant: string
  want: string
}
const cases: Case[] = [
  {
    name: '6:20 PM Central on 6 Aug is 23:20 UTC',
    real: central(6, 18, 20),
    mutant: broken(6, 18, 20),
    want: '2026-08-06T23:20:00.000Z'
  },
  {
    name: '11:40 PM Central on 7 Aug is 04:40 UTC the next day',
    real: central(7, 23, 40),
    mutant: broken(7, 23, 40),
    want: '2026-08-08T04:40:00.000Z'
  },
  {
    name: 'the CSV parser agrees with the wall clock (6:20 PM, 6 Aug)',
    real: parseLedgerDate(whatnot(6, 18, 20)),
    mutant: broken(6, 18, 20),
    want: '2026-08-06T23:20:00.000Z'
  }
]

for (const c of cases) {
  ok(c.real === c.want, c.name, `got ${c.real}`)
  ok(c.mutant !== c.want, `  ^ and that assertion FAILS against the UTC-reading mutant`)
}

// The business day of an instant, which is what the calendar and the P&L group on.
ok(businessDayOf('2026-08-08T04:40:00.000Z') === '2026-08-07', '11:40 PM Central books to 7 Aug')
ok(
  new Date('2026-08-08T04:40:00.000Z').toISOString().slice(0, 10) !== '2026-08-07',
  '  ^ and the UTC date would have said 8 Aug'
)
ok(streamDateOf('2026-08-08T04:40:00.000Z') === '2026-08-07', 'streamDateOf uses the business day')

// DST is handled by NAME, not by a stored offset.
ok(zoneOffsetMs(Date.UTC(2026, 7, 7, 18), Z) === -5 * 3600_000, 'August is CDT (UTC-5)')
ok(zoneOffsetMs(Date.UTC(2026, 0, 7, 18), Z) === -6 * 3600_000, 'January is CST (UTC-6)')
ok(
  zoneOffsetMs(Date.UTC(2026, 7, 7, 18), Z) !== zoneOffsetMs(Date.UTC(2026, 0, 7, 18), Z),
  '  ^ so a fixed offset would be wrong for half the year'
)

// A wall clock survives the round trip in both halves of the year.
let rt = 0
for (let h = 0; h < 24 * 365; h++) {
  const ms = Date.UTC(2026, 0, 1, h)
  if (instantFromWallClock(wallClockOf(ms, Z), Z) !== ms) rt += 1
}
ok(rt <= 1, 'every hour of the year round-trips but the repeated fall-back hour', `${rt} failed`)

// The zone is a SETTING, with a default rather than a hard-coded constant.
ok(DEFAULT_BUSINESS_TIME_ZONE === 'America/Chicago', 'the business runs on US Central by default')
ok(isValidTimeZone('America/Denver'), 'a real zone is accepted')
ok(!isValidTimeZone('Mars/Olympus'), 'a nonsense zone is refused')
ok(!setBusinessTimeZone('Mars/Olympus'), 'and setting one is refused rather than silently ignored')
ok(businessDayOf('2026-08-08T04:40:00.000Z') === '2026-08-07', '  ^ leaving the default in force')

console.log('\n=== 2. the fingerprint does not move, so no archive doubles ===')

/**
 * The stamp is the CSV's own characters whichever zone parsed them. That is what
 * makes this change safe against a database full of rows: every fingerprint
 * already stored still matches.
 */
let stampMismatch = 0
for (let day = 1; day <= 28; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const s = whatnot(day, hour, 7)
    const iso = parseLedgerDate(s)
    const digits = canonicalLedgerTimestamp(iso)
    const wantDigits =
      `2026${String(8).padStart(2, '0')}${String(day).padStart(2, '0')}` +
      `${String(hour).padStart(2, '0')}0700`
    if (digits !== wantDigits) stampMismatch += 1
  }
}
ok(stampMismatch === 0, 'a parsed row stamps back to the CSV wall clock it came from')
ok(
  businessStamp('2026-08-06T23:20:00.000Z') === '20260806182000',
  'and the stamp is the Central reading, not the UTC one'
)
ok(
  businessStamp('2026-08-06T23:20:00.000Z') !== '20260806232000',
  '  ^ which is what the container used to write'
)

console.log('\n=== 3. an evening show crossing midnight, the exact failing case ===')

const digestHere = runScenario()
const wantCents = SALES.reduce((a, s) => a + Math.round(s.amount * 100), 0)
ok(digestHere.includes(`inWindow=${SALES.length}`), 'every sale lands inside its own show', digestHere)
ok(digestHere.includes(`cents=${wantCents}`), `all $${(wantCents / 100).toFixed(2)} is attributed`, digestHere)
ok(digestHere.includes('days=2026-08-07'), 'and the whole evening books to 7 Aug', digestHere)

console.log('\n=== 4. THE REGRESSION: Central and UTC must agree ===')

/**
 * The whole scenario, run twice in real child processes. If these two digests
 * ever differ again, the desktop and the web app disagree about the same money.
 */
const self = process.argv[1]
const runIn = (tz: string): string =>
  execFileSync(process.execPath, [self], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TZ: tz,
      // Without this the build banner pins every suite to Central, and a proof
      // that Central and UTC agree would be comparing Central with Central.
      RMOPS_TEST_TZ_PASSTHROUGH: '1',
      RMOPS_TZ_CHILD: '1',
      TEST_DB_DIR: join(process.cwd(), `out/tests/business-time-db-${tz.replace(/\//g, '_')}`)
    }
  }).trim()

const inCentral = runIn('America/Chicago')
const inUtc = runIn('UTC')
const inTokyo = runIn('Asia/Tokyo')

console.log(`    Central : ${inCentral}`)
console.log(`    UTC     : ${inUtc}`)
console.log(`    Tokyo   : ${inTokyo}`)

ok(!inCentral.startsWith('SESSION-FAILED') && !inCentral.startsWith('IMPORT-FAILED'), 'the Central run worked', inCentral)
ok(inCentral === inUtc, 'a UTC process attributes IDENTICALLY to a Central one')
ok(inCentral === inTokyo, 'and so does any other zone — the machine no longer decides')
ok(inUtc.includes(`inWindow=${SALES.length}`), 'the server matches every sale to the show', inUtc)
ok(inUtc.includes(`cents=${wantCents}`), 'and none of the money is left outside', inUtc)

console.log('\n=== 5. the historical repair, proved by the row fingerprint ===')

/**
 * A row already stored by the UTC container: its instant is five hours early.
 * Nothing about the instant says so — the proof is the fingerprint, which
 * encodes the wall clock the FILE carried. The repair must move this row and
 * must leave an honest row alone.
 */
const db = getDb()
const before = listRows({}) as Array<{ id: string; occurredAt: string; attribution: string }>
ok(before.length === SALES.length, 'the parent database holds the imported show')

// Damage one row exactly the way the container did: shift the stored instant
// back by the Central offset, leaving its fingerprint untouched.
const victim = before[0]
const shifted = new Date(new Date(victim.occurredAt).getTime() - 5 * 3600_000).toISOString()
db.prepare('UPDATE ledger_rows SET occurred_at = ?, session_id = NULL, stream_date = NULL, attribution = ? WHERE id = ?').run(
  shifted,
  'unattributed',
  victim.id
)
const damaged = (listRows({}) as Array<{ id: string; attribution: string }>).find((r) => r.id === victim.id)
ok(damaged?.attribution === 'unattributed', 'a row stored by the UTC container falls outside its show')

const repaired = reattributeAll(null)
ok(repaired.ok, 're-attribution runs', repaired.ok ? '' : repaired.error)
if (repaired.ok) {
  const sum = repaired.data
  ok(sum.rowsRezoned === 1, 'exactly one instant is corrected', `rezoned=${sum.rowsRezoned}`)
  ok(sum.rowsUnprovable === 0, 'and no row was left unprovable', `unprovable=${sum.rowsUnprovable}`)
  const back = (listRows({}) as Array<{ id: string; occurredAt: string; attribution: string }>).find(
    (r) => r.id === victim.id
  )
  ok(back?.occurredAt === victim.occurredAt, 'the original instant is restored exactly')
  ok(back?.attribution === 'in_window', 'and the money is back inside its show')
  ok(
    sum.centsMovedByDay.some((d) => d.day === '2026-08-07' && d.cents > 0),
    'and the summary reports which day gained money',
    JSON.stringify(sum.centsMovedByDay)
  )

  // Idempotent: a second run must not touch anything.
  const again = reattributeAll(null)
  ok(again.ok && again.data.rowsRezoned === 0, 'running it twice corrects nothing further')
}

// An honest row must survive untouched — the repair may not "fix" what is right.
const untouched = reattributeAll(null)
ok(
  untouched.ok && untouched.data.rowsRezoned === 0 && untouched.data.rowsUnprovable === 0,
  'a correct database is left entirely alone'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
