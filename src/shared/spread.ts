/**
 * SPREAD AS A PERCENTAGE — what the stock is up against what it cost.
 *
 * Asked for over text, and the second message is the whole reason it exists:
 *
 *   "having % gain/loss next to spread would be extremely nice. as a total
 *    number on that screen as well as next to each line"
 *   "Bc gain/loss could be huge on something but to contextualize it sometimes
 *    its a ton of that product"
 *
 * That is the complaint, exactly: a spread of $5,000 says nothing on its own.
 * On two cases that cost $10,000 it is a stellar +50%; on a hundred that cost
 * $200,000 it is +2.5% and the position is barely moving. The dollars measure
 * how much of that product is held; the percentage measures how the product is
 * DOING. A column of dollar spreads sorts by size of holding as much as by
 * quality of buy, which is why the biggest number on the screen is so often the
 * least interesting one.
 *
 * ## WHAT PERIOD IS THIS? — the question the owner asked, answered here
 *
 * "would this be day to day or like how would this work i am a little confused
 * about that".
 *
 * It is NOT a day-to-day move, and it could not be: nothing in this app stores
 * yesterday's high bid, so there is no previous figure to difference against.
 * It is SINCE PURCHASE, measured right now — the same window `spread` itself
 * has always covered. Market value on hand today, against what was actually
 * paid for that stock, out of the FIFO cost layers.
 *
 * So it changes when one of two things changes: somebody records a new high bid
 * (the market moved), or the cost basis moves (stock came in, or went out, at a
 * different price). It does not tick on its own overnight, and it is not a
 * return "per year" or "per anything" — it is one number: what this stock has
 * gained or lost against its own cost, as of now.
 *
 * ## Why it is here and not two ternaries in a table cell
 *
 * Because it is a DIVISION, and every division in a money screen has the same
 * two ways to be wrong: the denominator is zero, and the denominator is the
 * wrong quantity. Both are answered once, in one place, with the answer tested —
 * and the tile at the top of the screen and the row halfway down it then cannot
 * disagree about what the percentage of the same money is.
 */

/**
 * The percentage a spread represents against the cost that produced it, or NULL
 * when there is no honest answer.
 *
 * ## NULL, NEVER ZERO, ON A MISSING BASIS
 *
 * Cost of nothing is not "up 0%" and it is not "up infinitely" — it is a
 * question nobody has answered, and the screen already has a mark for that: the
 * dash it prints for every other unmeasured figure. This is the same rule the
 * dollar spread keeps for an uncosted box (`outsideSpread` in helpers.tsx), and
 * for the same stated reason: zero is a spread somebody MEASURED.
 *
 * A negative basis returns null too. It should not occur, but if a repair ever
 * drove a cost layer below zero, the sign of the answer would flip and a losing
 * position would print as a gain — the one failure mode of a percentage that a
 * person cannot spot by eye.
 *
 * ## THE DENOMINATOR IS THE COST, NOT THE MARKET VALUE
 *
 * Return on what was paid, which is the number a buyer is judged by. Dividing by
 * market value instead would answer "what fraction of today's price is profit",
 * a different and much flatter number — it can never exceed 100% however good
 * the buy was, so it cannot say the thing the owner is asking it to say.
 */
export function spreadPercent(spread: number, costBasis: number): number | null {
  if (!Number.isFinite(spread) || !Number.isFinite(costBasis)) return null
  if (!(costBasis > 0)) return null
  return (spread / costBasis) * 100
}

/**
 * How that percentage is written, everywhere it appears.
 *
 * ONE DECIMAL PLACE, and a sign on every value including a gain. A column of
 * "+12.4%" and "−3.1%" is scanned by its first character; the same column with
 * the plus left off makes the reader look at each number twice to find out which
 * way it went. The minus is U+2212, the same one the rest of the money screens
 * use — a hyphen at this size is a hairline that disappears.
 *
 * Zero is written "0.0%" with no sign, because it went neither way.
 */
export function formatSpreadPercent(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null
  const rounded = Math.round(pct * 10) / 10
  if (rounded === 0) return '0.0%'
  const sign = rounded > 0 ? '+' : '−'
  return `${sign}${Math.abs(rounded).toFixed(1)}%`
}

/**
 * The percentage for one line, or for a whole screen, in one call.
 *
 * Takes the two figures the caller already has rather than a product, so the
 * tile at the top (which sums the main process's stats) and the row in the table
 * (which reads one product's metrics) go through the identical arithmetic. The
 * moment those two are computed separately is the moment they disagree by a
 * rounding step and somebody has to work out which one to believe.
 */
export function spreadPercentText(spread: number, costBasis: number): string | null {
  return formatSpreadPercent(spreadPercent(spread, costBasis))
}

/** Which way it went, for the colour. Null where there is no percentage. */
export function spreadTone(pct: number | null): 'pos' | 'neg' | null {
  if (pct === null || !Number.isFinite(pct)) return null
  const rounded = Math.round(pct * 10) / 10
  if (rounded > 0) return 'pos'
  if (rounded < 0) return 'neg'
  return null
}
