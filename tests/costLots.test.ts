/**
 * The cost-lot picker: which layer a consumption actually comes out of.
 *
 * ## The defect
 *
 * We hold three cases of a product at $1,400, five at $1,550 and two at $1,600.
 * Every consumption took the OLDEST layer and said nothing about it. Rip the
 * $1,600 case, book $1,400, and that break's margin is wrong by two hundred
 * dollars — as is the per-break P&L that sums exactly what each line recorded.
 * The number that is wrong is one nobody was ever shown.
 *
 * ## What this suite is actually defending
 *
 * Not the dialog — a test cannot press a button. Three things underneath it,
 * each of which fails silently if it is wrong:
 *
 *   1. WHEN TO ASK. A dialog that appears with one possible answer is dismissed
 *      unread within a week, and is then useless on the day it matters. So the
 *      question is only put when two layers with stock left carry genuinely
 *      different unit costs — and "genuinely" excludes a fiftieth of a cent
 *      between a real price and a blended backfill.
 *
 *   2. THAT THE CHOICE IS WHAT GETS BOOKED. A picker that changes what is
 *      displayed but not what is booked is worse than none. So every assertion
 *      about a chosen allocation also names what FIFO WOULD have booked, and
 *      asserts the two are different — a test that only checked "the cost is
 *      $3,200" would still pass if the allocation were being dropped and the
 *      layers happened to agree.
 *
 *   3. THAT IT REFUSES RATHER THAN FALLS BACK. A stale or impossible allocation
 *      must roll the whole consumption back. Quietly walking FIFO instead books
 *      a cost the operator did not choose at the exact moment they believe they
 *      chose one.
 *
 * The engine invariant — Σ lot.qty_remaining == inventory_stock.quantity per
 * (product, location) — is re-asserted after every section that moves stock,
 * because the failure mode of a hand-picked consumption is a layer decremented
 * without the shelf, or the reverse.
 *
 * Run: npm run test:cost-lots
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/cost-lots-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const {
  addStock,
  adjustStock,
  createProduct,
  getProduct,
  lotOptions,
  recordSale,
  stockQty
} = require('../src/main/db/inventory')
const { assertStockLotsConsistent, listOpenLots } = require('../src/main/db/lots')
const { addItem, createSession, getSessionDetail, removeItem } = require('../src/main/db/streaming')
const {
  allocationIsComplete,
  blendedUnitCost,
  fifoPicks,
  lotLabel,
  minusStep,
  needsLotChoice,
  openLots,
  outstandingQty,
  pickedCost,
  pickedQty,
  plusStep,
  tidyPicks,
  validatePicks,
  withPick
} = require('../src/shared/costLots')

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
const cents = (n: number): number => Math.round(n * 100) / 100
const eq = (a: number, b: number): boolean => cents(a) === cents(b)

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
// The migrations seed a real catalog and an on-hand snapshot. Stock and open
// layers are cleared so every figure below is ABSOLUTE — "$3,200" is a much
// stronger claim than "$3,200 more than before", and a delta would hide a
// double count or a sign error in the baseline.
db.exec('DELETE FROM inventory_stock')
db.exec('UPDATE inventory_lots SET qty_remaining = 0')

interface Seed {
  name: string
  unitType?: string
  boxesPerCase?: number | null
  packsPerBox?: number | null
  giveaway?: boolean
  cost: number
  open?: number
}

const make = (s: Seed): string =>
  createProduct(
    {
      sku: `CL-${s.name.replace(/\W+/g, '').slice(0, 14)}`,
      upc: null,
      name: s.name,
      category: 'Baseball',
      brand: '',
      setName: '',
      year: '',
      unitType: s.unitType ?? 'case',
      boxesPerCase: s.boxesPerCase ?? null,
      packsPerBox: s.packsPerBox ?? null,
      giveawayItem: !!s.giveaway,
      unitCost: s.cost,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null,
      openingQuantity: s.open ?? 0,
      openingLocation: 'RM'
    },
    null
  ).id

/** A synthetic layer list, for the pure sections. No database involved. */
const lot = (
  id: string,
  unitCost: number,
  qtyRemaining: number,
  receivedAt = '2026-01-01T12:00:00.000Z',
  extra: Partial<{ vendor: string | null; source: string; note: string | null }> = {}
): Record<string, unknown> => ({
  lotId: id,
  vendor: extra.vendor ?? null,
  unitCost,
  qtyRemaining,
  receivedAt,
  source: extra.source ?? 'restock',
  note: extra.note ?? null
})

/** Every open layer of a product at a location, as [unitCost, qtyRemaining]. */
const layers = (productId: string, location = 'RM'): Array<[number, number]> =>
  (listOpenLots(db, productId, location) as Array<{ unitCost: number; qtyRemaining: number }>).map(
    (l) => [l.unitCost, l.qtyRemaining] as [number, number]
  )

/**
 * Run a write that is expected to be refused, and return why.
 *
 * recordSale and adjustStock RETURN their validation errors but let the cost
 * engine THROW — the throw is what rolls the transaction back, and the IPC
 * handler above them turns it into a Result. This mirrors that boundary so a
 * refusal can be asserted on either shape without the suite caring which one a
 * given guard used.
 */
