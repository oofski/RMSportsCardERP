/**
 * Per-break P&L.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. THE PARTS SUM TO THE WHOLE. Every break's gross added up equals the day's
 *      sales line to the cent, and the same for fees. A per-break view whose
 *      lines quietly fail to add up to the day's total gets trusted and then
 *      found out.
 *
 *   2. FEES ARE EXACT, NOT ALLOCATED. deriveSaleFee runs on one ledger row, so
 *      grouping rows by break and re-running it apportions nothing. If this ever
 *      became a percentage of a per-break total, the flat 30¢ would be charged
 *      once per BREAK instead of once per row and every figure would drift.
 *
 *   3. AN UNRECORDED COST IS NOT A ZERO. A break nobody entered boxes for has an
 *      unknown margin, not a 100% one. Printing the revenue as profit flatters
 *      exactly the break that has the problem.
 *
 *   4. NOTHING IS DROPPED. Sales that name no break get their own row; a break
 *      with cost and no sales — boxes opened, nothing sold — still appears.
 *
 * Run: npm run test:break-pnl
 */
const {
  DEFAULT_FEE_RATES,
  computeFees,
  resolveFeeRates
} = require('../src/shared/financeStreaming')
const {
  breakPnlLabel,
  compareBreakPnlRows,
  splitPnlByBreak
} = require('../src/shared/breakPnl')

