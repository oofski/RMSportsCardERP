/**
 * PRICE BANDS — "show me the cheap ones", as one rule three screens share.
 *
 * The owner asked for "pricing range by category, just basic filtering
 * buttons" on the inventory screens. The thing that makes this worth a shared
 * module rather than three arrays of numbers is not the arithmetic; it is that
 * a band has to mean the same thing on every screen it appears on. The Pricing
 * tab, the Catalog and the on-hand Overview all draw the same chips, and if
 * "$500 – $1,999" quietly meant `> 500` on one of them and `>= 500` on
 * another, the counts would disagree and nobody could say which was right.
 *
 * ## Measured on the HIGH BID, everywhere
 *
 * The owner's answer when asked: market value, not what we paid. That is the
 * figure the Pricing tab exists to maintain, so a band is a question about what
 * stock is WORTH — which is the question somebody filtering a price list is
 * actually asking. Cost is a different question and would need its own bands;
 * mixing the two behind one set of chips is how a filter starts lying.
 *
 * ## UNPRICED IS A BAND, and it is the important one
 *
 * A product with no high bid is not worth $0 — nobody has said what it is
 * worth. On a screen whose whole job is entering those numbers, "what have I
 * not priced yet" is the most useful filter on offer, and folding those rows
 * into "under $100" would hide exactly the work the screen is for. So it is its
 * own chip, and every numeric band excludes it.
 *
 * ## Open-ended at the top, closed everywhere else
 *
 * `max` is exclusive and `min` inclusive, so the bands tile the number line
 * with no gap and no overlap: a box at exactly $500 is in one band, not two and
 * not neither. The last band has no `max` because there is no ceiling on what a
 * case can be worth, and inventing one would silently drop the most valuable
 * stock off a filter.
 */

export interface PriceBand {
  /** Stable id — stored in component state and never shown. */
  id: string
  /** What the chip says. */
  label: string
  /** Inclusive floor, in dollars. Absent on the unpriced band. */
  min?: number
  /** EXCLUSIVE ceiling. Absent means open-ended. */
  max?: number
  /** True for the one band that means "nobody has said". */
  unpriced?: boolean
}

/**
 * The bands, in the order the chips draw them.
 *
 * Five is a deliberate ceiling. These are meant to be read and clicked without
 * thinking — a row of nine chips is a menu, and a menu is slower than the
 * search box already sitting beside it.
 */
export const PRICE_BANDS: readonly PriceBand[] = [
  { id: 'unpriced', label: 'Unpriced', unpriced: true },
  { id: 'under100', label: 'Under $100', min: 0, max: 100 },
  { id: '100to500', label: '$100 – $499', min: 100, max: 500 },
  { id: '500to2000', label: '$500 – $1,999', min: 500, max: 2000 },
  { id: 'over2000', label: '$2,000+', min: 2000 }
]

export function priceBandById(id: string | null): PriceBand | null {
  if (!id) return null
  return PRICE_BANDS.find((b) => b.id === id) ?? null
}

/**
 * Does this product's market value fall in the band?
 *
 * A null band means "no filter" and everything passes — the chips are a toggle,
 * and the un-clicked state has to be the whole list rather than an empty one.
 *
 * NOT-A-NUMBER COUNTS AS UNPRICED. A stored value that is null, undefined or
 * NaN all mean the same thing to somebody looking at the screen — the cell
 * shows a dash — so they have to mean the same thing to the filter. Treating
 * NaN as 0 would file a product nobody has priced under "Under $100" and put
 * it in front of somebody who asked for cheap stock.
 */
export function matchesPriceBand(highBid: number | null | undefined, bandId: string | null): boolean {
  const band = priceBandById(bandId)
  if (!band) return true
  const priced = highBid !== null && highBid !== undefined && Number.isFinite(highBid)
  if (band.unpriced) return !priced
  if (!priced) return false
  const value = Number(highBid)
  if (band.min !== undefined && value < band.min) return false
  // Exclusive, so the bands tile without overlapping. See the note above.
  if (band.max !== undefined && value >= band.max) return false
  return true
}

/**
 * How many rows each band would show, for the counts on the chips.
 *
 * Counted over the list the OTHER filters have already narrowed, so the numbers
 * describe what a click would actually do from where the operator is standing.
 * A chip promising 40 results that lands on 3 because a category was still
 * selected is worse than no count at all.
 */
export function countByPriceBand<T>(
  rows: readonly T[],
  highBidOf: (row: T) => number | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const band of PRICE_BANDS) out[band.id] = 0
  for (const row of rows) {
    const bid = highBidOf(row)
    for (const band of PRICE_BANDS) {
      if (matchesPriceBand(bid, band.id)) out[band.id] += 1
    }
  }
  return out
}
