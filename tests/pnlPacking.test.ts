/**
 * Where the money lands — and, for packaging, that it lands nowhere.
 *
 * Postage and packaging were both taken off the statement in the same release,
 * and only postage came back. They were taken off for opposite reasons that this
 * module's reconciliation feels in opposite directions, and understanding the
 * difference is the whole point of the file. The check it makes is that a day's
 * own fields decompose the same money its attributed ledger rows carry, so every
 * figure has to be classified twice: is it in `netProfit`, and is it on a ledger
 * row.
 *
 *   - POSTAGE is on a ledger row AND back in `netProfit`. The four buckets have
 *     a section again — subsidy, postage charged back, giveaway postage, refund
 *     postage — each drilling to its own rows. Nothing is stripped for it any
 *     more: the ROW-side strip that carried it while no section claimed it had
 *     to go with the section's return, or the row side comes up short by exactly
 *     the postage.
 *   - PACKAGING is in neither, and still is not. It is modelled from cards,
 *     breaks and envelopes, no ledger row has ever held a sleeve, and it left
 *     `netProfit` when the owner took its section off. So NOTHING is stripped
 *     for it — and the strip that used to take it off the DAY side had to go
 *     with it, or the day side comes up short by exactly the packaging.
 *
 * Neither failure is loud. Both flag every day unreconciled, which is how an
 * operator learns to ignore the one flag that matters. That is what these
 * assertions exist to catch.
 *
 * `packagingCosts.test.ts` owns the arithmetic of the six packaging figures,
 * which is still computed on every night. This file owns the fact that no
 * section reads them — and that four postage lines now do.
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

/** The six line ids the packaging section used to print. */
const PACKAGING_LINES = [
  'packagingSleeves',
  'packagingTopLoaders',
  'packagingTeamBags',
  'packagingShippingLabels',
  'packagingTeamBagStickers',
  'packagingMailers'
]
const SHIPPING_LINES = ['shippingSubsidy', 'shippingCharges', 'giveawayShipping', 'refundShipping']

// ---------------------------------------------------------------------------
console.log('\n=== 1. the packaging is measured and printed nowhere ===')
// ---------------------------------------------------------------------------
// One break of MLB, three cards, and no packing dataset loaded. The model prices
// what it can off the ledger — sleeves, loaders, bags, stickers — and the day
// carries every figure. The statement carries none of them.
let view = streamingFinanceView()
ok(view.reconciled === true, 'the P&L reconciles with the packaging outside net profit',
   String(view.reconcileNote))
ok(view.reconcileNote === null, 'and has nothing to say about it', String(view.reconcileNote))

let day = dayOf(view, NIGHT)
ok(!!day, 'the show day is in the P&L', String(view.days.map((d: any) => d.streamDate)))
ok(day.packagingCards === 3, 'three break spots are three cards', String(day.packagingCards))
ok(day.packagingSlateTeams === 30, 'one MLB break is a 30-team slate', String(day.packagingSlateTeams))
ok(day.packagingDaysUnknown === 1, 'and the night is counted as having no packing record',
   String(day.packagingDaysUnknown))
// 3 sleeves at 5c + 3 x 50% loaders at 5c + 30 bags at 3c + 30 stickers at 1c
// = 0.15 + 0.08 + 0.90 + 0.30 = 1.43. STILL COMPUTED — the model is dormant, not
// deleted, and the owner is expected to want it back in another shape.
const modelled = (row: any): number =>
  PACKAGING_LINES.reduce((n, f) => n + cents(row[f]), 0)
ok(modelled(day) === cents(-1.43), 'the four priceable figures still come to -$1.43 on the day',
   String(modelled(day) / 100))

// AND NONE OF IT REACHES THE STATEMENT — not as a section, not as a line.
ok(sectionOf(day, 'packaging') === null,
   'the statement has no packaging section at all',
   JSON.stringify(buildPnl(day).map((s: any) => s.key)))
