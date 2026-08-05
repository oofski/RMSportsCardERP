/**
 * Packaging inside the bottom line, and the reconciliation that has to survive
 * it.
 *
 * The packaging figures come from counting cards, breaks and envelopes — not
 * from Whatnot's ledger — and this module reconciles every day against its rows.
 * A non-ledger cost that is inside `netProfit` and is NOT stripped from that
 * check flags EVERY day unreconciled, which does not fail loudly; it just
 * teaches the operator to ignore the one flag that matters. The reverse — a cost
 * stripped but never added — flags nothing at all and silently overstates the
 * night. Both are what these assertions exist to catch.
 *
 * `packagingCosts.test.ts` owns the arithmetic of the six lines. This file owns
 * where the money lands.
 *
 * Run: npm run test:pnl
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/pnl-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const { addItem, createSession } = require('../src/main/db/streaming')
const { createProduct } = require('../src/main/db/inventory')
const { saveExpense } = require('../src/main/db/financeExpenses')
const { importLedger, streamingFinanceView } = require('../src/main/db/financeStreaming')
const { pnlDetail } = require('../src/main/db/pnlDrill')
const ship = require('../src/main/db/shipping')
const { buildPnl, emptyDayFinance, pnlChecksum, sumDayFinance } =
  require('../src/shared/financeStreaming')
const { pnlDetailCount, pnlDrillSource } = require('../src/shared/pnlDrill')
const { parsePages } = require('../src/main/shipping/parser')
getDb()

let pass = 0, fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`) }
}
const cents = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100)
const dayOf = (v: any, d: string): any => v.days.find((x: any) => x.streamDate === d) ?? null
const sectionOf = (row: any, key: string): any =>
  buildPnl(row).find((s: any) => s.key === key) ?? null

// ---------------------------------------------------------------------------
// One night, through the real importer — a day only exists because ledger rows
// put it there. Nothing in the packaging block may ever CREATE a day: a PDF
// somebody uploaded is not evidence that a show happened.
// ---------------------------------------------------------------------------

const NIGHT = '2026-07-12'
const at = (h: number, m = 0, s = 0): Date => new Date(2026, 6, 12, h, m, s)
const two = (n: number): string => String(n).padStart(2, '0')
const whatnotDate = (d: Date): string => {
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return (
    `Jul ${d.getDate()}, ${d.getFullYear()}, ` +
    `${h}:${two(d.getMinutes())}:${two(d.getSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`
  )
}
const spot = (n: number, team: string): string =>
  `Earnings for selling a 1x 2026 FINEST BASEBALL HOBBY BOX- Break #${n} - ${team}`

const sess = createSession(
  { title: 'Sun MLB', startedAt: at(19).toISOString(), endedAt: at(23).toISOString() },
  null
)
ok(sess.ok, 'the show is logged', sess.ok ? '' : sess.error)

const rows = [
  { when: at(20, 1), amount: 18.4, message: spot(4, 'Boston Red Sox') },
  { when: at(20, 2), amount: 22.0, message: spot(4, 'New York Yankees') },
  { when: at(20, 3), amount: 15.5, message: spot(4, 'Chicago Cubs') }
]
const csv =
  ['Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date']
    .concat(
      rows.map((r, i) =>
        [
          `"${whatnotDate(r.when)}"`,
          `$${r.amount.toFixed(2)}`,
          '2041799396',
          `PKG${i + 1}`,
          r.message,
          'completed',
          'SALES',
          `"${whatnotDate(r.when)}"`
        ].join(',')
      )
    )
    .join('\r\n') + '\r\n'
const csvPath = join(DIR, 'night.csv')
writeFileSync(csvPath, csv, 'utf8')
const imported = importLedger(csvPath, null)
ok(imported.ok, 'the ledger imported', imported.ok ? '' : imported.error)

// ---------------------------------------------------------------------------
console.log('\n=== 1. with no packing slips loaded ===')
// ---------------------------------------------------------------------------
// One break of MLB, three cards, and NOBODY KNOWS how many envelopes went out —
// the shipping workspace is empty. Four of the six lines are real money; the two
// charged per package are unknown, and unknown is not zero.
let view = streamingFinanceView()
ok(view.reconciled === true, 'the P&L reconciles with the packaging block inside net profit',
   String(view.reconcileNote))

let day = dayOf(view, NIGHT)
ok(!!day, 'the show day is in the P&L', String(view.days.map((d: any) => d.streamDate)))
ok(day.packagingCards === 3, 'three break spots are three cards', String(day.packagingCards))
ok(day.packagingSlateTeams === 30, 'one MLB break is a 30-team slate', String(day.packagingSlateTeams))
ok(day.packagingDaysUnknown === 1, 'and the night is counted as having no packing record',
   String(day.packagingDaysUnknown))

let pack = sectionOf(day, 'packaging')
ok(pack.memo === undefined, 'the packaging section is NOT a memo any more', JSON.stringify(pack.memo))
ok(pack.incomplete === true, 'it is flagged as not fully counted', JSON.stringify(pack.incomplete))
// 3 sleeves at 5c + 3 x 50% loaders at 5c + 30 bags at 3c + 30 stickers at 1c
// = 0.15 + 0.08 + 0.90 + 0.30 = 1.43, with the labels and mailers unknown.
ok(cents(pack.subtotal) === cents(-1.43), 'four of six lines come to -$1.43', String(pack.subtotal))

// THE POINT OF THE WHOLE CHANGE: it is in the bottom line.
ok(
  cents(pnlChecksum(buildPnl(day))) === cents(day.netProfit),
  'and the statement sections sum to netProfit with it counted',
  `${pnlChecksum(buildPnl(day))} vs ${day.netProfit}`
)
ok(
  cents(day.netProfit) === cents(day.grossProfit + day.totalFees +
    pack.subtotal + day.showBoost + day.generalExpenses + day.reversals),
  'net profit is its sections added up, packaging among them and postage in none of them',
  String(day.netProfit)
)

// POSTAGE IS OFF THE STATEMENT ENTIRELY. There is no shipping section and no
// line printing one of its four figures — the owner took the cost out pending a
// different treatment of it. Section 7 is where the money proves it is still
// held and still reconciles; here it is enough that nothing prints it.
ok(sectionOf(day, 'shipping') === null,
   'the statement has no shipping section at all',
   JSON.stringify(buildPnl(day).map((s: any) => s.key)))
const SHIPPING_LINES = ['shippingSubsidy', 'shippingCharges', 'giveawayShipping', 'refundShipping']
ok(
  !buildPnl(day).some((s: any) => s.lines.some((l: any) => SHIPPING_LINES.includes(l.key))),
  'and no section anywhere carries one of the four postage lines',
  JSON.stringify(buildPnl(day).flatMap((s: any) => s.lines.map((l: any) => l.key)))
)

// THE DISCLOSURE. Net profit above is too high by whatever those envelopes cost,
// so the screen has to say so on the line, on the heading and in the note —
// three places, because the sections are closed by default and a reader who
// takes the subtotal off the column never opens one.
const labelLine = pack.lines.find((l: any) => l.key === 'packagingShippingLabels')
const mailerLine = pack.lines.find((l: any) => l.key === 'packagingMailers')
ok(labelLine.unavailable === true && mailerLine.unavailable === true,
   'both per-package lines read NOT KNOWN rather than $0.00')
ok(labelLine.empty !== true && mailerLine.empty !== true,
   'and neither can be hidden by the zero-line toggle')
ok(cents(day.packagingShippingLabels) === 0 && cents(day.packagingMailers) === 0,
   'their money fields are zero, because a money field cannot hold "unknown"')
// The disclosure MOVED — from the standing note into a warning that exists
// only while some night in the period really is unpriceable. A caveat printed
// on every period is a caveat nobody reads; this one fires when it is true.
// What must not change is that it still says the consequence out loud.
ok(String(pack.warning).includes('net profit is higher than the truth'),
   'and a warning says the bottom line is over-stated by exactly that gap',
   String(pack.note))

// ---------------------------------------------------------------------------
console.log('\n=== 2. load the packing slips ===')
// ---------------------------------------------------------------------------
// Two envelopes: one holding a bought card, one holding only a giveaway. The two
// unknown lines become real money, the caveat disappears, and net profit drops
// by exactly what they cost.
const slip = (handle: string, tracking: string, lines: string[]): string =>
  [
    'Whatnot Packing Slip 1/1',
    `To: ${handle} From: rm_cardz`,
    'Buyer Name',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    ...lines,
    `${Math.ceil(lines.length / 2)} Items $0.00`,
    `USPS Ground Advantage #${tracking} 3.0 oz`
  ].join('\n')

const netBefore = cents(day.netProfit)
const ds = parsePages(
  [
    slip('alpha', '9300120762602315706741', [
      '1 Boston Red Sox Order 6000000001 $20.00',
      '1x 2026 FINEST BASEBALL HOBBY BOX- Break #4'
    ]),
    slip('bravo', '9300120762602315706742', [
      '1 New York Yankees Order 6000000002 $0.00',
      'GIVEAWAY'
    ])
  ],
  { sport: 'mlb', eventName: 'Finest Baseball', eventDate: NIGHT }
)
ship.importDataset(ds, { filename: 'night.pdf' })
ship.setShipEvent('Finest Baseball', NIGHT)

view = streamingFinanceView()
ok(view.reconciled === true, 'still reconciles with the packages counted', String(view.reconcileNote))
day = dayOf(view, NIGHT)
pack = sectionOf(day, 'packaging')

ok(day.packagingPackages === 2, 'two envelopes went out', String(day.packagingPackages))
ok(day.packagingDaysCovered === 1 && day.packagingDaysUnknown === 0,
   'the night now has a packing record', `${day.packagingDaysCovered}/${day.packagingDaysUnknown}`)
ok(pack.incomplete !== true, 'so the heading carries no caveat', JSON.stringify(pack.incomplete))
// The other half of "conditional". A caveat printed on every period is a caveat
// nobody reads, so the absence of it here is as load-bearing as its presence
// above — without this the flag would quietly become wallpaper.
ok(!pack.warning, 'and no over-statement warning either', String(pack.warning))
ok(!pack.lines.some((l: any) => l.unavailable), 'and no line reads "not known"')
// 2 labels at 2c + 1 paid mailer at 48c + 1 giveaway mailer at 24c = 0.76.
ok(cents(pack.subtotal) === cents(-2.19), 'the subtotal is now all six lines: -$2.19', String(pack.subtotal))
ok(cents(day.netProfit) === netBefore - 76,
   'and net profit fell by exactly the 76¢ that had been unknown',
   `${cents(day.netProfit)} vs ${netBefore - 76}`)
ok(cents(pnlChecksum(buildPnl(day))) === cents(day.netProfit),
   'the statement still sums to the bottom line',
   `${pnlChecksum(buildPnl(day))} vs ${day.netProfit}`)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the show moves on ===')
// ---------------------------------------------------------------------------
// Clearing the show's day is what the next upload effectively does: the slips
// for this night stop being readable. The four per-card and per-break lines are
// derived from the LEDGER and stay exactly where they are; only the two counted
// off envelopes go back to being unknown, and the statement says so again rather
// than quietly reporting the night as cheaper.
ship.setShipEvent('Finest Baseball', '')
view = streamingFinanceView()
ok(view.reconciled === true, 'still reconciles once the show has moved on', String(view.reconcileNote))
const after = dayOf(view, NIGHT)
ok(cents(after.packagingTeamBags) === cents(-0.9),
   'the team bags are unchanged — they were never read off the slips',
   String(after.packagingTeamBags))
ok(after.packagingDaysUnknown === 1, 'but the packages are unknown again', String(after.packagingDaysUnknown))
ok(sectionOf(after, 'packaging').incomplete === true, 'and the caveat is back on the heading')
ok(cents(pnlChecksum(buildPnl(after))) === cents(after.netProfit),
   'with the statement still adding up', `${pnlChecksum(buildPnl(after))} vs ${after.netProfit}`)

// ---------------------------------------------------------------------------
console.log('\n=== 4. the sections that are empty on an ordinary day ===')
// ---------------------------------------------------------------------------
// This night has no marketplace order, nothing written off and no break cost.
// Every section carrying those must still be PRESENT and still reconcile: a
// section that vanished when it was empty would take its subtotal out of the
// checksum with it, and the statement would stop adding up on screen for the
// most common day there is.
const sections = buildPnl(after)
const genSec = sections.find((s: any) => s.key === 'general')
ok(!!genSec && genSec.subtotal === 0, 'the General expenses section is there and at zero',
   JSON.stringify(genSec?.subtotal))
const revSec = sections.find((s: any) => s.key === 'revenue')
const mktLine = revSec.lines.find((l: any) => l.key === 'marketplace')
ok(!!mktLine && mktLine.empty, 'the marketplace line is present and empty, so it is hidden',
   JSON.stringify(mktLine))
ok(revSec.lines.find((l: any) => l.key === 'sales').label === 'Sales',
   'and the sales line is not relabelled on a day with nothing split off it')
const cogsSec = sections.find((s: any) => s.key === 'cogs')
ok(cogsSec.lines.map((l: any) => l.key).join(',') === 'breakCost,giveawayCost',
   'a day that broke nothing prints the two totals rather than an empty list',
   JSON.stringify(cogsSec.lines.map((l: any) => l.key)))

// ---------------------------------------------------------------------------
console.log('\n=== 5. a week says what its days say ===')
// ---------------------------------------------------------------------------
// The rollup is a second accumulator with its own field list. A packaging figure
// carried on the day and dropped at the week boundary would leave a week whose
// net profit is higher than the sum of its own days — which is the failure the
// checksum below catches at the grain the owner actually reads.
const week = view.weeks.find((w: any) => w.from <= NIGHT && w.to >= NIGHT)
ok(!!week, 'the week exists', JSON.stringify(view.weeks.map((w: any) => w.key)))
ok(cents(week.packagingTeamBags) === cents(after.packagingTeamBags),
   'and carries the packaging money through the rollup', String(week.packagingTeamBags))
ok(cents(pnlChecksum(buildPnl(week))) === cents(week.netProfit),
   'with the week statement summing to the week net profit',
   `${pnlChecksum(buildPnl(week))} vs ${week.netProfit}`)
ok(cents(pnlChecksum(buildPnl(view.totals))) === cents(view.totals.netProfit),
   'and the all-time totals doing the same',
   `${pnlChecksum(buildPnl(view.totals))} vs ${view.totals.netProfit}`)

// ---------------------------------------------------------------------------
console.log('\n=== 6. every figure opens, and what opens adds up ===')
// ---------------------------------------------------------------------------
// The drill-down's whole claim is that clicking a figure lands on the records
// that make it. Two things have to be true for that to be worth anything, and
// neither is self-evident:
//
//   1. EVERY line the statement can print has somewhere to go. A P&L line added
//      upstream with no entry in the drill contract is a dead click, and a dead
//      click on a money figure teaches an operator that the whole feature is
//      decorative. The enumeration below is what stops one shipping.
//   2. What comes back SUMS TO THE FIGURE, to the cent, on a day and on a range.
//      A detail list that quietly disagrees with its own line is worse than none
//      — it either makes a correct statement look wrong, or hides a real skew
//      behind a plausible list of rows.
//
// The fixture is deliberately one of everything: both sales buckets, tips,
// bonuses, all four shipping buckets, a boost, a reversal, a shape nothing
// classifies, a costed break, an UNCOSTED break, a giveaway, and money somebody
// typed. That is one line per source in the contract, which is the only way this
// test covers all four payload kinds rather than the one the fixture happened to
// have.

const NIGHT2 = '2026-07-13'
const at2 = (h: number, m = 0): Date => new Date(2026, 6, 13, h, m, 0)
const whatnot2 = (d: Date): string => {
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `Jul ${d.getDate()}, ${d.getFullYear()}, ${h}:${two(d.getMinutes())}:00 ${h24 < 12 ? 'AM' : 'PM'}`
}

const sess2 = createSession(
  { title: 'Mon Mixed', startedAt: at2(19).toISOString(), endedAt: at2(23).toISOString() },
  null
)
ok(sess2.ok, 'the second show is logged', sess2.ok ? '' : sess2.error)

/** One of every classified shape, so every ledger-backed line has records. */
const mixed: Array<{ when: Date; amount: string; message: string; type: string }> = [
  { when: at2(20, 1), amount: '$24.00', message: spot(7, 'Dallas Cowboys'), type: 'SALES' },
  { when: at2(20, 2), amount: '$31.50', message: spot(7, 'Green Bay Packers'), type: 'SALES' },
  // No break number, no trailing team: a sealed case bought outright.
  { when: at2(20, 5), amount: '$410.00', message: 'Earnings for selling a 1x 2026 TOPPS CHROME SEALED CASE', type: 'SALES' },
  { when: at2(20, 9), amount: '$12.00', message: 'Tip from viewer', type: 'TIP' },
  { when: at2(20, 12), amount: '$45.00', message: 'Super Seller Bonus', type: 'ADJUSTMENT' },
  { when: at2(20, 15), amount: '$8.75', message: 'Shipping Subsidy', type: 'ADJUSTMENT' },
  { when: at2(20, 18), amount: '($4.15)', message: 'Whatnot platform charge for shipping adjustment on order 7000000001', type: 'ADJUSTMENT' },
  { when: at2(20, 21), amount: '($2.50)', message: 'Charged deduction of $2.50 for giveaway order 7000000002', type: 'SALES' },
  { when: at2(20, 24), amount: '($30.00)', message: 'Seller purchased Show Boost for show 12345', type: 'ADJUSTMENT' },
  { when: at2(20, 27), amount: '($18.40)', message: 'Reversal of sales transaction for order refund 7000000003', type: 'ADJUSTMENT' },
  { when: at2(20, 30), amount: '($3.10)', message: 'Deduction for order refund shipping costs on order 7000000003', type: 'ADJUSTMENT' },
  // A shape this version has never seen. Counted at face value in revenue, with
  // a line of its own so the subtotal never exceeds its lines.
  { when: at2(20, 33), amount: '$6.00', message: 'Mystery platform credit', type: 'ADJUSTMENT' }
]
const csv2 =
  ['Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date']
    .concat(
      mixed.map((r, i) =>
        [
          `"${whatnot2(r.when)}"`,
          r.amount,
          '2041799397',
          `MIX${i + 1}`,
          r.message,
          'completed',
          r.type,
          `"${whatnot2(r.when)}"`
        ].join(',')
      )
    )
    .join('\r\n') + '\r\n'
