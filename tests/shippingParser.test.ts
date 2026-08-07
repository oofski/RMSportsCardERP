/**
 * Shipping parser regressions.
 *
 * parsePages is pure — no I/O, no clock, no state — so it can be driven with
 * synthetic slip text. Both cases below were real defects that lost money
 * without saying anything, which is precisely why they are pinned here.
 *
 * Run: npm run test:parser
 */
import { learnBannerTail, parsePages, readBreakLabel } from '../src/main/shipping/parser'
import { groupIntoLines } from '../src/main/shipping/pdf'
import { SHIP_TEAM_LISTS } from '../src/main/shipping/teams'
import { pageRangeLabel } from '../src/shared/shippingViews'

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

// --- 2d. the bracketed break marker: the team is a COLUMN, not a suffix ----
//
// Whatnot changed the packing slip. The break used to be written inline at the
// end of the description with the team trailing it; now the team has a column
// of its own and the break prints as `[Break 1]` under the product. Reading the
// text after the label as the team is right for the first and wrong for the
// second — the only thing after "Break 1" is "]".
//
// What that cost, measured on a reconstruction of the real slip: every card
// came out named "]", the two in break 1 reported as one team claimed twice,
// and because "]" scores nothing in any league the auto-detected sport fell
// back to its first entry — a baseball show imported as the NFL with not one
// team resolved. So both halves are pinned here: the team, and the league.
const twoColSlip = (rows: string[], handle = 'shaunsir03'): string =>
  [
    'Whatnot Packing Slip 1/1',
    `To: ${handle} From: rm_cardz`,
    'Shaun Sir',
    '5 Oak Ave. Reno, NV. 89501. US',
    'QTY Name & Description Attributes Subtotal',
    ...rows,
    '2 Items $60.00',
    'USPS Ground Advantage #9300120762602315706745 7.0 oz'
  ].join('\n')

const BRACKETED = twoColSlip([
  '1 San Francisco Giants Order 1237174001 $28.00',
  '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
  '[Break 1]',
  '1 Arizona Diamondbacks Order 1237175471 $32.00',
  '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
  '[Break 1]'
])

const bracketed = parsePages([BRACKETED], { sport: 'mlb' })
const bracketedTeams = bracketed.teamSlots.map((s) => s.teamName).sort()
ok(
  bracketedTeams.join(' | ') === 'Arizona Diamondbacks | San Francisco Giants',
  'the bracketed layout reads the team column, not the bracket',
  JSON.stringify(bracketedTeams)
)
ok(
  bracketed.teamSlots.every((s) => s.breakLabel === '1'),
  'and both cards land in break 1',
  JSON.stringify(bracketed.teamSlots.map((s) => s.breakLabel))
)
ok(
  bracketed.warnings.length === 0,
  'with nothing to warn about',
  JSON.stringify(bracketed.warnings.map((w) => w.message))
)

// The league half. `auto` is what the Upload screen sends by default, and it
// harvests through a null matcher — so a layout that yields only punctuation
// leaves detection with no evidence at all and it silently picks the first
// league in the list.
const bracketedAuto = parsePages([BRACKETED], { sport: 'auto' })
ok(bracketedAuto.sport === 'mlb', 'and the league is detected from it, not guessed',
   String(bracketedAuto.sport))
ok(
  bracketedAuto.teamSlots.map((s) => s.teamName).sort().join(' | ') ===
    'Arizona Diamondbacks | San Francisco Giants',
  'so an auto-detected import gets the same teams',
  JSON.stringify(bracketedAuto.teamSlots.map((s) => s.teamName))
)

// The marker is a marker WHEREVER the line grouper puts it. This is the part
// that must not depend on one line arrangement: the same two rows are read from
// a PDF whose text runs may group the marker onto its own line, onto the
// product line, or onto the row itself — and a row torn in two by type size is
// the failure LINE_TOLERANCE already exists to fight (see pdf.ts).
const arrangements: [string, string[]][] = [
  ['on its own line', [
    '1 San Francisco Giants Order 1237174001 $28.00',
    '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
    '[Break 1]'
  ]],
  ['joined to the product line', [
    '1 San Francisco Giants Order 1237174001 $28.00',
    '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!) [Break 1]'
  ]],
  ['joined to the row itself', [
    '1 San Francisco Giants Order 1237174001 $28.00 4x 2026 CHROME BASEBAL JUMBO BOX [Break 1]'
  ]],
  ['with the name torn onto its own line', [
    '1 Order 1237174001 $28.00',
    'San Francisco Giants',
    '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
    '[Break 1]'
  ]],
  ['written without brackets', [
    '1 San Francisco Giants Order 1237174001 $28.00',
    '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
    'Break 1'
  ]]
]
for (const [shape, rows] of arrangements) {
  const r = parsePages([twoColSlip(rows)], { sport: 'mlb' })
  const slot = r.teamSlots[0]
  ok(
    r.teamSlots.length === 1 && slot?.teamName === 'San Francisco Giants' && slot?.breakLabel === '1',
    `a marker ${shape} still gives break 1 to the Giants`,
    JSON.stringify(r.teamSlots.map((s) => `${s.breakLabel}:${s.teamName}`))
  )
}

