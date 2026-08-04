/**
 * The bulk re-adjustment, against a real database.
 *
 * The rule under test is one sentence: THE PASTED SHEET IS THE WHOLE WAREHOUSE.
 * Everything on it lands on its counted numbers; everything else goes to zero.
 * So the assertions come in two halves —
 *
 *   1. that a counted row lands exactly, and that an uncounted product is
 *      genuinely emptied: stock nil at EVERY location, no cost layer left open,
 *      the average re-synced, a ledger row written, and a fractional balance
 *      neither rounded up to a whole box nor down to nothing; and
 *
 *   2. that every widget agrees with the paper afterwards. The dashboard, the
 *      category cards and the owner board do not store a valuation — they derive
 *      one from on-hand × the product's average cost. Section 5 recomputes each
 *      of those from the database after an apply and compares them to the
 *      sheet's own arithmetic, to the cent, because a dashboard that is three
 *      dollars out is worse than one that is three hundred out: nobody notices.
 *
 * Plus the two properties that make it safe to run at all: the whole thing is
 * one transaction (a failure part-way leaves nothing changed), and pasting the
 * same sheet twice is a no-op.
 *
 * Run: npm run test:reset
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/reset-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const {
  createProduct,
  addStock,
  categorySummaries,
  inventoryStats,
  listLots,
  pricingList,
  setZeroCostBasis,
  stockQty,
  updateProduct
} = require('../src/main/db/inventory')
const { assertStockLotsConsistent } = require('../src/main/db/lots')
const { applyReset, previewReset, buildResetExport } = require('../src/main/db/inventoryReset')
const { getOwnerBoard } = require('../src/main/db/ownerDashboard')
const { LOCATION_IDS } = require('../src/shared/inventory')

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
/** Money equality, to the cent, without float dust deciding the answer. */
const cents = (n: number): number => Math.round(n * 100) / 100
const eq = (a: number, b: number): boolean => cents(a) === cents(b)

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
// getDb() has already run the migrations, which seed the owner's 306-product
// catalog AND a real on-hand snapshot. That is left exactly where it is, because
// it is the situation the owner described: a few rows pasted against a warehouse
// that is already carrying stock and money. The snapshot is measured here rather
// than hard-coded, and every count below is stated relative to it, so the test
// says "and the whole of what was already there was written off too" instead of
// quietly only looking at its own five products.
const preseeded = db
  .prepare(
    `SELECT COUNT(*) AS shelves,
            COUNT(DISTINCT product_id) AS products,
            COALESCE(SUM(s.quantity * p.unit_cost), 0) AS cost
       FROM inventory_stock s
       JOIN inventory_products p ON p.id = s.product_id
      WHERE s.quantity <> 0`
  )
  .get() as { shelves: number; products: number; cost: number }

interface Seed {
  name: string
  category: string
  cost: number
  bid: number | null
  rm: number
  am?: number
  amCost?: number
  giveaway?: boolean
  /** Boxes unless stated. Section 12 needs a case, because the uncosted-stock
   *  check answers differently for one. */
  unit?: string
}

const make = (s: Seed): string => {
  const p = createProduct(
    {
      sku: `T-${s.name.replace(/\W+/g, '').slice(0, 10)}`,
      upc: null,
      name: s.name,
      category: s.category,
      brand: '',
      setName: '',
      year: '',
      unitType: s.unit ?? 'box',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: !!s.giveaway,
      unitCost: s.cost,
      highBid: s.bid,
      salePrice: null,
      reorderPoint: 0,
      notes: null,
      openingQuantity: s.rm,
      openingLocation: 'RM'
    },
    null
  )
  if (s.am) addStock(p.id, 'AM', s.am, s.amCost ?? s.cost, 'seed', null)
  return p.id
}

const ALPHA = make({ name: 'TEST Alpha Hobby Box', category: 'Baseball', cost: 90, bid: 140, rm: 5 })
const BRAVO = make({
  name: 'TEST Bravo Hobby Box',
  category: 'Basketball',
  cost: 18,
  bid: 30,
  rm: 3,
  am: 2,
  amCost: 25
})
const CHARLIE = make({ name: 'TEST Charlie Hobby Box', category: 'Football', cost: 50, bid: 70, rm: 4 })
const DELTA = make({
  name: 'TEST Delta Giveaway Box',
  category: 'Pokemon',
  cost: 12,
  bid: null,
  rm: 9.75,
  giveaway: true
})
const ECHO = make({ name: 'TEST Echo Hobby Box', category: 'Hockey', cost: 10, bid: 15, rm: 2, am: 1 })

const HEADER = 'Product\tLocation\tQty\tMarket\tCost'
/** Alpha and Bravo counted; Charlie, Delta and Echo left off entirely. */
const SHEET_A = [
  HEADER,
  'TEST Alpha Hobby Box\tRM\t7\t160.00\t110.00',
  'TEST Bravo Hobby Box\tRM\t3\t45.00\t22.00',
  'TEST Bravo Hobby Box\tAM\t2\t45.00\t22.00'
].join('\n')

/** What the sheet itself says the warehouse is worth, done by hand. */
const SHEET_A_UNITS = 7 + 3 + 2
const SHEET_A_COST = 7 * 110 + 3 * 22 + 2 * 22
const SHEET_A_MARKET = 7 * 160 + 3 * 45 + 2 * 45

const preview = (text: string): any => previewReset({ text, mapping: null, defaultLocation: 'RM' })
const applySheet = (text: string, mapping: unknown): any =>
  applyReset({ text, mapping, defaultLocation: 'RM', source: 'test' }, null)

const openLots = (productId: string, location?: string): any[] =>
  db
    .prepare(
      `SELECT * FROM inventory_lots WHERE product_id = ? AND qty_remaining > 0` +
        (location ? ' AND location = ?' : '')
    )
    .all(...(location ? [productId, location] : [productId])) as any[]