ok(
  !buildPnl(day).some((s: any) => s.lines.some((l: any) => PACKAGING_LINES.includes(l.key))),
  'and no section anywhere carries one of the six packaging lines',
  JSON.stringify(buildPnl(day).flatMap((s: any) => s.lines.map((l: any) => l.key)))
)
ok(PACKAGING_LINES.every((k) => pnlDrillSource(k) === null),
   'and the drill contract maps no line the statement cannot emit',
   PACKAGING_LINES.filter((k) => pnlDrillSource(k) !== null).join(', '))

// POSTAGE IS BACK ON, and this is the half that diverges from the packaging.
// It was taken off for a release and returned; the four buckets never stopped
// being computed, which is why returning it was a section and nothing else.
//
// IT IS NOW UNDER "FEES & COSTS" rather than a section of its own. Whatnot's
// month-end summary prints seller paid shipping and shipping surcharges under
// its own Fees and costs total, so this app groups them the same way and the
// two can finally be read side by side. The four lines and their drills are
// unchanged; only which section holds them moved.
const shipSection = sectionOf(day, 'fees')
ok(!!shipSection, 'THE STATEMENT STILL PRINTS THE POSTAGE LINES',
   JSON.stringify(buildPnl(day).map((s: any) => s.key)))
ok(
  SHIPPING_LINES.every((k) => shipSection.lines.some((l: any) => l.key === k)),
  'carrying all four postage lines, under Fees & costs',
  JSON.stringify(shipSection?.lines.map((l: any) => l.key))
)
ok(
  sectionOf(day, 'shipping') === null,
  'and there is no Shipping section left behind for them to be counted in twice',
  JSON.stringify(buildPnl(day).map((s: any) => s.key))
)
// FOUR LINES, NOT ONE NET FIGURE. The subsidy runs the other way from the three
// costs, and netting them would leave a reader unable to tell a cheap month from
// a well-subsidised one.
ok(
  cents(
    shipSection.lines
      .filter((l: any) => SHIPPING_LINES.includes(l.key))
      .reduce((n: number, l: any) => n + l.amount, 0)
  ) === cents(day.netShipping),
  'and the four of them still come to net shipping'
)
// EVERY ONE OF THEM DRILLS. They are ledger money — Whatnot wrote each row — so
// each maps to its own bucket and nothing is derived on the way.
for (const k of SHIPPING_LINES) {
  const src = pnlDrillSource(k)
  ok(!!src && src.kind === 'ledgerRows', `${k} drills to its ledger rows`, JSON.stringify(src))
  ok(!!src && src.buckets.length === 1, `and to exactly one bucket`, JSON.stringify(src))
}

// THE BOTTOM LINE IS THE SECTIONS THAT DO PRINT, and nothing else.
ok(
  cents(pnlChecksum(buildPnl(day))) === cents(day.netProfit),
  'the statement sections sum to netProfit',
  `${pnlChecksum(buildPnl(day))} vs ${day.netProfit}`
)
ok(
  cents(day.netProfit) === cents(day.grossProfit + day.totalFees + day.netShipping +
    day.showBoost + day.generalExpenses + day.reversals),
  'which is gross profit, fees, POSTAGE, show costs, expenses and adjustments — ' +
    'with the packaging still in none of them',
  String(day.netProfit)
)

