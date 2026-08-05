/**
 * Packaging costs on the P&L, line by line.
 *
 * THE MODEL, in the owner's own words and the owner's own order:
 *
 *   1. Sleeves            CARDS × 5¢                 (every card gets one)
 *   2. Top loaders        CARDS × 50% × 5¢
 *   3. Team bags          Σ over breaks of SLATE × 3¢
 *   4. Shipping labels    PACKAGES × 2¢
 *   5. Team bag stickers  Σ over breaks of SLATE × 1¢
 *   6. Mailers            PAID packages × 48¢ + giveaway-ONLY packages × 24¢
 *
 * where CARDS is break spots sold, SLATE is the league's full roster (32 NFL and
 * NHL, 30 MLB and NBA) and a PACKAGE is one envelope, not one order id.
 *
 * WHAT THIS FILE IS REALLY GUARDING is not the multiplication — that part is
 * arithmetic anybody can check. It is the three places the model can lie:
 *
 *   - PACKAGES come from the shipping dataset, and the shipping workspace holds
 *     ONE at a time. Every other day genuinely does not know how many envelopes
 *     went out, and "does not know" must never render as $0.00, which reads as
 *     "no cost" on a night that certainly shipped something.
 *   - A break whose league cannot be identified must not be billed at 32 bags.
 *     A wrong slate is invisible: it is a plausible number in the right column.
 *   - A line that is missing from PNL_MONEY_FIELDS reads correctly on every day
 *     and zero on every week, month and dragged range. Nothing fails; the
 *     statement is simply wrong at exactly the grain the owner reads it at —
 *     and now that these six are inside net profit, a week's bottom line stops
 *     matching the sum of its own days.
 *
 * Run: npm run test:packaging
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/packaging-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const { createSession } = require('../src/main/db/streaming')
const { importLedger, streamingFinanceView } = require('../src/main/db/financeStreaming')
const ship = require('../src/main/db/shipping')
const { parsePages } = require('../src/main/shipping/parser')
const { buildPnl, pnlChecksum, sumDayFinance } = require('../src/shared/financeStreaming')
const {
  PACKAGING_SLEEVE_COST,
  PACKAGING_TEAM_BAG_COST,
  computePackagingCosts
} = require('../src/shared/packagingCosts')

getDb()

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

/** Cents, so a comparison is between two integers and never between two floats. */
const cents = (n: number): number => Math.round((Number.isFinite(n) ? n : 0) * 100)

// ---------------------------------------------------------------------------
// A ledger, built the way the fee suite builds one: real CSV through the real
// importer, so the rows arrive classified and attributed exactly as they would
// from a Whatnot export rather than being written straight into the table.
// ---------------------------------------------------------------------------

interface Line {
  when: Date
  amount: number
  message: string
  type: string
  order?: string
}

const YEAR = 2026
const MONTH = 4
/** Local time, so the business-day rule is exercised the way the app runs it. */
const at = (day: number, hour: number, minute = 0, second = 0): Date =>
  new Date(YEAR, MONTH - 1, day, hour, minute, second)

/** "Apr 20, 2026, 8:15:00 PM" — the shape Whatnot writes, non-padded. */
const two = (n: number): string => String(n).padStart(2, '0')
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const whatnotDate = (d: Date): string => {
  const h24 = d.getHours()
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return (
    `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ` +
    `${h}:${two(d.getMinutes())}:${two(d.getSeconds())} ${h24 < 12 ? 'AM' : 'PM'}`
  )
}

const money = (n: number): string => (n < 0 ? `($${Math.abs(n).toFixed(2)})` : `$${n.toFixed(2)}`)

