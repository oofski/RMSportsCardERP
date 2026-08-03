/**
 * What stock on the shelf is worth, on every screen that says so.
 *
 * The defect this suite exists for is one line of arithmetic. The product's
 * `unit_cost` is the weighted average of its remaining FIFO cost layers, and
 * every valuation surface used to rebuild its total as on-hand × that average.
 * An average is a rate and it has to be rounded; multiplying it back up by the
 * quantity multiplies the rounding by the quantity too. Three boxes at $10.00
 * and four at $20.00 is $110.00 of stock — the average is $15.7142…, and seven
 * of anything that fits in a money column is not $110.00.
 *
 * The model under test: THE LAYERS ARE THE TRUTH. A shelf is worth Σ (qty ×
 * what that qty cost), the average is a derived per-unit display number, and no
 * total is ever reconstructed from it. Two things have to hold for that to be
 * safe rather than merely exact, and both are asserted here:
 *
 *   - stock with NO layers must not value at zero (section 6). That would be a
 *     far worse bug than the rounding — real stock reading as worthless;
 *   - layers that do not match the stock must not invent money (section 7), and
 *     the disagreement has to be findable rather than absorbed into a tile.
 *
 * Every listed surface is checked separately, on purpose. They do not all share
 * a helper, and "the dashboard is right" has never implied "the pricing screen
 * is right" in this app.
 *
 * Run: npm run test:valuation
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/valuation-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const {
  addStock,
  adjustStock,
  categorySummaries,
  createProduct,
  inventoryStats,
  listLots,
  listProducts,
  pricingList,
  recordSale,
  stockQty
} = require('../src/main/db/inventory')
const { assertStockLotsConsistent, unitMoney } = require('../src/main/db/lots')
const { layerGaps, shelfBasis } = require('../src/main/db/valuation')
const { previewReset, buildResetExport, resetCatalog } = require('../src/main/db/inventoryReset')
const { getOwnerBoard } = require('../src/main/db/ownerDashboard')
const { productMetrics } = require('../src/renderer/src/modules/inventory/helpers')

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
// getDb() has run the migrations, which seed a 306-product catalog AND a real
// on-hand snapshot. That snapshot is cleared here — not because it is in the
// way, but because this suite asserts ABSOLUTE totals: "$110.00" is a much
// stronger statement than "$110.00 more than it was", and a delta would hide a
// sign error or a double count in the baseline. The catalog itself is left
// alone; only stock and open layers go.
db.exec('DELETE FROM inventory_stock')
db.exec('UPDATE inventory_lots SET qty_remaining = 0')

interface Seed {
  name: string
  category?: string
  cost: number
  bid?: number | null
  qty?: number
  location?: string
  giveaway?: boolean
}

const make = (s: Seed): string =>
  createProduct(
    {
      sku: `V-${s.name.replace(/\W+/g, '').slice(0, 12)}`,
      upc: null,
      name: s.name,
      category: s.category ?? 'Baseball',
      brand: '',
      setName: '',
      year: '',
      unitType: 'box',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: !!s.giveaway,
      unitCost: s.cost,
      highBid: s.bid ?? null,
      salePrice: null,
      reorderPoint: 0,
      notes: null,
      openingQuantity: s.qty ?? 0,
      openingLocation: s.location ?? 'RM'
    },
    null
  ).id

const productRow = (id: string): any =>
  db.prepare('SELECT * FROM inventory_products WHERE id = ?').get(id) as any

const oneProduct = (id: string): any => listProducts().find((p: any) => p.id === id)
const onePricing = (id: string): any => pricingList().find((r: any) => r.id === id)
const categoryValue = (name: string): number =>
  categorySummaries().find((c: any) => c.category === name)?.value ?? 0
const ownerStockValue = (): number =>
  getOwnerBoard({ finance: false, invoicing: false, inventory: true, streaming: false }).inventory
    .stockValue

// ---------------------------------------------------------------------------
console.log('=== 1. three at $10 and four at $20 is $110.00, everywhere ===')
// ---------------------------------------------------------------------------
// THE headline case, stated once and then asserted against every surface that
// reports a valuation. $109.97 is the wrong answer and it is named explicitly in
// each assertion message, because the whole failure mode of this bug is that
// three cents looks like nothing.
const HEAD = make({ name: 'VAL Headline Hobby Box', category: 'Baseball', cost: 10, qty: 3 })
addStock(HEAD, 'RM', 4, 20, 'second layer', null)

const WRONG = 109.97
const RIGHT = 110

const stats1 = inventoryStats()
ok(stats1.units === 7, 'seven boxes on hand', String(stats1.units))
ok(
  eq(stats1.totalCost, RIGHT) && !eq(stats1.totalCost, WRONG),
  'dashboard Total cost is $110.00, not $109.97',
  String(stats1.totalCost)
)
ok(
  eq(stats1.totalValue, RIGHT),
  'dashboard Inventory value is $110.00 — unpriced stock is valued at what it cost',
  String(stats1.totalValue)
)
ok(eq(stats1.spread, 0), 'and the spread on unpriced stock is exactly zero', String(stats1.spread))
ok(
  stats1.unitsByLocation.RM === 7 && stats1.unitsByLocation.AM === 0,
  'units by location',
  JSON.stringify(stats1.unitsByLocation)
)

ok(eq(categoryValue('Baseball'), RIGHT), 'the category stat card reads $110.00', String(categoryValue('Baseball')))
ok(
  eq(
    categorySummaries().reduce((n: number, c: any) => n + c.value, 0),
    stats1.totalValue
  ),
  'and the value-by-category bars sum to the headline tile'
)

const price1 = onePricing(HEAD)
ok(eq(price1.invValue, RIGHT), 'Daily Pricing inv. value is $110.00', String(price1.invValue))
ok(eq(price1.costValue, RIGHT), 'its cost basis is $110.00', String(price1.costValue))
ok(eq(price1.spread, 0), 'and its spread is zero, not three cents', String(price1.spread))

const card1 = productMetrics(oneProduct(HEAD))
ok(
  eq(card1.totalCost, RIGHT) && !eq(card1.totalCost, WRONG),
  'the hover card / quick view total cost is $110.00, not $109.97',
  String(card1.totalCost)
)
ok(eq(card1.invValue, RIGHT), 'and its inventory value is $110.00', String(card1.invValue))

const lots1 = listLots(HEAD)
ok(lots1.length === 2, 'the FIFO case view lists two cost layers', String(lots1.length))
ok(
  eq(
    lots1.reduce((n: number, l: any) => n + l.qtyRemaining * l.unitCost, 0),
    RIGHT
  ),
  'and those layers themselves add up to $110.00 — the number every tile came from'
)
ok(
  lots1[0].unitCost === 10 && lots1[1].unitCost === 20,
  'oldest first, at the prices actually paid',
  lots1.map((l: any) => l.unitCost).join(',')
)

ok(eq(ownerStockValue(), RIGHT), "the owner board's stock value is $110.00", String(ownerStockValue()))

// The average is still stored, still shown, and still cannot carry the total.
const avg = productRow(HEAD).unit_cost
ok(avg === unitMoney(110 / 7), 'the stored average is the blend at per-unit precision', String(avg))
ok(eq(7 * avg, RIGHT), 'seven of the stored average rounds to $110.00 at four places', String(7 * avg))
ok(
  cents(7 * cents(avg)) === WRONG,
  'while seven of the CENT-rounded average is $109.97 — the number this suite exists to never see again',
  String(cents(7 * cents(avg)))
)
ok(eq(price1.unitCost, avg), 'the Avg cost column shows that same per-unit figure', String(price1.unitCost))

// The reset preview promises the same total it will find afterwards.
const previewTotals = (): any =>
  previewReset({
    text: ['Product\tLocation\tQty\tMarket\tCost', 'VAL Headline Hobby Box\tRM\t7\t20.00\t15.7143'].join('\n'),
    mapping: null,
    defaultLocation: 'RM'
  }).plan.totals
ok(
  eq(previewTotals().costBefore, stats1.totalCost),
  "the reset preview's promised BEFORE total is the dashboard's total, to the cent",
  `${previewTotals().costBefore} vs ${stats1.totalCost}`
)

assertStockLotsConsistent(db)
ok(layerGaps(db).length === 0, 'no shelf disagrees with its layers', JSON.stringify(layerGaps(db)))

// ---------------------------------------------------------------------------
console.log('\n=== 2. a cost that does not terminate ===')
// ---------------------------------------------------------------------------
// Three boxes out of a $10.00 case: $3.3333… each. There is no way to store that
// exactly, so the test is not "no error" — it is that the error stays below the
// cent it is reported in, instead of being a whole cent per unit the way a
// cent-rounded $3.33 would be ($9.99 for something that cost $10.00).
const THIRD = make({ name: 'VAL Repeating Hobby Box', category: 'Football', cost: 10 / 3, qty: 3 })
const stats2 = inventoryStats()
ok(
  eq(stats2.totalCost - stats1.totalCost, 10),
  'three boxes at $10/3 carry a $10.00 basis',
  String(stats2.totalCost - stats1.totalCost)
)
ok(
  productRow(THIRD).unit_cost === 3.3333,
  'stored per unit as $3.3333, not $3.33',
  String(productRow(THIRD).unit_cost)
)
ok(
  eq(categoryValue('Football'), 10),
  'and the category card reads $10.00 rather than the $9.99 a cent-rounded layer would give',
  String(categoryValue('Football'))
)
ok(eq(onePricing(THIRD).costValue, 10), 'Daily Pricing agrees', String(onePricing(THIRD).costValue))
ok(eq(productMetrics(oneProduct(THIRD)).totalCost, 10), 'so does the product card')

// ---------------------------------------------------------------------------
console.log('\n=== 3. sixty small layers, where the error used to compound ===')
// ---------------------------------------------------------------------------
// One box at a time, at a cent more each time: $0.01 … $0.60. Sixty layers,
// $18.30 of stock, and an average of $0.305 that no cent-rounded figure can
// carry — 60 × $0.31 is $18.60 and 60 × $0.30 is $18.00. The point of many small
// layers is that the per-unit error is multiplied by every one of them.
const MANY = make({ name: 'VAL Many Layers Hobby Box', category: 'Hockey', cost: 0.01, qty: 1 })
for (let i = 2; i <= 60; i++) addStock(MANY, 'RM', 1, i / 100, `layer ${i}`, null)
const MANY_VALUE = 18.3

ok(listLots(MANY).length === 60, 'sixty open layers', String(listLots(MANY).length))
ok(stockQty(MANY, 'RM') === 60, 'sixty boxes on hand', String(stockQty(MANY, 'RM')))
ok(
  eq(categoryValue('Hockey'), MANY_VALUE),
  'the category card reads $18.30, not $18.60 or $18.00',
  String(categoryValue('Hockey'))
)
ok(
  eq(productMetrics(oneProduct(MANY)).totalCost, MANY_VALUE),
  'the product card reads $18.30',
  String(productMetrics(oneProduct(MANY)).totalCost)
)
ok(eq(onePricing(MANY).costValue, MANY_VALUE), 'Daily Pricing reads $18.30')
const stats3 = inventoryStats()
ok(
  eq(stats3.totalCost, 110 + 10 + MANY_VALUE),
  'and the dashboard total carries all three products exactly',
  String(stats3.totalCost)
)
ok(eq(ownerStockValue(), stats3.totalCost), 'the owner board still has no opinion of its own')

// ---------------------------------------------------------------------------
console.log('\n=== 4. one product, two locations, two costs ===')
// ---------------------------------------------------------------------------
// The same $110.00 again, split across shelves. Value BY LOCATION has to stay
// coherent: RM is worth $30.00 and AM $80.00, and neither reads as half of a
// blended average.
const SPLIT = make({ name: 'VAL Split Shelf Hobby Box', category: 'Soccer', cost: 10, qty: 3, location: 'RM' })
addStock(SPLIT, 'AM', 4, 20, 'other shelf', null)

const rmShelf = shelfBasis(db, SPLIT, 'RM')
const amShelf = shelfBasis(db, SPLIT, 'AM')
ok(eq(rmShelf.value, 30), 'the RM shelf is worth $30.00', String(rmShelf.value))
ok(eq(amShelf.value, 80), 'the AM shelf is worth $80.00', String(amShelf.value))
ok(rmShelf.lotBasis === 10 && amShelf.lotBasis === 20, 'each shelf carries its own unit basis')
ok(eq(categoryValue('Soccer'), 110), 'the category card totals the two shelves at $110.00', String(categoryValue('Soccer')))
ok(
  eq(productMetrics(oneProduct(SPLIT)).totalCost, 110),
  'so does the product card, across both locations',
  String(productMetrics(oneProduct(SPLIT)).totalCost)
)

// resetCatalog is what the count-sheet planner decides against, and its
// per-shelf costs have to be the same numbers the dashboard valued with.
const catalogSplit = resetCatalog().find((p: any) => p.id === SPLIT)
ok(
  catalogSplit.costByLocation.RM === 10 && catalogSplit.costByLocation.AM === 20,
  'the reset catalog sees the two shelf costs, not one blend',
  JSON.stringify(catalogSplit.costByLocation)
)

// The write-off panel: what the dashboard loses if these shelves are not counted.
const wipe = previewReset({
  text: ['Product\tLocation\tQty\tMarket\tCost', 'VAL Headline Hobby Box\tRM\t7\t20.00\t15.7143'].join('\n'),
  mapping: null,
  defaultLocation: 'RM'
}).plan
const splitMissing = wipe.missing.filter((m: any) => m.productId === SPLIT)
ok(splitMissing.length === 2, 'both shelves are on the write-off list', String(splitMissing.length))
ok(
  eq(
    splitMissing.reduce((n: number, m: any) => n + m.quantity * m.unitCost, 0),
    110
  ),
  'and the money it says would be written off is the $110.00 the dashboard carries',
  splitMissing.map((m: any) => `${m.location}:${m.quantity}x${m.unitCost}`).join(' ')
)
ok(
  eq(wipe.totals.costBefore, inventoryStats().totalCost),
  "the preview's BEFORE total still equals the dashboard's, with a split shelf in play",
  `${wipe.totals.costBefore} vs ${inventoryStats().totalCost}`
)

// The export is the other half of that round trip.
const exported = buildResetExport().split('\n')
const splitRm = exported.find((l: string) => l.includes('VAL Split Shelf') && l.includes('\tRM\t'))
const splitAm = exported.find((l: string) => l.includes('VAL Split Shelf') && l.includes('\tAM\t'))
ok(!!splitRm && splitRm.endsWith('10.00\t30.00'), 'the export writes RM at $10.00 × 3 = $30.00', splitRm)
ok(!!splitAm && splitAm.endsWith('20.00\t80.00'), 'and AM at $20.00 × 4 = $80.00', splitAm)
const headLine = exported.find((l: string) => l.includes('VAL Headline'))
ok(
  !!headLine && headLine.endsWith('15.7143\t110.00'),
  'a blended shelf exports the precision needed to reproduce its $110.00, not a $15.71 that would lose three cents on the way back in',
  headLine
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. fractional giveaway quantities ===')
// ---------------------------------------------------------------------------
// A giveaway item legitimately sits at part of a box. Five at $12.00 and 4.75 at
// $16.00 is $136.00; the average is $13.9487… and 9.75 of the cent-rounded
// $13.95 is $136.01 — over, this time, which is no better.
const GIVE = make({
  name: 'VAL Giveaway Box',
  category: 'Pokemon',
  cost: 12,
  qty: 5,
  giveaway: true
})
addStock(GIVE, 'RM', 4.75, 16, 'partial box', null)
ok(stockQty(GIVE, 'RM') === 9.75, '9.75 boxes on hand', String(stockQty(GIVE, 'RM')))
ok(eq(categoryValue('Pokemon'), 136), 'the category card reads $136.00', String(categoryValue('Pokemon')))
ok(
  eq(productMetrics(oneProduct(GIVE)).totalCost, 136),
  'the product card reads $136.00, not $136.01',
  String(productMetrics(oneProduct(GIVE)).totalCost)
)
ok(eq(onePricing(GIVE).costValue, 136), 'Daily Pricing reads $136.00')
ok(
  eq(
    listLots(GIVE).reduce((n: number, l: any) => n + l.qtyRemaining * l.unitCost, 0),
    136
  ),
  'and the FIFO case view sums to the same $136.00'
)
assertStockLotsConsistent(db)
ok(true, 'the lot/stock invariant survives a fractional balance')

// ---------------------------------------------------------------------------
console.log('\n=== 6. a legacy shelf: stock, and no cost layers at all ===')
// ---------------------------------------------------------------------------
// Pre-FIFO stock. backfillLots is a one-time migration, not a standing
// guarantee, and revalueShelf still has a live branch for a shelf in this state.
// Valuing it from the layers alone would report real stock as worth $0.00 —
// which is a far worse failure than the three cents this whole change is about.
const LEGACY = make({ name: 'VAL Legacy Hobby Box', category: 'UFC', cost: 25, qty: 4 })
db.prepare('DELETE FROM inventory_lots WHERE product_id = ?').run(LEGACY)

const legacyShelf = shelfBasis(db, LEGACY, 'RM')
ok(legacyShelf.lotQuantity === 0, 'the shelf has no layers', String(legacyShelf.lotQuantity))
ok(legacyShelf.lotBasis === null, 'so there is no layer basis to read')
ok(
  eq(legacyShelf.value, 100) && legacyShelf.value !== 0,
  'and it is valued at 4 × its $25.00 average — NOT at zero',
  String(legacyShelf.value)
)
ok(eq(categoryValue('UFC'), 100), 'the category card carries it at $100.00', String(categoryValue('UFC')))
ok(
  eq(productMetrics(oneProduct(LEGACY)).totalCost, 100),
  'so does the product card',
  String(productMetrics(oneProduct(LEGACY)).totalCost)
)
ok(eq(onePricing(LEGACY).costValue, 100), 'and Daily Pricing')
ok(listLots(LEGACY).length === 0, 'while the FIFO case view honestly shows no layers')
ok(
  inventoryStats().zeroCost.every((z: any) => z.id !== LEGACY),
  'it is not reported as stock carried at nothing, because it is not'
)

// The disagreement is DETECTABLE rather than absorbed.
const gapsLegacy = layerGaps(db).filter((g: any) => g.id === LEGACY)
ok(gapsLegacy.length === 1, 'the shelf is listed as a layer gap', String(gapsLegacy.length))
ok(
  gapsLegacy[0].quantity === 4 && gapsLegacy[0].lotQuantity === 0,
  'saying exactly how far apart the count and the layers are',
  JSON.stringify(gapsLegacy[0])
)
ok(eq(gapsLegacy[0].value, 100), 'and how much money is riding on the fallback basis')
ok(
  inventoryStats().layerGaps.some((g: any) => g.id === LEGACY),
  'and the dashboard carries that list, so it is on a screen rather than in a log'
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. layers with no stock behind them ===')
// ---------------------------------------------------------------------------
// The other direction. An orphan layer on an emptied shelf is a real state —
// zeroShelf in the reset exists to sweep them — and a valuation that read the
// layers directly would report money for stock nobody has.
const ORPHAN = make({ name: 'VAL Orphan Hobby Box', category: 'Entertainment', cost: 40, qty: 2 })
const beforeOrphan = inventoryStats().totalCost
db.prepare('DELETE FROM inventory_stock WHERE product_id = ?').run(ORPHAN)

ok(
  (db.prepare('SELECT COUNT(*) AS c FROM inventory_lots WHERE product_id = ? AND qty_remaining > 0').get(
    ORPHAN
  ) as any).c === 1,
  'the cost layer is still open'
)
ok(
  eq(inventoryStats().totalCost, beforeOrphan - 80),
  'but the dashboard values it at nothing — the valuation follows the count, not the layer',
  String(inventoryStats().totalCost)
)
ok(eq(categoryValue('Entertainment'), 0), 'the category card reads $0.00', String(categoryValue('Entertainment')))
ok(!onePricing(ORPHAN), 'Daily Pricing drops it, since there is nothing on hand')
ok(
  eq(productMetrics(oneProduct(ORPHAN)).totalCost, 0),
  'and the product card carries no money for it',
  String(productMetrics(oneProduct(ORPHAN)).totalCost)
)
const gapsOrphan = layerGaps(db).filter((g: any) => g.id === ORPHAN)
ok(gapsOrphan.length === 1, 'the orphan layer is listed as a gap too', String(gapsOrphan.length))
ok(
  gapsOrphan[0].quantity === 0 && gapsOrphan[0].lotQuantity === 2,
  'in the opposite direction — two units of basis, nothing on the shelf',
  JSON.stringify(gapsOrphan[0])
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. a product with layers and zero stock, the ordinary way ===')
// ---------------------------------------------------------------------------
// Selling out is not a gap. Every layer is spent, the stock row sits at zero,
// and the product keeps its last known average so a later zero-cost restock does
// not reset the basis — but it contributes nothing to any total.
const SOLD = make({ name: 'VAL Sold Out Hobby Box', category: 'Basketball', cost: 55, qty: 2, bid: 70 })
const beforeSold = inventoryStats().totalCost
ok(eq(inventoryStats().totalCost, beforeSold), 'baseline')
recordSale(SOLD, 'RM', 2, 90, 'a buyer', null, null)
ok(stockQty(SOLD, 'RM') === 0, 'nothing left on hand')
ok(
  eq(inventoryStats().totalCost, beforeSold - 110),
  'the two boxes left the cost basis with them',
  String(inventoryStats().totalCost)
)
ok(productRow(SOLD).unit_cost === 55, 'the last known average is retained on the product row')
ok(eq(productMetrics(oneProduct(SOLD)).totalCost, 0), 'but it is worth nothing on hand')
ok(eq(categoryValue('Basketball'), 0), 'and its category reads $0.00')
ok(
  layerGaps(db).every((g: any) => g.id !== SOLD),
  'a sold-out product is not a layer gap — the layers and the count agree at zero'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. COGS still consumes real layers at real prices ===')
// ---------------------------------------------------------------------------
// The FIFO walk was already exact and must not have been disturbed. Selling
// three of the headline product takes the $10.00 layer and nothing else, and the
// $110.00 that is left behind falls to $80.00 — the layers that remain, not the
// old average times the new quantity.
const cogsOf = (productId: string): number =>
  (
    db
      .prepare(
        `SELECT cost_basis AS c FROM inventory_transactions
          WHERE product_id = ? AND type = 'sale' ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(productId) as any
  ).c

recordSale(HEAD, 'RM', 3, 30, 'a buyer', null, null)
ok(eq(cogsOf(HEAD), 30), 'COGS on three boxes is the $10.00 layer, exactly', String(cogsOf(HEAD)))
ok(
  eq(productMetrics(oneProduct(HEAD)).totalCost, 80),
  'and what is left on the shelf is the $20.00 layer: $80.00',
  String(productMetrics(oneProduct(HEAD)).totalCost)
)
ok(productRow(HEAD).unit_cost === 20, 'the average re-synced to the surviving layer')
ok(eq(onePricing(HEAD).costValue, 80), 'Daily Pricing follows')
ok(eq(categoryValue('Baseball'), 80), 'so does the category card')

// A sale that straddles two layers costs both, and the remainder is still exact.
recordSale(HEAD, 'RM', 2, 30, 'a buyer', null, null)
ok(eq(cogsOf(HEAD), 40), 'two more boxes cost $40.00 out of the $20.00 layer', String(cogsOf(HEAD)))
ok(eq(productMetrics(oneProduct(HEAD)).totalCost, 40), 'leaving $40.00 on the shelf')

// ---------------------------------------------------------------------------
console.log('\n=== 10. every surface, against one number, one last time ===')
// ---------------------------------------------------------------------------
// The whole warehouse this suite built, added up by hand and then compared to
// each surface independently. If any one of them re-derives a total from an
// average again, this is where it shows.
adjustStock(HEAD, 'RM', -2, 'clear the headline product', null)
const EXPECTED =
  10 + // VAL Repeating: 3 at $10/3
  18.3 + // VAL Many Layers: $0.01 … $0.60
  110 + // VAL Split Shelf: 3 at $10 + 4 at $20
  136 + // VAL Giveaway: 5 at $12 + 4.75 at $16
  100 // VAL Legacy: 4 at its $25 average, with no layers

const final = inventoryStats()
ok(eq(final.totalCost, EXPECTED), 'the dashboard tile', String(final.totalCost))
ok(
  eq(
    categorySummaries().reduce((n: number, c: any) => n + c.value, 0),
    final.totalValue
  ),
  'the category chart still sums to the headline value tile'
)
ok(
  eq(
    pricingList().reduce((n: number, r: any) => n + r.costValue, 0),
    EXPECTED
  ),
  'Daily Pricing, summed',
  String(pricingList().reduce((n: number, r: any) => n + r.costValue, 0))
)
ok(
  eq(
    listProducts().reduce((n: number, p: any) => n + productMetrics(p).totalCost, 0),
    EXPECTED
  ),
  'every product card, summed'
)
// The FIFO case views list LAYERS, so they can only total the shelves where the
// layers and the count agree. The two deliberately-broken shelves are excluded
// by that same test — which is the point of surfacing them: the one number the
// case list cannot reconcile is the one the app already says it cannot.
const gapIds = new Set(layerGaps(db).map((g: any) => g.id))
ok(
  eq(
    listProducts()
      .filter((p: any) => !gapIds.has(p.id))
      .reduce(
        (n: number, p: any) =>
          n + listLots(p.id).reduce((m: number, l: any) => m + l.qtyRemaining * l.unitCost, 0),
        0
      ),
    EXPECTED - 100 // everything but the legacy shelf, which has no layers to list
  ),
  'and the FIFO case views total every shelf whose layers match its count'
)
ok(eq(ownerStockValue(), EXPECTED), 'the owner board', String(ownerStockValue()))
ok(
  eq(
    previewReset({
      text: ['Product\tLocation\tQty\tMarket\tCost', 'VAL Legacy Hobby Box\tRM\t4\t30.00\t25.00'].join('\n'),
      mapping: null,
      defaultLocation: 'RM'
    }).plan.totals.costBefore,
    EXPECTED
  ),
  "the reset preview's promised total"
)

// The invariant, on everything except the two shelves this suite broke on
// purpose. Asserted by exclusion rather than skipped: assertStockLotsConsistent
// throws on the first mismatch, so it can only speak for a healthy warehouse —
// and `layerGaps` has to name EXACTLY the two shelves that are not one.
ok(
  gapIds.size === 2 && gapIds.has(LEGACY) && gapIds.has(ORPHAN),
  'the only two shelves out of step are the two that were broken deliberately',
  [...gapIds].join(',')
)
db.prepare('DELETE FROM inventory_stock WHERE product_id = ?').run(LEGACY)
db.prepare('UPDATE inventory_lots SET qty_remaining = 0 WHERE product_id = ?').run(ORPHAN)
assertStockLotsConsistent(db)
ok(
  layerGaps(db).length === 0,
  'and with those two put right, Σ lot.qty_remaining equals stock on every shelf'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