// THE FLAGS THAT WENT WITH THE SECTION. Both existed for packaging's "not known"
// nights and nothing else raised either, so a line carrying one now would mean
// somebody reinstated half the section.
ok(
  !buildPnl(day).some((s: any) => s.warning !== undefined),
  'no section raises a live warning',
  JSON.stringify(buildPnl(day).filter((s: any) => s.warning !== undefined).map((s: any) => s.key))
)
ok(
  !buildPnl(day).some((s: any) => s.lines.some((l: any) => l.unavailable !== undefined)),
  'and no line is flagged unavailable'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. load the packing slips ===')
// ---------------------------------------------------------------------------
// Two envelopes: one holding a bought card, one holding only a giveaway. The two
// per-package figures the model could not price become real money on the day —
// and NET PROFIT DOES NOT MOVE. That is the owner's change stated as behaviour
// rather than as a missing section, and it is the assertion that fails if
// packaging ever creeps back into the bottom line by the side door.
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
// THE ASSERTION THE MISSING DAY-SIDE STRIP WOULD BREAK. Nothing about this night
// changed for the ledger — no row was imported, no cent moved — so if the
// reconciliation were still subtracting the packaging from the day side, the two
// per-package figures arriving would put it 76¢ out on their own.
ok(view.reconciled === true, 'still reconciles with the packages counted', String(view.reconcileNote))
ok(view.reconcileNote === null, 'with nothing to report', String(view.reconcileNote))
day = dayOf(view, NIGHT)

ok(day.packagingPackages === 2, 'two envelopes went out', String(day.packagingPackages))
ok(day.packagingDaysCovered === 1 && day.packagingDaysUnknown === 0,
   'the night now has a packing record', `${day.packagingDaysCovered}/${day.packagingDaysUnknown}`)
// 2 labels at 2c + 1 paid mailer at 48c + 1 giveaway mailer at 24c = 0.76, on
// top of the 1.43 the model could already price.
ok(modelled(day) === cents(-2.19), 'and the model now prices all six figures: -$2.19',
   String(modelled(day) / 100))
ok(cents(day.netProfit) === netBefore,
   'while net profit did not move a cent — the statement does not book any of it',
   `${cents(day.netProfit)} vs ${netBefore}`)
ok(sectionOf(day, 'packaging') === null, 'and there is still no packaging section to print it in')
ok(cents(pnlChecksum(buildPnl(day))) === cents(day.netProfit),
   'the statement still sums to the bottom line',
   `${pnlChecksum(buildPnl(day))} vs ${day.netProfit}`)

// ---------------------------------------------------------------------------
console.log('\n=== 3. the show moves on ===')
// ---------------------------------------------------------------------------
// Clearing the show's day is what the next upload effectively does: the slips
// for this night stop being readable. The four per-card and per-break figures are
// derived from the LEDGER and stay exactly where they are, the two counted off
// envelopes go back to zero — and once more the bottom line does not notice,
// which is what "the owner will account for this cost another way" means.
ship.setShipEvent('Finest Baseball', '')
view = streamingFinanceView()
ok(view.reconciled === true, 'still reconciles once the show has moved on', String(view.reconcileNote))
const after = dayOf(view, NIGHT)
ok(cents(after.packagingTeamBags) === cents(-0.9),
   'the team bags are unchanged — they were never read off the slips',
   String(after.packagingTeamBags))
ok(after.packagingDaysUnknown === 1, 'but the packages are unknown again', String(after.packagingDaysUnknown))
ok(modelled(after) === cents(-1.43), 'so the model is back to pricing four figures of six',
   String(modelled(after) / 100))
ok(cents(after.netProfit) === netBefore, 'and net profit still has not moved',
   `${cents(after.netProfit)} vs ${netBefore}`)
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
// The rollup is a second accumulator with its own field list. The packaging is
// in no section now, so dropping it at the week boundary would not move a
// subtotal — which is exactly why it has to be asserted rather than noticed: a
// week that silently reported none of the packaging its days did would look
// perfect until the day the owner asks for the cost back.
const week = view.weeks.find((w: any) => w.from <= NIGHT && w.to >= NIGHT)
ok(!!week, 'the week exists', JSON.stringify(view.weeks.map((w: any) => w.key)))
ok(cents(week.packagingTeamBags) === cents(after.packagingTeamBags),
   'and carries the packaging money through the rollup though nothing prints it',
   String(week.packagingTeamBags))
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
// typed. That is one line per source the statement can still emit, rather than
// the one the fixture happened to have.
//
// THREE PAYLOAD KINDS COME OUT OF THAT AND THERE ARE FOUR. The fourth, `derived`,
// used to arrive on every day through the packaging lines; the only derived line
// left is the cost-of-goods residual, which by construction exists only on a
// build where main and the renderer disagree and therefore cannot be provoked
// from a correct fixture. It is exercised directly further down instead of being
// smuggled into this count, because a count that quietly dropped from four to
// three would otherwise be the first thing to rot.

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
  ok(kinds.size === 3, `${label}: all three payload kinds a correct build can emit are exercised`,
     [...kinds].join(','))
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

// THE FOURTH KIND, REACHED THE ONLY WAY IT STILL CAN. `cogsUnitemised` is the
// residual a version-skewed build prints, so no fixture can make `buildPnl` emit
// it; asking the contract for it directly is what keeps the payload shape and the
// renderer's danger-banner branch covered now that the packaging lines that used
// to exercise `derived` on every single day are gone.
const residualDetail = pnlDetail({ lineId: 'cogsUnitemised', start: NIGHT, end: NIGHT2 })
ok(residualDetail.kind === 'derived', 'the cost-of-goods residual is the one derived line left',
   residualDetail.kind)
ok(residualDetail.terms.length === 0 && cents(residualDetail.total) === 0,
   'with nothing behind it, which is what a residual means',
   JSON.stringify(residualDetail.terms))
ok(residualDetail.noteTone === 'danger',
   'and its note is a build fault rather than a footnote', String(residualDetail.noteTone))

// THE SIX PACKAGING LINES ARE NOT IN THE CONTRACT AT ALL, and that is the honest
// way to keep the enumeration above passing: the ids are gone from `buildPnl`, so
// the mappings are gone from here. A mapping left behind would have made the
// enumeration look satisfied while covering one line fewer.
for (const id of PACKAGING_LINES) {
  const gone = pnlDetail({ lineId: id, start: NIGHT, end: NIGHT2 })
  ok(pnlDrillSource(id) === null && pnlDetailCount(gone) === 0 &&
     String(gone.note).includes('No drill-down is defined'),
     `"${id}" maps to nothing and reports itself as unmapped`, String(gone.note))
}

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
for (const id of ['sales', 'whatnotFee', 'generalExpenses', 'cogsRest', costedLine.key]) {
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
// THE OTHER HALF OF THE RULE, AND THE ONE STRIP THAT IS LEFT. Packaging is off
// the statement and was never ledger money, so nothing is stripped for it — that
// is sections 1 to 3. Postage is off the statement and IS ledger money: the four
// buckets are still classified, still attributed and still carrying cents, so
// every one of those cents is inside the ledger money `buildView` compares the
// day breakdown against while none of it is inside net profit. Without the
// matching strip on the ROW side, a night that shipped a single parcel reports a
// break that is not there and the operator gets the "these numbers do not add up"
// banner on a correct statement. That is the flag they then learn to ignore.
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

// THE POSTAGE REACHES THE STATEMENT AND THE PACKAGING STILL DOES NOT. The two
// were taken off together and only one came back, so this is where they part.
const s7 = sectionOf(d7, 'fees')
ok(!!s7, 'the night prints its postage, under Fees & costs',
   JSON.stringify(buildPnl(d7).map((s: any) => s.key)))
// The four still come to 90c of net postage. They are read out of the section
// rather than off its subtotal now, because that subtotal is every charge
// Whatnot levied — which is the point of the regrouping.
const shipCents = (): number =>
  s7.lines
    .filter((l: any) => SHIPPING_LINES.includes(l.key))
    .reduce((n: number, l: any) => n + cents(l.amount), 0)
ok(shipCents() === cents(-0.9), 'the postage lines coming to the 90¢ of net postage',
   String(shipCents() / 100))
ok(
  SHIPPING_LINES.every((k) => s7.lines.some((l: any) => l.key === k)),
  'with a line for each of the four buckets',
  JSON.stringify(s7?.lines.map((l: any) => l.key))
)
// Each line is the bucket's own money, not an apportionment.
const lineFor = (k: string): number => cents(s7.lines.find((l: any) => l.key === k).amount)
ok(lineFor('shippingSubsidy') === cents(9.5), 'the subsidy line is the subsidy')
ok(lineFor('shippingCharges') === cents(-6.25), 'the charge line is the charge')
ok(lineFor('giveawayShipping') === cents(-1.75), 'GIVEAWAY POSTAGE IS ITS OWN LINE')
ok(lineFor('refundShipping') === cents(-2.4), 'and refund postage is its own')

ok(sectionOf(d7, 'packaging') === null, 'and there is still no packaging section',
   JSON.stringify(buildPnl(d7).map((s: any) => s.key)))
ok(
  !buildPnl(d7).some((s: any) =>
    s.lines.some((l: any) => PACKAGING_LINES.includes(l.key))),
  'nor a packaging line anywhere on it'
)
ok(cents(d7.packagingSleeves) !== 0, 'though the night did sleeve a card and the model priced it',
   String(d7.packagingSleeves))
ok(
  cents(d7.netProfit) === cents(d7.grossProfit + d7.totalFees + d7.netShipping + d7.showBoost +
    d7.generalExpenses + d7.reversals),
  'NET PROFIT NOW CARRIES THE POSTAGE — and the modelled packaging still in none of it',
  String(d7.netProfit)
)
ok(SHIPPING_LINES.every((k) => pnlDrillSource(k) !== null),
   'every postage line drills',
   SHIPPING_LINES.filter((k) => pnlDrillSource(k) === null).join(', '))
ok(PACKAGING_LINES.every((k) => pnlDrillSource(k) === null),
   'and the drill contract still maps no line the statement cannot emit',
   PACKAGING_LINES.filter((k) => pnlDrillSource(k) !== null).join(', '))

// MORE POSTAGE MOVES THE BOTTOM LINE. The mirror of what this section used to
// assert: another subsidy lands on the same night, the day's postage figure
// follows it, and net profit follows too — by exactly that amount.
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
ok(cents(d7b.netProfit) === netBeforePostage + cents(4.1),
   'AND NET PROFIT ROSE BY EXACTLY THE $4.10 — the statement books postage again',
   `${cents(d7b.netProfit)} vs ${netBeforePostage + cents(4.1)}`)

// The identity, at all three grains, on a period that contains both the postage
// and the packaging the statement ignores. A rollup that dropped either fails
// here and nowhere on the days.
const week7 = v7b.weeks.find((w: any) => w.from <= NIGHT3 && w.to >= NIGHT3)
for (const [label, row] of [
  [NIGHT3, d7b],
  [week7.label, week7],
  ['all-time', v7b.totals]
] as Array<[string, any]>) {
  ok(cents(pnlChecksum(buildPnl(row))) === cents(row.netProfit),
     `${label}: the statement sums to net profit with both costs outside it`,
     `${pnlChecksum(buildPnl(row))} vs ${row.netProfit}`)
  ok(sectionOf(row, 'packaging') === null,
     `${label}: and still prints no packaging section`,
     JSON.stringify(buildPnl(row).map((s: any) => s.key)))
  // The postage rolls up like every other section: a rollup that dropped it
  // would pass on the days and fail here.
  const rolled = sectionOf(row, 'fees')
  const rolledShipping =
    rolled === null
      ? null
      : rolled.lines
          .filter((l: any) => SHIPPING_LINES.includes(l.key))
          .reduce((n: number, l: any) => n + cents(l.amount), 0)
  ok(rolledShipping !== null && rolledShipping === cents(row.netShipping),
     `${label}: the postage lines roll up to the period's net postage`,
     `${rolledShipping} vs ${cents(row.netShipping)}`)
}
ok(cents(v7b.totals.netShipping) !== 0,
   'and the postage is on the statement rather than waiting to be reinstated',
   String(v7b.totals.netShipping))
ok(modelled(v7b.totals) !== 0,
   'as is every figure the packaging model priced',
   String(modelled(v7b.totals) / 100))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