let orderSeq = 0
const csvOf = (lines: Line[]): string => {
  const head =
    'Created Date,Amount,Listing ID,Order ID,Message,Status,Transaction Type,Completed Date'
  const body = lines.map((l) => {
    const order = l.order ?? `PKG${++orderSeq}`
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

/** One break spot: a break number and a team on the tail, which is the shape
 *  both the classifier and the slate detector read. */
const spot = (n: number, team: string): string =>
  `Earnings for selling a 1x 2026 FINEST HOBBY BOX- Break #${n} - ${team}`

const importAll = (lines: Line[], name: string): void => {
  const path = join(DIR, `${name}.csv`)
  writeFileSync(path, csvOf(lines), 'utf8')
  const res = importLedger(path, null)
  ok(res.ok, `  the ${name} ledger imported`, res.ok ? '' : res.error)
}

const dayOf = (view: any, date: string): any =>
  view.days.find((d: any) => d.streamDate === date) ?? null
const lineOf = (row: any, key: string): any =>
  buildPnl(row)
    .find((s: any) => s.key === 'packaging')
    .lines.find((l: any) => l.key === key) ?? null

// ---------------------------------------------------------------------------
console.log('\n=== 1. sleeves — every card, at 5¢ ===')
// ---------------------------------------------------------------------------

// One MLB night. Seven break spots across two breaks, plus a whole-product sale
// that must NOT be sleeved: a sealed box bought outright ships in its own wrap.
const NIGHT_A = '2026-04-20'
const sessA = createSession(
  { title: 'Mon MLB', startedAt: at(20, 19).toISOString(), endedAt: at(21, 1).toISOString() },
  null
)
ok(sessA.ok, 'the first show is logged', sessA.ok ? '' : sessA.error)

importAll(
  [
    { when: at(20, 20, 1), amount: 12.48, message: spot(3, 'Boston Red Sox'), type: 'SALES' },
    { when: at(20, 20, 2), amount: 7.0, message: spot(3, 'New York Yankees'), type: 'SALES' },
    { when: at(20, 20, 3), amount: 9.0, message: spot(3, 'Chicago Cubs'), type: 'SALES' },
    { when: at(20, 20, 4), amount: 15.0, message: spot(3, 'Los Angeles Dodgers'), type: 'SALES' },
    { when: at(20, 22, 30), amount: 143.19, message: spot(4, 'Atlanta Braves'), type: 'SALES' },
    { when: at(20, 22, 31), amount: 22.0, message: spot(4, 'Houston Astros'), type: 'SALES' },
    // Past midnight, still the Monday show's card.
    { when: at(21, 0, 12), amount: 19.99, message: spot(4, 'San Diego Padres'), type: 'SALES' },
    {
      when: at(20, 21, 0),
      amount: 610.0,
      message: 'Earnings for selling a 2026 Topps Inception Baseball Hobby Box',
      type: 'SALES'
    }
  ],
  'night-a'
)

let view = streamingFinanceView()
ok(view.reconciled === true, 'the view reconciles with the packaging block in it', String(view.reconcileNote))

let a = dayOf(view, NIGHT_A)
ok(!!a, 'the show day is in the P&L', String(view.days.map((d: any) => d.streamDate)))
ok(a.packagingCards === 7, 'seven break spots are counted as seven cards', String(a.packagingCards))
ok(
  a.saleCount === 8 && a.productSaleCount === 1,
  'and the whole-product sale is in the day but NOT in the card count',
  `${a.saleCount} sales, ${a.productSaleCount} products`
)

// 7 × $0.05 = $0.35, booked as a cost.
ok(cents(a.packagingSleeves) === cents(-0.35), '7 cards × 5¢ = −$0.35', String(a.packagingSleeves))
ok(a.packagingSleeves < 0, 'and it is signed as a cost, like every other cost on the day')

const sleeveLine = lineOf(a, 'packagingSleeves')
ok(!!sleeveLine, 'the statement carries a Sleeves line')
ok(cents(sleeveLine.amount) === cents(-0.35), 'holding the same figure as the day', String(sleeveLine.amount))
ok(
  String(sleeveLine.detail).includes('7 cards × 5¢'),
  'and states the arithmetic so it can be checked by hand',
  String(sleeveLine.detail)
)

// The rate is quoted from the constant, never written out — so a rate change
// moves the sentence with the money.
ok(PACKAGING_SLEEVE_COST === 0.05, 'the sleeve rate is a named constant at 5¢', String(PACKAGING_SLEEVE_COST))
ok(
  cents(computePackagingCosts({ cards: 400, slateTeams: 0 }).sleeves) === cents(-20),
  'the pure model prices 400 cards at −$20.00',
  String(computePackagingCosts({ cards: 400, slateTeams: 0 }).sleeves)
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. top loaders — half the cards, at 5¢ ===')
// ---------------------------------------------------------------------------

// 7 × 0.5 × $0.05 = $0.175, which is where the model's only fraction of a cent
// lives. It rounds ONCE, at the line, so the printed lines add to the printed
// subtotal.
ok(
  cents(a.packagingTopLoaders) === cents(-0.18),
  '7 cards × 50% × 5¢ = $0.175, rounded once to −$0.18',
  String(a.packagingTopLoaders)
)

const loaderLine = lineOf(a, 'packagingTopLoaders')
ok(!!loaderLine, 'the statement carries a Top loaders line')
ok(
  String(loaderLine.detail).includes('50% of 7 cards × 5¢'),
  'stating the share as well as the rate',
  String(loaderLine.detail)
)

// DELIBERATELY NOT ROUNDED UP TO WHOLE LOADERS. The supply plan rounds up
// because it is ordering objects; this is a cost over a period, and rounding
// every night up would overstate a month in one direction, every month.
ok(
  cents(computePackagingCosts({ cards: 3, slateTeams: 0 }).topLoaders) === cents(-0.08),
  '3 cards price at 7.5¢ and round to 8¢ rather than to two whole loaders',
  String(computePackagingCosts({ cards: 3, slateTeams: 0 }).topLoaders)
)
ok(
  cents(computePackagingCosts({ cards: 400, slateTeams: 0 }).topLoaders) === cents(-10),
  '400 cards price at −$10.00',
  String(computePackagingCosts({ cards: 400, slateTeams: 0 }).topLoaders)
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. team bags — the SLATE of every break, at 3¢ ===')
// ---------------------------------------------------------------------------

// Night A is two MLB breaks: 2 × 30 = 60 team slots × $0.03 = $1.80.
ok(a.packagingBreaks === 2, 'two distinct breaks ran', String(a.packagingBreaks))
ok(a.packagingBreaksPriced === 2, 'both were identified as MLB', String(a.packagingBreaksPriced))
ok(a.packagingSlateTeams === 60, '2 breaks × a 30-team slate = 60 slots', String(a.packagingSlateTeams))
ok(PACKAGING_TEAM_BAG_COST === 0.03, 'the team-bag rate is a named constant at 3¢', String(PACKAGING_TEAM_BAG_COST))
ok(cents(a.packagingTeamBags) === cents(-1.8), '60 slots × 3¢ = −$1.80', String(a.packagingTeamBags))

// CHARGED ON THE SLATE, NOT ON WHAT SOLD. Only seven of those sixty teams were
// bought; all sixty were pulled and bagged, and the unsold ones went to the
// house. A model counting sold cards would understate every night by exactly the
// number of teams nobody wanted.
ok(
  a.packagingSlateTeams > a.packagingCards,
  'the slate is bigger than the cards sold, which is the whole point',
  `${a.packagingSlateTeams} slots vs ${a.packagingCards} cards`
)

const bagLine = lineOf(a, 'packagingTeamBags')
ok(
  String(bagLine.detail) === '60 team slots over 2 breaks × 3¢',
  'the line says how many slots over how many breaks',
  String(bagLine.detail)
)
ok(
  !String(bagLine.detail).includes('skipped'),
  'and carries no caveat on a night where every break was identified'
)

// --- a MIXED night: one football break and one baseball break ----------------
//
// The reason detection is per BREAK. A day-level answer would give both of these
// one slate and be wrong about one of them, every mixed night the business runs.
console.log('\n--- a mixed NFL + MLB night ---')
const NIGHT_B = '2026-04-22'
const sessB = createSession(
  { title: 'Wed mixed', startedAt: at(22, 19).toISOString(), endedAt: at(22, 23).toISOString() },
  null
)
ok(sessB.ok, 'the mixed show is logged', sessB.ok ? '' : sessB.error)

importAll(
  [
    { when: at(22, 20, 0), amount: 30, message: spot(11, 'Dallas Cowboys'), type: 'SALES' },
    { when: at(22, 20, 1), amount: 25, message: spot(11, 'Green Bay Packers'), type: 'SALES' },
    { when: at(22, 21, 0), amount: 18, message: spot(12, 'Boston Red Sox'), type: 'SALES' },
    { when: at(22, 21, 1), amount: 14, message: spot(12, 'Chicago Cubs'), type: 'SALES' }
  ],
  'night-b'
)

view = streamingFinanceView()
ok(view.reconciled === true, 'still reconciles', String(view.reconcileNote))
const b = dayOf(view, NIGHT_B)
ok(!!b, 'the mixed night is in the P&L')
ok(b.packagingBreaks === 2 && b.packagingBreaksPriced === 2, 'both breaks identified', `${b.packagingBreaks}/${b.packagingBreaksPriced}`)
// 32 for the football break + 30 for the baseball one. A day-level detection
// would have printed 64 or 60 and neither would be true.
ok(
  b.packagingSlateTeams === 62,
  'a football break counts 32 and a baseball break counts 30, on the same night',
  String(b.packagingSlateTeams)
)
ok(cents(b.packagingTeamBags) === cents(-1.86), '62 slots × 3¢ = −$1.86', String(b.packagingTeamBags))

// --- a break whose league cannot be worked out -------------------------------
//
// `detectSport` always answers, and its answer for a set of strings containing
// no team at all is 'nfl' with a score of zero — 32 team bags, in the right
// column, invented. THIS is the assertion that stops that.
console.log('\n--- a break nobody can identify ---')
const NIGHT_C = '2026-04-24'
const sessC = createSession(
  { title: 'Fri mystery', startedAt: at(24, 19).toISOString(), endedAt: at(24, 23).toISOString() },
  null
)
ok(sessC.ok, 'the mystery show is logged', sessC.ok ? '' : sessC.error)

importAll(
  [
    // A real, identifiable baseball break.
    { when: at(24, 20, 0), amount: 20, message: spot(21, 'New York Yankees'), type: 'SALES' },
    { when: at(24, 20, 1), amount: 20, message: spot(21, 'Los Angeles Dodgers'), type: 'SALES' },
    // And a break sold as things that are not teams in any league.
    { when: at(24, 21, 0), amount: 12, message: spot(22, 'Cosmic Chrome'), type: 'SALES' },
    { when: at(24, 21, 1), amount: 12, message: spot(22, 'Mystery Rider'), type: 'SALES' }
  ],
  'night-c'
)

view = streamingFinanceView()
ok(view.reconciled === true, 'still reconciles', String(view.reconcileNote))
const c = dayOf(view, NIGHT_C)
ok(c.packagingBreaks === 2, 'two breaks ran', String(c.packagingBreaks))
ok(c.packagingBreaksPriced === 1, 'only one of them could be identified', String(c.packagingBreaksPriced))
ok(
  c.packagingSlateTeams === 30,
  'the unidentified break contributes NOTHING — not a default 32',
  String(c.packagingSlateTeams)
)
ok(cents(c.packagingTeamBags) === cents(-0.9), '30 slots × 3¢ = −$0.90', String(c.packagingTeamBags))
ok(
  c.packagingCards === 4,
  'while all four cards still got a sleeve — an unidentified break is still a break',
  String(c.packagingCards)
)

const cBagLine = lineOf(c, 'packagingTeamBags')
ok(
  String(cBagLine.detail) === '30 team slots over 1 break × 3¢ · 1 break skipped, league not identified',
  'and the statement SAYS one break was skipped rather than quietly under-reporting',
  String(cBagLine.detail)
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. shipping labels — one per package, at 2¢ ===')
// ---------------------------------------------------------------------------

// NO PACKING DATASET IS LOADED YET, so not one of the three nights above can say
// how many envelopes it sent. That must read as NOT KNOWN, never as $0.00: a
// night that sold seven break spots certainly shipped something, and a zero
// there is the app inventing a fact.
console.log('\n--- with no packing dataset at all ---')
ok(a.packagingDaysCovered === 0, 'night A has no packing record', String(a.packagingDaysCovered))
ok(a.packagingDaysUnknown === 1, 'and is counted as a night that needed one', String(a.packagingDaysUnknown))
ok(cents(a.packagingShippingLabels) === 0, 'so the money field is zero — a money field cannot hold "unknown"')

const labelLine = lineOf(a, 'packagingShippingLabels')
ok(labelLine.unavailable === true, 'but the statement line is marked UNAVAILABLE', JSON.stringify(labelLine))
ok(
  labelLine.empty !== true,
  'and is NOT marked empty, so the hide-zero-lines toggle cannot swallow it',
  JSON.stringify(labelLine.empty)
)
ok(
  String(labelLine.detail).includes('no packing record for this day'),
  'the detail says why rather than leaving a blank',
  String(labelLine.detail)
)
// And the SECTION says its own subtotal is short, because a reader who takes
// the subtotal and skips the lines would otherwise carry away a complete-looking
// figure that is missing two of its six components. Since this section is inside
// net profit, the same gap makes the bottom line too high — the warning has to
// say so, and the heading has to carry it for a reader who never opens the
// section.
//
// IT IS `warning`, NOT `note`, AND THAT IS THE POINT. The note is standing prose
// about how the section is priced and is true on every period; this is a
// condition, present only while some night in the range has no packing record.
// It used to be appended to the note, which made a permanent sentence out of a
// temporary fact — see the fully-covered night below, which must carry none of
// it.
const blindSec = buildPnl(a).find((s: any) => s.key === 'packaging')
ok(
  String(blindSec.warning).includes('subtotal is short'),
  'and the section warning says the subtotal is short rather than complete',
  String(blindSec.warning)
)
ok(
  String(blindSec.warning).includes('net profit is higher than the truth'),
  'naming the consequence for the bottom line, not just for the section',
  String(blindSec.warning)
)
ok(
  blindSec.incomplete === true,
  'and the heading is flagged, because the sections are closed by default',
  JSON.stringify(blindSec.incomplete)
)

// --- now load a real packing dataset for night A -----------------------------
//
// Two envelopes: one holding a bought card, one holding only a giveaway. Both
// take a label; the mailer split between them is section 6.
console.log('\n--- with the packing slips loaded ---')
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

const BOX = '1x 2026 FINEST HOBBY BOX- Break #'
const ds = parsePages(
  [
    slip('alpha', '9300120762602315706741', [
      '1 Boston Red Sox Order 7000000001 $20.00',
      BOX + '3'
    ]),
    slip('bravo', '9300120762602315706742', [
      '1 New York Yankees Order 7000000002 $0.00',
      'GIVEAWAY'
    ])
  ],
  { sport: 'mlb', eventName: 'Finest Baseball', eventDate: NIGHT_A }
)
ship.importDataset(ds, { filename: 'night-a.pdf' })
ship.setShipEvent('Finest Baseball', NIGHT_A)

view = streamingFinanceView()
ok(view.reconciled === true, 'still reconciles with a packing dataset loaded', String(view.reconcileNote))
a = dayOf(view, NIGHT_A)

ok(a.packagingPackages === 2, 'two packages went out', String(a.packagingPackages))
ok(a.packagingDaysCovered === 1 && a.packagingDaysUnknown === 0, 'night A now has a packing record', `${a.packagingDaysCovered}/${a.packagingDaysUnknown}`)
ok(cents(a.packagingShippingLabels) === cents(-0.04), '2 packages × 2¢ = −$0.04', String(a.packagingShippingLabels))

const labelLine2 = lineOf(a, 'packagingShippingLabels')
ok(!labelLine2.unavailable, 'and the line is no longer unavailable')
ok(String(labelLine2.detail) === '2 packages × 2¢', 'stating the arithmetic', String(labelLine2.detail))
const countedSec = buildPnl(a).find((s: any) => s.key === 'packaging')
ok(
  countedSec.incomplete !== true,
  'and a fully counted night carries no caveat at all — otherwise it stops being read'
)
ok(
  countedSec.warning === undefined,
  'no warning strip either, because there is nothing wrong to report',
  String(countedSec.warning)
)
ok(
  String(countedSec.note).length > 0 && !String(countedSec.note).includes('not known'),
  'the standing note stays, and says nothing about unknown nights',
  String(countedSec.note)
)

// A PACKAGE IS AN ENVELOPE, NOT AN ORDER ID. This is the whole reason packages
// cannot come from the ledger: night A's ledger holds eight order ids for two
// envelopes.
ok(
  a.packagingPackages < a.saleCount,
  'two envelopes against eight ledger order ids — one order id is a SPOT, not a package',
  `${a.packagingPackages} packages vs ${a.saleCount} sale rows`
)

// And the OTHER nights are still unknown: the shipping workspace holds ONE
// dataset, so loading night A's slips cannot answer for night B.
const bAfter = dayOf(view, NIGHT_B)
ok(bAfter.packagingDaysUnknown === 1, 'night B is still unknown — one dataset at a time', String(bAfter.packagingDaysUnknown))
ok(
  lineOf(bAfter, 'packagingShippingLabels').unavailable === true,
  'and says so on its own statement'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. team bag stickers — the same slate, at 1¢ ===')
// ---------------------------------------------------------------------------

// 60 slots × $0.01 = $0.60 on night A, 62 × $0.01 = $0.62 on the mixed night.
ok(cents(a.packagingTeamBagStickers) === cents(-0.6), '60 slots × 1¢ = −$0.60', String(a.packagingTeamBagStickers))
ok(cents(bAfter.packagingTeamBagStickers) === cents(-0.62), 'and 62 slots × 1¢ = −$0.62 on the mixed night', String(bAfter.packagingTeamBagStickers))

// ONE STICKER PER BAG, so the two lines share a base by construction. If these
// two ever stop being in a 3:1 ratio the model has been broken rather than
// refined, and this is the assertion that notices.
ok(
  cents(a.packagingTeamBags) === cents(a.packagingTeamBagStickers) * 3,
  'bags and stickers are charged on exactly the same slate — 3¢ against 1¢',
  `${a.packagingTeamBags} vs ${a.packagingTeamBagStickers}`
)

// The skipped-break caveat has to appear on BOTH per-break lines, not just the
// first one. A statement that discloses on one and not the other teaches the
// reader that the undisclosed line is complete.
const cStickerLine = lineOf(c, 'packagingTeamBagStickers')
ok(
  String(cStickerLine.detail) === '30 team slots over 1 break × 1¢ · 1 break skipped, league not identified',
  'and the sticker line carries the same skipped-break caveat the bag line does',
  String(cStickerLine.detail)
)
ok(
  cents(c.packagingTeamBagStickers) === cents(-0.3),
  'billing 30 slots rather than a defaulted 62',
  String(c.packagingTeamBagStickers)
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. mailers — 48¢ for a paid package, 24¢ for a giveaway-only one ===')
// ---------------------------------------------------------------------------

// Night A's dataset: 'alpha' holds a $20.00 Red Sox card, 'bravo' holds a
// Yankees GIVEAWAY and nothing else. So one paid package and one giveaway-only:
// 1 × $0.48 + 1 × $0.24 = $0.72.
ok(a.packagingPaidPackages === 1, 'one package holds a bought card', String(a.packagingPaidPackages))
ok(
  a.packagingPackages - a.packagingPaidPackages === 1,
  'and one is giveaway-only',
  String(a.packagingPackages - a.packagingPaidPackages)
)
ok(cents(a.packagingMailers) === cents(-0.72), '1 × 48¢ + 1 × 24¢ = −$0.72', String(a.packagingMailers))

const mailerLine = lineOf(a, 'packagingMailers')
ok(
  String(mailerLine.detail) === '1 paid × 48¢ + 1 giveaway-only × 24¢',
  'the line writes both halves out, so the sum can be checked',
  String(mailerLine.detail)
)
ok(!mailerLine.unavailable, 'and it is a real figure while the dataset is loaded')

// GIVEAWAY-ONLY MEANS EVERY SLOT IS A GIVEAWAY. A package holding one bought
// card and one giveaway is a PAID package at the full 48¢, because the bought
// card still travels double-mailered.
console.log('\n--- a mixed package is a PAID package ---')
const mixedDs = parsePages(
  [
    slip('alpha', '9300120762602315706741', [
      '1 Boston Red Sox Order 7000000001 $20.00',
      BOX + '3',
      '1 Chicago Cubs Order 7000000003 $0.00',
      'GIVEAWAY'
    ]),
    slip('bravo', '9300120762602315706742', [
      '1 New York Yankees Order 7000000002 $0.00',
      'GIVEAWAY'
    ])
  ],
  { sport: 'mlb', eventName: 'Finest Baseball', eventDate: NIGHT_A }
)
ship.importDataset(mixedDs, { filename: 'night-a-mixed.pdf' })
ship.setShipEvent('Finest Baseball', NIGHT_A)

view = streamingFinanceView()
const aMixed = dayOf(view, NIGHT_A)
ok(aMixed.packagingPackages === 2, 'still two packages', String(aMixed.packagingPackages))
ok(
  aMixed.packagingPaidPackages === 1,
  'the package holding a bought card AND a giveaway counts as paid, not as giveaway-only',
  String(aMixed.packagingPaidPackages)
)
ok(cents(aMixed.packagingMailers) === cents(-0.72), 'so the mailers are still 48¢ + 24¢', String(aMixed.packagingMailers))

// And when no dataset covers the day, the mailers report NOT KNOWN — the same
// promise the labels make, for the same reason.
const bMailer = lineOf(bAfter, 'packagingMailers')
ok(bMailer.unavailable === true, 'a night with no packing record reports mailers as not known')
ok(cents(bAfter.packagingMailers) === 0, 'with the money field at zero rather than at a guess')
ok(bMailer.empty !== true, 'and never hidden as an empty line')

// ---------------------------------------------------------------------------
console.log('\n=== the statement still adds up ===')
// Re-read: the mixed-package import above replaced the dataset, so the day
// object built before it is stale for the two per-package lines.
a = dayOf(view, NIGHT_A)
// ---------------------------------------------------------------------------

// THE IDENTITY EVERY OTHER P&L SUITE ALSO ASSERTS, and the one that now carries
// the packaging block. It stopped being a memo when the shipping checklist — and
// the second valuation of the same materials that came with it — was removed, so
// `pnlChecksum` counts it like every other section. A build that folded it into
// the bottom line and forgot the section, or the reverse, fails here by exactly
// the packaging total.
const checksumOk = (row: any, what: string): void => {
  const sections = buildPnl(row)
  ok(
    cents(pnlChecksum(sections)) === cents(row.netProfit),
    `  the ${what} statement sums to its net profit`,
    `${pnlChecksum(sections)} vs ${row.netProfit}`
  )
}
checksumOk(a, 'night A')
checksumOk(view.totals, 'all-time')

const packSec = buildPnl(a).find((s: any) => s.key === 'packaging')
ok(packSec.memo === undefined, 'the packaging section is no longer a memo', JSON.stringify(packSec.memo))
ok(
  cents(packSec.subtotal) === cents(-3.69),
  'its subtotal is the sum of its own lines',
  String(packSec.subtotal)
)
ok(
  !String(packSec.note).includes('NOT IN NET PROFIT'),
  'and no longer claims to be outside the bottom line',
  String(packSec.note)
)

// IN NET PROFIT, and demonstrably: take the section back off the bottom line and
// what is left is the statement without it. A day whose netProfit ignored the
// packaging would pass the checksum above only if the section were skipped, so
// the two assertions have to be read together.
ok(
  cents(packSec.subtotal) !== 0,
  'the packaging subtotal on night A is real money',
  String(packSec.subtotal)
)
const withoutPackaging = cents(a.netProfit) - cents(packSec.subtotal)
ok(
  cents(a.netProfit) < withoutPackaging,
  'and net profit is LOWER with it than without, which is what a cost does',
  `${cents(a.netProfit)} vs ${withoutPackaging}`
)

// The LEDGER's two figures stay clean. Every term of netShipping and
// netAfterCosts can be checked against a Whatnot export, and a modelled cost
// inside either would quietly destroy that property.
ok(
  cents(a.netShipping) === cents(a.shippingSubsidy + a.shippingCharges + a.giveawayShipping +
    a.refundShipping),
  'net shipping is postage only, untouched by the packaging block',
  String(a.netShipping)
)
ok(
  cents(a.netAfterCosts) ===
    cents(a.netRevenue + a.netShipping + a.showBoost + a.reversals + a.giveawayLoss),
  'and netAfterCosts is the ledger economics on their own',
  String(a.netAfterCosts)
)

// ---------------------------------------------------------------------------
console.log('\n=== a range rolls the packaging up ===')
// ---------------------------------------------------------------------------

// THIS IS WHAT PNL_MONEY_FIELDS PROTECTS. A money field left off that list reads
// correctly on the day and zero on every period above it, and nothing anywhere
// fails.
const spanOne = sumDayFinance([a])
ok(
  cents(spanOne.packagingSleeves) === cents(a.packagingSleeves),
  'a one-day range carries the sleeves through the rollup',
  String(spanOne.packagingSleeves)
)
ok(spanOne.packagingCards === 7, 'and the card count with it', String(spanOne.packagingCards))
ok(
  cents(spanOne.packagingTopLoaders) === cents(a.packagingTopLoaders),
  'and the top loaders',
  String(spanOne.packagingTopLoaders)
)

// --- three days, every field ------------------------------------------------
//
// EVERY money field and EVERY count, checked against the days added by hand. A
// field missing from PNL_MONEY_FIELDS or PNL_COUNT_FIELDS reads correctly on all
// three days and zero here, and nothing anywhere throws.
const bNow = dayOf(view, NIGHT_B)
const cNow = dayOf(view, NIGHT_C)
const span = sumDayFinance([a, bNow, cNow])

const sums = (f: string): number => cents(a[f]) + cents(bNow[f]) + cents(cNow[f])
for (const f of [
  'packagingSleeves',
  'packagingTopLoaders',
  'packagingTeamBags',
  'packagingShippingLabels',
  'packagingTeamBagStickers',
  'packagingMailers'
]) {
  ok(cents(span[f]) === sums(f), `  ${f} sums over three days`, `${cents(span[f])} vs ${sums(f)}`)
}
const counts = (f: string): number => a[f] + bNow[f] + cNow[f]
for (const f of [
  'packagingCards',
  'packagingBreaks',
  'packagingBreaksPriced',
  'packagingSlateTeams',
  'packagingPackages',
  'packagingPaidPackages',
  'packagingDaysCovered',
  'packagingDaysUnknown'
]) {
  ok(span[f] === counts(f), `  ${f} sums over three days`, `${span[f]} vs ${counts(f)}`)
}

// The hand-checked totals, so the loop above cannot pass by summing zeros.
// 7 + 4 + 4 = 15 cards, 60 + 62 + 30 = 152 team slots over 5 priced breaks of 6.
ok(span.packagingCards === 15, 'fifteen cards across the three nights', String(span.packagingCards))
ok(span.packagingSlateTeams === 152, '152 team slots', String(span.packagingSlateTeams))
ok(cents(span.packagingSleeves) === cents(-0.75), '15 cards × 5¢ = −$0.75', String(span.packagingSleeves))
ok(cents(span.packagingTeamBags) === cents(-4.56), '152 slots × 3¢ = −$4.56', String(span.packagingTeamBags))

// AND THE DISCLOSURE SURVIVES THE ROLLUP, which is the point of counting days
// rather than carrying a flag. One of these three nights has slips; two do not,
// and the range has to say so instead of quietly reporting a third of the
// mailers as though it were all of them.
ok(span.packagingDaysCovered === 1, 'one of the three nights has a packing record', String(span.packagingDaysCovered))
ok(span.packagingDaysUnknown === 2, 'and two do not', String(span.packagingDaysUnknown))

const spanMailer = lineOf(span, 'packagingMailers')
ok(spanMailer.unavailable === true, 'so the range mailer line is still marked unavailable')
ok(
  String(spanMailer.detail) ===
    '1 paid × 48¢ + 1 giveaway-only × 24¢ over 1 of 3 nights · 2 nights have no packing record',
  'writing out the arithmetic for the night it covers AND naming the two it does not',
  String(spanMailer.detail)
)
ok(
  cents(spanMailer.amount) === cents(a.packagingMailers),
  'while still holding the real money for the night it does cover',
  String(spanMailer.amount)
)

// The same through MAIN's own rollup, which is a second accumulator with its own
// field list. A breakdown carried by hand in one and forgotten in the other is
// exactly the drift this catches.
const week = view.weeks.find((w: any) => w.from <= NIGHT_A && w.to >= NIGHT_A)
ok(!!week, "main's own week rollup exists", JSON.stringify(view.weeks.map((w: any) => w.key)))
ok(
  cents(week.packagingSleeves) !== 0,
  'and it carries the packaging money rather than dropping it at the day boundary',
  String(week.packagingSleeves)
)
ok(
  week.packagingDaysUnknown > 0,
  'and the coverage counters with it',
  String(week.packagingDaysUnknown)
)
checksumOk(week, 'week')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
