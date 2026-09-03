/**
 * Ranking the inventory table by any of its columns.
 *
 * The Dashboard drill-down is the widest table in the app — product, structure,
 * one column per location, then six money columns — and until now the order was
 * fixed by whichever tile you came in through. This is the contract that lets an
 * operator re-rank it, kept out of the component so the rules below are things a
 * test can hold rather than things a screenshot can.
 *
 * ## A dash is not a zero
 *
 * Half these columns print an em dash rather than a figure: a box with no cost
 * basis has no average cost, a product nobody has bid on has no high bid, and
 * the Spread deliberately declines to speak for an uncosted box. Sorting those
 * as 0 would file them among the cheapest — an answer the table never gave.
 * They sort to the BOTTOM in both directions instead, which is the honest
 * reading: you asked to rank by cost, and these cannot be ranked by cost.
 */

export type SortDir = 'asc' | 'desc'

export interface SortState {
  key: string
  dir: SortDir
}

/** What a column yields for one row. `null` means the cell prints a dash. */
export type SortValue = number | string | null

/**
 * The figures a row can be ranked by.
 *
 * Built by the table from the same values it prints — a cell that shows a dash
 * puts `null` here — so a column can never sort by something the operator
 * cannot see.
 */
export interface InventorySortRow {
  name: string
  /** The structure column: 'case', 'box', … */
  unit: string
  quantity: number
  byLocation: Record<string, number>
  highBid: number | null
  invValue: number | null
  avgCost: number | null
  totalCost: number | null
  spread: number | null
  /**
   * The spread as a percentage of what was paid, or null wherever `spread` is.
   *
   * ITS OWN KEY, not a derivation at sort time, and that is the point of the
   * whole column: ranking by dollar spread ranks by how much of a product is
   * held as much as by how well it was bought, so the two orders are genuinely
   * different questions and each needs its own arrow. See @shared/spread.
   */
  spreadPct: number | null
  /**
   * When somebody last entered a high bid, as an ISO instant, or null if
   * nobody ever has.
   *
   * OPTIONAL, because only the Pricing tab has a column for it — the on-hand
   * Overview does not draw the date and must not be forced to invent one. A
   * table that omits it simply has no such column to click, and the key sorts
   * every row as missing if one ever did.
   *
   * An ISO string sorts correctly as a string: fixed width, most significant
   * field first. Parsing it to a number here would buy nothing and would give
   * an unparseable value a silent NaN rather than an honest null.
   */
  lastPriced?: string | null
}

/**
 * Location columns are named at run time, because the set of places stock can
 * sit is data now. A prefix keeps them from ever colliding with a fixed key.
 */
export const LOCATION_SORT_PREFIX = 'loc:'

export function locationSortKey(locationId: string): string {
  return LOCATION_SORT_PREFIX + locationId
}

/** The fixed columns, in the order the table draws them. */
export const INVENTORY_SORT_KEYS = [
  'product',
  'structure',
  'total',
  'highBid',
  'invValue',
  'avgCost',
  'totalCost',
  'spread',
  'spreadPct',
  'lastPriced'
] as const

export type InventorySortKey = (typeof INVENTORY_SORT_KEYS)[number]

/** What one column reads off a row. */
export function inventorySortValue(row: InventorySortRow, key: string): SortValue {
  if (key.startsWith(LOCATION_SORT_PREFIX)) {
    // A location holding none of this product is a real zero, not a missing
    // figure — the cell prints 0, and 0 is where it belongs in the ranking.
    return row.byLocation[key.slice(LOCATION_SORT_PREFIX.length)] ?? 0
  }
  switch (key as InventorySortKey) {
    case 'product':
      return row.name
    case 'structure':
      return row.unit
    case 'total':
      return row.quantity
    case 'highBid':
      return row.highBid
    case 'invValue':
      return row.invValue
    case 'avgCost':
      return row.avgCost
    case 'totalCost':
      return row.totalCost
    case 'spread':
      return row.spread
    case 'spreadPct':
      return row.spreadPct
    case 'lastPriced':
      // `?? null` and not `?? ''`: a product nobody has priced is MISSING, and
      // compareSortValues sinks missing to the bottom in both directions. An
      // empty string would sort as a real value below every date ascending and
      // above none of them descending, so the never-priced rows — the ones the
      // Pricing tab exists to surface — would sit in a different place
      // depending on which way the arrow pointed.
      return row.lastPriced ?? null
    default:
      return null
  }
}

