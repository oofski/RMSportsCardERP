/**
 * Stock can sit somewhere other than RM and AM.
 *
 * The owner's words: "ability to add ANY vendor/location to inventory, not just
 * AM/RM ... and have Roadshow shops pinned for easy access here".
 *
 * The app was built around two shelves, and everywhere else was a DROPSHIP by
 * definition — units this business never held. That is wrong about a Roadshow
 * shop, which keeps product between events: those boxes are ours, they are just
 * not here. Under the old model selling one drew stock from nowhere.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. A NEW PLACE IS A SHELF. `destinationHoldsStock` is the ONE question every
 *      receiving and selling path asks, and it must answer yes for a place the
 *      operator added — otherwise the feature does nothing at all and does it
 *      silently, by classifying real inventory as a dropship.
 *
 *   2. RM AND AM CANNOT BE REMOVED. A blank destination has resolved to RM since
 *      v1, in migrations and defaults alike. A registry that can lose it is one
 *      where every default is wrong.
 *
 *   3. RETIRED STILL HOLDS. Every sales order ever fulfilled from a place was
 *      costed on the understanding that its units came off a shelf. Dropping a
 *      retired place from the set reclassifies all of them as dropships and
 *      changes the stock math of closed months.
 *
 *   4. A RENAME MOVES THE STOCK. The name IS the key on every stock row, layer
 *      and transaction, so a rename that did not carry them would empty the
 *      shelf.
 *
 * Every name here is invented.
 *
 * Run: npm run test:stock-locations
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/stock-locations-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const places = require('../src/main/db/stockLocations')
const inv = require('../src/main/db/inventory')
const invoices = require('../src/main/db/invoices')
const {
  BUILTIN_LOCATION_IDS,
  activeLocations,
  allLocations,
  isLocation,
  locationIds,
  setKnownLocations
} = require('../src/shared/inventory')
const { destinationHoldsStock } = require('../src/shared/purchaseOrders')

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

const ACTOR = 'emp_owner'
db.prepare(
  `INSERT INTO inventory_products (id, sku, name, category, unit_cost, created_at, updated_at)
   VALUES ('p_loc', 'SKU-LOC', 'Roadshow Case', 'Baseball', 60,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
).run()

// ---------------------------------------------------------------------------
console.log('\n=== 1. the two originals are the floor ===')
// ---------------------------------------------------------------------------

ok(BUILTIN_LOCATION_IDS.includes('RM'), 'RM is built in')
ok(BUILTIN_LOCATION_IDS.includes('AM'), 'and so is AM')
ok(isLocation('RM') && isLocation('AM'), 'both hold stock out of the box')
ok(destinationHoldsStock('RM'), 'and the shelf test agrees')
ok(!isLocation('Fenwick Cards'), 'somewhere nobody added is not a shelf')
ok(!destinationHoldsStock('Fenwick Cards'), 'so it is still a dropship')

// EVEN AN EMPTY READ KEEPS THEM. A database mid-migration, or one whose table
// could not be read, must behave the way this app always has.
setKnownLocations([])
ok(isLocation('RM'), 'an EMPTY registry still holds RM')
ok(isLocation('AM'), 'and AM')
places.hydrateLocations(db)

// ---------------------------------------------------------------------------
console.log('\n=== 2. adding a place makes it a real shelf ===')
// ---------------------------------------------------------------------------

const added = places.saveStockLocation({ label: 'Roadshow Dallas', pinned: true }, ACTOR)
ok(added.ok === true, 'a Roadshow shop can be added', added.error ?? '')
ok(isLocation('Roadshow Dallas'), 'IT IS NOW A SHELF')
ok(destinationHoldsStock('Roadshow Dallas'), 'AND THE SHELF TEST SAYS SO — this is the whole feature')
ok(isLocation('roadshow dallas'), 'matched case-insensitively')
ok(locationIds().includes('Roadshow Dallas'), 'and it is offered in pickers')

// Pinned places come first, so a Roadshow shop is one press away.
ok(activeLocations()[0].id === 'Roadshow Dallas', 'a pinned place leads the list', activeLocations()[0].id)
ok(activeLocations()[0].pinned === true, 'because it is pinned')

// The same name twice is one shelf, not two holding half the stock each.
const dupe = places.saveStockLocation({ label: 'roadshow dallas' }, ACTOR)
ok(dupe.ok === false, 'the same name again is refused')
ok(/already a place/i.test(dupe.error ?? ''), 'and says why', dupe.error ?? '')

// ---------------------------------------------------------------------------
console.log('\n=== 3. stock really lands there, and really sells from there ===')
// ---------------------------------------------------------------------------

inv.addStock('p_loc', 'Roadshow Dallas', 10, 60, ACTOR, null)
const at = (loc: string): number => inv.stockQty('p_loc', loc)
ok(at('Roadshow Dallas') === 10, 'ten units land on the new shelf', String(at('Roadshow Dallas')))

// A sales order fulfilled FROM there draws it down. Before v79 this line would
// have read as a dropship and drawn nothing at all.
const sale = invoices.saveInvoice(
  {
    customerName: 'Invented Buyer',
    invoiceDate: '2026-08-20',
    location: 'Roadshow Dallas',
    lines: [{ item: 'Roadshow Case', productId: 'p_loc', quantity: 4, rate: 200 }]
  },
  ACTOR
)
ok(!!sale.id, 'a sale is raised against it')
ok(
  at('Roadshow Dallas') === 6,
  'AND IT DRAWS THE SHELF DOWN — four gone, six left',
  String(at('Roadshow Dallas'))
)
ok(
  invoices.getInvoice(sale.id).lines[0].dropship === false,
  'the line is NOT a dropship — the goods were ours'
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. retired still holds, and cannot strand stock ===')
// ---------------------------------------------------------------------------

const stillHeld = places.setStockLocationRetired('Roadshow Dallas', true)
ok(stillHeld.ok === false, 'a place holding stock cannot be retired')
ok(/still holds 6/i.test(stillHeld.error ?? ''), 'and says how much', stillHeld.error ?? '')

const empty = places.saveStockLocation({ label: 'Roadshow Austin' }, ACTOR)
ok(empty.ok === true, 'a second shop is added', empty.error ?? '')
const retired = places.setStockLocationRetired('Roadshow Austin', true)
ok(retired.ok === true, 'an empty one retires', retired.error ?? '')
ok(!locationIds().includes('Roadshow Austin'), 'and stops being offered')
ok(
  isLocation('Roadshow Austin'),
  'BUT IT STILL HOLDS STOCK — every order ever costed from it must stay costed that way'
)
ok(destinationHoldsStock('Roadshow Austin'), 'so the shelf test still says yes')
ok(allLocations().some((l: any) => l.id === 'Roadshow Austin'), 'and it is still in the world')

// Neither original can be retired.
for (const id of ['RM', 'AM']) {
  const res = places.setStockLocationRetired(id, true)
  ok(res.ok === false, `${id} cannot be retired`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. a rename carries the stock with it ===')
// ---------------------------------------------------------------------------
// The name IS the key on every stock row, layer and transaction. A rename that
// left them behind would empty the shelf and orphan its cost layers.

const renamed = places.saveStockLocation(
  { id: 'Roadshow Dallas', label: 'Roadshow Fort Worth', pinned: true },
  ACTOR
)
ok(renamed.ok === true, 'a place can be renamed', renamed.error ?? '')
ok(at('Roadshow Fort Worth') === 6, 'AND ITS STOCK CAME WITH IT', String(at('Roadshow Fort Worth')))
ok(at('Roadshow Dallas') === 0, 'nothing is left under the old name', String(at('Roadshow Dallas')))
ok(isLocation('Roadshow Fort Worth'), 'the new name is a shelf')
const layers = db
  .prepare(`SELECT COUNT(*) AS n FROM inventory_lots WHERE location = ?`)
  .get('Roadshow Fort Worth') as { n: number }
ok(layers.n > 0, 'and its cost layers moved too', String(layers.n))

// ---------------------------------------------------------------------------
console.log('\n=== 6. pinning, which is the other half of the ask ===')
// ---------------------------------------------------------------------------

places.setStockLocationPinned('Roadshow Fort Worth', false)
ok(
  activeLocations().find((l: any) => l.id === 'Roadshow Fort Worth').pinned === false,
  'a place can be unpinned'
)
places.setStockLocationPinned('Roadshow Fort Worth', true)
const active = activeLocations()
ok(active[0].id === 'Roadshow Fort Worth', 'and pinned again it leads the list', active[0].id)
ok(
  active.filter((l: any) => l.pinned).length === 1,
  'with only the pinned one up there',
  String(active.filter((l: any) => l.pinned).length)
)
ok(
  active.some((l: any) => l.id === 'RM') && active.some((l: any) => l.id === 'AM'),
  'and the two originals still on the list underneath'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
