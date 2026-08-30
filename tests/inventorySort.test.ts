/**
 * Ranking the inventory table by any of its columns.
 *
 * The owner's words: "ability to sort ascending/descending on all of these
 * headers ... just like arrows next to each column".
 *
 * A sort looks like the most trivial thing in an app until it quietly lies, and
 * this particular table has three ways to do that. What is pinned here:
 *
 *   1. A DASH IS NOT A ZERO. Half these columns print an em dash rather than a
 *      figure — a box with no cost basis has no average cost, and the Spread
 *      deliberately declines to speak for one. Ranked as 0 they would file
 *      among the cheapest, which is an answer the table never gave. They sink
 *      to the bottom in BOTH directions instead.
 *
 *   2. SORTING IS NOT FILTERING. Each drill-down lists what its tile counts:
 *      the Spread view excludes uncosted boxes and the total above it says so.
 *      Re-ranking by Total cost must not drag one back in, or the table stops
 *      agreeing with its own total.
 *
 *   3. THE ORDER IS STABLE. Two boxes with the same total cost must not swap
 *      places between renders. A table that reorders itself while it is being
 *      read is one nobody trusts.
 *
 * And one that is only about how it feels: money columns open DESCENDING.
 * Somebody clicking "Total cost" wants the expensive ones, not a screen of
 * dashes. Getting that backwards makes every column need two clicks.
 *
 * Every product name here is invented.
 *
 * Run: npm run test:inventory-sort
 */
/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
const {
  compareSortValues,
  defaultInventorySort,
  firstSortDir,
  inventorySortValue,
  locationSortKey,
  nextSortState,
  sortInventoryRows,
  INVENTORY_SORT_KEYS,
  LOCATION_SORT_PREFIX
} = require('../src/shared/inventorySort')

let pass = 0
let fail = 0
const ok = (c: boolean, n: string, e = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + n)
  } else {
    fail++
    console.log('  FAIL ' + n + (e ? ' — ' + e : ''))
  }
}

type Row = {
  name: string
  unit: string
  quantity: number
  byLocation: Record<string, number>
  highBid: number | null
  invValue: number | null
  avgCost: number | null
  totalCost: number | null
  spread: number | null
}

const row = (name: string, over: Partial<Row> = {}): Row => ({
  name,
  unit: 'box',
  quantity: 1,
  byLocation: {},
  highBid: 10,
  invValue: 10,
  avgCost: 5,
  totalCost: 5,
  spread: 5,
  ...over
})

const id = (r: Row): Row => r
const names = (rows: Row[]): string[] => rows.map((r) => r.name)
const order = (rows: Row[], key: string, dir: string): string[] =>
  names(sortInventoryRows(rows, { key, dir }, id))

// ---------------------------------------------------------------------------
console.log('\n=== 1. a dash sinks, whichever way the arrow points ===')
// ---------------------------------------------------------------------------

const withGaps: Row[] = [
  row('Bravo', { totalCost: 500 }),
  row('Charlie', { totalCost: null }),
  row('Alpha', { totalCost: 20 }),
  row('Delta', { totalCost: null })
]

const desc = order(withGaps, 'totalCost', 'desc')
ok(desc[0] === 'Bravo', 'descending puts the biggest figure first', desc.join(' | '))
ok(desc[1] === 'Alpha', 'then the smaller one')
ok(
  desc[2] === 'Charlie' && desc[3] === 'Delta',
  'AND THE ONES WITH NO FIGURE LAST',
  desc.join(' | ')
)

const asc = order(withGaps, 'totalCost', 'asc')
ok(asc[0] === 'Alpha', 'ascending puts the smallest figure first', asc.join(' | '))
ok(asc[1] === 'Bravo', 'then the bigger one')
ok(
  asc[2] === 'Charlie' && asc[3] === 'Delta',
  'AND THE ONES WITH NO FIGURE STILL LAST — a dash is not a zero, so it never leads',
  asc.join(' | ')
)

// The zero case is the one that proves it is not just "small sorts low": a real
// zero and a missing figure must land on opposite ends going up.
const zeroVsNothing: Row[] = [
  row('Costed at nothing', { totalCost: 0 }),
  row('Never costed', { totalCost: null }),
  row('Costed at ten', { totalCost: 10 })
]
const zAsc = order(zeroVsNothing, 'totalCost', 'asc')
ok(
  zAsc[0] === 'Costed at nothing' && zAsc[2] === 'Never costed',
  'A REAL ZERO LEADS ASCENDING WHILE A MISSING FIGURE TRAILS — they are not the same thing',
  zAsc.join(' | ')
)