/**
 * Which way a column goes on its FIRST click.
 *
 * Money and counts open descending, because somebody clicking "Total cost"
 * wants the expensive ones, not a screen of dashes and zeroes. Text opens
 * ascending, because A–Z is what a name column means. Getting this backwards
 * makes every column feel like it needs two clicks.
 */
export function firstSortDir(key: string): SortDir {
  if (key === 'product' || key === 'structure') return 'asc'
  // lastPriced opens descending with the rest: "when did I last touch this"
  // means the most recent first, and the never-priced rows sink either way.
  return 'desc'
}

/**
 * The state after clicking a header.
 *
 * A different column adopts that column's natural direction; the same column
 * flips. Two states, not three: the operator asked for ascending and
 * descending, and a hidden third click that reverts to some previous order is a
 * rule nobody can see in an arrow.
 */
export function nextSortState(current: SortState | null, key: string): SortState {
  if (current && current.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  }
  return { key, dir: firstSortDir(key) }
}

/**
 * Compare two cells.
 *
 * MISSING SINKS. `null` is below everything ascending and below everything
 * descending, which is the one rule here that is not a plain reversal — see the
 * note at the top of this file.
 */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const aMissing = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a))
  const bMissing = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b))
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1

  let cmp: number
  if (typeof a === 'string' || typeof b === 'string') {
    cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
  } else {
    cmp = a === b ? 0 : a < b ? -1 : 1
  }
  return dir === 'asc' ? cmp : -cmp
}

/**
 * Re-rank the table.
 *
 * Generic over the row the caller actually holds — the component carries a
 * product and its metrics together and wants those back, not a projection — so
 * `project` says how to read the sortable figures out of one.
 *
 * The tiebreak is ALWAYS the product name ascending, whatever the direction.
 * Without it two boxes with the same total cost can swap places between renders
 * for no reason the operator did, and a table that reorders itself while being
 * read is one nobody trusts.
 */
export function sortInventoryRows<T>(
  rows: readonly T[],
  state: SortState | null,
  project: (row: T) => InventorySortRow
): T[] {
  const out = [...rows]
  if (!state) return out
  return out.sort((ra, rb) => {
    const a = project(ra)
    const b = project(rb)
    const cmp = compareSortValues(
      inventorySortValue(a, state.key),
      inventorySortValue(b, state.key),
      state.dir
    )
    if (cmp !== 0) return cmp
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/** The drill-downs the Dashboard tiles open. */
export type InventoryDetailKind = 'value' | 'cost' | 'spread' | 'cases' | 'skus' | 'category'

/**
 * How a drill-down arrives.
 *
 * Each tile already ordered its table by the figure the tile counts, and that
 * order is why the operator is looking at it. So the arrow starts LIT on that
 * column rather than the table arriving unsorted-looking: the header says why
 * the list is in this order, and clicking anything else takes it from there.
 */
export function defaultInventorySort(kind: InventoryDetailKind | string): SortState {
  switch (kind) {
    case 'value':
      return { key: 'invValue', dir: 'desc' }
    case 'cost':
      return { key: 'totalCost', dir: 'desc' }
    case 'spread':
      return { key: 'spread', dir: 'desc' }
    case 'skus':
      return { key: 'product', dir: 'asc' }
    case 'cases':
    case 'category':
    default:
      return { key: 'total', dir: 'desc' }
  }
}