// A bracketed label keeps its letter. #11A is a different break from #11 with a
// full slate of its own, and the brackets must not cost that distinction.
const bracketedSuffix = parsePages(
  [
    twoColSlip([
      '1 San Francisco Giants Order 1237174001 $28.00',
      '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
      '[Break 11A]',
      '1 Arizona Diamondbacks Order 1237175471 $32.00',
      '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
      '[ BREAK 11a ]'
    ])
  ],
  { sport: 'mlb' }
)
ok(
  bracketedSuffix.breaks.length === 1 && bracketedSuffix.breaks[0]?.breakLabel === '11A',
  'a bracketed “[Break 11A]” keeps its suffix, however it is typed',
  JSON.stringify(bracketedSuffix.breaks.map((b) => b.breakLabel))
)

// An opening bracket alone proves nothing. A description that parenthesises the
// whole thing still puts the team AFTER the label, and that is the old form.
const parenthesised = parsePages(
  [
    twoColSlip([
      '1 Order 1237174001 $28.00',
      '4x 2026 CHROME BASEBAL JUMBO BOX (Break #1 - San Francisco Giants)'
    ])
  ],
  { sport: 'mlb' }
)
ok(
  parenthesised.teamSlots[0]?.teamName === 'San Francisco Giants',
  'a bracket that opens before the label but closes after the team is still a prefix',
  JSON.stringify(parenthesised.teamSlots.map((s) => s.teamName))
)

// --- 2e. a punctuation fragment is never a team --------------------------
// Worth having whatever the layout does. "]", "[" and "" are what is left when
// a slice lands between two columns, and each of them used to be printed on the
// pick screen as the team somebody had to find in a box.
const fragments = parsePages(
  [
    twoColSlip([
      '1 Order 5555555551 $12.00',
      '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)',
      '[Break 4]',
      '1 ] Order 5555555552 $13.00',
      '1x 2026 CHROME BASEBAL JUMBO BOX- Break #4 - [',
      '1 - Order 5555555553 $14.00',
      '1x 2026 CHROME BASEBAL JUMBO BOX- Break #4 -'
    ])
  ],
  { sport: 'mlb' }
)
ok(
  fragments.teamSlots.length === 3,
  'every unreadable card is still kept and still pickable',
  String(fragments.teamSlots.length)
)
ok(
  fragments.teamSlots.every((s) => /[A-Za-z0-9].*[A-Za-z0-9]/.test(s.teamName)),
  'and none of them is named after a bracket or a dash',
  JSON.stringify(fragments.teamSlots.map((s) => s.teamName))
)
ok(
  fragments.teamSlots.every((s) => s.teamName === 'Unknown team'),
  'they read as Unknown team, which is at least true',
  JSON.stringify(fragments.teamSlots.map((s) => s.teamName))
)
ok(
  fragments.warnings.filter((w) => /No team could be read/.test(w.message)).length === 3,
  'and each one says so, naming its order',
  JSON.stringify(fragments.warnings.map((w) => w.message))
)