const csv2Path = join(DIR, 'night2.csv')
writeFileSync(csv2Path, csv2, 'utf8')
const imported2 = importLedger(csv2Path, null)
ok(imported2.ok, 'the mixed ledger imported', imported2.ok ? '' : imported2.error)

// --- cost of goods, costed and not ------------------------------------------
//
// Both sessions are dated in the past, so every line below is a RECONCILIATION:
// it states what the stock cost rather than consuming a layer. A stated price of
// zero is the supported way a line ends up carrying no cost at all, which is
// exactly the row the uncosted drill-down exists for.
const CASE_PRICE = 1200
const prod = createProduct(
  {
    sku: 'PNL-DRILL-CASE', upc: null, name: 'PNL Drill Hobby 12-Box Case',
    category: 'Baseball', brand: '', setName: '', year: '',
    unitType: 'case', boxesPerCase: 12, packsPerBox: null, giveawayItem: false,
    unitCost: CASE_PRICE, highBid: null, salePrice: null, reorderPoint: 0,
    openingQuantity: 0, openingLocation: 'RM'
  },
  null
).id
const prod2 = createProduct(
  {
    sku: 'PNL-DRILL-GIFT', upc: null, name: 'PNL Drill Giveaway Case',
    category: 'Baseball', brand: '', setName: '', year: '',
    unitType: 'case', boxesPerCase: 12, packsPerBox: null, giveawayItem: false,
    unitCost: 300, highBid: null, salePrice: null, reorderPoint: 0,
    openingQuantity: 0, openingLocation: 'RM'
  },
  null
).id

