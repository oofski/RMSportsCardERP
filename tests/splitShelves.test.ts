/**
 * ONE LINE, SEVERAL SHELVES — allocated while the order is being written.
 *
 * The owner, looking at the picker with three shelves each holding one and a
 * line for three: "I want to be able to add each of these here to sum to 3."
 *
 * ## What was actually missing, which is narrower than it looks
 *
 * Splitting a sales-order line across shelves was ALREADY possible. The table
 * has the column, `effectiveSlices` has always resolved the rows, and the cost
 * consumption reads `slice.sourcePoId` and `slice.destination` per slice rather
 * than off the line. What could not be done was doing it AT CREATION: the
 * picker offered a single shelf, `NewInvoiceLine` had nowhere to put a split,
 * and `saveInvoice` wrote no allocation rows. The only route was create the
 * order, then open a second screen and route it.
 *
 * So section 3 is the point of this file: an order created in ONE call, split
 * across three shelves, drawing all three down. Everything else guards the
 * edges of that.
 *
 * ## The two invariants that must not move
 *
 * ONE SHELF IS NOT A SPLIT. `allocationProblem` refuses a single stored row —
 * two ways to say the same thing can disagree — so both `toLineChoice` and
 * `buildLineAllocations` collapse it to the line's own destination. Section 2
 * and section 4 pin both ends of that.
 *
 * AN ORDINARY ADD IS BYTE FOR BYTE WHAT IT WAS. No rows written, the same shelf
 * drawn, the same inheritance stored. That is the whole back-compat mechanism
 * and section 4 asserts it directly rather than trusting it.
 *
 * Every name and figure here is invented.
 *
 * Run: npm run test:split-shelves
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/split-shelves-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const repo = require('../src/main/db/invoices')
const inv = require('../src/main/db/inventory')
const {
  allocationTotal,
  defaultAllocation,
  fillFromShelf,
  quantityAt,
  setShelfQuantity,
  shelfShortfalls,
  shelfSumProblem,
  toLineChoice
} = require('../src/shared/pickSource')

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

let seq = 0
const makeProduct = (name: string): any =>
  inv.createProduct(
    {
      sku: `SPLIT-${++seq}`,
      upc: null,
      name,
      category: 'Baseball',
      brand: 'Invented',
      setName: '',
      year: '2026',
      unitType: 'case',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 0,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null
    },
    null
  )

/** What is on one shelf right now. */
const onHand = (productId: string, location: string): number => {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_remaining), 0) AS n FROM inventory_lots
        WHERE product_id = ? AND location = ? AND qty_remaining > 0`
    )
    .get(productId, location) as { n: number }
  return Number(row?.n) || 0
}

const allocationRows = (invoiceId: string): any[] =>
  db
    .prepare(
      `SELECT quantity, destination, supplier FROM invoice_line_allocations
        WHERE invoice_id = ? ORDER BY position ASC`
    )
    .all(invoiceId) as any[]

// ---------------------------------------------------------------------------
console.log('=== 1. the rules the picker runs on ===')
// ---------------------------------------------------------------------------
{
  const d = defaultAllocation(3, 'RM')
  ok(d.length === 1 && d[0].location === 'RM' && d[0].quantity === 3, 'it opens with everything at the order’s shelf', JSON.stringify(d))
  ok(shelfSumProblem(d, 3) === null, 'and that adds up')

  ok(shelfSumProblem([{ location: 'RM', quantity: 1 }], 3) !== null, 'one of three does not')
  ok(
    (shelfSumProblem([{ location: 'RM', quantity: 1 }], 3) ?? '').includes('2 of the 3'),
    'and it says how many are unplaced rather than merely that something is wrong',
    String(shelfSumProblem([{ location: 'RM', quantity: 1 }], 3))
  )
  ok(
    (shelfSumProblem([{ location: 'RM', quantity: 5 }], 3) ?? '').includes('2 more'),
    'and the other way round too',
    String(shelfSumProblem([{ location: 'RM', quantity: 5 }], 3))
  )

  // The owner's exact case: three shelves, one each, filled by pressing.
  let slices: any[] = []
  for (const shelf of ['RM', 'California Roadshow', 'Texas Roadshow']) {
    slices = fillFromShelf(slices, { location: shelf, onHand: 1 }, 3)
  }
  ok(allocationTotal(slices) === 3, 'THREE PRESSES MAKE 1 + 1 + 1', JSON.stringify(slices))
  ok(shelfSumProblem(slices, 3) === null, 'and the line is complete')

  // Capped at what a shelf holds: a convenience must not invent stock.
  const capped = fillFromShelf([], { location: 'RM', onHand: 1 }, 5)
  ok(
    capped.length === 1 && capped[0].quantity === 1,
    'PRESSING A SHELF TAKES WHAT IT HAS, not what is still needed — filling past a ' +
      'shelf is possible by typing and should never be what a convenience does',
    JSON.stringify(capped)
  )

  ok(quantityAt(slices, 'Texas Roadshow') === 1, 'a shelf reports its own share')
  ok(quantityAt(slices, 'Nowhere') === 0, 'and a shelf nobody used reports none')
  ok(
    setShelfQuantity(slices, 'Texas Roadshow', 0).length === 2,
    'clearing a shelf removes its row rather than storing a zero'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. what the picker hands back ===')
// ---------------------------------------------------------------------------
{
  const all3 = toLineChoice([{ location: 'RM', quantity: 3 }], 3, 'RM')
  ok(
    all3.location === '' && all3.allocations.length === 0,
    'EVERYTHING AT THE ORDER’S OWN SHELF IS NOT A SPLIT — blank location, no rows, ' +
      'which is exactly what an add wrote before any of this existed',
    JSON.stringify(all3)
  )

  const elsewhere = toLineChoice([{ location: 'Texas Roadshow', quantity: 3 }], 3, 'RM')
  ok(
    elsewhere.location === 'Texas Roadshow' && elsewhere.allocations.length === 0,
    'one shelf that is not the order’s is still not a split — it is the line’s destination',
    JSON.stringify(elsewhere)
  )

  const split = toLineChoice(
    [
      { location: 'RM', quantity: 1 },
      { location: 'California Roadshow', quantity: 1 },
      { location: 'Texas Roadshow', quantity: 1 }
    ],
    3,
    'RM'
  )
  ok(split.allocations.length === 3, 'three shelves IS a split', JSON.stringify(split.allocations))
  ok(allocationTotal(split.allocations) === 3, 'and its rows still add to the quantity')

  const zeroed = toLineChoice(
    [
      { location: 'RM', quantity: 2 },
      { location: 'Texas Roadshow', quantity: 0 }
    ],
    2,
    'RM'
  )
  ok(
    zeroed.allocations.length === 0 && zeroed.location === '',
    'A SHELF CLEARED WHILE DECIDING IS NOT STORED — it would read on every later ' +
      'screen as a real choice that draws nothing',
    JSON.stringify(zeroed)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. THE OWNER’S CASE, created in one call ===')
// ---------------------------------------------------------------------------
{
  const p = makeProduct('2026 Topps Marvel Mint 10-Box Case')
  inv.addStock(p.id, 'RM', 1, 400, 'the home one', null, null)
  inv.addStock(p.id, 'California Roadshow', 1, 380, 'california', null, null)
  inv.addStock(p.id, 'Texas Roadshow', 1, 420, 'texas', null, null)
  ok(
    onHand(p.id, 'RM') === 1 && onHand(p.id, 'California Roadshow') === 1 && onHand(p.id, 'Texas Roadshow') === 1,
    'five of a product across three places — one here, one at each roadshow'
  )

  const saved = repo.saveInvoice(
    {
      invoiceNumber: 'SPLIT-1',
      customerName: 'Dana Whitlock',
      invoiceDate: '2026-08-31',
      location: 'RM',
      lines: [
        {
          item: p.name,
          productId: p.id,
          quantity: 3,
          rate: 900,
          allocations: [
            { location: 'RM', quantity: 1 },
            { location: 'California Roadshow', quantity: 1 },
            { location: 'Texas Roadshow', quantity: 1 }
          ]
        }
      ]
    },
    null
  )
  ok(!!saved?.id, 'the order saves in one call, with the split already on it')

  /**
   * THE ASSERTION THE WHOLE FEATURE IS FOR. Before this, a line of three could
   * name one shelf: RM would have gone to zero, the order would have been two
   * short, and the two cases sitting at the roadshows would have been untouched.
   */
  ok(
    onHand(p.id, 'RM') === 0,
    'RM is drawn down',
    String(onHand(p.id, 'RM'))
  )
  ok(
    onHand(p.id, 'California Roadshow') === 0 && onHand(p.id, 'Texas Roadshow') === 0,
    'AND SO ARE BOTH ROADSHOWS — all three shelves gave up their one, from a single line',
    `CA ${onHand(p.id, 'California Roadshow')}, TX ${onHand(p.id, 'Texas Roadshow')}`
  )

  const rows = allocationRows(saved.id)
  ok(rows.length === 3, 'three allocation rows are stored', String(rows.length))
  ok(
    rows.reduce((t: number, r: any) => t + r.quantity, 0) === 3,
    'and they add up to the line',
    JSON.stringify(rows.map((r: any) => r.quantity))
  )
  ok(
    rows.every((r: any) => r.supplier === null),
    'NONE OF THEM NAMES A SUPPLIER — every shelf here is our own stock, and a ' +
      'supplier on those would offer to buy what we already hold',
    JSON.stringify(rows.map((r: any) => r.supplier))
  )

  const reread = repo.getInvoice(saved.id)
  ok(
    (reread?.lines?.[0]?.allocations?.length ?? 0) === 3,
    'and the split reads back on the line',
    String(reread?.lines?.[0]?.allocations?.length)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. the edges: refusals, and the ordinary line unchanged ===')
// ---------------------------------------------------------------------------
{
  const p = makeProduct('2026 Bowman Sterling Case')
  inv.addStock(p.id, 'RM', 5, 300, 'the pallet', null, null)

  let threw = ''
  try {
    repo.saveInvoice(
      {
        invoiceNumber: 'SPLIT-BAD',
        customerName: 'Dana Whitlock',
        invoiceDate: '2026-08-31',
        location: 'RM',
        lines: [
          {
            item: p.name,
            productId: p.id,
            quantity: 3,
            rate: 900,
            // Two of three. The unit that is not here would be sold from nowhere.
            allocations: [
              { location: 'RM', quantity: 1 },
              { location: 'Texas Roadshow', quantity: 1 }
            ]
          }
        ]
      },
      null
    )
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err)
  }
  ok(
    threw !== '',
    'ROWS THAT DO NOT ADD UP ARE REFUSED IN MAIN — the form checks too, but a ' +
      'renderer is a convenience and these decide which shelves get drawn'
  )
  ok(
    threw.includes('not accounted for'),
    'and the refusal says what is missing',
    threw
  )
  ok(onHand(p.id, 'RM') === 5, 'AND NOTHING MOVED — a refused save draws no shelf', String(onHand(p.id, 'RM')))

  // The ordinary add, unchanged.
  const plain = repo.saveInvoice(
    {
      invoiceNumber: 'SPLIT-PLAIN',
      customerName: 'Dana Whitlock',
      invoiceDate: '2026-08-31',
      location: 'RM',
      lines: [{ item: p.name, productId: p.id, quantity: 2, rate: 900 }]
    },
    null
  )
  ok(allocationRows(plain.id).length === 0, 'a line with no split writes no rows at all')
  ok(onHand(p.id, 'RM') === 3, 'and draws its own shelf exactly as it always did', String(onHand(p.id, 'RM')))

  // One row is not a split — it collapses rather than being stored.
  const single = repo.saveInvoice(
    {
      invoiceNumber: 'SPLIT-ONE',
      customerName: 'Dana Whitlock',
      invoiceDate: '2026-08-31',
      location: 'RM',
      lines: [
        { item: p.name, productId: p.id, quantity: 1, rate: 900, allocations: [{ location: 'RM', quantity: 1 }] }
      ]
    },
    null
  )
  ok(
    allocationRows(single.id).length === 0,
    'ONE SHELF IS NOT A SPLIT — stored as the line’s own destination, because two ' +
      'ways to say the same thing can disagree',
    String(allocationRows(single.id).length)
  )
  ok(onHand(p.id, 'RM') === 2, 'and it still drew the shelf', String(onHand(p.id, 'RM')))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
