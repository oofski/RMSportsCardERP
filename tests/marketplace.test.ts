/**
 * Telling a break spot from a whole product, and finding the product.
 *
 * Every string in here is copied verbatim out of two months of RM's real
 * Whatnot ledger (9,225 rows). That matters more than usual: the split is read
 * off a message Whatnot never intended as structured data, so the only evidence
 * that a rule works is that it works on what Whatnot actually wrote — including
 * the typos, the relocated club and the two boxes sold a pack at a time.
 *
 * Run: npm run test:marketplace
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const DIR = process.env.TEST_DB_DIR || join(process.cwd(), 'out/tests/mkt-db')
process.env.TEST_DB_DIR = DIR
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

/* eslint-disable @typescript-eslint/no-var-requires */
const { getDb } = require('../src/main/db/database')
const inventory = require('../src/main/db/inventory')
const {
  classifyLedgerRow,
  parseProductSaleName,
  booksToOwnDay,
  parseBreakNumber
} = require('../src/shared/financeStreaming')
const { isAnyLeagueTeam } = require('../src/main/shipping/teams')
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
const cls = (msg: string): string => classifyLedgerRow('SALES', `Earnings for selling a ${msg}`, isAnyLeagueTeam)

// ---------------------------------------------------------------------------
console.log('=== 1. whole products, from the real export ===')
// ---------------------------------------------------------------------------
const PRODUCTS = [
  '2025-26 Topps Chrome Cactus Jack Basketball Hobby Box',
  '2025-26 Panini Signature Series Basketball Hobby 12-Box Case',
  '2025 Topps Inception Baseball Hobby Box',
  '2026 Topps Chrome VeeFriends Hobby Box ',
  '2026 Panini Prizm FIFA World Cup Soccer Hobby Box ',
  '2020-21 Panini Prizm Basketball Hobby Box',
  '2025 Topps Stadium Club UFC Hobby Box '
]
for (const p of PRODUCTS) ok(cls(p) === 'product_sale', `product: ${p.trim().slice(0, 52)}`, cls(p))

// ---------------------------------------------------------------------------
console.log('\n=== 2. break spots, from the same export ===')
// ---------------------------------------------------------------------------
const SPOTS: Array<[string, string]> = [
  // The ordinary shape.
  ['1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #12 - Boston Red Sox', 'break number'],
  // A typo that appears 30 times in one export. Without the `=` every one of
  // these reads as a whole product.
  ['2x 2026 TIER ONE BASEBALL HOBBY BOX - NEW RELEASE!! BREAK #=7 - Detroit Tigers', 'BREAK #=7'],
  // The bracketed layout the new packing slips print. It must still be a SPOT,
  // not a product — otherwise the matcher hunts the catalog for the box the
  // break was cut from and books stock against something opened on stream.
  ['[Break 1] 2026 Topps Chrome Baseball Hobby Box - San Francisco Giants', 'bracketed break'],
  // No break marker at all — carried entirely by the team on the end.
  [
    '1x COSMIC CHROME FOOTBALL HOBBY BOX- CHASE PLANETARY PURSUIT, SUPER NOVA, COSMIC DUST, + 1/1s!! - Dallas Cowboys',
    'team only'
  ],
  // The club that moved. Canonical is "Athletics"; the listing says Oakland.
  ['4x 2025 INCEPTION BASEBALL-HALF CASE RANDOM TEAMS (4 BOXES) - Oakland Athletics', 'relocated club'],
  // Aliases the canonical slate does not carry.
  ['1x 2025/26 Cactus Jack Basketball NEW RELASE-RANDOM TEAMS - LA Lakers', 'LA Lakers'],
  ['2x Cactus Jack NBA NEW RELEASE-RANDOM TEAMS #1 - Philadelphia Sixers', 'Philadelphia Sixers'],
  // A box sold one pack at a time. Twelve rows, one box — booking these as
  // products would take twelve boxes out of stock for a box opened once.
  ['#2/2020-21 Prizm Basketball Hobby PACK (Fresh From Box) #12', 'numbered lot'],
  ['2020-2021 Prizm Basketball Hobby Pack (FRESH FROM BOX) #1', 'numbered lot, other spelling']
]
for (const [m, why] of SPOTS) ok(cls(m) === 'sale', `spot: ${why}`, cls(m))

