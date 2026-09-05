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
const {
  EARNING_LINES,
  FEE_LINES,
  fitFromGross,
  gapShape,
  grossFitVerdict,
  modelDivisor,
  payoutCheck,
  solveRatesFor,
  statementInputFromRaw,
  statementTotals
} = require('../src/shared/statementFit')
const {
  listStatements,
  saveStatement,
  validateStatement
} = require('../src/main/db/whatnotStatements')
const {
  checkWindow,
  ledgerParts,
  pinTermsFor,
  reconInRange,
  reconRows,
  reconTotals,
  revenueStanding
} = require('../src/shared/pnlRecon')
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


console.log('\n=== the payout check: is the app holding the right ORDERS at all ===')
// ---------------------------------------------------------------------------
/**
 * THE REAL JULY, from the owner's own statement, pinned as a fixture.
 *
 * He sent it beside a screen reading $24k higher: "the things I am uploading is
 * what we get in our account, so that is the most important part, since it is
 * that minus COGS to profit. But why is the streaming fees $5,000 less and
 * revenue $22,000 more?"
 *
 * ## Both gaps were real, and they had DIFFERENT causes
 *
 * The fee gap is a rate: the app applied 5.26% commission where the month's
 * blended rate was 6.22%. That is what a fitted commission is for.
 *
 * The revenue gap is not, and this is the point of the whole section. Revenue is
 * net grossed up, so if the NET is wrong no rate can fix it — and the net was
 * wrong: the ledger held $28.6k more than Whatnot paid out. `fitFromGross`
 * correctly refused, returning a NEGATIVE commission, but a negative rate says
 * "these cannot both be right" without saying which one to go and look at.
 *
 * The payout comparison says which. Both its sides are RECORDED — the ledger's
 * Amount column and the money that actually moved — so it contains no fee
 * schedule and cannot be wrong for a fee schedule's reasons.
 */
{
  // Straight off the July statement.
  const SALES = 411_575.0
  const PAYOUT = 369_362.53
  const STMT_COMMISSION = 25_584.76
  const STMT_PROCESSING = 15_013.54
  // What the app showed for the same window.
  const APP_REVENUE = 436_029.79
  const APP_COMMISSION = 22_938.75
  const APP_PROCESSING = 15_135.61
  const APP_NET = APP_REVENUE - APP_COMMISSION - APP_PROCESSING
  const ORDERS = 6_123

  // WHAT THE LEDGER HOLDS, on the same footing as the payout.
  //
  // The statement lists $42,839.24 of fees against $40,598.30 of commission and
  // processing, so $2,240.94 is postage, boosts and refunds — rows the app keeps
  // in their own buckets and OUTSIDE netSales. Whatnot had already taken them
  // off before it paid, so they come off this side too before the two figures
  // are compared. Tips and adjustments ($614.98) go the other way for the same
  // reason. That is what ReconRow.ledgerNet does on real days; here the terms
  // are written out so the fixture shows its working.
  const OTHER_COSTS = 2_240.94
  const TIPS_AND_ADJ = 614.98
  const APP_LEDGER = APP_NET - OTHER_COSTS + TIPS_AND_ADJ

  const check = payoutCheck(APP_LEDGER, PAYOUT)
  ok(
    check.gap > 26_000 && check.gap < 27_500,
    'THE LEDGER HELD ~$27k MORE THAN WHATNOT PAID OUT — the finding neither the revenue nor the fee gap could name',
    String(check.gap)
  )
  ok(
    payoutCheck(APP_NET, PAYOUT).gap - check.gap > 1_600,
    'AND IT IS SMALLER THAN THE SALE ROWS ALONE SUGGEST — the first cut of this check compared a ' +
      'payout with netSales and charged the app $1.6k for its own postage and boosts',
    `${payoutCheck(APP_NET, PAYOUT).gap} vs ${check.gap}`
  )
  ok(
    check.material === true && /MORE than this statement paid out/.test(check.sentence),
    'and it is called out as too big to be timing or an adjustment',
    check.sentence
  )
  ok(
    /window or the rows/.test(check.sentence) && /payout cycle/.test(check.sentence),
    'naming the two things worth checking rather than offering to re-price the month',
    check.sentence
  )

  // The fit, on the same numbers, cannot help — and says so.
  const july = fitFromGross(
    SALES,
    { netPaid: APP_NET, derivedRevenue: APP_REVENUE, orders: ORDERS },
    { processingRate: 0.029, taxRate: 0.0518, processingFlatCents: 30 }
  )
  ok(
    july.solvable === false && july.fittedCommissionRate < 0,
    'THE FIT REFUSES: no commission reproduces those sales from that net, because the net is too high',
    String(july.fittedCommissionRate)
  )
  ok(
    Math.abs(july.revenueGap - 24_454.79) < 0.01,
    'and the revenue gap it reports is the $24.5k the owner saw',
    String(july.revenueGap)
  )
  ok(
    Math.abs(APP_COMMISSION + APP_PROCESSING - (STMT_COMMISSION + STMT_PROCESSING) + 2_523.94) < 0.01,
    'while the like-for-like fee gap is $2.5k, not the $4.8k the tile suggested — the rest is shipping and refunds the app does not model',
    String(APP_COMMISSION + APP_PROCESSING - (STMT_COMMISSION + STMT_PROCESSING))
  )

  // --- the shapes the check has to tell apart -------------------------------
  const close = payoutCheck(371_600.0, PAYOUT)  // 0.6% out
  ok(
    close.material === false && /[Nn]othing here needs chasing/.test(close.sentence),
    'A GAP THE SIZE OF TIMING AND ROUNDING IS NOT RAISED — 0.6% is the ordinary shape of a real month',
    close.sentence
  )
  ok(
    payoutCheck(PAYOUT, PAYOUT).gap === 0 &&
      /agree exactly/.test(payoutCheck(PAYOUT, PAYOUT).sentence),
    'an exact match says so plainly'
  )

  const short = payoutCheck(300_000.0, PAYOUT)
  ok(
    short.material === true &&
      short.gap < 0 &&
      /nights are missing from the import/.test(short.sentence),
    'AND A LEDGER HOLDING LESS POINTS THE OTHER WAY — missing nights, not extra ones',
    short.sentence
  )

  // The threshold is a judgement and is pinned so it cannot drift silently.
  ok(
    payoutCheck(PAYOUT * 1.02, PAYOUT).material === false &&
      payoutCheck(PAYOUT * 1.0201, PAYOUT).material === true,
    'the line is drawn at 2% of the payout, exactly'
  )
}


