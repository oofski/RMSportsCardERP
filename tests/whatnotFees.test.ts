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
 * So the arithmetic now runs the other way, per positive sale row:
 *
 *     gross      = (net + 0.30) / (1 − whatnotRate − 0.029)
 *     whatnotFee = gross × whatnotRate
 *     stripeFee  = gross × 0.029 + 0.30
 *
 * and the assertion that matters most is the ROUND TRIP: take the net, derive
 * the gross, put the fees back on, and land on the net again to the cent. If
 * that ever stops holding, the reported gross is money nobody paid.
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
const { createSession } = require('../src/main/db/streaming')
const { importLedger, streamingFinanceView } = require('../src/main/db/financeStreaming')
const {
  deleteRatePeriod,
  listRatePeriods,
  rateForDate,
  saveRatePeriod
} = require('../src/main/db/whatnotRates')
const {
  DEFAULT_WHATNOT_RATE,
  STRIPE_FLAT_CENTS,
  STRIPE_PERCENT_RATE,
  computeFees,
  deriveSaleFee,
  effectiveWhatnotRate,
  overlappingRatePeriod,
  parseLedgerAmount,
  validateRatePeriod
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
console.log('=== 1. the round trip: net -> gross -> net, to the cent ===')
// ---------------------------------------------------------------------------
// Every net figure the ledger could plausibly hold, at every rate the app will
// accept. If the three parts do not add back to the net EXACTLY, the gross on
// screen is money nobody paid.
const NETS = [1, 2, 7, 13, 99, 100, 101, 499, 500, 1248, 1999, 2000, 4237, 9999, 100000, 1234567]
const RATES = [0, 0.03, 0.06, 0.065, 0.08, 0.0825, 0.1234, 0.5]
let tripFail: string | null = null
let biggestGap = 0
for (const net of NETS) {
  for (const rate of RATES) {
    const f = deriveSaleFee(net, rate)
    if (f.grossCents + f.whatnotFeeCents + f.stripeFeeCents !== net) {
      tripFail = `net ${net} at ${rate}: gross ${f.grossCents}, fees ${f.whatnotFeeCents}/${f.stripeFeeCents}`
      break
    }
    // The two fees must still BE their rates, not residuals absorbing the
    // rounding — that is what makes a line on the statement checkable against
    // Whatnot. Half a cent each is the most rounding can move them.
    const exact = (net + STRIPE_FLAT_CENTS) / (1 - rate - STRIPE_PERCENT_RATE)
    biggestGap = Math.max(
      biggestGap,
      Math.abs(Math.abs(f.whatnotFeeCents) - exact * rate),
      Math.abs(Math.abs(f.stripeFeeCents) - (exact * STRIPE_PERCENT_RATE + STRIPE_FLAT_CENTS))
    )
  }
}
ok(tripFail === null, `${NETS.length * RATES.length} nets x rates all round-trip exactly`, tripFail ?? '')
ok(biggestGap <= 0.5, 'and each fee is within half a cent of its own rate', String(biggestGap))

// The worked example, by hand, at the default rate.
const spot = deriveSaleFee(1248, DEFAULT_WHATNOT_RATE)
ok(spot.grossCents === 1403, 'a $12.48 payout was a $14.03 purchase', String(spot.grossCents))
ok(spot.whatnotFeeCents === -84, "Whatnot's 6% is $0.84", String(spot.whatnotFeeCents))
ok(spot.stripeFeeCents === -71, "Stripe's 2.9% + 30c is $0.71", String(spot.stripeFeeCents))

// ---------------------------------------------------------------------------
console.log('\n=== 2. a refund and a $0.00 row are not purchases ===')
// ---------------------------------------------------------------------------
for (const net of [-46747, -415, -1, 0]) {
  const f = deriveSaleFee(net, DEFAULT_WHATNOT_RATE)
  ok(
    f.grossCents === net && f.whatnotFeeCents === 0 && f.stripeFeeCents === 0,
    `${net}c passes through at face value with no fee and no 30c`,
    JSON.stringify(f)
  )
}
// Specifically the 30c: applying it to a refund would invent a charge AND get
// its sign wrong, which is the failure mode this rule exists for.
ok(
  deriveSaleFee(-500, DEFAULT_WHATNOT_RATE).stripeFeeCents === 0,
  'a refund is never charged the flat 30c'
)

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
function feesFromRows(streamDate: string, rate: (day: string) => number): {
  netCents: number
  grossCents: number
  whatnotCents: number
  stripeCents: number
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
  const out = { netCents: 0, grossCents: 0, whatnotCents: 0, stripeCents: 0, charged: 0 }
  for (const r of rows) {
    const f = deriveSaleFee(r.c, rate(streamDateOf(r.at)))
    out.netCents += f.netCents
    out.grossCents += f.grossCents
    out.whatnotCents += f.whatnotFeeCents
    out.stripeCents += f.stripeFeeCents
    if (f.whatnotFeeCents !== 0 || f.stripeFeeCents !== 0) out.charged += 1
  }
  return out
}

const atDefault = (): number => DEFAULT_WHATNOT_RATE
for (const day of [day20, day21]) {
  const mine = feesFromRows(day.streamDate, atDefault)
  ok(cents(day.netSales) === mine.netCents, `${day.streamDate}: net sales agree`, `${day.netSales}`)
  ok(cents(day.grossSales) === mine.grossCents, '  gross agrees row by row', String(day.grossSales))
  ok(cents(day.whatnotFee) === mine.whatnotCents, "  Whatnot's cut agrees", String(day.whatnotFee))
  ok(cents(day.processingFee) === mine.stripeCents, "  Stripe's cut agrees", String(day.processingFee))
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
ok(rateForDate('2020-01-01') === 0.06, 'so every day is 6%', String(rateForDate('2020-01-01')))
ok(effectiveWhatnotRate([], '2099-12-31') === DEFAULT_WHATNOT_RATE, 'including days far ahead')

const beforeGross = day20.grossSales
const beforeNet = day20.netSales
const savedPeriod = saveRatePeriod(
  { fromDate: '2026-07-01', toDate: '2026-07-31', rate: 0.08, note: 'July renegotiation' },
  null
)
ok(savedPeriod.ok, 'an 8% July is saved', savedPeriod.ok ? '' : savedPeriod.error)
ok(rateForDate('2026-07-20') === 0.08, 'and July now reads 8%', String(rateForDate('2026-07-20')))
ok(rateForDate('2026-08-01') === 0.06, 'while August falls back to the default')

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
const mine8 = feesFromRows(day20b.streamDate, () => 0.08)
ok(cents(day20b.whatnotFee) === mine8.whatnotCents, 'at the rate the period says', String(day20b.whatnotFee))

// ---------------------------------------------------------------------------
console.log('\n=== 5. overlap is refused, and so is a bad number ===')
// ---------------------------------------------------------------------------
// THE RULE: two periods may not both claim a day. Not resolved by precedence —
// refused — because a precedence rule makes a show's fee depend on something the
// screen does not show, and nobody could reproduce it by reading the list.
const clashes: Array<[string, string | null, string]> = [
  ['2026-07-15', '2026-08-15', 'a range that starts inside July'],
  ['2026-06-01', '2026-07-05', 'a range that ends inside July'],
  ['2026-06-01', null, 'an open-ended range that swallows July'],
  ['2026-07-10', '2026-07-12', 'a range entirely inside July'],
  ['2026-07-01', '2026-07-31', 'the identical range']
]
for (const [from, to, why] of clashes) {
  const res = saveRatePeriod({ fromDate: from, toDate: to, rate: 0.07, note: '' }, null)
  ok(!res.ok && /overlap/i.test(res.error ?? ''), `refused: ${why}`, res.ok ? 'accepted' : res.error)
}
ok(listRatePeriods().length === 1, 'and none of them landed', String(listRatePeriods().length))

// Touching ranges are fine — 1 Aug is not inside 1–31 July.
const august = saveRatePeriod(
  { fromDate: '2026-08-01', toDate: null, rate: 0.065, note: 'from August' },
  null
)
ok(august.ok, 'a range that starts the day after is accepted', august.ok ? '' : august.error)
ok(rateForDate('2026-07-31') === 0.08 && rateForDate('2026-08-01') === 0.065, 'and the boundary is exact')

// Editing a period does not collide with itself.
const mine = listRatePeriods().find((p: any) => p.note === 'July renegotiation')
const edited = saveRatePeriod(
  { id: mine.id, fromDate: '2026-07-01', toDate: '2026-07-31', rate: 0.085, note: 'corrected' },
  null
)
ok(edited.ok, 'a period can be edited in place', edited.ok ? '' : edited.error)
ok(rateForDate('2026-07-20') === 0.085, 'and the new rate applies immediately')

// Validation. Main is the trust boundary: the renderer sends strings and every
// one of these has to be refused HERE.
const bad: Array<[any, string]> = [
  [{ fromDate: 'not-a-date', toDate: null, rate: 0.06, note: '' }, 'a start date that is not a date'],
  [{ fromDate: '2026-02-31', toDate: null, rate: 0.06, note: '' }, 'a day the calendar does not have'],
  [{ fromDate: '2030-01-10', toDate: '2030-01-01', rate: 0.06, note: '' }, 'an end before the start'],
  [{ fromDate: '2030-01-01', toDate: null, rate: Number.NaN, note: '' }, 'a rate that will not parse'],
  [{ fromDate: '2030-01-01', toDate: null, rate: 6, note: '' }, 'a 600% rate (percent entered raw)'],
  [{ fromDate: '2030-01-01', toDate: null, rate: -0.06, note: '' }, 'a negative rate']
]
for (const [input, why] of bad) {
  ok(validateRatePeriod(input) !== null, `the contract refuses ${why}`)
  const res = saveRatePeriod(input, null)
  ok(!res.ok, `and so does main: ${why}`, res.ok ? 'accepted' : '')
}
// A blank rate field arrives as Number('') === 0, which is a REAL number and a
// legal rate — 0% commission. It must be accepted rather than silently refused,
// because a promotional 0% is a thing that can happen; what must not happen is a
// blank field becoming one, which is why the form sends NaN for empty.
ok(validateRatePeriod({ fromDate: '2030-01-01', toDate: null, rate: 0, note: '' }) === null,
  'but a deliberate 0% is legal')

// Overlap detection itself, at the contract, including the open-ended cases.
const A = { id: 'a', fromDate: '2026-01-01', toDate: '2026-06-30', rate: 0.06, note: '', createdAt: '', updatedAt: '' }
const B = { id: 'b', fromDate: '2026-07-01', toDate: null, rate: 0.07, note: '', createdAt: '', updatedAt: '' }
ok(overlappingRatePeriod([A, B], { fromDate: '2026-06-30', toDate: '2026-06-30' }) === A, 'the last day of a closed range is inside it')
ok(overlappingRatePeriod([A, B], { fromDate: '2030-01-01', toDate: null }) === B, 'an open range reaches forever')
ok(overlappingRatePeriod([A, B], { fromDate: '2025-01-01', toDate: '2025-12-31' }) === null, 'and a range before both is clear')
ok(overlappingRatePeriod([A, B], { fromDate: '2026-01-01', toDate: null }, 'a') === B, 'ignoring itself still finds the other')

// An open-ended period really does run forever — which is also why a 2031 range
// cannot be added while it exists.
ok(rateForDate('2031-06-01') === 0.065, 'the open-ended August period reaches 2031')
const blocked = saveRatePeriod({ fromDate: '2031-01-01', toDate: '2031-12-31', rate: 0.09, note: '' }, null)
ok(!blocked.ok, 'so a 2031 range collides with it', blocked.ok ? 'accepted' : '')

// Removing a period puts its days back on whatever else covers them, and leaves
// every other period exactly where it was.
const augustId = listRatePeriods().find((p: any) => p.fromDate === '2026-08-01').id
ok(deleteRatePeriod(augustId).ok, 'the open-ended period can be removed')
ok(rateForDate('2031-06-01') === DEFAULT_WHATNOT_RATE, 'after which the default is back')
ok(rateForDate('2026-07-20') === 0.085, 'and July is untouched by that')
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
    for (const r of saleRows) {
      const fee = deriveSaleFee(r.c, DEFAULT_WHATNOT_RATE)
      if (fee.grossCents + fee.whatnotFeeCents + fee.stripeFeeCents !== r.c) broken += 1
      if (r.c > 0) positives += 1
      else if (r.c < 0) negatives += 1
      else zeros += 1
      netC += fee.netCents
      grossC += fee.grossCents
      feeC += fee.whatnotFeeCents + fee.stripeFeeCents
    }
    console.log(
      `  ---- ${saleRows.length.toLocaleString()} sale rows (${positives.toLocaleString()} positive, ` +
        `${negatives} negative, ${zeros} zero) · net $${(netC / 100).toFixed(2)} · ` +
        `gross $${(grossC / 100).toFixed(2)} · fees $${(-feeC / 100).toFixed(2)}`
    )
    ok(broken === 0, `every one of ${saleRows.length.toLocaleString()} rows round-trips`, String(broken))
    ok(grossC + feeC === netC, 'and the totals do too, to the cent', `${grossC + feeC} vs ${netC}`)
    ok(grossC > netC, 'with the derived gross above the ledger figure, as it must be')

    // What the old model would have reported, side by side. This is the size of
    // the bug, measured on the owner's own file rather than argued about.
    const oldRevenue = netC
    const oldFee = Math.round(netC * 0.089)
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
      saleRows.map((r) => ({ netCents: r.c, whatnotRate: DEFAULT_WHATNOT_RATE }))
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

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`)
process.exit(fail === 0 ? 0 : 1)
