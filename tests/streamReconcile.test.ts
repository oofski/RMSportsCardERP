/**
 * Reconciling a past show, against a real database.
 *
 * The owner's sentence: "if the edit is happening to a date in the past that is
 * because of a reconciliation … we will search a product and add it, and then
 * can enter how many cases of it and the price we bought each case at."
 *
 * And the one that followed it, once he tried it on a product he buys by the
 * box: "if a product is tagged as a box not a case … then the default value
 * should just be a box not a case, and I can enter the per-box value." So the
 * entry unit follows the PRODUCT, not the word "case" — a box-stocked product is
 * counted in boxes at a price per box, which needs no boxes-per-case because
 * there is nothing to convert.
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
  removeItem,
  setItemCost
} = require('../src/main/db/streaming')
const { isPastDatedSession, parseMoneyInput, statedPriceUnit } = require('../src/shared/streaming')

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
// Box-stocked, eight boxes to a case. The divisor is real and the LIVE break
// path still uses it — but a reconciliation of this product is entered in boxes
// at a price per box, because that is the unit it is stocked in.
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
// Box-stocked with NO boxes-per-case — the owner's own failing product. A case
// still cannot be expressed for it, and pretending a case holds one box is the
// order-of-magnitude error the unit contract exists to refuse. But a
// reconciliation of it never asks: it counts boxes and prices boxes, and the
// divisor it does not have is one it never needed.
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

/**
 * How far ONE product's shelf sits from its cost layers.
 *
 * The whole-database assertion cannot be used past section 12: the live
 * fractional break there leaves CASE_P a quarter of a case apart, and that
 * section records it as the behaviour that actually exists rather than the one
 * that would be tidier. So a later section proves what it can honestly prove —
 * that it moved neither side of that gap — and demands an exact zero of the
 * products it created itself.
 */
