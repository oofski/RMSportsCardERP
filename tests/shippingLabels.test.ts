/**
 * Break labels, end to end through real SQLite.
 *
 *  1. A v30-shaped database (audit keyed by break_number) migrates to v31
 *     without losing the audit rows the floor is currently looking at.
 *  2. #11 and #11A survive an import as two breaks with two slates.
 *  3. Re-importing does NOT let a card picked in #11 hand its tick to #11A.
 */
import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// The Electron shim reports this as userData, so the DB layer writes here.
// Defaulted rather than required so `npm run test:labels` works with no
// cross-platform env-var dance.
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

// --- Build a v30-shaped database FIRST, so getDb() has to migrate it. -------
const file = join(DIR, 'rm-operations.db')
{
  const pre = new Database(file)
  pre.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta (key, value) VALUES ('schema_version', '30');
    CREATE TABLE ship_break_audit (
      break_number       INTEGER PRIMARY KEY,
      team_count         INTEGER,
      distinct_team_count INTEGER,
      max_teams          INTEGER,
      missing_count      INTEGER,
      missing_teams      TEXT,
      has_all            INTEGER,
      collisions         TEXT
    );
    INSERT INTO ship_break_audit VALUES (7, 29, 29, 30, 1, '["Chicago Cubs"]', 0, '[]');
  `)
  pre.close()
}

let pass = 0, fail = 0
const ok = (c: boolean, name: string, extra = ''): void => {
  if (c) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb, getMeta } = require('../src/main/db/database')
const ship = require('../src/main/db/shipping')
const domain = require('../src/main/db/shippingDomain')
const { parsePages } = require('../src/main/shipping/parser')

const db = getDb()

console.log('\n=== 1. v30 -> v31 migration ===')
ok(Number(getMeta(db, 'schema_version')) >= 31, 'schema_version reaches 31', String(getMeta(db, 'schema_version')))
const cols = (t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
ok(cols('ship_breaks').includes('break_label'), 'ship_breaks.break_label exists')
ok(cols('ship_team_slots').includes('break_label'), 'ship_team_slots.break_label exists')
ok(cols('ship_break_audit').includes('break_label'), 'ship_break_audit.break_label exists')
const pk = (db.prepare(`PRAGMA table_info(ship_break_audit)`).all() as { name: string; pk: number }[])
  .filter((c) => c.pk > 0).map((c) => c.name)
ok(pk.length === 1 && pk[0] === 'break_label', 'and it is the primary key', JSON.stringify(pk))
const carried = db.prepare(`SELECT * FROM ship_break_audit`).all() as Record<string, unknown>[]
ok(carried.length === 1 && carried[0].break_label === '7' && carried[0].break_number === 7,
   'the pre-existing audit row survived, labelled by its number', JSON.stringify(carried))
ok(carried[0]?.missing_teams === '["Chicago Cubs"]', 'with its slate intact')

console.log('\n=== 2. #11 and #11A land as two breaks ===')
const slip = (handle: string, lines: string[]): string =>
  [
    'Whatnot Packing Slip 1/1',
    `To: ${handle} From: rm_cardz`,
    'Person Name',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    ...lines,
    `${lines.length / 2} Items $0.00`,
    'USPS Ground Advantage #93001207626023157067' + (handle === 'alpha' ? '46' : '47') + ' 3.0 oz'
  ].join('\n')

const BOX = '1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #'
const pages = [
  slip('alpha', [
    '1 Boston Red Sox Order 3333333333 $20.00', BOX + '11',
    '1 New York Yankees Order 3333333334 $25.00', BOX + '11A'
  ]),
  slip('bravo', [
    '1 Boston Red Sox Order 3333333335 $30.00', BOX + '11A',
    '1 New York Yankees Order 3333333336 $35.00', BOX + '11'
  ])
]
const ds = parsePages(pages, { sport: 'mlb', eventName: 'Test show', eventDate: '2026-08-01' })
ship.importDataset(ds, { filename: 'test.pdf', carryForward: true })

const breaks = domain.listBreaks() as { id: string; breakLabel: string; breakNumber: number; totalTeams: number; audit: { breakLabel: string; teamCount: number; collisions: unknown[] } | null }[]
ok(breaks.length === 2, 'two breaks in the database', String(breaks.length))
ok(breaks.map((b) => b.breakLabel).sort().join(',') === '11,11A',
   'labelled 11 and 11A', JSON.stringify(breaks.map((b) => b.breakLabel)))
ok(breaks.every((b) => b.breakNumber === 11), 'both numbered 11')
ok(breaks.every((b) => b.totalTeams === 2), 'two cards each',
   JSON.stringify(breaks.map((b) => b.totalTeams)))
ok(breaks.every((b) => b.audit != null), 'each has its own audit row')
ok(breaks.every((b) => b.audit?.breakLabel === b.breakLabel), 'keyed to the right label')
ok(breaks.every((b) => (b.audit?.collisions.length ?? 0) === 0),
   'and neither reports a phantom collision',
   JSON.stringify(breaks.map((b) => b.audit?.collisions)))

console.log('\n=== 3. a pick in #11 stays in #11 across a re-import ===')
const b11 = breaks.find((b) => b.breakLabel === '11')!
const d11 = domain.getBreak(b11.id) as { slots: { id: string; teamName: string; breakLabel: string }[] }
const sox11 = d11.slots.find((s) => s.teamName === 'Boston Red Sox')!
ok(sox11 != null && sox11.breakLabel === '11', 'the Red Sox card in #11 is labelled 11')
domain.setTeamSlotChecked(sox11.id, true, 'tester')

// Same show, imported again — ids are regenerated, so only the natural key can
// carry the tick.
const ds2 = parsePages(pages, { sport: 'mlb', eventName: 'Test show', eventDate: '2026-08-01' })
ship.importDataset(ds2, { filename: 'test.pdf', carryForward: true })

const after = domain.listBreaks() as { id: string; breakLabel: string; checkedTeams: number }[]
const a11 = after.find((b) => b.breakLabel === '11')!
const a11a = after.find((b) => b.breakLabel === '11A')!
ok(a11.checkedTeams === 1, '#11 still shows exactly one card picked', String(a11.checkedTeams))
ok(a11a.checkedTeams === 0, '#11A shows none — the tick did not leak', String(a11a.checkedTeams))
const d11b = domain.getBreak(a11.id) as { slots: { teamName: string; checkedOff: boolean }[] }
ok(d11b.slots.find((s) => s.teamName === 'Boston Red Sox')?.checkedOff === true,
   'and it is still the Red Sox card that is picked')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