ok(compareSortValues(null, 5, 'asc') > 0, 'null is below a number ascending')
ok(compareSortValues(null, 5, 'desc') > 0, 'and below it descending too')
ok(compareSortValues(null, null, 'asc') === 0, 'two nulls tie')
// NaN reaches here the moment a division by a zero quantity slips through, and
// it must be treated as a missing figure rather than sorted arbitrarily.
ok(compareSortValues(Number.NaN, 1, 'desc') > 0, 'a NaN is treated as missing, not as a figure')

// ---------------------------------------------------------------------------
console.log('\n=== 2. a location column ranks by units, and zero is a real zero ===')
// ---------------------------------------------------------------------------

const shelves: Row[] = [
  row('Held at RM', { byLocation: { RM: 9, AM: 0 } }),
  row('Held at AM', { byLocation: { RM: 0, AM: 4 } }),
  row('Held nowhere', { byLocation: {} })
]
const byRm = order(shelves, locationSortKey('RM'), 'desc')
ok(byRm[0] === 'Held at RM', 'the shelf holding the most leads', byRm.join(' | '))
ok(
  inventorySortValue(row('x', { byLocation: {} }), locationSortKey('RM')) === 0,
  'A LOCATION HOLDING NONE READS AS 0, NOT AS MISSING — the cell prints 0, and 0 can be ranked'
)
ok(
  locationSortKey('Roadshow Tulsa') === LOCATION_SORT_PREFIX + 'Roadshow Tulsa',
  'a location key is prefixed, so it can never collide with a fixed column'
)
ok(
  !INVENTORY_SORT_KEYS.some((k: string) => k.startsWith(LOCATION_SORT_PREFIX)),
  'and no fixed column uses that prefix'
)

// ---------------------------------------------------------------------------
console.log('\n=== 3. every column ranks by its own figure ===')
// ---------------------------------------------------------------------------

// One row that is the biggest on exactly one column and the smallest on the
// rest: if a header were wired to the wrong figure, it would surface under the
// wrong heading and nowhere else.
const probe = (key: string, over: Partial<Row>): boolean => {
  const rows = [row('Ordinary', {}), row('Standout', over)]
  return order(rows, key, 'desc')[0] === 'Standout'
}
ok(probe('total', { quantity: 99 }), 'Total ranks by units on hand')
ok(probe('highBid', { highBid: 99 }), 'High bid ranks by the bid')
ok(probe('invValue', { invValue: 99 }), 'Inv. value ranks by market value')
ok(probe('avgCost', { avgCost: 99 }), 'Avg cost ranks by the average')
ok(probe('totalCost', { totalCost: 99 }), 'Total cost ranks by the basis')
ok(probe('spread', { spread: 99 }), 'Spread ranks by the spread')

const alpha = [row('Zulu'), row('Alpha'), row('Mike')]
ok(order(alpha, 'product', 'asc')[0] === 'Alpha', 'Product sorts A to Z')
ok(order(alpha, 'product', 'desc')[0] === 'Zulu', 'and Z to A')

const structures = [row('a', { unit: 'single' }), row('b', { unit: 'box' }), row('c', { unit: 'case' })]
ok(
  order(structures, 'structure', 'asc').join('') === 'bca',
  'Structure groups by unit type',
  order(structures, 'structure', 'asc').join('')
)

// A name column with numbers in it: "Series 2" must not sort after "Series 10",
// which is what a plain string compare does.
const numeric = [row('Series 10'), row('Series 2'), row('Series 1')]
ok(
  order(numeric, 'product', 'asc').join(' | ') === 'Series 1 | Series 2 | Series 10',
  'and counts numbers in a name as numbers',
  order(numeric, 'product', 'asc').join(' | ')
)

// ---------------------------------------------------------------------------
console.log('\n=== 4. equal figures never shuffle ===')
// ---------------------------------------------------------------------------

