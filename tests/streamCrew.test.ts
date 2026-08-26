/**
 * A SHOW IS RUN BY MORE THAN ONE PERSON, and not by everybody.
 *
 * The owner's words: "add a feature where I can add multiple people to a stream,
 * and that only people that are in breaking or owners are options for
 * streaming."
 *
 * ## What is pinned here, and how each fails if it is wrong
 *
 *   1. THE COLUMN AND THE TABLE CANNOT DISAGREE. `stream_sessions.host_id` is
 *      read by the P&L, the performance page and the schedule, and it stays —
 *      as the FIRST of the crew. Two places deciding who leads is how a show
 *      comes to name one person in its header and a different one in its list.
 *
 *   2. AN EDIT THAT SAYS NOTHING ABOUT THE CREW LEAVES IT ALONE. `undefined`
 *      means "leave it" and `[]` means "clear it" — collapsing the two would
 *      make correcting a typo in a title silently wipe the crew.
 *
 *   3. ONLY PEOPLE WHO MAY RUN A SHOW ARE OFFERED, read off the PERMISSION and
 *      not the role name. A stand-in granted `streaming.run` by hand is covered
 *      for the week; testing the role would let them start a show they could not
 *      be named on.
 *
 *   4. SOMEBODY WHO HAS LEFT STAYS ON THE SHOWS THEY RAN. Dropping a disabled
 *      account out of the picker would silently rewrite the crew of an old
 *      session the first time anybody opened it to fix a typo.
 *
 * Every name here is invented.
 *
 * Run: npm run test:stream-crew
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/crew-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const streaming = require('../src/main/db/streaming')
const { hostFromCrew, normalizeCrew } = require('../src/shared/streaming')
const { canRunStream, streamHostCandidates } = require('../src/shared/permissions')

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

const addPerson = (id: string, first: string, last: string): void => {
  db.prepare(
    `INSERT INTO employees (id, first_name, last_name, company_id, email, title, role,
                            status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Staff', 'staff', 'active',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(id, first, last, id.toUpperCase(), `${id}@example.test`)
}
addPerson('e_ada', 'Ada', 'Fenwick')
addPerson('e_bo', 'Bo', 'Harborline')
addPerson('e_cy', 'Cy', 'Marisol')

// ---------------------------------------------------------------------------
console.log('=== 1. tidying a crew ===')
// ---------------------------------------------------------------------------
ok(JSON.stringify(normalizeCrew([])) === '[]', 'an empty crew is empty')
ok(
  JSON.stringify(normalizeCrew(['  e_ada  ', 'e_bo'])) === '["e_ada","e_bo"]',
  'names are trimmed and order is kept — the first of them is the host, and somebody who put themselves first meant it'
)
ok(
  JSON.stringify(normalizeCrew(['e_ada', 'e_ada', 'e_bo'])) === '["e_ada","e_bo"]',
  'A DOUBLE TAP IS ONE PRESS TOO MANY, not a failed insert against the UNIQUE'
)
ok(
  JSON.stringify(normalizeCrew(['', null, undefined, 'e_bo'])) === '["e_bo"]',
  'and blanks fall out'
)
ok(hostFromCrew([]) === null, 'an empty crew has no host')
ok(hostFromCrew(['e_bo', 'e_ada']) === 'e_bo', 'and otherwise the first of them leads')

// ---------------------------------------------------------------------------
console.log('\n=== 2. the column and the table agree ===')
// ---------------------------------------------------------------------------
const made = streaming.createSession(
  {
    title: 'Two on the mic',
    startedAt: '2026-07-01T01:00:00.000Z',
    endedAt: '2026-07-01T03:00:00.000Z',
    hostId: null,
    crew: ['e_ada', 'e_bo'],
    note: null
  },
  null
)
ok(made.ok, 'a show is typed in with two people on it', made.error ?? '')
const two = streaming.getSessionDetail(made.data.id).session
ok(two.crew.length === 2, 'both are on the crew', String(two.crew.length))
ok(
  two.crew.map((c: any) => c.employeeId).join(',') === 'e_ada,e_bo',
  'in the order they were added',
  two.crew.map((c: any) => c.employeeId).join(',')
)
ok(two.crew[0].name === 'Ada Fenwick', 'resolved for display', String(two.crew[0].name))
ok(
  two.hostId === 'e_ada',
  'AND host_id IS THE FIRST OF THEM — every read written before crews existed carries on unchanged',
  String(two.hostId)
)
ok(two.hostName === 'Ada Fenwick', 'including the resolved host name')

// A caller that only knows about a single host still works, and gets a crew.
const single = streaming.createSession(
  {
    title: 'One on the mic',
    startedAt: '2026-07-02T01:00:00.000Z',
    endedAt: '2026-07-02T03:00:00.000Z',
    hostId: 'e_cy',
    note: null
  },
  null
)
const one = streaming.getSessionDetail(single.data.id).session
ok(one.hostId === 'e_cy', 'a caller sending only hostId still sets it', String(one.hostId))
ok(
  one.crew.length === 1 && one.crew[0].employeeId === 'e_cy',
  'AND GETS A ONE-PERSON CREW — so nothing has to know about both fields',
  JSON.stringify(one.crew)
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. an edit that says nothing leaves the crew alone ===')
// ---------------------------------------------------------------------------
streaming.updateSession({ id: made.data.id, title: 'Two on the mic (fixed)' }, null)
const afterTitle = streaming.getSessionDetail(made.data.id).session
ok(afterTitle.title === 'Two on the mic (fixed)', 'the title changes')
ok(
  afterTitle.crew.length === 2,
  'AND THE CREW SURVIVES — undefined means leave it, and collapsing that into "clear it" would wipe a crew on every typo fix',
  String(afterTitle.crew.length)
)
ok(afterTitle.hostId === 'e_ada', 'and so does the host')

// Reordering changes who leads, in both places at once.
streaming.updateSession({ id: made.data.id, crew: ['e_bo', 'e_ada'] }, null)
const flipped = streaming.getSessionDetail(made.data.id).session
ok(
  flipped.crew.map((c: any) => c.employeeId).join(',') === 'e_bo,e_ada',
  'putting somebody first reorders the crew',
  flipped.crew.map((c: any) => c.employeeId).join(',')
)
ok(flipped.hostId === 'e_bo', 'AND MOVES THE HOST WITH IT', String(flipped.hostId))

// Taking somebody off is a name being ABSENT — the list arrives complete.
streaming.updateSession({ id: made.data.id, crew: ['e_bo'] }, null)
const trimmed = streaming.getSessionDetail(made.data.id).session
ok(trimmed.crew.length === 1, 'a name left out is a name taken off', String(trimmed.crew.length))

// An explicit empty array clears it, which is how the last name comes off.
streaming.updateSession({ id: made.data.id, crew: [] }, null)
const cleared = streaming.getSessionDetail(made.data.id).session
ok(cleared.crew.length === 0, 'an explicit empty crew clears it', String(cleared.crew.length))
ok(cleared.hostId === null, 'and the host with it', String(cleared.hostId))

// ---------------------------------------------------------------------------
console.log('\n=== 4. only the people who may run a show ===')
// ---------------------------------------------------------------------------
ok(canRunStream('breaker'), 'a Breaker may run a show — that is what the role is for')
ok(canRunStream('owner'), 'and so may an Owner')
ok(!canRunStream('staff'), 'ordinary Staff may not')
ok(!canRunStream('shipping'), 'nor may the packing floor')
ok(
  canRunStream('staff', ['streaming.run']),
  'BUT A HAND-GRANTED PERMISSION DOES — read off the permission, not the role, which is how a stand-in gets covered for a week'
)

const people = [
  { id: 'e_ada', role: 'breaker', status: 'active' },
  { id: 'e_bo', role: 'owner', status: 'active' },
  { id: 'e_cy', role: 'staff', status: 'active' },
  { id: 'e_dee', role: 'shipping', status: 'active', permissions: ['streaming.run'] },
  { id: 'e_gone', role: 'breaker', status: 'disabled' }
]
const offered = streamHostCandidates(people).map((p: any) => p.id)
ok(offered.includes('e_ada'), 'the breaker is offered')
ok(offered.includes('e_bo'), 'the owner is offered')
ok(!offered.includes('e_cy'), 'THE OFFICE STAFF ARE NOT — a list of thirty names to find the two of them is a list nobody reads')
ok(offered.includes('e_dee'), 'the covered stand-in is offered')
ok(!offered.includes('e_gone'), 'and somebody who has left is not')

const withKeep = streamHostCandidates(people, ['e_gone', 'e_cy']).map((p: any) => p.id)
ok(
  withKeep.includes('e_gone'),
  'BUT SOMEBODY ALREADY ON THE SHOW STAYS OFFERED — they ran the shows they ran, and dropping them would rewrite an old crew the first time anybody opened it'
)
ok(withKeep.includes('e_cy'), 'which holds for anybody already named, however they got there')

// ---------------------------------------------------------------------------
console.log('\n=== 5. a name that is gone keeps its slot ===')
// ---------------------------------------------------------------------------
const kept = streaming.createSession(
  {
    title: 'Crew with a ghost',
    startedAt: '2026-07-03T01:00:00.000Z',
    endedAt: '2026-07-03T03:00:00.000Z',
    hostId: null,
    crew: ['e_ada', 'e_ghost', 'e_bo'],
    note: null
  },
  null
)
const ghosted = streaming.getSessionDetail(kept.data.id).session
ok(ghosted.crew.length === 3, 'three slots, one of them naming nobody on file', String(ghosted.crew.length))
ok(
  ghosted.crew[1].employeeId === 'e_ghost' && ghosted.crew[1].name === null,
  'THE MISSING NAME KEEPS ITS SLOT — dropping it would shift everybody after it up by one and put somebody else’s name against this id',
  JSON.stringify(ghosted.crew)
)
ok(ghosted.crew[2].name === 'Bo Harborline', 'so the third is still the third', String(ghosted.crew[2].name))

// A COMMA IN A NAME MUST NOT TEAR A CREW IN TWO. The ids and names come back
// newline-joined for exactly this reason.
db.prepare(`UPDATE employees SET last_name = 'Fenwick, Jr' WHERE id = 'e_ada'`).run()
const commad = streaming.getSessionDetail(kept.data.id).session
ok(
  commad.crew.length === 3,
  'a comma in somebody’s name does not split them into two crew members',
  String(commad.crew.length)
)
ok(commad.crew[0].name === 'Ada Fenwick, Jr', 'and their name survives whole', String(commad.crew[0].name))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