const refusal = (run: () => { error?: string }): string | null => {
  try {
    return run().error ?? null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const lastTxn = (productId: string): Record<string, unknown> =>
  db
    .prepare(
      'SELECT id, type, quantity_change, cost_basis FROM inventory_transactions WHERE product_id = ? ORDER BY rowid DESC LIMIT 1'
    )
    .get(productId) as Record<string, unknown>

const txnLots = (txnId: string): Array<{ lot_id: string; quantity: number; unit_cost: number; picked: number }> =>
  db
    .prepare('SELECT lot_id, quantity, unit_cost, picked FROM inventory_txn_lots WHERE txn_id = ? ORDER BY rowid')
    .all(txnId) as Array<{ lot_id: string; quantity: number; unit_cost: number; picked: number }>

// ===========================================================================
console.log('=== 1. when the operator is asked, and when they are left alone ===')
// ===========================================================================
// Over-prompting is not a smaller version of under-prompting. Under-prompting
// loses one break's margin; over-prompting trains people to dismiss the dialog
// and loses the whole mechanism.

ok(!needsLotChoice([]), 'no layers at all is not a question')
ok(!needsLotChoice([lot('a', 1400, 3)]), 'one layer is not a choice')
ok(
  !needsLotChoice([lot('a', 1400, 3), lot('b', 1400, 5), lot('c', 1400, 2)]),
  'three layers all bought at $1,400 is not a choice either — the answer cannot differ'
)
ok(
  needsLotChoice([lot('a', 1400, 3), lot('b', 1550, 5), lot('c', 1600, 2)]),
  'three prices IS a choice — this is the owner’s case'
)
ok(
  needsLotChoice([lot('a', 1400, 3), lot('b', 1400, 5), lot('c', 1600, 2)]),
  'and so is two the same and one different — the odd one out is the decision'
)
// A backfilled layer opened at a blended average lands fractions of a cent away
// from a real purchase price. Prompting over that is exactly the noise that
// gets the dialog dismissed unread.
ok(
  !needsLotChoice([lot('a', 1400, 3), lot('b', 1400.0002, 5)]),
  'a fiftieth of a cent apart is not two prices — no prompt'
)
ok(
  needsLotChoice([lot('a', 1400, 3), lot('b', 1400.01, 5)]),
  'a whole cent apart is, because a cent a unit is real money over a case'
)
// An emptied layer is not an alternative. It is still a row in the table until
// something prunes it, and counting it would prompt on a shelf that has exactly
// one thing left to take.
ok(
  !needsLotChoice([lot('a', 1400, 0), lot('b', 1600, 2)]),
  'a spent layer is not an alternative, however different its price was'
)
ok(openLots([lot('a', 1400, 0), lot('b', 1600, 2)]).length === 1, 'and it is not listed')

// Oldest first, so the top row of the dialog IS what the app would have taken.
const ordered = openLots([
  lot('new', 1600, 2, '2026-06-01T12:00:00.000Z'),
  lot('old', 1400, 3, '2026-01-01T12:00:00.000Z'),
  lot('mid', 1550, 5, '2026-03-01T12:00:00.000Z')
]) as Array<{ lotId: string }>
ok(
  ordered.map((l) => l.lotId).join(',') === 'old,mid,new',
  'layers are listed oldest first, matching the FIFO order the picker replaces',
  ordered.map((l) => l.lotId).join(',')
)

// ===========================================================================
console.log('\n=== 2. an allocation is only valid if it adds up exactly ===')
// ===========================================================================
const THREE = [lot('a', 1400, 3), lot('b', 1550, 5), lot('c', 1600, 2)]

ok(
  validatePicks(THREE, [{ lotId: 'a', qty: 2 }, { lotId: 'c', qty: 1 }], 3).ok,
  'two from the $1,400 lot and one from the $1,600 covers three'
)
const short = validatePicks(THREE, [{ lotId: 'a', qty: 2 }], 3)
ok(!short.ok, 'two of three is refused')
ok(
  !short.ok && short.error.includes('1'),
  'and the refusal says how much is still to place',
  !short.ok ? short.error : ''
)
const over = validatePicks(THREE, [{ lotId: 'a', qty: 3 }, { lotId: 'b', qty: 2 }], 3)
ok(!over.ok, 'five allocated against a three-unit consumption is refused')
ok(
  !validatePicks(THREE, [{ lotId: 'zz', qty: 3 }], 3).ok,
  'a layer that is not on the shelf is refused rather than ignored'
)
// Two rows can each look legal while their sum walks past what the layer holds.
ok(
  !validatePicks(THREE, [{ lotId: 'a', qty: 2 }, { lotId: 'a', qty: 1 }], 3).ok,
  'one layer listed twice is refused — each row is legal, the sum is not'
)
ok(
  !validatePicks(THREE, [{ lotId: 'a', qty: 4 }], 4).ok,
  'taking four from a layer holding three is refused'
)
ok(
  !validatePicks(THREE, [{ lotId: 'a', qty: -1 }, { lotId: 'b', qty: 4 }], 3).ok,
  'a negative quantity is refused, even when the total comes out right'
)
ok(!validatePicks(THREE, [], 0).ok, 'there is nothing to allocate against a zero consumption')
ok(
  !validatePicks(THREE, [{ lotId: 'a', qty: Number.NaN }], 3).ok,
  'and a quantity that is not a number is refused rather than stored'
)

// The fractional case the whole quantization-slack machinery exists for: a
// stored balance is re-rounded to four places, so the last piece of a
// six-piece unit legitimately lands a few ten-thousandths under a
// full-precision ask. Demanding exact equality would leave Confirm permanently
// dead on that piece.
const SIXTH = 1 / 6
ok(
  allocationIsComplete([{ lotId: 'a', qty: 0.1667 }], SIXTH),
  'a stored 0.1667 completes a full-precision one-sixth ask'
)
ok(
  !allocationIsComplete([{ lotId: 'a', qty: 0.1 }], SIXTH),
  'but a genuinely short allocation is still short'
)
ok(!allocationIsComplete([], 3), 'nothing allocated never completes')

// ===========================================================================
console.log('\n=== 3. the stepper cannot produce an invalid allocation ===')
// ===========================================================================
// Over-allocation is designed out rather than validated against: + is clamped
// to what is left to place and to what the layer holds, so the running total
// can only ever be short.
const A = THREE[0] as never
ok(plusStep(A, 0, [], 3) === 1, 'the first press of + takes one unit')
ok(
  plusStep(A, 0, [{ lotId: 'b', qty: 3 }], 3) === 0,
  '+ is dead once the whole quantity is placed — over-allocating is not a state'
)
ok(
  plusStep(A, 3, [{ lotId: 'a', qty: 3 }], 5) === 0,
  '+ is dead on a layer that has nothing left, whatever is still to place'
)
// A giveaway of three packs out of a twelve-pack box is a quarter of a box.
// A stepper that only moved in whole units would leave Confirm unreachable.
ok(
  plusStep(A, 0, [], 0.25) === 0.25,
  'a fractional consumption is placed in one press — the step clamps to the ask'
)
ok(minusStep(2.25) === 1, '− comes down a whole unit from 2.25')
ok(minusStep(0.25) === 0.25, 'and takes the remainder when that is all there is')
ok(minusStep(0) === 0, 'and does nothing at zero')

let picks = withPick([], 'a', 2)
picks = withPick(picks, 'c', 1)
ok(pickedQty(picks) === 3, 'two plus one is three')
ok(outstandingQty(picks, 3) === 0, 'and nothing is left to place')
ok(outstandingQty(picks, 5) === 2, 'against a five-unit ask, two are still to place')
ok(withPick(picks, 'a', 0).length === 1, 'setting a layer back to zero drops its row entirely')
ok(
  tidyPicks([{ lotId: 'a', qty: 2 }, { lotId: 'b', qty: 0 }]).length === 1,
  'and tidying drops the zero rows the dialog holds for every layer on screen'
)

// ===========================================================================
console.log('\n=== 4. what the allocation costs ===')
// ===========================================================================
ok(eq(pickedCost(THREE, picks), 4400), '2 × $1,400 + 1 × $1,600 = $4,400', String(pickedCost(THREE, picks)))
ok(
  eq(blendedUnitCost(THREE, picks), 1466.67),
  'which blends to $1,466.67 a unit',
  String(blendedUnitCost(THREE, picks))
)
ok(blendedUnitCost(THREE, []) === 0, 'and nothing allocated blends to nothing, not to NaN')
// What the old behaviour would have booked, kept as an explicit contrast.
ok(
  eq(pickedCost(THREE, fifoPicks(THREE, 3)), 4200),
  'FIFO on the same three units would have booked $4,200 — $200 less',
  String(pickedCost(THREE, fifoPicks(THREE, 3)))
)

console.log('\n--- the vendor column, and what a layer without one says ---')
ok(lotLabel(lot('a', 1400, 3, undefined, { vendor: 'Vendor One' })) === 'Vendor One', 'a vendor prints')
ok(
  lotLabel(lot('a', 1400, 3, undefined, { vendor: null, source: 'backfill' })) === 'Opening balance',
  'a backfilled layer says where it came from rather than showing a blank row'
)
ok(
  lotLabel(lot('a', 1400, 3, undefined, { vendor: null, source: 'opening' })) === 'Opening stock',
  'and so does an opening balance'
)
ok(
  lotLabel(lot('a', 1400, 3, undefined, { vendor: '   ', note: 'Scanned in PO-1042' })) ===
    'Scanned in PO-1042',
  'a blank vendor falls through to the note rather than printing whitespace'
)
ok(
  lotLabel(lot('a', 1400, 3, undefined, { vendor: null, source: 'restock' })) === 'No vendor recorded',
  'and a layer that knows nothing says so — it never invents a supplier'
)

// ===========================================================================
console.log('\n=== 5. a sale books the layers that were chosen, not the oldest ===')
// ===========================================================================
// The owner's exact holding: three at $1,400, five at $1,550, two at $1,600.
const CASE_P = make({
  name: 'CL Owner Case Hobby 12-Box Case',
  unitType: 'case',
  boxesPerCase: 12,
  cost: 1400,
  open: 3
})
addStock(CASE_P, 'RM', 5, 1550, 'second buy', null, 'Vendor Two')
addStock(CASE_P, 'RM', 2, 1600, 'third buy', null, 'Vendor Three')

const options = lotOptions(CASE_P, 'RM')
ok(!!options, 'the picker read finds the product')
ok(options.lots.length === 3, 'three open layers', String(options.lots.length))
ok(
  needsLotChoice(options.lots),
  'and they are three different prices, so the operator is asked'
)
ok(
  options.lots.map((l: { unitCost: number }) => l.unitCost).join(',') === '1400,1550,1600',
  'listed oldest first',
  options.lots.map((l: { unitCost: number }) => l.unitCost).join(',')
)
ok(
  eq(options.averageCost, getProduct(CASE_P).unitCost),
  'and the reference average is the product’s own, not re-derived here'
)
ok(
  options.lots[2].vendor === 'Vendor Three',
  'the vendor a receipt was booked against rides on its layer',
  String(options.lots[2].vendor)
)
ok(options.lots[0].vendor === null, 'and an opening balance honestly has none')

const dear = options.lots[2].lotId
const sale = recordSale(CASE_P, 'RM', 2, 4000, 'Buyer', 'chose the dear layer', null, [
  { lotId: dear, qty: 2 }
])
ok(!sale.error, 'the sale is accepted', sale.error)
const saleTxn = lastTxn(CASE_P)
// $3,200 is the point of the whole feature. $2,800 is what shipped before it.
ok(eq(saleTxn.cost_basis as number, 3200), 'COGS is 2 × $1,600 = $3,200', String(saleTxn.cost_basis))
ok(
  !eq(saleTxn.cost_basis as number, 2800),
  'and NOT the $2,800 the oldest-first walk would have booked — that is the bug'
)
ok(
  JSON.stringify(layers(CASE_P)) === JSON.stringify([[1400, 3], [1550, 5]]),
  'the $1,600 layer is gone and the two cheaper ones are untouched',
  JSON.stringify(layers(CASE_P))
)
ok(stockQty(CASE_P, 'RM') === 8, 'and the shelf dropped by exactly two', String(stockQty(CASE_P, 'RM')))

const saleSlices = txnLots(saleTxn.id as string)
ok(saleSlices.length === 1, 'the movement records the one layer it took', String(saleSlices.length))
ok(
  saleSlices[0].lot_id === dear && saleSlices[0].quantity === 2 && eq(saleSlices[0].unit_cost, 1600),
  'naming the layer, the quantity and the cost it was taken at'
)
ok(saleSlices[0].picked === 1, 'and flagged as a human decision rather than a FIFO default')
ok(
  eq(
    saleSlices.reduce((n, s) => n + s.quantity * s.unit_cost, 0),
    saleTxn.cost_basis as number
  ),
  'the recorded composition sums to exactly the cost that was booked — one number, three places'
)
assertStockLotsConsistent(db)

console.log('\n--- a SPLIT: two from the cheap lot, one from the dear one ---')
const P2 = make({ name: 'CL Split Hobby Box', unitType: 'box', cost: 100, open: 3 })
addStock(P2, 'RM', 2, 300, 'dear boxes', null, 'Vendor Dear')
const p2lots = lotOptions(P2, 'RM').lots
const split = recordSale(P2, 'RM', 3, 500, 'Buyer', null, null, [
  { lotId: p2lots[0].lotId, qty: 2 },
  { lotId: p2lots[1].lotId, qty: 1 }
])
ok(!split.error, 'the split is accepted', split.error)
const splitTxn = lastTxn(P2)
ok(eq(splitTxn.cost_basis as number, 500), '2 × $100 + 1 × $300 = $500', String(splitTxn.cost_basis))
ok(!eq(splitTxn.cost_basis as number, 300), 'and not the $300 a pure FIFO walk would have booked')
ok(
  JSON.stringify(layers(P2)) === JSON.stringify([[100, 1], [300, 1]]),
  'one of each layer is left',
  JSON.stringify(layers(P2))
)
ok(txnLots(splitTxn.id as string).length === 2, 'and the movement records both slices')
assertStockLotsConsistent(db)

// ===========================================================================
console.log('\n=== 6. a break on air books the case that was actually ripped ===')
// ===========================================================================
const RIP = make({
  name: 'CL Rip Case Hobby 8-Box Case',
  unitType: 'case',
  boxesPerCase: 8,
  cost: 1400,
  open: 3
})
addStock(RIP, 'RM', 2, 1600, 'dear cases', null, 'Vendor Three')

const now = new Date()
const started = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
const session = createSession(
  { title: 'CL Tonight', startedAt: started, endedAt: null, hostId: null, note: null },
  null
)
ok(session.ok, 'a live session exists to break on', session.error)
const SESSION = session.data.id

const ripLots = lotOptions(RIP, 'RM').lots
const dearCase = ripLots[1].lotId
const rip = addItem(
  {
    sessionId: SESSION,
    kind: 'break',
    productId: RIP,
    cases: 1,
    location: 'RM',
    breakNumber: 1,
    allocation: [{ lotId: dearCase, qty: 1 }]
  },
  null
)
ok(rip.ok, 'the break is recorded', rip.error)
const ripLine = getSessionDetail(SESSION).items[0]
ok(eq(ripLine.costTotal, 1600), 'the line books $1,600 — the case that was opened', String(ripLine.costTotal))
ok(!eq(ripLine.costTotal, 1400), 'and not the $1,400 oldest-first case that was not')
ok(eq(ripLine.unitCost, 1600), 'so the per-unit cost on the line is $1,600 too', String(ripLine.unitCost))
ok(
  JSON.stringify(layers(RIP)) === JSON.stringify([[1400, 3], [1600, 1]]),
  'the dear layer is one lighter and the cheap one untouched',
  JSON.stringify(layers(RIP))
)

const ripSlices = db
  .prepare('SELECT lot_id, quantity, unit_cost, picked FROM stream_item_lots WHERE item_id = ?')
  .all(ripLine.id) as Array<{ lot_id: string; quantity: number; unit_cost: number; picked: number }>
ok(ripSlices.length === 1 && ripSlices[0].lot_id === dearCase, 'the line names the layer it took')
ok(ripSlices[0].picked === 1, 'and records that a human chose it')

console.log('\n--- removing the line puts back the layer it took, not the oldest ---')
const removed = removeItem(ripLine.id, null)
ok(removed.ok, 'the line is removed', removed.error)
ok(
  JSON.stringify(layers(RIP)) === JSON.stringify([[1400, 3], [1600, 2]]),
  'the $1,600 layer is whole again — a restore that handed the unit to the oldest layer would have read [4, 1]',
  JSON.stringify(layers(RIP))
)
ok(stockQty(RIP, 'RM') === 5, 'and the shelf is back to five', String(stockQty(RIP, 'RM')))
assertStockLotsConsistent(db)

// ===========================================================================
console.log('\n=== 7. it refuses rather than quietly falling back to FIFO ===')
// ===========================================================================
// Every case here would, if it silently walked FIFO instead, book a cost the
// operator did not choose while the screen told them they had chosen.
const GUARD = make({ name: 'CL Guard Hobby Box', unitType: 'box', cost: 10, open: 4 })
addStock(GUARD, 'RM', 4, 30, 'dear boxes', null, null)
const gLots = lotOptions(GUARD, 'RM').lots
const beforeGuard = JSON.stringify(layers(GUARD))
const beforeGuardStock = stockQty(GUARD, 'RM')

const wrongTotal = refusal(() =>
  recordSale(GUARD, 'RM', 3, 50, 'Buyer', null, null, [{ lotId: gLots[0].lotId, qty: 2 }])
)
ok(!!wrongTotal, 'an allocation that does not add up is refused', 'it was accepted')
ok(JSON.stringify(layers(GUARD)) === beforeGuard, 'and nothing moved on the layers')
ok(stockQty(GUARD, 'RM') === beforeGuardStock, 'nor on the shelf — the whole transaction rolled back')
/**
 * WHICH GATE REFUSED IT, pinned by the wording.
 *
 * There are two, and they are not redundant. `validatePicks` runs BEFORE a
 * single UPDATE and produces the sentence the operator can act on — "1 still to
 * place", "that layer only has 4 left". The engine's own arithmetic behind it
 * would catch the same case eventually, but only after part-consuming the
 * layers, and it can only say "those cost layers cover 4, not 5" because by then
 * it has forgotten which one was short.
 *
 * Asserting the message is what stops the front gate being quietly deleted: the
 * transaction rolls back either way, so nothing else about the outcome differs.
 */
ok(
  (wrongTotal ?? '').includes('still to place'),
  'and the refusal names what is missing, from the gate that runs before anything is written',
  String(wrongTotal)
)

const tooMuch = refusal(() =>
  recordSale(GUARD, 'RM', 5, 50, 'Buyer', null, null, [{ lotId: gLots[0].lotId, qty: 5 }])
)
ok(!!tooMuch, 'taking five from a layer holding four is refused')
ok(
  (tooMuch ?? '').includes('only has'),
  'naming the layer that is short rather than the shortfall in total',
  String(tooMuch)
)
ok(JSON.stringify(layers(GUARD)) === beforeGuard, 'and again nothing moved')

const ghost = refusal(() =>
  recordSale(GUARD, 'RM', 1, 50, 'Buyer', null, null, [{ lotId: 'not-a-lot', qty: 1 }])
)
ok(!!ghost, 'a layer that does not exist is refused')
ok(JSON.stringify(layers(GUARD)) === beforeGuard, 'and nothing moved')

// A layer belonging to another shelf is a stale dialog, not a legal answer:
// consuming it would decrement AM's layers against RM's stock and break the
// per-location invariant the whole engine rests on.
addStock(GUARD, 'AM', 2, 99, 'other shelf', null, null)
const amLot = lotOptions(GUARD, 'AM').lots[0].lotId
const crossed = refusal(() =>
  recordSale(GUARD, 'RM', 1, 50, 'Buyer', null, null, [{ lotId: amLot, qty: 1 }])
)
ok(!!crossed, 'a layer from another location is refused')
ok(JSON.stringify(layers(GUARD)) === beforeGuard, 'and RM is untouched')
ok(JSON.stringify(layers(GUARD, 'AM')) === JSON.stringify([[99, 2]]), 'as is AM')
assertStockLotsConsistent(db)

console.log('\n--- a reconciliation has no layers to allocate against ---')
const past = new Date()
past.setDate(past.getDate() - 30)
past.setHours(20, 0, 0, 0)
const pastEnd = new Date(past.getTime() + 2 * 60 * 60 * 1000)
const oldSession = createSession(
  { title: 'CL Past Show', startedAt: past.toISOString(), endedAt: pastEnd.toISOString(), hostId: null, note: null },
  null
)
ok(oldSession.ok, 'a past-dated session exists', oldSession.error)
const reconciled = addItem(
  {
    sessionId: oldSession.data.id,
    kind: 'break',
    productId: GUARD,
    boxes: 1,
    casePrice: 25,
    location: 'RM',
    allocation: [{ lotId: gLots[0].lotId, qty: 1 }]
  },
  null
)
ok(!reconciled.ok, 'an allocation on a reconciliation is refused rather than ignored')
ok(JSON.stringify(layers(GUARD)) === beforeGuard, 'and the shelf it does not describe is untouched')

// ===========================================================================
console.log('\n=== 8. no allocation is still oldest-first, exactly as before ===')
// ===========================================================================
// The picker is not shown when there is nothing to decide, and every
// non-interactive caller — a count-sheet reset, a purchase-order cancellation,
// a replayed scan — passes nothing. All of those must behave as they always did.
const PLAIN = make({ name: 'CL Plain Hobby Box', unitType: 'box', cost: 10, open: 3 })
addStock(PLAIN, 'RM', 3, 30, 'dear boxes', null, null)
const plainSale = recordSale(PLAIN, 'RM', 4, 50, 'Buyer', null, null)
ok(!plainSale.error, 'a sale with no allocation still works', plainSale.error)
ok(
  eq(lastTxn(PLAIN).cost_basis as number, 60),
  '3 × $10 + 1 × $30 = $60 — the oldest layers, drained in order',
  String(lastTxn(PLAIN).cost_basis)
)
ok(JSON.stringify(layers(PLAIN)) === JSON.stringify([[30, 2]]), 'two dear boxes left')
const plainSlices = txnLots(lastTxn(PLAIN).id as string)
ok(plainSlices.length === 2, 'and the movement still records what it took')
ok(
  plainSlices.every((s) => s.picked === 0),
  'flagged as a default rather than a decision — nobody was asked'
)
assertStockLotsConsistent(db)

console.log('\n--- an empty allocation is the same as none ---')
// The dialog holds a zero for every layer on screen. Tidied to empty, that is
// "no choice was made", not "take nothing".
const emptyAlloc = recordSale(PLAIN, 'RM', 1, 50, 'Buyer', null, null, [])
ok(!emptyAlloc.error, 'an empty allocation falls through to the ordinary path', emptyAlloc.error)
ok(eq(lastTxn(PLAIN).cost_basis as number, 30), 'and books the oldest remaining layer')

// ===========================================================================
console.log('\n=== 9. a correction down takes the layers it was told to ===')
// ===========================================================================
const ADJ = make({ name: 'CL Adjust Hobby Box', unitType: 'box', cost: 10, open: 3 })
addStock(ADJ, 'RM', 3, 30, 'dear boxes', null, null)
const adjLots = lotOptions(ADJ, 'RM').lots
const adjusted = adjustStock(ADJ, 'RM', -2, 'damaged', null, [{ lotId: adjLots[1].lotId, qty: 2 }])
ok(!adjusted.error, 'the correction is accepted', adjusted.error)
ok(
  JSON.stringify(layers(ADJ)) === JSON.stringify([[10, 3], [30, 1]]),
  'the two dear boxes went, not the cheap ones',
  JSON.stringify(layers(ADJ))
)
const adjSlices = txnLots(lastTxn(ADJ).id as string)
ok(adjSlices.length === 1 && eq(adjSlices[0].unit_cost, 30), 'and the movement records which layer it was')
ok(adjSlices[0].picked === 1, 'as a decision')

// An upward correction opens a layer instead of taking one, so an allocation
// against it has nothing to describe and must not be able to break it.
const up = adjustStock(ADJ, 'RM', 2, 'found', null, [{ lotId: adjLots[0].lotId, qty: 2 }])
ok(!up.error, 'an allocation sent with an upward correction is harmless', up.error)
ok(stockQty(ADJ, 'RM') === 6, 'the shelf went up by two', String(stockQty(ADJ, 'RM')))
ok(txnLots(lastTxn(ADJ).id as string).length === 0, 'and nothing was recorded as consumed')
assertStockLotsConsistent(db)

// ===========================================================================
console.log('\n=== 10. fractional stock: a giveaway of part of a box ===')
// ===========================================================================
// The one case a whole-unit stepper could not express, and the reason + clamps
// to the outstanding ask rather than always adding one.
const GIVE = make({
  name: 'CL Giveaway Hobby Box',
  unitType: 'box',
  boxesPerCase: null,
  packsPerBox: 4,
  giveaway: true,
  cost: 40,
  open: 1
})
addStock(GIVE, 'RM', 1, 80, 'dear box', null, null)
const giveLots = lotOptions(GIVE, 'RM').lots
ok(needsLotChoice(giveLots), 'two boxes at two prices is a choice even on a giveaway item')
const dearBox = giveLots[1].lotId
const giveaway = addItem(
  {
    sessionId: SESSION,
    kind: 'giveaway',
    productId: GIVE,
    boxes: 0,
    packs: 1,
    location: 'RM',
    recipient: 'winner',
    allocation: [{ lotId: dearBox, qty: 0.25 }]
  },
  null
)
ok(giveaway.ok, 'a quarter of the dear box is given away', giveaway.error)
const giveLine = getSessionDetail(SESSION).items.find((i: { productId: string }) => i.productId === GIVE)
ok(eq(giveLine.costTotal, 20), 'and books $20 — a quarter of $80', String(giveLine.costTotal))
ok(!eq(giveLine.costTotal, 10), 'not the $10 a quarter of the cheap box would have been')
ok(
  JSON.stringify(layers(GIVE)) === JSON.stringify([[40, 1], [80, 0.75]]),
  'three quarters of the dear box remain',
  JSON.stringify(layers(GIVE))
)
assertStockLotsConsistent(db)

// ===========================================================================
console.log('\n=== 12. snapping a layer must not outrun the shelf ===')
// ===========================================================================
// THE INVARIANT AND THE SNAP, AND THE FACT THAT THEY ARE ONE DECISION.
//
// A fractional take leaves rounding dust on the layer it empties — for divisors
// whose 1/N rounds down at four places, taking all N pieces leaves 0.0001 to
// 0.001 behind. `consumeFifo` snaps that to zero, because an open cost layer for
// stock that is gone can never be cleared: no UI can enter a fraction that
// small.
//
// `bumpStock` snaps too, and it asks a DIFFERENT question: it clears the shelf
// when the WHOLE SHELF comes to dust. On a one-layer shelf the two questions
// have the same answer, which is exactly why this went unseen — every fractional
// case in this suite and in the streaming suite has one layer.
//
// Put a second layer behind the first and they disagree. The front layer empties
// to 0.0004, the layer is snapped to zero, and the shelf still holds five real
// boxes — so the stock row keeps a 0.0004 that no layer accounts for, and
// Σ lot.qty_remaining == inventory_stock.quantity is broken. It stays broken:
// nothing recomputes a layer from a shelf, and undoing the movement hands back
// only what the slice recorded, so the dust is gone from the layers for good.
const DUST = make({
  name: 'CL Dust Giveaway Box',
  unitType: 'box',
  boxesPerCase: null,
  packsPerBox: 12,
  giveaway: true,
  cost: 40,
  open: 0
})
// The front layer, holding what eleven twelfths of a box leaves behind, and a
// full second layer behind it.
addStock(DUST, 'RM', 0.0837, 40, 'front layer', null, null)
addStock(DUST, 'RM', 5, 90, 'the rest of the shelf', null, null)
ok(stockQty(DUST, 'RM') === 5.0837, 'the shelf holds 5.0837', String(stockQty(DUST, 'RM')))

// The twelfth pack. Empties the front layer to 0.0004 and leaves the shelf with
// five boxes on it.
const dustSale = recordSale(DUST, 'RM', 0.0833, 5, 'Buyer', 'last pack', null, null)
ok(!dustSale.error, 'the last pack of the front layer sells', dustSale.error)
ok(stockQty(DUST, 'RM') === 5.0004, 'the shelf goes to 5.0004', String(stockQty(DUST, 'RM')))

// THE ASSERTION THIS SECTION EXISTS FOR. Against the old code the layer reads
// [ [90, 5] ] — the front one snapped away while its dust stayed on the shelf.
ok(
  JSON.stringify(layers(DUST)) === JSON.stringify([[40, 0.0004], [90, 5]]),
  'THE DUST STAYS ON THE LAYER, because the shelf is keeping it',
  JSON.stringify(layers(DUST))
)
let dustHeld = true
try {
  assertStockLotsConsistent(db)
} catch (err) {
  dustHeld = false
  console.log('   ' + (err instanceof Error ? err.message : String(err)))
}
ok(dustHeld, 'and the shelf still equals the sum of its layers')

// A dust layer in front of real stock is not permanent — it is consumed exactly
// and completely by the next movement, which is why leaving it there is safe.
const nextSale = recordSale(DUST, 'RM', 1, 120, 'Buyer', 'a whole box', null, null)
ok(!nextSale.error, 'the next sale goes through', nextSale.error)
ok(
  JSON.stringify(layers(DUST)) === JSON.stringify([[90, 4.0004]]),
  'and takes the dust layer with it, leaving nothing behind',
  JSON.stringify(layers(DUST))
)
assertStockLotsConsistent(db)

// THE OTHER HALF: when the shelf really is nothing but dust, the layer and the
// stock row must still land on zero TOGETHER. This is the case the snap was
// written for, and it has to keep working.
const LAST = make({
  name: 'CL Last Layer Box',
  unitType: 'box',
  boxesPerCase: null,
  packsPerBox: 12,
  giveaway: true,
  cost: 40,
  open: 0
})
addStock(LAST, 'RM', 0.0837, 40, 'the only layer', null, null)
const lastSale = recordSale(LAST, 'RM', 0.0833, 5, 'Buyer', 'the twelfth pack', null, null)
ok(!lastSale.error, 'the twelfth pack sells', lastSale.error)
ok(stockQty(LAST, 'RM') === 0, 'the shelf is EMPTY, not holding 0.0004', String(stockQty(LAST, 'RM')))
ok(layers(LAST).length === 0, 'and no open layer is left behind', JSON.stringify(layers(LAST)))
assertStockLotsConsistent(db)

// And the whole-unit catalog is untouched by any of it: every quantity is an
// integer, so there is never a remainder small enough to snap.
const WHOLE = make({ name: 'CL Whole Units Box', unitType: 'box', cost: 100, open: 0 })
addStock(WHOLE, 'RM', 3, 100, 'first', null, null)
addStock(WHOLE, 'RM', 4, 150, 'second', null, null)
recordSale(WHOLE, 'RM', 3, 200, 'Buyer', null, null, null)
ok(
  JSON.stringify(layers(WHOLE)) === JSON.stringify([[150, 4]]),
  'a whole-unit sale empties the first layer exactly',
  JSON.stringify(layers(WHOLE))
)
ok(stockQty(WHOLE, 'RM') === 4, 'and the shelf agrees', String(stockQty(WHOLE, 'RM')))
assertStockLotsConsistent(db)

// ===========================================================================
console.log('\n=== 13. found stock is valued at the shelf that found it ===')
// ===========================================================================
// `products.unit_cost` is the weighted average across EVERY location. For a
// product held in one place that is the shelf's own basis. For one held in two
// it is a blend, and opening a found-stock layer at it prices boxes at neither
// of the two prices they could possibly have cost.
//
// The count-sheet reset already asks `shelfBasis` for exactly this decision —
// its doc comment calls it "what a found-stock lot at that location should be
// valued at". The everyday Adjust form was the one found-stock path that did
// not, so the same correction typed on two screens produced two different cost
// bases for the same boxes.
const SPLIT = make({ name: 'CL Two Shelves Box', unitType: 'box', cost: 0, open: 0 })
addStock(SPLIT, 'RM', 10, 100, 'cheap shelf', null, null)
addStock(SPLIT, 'AM', 2, 250, 'dear shelf', null, null)
// The product average is the blend of the two — 12 boxes for $1,500.
ok(eq(getProduct(SPLIT).unitCost, 125), 'the product average blends both shelves', String(getProduct(SPLIT).unitCost))

const found = adjustStock(SPLIT, 'AM', 2, 'found two more at AM', null, null)
ok(!found.error, 'two more boxes are found at AM', found.error)
ok(
  JSON.stringify(layers(SPLIT, 'AM')) === JSON.stringify([[250, 2], [250, 2]]),
  'AND THEY ARE VALUED AT $250 — what the AM shelf carries, not the $125 blend',
  JSON.stringify(layers(SPLIT, 'AM'))
)
ok(
  JSON.stringify(layers(SPLIT, 'RM')) === JSON.stringify([[100, 10]]),
  'while the RM shelf is untouched by a correction made at AM',
  JSON.stringify(layers(SPLIT, 'RM'))
)
assertStockLotsConsistent(db)

// A shelf that has never had a layer at all still falls back on the product
// average: there is nothing better to say, and zero would be a lie.
const found2 = adjustStock(SPLIT, 'Fenwick Cards', 1, 'found one at a dropship stop', null, null)
ok(!found2.error, 'stock found somewhere with no layer history is accepted', found2.error)
const fenwick = (
  db
    .prepare(
      `SELECT unit_cost AS c FROM inventory_lots WHERE product_id = ? AND location = 'Fenwick Cards'`
    )
    .all(SPLIT) as Array<{ c: number }>
).map((r) => r.c)
ok(fenwick.length === 1, 'and opens one layer', String(fenwick.length))
ok(fenwick[0] > 0, 'valued at the product average rather than at nothing', String(fenwick[0]))
assertStockLotsConsistent(db)

// ===========================================================================
console.log('\n=== 11. the engine invariant survives all of it ===')
// ===========================================================================
// Σ lot.qty_remaining == inventory_stock.quantity, per (product, location). A
// hand-picked consumption fails by decrementing a layer without the shelf, or
// the reverse, and neither is visible on any screen until a count sheet lands.
let invariantHeld = true
try {
  assertStockLotsConsistent(db)
} catch (err) {
  invariantHeld = false
  console.log('   ' + (err instanceof Error ? err.message : String(err)))
}
ok(invariantHeld, 'every shelf still equals the sum of its cost layers')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
