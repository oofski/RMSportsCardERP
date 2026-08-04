/**
 * General expenses — the one figure on a P&L day that nobody imported.
 *
 * A DOLLAR AMOUNT, NOT A STOCK MOVEMENT. The owner's ask was "general product
 * lost in dollar amount": a pack opened for fun, a box given to a friend, a
 * sleeve that walked. Recording an actual movement is what the Streaming
 * giveaway flow already does — it consumes the FIFO layers, drops the on-hand
 * count and values the loss at what those layers cost — and nothing in this file
 * touches inventory, on purpose. It exists for the loose case where nobody is
 * going to reconcile a pack against the shelf, where inventing a lot consumption
 * would move the stock count away from the truth rather than toward it.
 *
 * THE TWO MUST NOT BE CONFLATED. A giveaway entered in Streaming AND typed here
 * books the same pack twice: once through `stream_items.loss_value` into
 * `giveawayCost`, once through this table into `generalExpenses`. Nothing can
 * detect that — one is a stock movement and the other is a bare number — so the
 * only defence is the split the two screens make obvious.
 *
 * Stored POSITIVE and reported NEGATIVE, the same bargain `stream_items` makes
 * with `cost_total`. The negation happens in `buildView`, once, where every other
 * cost is signed.
 */
import type { Result } from '@shared/types'
import type { GeneralExpense, GeneralExpenseInput } from '@shared/financeStreaming'
import {
  EXPENSE_LABEL_MAX,
  EXPENSE_NOTE_MAX,
  validateGeneralExpense
} from '@shared/financeStreaming'
import { getDb } from './database'
import { newId, nowIso } from '../util'

interface ExpenseRow {
  id: string
  stream_date: string
  amount: number
  label: string
  note: string | null
  created_at: string
  created_by: string | null
  updated_at: string
}

const SELECT =
  `SELECT id, stream_date, amount, label, note, created_at, created_by, updated_at
     FROM finance_expenses`

function toExpense(r: ExpenseRow): GeneralExpense {
  return {
    id: r.id,
    streamDate: r.stream_date,
    // Rounded on read as well as on write. A row can arrive from another laptop
    // through the relay, which upserts whatever it was sent — and a fraction of a
    // cent landing in the P&L would surface as an unreconciled day rather than as
    // the typo it is.
    amount: Math.round(r.amount * 100) / 100,
    label: r.label,
    note: r.note ?? '',
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at
  }
}

/**
 * Every entry, newest day first.
 *
 * The whole list rather than a page: this is a handful of rows a person typed,
 * and the screen that shows them filters by whatever range is selected. A day
 * filter in SQL would mean the panel could not show a range without a second
 * query shape.
 */
export function listExpenses(): GeneralExpense[] {
  const rows = getDb()
    .prepare(`${SELECT} ORDER BY stream_date DESC, created_at DESC, rowid DESC`)
    .all() as ExpenseRow[]
  return rows.map(toExpense)
}

/**
 * What each business day carries, in INTEGER CENTS, for the P&L.
 *
 * Summed in SQL rather than in JS for the same reason every other day rollup in
 * this module is: the caller adds it to figures that are already cents, and a
 * float sum of forty entries compared against a cents total is how a
 * reconciliation check reports a phantom penny.
 */
export function expenseTotalsByDay(): Map<string, { cents: number; count: number }> {
  const rows = getDb()
    .prepare(
      `SELECT stream_date AS d, COUNT(*) AS n,
              COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS cents
         FROM finance_expenses
        GROUP BY stream_date`
    )
    .all() as Array<{ d: string; n: number; cents: number }>
  const out = new Map<string, { cents: number; count: number }>()
  for (const r of rows) out.set(r.d, { cents: r.cents, count: r.n })
  return out
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/**
 * Create (no id) or update (id), returning the whole list back.
 *
 * The list rather than the row, matching `saveRatePeriod`: the caller is a panel
 * showing all of them and replacing its state wholesale is what stops it drifting
 * out of step with what was actually stored.
 *
 * COERCED AND RE-VALIDATED HERE, not trusted from the renderer. The form checks
 * too, so the operator finds out early, but a renderer is a convenience and this
 * is the trust boundary — and this number comes straight off reported profit.
 */
export function saveExpense(
  input: GeneralExpenseInput,
  actorId: string | null
): Result<GeneralExpense[]> {
  // Number('') is 0 and Number('$12') is NaN. Both have to reach the validator
  // as themselves: a blank amount silently booked as zero would leave an entry
  // sitting on a day looking like a decision somebody made.
  const clean: GeneralExpenseInput = {
    id: typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
    streamDate: String(input?.streamDate ?? '').trim(),
    amount: typeof input?.amount === 'number' ? input.amount : Number(input?.amount),
    label: String(input?.label ?? '').trim().slice(0, EXPENSE_LABEL_MAX),
    note: String(input?.note ?? '').trim().slice(0, EXPENSE_NOTE_MAX)
  }

  const invalid = validateGeneralExpense(clean)
  if (invalid) return { ok: false, error: invalid }

  // To the cent on the way in as well as on the way out. The P&L adds this to
  // integer-cent totals and asserts the result against the ledger rows, so a
  // third decimal place typed into the form would flag the whole day.
  const amount = Math.round(clean.amount * 100) / 100

  const db = getDb()
  const ts = nowIso()
  try {
    if (clean.id) {
      const info = db
        .prepare(
          `UPDATE finance_expenses
              SET stream_date = @day, amount = @amount, label = @label, note = @note,
                  updated_at = @ts, updated_by = @by
            WHERE id = @id`
        )
        .run({
          id: clean.id,
          day: clean.streamDate,
          amount,
          label: clean.label,
          note: clean.note || null,
          ts,
          by: actorId
        })
      if (info.changes === 0) return { ok: false, error: 'That expense no longer exists.' }
    } else {
      db.prepare(
        `INSERT INTO finance_expenses
           (id, stream_date, amount, label, note, created_at, created_by, updated_at, updated_by)
         VALUES (@id, @day, @amount, @label, @note, @ts, @by, @ts, @by)`
      ).run({
        id: newId(),
        day: clean.streamDate,
        amount,
        label: clean.label,
        note: clean.note || null,
        ts,
        by: actorId
      })
    }
    return { ok: true, data: listExpenses() }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Remove one entry. The day it was on gets that money back, which is a real
 * change to a reported bottom line — so the caller is expected to mean it.
 */
export function deleteExpense(id: string): Result<GeneralExpense[]> {
  try {
    const info = getDb()
      .prepare('DELETE FROM finance_expenses WHERE id = ?')
      .run(String(id ?? '').trim())
    if (info.changes === 0) return { ok: false, error: 'That expense no longer exists.' }
    return { ok: true, data: listExpenses() }
  } catch (err) {
    return fail(err)
  }
}
