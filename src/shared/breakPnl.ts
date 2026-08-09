/**
 * One night's P&L, split by break.
 *
 * The day statement answers "what did last night make". This answers the
 * question underneath it — "which breaks made it" — and it is the same
 * arithmetic grouped one level finer, deliberately, so the two can never
 * disagree about the same money.
 *
 * ## Why this is exact rather than allocated
 *
 * The obvious worry with a per-break split is the flat 30¢: it is charged per
 * ORDER, and an order can contain teams from several breaks, so there would be
 * no fact in the data saying whose 30¢ it is.
 *
 * That problem does not arise here, and it is worth saying why rather than
 * leaving it to be rediscovered. `deriveSaleFee` runs on ONE LEDGER ROW at a
 * time — it takes that row's net payout and recovers the commission and the
 * processing charge that produced it. The day's fee figure is already nothing
 * but the sum of those per-row results. Every row carries at most one break
 * number, so grouping the rows by break and re-running the identical function
 * gives fees that add back to the day's to the cent, with nothing apportioned
 * and no rule to argue about.
 *
 * So the split is not an estimate of the day. It is the day, re-summed.
 *
 * ## What is NOT exact, and says so
 *
 * COST is the other half, and it comes from somewhere else entirely: the boxes
 * recorded as ripped for that break (`stream_items.break_number`). A break can
 * have a night's revenue and no cost line at all, because nobody entered what
 * was opened for it. That break's margin is then unknown, NOT 100%.
 *
 * A statement that prints a missing cost as a zero is worse than one that
 * refuses: 100% margin is a plausible-looking number, it flatters the break
 * that has the problem, and it silently inflates the total of any list sorted
 * by profit. So `costKnown` is false, gross profit is null, and the screen
 * shows a gap where a figure would be.
 *
 * ## The unattributed row
 *
 * Not every sale row names a break. Those are collected into one row rather
 * than dropped, so the parts always sum to the whole — a per-break view whose
 * lines quietly fail to add up to the day's total is a view that gets trusted
 * and then found out.
 */

import type { WhatnotFeeRates } from './financeStreaming'
import { computeFees } from './financeStreaming'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * One sale row, already resolved to the rates its business day was charged
 * under.
 *
 * Rates are carried per row rather than per call because a rolled-up period can
 * span a rate change — see `rateLookup`. Passing one rate for a range is how a
 * week that crossed a boundary reported a percentage nobody had configured.
 */
export interface BreakPnlSaleRow {
  /** Null when the ledger message named no break. */
  breakNumber: number | null
  netCents: number
  rates: WhatnotFeeRates
  /** The raw ledger message, for the "3x" box count and the product name. */
  message?: string
}

/**
 * How many boxes went into a break, off the listing title.
 *
 * "Earnings for selling a 3x 2026 Finest Delight HALF CASE (NEW RELEASE!)-
 * Break #7 - Houston Astros" → 3.
 *
 * The multiplier describes the BREAK, not the purchase: every row in break #7
 * carries the same "3x" because it is part of the listing title all thirty
 * teams were sold under. That is what makes it usable as a break-level fact
 * from any one of its rows.
 *
 * ONLY BEFORE THE BREAK MARKER. A team name can contain a digit and an x
 * ("Red Sox" does not, but nothing stops a future listing), and the segment
 * after "Break #7 -" is the team. Reading a multiplier out of there would
 * silently re-cost a break off the buyer's team name.
 *
 * Bounded at 60 because this multiplies a case price: a mis-read that produced
 * 2026 boxes from the year would not look like a typo on a screen, it would
 * look like a catastrophic night.
 */
export function parseBreakBoxes(message: string): number | null {
  const m = message || ''
  // Cut at the break marker so only the listing title is searched.
  const cut = /\bBreak\s*#?\s*=?\s*\d+/i.exec(m)
  const head = cut ? m.slice(0, cut.index) : m
  // A digit immediately followed by x, as its own word: "3x", "12 x".
  const hit = /\b(\d{1,2})\s*x\b/i.exec(head)
  if (!hit) return null
  const n = Number(hit[1])
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : null
}

/**
 * A product costed on this night, and what ONE BOX of it cost.
 *
 * The division from a case price is done by the caller with `boxCost` from
 * @shared/units, which already refuses when boxes-per-case is unknown — a wrong
 * divisor here silently distorts every break on the night, so a missing one has
 * to stay missing rather than defaulting.
 */
export interface BreakPnlBoxCost {
  productName: string
  perBoxCost: number
}

