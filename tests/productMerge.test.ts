/**
 * Merging two catalog rows into one, without taking anything with them.
 *
 * `dedupeProducts` is a MIGRATION, so nobody watches it run and there is no
 * screen that shows what it did. That is exactly why it needed a suite: it
 * deletes rows in a database with `ON DELETE CASCADE` foreign keys pointing at
 * the row it deletes, and the damage that causes is invisible until somebody
 * opens a purchase order months later and finds it empty.
 *
 * Two failures are pinned, both of which the code had:
 *
 *   1. IT DELETED PURCHASE ORDER LINES. Four child tables were re-pointed onto
 *      the survivor and the rest were not. `purchase_order_lines.product_id` is
 *      ON DELETE CASCADE, so every order that had ever bought the losing product
 *      lost those lines outright — while keeping its stored header total, so the
 *      order still claimed to be worth $4,000 with nothing on it. Three more
 *      tables were left pointing at an id that no longer existed.
 *
 *   2. IT MERGED ON THE NAME ALONE. A name is not an identity. Two genuinely
 *      different boxes called "2025 Topps Series 1 Hobby Box" were made one:
 *      their shelves were added together and their FIFO cost lots were pooled,
 *      so the survivor's cost basis became a blend of two things that never cost
 *      the same — and every margin computed from it was wrong afterwards, with
 *      no record of why.
 *
 * The fixtures are invented. No real product, supplier or buyer is in this file.
 *
 * Run: npm run test:product-merge
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/product-merge-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const { dedupeProducts } = require('../src/main/db/dedupe')
const inv = require('../src/main/db/inventory')
const poRepo = require('../src/main/db/purchaseOrders')
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

const product = (over: Record<string, unknown> = {}): any =>
  inv.createProduct(
    {
      sku: '',
      upc: null,
      name: 'Invented Series One Hobby Box',
      category: 'Baseball',
      brand: 'Invented',
      setName: '',
      year: '2026',
      unitType: 'box',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 0,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null,
      ...over
    },
    null
  )

const countWhere = (table: string, column: string, value: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number })
    .n

// ---------------------------------------------------------------------------
console.log('=== 1. the merge does not take a purchase order with it ===')
// ---------------------------------------------------------------------------
// The CASCADE case, end to end: a real order, raised against the product that
// is about to lose, through the real create path.
{
  const keeper = product({ sku: 'INV-A1', upc: '000000000001', unitCost: 100 })
  // Same name, no identity of its own — the legacy shape this cleanup exists
  // for: one full row and one empty one, created twice by an early build.
  const dup = product({ sku: '', upc: null })

  const po = poRepo.createPurchaseOrder(
    {
      supplier: 'Invented Distributors',
      location: 'RM',
      lines: [{ productId: dup.id, quantity: 6, unitPrice: 95 }]
    },
    null
  )
  ok(po.lines.length === 1, 'the order is raised with one line')
  ok(countWhere('purchase_order_lines', 'po_id', po.id) === 1, 'and the line is on disk')

  // Stock and a cost layer on each side, so the fold is exercised too.
  inv.addStock(keeper.id, 'RM', 4, 100, null, null)
  inv.addStock(dup.id, 'RM', 3, 90, null, null)

  dedupeProducts(db)

  ok(inv.getProduct(keeper.id) !== null, 'the keeper survives')
  ok(inv.getProduct(dup.id) === null, 'and the duplicate is gone')

  // THE ASSERTION THE BUG WAS HIDING BEHIND.
  ok(
    countWhere('purchase_order_lines', 'po_id', po.id) === 1,
    'THE PURCHASE ORDER STILL HAS ITS LINE',
    String(countWhere('purchase_order_lines', 'po_id', po.id))
  )
  // Read defensively. When this regresses the line is DELETED, and a suite that
  // crashes on the missing row reports a TypeError instead of the sentence
  // above — which is the one thing somebody needs to read.
  const line = db
    .prepare('SELECT product_id, quantity FROM purchase_order_lines WHERE po_id = ?')
    .get(po.id) as { product_id: string; quantity: number } | undefined
  ok(line?.product_id === keeper.id, 'pointing at the surviving product', String(line?.product_id))
  ok(line?.quantity === 6, 'with the quantity that was ordered', String(line?.quantity))
  ok(poRepo.getPurchaseOrder(po.id)?.lines.length === 1, 'and the order still reads as one line')

  // The rest of the merge still does what it always did.
  const pooled = (
    db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_stock WHERE product_id = ?')
      .get(keeper.id) as { q: number }
  ).q
  ok(pooled === 7, 'the two shelves are pooled onto the survivor', String(pooled))
  ok(countWhere('inventory_lots', 'product_id', keeper.id) === 2, 'and both cost layers moved')
  ok(countWhere('inventory_lots', 'product_id', dup.id) === 0, 'with none left behind')
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. everything else that points at a product moves too ===')
// ---------------------------------------------------------------------------
// The quieter half. These are SET NULL or have no foreign key at all, so the
// row survives the delete and simply forgets which box it was about — which
// reads as missing data rather than as damage.
{
  const keeper = product({ name: 'Invented Two', sku: 'INV-B1' })
  const dup = product({ name: 'Invented Two' })
  const stamp = new Date().toISOString()

  db.prepare(
    `INSERT INTO inventory_scans (id, raw_code, outcome, product_id, created_at)
     VALUES ('scn_1', '000000000009', 'matched', ?, ?)`
  ).run(dup.id, stamp)
  db.prepare(
    `INSERT INTO stream_sessions (id, started_at, stream_date, created_at, updated_at)
     VALUES ('ses_1', ?, '2026-08-09', ?, ?)`
  ).run(stamp, stamp, stamp)
  db.prepare(
    `INSERT INTO stream_items (id, session_id, kind, product_id, product_name, quantity, location, created_at)
     VALUES ('sti_1', 'ses_1', 'break', ?, 'Invented Two', 1, 'RM', ?)`
  ).run(dup.id, stamp)

  dedupeProducts(db)

  ok(
    (db.prepare(`SELECT product_id AS p FROM inventory_scans WHERE id = 'scn_1'`).get() as any).p ===
      keeper.id,
    'a scan follows the product it was about'
  )
  ok(
    (db.prepare(`SELECT product_id AS p FROM stream_items WHERE id = 'sti_1'`).get() as any).p ===
      keeper.id,
    'and so does a stream item'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. the same name is not the same product ===')
// ---------------------------------------------------------------------------
// A UPC or a SKU is an identity; a name is a label. Where both rows carry one
// and the two disagree, these are different boxes and nothing may be merged.
{
  const a = product({ name: 'Invented Three', upc: '000000000021', unitCost: 100 })
  const b = product({ name: 'Invented Three', upc: '000000000022', unitCost: 250 })
  inv.addStock(a.id, 'RM', 2, 100, null, null)
  inv.addStock(b.id, 'RM', 5, 250, null, null)

  dedupeProducts(db)

  ok(inv.getProduct(a.id) !== null, 'the first box is left alone')
  ok(inv.getProduct(b.id) !== null, 'AND SO IS THE SECOND — two UPCs, two products')
  ok(inv.getProduct(a.id)?.unitCost === 100, 'each keeps its own cost', String(inv.getProduct(a.id)?.unitCost))
  ok(inv.getProduct(b.id)?.unitCost === 250, 'rather than a blend of the two', String(inv.getProduct(b.id)?.unitCost))
  const shelfA = (
    db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM inventory_stock WHERE product_id = ?').get(a.id) as any
  ).q
  ok(shelfA === 2, 'and its own shelf, unpooled', String(shelfA))
}
{
  // Same rule for a SKU. Two rows with no UPC at all but different SKUs are
  // still two products.
  const a = product({ name: 'Invented Four', sku: 'INV-D1' })
  const b = product({ name: 'Invented Four', sku: 'INV-D2' })
  dedupeProducts(db)
  ok(inv.getProduct(a.id) !== null && inv.getProduct(b.id) !== null, 'two SKUs, two products')
}
{
  // A BLANK IS NOT EVIDENCE. One full row and one empty one is the legacy shape
  // the cleanup exists for, and it must still merge.
  const full = product({ name: 'Invented Five', sku: 'INV-E1', upc: '000000000031' })
  const empty = product({ name: 'Invented Five' })
  dedupeProducts(db)
  const survivors = db
    .prepare(`SELECT id FROM inventory_products WHERE name = 'Invented Five'`)
    .all() as Array<{ id: string }>
  ok(survivors.length === 1, 'a blank row still merges into the full one', String(survivors.length))
  ok(survivors[0]?.id === full.id, 'and the full row is the one that survives')
  ok(inv.getProduct(empty.id) === null, 'the empty one is gone')
}
{
  // The keeper INHERITS the identity, which then guards the next comparison. A
  // blank keeper that picks up a SKU from the first duplicate must refuse a
  // third row carrying a different one.
  const blank = product({ name: 'Invented Six' })
  inv.addStock(blank.id, 'RM', 9, 10, null, null)
  const withSku = product({ name: 'Invented Six', sku: 'INV-F1' })
  const other = product({ name: 'Invented Six', sku: 'INV-F2' })

  dedupeProducts(db)

  ok(inv.getProduct(blank.id) !== null, 'the keeper is the one holding the stock')
  ok(inv.getProduct(blank.id)?.sku === 'INV-F1', 'and inherits the SKU it merged in', inv.getProduct(blank.id)?.sku)
  ok(inv.getProduct(withSku.id) === null, 'the matching row merged')
  ok(inv.getProduct(other.id) !== null, 'AND THE THIRD ROW DID NOT — its SKU disagrees with the keeper’s now')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. running it twice changes nothing ===')
// ---------------------------------------------------------------------------
// It is a migration guarded by runOnce, but a migration that is not idempotent
// is one bad `runOnce` key away from running against a live catalog.
{
  const before = db.prepare('SELECT id, name, sku, upc, unit_cost FROM inventory_products ORDER BY id').all()
  const stockBefore = db
    .prepare('SELECT product_id, location, quantity FROM inventory_stock ORDER BY product_id, location')
    .all()
  dedupeProducts(db)
  const after = db.prepare('SELECT id, name, sku, upc, unit_cost FROM inventory_products ORDER BY id').all()
  const stockAfter = db
    .prepare('SELECT product_id, location, quantity FROM inventory_stock ORDER BY product_id, location')
    .all()
  ok(JSON.stringify(before) === JSON.stringify(after), 'a settled catalog is untouched')
  ok(JSON.stringify(stockBefore) === JSON.stringify(stockAfter), 'and so are the shelves')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
