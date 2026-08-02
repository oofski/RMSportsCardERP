/**
 * Shipping parser regressions.
 *
 * parsePages is pure — no I/O, no clock, no state — so it can be driven with
 * synthetic slip text. Both cases below were real defects that lost money
 * without saying anything, which is precisely why they are pinned here.
 *
 * Run: npm run test:parser
 */
import { learnBannerTail, parsePages } from '../src/main/shipping/parser'
import { groupIntoLines } from '../src/main/shipping/pdf'

let pass = 0, fail = 0
const ok = (c: boolean, label: string, extra = ''): void => {
  if (c) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`) }
}

// --- 1. A paid card must survive an unrelated $0 giveaway of the same team ---
// Buyer wins the Cowboys in break #3 for $50, and separately receives a $0
// Cowboys giveaway with no break number.
const packing = [
  'Whatnot Packing Slip 1/1',
  'To: bigbuyer From: rm_cardz',
  'Buyer Name',
  '12 Main St. Dallas, TX. 75201. US',
  'QTY Name & Description Attributes Subtotal',
  '1 Dallas Cowboys Order 1111111111 $50.00',
  '1x 2025 PRIZM FOOTBALL HOBBY BOX- Break #3',
  '1 Dallas Cowboys Order 2222222222 $0.00',
  'GIVEAWAY',
  '2 Items $50.00',
  'USPS Ground Advantage #9300120762602315706745 7.0 oz'
].join('\n')

const res = parsePages([packing], { sport: 'nfl' })
const cowboys = res.teamSlots.filter((s) => s.teamName === 'Dallas Cowboys')
ok(cowboys.length === 2, 'both Cowboys cards exist', `got ${cowboys.length}`)
const paid = cowboys.filter((s) => s.price === 50 && !s.isGiveaway)
const free = cowboys.filter((s) => s.price === 0 && s.isGiveaway)
ok(paid.length === 1, 'the $50 card is still paid and still pickable',
   `paid=${paid.length} ` + JSON.stringify(cowboys.map(c => ({ p: c.price, g: c.isGiveaway }))))
ok(free.length === 1, 'the giveaway is still a giveaway', `free=${free.length}`)
ok(res.teamSlots.reduce((a, s) => a + s.price, 0) === 50, 'total revenue is $50, not $0')

// --- 2. #11 and #11A are two breaks, not one -----------------------------
// A show that runs a lettered break really does run two independent slates.
// Reading the letter off and keying on the number folds them into one 4-card
// pile in which every team looks claimed twice — thirty fabricated collisions
// on a real MLB break, and a break nobody can work.
const twoBreaks = [
  'Whatnot Packing Slip 1/1',
  'To: someone From: rm_cardz',
  'Person Name',
  '5 Oak Ave. Reno, NV. 89501. US',
  'QTY Name & Description Attributes Subtotal',
  '1 Boston Red Sox Order 3333333333 $20.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #11',
  '1 New York Yankees Order 3333333334 $25.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #11',
  '1 Boston Red Sox Order 3333333335 $30.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #11A',
  '1 New York Yankees Order 3333333336 $35.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #11A',
  '4 Items $110.00',
  'USPS Ground Advantage #9300120762602315706746 3.0 oz'
].join('\n')
const res2 = parsePages([twoBreaks], { sport: 'mlb' })

const labels2 = res2.breaks.map((b) => b.breakLabel).sort()
ok(labels2.length === 2 && labels2[0] === '11' && labels2[1] === '11A',
   'a show running #11 and #11A produces TWO breaks', JSON.stringify(labels2))
ok(res2.breaks.every((b) => b.breakNumber === 11),
   'both order under the number 11', JSON.stringify(res2.breaks.map((b) => b.breakNumber)))

const in11 = res2.teamSlots.filter((s) => s.breakLabel === '11')
const in11a = res2.teamSlots.filter((s) => s.breakLabel === '11A')
ok(in11.length === 2 && in11a.length === 2,
   'the cards split two and two', `11=${in11.length} 11A=${in11a.length}`)
ok(new Set(res2.teamSlots.map((s) => s.breakId)).size === 2,
   'and land under two distinct break ids',
   JSON.stringify([...new Set(res2.teamSlots.map((s) => s.breakId))]))

// The audit is per-slate. Keyed by number it would see one 4-card break holding
// Red Sox twice and Yankees twice.
const collisions2 = res2.breakAudit.flatMap((a) => a.collisions)
ok(collisions2.length === 0,
   'neither break reports a phantom collision', JSON.stringify(collisions2))
ok(res2.breakAudit.length === 2 && res2.breakAudit.every((a) => a.teamCount === 2),
   'each break is audited as its own 2-card slate',
   JSON.stringify(res2.breakAudit.map((a) => ({ l: a.breakLabel, n: a.teamCount }))))
ok(res2.teamSlots.reduce((a, s) => a + s.price, 0) === 110, 'and all $110 survives')

// --- 2b. however the label was typed, it is the SAME break ---------------
// The break id is `break_<label>`, so a slip that writes it two ways would
// split one break in half and scatter a customer's cards across both.
const labelSlip = (marker: string): string =>
  [
    'Whatnot Packing Slip 1/1',
    'To: someone From: rm_cardz',
    'Person Name',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    '1 Boston Red Sox Order 3333333333 $20.00',
    `1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- ${marker}`,
    '1 Item $20.00',
    'USPS Ground Advantage #9300120762602315706746 3.0 oz'
  ].join('\n')

const labelOf = (marker: string): string | null => {
  const r = parsePages([labelSlip(marker)], { sport: 'mlb' })
  return r.breaks[0]?.breakLabel ?? null
}

for (const marker of ['Break #11A', 'Break #11a', 'Break # 11A', 'Break #11-A', 'Break #11 A', 'Break 11A']) {
  ok(labelOf(marker) === '11A', `“${marker}” reads as break 11A`, String(labelOf(marker)))
}
ok(labelOf('Break #11AA') === '11AA', 'a two-letter suffix is a break, not a dropped card', String(labelOf('Break #11AA')))
ok(labelOf('Break #11B') === '11B', 'and #11B is its own break', String(labelOf('Break #11B')))
ok(labelOf('Break #11') === '11', 'a plain number stays plain', String(labelOf('Break #11')))

// The two things a greedy suffix would eat.
const apos = parsePages(
  [labelSlip('Break #3 A’s')],
  { sport: 'mlb' }
)
ok(apos.breaks[0]?.breakLabel === '3', 'an apostrophe after the number is a team, not a suffix',
   String(apos.breaks[0]?.breakLabel))
const trailing = parsePages([labelSlip('Break #12 Boston Red Sox')], { sport: 'mlb' })
ok(trailing.breaks[0]?.breakLabel === '12', 'a team name after the number is not a suffix',
   String(trailing.breaks[0]?.breakLabel))

// --- 2c. the league is the check on the labels ---------------------------
// Two part-slates sharing a number: kept as two breaks, but flagged, because
// one break written two ways looks exactly like this.
const splitSlip = [
  'Whatnot Packing Slip 1/1',
  'To: someone From: rm_cardz',
  'Person Name',
  '5 Oak Ave. Reno, NV. 89501. US',
  'QTY Name & Description Attributes Subtotal',
  '1 Boston Red Sox Order 4444444441 $20.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX- Break #7',
  '1 New York Yankees Order 4444444442 $20.00',
  '1x 2026 FINEST BASEBALL HOBBY BOX- Break #7B',
  '2 Items $40.00',
  'USPS Ground Advantage #9300120762602315706748 3.0 oz'
].join('\n')
const split = parsePages([splitSlip], { sport: 'mlb' })
ok(split.breaks.length === 2, 'a part-slate pair is still two breaks', String(split.breaks.length))
ok(split.teamSlots.length === 2, 'and every card is kept', String(split.teamSlots.length))
ok(
  split.warnings.some((w) => /may be one break #7 labelled two ways/.test(w.message)),
  'and the arithmetic flags it for a person',
  JSON.stringify(split.warnings.map((w) => w.message))
)

// --- 3. control: an ordinary break is untouched ---------------------------
const plain = twoBreaks.replace(/Break #11A/g, 'Break #12')
const res3 = parsePages([plain], { sport: 'mlb' })
ok(res3.breaks.map((b) => b.breakLabel).sort().join(',') === '11,12',
   'plain numbers still read as plain numbers',
   JSON.stringify(res3.breaks.map((b) => b.breakLabel)))
ok(res3.breaks.every((b) => b.breakLabel === String(b.breakNumber)),
   'and their label is exactly their number')

// --- 3b. the two-column header: name and address, not the seller's banner ---
// The slip header is two columns, and the line grouper joins whatever shares a
// row — as it must for the order lines. So the buyer's name arrives welded to
// the show banner. The name then stopped looking like a name, was never
// captured, and the pick screen showed a dash where the customer should be.
const banner = (lines: string[]): string =>
  [
    'Whatnot Packing Slip 1/1',
    'To: buyer99 NEW From: rm_cardz',
    ...lines,
    'QTY Name & Description Attributes Subtotal',
    '1 Boston Red Sox Order 7000000001 $20.00',
    '1x 2026 FINEST BASEBALL HOBBY BOX- Break #3',
    '1 Item $20.00',
    'USPS Ground Advantage #9300120762602315706799 3.0 oz'
  ].join('\n')

// Both real wrap shapes from the July export, in one document so the banner is
// learnable (it needs more than one sample, exactly as a real show has).
const twoCol = parsePages(
  [
    banner([
      'Rick Layman \u25A0 FINEST BASEBALL RELEASE WEEK!',
      '4556 MCCARTY LN. ROCHESTER, IN. 46975. US RANDOM TEAMS + $1 STARTS\u25A0',
      '12 July, 2026'
    ]),
    banner([
      'Nate Hoeft \u25A0 FINEST BASEBALL RELEASE WEEK!',
      '26602 Shakespeare Ln. Stevenson Ranch, CA. RANDOM TEAMS + $1 STARTS\u25A0',
      '91381-1465. US 12 July, 2026'
    ]).replace('To: buyer99', 'To: buyer98')
  ],
  { sport: 'mlb' }
)
const c1 = twoCol.customers.find((c) => c.id === 'buyer99')
const c2 = twoCol.customers.find((c) => c.id === 'buyer98')
ok(c1?.realName === 'Rick Layman', 'the buyer name survives the glued banner', String(c1?.realName))
ok(c2?.realName === 'Nate Hoeft', 'including on a slip whose address wraps', String(c2?.realName))
ok(
  c1?.address === '4556 MCCARTY LN. ROCHESTER, IN. 46975. US',
  'a single-line address ends at the country, not in the banner',
  String(c1?.address)
)
ok(
  c2?.address === '26602 Shakespeare Ln. Stevenson Ranch, CA., 91381-1465. US',
  'a wrapped address keeps both halves and drops the banner between them',
  String(c2?.address)
)
ok(
  !/RANDOM TEAMS|RELEASE WEEK|\u25A0|July/.test(`${c1?.realName} ${c1?.address} ${c2?.realName} ${c2?.address}`),
  'and no banner text or banner date is left anywhere'
)
ok(learnBannerTail([
  'x RANDOM TEAMS + $1 STARTS\u25A0',
  'y RANDOM TEAMS + $1 STARTS\u25A0'
]) === 'RANDOM TEAMS + $1 STARTS', 'the banner is learned from the document, not hard-coded',
  learnBannerTail(['x RANDOM TEAMS + $1 STARTS\u25A0', 'y RANDOM TEAMS + $1 STARTS\u25A0']))
ok(learnBannerTail(['only one sample\u25A0']) === '', 'one sample is not enough to call something a banner')

// ---------------------------------------------------------------------------
// 4. The line grouper: a row set in two sizes is still ONE row
// ---------------------------------------------------------------------------
// Real geometry from the July 2026 Finest Baseball export, page A7: the qty,
// order id and price sit at y=498.57 (11pt) and the team name at y=498.27
// (12pt). Math.round puts them on different lines; clustering does not.

const row = groupIntoLines([
  { y: 498.57, x: 23.81, s: '1' },
  { y: 498.27, x: 63.5, s: 'Washington Nationals' },
  { y: 498.57, x: 349.8, s: 'Order 1181185826' },
  { y: 498.57, x: 543.19, s: '$15.00' }
])
ok(row.length === 1, 'a two-size row groups as one line', JSON.stringify(row))
ok(
  row[0] === '1 Washington Nationals Order 1181185826 $15.00',
  'and reads in column order',
  row[0]
)

// The badge sits 0.95–0.96pt off its row and must come with it...
const badged = groupIntoLines([
  { y: 726.9, x: 23.81, s: 'To: davkaylem' },
  { y: 725.95, x: 120, s: 'NEW' },
  { y: 726.9, x: 349.8, s: 'From: rm_cardz' }
])
ok(badged.length === 1, 'the NEW badge stays on the To: line', JSON.stringify(badged))

// ...while genuinely separate rows stay separate. The smallest real gap between
// two rows in the corpus is 12.47pt.
const twoRows = groupIntoLines([
  { y: 498.57, x: 23.81, s: '1' },
  { y: 498.27, x: 63.5, s: 'Washington Nationals' },
  { y: 486.1, x: 349.8, s: '1x 2026 FINEST BASEBALL' }
])
ok(twoRows.length === 2, 'a 12.47pt gap is still two lines', JSON.stringify(twoRows))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