// ---------------------------------------------------------------------------
console.log('\n=== the payout is checked against EVERY ledger row, not the sale rows ===')
// ---------------------------------------------------------------------------
/**
 * THE DEFECT THIS PINS, which shipped and was caught by reading it back.
 *
 * `netPaid` is the sale rows alone. That is exactly right for fitting a
 * commission — the commission was charged on those rows and nothing else — and
 * exactly wrong for checking a payout, because a payout has the postage, the
 * boosts, the refunds and the tips in it already.
 *
 * Compare a payout with `netPaid` and the app is charged for its own other
 * buckets: it reports a discrepancy the size of a month's postage on a month
 * where nothing whatever is wrong. A heavy-shipping month would have read as a
 * $12,000 problem on a ledger that reconciles to the cent.
 *
 * `giveawayLoss` is the one term stripped back out, because it is the only
 * figure on a day that never was a ledger row — a prize somebody typed in, which
 * Whatnot neither saw nor deducted.
 */
{
  // One month. Every bucket populated, and the payout is what such a month
  // would actually pay: sales, plus tips and a bonus, less postage, a boost and
  // a reversal. The giveaway prize is a cost the OWNER carried, not Whatnot.
  const NET_SALES = 400_000
  const TIPS = 1_500
  const BONUSES = 800
  const POSTAGE = -12_000        // netShipping: subsidy + charges + giveaway + refunds
  const BOOST = -3_000
  const REVERSALS = -900
  const GIVEAWAY_LOSS = -5_000   // typed in, never a ledger row

  const netRevenue = NET_SALES + TIPS + BONUSES
  const TRUE_PAYOUT = netRevenue + POSTAGE + BOOST + REVERSALS   // 386,400

  const days: any[] = [
    {
      streamDate: '2026-07-15',
      netSales: NET_SALES,
      grossSales: 449_691.86,
      whatnotFee: -35_975.35,
      processingFee: -13_716.51,
      cogs: -180_000,
      netProfit: 200_000,
      feeSaleCount: 6_000,
      rateBreakdown: [{ rate: 0.08, grossSales: 449_691.86 }],
      netAfterCosts: TRUE_PAYOUT + GIVEAWAY_LOSS,
      giveawayLoss: GIVEAWAY_LOSS
    }
  ]
  const t = reconTotals(reconRows(days, []))

  ok(
    t.netPaid === NET_SALES,
    'netPaid is still the SALE ROWS ALONE — the fit needs that and must not change',
    String(t.netPaid)
  )
  ok(
    t.ledgerNet === TRUE_PAYOUT,
    'AND ledgerNet IS EVERY LEDGER ROW — tips and bonuses in, postage and boosts and reversals off',
    `${t.ledgerNet} vs ${TRUE_PAYOUT}`
  )
  ok(
    t.ledgerNet !== t.netPaid && t.ledgerNet - t.netPaid === TIPS + BONUSES + POSTAGE + BOOST + REVERSALS,
    'differing by exactly the buckets netSales leaves out, and by nothing else',
    String(t.ledgerNet - t.netPaid)
  )
  ok(
    t.ledgerNet !== t.netPaid + POSTAGE + BOOST + REVERSALS + TIPS + BONUSES + GIVEAWAY_LOSS,
    'THE TYPED-IN GIVEAWAY PRIZE IS STRIPPED — Whatnot never saw it, so it cannot be missing from a payout'
  )

  // The whole point: this month reconciles, and must be reported as reconciling.
  const right = payoutCheck(t.ledgerNet, TRUE_PAYOUT)
  ok(
    right.gap === 0 && right.material === false,
    'A MONTH THAT RECONCILES TO THE CENT IS REPORTED AS RECONCILING',
    right.sentence
  )
  const wrong = payoutCheck(t.netPaid, TRUE_PAYOUT)
  ok(
    wrong.material === true && Math.abs(wrong.gap - 13_600) < 0.01,
    'WHILE THE SALE ROWS ALONE WOULD HAVE CRIED WOLF over $13,600 of the app\'s own postage and boosts',
    `${wrong.gap} — ${wrong.sentence}`
  )
}


