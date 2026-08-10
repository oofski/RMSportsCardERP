/**
 * Reading a supplier's text message into purchase-order rows.
 *
 * @shared/supplierOffers is pure — no DB, no DOM, no clock — so the whole of it
 * can be driven from strings, and it is worth driving hard: every defect in a
 * parser like this one produces a PLAUSIBLE purchase order rather than an
 * error. A quantity read as 1 instead of 5, a price read as $1,080 instead of
 * $10.80, a line silently dropped between the greeting and the sign-off: none
 * of those look wrong on screen and all of them are money.
 *
 * What is pinned here, and how each one fails if it is not:
 *
 *   1. NINE LINES IN, NINE ROWS OUT. The one property that makes the review
 *      trustworthy. A line the parser cannot read has to survive as a row
 *      carrying its own text — dropped, it is money the operator never sees
 *      leave the list.
 *
 *   2. THE PARSER NEVER INVENTS A PRICE. No "$", malformed thousands, three
 *      decimal places: all refused, none guessed. "$10,80" reads as 1080 if you
 *      just strip commas, which is a hundred times what the supplier wrote.
 *
 *   3. EVERY LINE IS A CASE PRICE, "per" OR NOT. The owner settled this: the
 *      word is inconsistent typing. Two lines identical but for it must produce
 *      identical readings, or the screen starts making distinctions that mean
 *      nothing.
 *
 *   4. THE FLIP RECOMPUTES FROM WHAT WILL BE STORED. A purchase order keeps a
 *      unit price and multiplies; if the review's total came from anywhere else
 *      the screen could show one number and the saved PO hold another.
 *
 *   5. THE CENTURY AND SEASON RULES ARE FIXED, not clock-dependent. Same paste,
 *      same rows, this year and next.
 *
 *   6. A LINE IS NEVER SILENTLY ATTACHED TO THE WRONG PRODUCT. Two candidates,
 *      a different year, or a product stocked in the other unit all have to
 *      reach a person rather than arrive pre-selected.
 *
 * EVERY PRODUCT NAME, PRICE AND COUNT BELOW IS INVENTED. This repository is
 * public; the rules came from a real supplier message, the values did not.
 *
 * Run: npm run test:offers
 */
import {
  AMBIGUOUS_ABBREVIATIONS,
  CONFIDENT_MIN_SCORE,
  catalogQueriesFor,
  lineTotalOf,
  matchOfferLine,
  offerTotal,
  parseSupplierOffer,
  pricingNote,
  unitPriceOf,
  type MatchableProduct,
  type OfferLine,
  type ParsedOfferLine
} from '../src/shared/supplierOffers'

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

/** Parse one line and hand back the row, whatever kind it turned out to be. */
function one(text: string): OfferLine {
  const r = parseSupplierOffer(text)
  if (r.lines.length !== 1) {
    throw new Error(`expected 1 row from ${JSON.stringify(text)}, got ${r.lines.length}`)
  }
  return r.lines[0]
}

/** Parse one line that is expected to be readable. */
function offer(text: string): ParsedOfferLine {
  const line = one(text)
  if (!line.ok) throw new Error(`expected ${JSON.stringify(text)} to parse: ${line.reason}`)
  return line
}

// ---------------------------------------------------------------------------
console.log('=== 1. a whole message, the way one arrives ===')
// ---------------------------------------------------------------------------
// Nine offers wrapped in the things a real message is wrapped in: a greeting, a
// blank line, a heading, a note and a signature.
const MESSAGE = [
  'Hey — here is what I can do this week:',
  '',
  'Football:',
  '26 Reflector FB Crest-$3150 per (4cs)',
  '26 Reflector FB Vault-$2725 per (6cs)',
  '26 Lantern Crest-$1840 per (9cs)',
  '26 Beacon Jumbo FB-$3320 (4cs)',
  '26 Beacon FB Crest-$4,180 (7cs)',
  '26/7 Beacon BKB Standard-$5,940 (2cs)',
  '27 Meridian Two-$1275 (3cs)',
  '26 Aurora Baseball-$960 (8cs)',
  '27 Nova FIFA Cup-$2410 per (5cs)',
  '',
  'Prices hold until Friday.',
  'Thanks',
  'Sam'
].join('\n')

