/**
 * A FINISHED SUPPLY ORDER LEAVES THE BOARD AFTER A DAY, AND LANDS IN HISTORY.
 *
 * The owner: "supply tab purchase orders once they are ... delivered also
 * disappear after 24 hours into history or something like that, those can also
 * be tracked" — then, asked whether a payment step should come first: "I just
 * want them to move to the history tab once they are there for 24 hours."
 *
 * The window used to be fourteen days, which meant a fortnight of finished
 * orders sitting among the live ones. Shortening it is easy; the thing that can
 * go wrong is an order falling out of the board and into nothing.
 *
 * ## What section 2 is actually protecting
 *
 * `listSupplyOrders` and `listSupplyOrderHistory` are written as exact
 * complements — the history query is literally `NOT (on board)`. If they were
 * ever spelled out as two separate sets of conditions they could disagree, and
 * the way they disagree is an order that appears in NEITHER list: a purchase
 * that exists in the database, that money was spent on, and that no screen in
 * the app will ever show. That is a worse outcome than the crowded board this
 * change set out to fix, so it is asserted over every state a row can be in
 * rather than over the two the feature is about.
 *
 * Every supplier and product name here is invented.
 *
 * Run: npm run test:supply-history
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/supplyhist-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const sup = require('../src/main/db/supplies')
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

const WINDOW: number = sup.SUPPLY_BOARD_WINDOW_MS
const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString()
const HOUR = 60 * 60 * 1000

db.prepare(
  `INSERT INTO supplies (id, name, unit, quantity, unit_cost, items_per_unit, reorder_point, recurring, created_at, updated_at)
   VALUES ('s1', 'Invented 6x9 Bubble Mailer', 'box', 0, 0.4, 100, 50, 1,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

/** Put a supply order straight into the state under test. */
const seed = (
  id: string,
  status: string,
  stamps: { delivered?: string | null; cancelled?: string | null } = {}
): void => {
  db.prepare(
    `INSERT INTO supply_orders
       (id, supply_id, units, items_per_unit, total, status, source, ordered_at, delivered_at, cancelled_at, created_at)
     VALUES (?, 's1', 2, 100, 120, ?, 'manual', '2026-01-01T00:00:00.000Z', ?, ?, '2026-01-01T00:00:00.000Z')`
  ).run(id, status, stamps.delivered ?? null, stamps.cancelled ?? null)
}

const boardIds = (): string[] => sup.listSupplyOrders().map((o: any) => o.id).sort()
const historyIds = (): string[] => sup.listSupplyOrderHistory().map((o: any) => o.id).sort()

// ---------------------------------------------------------------------------
// 1. The boundary the owner asked for
// ---------------------------------------------------------------------------
console.log('\n=== 1. one day, then it goes ===')

ok(WINDOW === 24 * HOUR, 'the window is 24 hours', String(WINDOW / HOUR) + 'h')

seed('o_fresh', 'delivered', { delivered: agoIso(HOUR) })
seed('o_stale', 'delivered', { delivered: agoIso(WINDOW + HOUR) })

ok(boardIds().includes('o_fresh'), 'delivered an hour ago is still on the board')
ok(!historyIds().includes('o_fresh'), 'and is not in history yet')
ok(!boardIds().includes('o_stale'), 'delivered a day and an hour ago has left the board')
ok(historyIds().includes('o_stale'), 'and is in history')

// The edge itself, from both sides. `>= cutoff` is on the board, so a row
// stamped exactly one window ago is the last one that stays.
db.prepare(`UPDATE supply_orders SET delivered_at = ? WHERE id = 'o_fresh'`).run(agoIso(WINDOW - 1000))
ok(boardIds().includes('o_fresh'), 'a second short of the window is still on the board')
db.prepare(`UPDATE supply_orders SET delivered_at = ? WHERE id = 'o_fresh'`).run(agoIso(WINDOW + 1000))
ok(historyIds().includes('o_fresh'), 'a second past it has crossed')
db.prepare(`UPDATE supply_orders SET delivered_at = ? WHERE id = 'o_fresh'`).run(agoIso(HOUR))

// ---------------------------------------------------------------------------
// 2. NOBODY FALLS THROUGH THE GAP
// ---------------------------------------------------------------------------
console.log('\n=== 2. every order is in exactly one list ===')

// One row per state a supply order can be in, at both ages, plus the two rows
// that carry no terminal stamp at all — a state the table permits and which a
// naive history query ("status is terminal") would file away with no date.
seed('o_ordered', 'ordered')
seed('o_transit', 'in_transit')
seed('o_cancel_new', 'cancelled', { cancelled: agoIso(HOUR) })
seed('o_cancel_old', 'cancelled', { cancelled: agoIso(WINDOW + HOUR) })
seed('o_delivered_nostamp', 'delivered')
seed('o_cancelled_nostamp', 'cancelled')

const all = db
  .prepare(`SELECT id FROM supply_orders`)
  .all()
  .map((r: any) => r.id)
  .sort()
const board = boardIds()
const past = historyIds()

const both = all.filter((id: string) => board.includes(id) && past.includes(id))
const neither = all.filter((id: string) => !board.includes(id) && !past.includes(id))

ok(both.length === 0, 'no order is in both lists', both.join(','))
ok(neither.length === 0, 'no order is in neither list', neither.join(','))
ok(
  board.length + past.length === all.length,
  'the two lists partition the table',
  `${board.length} + ${past.length} vs ${all.length}`
)

console.log('\n=== 3. which side each state lands on ===')
ok(board.includes('o_ordered'), 'an open order stays on the board however old the row is')
ok(board.includes('o_transit'), 'so does one in transit')
ok(!past.includes('o_ordered') && !past.includes('o_transit'), 'and neither reaches history')
ok(past.includes('o_cancel_old'), 'a cancelled order ages out too')
ok(board.includes('o_cancel_new'), 'but not before the window is up')
ok(
  board.includes('o_delivered_nostamp') && board.includes('o_cancelled_nostamp'),
  'a terminal row with no timestamp has nothing to age out of, so it stays visible'
)

// ---------------------------------------------------------------------------
// 4. History is ordered by when things finished, newest first
// ---------------------------------------------------------------------------
console.log('\n=== 4. newest finish first ===')
seed('o_oldest', 'delivered', { delivered: agoIso(WINDOW + 90 * 24 * HOUR) })
const order = sup.listSupplyOrderHistory().map((o: any) => o.id)
ok(
  order.indexOf('o_oldest') === order.length - 1,
  'the ninety-day-old one sorts last',
  order.join(' ')
)
ok(order[0] === 'o_stale' || order[0] === 'o_cancel_old', 'the most recent finish sorts first', order.join(' '))

// The limit is a floor and a ceiling, not a raw pass-through: a caller asking
// for 0 or for a million must not turn into `LIMIT 0` or an unbounded read.
ok(sup.listSupplyOrderHistory(1).length === 1, 'a limit of 1 returns one row')
ok(sup.listSupplyOrderHistory(0).length === 1, 'a limit of 0 is clamped up to 1, not to nothing')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