const addLine = (sessionId: string, productId: string, kind: string, price: number): any =>
  addItem({ sessionId, productId, kind, location: 'RM', cases: 1, casePrice: String(price) }, null)

ok(addLine(sess.data.id, prod, 'break', CASE_PRICE).ok, 'a costed case is broken on night one')
ok(addLine(sess2.data.id, prod, 'break', 0).ok, 'and one on night two that nobody priced')
ok(addLine(sess2.data.id, prod2, 'giveaway', 300).ok, 'with a case given away on night two')

// --- money somebody typed ----------------------------------------------------
ok(saveExpense({ streamDate: NIGHT, amount: 25, label: 'Pack opened on stream' }, null).ok,
   'an expense is typed against night one')
ok(saveExpense({ streamDate: NIGHT2, amount: 10.5, label: 'Box written off' }, null).ok,
   'and another against night two')

view = streamingFinanceView()
ok(view.reconciled === true, 'the whole fixture still reconciles', String(view.reconcileNote))

const d1 = dayOf(view, NIGHT)
const d2 = dayOf(view, NIGHT2)
ok(!!d1 && !!d2, 'both nights are in the P&L', String(view.days.map((d: any) => d.streamDate)))
const span = sumDayFinance([d1, d2])

/**
 * THE TEST THAT STOPS THIS FEATURE ROTTING.
 *
 * Walks every line the statement prints for a period, insists the contract knows
 * where its money is, and insists that what comes back adds to the figure on the
 * line. Reported as two assertions rather than two per line so a failure names
 * every offender at once instead of scrolling the first one off the screen.
 */
