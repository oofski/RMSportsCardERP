/**
 * Reconciling a past show, against a real database.
 *
 * The owner's sentence: "if the edit is happening to a date in the past that is
 * because of a reconciliation … we will search a product and add it, and then
 * can enter how many cases of it and the price we bought each case at."
 *
 * That is a claim about COST, not a claim about stock, and the difference is
 * everything this file is about. Adding a line to a show two months old must:
 *
 *   1. cost the show at the price that was stated, never at whatever the
 *      product's average has drifted to since;
 *   2. work when the product has NO stock on hand, which is the normal case —
 *      the cases were broken and thrown away in June;
 *   3. leave the on-hand count, the cost layers and the product's average cost
 *      exactly as it found them, because today's numbers were counted AFTER
 *      that night and already have those cases missing from them;
 *   4. leave tonight's show behaving precisely as it did before; and
 *   5. reverse to nothing, so a mistyped reconciliation can be undone without
 *      leaving an orphan lot, a stranded ledger row or invented stock.
 *
 * Run: npm run test:stream-reconcile
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/stream-recon-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const { createProduct, stockQty, getProduct } = require('../src/main/db/inventory')
const { assertStockLotsConsistent } = require('../src/main/db/lots')
const {
  addItem,
  createSession,
  deleteSession,
  getSessionDetail,
  removeItem
} = require('../src/main/db/streaming')
const { isPastDatedSession, parseMoneyInput } = require('../src/shared/streaming')

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

/** A local instant N days back, at a given hour — so every session below lands
 *  on the business day the test means, whatever timezone this machine is in. */
const at = (daysAgo: number, hour: number, minute = 0): string => {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

interface Seed {
  name: string
  unitType: 'case' | 'box' | 'pack'
  boxesPerCase: number | null
  packsPerBox?: number | null
  cost: number
  open: number
}

const make = (s: Seed): string =>
  createProduct(
    {
      sku: `SR-${s.name.replace(/\W+/g, '').slice(0, 12)}`,
      upc: null,
      name: s.name,
      category: 'Baseball',
      brand: '',
      setName: '',
      year: '',
      unitType: s.unitType,
      boxesPerCase: s.boxesPerCase,
      packsPerBox: s.packsPerBox ?? null,
      giveawayItem: false,
      unitCost: s.cost,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null,
      openingQuantity: s.open,
      openingLocation: 'RM'
    },
    null
  ).id

// A case-stocked product carrying five cases bought at $1,000. The stated price
// in every reconciliation below is $2,400 — deliberately nothing like $1,000, so
// a line costed at the moving average is impossible to mistake for one costed at
// what was actually paid.
const CASE_P = make({
  name: 'SR Case Product Hobby 12-Box Case',
  unitType: 'case',
  boxesPerCase: 12,
  cost: 1000,
  open: 5
})
// Box-stocked, eight boxes to a case: the entry is still cases, and the price
// has to divide down to the unit the shelf actually counts.
const BOX_P = make({
  name: 'SR Box Product Hobby Box',
  unitType: 'box',
  boxesPerCase: 8,
  cost: 100,
  open: 20
})
// The normal case for a past show: nothing left on the shelf at all.
const EMPTY_P = make({
  name: 'SR Empty Product Hobby 6-Box Case',
  unitType: 'case',
  boxesPerCase: 6,
  cost: 0,
  open: 0
})
// Box-stocked with NO boxes-per-case. A case cannot be expressed for it, and
// pretending a case holds one box is the order-of-magnitude error the unit
// contract exists to refuse.
const NO_BPC_P = make({
  name: 'SR No Divisor Hobby Box',
  unitType: 'box',
  boxesPerCase: null,
  cost: 40,
  open: 10
})
// Stocked in packs: no case structure at any price.
const PACK_P = make({
  name: 'SR Pack Product Loose Pack',
  unitType: 'pack',
  boxesPerCase: null,
  cost: 5,
  open: 30
})

const mkSession = (title: string, startedAt: string, endedAt: string | null): string => {
  const res = createSession({ title, startedAt, endedAt, hostId: null, note: null }, null)
  if (!res.ok) throw new Error(`${title}: ${res.error}`)
  return res.data.id
}

// Thirty days back and over — unambiguously history however the clock moves
// during the run.
const PAST = mkSession('SR Past Show', at(30, 20), at(30, 23))
const PAST_2 = mkSession('SR Older Show', at(45, 19), at(45, 22, 30))
// Today, already finished. Not a reconciliation: its stock came off the shelf
// this morning and is costed at the layers it took.
const TODAY = mkSession('SR Tonight', at(0, 9), at(0, 11))

/** Every cost layer this product still has, and what they are carried at. */
const lotState = (productId: string): { qty: number; value: number; rows: number } => {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(qty_remaining), 0) AS qty,
              COALESCE(SUM(qty_remaining * unit_cost), 0) AS value
         FROM inventory_lots WHERE product_id = ?`
    )
    .get(productId) as { rows: number; qty: number; value: number }
  return { qty: r.qty, value: cents(r.value), rows: r.rows }
}

/** The whole inventory ledger for one product, as two sums. Both have to come
 *  back to where they started once a line is removed. */
const txnState = (productId: string): { rows: number; qty: number; cost: number } => {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(quantity_change), 0) AS qty,
              COALESCE(SUM(cost_basis), 0) AS cost
         FROM inventory_transactions WHERE product_id = ?`
    )
    .get(productId) as { rows: number; qty: number; cost: number }
  return { rows: r.rows, qty: r.qty, cost: cents(r.cost) }
}

