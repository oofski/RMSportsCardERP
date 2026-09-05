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
const { SYNCED_BY_TABLE, SYNCED_TABLES, NEVER_SYNCED } = require('../src/main/db/syncTables')

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


// ---------------------------------------------------------------------------
console.log('\n=== 5. EVERY SYNC KEY NAMES A REAL CONSTRAINT — the other half of the check ===')
// ---------------------------------------------------------------------------
/**
 * A KEY THAT IS NOT A KEY IS NOT A MERGE BUG, IT IS BROKEN SQL.
 *
 * `upsertRow` builds `ON CONFLICT (<the manifest key columns>)`. SQLite accepts
 * that clause only when those columns are exactly a PRIMARY KEY or a UNIQUE
 * index. Name anything else and it refuses the statement outright — not for the
 * row that collides, for EVERY row.
 *
 * ship_break_audit was declared on `break_label` while its primary key is
 * `break_id`. So every audit row ever sent was refused, in the batch and again
 * on the row-by-row retry, and surfaced to the owner under "usually the same
 * thing created twice. Nothing is lost" — which described the one failure mode
 * it was not.
 *
 * Section 2 checks that a table is on a list. This checks that being on the
 * list means something. Both were absent, and the second is the one no amount
 * of reading the manifest could catch: `key: ['break_label']` looks exactly as
 * plausible as `key: ['id']` until it meets the schema.
 */
{
  const cols = (t: string): Array<{ name: string; pk: number }> =>
    db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(t) as Array<{
      name: string
      pk: number
    }>

  /** Every column set this table can legally be upserted on. */
  const constraintsOf = (t: string): string[] => {
    const sets: string[] = []
    const pk = cols(t)
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort()
    if (pk.length > 0) sets.push(pk.join('|'))
    const indexes = db.prepare('SELECT name, "unique" AS uniq FROM pragma_index_list(?)').all(t) as
      Array<{ name: string; uniq: number }>
    for (const ix of indexes) {
      if (!ix.uniq) continue
      const on = (
        db.prepare('SELECT name FROM pragma_index_info(?)').all(ix.name) as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort()
      if (on.length > 0) sets.push(on.join('|'))
    }
    return sets
  }

  const offenders: string[] = []
  let checked = 0
  for (const spec of SYNCED_TABLES) {
    if (cols(spec.table).length === 0) continue // not built on this schema version
    checked += 1
    const want = [...spec.key].sort().join('|')
    if (!constraintsOf(spec.table).includes(want)) {
      offenders.push(`${spec.table} keyed on (${spec.key.join(', ')}) — real: ${constraintsOf(spec.table).join(' / ')}`)
    }
  }

  ok(checked > 60, 'every synced table was checked against the live schema', `${checked} tables`)
  ok(
    offenders.length === 0,
    'NO SYNCED TABLE IS KEYED ON COLUMNS THAT ARE NOT A PRIMARY KEY OR A UNIQUE INDEX — ' +
      'the ON CONFLICT clause is built from this key, and a key that names no constraint ' +
      'makes SQLite refuse every row of the table rather than merge them',
    offenders.join(' ;; ')
  )

  const audit = SYNCED_BY_TABLE.get('ship_break_audit')
  ok(
    audit?.key.length === 1 && audit.key[0] === 'break_id',
    'ship_break_audit specifically travels on its primary key, which is also ship_breaks.id',
    JSON.stringify(audit?.key)
  )

  // The row proves it: an upsert on the fixed key has to actually run, and a
  // second copy of the same audit has to REPLACE rather than duplicate.
  db.prepare('DELETE FROM ship_break_audit').run()
  const auditRow = (teams: number) => ({
    break_id: 'brk1',
    break_label: 'Break 1',
    break_number: 1,
    team_count: teams,
    distinct_team_count: teams,
    max_teams: 30,
    missing_count: 0,
    missing_teams: '[]',
    has_all: 1,
    collisions: '[]'
  })
  const send = (teams: number, seq: number): void => {
    sync.applyRows([
      {
        kind: 'ship_break_audit',
        id: 'brk1',
        seq,
        updated_at: '2026-09-01T16:33:00.000Z',
        deleted: 0 as const,
        data: JSON.stringify(auditRow(teams))
      }
    ])
  }
  send(28, 1)
  const after = db.prepare(`SELECT team_count FROM ship_break_audit WHERE break_id = 'brk1'`).get() as
    | { team_count: number }
    | undefined
  ok(!!after, 'AN AUDIT ROW FROM ANOTHER MACHINE NOW APPLIES — this is the row that was refused')
  send(30, 2)
  const rows = db.prepare('SELECT break_id, team_count FROM ship_break_audit').all() as Array<{
    break_id: string
    team_count: number
  }>
  ok(
    rows.length === 1 && rows[0].team_count === 30,
    'and a corrected copy REPLACES it rather than landing beside it',
    JSON.stringify(rows)
  )
}


// ---------------------------------------------------------------------------
console.log('\n=== 6. a stale QuickBooks reading cannot overwrite a fresh one ===')
// ---------------------------------------------------------------------------
/**
 * ONE MACHINE CAN ASK QUICKBOOKS. EVERY MACHINE CAN OVERWRITE THE ANSWER.
 *
 * The QuickBooks tokens live in `meta`, sealed with safeStorage, and meta never
 * travels — so exactly one machine can refresh an invoice's balance, and the
 * card says which: "Checked on the desktop app". Everybody else holds whatever
 * arrived by sync and can never correct it.
 *
 * Under plain last-write-wins that eats itself. A laptop that has never spoken
 * to QuickBooks still carries a copy of the answer from its last sync; edit
 * anything on that invoice there — a memo, a tracking number — and the whole row
 * goes up carrying the frozen balance, lands on the desktop, and overwrites the
 * reading taken minutes ago. The invoice reverts to owing money that was paid,
 * and the only machine that could fix it is the one that just got clobbered.
 *
 * No conflict, no reject, no error: two valid rows, later one wins. And it gets
 * WORSE the more the team syncs, which is backwards.
 */
{
  const inv = 'inv-qbo'
  db.prepare(
    `INSERT INTO invoices
       (id, customer_name, terms, invoice_date, due_date, status, total, created_at, updated_at,
        qbo_balance, qbo_total_amt, qbo_payments_applied, qbo_status_checked_at)
     VALUES (?, 'WeTheHobby', 'Due on receipt', '2026-09-01', '2026-09-01', 'paid', 28000,
             '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z',
             0, 28000, 28000, '2026-09-01T18:00:00.000Z')`
  ).run(inv)

  const send = (row: Record<string, unknown>, seq: number): void => {
    sync.applyRows([
      {
        kind: 'invoices',
        id: inv,
        seq,
        updated_at: String(row.updated_at),
        deleted: 0 as const,
        data: JSON.stringify({ id: inv, ...row })
      }
    ])
  }
  const read = () =>
    db
      .prepare(
        `SELECT memo, qbo_balance, qbo_payments_applied, qbo_status_checked_at
           FROM invoices WHERE id = ?`
      )
      .get(inv) as {
      memo: string | null
      qbo_balance: number
      qbo_payments_applied: number
      qbo_status_checked_at: string
    }

  // THE LAPTOP'S EDIT. Later row, real change to a normal column — and a
  // QuickBooks reading eight hours STALER than the one already here.
  send(
    {
      customer_name: 'WeTheHobby',
      terms: 'Due on receipt',
      invoice_date: '2026-09-01',
      due_date: '2026-09-01',
      status: 'paid',
      total: 28000,
      created_at: '2026-09-01T10:00:00.000Z',
      updated_at: '2026-09-01T20:00:00.000Z',
      memo: 'left with the front desk',
      qbo_balance: 28000,
      qbo_total_amt: 28000,
      qbo_payments_applied: 0,
      qbo_status_checked_at: '2026-09-01T10:00:00.000Z'
    },
    1
  )
  const after = read()
  ok(after.memo === 'left with the front desk', 'the ordinary edit lands — normal columns still merge')
  ok(
    after.qbo_balance === 0 && after.qbo_payments_applied === 28000,
    'BUT THE STALE QUICKBOOKS READING DOES NOT — the paid balance survives the laptop that ' +
      'cannot ask QuickBooks and was carrying an eight-hour-old answer',
    `balance ${after.qbo_balance}, applied ${after.qbo_payments_applied}`
  )
  ok(
    after.qbo_status_checked_at === '2026-09-01T18:00:00.000Z',
    'and the observation time does not go backwards',
    after.qbo_status_checked_at
  )

  // A GENUINELY NEWER READING STILL WINS. The guard is freshness, not a freeze:
  // the desktop checks again, finds a credit memo reversed, and that must land.
  send(
    {
      customer_name: 'WeTheHobby',
      terms: 'Due on receipt',
      invoice_date: '2026-09-01',
      due_date: '2026-09-01',
      status: 'paid',
      total: 28000,
      created_at: '2026-09-01T10:00:00.000Z',
      updated_at: '2026-09-01T21:00:00.000Z',
      memo: 'left with the front desk',
      qbo_balance: 500,
      qbo_total_amt: 28000,
      qbo_payments_applied: 27500,
      qbo_status_checked_at: '2026-09-01T20:30:00.000Z'
    },
    2
  )
  const newer = read()
  ok(
    newer.qbo_balance === 500 && newer.qbo_payments_applied === 27500,
    'A NEWER READING STILL LANDS — this is a freshness rule, not a freeze, or the answer ' +
      'could never leave the one machine allowed to ask',
    `balance ${newer.qbo_balance}`
  )

  // A row from a build that has no observation time at all must not be treated
  // as an observation from the beginning of time.
  send(
    {
      customer_name: 'WeTheHobby',
      terms: 'Due on receipt',
      invoice_date: '2026-09-01',
      due_date: '2026-09-01',
      status: 'paid',
      total: 28000,
      created_at: '2026-09-01T10:00:00.000Z',
      updated_at: '2026-09-01T22:00:00.000Z',
      memo: 'collected',
      qbo_balance: 28000,
      qbo_payments_applied: 0
    },
    3
  )
  const bare = read()
  ok(
    bare.memo === 'collected' && bare.qbo_balance === 500,
    'AND A ROW CARRYING NO OBSERVATION TIME CANNOT TOUCH THE READING AT ALL — it is not ' +
      'evidence of anything, so it merges everything else and leaves this alone',
    `memo ${bare.memo}, balance ${bare.qbo_balance}`
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