const productRow = (id: string): any =>
  db.prepare('SELECT * FROM inventory_products WHERE id = ?').get(id) as any

// ---------------------------------------------------------------------------
console.log('=== 1. the plan reads the sheet as the whole warehouse ===')
// ---------------------------------------------------------------------------
const planA = preview(SHEET_A).plan
ok(planA.problems.length === 0, 'the mapping is understood', planA.problems.join(' | '))
ok(planA.counts.total === 3, 'three count rows', String(planA.counts.total))
ok(
  planA.counts.unmatched === 0 && planA.counts.ambiguous === 0 && planA.counts.invalid === 0,
  'every row matched a catalog product'
)
ok(
  planA.mapping.join(',') === 'name,location,quantity,marketEach,costEach',
  'the header mapped the five columns',
  planA.mapping.join(',')
)

// Everything the sheet does not name — the three uncounted fixtures AND the
// whole pre-existing snapshot — is on the write-off list.
const missingIds = new Set(planA.missing.map((m: any) => m.productId))
ok(
  missingIds.size === preseeded.products + 3,
  'every product not on the sheet is listed, not just the ones this test made',
  `${missingIds.size} vs ${preseeded.products + 3}`
)
ok(
  missingIds.has(CHARLIE) && missingIds.has(DELTA) && missingIds.has(ECHO),
  'Charlie, Delta and Echo are among them'
)
ok(
  planA.missing.length === preseeded.shelves + 4,
  'listed per SHELF, so Echo appears twice — once for RM and once for AM',
  `${planA.missing.length} vs ${preseeded.shelves + 4}`
)
ok(
  planA.missing.every((m: any) => m.unitMarket > 0),
  'each one is valued at market as well as cost — the money the dashboard loses'
)
ok(
  eq(
    planA.missing.reduce((n: number, m: any) => n + m.quantity * m.unitCost, 0),
    preseeded.cost + (4 * 50 + 9.75 * 12 + 2 * 10 + 1 * 10)
  ),
  'the write-off adds up to every dollar of cost basis the sheet does not account for'
)

// The totals the preview promises ARE the sheet's own arithmetic.
ok(eq(planA.totals.unitsAfter, SHEET_A_UNITS), 'units after = the sheet', String(planA.totals.unitsAfter))
ok(eq(planA.totals.costAfter, SHEET_A_COST), 'cost after = the sheet', String(planA.totals.costAfter))
ok(eq(planA.totals.marketAfter, SHEET_A_MARKET), 'market after = the sheet', String(planA.totals.marketAfter))

// A shelf the sheet skipped for a product it counted elsewhere is named on the
// row, because that is the shape of a location typo.
const bravoRow = planA.rows.find((r: any) => r.productId === BRAVO)
ok(!!bravoRow && bravoRow.warnings.length === 0, 'Bravo is counted at both shelves, so nothing to warn about')

// ---------------------------------------------------------------------------
console.log('\n=== 2. a row that cannot be read blocks the whole run ===')
// ---------------------------------------------------------------------------
const withGhost = SHEET_A + '\nTEST Ghost That Does Not Exist\tRM\t2\t10.00\t5.00'
const ghostPlan = preview(withGhost).plan
ok(ghostPlan.counts.unmatched === 1, 'the ghost row is unmatched')
ok(ghostPlan.problems.length > 0, 'and that is a BLOCKING problem, not a skipped line')
ok(
  /write off/i.test(ghostPlan.problems.join(' ')),
  'the problem says why: the rest would be written off',
  ghostPlan.problems.join(' | ')
)
const ghostApply = applySheet(withGhost, ghostPlan.mapping)
ok(ghostApply.ok === false, 'apply refuses it')
ok(stockQty(CHARLIE, 'RM') === 4, 'and nothing moved — Charlie is still at 4')

const noQty = SHEET_A + '\nTEST Charlie Hobby Box\tRM\t\t70.00\t50.00'
const noQtyPlan = preview(noQty).plan
ok(noQtyPlan.counts.invalid === 1, 'a row with no quantity is rejected, not silently skipped')
ok(noQtyPlan.problems.length > 0, 'and it blocks too')