const tied: Row[] = [
  row('Yankee', { totalCost: 100 }),
  row('Alpha', { totalCost: 100 }),
  row('Mike', { totalCost: 100 })
]
const tiedDesc = order(tied, 'totalCost', 'desc')
const tiedAsc = order(tied, 'totalCost', 'asc')
ok(
  tiedDesc.join(' | ') === 'Alpha | Mike | Yankee',
  'a tie breaks on the product name',
  tiedDesc.join(' | ')
)
ok(
  tiedAsc.join(' | ') === 'Alpha | Mike | Yankee',
  'THE SAME WAY IN BOTH DIRECTIONS — reversing the tiebreak too would reshuffle rows nobody re-ranked',
  tiedAsc.join(' | ')
)
// Rows that all print a dash are all tied, and must still come out in a fixed
// order rather than whatever the input happened to be.
const allMissing = [row('Yankee', { spread: null }), row('Alpha', { spread: null })]
ok(
  order(allMissing, 'spread', 'desc').join(' | ') === 'Alpha | Yankee',
  'and rows that ALL show a dash still land in a settled order'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. sorting reorders the table, it never changes what is in it ===')
// ---------------------------------------------------------------------------

const source: Row[] = [row('One'), row('Two'), row('Three')]
const sorted = sortInventoryRows(source, { key: 'product', dir: 'asc' }, id)
ok(sorted.length === source.length, 'every row survives the sort')
ok(names(source).join() === 'One,Two,Three', 'AND THE ARRAY HANDED IN IS NOT MUTATED')
ok(sorted !== source, 'a new array comes back')

// A missing figure is a reason to sink, never a reason to disappear: the count
// above the table is derived from the same list.
const gappy = [row('Has one', { spread: 4 }), row('Has none', { spread: null })]
ok(
  sortInventoryRows(gappy, { key: 'spread', dir: 'desc' }, id).length === 2,
  'a row with no figure is ranked last, NOT dropped'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. which way a column opens, and what a second click does ===')
// ---------------------------------------------------------------------------

ok(firstSortDir('totalCost') === 'desc', 'money opens with the biggest first')
ok(firstSortDir('total') === 'desc', 'so do counts')
ok(firstSortDir(locationSortKey('RM')) === 'desc', 'and a location column')
ok(firstSortDir('product') === 'asc', 'a name opens A to Z')
ok(firstSortDir('structure') === 'asc', 'and so does the structure')

const first = nextSortState(null, 'totalCost')
ok(
  first.key === 'totalCost' && first.dir === 'desc',
  'clicking a fresh column adopts that column’s own direction'
)
const second = nextSortState(first, 'totalCost')
ok(second.dir === 'asc', 'clicking it again reverses')
const third = nextSortState(second, 'totalCost')
ok(third.dir === 'desc', 'and again reverses back — two states, not a hidden third')
const moved = nextSortState(second, 'product')
ok(
  moved.key === 'product' && moved.dir === 'asc',
  'MOVING TO ANOTHER COLUMN TAKES ITS OWN DIRECTION, not the one left behind',
  moved.dir
)

// ---------------------------------------------------------------------------
console.log('\n=== 7. a drill-down arrives sorted by the figure its tile counts ===')
// ---------------------------------------------------------------------------

ok(defaultInventorySort('value').key === 'invValue', 'the Inventory value tile opens on Inv. value')
ok(defaultInventorySort('cost').key === 'totalCost', 'the Cost tile opens on Total cost')
ok(defaultInventorySort('spread').key === 'spread', 'the Spread tile opens on Spread')
ok(defaultInventorySort('cases').key === 'total', 'the Cases tile opens on the count')
ok(defaultInventorySort('category').key === 'total', 'and so does a category')
ok(defaultInventorySort('skus').key === 'product', 'the SKU count opens alphabetically')
ok(defaultInventorySort('skus').dir === 'asc', 'ascending, because that is what A to Z means')
ok(
  ['value', 'cost', 'spread', 'cases', 'category'].every(
    (k) => defaultInventorySort(k).dir === 'desc'
  ),
  'EVERY FIGURE TILE OPENS BIGGEST FIRST — the tile is a total, and the list under it explains it'
)
// The identifiers view never reaches this table, but a kind nobody anticipated
// must still produce a usable order rather than an unsorted one.
ok(
  defaultInventorySort('something-new').key === 'total',
  'an unrecognised drill-down still opens on a real column'
)

// ---------------------------------------------------------------------------
console.log('\n=== 8. the whole table, end to end ===')
// ---------------------------------------------------------------------------

// What the Spread drill-down actually holds: costed stock only. The uncosted
// box is absent because the FILTER left it out — sorting is asked to rank what
// it is given and nothing else.
const spreadView: Row[] = [
  row('2026 Prizm Football Hobby', { spread: 1200, totalCost: 4000, quantity: 8 }),
  row('2026 Topps Chrome Baseball', { spread: -300, totalCost: 900, quantity: 3 }),
  row('2026 Select Basketball', { spread: 1200, totalCost: 2500, quantity: 5 })
]
const bySpread = order(spreadView, 'spread', 'desc')
ok(
  bySpread.join(' | ') ===
    '2026 Prizm Football Hobby | 2026 Select Basketball | 2026 Topps Chrome Baseball',
  'the widest spread leads, the loss trails, and the tie breaks on the name',
  bySpread.join(' | ')
)
ok(
  order(spreadView, 'spread', 'asc')[0] === '2026 Topps Chrome Baseball',
  'and reversing puts the loss on top — which is the reason to reverse it'
)
ok(
  order(spreadView, 'totalCost', 'desc').length === 3,
  'RE-RANKING BY ANOTHER COLUMN DOES NOT PULL IN A ROW THE VIEW EXCLUDED'
)


// ---------------------------------------------------------------------------
console.log('\n=== N. price bands: the basic filter buttons ===')
// ---------------------------------------------------------------------------
/**
 * The owner: "pricing range by category as well in inventory, just basic
 * filtering buttons." Measured on the HIGH BID — market value, their answer
 * when asked — and drawn identically on the Pricing tab, the Catalog and the
 * on-hand Overview.
 *
 * Three screens sharing one predicate is the whole reason this is a module and
 * not three arrays of numbers, so what is pinned here is the arithmetic that
 * would let them disagree:
 *
 *   1. THE BANDS TILE THE LINE. `min` inclusive, `max` exclusive, so a box at
 *      exactly $500 lands in one band — not two, and not none. A boundary
 *      counted twice inflates a chip; counted zero times hides stock.
 *   2. UNPRICED IS NOT ZERO. A product nobody has priced is not worth nothing,
 *      and on a screen built for entering those numbers it is the most useful
 *      filter there is. Folding it into "under $100" would bury the work.
 *   3. NO BAND MEANS EVERYTHING. The chips toggle, and the un-clicked state has
 *      to be the whole list rather than an empty one.
 */
const {
  PRICE_BANDS,
  matchesPriceBand,
  countByPriceBand,
  priceBandById
} = require('../src/shared/priceBands')

ok(matchesPriceBand(50, null) === true, 'no band selected lets everything through')
ok(matchesPriceBand(null, null) === true, 'including the unpriced')

// -- the boundaries, where a tiling error would show ------------------------
ok(matchesPriceBand(99.99, 'under100') === true, '$99.99 is under $100')
ok(matchesPriceBand(100, 'under100') === false, 'AND $100 IS NOT — max is exclusive')
ok(matchesPriceBand(100, '100to500') === true, 'it belongs to the next band up, inclusively')
ok(matchesPriceBand(499.99, '100to500') === true, 'which runs to just under 500')
ok(matchesPriceBand(500, '100to500') === false, 'and stops there')
ok(matchesPriceBand(500, '500to2000') === true, 'where the next one starts')
ok(matchesPriceBand(1999.99, '500to2000') === true, 'running to just under 2000')
ok(matchesPriceBand(2000, '500to2000') === false, 'and stopping')
ok(matchesPriceBand(2000, 'over2000') === true, 'the top band is open-ended and starts at 2000')
ok(
  matchesPriceBand(999999, 'over2000') === true,
  'WITH NO CEILING — a made-up one would drop the most valuable stock off the filter'
)

/**
 * EVERY VALUE LANDS IN EXACTLY ONE NUMERIC BAND. Swept rather than spot-checked,
 * because a tiling bug is exactly the kind that hides between the examples
 * somebody thought to write down.
 */
const numericBands = PRICE_BANDS.filter((b: any) => !b.unpriced)
let wrongCount = 0
for (const v of [0, 0.01, 1, 99.99, 100, 250, 499.99, 500, 1200, 1999.99, 2000, 5000, 250000]) {
  const hits = numericBands.filter((b: any) => matchesPriceBand(v, b.id)).length
  if (hits !== 1) {
    wrongCount += 1
    console.log(`    value ${v} matched ${hits} bands`)
  }
}
ok(wrongCount === 0, 'every price falls in exactly ONE band — the bands tile with no gap or overlap')

// -- unpriced is its own answer, in both directions -------------------------
ok(matchesPriceBand(null, 'unpriced') === true, 'null is unpriced')
ok(matchesPriceBand(undefined, 'unpriced') === true, 'so is undefined')
ok(matchesPriceBand(NaN, 'unpriced') === true, 'AND SO IS NaN — the cell shows a dash for all three')
ok(matchesPriceBand(0, 'unpriced') === false, 'but a real zero is a price somebody entered')
ok(
  matchesPriceBand(null, 'under100') === false,
  'AN UNPRICED PRODUCT IS NOT CHEAP — filing it under $100 would put stock nobody has valued in front of somebody who asked for the cheap ones'
)
ok(matchesPriceBand(NaN, 'under100') === false, 'and NaN is not cheap either')
ok(matchesPriceBand(0, 'under100') === true, 'while a genuine $0 is')

// -- the counts on the chips ------------------------------------------------
const bandRows = [
  { bid: null },
  { bid: null },
  { bid: 40 },
  { bid: 250 },
  { bid: 250 },
  { bid: 1500 },
  { bid: 9000 }
]
const counts = countByPriceBand(bandRows, (r: any) => r.bid)
ok(counts.unpriced === 2, 'two unpriced', String(counts.unpriced))
ok(counts.under100 === 1, 'one under a hundred', String(counts.under100))
ok(counts['100to500'] === 2, 'two in the hundreds', String(counts['100to500']))
ok(counts['500to2000'] === 1, 'one in the middle band', String(counts['500to2000']))
ok(counts.over2000 === 1, 'one above two thousand', String(counts.over2000))
ok(
  Object.values(counts).reduce((a: any, b: any) => a + b, 0) === bandRows.length,
  'AND THE COUNTS SUM TO THE LIST — nothing is counted twice and nothing is lost',
  JSON.stringify(counts)
)
ok(
  Object.keys(countByPriceBand([], (r: any) => r.bid)).length === PRICE_BANDS.length,
  'an empty list still reports every band, so no chip vanishes from the row'
)

ok(priceBandById('nope') === null, 'an unknown id is no band')
ok(matchesPriceBand(50, 'nope') === true, 'and therefore filters nothing, rather than everything')

// ---------------------------------------------------------------------------
console.log('\n=== N+1. sorting by when a product was last priced ===')
// ---------------------------------------------------------------------------
/**
 * The Pricing tab's one column the on-hand table does not have. `lastPriced` is
 * optional on the row for exactly that reason — a table with no such column
 * must not be forced to invent a date.
 *
 * NEVER-PRICED SINKS IN BOTH DIRECTIONS, the same rule the money columns
 * follow. `?? null` and not `?? ''` is what makes that true: an empty string is
 * a real value that would sort below every date ascending and above none of
 * them descending, so the rows the Pricing tab exists to surface would move
 * depending on which way the arrow pointed.
 */
const priceRow = (name: string, at: string | null): any => ({
  name,
  unit: 'box',
  quantity: 1,
  byLocation: {},
  highBid: 10,
  invValue: 10,
  avgCost: 5,
  totalCost: 5,
  spread: 5,
  lastPriced: at
})
const priced = [
  priceRow('Older', '2026-05-01T10:00:00.000Z'),
  priceRow('Never', null),
  priceRow('Newest', '2026-08-30T10:00:00.000Z')
]
const byRecent = sortInventoryRows(priced, { key: 'lastPriced', dir: 'desc' }, (r: any) => r)
ok(byRecent[0].name === 'Newest', 'newest first when descending', byRecent[0].name)
ok(byRecent[2].name === 'Never', 'and the never-priced sinks', byRecent[2].name)

const byOldest = sortInventoryRows(priced, { key: 'lastPriced', dir: 'asc' }, (r: any) => r)
ok(byOldest[0].name === 'Older', 'oldest first when ascending', byOldest[0].name)
ok(
  byOldest[2].name === 'Never',
  'AND THE NEVER-PRICED STILL SINKS — missing is missing whichever way the arrow points',
  byOldest[2].name
)

ok(
  firstSortDir('lastPriced') === 'desc',
  'the column opens on the most recent, like the other figures'
)
ok(
  inventorySortValue({ ...priceRow('x', null) }, 'lastPriced') === null,
  'a row that never carried a date reads as missing, not as an empty string'
)
ok(
  inventorySortValue({ name: 'y', unit: '', quantity: 0, byLocation: {} } as any, 'lastPriced') ===
    null,
  'and a table that omits the field entirely sorts every row as missing rather than crashing'
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
