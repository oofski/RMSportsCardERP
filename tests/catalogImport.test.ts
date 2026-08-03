/**
 * The owner's product list, added to the catalog without disturbing it.
 *
 * The whole instruction for this import was one sentence: add what is missing,
 * and "if they already exist or have a matching skew don't replace them or touch
 * any of the current inventory that is a huge deal". So the assertions that
 * matter here are not about how many rows landed — they are about what did NOT
 * change. Section 3 photographs every column of every pre-existing product plus
 * its stock and its cost lots, runs the import, and compares byte for byte.
 *
 * Run: npm run test:catalog
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/catalog-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const {
  seedCatalogV3,
  catalogNameKey,
  catalogProductId,
  isMatchableSku
} = require('../src/main/db/inventoryCatalogV3')
const { yearOf, unitTypeOf } = require('../src/main/db/inventorySeed')
const { boxesPerCaseFromName } = require('../src/shared/units')
const { CATEGORY_ORDER, CATEGORY_COLORS } = require('../src/shared/inventory')

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

interface ProductRow {
  id: string
  sku: string
  upc: string | null
  name: string
  category: string
  brand: string
  year: string
  unit_type: string
  boxes_per_case: number | null
  packs_per_box: number | null
  unit_cost: number
  high_bid: number | null
  sale_price: number | null
  reorder_point: number
  created_at: string
  updated_at: string
}

const allProducts = (): ProductRow[] =>
  db.prepare('SELECT * FROM inventory_products ORDER BY id').all() as ProductRow[]

// ---------------------------------------------------------------------------
console.log('=== 1. the keys the import matches on ===')
// ---------------------------------------------------------------------------
ok(
  catalogNameKey('2025 Topps Chrome Football Hobby 12-Box Case') ===
    catalogNameKey('2025 topps chrome football hobby 12 box case'),
  'name key ignores case and the hyphen in "12-Box"'
)
ok(
  catalogNameKey("2025 Bowman's Best Baseball Hobby 8-Box Case") ===
    catalogNameKey('2025 Bowmans Best Baseball Hobby 8-Box Case'),
  'name key ignores the apostrophe'
)
ok(
  catalogNameKey('2026 Topps Chrome  UFC   Hobby Box') === '2026 topps chrome ufc hobby box',
  'name key collapses runs of whitespace'
)
ok(
  catalogNameKey('Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case') ===
    'pokemon scarlet violet destined rivals sleeved booster case',
  'name key drops the ampersand'
)
ok(
  catalogNameKey('2025 Topps Chrome Football Hobby Box') !==
    catalogNameKey('2025 Topps Chrome Football Hobby 12-Box Case'),
  'a box and its case are still two different products'
)
ok(catalogNameKey('') === '' && catalogNameKey('   ') === '', 'an empty name yields an empty key')

// The placeholder SKUs are the trap: 27 rows in the list share "BOX".
ok(!isMatchableSku('BOX'), '"BOX" is not a matchable SKU')
ok(!isMatchableSku('box'), 'the placeholder check is case-insensitive')
ok(!isMatchableSku('n/a'), '"n/a" is not a matchable SKU')
ok(!isMatchableSku(''), 'an empty SKU is not matchable')
ok(!isMatchableSku('12'), 'a two-character SKU is too short to match on')
ok(isMatchableSku('6578'), 'a real numeric SKU is matchable')
ok(isMatchableSku('100-10623'), 'a hyphenated vendor SKU is matchable')
ok(isMatchableSku('FS6260'), 'an alphanumeric SKU is matchable')

// ---------------------------------------------------------------------------
console.log('\n=== 2. ids are the same on every machine ===')
// ---------------------------------------------------------------------------
const idA = catalogProductId('2026 Topps Chrome UFC Hobby Box')
const idB = catalogProductId('2026 Topps Chrome UFC Hobby Box')
ok(idA === idB, 'the same name gives the same id')
ok(
  catalogProductId('2026 topps chrome ufc hobby box') === idA,
  'the id is derived from the normalized key, not the raw string'
)
ok(catalogProductId('2026 Topps Chrome UFC Mega Box') !== idA, 'a different name gives a different id')
ok(
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idA),
  'the id is shaped like every other product id in the database',
  idA
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the import does not touch what is already there ===')
// ---------------------------------------------------------------------------
// getDb() has already run the import once as part of the migration sequence, so
// the catalog on disk here is the post-import state. Everything below re-runs it
// against that state, which is the harder case: every row is now a collision.
const seedCount = allProducts().length
ok(seedCount > 300, `the catalog has ${seedCount} products after the migration ran`)

// Give a handful of products the marks of real use — stock, a cost, a high bid,
// an edited name — so "untouched" means something stronger than "still exists".
const victims = allProducts().slice(0, 12)
const stamp = '2020-01-01T00:00:00.000Z'
for (const p of victims) {
  db.prepare(
    `UPDATE inventory_products
        SET unit_cost = 123.45, high_bid = 999.99, sale_price = 250, reorder_point = 7,
            packs_per_box = 24, notes = 'do not touch', updated_at = ?
      WHERE id = ?`
  ).run(stamp, p.id)
  db.prepare(
    `INSERT INTO inventory_stock (id, product_id, location, quantity) VALUES (?, ?, 'RM', 5)
     ON CONFLICT(product_id, location) DO UPDATE SET quantity = 5`
  ).run('stk-' + p.id, p.id)
}

const before = JSON.stringify(allProducts())
const beforeStock = JSON.stringify(
  db.prepare('SELECT * FROM inventory_stock ORDER BY id').all()
)
const beforeLots = JSON.stringify(
  db.prepare('SELECT * FROM inventory_lots ORDER BY id').all()
)

const second = seedCatalogV3(db)
ok(second.inserted === 0, 'a second run inserts nothing', String(second.inserted))
ok(
  second.skippedByName + second.skippedBySku === second.considered,
  'every row of the list is accounted for as a skip',
  `${second.skippedByName}+${second.skippedBySku} of ${second.considered}`
)
ok(JSON.stringify(allProducts()) === before, 'not one product column changed')
ok(
  JSON.stringify(db.prepare('SELECT * FROM inventory_stock ORDER BY id').all()) === beforeStock,
  'not one stock row changed'
)
ok(
  JSON.stringify(db.prepare('SELECT * FROM inventory_lots ORDER BY id').all()) === beforeLots,
  'not one cost lot changed'
)
ok(
  (db.prepare("SELECT COUNT(*) AS c FROM inventory_products WHERE notes = 'do not touch'").get() as {
    c: number
  }).c === victims.length,
  'the edited products kept their edits'
)
ok(
  (
    db
      .prepare('SELECT COUNT(*) AS c FROM inventory_products WHERE updated_at = ?')
      .get(stamp) as { c: number }
  ).c === victims.length,
  'updated_at was not bumped on any existing product'
)

// The structural guarantee, checked against the source rather than the behaviour:
// a file with no UPDATE and no DELETE in it cannot modify anything.
const src: string = require('node:fs').readFileSync(
  join(process.cwd(), 'src/main/db/inventoryCatalogV3.ts'),
  'utf8'
)
const sql = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
ok(!/\bUPDATE\s+inventory/i.test(sql), 'the import module contains no UPDATE statement')
ok(!/\bDELETE\s+FROM/i.test(sql), 'the import module contains no DELETE statement')
ok(!/\bINSERT\s+OR\s+REPLACE\b/i.test(sql), 'the import module never uses INSERT OR REPLACE')
ok(!/\bON\s+CONFLICT\b/i.test(sql), 'the import module never upserts')

// ---------------------------------------------------------------------------
console.log('\n=== 4. what a fresh install ends up with ===')
// ---------------------------------------------------------------------------
// Same list, same rules, against an empty catalog — so the row-shaping rules can
// be checked on rows this run actually created.
const fresh = new (require('better-sqlite3'))(':memory:')
fresh.exec(
  db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_products'")
    .get().sql
)
const freshResult = seedCatalogV3(fresh)
ok(freshResult.considered === 306, 'the list holds 306 rows', String(freshResult.considered))
ok(
  freshResult.inserted === 306,
  'all 306 land in an empty catalog',
  String(freshResult.inserted)
)
ok(
  freshResult.skippedByName === 0 && freshResult.skippedBySku === 0,
  'the list has no duplicates within itself'
)
// The list puts SKU 6415 on two unrelated products. Both are real and both must
// land; only one of them can be carrying the right number, which is the owner's
// call to make, not this import's.
ok(
  (
    fresh
      .prepare("SELECT COUNT(*) AS c FROM inventory_products WHERE sku = '6415'")
      .get() as { c: number }
  ).c === 2,
  'both products sharing SKU 6415 landed'
)

const rows = fresh.prepare('SELECT * FROM inventory_products').all() as ProductRow[]
const byName = new Map(rows.map((r) => [r.name, r]))

ok(rows.every((r) => r.upc === null), 'every UPC is blank, as asked')
ok(rows.every((r) => r.unit_cost === 0), 'every unit cost is blank')
ok(rows.every((r) => r.high_bid === null), 'every high bid is blank')
ok(rows.every((r) => r.sale_price === null), 'every sale price is blank')
ok(rows.every((r) => r.packs_per_box === null), 'packs per box is never guessed')
ok(rows.every((r) => r.reorder_point === 0), 'every reorder point is blank')
ok(
  rows.every((r) => r.created_at === r.updated_at && r.created_at.length > 0),
  'every row carries a timestamp'
)
ok(new Set(rows.map((r) => r.id)).size === rows.length, 'no two rows share an id')

// Case vs box, and how many boxes are in the case.
const caseRows = rows.filter((r) => /case/i.test(r.name))
const boxRows = rows.filter((r) => !/case/i.test(r.name))
ok(caseRows.length === 279 && boxRows.length === 27, 'the list is 279 cases and 27 boxes')
ok(caseRows.every((r) => r.unit_type === 'case'), 'every case is stored as a case')
ok(boxRows.every((r) => r.unit_type === 'box'), 'every box is stored as a box')
ok(boxRows.every((r) => r.boxes_per_case === null), 'a single box has no boxes-per-case')

const CASES: Array<[string, number | null]> = [
  ['2026 Topps Chrome Baseball Jumbo Hobby 8-Box Case', 8],
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby 12-Box Case', 12],
  ['2024-25 Upper Deck The Cup Hockey Hobby 3-Box Case', 3],
  ['2024-25 Topps UEFA Club Competitions Chrome Soccer Hanger 64-Box Case', 64],
  // Written with a space instead of a hyphen — the same product shape.
  ['2025-26 Topps UEFA Club Competitions Soccer Hobby 12 Box Case', 12],
  ['2026 Panini USA Stars And Stripes Prizm Baseball Hobby 12 Box Case', 12],
  // A case of something that is not boxes. Guessing here would divide every
  // break cost by the wrong number, so it stays blank.
  ['2026 Topps Series 1 Baseball 36-Tin Case', null],
  ['2025 Topps Allen & Ginter Baseball Fat Pack 108-Pack Case', null],
  ['2024-25 Panini Eminence Basketball Hobby Case', null],
  ['Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case', null],
  ['Carrying On His Will Booster Case', null]
]
for (const [name, expected] of CASES) {
  const r = byName.get(name)
  ok(
    !!r && r.boxes_per_case === expected && r.unit_type === 'case',
    `boxes/case: ${name.slice(0, 56)} → ${expected === null ? 'blank' : expected}`,
    r ? String(r.boxes_per_case) : 'missing'
  )
  ok(!!r && boxesPerCaseFromName(name) === expected, `the shared contract agrees for ${name.slice(0, 40)}`)
}

// Season parsing, including the one row written "2024-2025".
const YEARS: Array<[string, string]> = [
  ['2026 Topps Chrome Baseball Jumbo Hobby 8-Box Case', '2026'],
  ['2020-21 Panini Prizm Basketball Hobby Box', '2020-21'],
  ['2024-2025 Marvel Studios Chrome Sapphire Edition Hobby 10-Box Case', '2024-25'],
  ['Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case', ''],
  ['Carrying On His Will Booster Case', '']
]
for (const [name, expected] of YEARS) {
  const r = byName.get(name)
  ok(!!r && r.year === expected, `year: ${name.slice(0, 50)} → "${expected}"`, r ? r.year : 'missing')
  ok(yearOf(name) === expected, `yearOf agrees for ${name.slice(0, 40)}`)
}
ok(unitTypeOf('Carrying On His Will Booster Case') === 'case', 'a booster case is still a case')

// SKUs go in exactly as written — a leading zero is part of the SKU.
ok(
  byName.get('2024-25 Upper Deck Engrained Icons Hockey Hobby 10-Box Case')?.sku === '03495',
  'a leading-zero SKU keeps its zero',
  String(byName.get('2024-25 Upper Deck Engrained Icons Hockey Hobby 10-Box Case')?.sku)
)
ok(
  byName.get('Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case')?.sku === '100-10623',
  'a hyphenated SKU is stored verbatim'
)
ok(
  rows.filter((r) => r.sku === 'BOX').length === 27,
  'all 27 placeholder SKUs went in as written rather than being deduped away',
  String(rows.filter((r) => r.sku === 'BOX').length)
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. categories ===')
// ---------------------------------------------------------------------------
const cats = new Map<string, number>()
for (const r of rows) cats.set(r.category, (cats.get(r.category) ?? 0) + 1)
ok(!cats.has('Combat'), 'nothing is filed under the retired "Combat" category')
ok(
  cats.get('UFC') === 24,
  'the 24 Combat rows became UFC, where the app files fighting',
  String(cats.get('UFC'))
)
ok(cats.get('Racing') === 8, 'Racing came through', String(cats.get('Racing')))
ok(cats.get('Tennis') === 2, 'Tennis came through', String(cats.get('Tennis')))
ok(cats.get('Baseball') === 81 && cats.get('Football') === 57, 'the big two came through whole')
for (const c of cats.keys()) {
  ok(CATEGORY_ORDER.includes(c), `"${c}" has a place in the dashboard order`)
  ok(!!CATEGORY_COLORS[c], `"${c}" has a colorway`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. an existing product is recognised, however it was typed ===')
// ---------------------------------------------------------------------------
const scenario = new (require('better-sqlite3'))(':memory:')
scenario.exec(
  db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_products'")
    .get().sql
)
const put = (id: string, name: string, sku: string): void => {
  scenario
    .prepare(
      `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
       VALUES (?, ?, ?, 'Baseball', 99, '2020-01-01', '2020-01-01')`
    )
    .run(id, sku, name)
}
// Same product, typed four ways it plausibly already sits in the catalog.
put('keep-1', '2025 topps chrome football hobby 12 box case', '9999') // case + hyphen differ
put('keep-2', "2025 BOWMAN'S BEST BASEBALL HOBBY 8-BOX CASE", '9998') // apostrophe + caps
put('keep-3', 'Renamed by hand — Topps Disney Chrome', '6782') // renamed, real SKU intact
put('keep-4', 'Another hand-typed name', 'BOX') // placeholder SKU, unrelated name

const s = seedCatalogV3(scenario)
ok(s.skippedByName >= 2, 'the two re-typed names were matched by name', String(s.skippedByName))
ok(s.skippedBySku >= 1, 'the renamed product was matched by its SKU', String(s.skippedBySku))
ok(
  s.inserted === 306 - s.skippedByName - s.skippedBySku,
  'skips and inserts add up to the whole list'
)
for (const id of ['keep-1', 'keep-2', 'keep-3', 'keep-4']) {
  const r = scenario.prepare('SELECT * FROM inventory_products WHERE id = ?').get(id) as ProductRow
  ok(!!r && r.unit_cost === 99, `${id} kept its cost basis`)
  ok(!!r && r.updated_at === '2020-01-01', `${id} was not re-stamped`)
}
ok(
  (
    scenario
      .prepare('SELECT COUNT(*) AS c FROM inventory_products WHERE name = ?')
      .get('2025 Topps Chrome Football Hobby 12-Box Case') as { c: number }
  ).c === 0,
  'no second copy of the re-typed case was created'
)
// The placeholder SKU must NOT have swallowed the 27 boxes that share it.
ok(
  (
    scenario
      .prepare("SELECT COUNT(*) AS c FROM inventory_products WHERE sku = 'BOX'").get() as {
      c: number
    }
  ).c === 28,
  'the "BOX" placeholder matched nothing — all 27 boxes still landed',
  String(
    (
      scenario.prepare("SELECT COUNT(*) AS c FROM inventory_products WHERE sku = 'BOX'").get() as {
        c: number
      }
    ).c
  )
)
// "6782" is Topps Disney Chrome. Matching it by SKU must not also skip a
// different product that happens to sort near it.
ok(
  (
    scenario
      .prepare('SELECT COUNT(*) AS c FROM inventory_products WHERE name = ?')
      .get('2026 Topps Disney Chrome Hobby 8-Box Case') as { c: number }
  ).c === 0,
  'the renamed Disney case was not re-added under its catalog name'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