const badMapping = preview('Product\tQty\nTEST Alpha Hobby Box\t4').plan
ok(
  badMapping.problems.some((p: string) => /Cost/i.test(p)) &&
    badMapping.problems.some((p: string) => /Market/i.test(p)),
  'a sheet with no money columns cannot be a baseline',
  badMapping.problems.join(' | ')
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the run is atomic ===')
// ---------------------------------------------------------------------------
// The summary INSERT is the last thing applyReset does, so taking its table away
// fails the transaction AFTER every stock, lot and ledger write has happened.
// If any of that survives, the run is not atomic.
const snapshot = (): string =>
  JSON.stringify({
    stock: db.prepare('SELECT * FROM inventory_stock ORDER BY product_id, location').all(),
    lots: db.prepare('SELECT * FROM inventory_lots ORDER BY id').all(),
    txns: db.prepare('SELECT * FROM inventory_transactions ORDER BY id').all(),
    products: db.prepare('SELECT id, unit_cost, high_bid FROM inventory_products ORDER BY id').all()
  })

const beforeFailure = snapshot()
db.exec('ALTER TABLE inventory_resets RENAME TO inventory_resets_hidden')
const doomed = applySheet(SHEET_A, planA.mapping)
db.exec('ALTER TABLE inventory_resets_hidden RENAME TO inventory_resets')
ok(doomed.ok === false, 'a failure part-way through is reported, not swallowed')
ok(snapshot() === beforeFailure, 'and NOTHING changed — not a stock row, a lot, a ledger row or a cost')

// ---------------------------------------------------------------------------
console.log('\n=== 4. applying it ===')
// ---------------------------------------------------------------------------
const applied = applySheet(SHEET_A, planA.mapping)
ok(applied.ok === true, 'the sheet applies', applied.ok ? '' : applied.error)
const run = applied.data.run
ok(run.rowsSkipped === 0, 'nothing was skipped')
ok(run.productsCreated === 0, 'nothing was created')
ok(
  run.shelvesZeroed === preseeded.shelves + 4,
  'every shelf the sheet did not name was emptied — the fixtures and the whole snapshot',
  `${run.shelvesZeroed} vs ${preseeded.shelves + 4}`
)

// -- counted rows land exactly ------------------------------------------------
ok(stockQty(ALPHA, 'RM') === 7, 'Alpha is at the counted 7', String(stockQty(ALPHA, 'RM')))
ok(productRow(ALPHA).unit_cost === 110, 'at the counted unit cost', String(productRow(ALPHA).unit_cost))
ok(productRow(ALPHA).high_bid === 160, 'and the counted market value')
ok(
  openLots(ALPHA, 'RM').every((l: any) => l.unit_cost === 110),
  'every open cost layer was re-based, not just the newest'
)
ok(
  openLots(ALPHA, 'RM').reduce((n: number, l: any) => n + l.qty_remaining, 0) === 7,
  'and the layers add up to the counted quantity'
)
ok(stockQty(BRAVO, 'RM') === 3 && stockQty(BRAVO, 'AM') === 2, 'Bravo landed on both shelves')
ok(productRow(BRAVO).unit_cost === 22, 'Bravo re-based BOTH shelves to the counted cost — no stale AM layer')

// -- an uncounted product is emptied everywhere ------------------------------
for (const [label, id] of [
  ['Charlie', CHARLIE],
  ['Delta', DELTA],
  ['Echo', ECHO]
] as Array<[string, string]>) {
  ok(
    LOCATION_IDS.every((loc: string) => stockQty(id, loc) === 0),
    `${label} holds nothing at any location`,
    LOCATION_IDS.map((l: string) => `${l}=${stockQty(id, l)}`).join(' ')
  )
  ok(openLots(id).length === 0, `${label} has no open cost layer left to resurface`)
  ok(listLots(id).length === 0, `${label} shows an empty FIFO case list`)
  ok(
    (db.prepare('SELECT COUNT(*) AS c FROM inventory_lots WHERE product_id = ?').get(id) as any).c > 0,
    `${label} kept the retired layers as history rather than deleting them`
  )
  ok(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM inventory_transactions
            WHERE product_id = ? AND type = 'adjustment' AND note LIKE '%not on the count sheet%'`
        )
        .get(id) as any
    ).c > 0,
    `${label} left an auditable ledger row`
  )
}
ok(
  applied.data.applied.some((l: string) => l.includes('TEST Echo') && l.includes('AM')),
  "the run's detail log names the second location too, not just the first"
)

// -- a fraction is not rounded on the way out --------------------------------
ok(
  stockQty(DELTA, 'RM') === 0,
  'the 9.75-box giveaway zeroed to exactly nothing',
  String(stockQty(DELTA, 'RM'))
)
const deltaTxn = db
  .prepare(
    `SELECT quantity_change AS q FROM inventory_transactions
      WHERE product_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  )
  .get(DELTA) as any
ok(deltaTxn.q === -9.75, 'the ledger records -9.75, not -10 and not -9.8', String(deltaTxn.q))

assertStockLotsConsistent(db)
ok(true, 'Σ lot.qty_remaining still equals stock for every shelf')

// ---------------------------------------------------------------------------
console.log('\n=== 5. every widget now reads back the sheet ===')
// ---------------------------------------------------------------------------
const stats = inventoryStats()
ok(eq(stats.totalCost, SHEET_A_COST), 'dashboard total cost = the sheet', String(stats.totalCost))
ok(eq(stats.totalValue, SHEET_A_MARKET), 'dashboard inventory value = the sheet', String(stats.totalValue))
ok(
  eq(stats.spread, SHEET_A_MARKET - SHEET_A_COST),
  'dashboard spread = market − cost from the sheet',
  String(stats.spread)
)
ok(stats.units === SHEET_A_UNITS, 'dashboard units on hand = the sheet', String(stats.units))
ok(
  stats.unitsByLocation.RM === 10 && stats.unitsByLocation.AM === 2,
  'units by location match the sheet',
  JSON.stringify(stats.unitsByLocation)
)
ok(
  stats.zeroCost.length === 0,
  'nothing is left on the shelf carried at $0.00',
  stats.zeroCost.map((z: any) => z.name).join(', ')
)

// The value-by-category chart and the category stat cards read the same query.
const cats = new Map(categorySummaries().map((c: any) => [c.category, c]))
ok(eq((cats.get('Baseball') as any).value, 7 * 160), 'Baseball category value = Alpha on the sheet')
ok(eq((cats.get('Basketball') as any).value, 5 * 45), 'Basketball category value = Bravo on the sheet')
for (const gone of ['Football', 'Pokemon', 'Hockey']) {
  ok(eq((cats.get(gone) as any).value, 0), `${gone} fell to zero with its only stocked product`)
  ok((cats.get(gone) as any).units === 0, `${gone} shows no units`)
}
ok(
  eq(
    categorySummaries().reduce((n: number, c: any) => n + c.value, 0),
    SHEET_A_MARKET
  ),
  'the category chart sums to the same number as the headline tile'
)

// The hover card / quick-view derive their own money from the same three fields.
const alphaCard = productRow(ALPHA)
ok(
  eq(7 * (alphaCard.high_bid || alphaCard.unit_cost), 7 * 160) &&
    eq(7 * alphaCard.unit_cost, 7 * 110),
  'the product card computes inv. value and total cost from the counted numbers'
)
const alphaCases = listLots(ALPHA)
ok(
  alphaCases.reduce((n: number, l: any) => n + l.qtyRemaining, 0) === 7 &&
    alphaCases.every((l: any) => l.unitCost === 110),
  'the FIFO case view shows seven cases, every one at the counted cost'
)

// Daily Pricing is the fourth derivation of the same three fields, and the one
// that decides what gets re-priced. A zeroed product must drop out of it rather
// than sit there at its old bid asking to be looked at.
const pricing = pricingList()
ok(
  pricing.every((r: any) => r.id !== CHARLIE && r.id !== DELTA && r.id !== ECHO),
  'the pricing list no longer offers the emptied products'
)
ok(
  eq(pricing.reduce((n: number, r: any) => n + r.invValue, 0), SHEET_A_MARKET),
  'and its inventory value column sums to the sheet',
  String(pricing.reduce((n: number, r: any) => n + r.invValue, 0))
)
ok(
  eq(pricing.reduce((n: number, r: any) => n + r.spread, 0), SHEET_A_MARKET - SHEET_A_COST),
  'as does its spread'
)

// The owner board must not have an opinion of its own.
const board = getOwnerBoard({ finance: false, invoicing: false, inventory: true, streaming: false })
ok(
  eq(board.inventory.stockValue, SHEET_A_COST),
  "the owner dashboard's inventory snapshot = the sheet",
  String(board.inventory.stockValue)
)

// And the export round-trips: what comes out is what was pasted in.
const exported = buildResetExport()
ok(exported.split('\n').length === 4, 'the export writes exactly the three counted shelves', exported)
ok(exported.includes('\t7\t160.00\t1120.00\t110.00\t770.00'), 'with Alpha at the counted numbers')

// ---------------------------------------------------------------------------
console.log('\n=== 6. pasting the same sheet twice changes nothing ===')
// ---------------------------------------------------------------------------
const second = preview(SHEET_A).plan
ok(second.counts.change === 0, 'nothing is left to change', String(second.counts.change))
ok(second.counts.same === 3, 'all three rows read as already correct')
ok(second.missing.length === 0, 'and there is nothing left to zero')

const beforeIdempotent = snapshot()
const again = applySheet(SHEET_A, second.mapping)
ok(again.ok === true, 're-applying it succeeds')
ok(again.data.run.rowsApplied === 0 && again.data.run.shelvesZeroed === 0, 'and writes nothing')
ok(snapshot() === beforeIdempotent, 'the database is byte-for-byte what it was')

// ---------------------------------------------------------------------------
console.log('\n=== 7. a fractional count lands as a fraction ===')
// ---------------------------------------------------------------------------
const SHEET_B = [
  HEADER,
  'TEST Alpha Hobby Box\tRM\t7\t160.00\t110.00',
  'TEST Bravo Hobby Box\tRM\t3\t45.00\t22.00',
  'TEST Bravo Hobby Box\tAM\t2\t45.00\t22.00',
  'TEST Delta Giveaway Box\tRM\t4.5\t20.00\t14.00'
].join('\n')
const planB = preview(SHEET_B).plan
ok(planB.problems.length === 0, 'the sheet is readable', planB.problems.join(' | '))
const deltaRow = planB.rows.find((r: any) => r.productId === DELTA)
ok(deltaRow.quantityAfter === 4.5, 'the plan keeps the half box', String(deltaRow.quantityAfter))
ok(deltaRow.warnings.length === 0, 'and does not complain — this product is flagged for fractions')
ok(applySheet(SHEET_B, planB.mapping).ok === true, 'it applies')
ok(stockQty(DELTA, 'RM') === 4.5, 'Delta is at 4.5 boxes', String(stockQty(DELTA, 'RM')))
ok(
  openLots(DELTA, 'RM').reduce((n: number, l: any) => n + l.qty_remaining, 0) === 4.5,
  'and its cost layer holds 4.5, not 5'
)
ok(productRow(DELTA).unit_cost === 14, 'valued at the counted cost')
ok(
  eq(inventoryStats().totalCost, SHEET_A_COST + 4.5 * 14),
  'the dashboard total carries the fraction to the cent',
  String(inventoryStats().totalCost)
)
assertStockLotsConsistent(db)
ok(true, 'the lot/stock invariant survives a fractional count')

// A non-giveaway product cannot be counted in halves, and says so.
const halfAlpha = preview(
  [HEADER, 'TEST Alpha Hobby Box\tRM\t6.5\t160.00\t110.00'].join('\n')
).plan
const halfRow = halfAlpha.rows.find((r: any) => r.productId === ALPHA)
ok(halfRow.quantityAfter === 7, 'a half box on an ordinary product rounds', String(halfRow.quantityAfter))
ok(
  halfRow.warnings.some((w: string) => /fractional/i.test(w)),
  'and the rounding is stated on the row rather than done quietly'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. two shelves at two costs, and no cents lost between them ===')
// ---------------------------------------------------------------------------
// 3 @ $10 and 4 @ $20 is $110.00 on the paper. It used to be $109.97 on the
// dashboard, because the product stores ONE average unit cost — $15.7142…,
// rounded — and every widget rebuilt its value as on-hand × that number, which
// multiplies the rounding by the quantity. The layers are now the source of
// every total, so there is nothing left to round: this reads $110.00 exactly,
// the preview promises $110.00, and the two are the same arithmetic rather than
// two that were made to agree.
const FOX = make({ name: 'TEST Foxtrot Hobby Box', category: 'Soccer', cost: 5, bid: 9, rm: 1 })
const SHEET_C = [
  HEADER,
  'TEST Alpha Hobby Box\tRM\t7\t160.00\t110.00',
  'TEST Bravo Hobby Box\tRM\t3\t45.00\t22.00',
  'TEST Bravo Hobby Box\tAM\t2\t45.00\t22.00',
  'TEST Delta Giveaway Box\tRM\t4.5\t20.00\t14.00',
  'TEST Foxtrot Hobby Box\tRM\t3\t30.00\t10.00',
  'TEST Foxtrot Hobby Box\tAM\t4\t30.00\t20.00'
].join('\n')
const planC = preview(SHEET_C).plan
const foxRows = planC.rows.filter((r: any) => r.productId === FOX)
ok(foxRows.length === 2, 'Foxtrot is counted at both locations')
// This row used to carry a warning saying the dashboard would read three cents
// under the sheet. It was true, and it is now false — the totals come off the
// layers, so there is no blend gap left to warn about. A warning that states a
// discrepancy which no longer occurs is worse than no warning: it teaches the
// operator to expect the dashboard to be wrong.
ok(
  foxRows.every((r: any) => !r.warnings.some((w: string) => /different unit costs/i.test(w))),
  'no blend warning — there is no longer a blend gap to warn about',
  foxRows.map((r: any) => r.warnings.join('/')).join(' | ')
)
ok(applySheet(SHEET_C, planC.mapping).ok === true, 'it applies')
// The stored average is a PER-UNIT figure now, kept at four places rather than
// two. It is no longer what any total is built from — but it is still the basis
// a shelf with no cost layer falls back on, and it is what the Avg cost column
// shows, so $15.7143 is the honest number and $15.71 was not.
ok(
  productRow(FOX).unit_cost === 15.7143,
  'the stored average is the blend at per-unit precision',
  String(productRow(FOX).unit_cost)
)
const statsC = inventoryStats()
ok(
  eq(statsC.totalCost, planC.totals.costAfter),
  'the dashboard lands on the number the PREVIEW promised, to the cent',
  `${statsC.totalCost} vs ${planC.totals.costAfter}`
)
ok(
  eq(
    getOwnerBoard({ finance: false, invoicing: false, inventory: true, streaming: false }).inventory
      .stockValue,
    statsC.totalCost
  ),
  'and the owner board still reads the same number as the dashboard'
)
// Was: within five cents of the sheet, the gap being "the predicted rounding".
// There is no predicted rounding any more. Foxtrot is worth 3 × $10 + 4 × $20 =
// $110.00 and the dashboard says so to the cent.
ok(
  eq(statsC.totalCost, SHEET_A_COST + 4.5 * 14 + 110),
  'the dashboard is the sheet EXACTLY — 3 @ $10 + 4 @ $20 is $110.00, not $109.97',
  String(statsC.totalCost)
)
ok(
  eq(planC.totals.costAfter, SHEET_A_COST + 4.5 * 14 + 110),
  'and so is the total the preview promised before anything was written',
  String(planC.totals.costAfter)
)
assertStockLotsConsistent(db)
ok(true, 'the invariant holds after the multi-shelf revaluation')

// ---------------------------------------------------------------------------
console.log('\n=== 9. the catalog itself is never edited ===')
// ---------------------------------------------------------------------------
// The owner was emphatic about this during the catalog import: a count sets
// stock and money, it does not touch product records.
const alphaBefore = productRow(ALPHA)
const rekeyed = [
  'Product\tSKU\tCategory\tLocation\tQty\tMarket\tCost',
  'TEST Alpha Hobby Box\tWRONG-SKU\tBadminton\tRM\t7\t160.00\t110.00',
  'TEST Bravo Hobby Box\tX\tX\tRM\t3\t45.00\t22.00',
  'TEST Bravo Hobby Box\tX\tX\tAM\t2\t45.00\t22.00',
  'TEST Delta Giveaway Box\tX\tX\tRM\t4.5\t20.00\t14.00',
  'TEST Foxtrot Hobby Box\tX\tX\tRM\t3\t30.00\t10.00',
  'TEST Foxtrot Hobby Box\tX\tX\tAM\t4\t30.00\t20.00'
].join('\n')
const planD = preview(rekeyed).plan
ok(planD.problems.length === 0, 'the sheet is still readable with junk identity columns')
ok(applySheet(rekeyed, planD.mapping).ok === true, 'and it applies')
const alphaAfter = productRow(ALPHA)
ok(alphaAfter.sku === alphaBefore.sku, 'the SKU was not rewritten', alphaAfter.sku)
ok(alphaAfter.category === alphaBefore.category, 'the category was not rewritten', alphaAfter.category)
ok(alphaAfter.upc === alphaBefore.upc && alphaAfter.name === alphaBefore.name, 'nor the UPC or the name')
ok(
  (db.prepare("SELECT COUNT(*) AS c FROM inventory_products WHERE category = 'Badminton'").get() as any)
    .c === 0,
  'and no product moved into the category the sheet invented'
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. a row that counts zero empties the shelf too ===')
// ---------------------------------------------------------------------------
// Naming a product and writing 0 beside it is a different act from leaving it
// off, and it has to land in the same place: no stock, no open layer.
const zeroRow = [
  HEADER,
  'TEST Alpha Hobby Box\tRM\t7\t160.00\t110.00',
  'TEST Bravo Hobby Box\tRM\t0\t45.00\t22.00',
  'TEST Bravo Hobby Box\tAM\t2\t45.00\t22.00',
  'TEST Delta Giveaway Box\tRM\t4.5\t20.00\t14.00',
  'TEST Foxtrot Hobby Box\tRM\t3\t30.00\t10.00',
  'TEST Foxtrot Hobby Box\tAM\t4\t30.00\t20.00'
].join('\n')
const planE = preview(zeroRow).plan
ok(planE.problems.length === 0, 'a counted zero is a valid row, not a rejected one')
ok(applySheet(zeroRow, planE.mapping).ok === true, 'it applies')
ok(stockQty(BRAVO, 'RM') === 0, "Bravo's RM shelf is empty", String(stockQty(BRAVO, 'RM')))
ok(openLots(BRAVO, 'RM').length === 0, 'with no layer left open on it')
ok(stockQty(BRAVO, 'AM') === 2, 'and its AM shelf is untouched at the counted 2')
ok(productRow(BRAVO).unit_cost === 22, 'the average now comes from AM alone')
assertStockLotsConsistent(db)
ok(true, 'the invariant holds after a counted zero')

// ---------------------------------------------------------------------------
console.log('\n=== 11. export, then paste it straight back ===')
// ---------------------------------------------------------------------------
// The owner's actual loop: export the current count, mark it up in Excel, paste
// the result in. An unmodified round trip has to be a no-op — including for the
// half box and for the product carrying two different shelf costs, which is
// exactly where a cost export that wrote the product AVERAGE instead of the
// shelf's would quietly revalue both shelves to their blend.
const roundTrip = preview(buildResetExport()).plan
ok(roundTrip.problems.length === 0, 'the export maps itself with no help', roundTrip.problems.join(' | '))
ok(
  roundTrip.counts.change === 0 && roundTrip.missing.length === 0,
  'and re-pasting it changes nothing at all',
  `${roundTrip.counts.change} changing, ${roundTrip.missing.length} to zero`
)
ok(
  roundTrip.counts.same === roundTrip.counts.total && roundTrip.counts.total > 0,
  'every exported shelf reads back as already correct',
  `${roundTrip.counts.same} of ${roundTrip.counts.total}`
)
ok(
  eq(roundTrip.totals.costAfter, roundTrip.totals.costBefore) &&
    eq(roundTrip.totals.marketAfter, roundTrip.totals.marketBefore),
  'and the totals do not move by a cent'
)

// ---------------------------------------------------------------------------
console.log('\n=== 12. stock that would end at $0.00: a case blocks, a box is noted ===')
// ---------------------------------------------------------------------------
// WHAT HAPPENED. A catalog import created 184 products at unit_cost 0. A baseline
// paste then counted them with the cost column blank, which correctly means "the
// sheet did not state this" and so left every one of them on the basis it
// already had — nothing. The run reported no trouble; the dashboard reported
// $16,039.93 of Spread that was pure fiction, because spread is market − cost
// and the cost was zero.
//
// A blank quantity has always been fatal. A blank cost that leaves a CASE on the
// shelf at nothing is the same class of problem and does more damage, because it
// fails SILENTLY. It blocks, on exactly one condition: whether the stock ENDS at
// a zero cost basis. Not whether the cell is empty.
//
// A BOX is the exception and only a box, because the dashboard stopped counting
// an uncosted box as profit: it holds it out of the Spread and reports how much
// it is holding. So the run warns and applies. A box is also the thing that gets
// picked up with no price to hand, which is why its cost is optional everywhere
// else; a case is a four-figure purchase whose price is known when it is bought.
const GOLF = make({ name: 'TEST Golf Uncosted Case', category: 'Baseball', cost: 0, bid: 200, rm: 0, unit: 'case' })
const HOTEL = make({ name: 'TEST Hotel Uncosted Case', category: 'Baseball', cost: 0, bid: 75, rm: 0, unit: 'case' })
const KILO = make({ name: 'TEST Kilo Uncosted Box', category: 'Baseball', cost: 0, bid: 120, rm: 0 })
const LIMA = make({ name: 'TEST Lima Tracked Box', category: 'Baseball', cost: 60, bid: 100, rm: 2 })

/** Everything currently on a shelf, restated so a sheet is the whole warehouse. */
const heldNow = (): string[] =>
  (
    db
      .prepare(
        `SELECT p.name AS name, s.location AS loc, s.quantity AS qty,
                COALESCE(p.high_bid, 0) AS bid, p.unit_cost AS cost
           FROM inventory_stock s
           JOIN inventory_products p ON p.id = s.product_id
          WHERE s.quantity > 0`
      )
      .all() as Array<{ name: string; loc: string; qty: number; bid: number; cost: number }>
  ).map((r) => `${r.name}\t${r.loc}\t${r.qty}\t${(r.bid || r.cost).toFixed(2)}\t${r.cost.toFixed(2)}`)

// -- a case is refused, and it says which products ---------------------------
const uncosted = [HEADER, ...heldNow(), 'TEST Golf Uncosted Case\tRM\t6\t200.00\t'].join('\n')
const planF = preview(uncosted).plan
ok(planF.counts.invalid === 0, 'the row itself is perfectly readable — it is not a rejected row')
ok(planF.problems.length > 0, 'but the run is blocked all the same')
const blockText = planF.problems.join(' | ')
ok(/no cost/i.test(blockText), 'the problem says what is wrong', blockText)
ok(blockText.includes('TEST Golf Uncosted Case'), 'and names the product', blockText)
ok(/\(6\)/.test(blockText), 'with the quantity that would sit there uncosted', blockText)
ok(
  applySheet(uncosted, planF.mapping).ok === false,
  'apply refuses it rather than booking the stock at nothing'
)
ok(stockQty(GOLF, 'RM') === 0, 'and nothing was written')
const golfRow = planF.rows.find((r: any) => r.productId === GOLF)
ok(
  golfRow.warnings.some((w: string) => /holding the count up/i.test(w)),
  'the row itself is flagged too, so the operator knows which line to fix',
  JSON.stringify(golfRow.warnings)
)

// On a case, a cell stating a literal 0 is the same outcome by a different
// route, and is refused for the same reason — the test is what the shelf ends up
// carrying. (On a box it is a declaration and is accepted; see below.)
const explicitZero = [HEADER, ...heldNow(), 'TEST Golf Uncosted Case\tRM\t6\t200.00\t0.00'].join('\n')
ok(preview(explicitZero).plan.problems.length > 0, 'a cost cell stating $0.00 on a case is refused too')

// Several of them are all named, not just the first.
const twoUncosted = [
  HEADER,
  ...heldNow(),
  'TEST Golf Uncosted Case\tRM\t6\t200.00\t',
  'TEST Hotel Uncosted Case\tAM\t2\t75.00\t'
].join('\n')
const twoText = preview(twoUncosted).plan.problems.join(' | ')
ok(
  twoText.includes('TEST Golf Uncosted Case') && twoText.includes('TEST Hotel Uncosted Case'),
  'both uncosted products are named',
  twoText
)
ok(/^2 products/.test(twoText), 'and counted', twoText)

// -- a BOX is a note, and the run goes through -------------------------------
// The same sheet shape, against a box. Nothing about the paste changes; what
// changes is what the dashboard does with the result, and that is what decides
// whether refusing is worth the cost of refusing.
const boxBlank = [HEADER, ...heldNow(), 'TEST Kilo Uncosted Box\tRM\t4\t120.00\t'].join('\n')
const planK = preview(boxBlank).plan
ok(planK.problems.length === 0, 'a box left with no cost does not block the run', planK.problems.join(' | '))
const kiloRow = planK.rows.find((r: any) => r.productId === KILO)
ok(
  kiloRow.warnings.some((w: string) => /outside the spread/i.test(w)),
  'it is a note on the row instead, saying where the stock ends up',
  JSON.stringify(kiloRow.warnings)
)
ok(applySheet(boxBlank, planK.mapping).ok === true, 'and the sheet applies')
ok(stockQty(KILO, 'RM') === 4, 'the boxes are on the shelf', String(stockQty(KILO, 'RM')))
ok(productRow(KILO).unit_cost === 0, 'carrying nothing', String(productRow(KILO).unit_cost))
const kiloPricing = pricingList().find((r: any) => r.id === KILO)
ok(eq(kiloPricing.invValue, 4 * 120), 'they are still worth their high bid', String(kiloPricing.invValue))
ok(kiloPricing.outsideSpread === true && eq(kiloPricing.spread, 0), 'and they carry no spread at all')
const kiloBanner = inventoryStats().zeroCost.find((z: any) => z.id === KILO)
ok(
  !!kiloBanner && kiloBanner.outsideSpread === true,
  'the banner reports them as held OUT of the spread, not as invented profit'
)
ok(
  eq(
    inventoryStats().outsideSpreadValue,
    inventoryStats()
      .zeroCost.filter((z: any) => z.outsideSpread)
      .reduce((n: number, z: any) => n + z.marketValue, 0)
  ),
  'and the excluded figure is exactly what the banner adds up to',
  String(inventoryStats().outsideSpreadValue)
)

// -- an explicit 0 on a box is a VALUE, not an omission ----------------------
// Blank means "the sheet did not say" and keeps what the product had. A typed 0
// means "we do not track cost for this one" and is written as stated — which is
// destructive, because it clears a basis that was there, and is the only way to
// say it.
const limaCostBefore = productRow(LIMA).unit_cost
ok(limaCostBefore === 60, 'Lima starts out carrying a real basis', String(limaCostBefore))
const limaZero = [HEADER, ...heldNow()]
  .map((line) =>
    line.startsWith('TEST Lima Tracked Box\t')
      ? line.split('\t').slice(0, 4).join('\t') + '\t0.00'
      : line
  )
  .join('\n')
const planL = preview(limaZero).plan
ok(planL.problems.length === 0, 'an explicit $0.00 on a box is accepted', planL.problems.join(' | '))
const limaRow = planL.rows.find((r: any) => r.productId === LIMA)
ok(limaRow.shelfCostAfter === 0, 'the zero is written as stated, not read as a blank', String(limaRow.shelfCostAfter))
ok(
  limaRow.warnings.some((w: string) => /clears the/i.test(w)),
  'the row says which basis it is about to clear',
  JSON.stringify(limaRow.warnings)
)
ok(
  !limaRow.warnings.some((w: string) => /No cost for this box/i.test(w)),
  'and is not also told it forgot to say — it said'
)
ok(applySheet(limaZero, planL.mapping).ok === true, 'it applies')
ok(productRow(LIMA).unit_cost === 0, 'the basis it carried is gone', String(productRow(LIMA).unit_cost))
ok(
  openLots(LIMA).every((l: any) => l.unit_cost === 0),
  'the layers under the stock went with it — not just the average'
)
const limaPricing = pricingList().find((r: any) => r.id === LIMA)
ok(limaPricing.outsideSpread === true && eq(limaPricing.spread, 0), 'and it now sits outside the spread too')

// -- allowed through when there IS a basis to keep ---------------------------
// This is the half that stops the check being a nuisance: an ordinary recount
// leaves the cost column blank on products whose cost is already set, and must
// not force anybody to retype it. Alpha is a BOX, so this is also the other side
// of the distinction above: a blank keeps the cost, a typed 0 would have cleared
// it, and the two do not mean the same thing just because a box may end at zero.
const alphaCostBefore = productRow(ALPHA).unit_cost
ok(alphaCostBefore > 0, 'Alpha already carries a real cost basis', String(alphaCostBefore))
const recount = [HEADER, ...heldNow()]
  .map((line) =>
    line.startsWith('TEST Alpha Hobby Box\t')
      ? line.split('\t').slice(0, 4).join('\t') + '\t'
      : line
  )
  .join('\n')
const planG = preview(recount).plan
ok(planG.problems.length === 0, 'a blank cost on a costed product does NOT block', planG.problems.join(' | '))
const alphaRow = planG.rows.find((r: any) => r.productId === ALPHA)
ok(
  alphaRow.warnings.some((w: string) => /keeps its current basis/i.test(w)),
  'it is a note on the row rather than a blocker',
  JSON.stringify(alphaRow.warnings)
)
ok(alphaRow.shelfCostAfter === null, 'nothing is written to that shelf’s cost')
ok(
  !alphaRow.warnings.some((w: string) => /outside the spread/i.test(w)),
  'and a costed box is not told it is uncosted, because it is not',
  JSON.stringify(alphaRow.warnings)
)
ok(eq(alphaRow.costAfter, alphaCostBefore), 'and the basis it keeps is the one it had', String(alphaRow.costAfter))
ok(applySheet(recount, planG.mapping).ok === true, 'the recount applies')
ok(
  eq(productRow(ALPHA).unit_cost, alphaCostBefore),
  'Alpha still carries exactly what it did',
  String(productRow(ALPHA).unit_cost)
)

// -- THE PROPERTY THE WHOLE CHANGE EXISTS FOR --------------------------------
// A run that passes cannot leave stock whose market value the Spread is
// reporting as profit. `zeroCost` is `qty > 0 AND cost_value <= 0` per product,
// the same condition the planner refuses on, and this asserts the two agree on
// real data rather than by reading.
//
// The property is now stated over the rows the banner marks as INFLATING the
// spread. An uncosted box may survive a run — that is the whole of the change
// above — but it lands in the excluded half, where the dashboard counts it in
// Inventory value, keeps it out of Spread and says how much it is holding out.
// A product in the other half is the failure this check exists to prevent.
const inflating = (): any[] => inventoryStats().zeroCost.filter((z: any) => !z.outsideSpread)
ok(
  inflating().length === 0,
  'after a run that passed, nothing is inflating the spread',
  inflating()
    .map((z: any) => z.name)
    .join(', ')
)
ok(
  inventoryStats().zeroCost.some((z: any) => z.id === KILO),
  'while the uncosted box that was allowed through is still named — as excluded'
)

// And the same, once for every sheet in this file that was allowed to apply: a
// costed sheet, a fractional one and a counted zero all end with nothing
// inflating the spread.
for (const [label, text] of [
  ['a fully costed sheet', [HEADER, ...heldNow()].join('\n')],
  [
    'one that also puts stock on a previously uncosted product',
    [HEADER, ...heldNow(), 'TEST Hotel Uncosted Case\tRM\t3\t75.00\t44.00'].join('\n')
  ]
] as Array<[string, string]>) {
  const p = preview(text).plan
  ok(p.problems.length === 0, `${label} is accepted`, p.problems.join(' | '))
  ok(applySheet(text, p.mapping).ok === true, `  ${label} applies`)
  ok(
    inflating().length === 0,
    `  and leaves nothing inflating the spread`,
    inflating()
      .map((z: any) => z.name)
      .join(', ')
  )
}
ok(stockQty(HOTEL, 'RM') === 3, 'the newly costed product is on the shelf', String(stockQty(HOTEL, 'RM')))
ok(productRow(HOTEL).unit_cost === 44, 'carrying the cost the sheet stated', String(productRow(HOTEL).unit_cost))
assertStockLotsConsistent(db)
ok(true, 'and the stock/lot invariant survived all of it')

// ---------------------------------------------------------------------------
console.log('\n=== 13. putting a cost on stock that is carrying nothing ===')
// ---------------------------------------------------------------------------
// THE CAVEAT BOTH FIELDS HAVE TO CLEAR. A product's stored average is not what a
// total is built from — the valuation reads the cost LAYERS first. A product
// that reached the banner the usual way (created at zero, then counted by a
// paste that opened its layers at the zero it found, or a box taken in with the
// cost left blank) has layers, all at zero, so writing the average alone would
// change nothing anybody can see. Both the catalog's cost field and the banner's
// re-base the layers carrying nothing as well, because a field that silently
// fails at the one thing it was offered for is worse than no field.
const stuck = make({ name: 'TEST India Zero Layers', category: 'Baseball', cost: 0, bid: 90, rm: 4 })
ok(
  openLots(stuck).length > 0 && openLots(stuck).every((l: any) => l.unit_cost === 0),
  'the fixture has open layers and every one of them carries nothing'
)
ok(
  inventoryStats().zeroCost.some((z: any) => z.id === stuck),
  'so the banner lists it'
)
const stuckSpreadBefore = inventoryStats().spread

// The CATALOG's own field — "go into the catalog and make sure it actually has a
// price". That is where an operator goes to price a product, so that is where
// pricing one has to land.
updateProduct({ id: stuck, unitCost: 25 })
ok(productRow(stuck).unit_cost === 25, 'the product row carries what was typed')
ok(
  openLots(stuck).every((l: any) => l.unit_cost === 25),
  'and so do the layers under the stock — not just the average'
)
ok(
  !inventoryStats().zeroCost.some((z: any) => z.id === stuck),
  'so the banner has nothing left to say about it'
)
ok(
  eq(inventoryStats().spread - stuckSpreadBefore, 4 * 90 - 4 * 25),
  'and the spread rises by exactly market minus the cost that was just set',
  String(inventoryStats().spread - stuckSpreadBefore)
)

// The BANNER's field is the same operation, and reports what it did so the row
// can say whether the fix landed rather than assume it.
const stillStuck = make({ name: 'TEST Kilo Zero Layers', category: 'Baseball', cost: 0, bid: 90, rm: 4 })
const fixed = setZeroCostBasis(stillStuck, 25)
ok(!!fixed, 'the banner’s field puts a real basis on it')
ok(
  fixed.layersRevalued === openLots(stillStuck).length,
  'every layer carrying nothing was re-based',
  String(fixed.layersRevalued)
)
ok(openLots(stillStuck).every((l: any) => l.unit_cost === 25), 'they now carry the stated cost')
ok(eq(fixed.costValue, 4 * 25), 'the reported basis is the stock at that cost', String(fixed.costValue))
ok(fixed.costValue > 0, 'which is what tells the caller the fix actually landed')
ok(
  !inventoryStats().zeroCost.some((z: any) => z.id === stillStuck),
  'and the banner no longer lists it'
)
ok(eq(productRow(stillStuck).unit_cost, 25), 'the average agrees with the layers under it')

// A layer carrying a REAL price is never touched: this is a screen for stock
// with no basis, not one for repricing a purchase.
const priced = make({ name: 'TEST Juliet Half Priced', category: 'Baseball', cost: 30, bid: 90, rm: 2 })
addStock(priced, 'AM', 2, 0, 'seed a zero layer', null)
setZeroCostBasis(priced, 11)
ok(
  openLots(priced, 'RM').every((l: any) => l.unit_cost === 30),
  'the RM layer keeps the $30 somebody actually paid'
)
ok(
  openLots(priced, 'AM').every((l: any) => l.unit_cost === 11),
  'while the AM layer that carried nothing takes the new figure'
)
assertStockLotsConsistent(db)
ok(true, 'and the invariant holds after a revaluation')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