const message = parseSupplierOffer(MESSAGE)
ok(message.lines.length === 9, 'nine offers produce nine rows', String(message.lines.length))
ok(message.lines.every((l) => l.ok), 'and all nine are readable')
ok(
  message.ignored.length === 5,
  'the greeting, the heading, the note and both signature lines are left out',
  message.ignored.map((g) => g.raw).join(' | ')
)
ok(
  message.consideredLines === message.lines.length + message.ignored.length,
  'every non-blank line is accounted for exactly once',
  `${message.consideredLines} vs ${message.lines.length}+${message.ignored.length}`
)
ok(
  message.lines.map((l) => l.lineNumber).join(',') === '4,5,6,7,8,9,10,11,12',
  'and each row knows which line of the paste it came from',
  message.lines.map((l) => l.lineNumber).join(',')
)
// The blank lines are not rows AND not "left out" — there is nothing to report
// about them, and listing them would bury the five lines worth looking at.
ok(!message.ignored.some((g) => g.raw.trim() === ''), 'blank lines are not reported at all')

const first = message.lines[0] as ParsedOfferLine
ok(first.season?.label === '2026', 'the season expands', String(first.season?.label))
ok(first.productText === 'Reflector FB Crest', 'the product keeps the supplier’s own words', first.productText)
ok(first.searchText === 'Reflector Football Crest', 'and is searched with the sport spelled out', first.searchText)
ok(first.price === 3150, 'the price is the number after the "$"', String(first.price))
ok(first.quantity === 4 && first.unit === 'case', 'the count and its unit', `${first.quantity}${first.unit}`)
ok(lineTotalOf(first) === 12600, 'and the line comes to 4 x $3,150', String(lineTotalOf(first)))

// ---------------------------------------------------------------------------
console.log('\n=== 2. "per" is noise — every line is a case price ===')
// ---------------------------------------------------------------------------
// The owner's ruling. Two lines differing ONLY in the word have to read the
// same, or the review starts drawing a distinction that means nothing and
// somebody "fixes" a row that was already right.
const withPer = offer('26 Halo FB Crest-$2400 per (5cs)')
const without = offer('26 Halo FB Crest-$2400 (5cs)')
ok(withPer.basis === 'per-unit', 'a line saying "per" is a case price')
ok(without.basis === 'per-unit', 'and so is a line that does not say it')
ok(
  unitPriceOf(withPer) === unitPriceOf(without) && lineTotalOf(withPer) === lineTotalOf(without),
  'the two read to the same money',
  `${lineTotalOf(withPer)} vs ${lineTotalOf(without)}`
)
ok(withPer.productText === without.productText, '"per" never lands in the product name', withPer.productText)
ok(withPer.productText === 'Halo FB Crest', 'which stays exactly what was typed', withPer.productText)
ok(lineTotalOf(withPer) === 12000, 'five cases at $2,400 is $12,000', String(lineTotalOf(withPer)))
ok(pricingNote(withPer) === null, '"per" agrees with the reading, so the row says nothing about it')
ok(offer('26 Halo FB Crest-$2400 per case (5cs)').productText === 'Halo FB Crest', '"per case" too')
ok(offer('26 Halo FB Crest-$2400 each (5cs)').productText === 'Halo FB Crest', 'and "each"')

// A set really called Total, written BEFORE the price, is a product name and
// must survive intact — stripping it there would search the catalog for a name
// nobody used.
const namedTotal = offer('27 Meridian Total-$1180 (3cs)')
ok(namedTotal.productText === 'Meridian Total', 'a product called Total keeps its name', namedTotal.productText)
ok(pricingNote(namedTotal) === null, 'and is not mistaken for a lot price')