const drillCheck = (label: string, row: any, start: string | null, end: string | null): void => {
  const unmapped: string[] = []
  const off: string[] = []
  const kinds = new Set<string>()
  let checked = 0
  for (const sec of buildPnl(row)) {
    for (const line of sec.lines) {
      if (!pnlDrillSource(line.key)) {
        unmapped.push(line.key)
        continue
      }
      const got = pnlDetail({ lineId: line.key, start, end })
      kinds.add(got.kind)
      checked += 1
      if (cents(got.total) !== cents(line.amount)) {
        off.push(`${line.key}: records ${got.total} vs line ${line.amount}`)
      }
    }
  }
  ok(unmapped.length === 0, `${label}: every line has a drill-down mapping`, unmapped.join(', '))
  ok(off.length === 0, `${label}: all ${checked} lines reconcile to the cent`, off.join(' | '))
  ok(kinds.size === 4, `${label}: all four payload kinds are exercised`, [...kinds].join(','))
}

drillCheck('one day', d1, NIGHT, NIGHT)
drillCheck('the other day', d2, NIGHT2, NIGHT2)
drillCheck('a two-day range', span, NIGHT, NIGHT2)
drillCheck('all time', view.totals, null, null)

// The same enumeration over every grain the app actually renders, including the
// EMPTY day — which is the only statement that prints the two cost-of-goods
// fallback totals, and therefore the only one that can check they are mapped.
const grains: Array<[string, any]> = [
  ...view.days.map((d: any): [string, any] => [d.streamDate, d]),
  ...view.weeks.map((w: any): [string, any] => [w.label, w]),
  ...view.months.map((m: any): [string, any] => [m.label, m]),
  ['all-time', view.totals],
  ['an empty period', emptyDayFinance('2026-01-01')]
]
const missing: string[] = []
for (const [, row] of grains) {
  for (const sec of buildPnl(row)) {
    for (const line of sec.lines) if (!pnlDrillSource(line.key)) missing.push(line.key)
  }
}
ok(missing.length === 0,
   'every line id any grain can emit — days, weeks, months, all time, an empty day — is mapped',
   missing.join(', '))