// ---------------------------------------------------------------------------
console.log('\n=== 11. a window that cannot be compared with a statement is REFUSED ===')
// ---------------------------------------------------------------------------
/**
 * `RatesTab` starts both date boxes at useState(''), and a blank end means NO
 * FILTER. So every answer both revenue panels have ever given was a figure off
 * one month's statement set against the entire ledger. `checkWindow` is the gate
 * that ends that, and it refuses rather than guessing a month nobody chose.
 */
{
  const blank = checkWindow('', '')
  ok(
    blank.bounded === false && blank.days === 0,
    'THE SHIPPED DEFAULT — blank/blank — IS NOT A WINDOW, and says so',
    JSON.stringify(blank)
  )
  ok(
    /every night ever imported/.test(String(blank.problem)),
    'and the reason is the owner-facing one, not a validation message',
    String(blank.problem)
  )

  const noStart = checkWindow('', '2026-07-31')
  const noEnd = checkWindow('2026-07-01', '')
  ok(
    noStart.bounded === false && noEnd.bounded === false,
    'one blank end is still no window — half a period cannot cover a statement'
  )
  ok(
    /no start date/.test(String(noStart.problem)) && /no end date/.test(String(noEnd.problem)),
    'and each names the end that is actually missing',
    `${noStart.problem} / ${noEnd.problem}`
  )

  const back = checkWindow('2026-07-31', '2026-07-01')
  ok(
    back.bounded === false && /falls after the end/.test(String(back.problem)),
    'a reversed pair covers no nights at all and is told so plainly',
    String(back.problem)
  )

  const junk = checkWindow('07/01/26', '2026-07-31')
  ok(
    junk.bounded === false && /not a day this app can read/.test(String(junk.problem)),
    'a date the app cannot read is refused rather than silently ignored',
    String(junk.problem)
  )
  ok(
    checkWindow('2026-02-30', '2026-03-31').bounded === false,
    'INCLUDING A WELL-SHAPED DAY THAT DOES NOT EXIST — Date.UTC would roll it into March'
  )

  const reasons = new Set(
    [blank, noStart, noEnd, back, junk].map((w: any) => String(w.problem))
  )
  ok(reasons.size === 5, 'every refusal gives its own reason — none is a generic "invalid"')

  const july = checkWindow('2026-07-01', '2026-07-31')
  ok(july.bounded === true && july.problem === null, 'a real month is a window')
  ok(
    july.days === 31,
    'AND BOTH ENDS COUNT — July is 31 days, not 30. Every window in this app is inclusive',
    String(july.days)
  )
  ok(
    checkWindow('2026-07-15', '2026-07-15').days === 1,
    'one day is one day, not zero'
  )
  ok(
    checkWindow('2026-03-01', '2026-03-31').days === 31,
    'and a month spanning the daylight-saving change is still 31 — parsed at UTC noon',
    String(checkWindow('2026-03-01', '2026-03-31').days)
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 12. THE ALL-TIME DEFAULT WAS LYING — what the panels actually compared ===')
// ---------------------------------------------------------------------------
/**
 * THE ASSERTION THAT PINS THE SHIPPED BUG.
 *
 * Two months in the ledger. The panel's own default window — blank/blank —
 * filters nothing, so a payout or a sales figure typed off July's statement was
 * compared against June AND July. The gap that comes back is not a fee error and
 * is not a rate error; it is the rest of the ledger, reported as a discrepancy.
 *
 * `reconInRange` is left exactly as it is: blank-means-open is correct for the
 * night-by-night table, which describes what is stored. It is `checkWindow` that
 * must stop the two panels asserting agreement across it.
 */
{
  const JUNE_NET = 250_000
  const JULY_NET = 300_000
  const days: any[] = [
    {
      streamDate: '2026-06-14', netSales: JUNE_NET, grossSales: 281_000,
      whatnotFee: -22_480, processingFee: -8_520, cogs: -120_000, netProfit: 130_000,
      feeSaleCount: 3_500, rateBreakdown: [{ rate: 0.08, grossSales: 281_000 }],
      netAfterCosts: JUNE_NET, giveawayLoss: 0
    },
    {
      streamDate: '2026-07-18', netSales: JULY_NET, grossSales: 337_200,
      whatnotFee: -26_976, processingFee: -10_224, cogs: -150_000, netProfit: 150_000,
      feeSaleCount: 4_200, rateBreakdown: [{ rate: 0.08, grossSales: 337_200 }],
      netAfterCosts: JULY_NET, giveawayLoss: 0
    }
  ]
  const rows = reconRows(days, [])

  const allTime = reconTotals(reconInRange(rows, '', ''))
  const july = reconTotals(reconInRange(rows, '2026-07-01', '2026-07-31'))

  ok(
    allTime.netPaid === JUNE_NET + JULY_NET,
    'the panel default sweeps up every night ever imported',
    String(allTime.netPaid)
  )
  ok(
    july.netPaid === JULY_NET,
    'while the month somebody meant holds only July',
    String(july.netPaid)
  )
  ok(
    allTime.netPaid - july.netPaid === JUNE_NET,
    'THE TWO DIFFER BY A WHOLE MONTH — $250,000 of June, reported as July disagreeing',
    `$${(allTime.netPaid - july.netPaid).toLocaleString()}`
  )
  ok(
    allTime.grossSales - july.grossSales > 100_000 &&
      allTime.ledgerNet - july.ledgerNet === JUNE_NET,
    'and every column the panels read moves with it — revenue, and the payout figure too',
    `${allTime.grossSales - july.grossSales} / ${allTime.ledgerNet - july.ledgerNet}`
  )

  // A payout typed off July's statement, checked the way the panel checked it.
  const asShipped = payoutCheck(allTime.ledgerNet, JULY_NET)
  const asMeant = payoutCheck(july.ledgerNet, JULY_NET)
  ok(
    asShipped.material === true && asMeant.gap === 0 && asMeant.material === false,
    'A MONTH THAT RECONCILES TO THE CENT READ AS AN 83% DISCREPANCY on the default window',
    `${(asShipped.gapShare * 100).toFixed(1)}% vs ${(asMeant.gapShare * 100).toFixed(1)}%`
  )
  ok(
    checkWindow('', '').bounded === false && checkWindow('2026-07-01', '2026-07-31').bounded,
    'which is exactly the window checkWindow now refuses, and the one it allows'
  )
  ok(
    reconInRange(rows, '', '').length === 2,
    'reconInRange is UNCHANGED — blank still means open, because the table describes what is stored'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 13. what the app derives against what Whatnot actually stated ===')
// ---------------------------------------------------------------------------
{
  const JULY = checkWindow('2026-07-01', '2026-07-31')
  const DERIVED = 331_000

  const never = revenueStanding(JULY, [], DERIVED)
  ok(
    never.state === 'never' && never.statedGross === null,
    'no saved figure at all is its own state — it asks for a number, not for new dates',
    never.sentence
  )

  // A fortnight's figure, and a window covering the whole month.
  const halfMonth: any[] = [
    { fromDate: '2026-07-01', toDate: '2026-07-15', statedGross: 150_000 }
  ]
  const stale = revenueStanding(JULY, halfMonth, DERIVED)
  ok(
    stale.state === 'stale' && stale.statement === null && stale.gap === null,
    'PARTIAL OVERLAP IS NOT COVERAGE — 1-15 July does not answer a question about all of July',
    stale.sentence
  )
  ok(
    !/\$/.test(stale.sentence),
    'and it prints no money, because half a month set against a whole one invents the gap',
    stale.sentence
  )

  // The panel's own default window, with figures on file.
  const allTime = revenueStanding(checkWindow('', ''), [
    { fromDate: '2026-06-01', toDate: '2026-06-30', statedGross: 260_000 },
    { fromDate: '2026-08-01', toDate: '2026-08-31', statedGross: 280_000 }
  ] as any, DERIVED)
  ok(
    allTime.state === 'stale' && allTime.statedGross === null,
    'AN ALL-TIME WINDOW CAN NEVER BE COVERED — there are no ends for a statement to contain',
    allTime.sentence
  )
  ok(
    !/\$/.test(allTime.sentence) && !/540/.test(allTime.sentence),
    'AND THE STATEMENTS ARE NEVER SUMMED — $540,000 is a figure nobody stated, for a period ' +
      'nobody reported on, and July is missing from the middle of it',
    allTime.sentence
  )

  const stated: any[] = [{ fromDate: '2026-07-01', toDate: '2026-07-31', statedGross: 307_000 }]
  const high = revenueStanding(JULY, stated, DERIVED)
  ok(
    high.state === 'disagrees' && high.gap === 24_000,
    'THE $24k THE OWNER HAS BEEN CHASING, once the window is honest',
    `${high.gap} — ${high.sentence}`
  )
  ok(
    /higher,/.test(high.sentence) && /307,000\.00/.test(high.sentence),
    'the sentence names the stated figure and which way the app reads',
    high.sentence
  )
  ok(
    /331,000\.00/.test(high.sentence),
    'AND PRINTS THE DERIVED FIGURE IT WAS HANDED — never a re-derived one that would ' +
      'contradict the tile it sits under',
    high.sentence
  )
  ok(
    /[Cc]ompared/.test(high.sentence) && !/reconcil/i.test(high.sentence),
    'it says COMPARED and never "reconciled" — the app’s July is July’s SHOWS, not July’s rows',
    high.sentence
  )

  const low = revenueStanding(JULY, stated, 280_000)
  ok(
    low.state === 'disagrees' && low.gap === -27_000 && /lower,/.test(low.sentence),
    'and a ledger reading UNDER the stated figure points the other way, not the same way',
    low.sentence
  )

  // The threshold is the one already exported for the payout check, not a copy.
  const close = revenueStanding(JULY, stated, 307_000 * 1.02)
  const over = revenueStanding(JULY, stated, 307_000 * 1.0201)
  ok(
    close.state === 'compared' && over.state === 'disagrees',
    'the line is PAYOUT_GAP_LIMIT — 2% — imported rather than restated, so it cannot drift apart',
    `${(close.gapShare * 100).toFixed(3)}% vs ${(over.gapShare * 100).toFixed(3)}%`
  )
  ok(
    !/reconcil/i.test(close.sentence) && /[Cc]ompared/.test(close.sentence),
    'agreement is reported as compared too — evidence, never proof'
  )

  // A quarter and a month both contain July.
  const both: any[] = [
    { fromDate: '2026-07-01', toDate: '2026-09-30', statedGross: 900_000 },
    { fromDate: '2026-07-01', toDate: '2026-07-31', statedGross: 307_000 }
  ]
  const narrow = revenueStanding(JULY, both, DERIVED)
  ok(
    narrow.statedGross === 307_000,
    'NARROWEST WINS — the July figure answers a July question; the quarter only bounds it',
    String(narrow.statedGross)
  )
  ok(
    revenueStanding(JULY, [both[0]] as any, DERIVED).statedGross === 900_000,
    'though a quarter alone still covers the month, and is used when it is all there is'
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 14. the terms are pinned to the night that carried the money ===')
// ---------------------------------------------------------------------------
/**
 * `RatesTab` pinned off the window's LAST DAY, falling back to TODAY when the
 * box was blank — and the box defaulted to blank. So a fit on July's money was
 * being held to whatever rates are in force this afternoon. The main process
 * pinned off the heaviest night. Two answers to one question; this is the one.
 */
{
  const HEAVY = { processingRate: 0.029, taxRate: 0.0518, processingFlatCents: 30 }
  const LIGHT = { processingRate: 0.035, taxRate: 0.0518, processingFlatCents: 0 }
  // Newest first, the way reconRows returns them — so the LAST DAY of the window
  // is the quiet night, and the heaviest is three weeks earlier.
  const rows: any[] = [
    { day: '2026-07-28', netPaid: 40 },
    { day: '2026-07-04', netPaid: 60_000 }
  ]
  const termsFor = (day: string): any => (day === '2026-07-04' ? HEAVY : LIGHT)

  const pin = pinTermsFor(rows, termsFor)
  ok(
    pin.pinnedDay === '2026-07-04' && pin.pinned.processingRate === 0.029,
    'THE $60,000 SATURDAY DECIDES THE TERMS, not the $40 Tuesday that happens to close the month',
    `${pin.pinnedDay} @ ${pin.pinned.processingRate}`
  )
  ok(
    pin.pinned.processingFlatCents === 30 && termsFor(rows[0].day).processingFlatCents === 0,
    'which is a different answer from the one the window’s last day gives — that was the defect'
  )
  ok(
    pin.mixedTerms === true,
    'and a window spanning two sets of card terms says so, rather than passing an average as exact'
  )

  const single = pinTermsFor(
    [{ day: '2026-07-04', netPaid: 60_000 }, { day: '2026-07-05', netPaid: 900 }] as any,
    () => HEAVY
  )
  ok(
    single.mixedTerms === false && single.pinned.processingRate === 0.029,
    'one set of terms across the window is not "mixed"'
  )

  const empty = pinTermsFor([] as any, termsFor, LIGHT)
  ok(
    empty.pinnedDay === null && empty.pinned.processingRate === 0.035,
    'an empty window has no heaviest night, so the caller’s own fallback stands — nothing is ' +
      'being priced, and this must not invent a night'
  )

  // Ties must not depend on the order the rows arrived in.
  const tieA = pinTermsFor([{ day: '2026-07-01', netPaid: 100 }, { day: '2026-07-02', netPaid: 100 }] as any, () => HEAVY)
  const tieB = pinTermsFor([{ day: '2026-07-02', netPaid: 100 }, { day: '2026-07-01', netPaid: 100 }] as any, () => HEAVY)
  ok(
    tieA.pinnedDay === tieB.pinnedDay && tieA.pinnedDay === '2026-07-02',
    'two nights holding identical money break the tie on the date, not on list order',
    `${tieA.pinnedDay} / ${tieB.pinnedDay}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 15. THE TWO SCREENS MUST COMPARE THE SAME QUANTITY ===')
// ---------------------------------------------------------------------------
// Found in review, and it is the failure this whole feature exists to end: the
// Streaming tab fed revenueStanding the P&L revenue SUBTOTAL (gross sales plus
// tips, seller bonuses and unrecognised rows) while Fees & rates fed it gross
// sales. A statement's stated figure is what the window SOLD, so tips were
// counted on one side only and the same document got opposite verdicts on two
// screens.
{
  const july = { from: '2026-07-01', to: '2026-07-31', bounded: true, days: 31, problem: null }
  const stmt = [{ fromDate: '2026-07-01', toDate: '2026-07-31', statedGross: 307000 }]

  // The sales agree with Whatnot to the cent.
  const onSales = revenueStanding(july, stmt, 307000)
  ok(onSales.state === 'compared', 'sales that match the statement read as compared', onSales.state)

  // The same window with $8,000 of tips and bonuses in it. Total revenue is
  // 315,000 — and if THAT is what gets compared, a perfect month reads as broken.
  const onTotalRevenue = revenueStanding(july, stmt, 315000)
  ok(
    onTotalRevenue.state === 'disagrees',
    'AND THE REVENUE SUBTOTAL WOULD READ AS A DISAGREEMENT — 8k of tips is 2.6%, over the 2% limit',
    `${onTotalRevenue.state} ${onTotalRevenue.gapShare}`
  )
  ok(
    onSales.state !== onTotalRevenue.state,
    'so the two figures give OPPOSITE verdicts on one statement — which is why the comparand is pinned',
    `${onSales.state} vs ${onTotalRevenue.state}`
  )
}

// The sentence must name SALES. It sits directly under a tile labelled "Total
// revenue" that shows a LARGER number, and a sentence about "revenue" there
// reads as a claim about the tile it is not describing.
{
  const july = { from: '2026-07-01', to: '2026-07-31', bounded: true, days: 31, problem: null }
  const agreed = revenueStanding(
    july,
    [{ fromDate: '2026-07-01', toDate: '2026-07-31', statedGross: 307000 }],
    307000
  )
  ok(/sales/i.test(agreed.sentence), 'the agreeing sentence says SALES', agreed.sentence)
  ok(
    !/the revenue this app derives/i.test(agreed.sentence),
    'and never calls the compared figure "revenue" — the tile above it means something bigger',
    agreed.sentence
  )
  const none = revenueStanding(july, [], 307000)
  ok(/sales/i.test(none.sentence), 'and so does the never-saved sentence', none.sentence)
}


// ===========================================================================
console.log('\n=== THE MONTH-END SUMMARY, LINE FOR LINE ===')
// ===========================================================================
/*
 * The owner, sending one over: he wants to type what the platform's month-end
 * screen prints, all eleven lines of it, and have the app take it from there.
 *
 * The shape matters more than any single figure. Whatnot prints two lists and a
 * total each — Earnings over Sales, Tips, Other adjustments (+); Fees & costs
 * over Commission, Payment processing, Seller paid shipping, Shipping
 * surcharges, Order refunds, Other adjustments (-) — and the difference between
 * the two totals is the money it actually sent.
 *
 * WHICH IS THE POINT. Of those six fee lines this app models exactly two. The
 * other four are ledger rows it already holds, and so is every line under
 * Earnings. So the split is not bookkeeping: it separates "our commission rate
 * is wrong" from "we are holding the wrong rows", and nothing on any screen
 * could tell those apart before.
 *
 * Figures below are invented. The repo is public and a real month's takings are
 * not something to commit; the SHAPE is what is under test.
 */
const MONTH = {
  fromDate: '2026-04-01',
  toDate: '2026-04-30',
  statedGross: 400000,      // Sales
  statedTips: 100,
  statedOtherIn: 5000,      // Other adjustments (+)   => Earnings 405,100
  statedCommission: 20000,
  statedProcessing: 12000,
  statedShipping: 1500,
  statedSurcharges: 600,
  statedRefunds: 200,
  statedOtherOut: 50        // Fees & costs 34,350     => payout 370,750
}

{
  const t = statementTotals(MONTH)
  ok(t.earnings === 405100, 'Earnings is sales plus tips plus the credits', String(t.earnings))
  ok(t.feesTotal === 34350, 'Fees and costs is the six lines added up', String(t.feesTotal))
  ok(
    t.payout === 370750,
    'AND THE DIFFERENCE IS THE PAYOUT — the one line the app holds its own copy of',
    String(t.payout)
  )
  ok(
    t.modelledFees === 32000,
    'commission and processing are named apart: they are the only two this app guesses',
    String(t.modelledFees)
  )
  ok(t.itemised === true, 'and the statement knows it was itemised')
  ok(t.problem === null, 'with nothing to complain about', String(t.problem))
}

// A TYPED TOTAL THAT DOES NOT MATCH ITS OWN LINES is a keying error, and the
// only cheap moment to catch it is while the document is still open.
{
  const wrong = statementTotals({ ...MONTH, statedFees: 34000 })
  ok(!!wrong.problem, 'the six lines are checked against the total printed above them', String(wrong.problem))
  ok(
    /34,350/.test(wrong.problem || '') && /34,000/.test(wrong.problem || ''),
    'and the sentence quotes both figures so it is obvious which was mistyped',
    String(wrong.problem)
  )
  const right = statementTotals({ ...MONTH, statedFees: 34350 })
  ok(right.problem === null, 'a total that agrees passes silently', String(right.problem))
}

// A DASHBOARD READING states sales alone, and must still work — that is the
// whole reason every line is optional.
{
  const bare = statementTotals({ statedGross: 400000, statedFees: 34350 })
  ok(bare.earnings === 400000, 'with no lines, Earnings is just the sales', String(bare.earnings))
  ok(bare.feesTotal === 34350, 'and the fees total falls back to the one typed', String(bare.feesTotal))
  ok(bare.payout === 365650, 'the payout still comes out', String(bare.payout))
  ok(bare.itemised === false, 'and it knows it was not itemised')
  ok(bare.modelledFees === null, 'with nothing said about which part is modelled', String(bare.modelledFees))
}

// AN EMPTY BOX IS NOT A STATED ZERO. Number('') is 0, and a zero here is a
// claim — "the platform charged nothing under this heading" — which would then
// be fitted against and reported as a fee that vanished.
{
  const none = statementTotals({ statedGross: 1000, statedTips: null, statedCommission: null })
  ok(none.earnings === 1000, 'an absent tips line adds nothing', String(none.earnings))
  ok(none.feesTotal === null, 'and absent fee lines are not a fee of zero', String(none.feesTotal))
  ok(none.payout === null, 'so no payout is claimed either', String(none.payout))
}

console.log('\n--- what it refuses ---')
{
  // The platform prints the fees as amounts taken OFF. A minus in one of those
  // boxes is somebody typing what they think the arithmetic wants.
  const neg = validateStatement({ ...MONTH, statedRefunds: -200 })
  ok(!!neg && /positive/i.test(neg), 'a negative fee line is refused, with the reason', String(neg))

  const bad = validateStatement({ ...MONTH, statedFees: 34000 })
  ok(!!bad && /keyed wrong/i.test(bad), 'and so is a total that fights its own lines', String(bad))

  // Payout is compared against EARNINGS, not sales: a light month with a large
  // credit can legitimately pay out more than it sold, and refusing that would
  // refuse a true document.
  const between = validateStatement({ ...MONTH, statedGross: 100, statedPayout: 200 })
  ok(
    between === null,
    'a payout above SALES but below earnings is allowed — the credits are real money',
    String(between)
  )
  const over = validateStatement({ ...MONTH, statedPayout: 500000 })
  ok(!!over, 'a payout above everything credited is still refused', String(over))
}

console.log('\n--- nothing is lost in transit ---')
// THE FAILURE THIS EXISTS FOR. `statedPayout` was absent from the transport
// handler's object for a release: the column, the type, the validator and the
// read all carried it, so the value was dropped between the form and the store
// and every saved statement came back with a null the check then skipped. No
// error, no warning — just a box the operator filled in that did nothing.
//
// So the mapping lives in the contract and is asserted field by field HERE,
// against a raw object shaped like the form's own state, with every figure a
// string because that is what an <input> yields.
{
  const raw = {
    fromDate: '2026-04-01',
    toDate: '2026-04-30',
    statedGross: '400000',
    statedFees: '34350',
    statedPayout: '370750',
    statedTips: '100',
    statedOtherIn: '5000',
    statedCommission: '20000',
    statedProcessing: '12000',
    statedShipping: '1500',
    statedSurcharges: '600',
    statedRefunds: '200',
    statedOtherOut: '50',
    note: '  April  '
  }
  const mapped = statementInputFromRaw(raw)
  const dropped = [
    'statedGross',
    'statedFees',
    'statedPayout',
    ...EARNING_LINES,
    ...FEE_LINES
  ].filter((k) => mapped[k] === null || mapped[k] === undefined || Number.isNaN(mapped[k]))
  ok(dropped.length === 0, 'EVERY FIGURE ON THE DOCUMENT REACHES THE STORE', dropped.join(', ') || 'none')
  ok(mapped.statedCommission === 20000, 'and as a number, not the string it arrived as', String(mapped.statedCommission))
  ok(mapped.statedOtherOut === 50, 'including the smallest line', String(mapped.statedOtherOut))
  ok(mapped.note === 'April', 'the note is trimmed', JSON.stringify(mapped.note))
  ok(mapped.id === undefined, 'and a blank id means a new row, not an update', String(mapped.id))

  // Empty and absent both stay null, which is the distinction the whole form
  // rests on — Number('') is 0, and a zero is a claim the document never made.
  const sparse = statementInputFromRaw({
    fromDate: '2026-04-01',
    toDate: '2026-04-30',
    statedGross: '1000',
    statedTips: '',
    statedCommission: '80'
  })
  ok(sparse.statedTips === null, 'an empty box is null, not zero', String(sparse.statedTips))
  ok(sparse.statedRefunds === null, 'and so is a box that was never rendered', String(sparse.statedRefunds))
  ok(sparse.statedCommission === 80, 'while the one that was typed comes through', String(sparse.statedCommission))

  // A figure that will not parse must arrive as NaN so the validator refuses it,
  // rather than as a stated zero the fit would then chase.
  const junk = statementInputFromRaw({ fromDate: 'x', toDate: 'y', statedGross: 'four hundred' })
  ok(Number.isNaN(junk.statedGross), 'an unparseable figure arrives as NaN, not as zero', String(junk.statedGross))
  ok(!!validateStatement(junk), 'and is refused', String(validateStatement(junk)))
}

console.log('\n--- it survives the round trip ---')
// The payout field spent a release being dropped between the form and the
// store, silently, because nothing downstream could tell a value that was never
// sent from one that was never typed. Eight more optional fields is eight more
// chances at the same silence.
{
  const saved = saveStatement({ ...MONTH, note: 'April, typed off the summary' }, null)
  ok(saved.ok === true, 'the month saves', saved.error || '')
  const row = listStatements().find((r) => r.fromDate === '2026-04-01')
  ok(!!row, 'and reads back')
  if (row) {
    const missing = [...FEE_LINES, 'statedTips', 'statedOtherIn'].filter(
      (k) => row[k] === null || row[k] === undefined
    )
    ok(missing.length === 0, 'WITH ALL EIGHT LINES INTACT', missing.join(', ') || 'none')
    ok(row.statedCommission === 20000, 'commission survived', String(row.statedCommission))
    ok(row.statedOtherOut === 50, 'and so did the smallest line on the document', String(row.statedOtherOut))
    ok(statementTotals(row).payout === 370750, 'and the payout still comes out of what was stored')

    // A line left blank comes back null, not zero — the distinction the whole
    // form rests on.
    const partial = saveStatement(
      { fromDate: '2026-05-01', toDate: '2026-05-31', statedGross: 1000, statedCommission: 80 },
      null
    )
    ok(partial.ok === true, 'a half-filled statement is ordinary', partial.error || '')
    const may = listStatements().find((r) => r.fromDate === '2026-05-01')
    ok(may && may.statedCommission === 80, 'the line that was typed is there', String(may && may.statedCommission))
    ok(
      may && may.statedTips === null && may.statedRefunds === null,
      'AND THE ONES THAT WERE NOT ARE NULL, not zero',
      may ? `${may.statedTips}/${may.statedRefunds}` : 'no row'
    )
  }
}

// ===========================================================================
console.log('\n=== FROM A STATED MONTH TO THE TERMS THAT PRODUCED IT ===')
// ===========================================================================
/*
 * The owner's rule, in his words: split the gap between projected and actual
 * across the nights "based on the percentage it contributed". Section 1 below
 * shows that solving a rate IS that rule — a night's fee moves by the ratio of
 * the new rate to the old, which is its share of the correction — and section 2
 * is the set of refusals, which are the substance.
 *
 * Invented figures throughout, chosen so the arithmetic is checkable by eye: a
 * month that sold 100,000 at a true 6% commission and a true 2% card charge.
 */
{
  const SALES = 100000
  const COMMISSION = 6000 // 6% of sales
  const PROCESSING = 2100 // 2% of the tax-inclusive total, at 5% tax
  const TAX = 0.05
  // What the ledger holds: sales less the two fee lines.
  const NET = SALES - COMMISSION - PROCESSING

  const app = {
    netPaid: NET,
    // What the app currently derives, at the wrong default 8%: irrelevant to the
    // fit itself, and carried only so the gap can be reported.
    derivedRevenue: 112000,
    derivedCommission: -8960,
    derivedProcessing: -3400,
    orders: 900
  }
  const stmt = {
    fromDate: '2026-04-01',
    toDate: '2026-04-30',
    statedGross: SALES,
    statedCommission: COMMISSION,
    statedProcessing: PROCESSING
  }

  const solved = solveRatesFor(stmt, app, TAX)
  ok(solved.problem === null, 'a month that itemises both modelled lines solves', String(solved.problem))
  ok(!!solved.period, 'and produces terms ready to save')
  if (solved.period) {
    ok(
      Math.abs(solved.period.rate - 0.06) < 1e-9,
      'THE COMMISSION IT SOLVES IS THE ONE THAT WAS CHARGED',
      String(solved.period.rate)
    )
    ok(
      Math.abs(solved.period.processingRate - PROCESSING / (SALES * (1 + TAX))) < 1e-9,
      'and the card rate is solved on the TAX-INCLUSIVE total, as the model charges it',
      String(solved.period.processingRate)
    )
    ok(solved.period.fromDate === '2026-04-01' && solved.period.toDate === '2026-04-30',
      'the period covers exactly the days the document does', `${solved.period.fromDate}..${solved.period.toDate}`)
    ok(solved.period.processingFlatCents === 0, 'with the flat charge pinned at zero', String(solved.period.processingFlatCents))
    ok(solved.period.scope === 'all', 'and applying to everything sold', String(solved.period.scope))
    ok(/Whatnot stated/.test(solved.period.note), 'the note says where it came from', solved.period.note)
  }

  // THE OWNER'S RULE AND THIS RULE ARE THE SAME ARITHMETIC.
  //
  // His: night D takes a share of the delta equal to its share of the projected
  // figure. Ours: every row is re-priced at the solved rate. Work both over a
  // month of three nights and they land on the same per-night fee.
  {
    const nights = [30000, 45000, 25000] // what each night sold, summing to SALES
    const oldRate = 0.08
    const projected = nights.map((v) => v * oldRate)
    const projectedTotal = projected.reduce((a, b) => a + b, 0)
    const actualTotal = COMMISSION
    const delta = actualTotal - projectedTotal

    const ownersWay = projected.map((p) => p + delta * (p / projectedTotal))
    const ratesWay = nights.map((v) => v * (solved.period ? solved.period.rate : 0))

    const same = ownersWay.every((v, i) => Math.abs(v - ratesWay[i]) < 1e-6)
    ok(same, 'SPLITTING THE DELTA BY SHARE AND RE-PRICING AT THE SOLVED RATE AGREE, NIGHT BY NIGHT',
      ownersWay.map((v, i) => `${v.toFixed(2)} vs ${ratesWay[i].toFixed(2)}`).join(' | '))
    ok(
      Math.abs(ratesWay.reduce((a, b) => a + b, 0) - actualTotal) < 1e-6,
      'and the nights add back up to the figure the platform stated',
      String(ratesWay.reduce((a, b) => a + b, 0))
    )
  }
}

console.log('\n--- what it refuses to solve ---')
{
  const base = {
    fromDate: '2026-04-01',
    toDate: '2026-04-30',
    statedGross: 100000,
    statedCommission: 6000,
    statedProcessing: 2100
  }
  const app = { netPaid: 91900, derivedRevenue: 112000, derivedCommission: -8960, derivedProcessing: -3400, orders: 900 }

  // BOTH MODELLED LINES OR NEITHER. A commission fitted from a statement that
  // only gives a combined total swallows the card charge, and the rate looks
  // plausible and reproduces the right revenue for the wrong reason.
  const noSplit = solveRatesFor({ ...base, statedProcessing: null }, app, 0.05)
  ok(!!noSplit.problem && noSplit.period === null, 'a statement without the two lines apart is refused', String(noSplit.problem))
  ok(/commission and payment processing/i.test(noSplit.problem || ''), 'and told exactly what to go and type', String(noSplit.problem))

  // THE WINDOW COMES FIRST. Both sides here are recorded money, so a gap is the
  // wrong set of rows — and re-pricing to close it would bury the real fault.
  const wrongRows = solveRatesFor(base, { ...app, netPaid: 80000 }, 0.05)
  ok(!!wrongRows.problem && wrongRows.period === null, 'A WINDOW THAT DOES NOT TIE IS REFUSED BEFORE ANY RATE IS SPOKEN OF', String(wrongRows.problem))
  ok(
    /apart/.test(wrongRows.problem || '') && /no rate/i.test(wrongRows.problem || ''),
    'and the sentence names the gap and says a rate cannot fix it',
    String(wrongRows.problem)
  )

  // A figure that implies an absurd schedule is a typo, not a fee.
  const absurd = solveRatesFor({ ...base, statedCommission: 60000, statedProcessing: 2100 }, { ...app, netPaid: 37900 }, 0.05)
  ok(!!absurd.problem && absurd.period === null, 'a commission over the ceiling is refused', String(absurd.problem))

  const noSales = solveRatesFor({ ...base, statedGross: 0 }, app, 0.05)
  ok(!!noSales.problem, 'and so is a window with no sales to solve against', String(noSales.problem))
}

// ===========================================================================
console.log('\n=== WHAT THE LEDGER FIGURE IS MADE OF ===')
// ===========================================================================
/*
 * The owner, on a real month reading twenty thousand dollars apart from the
 * document: a total against a total says only that they differ. His first
 * instinct was that the costs he types in himself were being counted, which is
 * exactly the right question and — as section 2 pins — not what happens.
 */
{
  const day = (over: Record<string, number>): Record<string, unknown> => ({
    streamDate: '2026-04-06',
    netSales: 0, tips: 0, bonuses: 0, netRevenue: 0,
    netShipping: 0, showBoost: 0, reversals: 0,
    generalExpenses: 0, cogs: 0, giveawayLoss: 0, netProfit: 0,
    ...over
  })

  // A night with one of everything. netRevenue is netSales + tips + bonuses +
  // whatever the classifier could not name, so 1,000 of it here means 40 of
  // unrecognised money.
  const nights = [
    day({
      streamDate: '2026-04-06',
      netSales: 900, tips: 25, bonuses: 35, netRevenue: 1000,
      netShipping: -60, showBoost: -15, reversals: -20,
      generalExpenses: -500, cogs: -300, giveawayLoss: -75
    }),
    day({ streamDate: '2026-04-13', netSales: 500, netRevenue: 500, netShipping: -10 })
  ]

  const p = ledgerParts(nights, '2026-04-01', '2026-04-30')
  ok(p.sales === 1400, 'sales are the sale rows at what was paid', String(p.sales))
  ok(p.tips === 25, 'tips are their own line', String(p.tips))
  ok(p.bonuses === 35, 'and so are seller bonuses', String(p.bonuses))
  ok(p.unrecognised === 40, 'MONEY THE CLASSIFIER COULD NOT NAME IS SHOWN, not folded away', String(p.unrecognised))
  ok(p.shipping === -70, 'postage is one line across the window', String(p.shipping))
  ok(p.boosts === -15 && p.refunds === -20, 'boosts and refunds are separate', `${p.boosts}/${p.refunds}`)

  // THE ASSERTION THE BREAKDOWN LIVES OR DIES ON. A list that does not add up to
  // the figure it explains is worse than no list.
  const summed = p.sales + p.tips + p.bonuses + p.unrecognised + p.shipping + p.boosts + p.refunds
  ok(Math.abs(summed - p.total) < 0.005, 'AND THE PARTS ADD BACK TO THE TOTAL', `${summed} vs ${p.total}`)
  ok(p.total === 1395, 'which is what the ledger holds for these days', String(p.total))

  // WHAT IS NOT IN IT, and this is the owner's question answered.
  //
  // 500 of typed expenses, 300 of stock broken on air and a 75 prize are all on
  // that first night, and none of them moves this figure by a cent. Whatnot
  // never saw them, so putting them on this side of a payout comparison would
  // report our own bookkeeping as the platform's error.
  const withoutOurCosts = ledgerParts(
    [
      day({
        streamDate: '2026-04-06',
        netSales: 900, tips: 25, bonuses: 35, netRevenue: 1000,
        netShipping: -60, showBoost: -15, reversals: -20,
        generalExpenses: 0, cogs: 0, giveawayLoss: 0
      }),
      day({ streamDate: '2026-04-13', netSales: 500, netRevenue: 500, netShipping: -10 })
    ],
    '2026-04-01',
    '2026-04-30'
  )
  ok(
    withoutOurCosts.total === p.total,
    'OUR OWN COSTS CHANGE IT BY NOTHING — expenses, broken stock and a prize are all absent',
    `${withoutOurCosts.total} vs ${p.total}`
  )

  // The window is honoured, and a blank end means no bound — the same rule
  // reconInRange keeps, so the breakdown and the table agree on which days.
  const aprilSixth = ledgerParts(nights, '2026-04-06', '2026-04-06')
  ok(aprilSixth.sales === 900, 'a one-day window takes that day alone', String(aprilSixth.sales))
  // BOTH ENDS, not just the far one: a window that starts after the first night
  // must drop it, which is the case a `to`-only filter would pass by accident.
  const fromTheThirteenth = ledgerParts(nights, '2026-04-13', '2026-04-30')
  ok(fromTheThirteenth.sales === 500, 'and a window that starts late drops the nights before it', String(fromTheThirteenth.sales))
  ok(ledgerParts(nights, '', '').total === p.total, 'and blank ends mean every night', String(ledgerParts(nights, '', '').total))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
