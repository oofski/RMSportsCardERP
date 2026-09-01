/**
 * WHAT A SALE TOOK OFF THE SHELF HAS TO TRAVEL WITH THE SALE.
 *
 * The bug this pins was the quiet kind. A sales order raised on one machine
 * reached every other one looking complete: the order was there, its lines were
 * there, and the cost layers arrived with their remainders already reduced — so
 * `inventory_stock` rebuilt to the right quantity and nothing disagreed.
 *
 * Only `invoice_stock_moves` stayed behind. That table is the RECEIPT: it says
 * which layers this sale consumed and what they cost. Without it, on every
 * laptop but the one that raised the order —
 *
 *   - the order showed no cost of goods, so it read as pure margin;
 *   - voiding it could not put the stock back, because nothing said what;
 *   - a roadshow shop's "sold" count read zero.
 *
 * The owner saw it as "a sales order is moving but it is not working entirely".
 *
 * PART 2 is the part that matters more than the fix. The table was absent from
 * the synced list AND from the module header's account of what is deliberately
 * absent, and nothing could tell that omission from a decision. So every table
 * in the schema is now checked against both lists, and a new one fails until
 * somebody puts it in one of them.
 *
 * Run: npm run test:sale-sync
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/sale-sync-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const sync = require('../src/main/db/sync')
const { SYNCED_BY_TABLE, NEVER_SYNCED } = require('../src/main/db/syncTables')

let pass = 0
let fail = 0
const ok = (cond: boolean, what: string, detail?: string): void => {
  if (cond) {
    pass += 1
    console.log(`  ok   ${what}`)
  } else {
    fail += 1
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`)
  }
}

const db = getDb()

// ---------------------------------------------------------------------------
console.log('\n=== 1. the receipt is on the manifest, and lands after what it names ===')
// ---------------------------------------------------------------------------
{
  const spec = SYNCED_BY_TABLE.get('invoice_stock_moves')
  ok(!!spec, 'invoice_stock_moves is a synced table')
  ok(spec?.key?.length === 1 && spec.key[0] === 'id', 'keyed by its own id, which never collides')
  // Tier matters on the row-at-a-time recovery path: a receipt that landed
  // before its invoice would be a receipt for nothing.
  const invoices = SYNCED_BY_TABLE.get('invoices')
  const txns = SYNCED_BY_TABLE.get('inventory_transactions')
  ok(
    (spec?.tier ?? 0) > (invoices?.tier ?? 0) && (spec?.tier ?? 0) > (txns?.tier ?? 0),
    'AND IT LANDS AFTER BOTH THE INVOICE AND THE INVENTORY MOVEMENT IT NAMES',
    `moves ${spec?.tier} vs invoices ${invoices?.tier} / transactions ${txns?.tier}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. EVERY TABLE IS ACCOUNTED FOR — the check that was missing ===')
// ---------------------------------------------------------------------------
{
  // Off sqlite_master rather than off the source, so this sees what the
  // migration actually built and cannot be fooled by a table added somewhere
  // the grep would not look.
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name)

  ok(tables.length > 50, 'the migration built the whole schema', `${tables.length} tables`)

  const never = new Set(NEVER_SYNCED)
  const orphans = tables.filter((t) => !SYNCED_BY_TABLE.has(t) && !never.has(t))
  ok(
    orphans.length === 0,
    'NO TABLE IS IN NEITHER LIST — a new one must be declared to travel or declared not to, ' +
      'because forgetting looks exactly like deciding',
    orphans.join(', ')
  )

  // And the other direction: an exclusion for a table that no longer exists is
  // a stale note that would let a REAL orphan hide behind it.
  const gone = NEVER_SYNCED.filter((t: string) => !tables.includes(t))
  ok(gone.length === 0, 'and nothing is excluded that is not there any more', gone.join(', '))

  ok(
    !never.has('invoice_stock_moves') && SYNCED_BY_TABLE.has('invoice_stock_moves'),
    'the receipt is on the travelling side of that split, not the excluded side'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. a receipt written here is captured for the wire ===')
// ---------------------------------------------------------------------------
{
  // A parent invoice, because the receipt cascades off one. Minimal on purpose:
  // this section is about the capture trigger, not about invoicing.
  const invoice = (id: string): void => {
    db.prepare(
      `INSERT INTO invoices
         (id, customer_name, terms, invoice_date, due_date, status, total, created_at, updated_at)
       VALUES (?, 'Buyer', 'Due on receipt', '2026-07-15', '2026-07-15', 'draft', 0,
               '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z')`
    ).run(id)
  }
  invoice('inv1')

  db.prepare('DELETE FROM sync_outbox').run()
  db.prepare(
    `INSERT INTO invoice_stock_moves
       (id, invoice_id, line_position, product_id, location, quantity, cost_total, txn_id, created_at)
     VALUES ('m1', 'inv1', 0, 'p1', 'Warehouse', 2, 550.0, 't1', '2026-07-15T12:00:00.000Z')`
  ).run()
  const queued = db
    .prepare(`SELECT kind, id, deleted FROM sync_outbox WHERE kind = 'invoice_stock_moves'`)
    .all() as Array<{ kind: string; id: string; deleted: number }>
  ok(
    queued.length === 1 && queued[0].id === 'm1' && queued[0].deleted === 0,
    'THE CAPTURE TRIGGER IS INSTALLED — writing a receipt queues it to go up',
    JSON.stringify(queued)
  )

  // Deletes have to travel too, or a voided sale keeps its consumed layers on
  // every machine that was not the one that voided it.
  db.prepare('DELETE FROM sync_outbox').run()
  db.prepare(`DELETE FROM invoice_stock_moves WHERE id = 'm1'`).run()
  const tomb = db
    .prepare(`SELECT id, deleted FROM sync_outbox WHERE kind = 'invoice_stock_moves'`)
    .all() as Array<{ id: string; deleted: number }>
  ok(
    tomb.length === 1 && tomb[0].deleted === 1,
    'and taking one back queues a tombstone rather than going quiet',
    JSON.stringify(tomb)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. and a receipt from another machine lands, with its cost ===')
// ---------------------------------------------------------------------------
{
  db.prepare('DELETE FROM invoice_stock_moves').run()
  db.prepare(
    `INSERT INTO invoices
       (id, customer_name, terms, invoice_date, due_date, status, total, created_at, updated_at)
     VALUES ('inv9', 'Buyer', 'Due on receipt', '2026-07-16', '2026-07-16', 'draft', 0,
             '2026-07-16T12:00:00.000Z', '2026-07-16T12:00:00.000Z')`
  ).run()
  ok(
    (db.prepare('SELECT COUNT(*) AS n FROM invoice_stock_moves').get() as { n: number }).n === 0,
    'the receiving machine starts with no receipt for this sale'
  )

  const row = {
    id: 'm2',
    invoice_id: 'inv9',
    line_position: 0,
    product_id: 'p9',
    location: 'New York roadshow',
    quantity: 3,
    cost_total: 825.0,
    txn_id: 't9',
    created_at: '2026-07-16T12:00:00.000Z'
  }
  sync.applyRows([
    {
      kind: 'invoice_stock_moves',
      id: row.id,
      seq: 1,
      updated_at: row.created_at,
      deleted: 0 as const,
      data: JSON.stringify(row)
    }
  ])

  const landed = db
    .prepare(`SELECT quantity, cost_total, location FROM invoice_stock_moves WHERE id = 'm2'`)
    .get() as { quantity: number; cost_total: number; location: string } | undefined
  ok(!!landed, 'the receipt arrives')
  ok(
    landed?.cost_total === 825.0,
    'CARRYING WHAT THE GOODS COST — the figure the order reads its margin off, and the one ' +
      'that was silently zero on every machine but the seller',
    String(landed?.cost_total)
  )
  ok(landed?.quantity === 3, 'and how many units it took, which is what a void has to put back')
  ok(
    landed?.location === 'New York roadshow',
    'and the shelf it took them off, which is what a shop column counts as sold',
    landed?.location
  )

  // Applying the same row again must not double anything: the relay redelivers
  // on any cursor rewind, and this table is keyed by its own id for that reason.
  sync.applyRows([
    {
      kind: 'invoice_stock_moves',
      id: row.id,
      seq: 2,
      updated_at: row.created_at,
      deleted: 0 as const,
      data: JSON.stringify(row)
    }
  ])
  ok(
    (db.prepare('SELECT COUNT(*) AS n FROM invoice_stock_moves').get() as { n: number }).n === 1,
    'AND A REDELIVERY IS IDEMPOTENT — one receipt, not two, so a rewound cursor cannot double a cost'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