// --- the four kinds, named, so a failure says WHICH one broke ---------------
const lineOf = (row: any, section: string, key: string): any =>
  (sectionOf(row, section)?.lines ?? []).find((l: any) => l.key === key) ?? null

const salesDetail = pnlDetail({ lineId: 'sales', start: NIGHT2, end: NIGHT2 })
ok(salesDetail.kind === 'ledgerRows', 'the sales line drills to ledger rows', salesDetail.kind)
ok(salesDetail.rows.length === 2, 'two break spots on night two', String(salesDetail.rows.length))
// THE ROWS ARE NOT THE STORED AMOUNTS. Whatnot pays net; the statement's top
// line is that net with the fees added back, so a list of stored amounts would
// be short by exactly the fees on every single day.
ok(salesDetail.rows.every((r: any) => r.amount > r.row.amount && !!r.basis),
   'each row contributes its DERIVED gross, and says so',
   JSON.stringify(salesDetail.rows.map((r: any) => [r.row.amount, r.amount])))
ok(cents(salesDetail.total) === cents(lineOf(d2, 'revenue', 'sales').amount),
   'and they add to the sales line exactly',
   `${salesDetail.total} vs ${lineOf(d2, 'revenue', 'sales').amount}`)

const feeDetail = pnlDetail({ lineId: 'whatnotFee', start: NIGHT2, end: NIGHT2 })
ok(feeDetail.rows.length === 3, 'the commission drills to all three charged sales',
   String(feeDetail.rows.length))
