/**
 * IS THE REVENUE FIGURE ACTUALLY RIGHT?
 *
 * The owner, watching the Streaming tab: revenue running **$15-25k a month above
 * Whatnot's own stated sales**, every month.
 *
 * ## Why that was possible, and why nothing caught it
 *
 * Revenue in this app is not recorded, it is CALCULATED. The ledger's Amount
 * column is the net Whatnot paid; the price a buyer bid is reverse-engineered
 * from it by adding a MODELLED fee back. So every error in the fee model lands
 * on revenue — and only on revenue, because the same fee is subtracted again two
 * sections down. Section 2 pins that invariance directly: a wrong commission
 * moves the top line by tens of thousands and leaves net profit identical to the
 * cent. That is the whole reason it survived months of somebody reading these
 * screens.
 *
 * ## The two defects
 *
 * The commission was resolved by DATE ALONE — one rate for every row on a night
 * — while the real commission depends on what was sold. Any night mixing break
 * spots and sealed product was therefore priced wrong on some of them by
 * construction. Section 5 is that fix, tested through the real store rather than
 * the contract, because a rate that resolves correctly in a pure function and is
 * never passed a scope by the code that prices rows is exactly the defect this
 * repo has been bitten by before.
 *
 * And a night no rate period covers falls through to the built-in 8%, silently.
 * Section 4 is that: reported, and reported in MONEY, because four uncovered
 * Tuesdays worth $40 and one uncovered Saturday worth $60,000 are not the same
 * problem and a count cannot tell them apart.
 *
 * ## The fix is to stop guessing
 *
 * Section 1 is the answer: type what the platform states and solve for the
 * commission that reproduces it. One number is enough because the ledger already
 * supplies the other two — the net is a record and so is the order count.
 *
 * Every name and figure here is invented except the model's own constants.
 *
 * Run: npm run test:revenue-check
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/revenue-check-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const { getDb } = require('../src/main/db/database')
const { createSession } = require('../src/main/db/streaming')
const { importLedger, streamingFinanceView } = require('../src/main/db/financeStreaming')
const { listRatePeriods, rateForDate, saveRatePeriod } = require('../src/main/db/whatnotRates')
const {
  DEFAULT_COMMISSION_RATE,
  DEFAULT_FEE_RATES,
  buildPnl,
  computeFees,
  coveringRatePeriod,
  deriveSaleFee,
  effectiveFeeRates,
  overlappingRatePeriod,
  pnlChecksum,
  resolveFeeRates,
  scopeForBucket,
  validateRatePeriod
} = require('../src/shared/financeStreaming')
const { fitFromGross, gapShape, grossFitVerdict, modelDivisor } = require('../src/shared/statementFit')
const { reconInRange, reconRows, reconTotals } = require('../src/shared/pnlRecon')
const { streamDateOf } = require('../src/shared/streaming')

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
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

/** The model's own terms, with the flat charge off unless a test wants it. */
const terms = (commission: number, flat = 0): any =>
  resolveFeeRates({
    commissionRate: commission,
    taxRate: DEFAULT_FEE_RATES.taxRate,
    processingRate: DEFAULT_FEE_RATES.processingRate,
    processingFlatCents: flat,
    shippingCents: 0
  })

// ---------------------------------------------------------------------------
console.log('=== 1. one stated figure solves the commission ===')
// ---------------------------------------------------------------------------
{
  // A month priced at a real 4%: this is the ledger the app would be holding.
  const rows = Array.from({ length: 400 }, (_, i) => ({
    netCents: 1000 + i * 37,
    rates: terms(0.04, 30)
  }))
  const truth = computeFees(rows)

  // Now the app is misconfigured at the built-in 8% and derives a higher gross.
  const wrong = computeFees(rows.map((r) => ({ ...r, rates: terms(0.08, 30) })))

  const fit = fitFromGross(
    truth.grossSales,
    { netPaid: truth.netSales, derivedRevenue: wrong.grossSales, orders: truth.saleCount },
    {
      processingRate: DEFAULT_FEE_RATES.processingRate,
      taxRate: DEFAULT_FEE_RATES.taxRate,
      processingFlatCents: 30
    }
  )

  ok(fit.solvable, 'a stated figure and a net produce a rate', String(fit.problem))
  ok(
    near(fit.fittedCommissionRate, 0.04, 0.0005),
    'AND IT IS THE RATE THAT WAS ACTUALLY CHARGED — solved, not guessed',
    `${(fit.fittedCommissionRate * 100).toFixed(3)}% vs 4%`
  )
  ok(
    near(fit.refitRevenue, truth.grossSales, 1),
    'revenue re-derived at the fitted rate lands on the stated figure',
    `${fit.refitRevenue} vs ${truth.grossSales}`
  )
  ok(
    fit.revenueGap > 0,
    'and the gap it reports is positive — the app was reading HIGH',
    String(fit.revenueGap)
  )
  ok(
    grossFitVerdict(fit).tone === 'warn',
    'the verdict says so rather than passing it as fine'
  )
}