// The same word AFTER the price is a qualifier. It does not move the reading —
// that rule is fixed — but the row is told, because deleting a word the
// supplier wrote without saying so is the app deciding it did not matter.
const saysTotal = offer('27 Meridian Two-$1180 total (3cs)')
ok(saysTotal.basis === 'per-unit', 'a line saying "total" is still read per case')
ok(lineTotalOf(saysTotal) === 3540, 'so it comes to 3 x $1,180', String(lineTotalOf(saysTotal)))
ok(saysTotal.productText === 'Meridian Two', 'the word is kept out of the product name', saysTotal.productText)
ok((pricingNote(saysTotal) ?? '').includes('total'), 'and the row is told which word it removed', String(pricingNote(saysTotal)))

// ---------------------------------------------------------------------------
console.log('\n=== 3. flipping a row to a lot price ===')
// ---------------------------------------------------------------------------
// The control the owner asked to keep. A purchase order stores a unit price and
// multiplies, so the review's figures must come from that same unit price —
// otherwise the screen can show the quoted total while the saved PO holds
// something else.
const flipped: ParsedOfferLine = { ...offer('26 Halo FB Crest-$2400 (5cs)'), basis: 'total' }
ok(unitPriceOf(flipped) === 480, '$2,400 over five cases is $480 a case', String(unitPriceOf(flipped)))
ok(lineTotalOf(flipped) === 2400, 'and the line is the $2,400 that was quoted', String(lineTotalOf(flipped)))

// The awkward divide, which is the reason a unit price is held at four places
// rather than two. At two, $10,000/3 stores $3,333.33 and multiplies back to
// $9,999.99 — a purchase order a cent short of the quote for no findable
// reason. At four it lands back on the quote.
const thirds: ParsedOfferLine = { ...offer('26 Halo FB Crest-$10,000 (3cs)'), basis: 'total' }
ok(unitPriceOf(thirds) === 3333.3333, 'a non-terminating unit price keeps four places', String(unitPriceOf(thirds)))
ok(lineTotalOf(thirds) === 10000, 'and the line still totals the quoted $10,000', String(lineTotalOf(thirds)))
const sevenths: ParsedOfferLine = { ...offer('26 Halo FB Crest-$10 (7cs)'), basis: 'total' }
ok(lineTotalOf(sevenths) === 10, 'same for a seventh', String(lineTotalOf(sevenths)))

// A quantity box is empty for one keystroke. Dividing by that must not put
// "$Infinity" on a purchase-order screen.
const emptied: ParsedOfferLine = { ...flipped, quantity: 0 }
ok(unitPriceOf(emptied) === 0, 'a zero count divides to zero, not to infinity', String(unitPriceOf(emptied)))
ok(lineTotalOf(emptied) === 0, 'and the line total with it', String(lineTotalOf(emptied)))

