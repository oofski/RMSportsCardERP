/**
 * The per-break P&L, read off the database.
 *
 * Two reads and one pure function. The arithmetic all lives in
 * @shared/breakPnl, so this file's only job is to hand it the right rows —
 * which is exactly where a per-break statement goes wrong: pull a different set
 * of rows than the day statement pulls, and the split stops adding up to the
 * day for a reason nobody can see from either screen.
 *
 * So both predicates below are COPIED FROM THE DAY, deliberately, with the
 * reasons kept beside them:
 *
 *   · Sales are bucket 'sale' only — the same bucket the statement's Sales line
 *     is defined as. Product sales are a separate line there and would be a
 *     separate line here; folding them in would make the split exceed the day.
 *   · Attributed rows only. A row whose session was deleted keeps a stale
 *     stream_date, and counting it would put money on a day the statement does
 *     not have it on.
 */
import type { Database } from 'better-sqlite3'
import type {
  BreakPnlBoxCost,
  BreakPnlCostRow,
  BreakPnlSaleRow,
  BreakPnlSplit
} from '@shared/breakPnl'
import { splitPnlByBreak } from '@shared/breakPnl'
import type { ProductUnits } from '@shared/units'
import { boxCost } from '@shared/units'
import { getDb } from './database'
import { rateLookup } from './whatnotRates'

interface RawSale {
  amount: number
  stream_date: string
  break_number: number | null
  message: string
}

interface RawCost {
  break_number: number | null
  cost_total: number
  loss_value: number
  unit_cost: number
  product_name: string
  unit_type: string | null
  boxes_per_case: number | null
  packs_per_box: number | null
}

/**
 * One business day, split by break.
 *
 * `day` is a BUSINESS day — a `stream_date`, the same key the statement and the
 * rate lookup are asked with. Passing a calendar date instead is what made one
 * show report two rates.
 */
export function breakPnlForDay(day: string): BreakPnlSplit {
  const db: Database = getDb()

  const sales = db
    .prepare(
      `SELECT amount, stream_date, break_number, message
         FROM ledger_rows
        WHERE stream_date = @day
          AND (session_id IS NOT NULL OR attribution = 'own_day')
          AND bucket = 'sale'
        ORDER BY occurred_at, rowid`
    )
    .all({ day }) as RawSale[]

  const costs = db
    .prepare(
      `SELECT i.break_number AS break_number,
              i.cost_total   AS cost_total,
              i.loss_value   AS loss_value,
              i.unit_cost    AS unit_cost,
              TRIM(i.product_name) AS product_name,
              p.unit_type      AS unit_type,
              p.boxes_per_case AS boxes_per_case,
              p.packs_per_box  AS packs_per_box
         FROM stream_items i
         JOIN stream_sessions s ON s.id = i.session_id
         LEFT JOIN inventory_products p ON p.id = i.product_id
        WHERE s.stream_date = @day
        ORDER BY i.created_at, i.rowid`
    )
    .all({ day }) as RawCost[]

  // One lookup for the whole day rather than one per row: the rate cannot
  // change inside a business day, and walking the period list once per sale row
  // is what made a nine-thousand-row export slow.
  const rateAt = rateLookup()

  const saleRows: BreakPnlSaleRow[] = sales.map((r) => ({
    breakNumber: r.break_number ?? null,
    // The listing title, for the "3x" box count and the product it names.
    message: r.message ?? '',
    // Cents, and rounded here rather than deeper in: the ledger stores dollars
    // as a REAL, and 18.29 * 100 is 1828.9999... on the way to the fee model.
    netCents: Math.round((r.amount ?? 0) * 100),
    rates: rateAt(r.stream_date)
  }))

  const costRows: BreakPnlCostRow[] = costs.map((r) => ({
    breakNumber: r.break_number ?? null,
    costTotal: r.cost_total ?? 0,
    lossValue: r.loss_value ?? 0,
    productName: r.product_name || undefined
  }))

  // WHAT ONE BOX OF EACH COSTED PRODUCT WAS WORTH, so a break with no cost line
  // of its own can be priced from the box count in its listing title.
  //
  // `boxCost` does the case→box division and REFUSES when boxes-per-case is
  // unknown rather than defaulting to one. A wrong divisor here does not look
  // wrong on screen — it silently distorts every break on the night — so a
  // product the catalog cannot divide simply contributes nothing and the breaks
  // that would have used it stay honestly blank.
  const perBox = new Map<string, number>()
  for (const r of costs) {
    const name = (r.product_name || '').trim()
    if (!name || perBox.has(name)) continue
    const per = boxCost(
      {
        unitType: (r.unit_type as ProductUnits['unitType']) ?? 'box',
        boxesPerCase: r.boxes_per_case ?? null,
        packsPerBox: r.packs_per_box ?? null,
        giveawayItem: false
      },
      r.unit_cost ?? 0
    )
    if (per !== null && per > 0) perBox.set(name, per)
  }
  const boxCosts: BreakPnlBoxCost[] = [...perBox].map(([productName, perBoxCost]) => ({
    productName,
    perBoxCost
  }))

  return splitPnlByBreak(saleRows, costRows, boxCosts)
}
