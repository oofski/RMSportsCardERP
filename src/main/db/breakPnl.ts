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
import type { BreakPnlCostRow, BreakPnlSaleRow, BreakPnlSplit } from '@shared/breakPnl'
import { splitPnlByBreak } from '@shared/breakPnl'
import { getDb } from './database'
import { rateLookup } from './whatnotRates'

interface RawSale {
  amount: number
  stream_date: string
  break_number: number | null
}

interface RawCost {
  break_number: number | null
  cost_total: number
  loss_value: number
  product_name: string
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
      `SELECT amount, stream_date, break_number
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
              TRIM(i.product_name) AS product_name
         FROM stream_items i
         JOIN stream_sessions s ON s.id = i.session_id
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

  return splitPnlByBreak(saleRows, costRows)
}