ok(
  offerTotal([first, withPer]) === 24600,
  'the running total is the sum of the lines',
  String(offerTotal([first, withPer]))
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. the parser will not invent a price ===')
// ---------------------------------------------------------------------------
const noDollar = one('26 Halo FB Crest-2400 (5cs)')
ok(!noDollar.ok, 'a line with no "$" is refused rather than read')
ok(!noDollar.ok && noDollar.raw === '26 Halo FB Crest-2400 (5cs)', 'and keeps its own text to show')
// Three numbers on the line and no way to tell which is the price. Guessing is
// the failure this refusal exists to prevent.
ok(!noDollar.ok && noDollar.reason.includes('$'), 'the reason names what was missing', noDollar.ok ? '' : noDollar.reason)

const hundredfold = one('26 Halo FB Crest-$10,80 (5cs)')
ok(!hundredfold.ok, '"$10,80" is refused — stripped of its comma it is 100x the likely intent')

const tooPrecise = one('26 Halo FB Crest-$2400.125 (5cs)')
ok(!tooPrecise.ok, 'three decimal places is not money')

ok(!one('26 Halo FB Crest-$0 (5cs)').ok, 'a zero price is refused')
ok(offer('26 Halo FB Crest-$4,180 (7cs)').price === 4180, 'thousands separators are read', '')
ok(offer('26 Halo FB Crest-$2400.50 (2cs)').price === 2400.5, 'and cents')
ok(lineTotalOf(offer('26 Halo FB Crest-$2400.50 (2cs)')) === 4801, 'which multiply exactly', '')

// ---------------------------------------------------------------------------
console.log('\n=== 5. seasons, and the century rule ===')
// ---------------------------------------------------------------------------
const s = (text: string): ParsedOfferLine => offer(text)
ok(s('26 Halo FB-$1200 (2cs)').season?.startYear === 2026, 'a two-digit year is 20YY')
ok(s('26 Halo FB-$1200 (2cs)').season?.endYear === null, 'and a single-year season has no second year')
ok(s('26 Halo FB-$1200 (2cs)').season?.label === '2026', 'labelled as the year itself')

const split = s('26/7 Halo BKB-$1200 (2cs)')
ok(split.season?.startYear === 2026 && split.season?.endYear === 2027, '"26/7" is the 2026-27 season', JSON.stringify(split.season))
ok(split.season?.label === '2026-27', 'and reads back that way', String(split.season?.label))
ok(split.season?.raw === '26/7', 'while the row can still show exactly what was typed', String(split.season?.raw))
// The invariant behind "the next year ending in these digits": a season cannot
// end in the year it started. "26/6" resolving to 2026-2026 would print a label
// that looks fine and describes nothing.
const degenerate = s('26/6 Halo BKB-$1200 (2cs)')
ok(
  (degenerate.season?.endYear ?? 0) > (degenerate.season?.startYear ?? 0),
  'a split season always ends AFTER it starts',
  JSON.stringify(degenerate.season)
)

ok(s('26-27 Halo BKB-$1200 (2cs)').season?.endYear === 2027, '"26-27" too')
ok(s('2026-27 Halo BKB-$1200 (2cs)').season?.endYear === 2027, 'and "2026-27"')
// A four-digit year is honoured as typed; only the two-digit form is expanded.
ok(s('1997 Halo FB-$1200 (2cs)').season?.startYear === 1997, 'a four-digit year is left alone')
// The rollover a "next year ending in these digits" rule has to get right.
ok(s('1999-00 Halo BKB-$1200 (2cs)').season?.endYear === 2000, '"1999-00" rolls forward to 2000, not back to 1900')

// A single leading digit is a count somebody typed first, not a season.
const noSeason = s('3 Halo FB Crest-$1200 (2cs)')
ok(noSeason.season === null, 'one leading digit is not a season')
ok(noSeason.productText === '3 Halo FB Crest', 'and stays in the product name', noSeason.productText)

// A season is read off the FRONT or not at all. Hunting for the first
// two-digit number anywhere on the line turns a pack count in the middle of a
// product name into a release year AND eats the words before it — so the row
// would show a different product from the one the supplier named.
const midNumber = s('Halo 26 Pack Crest-$1200 (2cs)')
ok(midNumber.season === null, 'a number inside a product name is not a season', JSON.stringify(midNumber.season))
ok(midNumber.productText === 'Halo 26 Pack Crest', 'and the whole name survives', midNumber.productText)

// ---------------------------------------------------------------------------
console.log('\n=== 6. counts, and their units ===')
// ---------------------------------------------------------------------------
ok(offer('26 Halo FB-$1200 (7cs)').quantity === 7, '"(7cs)"')
ok(offer('26 Halo FB-$1200 (7 cases)').quantity === 7, '"(7 cases)"')
ok(offer('26 Halo FB-$1200 7 case').quantity === 7, 'and no brackets at all')
ok(offer('26 Halo FB-$1200 (7cs)').unit === 'case', 'cs is cases')
ok(offer('26 Halo FB-$1200 (7bx)').unit === 'box', 'bx is boxes')
ok(offer('26 Halo FB-$1200 (7 boxes)').unit === 'box', 'and so is "boxes"')

// No count at all: one unit, FLAGGED. The money is the same either way at a
// count of one, but the row must not read as a quantity the supplier stated.
const noCount = offer('26 Halo FB Crest-$1200')
ok(noCount.quantity === 1, 'a line with no count is one unit')
ok(noCount.quantityAssumed, 'and says so')
ok(offer('26 Halo FB-$1200 (7cs)').quantityAssumed === false, 'a stated count is not flagged')

// A fraction of a case is not something this app can stock, and reading "1.5cs"
// as five — or as one — is worse than refusing it.
const half = one('26 Halo FB Crest-$1200 (1.5cs)')
ok(!half.ok, 'a fractional count is refused rather than rounded')
ok(!half.ok && half.reason.includes('1.5cs'), 'and the reason quotes it', half.ok ? '' : half.reason)

// A number inside the product name must not be mistaken for the count.
const numbered = offer('26 Halo 6 Pack Crest-$1200 (2cs)')
ok(numbered.quantity === 2, 'a count-shaped number in the name is not the count', String(numbered.quantity))
ok(numbered.productText === 'Halo 6 Pack Crest', 'and the rest stays in the name', numbered.productText)

// The harder version: a product whose NAME contains a real count and a real
// unit. "3 Box" is part of what is being sold; "(2cs)" is how much of it. Read
// the first one and the order becomes three boxes of something nobody offered.
const twoCounts = offer('26 Halo 3 Box Bundle-$1200 (2cs)')
ok(twoCounts.quantity === 2, 'the LAST count on the line is the one being sold', String(twoCounts.quantity))
ok(twoCounts.unit === 'case', 'with its own unit, not the name\'s', twoCounts.unit)
ok(twoCounts.productText === 'Halo 3 Box Bundle', 'and the name keeps its own', twoCounts.productText)

// ---------------------------------------------------------------------------
console.log('\n=== 7. sport shorthand ===')
// ---------------------------------------------------------------------------
const fb = offer('26 Halo FB Crest-$1200 (2cs)')
ok(fb.searchText === 'Halo Football Crest', 'FB is searched as Football', fb.searchText)
ok(fb.productText === 'Halo FB Crest', 'and the row still shows what was typed', fb.productText)
ok(
  fb.expansions.length === 1 && fb.expansions[0].from === 'FB' && fb.expansions[0].to === 'Football',
  'the row can show its working',
  JSON.stringify(fb.expansions)
)
ok(offer('26 Halo BKB Crest-$1200 (2cs)').searchText === 'Halo Basketball Crest', 'BKB is Basketball')
ok(offer('26 halo bkb crest-$1200 (2cs)').searchText === 'halo Basketball crest', 'in any case')

// The refusal that matters. "BB" is baseball to half this trade and basketball
// to the other half, both are bought here from the same brands, and an
// expansion that is right most of the time would put a confident match on a row
// that deserves a question.
const bb = offer('26 Halo BB Crest-$1200 (2cs)')
ok(bb.searchText === 'Halo BB Crest', 'BB is left alone', bb.searchText)
ok(bb.expansions.length === 0, 'and nothing claims to have expanded it')
ok('bb' in AMBIGUOUS_ABBREVIATIONS, 'the refusal is written down rather than merely absent')

// ---------------------------------------------------------------------------
console.log('\n=== 8. what is not an order line ===')
// ---------------------------------------------------------------------------
const wrapper = parseSupplierOffer(
  ['Hi Sam', 'New releases:', '', 'Best,', 'Jo', 'Sent from my phone'].join('\n')
)
ok(wrapper.lines.length === 0, 'a message with no offers produces no rows')
ok(wrapper.ignored.length === 5, 'and reports the five non-blank lines it left out', String(wrapper.ignored.length))

// Anything carrying money or a count outranks every courtesy pattern — a line
// that starts "Best price I have" is still a price.
const courteous = parseSupplierOffer('Best price I have: 26 Halo FB Crest-$1200 (2cs)')
ok(courteous.lines.length === 1 && courteous.lines[0].ok, 'a greeting word cannot suppress a priced line')

// A line that looks like an offer and cannot be read stays as a row. This is
// the property that lets somebody count rows against the message.
const mixed = parseSupplierOffer(
  ['26 Halo FB Crest-$1200 (2cs)', '26 Halo BKB Crest-1200 (2cs)', 'Thanks'].join('\n')
)
ok(mixed.lines.length === 2, 'two offer-shaped lines, two rows', String(mixed.lines.length))
ok(mixed.lines[0].ok && !mixed.lines[1].ok, 'one readable, one not')
ok(mixed.ignored.length === 1, 'and the sign-off is the only thing left out')

// ---------------------------------------------------------------------------
console.log('\n=== 9. finding the product, and refusing to guess it ===')
// ---------------------------------------------------------------------------
const CATALOG: MatchableProduct[] = [
  { id: 'a', name: '2026 Halo Football Crest Case', sku: 'HFC-26', year: '2026', unitType: 'case' },
  { id: 'b', name: '2026 Halo Football Crest Jumbo Case', sku: 'HFCJ-26', year: '2026', unitType: 'case' },
  { id: 'c', name: '2026 Halo Basketball Vault Case', sku: 'HBV-26', year: '2026', unitType: 'case' },
  { id: 'd', name: '2019 Halo Football Crest Case', sku: 'HFC-19', year: '2019', unitType: 'case' },
  { id: 'e', name: '2026 Aurora Baseball Standard Box', sku: 'ABS-26', year: '2026', unitType: 'box' }
]

// One survivor, saying what the line said: pre-selected.
const clean = matchOfferLine(offer('26 Halo BKB Vault-$1200 (2cs)'), CATALOG)
ok(clean.confidence === 'confident', 'one product carrying every word is confident', clean.confidence)
ok(clean.selected?.sku === 'HBV-26', 'and it is the right one', String(clean.selected?.sku))
ok(clean.note === null, 'with nothing for the operator to decide')

// Two survivors: the line did not say which, so neither does the app. Choosing
// between them would price stock at another product's cost.
const two = matchOfferLine(offer('26 Halo FB Crest-$1200 (2cs)'), CATALOG)
ok(two.confidence === 'uncertain', 'two products fitting the line is uncertain', two.confidence)
ok(two.selected === null, 'and NOTHING is pre-selected')
ok(
  two.options.filter((o) => o.complete).length === 2,
  'both are offered',
  two.options.map((o) => o.product.sku).join(',')
)
ok(two.options[0].product.sku === 'HFC-26', 'best first — the one saying least beyond the line', two.options[0].product.sku)

// The year is decisive. Two seasons of one product differ in nothing else and
// cost different money, so a disagreeing year is out before anything is scored.
const yearGate = matchOfferLine(offer('19 Halo FB Crest-$1200 (2cs)'), CATALOG)
ok(
  yearGate.options.every((o) => o.product.sku !== 'HFC-26'),
  'a 2026 product cannot match a 2019 line',
  yearGate.options.map((o) => o.product.sku).join(',')
)
ok(yearGate.confidence === 'confident' && yearGate.selected?.sku === 'HFC-19', 'and the right season is found', String(yearGate.selected?.sku))

// A word the line said and the catalog does not carry is a DIFFERENT product,
// not a weaker match. This is the floor, and it runs the opposite way to
// matchProductByName in db/inventory.ts — see the comment there.
const missingWord = matchOfferLine(offer('26 Halo FB Beacon-$1200 (2cs)'), CATALOG)
ok(missingWord.confidence === 'none', 'a word nothing in the catalog carries is not a match', missingWord.confidence)
ok(missingWord.selected === null, 'so nothing is pre-selected')
ok(missingWord.options.length > 0, 'but near-misses are still offered to pick from')

// Nothing at all: flagged, and the row asks.
const nothing = matchOfferLine(offer('26 Zephyr Handball-$1200 (2cs)'), [])
ok(nothing.confidence === 'none' && nothing.options.length === 0, 'an empty catalog answer is a flagged row')
ok((nothing.note ?? '').length > 0, 'with words the operator can act on')

// A product sharing NO word with the line is not a near-miss and is not worth
// offering. Listing them would put a page of unrelated products one click from
// a line that has none — which is how the wrong product gets attached by a
// person going quickly, and the whole point of this screen is that it does not.
const unrelated = matchOfferLine(offer('26 Zephyr Handball-$1200 (2cs)'), CATALOG)
ok(unrelated.confidence === 'none', 'a line with nothing in common is flagged', unrelated.confidence)
ok(
  unrelated.options.length === 0,
  'and is offered no choices at all rather than arbitrary ones',
  unrelated.options.map((o) => o.product.sku).join(',')
)

// The unit trap: a line counting cases against a product stocked in boxes. Not
// disqualifying — plenty of catalog rows are stocked the other way on purpose —
// but it can never arrive pre-selected, because 8 entered against a box-stocked
// product at a case price is an order-of-magnitude error in the cost basis.
const unitTrap = matchOfferLine(offer('26 Aurora Baseball Standard-$960 (8cs)'), CATALOG)
ok(unitTrap.confidence === 'uncertain', 'a unit that does not line up is never confident', unitTrap.confidence)
ok(unitTrap.selected === null, 'and is not pre-selected')
ok(unitTrap.options[0]?.unitMismatch === true, 'the option says so', JSON.stringify(unitTrap.options[0]?.unitMismatch))
ok((unitTrap.note ?? '').includes('box'), 'and the note names the unit', String(unitTrap.note))

// A lone survivor whose name says far more than the line did is a weaker claim
// than one that matches it, and asks rather than assumes.
const thin: MatchableProduct[] = [
  {
    id: 'z',
    name: '2026 Halo Football Crest Vault Standard Premium Case',
    sku: 'HALO-Z',
    year: '2026',
    unitType: 'case'
  }
]
const thinMatch = matchOfferLine(offer('26 Halo-$1200 (2cs)'), thin)
ok(thinMatch.confidence === 'uncertain', 'one word of six is not a confident match', thinMatch.confidence)
ok(thinMatch.options[0].score < CONFIDENT_MIN_SCORE, 'because it accounts for too little of the name', String(thinMatch.options[0].score))

// ---------------------------------------------------------------------------
console.log('\n=== 10. what the catalog gets asked ===')
// ---------------------------------------------------------------------------
// The catalog search requires EVERY term to appear, so a ladder is the only way
// a partly-recognised line produces candidates at all. Most specific first;
// never narrower than two words, because a one-word search answers nothing.
const ladder = catalogQueriesFor(offer('26 Halo FB Crest Vault-$1200 (2cs)'))
ok(ladder[0] === '2026 Halo Football Crest Vault', 'the year and the whole name first', ladder[0])
ok(ladder[1] === 'Halo Football Crest Vault', 'then without the year', ladder[1])
ok(ladder[2] === 'Halo Football Crest', 'then shortened from the right', ladder[2])
ok(
  ladder.every((q) => q.split(/\s+/).length >= 2),
  'and never down to a single word',
  ladder.join(' | ')
)
ok(new Set(ladder).size === ladder.length, 'with no query asked twice')
// A line with no season starts at the name — there is no year to lead with.
ok(catalogQueriesFor(offer('Halo FB Crest-$1200 (2cs)'))[0] === 'Halo Football Crest', 'no season, no year term')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
