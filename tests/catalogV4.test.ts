/**
 * The August 2026 catalog top-up — and, mostly, what it must NOT do.
 *
 * The owner sent their distributor's product sheet and asked for three things,
 * the third in capitals: add what is missing, fill in the SKU and category
 * where they are absent or wrong, and **do not touch anything that already has
 * a barcode**. A scannable product is one somebody has already been through —
 * checked, matched, corrected — and rewriting a field underneath them is worse
 * than leaving a gap.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. NOTHING EXISTING IS MODIFIED. Not the name, not the SKU, not the
 *      barcode, not the cost, not the stock. The import path has no UPDATE in
 *      it and this proves that against a row deliberately made to look stale.
 *
 *   2. STOCK AND COST SURVIVE. The worst outcome is not a duplicate row — it
 *      is a product whose cost basis was reset, because that silently misstates
 *      the margin on everything sold out of it afterwards.
 *
 *   3. IT DOES NOT DUPLICATE. Matched by a normalised name and by a real SKU,
 *      so "Bowman's" and "Bowmans", or the same product under two names, do
 *      not both land.
 *
 *   4. THE ONE SKU CORRECTION IS GUARDED. 19837 → 19387 is a transposition, and
 *      it applies ONLY to a row that still holds the wrong value AND has no
 *      barcode. A barcoded row keeps its wrong SKU, deliberately.
 *
 *   5. THE NEW ROWS ARE USABLE. A name, a category the dashboard knows, and the
 *      boxes-per-case derived from the name — not a row that exists but cannot
 *      be ordered, costed or counted.
 *
 * Run: npm run test:catalog-v4
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/catalogv4-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const { fixTransposedSku, seedCatalogV4 } = require('../src/main/db/inventoryCatalogV4')
const { catalogNameKey } = require('../src/main/db/inventoryCatalogV3')
const { CATEGORY_ORDER } = require('../src/shared/inventory')
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

const byName = (name: string): any =>
  (db.prepare('SELECT * FROM inventory_products').all() as any[]).find(
    (p) => catalogNameKey(p.name) === catalogNameKey(name)
  )

// The migrations already ran when the database opened, so v4 is in. Everything
// below re-runs the seeder against that state, which is also the honest test:
// a second run must be a no-op.

// ---------------------------------------------------------------------------
console.log('\n=== 1. the rows landed, and are usable ===')
// ---------------------------------------------------------------------------
const NEW_ROWS = [
  ['2025-26 Topps Chrome Update Series Basketball Hobby Jumbo 8-Box Case', '6721', 'Basketball', 8],
  ['2026 Topps Pristine Baseball Hobby 6-Box Case', '6611', 'Baseball', 6],
  ['Pokemon Mega Evolution ME4 Chaos Rising Booster 6-Box Case', '10407-119', 'Pokemon', 6],
  ['2025 Topps Chrome Tennis Breaker’s Delight 12-Box Case', '6337', 'Tennis', 12],
  ['2026 Bo Jackson Battle Arena Tecmo Bowl Edition - Hobby 6-Box Case', '21067', 'Football', 6]
]
for (const [name, sku, category, boxes] of NEW_ROWS) {
  const row = byName(name as string)
  ok(!!row, `${String(name).slice(0, 44)}… is in the catalog`)
  if (!row) continue
  ok(row.sku === sku, '  with its SKU', `${row.sku} vs ${sku}`)
  ok(row.category === category, '  and its category', `${row.category} vs ${category}`)
  ok(row.boxes_per_case === boxes, '  and the boxes its case holds', String(row.boxes_per_case))
}

// REASON 5: a category the dashboard cannot draw is a product nobody finds.
const cats = new Set(
  (db.prepare('SELECT DISTINCT category AS c FROM inventory_products').all() as any[]).map((r) => r.c)
)
const unknown = [...cats].filter((c) => c && !CATEGORY_ORDER.includes(c))
ok(unknown.length === 0, 'every category in the catalog is one the dashboard knows', JSON.stringify(unknown))

// A single-box SKU is a box, not a case — and a box has no boxes-per-case.
const singleBox = byName('2026 Topps Chrome Baseball Hobby Box')
ok(!!singleBox, 'the single-box row landed')
ok(singleBox?.unit_type === 'box', 'as a BOX', String(singleBox?.unit_type))
ok(singleBox?.boxes_per_case === null, 'with no boxes-per-case invented for it', String(singleBox?.boxes_per_case))

// ---------------------------------------------------------------------------
console.log('\n=== 2. REASON 4: the guarded SKU correction ===')
// ---------------------------------------------------------------------------
const fixed = byName('2025-26 Panini Select Road to FIFA World Cup Soccer Hobby 12-Box Case')
ok(!!fixed, 'the Road to FIFA World Cup case is there')
ok(fixed?.sku === '19387', 'and carries the corrected SKU', String(fixed?.sku))

// The guard itself: a barcoded row holding the wrong value is LEFT ALONE.
db.prepare(
  `INSERT INTO inventory_products (id, sku, upc, upc_norm, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_barcoded', '19837', '012345678905', '00012345678905', 'Barcoded Decoy Case',
           'Soccer', 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()
// The SHIPPED statement, not a copy of it written here — a test that re-types
// the update proves only that the test can write one.
const changed = fixTransposedSku(db)
ok(changed === 0, 'and the correction finds nothing left to fix', String(changed))
const decoy = db.prepare(`SELECT sku, upc FROM inventory_products WHERE id = 'p_barcoded'`).get() as any
ok(decoy.sku === '19837', 'a BARCODED row keeps its wrong SKU — untouched, as asked', String(decoy.sku))

// ---------------------------------------------------------------------------
console.log('\n=== 3. REASONS 1, 2 and 3: a second run changes nothing ===')
// ---------------------------------------------------------------------------
// Make an existing catalog row look like one somebody has worked on: a barcode,
// a hand-typed name variant, stock, and a real cost basis.
const target = byName('2026 Topps Pristine Baseball Hobby 6-Box Case')
db.prepare(
  `UPDATE inventory_products
      SET upc = '098765432109', upc_norm = '00098765432109', sku = 'HAND-TYPED',
          unit_cost = 1234.56, name = '2026 Topps Pristine Baseball Hobby 6 Box Case'
    WHERE id = ?`
).run(target.id)
db.prepare(
  `INSERT INTO inventory_stock (id, product_id, location, quantity) VALUES ('st_v4', ?, 'RM', 7)`
).run(target.id)

const before = db.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }
const again = seedCatalogV4(db)
const after = db.prepare('SELECT COUNT(*) AS n FROM inventory_products').get() as { n: number }

ok(again.inserted === 0, 'a second run inserts nothing', String(again.inserted))
ok(after.n === before.n, 'and the catalog is the same size', `${before.n} → ${after.n}`)
ok(
  again.skippedByName + again.skippedBySku === again.considered,
  'every row was recognised as already there',
  `${again.skippedByName}+${again.skippedBySku} of ${again.considered}`
)

const kept = db.prepare('SELECT * FROM inventory_products WHERE id = ?').get(target.id) as any
ok(kept.upc === '098765432109', 'REASON 1: the barcode is untouched', String(kept.upc))
ok(kept.sku === 'HAND-TYPED', 'the hand-typed SKU is untouched', String(kept.sku))
ok(kept.name === '2026 Topps Pristine Baseball Hobby 6 Box Case', 'and the name', String(kept.name))
ok(kept.unit_cost === 1234.56, 'REASON 2: the cost basis survives', String(kept.unit_cost))
ok(
  (db.prepare('SELECT quantity AS q FROM inventory_stock WHERE product_id = ?').get(target.id) as any)
    ?.q === 7,
  'and so does the stock on the shelf'
)

// REASON 3: the name variant did not become a second product.
const dupes = (db.prepare('SELECT name FROM inventory_products').all() as any[])
  .map((p) => catalogNameKey(p.name))
  .filter((k) => k === catalogNameKey('2026 Topps Pristine Baseball Hobby 6-Box Case'))
ok(dupes.length === 1, 'and "6 Box Case" did not become a second copy of "6-Box Case"', String(dupes.length))

// Nothing anywhere in the catalog holds a duplicate normalised name.
const keys = (db.prepare('SELECT name FROM inventory_products').all() as any[]).map((p) =>
  catalogNameKey(p.name)
)
const dupeKeys = keys.filter((k, i) => keys.indexOf(k) !== i)
ok(dupeKeys.length === 0, 'no product name is duplicated anywhere', JSON.stringify([...new Set(dupeKeys)]))

// ---------------------------------------------------------------------------
console.log('\n=== 4. the four non-products stayed out ===')
// ---------------------------------------------------------------------------
// Invoice adjustments off the same distributor export — a fee swap, an
// allocation, a promotional credit, a rebate. Not stock, and a product row for
// one would be permanently empty and permanently unidentifiable.
for (const n of ['DealerNet EFT to Wire Swap', 'Giveaways', 'Show Boost', 'Super Seller Bonus']) {
  ok(!byName(n), `"${n}" is not a product`)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