/** Where a break's cost figure came from. Shown, because they differ in trust. */
export type BreakCostSource = 'recorded' | 'derived' | 'unknown'

/** One costed thing consumed on the night, from `stream_items`. */
export interface BreakPnlCostRow {
  breakNumber: number | null
  /** What the boxes for this break cost. Positive dollars. */
  costTotal: number
  /** A giveaway's prize value, which is a cost of the show and not of a box. */
  lossValue?: number
  productName?: string
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface BreakPnlRow {
  /** Null on the unattributed row, which is why it is not a number field. */
  breakNumber: number | null
  /** "#7", or "No break named" — what the screen prints. */
  label: string
  /** How many ledger rows are behind this line. */
  saleCount: number
  /** Derived gross: net with both fees added back. */
  grossSales: number
  /** NEGATIVE. */
  whatnotFee: number
  /** NEGATIVE. */
  processingFee: number
  /** NEGATIVE. whatnotFee + processingFee. */
  totalFees: number
  /** What the boxes cost. Zero when nothing was recorded — read `costKnown`. */
  cogs: number
  /** Was a cost actually recorded for this break? */
  costKnown: boolean
  /**
   * Where the cost came from.
   *
   * 'recorded' is a stream item entered against this break — the strongest.
   * 'derived' is boxes × per-box price, read off the listing title. Both are
   * real numbers; they are told apart on screen because one is what somebody
   * entered and the other is what the app worked out, and an operator
   * reconciling a night needs to know which is which.
   */
  costSource: BreakCostSource
  /** Boxes in this break, off the "3x" in the listing title. Null if unread. */
  boxes: number | null
  /** The products named on the cost lines, for a one-line detail. */
  products: string[]
  /**
   * gross − cogs, or NULL when no cost was recorded.
   *
   * Null rather than "same as gross", because a break with an unknown cost has
   * an unknown margin and printing the revenue there says 100%.
   */
  grossProfit: number | null
  /** grossProfit + fees, or null for the same reason. */
  netProfit: number | null
}

export interface BreakPnlSplit {
  rows: BreakPnlRow[]
  /** Every row's gross added up — equal to the day's sales line, to the cent. */
  grossSales: number
  totalFees: number
  /**
   * Cost that could be attributed at all — recorded plus derived.
   *
   * NOT the night's cost of goods: a break with neither a cost line nor a
   * readable box count contributes nothing here, so this can be short of the
   * statement's own figure. That gap is the point — it is how much of the
   * night's cost the split could actually place on a break.
   */
  cogs: number
  /** How many rows have revenue and no recorded cost. */
  uncostedBreaks: number
  /** True when at least one sale row named no break. */
  hasUnattributed: boolean
}

const c2 = (n: number): number => Math.round(n * 100) / 100

/** "#7" — matching the chip the shipping module prints for the same break. */
export function breakPnlLabel(breakNumber: number | null): string {
  return breakNumber === null ? 'No break named' : `#${breakNumber}`
}

/**
 * Order: by break number, with the unattributed row LAST.
 *
 * Last rather than first because it is the exception. Sorting it to the top
 * would put the line that represents a gap in the data above every line that
 * represents a break, on a screen somebody is reading to compare breaks.
 */
export function compareBreakPnlRows(a: BreakPnlRow, b: BreakPnlRow): number {
  if (a.breakNumber === null) return b.breakNumber === null ? 0 : 1
  if (b.breakNumber === null) return -1
  return a.breakNumber - b.breakNumber
}

/**
 * Split a night's sales and costs by break.
 *
 * `computeFees` is called once per group rather than reimplemented, so the fee
 * arithmetic here IS the fee arithmetic on the day statement — there is no
 * second copy to drift.
 */
/**
 * Which costed product a break's listing title is naming.
 *
 * Matched on words rather than equality: the ledger title is marketing —
 * "3x 2026 Finest Delight HALF CASE (NEW RELEASE!)" — and the catalog name is
 * not. Scored by how many of the product's own words appear in the title, so a
 * product named in full wins over one that happens to share a year.
 *
 * A TIE RETURNS NOTHING. Two products scoring equally means the title does not
 * distinguish them, and picking either would put one product's case price on
 * another product's break — a wrong number that looks entirely reasonable. The
 * break's cost stays unknown instead, which is visible.
 */
export function matchBoxCost(
  title: string,
  costs: readonly BreakPnlBoxCost[]
): BreakPnlBoxCost | null {
  if (!costs.length) return null
  // One costed product on the night is the ordinary case and needs no matching.
  if (costs.length === 1) return costs[0]
  const hay = ` ${(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `
  let best: BreakPnlBoxCost | null = null
  let bestScore = 0
  let tied = false
  for (const c of costs) {
    const words = c.productName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean)
    if (!words.length) continue
    const score = words.filter((w) => hay.includes(` ${w} `)).length
    if (score === 0) continue
    if (score > bestScore) {
      bestScore = score
      best = c
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }
  return tied ? null : best
}

export function splitPnlByBreak(
  sales: readonly BreakPnlSaleRow[],
  costs: readonly BreakPnlCostRow[],
  /** What one box of each product costed on this night was worth. */
  boxCosts: readonly BreakPnlBoxCost[] = []
): BreakPnlSplit {
  const saleGroups = new Map<number | null, BreakPnlSaleRow[]>()
  for (const row of sales) {
    const key = row.breakNumber ?? null
    const list = saleGroups.get(key)
    if (list) list.push(row)
    else saleGroups.set(key, [row])
  }

  const costGroups = new Map<number | null, { total: number; products: string[] }>()
  for (const row of costs) {
    const key = row.breakNumber ?? null
    const entry = costGroups.get(key) ?? { total: 0, products: [] }
    // A giveaway's prize is a cost of the show that rode along in this break,
    // so it belongs to the break rather than to nothing. It is added rather
    // than replacing cost_total: the two are different movements — see the note
    // on `loss_value` in the schema.
    entry.total += (row.costTotal ?? 0) + (row.lossValue ?? 0)
    const name = (row.productName ?? '').trim()
    if (name && !entry.products.includes(name)) entry.products.push(name)
    costGroups.set(key, entry)
  }

  // Every break that appears on EITHER side. A break with cost and no sales is
  // a real and alarming thing — boxes opened, nothing sold — and dropping it
  // because the sales map has no key for it would hide exactly that.
  const keys = new Set<number | null>([...saleGroups.keys(), ...costGroups.keys()])

  const rows: BreakPnlRow[] = []
  for (const key of keys) {
    const group = saleGroups.get(key) ?? []
    const fees = computeFees(group.map((r) => ({ netCents: r.netCents, rates: r.rates })))
    // The break's own listing title, from whichever of its rows carries one.
    // Every row in a break shares it, so the first is as good as any.
    const title = group.find((r) => (r.message ?? '').trim())?.message ?? ''
    const boxes = key === null ? null : parseBreakBoxes(title)

    const cost = costGroups.get(key)
    let costSource: BreakCostSource = 'unknown'
    let cogs = 0
    if (cost && cost.total !== 0) {
      costSource = 'recorded'
      cogs = c2(cost.total)
    } else if (boxes !== null) {
      // WHAT THE OPERATOR ASKED FOR. The listing says how many boxes went into
      // this break; the night's cost of goods says what one box was worth. The
      // product of the two is this break's cost, and it beats leaving the row
      // blank when the two facts are both sitting there.
      const per = matchBoxCost(title, boxCosts)
      if (per && per.perBoxCost > 0) {
        costSource = 'derived'
        cogs = c2(boxes * per.perBoxCost)
      }
    }
    const costKnown = costSource !== 'unknown'
    const grossProfit = costKnown ? c2(fees.grossSales - cogs) : null
    rows.push({
      breakNumber: key,
      label: breakPnlLabel(key),
      saleCount: fees.saleCount,
      grossSales: fees.grossSales,
      whatnotFee: fees.whatnotFee,
      processingFee: fees.processingFee,
      totalFees: fees.totalFees,
      cogs,
      costKnown,
      costSource,
      boxes,
      products: cost?.products ?? [],
      grossProfit,
      // Fees are already negative, so this is an addition. Written out rather
      // than subtracted, because reading it as a subtraction is how the sign
      // gets flipped by somebody tidying it later.
      netProfit: grossProfit === null ? null : c2(grossProfit + fees.totalFees)
    })
  }

  rows.sort(compareBreakPnlRows)

  return {
    rows,
    grossSales: c2(rows.reduce((s, r) => s + r.grossSales, 0)),
    totalFees: c2(rows.reduce((s, r) => s + r.totalFees, 0)),
    cogs: c2(rows.reduce((s, r) => s + r.cogs, 0)),
    uncostedBreaks: rows.filter((r) => !r.costKnown && r.grossSales !== 0).length,
    hasUnattributed: rows.some((r) => r.breakNumber === null)
  }
}