ok(cents(feeDetail.total) === cents(d2.whatnotFee), 'and adds to the fee line',
   `${feeDetail.total} vs ${d2.whatnotFee}`)

const expenseDetail = pnlDetail({ lineId: 'generalExpenses', start: NIGHT, end: NIGHT2 })
ok(expenseDetail.kind === 'expenses', 'the general expenses line drills to the typed entries',
   expenseDetail.kind)
ok(expenseDetail.entries.length === 2, 'both entries in the range', String(expenseDetail.entries.length))
ok(cents(expenseDetail.total) === cents(-35.5),
   'reported NEGATIVE, because the statement books them as a cost', String(expenseDetail.total))

const sleeveDetail = pnlDetail({ lineId: 'packagingSleeves', start: NIGHT, end: NIGHT2 })
ok(sleeveDetail.kind === 'derived', 'a packaging line is DERIVED, not a transaction list',
   sleeveDetail.kind)
ok(sleeveDetail.terms.length === 2, 'one term per night', String(sleeveDetail.terms.length))
ok(sleeveDetail.terms.every((t: any) => /cards? × 5¢$/.test(t.detail)),
   'each term is the counts and the rate, written out',
   JSON.stringify(sleeveDetail.terms.map((t: any) => t.detail)))
ok(cents(sleeveDetail.total) === cents(span.packagingSleeves),
   'and the nights add to the line', `${sleeveDetail.total} vs ${span.packagingSleeves}`)

// The two lines counted off packing slips. Both nights have lost their slips, so
// this drills to NO arithmetic and TWO named nights — an unavailable line that
// came back with an empty table would say the cost did not happen.
const labelDetail = pnlDetail({ lineId: 'packagingShippingLabels', start: NIGHT, end: NIGHT2 })
ok(labelDetail.kind === 'derived' && labelDetail.terms.length === 0,
   'the shipping-label line has no night it can price', JSON.stringify(labelDetail.terms))
ok(labelDetail.unknown.length === 2, 'and names both nights nothing can answer for',
   JSON.stringify(labelDetail.unknown))
ok(String(labelDetail.note).includes('net profit is higher than the truth'),
   'saying plainly that the bottom line is over-stated by that gap', String(labelDetail.note))

// --- the uncosted row --------------------------------------------------------
const uncostedLine = (sectionOf(d2, 'cogs').lines as any[]).find((l) => l.uncosted)
ok(!!uncostedLine, 'night two prints an uncosted cost-of-goods line',
   JSON.stringify(sectionOf(d2, 'cogs').lines.map((l: any) => l.key)))
const uncostedDetail = pnlDetail({ lineId: uncostedLine.key, start: NIGHT2, end: NIGHT2 })
ok(uncostedDetail.kind === 'streamItems', 'which drills to the stream lines themselves',
   uncostedDetail.kind)
ok(uncostedDetail.items.length === (uncostedLine.uncostedItems ?? []).length &&
   uncostedDetail.items.length === 1,
   'exactly the lines the statement offered for pricing',
   `${uncostedDetail.items.length} vs ${(uncostedLine.uncostedItems ?? []).length}`)
ok(uncostedDetail.items[0].id === uncostedLine.uncostedItems[0].id,
   'the same stream_items row, so the cost form writes to what was clicked')
ok(uncostedDetail.items[0].priceUnit === 'case',
   'carrying the unit a price for it would be per', String(uncostedDetail.items[0].priceUnit))