const itemLotRows = (itemId: string): number =>
  (
    db.prepare('SELECT COUNT(*) AS c FROM stream_item_lots WHERE item_id = ?').get(itemId) as {
      c: number
    }
  ).c

const lastItem = (sessionId: string): Record<string, unknown> => {
  const detail = getSessionDetail(sessionId)
  return detail.items[detail.items.length - 1]
}

// ---------------------------------------------------------------------------
console.log('=== 1. what counts as a date in the past ===')
// ---------------------------------------------------------------------------
const nowRef = new Date()
nowRef.setHours(14, 0, 0, 0)
const day = (daysAgo: number): string => {
  const d = new Date(nowRef)
  d.setDate(d.getDate() - daysAgo)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

ok(
  isPastDatedSession({ streamDate: day(30), endedAt: at(30, 23) }, nowRef),
  'a show that ended a month ago is history'
)
ok(
  !isPastDatedSession({ streamDate: day(0), endedAt: at(0, 11) }, nowRef),
  'a show dated today is not history, even though it has ended'
)
ok(
  !isPastDatedSession({ streamDate: day(1), endedAt: null }, nowRef),
  'a show still on air is never history, whatever day it started on'
)
// THE case the rule exists for: a Monday 9pm show ends at 2am on Tuesday. Its
// business day is already "yesterday" the moment it finishes, and a rule keyed
// on stream_date alone would turn the add form into a reconciliation form at
// midnight — while the operator is still typing breaks into it.
ok(
  !isPastDatedSession({ streamDate: day(1), endedAt: at(0, 2) }, nowRef),
  'a show that ran past midnight is not history on the day it finished'
)
ok(
  isPastDatedSession({ streamDate: day(2), endedAt: at(1, 2) }, nowRef),
  'and it becomes history the day after it finished, not the day after it started'
)

console.log('\n--- money as a person types it ---')
ok(parseMoneyInput('2400') === 2400, 'a plain amount parses')
ok(parseMoneyInput('2,400.50') === 2400.5, 'commas are ignored')
ok(parseMoneyInput('$2,400') === 2400, 'a dollar sign is ignored')
ok(Number.isNaN(parseMoneyInput('')), 'blank is NaN, not zero')
ok(Number.isNaN(parseMoneyInput('   ')), 'whitespace is NaN, not zero')
ok(Number.isNaN(parseMoneyInput('abc')), 'a word is NaN')
ok(Number.isNaN(parseMoneyInput('1e3')), 'exponent notation is not a price somebody typed')
ok(Number.isNaN(parseMoneyInput('0x10')), 'hex is not a price either')
ok(parseMoneyInput('-5') === -5, 'a negative parses, so it can be refused in its own words')

// ---------------------------------------------------------------------------
console.log('\n=== 2. a past-dated add books the price that was STATED ===')
// ---------------------------------------------------------------------------
const beforeStock = stockQty(CASE_P, 'RM')
const beforeLots = lotState(CASE_P)
const beforeAvg = getProduct(CASE_P).unitCost
const beforeTxn = txnState(CASE_P)

const r1 = addItem(
  {
    sessionId: PAST,
    kind: 'break',
    productId: CASE_P,
    cases: 4,
    casePrice: 2400,
    location: 'RM',
    breakNumber: 4
  },
  null
)
ok(r1.ok, 'four cases at $2,400 are accepted on a past show', r1.error)
const line1 = lastItem(PAST) as Record<string, number | string | null>

ok(eq(line1.costTotal as number, 9600), '4 × $2,400 books $9,600', String(line1.costTotal))
ok(
  eq(line1.unitCost as number, 2400),
  'the cost per stock unit is the stated case price, not the $1,000 average',
  String(line1.unitCost)
)
ok(line1.quantity === 4, 'four cases of a case-stocked product is four stock units')
ok(eq(line1.statedCasePrice as number, 2400), 'the assertion is stored on the line')
ok(line1.enteredCases === 4, 'the line reads back as the four cases that were typed')

console.log('\n--- and it moved nothing ---')
ok(stockQty(CASE_P, 'RM') === beforeStock, 'the shelf still holds what it held')
const afterLots = lotState(CASE_P)
ok(
  afterLots.rows === beforeLots.rows && afterLots.qty === beforeLots.qty,
  'no cost layer was opened, consumed or left half-eaten'
)
ok(eq(afterLots.value, beforeLots.value), 'the value of the layers on hand is unchanged')
ok(
  eq(getProduct(CASE_P).unitCost, beforeAvg),
  "a price from a show a month ago does not re-base today's average cost",
  `${beforeAvg} → ${getProduct(CASE_P).unitCost}`
)
ok(itemLotRows(line1.id as string) === 0, 'no consumed layers are recorded, because none were')

const afterTxn = txnState(CASE_P)
ok(afterTxn.rows === beforeTxn.rows + 1, 'one ledger row was written for it')
ok(
  afterTxn.qty === beforeTxn.qty,
  'and it carries a quantity change of zero — inventory history cannot disagree with the shelf'
)
ok(eq(afterTxn.cost, beforeTxn.cost + 9600), 'the ledger row carries the whole stated cost')
assertStockLotsConsistent(db)
ok(true, 'stock and cost layers still agree')

// ---------------------------------------------------------------------------
console.log('\n=== 3. the case price divides down to the unit the shelf counts ===')
// ---------------------------------------------------------------------------
const r2 = addItem(
  { sessionId: PAST, kind: 'break', productId: BOX_P, cases: 2, casePrice: 2400, location: 'RM' },
  null
)
ok(r2.ok, 'two cases of a box-stocked product are accepted', r2.error)
const line2 = lastItem(PAST) as Record<string, number | string | null>
ok(line2.quantity === 16, 'two 8-box cases are sixteen boxes on a box-stocked product')
ok(eq(line2.unitCost as number, 300), '$2,400 a case is $300 a box')
ok(eq(line2.costTotal as number, 4800), 'and the line books 2 × $2,400')
ok(stockQty(BOX_P, 'RM') === 20, 'still twenty boxes on the shelf')

// ---------------------------------------------------------------------------
console.log('\n=== 4. the normal case: nothing on hand at all ===')
// ---------------------------------------------------------------------------
ok(stockQty(EMPTY_P, 'RM') === 0, 'the fixture product genuinely holds nothing')
const r3 = addItem(
  { sessionId: PAST, kind: 'break', productId: EMPTY_P, cases: 3, casePrice: 1500, location: 'RM' },
  null
)
ok(r3.ok, 'a break of stock that is long gone is recordable', r3.error)
const line3 = lastItem(PAST) as Record<string, number | string | null>
ok(eq(line3.costTotal as number, 4500), 'and it books 3 × $1,500')
ok(stockQty(EMPTY_P, 'RM') === 0, 'the shelf is still at zero — not at minus three')
ok(lotState(EMPTY_P).rows === 0, 'and no phantom cost layer was invented for it')
assertStockLotsConsistent(db)
ok(true, 'the lot/stock invariant survives a break of stock that no longer exists')

// The same add through the ordinary path is exactly what fails, which is why
// the reconciliation path exists at all.
const r3b = addItem(
  { sessionId: TODAY, kind: 'break', productId: EMPTY_P, cases: 3, location: 'RM' },
  null
)
ok(!r3b.ok, "the same break on tonight's show is refused — there is nothing to take")
ok(/Only 0 in RM/.test(r3b.error ?? ''), 'and it says so in the shelf’s own terms', r3b.error)

// ---------------------------------------------------------------------------
console.log('\n=== 5. tonight is untouched by any of this ===')
// ---------------------------------------------------------------------------
const beforeTonight = stockQty(CASE_P, 'RM')
const r4 = addItem(
  { sessionId: TODAY, kind: 'break', productId: CASE_P, cases: 1, location: 'RM' },
  null
)
ok(r4.ok, "a break on today's show still records", r4.error)
const line4 = lastItem(TODAY) as Record<string, number | string | null>
ok(eq(line4.costTotal as number, 1000), 'and it books the FIFO cost of the layer it took')
ok(line4.statedCasePrice === null, 'with no stated price on it')
ok(stockQty(CASE_P, 'RM') === beforeTonight - 1, 'the case came off the shelf, as it always did')
ok(itemLotRows(line4.id as string) === 1, 'and the layer it consumed is named on the line')

const r5 = addItem(
  { sessionId: TODAY, kind: 'break', productId: CASE_P, cases: 1, casePrice: 2400, location: 'RM' },
  null
)
ok(!r5.ok, "a stated price is refused on a show that is not in the past")
ok(
  /not history yet/.test(r5.error ?? ''),
  'and the refusal says why rather than silently ignoring the price',
  r5.error
)

const r6 = addItem(
  { sessionId: PAST, kind: 'break', productId: CASE_P, cases: 1, location: 'RM' },
  null
)
ok(!r6.ok, 'and a past show refuses an add with NO price rather than eating stock bought since')
ok(stockQty(CASE_P, 'RM') === beforeTonight - 1, 'the refusal took nothing off the shelf')

// Removing a normal line still puts back exactly what it took.
const back = removeItem(line4.id as string, null)
ok(back.ok, 'the ordinary line removes', back.error)
ok(stockQty(CASE_P, 'RM') === beforeTonight, 'and its case is back on the shelf')
assertStockLotsConsistent(db)
ok(true, 'with the layers it came from restored')

// ---------------------------------------------------------------------------
console.log('\n=== 6. what it refuses, and how honestly ===')
// ---------------------------------------------------------------------------
const bad = (
  input: Record<string, unknown>,
  name: string,
  pattern: RegExp
): void => {
  const res = addItem(
    { sessionId: PAST, kind: 'break', productId: CASE_P, cases: 1, location: 'RM', ...input },
    null
  )
  ok(!res.ok && pattern.test(res.error ?? ''), name, res.error ?? 'accepted')
}

bad({ casePrice: -1 }, 'a negative price is refused', /less than nothing/)
bad({ casePrice: '' }, 'a blank price is refused', /as a number/)
bad({ casePrice: 'abc' }, 'a non-numeric price is refused', /as a number/)
bad({ casePrice: Number.NaN }, 'a NaN price is refused rather than stored', /as a number/)
bad({ casePrice: 2400, cases: 0 }, 'zero cases is refused', /at least one case/)
bad({ casePrice: 2400, cases: 2.5 }, 'a part-case is refused', /whole/)
bad(
  { casePrice: 2400, cases: 1, boxes: 3 },
  'loose boxes beside a case price are refused rather than silently dropped',
  /priced per case/
)

const noDivisor = addItem(
  { sessionId: PAST, kind: 'break', productId: NO_BPC_P, cases: 2, casePrice: 800, location: 'RM' },
  null
)
ok(
  !noDivisor.ok && /boxes-per-case/.test(noDivisor.error ?? ''),
  'a box-stocked product with no boxes-per-case cannot express a case, and says which field to fill in',
  noDivisor.error ?? 'accepted'
)
const packStocked = addItem(
  { sessionId: PAST, kind: 'break', productId: PACK_P, cases: 1, casePrice: 60, location: 'RM' },
  null
)
ok(
  !packStocked.ok && /not cases or boxes/.test(packStocked.error ?? ''),
  'a pack-stocked product has no case to price, and is refused by name',
  packStocked.error ?? 'accepted'
)

const nothingLanded = getSessionDetail(PAST).items.length
ok(nothingLanded === 3, 'none of the refusals wrote a line', String(nothingLanded))
ok(eq(txnState(CASE_P).cost, afterTxn.cost), 'and none of them booked a cent')

// ---------------------------------------------------------------------------
console.log('\n=== 7. a reconciled giveaway costs the show what the prize cost ===')
// ---------------------------------------------------------------------------
const r7 = addItem(
  {
    sessionId: PAST,
    kind: 'giveaway',
    productId: CASE_P,
    cases: 1,
    casePrice: 2400,
    location: 'RM',
    recipient: 'someone'
  },
  null
)
ok(r7.ok, 'a giveaway can be reconciled too', r7.error)
const line7 = lastItem(PAST) as Record<string, number | string | null>
ok(eq(line7.lossValue as number, 2400), 'and the loss it books is the price that was paid for it')
ok(eq(line7.costTotal as number, 2400), 'matching the cost on the line')
ok(stockQty(CASE_P, 'RM') === beforeTonight, 'with the shelf still untouched')

// ---------------------------------------------------------------------------
console.log('\n=== 8. removing one reverses it exactly ===')
// ---------------------------------------------------------------------------
const beforeRemove = {
  stock: stockQty(CASE_P, 'RM'),
  lots: lotState(CASE_P),
  avg: getProduct(CASE_P).unitCost,
  txn: txnState(CASE_P)
}
const rm1 = removeItem(line1.id as string, null)
ok(rm1.ok, 'the four-case reconciliation removes', rm1.error)
ok(
  db.prepare('SELECT COUNT(*) AS c FROM stream_items WHERE id = ?').get(line1.id as string).c === 0,
  'the line is gone'
)
ok(itemLotRows(line1.id as string) === 0, 'and it left no orphan layer rows behind')
ok(stockQty(CASE_P, 'RM') === beforeRemove.stock, 'no stock was invented by the undo')
const lotsAfterRemove = lotState(CASE_P)
ok(
  lotsAfterRemove.rows === beforeRemove.lots.rows &&
    lotsAfterRemove.qty === beforeRemove.lots.qty &&
    eq(lotsAfterRemove.value, beforeRemove.lots.value),
  'and no cost layer moved'
)
ok(eq(getProduct(CASE_P).unitCost, beforeRemove.avg), 'the average cost is where it was')
const txnAfterRemove = txnState(CASE_P)
ok(txnAfterRemove.rows === beforeRemove.txn.rows + 1, 'a reversing ledger row was written')
ok(txnAfterRemove.qty === beforeRemove.txn.qty, 'carrying no quantity, exactly as the original did')
ok(
  eq(txnAfterRemove.cost, beforeRemove.txn.cost - 9600),
  'and cancelling the $9,600 to the cent',
  String(txnAfterRemove.cost)
)
assertStockLotsConsistent(db)
ok(true, 'stock and layers still agree after the undo')

// ---------------------------------------------------------------------------
console.log('\n=== 9. reconciling the same show twice does not double-count ===')
// ---------------------------------------------------------------------------
// Two identical entries ARE two real breaks — a show breaks the same product
// more than once — so they book twice, and that is correct. What must not
// happen is either of them touching stock, or an undo of the pair leaving the
// database anywhere other than exactly where it started.
const start = {
  stock: stockQty(CASE_P, 'RM'),
  lots: lotState(CASE_P),
  avg: getProduct(CASE_P).unitCost,
  txn: txnState(CASE_P),
  cost: getSessionDetail(PAST_2).totals.totalCost
}
const dupA = addItem(
  { sessionId: PAST_2, kind: 'break', productId: CASE_P, cases: 2, casePrice: 2400, location: 'RM' },
  null
)
const dupB = addItem(
  { sessionId: PAST_2, kind: 'break', productId: CASE_P, cases: 2, casePrice: 2400, location: 'RM' },
  null
)
ok(dupA.ok && dupB.ok, 'both entries are accepted', dupA.error ?? dupB.error)
ok(
  eq(getSessionDetail(PAST_2).totals.breakCost, 9600),
  'the show carries both, at $4,800 each',
  String(getSessionDetail(PAST_2).totals.breakCost)
)
ok(stockQty(CASE_P, 'RM') === start.stock, 'and neither of them moved a single case')

const items2 = getSessionDetail(PAST_2).items
for (const it of items2) removeItem(it.id, null)
ok(getSessionDetail(PAST_2).items.length === 0, 'both come off again')
ok(eq(getSessionDetail(PAST_2).totals.totalCost, start.cost), 'leaving the show costing nothing')
ok(stockQty(CASE_P, 'RM') === start.stock, 'the shelf is exactly where it started')
const endLots = lotState(CASE_P)
ok(
  endLots.rows === start.lots.rows && endLots.qty === start.lots.qty && eq(endLots.value, start.lots.value),
  'the cost layers are exactly where they started'
)
ok(eq(getProduct(CASE_P).unitCost, start.avg), 'and so is the average cost')
ok(eq(txnState(CASE_P).cost, start.txn.cost), 'the ledger nets back to the cent')
ok(
  db
    .prepare(
      `SELECT COUNT(*) AS c FROM stream_item_lots l
        WHERE NOT EXISTS (SELECT 1 FROM stream_items i WHERE i.id = l.item_id)`
    )
    .get().c === 0,
  'no stream_item_lots row is left pointing at a line that no longer exists'
)

// ---------------------------------------------------------------------------
console.log('\n=== 10. deleting a reconciled show is the same undo, wholesale ===')
// ---------------------------------------------------------------------------
const beforeDelete = {
  stock: stockQty(CASE_P, 'RM'),
  boxStock: stockQty(BOX_P, 'RM'),
  lots: lotState(CASE_P),
  avg: getProduct(CASE_P).unitCost
}
const del = deleteSession(PAST, null)
ok(del.ok, 'the past show deletes with its lines', del.error)
ok(getSessionDetail(PAST) === null, 'and is gone')
ok(stockQty(CASE_P, 'RM') === beforeDelete.stock, 'no stock came back for the reconciled lines')
ok(stockQty(BOX_P, 'RM') === beforeDelete.boxStock, 'nor for the box-stocked one')
ok(stockQty(EMPTY_P, 'RM') === 0, 'and the empty shelf is still empty, not holding three cases')
const lotsAfterDelete = lotState(CASE_P)
ok(
  lotsAfterDelete.rows === beforeDelete.lots.rows &&
    lotsAfterDelete.qty === beforeDelete.lots.qty &&
    eq(lotsAfterDelete.value, beforeDelete.lots.value),
  'no cost layer was disturbed'
)
ok(eq(getProduct(CASE_P).unitCost, beforeDelete.avg), 'and the average cost is untouched')
assertStockLotsConsistent(db)
ok(true, 'the database is consistent at the end of all of it')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
