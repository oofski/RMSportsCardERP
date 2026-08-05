/**
 * What Whatnot already took, and what the app says it took.
 *
 * THE BUG THIS FILE PINS. The ledger's `Amount` column is NET — Whatnot deducts
 * its cut before it writes the row, and the file contains no fee line anywhere.
 * The app read that figure as GROSS and subtracted 8.9% from it a second time.
 * On one ten-day export that understated revenue by about $35,000 and reported a
 * fee that had already been taken; every Whatnot P&L the owner had ever seen
 * carried it.
 *
 * THE MODEL, in the owner's own order and with the owner's own rounding:
 *
 *     commission = round(item × commissionRate)
 *     tax        = round((item + shipping) × taxRate)
 *     orderTotal = item + shipping + tax
 *     processing = round(orderTotal × processingRate + processingFlat)
 *     payout     = item + shipping − commission − processing
 *
 * Two fees on two different bases, each rounded to the cent as it is computed,
 * and a sales tax that touches the payout line nowhere. The ledger gives the
 * payout; the app recovers the item price, and the test that matters most is
 * that the recovered price, run FORWARD, reproduces the payout exactly.
 *
 * SECTION 6 RUNS AGAINST THE OWNER'S REAL EXPORTS and is the only part of this
 * file that cannot run everywhere: a Whatnot ledger holds order ids and a Stripe
 * account reference, and this repository is public, so the files are not in it.
 * Point RM_LEDGER_DIR at a folder of them to run it:
 *
 *     RM_LEDGER_DIR=/path/to/exports npm run test:fees
 *
 * Without it that section reports itself as skipped rather than passing quietly,
 * because "no real ledger was checked" and "the real ledger checks out" must
 * never read the same on a console.
 *
 * Run: npm run test:fees
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/whatnot-fees-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const { addItem, createSession } = require('../src/main/db/streaming')
const { createProduct } = require('../src/main/db/inventory')
const { importLedger, streamingFinanceView, reattributeAll } = require('../src/main/db/financeStreaming')
const { deleteExpense, listExpenses, saveExpense } = require('../src/main/db/financeExpenses')
const {
  deleteRatePeriod,
  listRatePeriods,
  rateForDate,
  saveRatePeriod
} = require('../src/main/db/whatnotRates')
const {
  DEFAULT_COMMISSION_RATE,
  DEFAULT_FEE_RATES,
  DEFAULT_PROCESSING_FLAT_CENTS,
  DEFAULT_PROCESSING_RATE,
  DEFAULT_TAX_RATE,
  buildPnl,
  computeFees,
  deriveSaleFee,
  effectiveFeeRates,
  itemPriceFromPayout,
  mergeCogsItems,
  mergeRateSlices,
  overlappingRatePeriod,
  parseLedgerAmount,
  pnlChecksum,
  ratePct,
  resolveFeeRates,
  sumDayFinance,
  validateRatePeriod,
  whatnotOrder
} = require('../src/shared/financeStreaming')
const { streamDateOf } = require('../src/shared/streaming')

const db = getDb()

let pass = 0
let fail = 0
let skipped = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`)
  }
}
const skip = (n: string): void => {
  skipped++
  console.log('  SKIP ' + n)
}
const cents = (n: number): number => Math.round(n * 100)

// ---------------------------------------------------------------------------
console.log('=== 1. the owner\'s worked example: a $1.00 bid pays out $0.59 ===')
// ---------------------------------------------------------------------------
// THE ANCHOR FOR THE WHOLE MODEL, and it comes off the owner's real ledger: the
// smallest positive payout in the 19–28 July export is $0.59, and it is a $1.00
// opening bid. Every intermediate is asserted, not just the answer, because the
// answer alone would still pass under a model that rounded once at the end or
// charged the card fee on the wrong base — it is the intermediates that pin the
// order the owner specified.
{
  const o = whatnotOrder(100, DEFAULT_FEE_RATES)
  ok(o.commissionCents === 8, '8% of $1.00 is 8c', String(o.commissionCents))
  ok(o.taxCents === 5, '5.18% tax on $1.00 is 5.18c, rounded to 5c', String(o.taxCents))
  ok(o.orderTotalCents === 105, 'so the order total is $1.05', String(o.orderTotalCents))
  // 105 x 0.029 = 3.045, + 30 = 33.045 -> 33. Rounded HERE, on the order total,
  // not on the sale price: 100 x 0.029 + 30 = 32.9 -> 33 happens to agree at
  // this size and does not at others, which is why the base is asserted through
  // the total rather than through the fee alone.
  ok(o.processingCents === 33, 'processing is 2.9% of $1.05 plus 30c = 33c', String(o.processingCents))
  ok(o.payoutCents === 59, 'leaving a payout of exactly 59c', String(o.payoutCents))
  // AND THE TAX IS NOT IN IT. 100 - 8 - 33 = 59, with the 5c nowhere: the buyer
  // paid $1.05 and the state gets the nickel.
  ok(
    o.payoutCents === o.itemCents - o.commissionCents - o.processingCents,
    'the payout is the item less the two fees, with the tax nowhere in it'
  )

  // And back the other way, which is the direction the app actually runs.
  const back = itemPriceFromPayout(59, DEFAULT_FEE_RATES)
  ok(back.itemCents === 100, 'and $0.59 inverts to exactly $1.00 — a real opening bid', String(back.itemCents))
  ok(back.missCents === 0, 'with nothing left over')

  const fee = deriveSaleFee(59, DEFAULT_FEE_RATES)
  ok(fee.grossCents === 100, 'the sale row reports a $1.00 gross', String(fee.grossCents))
  ok(fee.whatnotFeeCents === -8 && fee.processingFeeCents === -33, 'and the two fees that took it there')
  ok(fee.taxCents === 5, 'the tax rides along as a memo', String(fee.taxCents))
  ok(fee.exact, 'and the payout was reproduced exactly, not approached')
}

// ---------------------------------------------------------------------------
console.log('\n=== 1b. forward and inverse agree, everywhere ===')
// ---------------------------------------------------------------------------
// A PROPERTY, NOT THREE EXAMPLES. Three worked cases prove three cases; what has
// to be true is that for EVERY item price at EVERY set of terms the app accepts,
// pricing it forward and inverting the payout lands back on a price whose
// forward payout is the same to the cent. Anything less and some spot somewhere
// reports a gross nobody paid.
const RATE_SETS = [
  DEFAULT_FEE_RATES,
  { commissionRate: 0.08, taxRate: 0.0518, processingRate: 0.029, processingFlatCents: 30, shippingCents: 0 },
  { commissionRate: 0.06, taxRate: 0.0518, processingRate: 0.029, processingFlatCents: 30, shippingCents: 0 },
  { commissionRate: 0.04, taxRate: 0.07, processingRate: 0.035, processingFlatCents: 49, shippingCents: 0 },
  { commissionRate: 0.05, taxRate: 0, processingRate: 0.029, processingFlatCents: 30, shippingCents: 0 },
  { commissionRate: 0, taxRate: 0.0625, processingRate: 0.029, processingFlatCents: 0, shippingCents: 0 },
  { commissionRate: 0.5, taxRate: 0.25, processingRate: 0.25, processingFlatCents: 500, shippingCents: 0 },
  // Shipping is zero on every ledger-derived row, so it gets its own sets rather
  // than being left untested: the model carries the term and a future import
  // will use it.
  { commissionRate: 0.08, taxRate: 0.0518, processingRate: 0.029, processingFlatCents: 30, shippingCents: 499 },
  { commissionRate: 0.08, taxRate: 0.0518, processingRate: 0.029, processingFlatCents: 30, shippingCents: 1275 }
]

let sweep = 0
let roundTripFail: string | null = null
let identityFail: string | null = null
let inexact = 0
for (const rates of RATE_SETS) {
  // Every cent from 1c to $12, then a spread through the sizes real spots and
  // whole boxes actually sell at.
  const items: number[] = []
  for (let c = 1; c <= 1200; c++) items.push(c)
  for (let c = 1201; c <= 50000; c += 37) items.push(c)
  for (const extra of [123456, 250000, 999999]) items.push(extra)

  for (const item of items) {
    sweep += 1
    const fwd = whatnotOrder(item, rates)
    if (fwd.payoutCents <= 0) continue
    const back = itemPriceFromPayout(fwd.payoutCents, rates)
    if (back.itemCents === null) {
      inexact += 1
      if (!roundTripFail) roundTripFail = `payout ${fwd.payoutCents} from item ${item} did not invert`
      continue
    }
    // NOT "the same item price" — the same PAYOUT. A cent more on the bid moves
    // the payout by about 0.89c, so roughly one payout in nine is produced by
    // two adjacent bids and the inverse cannot know which of them happened. What
    // it must never do is return one that produces a different payout.
    const again = whatnotOrder(back.itemCents, rates)
    if (again.payoutCents !== fwd.payoutCents && !roundTripFail) {
      roundTripFail = `item ${item} -> payout ${fwd.payoutCents} -> item ${back.itemCents} -> payout ${again.payoutCents}`
    }
    const fee = deriveSaleFee(fwd.payoutCents, rates)
    if (fee.grossCents + fee.whatnotFeeCents + fee.processingFeeCents !== fwd.payoutCents) {
      if (!identityFail) {
        identityFail = `payout ${fwd.payoutCents}: gross ${fee.grossCents}, fees ${fee.whatnotFeeCents}/${fee.processingFeeCents}`
      }
    }
    // The gross IS the recovered bid plus what the buyer paid for postage —
    // never the tax, which is where a wrong model would quietly add 5%.
    if (fee.exact && fee.grossCents !== back.itemCents + rates.shippingCents && !identityFail) {
      identityFail = `payout ${fwd.payoutCents}: gross ${fee.grossCents} is not item ${back.itemCents} + shipping ${rates.shippingCents}`
    }
  }
}
ok(roundTripFail === null, `${sweep.toLocaleString()} item prices x ${RATE_SETS.length} rate sets round-trip to the cent`, roundTripFail ?? '')
ok(identityFail === null, 'and gross less fees is the payout on every one of them', identityFail ?? '')
ok(inexact === 0, 'every payout the model can produce, it can also invert', String(inexact))

// EACH FEE IS ITS OWN RATE, not a residual absorbing the rounding. Half a cent
// each is the most the rounding can move them, and that is what makes a fee line
// checkable against a Whatnot statement.
{
  let worst = 0
  for (const rates of RATE_SETS) {
    for (let item = 1; item <= 30000; item += 7) {
      const o = whatnotOrder(item, rates)
      worst = Math.max(
        worst,
        Math.abs(o.commissionCents - item * rates.commissionRate),
        Math.abs(o.processingCents - (o.orderTotalCents * rates.processingRate + rates.processingFlatCents))
      )
    }
  }
  ok(worst <= 0.5, 'each fee stays within half a cent of its own rate on its own base', String(worst))
}

// ---------------------------------------------------------------------------
console.log('\n=== 1c. the ROUNDING ORDER is part of the model ===')
// ---------------------------------------------------------------------------
// The owner was explicit: round each fee to the cent as it is computed, in that
// order. This pins it, because the alternative — carry full precision and round
// once at the end — is an easy "simplification" that agrees on most rows and
// disagrees on real money at volume.
{
  let differs = 0
  for (let item = 1; item <= 5000; item++) {
    const stepwise = whatnotOrder(item, DEFAULT_FEE_RATES).payoutCents
    const t = item * DEFAULT_TAX_RATE
    const once = Math.round(
      item -
        item * DEFAULT_COMMISSION_RATE -
        ((item + t) * DEFAULT_PROCESSING_RATE + DEFAULT_PROCESSING_FLAT_CENTS)
    )
    if (stepwise !== once) differs += 1
  }
  ok(differs > 0, `rounding once at the end disagrees on ${differs} of 5,000 bids`, String(differs))
  // The tax is rounded BEFORE it feeds the order total, which is what makes the
  // $1.00 case land on 33c: 105 x 0.029, not 105.18 x 0.029.
  const unrounded = Math.round((100 + 100 * DEFAULT_TAX_RATE) * DEFAULT_PROCESSING_RATE + 30)
  ok(
    whatnotOrder(100, DEFAULT_FEE_RATES).processingCents === 33 && unrounded === 33,
    'and the tax is rounded before it feeds the order total'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 1d. a payout the model cannot produce says so ===')
// ---------------------------------------------------------------------------
// A silently wrong item price becomes a wrong gross on every screen, so the
// inverse returns null rather than the nearest plausible bid.
//
// WHY THIS IS HARD TO PROVOKE, which is worth knowing before somebody decides
// the branch is dead code. One cent more on a bid moves the payout by 0, 1 or
// -1 cents and never by 2, so the payouts the model can produce have no holes
// in them: within its range, every whole cent is somebody's bid. The case that
// remains is a payout BELOW that range — smaller than the flat card charge takes
// on its own — which no bid can produce because a bid cannot be negative.
{
  const found = itemPriceFromPayout(-1000, DEFAULT_FEE_RATES)
  ok(found.itemCents === null, 'an unreachable payout inverts to null, not to a guess', String(found.itemCents))
  ok(found.missCents !== 0, 'while still reporting how far off the closest bid is', JSON.stringify(found))
  ok(found.nearestCents >= 0, 'and the closest bid it names is not a negative price', String(found.nearestCents))

  // No hole in the reachable range, asserted rather than argued: every payout
  // from the smallest positive one up through $500 inverts to a real bid.
  let holes = 0
  for (let payout = 1; payout <= 50000; payout++) {
    if (itemPriceFromPayout(payout, DEFAULT_FEE_RATES).itemCents === null) holes += 1
  }
  ok(holes === 0, 'and every payout from 1c to $500 is somebody\'s bid', String(holes))

  // A flagged row still has to reconcile. `deriveSaleFee` reaches this only for a
  // positive payout, so it is provoked here through the contract's own guard:
  // whatever the inverse says, gross less fees is the payout.
  const fee = deriveSaleFee(59, DEFAULT_FEE_RATES)
  ok(
    fee.grossCents + fee.whatnotFeeCents + fee.processingFeeCents === 59,
    'and gross less fees is the payout however the inversion went',
    JSON.stringify(fee)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. a refund and a $0.00 row are not purchases ===')
// ---------------------------------------------------------------------------
for (const net of [-46747, -415, -1, 0]) {
  const f = deriveSaleFee(net, DEFAULT_FEE_RATES)
  ok(
    f.grossCents === net && f.whatnotFeeCents === 0 && f.processingFeeCents === 0,
    `${net}c passes through at face value with no fee and no flat charge`,
    JSON.stringify(f)
  )
  ok(f.taxCents === 0, '  and carries no tax either', String(f.taxCents))
}
// Specifically the flat charge: applying it to a refund would invent a cost AND
// get its sign wrong, which is the failure mode this rule exists for.
ok(
  deriveSaleFee(-500, DEFAULT_FEE_RATES).processingFeeCents === 0,
  'a refund is never charged the flat card fee'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2b. tax is passed through, and is in no total ===')
// ---------------------------------------------------------------------------
// The one thing the owner was most explicit about. The tax appears in the model
// because the card fee is charged on a total containing it, and NOWHERE ELSE.
{
  const rows = [1248, 700, 14319, 1999, 6150].map((c) => ({ netCents: c, rates: DEFAULT_FEE_RATES }))
  const f = computeFees(rows)
  ok(f.salesTax > 0, 'the tax is reported as its own memo figure', String(f.salesTax))
  ok(
    cents(f.grossSales) + cents(f.totalFees) === cents(f.netSales),
    'and gross less fees is the net, with the tax in neither',
    `${f.grossSales} + ${f.totalFees} vs ${f.netSales}`
  )
  ok(f.unresolvedCount === 0, 'every row was reproduced exactly', String(f.unresolvedCount))
  // Raising the tax rate raises the processing fee (its base grew) and therefore
  // the derived gross — but it never appears AS revenue, and the net Whatnot
  // paid is untouched because that is a stored fact.
  const taxed = computeFees(
    rows.map((r) => ({ ...r, rates: { ...DEFAULT_FEE_RATES, taxRate: 0.1 } }))
  )
  ok(cents(taxed.netSales) === cents(f.netSales), 'a tax change never moves the net Whatnot paid')
  ok(taxed.salesTax > f.salesTax, 'it moves the tax the buyers paid', `${taxed.salesTax} vs ${f.salesTax}`)
  ok(
    Math.abs(taxed.processingFee) >= Math.abs(f.processingFee),
    'and the processing fee charged on it',
    `${taxed.processingFee} vs ${f.processingFee}`
  )
  ok(
    cents(taxed.grossSales) + cents(taxed.totalFees) === cents(taxed.netSales),
    'with the identity still exact at the new rate'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. a real import: per row and per day agree exactly ===')
// ---------------------------------------------------------------------------

/** "Jul 20, 2026, 8:15:00 PM" — the shape Whatnot writes, non-padded. */
function whatnotDate(d: Date): string {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ` +
    `${h}:${p(d.getMinutes())}:${p(d.getSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`
  )
}

/** Local instants, so the business day is the one this test means wherever it runs. */
const at = (day: number, hour: number, minute = 0, second = 0): Date =>
  new Date(2026, 6, day, hour, minute, second)

const money = (dollars: number): string =>
  dollars < 0 ? `($${Math.abs(dollars).toFixed(2)})` : `$${dollars.toFixed(2)}`

interface Line {
  when: Date
  amount: number
  message: string
  type: string
  order?: string
}

let orderSeq = 0
function csvOf(lines: Line[]): string {
  const head =
    'Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date'
  const body = lines.map((l) => {
    const order = l.order ?? `ORD${++orderSeq}`
    return [
      `"${whatnotDate(l.when)}"`,
      money(l.amount),
      '2041799396',
      order,
      l.message,
      'completed',
      l.type,
      `"${whatnotDate(l.when)}"`
    ].join(',')
  })
  return [head, ...body].join('\r\n') + '\r\n'
}

const spotMsg = (n: number, team: string): string =>
  `Earnings for selling a 1x 2026 FINEST BASEBALL HOBBY BOX- Break #${n} - ${team}`

// Two shows, two nights, one of them running past midnight — so the business-day
// rule and the fee derivation are exercised together rather than in isolation.
const s1 = createSession(
  { title: 'Mon night', startedAt: at(20, 19).toISOString(), endedAt: at(21, 1).toISOString() },
  null
)
const s2 = createSession(
  { title: 'Tue night', startedAt: at(21, 19).toISOString(), endedAt: at(21, 23).toISOString() },
  null
)
ok(s1.ok && s2.ok, 'two shows logged', JSON.stringify([s1.error, s2.error]))

// A show that is a real mix: ordinary spots, a spot that settled after midnight,
// a giveaway postage deduction, a $0.00 subsidy, a tip, a bonus and a payout.
const NIGHT_ONE: Line[] = [
  { when: at(20, 20, 1), amount: 12.48, message: spotMsg(3, 'Boston Red Sox'), type: 'SALES' },
  { when: at(20, 20, 2), amount: 7.0, message: spotMsg(3, 'New York Yankees'), type: 'SALES' },
  { when: at(20, 22, 30), amount: 143.19, message: spotMsg(4, 'Los Angeles Dodgers'), type: 'SALES' },
  // After midnight, still the Monday show's money.
  { when: at(21, 0, 12), amount: 19.99, message: spotMsg(5, 'Chicago Cubs'), type: 'SALES' },
  {
    when: at(21, 0, 20),
    amount: 61.5,
    message: 'Earnings for selling a 2025 Topps Inception Baseball Hobby Box',
    type: 'SALES'
  },
  {
    when: at(20, 23, 5),
    amount: -4.35,
    message: 'Charged deduction of $4.35 for giveaway order aLhPjeFE4Fgceq',
    type: 'SALES'
  },
  { when: at(20, 23, 6), amount: 0, message: 'Shipping Subsidy', type: 'ADJUSTMENT' },
  { when: at(20, 23, 7), amount: 3.75, message: 'Shipping Subsidy', type: 'ADJUSTMENT' },
  { when: at(20, 21, 0), amount: 25, message: 'Tip from viewer', type: 'TIP' },
  { when: at(20, 21, 1), amount: 40, message: 'Super Seller Bonus', type: 'ADJUSTMENT' }
]
const NIGHT_TWO: Line[] = [
  { when: at(21, 20, 0), amount: 5.0, message: spotMsg(1, 'Detroit Tigers'), type: 'SALES' },
  { when: at(21, 20, 1), amount: 5.0, message: spotMsg(1, 'Detroit Tigers'), type: 'SALES' },
  { when: at(21, 20, 2), amount: 250.0, message: spotMsg(2, 'Philadelphia Phillies'), type: 'SALES' },
  { when: at(21, 21, 0), amount: -50.0, message: 'Seller purchased Show Boost for the show', type: 'ADJUSTMENT' }
]

const csvPath = join(DIR, 'ledger.csv')
writeFileSync(csvPath, csvOf([...NIGHT_ONE, ...NIGHT_TWO]), 'utf8')
const imported = importLedger(csvPath, null)
ok(imported.ok, 'the ledger imported', imported.ok ? '' : imported.error)

let view = streamingFinanceView()
ok(view.reconciled, 'and the view reconciles', String(view.reconcileNote))
ok(view.days.length === 2, 'two business days', String(view.days.length))

const day20 = view.days.find((d: any) => d.streamDate === streamDateOf(at(20, 19).toISOString()))
const day21 = view.days.find((d: any) => d.streamDate === streamDateOf(at(21, 19).toISOString()))
ok(!!day20 && !!day21, 'both days are present')

/**
 * The day's fee figures, recomputed HERE from the stored rows.
 *
 * Deliberately a second, independent aggregation: `buildView` walks the rows and
 * accumulates onto days, this walks the rows and accumulates in a Map. They
 * share `deriveSaleFee` — which is the point, there is one derivation — but not
 * the summing, so a day that dropped a row or double-counted one shows up here.
 */
function feesFromRows(
  streamDate: string,
  rate: (day: string) => Record<string, number>,
  /** Which date to ask `rate` about. The BUSINESS day is what the app uses; the
   *  row's own calendar date is the rule this file's section 8 pins as wrong. */
  by: 'business' | 'calendar' = 'business'
): {
  netCents: number
  grossCents: number
  whatnotCents: number
  processingCents: number
  charged: number
} {
  const rows = db
    .prepare(
      `SELECT occurred_at AS at, CAST(ROUND(amount * 100) AS INTEGER) AS c
         FROM ledger_rows
        WHERE stream_date = ? AND bucket IN ('sale', 'product_sale')
          AND (session_id IS NOT NULL OR attribution = 'own_day')`
    )
    .all(streamDate) as Array<{ at: string; c: number }>
  const out = { netCents: 0, grossCents: 0, whatnotCents: 0, processingCents: 0, charged: 0 }
  for (const r of rows) {
    const f = deriveSaleFee(r.c, rate(by === 'business' ? streamDate : streamDateOf(r.at)))
    out.netCents += f.netCents
    out.grossCents += f.grossCents
    out.whatnotCents += f.whatnotFeeCents
    out.processingCents += f.processingFeeCents
    if (f.whatnotFeeCents !== 0 || f.processingFeeCents !== 0) out.charged += 1
  }
  return out
}

/** The terms with one number changed — every call site below wants the defaults
 *  with a different commission, and spelling out four fields each time would
 *  bury which one the test is actually about. */
const withCommission = (commissionRate: number): Record<string, number> => ({
  ...DEFAULT_FEE_RATES,
  commissionRate
})
const atDefault = (): Record<string, number> => DEFAULT_FEE_RATES
for (const day of [day20, day21]) {
  const mine = feesFromRows(day.streamDate, atDefault)
  ok(cents(day.netSales) === mine.netCents, `${day.streamDate}: net sales agree`, `${day.netSales}`)
  ok(cents(day.grossSales) === mine.grossCents, '  gross agrees row by row', String(day.grossSales))
  ok(cents(day.whatnotFee) === mine.whatnotCents, "  Whatnot's cut agrees", String(day.whatnotFee))
  ok(cents(day.processingFee) === mine.processingCents, '  card processing agrees', String(day.processingFee))
  ok(day.feeSaleCount === mine.charged, '  and so does the charged count', String(day.feeSaleCount))
  // THE IDENTITY. Everything above can agree and this can still be wrong, so it
  // is asserted on its own: the derived gross must fall back to the ledger's own
  // net when the derived fees come off it.
  ok(
    cents(day.grossSales) + cents(day.totalFees) === cents(day.netSales),
    '  and gross less fees IS the net Whatnot paid',
    `${day.grossSales} + ${day.totalFees} vs ${day.netSales}`
  )
}

// The money that is not a sale arrives whole — no fee, no gross-up, unchanged
// from before this rewrite.
ok(day20.tips === 25, 'a tip arrives whole', String(day20.tips))
ok(day20.bonuses === 40, 'a seller bonus arrives whole', String(day20.bonuses))
ok(day20.shippingSubsidy === 3.75, 'a shipping subsidy arrives whole', String(day20.shippingSubsidy))
ok(day20.giveawayShipping === -4.35, 'giveaway postage is untouched', String(day20.giveawayShipping))
ok(day21.showBoost === -50, 'a Show Boost is untouched', String(day21.showBoost))
// And none of them is inside the fee base.
ok(
  cents(day20.netSales) === cents(12.48 + 7 + 143.19 + 19.99 + 61.5),
  'only sale rows are in the fee base',
  String(day20.netSales)
)

// The period rollups are sums of the days, so they cannot disagree with them.
const totalGross = cents(day20.grossSales) + cents(day21.grossSales)
ok(cents(view.totals.grossSales) === totalGross, 'all-time gross is the sum of the days')
ok(
  cents(view.totals.grossSales) + cents(view.totals.totalFees) === cents(view.totals.netSales),
  'and the identity survives the rollup',
  `${view.totals.grossSales} + ${view.totals.totalFees}`
)
const week = view.weeks[0]
ok(
  cents(week.grossSales) + cents(week.totalFees) === cents(week.netSales),
  'as it does on the week'
)

// The whole point, in one line: the old model reported the net as revenue and
// then took 8.9% off it. The new one reports MORE revenue and a fee that was
// genuinely taken.
const oldWayRevenue = cents(day20.netSales)
ok(
  cents(day20.grossSales) > oldWayRevenue,
  'the corrected day reports MORE revenue than the ledger figure',
  `${day20.grossSales} vs ${day20.netSales}`
)
ok(
  cents(day20.netRevenue) === cents(day20.netSales) + cents(day20.tips) + cents(day20.bonuses),
  'while what was actually received is unchanged',
  String(day20.netRevenue)
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. the default rate, and a date range that overrides it ===')
// ---------------------------------------------------------------------------
ok(listRatePeriods().length === 0, 'nothing is configured out of the box')
const outOfBox = rateForDate('2020-01-01')
ok(outOfBox.commissionRate === 0.08, 'so every day is 8% commission', String(outOfBox.commissionRate))
ok(outOfBox.taxRate === 0.0518, 'at 5.18% tax', String(outOfBox.taxRate))
ok(
  outOfBox.processingRate === 0.029 && outOfBox.processingFlatCents === 30,
  'and 2.9% + 30c card processing',
  JSON.stringify(outOfBox)
)
ok(outOfBox.shippingCents === 0, 'with no shipping inside the sale row — it rides as its own ADJUSTMENT rows')
ok(
  effectiveFeeRates([], '2099-12-31').commissionRate === DEFAULT_COMMISSION_RATE,
  'including days far ahead'
)

const beforeGross = day20.grossSales
const beforeNet = day20.netSales
const savedPeriod = saveRatePeriod(
  {
    fromDate: '2026-07-01',
    toDate: '2026-07-31',
    rate: 0.1,
    taxRate: DEFAULT_TAX_RATE,
    processingRate: DEFAULT_PROCESSING_RATE,
    processingFlatCents: DEFAULT_PROCESSING_FLAT_CENTS,
    note: 'July renegotiation'
  },
  null
)
ok(savedPeriod.ok, 'a 10% July is saved', savedPeriod.ok ? '' : savedPeriod.error)
ok(rateForDate('2026-07-20').commissionRate === 0.1, 'and July now reads 10%', String(rateForDate('2026-07-20').commissionRate))
ok(rateForDate('2026-08-01').commissionRate === 0.08, 'while August falls back to the default')

// AN INPUT FROM A RENDERER THAT PREDATES THE OTHER THREE TERMS. It must not be
// refused — that would leave an old screen unable to save anything — and it must
// not book NaN. It takes the defaults, which is exactly what the app charged
// before those columns existed.
{
  const oldShaped = saveRatePeriod(
    { fromDate: '2027-01-01', toDate: '2027-01-31', rate: 0.07, note: 'old renderer' } as never,
    null
  )
  ok(oldShaped.ok, 'a save with only a commission is accepted', oldShaped.ok ? '' : oldShaped.error)
  const jan = rateForDate('2027-01-15')
  ok(jan.commissionRate === 0.07, 'the commission it sent is stored', String(jan.commissionRate))
  ok(
    jan.taxRate === DEFAULT_TAX_RATE &&
      jan.processingRate === DEFAULT_PROCESSING_RATE &&
      jan.processingFlatCents === DEFAULT_PROCESSING_FLAT_CENTS,
    'and the three it did not send take the defaults',
    JSON.stringify(jan)
  )
  const stored = listRatePeriods().find((p: any) => p.note === 'old renderer')
  ok(deleteRatePeriod(stored.id).ok, 'tidied away again')
}

// NOTHING WAS RE-IMPORTED. The fee is derived on read, so re-reading the view is
// the whole of the update path — this is the assertion that the history moved.
view = streamingFinanceView()
const day20b = view.days.find((d: any) => d.streamDate === day20.streamDate)
ok(view.reconciled, 'the view still reconciles at the new rate', String(view.reconcileNote))
ok(
  cents(day20b.netSales) === cents(beforeNet),
  'the net Whatnot paid is untouched — it is a stored fact',
  `${day20b.netSales} vs ${beforeNet}`
)
ok(
  cents(day20b.grossSales) > cents(beforeGross),
  'but the past show now reports a higher gross, with no re-upload',
  `${day20b.grossSales} vs ${beforeGross}`
)
ok(
  cents(day20b.grossSales) + cents(day20b.totalFees) === cents(day20b.netSales),
  'and it still lands back on the net'
)
const mine10 = feesFromRows(day20b.streamDate, () => withCommission(0.1))
ok(cents(day20b.whatnotFee) === mine10.whatnotCents, 'at the rate the period says', String(day20b.whatnotFee))

// THE OTHER THREE MOVE HISTORY TOO, which is the whole of "make the processing
// fee configurable". Nothing is re-imported here either — the tax rate and the
// flat charge are read on every derivation, exactly as the commission is.
{
  const beforeProcessing = day20b.processingFee
  const beforeTax = day20b.salesTax
  const july = listRatePeriods().find((p: any) => p.note === 'July renegotiation')
  const bumped = saveRatePeriod(
    {
      id: july.id,
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      rate: 0.1,
      taxRate: 0.09,
      processingRate: 0.035,
      processingFlatCents: 49,
      note: 'July renegotiation'
    },
    null
  )
  ok(bumped.ok, 'the tax rate and the card terms are edited', bumped.ok ? '' : bumped.error)
  const after = streamingFinanceView().days.find((d: any) => d.streamDate === day20.streamDate)
  ok(
    Math.abs(after.processingFee) > Math.abs(beforeProcessing),
    'a past show now reports a bigger processing fee, with no re-upload',
    `${after.processingFee} vs ${beforeProcessing}`
  )
  ok(after.salesTax > beforeTax, 'and more tax passed through', `${after.salesTax} vs ${beforeTax}`)
  ok(
    cents(after.netSales) === cents(beforeNet),
    'while the net Whatnot paid is still the stored fact it always was'
  )
  ok(
    cents(after.grossSales) + cents(after.totalFees) === cents(after.netSales),
    'and the identity holds at the new terms'
  )
  ok(
    cents(after.totalRevenue) ===
      cents(after.grossSales + after.tips + after.bonuses + after.unclassified),
    'with the tax in no revenue line and no subtotal',
    `${after.totalRevenue} vs ${after.grossSales} + ${after.tips} + ${after.bonuses}`
  )
  ok(
    cents(after.grossSales) > cents(beforeGross),
    'and the gross moved because the fee taken out of it did',
    `${after.grossSales} vs ${beforeGross}`
  )

  // THE FLAT CHARGE ON ITS OWN. It is the term with no percentage behind it, so
  // it is the one most likely to be treated as a constant somewhere — and a
  // constant would not move a past show. Nothing else is touched here.
  const flatOnly = saveRatePeriod(
    {
      id: july.id,
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      // Every other term exactly as the edit above left it, so the only thing
      // that moves below is the flat charge.
      rate: 0.1,
      taxRate: 0.09,
      processingRate: 0.035,
      processingFlatCents: 99,
      note: 'July renegotiation'
    },
    null
  )
  ok(flatOnly.ok, 'the flat card charge alone is edited to 99c', flatOnly.ok ? '' : flatOnly.error)
  const flatDay = streamingFinanceView().days.find((d: any) => d.streamDate === day20.streamDate)
  ok(
    Math.abs(cents(flatDay.processingFee)) - Math.abs(cents(after.processingFee)) >=
      0.69 * flatDay.feeSaleCount,
    `and all ${flatDay.feeSaleCount} orders on that past show cost at least 69c more to process`,
    `${flatDay.processingFee} vs ${after.processingFee}`
  )
  ok(
    cents(flatDay.grossSales) > cents(after.grossSales),
    'so the show reports a higher gross again, still with no re-upload',
    `${flatDay.grossSales} vs ${after.grossSales}`
  )
  ok(
    cents(flatDay.grossSales) + cents(flatDay.totalFees) === cents(flatDay.netSales),
    'and the identity is still exact'
  )
  // The tax moved too, and it should have: a bigger flat charge means the same
  // payout can only have come from a BIGGER bid, and the buyer's tax is charged
  // on that bid. It is still not revenue and still in no subtotal — it is the
  // recovered sale price underneath it that changed.
  ok(
    cents(flatDay.salesTax) > cents(after.salesTax),
    'and the tax follows the bid, because a bigger charge means a bigger bid',
    `${flatDay.salesTax} vs ${after.salesTax}`
  )
  // Put July back where section 5 expects it.
  const restored = saveRatePeriod(
    {
      id: july.id,
      fromDate: '2026-07-01',
      toDate: '2026-07-31',
      rate: 0.1,
      taxRate: DEFAULT_TAX_RATE,
      processingRate: DEFAULT_PROCESSING_RATE,
      processingFlatCents: DEFAULT_PROCESSING_FLAT_CENTS,
      note: 'July renegotiation'
    },
    null
  )
  ok(restored.ok, 'and restored', restored.ok ? '' : restored.error)
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. overlap is refused, and so is a bad number ===')
// ---------------------------------------------------------------------------
// THE RULE: two periods may not both claim a day. Not resolved by precedence —
// refused — because a precedence rule makes a show's fee depend on something the
// screen does not show, and nobody could reproduce it by reading the list.
/** A whole period input at one commission, on the default terms. */
const termsOf = (rate: number): Record<string, unknown> => ({
  rate,
  taxRate: DEFAULT_TAX_RATE,
  processingRate: DEFAULT_PROCESSING_RATE,
  processingFlatCents: DEFAULT_PROCESSING_FLAT_CENTS
})

const clashes: Array<[string, string | null, string]> = [
  ['2026-07-15', '2026-08-15', 'a range that starts inside July'],
  ['2026-06-01', '2026-07-05', 'a range that ends inside July'],
  ['2026-06-01', null, 'an open-ended range that swallows July'],
  ['2026-07-10', '2026-07-12', 'a range entirely inside July'],
  ['2026-07-01', '2026-07-31', 'the identical range']
]
for (const [from, to, why] of clashes) {
  const res = saveRatePeriod({ ...termsOf(0.07), fromDate: from, toDate: to, note: '' }, null)
  ok(!res.ok && /overlap/i.test(res.error ?? ''), `refused: ${why}`, res.ok ? 'accepted' : res.error)
}
ok(listRatePeriods().length === 1, 'and none of them landed', String(listRatePeriods().length))

// Touching ranges are fine — 1 Aug is not inside 1–31 July.
const august = saveRatePeriod(
  { ...termsOf(0.065), fromDate: '2026-08-01', toDate: null, note: 'from August' },
  null
)
ok(august.ok, 'a range that starts the day after is accepted', august.ok ? '' : august.error)
ok(
  rateForDate('2026-07-31').commissionRate === 0.1 && rateForDate('2026-08-01').commissionRate === 0.065,
  'and the boundary is exact'
)

// Editing a period does not collide with itself.
const mine = listRatePeriods().find((p: any) => p.note === 'July renegotiation')
const edited = saveRatePeriod(
  { ...termsOf(0.085), id: mine.id, fromDate: '2026-07-01', toDate: '2026-07-31', note: 'corrected' },
  null
)
ok(edited.ok, 'a period can be edited in place', edited.ok ? '' : edited.error)
ok(rateForDate('2026-07-20').commissionRate === 0.085, 'and the new rate applies immediately')

// Validation. Main is the trust boundary: the renderer sends strings and every
// one of these has to be refused HERE.
const bad: Array<[any, string]> = [
  [{ ...termsOf(0.08), fromDate: 'not-a-date', toDate: null, note: '' }, 'a start date that is not a date'],
  [{ ...termsOf(0.08), fromDate: '2026-02-31', toDate: null, note: '' }, 'a day the calendar does not have'],
  [{ ...termsOf(0.08), fromDate: '2030-01-10', toDate: '2030-01-01', note: '' }, 'an end before the start'],
  [{ ...termsOf(Number.NaN), fromDate: '2030-01-01', toDate: null, note: '' }, 'a rate that will not parse'],
  [{ ...termsOf(8), fromDate: '2030-01-01', toDate: null, note: '' }, 'an 800% rate (percent entered raw)'],
  [{ ...termsOf(-0.08), fromDate: '2030-01-01', toDate: null, note: '' }, 'a negative rate'],
  // The three newer terms are the point of this release, so each is refused on
  // its own rather than being assumed to ride along with the commission.
  [
    { ...termsOf(0.08), taxRate: 5.18, fromDate: '2030-01-01', toDate: null, note: '' },
    'a 518% tax rate (percent entered raw)'
  ],
  [
    { ...termsOf(0.08), taxRate: Number.NaN, fromDate: '2030-01-01', toDate: null, note: '' },
    'a tax rate that will not parse'
  ],
  [
    { ...termsOf(0.08), processingRate: -0.029, fromDate: '2030-01-01', toDate: null, note: '' },
    'a negative processing rate'
  ],
  [
    { ...termsOf(0.08), processingFlatCents: 3000, fromDate: '2030-01-01', toDate: null, note: '' },
    'a $30 flat charge (dollars entered as cents)'
  ],
  [
    { ...termsOf(0.08), processingFlatCents: Number.NaN, fromDate: '2030-01-01', toDate: null, note: '' },
    'a flat charge that will not parse'
  ]
]
for (const [input, why] of bad) {
  ok(validateRatePeriod(input) !== null, `the contract refuses ${why}`)
  const res = saveRatePeriod(input, null)
  ok(!res.ok, `and so does main: ${why}`, res.ok ? 'accepted' : '')
}
// A blank rate field arrives as Number('') === 0, which is a REAL number and a
// legal rate — 0% commission. It must be accepted rather than silently refused,
// because a promotional 0% is a thing that can happen; what must not happen is a
// blank field becoming one, which is why the form sends NaN for empty. The same
// goes for a 0% tax state and a card deal with no flat charge.
ok(
  validateRatePeriod({
    fromDate: '2030-01-01', toDate: null, rate: 0, taxRate: 0, processingRate: 0,
    processingFlatCents: 0, note: ''
  }) === null,
  'but a deliberate zero on every term is legal'
)
// The message names the field, because "that rate is not a number" beside four
// rate fields is a bug report nobody can act on.
ok(
  /tax/i.test(validateRatePeriod({ ...termsOf(0.08), taxRate: 9, fromDate: '2030-01-01', toDate: null, note: '' }) ?? ''),
  'and a refusal names which of the four was wrong'
)
// The flat charge is CENTS, and the message says so — 0.30 in that field is
// three tenths of a cent, which is the mistake somebody will make.
ok(
  /cents/i.test(
    validateRatePeriod({ ...termsOf(0.08), processingFlatCents: 900, fromDate: '2030-01-01', toDate: null, note: '' }) ?? ''
  ),
  'and a flat charge refusal says it is entered in cents'
)

// Overlap detection itself, at the contract, including the open-ended cases.
const A = { id: 'a', fromDate: '2026-01-01', toDate: '2026-06-30', ...termsOf(0.06), note: '', createdAt: '', updatedAt: '' }
const B = { id: 'b', fromDate: '2026-07-01', toDate: null, ...termsOf(0.07), note: '', createdAt: '', updatedAt: '' }
ok(overlappingRatePeriod([A, B], { fromDate: '2026-06-30', toDate: '2026-06-30' }) === A, 'the last day of a closed range is inside it')
ok(overlappingRatePeriod([A, B], { fromDate: '2030-01-01', toDate: null }) === B, 'an open range reaches forever')
ok(overlappingRatePeriod([A, B], { fromDate: '2025-01-01', toDate: '2025-12-31' }) === null, 'and a range before both is clear')
ok(overlappingRatePeriod([A, B], { fromDate: '2026-01-01', toDate: null }, 'a') === B, 'ignoring itself still finds the other')

// An open-ended period really does run forever — which is also why a 2031 range
// cannot be added while it exists.
ok(rateForDate('2031-06-01').commissionRate === 0.065, 'the open-ended August period reaches 2031')
const blocked = saveRatePeriod({ ...termsOf(0.09), fromDate: '2031-01-01', toDate: '2031-12-31', note: '' }, null)
ok(!blocked.ok, 'so a 2031 range collides with it', blocked.ok ? 'accepted' : '')

// Removing a period puts its days back on whatever else covers them, and leaves
// every other period exactly where it was.
const augustId = listRatePeriods().find((p: any) => p.fromDate === '2026-08-01').id
ok(deleteRatePeriod(augustId).ok, 'the open-ended period can be removed')
ok(rateForDate('2031-06-01').commissionRate === DEFAULT_COMMISSION_RATE, 'after which the default is back')
ok(rateForDate('2026-07-20').commissionRate === 0.085, 'and July is untouched by that')
ok(deleteRatePeriod(augustId).ok === false, 'removing it twice is refused, not silent')

// ---------------------------------------------------------------------------
console.log("\n=== 6. the owner's real exports ===")
// ---------------------------------------------------------------------------
const ledgerDir = (process.env.RM_LEDGER_DIR ?? '').trim()
if (!ledgerDir) {
  skip('RM_LEDGER_DIR is not set — no real ledger was checked (see the header of this file)')
} else {
  let files: string[] = []
  try {
    files = readdirSync(ledgerDir).filter((f) => f.toLowerCase().endsWith('.csv')).sort()
  } catch (err) {
    files = []
    ok(false, `RM_LEDGER_DIR could not be read: ${ledgerDir}`, String(err))
  }
  ok(files.length > 0, `${files.length} CSV file(s) found in RM_LEDGER_DIR`)

  const realImports: string[] = []
  for (const f of files) {
    const res = importLedger(join(ledgerDir, f), null)
    if (!res.ok) {
      // A file this build cannot read is reported, never quietly passed over.
      skip(`${f}: ${res.error}`)
      continue
    }
    const rec = res.data.import
    if (rec.rowsImported > 0) {
      realImports.push(rec.id)
      console.log(`  ---- ${f}: ${rec.rowsImported} rows, ${rec.rowsQuarantined} quarantined`)
      ok(rec.rowsQuarantined === 0, `  ${f}: nothing quarantined`, String(rec.rowsQuarantined))
    } else {
      // A duplicate export. That it inserts nothing is itself the assertion.
      ok(rec.rowsDuplicate > 0, `  ${f}: a re-upload adds nothing and loses nothing`)
    }
  }

  if (realImports.length === 0) {
    skip('no real ledger rows were imported — nothing to reconcile')
  } else {
    const scope = realImports.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')

    // THE RECONCILIATION IDENTITY, PER EXPORT. Every non-payout row in a file
    // summed equals that file's payouts. This is the proof that `Amount` is
    // already net: if a fee were still to come off, the two could not balance.
    //
    // Per file, not across the pile. The identity is a property of ONE export,
    // and a folder of them may overlap — Whatnot writes two different formats
    // (`($25.00)` and `"-$25.00"`, bare and quoted empties) and the same period
    // pulled in both spells a handful of messages differently, so a row can
    // fail to recognise its own twin. Summing overlapping exports together and
    // demanding they balance tests the folder somebody happened to assemble
    // rather than the arithmetic, and it passed here only while one of the
    // files was being rejected outright.
    for (const id of realImports) {
      const one = db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN bucket = 'payout' THEN 0
                               ELSE CAST(ROUND(amount * 100) AS INTEGER) END), 0) AS earned,
             COALESCE(SUM(CASE WHEN bucket = 'payout'
                               THEN CAST(ROUND(amount * 100) AS INTEGER) ELSE 0 END), 0) AS paid
           FROM ledger_rows WHERE import_id = ?`
        )
        .get(id) as { earned: number; paid: number }
      // An export whose payouts all fall outside its own window has nothing to
      // balance against; only a file carrying both sides is evidence.
      if (one.paid === 0) continue
      ok(
        one.earned === -one.paid,
        `  one export balances: earned $${(one.earned / 100).toFixed(2)} = paid out $${(-one.paid / 100).toFixed(2)}`,
        `${one.earned} vs ${-one.paid}`
      )
    }

    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN bucket = 'payout' THEN 0
                             ELSE CAST(ROUND(amount * 100) AS INTEGER) END), 0) AS earned,
           COALESCE(SUM(CASE WHEN bucket = 'payout'
                             THEN CAST(ROUND(amount * 100) AS INTEGER) ELSE 0 END), 0) AS paid,
           COUNT(*) AS rows
         FROM ledger_rows WHERE import_id IN (${scope})`
      )
      .get() as { earned: number; paid: number; rows: number }
    console.log(
      `  ---- ${totals.rows.toLocaleString()} rows · earned $${(totals.earned / 100).toFixed(2)} · ` +
        `paid out $${(-totals.paid / 100).toFixed(2)}`
    )
    // Across the whole folder this can only be reported, not asserted: see the
    // note above. When it does not balance, the gap is what overlapping exports
    // in two formats cost — worth printing so nobody reads the total as gospel.
    if (totals.earned !== -totals.paid) {
      console.log(
        `  ---- note: these exports overlap; the union is off by ` +
          `$${Math.abs(totals.earned + totals.paid) / 100} (rows one format spells differently)`
      )
    }
    ok(
      true,
      'per-export identity checked above; union reported',
      `${totals.earned} vs ${-totals.paid}`
    )

    // And the derived gross, less the derived fees, is the ledger's own net —
    // across every positive sale row in the real files.
    const saleRows = db
      .prepare(
        `SELECT occurred_at AS at, CAST(ROUND(amount * 100) AS INTEGER) AS c
           FROM ledger_rows
          WHERE import_id IN (${scope}) AND bucket IN ('sale', 'product_sale')`
      )
      .all() as Array<{ at: string; c: number }>
    let positives = 0
    let negatives = 0
    let zeros = 0
    let netC = 0
    let grossC = 0
    let feeC = 0
    let broken = 0
    let unresolved = 0
    let taxC = 0
    let smallestPositive = Number.POSITIVE_INFINITY
    for (const r of saleRows) {
      const fee = deriveSaleFee(r.c, DEFAULT_FEE_RATES)
      if (fee.grossCents + fee.whatnotFeeCents + fee.processingFeeCents !== r.c) broken += 1
      if (r.c > 0) {
        positives += 1
        // EVERY positive payout must be reproducible by the forward model.
        // A row that is not is the app noticing that the configured terms are
        // not the ones Whatnot charged — which is information, not a rounding
        // wobble, and is why it is counted rather than smoothed over.
        if (!fee.exact) unresolved += 1
        if (r.c < smallestPositive) smallestPositive = r.c
      } else if (r.c < 0) negatives += 1
      else zeros += 1
      netC += fee.netCents
      grossC += fee.grossCents
      feeC += fee.whatnotFeeCents + fee.processingFeeCents
      taxC += fee.taxCents
    }
    console.log(
      `  ---- ${saleRows.length.toLocaleString()} sale rows (${positives.toLocaleString()} positive, ` +
        `${negatives} negative, ${zeros} zero) · net $${(netC / 100).toFixed(2)} · ` +
        `gross $${(grossC / 100).toFixed(2)} · fees $${(-feeC / 100).toFixed(2)} · ` +
        `tax passed through $${(taxC / 100).toFixed(2)}`
    )
    ok(broken === 0, `every one of ${saleRows.length.toLocaleString()} rows round-trips`, String(broken))
    ok(
      unresolved === 0,
      `and all ${positives.toLocaleString()} positive payouts invert to a real bid`,
      String(unresolved)
    )
    ok(grossC + feeC === netC, 'and the totals do too, to the cent', `${grossC + feeC} vs ${netC}`)
    ok(grossC > netC, 'with the derived gross above the ledger figure, as it must be')

    // THE SMALLEST PAYOUT IN A FILE IS THE BEST EVIDENCE IN IT. A $1.00 opening
    // bid happens on every RM show, so a model that turns the smallest payout
    // Whatnot ever wrote into exactly $1.00 is saying something the reconciling
    // identity cannot: that these are the real terms rather than a set that
    // merely adds up. In the 19-28 July export that payout is $0.59, and it is a
    // dollar.
    if (Number.isFinite(smallestPositive)) {
      const tiny = deriveSaleFee(smallestPositive, DEFAULT_FEE_RATES)
      console.log(
        `  ---- smallest positive payout $${(smallestPositive / 100).toFixed(2)} ` +
          `-> a $${((tiny.itemCents ?? 0) / 100).toFixed(2)} bid`
      )
    }
    const fiftyNine = saleRows.some((r) => r.c === 59)
    if (fiftyNine) {
      const bid = deriveSaleFee(59, DEFAULT_FEE_RATES)
      ok(bid.itemCents === 100, '  the $0.59 payout in the file is a $1.00 opening bid', String(bid.itemCents))
    } else {
      skip('  no $0.59 payout in these files — the $1.00 bid case is pinned in section 1 regardless')
    }
    // ROUNDNESS PROVES NOTHING ON ITS OWN, and this says so out loud rather than
    // letting the next reader infer it. Older exports carry payouts that invert
    // to bids like $0.89 — perfectly consistent arithmetic under terms that were
    // not today's — which is exactly why all four numbers are configurable by
    // date instead of chosen once, here, by whoever wrote this model.
    const roundBids = saleRows.filter(
      (r) => r.c > 0 && (deriveSaleFee(r.c, DEFAULT_FEE_RATES).itemCents ?? 1) % 100 === 0
    ).length
    console.log(
      `  ---- ${roundBids.toLocaleString()} of ${positives.toLocaleString()} bids land on a round dollar ` +
        `at today's terms (${((100 * roundBids) / positives).toFixed(1)}%)`
    )

    // What the old model would have reported, side by side. This is the size of
    // the bug, measured on the owner's own file rather than argued about.
    const oldRevenue = netC
    const oldFee = Math.round(netC * 0.089)
    ok(taxC > 0, 'the buyers paid real sales tax, and none of it is in the figures above', String(taxC))
    console.log(
      `  ---- old model: revenue $${(oldRevenue / 100).toFixed(2)} less $${(oldFee / 100).toFixed(2)} fees` +
        ` = $${((oldRevenue - oldFee) / 100).toFixed(2)} kept`
    )
    console.log(
      `  ---- corrected: revenue $${(grossC / 100).toFixed(2)} less $${(-feeC / 100).toFixed(2)} fees` +
        ` = $${((grossC + feeC) / 100).toFixed(2)} kept`
    )
    ok(
      grossC + feeC === netC && oldRevenue - oldFee < netC,
      'the corrected model keeps exactly what was paid; the old one kept less',
      `${(grossC + feeC) / 100} vs ${(oldRevenue - oldFee) / 100}`
    )

    // The parser's own money shapes, on the real strings — the parenthesised
    // negative is the one that silently turned an expense into revenue.
    ok(parseLedgerAmount('($4.15)') === -4.15, 'a parenthesised negative is still negative')
    ok(parseLedgerAmount('$0.00 ') === 0, 'and a padded zero is still zero')

    // Summing the same rows through the contract's own aggregator has to give
    // the same answer as the loop above.
    const viaContract = computeFees(
      saleRows.map((r) => ({ netCents: r.c, rates: DEFAULT_FEE_RATES }))
    )
    ok(
      cents(viaContract.grossSales) === grossC && cents(viaContract.netSales) === netC,
      'computeFees agrees with the row-by-row sum'
    )
    ok(viaContract.chargedCount === positives, 'and charges exactly the positive rows')
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. a sheet exported at its full width ===')
// ---------------------------------------------------------------------------
// A spreadsheet that has ever held a value to the right of the data writes the
// whole sheet width, so the export comes out "…,Completed Date,,," and every
// row carries the same trailing commas. One of the owner's two copies of the
// same June export is exactly that, and it was refused outright.
//
// The rows must survive the padding, INCLUDING the ones that need the anchored
// repair — that regex is anchored at both ends, so a padded line matches
// nothing and the rows most in need of repairing are the ones that would be
// lost. That is the case worth a test; the plain rows are the easy half.
{
  const pad = (csv: string, cols: number): string =>
    csv
      .split('\r\n')
      .map((l) => (l.trim() ? l + ','.repeat(cols) : l))
      .join('\r\n')

  // The SAME bytes already imported above — csvOf mints fresh order ids on each
  // call, and comparing against different orders would prove nothing.
  const plain = readFileSync(csvPath, 'utf8')
  const padded = join(DIR, 'ledger-padded.csv')
  writeFileSync(padded, pad(plain, 3), 'utf8')
  const r = importLedger(padded, null)
  ok(r.ok, 'a sheet-width export imports', r.ok ? '' : r.error)
  if (r.ok) {
    ok(r.data.import.rowsQuarantined === 0, 'nothing quarantined', String(r.data.import.rowsQuarantined))
    ok(
      r.data.import.rowsParsed === NIGHT_ONE.length + NIGHT_TWO.length,
      'every row parsed',
      `${r.data.import.rowsParsed} of ${NIGHT_ONE.length + NIGHT_TWO.length}`
    )
    // Same rows as the unpadded copy, so the padding changed nothing but the
    // shape of the file: they dedupe against what is already imported.
    ok(r.data.import.rowsImported === 0, 'and they are the SAME rows, not new ones')
  }

  // A trailing column carrying a VALUE is a format change, not padding. It must
  // still be refused — a silently added column is how a bucket goes missing
  // while every total still looks plausible.
  const named = join(DIR, 'ledger-named-col.csv')
  writeFileSync(
    named,
    plain
      .split('\r\n')
      .map((l, i) => (l.trim() ? l + (i === 0 ? ',Currency' : ',USD') : l))
      .join('\r\n'),
    'utf8'
  )
  const bad = importLedger(named, null)
  ok(!bad.ok, 'but a NAMED extra column is still refused', bad.ok ? 'accepted!' : '')
}

// ---------------------------------------------------------------------------
console.log('\n=== 8. a rate period follows the SHOW, not the calendar ===')
// ---------------------------------------------------------------------------
// THE OWNER'S CASE, EXACTLY. A commission period of 15 June – 20 July at 4%, and
// a Monday show that went on at 7pm on the 20th and finished at 1am on the 21st.
// The statement reported 5.1% — a number on no screen and in no agreement —
// because the rate was looked up by each ROW'S OWN calendar date, so the spots
// sold before midnight were inside the period at 4% and the ones sold after it
// were outside at the 6% default, and the fee line printed the blend.
//
// The rate is now looked up by the row's BUSINESS DAY, which is the same
// `stream_date` the P&L already groups by, so a show has ONE rate from its first
// spot to its last. See the note in buildView for what that trades away.
for (const p of listRatePeriods()) deleteRatePeriod(p.id)
ok(listRatePeriods().length === 0, 'the rate list is cleared for this section')

const owners = saveRatePeriod(
  { ...termsOf(0.04), fromDate: '2026-06-15', toDate: '2026-07-20', note: "the owner's 4% period" },
  null
)
ok(owners.ok, 'the 15 Jun – 20 Jul period at 4% is saved', owners.ok ? '' : owners.error)

// The Fees & rates preview's own answer, for the night the show started on and
// for the calendar day it finished on. The first is what everything below must
// agree with; the second is the rate the OLD rule mixed in.
const nightOf20 = day20.streamDate
ok(
  rateForDate(nightOf20).commissionRate === 0.04,
  'the preview says 4% for the night of the 20th',
  String(rateForDate(nightOf20).commissionRate)
)
ok(
  rateForDate('2026-07-21').commissionRate === DEFAULT_COMMISSION_RATE,
  'and 8% for the 21st, which is where the blend came from'
)

view = streamingFinanceView()
const night20 = view.days.find((d: any) => d.streamDate === nightOf20)
const night21 = view.days.find((d: any) => d.streamDate === day21.streamDate)
ok(!!night20 && !!night21, 'both nights are still there')
ok(view.reconciled, 'and the view reconciles under the business-day rule', String(view.reconcileNote))

// ONE RATE FOR THE WHOLE SHOW. The night of the 20th has rows on both sides of
// midnight — two of the five settled after it — and every one of them is priced
// at the period's 4%.
const straddling = db
  .prepare(
    `SELECT COUNT(*) AS c FROM ledger_rows
      WHERE stream_date = ? AND bucket IN ('sale', 'product_sale')
        AND occurred_at > ?`
  )
  .get(nightOf20, at(21, 0).toISOString()) as { c: number }
ok(straddling.c > 0, `${straddling.c} of the show's sale rows settled after midnight`)

ok(night20.rateBreakdown.length === 1, 'the night reports exactly ONE rate', JSON.stringify(night20.rateBreakdown))
ok(night20.rateBreakdown[0].rate === 0.04, 'and it is the 4% the period says', String(night20.rateBreakdown[0].rate))
ok(
  cents(night20.rateBreakdown[0].grossSales) === cents(night20.grossSales),
  'the slice accounts for the whole of the gross',
  `${night20.rateBreakdown[0].grossSales} vs ${night20.grossSales}`
)

const at4 = feesFromRows(nightOf20, () => withCommission(0.04))
ok(cents(night20.whatnotFee) === at4.whatnotCents, 'every row of the show was charged at 4%', String(night20.whatnotFee))
ok(cents(night20.grossSales) === at4.grossCents, 'and the gross was derived at 4% throughout')
ok(
  cents(night20.grossSales) + cents(night20.totalFees) === cents(night20.netSales),
  'with the net Whatnot paid still landing exactly'
)

// 4.0%, not 5.1%. Measured the way the statement measures it — fee over gross —
// so this is the figure that used to be a blend.
const derived20 = Math.round((Math.abs(night20.whatnotFee) / night20.grossSales) * 1000) / 10
ok(derived20 === 4, 'the show reports 4.0%', `${derived20}%`)

// And the old rule, run on the same rows, produces neither 4% nor 6% — which is
// what a blended figure IS, and why nobody could find it on the rates screen.
const oldWay = feesFromRows(
  nightOf20,
  (d: string) => withCommission(d <= '2026-07-20' ? 0.04 : DEFAULT_COMMISSION_RATE),
  'calendar'
)
const oldPct = Math.round((Math.abs(oldWay.whatnotCents) / oldWay.grossCents) * 1000) / 10
ok(oldPct > 4 && oldPct < 8, `the old row-date rule blended it to ${oldPct}%`, String(oldPct))
ok(oldPct !== derived20, 'which is a different number from the one the period configures')

// THE STATEMENT AND THE PREVIEW PRINT THE SAME STRING. Not "agree numerically" —
// the same characters, from the same formatter, because a statement that says
// "4%" beside a screen that says "4.00%" is the same complaint in a smaller font.
const sect20 = buildPnl(night20)
const feeLine20 = sect20
  .find((s: any) => s.key === 'fees')
  .lines.find((l: any) => l.key === 'whatnotFee')
ok(
  feeLine20.detail.startsWith(`${ratePct(rateForDate(nightOf20).commissionRate)} of `),
  'the commission line leads with the rate the preview would show for that night',
  feeLine20.detail
)
ok(!/blended/.test(feeLine20.detail), 'and says nothing about a blend, because there is not one')

// The night AFTER the period ends falls back to the default, on its own, whole.
ok(night21.rateBreakdown.length === 1, 'the 21st also reports one rate')
ok(
  night21.rateBreakdown[0].rate === DEFAULT_COMMISSION_RATE,
  'the 8% default, because no period covers that night',
  String(night21.rateBreakdown[0].rate)
)
// The slice also carries the CARD terms those rows were charged under, which is
// what lets the processing line name a rate instead of describing a shape.
ok(
  night21.rateBreakdown[0].processingRate === DEFAULT_PROCESSING_RATE &&
    night21.rateBreakdown[0].processingFlatCents === DEFAULT_PROCESSING_FLAT_CENTS,
  'and the card terms alongside it',
  JSON.stringify(night21.rateBreakdown[0])
)

// ---------------------------------------------------------------------------
console.log('\n=== 8b. a span that really does cover two rates says so ===')
// ---------------------------------------------------------------------------
// A single business day cannot span two rates any more — that is the point of
// section 8, and it is true by construction now that the rate is a function of
// `stream_date` alone. A WEEK, a MONTH or any picked range still can, and the
// statement renders those with the same builder, so the disclosure lives there.
const span = sumDayFinance([night20, night21])
ok(span.rateBreakdown.length === 2, 'a range over both nights carries two rates', JSON.stringify(span.rateBreakdown))
ok(
  span.rateBreakdown[0].rate === 0.04 && span.rateBreakdown[1].rate === DEFAULT_COMMISSION_RATE,
  'lowest first, both as configured'
)
ok(
  cents(span.rateBreakdown[0].grossSales + span.rateBreakdown[1].grossSales) === cents(span.grossSales),
  'and the two slices still add up to the range gross, to the cent',
  `${span.rateBreakdown[0].grossSales} + ${span.rateBreakdown[1].grossSales} vs ${span.grossSales}`
)

const spanLine = buildPnl(span)
  .find((s: any) => s.key === 'fees')
  .lines.find((l: any) => l.key === 'whatnotFee')
ok(spanLine.detail.startsWith('blended: '), 'the statement calls it a blend', spanLine.detail)
ok(spanLine.detail.includes('4% on $'), 'and names the 4% and what was sold at it', spanLine.detail)
ok(spanLine.detail.includes('8% on $'), 'and the 8% and what was sold at that')
// The card terms did NOT change across those two nights, so the processing line
// must not claim a blend it does not have — the two fees blend independently.
const spanProcessing = buildPnl(span)
  .find((s: any) => s.key === 'fees')
  .lines.find((l: any) => l.key === 'processingFee')
ok(
  !/blended/.test(spanProcessing.detail),
  'while the processing line says nothing about a blend, because the card terms never moved',
  spanProcessing.detail
)
ok(
  spanProcessing.detail.startsWith(`${ratePct(DEFAULT_PROCESSING_RATE)} of `),
  'and leads with the card percentage that was actually charged',
  spanProcessing.detail
)
ok(
  spanProcessing.detail.includes(`${DEFAULT_PROCESSING_FLAT_CENTS}¢`),
  'and states the flat charge per order',
  spanProcessing.detail
)
// The failure this replaces: one averaged percentage, presented as if somebody
// had configured it.
const blend = Math.round((Math.abs(span.whatnotFee) / span.grossSales) * 1000) / 10
ok(blend !== 4 && blend !== 6, `the average would have been ${blend}% — a rate on no screen`, String(blend))
ok(!spanLine.detail.includes(`${blend}%`), 'and that average appears nowhere on the line', spanLine.detail)

// The same disclosure at the contract, with rates picked so the average is a
// tidy-looking lie: 4% on $10,000 and 8% on $10,000 averages to exactly 6%, the
// default — a figure that would look configured and be nothing of the sort.
const twoRate = buildPnl({
  netSales: 18600, grossSales: 20000, saleCount: 2,
  tips: 0, bonuses: 0, totalRevenue: 20000, unclassified: 0, feeSaleCount: 2,
  rateBreakdown: [
    { rate: 0.04, grossSales: 10000 },
    { rate: 0.08, grossSales: 10000 }
  ],
  breakCost: 0, giveawayCost: 0, cogs: 0, grossProfit: 20000,
  whatnotFee: -1200, processingFee: -580, totalFees: -1780,
  shippingSubsidy: 0, shippingCharges: 0, giveawayShipping: 0, refundShipping: 0,
  netShipping: 0, showBoost: 0, reversals: 0, netProfit: 18220
})
  .find((s: any) => s.key === 'fees')
  .lines.find((l: any) => l.key === 'whatnotFee')
ok(
  twoRate.detail === 'blended: 4% on $10,000.00, 8% on $10,000.00',
  'both rates are named with the gross at each, rather than averaged to 6%',
  twoRate.detail
)

// A build old enough to send no breakdown at all still prints something true —
// the derived quotient it always printed — rather than nothing.
const legacy = buildPnl({
  netSales: 18600, grossSales: 20000, saleCount: 2,
  tips: 0, bonuses: 0, totalRevenue: 20000, unclassified: 0, feeSaleCount: 2,
  breakCost: 0, giveawayCost: 0, cogs: 0, grossProfit: 20000,
  whatnotFee: -1200, processingFee: -580, totalFees: -1780,
  shippingSubsidy: 0, shippingCharges: 0, giveawayShipping: 0, refundShipping: 0,
  netShipping: 0, showBoost: 0, reversals: 0, netProfit: 18220
})
  .find((s: any) => s.key === 'fees')
  .lines.find((l: any) => l.key === 'whatnotFee')
ok(legacy.detail === '6% of $20,000.00 gross', 'a breakdown-less day falls back to the old line', legacy.detail)

// The merge itself: same rate from several days is one slice, and the cents add.
const merged = mergeRateSlices([
  { rate: 0.06, grossSales: 100.01 },
  { rate: 0.04, grossSales: 50 },
  { rate: 0.06, grossSales: 0.02 }
])
ok(merged.length === 2, 'merging folds repeats of the same rate together', JSON.stringify(merged))
ok(merged[0].rate === 0.04 && merged[1].rate === 0.06, 'sorted lowest rate first')
ok(cents(merged[1].grossSales) === cents(100.03), 'and the money adds in cents, not floats', String(merged[1].grossSales))

// ---------------------------------------------------------------------------
console.log('\n=== 9. two nights of a real show, itemised ===')
// ---------------------------------------------------------------------------
// THE SETUP FOR THE THREE THINGS BELOW, and it is one setup on purpose: cost of
// goods per product, the marketplace split and a typed write-off all have to sum
// over the SAME range and land on the same bottom line, so they are asserted
// against one pair of nights rather than three convenient ones.
//
// The nights are RELATIVE TO NOW rather than fixed in July 2026, because a
// stream line entered against a session that has already ended is a
// reconciliation — it states what the stock cost instead of consuming layers —
// and which of those two paths runs depends on the wall clock, not on the
// fixture. Forty days back is history whenever this file is run.
//
// The rate periods are cleared first so this section prices at the defaults
// however section 8 left them; nothing below asserts a rate, but a section whose
// numbers depend on a previous section's leftovers is one that fails for the
// wrong reason.
for (const p of listRatePeriods()) deleteRatePeriod(p.id)

const back = (days: number, hour: number, minute = 0): Date => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, minute, 0, 0)
  return d
}
const NIGHT_A = back(40, 19)
const NIGHT_B = back(39, 19)
const dayA = streamDateOf(NIGHT_A.toISOString())
const dayB = streamDateOf(NIGHT_B.toISOString())

const sA = createSession(
  { title: 'Itemised A', startedAt: NIGHT_A.toISOString(), endedAt: back(40, 23).toISOString() },
  null
)
const sB = createSession(
  { title: 'Itemised B', startedAt: NIGHT_B.toISOString(), endedAt: back(39, 23).toISOString() },
  null
)
ok(sA.ok && sB.ok, 'two more shows logged', JSON.stringify([sA.error, sB.error]))

const mkProduct = (name: string, unitType: 'case' | 'box', boxesPerCase: number | null): string =>
  createProduct(
    {
      sku: `WF-${name.replace(/\W+/g, '').slice(0, 12)}`,
      upc: null,
      name,
      category: 'Baseball',
      brand: '',
      setName: '',
      year: '',
      unitType,
      boxesPerCase,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 0,
      highBid: null,
      salePrice: null,
      reorderPoint: 0,
      notes: null,
      openingQuantity: 0,
      openingLocation: 'RM'
    },
    null
  ).id

const ALPHA = 'WF Alpha Hobby 12-Box Case'
const BRAVO = 'WF Bravo Hobby 8-Box Case'
const GIFT = 'WF Gift Hobby Box'
const alphaId = mkProduct(ALPHA, 'case', 12)
const bravoId = mkProduct(BRAVO, 'case', 8)
const giftId = mkProduct(GIFT, 'box', null)

// ALPHA IS BROKEN ON BOTH NIGHTS. That is the case the aggregation exists for:
// two cases on the first night and one on the second must read as ONE line worth
// $3,600 over a range covering both, not as two lines of the same name.
const lines = [
  { session: sA.data.id, kind: 'break', product: alphaId, cases: 2, price: 1200 },
  { session: sA.data.id, kind: 'break', product: bravoId, cases: 1, price: 900 },
  { session: sA.data.id, kind: 'giveaway', product: giftId, boxes: 1, price: 150 },
  { session: sB.data.id, kind: 'break', product: alphaId, cases: 1, price: 1200 }
]
for (const l of lines) {
  const res = addItem(
    {
      sessionId: l.session,
      kind: l.kind,
      productId: l.product,
      cases: l.cases,
      boxes: l.boxes,
      casePrice: l.price,
      location: 'RM',
      breakNumber: l.kind === 'break' ? 1 : null
    },
    null
  )
  ok(res.ok, `  ${l.kind} line accepted`, res.ok ? '' : res.error)
}

// The ledger for those two nights. Night A carries a WHOLE PRODUCT sale beside a
// dozen small break spots; night B carries spots only, so the marketplace line
// has to be absent there and present next door.
const PRODUCT_MSG = 'Earnings for selling a 2026 WF Marketplace Sealed Hobby Box'
const NIGHT_A_ROWS: Line[] = [
  ...Array.from({ length: 12 }, (_, i) => ({
    when: back(40, 20, i),
    amount: 5,
    message: spotMsg(1, 'Boston Red Sox'),
    type: 'SALES'
  })),
  { when: back(40, 21), amount: 600, message: PRODUCT_MSG, type: 'SALES' }
]
const NIGHT_B_ROWS: Line[] = [
  { when: back(39, 20), amount: 40, message: spotMsg(2, 'New York Yankees'), type: 'SALES' },
  { when: back(39, 20, 1), amount: 60, message: spotMsg(2, 'Chicago Cubs'), type: 'SALES' }
]
const csv9 = join(DIR, 'itemised.csv')
writeFileSync(csv9, csvOf([...NIGHT_A_ROWS, ...NIGHT_B_ROWS]), 'utf8')
const imported9 = importLedger(csv9, null)
ok(imported9.ok, 'the two nights imported', imported9.ok ? '' : imported9.error)

const viewOf = (): any => streamingFinanceView()
const pick = (v: any, d: string): any => v.days.find((x: any) => x.streamDate === d)
let v9 = viewOf()
ok(v9.reconciled, 'the whole view still reconciles', String(v9.reconcileNote))

let nightA = pick(v9, dayA)
let nightB = pick(v9, dayB)
ok(!!nightA && !!nightB, 'both new nights are in the P&L')

// ---------------------------------------------------------------------------
console.log('\n--- 9a. cost of goods, one line per product ---')
// ---------------------------------------------------------------------------
const cogsOf = (row: any): any[] => buildPnl(row).find((s: any) => s.key === 'cogs').lines
const sumLines = (ls: any[]): number => ls.reduce((n: number, l: any) => n + cents(l.amount), 0)

const aLines = cogsOf(nightA)
ok(aLines.length === 3, 'night A lists three products, not two totals', JSON.stringify(aLines.map((l: any) => l.label)))
ok(sumLines(aLines) === cents(nightA.cogs), 'and the lines add up to the day cogs exactly', `${sumLines(aLines)} vs ${cents(nightA.cogs)}`)
ok(cents(nightA.cogs) === cents(-(2400 + 900 + 150)), 'which is what the three lines cost', String(nightA.cogs))

const alphaA = aLines.find((l: any) => l.label === ALPHA)
const giftA = aLines.find((l: any) => l.label === GIFT)
ok(!!alphaA && cents(alphaA.amount) === cents(-2400), 'the two ALPHA cases are one line at $2,400', JSON.stringify(alphaA))
ok(alphaA.amount < 0, 'and it is booked as a cost')
// THE DISTINCTION THAT MUST NOT BE LOST SILENTLY. A giveaway is stock that left
// with nothing sold against it; a break is stock consumed to make the revenue
// two lines up. Both are cost of goods, so they share a section — but the
// giveaway says what it was on the row that is one.
ok(!!giftA && cents(giftA.amount) === cents(-150), 'the giveaway is its own line', JSON.stringify(giftA))
ok(giftA.detail === 'given away', 'marked as given away rather than broken', String(giftA.detail))
ok(!alphaA.detail, 'while a break carries no such mark', String(alphaA.detail))
ok(
  aLines[0].label === ALPHA,
  'biggest cost first, so a cap would only ever roll up the small stuff',
  aLines[0].label
)

const bLines = cogsOf(nightB)
ok(bLines.length === 1, 'night B lists the one product it broke', JSON.stringify(bLines.map((l: any) => l.label)))
ok(sumLines(bLines) === cents(nightB.cogs), 'and still sums to that day cogs')

// THE AGGREGATION. A range over both nights folds ALPHA into ONE line holding
// the sum, which is the whole of the owner's instruction for a multi-day view.
const span9 = sumDayFinance([nightA, nightB])
const spanLines = cogsOf(span9)
ok(spanLines.length === 3, 'the two-night range still lists three products', JSON.stringify(spanLines.map((l: any) => l.label)))
const alphaSpan = spanLines.filter((l: any) => l.label === ALPHA)
ok(alphaSpan.length === 1, 'ALPHA appears ONCE across the range, not once per night', String(alphaSpan.length))
ok(cents(alphaSpan[0].amount) === cents(-3600), 'holding both nights added together', String(alphaSpan[0].amount))
ok(sumLines(spanLines) === cents(span9.cogs), 'and the range lines sum to the range cogs', `${sumLines(spanLines)} vs ${cents(span9.cogs)}`)
ok(cents(span9.cogs) === cents(nightA.cogs) + cents(nightB.cogs), 'which is the two days added, to the cent')
// The same thing through the OTHER accumulator — main builds the weeks and the
// grand total with its own rollup, and a breakdown carried by hand in one of the
// two and forgotten in the other is exactly the drift this asserts against.
const wk = v9.weeks.find((w: any) => w.from <= dayA && w.to >= dayA)
ok(!!wk && Array.isArray(wk.cogsBreakdown), "main's own week rollup carries the breakdown too")
ok(
  sumLines(cogsOf(wk)) === cents(wk.cogs),
  'and its lines sum to the week cogs',
  `${sumLines(cogsOf(wk))} vs ${cents(wk.cogs)}`
)

const checksumOk = (row: any, what: string): void => {
  const sections = buildPnl(row)
  ok(
    cents(pnlChecksum(sections)) === cents(row.netProfit),
    `  the ${what} statement still sums to its net profit`,
    `${pnlChecksum(sections)} vs ${row.netProfit}`
  )
}
checksumOk(nightA, 'night A')
checksumOk(nightB, 'night B')
checksumOk(span9, 'two-night range')
checksumOk(v9.totals, 'all-time')

// --- the three edges of the section, at the contract ------------------------
//
// Straight through `buildPnl`, because each of these is a shape the database
// cannot easily be pushed into and every one of them ends in the same place: the
// section subtotal is `cogs`, whatever the lines look like.
const cogsShape = (row: any): any => buildPnl(row).find((s: any) => s.key === 'cogs')
const bare = (over: any): any => ({
  netSales: 0, grossSales: 0, saleCount: 0, tips: 0, bonuses: 0, totalRevenue: 0,
  unclassified: 0, feeSaleCount: 0, breakCost: 0, giveawayCost: 0, cogs: 0, grossProfit: 0,
  whatnotFee: 0, processingFee: 0, totalFees: 0, shippingSubsidy: 0, shippingCharges: 0,
  giveawayShipping: 0, refundShipping: 0, netShipping: 0,
  showBoost: 0, reversals: 0, netProfit: 0, ...over
})

// A build old enough to send the two totals and no itemisation prints what this
// section always printed.
const legacyCogs = cogsShape(bare({ breakCost: -500, giveawayCost: -20, cogs: -520, netProfit: -520 }))
ok(
  legacyCogs.lines.map((l: any) => l.key).join(',') === 'breakCost,giveawayCost',
  'a day with no breakdown falls back to the two totals',
  JSON.stringify(legacyCogs.lines.map((l: any) => l.key))
)
ok(sumLines(legacyCogs.lines) === cents(-520), 'which still add to cogs')

// A LONG SHOW. Thirty products is more than a section should print, so the tail
// rolls into one line that carries its money — the cap changes how many lines
// there are and never what they add up to.
const many = Array.from({ length: 30 }, (_, i) => ({
  kind: 'break',
  name: `Long Show Product ${String(i + 1).padStart(2, '0')}`,
  amount: -(i + 1)
}))
const manyTotal = -((30 * 31) / 2)
const manyCogs = cogsShape(bare({ cogsBreakdown: many, cogs: manyTotal, netProfit: manyTotal }))
ok(manyCogs.lines.length === 26, 'thirty products print as 25 lines and a roll-up', String(manyCogs.lines.length))
ok(manyCogs.lines[25].key === 'cogsRest', 'the last line is the roll-up', manyCogs.lines[25].key)
ok(manyCogs.lines[25].label === '5 other products', 'and says how many it stands for', manyCogs.lines[25].label)
ok(sumLines(manyCogs.lines) === cents(manyTotal), 'and the section still adds to cogs to the cent',
   `${sumLines(manyCogs.lines)} vs ${cents(manyTotal)}`)
ok(cents(manyCogs.subtotal) === cents(manyTotal), 'as does its subtotal')

// A breakdown that does not account for the whole cost — only reachable through
// a renderer and a main built from different versions. The gap is PRINTED rather
// than left as a subtotal quietly larger than its lines.
const shortCogs = cogsShape(
  bare({ cogsBreakdown: [{ kind: 'break', name: 'Only Product', amount: -100 }], cogs: -160, netProfit: -160 })
)
ok(!!shortCogs.lines.find((l: any) => l.key === 'cogsUnitemised'),
   'an unaccounted-for cost gets a line of its own', JSON.stringify(shortCogs.lines.map((l: any) => l.key)))
ok(sumLines(shortCogs.lines) === cents(-160), 'so the section equals cogs even then')

// The merge keeps the two ACTS apart. One product both broken and given away is
// two lines; folding them would make a product that was half given away read as
// a product that sold.
const bothWays = mergeCogsItems([
  { kind: 'break', name: 'Same Product', amount: -40 },
  { kind: 'giveaway', name: 'Same Product', amount: -10 },
  { kind: 'break', name: 'Same Product', amount: -2.01 }
])
ok(bothWays.length === 2, 'break and giveaway of one product stay two lines', JSON.stringify(bothWays))
ok(cents(bothWays[0].amount) === cents(-42.01), 'with the two breaks folded in cents', String(bothWays[0].amount))

// ---------------------------------------------------------------------------
console.log('\n--- 9b. marketplace orders, on their own revenue line ---')
// ---------------------------------------------------------------------------
const revOf = (row: any): any => buildPnl(row).find((s: any) => s.key === 'revenue')
const revA = revOf(nightA)
const revB = revOf(nightB)
const mktA = revA.lines.find((l: any) => l.key === 'marketplace')
const mktB = revB.lines.find((l: any) => l.key === 'marketplace')

ok(!!mktA && !mktA.empty, 'night A carries a marketplace line', JSON.stringify(mktA))
ok(!!mktB && mktB.empty, 'night B has one at zero, which the statement hides', JSON.stringify(mktB))
ok(revA.lines.find((l: any) => l.key === 'sales').label === 'Break spots',
   'the sales line says what it is once something is split off it',
   revA.lines.find((l: any) => l.key === 'sales').label)
ok(revB.lines.find((l: any) => l.key === 'sales').label === 'Sales',
   'and stays plain "Sales" on a night with nothing to split')

// THE SUBTOTAL STILL EQUALS ITS LINES. This is the assertion the whole design of
// the split hangs on: the marketplace figure is subtracted from the sales line
// rather than added beside it, so Revenue is unchanged.
const revSum = (s: any): number => s.lines.reduce((n: number, l: any) => n + cents(l.amount), 0)
ok(revSum(revA) === cents(nightA.totalRevenue), 'night A revenue lines sum to total revenue', `${revSum(revA)} vs ${cents(nightA.totalRevenue)}`)
ok(revSum(revB) === cents(nightB.totalRevenue), 'and so do night B\'s')
ok(cents(nightA.grossSales) === cents(mktA.amount) + cents(revA.lines.find((l: any) => l.key === 'sales').amount),
   'the two sales lines are exactly the derived gross, split')

// GROSS, NOT NET. `productSales` is the ledger's own figure for those rows and
// stays that; the line prints what the buyer paid.
ok(cents(mktA.amount) === cents(nightA.productGrossSales), 'the line is the derived marketplace gross')
ok(cents(nightA.productGrossSales) > cents(nightA.productSales), 'which is more than the net Whatnot paid for it',
   `${nightA.productGrossSales} vs ${nightA.productSales}`)

// THE ARITHMETIC CHOICE, PINNED. Splitting the day's gross in proportion to the
// net would be the easy option and it is wrong: the flat card charge is levied
// once per ORDER, so one $600 box and twelve $5 spots do not gross up at the
// same ratio their nets sit in. The gap is real money, and it is why the figure
// is derived from the marketplace rows themselves.
const proportional = Math.round((cents(nightA.grossSales) * cents(nightA.productSales)) / cents(nightA.netSales))
ok(
  Math.abs(proportional - cents(nightA.productGrossSales)) > 1,
  `a proportional split would have said ${proportional} where the rows say ${cents(nightA.productGrossSales)}`,
  `${proportional} vs ${cents(nightA.productGrossSales)}`
)

// NAMED, AND THE NAMES MERGE. One sale, one product, so the detail names it —
// and a range covering both nights still names it once.
ok(nightA.marketplaceBreakdown.length === 1, 'one product behind night A', JSON.stringify(nightA.marketplaceBreakdown))
ok(mktA.detail.includes('WF Marketplace Sealed Hobby Box'), 'and the line names it', mktA.detail)
const revSpan = revOf(span9)
const mktSpan = revSpan.lines.find((l: any) => l.key === 'marketplace')
ok(cents(mktSpan.amount) === cents(mktA.amount), 'the range carries night A\'s marketplace money and no more')
ok(span9.marketplaceBreakdown.length === 1, 'still one product over the range', JSON.stringify(span9.marketplaceBreakdown))
ok(revSum(revSpan) === cents(span9.totalRevenue), 'and the range revenue lines still sum to its subtotal')

// ---------------------------------------------------------------------------
console.log('\n--- 9c. a general expense somebody typed ---')
// ---------------------------------------------------------------------------
ok(listExpenses().length === 0, 'nothing is written off out of the box')

// Refused before it can reach a P&L. Each of these is a way a form can hand main
// something that would otherwise sit on a day looking like a decision.
const refusals: Array<[any, string]> = [
  [{ streamDate: dayA, amount: Number.NaN, label: 'blank' }, 'a blank amount'],
  [{ streamDate: dayA, amount: 0, label: 'zero' }, 'a zero'],
  [{ streamDate: dayA, amount: -20, label: 'negative' }, 'a negative'],
  [{ streamDate: dayA, amount: 20, label: '   ' }, 'no description'],
  [{ streamDate: 'not-a-day', amount: 20, label: 'bad day' }, 'a date that is not one']
]
for (const [input, what] of refusals) {
  const res = saveExpense(input, null)
  ok(!res.ok, `  ${what} is refused`, JSON.stringify(res))
}
ok(listExpenses().length === 0, 'and none of them was stored')

const beforeA = cents(nightA.netProfit)
const beforeB = cents(nightB.netProfit)
const e1 = saveExpense({ streamDate: dayA, amount: 24.99, label: 'Opened a box on air' }, null)
ok(e1.ok, 'a real one saves', e1.ok ? '' : e1.error)
const e2 = saveExpense({ streamDate: dayB, amount: 10, label: 'Pack given to a regular' }, null)
ok(e2.ok, 'and a second, on the other night')

v9 = viewOf()
ok(v9.reconciled, 'the view STILL reconciles with money in it that no import brought', String(v9.reconcileNote))
nightA = pick(v9, dayA)
nightB = pick(v9, dayB)

ok(cents(nightA.generalExpenses) === cents(-24.99), 'it lands NEGATIVE on the day', String(nightA.generalExpenses))
ok(nightA.generalExpenseCount === 1, 'with the entry counted')
ok(cents(nightA.netProfit) === beforeA - cents(24.99), 'and net profit is lower by exactly that much',
   `${nightA.netProfit} vs ${beforeA / 100}`)
ok(cents(nightB.netProfit) === beforeB - cents(10), 'the other night moves by its own entry and no more')

const genA = buildPnl(nightA).find((s: any) => s.key === 'general')
ok(!!genA, 'the statement has a General expenses section of its own')
ok(cents(genA.subtotal) === cents(-24.99), 'holding the day figure', String(genA.subtotal))
ok(genA.lines.length === 1 && !genA.lines[0].empty, 'with one line on it')
ok(/1 entry/.test(String(genA.lines[0].detail)), 'that says how many entries are behind it', String(genA.lines[0].detail))
// It is deliberately NOT under "Other show costs": that section is what Whatnot
// charged and can be checked line for line against a Whatnot screen.
const showA = buildPnl(nightA).find((s: any) => s.key === 'showCosts')
ok(cents(showA.subtotal) === cents(nightA.showBoost), 'and Show costs still holds only what the platform charged',
   `${showA.subtotal} vs ${nightA.showBoost}`)

checksumOk(nightA, 'night A with an expense')
checksumOk(nightB, 'night B with an expense')

// IT SURVIVES A RANGE. Both entries, added, through the contract's accumulator.
const span9b = sumDayFinance([nightA, nightB])
ok(cents(span9b.generalExpenses) === cents(-34.99), 'a range sums both write-offs', String(span9b.generalExpenses))
ok(span9b.generalExpenseCount === 2, 'and both counts')
checksumOk(span9b, 'two-night range with expenses')
checksumOk(v9.totals, 'all-time with expenses')

// A DAY THAT IS NOTHING BUT A WRITE-OFF. Money was spent on it, so it belongs on
// the calendar — and a day with no ledger row behind it is the sharpest test of
// the reconciliation, which has to strip a cost the ledger never knew about.
const lonely = back(60, 12)
const lonelyDay = streamDateOf(lonely.toISOString())
ok(saveExpense({ streamDate: lonelyDay, amount: 5, label: 'Cracked a pack' }, null).ok,
   'an expense saves against a day with no show and no rows')
v9 = viewOf()
const L = pick(v9, lonelyDay)
ok(!!L, 'that day now exists in the P&L', String(lonelyDay))
ok(cents(L.netProfit) === cents(-5), 'and its whole bottom line is the write-off', String(L.netProfit))
ok(v9.reconciled, 'with the ledger reconciliation untouched by it', String(v9.reconcileNote))
checksumOk(L, 'expense-only day')

// Removing one gives the money back, through the same path.
const removed = deleteExpense(listExpenses().find((e: any) => e.streamDate === lonelyDay).id)
ok(removed.ok, 'an entry can be removed', removed.ok ? '' : removed.error)
v9 = viewOf()
ok(!pick(v9, lonelyDay), 'and the day it was the only thing on goes with it')
ok(v9.reconciled, 'still reconciled afterwards')
ok(listExpenses().length === 2, 'the other two are untouched', String(listExpenses().length))

// ---------------------------------------------------------------------------
console.log('\n=== IMPORT and RE-ATTRIBUTE must agree, row for row ===')
// ---------------------------------------------------------------------------
// The assertion whose absence cost real money.
//
// Two code paths decide where a row lands: the import writes it once, and
// `reattributeAll` recomputes it later from the same stored fields. They are
// meant to be the same function of the same inputs — and they were not. The
// import wrote a stream_date three ways (matched show, own day, none); the
// re-attribution knew only two, dropping the own-day date while keeping the
// own-day LABEL. Such a row then satisfied neither half of the reconciliation:
// counted in the stored total, absent from the days, skipped by unattributed.
//
// Nothing failed. The suite passed, the import path was correct, and the drift
// only surfaced when a classifier bump made every row re-attribute at once —
// on a real ledger, at which point four marketplace sales left the statement.
//
// So this compares the two paths directly. Snapshot every row's derived columns
// after the import, re-attribute, and demand they are IDENTICAL. Re-attribution
// is meant to be idempotent over an unchanged database; anything it changes on
// an untouched ledger is a disagreement between the two, whatever it is.
const derivedRows = (): Array<Record<string, unknown>> =>
  getDb()
    .prepare(
      `SELECT id, bucket, session_id, stream_date, attribution, break_number
         FROM ledger_rows ORDER BY id`
    )
    .all() as Array<Record<string, unknown>>

// The fixture the bug needs, and the reason it survived a 275-assertion suite:
// every marketplace sale above happens to fall INSIDE a logged show, so it gets
// a session and never takes the own-day branch at all. The shape that broke is
// a whole-product sale on a day with NO show — somebody sold a sealed box on a
// Tuesday they did not stream. That row books to its own date, carries no
// session, and is exactly the row the re-attribution used to strip.
const ORPHAN_MSG = 'Earnings for selling a 2026 WF Unstreamed Sealed Hobby Box'
const csvOrphan = join(DIR, 'orphan-day.csv')
writeFileSync(csvOrphan, csvOf([{ when: back(200, 14), amount: 250, message: ORPHAN_MSG, type: 'SALES' }]), 'utf8')
const impOrphan = importLedger(csvOrphan, null)
ok(impOrphan.ok, 'a marketplace sale on a day with NO show imported', impOrphan.ok ? '' : impOrphan.error)

const orphanRow = (): { attribution: string; stream_date: string | null; session_id: string | null } =>
  getDb()
    .prepare(
      `SELECT attribution, stream_date, session_id FROM ledger_rows WHERE message = ?`
    )
    .get(ORPHAN_MSG) as { attribution: string; stream_date: string | null; session_id: string | null }

const orphanAtImport = orphanRow()
ok(orphanAtImport.attribution === 'own_day', 'the import books it to its own day', orphanAtImport.attribution)
ok(orphanAtImport.session_id === null, 'with no session, because there was no show')
ok(orphanAtImport.stream_date !== null, 'AND it keeps a date — the pair that makes it findable')

const beforeReattr = derivedRows()
ok(beforeReattr.length > 0, 'there are rows to compare', String(beforeReattr.length))

const reattr = reattributeAll(null)
ok(reattr.ok === true, 're-attribution ran', reattr.error)

const afterReattr = derivedRows()
ok(afterReattr.length === beforeReattr.length, 'no row was added or lost')

const drifted: string[] = []
for (let i = 0; i < beforeReattr.length; i++) {
  const a = beforeReattr[i]
  const b = afterReattr[i]
  for (const col of ['bucket', 'session_id', 'stream_date', 'attribution', 'break_number']) {
    if (a[col] !== b[col]) drifted.push(`${String(a.id).slice(0, 8)}.${col}: ${a[col]} -> ${b[col]}`)
  }
}
ok(drifted.length === 0, 'every derived column survives a re-attribution unchanged', drifted.slice(0, 6).join(' | '))

// The specific shape that broke, asserted on its own so a future regression
// names itself instead of hiding inside the loop above.
const ownDay = getDb()
  .prepare(`SELECT COUNT(*) AS n FROM ledger_rows WHERE attribution = 'own_day' AND stream_date IS NULL`)
  .get() as { n: number }
ok(ownDay.n === 0, 'no own-day row has lost its date', String(ownDay.n))

const orphanAfter = orphanRow()
ok(orphanAfter.attribution === 'own_day', 'the unstreamed sale is still an own-day row')
ok(
  orphanAfter.stream_date === orphanAtImport.stream_date,
  'and re-attributing did not take its date away',
  `${orphanAtImport.stream_date} -> ${orphanAfter.stream_date}`
)
// The consequence, spelled out: a dateless own-day row is counted in the stored
// total and in neither the days nor the unattributed, which is precisely the
// "these numbers do not add up" banner.
ok(
  !!streamingFinanceView().days.find((d: any) => d.streamDate === orphanAfter.stream_date),
  'and its day is still on the statement'
)

// And the reconciliation itself, which is what the operator actually sees.
const afterView = streamingFinanceView()
ok(afterView.reconciled === true, 'the statement still reconciles after re-attributing', afterView.reconcileNote ?? '')

// Twice more. A path that is correct once but not stable would still drift on
// the third press of a button people press when something looks wrong.
reattributeAll(null)
reattributeAll(null)
const afterThrice = derivedRows()
let stable = true
for (let i = 0; i < beforeReattr.length; i++) {
  for (const col of ['bucket', 'session_id', 'stream_date', 'attribution', 'break_number']) {
    if (beforeReattr[i][col] !== afterThrice[i][col]) stable = false
  }
}
ok(stable, 're-attributing three times changes nothing — it is idempotent')
ok(streamingFinanceView().reconciled === true, 'and still reconciles')

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`)
process.exit(fail === 0 ? 0 : 1)