ok(cents(uncostedDetail.total) === 0 && cents(uncostedLine.amount) === 0,
   'and it reconciles at zero — which is what uncosted MEANS, not a failure to find rows')

// The costed line of the SAME product on the same night is a different row and
// must not be answered with the uncosted one's stream lines.
const costedLine = (sectionOf(d1, 'cogs').lines as any[]).find(
  (l) => !l.uncosted && l.key.startsWith('cogs:break:')
)
ok(!!costedLine, 'night one prints a costed cost-of-goods line',
   JSON.stringify(sectionOf(d1, 'cogs').lines.map((l: any) => l.key)))
const costedDetail = pnlDetail({ lineId: costedLine.key, start: NIGHT, end: NIGHT })
ok(costedDetail.items.length === 1 && cents(costedDetail.total) === cents(-CASE_PRICE),
   'and drills to the one case it cost, at what was stated for it',
   `${costedDetail.items.length} lines, ${costedDetail.total}`)

// --- a range with nothing in it ---------------------------------------------
//
// An empty answer, not an error and not a throw. This is the ordinary state of
// most ranges somebody picks, and the screen's empty state depends on it.
for (const id of ['sales', 'whatnotFee', 'generalExpenses', 'packagingSleeves', costedLine.key]) {
  const nothing = pnlDetail({ lineId: id, start: '2020-01-01', end: '2020-01-31' })
  ok(cents(nothing.total) === 0 && pnlDetailCount(nothing) === 0,
     `a range with no data drills "${id}" to an empty list`, JSON.stringify(nothing))
}

// A line id nothing claims comes back EMPTY AND SAYING SO, rather than throwing:
// the screen then reports "no records against $X", which is exactly what has
// gone wrong, instead of a red box that names no line.
const bogus = pnlDetail({ lineId: 'somethingNobodyMapped', start: null, end: null })
ok(pnlDetailCount(bogus) === 0 && String(bogus.note).includes('No drill-down is defined'),
   'an unmapped line id is reported as a gap in the contract', String(bogus.note))