// ---------------------------------------------------------------------------
console.log('\n=== 2b. the break NUMBER comes off every generation of the format ===')
// ---------------------------------------------------------------------------
// Classification and numbering are two different reads of the same string, and
// they drifted: RE_LEDGER_BREAK is unanchored so it always called "[Break 1]" a
// break, while parseBreakNumber wanted either "- Break #n" or "Break n:" and
// returned null. The row landed in the right bucket with no break on it, so the
// money was right and the attribution was blank — the quiet half of the same
// bug the packing slip showed loudly.
const BREAKS: Array<[string, number | null, string]> = [
  ['1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #12 - Boston Red Sox', 12, 'trailing "- Break #12"'],
  ['2x 2026 TIER ONE BASEBALL HOBBY BOX - NEW RELEASE!! BREAK #=7 - Detroit Tigers', 7, 'the "#=" typo'],
  ['Earnings for selling a Break 19: 4x TOPPS CHROME BASEBALL - Phillies', 19, 'leading "Break 19:"'],
  // The new slip layout, and the reason this section exists.
  ['Earnings for selling a [Break 1] 2026 Topps Chrome Baseball Hobby Box - San Francisco Giants', 1, 'bracketed'],
  ['Earnings for selling a [Break 12] ... - Arizona Diamondbacks', 12, 'bracketed, two digits'],
  ['Earnings for selling a ( Break 3 ) ... - New York Mets', 3, 'parenthesised and spaced'],
  ['Earnings for selling a (Break #12 - Boston Red Sox)', 12, 'an OPEN bracket with the team still behind it'],
  // A suffixed label loses its letter here on purpose: the column is an
  // integer. The packing-slip parser keeps "11A" whole, because there the
  // suffix tells two real breaks apart.
  ['1x HOBBY BOX - Break #11A - Chicago Cubs', 11, 'a suffixed label yields its number'],
  // Last resort: the word and a number with nothing vouching for them.
  ['1x 2026 HOBBY BOX RANDOM TEAMS BREAK 4 - Detroit Tigers', 4, 'bare "BREAK 4"'],
  // …but a year is not a break number, and this is exactly the string that
  // would make a naked pattern say so.
  ['Earnings for selling a 2026 BREAK 2026 TOPPS CHROME BASEBALL HOBBY BOX', null, 'a YEAR is refused'],
  ['Earnings for selling a 2025 Topps Inception Baseball Hobby Box', null, 'a whole product has no break'],
  ['Breaking News Collectibles Hobby Box', null, '"Breaking" is not "Break"']
]
for (const [m, want, why] of BREAKS) {
  ok(parseBreakNumber(m) === want, `break #: ${why}`, String(parseBreakNumber(m)))
}
// The two reads must not disagree again: anything the classifier calls a break
// carries a number, for every string above that IS one.
for (const [m, why] of SPOTS) {
  if (!/break/i.test(m)) continue
  ok(parseBreakNumber(m) !== null, `classified a break AND numbered: ${why}`)
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. the name comes out clean ===')
// ---------------------------------------------------------------------------
ok(
  parseProductSaleName('Earnings for selling a 2025 Topps Inception Baseball Hobby Box') ===
    '2025 Topps Inception Baseball Hobby Box',
  'the "a" and the prefix are stripped'
)
ok(
  parseProductSaleName('Earnings for selling a 2026 Topps Chrome VeeFriends Hobby Box ') ===
    '2026 Topps Chrome VeeFriends Hobby Box',
  'and the trailing space Whatnot leaves'
)
ok(parseProductSaleName('Reversal of sales transaction for order refund') === '', 'a non-sale yields nothing')

// ---------------------------------------------------------------------------
console.log('\n=== 4. other buckets are untouched ===')
// ---------------------------------------------------------------------------
ok(classifyLedgerRow('PAYOUT', 'Payout request: STRIPE acct_x') === 'payout', 'payout')
ok(classifyLedgerRow('TIP', 'anything') === 'tip', 'tip')
ok(
  classifyLedgerRow('SALES', 'Charged deduction of $4.15 for giveaway order 123') === 'giveaway_shipping',
  'giveaway postage is still not a sale'
)
ok(classifyLedgerRow('ADJUSTMENT', 'Shipping Subsidy') === 'shipping_subsidy', 'subsidy')

// ---------------------------------------------------------------------------
console.log('\n=== 5. a product sale books to its own day ===')
// ---------------------------------------------------------------------------
ok(booksToOwnDay('product_sale') === true, 'a whole product has a day of its own')
ok(booksToOwnDay('sale') === false, 'a break spot does NOT — an orphan spot is a missing show')
ok(booksToOwnDay('shipping_subsidy') === false, 'nor does a settlement row')

// ---------------------------------------------------------------------------
console.log('\n=== 6. finding the product in the SHIPPED catalog ===')
// ---------------------------------------------------------------------------
// Against the catalog the app actually ships with, not a fixture. That is the
// only test that answers the real question: when one of these sales lands, does
// the app find the box?
const REAL: Array<[string, boolean]> = [
  ['2025-26 Topps Chrome Cactus Jack Basketball Hobby Box', true],
  ['2025-26 Panini Signature Series Basketball Hobby 12-Box Case', true],
  ['2025 Topps Inception Baseball Hobby Box', true],
  ['2026 Topps Chrome VeeFriends Hobby Box', true],
  ['2020-21 Panini Prizm Basketball Hobby Box', true],
  ['2025 Topps Stadium Club UFC Hobby Box', true],
  // Was the standing example of a sale the catalog could not name. The owner's
  // 306-row list carries it, so the honest assertion now is that it resolves.
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby Box', true],
  // Not in the catalog, and not a real product. Must come back EMPTY rather
  // than come back wrong — the whole point of a floor on the match.
  ['2031 Topps Chrome Curling Championship Hobby Box', false]
]
for (const [name, shouldMatch] of REAL) {
  const m = inventory.matchProductByName(name)
  if (shouldMatch) {
    ok(m !== null && m.product.name === name, `finds: ${name.slice(0, 48)}`, String(m?.product?.name))
    ok(m?.ambiguous === false, '  unambiguously', JSON.stringify(m?.ambiguous))
    ok(m?.score === 1, '  at a full-title score', String(m?.score))
  } else {
    ok(m === null, `no match rather than a wrong one: ${name.slice(0, 40)}`, String(m?.product?.name))
  }
}

// The year has to be decisive: two Prizm Basketball boxes differing in nothing
// else, and booking a sale against the wrong year's cost is worse than none.
let sku = 0
const mk = (name: string, category = 'Basketball'): string =>
  inventory.createProduct(
    {
      name,
      category,
      sku: `MKT${++sku}`,
      upc: null,
      brand: '',
      setName: '',
      year: '',
      unitType: 'box',
      boxesPerCase: null,
      packsPerBox: null,
      giveawayItem: false,
      unitCost: 100,
      highBid: null,
      salePrice: 0,
      reorderPoint: 0,
      notes: null
    },
    null
  ).id
mk('2031-32 Fictional Prizm Basketball Hobby Box')
mk('2032-33 Fictional Prizm Basketball Hobby Box')
const y = inventory.matchProductByName('2032-33 Fictional Prizm Basketball Hobby Box')
ok(
  y?.product?.name === '2032-33 Fictional Prizm Basketball Hobby Box',
  'the right YEAR of an otherwise identical box',
  String(y?.product?.name)
)
ok(y?.ambiguous === false, 'and the other year is not a tie')

// Cross-sport words must not bleed.
ok(
  inventory.matchProductByName('2031-32 Fictional Prizm FOOTBALL Hobby Box') === null,
  'football does not match a basketball box'
)
// Two products the app genuinely cannot tell apart are REFUSED, not guessed.
mk('2033-34 Twin Prizm Basketball Hobby Box')
mk('2033-34 Twin Prizm Basketball Hobby Box')
const twin = inventory.matchProductByName('2033-34 Twin Prizm Basketball Hobby Box')
ok(twin?.ambiguous === true, 'a true duplicate is reported ambiguous', JSON.stringify(twin?.ambiguous))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
