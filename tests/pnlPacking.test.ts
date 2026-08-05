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
const { createSession } = require('../src/main/db/streaming')
const { importLedger, streamingFinanceView } = require('../src/main/db/financeStreaming')
const ship = require('../src/main/db/shipping')
const { buildPnl, pnlChecksum } = require('../src/shared/financeStreaming')
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
  cents(day.netProfit) === cents(day.grossProfit + day.totalFees + day.netShipping +
    pack.subtotal + day.showBoost + day.generalExpenses + day.reversals),
  'net profit is its sections added up, packaging among them',
  String(day.netProfit)
)

// The shipping section is postage and nothing else now — every term in it is a
// ledger row, which is what lets somebody check it against a Whatnot screen.
const shipSec = sectionOf(day, 'shipping')
ok(!shipSec.lines.find((l: any) => l.key === 'packingSupplies'),
   'the shipping section carries no Packing supplies line',
   JSON.stringify(shipSec.lines.map((l: any) => l.key)))
ok(shipSec.subtotalLabel === 'Net shipping', 'and is labelled for what it now holds', shipSec.subtotalLabel)
ok(cents(shipSec.subtotal) === cents(day.netShipping),
   'with its subtotal still netShipping', `${shipSec.subtotal} vs ${day.netShipping}`)

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
ok(String(pack.note).includes('net profit above is higher than the truth'),
   'and the note says the bottom line is over-stated by exactly that gap',
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

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