let pass = 0
let fail = 0
const ok = (c: boolean, name: string, extra = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const RATES = resolveFeeRates(DEFAULT_FEE_RATES)
const sale = (breakNumber: number | null, netCents: number): Record<string, unknown> => ({
  breakNumber,
  netCents,
  rates: RATES
})

// A night: three breaks and a handful of rows that name no break at all.
const SALES = [
  sale(6, 1824_00),
  sale(6, 940_55),
  sale(7, 2210_10),
  sale(7, 15_00),
  sale(8, 505_99),
  sale(null, 88_40),
  sale(null, 12_01)
]

// ---------------------------------------------------------------------------
console.log('=== 1. the parts sum to the whole ===')
// ---------------------------------------------------------------------------
// The day's figure, computed exactly as the day statement computes it.
const day = computeFees(SALES.map((s) => ({ netCents: s.netCents, rates: s.rates })))
const split = splitPnlByBreak(SALES, [])

ok(split.grossSales === day.grossSales, 'gross adds back to the day, to the cent',
  `${split.grossSales} vs ${day.grossSales}`)
ok(split.totalFees === day.totalFees, 'and so do the fees',
  `${split.totalFees} vs ${day.totalFees}`)
ok(
  split.rows.reduce((s: number, r: { saleCount: number }) => s + r.saleCount, 0) === SALES.length,
  'and every sale row is on exactly one line'
)

// THE MUTATION THIS GUARDS. If fees were ever recomputed as a percentage of a
// per-break total, the 30¢ flat would be charged once per break rather than
// once per row — three breaks instead of seven rows, off by four flat charges.
// The identity above catches it, so state the size of the error it catches.
const perRowFlat = SALES.filter((s) => s.netCents > 0).length * 0.3
const perBreakFlat = 4 * 0.3
ok(perRowFlat !== perBreakFlat, 'per-row and per-break flat charges genuinely differ',
  `${perRowFlat} vs ${perBreakFlat}`)

// ---------------------------------------------------------------------------
console.log('\n=== 2. grouping ===')
// ---------------------------------------------------------------------------
ok(split.rows.length === 4, 'three breaks and the unattributed row', String(split.rows.length))
ok(split.rows[0].breakNumber === 6, 'in break order')
ok(split.rows[3].breakNumber === null, 'with the unattributed row LAST', String(split.rows[3].label))
ok(split.rows[3].label === 'No break named', 'and named for what it is')
ok(split.hasUnattributed, 'and the split says so')
ok(split.rows[0].saleCount === 2, 'break #6 carries both of its rows')

// Sorting is stated rather than incidental: the exception must not sit above
// every real break on a screen somebody reads to compare breaks.
ok(compareBreakPnlRows({ breakNumber: null }, { breakNumber: 99 }) > 0, 'null sorts after a number')
ok(compareBreakPnlRows({ breakNumber: 2 }, { breakNumber: 11 }) < 0, 'and numbers sort numerically')
ok(breakPnlLabel(7) === '#7', 'a break is labelled like its chip')

// ---------------------------------------------------------------------------
console.log('\n=== 3. an unrecorded cost is not a zero ===')
// ---------------------------------------------------------------------------
const costed = splitPnlByBreak(SALES, [
  { breakNumber: 6, costTotal: 1200, productName: '2025 Finest Football' },
  { breakNumber: 7, costTotal: 900, productName: '2025 Prizm' }
])
const six = costed.rows.find((r: { breakNumber: number | null }) => r.breakNumber === 6)
const eight = costed.rows.find((r: { breakNumber: number | null }) => r.breakNumber === 8)

ok(six.costKnown, 'a break with a cost line knows its cost')
ok(six.cogs === 1200, 'and carries it', String(six.cogs))
ok(six.grossProfit === Math.round((six.grossSales - 1200) * 100) / 100, 'and has a gross profit')
ok(six.netProfit === Math.round((six.grossProfit + six.totalFees) * 100) / 100,
  'and a net profit with the fees taken off')
ok(six.netProfit < six.grossProfit, 'which is SMALLER — fees are negative and get added')
ok(six.products.includes('2025 Finest Football'), 'and names what was ripped')

// The one that matters. Break #8 sold and nobody recorded a box for it.
ok(!eight.costKnown, 'a break with no cost line says its cost is unknown')
ok(eight.grossProfit === null, 'and refuses to state a gross profit')
ok(eight.netProfit === null, 'or a net one')
ok(eight.grossSales > 0, 'while still showing the revenue that IS known', String(eight.grossSales))
ok(costed.uncostedBreaks === 2, 'and the split counts them', String(costed.uncostedBreaks))
// Only recorded cost is totalled. A missing one must not be summed as zero into
// a figure somebody reads as the night's cost of goods.
ok(costed.cogs === 2100, 'the total is only what was actually recorded', String(costed.cogs))

// ---------------------------------------------------------------------------
console.log('\n=== 4. nothing is dropped ===')
// ---------------------------------------------------------------------------
// Boxes opened, nothing sold. Dropping this because the sales map has no key
// for it would hide precisely the situation worth seeing.
const orphan = splitPnlByBreak([sale(6, 100_00)], [
  { breakNumber: 6, costTotal: 300 },
  { breakNumber: 12, costTotal: 450, productName: 'Opened, nothing sold' }
])
const twelve = orphan.rows.find((r: { breakNumber: number | null }) => r.breakNumber === 12)
ok(!!twelve, 'a break with cost and no sales still appears')
ok(twelve.grossSales === 0, 'with no revenue', String(twelve.grossSales))
ok(twelve.saleCount === 0, 'and no rows behind it')
ok(twelve.costKnown && twelve.cogs === 450, 'but its cost intact')
ok(twelve.grossProfit === -450, 'and a loss stated as a loss', String(twelve.grossProfit))

// A giveaway's prize rode along in the break and is a real cost of the show.
const withPrize = splitPnlByBreak([sale(6, 100_00)], [
  { breakNumber: 6, costTotal: 300, lossValue: 75 }
])
ok(withPrize.rows[0].cogs === 375, 'a giveaway prize is added to the break it rode in',
  String(withPrize.rows[0].cogs))

// An empty night is an empty split, not a crash.
const nothing = splitPnlByBreak([], [])
ok(nothing.rows.length === 0, 'no rows on an empty day')
ok(nothing.grossSales === 0 && nothing.totalFees === 0, 'and zeroes rather than NaN')
ok(!nothing.hasUnattributed, 'and nothing unattributed')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