{
  // The refusals. Both are window mismatches wearing different clothes, and both
  // would otherwise hand back a confident rate derived from nonsense.
  const bad = fitFromGross(
    5000,
    { netPaid: 9000, derivedRevenue: 10000, orders: 10 },
    { processingRate: 0.029, taxRate: 0.0518, processingFlatCents: 30 }
  )
  ok(
    !bad.solvable,
    'A STATED GROSS BELOW THE NET IS REFUSED — gross is always the larger, so these are not the same days'
  )
  ok(
    (bad.problem ?? '').includes('not describing the same days'),
    'and it says which of the two things is wrong',
    String(bad.problem)
  )
  ok(grossFitVerdict(bad).tone === 'bad', 'the verdict refuses it too')

  const silly = fitFromGross(
    1_000_000,
    { netPaid: 100, derivedRevenue: 110, orders: 1 },
    { processingRate: 0.029, taxRate: 0.0518, processingFlatCents: 30 }
  )
  ok(
    !silly.solvable,
    'AND A RATE NO FEE SCHEDULE COULD HOLD IS REFUSED, rather than offered for saving'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. THE $15-25k MECHANISM, and why nothing noticed ===')
// ---------------------------------------------------------------------------
{
  // With no flat charge the multipliers are exact, so they can be asserted
  // rather than approximated.
  const k = DEFAULT_FEE_RATES.processingRate * (1 + DEFAULT_FEE_RATES.taxRate)
  const at8 = 1 / modelDivisor(0.08, DEFAULT_FEE_RATES.processingRate, DEFAULT_FEE_RATES.taxRate)
  const at4 = 1 / modelDivisor(0.04, DEFAULT_FEE_RATES.processingRate, DEFAULT_FEE_RATES.taxRate)
  ok(near(k, 0.0305022, 1e-7), 'k = processing x (1 + tax) = 0.03050', k.toFixed(7))
  ok(near(at8, 1.12423, 1e-5), 'a dollar of net grosses to $1.12423 at 8%', at8.toFixed(5))
  ok(near(at4, 1.07585, 1e-5), 'and to $1.07585 at 4%', at4.toFixed(5))
  ok(
    near(at8 - at4, 0.04838, 1e-5),
    'SO PRICING AT 8% WHEN THE REAL RATE IS 4% INVENTS 4.84 CENTS PER DOLLAR OF NET',
    (at8 - at4).toFixed(5)
  )
}

{
  // A month shaped like the one quoted in financeStreaming's own comments:
  // 6,674 rows, about $285k of net.
  const N = 6674
  // Averaging $42.75 a row, which is $285k across 6,674 — the month quoted in
  // financeStreaming's own comments, so the figure below is comparable to a real
  // one rather than to an invented shape.
  const rows = Array.from({ length: N }, (_, i) => ({
    netCents: 1000 + ((i * 977) % 6551),
    rates: terms(0.04, 30)
  }))
  const real = computeFees(rows)
  const misread = computeFees(rows.map((r) => ({ ...r, rates: terms(0.08, 30) })))
  const overshoot = misread.grossSales - real.grossSales

  ok(
    real.netSales > 250_000 && real.netSales < 320_000,
    'a month of about $285k net, in 6,674 rows',
    `$${Math.round(real.netSales).toLocaleString()} across ${N}`
  )
  ok(
    overshoot > 12_000 && overshoot < 20_000,
    'THE OVERSHOOT ON THAT MONTH IS THE OWNER’S REPORTED BAND',
    `$${Math.round(overshoot).toLocaleString()}`
  )

  /**
   * THE INVARIANCE THAT HID IT FOR MONTHS.
   *
   * The derived gross went up by the whole overshoot and the fee went down by
   * exactly the same amount, so anything computed from both is untouched. Every
   * bottom line on every screen was correct the entire time the top line was
   * wrong by five figures — which is precisely why no one went looking.
   */
  ok(
    near(misread.totalFees - real.totalFees, -overshoot, 1),
    'the fee moved by exactly the same amount, in the opposite direction',
    `${(misread.totalFees - real.totalFees).toFixed(2)} vs ${(-overshoot).toFixed(2)}`
  )
  ok(
    near(
      misread.grossSales + misread.totalFees,
      real.grossSales + real.totalFees,
      0.02
    ),
    'SO NET IS IDENTICAL AT BOTH RATES — the bottom line never moved, and that is why nobody noticed',
    `${(misread.grossSales + misread.totalFees).toFixed(2)} vs ${(real.grossSales + real.totalFees).toFixed(2)}`
  )
  ok(
    near(misread.netSales, real.netSales, 0.02),
    'and the net Whatnot paid is untouched by the rate, being a record rather than a model'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. a percentage error and a per-order error are told apart ===')
// ---------------------------------------------------------------------------
{
  // Two windows, one a third the size of the other. A commission error scales
  // with the money; a flat charge scales with the ORDER COUNT.
  const big = gapShape(9000, 6000)
  const small = gapShape(3000, 2000)
  ok(
    near(big.perOrder ?? 0, small.perOrder ?? 0, 0.001),
    'A PER-ORDER ERROR HOLDS ITS PER-ORDER SIZE while the total falls with volume',
    `${big.perOrder} vs ${small.perOrder}`
  )

  const bigPct = gapShape(9000, 6000)
  const smallPct = gapShape(1000, 2000)
  ok(
    !near(bigPct.perOrder ?? 0, smallPct.perOrder ?? 0, 0.05),
    'while a percentage error does NOT — which is what separates the two causes',
    `${bigPct.perOrder} vs ${smallPct.perOrder}`
  )
  ok(gapShape(100, 0).perOrder === null, 'and a window with no orders states no per-order figure')
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. a night nobody set a rate for is reported, in money ===')
// ---------------------------------------------------------------------------
{
  const days: any[] = [
    { streamDate: '2026-07-20', netSales: 60_000, grossSales: 67_453, whatnotFee: -5400, processingFee: -2053, cogs: -20_000, netProfit: 40_000, feeSaleCount: 900, rateBreakdown: [{ rate: 0.04, grossSales: 67_453 }] },
    { streamDate: '2026-07-21', netSales: 40, grossSales: 45, whatnotFee: -3, processingFee: -2, cogs: 0, netProfit: 40, feeSaleCount: 4, rateBreakdown: [{ rate: 0.08, grossSales: 45 }] }
  ]
  // A period covering only the quiet night.
  const periods: any[] = [
    {
      id: 'p1', fromDate: '2026-07-21', toDate: '2026-07-21', rate: 0.04,
      taxRate: DEFAULT_FEE_RATES.taxRate, processingRate: DEFAULT_FEE_RATES.processingRate,
      processingFlatCents: 30, scope: 'all', note: 'Real terms', createdAt: '', updatedAt: ''
    }
  ]
  const t = reconTotals(reconRows(days, periods))
  ok(t.uncoveredDays === 1, 'the uncovered night is counted', String(t.uncoveredDays))
  ok(
    t.uncoveredNetPaid === 60_000,
    'AND SIZED IN MONEY — $60,000 uncovered, not "one night". A count cannot tell a ' +
      'footnote from the whole discrepancy',
    `$${t.uncoveredNetPaid.toLocaleString()}`
  )
  const covered = reconRows(days, periods).find((r: any) => r.day === '2026-07-21')
  const bare = reconRows(days, periods).find((r: any) => r.day === '2026-07-20')
  ok(covered?.covered === true && covered?.periodNote === 'Real terms', 'the covered night names its period')
  ok(bare?.covered === false, 'and the other says plainly that nothing covered it')
  ok(
    reconInRange(reconRows(days, periods), '2026-07-21', '2026-07-21').length === 1,
    'the window filter is inclusive at both ends'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 5. the rate can depend on WHAT WAS SOLD — through the real store ===')
// ---------------------------------------------------------------------------
ok(scopeForBucket('sale') === 'break_spots', 'a break spot prices as a break spot')
ok(scopeForBucket('product_sale') === 'whole_products', 'and a sealed box as a whole product')

{
  // Two periods over the SAME nights: 8% generally, 4% on sealed product.
  const general = saveRatePeriod(
    { fromDate: '2026-07-01', toDate: '2026-07-31', rate: 0.08, taxRate: DEFAULT_FEE_RATES.taxRate, processingRate: DEFAULT_FEE_RATES.processingRate, processingFlatCents: 30, scope: 'all', note: 'Standard' },
    null
  )
  ok(general.ok, 'a general period saves', general.ok ? '' : general.error)

  const sealed = saveRatePeriod(
    { fromDate: '2026-07-01', toDate: '2026-07-31', rate: 0.04, taxRate: DEFAULT_FEE_RATES.taxRate, processingRate: DEFAULT_FEE_RATES.processingRate, processingFlatCents: 30, scope: 'whole_products', note: 'Sealed' },
    null
  )
  ok(
    sealed.ok,
    'AND A NARROWER ONE OVER THE SAME DATES IS ALLOWED — an exception should not ' +
      'require carving up the calendar to express',
    sealed.ok ? '' : sealed.error
  )

  const clash = saveRatePeriod(
    { fromDate: '2026-07-10', toDate: '2026-07-12', rate: 0.06, taxRate: DEFAULT_FEE_RATES.taxRate, processingRate: DEFAULT_FEE_RATES.processingRate, processingFlatCents: 30, scope: 'all', note: 'Clash' },
    null
  )
  ok(
    !clash.ok,
    'while two periods covering the SAME thing on the same days are still refused',
    clash.ok ? 'it saved' : ''
  )
  ok(
    !clash.ok && String(clash.error).includes('everything'),
    'and the refusal names what the existing one covers',
    clash.ok ? '' : String(clash.error)
  )

  const periods = listRatePeriods()
  ok(
    coveringRatePeriod(periods, '2026-07-15', 'whole_products')?.rate === 0.04,
    'THE NARROWER PERIOD WINS for what it names'
  )
  ok(
    coveringRatePeriod(periods, '2026-07-15', 'break_spots')?.rate === 0.08,
    'and the general one still answers for everything else'
  )
  ok(
    effectiveFeeRates(periods, '2026-07-15', 'whole_products').commissionRate === 0.04,
    'effectiveFeeRates resolves the scope, not just the day'
  )
  ok(
    effectiveFeeRates(periods, '2026-08-15', 'whole_products').commissionRate ===
      DEFAULT_COMMISSION_RATE,
    'and a day outside every period still falls back to the built-in rate'
  )
  ok(
    rateForDate('2026-07-15', 'whole_products').commissionRate === 0.04,
    'the store’s own reader takes a scope too'
  )
}

{
  // Now prove the PRICING uses it, not just the resolver. This is the half a
  // pure test cannot reach: a rate that resolves perfectly and is never handed
  // to the code that prices rows is exactly the shape of defect this repo has
  // shipped before.
  /**
   * LOCAL instants and Whatnot's own date format, both copied from
   * `tests/whatnotFees.test.ts`.
   *
   * Neither is incidental. A row's timestamp is parsed as a local wall clock, so
   * building it from `Date.UTC` puts every row hours outside the session window
   * and the whole night lands unattributed — which reads on this test as
   * "revenue is zero" rather than as "the dates are wrong". It cost a debugging
   * pass to find once already.
   */
  const at = (day: number, hour: number, minute = 0, second = 0): Date =>
    new Date(2026, 6, day, hour, minute, second)
  const s = createSession(
    { title: 'Mixed night', startedAt: at(15, 19).toISOString(), endedAt: at(15, 23).toISOString() },
    null
  )
  ok(s.ok, 'a show is logged', s.ok ? '' : s.error)

  const whatnotDate = (d: Date): string => {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const h24 = d.getHours()
    const h = h24 % 12 === 0 ? 12 : h24 % 12
    const p = (n: number): string => String(n).padStart(2, '0')
    return (
      `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ` +
      `${h}:${p(d.getMinutes())}:${p(d.getSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`
    )
  }
  const head =
    'Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date'
  const line = (when: Date, amount: number, message: string, order: string): string =>
    [
      `"${whatnotDate(when)}"`,
      `$${amount.toFixed(2)}`,
      '2041799396',
      order,
      message,
      'completed',
      'SALES',
      `"${whatnotDate(when)}"`
    ].join(',')

  const SPOT = 'Earnings for selling a 1x 2026 FINEST BASEBALL HOBBY BOX- Break #3 - Boston Red Sox'
  const BOX = 'Earnings for selling a 2025 Topps Inception Baseball Hobby Box'
  const csv =
    [
      head,
      line(at(15, 20, 1), 100.0, SPOT, 'o1'),
      line(at(15, 20, 2), 100.0, SPOT, 'o2'),
      line(at(15, 20, 3), 500.0, BOX, 'o3')
    ].join('\r\n') + '\r\n'

  const path = join(DIR, 'mixed.csv')
  writeFileSync(path, csv, 'utf8')
  const imported = importLedger(path, null)
  ok(imported.ok, 'the mixed night imports', imported.ok ? '' : imported.error)

  const view = streamingFinanceView()
  const day = view.days.find((d: any) => d.streamDate === streamDateOf(at(15, 20, 1).toISOString()))
  ok(!!day, 'and lands on one business day')

  if (day) {
    const periods = listRatePeriods()
    const spotRates = effectiveFeeRates(periods, day.streamDate, 'break_spots')
    const boxRates = effectiveFeeRates(periods, day.streamDate, 'whole_products')
    const expected = computeFees([
      { netCents: 10_000, rates: spotRates },
      { netCents: 10_000, rates: spotRates },
      { netCents: 50_000, rates: boxRates }
    ])

    ok(
      Math.abs(day.grossSales - expected.grossSales) < 0.02,
      'EACH ROW WAS PRICED UNDER ITS OWN SCOPE — the sealed box at 4%, the spots at 8%',
      `${day.grossSales} vs ${expected.grossSales}`
    )
    ok(
      Math.abs(day.totalFees - expected.totalFees) < 0.02,
      'and the day’s fees are the rows’ fees, to the cent'
    )
    ok(
      day.rateBreakdown.length === 2,
      'the day reports BOTH sets of terms rather than a blended percentage nobody configured',
      JSON.stringify(day.rateBreakdown?.map((r: any) => r.rate))
    )
    // The one that proves the scope is really reaching the pricing: at a single
    // rate for everything, the gross would be a different number entirely.
    const flat8 = computeFees([
      { netCents: 10_000, rates: spotRates },
      { netCents: 10_000, rates: spotRates },
      { netCents: 50_000, rates: spotRates }
    ])
    ok(
      Math.abs(day.grossSales - flat8.grossSales) > 10,
      'AND IT IS NOT WHAT ONE RATE FOR THE WHOLE NIGHT WOULD HAVE PRODUCED',
      `${day.grossSales} vs ${flat8.grossSales} at one rate`
    )
  }
}

{
  const bad = validateRatePeriod({
    fromDate: '2026-07-01', toDate: null, rate: 0.08,
    taxRate: DEFAULT_FEE_RATES.taxRate, processingRate: DEFAULT_FEE_RATES.processingRate,
    processingFlatCents: 30, scope: 'coins' as any, note: ''
  })
  ok(!!bad, 'an unknown scope is refused rather than widened to everything', String(bad))
  ok(
    overlappingRatePeriod(
      [{ id: 'a', fromDate: '2026-07-01', toDate: '2026-07-31', scope: 'all' } as any],
      { fromDate: '2026-07-10', toDate: '2026-07-12', scope: 'break_spots' },
      undefined
    ) === null,
    'and differing scopes do not collide'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. the identity survives every rate and every scope ===')
// ---------------------------------------------------------------------------
{
  let broken = 0
  for (const rate of [0, 0.02, 0.04, 0.06, 0.08, 0.12, 0.2]) {
    for (const flat of [0, 30, 50]) {
      for (const net of [1, 59, 1000, 12_48, 143_19, 1_000_00]) {
        const fee = deriveSaleFee(net, terms(rate, flat))
        if (fee.grossCents + fee.whatnotFeeCents + fee.processingFeeCents !== fee.netCents) {
          broken += 1
        }
      }
    }
  }
  ok(
    broken === 0,
    'GROSS + COMMISSION + PROCESSING === NET on every rate, flat charge and amount tried',
    `${broken} broken`
  )
}

{
  const view = streamingFinanceView()
  let bad = 0
  for (const d of view.days) {
    const sections = buildPnl(d)
    if (Math.abs(pnlChecksum(sections) - d.netProfit) > 0.005) bad += 1
  }
  ok(
    bad === 0,
    'and every statement still adds up to its own bottom line after all of this',
    `${bad} of ${view.days.length} days`
  )
}


// ---------------------------------------------------------------------------
console.log('\n=== 10. the one line Streaming keeps after the panels moved ===')
// ---------------------------------------------------------------------------
/**
 * The upload box and the import history moved to Admin, on the owner's ask that
 * an upload should just land rather than sit on the screen that reports the
 * money. Streaming keeps a single line — and BOTH that line and the Admin tile
 * are built from `importStanding`, so the two cannot describe the same imports
 * differently. A pointer saying all is well above a tile listing four unreadable
 * rows is the failure this shares one function to prevent.
 */
{
  const { describeImportStanding, importStanding } = require('../src/shared/financeStreaming')
  const imp = (over: any = {}): any => ({
    id: 'i', filename: 'ledger.csv', rowsParsed: 100, rowsImported: 100,
    rowsDuplicate: 0, rowsRepaired: 0, rowsQuarantined: 0, attributedRows: 100,
    unattributedRows: 0, unattributedAmount: 0, firstOccurredAt: null,
    lastOccurredAt: null, warnings: [], createdAt: '2026-08-01T00:00:00.000Z',
    createdBy: null, ...over
  })

  const none = importStanding([])
  ok(none.importCount === 0 && none.lastImportAt === null, 'no imports reads as none')
  ok(!none.needsAttention, 'AND IS NOT AN ALARM — an empty state is not a problem')
  ok(
    describeImportStanding(none) === 'No ledger has been uploaded yet',
    'and says so in words a person can act on',
    describeImportStanding(none)
  )

  const clean = importStanding([imp({ createdAt: '2026-08-01T00:00:00.000Z' }), imp({ id: 'j', rowsImported: 50, createdAt: '2026-08-09T00:00:00.000Z' })])
  ok(clean.importCount === 2 && clean.rowsImported === 150, 'rows are summed across every import', JSON.stringify(clean))
  ok(
    clean.lastImportAt === '2026-08-09T00:00:00.000Z',
    'THE NEWEST UPLOAD IS THE ONE NAMED, whatever order the list arrived in',
    String(clean.lastImportAt)
  )
  ok(!clean.needsAttention, 'a clean pair of imports stays quiet')

  const cut = importStanding([imp({ rowsQuarantined: 4 })])
  ok(
    cut.needsAttention,
    'QUARANTINED ROWS RAISE IT — those are rows no parser could read, which is ' +
      'money missing from the P&L rather than a cosmetic complaint'
  )
  ok(
    describeImportStanding(cut).includes('4 rows could not be read'),
    'and they are named separately from the rows that landed, never added to them',
    describeImportStanding(cut)
  )

  const warned = importStanding([imp({ warnings: ['A vacuuming session'] })])
  ok(warned.needsAttention && warned.withWarnings === 1, 'so does a warning on an import')
  ok(
    describeImportStanding(importStanding([imp()])) === '1 upload · 100 rows',
    'and a single healthy import is one short sentence with no alarm in it',
    describeImportStanding(importStanding([imp()]))
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
