/**
 * WHAT THE PLATFORM SAYS THE WINDOW SOLD — the only thing a derived revenue
 * figure can be checked against.
 *
 * ## Why this table has to exist
 *
 * Revenue in this app is not recorded, it is CALCULATED. The ledger states only
 * the net Whatnot paid; the gross a buyer bid is reverse-engineered from it by
 * adding a modelled fee back. That model has four knobs and every one of them is
 * a guess until somebody checks it, and until this table there was nothing
 * outside the app that any revenue figure had ever been compared with.
 *
 * The owner reported revenue running $15-25k a month above Whatnot's own stated
 * sales, every month, and no screen could confirm it or deny it. Two facts made
 * that both possible and invisible: the commission was resolved by DATE alone
 * while the real rate depends on what was sold, and any night no period covered
 * was silently priced at the built-in 8%. Neither moves the bottom line — the
 * fee comes straight back off two sections later — so the error lived entirely
 * on the top line where nothing was watching.
 *
 * ## One row is one document
 *
 * A dashboard reading, a statement, a 1099. Storing it rather than offering a
 * calculator is what makes the check STANDING: a figure typed once and thrown
 * away tells you about one month, and a figure kept tells you the day a rate
 * stops reproducing it. It is also exactly the record a year-end tie-out needs,
 * the 1099 being the only document that can confirm a whole year of derived
 * revenue at once.
 *
 * ## The fees are optional and the sales are not
 *
 * A platform dashboard routinely states sales alone. Demanding a commission and
 * a processing total nobody is holding would mean the check never gets used, and
 * a check nobody runs is worth less than a rough one somebody does. When all
 * three ARE to hand, `fitStatement` in the contract solves both rates at once
 * and is the better tool; this path solves the commission from sales alone.
 */
import type { Result } from '@shared/types'
import type { PinnedTerms, RevenueCheck, StatementInput, WhatnotStatement } from '@shared/statementFit'
import { fitFromGross, grossFitVerdict, payoutCheck } from '@shared/statementFit'
import type { StreamDayFinance, WhatnotRatePeriod } from '@shared/financeStreaming'
import { effectiveFeeRates, isDayKey } from '@shared/financeStreaming'
import { pinTermsFor, reconInRange, reconRows, reconTotals } from '@shared/pnlRecon'
import { getDb } from './database'
import { newId, nowIso } from '../util'

const NOTE_MAX = 200
const c2 = (v: number): number => Math.round((Number(v) || 0) * 100) / 100

interface StatementRow {
  id: string
  from_date: string
  to_date: string
  stated_gross: number
  stated_fees: number | null
  stated_payout: number | null
  note: string | null
  created_at: string
  updated_at: string
}