// --- 2f. the same slip, both layouts, one dataset ------------------------
// The old form is not legacy: RM re-imports months of it. Whichever way the
// slip is printed, the import must be the same import.
const sameRows = [
  ['1 San Francisco Giants Order 1237174001 $28.00', '1 Arizona Diamondbacks Order 1237175471 $32.00'],
  ['4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)', '4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)']
]
const oldForm = twoColSlip([
  `${sameRows[0][0]}`,
  `${sameRows[1][0]}- Break #1 - San Francisco Giants`,
  `${sameRows[0][1]}`,
  `${sameRows[1][1]}- Break #1 - Arizona Diamondbacks`
])
const newForm = twoColSlip([
  `${sameRows[0][0]}`,
  `${sameRows[1][0]}`,
  '[Break 1]',
  `${sameRows[0][1]}`,
  `${sameRows[1][1]}`,
  '[Break 1]'
])
const oldParsed = parsePages([oldForm], { sport: 'auto' })
const newParsed = parsePages([newForm], { sport: 'auto' })
ok(
  oldParsed.teamSlots.map((s) => s.teamName).join(' | ') === 'San Francisco Giants | Arizona Diamondbacks',
  'the old inline layout still yields its team',
  JSON.stringify(oldParsed.teamSlots.map((s) => s.teamName))
)
ok(
  JSON.stringify(oldParsed) === JSON.stringify(newParsed),
  'and the two layouts of one slip produce the same dataset, field for field',
  `old=${JSON.stringify(oldParsed.teamSlots)} new=${JSON.stringify(newParsed.teamSlots)}`
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

// --- 3c. an order that runs onto more pages keeps all of them --------------
// Nine of the July show's 122 orders did, and one buyer's 47 cards took five
// pages. The pages travel on the customer so the slip pane can show the whole
// run: showing only the first is worse than showing none, because a short list
// that looks complete gets agreed with and the package sealed.
const runOn = parsePages(
  [
    [
      'Whatnot Packing Slip 1/3',
      'To: moomoomayne NEW From: rm_cardz',
      'Joseph Drewer',
      '701 Breeze Hill Rd. Vista, CA. 92081-4324. US',
      'QTY Name & Description Attributes Subtotal',
      '1 New York Mets Order 1181773001 $45.00',
      '2x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #6'
    ].join('\n'),
    // Continuation: the header repeats, the buyer block does not.
    [
      'Whatnot Packing Slip 2/3',
      '1 Baltimore Orioles Order 1181774687 $45.00',
      '2x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #6'
    ].join('\n'),
    [
      'Whatnot Packing Slip 3/3',
      '1 San Francisco Giants Order 1181821631 $44.00',
      '1x 2026 Finest Delight BOX (NEW RELEASE!)- Break #17',
      '3 Items $134.00',
      'USPS Ground Advantage #9300120762602315706700 8.0 oz'
    ].join('\n')
  ],
  { sport: 'mlb' }
)
const runOnCustomer = runOn.customers.find((c) => c.id === 'moomoomayne')
ok(
  JSON.stringify(runOnCustomer?.pages) === '[1,2,3]',
  'a three-page order carries all three page numbers',
  JSON.stringify(runOnCustomer?.pages)
)
ok(runOn.teamSlots.length === 3, 'and every card across them is kept', String(runOn.teamSlots.length))
ok(
  runOn.teamSlots.filter((s) => s.breakLabel === '6').length === 2 &&
    runOn.teamSlots.filter((s) => s.breakLabel === '17').length === 1,
  'each landing in the break its own page named',
  JSON.stringify(runOn.teamSlots.map((s) => s.breakLabel))
)
ok(runOnCustomer?.realName === 'Joseph Drewer', 'the buyer is read off page one only')

// A one-page order is exactly one page — the pane must not invent a run.
const single = parsePages(
  [
    [
      'Whatnot Packing Slip 1/1',
      'To: solo99 From: rm_cardz',
      'Solo Buyer',
      '1 Main St. Reno, NV. 89501. US',
      'QTY Name & Description Attributes Subtotal',
      '1 New York Mets Order 1181773999 $10.00',
      '1x 2026 FINEST BASEBALL HOBBY BOX- Break #6',
      '1 Item $10.00',
      'USPS Ground Advantage #9300120762602315706701 3.0 oz'
    ].join('\n')
  ],
  { sport: 'mlb' }
)
ok(
  JSON.stringify(single.customers[0]?.pages) === '[1]',
  'a one-page order carries exactly one page',
  JSON.stringify(single.customers[0]?.pages)
)

// The label the pane prints over the run.
ok(pageRangeLabel([27, 28, 29, 30, 31]) === '27–31', 'a contiguous run reads as a range', pageRangeLabel([27, 28, 29, 30, 31]))
ok(pageRangeLabel([15]) === '15', 'a single page reads as itself')
ok(pageRangeLabel([4, 9]) === '4, 9', 'a gap is never described as a range', pageRangeLabel([4, 9]))
ok(pageRangeLabel([]) === '', 'no pages, nothing to say')

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

// ---------------------------------------------------------------------------
// 5. The real August layout, page for page, with invented people
// ---------------------------------------------------------------------------
//
// The owner's 97-page slip parses correctly today: 87 customers, 265 team slots,
// 8 breaks labelled 1–8, each one a clean 30-team MLB slate, 25 giveaways, no
// warnings and no malformed team names. Nothing below changes any of that. It
// exists so that the next edit to `readBreakLabel`, to the banner learner or to
// the team column cannot quietly take it away — every previous regression in
// this file was found on a real import, weeks late, after cards had been picked
// against it.
//
// PRIVACY. Every name, street, handle, order id and tracking number here is
// INVENTED. This repository is public and the real slip is a hundred pages of
// customers' home addresses. What is reproduced is the LAYOUT — the exact line
// shapes `groupIntoLines` emits for that document — and nothing else:
//
//     Whatnot Packing Slip 1/1
//     To: <handle> From: rm_cardz
//     <Buyer Name> ■ 2026 TRIBUTE AND CHROME BASEBALL
//     <address> JUMBO! RANDOM TEAMS + $1 STARTS ■
//     03 August, 2026
//     QTY Name & Description Attributes Subtotal
//     1 San Francisco Giants Order 1237174001 $28.00
//     4x 2026 CHROME BASEBAL
//     JUMBO BOX (HALF CASE!)
//     [Break 1]
//     ...
//     2 Items $60.00
//     USPS Ground Advantage™ #93001207626023788195 14.0 oz
//
// Three shapes in there are the whole difficulty, and all three are real:
// QTY + TEAM + "Order <id>" + subtotal arrive as ONE line because they are four
// columns of one row; the product description continues on the lines under it;
// and `[Break N]` sits ALONE on a line of its own with nothing after the number
// but a bracket. The ■ are the banner column's glyphs.
console.log('\n--- the August layout, invented identities ---')

const AUG_BANNER = '2026 TRIBUTE AND CHROME BASEBALL'
const AUG_TAIL = 'JUMBO! RANDOM TEAMS + $1 STARTS'
// Two lines, exactly as the description column wraps on the real slip.
const AUG_PRODUCT = ['4x 2026 CHROME BASEBAL', 'JUMBO BOX (HALF CASE!)']
const AUG_TEAMS = SHIP_TEAM_LISTS.mlb

let augOrder = 1900000000
let augTracking = 1000
const augTrack = (): string => `94001000000000000${++augTracking}`

/** One bought card: the joined row, the wrapped product, then the marker. */
const augItem = (team: string, price: number, brk: number): string[] => [
  `1 ${team} Order ${++augOrder} $${price.toFixed(2)}`,
  ...AUG_PRODUCT,
  `[Break ${brk}]`
]
/** A promo rider: $0.00, and no break of its own — which is what a rider IS. */
const augRider = (team: string): string[] => [`1 ${team} Order ${++augOrder} $0.00`, 'GIVEAWAY']

const augHead = (handle: string, name: string, addr: string[], page: string): string[] => [
  `Whatnot Packing Slip ${page}`,
  `To: ${handle} From: rm_cardz`,
  `${name} ■ ${AUG_BANNER}`,
  ...addr,
  'QTY Name & Description Attributes Subtotal'
]
const augAddr = (line: string): string[] => [`${line} ${AUG_TAIL} ■`, '03 August, 2026']
// A long address wraps, and the banner lands in the middle of it. The real
// export has both shapes, and having both here matters: with every address
// ending "…. US" the banner learner would take the country for part of the
// banner, and the fixture would pin behaviour the real document never produces.
const augWrapped = (a: string, b: string): string[] => [`${a} ${AUG_TAIL} ■`, `${b} 03 August, 2026`]
const augFoot = (n: number, total: number): string[] => [
  `${n} Items $${total.toFixed(2)}`,
  `USPS Ground Advantage™ #${augTrack()} 14.0 oz`
]

const augPages: string[] = []

// Pages 1–3: one buyer whose order runs on, ending in a rider. Nine of the July
// show's orders did this and one took five pages.
augPages.push(
  [
    ...augHead(
      'quarrymoon',
      'Dana Whitlock',
      augWrapped('18 Falconer Way. Elkhart Lake, WI.', '53020-1187. US'),
      '1/3'
    ),
    ...augItem(AUG_TEAMS[0], 28, 1),
    ...augItem(AUG_TEAMS[1], 32, 1)
  ].join('\n')
)
// A continuation page: the slip header repeats, the buyer block does not.
augPages.push(
  ['Whatnot Packing Slip 2/3', ...augItem(AUG_TEAMS[2], 19, 1), ...augItem(AUG_TEAMS[3], 21, 1)].join('\n')
)
augPages.push(['Whatnot Packing Slip 3/3', ...augRider(AUG_TEAMS[7]), ...augFoot(5, 100)].join('\n'))

// Page 4: two items on one page, and they are in DIFFERENT breaks — which is
// the case a per-page break guess would get wrong.
augPages.push(
  [
    ...augHead('pinewood12', 'Marta Ellery', augAddr('6 Larkspur Bend. Ojai, CA. 93023-2210. US'), '1/1'),
    ...augItem(AUG_TEAMS[4], 15, 1),
    ...augItem(AUG_TEAMS[5], 17, 2),
    ...augFoot(2, 32)
  ].join('\n')
)

// The rest of both slates, one buyer to a page, the way most of the real slip is.
const augRest: Array<{ team: string; brk: number }> = []
for (let i = 5; i < 30; i++) augRest.push({ team: AUG_TEAMS[i], brk: 1 })
for (let i = 0; i < 30; i++) if (i !== 5) augRest.push({ team: AUG_TEAMS[i], brk: 2 })
augRest.forEach((r, i) => {
  const n = i + 1
  const price = 12 + (n % 7)
  augPages.push(
    [
      ...augHead(
        `buyer${String(n).padStart(2, '0')}`,
        `Casey Fixture ${n}`,
        augAddr(`${n} Sycamore Row. Bellwood, OR. 97000-${1000 + n}. US`),
        '1/1'
      ),
      ...augItem(r.team, price, r.brk),
      ...augFoot(1, price)
    ].join('\n')
  )
})

// A giveaway-only package: real, and the reason the supply model has a
// single-mailer rate.
augPages.push(
  [
    ...augHead('hollowmint', 'Ruth Vandermeer', augAddr('44 Copperline Ct. Argyle, TX. 76226-6018. US'), '1/1'),
    ...augRider(AUG_TEAMS[11]),
    ...augFoot(1, 0)
  ].join('\n')
)

// `auto`, because that is what the Upload screen sends. The league has to come
// out of the team column — the only other text on these pages is a product name
// and a bracket.
const aug = parsePages(augPages, { sport: 'auto' })

ok(aug.sport === 'mlb', 'the league is detected from the team column', String(aug.sport))
ok(aug.customers.length === 57, 'every buyer on the slip becomes a customer', String(aug.customers.length))
ok(aug.teamSlots.length === 62, 'and every printed item becomes exactly one card', String(aug.teamSlots.length))
ok(
  aug.warnings.length === 0,
  'a clean slip raises NO warnings — no false alarms was the explicit ask',
  JSON.stringify(aug.warnings.map((w) => w.message))
)

// --- the break labels are the numbers, and nothing else --------------------
ok(
  aug.breaks.map((b) => b.breakLabel).join(',') === '1,2',
  'the breaks are labelled by their printed number',
  JSON.stringify(aug.breaks.map((b) => b.breakLabel))
)
ok(
  aug.breaks.every((b) => b.breakLabel === String(b.breakNumber)),
  'with the label and the number in agreement',
  JSON.stringify(aug.breaks.map((b) => [b.breakLabel, b.breakNumber]))
)
// A CLEAN SLATE, which is what the owner checked on the real one: thirty cards
// in each break, thirty DIFFERENT teams, nobody claimed twice.
for (const label of ['1', '2']) {
  const inBreak = aug.teamSlots.filter((s) => s.breakLabel === label)
  ok(inBreak.length === 30, `break ${label} holds a full 30-team slate`, String(inBreak.length))
  ok(
    new Set(inBreak.map((s) => s.teamName)).size === 30,
    `and thirty DISTINCT teams — no team claimed twice`,
    String(new Set(inBreak.map((s) => s.teamName)).size)
  )
}
ok(
  aug.breakAudit.every((a) => a.collisions.length === 0 && a.missingTeams.length === 0),
  'so the fidelity audit finds neither a collision nor a hole',
  JSON.stringify(aug.breakAudit.map((a) => ({ l: a.breakLabel, c: a.collisions.length, m: a.missingTeams.length })))
)

// --- the team column, which is where the bracketed layout used to fail -----
// Every card on a new-layout slip once came out named "]". These four
// assertions are that failure, pinned four ways.
ok(
  aug.teamSlots.every((s) => !/[[\]()<>]/.test(s.teamName)),
  'no team name carries a bracket',
  JSON.stringify(aug.teamSlots.map((s) => s.teamName).filter((t) => /[[\]()<>]/.test(t)))
)
ok(
  aug.teamSlots.every((s) => s.teamName.trim().length > 0),
  'and none of them is empty'
)
ok(
  aug.teamSlots.every((s) => !/break/i.test(s.teamName)),
  'nor named after the marker that sits under it',
  JSON.stringify(aug.teamSlots.map((s) => s.teamName).filter((t) => /break/i.test(t)))
)
ok(
  aug.teamSlots.every((s) => AUG_TEAMS.includes(s.teamName)),
  'every card names a real MLB team',
  JSON.stringify([...new Set(aug.teamSlots.map((s) => s.teamName))].filter((t) => !AUG_TEAMS.includes(t)))
)

// --- a page holding two items yields two cards, in their own breaks --------
const pine = aug.teamSlots.filter((s) => s.customerId === 'pinewood12')
ok(pine.length === 2, 'a two-item page yields one card per item', String(pine.length))
ok(
  pine.map((s) => `${s.breakLabel}:${s.teamName}`).join(' | ') ===
    `1:${AUG_TEAMS[4]} | 2:${AUG_TEAMS[5]}`,
  'each taking the marker printed under IT, not the one above',
  JSON.stringify(pine.map((s) => `${s.breakLabel}:${s.teamName}`))
)

// --- prices ---------------------------------------------------------------
ok(
  pine.map((s) => s.price).join(',') === '15,17',
  'the subtotal on the joined row parses as the price',
  JSON.stringify(pine.map((s) => s.price))
)
const augExpected = 28 + 32 + 19 + 21 + 15 + 17 + augRest.reduce((a, _r, i) => a + 12 + ((i + 1) % 7), 0)
ok(
  aug.teamSlots.reduce((a, s) => a + s.price, 0) === augExpected,
  'and the show totals what the printed prices add to',
  `${aug.teamSlots.reduce((a, s) => a + s.price, 0)} vs ${augExpected}`
)

// --- giveaways ------------------------------------------------------------
const augGiveaways = aug.teamSlots.filter((s) => s.isGiveaway)
ok(augGiveaways.length === 2, 'the promo riders are flagged as giveaways', String(augGiveaways.length))
ok(augGiveaways.every((s) => s.price === 0), 'and every one of them is $0.00')
ok(
  augGiveaways.every((s) => s.breakLabel === null && s.breakId.startsWith('giveaway_')),
  'a rider carries no break — it is a card from a break that already happened',
  JSON.stringify(augGiveaways.map((s) => `${s.breakLabel}/${s.breakId}`))
)
ok(
  aug.teamSlots.filter((s) => !s.isGiveaway).every((s) => s.price > 0),
  'while nothing that was paid for is mistaken for one'
)

// --- the buyer block, and a run-on order ----------------------------------
const augBig = aug.customers.find((c) => c.id === 'quarrymoon')
ok(JSON.stringify(augBig?.pages) === '[1,2,3]', 'a three-page order carries all three pages',
   JSON.stringify(augBig?.pages))
ok(
  aug.teamSlots.filter((s) => s.customerId === 'quarrymoon').length === 5,
  'with every card from every one of them',
  String(aug.teamSlots.filter((s) => s.customerId === 'quarrymoon').length)
)
ok(augBig?.realName === 'Dana Whitlock', 'the buyer name survives the banner glued to it', String(augBig?.realName))
ok(
  augBig?.address === '18 Falconer Way. Elkhart Lake, WI., 53020-1187. US',
  'and a wrapped address keeps both halves with the banner cut out of the middle',
  String(augBig?.address)
)
ok(
  aug.customers.every((c) => !/RANDOM TEAMS|TRIBUTE AND CHROME|■|August/.test(`${c.realName} ${c.address}`)),
  'no banner text or banner date lands in anybody’s name or address'
)
ok(
  aug.customers.find((c) => c.id === 'pinewood12')?.pages?.join(',') === '4',
  'and a one-page order is exactly one page',
  JSON.stringify(aug.customers.find((c) => c.id === 'pinewood12')?.pages)
)

// --- how the marker gets typed --------------------------------------------
//
// Every shape the owner has seen on a real slip, and all of them are read. The
// bare "#4" is the deliberate trade: "#" before a number is also how a lot, a
// pack and a quantity are written, so it counts ONLY when it is alone on its
// own line — which is exactly where "[Break 1]" sits in the Attributes column.
// A "#12" with anything else on its line is still refused; that guard is tested
// on its own in section 6, and it is what makes reading this one safe.
console.log('\n--- however the break marker is typed ---')
const augMarker = (marker: string): ReturnType<typeof parsePages> =>
  parsePages(
    [
      [
        ...augHead('markertest', 'Ivo Renshaw', augAddr('9 Kestrel Loop. Bend, OR. 97701-1010. US'), '1/1'),
        `1 ${AUG_TEAMS[23]} Order 1990000001 $28.00`,
        ...AUG_PRODUCT,
        marker,
        ...augFoot(1, 28)
      ].join('\n')
    ],
    { sport: 'mlb' }
  )

for (const [marker, label] of [
  ['[Break 2]', '2'],
  ['Break 3', '3'],
  ['- Break #5 -', '5'],
  ['(Break 6)', '6'],
  ['[ BREAK 7a ]', '7A']
] as Array<[string, string]>) {
  const r = augMarker(marker)
  ok(
    r.breaks.length === 1 && r.breaks[0]?.breakLabel === label && r.warnings.length === 0,
    `“${marker}” reads as break ${label}, quietly`,
    JSON.stringify({ labels: r.breaks.map((b) => b.breakLabel), warnings: r.warnings.map((w) => w.message) })
  )
  ok(
    r.teamSlots[0]?.teamName === AUG_TEAMS[23],
    `and the team still comes from the name column, not from “${marker}”`,
    String(r.teamSlots[0]?.teamName)
  )
}

// The two the owner asked for by name. Both now land, both silently, and the
// card keeps its team and price either way — a marker contributes the break and
// nothing else, so the name column is still what names the team.
for (const [marker, label] of [
  ['#4', '4'],
  ['BREAK #=7', '7']
] as Array<[string, string]>) {
  const r = augMarker(marker)
  ok(
    r.breaks.length === 1 && r.breaks[0]?.breakLabel === label,
    `“${marker}” reads as break ${label}`,
    JSON.stringify(r.breaks.map((b) => b.breakLabel))
  )
  ok(
    r.warnings.length === 0,
    `and raises no warning — it is a break, not a loose card`,
    JSON.stringify(r.warnings.map((w) => w.message))
  )
  ok(
    r.teamSlots.length === 1 && r.teamSlots[0]?.teamName === AUG_TEAMS[23] && r.teamSlots[0]?.price === 28,
    `while the card keeps its team and price through “${marker}”`,
    JSON.stringify(r.teamSlots.map((s) => `${s.teamName}:${s.price}`))
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 6. every way a break gets written, and every way it does not ===')
// ---------------------------------------------------------------------------
// The owner writes the break number several ways and asked for all of them to
// land, without false alarms. The bare `#4` is the deliberate trade: `#` in
// front of a number is ALSO how a lot, a pack, a quantity and a tracking number
// are written, so it counts only when it is alone on its own line — the exact
// position `[Break 1]` occupies in the Attributes column of a real slip. The
// negatives below are the whole reason that guard is narrow, and they matter
// more than the positives.
const READS: Array<[string, string | null, string]> = [
  ['[Break 2]', '2', 'the bracketed form the August slips print'],
  ['Break 3', '3', 'the bare word'],
  ['- Break #5 -', '5', 'fenced by dashes'],
  ['(Break 6)', '6', 'parenthesised'],
  ['[ BREAK 7a ]', '7A', 'shouted, spaced, suffixed'],
  ['Break #11A', '11A', 'a suffix keeps its letter'],
  // Thirty rows of one real export carry this typo. Without it, thirty cards
  // fall out of their break and turn up loose.
  ['BREAK #=7', '7', 'the "#=" typo'],
  ['#4', '4', 'a bare hash, alone on its line'],
  ['  #4  ', '4', 'and the same padded'],
  ['#=9', '9', 'a bare hash carrying the typo'],
  ['Order 1237174001\n4x 2026 CHROME BASEBAL\n#4', '4', 'a bare hash below the item lines'],
  // The negatives. Each of these is a real string off a real slip.
  ['#12 Boston Red Sox', null, 'a hash with a TEAM after it is a quantity, not a break'],
  ['(Fresh From Box) #12', null, 'a trailing lot number is not a break'],
  ['4x 2026 CHROME BASEBAL JUMBO BOX (HALF CASE!)', null, 'a product title is not a break'],
  ['USPS Ground Advantage #9300120762602378819581', null, 'a tracking number is not a break'],
  ['1 San Francisco Giants Order 1237174001 $28.00', null, 'an item row is not a break'],
  // The word always outranks the bare form, whichever order they appear in.
  ['Break 1\n#9', '1', 'an explicit label beats a stray hash below it'],
  ['#9\nBreak 1', '1', 'and beats one above it']
]
for (const [text, want, why] of READS) {
  const got = readBreakLabel(text)
  const label = got ? got.label : null
  ok(label === want, `break: ${why}`, `${JSON.stringify(text).slice(0, 40)} -> ${String(label)}`)
}
// A marker contributes the break and nothing else — reading the text after it
// as a team is the `]` bug that put a bracket in the pick list.
ok(readBreakLabel('#4')?.marker === true, 'a bare hash is a marker, so it offers no team')
ok(readBreakLabel('[Break 2]')?.marker === true, 'and so is a bracketed label')

// ---------------------------------------------------------------------------
console.log('\n=== 7. the product NAME is not the break number ===')
// ---------------------------------------------------------------------------
// Reported from the floor as "the PDF does not match what is extracted per
// break". Whatnot prints the product in the description column and the break in
// the attributes column below it, and the product is called things like
// "1x BREAK 2026 FINEST BASEBALL HOBBY BOX". The first "Break <digits>" in the
// window used to win, and `\d{1,3}` took "202" out of "2026" — so the card was
// filed under break #202, a break nobody ran, while the [Break 5] two lines down
// was never looked at. On screen: a #202 chip beside a page reading Break 5.
ok(readBreakLabel('1x BREAK 2026 FINEST BASEBALL HOBBY BOX') === null,
  'a four-digit year is not a break number')
ok(readBreakLabel('BREAK 2026') === null, 'nor on its own')
ok(readBreakLabel('Break 1234567890') === null, 'and neither is an order id')
// The marker wins wherever it sits, which is the general form of the same rule:
// a phrase containing the word is weaker evidence than the slip saying so.
ok(
  readBreakLabel('1x 2026 BREAK 30 TEAM RANDOM\nBoston Red Sox\n[Break 5]')?.label === '5',
  'a bracketed marker beats the word inside a product name',
  String(readBreakLabel('1x 2026 BREAK 30 TEAM RANDOM\nBoston Red Sox\n[Break 5]')?.label)
)
ok(readBreakLabel('Break 11A')?.label === '11A', 'and a plain label still reads')
ok(readBreakLabel('Break #=7')?.label === '7', 'including the =7 typo')

const yearSlip = [
  'Whatnot Packing Slip',
  'To: @casey12',
  'Casey Miller',
  '12 Elm Street',
  'Springfield, IL 62704',
  'Order 1237174001',
  'Item                                   Qty   Price   Attributes',
  '1x BREAK 2026 FINEST BASEBALL HOBBY BOX  1   $28.00',
  'Boston Red Sox',
  '[Break 5]',
  'USPS 9400111899561234567890'
].join('\n')
const yearOut = parsePages([yearSlip], { league: 'MLB' } as never) as unknown as Record<
  string,
  Array<Record<string, unknown>>
>
ok(yearOut.teamSlots.length === 1, 'the slip yields exactly one card', String(yearOut.teamSlots.length))
ok(yearOut.teamSlots[0]?.breakLabel === '5', 'in break 5, as printed', String(yearOut.teamSlots[0]?.breakLabel))
ok(yearOut.teamSlots[0]?.teamName === 'Boston Red Sox', 'for the right team', String(yearOut.teamSlots[0]?.teamName))
ok(yearOut.teamSlots[0]?.price === 28, 'at the right price', String(yearOut.teamSlots[0]?.price))
ok(yearOut.warnings.length === 0, 'with nothing to warn about', JSON.stringify(yearOut.warnings.map((w) => w.message)))

// ---------------------------------------------------------------------------
console.log('\n=== 8. "PRE-ORDER" in a product name is not an order id ===')
// ---------------------------------------------------------------------------
// The same class of fault one column over. "4x PRE-ORDER 2026 CHROME BASEBALL"
// registered as a second order whose id was the year, and a one-card $28 order
// came out as a phantom "PRE" card for $28 under order 2026 plus a $0 giveaway —
// with the card the customer actually bought in neither of them.
const preSlip = [
  'Whatnot Packing Slip',
  'To: @casey12',
  'Casey Miller',
  '12 Elm Street',
  'Springfield, IL 62704',
  'Order 1237174001',
  'Item                                   Qty   Price   Attributes',
  '4x PRE-ORDER 2026 CHROME BASEBAL         1   $28.00',
  'Boston Red Sox',
  '[Break 1]',
  'USPS 9400111899561234567890'
].join('\n')
const preOut = parsePages([preSlip], { league: 'MLB' } as never) as unknown as Record<
  string,
  Array<Record<string, unknown>>
>
ok(preOut.teamSlots.length === 1, 'one card, not two', String(preOut.teamSlots.length))
ok(preOut.teamSlots[0]?.teamName === 'Boston Red Sox', 'and it is the team on the slip', String(preOut.teamSlots[0]?.teamName))
ok(preOut.teamSlots[0]?.orderId === '1237174001', 'under the real order id', String(preOut.teamSlots[0]?.orderId))
ok(preOut.teamSlots[0]?.isGiveaway === false, 'and it is not a giveaway')
ok(preOut.warnings.length === 0, 'with nothing to warn about', JSON.stringify(preOut.warnings.map((w) => w.message)))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