// --- and the statement still adds up ----------------------------------------
for (const [label, row] of grains) {
  ok(cents(pnlChecksum(buildPnl(row))) === cents(row.netProfit),
     `${label}: the sections still sum to net profit`,
     `${pnlChecksum(buildPnl(row))} vs ${row.netProfit}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 7. postage: still in the ledger, out of the statement ===')
// ---------------------------------------------------------------------------
// THE SAME FAILURE AS SECTION 1, RUNNING THE OTHER WAY. Packaging is money in
// net profit that no ledger row carries, so the reconciliation strips it from
// the DAY side. Postage is now the mirror: the four buckets are still
// classified, still attributed and still carrying cents, and no statement
// section reads one of them. Every one of those cents is therefore inside the
// ledger money `buildView` compares the day breakdown against, and none of it
// is inside net profit — so without the matching strip on the ROW side, a night
// that shipped a single parcel reports a break that is not there and the
// operator gets the "these numbers do not add up" banner on a correct
// statement. That is the flag they then learn to ignore.
//
// One night, all four buckets, and a sale so the night is a night.

const NIGHT3 = '2026-07-14'
const at3 = (h: number, m = 0): Date => new Date(2026, 6, 14, h, m, 0)
const whatnot3 = (d: Date): string => {
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `Jul ${d.getDate()}, ${d.getFullYear()}, ${h}:${two(d.getMinutes())}:00 ${h24 < 12 ? 'AM' : 'PM'}`
}
const sess3 = createSession(
  { title: 'Tue Postage', startedAt: at3(19).toISOString(), endedAt: at3(23).toISOString() },
  null
)
ok(sess3.ok, 'the postage show is logged', sess3.ok ? '' : sess3.error)

const ledgerCsv = (name: string, lines: Array<{ when: Date; amount: string; message: string; type: string }>): string => {
  const body =
    ['Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date']
      .concat(
        lines.map((r, i) =>
          [
            `"${whatnot3(r.when)}"`,
            r.amount,
            '2041799398',
            `${name}${i + 1}`,
            r.message,
            'completed',
            r.type,
            `"${whatnot3(r.when)}"`
          ].join(',')
        )
      )
      .join('\r\n') + '\r\n'
  const path = join(DIR, `${name}.csv`)
  writeFileSync(path, body, 'utf8')
  return path
}

// Four different figures on purpose: a bucket wired to the wrong field shows up
// as a wrong number rather than as a total that happens to still be right.
const postage = importLedger(
  ledgerCsv('postage', [
    { when: at3(20, 1), amount: '$30.00', message: spot(9, 'Boston Red Sox'), type: 'SALES' },
    { when: at3(20, 4), amount: '$9.50', message: 'Shipping Subsidy', type: 'ADJUSTMENT' },
    { when: at3(20, 7), amount: '($6.25)', message: 'Whatnot platform charge for shipping adjustment on order 8000000001', type: 'ADJUSTMENT' },
    { when: at3(20, 10), amount: '($1.75)', message: 'Charged deduction of $1.75 for giveaway order 8000000002', type: 'SALES' },
    { when: at3(20, 13), amount: '($2.40)', message: 'Deduction for order refund shipping costs on order 8000000003', type: 'ADJUSTMENT' }
  ]),
  null
)
ok(postage.ok, 'the postage ledger imported', postage.ok ? '' : postage.error)

const v7 = streamingFinanceView()
// THE ASSERTION THE WHOLE STRIP EXISTS FOR.
ok(v7.reconciled === true, 'a night carrying all four postage buckets reconciles',
   String(v7.reconcileNote))
ok(v7.reconcileNote === null, 'and has nothing to say about it', String(v7.reconcileNote))

const d7 = dayOf(v7, NIGHT3)
ok(!!d7, 'the postage night is in the P&L', String(v7.days.map((d: any) => d.streamDate)))
ok(
  cents(d7.shippingSubsidy) === cents(9.5) && cents(d7.shippingCharges) === cents(-6.25) &&
    cents(d7.giveawayShipping) === cents(-1.75) && cents(d7.refundShipping) === cents(-2.4),
  'all four buckets are still measured onto the day',
  JSON.stringify([d7.shippingSubsidy, d7.shippingCharges, d7.giveawayShipping, d7.refundShipping])
)
ok(cents(d7.netShipping) === cents(-0.9), 'and netShipping is still their sum', String(d7.netShipping))
ok(cents(d7.netAfterCosts) ===
   cents(d7.netRevenue + d7.netShipping + d7.showBoost + d7.reversals + d7.giveawayLoss),
   'netAfterCosts still books the postage, because it is the LEDGER economics',
   String(d7.netAfterCosts))

// None of it reaches the statement — not as a section, not as a line, and not
// as a figure the bottom line quietly carries.
const pack7 = sectionOf(d7, 'packaging')
ok(sectionOf(d7, 'shipping') === null, 'the night prints no shipping section',
   JSON.stringify(buildPnl(d7).map((s: any) => s.key)))
ok(
  !buildPnl(d7).some((s: any) => s.lines.some((l: any) => SHIPPING_LINES.includes(l.key))),
  'and no postage line anywhere on it'
)
ok(
  cents(d7.netProfit) === cents(d7.grossProfit + d7.totalFees + pack7.subtotal + d7.showBoost +
    d7.generalExpenses + d7.reversals),
  'net profit is the sections it does print, with the 90¢ of net postage in none of them',
  String(d7.netProfit)
)
ok(SHIPPING_LINES.every((k) => pnlDrillSource(k) === null),
   'and the drill contract maps no line the statement cannot emit',
   SHIPPING_LINES.filter((k) => pnlDrillSource(k) !== null).join(', '))

// MORE POSTAGE MOVES THE RECORD AND NOT THE BOTTOM LINE. This is the owner's
// change stated as behaviour rather than as a missing section: another subsidy
// lands on the same night, the day's postage figure follows it, and net profit
// does not move a cent.
const netBeforePostage = cents(d7.netProfit)
const more = importLedger(
  ledgerCsv('postage-more', [
    { when: at3(21, 40), amount: '$4.10', message: 'Shipping Subsidy', type: 'ADJUSTMENT' }
  ]),
  null
)
ok(more.ok, 'a second postage row imports', more.ok ? '' : more.error)
const v7b = streamingFinanceView()
const d7b = dayOf(v7b, NIGHT3)
ok(v7b.reconciled === true, 'the view still reconciles with it', String(v7b.reconcileNote))
ok(cents(d7b.shippingSubsidy) === cents(13.6), 'the subsidy on the day went up by $4.10',
   String(d7b.shippingSubsidy))
ok(cents(d7b.netProfit) === netBeforePostage, 'and net profit did not move',
   `${cents(d7b.netProfit)} vs ${netBeforePostage}`)

// The identity, at all three grains, on a period that now contains postage the
// statement ignores. A rollup that dropped the strip fails here and nowhere on
// the days.
const week7 = v7b.weeks.find((w: any) => w.from <= NIGHT3 && w.to >= NIGHT3)
for (const [label, row] of [
  [NIGHT3, d7b],
  [week7.label, week7],
  ['all-time', v7b.totals]
] as Array<[string, any]>) {
  ok(cents(pnlChecksum(buildPnl(row))) === cents(row.netProfit),
     `${label}: the statement sums to net profit with postage outside it`,
     `${pnlChecksum(buildPnl(row))} vs ${row.netProfit}`)
}
ok(cents(v7b.totals.netShipping) !== 0,
   'and the postage is still there to be reinstated when the owner wants it back',
   String(v7b.totals.netShipping))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