const lotStockGap = (productId: string): number => {
  const rows = db
    .prepare(
      `SELECT s.location AS loc, s.quantity AS stock,
              COALESCE((SELECT SUM(l.qty_remaining) FROM inventory_lots l
                        WHERE l.product_id = s.product_id AND l.location = s.location), 0) AS lots
         FROM inventory_stock s WHERE s.product_id = ?`
    )
    .all(productId) as Array<{ loc: string; stock: number; lots: number }>
  return rows.reduce((worst, r) => Math.max(worst, Math.abs(r.stock - r.lots)), 0)
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

/**
 * THE WINDOW IS TWENTY-FOUR HOURS FROM THE MOMENT THE SHOW ENDED.
 *
 * The owner's rule, in his words: "it should be 24 hours after the stream that
 * it is reconciliation, not right away, since I wanna pull from inventory."
 *
 * It used to be "the day it ended is behind us", which made the grace period
 * depend on what time the show happened to finish — nearly a full day for a
 * show ending at 2am, one hour for a show ending at 11pm. Nobody enters a
 * Friday night's cases at 11:59 on Friday; they do it on Saturday morning with
 * the boxes in front of them, and the old rule had already closed the shelf.
 */
const hoursAgo = (h: number): string => new Date(nowRef.getTime() - h * 3600_000).toISOString()

ok(
  isPastDatedSession({ endedAt: at(30, 23) }, nowRef),
  'a show that ended a month ago is history'
)
ok(
  !isPastDatedSession({ endedAt: at(0, 11) }, nowRef),
  'a show that ended earlier today is not history — its cases still come off the shelf'
)
ok(
  !isPastDatedSession({ endedAt: null }, nowRef),
  'a show still on air is never history, whatever day it started on'
)
// THE case the old rule got wrong, and the reason for the change: a Friday
// 9pm-to-11pm show, opened on Saturday morning to enter what went out. Fifteen
// hours have passed and the day HAS turned, so the calendar rule called it
// history and refused to touch inventory.
ok(
  !isPastDatedSession({ endedAt: hoursAgo(15) }, nowRef),
  'THE MORNING AFTER IS STILL THE SHELF — fifteen hours on, and last night’s cases can still be drawn',
  hoursAgo(15)
)
ok(
  !isPastDatedSession({ endedAt: hoursAgo(23.5) }, nowRef),
  'and so is the twenty-third hour — the window is a full day, not "until midnight"'
)
ok(
  isPastDatedSession({ endedAt: hoursAgo(24.5) }, nowRef),
  'PAST TWENTY-FOUR HOURS IT IS A RECONCILIATION — the stock is long gone, so the price is stated instead'
)
/**
 * EVERY SHOW GETS THE SAME WINDOW, which is the whole point of measuring an
 * elapsed time rather than a calendar day. Two shows that ended twenty hours
 * ago are in the same mode whether one finished at 2am and the other at 11pm.
 */
ok(
  !isPastDatedSession({ endedAt: hoursAgo(20) }, nowRef) &&
    !isPastDatedSession({ endedAt: hoursAgo(20.01) }, nowRef),
  'and the answer turns on hours elapsed, never on the hour of the clock the show happened to end at'
)
// A stamp nobody can parse, and one in the future, both answer "not history":
// a movement can be undone, a reconciliation asserts a cost nobody checked.
ok(
  !isPastDatedSession({ endedAt: 'not a date' }, nowRef) &&
    !isPastDatedSession({ endedAt: hoursAgo(-5) }, nowRef),
  'a broken or future end stamp leaves the shelf open rather than asserting a cost'
)

/**
 * AND THE WINDOW IS VISIBLE WHILE IT RUNS.
 *
 * The switch used to arrive with no warning at all: somebody came back the
 * morning after to enter the night's cases and met a form that would not touch
 * inventory, with nothing on screen having ever mentioned a deadline. A window
 * nobody can see is a trap however long it is.
 */
const { msUntilReconcile } = require('../src/shared/streaming')
const hoursLeft = (v: number | null): number | null => (v === null ? null : v / 3600_000)
ok(
  msUntilReconcile({ endedAt: null }, nowRef) === null,
  'NOTHING IS COUNTING DOWN WHILE THE SHOW IS ON AIR — that is not the same as "no time left"'
)
ok(
  Math.abs((hoursLeft(msUntilReconcile({ endedAt: hoursAgo(15) }, nowRef)) ?? 0) - 9) < 0.01,
  'fifteen hours after it ended, nine are left',
  String(hoursLeft(msUntilReconcile({ endedAt: hoursAgo(15) }, nowRef)))
)
ok(
  msUntilReconcile({ endedAt: hoursAgo(40) }, nowRef) === 0,
  'AND IT IS ZERO ONCE THE SHELF HAS CLOSED, never negative — the screen has nothing left to promise',
  String(msUntilReconcile({ endedAt: hoursAgo(40) }, nowRef))
)
ok(
  msUntilReconcile({ endedAt: hoursAgo(24) }, nowRef) === 0 &&
    isPastDatedSession({ endedAt: hoursAgo(24) }, nowRef),
  'THE TWO AGREE AT THE BOUNDARY — the countdown hits zero exactly when the mode flips, so the note can never promise time the form will refuse'
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
console.log('\n=== 3. a box-stocked product is entered in BOXES, at a per-box price ===')
// ---------------------------------------------------------------------------
// This product HAS a boxes-per-case, and it is still not used here: the entry
// unit follows what the shelf counts, so the operator states boxes and what one
// box cost. Nothing is divided down, so nothing can be rounded on the way in.
const r2 = addItem(
  { sessionId: PAST, kind: 'break', productId: BOX_P, boxes: 16, casePrice: 300, location: 'RM' },
  null
)
ok(r2.ok, 'sixteen boxes of a box-stocked product are accepted', r2.error)
const line2 = lastItem(PAST) as Record<string, number | string | null>
ok(line2.quantity === 16, 'sixteen boxes is sixteen stock units on a box-stocked product')
ok(eq(line2.unitCost as number, 300), 'and the cost per stock unit is the stated BOX price')
ok(eq(line2.costTotal as number, 4800), 'so the line books 16 × $300')
ok(line2.enteredBoxes === 16, 'the line reads back as the sixteen boxes that were typed')
ok(
  line2.enteredCases === null,
  'and carries no case count — which is how the row says its price is per box'
)
ok(stockQty(BOX_P, 'RM') === 20, 'still twenty boxes on the shelf')

// The old rule, refused now. A case entry on a box-stocked product would have to
// be divided by a boxes-per-case to become a price, and the number it produced
// would not be the one the operator typed.
const boxAsCases = addItem(
  { sessionId: PAST, kind: 'break', productId: BOX_P, cases: 2, casePrice: 2400, location: 'RM' },
  null
)
ok(
  !boxAsCases.ok && /priced per box/.test(boxAsCases.error ?? ''),
  'a case entry on a box-stocked product is refused, divisor or no divisor',
  boxAsCases.error ?? 'accepted'
)

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
// A PART-CASE IS NOT REFUSED, and used to be. A night that went through a case
// and a quarter cost a case and a quarter, and this is the only field that was
// ever going to say so. It is safe here and nowhere else because a
// reconciliation moves no stock — see section 12, which proves the shelf, the
// average and the cost layers all sit still while 1.25 is recorded.
bad(
  { casePrice: 2400, cases: 1, boxes: 3 },
  'loose boxes beside a case price are refused rather than silently dropped',
  /priced per case/
)

/**
 * THIS ASSERTION USED TO SAY SOMETHING ELSE.
 *
 * It read: a box-stocked product with no boxes-per-case cannot express a case,
 * and the refusal names the field to fill in. That was the old rule — every
 * reconciliation was entered in cases — and it is precisely the wall the owner
 * hit: the product is bought and broken by the box, the divisor is meaningless
 * for it, and the app demanded one anyway.
 *
 * The refusal is still here because the entry is still wrong, but for the honest
 * reason: this product is priced per BOX, so a case count is a number that
 * cannot be turned into what it cost. It no longer sends anybody to Inventory to
 * invent a divisor. The old message is still correct where it always was — a
 * LIVE break really does have to convert cases into boxes — and section 11
 * proves it survives there.
 */
const noDivisorAsCases = addItem(
  { sessionId: PAST, kind: 'break', productId: NO_BPC_P, cases: 2, casePrice: 800, location: 'RM' },
  null
)
ok(
  !noDivisorAsCases.ok && /priced per box/.test(noDivisorAsCases.error ?? ''),
  'a box-stocked product refuses a case entry as priced per box, not as a missing divisor',
  noDivisorAsCases.error ?? 'accepted'
)
ok(
  !/boxes-per-case/.test(noDivisorAsCases.error ?? ''),
  'and never sends the operator to Inventory for a divisor a reconciliation does not use',
  noDivisorAsCases.error ?? 'accepted'
)
const packStocked = addItem(
  { sessionId: PAST, kind: 'break', productId: PACK_P, cases: 1, casePrice: 60, location: 'RM' },
  null
)
ok(
  !packStocked.ok && /not cases or boxes/.test(packStocked.error ?? ''),
  'a pack-stocked product has no case or box to price, and is refused by name',
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

// ---------------------------------------------------------------------------
console.log('\n=== 11. the owner’s product: stocked in boxes, no divisor, priced per box ===')
// ---------------------------------------------------------------------------
// The exact entry that used to come back "No boxes-per-case set for this
// product, so cases cannot be converted to boxes. Set it in Inventory." Nothing
// about that product needs a boxes-per-case: it is bought by the box, broken by
// the box and counted by the box, and the divisor only ever existed to express a
// CASE on a shelf that counts boxes. So the entry stops asking for one.
{
  const BOXES = mkSession('SR Box Night', at(28, 20), at(28, 23))
  const before = {
    qty: stockQty(NO_BPC_P, 'RM'),
    avg: getProduct(NO_BPC_P).unitCost,
    lots: lotState(NO_BPC_P),
    txn: txnState(NO_BPC_P)
  }
  const r = addItem(
    { sessionId: BOXES, kind: 'break', productId: NO_BPC_P, boxes: 3, casePrice: 40, location: 'RM' },
    null
  )
  ok(r.ok, 'three boxes at $40 a box are recorded against a show two months old', r.ok ? '' : r.error)

  const line = lastItem(BOXES) as Record<string, number | string | null>
  ok(line.quantity === 3, 'three boxes is three stock units — nothing was converted')
  ok(eq(line.costTotal as number, 120), 'and the cost is boxes × the per-box price', String(line.costTotal))
  ok(eq(line.unitCost as number, 40), 'so a stock unit of it cost exactly what was stated')
  ok(eq(line.statedCasePrice as number, 40), 'the stated price is stored as typed — per box')
  ok(
    line.enteredBoxes === 3 && line.enteredCases === null,
    'and the row says which unit that price is per, through the count it was entered in'
  )
  ok(statedPriceUnit(line) === 'box', 'which reads back as a per-box price')

  console.log('\n--- and it moved nothing, exactly like a case reconciliation ---')
  ok(stockQty(NO_BPC_P, 'RM') === before.qty, 'the shelf still holds what it held')
  ok(eq(getProduct(NO_BPC_P).unitCost, before.avg), 'the average cost did not move')
  const lots = lotState(NO_BPC_P)
  ok(
    lots.rows === before.lots.rows && lots.qty === before.lots.qty && eq(lots.value, before.lots.value),
    'no cost layer was opened, consumed or left half-eaten'
  )
  ok(itemLotRows(line.id as string) === 0, 'and no consumed layers are named on the line')
  const txn = txnState(NO_BPC_P)
  ok(txn.qty === before.txn.qty, 'the ledger row carries a quantity change of zero')
  ok(eq(txn.cost, before.txn.cost + 120), 'and the whole stated cost')
  assertStockLotsConsistent(db)
  ok(true, 'stock and cost layers still agree')

  // The v0.0.84 reasoning, in boxes: a night that went through two and a half
  // boxes cost two and a half boxes, and nothing on a reconciliation can be
  // corrupted by saying so.
  const half = addItem(
    { sessionId: BOXES, kind: 'break', productId: NO_BPC_P, boxes: 2.5, casePrice: 40, location: 'RM' },
    null
  )
  ok(half.ok, 'half a box is recordable, exactly as a quarter of a case is', half.ok ? '' : half.error)
  const halfLine = lastItem(BOXES) as Record<string, number | string | null>
  ok(
    Math.abs((halfLine.quantity as number) - 2.5) < 1e-9,
    'the line records 2.5, not a rounded 2 or 3',
    String(halfLine.quantity)
  )
  ok(eq(halfLine.costTotal as number, 100), 'and costs it at 2.5 × $40')
  ok(stockQty(NO_BPC_P, 'RM') === before.qty, 'with the shelf still where it was')

  console.log('\n--- the divisor still matters where it always did ---')
  // The refusal the old test asserted, in the place it is still true: a LIVE
  // break really does have to turn cases into boxes to take them off the shelf,
  // and it cannot without the divisor.
  const liveCases = addItem(
    { sessionId: TODAY, kind: 'break', productId: NO_BPC_P, cases: 1, location: 'RM' },
    null
  )
  ok(
    !liveCases.ok && /boxes-per-case/.test(liveCases.error ?? ''),
    'a LIVE break of it in cases is still refused, and still names the field to fill in',
    liveCases.error ?? 'accepted'
  )
  const liveBoxes = addItem(
    { sessionId: TODAY, kind: 'break', productId: NO_BPC_P, boxes: 2, location: 'RM' },
    null
  )
  ok(liveBoxes.ok, 'while a live break of it in boxes records', liveBoxes.ok ? '' : liveBoxes.error)
  ok(
    stockQty(NO_BPC_P, 'RM') === before.qty - 2,
    'and takes its two boxes off the shelf, as it always did'
  )
  assertStockLotsConsistent(db)
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. part of a case, and the shelf still never moves ===')
// ---------------------------------------------------------------------------
// A night can go through a case and a quarter. Everywhere else a case count is
// whole because it moves stock and a shelf cannot hold a quarter of one; a
// reconciliation moves NO stock, so the rule that protects the shelf has
// nothing to protect and refusing 1.25 would only force a wrong number into the
// one field meant to say what really happened.
{
  // Its own session: the sections above delete PAST on their way out.
  const FRAC = mkSession('SR Quarter Case', at(21, 20), at(21, 23))
  const before = {
    qty: stockQty(CASE_P, 'RM'),
    avg: getProduct(CASE_P).unitCost,
    lots: lotState(CASE_P)
  }
  const r = addItem(
    { sessionId: FRAC, kind: 'break', productId: CASE_P, cases: 1.25, casePrice: 6525, location: 'RM' },
    null
  )
  ok(r.ok, 'a quarter-case reconciliation is accepted', r.ok ? '' : r.error)

  const line = db
    .prepare('SELECT quantity, cost_total, stated_case_price FROM stream_items WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(FRAC) as { quantity: number; cost_total: number; stated_case_price: number }
  ok(Math.abs(line.quantity - 1.25) < 1e-9, 'the line records 1.25, not a rounded 1 or 2', String(line.quantity))
  ok(eq(line.cost_total, 1.25 * 6525), 'and costs it at 1.25 x the stated case price', String(line.cost_total))
  ok(eq(line.stated_case_price, 6525), 'the stated price is the price per WHOLE case')

  ok(stockQty(CASE_P, 'RM') === before.qty, 'the shelf did not move')
  ok(eq(getProduct(CASE_P).unitCost, before.avg), 'the average cost did not move')
  const after = lotState(CASE_P)
  ok(
    after.rows === before.lots.rows && after.qty === before.lots.qty && eq(after.value, before.lots.value),
    'no cost layer was opened or consumed'
  )
  const txn = db
    .prepare("SELECT quantity_change FROM inventory_transactions WHERE product_id = ? ORDER BY rowid DESC LIMIT 1")
    .get(CASE_P) as { quantity_change: number }
  ok(txn.quantity_change === 0, 'and the ledger row carries a quantity change of zero')
  assertStockLotsConsistent(db)
}

// A live show is a different act and must not have been widened by this. The
// renderer refuses a fraction there (`count` only allows one when reconciling),
// which is where the guard has always been for a live entry — breakToStock has
// never rejected a fractional CASE count on a case-stocked product, before this
// change or after it. Asserted as the behaviour that actually exists rather
// than the one that would be tidier, so this reads as a record and not a claim.
{
  const shelfBefore = stockQty(CASE_P, 'RM')
  const r = addItem(
    { sessionId: TODAY, kind: 'break', productId: CASE_P, cases: 1.25, location: 'RM' },
    null
  )
  ok(
    r.ok,
    'a live fraction still reaches the same conversion it always did — the UI is the gate there',
    r.ok ? '' : (r.error ?? '')
  )
  ok(
    stockQty(CASE_P, 'RM') !== shelfBefore,
    'and unlike a reconciliation, a live entry DOES move the shelf'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 13. a line says which unit its stated price is in ===')
// ---------------------------------------------------------------------------
// One column holds both prices, so the row has to be able to say which it means.
// It does, through the count it was entered in — and a line recorded before any
// of this must still read as what it was: cases.
{
  const MIXED = mkSession('SR Mixed Units', at(35, 19), at(35, 22))
  addItem(
    { sessionId: MIXED, kind: 'break', productId: CASE_P, cases: 2, casePrice: 2400, location: 'RM' },
    null
  )
  const caseLine = lastItem(MIXED) as Record<string, number | string | null>
  ok(statedPriceUnit(caseLine) === 'case', 'a case-stocked line reads back as priced per case')
  ok(eq(caseLine.statedCasePrice as number, 2400), 'at the price that was stated for a case')
  addItem(
    { sessionId: MIXED, kind: 'break', productId: BOX_P, boxes: 5, casePrice: 300, location: 'RM' },
    null
  )
  const boxLine = lastItem(MIXED) as Record<string, number | string | null>
  ok(statedPriceUnit(boxLine) === 'box', 'and a box-stocked line beside it as priced per box')
  ok(eq(boxLine.costTotal as number, 1500), 'costing 5 × $300, not 5 × a case', String(boxLine.costTotal))

  // The rule, on the shapes a stored row can actually take. The last of these is
  // a row from before the entered units existed: cases were the only thing a
  // reconciliation could be entered in, so cases is what it was.
  ok(statedPriceUnit({ enteredCases: 4, enteredBoxes: null }) === 'case', 'a case count means per case')
  ok(statedPriceUnit({ enteredCases: null, enteredBoxes: 3 }) === 'box', 'a box count means per box')
  ok(
    statedPriceUnit({ enteredCases: null, enteredBoxes: null }) === 'case',
    'and a line that says neither still reads as cases, which is what it was'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 14. entering the price afterwards ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "give me the ability in the streaming or finance to enter the price
 * … since we might not always know in the moment."
 *
 * A box gets broken on air with no invoice to hand and the line lands carrying
 * nothing. The P&L now PRINTS that hole instead of hiding it, and this is what
 * fills it in. What it must not do is the thing that would be easy and wrong:
 * treat a late price as a reason to go back and move stock.
 *
 * THE CONTRACT IT INHERITS. A reconciled line never consumed FIFO, never opened
 * a lot and never re-based the product's average, because the stock it describes
 * left the shelf weeks before anybody typed it. Everything in sections 2, 4 and
 * 11 rests on that. A cost arriving late changes what the STATEMENT says the
 * night cost and nothing else — the four assertions below are the whole of it,
 * and each names the thing that breaks if it is got wrong.
 */
{
  const LATE = mkSession('SR Priced Later', at(55, 20), at(55, 23))
  const before = {
    stock: stockQty(CASE_P, 'RM'),
    lots: lotState(CASE_P),
    avg: getProduct(CASE_P).unitCost,
    txn: txnState(CASE_P),
    gap: lotStockGap(CASE_P)
  }

  // A reconciliation entered at a price of NOTHING — one of the two supported
  // ways a real line reaches zero, and the one that produced the owner's report.
  const r = addItem(
    { sessionId: LATE, kind: 'break', productId: CASE_P, cases: 2, casePrice: 0, location: 'RM' },
    null
  )
  ok(r.ok, 'a past show can be reconciled at a price of nothing — the invoice is not to hand', r.error)
  const line = lastItem(LATE) as Record<string, number | string | null>
  ok(eq(line.costTotal as number, 0), 'so the line carries no cost at all')
  ok(line.statedCasePrice === 0, 'with the zero stored as the assertion it is, not as a null')

  const priced = setItemCost({ itemId: line.id as string, unitPrice: 2400 }, null)
  ok(priced.ok, 'and the price can be entered afterwards', priced.ok ? '' : priced.error)

  const after = lastItem(LATE) as Record<string, number | string | null>
  ok(eq(after.costTotal as number, 4800), 'two cases at $2,400 now cost the show $4,800', String(after.costTotal))
  ok(eq(after.unitCost as number, 2400), 'at $2,400 a stock unit', String(after.unitCost))
  ok(eq(after.statedCasePrice as number, 2400), 'and the stated price on the line is the one that was typed')

  console.log('\n--- and it moved nothing, exactly as the original entry moved nothing ---')
  // The four. Each of these is a different way a late price could quietly
  // corrupt the shelf, and none of them is allowed to happen.
  ok(stockQty(CASE_P, 'RM') === before.stock, 'ON-HAND STOCK is untouched — the cases went weeks ago')
  const lots = lotState(CASE_P)
  ok(
    lots.rows === before.lots.rows && lots.qty === before.lots.qty,
    'NO COST LAYER was consumed or opened',
    `${JSON.stringify(before.lots)} -> ${JSON.stringify(lots)}`
  )
  ok(eq(lots.value, before.lots.value), 'and the value carried on the layers on hand is unchanged')
  ok(
    itemLotRows(line.id as string) === 0,
    'the line still names no consumed layers, because it still consumed none'
  )
  ok(
    eq(getProduct(CASE_P).unitCost, before.avg),
    "the product's AVERAGE COST did not move — a price for stock nobody has must not re-base today's shelf",
    `${before.avg} -> ${getProduct(CASE_P).unitCost}`
  )
  ok(
    lotStockGap(CASE_P) === before.gap,
    'and it moved neither the shelf nor the layers — the distance between them is exactly what it was',
    `${before.gap} -> ${lotStockGap(CASE_P)}`
  )

  // The ledger records the correction rather than being edited, like everything
  // else in this app: one row for the difference, carrying no quantity.
  const txn = txnState(CASE_P)
  ok(txn.qty === before.txn.qty, 'the correcting ledger row carries a quantity change of zero')
  ok(eq(txn.cost, before.txn.cost + 4800), 'and the whole newly stated cost', String(txn.cost))

  // And it reverses to nothing, so a price typed onto the wrong line is as
  // undoable as the line itself always was.
  ok(removeItem(line.id as string, null).ok, 'the priced line removes')
  ok(stockQty(CASE_P, 'RM') === before.stock, 'still inventing no stock on the way out')
  ok(eq(txnState(CASE_P).cost, before.txn.cost), 'and the ledger nets back to where it started')
  ok(eq(getProduct(CASE_P).unitCost, before.avg), 'with the average cost where it started too')
  ok(lotStockGap(CASE_P) === before.gap, 'and the shelf and its layers are still exactly as far apart')
}

// ---------------------------------------------------------------------------
console.log('\n--- 14a. decimals, because a box can cost $1.25 ---')
// ---------------------------------------------------------------------------
{
  const DEC = mkSession('SR Decimals', at(56, 20), at(56, 23))
  // A quarter of a case AND a price with cents — the two decimals meet on one
  // line, which is where a rounding rule that only half works shows up.
  addItem(
    { sessionId: DEC, kind: 'break', productId: CASE_P, cases: 1.25, casePrice: 0, location: 'RM' },
    null
  )
  const frac = lastItem(DEC) as Record<string, number | string | null>
  ok(setItemCost({ itemId: frac.id as string, unitPrice: 1.33 }, null).ok, '1.33 a case is accepted')
  const fracAfter = lastItem(DEC) as Record<string, number | string | null>
  ok(eq(fracAfter.unitCost as number, 1.33), '1.33 comes back as 1.33, not 1.3 and not 1', String(fracAfter.unitCost))
  ok(
    eq(fracAfter.costTotal as number, 1.66),
    '1.25 x 1.33 books $1.66 — rounded once, at the cent',
    String(fracAfter.costTotal)
  )

  addItem(
    { sessionId: DEC, kind: 'break', productId: BOX_P, boxes: 4, casePrice: 0, location: 'RM' },
    null
  )
  const boxLine = lastItem(DEC) as Record<string, number | string | null>
  ok(setItemCost({ itemId: boxLine.id as string, unitPrice: 1.25 }, null).ok, '$1.25 a box is accepted')
  const boxAfter = lastItem(DEC) as Record<string, number | string | null>
  ok(eq(boxAfter.unitCost as number, 1.25), '1.25 round-trips exactly', String(boxAfter.unitCost))
  ok(eq(boxAfter.costTotal as number, 5), 'and four of them book $5.00', String(boxAfter.costTotal))
  ok(eq(boxAfter.statedCasePrice as number, 1.25), 'the stated price is per BOX, because that is what it is stocked in')

  // What it refuses, in the words the operator gets.
  const neg = setItemCost({ itemId: boxLine.id as string, unitPrice: -1 }, null)
  ok(!neg.ok && /less than nothing/.test(neg.error ?? ''), 'a negative price is refused', neg.error ?? 'accepted')
  const nan = setItemCost({ itemId: boxLine.id as string, unitPrice: Number.NaN }, null)
  ok(!nan.ok && /as a number/.test(nan.error ?? ''), 'and a NaN is refused rather than stored', nan.error ?? 'accepted')
  const gone = setItemCost({ itemId: 'no-such-line', unitPrice: 10 }, null)
  ok(!gone.ok && /no longer exists/.test(gone.error ?? ''), 'as is a line that is not there', gone.error ?? 'accepted')
  const still = lastItem(DEC) as Record<string, number | string | null>
  ok(eq(still.costTotal as number, 5), 'and none of the refusals changed the line they were aimed at')
}

// ---------------------------------------------------------------------------
console.log('\n--- 14b. a LIVE line: the record moves, the stock does not ---')
// ---------------------------------------------------------------------------
/**
 * The other way a line reaches zero: a product carried at a cost of nothing,
 * because "0 means don't track". This one DID consume FIFO — it is tonight's
 * show and the boxes came off the shelf — and the decision is that a late price
 * corrects what the STATEMENT says the night cost and leaves the cost layers
 * exactly where they are.
 *
 * The alternative was considered and rejected. Rewriting the layers now would
 * revalue stock that is already gone, move the product's average on the strength
 * of a price for stock nobody has, and cascade into every later line that
 * consumed the same lot. What is being corrected is a record, not a shelf.
 *
 * `stated_case_price` STAYING NULL is the load-bearing assertion here.
 * `restoreItemStock` reads that column to decide whether a removal hands stock
 * back; setting it on a live line would strand on the shelf the very boxes this
 * line really did take.
 */
{
  const ZERO_P = make({
    name: 'SR Untracked Hobby Box',
    unitType: 'box',
    boxesPerCase: null,
    cost: 0,
    open: 10
  })
  const before = {
    stock: stockQty(ZERO_P, 'RM'),
    avg: getProduct(ZERO_P).unitCost,
    lots: lotState(ZERO_P),
    txn: txnState(ZERO_P)
  }

  const live = addItem(
    { sessionId: TODAY, kind: 'break', productId: ZERO_P, boxes: 3, location: 'RM' },
    null
  )
  ok(live.ok, 'three boxes of an untracked product break on tonight\'s show', live.ok ? '' : live.error)
  const line = lastItem(TODAY) as Record<string, number | string | null>
  ok(eq(line.costTotal as number, 0), 'and cost the show nothing, because the product is carried at nothing')
  ok(line.statedCasePrice === null, 'it is a live line, so it states no price')
  ok(itemLotRows(line.id as string) === 1, 'and it DID consume a cost layer, unlike a reconciliation')
  const afterBreak = {
    stock: stockQty(ZERO_P, 'RM'),
    avg: getProduct(ZERO_P).unitCost,
    lots: lotState(ZERO_P)
  }
  ok(afterBreak.stock === before.stock - 3, 'the three boxes came off the shelf')

  ok(setItemCost({ itemId: line.id as string, unitPrice: 74.5 }, null).ok, 'the price arrives the next day')
  const after = lastItem(TODAY) as Record<string, number | string | null>
  ok(eq(after.costTotal as number, 223.5), '3 x $74.50 is now what the show carries', String(after.costTotal))
  ok(
    after.statedCasePrice === null,
    'and the line is STILL not a reconciliation — setting that would strand the stock it really took on removal'
  )

  ok(stockQty(ZERO_P, 'RM') === afterBreak.stock, 'the shelf did not move again')
  const lots = lotState(ZERO_P)
  ok(
    lots.rows === afterBreak.lots.rows && lots.qty === afterBreak.lots.qty && eq(lots.value, afterBreak.lots.value),
    'the cost layers were NOT revalued — they describe a shelf, and this describes a night',
    `${JSON.stringify(afterBreak.lots)} -> ${JSON.stringify(lots)}`
  )
  ok(eq(getProduct(ZERO_P).unitCost, afterBreak.avg), 'and the average cost was not re-based off it')
  ok(itemLotRows(line.id as string) === 1, 'the layer it consumed is still the layer it consumed')
  ok(lotStockGap(ZERO_P) === 0, 'stock and cost layers agree for it exactly')

  // The one thing that HAS to still work afterwards: this line is still a stock
  // movement, so removing it still gives the boxes back.
  ok(removeItem(line.id as string, null).ok, 'the priced live line removes')
  ok(stockQty(ZERO_P, 'RM') === before.stock, 'and its three boxes are back on the shelf')
  ok(eq(txnState(ZERO_P).cost, before.txn.cost), 'with the ledger netting back to the cent', String(txnState(ZERO_P).cost))
  ok(lotStockGap(ZERO_P) === 0, 'and it ends exactly consistent after all of it')
}

// ---------------------------------------------------------------------------
console.log('\n=== BREAKING A BOX OUT OF A CASE ===')
// ---------------------------------------------------------------------------
/**
 * THE MOST ORDINARY THING THIS BUSINESS DOES, and it used to be an error.
 *
 * The owner opened one whole case and one box out of the next, and the break
 * form refused: "1 loose box(es) is a part-case, and this product is not stocked
 * for fractional quantities. Enter whole cases, or mark it as a giveaway item."
 * Neither way out was true — a whole case says twelve boxes were opened when one
 * was, and the giveaway flag is a statement about promotional material.
 *
 * `boxesPerCase` is the divisibility statement. A product declaring a 12-box
 * case has said a box is a twelfth of it. What is pinned here is that the break
 * goes through, takes exactly the right stock, and reads back as cases and boxes
 * rather than as a decimal nobody can act on.
 */
const { breakToStock, caseBreakdown, describeQuantity } = require('../src/shared/units')
const CASE_UNITS = { unitType: 'case', boxesPerCase: 12, packsPerBox: null, giveawayItem: false }

// ---- the conversion --------------------------------------------------------
const oneAndOne = breakToStock(CASE_UNITS, 1, 1)
ok(oneAndOne.ok === true, 'ONE CASE PLUS ONE BOX IS ACCEPTED — it was refused outright before', String(!oneAndOne.ok && oneAndOne.error))
ok(
  oneAndOne.ok && Math.abs(oneAndOne.value.quantity - (1 + 1 / 12)) < 1e-9,
  'and converts to 1 + 1/12 cases, at full precision',
  oneAndOne.ok ? String(oneAndOne.value.quantity) : ''
)
ok(oneAndOne.ok && oneAndOne.value.fractional === true, 'flagged fractional, which is what the stock path keys its slack off')

// A whole number of cases is unchanged, and so is the one refusal worth keeping.
const whole = breakToStock(CASE_UNITS, 2, 0)
ok(whole.ok === true && whole.value.quantity === 2 && whole.value.fractional === false, 'two whole cases still convert plainly')
const noDivisor = breakToStock(
  { unitType: 'case', boxesPerCase: null, packsPerBox: null, giveawayItem: false },
  0,
  1
)
ok(
  noDivisor.ok === false,
  'A CASE WITH NO BOXES-PER-CASE STILL REFUSES — without the divisor the fraction cannot be computed at all'
)
ok(
  (!noDivisor.ok ? noDivisor.error : '').includes('boxes-per-case'),
  'and says which field to set rather than blaming the operator',
  !noDivisor.ok ? noDivisor.error : ''
)

// ---- reading the shelf back ------------------------------------------------
/**
 * A stored balance is re-rounded to four places, so 47 boxes of a 12-box case is
 * 3.9167 and not 3.916666… The breakdown rounds to the nearest BOX, which is what
 * makes both readings land on 47. Flooring would report 46 and lose a real box.
 */
const split = caseBreakdown(CASE_UNITS, 3.9167)
ok(!!split, 'a part-case balance can be read back')
ok(split.fullCases === 3, 'three cases are still sealed', String(split?.fullCases))
ok(split.looseBoxes === 11, 'AND ELEVEN BOXES ARE LEFT IN THE OPEN ONE', String(split?.looseBoxes))
ok(split.open === true, 'which is what marks the case as cracked')
ok(split.totalBoxes === 47, 'forty-seven boxes in the room', String(split?.totalBoxes))

/**
 * THE LAST BOX OF AN OPEN CASE, and the reason this rounds rather than floors.
 *
 * One box of a 12-box case is 1/12 = 0.08333…, stored at four places as 0.0833.
 * Multiplied back out that is 0.9996 — just UNDER a whole box. Flooring reports
 * zero and the box vanishes from the shelf reading while it is still physically
 * on it and still carrying its cost; rounding lands on the one box that is
 * really there. The same shortfall exists on every divisor where 1/N rounds
 * down, which is most of them.
 */
ok(
  caseBreakdown(CASE_UNITS, 0.0833)?.looseBoxes === 1,
  'A SINGLE REMAINING BOX IS STILL ONE BOX — its stored balance is a hair under, and flooring would lose it',
  String(caseBreakdown(CASE_UNITS, 0.0833)?.looseBoxes)
)
ok(caseBreakdown(CASE_UNITS, 0.0833)?.fullCases === 0, 'with no sealed cases behind it')
ok(
  caseBreakdown({ unitType: 'case', boxesPerCase: 3, packsPerBox: null, giveawayItem: false }, 0.3333)
    ?.looseBoxes === 1,
  'and the same on a 3-box case, where the shortfall is larger'
)

ok(caseBreakdown(CASE_UNITS, 4)?.open === false, 'four sealed cases are not open')
ok(caseBreakdown(CASE_UNITS, 0)?.totalBoxes === 0, 'and an empty shelf reads as no boxes')
ok(
  caseBreakdown({ unitType: 'box', boxesPerCase: 8, packsPerBox: null, giveawayItem: false }, 3) === null,
  'a BOX-stocked product has nothing to split — the reading would be an invention'
)
ok(
  caseBreakdown({ unitType: 'case', boxesPerCase: null, packsPerBox: null, giveawayItem: false }, 3.5) === null,
  'and neither has one with no divisor'
)
/**
 * A giveaway item holding two thirds of a box has no honest reading as a number
 * of boxes, so it gets none and the caller falls back to the decimal. Returning
 * "0 boxes" would say the shelf is empty when it is not.
 */
ok(
  caseBreakdown({ unitType: 'case', boxesPerCase: 12, packsPerBox: 4, giveawayItem: true }, 3.9722) === null,
  'a balance that is not a whole number of boxes refuses to be split'
)

ok(
  describeQuantity(CASE_UNITS, 3.9167) === '3 cases + 11 boxes',
  'THE SHELF READS AS CASES AND BOXES, not as 3.9167',
  describeQuantity(CASE_UNITS, 3.9167)
)
ok(describeQuantity(CASE_UNITS, 4) === '4 cases', 'a whole shelf still reads whole')
ok(
  describeQuantity(CASE_UNITS, 1 / 12) === '11 boxes' || describeQuantity(CASE_UNITS, 11 / 12) === '11 boxes',
  'and one open case with no sealed ones behind it drops the "0 cases"',
  describeQuantity(CASE_UNITS, 11 / 12)
)

// ---- and it actually moves the stock ---------------------------------------
/**
 * The end of the owner's sentence: five cases on the shelf, open one whole case
 * and one box out of the next, and thirty-five boxes plus eleven are left.
 */
/**
 * A FRESH product, deliberately. CASE_P has been through the reconciliation
 * sections above, which leave stock and cost layers legitimately apart — a
 * reconciliation describes a night and not a shelf, so it moves one and not the
 * other. Measuring lot consistency against that would be measuring their history
 * rather than this break.
 */
const PART_P = make({
  name: 'SR Part Case Hobby 12-Box Case',
  unitType: 'case',
  boxesPerCase: 12,
  cost: 1200,
  open: 5
})
const shelfBefore = stockQty(PART_P, 'RM')
const gapBefore = lotStockGap(PART_P)
ok(shelfBefore === 5, 'five sealed cases to start', String(shelfBefore))
ok(gapBefore === 0, 'with stock and cost layers in step', String(gapBefore))
const broke = addItem(
  { sessionId: TODAY, kind: 'break', productId: PART_P, cases: 1, boxes: 1, location: 'RM' },
  null
)
ok(broke.ok === true, 'the break records', String(!broke.ok && broke.error))
const shelfAfter = stockQty(PART_P, 'RM')
ok(
  Math.abs(shelfBefore - shelfAfter - (1 + 1 / 12)) < 1e-3,
  'THIRTEEN BOXES CAME OFF THE SHELF — one case and one box, not two cases',
  `${shelfBefore} -> ${shelfAfter}`
)
const left = caseBreakdown(CASE_UNITS, shelfAfter)
ok(
  left?.fullCases === 3 && left?.looseBoxes === 11,
  'AND THE SHELF READS 3 SEALED CASES AND 11 BOXES IN THE OPEN ONE',
  JSON.stringify(left)
)
ok(left?.totalBoxes === 47, 'forty-seven boxes left in the room', String(left?.totalBoxes))
ok(
  lotStockGap(PART_P) === 0,
  'STOCK AND THE COST LAYERS STILL AGREE EXACTLY — a part-case break must not leave dust behind',
  String(lotStockGap(PART_P))
)

// Putting it back is the same rule in reverse — a part-case must not strand.
const partLine = db
  .prepare(`SELECT id FROM stream_items WHERE product_id = ? ORDER BY rowid DESC LIMIT 1`)
  .get(PART_P) as { id: string } | undefined
ok(!!partLine, 'the break left a line to remove')
ok(removeItem(partLine?.id as string, null).ok, 'the part-case line removes')
ok(
  Math.abs(stockQty(PART_P, 'RM') - shelfBefore) < 1e-3,
  'and every one of the thirteen boxes goes back',
  `${stockQty(PART_P, 'RM')} vs ${shelfBefore}`
)
ok(lotStockGap(PART_P) === 0, 'with the layers exactly consistent again', String(lotStockGap(PART_P)))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