function toStatement(r: StatementRow): WhatnotStatement {
  return {
    id: r.id,
    fromDate: r.from_date,
    toDate: r.to_date,
    statedGross: r.stated_gross,
    statedFees: r.stated_fees ?? null,
    statedPayout: r.stated_payout ?? null,
    note: r.note ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/**
 * Every stated figure, newest window first.
 *
 * Newest first because a reconciliation starts from the thing that just landed —
 * the same order `reconRows` sorts in, and for the same reason.
 */
export function listStatements(): WhatnotStatement[] {
  const rows = getDb()
    .prepare(
      `SELECT id, from_date, to_date, stated_gross, stated_fees, stated_payout, note,
              created_at, updated_at
         FROM whatnot_statements
        ORDER BY from_date DESC, rowid DESC`
    )
    .all() as StatementRow[]
  return rows.map(toStatement)
}

/** Everything that can be wrong with one, as a sentence, or null. */
export function validateStatement(input: StatementInput): string | null {
  if (!isDayKey(String(input?.fromDate ?? ''))) return 'The start date is not a real date.'
  if (!isDayKey(String(input?.toDate ?? ''))) return 'The end date is not a real date.'
  if (String(input.toDate) < String(input.fromDate)) {
    return 'The end date is before the start date.'
  }
  const gross = Number(input?.statedGross)
  // Number('') is 0, so an empty box would otherwise be stored as a stated zero
  // and then reported as revenue overshooting by the whole month.
  if (!Number.isFinite(gross) || gross <= 0) {
    return 'Enter the sales figure the platform states for this window.'
  }
  if (gross > 100_000_000) return 'That figure is larger than this app will accept.'
  if (input?.statedFees !== undefined && input.statedFees !== null) {
    const fees = Number(input.statedFees)
    if (!Number.isFinite(fees) || fees < 0) return 'The fees figure is not a number.'
    if (fees >= gross) return 'The fees cannot be the whole of the sales.'
  }
  if (input?.statedPayout !== undefined && input.statedPayout !== null) {
    const paid = Number(input.statedPayout)
    if (!Number.isFinite(paid) || paid < 0) return 'The payout figure is not a number.'
    // A payout ABOVE sales is possible for a day and absurd for a window — it
    // would mean the platform paid out more than it took. Almost always the
    // gross box has the payout in it and the payout box has the sales.
    if (paid > gross) {
      return 'The payout is larger than the sales, which cannot be right for a whole window — are the two figures the other way round?'
    }
  }
  return null
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/**
 * Create or update one, returning the whole list back.
 *
 * The list rather than the row, matching `saveRatePeriod`: these are windows
 * that describe each other, and a screen replacing its state wholesale cannot
 * drift from what was stored.
 */
export function saveStatement(
  input: StatementInput,
  actorId: string | null
): Result<WhatnotStatement[]> {
  const clean: StatementInput = {
    id: typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
    fromDate: String(input?.fromDate ?? '').trim(),
    toDate: String(input?.toDate ?? '').trim(),
    statedGross: c2(Number(input?.statedGross)),
    statedFees:
      input?.statedFees === undefined || input.statedFees === null || input.statedFees === ('' as never)
        ? null
        : c2(Number(input.statedFees)),
    statedPayout:
      input?.statedPayout === undefined ||
      input.statedPayout === null ||
      input.statedPayout === ('' as never)
        ? null
        : c2(Number(input.statedPayout)),
    note: String(input?.note ?? '').trim().slice(0, NOTE_MAX)
  }

  const invalid = validateStatement(clean)
  if (invalid) return { ok: false, error: invalid }

  const db = getDb()
  const ts = nowIso()
  try {
    if (clean.id) {
      const info = db
        .prepare(
          `UPDATE whatnot_statements
              SET from_date = @from, to_date = @to, stated_gross = @gross,
                  stated_fees = @fees, stated_payout = @paid, note = @note, updated_at = @ts
            WHERE id = @id`
        )
        .run({
          id: clean.id,
          from: clean.fromDate,
          to: clean.toDate,
          gross: clean.statedGross,
          fees: clean.statedFees,
          paid: clean.statedPayout ?? null,
          note: clean.note,
          ts
        })
      if (info.changes === 0) return { ok: false, error: 'That figure no longer exists.' }
    } else {
      db.prepare(
        `INSERT INTO whatnot_statements
           (id, from_date, to_date, stated_gross, stated_fees, stated_payout, note,
            created_at, updated_at, created_by)
         VALUES (@id, @from, @to, @gross, @fees, @paid, @note, @ts, @ts, @by)`
      ).run({
        id: newId(),
        from: clean.fromDate,
        to: clean.toDate,
        gross: clean.statedGross,
        fees: clean.statedFees,
        paid: clean.statedPayout ?? null,
        note: clean.note,
        ts,
        by: actorId
      })
    }
    return { ok: true, data: listStatements() }
  } catch (err) {
    return fail(err)
  }
}

export function deleteStatement(id: string): Result<WhatnotStatement[]> {
  try {
    const info = getDb()
      .prepare('DELETE FROM whatnot_statements WHERE id = ?')
      .run(String(id ?? '').trim())
    if (info.changes === 0) return { ok: false, error: 'That figure no longer exists.' }
    return { ok: true, data: listStatements() }
  } catch (err) {
    return fail(err)
  }
}

/**
 * Compare one stated figure against what the app derives for the same window.
 *
 * ## Built entirely out of things that already exist
 *
 * `reconRows` already answers "what did each night hold, at what rate, and was
 * that rate one somebody chose" — including the order count the fit needs and
 * the uncovered-money figure that is the other likely cause. `reconInRange`
 * already windows it by business day using string comparison, which is the rule
 * this codebase keeps everywhere for date-only values. `fitFromGross` already
 * solves the commission. Nothing here re-derives any of it, so this cannot
 * disagree with the Night by night table somebody checks it against.
 *
 * ## Which terms are held fixed
 *
 * The card percentage, the tax rate and the flat charge are pinned and the
 * commission is solved, because the commission is the term that actually varies:
 * it is negotiated, it changes, and it differs by what is being sold. They are
 * taken from THE NIGHT THAT CARRIED THE MOST MONEY in the window — the same
 * choice `pnlRecon` makes for a rolled-up rate, on the same reasoning that when
 * one answer is required the honest one is the terms that priced most of it.
 * When the window is not all on one set of card terms, `mixedTerms` says so
 * rather than letting the average pass as exact.
 *
 * THAT RULE IS `pinTermsFor` IN @shared/pnlRecon AND IS NOT COPIED HERE. It used
 * to be, and the copy is how the app came to hold two answers to one question:
 * the Rates tab pins the same terms for the same window and picked them off the
 * window's LAST DAY, falling back to TODAY when the date box was blank — which
 * it defaulted to — so the panel could fit July's money on this month's rates
 * while this store fitted it on July's heaviest night, and nothing on either
 * screen said they disagreed. Deleted rather than kept in step: a second copy is
 * exactly how they drifted apart, and it would drift again.
 */
export function revenueCheck(
  days: readonly StreamDayFinance[],
  periods: readonly WhatnotRatePeriod[],
  window: { fromDate: string; toDate: string; statedGross: number; statedPayout?: number | null }
): RevenueCheck {
  const from = String(window.fromDate ?? '').trim()
  const to = String(window.toDate ?? '').trim()
  const rows = reconInRange(reconRows(days, periods), from, to)
  const totals = reconTotals(rows)

  // The night that carried the most money decides the pinned terms — the shared
  // rule, called, not reimplemented. See the note above about the second copy.
  //
  // The day-to-terms lookup goes in as a CALLBACK because resolving it is a
  // main-process job: it reads the rate periods this process holds, and dragging
  // that into `@shared` would put it in the browser bundle as well.
  const termsFor = (day: string): PinnedTerms => {
    const r = effectiveFeeRates(periods, day)
    return {
      processingRate: r.processingRate,
      taxRate: r.taxRate,
      processingFlatCents: r.processingFlatCents
    }
  }
  // The fallback is named here rather than left to the shared default because it
  // is this file's own answer for a window that held no money: nothing is being
  // priced, so the built-in card terms stand in. These are the same figures as
  // `DEFAULT_FEE_RATES`, written out so that changing the platform defaults
  // cannot quietly change what an EMPTY window reports.
  const { pinned, mixedTerms } = pinTermsFor(rows, termsFor, {
    processingRate: 0.029,
    taxRate: 0.0518,
    processingFlatCents: 30
  })

  const fit = fitFromGross(
    Number(window.statedGross) || 0,
    { netPaid: totals.netPaid, derivedRevenue: totals.grossSales, orders: totals.orders },
    pinned
  )

  return {
    fromDate: from,
    toDate: to,
    hasData: rows.length > 0,
    fit,
    verdict: grossFitVerdict(fit),
    pinned,
    mixedTerms,
    uncoveredDays: totals.uncoveredDays,
    uncoveredNetPaid: totals.uncoveredNetPaid,
    /**
     * Only when the statement states one. Both sides here are RECORDED — every
     * row of the ledger's own Amount column and the platform's payout — so this
     * is the check that can say whether the app holds the right rows at all,
     * which is upstream of every question about rates.
     *
     * `ledgerNet` AND NOT `netPaid`: the payout has postage, boosts, refunds and
     * tips in it, and so must the figure it is compared with, or the app's own
     * other buckets are reported as a discrepancy. `netPaid` — the sale rows
     * alone — is the right input to the fit two lines up and the wrong one here.
     * See ReconRow.ledgerNet and payoutCheck.
     */
    payout:
      window.statedPayout === undefined || window.statedPayout === null
        ? null
        : payoutCheck(totals.ledgerNet, Number(window.statedPayout))
  }
}
