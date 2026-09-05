/**
 * SPREAD AS A PERCENTAGE — how the product is doing, beside how much is held.
 *
 * Asked for over text: "having % gain/loss next to spread would be extremely
 * nice. as a total number on that screen as well as next to each line ... Bc
 * gain/loss could be huge on something but to contextualize it sometimes its a
 * ton of that product."
 *
 * Section 1 is that sentence as arithmetic: two positions with the SAME dollar
 * spread and wildly different quality, which the dollars alone cannot tell
 * apart and the percentage separates immediately.
 *
 * ## The thing this suite mostly exists to stop
 *
 * A division in a money screen has two ways to be wrong, and both are silent.
 * The denominator can be zero — answered here with null and a dash, never 0%,
 * because "no cost recorded" is not "up nothing". And the denominator can be the
 * WRONG quantity: dividing by market value instead of cost gives a number that
 * can never exceed 100%, so it cannot say the thing the request is asking for.
 * Section 3 pins both.
 *
 * Every figure here is invented.
 *
 * Run: npm run test:spread
 */
import {
  formatSpreadPercent,
  spreadPercent,
  spreadPercentText,
  spreadTone
} from '../src/shared/spread'

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

// ---------------------------------------------------------------------------
console.log('\n=== 1. the same dollars, told apart ===')
// ---------------------------------------------------------------------------
{
  // Two cases bought at $5,000 each, now worth $7,500 each: $5,000 of spread.
  const small = spreadPercent(5_000, 10_000)
  // A hundred cases bought at $2,000 each, now worth $2,050: also $5,000.
  const big = spreadPercent(5_000, 200_000)

  ok(small === 50, 'two cases up $5,000 on a $10,000 basis is +50%', String(small))
  ok(big === 2.5, 'a hundred cases up the same $5,000 on $200,000 is +2.5%', String(big))
  ok(
    formatSpreadPercent(small) === '+50.0%' && formatSpreadPercent(big) === '+2.5%',
    'THE DOLLARS ARE IDENTICAL AND THE PERCENTAGES ARE NOT — which is the whole request',
    `${formatSpreadPercent(small)} vs ${formatSpreadPercent(big)}`
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 2. sign, rounding and the way it is written ===')
// ---------------------------------------------------------------------------
{
  ok(formatSpreadPercent(12.44) === '+12.4%', 'one decimal place, rounded', String(formatSpreadPercent(12.44)))
  ok(formatSpreadPercent(12.46) === '+12.5%', 'and rounded up when it should be', String(formatSpreadPercent(12.46)))
  ok(
    formatSpreadPercent(-3.1) === '−3.1%',
    'a loss carries the TYPOGRAPHIC minus, not a hyphen that vanishes at this size',
    String(formatSpreadPercent(-3.1))
  )
  ok(
    formatSpreadPercent(-3.1)?.charCodeAt(0) === 0x2212,
    'U+2212 specifically, the one the rest of the money screens use',
    String(formatSpreadPercent(-3.1)?.charCodeAt(0))
  )
  ok(
    formatSpreadPercent(8)?.startsWith('+'),
    'A GAIN IS SIGNED TOO — a column scanned by its first character has to have one on every row',
    String(formatSpreadPercent(8))
  )
  ok(formatSpreadPercent(0) === '0.0%', 'flat is written without a sign, because it went neither way')
  // Rounding must not manufacture a sign: −0.04% is flat to one decimal place,
  // and printing "−0.0%" would put a loss colour on a position that has not moved.
  ok(formatSpreadPercent(-0.04) === '0.0%', 'and a value that rounds to nothing is flat, not "−0.0%"')
  ok(spreadTone(-0.04) === null, 'with no colour on it either', String(spreadTone(-0.04)))

  ok(spreadTone(4) === 'pos' && spreadTone(-4) === 'neg', 'the tone follows the sign')
  ok(spreadTone(null) === null, 'and there is no tone where there is no percentage')

  // A very good buy is a very large number, and it is printed rather than capped.
  ok(formatSpreadPercent(spreadPercent(9_000, 1_000)) === '+900.0%', 'a ten-bagger says so')
}

// ---------------------------------------------------------------------------
console.log('\n=== 3. the two ways a division in a money screen goes wrong ===')
// ---------------------------------------------------------------------------
{
  // (a) NO BASIS IS NULL, NEVER ZERO. The dollar spread already dashes these
  // rows; a percentage that printed 0.0% would claim a measurement nobody made.
  ok(spreadPercent(400, 0) === null, 'stock carried at nothing has no percentage')
  ok(spreadPercentText(400, 0) === null, 'so the cell has nothing to print and falls back to a dash')
  ok(spreadPercent(400, -50) === null, 'and a negative basis is refused — the sign would flip and read as a gain')
  ok(spreadPercent(Number.NaN, 100) === null, 'a NaN spread is refused rather than printed')
  ok(spreadPercent(100, Number.POSITIVE_INFINITY) === null, 'so is an infinite basis')
  ok(formatSpreadPercent(null) === null, 'and formatting null stays null all the way to the cell')

  // (b) THE DENOMINATOR IS THE COST. Dividing by market value instead answers a
  // different question and is bounded at 100%, so it could never express the
  // ten-bagger above — this is the mistake that would look plausible on screen.
  const cost = 10_000
  const market = 25_000
  const spread = market - cost
  ok(
    spreadPercent(spread, cost) === 150,
    'a buy that more than doubled is +150% ON WHAT WAS PAID',
    String(spreadPercent(spread, cost))
  )
  ok(
    spreadPercent(spread, market) === 60,
    'the same position against MARKET VALUE would read +60% — a different, flatter, wrong number',
    String(spreadPercent(spread, market))
  )
  ok(
    spreadPercent(spread, cost) > 100,
    'and only the cost denominator can ever exceed 100%, which is the point',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== 4. a total is the ratio of the totals, not a mean of ratios ===')
// ---------------------------------------------------------------------------
// The screen totals sum the dollars and divide once. Averaging the row
// percentages would weight a $40 box the same as a $200,000 position, which is
// exactly the distortion the percentage was added to remove.
{
  const rows = [
    { spread: 5_000, cost: 200_000 }, // +2.5%, the bulk of the money
    { spread: 20, cost: 40 } //          +50%, a single cheap box
  ]
  const totalSpread = rows.reduce((n, r) => n + r.spread, 0)
  const totalCost = rows.reduce((n, r) => n + r.cost, 0)

  const correct = spreadPercent(totalSpread, totalCost) as number
  const meanOfRatios =
    rows.reduce((n, r) => n + (spreadPercent(r.spread, r.cost) as number), 0) / rows.length

  ok(Math.round(correct * 100) / 100 === 2.51, 'the screen total is 2.51%', String(correct))
  ok(Math.round(meanOfRatios * 10) / 10 === 26.3, 'an average of the rows would say 26.3%', String(meanOfRatios))
  ok(
    Math.abs(meanOfRatios - correct) > 20,
    'A TENFOLD LIE, from one $40 box. The totals row divides once, and this is why',
    String(Math.abs(meanOfRatios - correct))
  )
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
