/**
 * What the platform charged, and when.
 *
 * FOUR NUMBERS, AND THEY MULTIPLY EVERYTHING. The commission, the sales tax
 * rate, the card percentage and the card flat charge are between them the whole
 * difference between the net Whatnot paid and the price the buyer bid, so they
 * decide the top line of every show the business has ever run. Each defaults to
 * what RM is on today and each can be overridden for a stretch of dates, because
 * every one of them is a term somebody set — a seller agreement, a state, a card
 * network — rather than a law of nature.
 *
 * A PERIOD COVERS SHOWS, NOT CALENDAR DAYS. The dates on a period are business
 * days — the same `stream_date` the P&L groups by — so "15 June to 20 July" is
 * "the shows that started on those nights", and a show running until 2am is
 * priced end to end at the rate its opening night falls under. `buildView` in
 * financeStreaming.ts carries the long argument for that, including what it
 * gives up.
 *
 * NOTHING IS STORED ON A ROW. The fee is computed on READ, in `buildView`, from
 * the rate in force on each row's business day. That is what makes a rate change
 * re-derive history: change the period, reopen Finance, and every show inside it
 * moves — no re-upload, no re-attribution, no migration. The alternative, baking
 * a fee onto each ledger row at import, would leave a database holding two
 * generations of answers and no way to tell which show was priced under which.
 *
 * OVERLAP IS REFUSED. See `overlappingRatePeriod` in the contract for the
 * argument; this module is where it is enforced, inside the write transaction,
 * against the rows as they are at that instant. A renderer that checked first
 * and a main that did not would be a check, not a rule.
 */
import type { Result } from '@shared/types'
import type { RatePeriodInput, WhatnotRatePeriod } from '@shared/financeStreaming'
import type { WhatnotFeeRates } from '@shared/financeStreaming'
import {
  DEFAULT_FEE_RATES,
  DEFAULT_PROCESSING_FLAT_CENTS,
  DEFAULT_PROCESSING_RATE,
  DEFAULT_TAX_RATE,
  effectiveFeeRates,
  overlappingRatePeriod,
  validateRatePeriod
} from '@shared/financeStreaming'
import { getDb } from './database'
import { newId, nowIso } from '../util'

interface RateRow {
  id: string
  from_date: string
  to_date: string | null
  rate: number
  tax_rate: number | null
  processing_rate: number | null
  processing_flat_cents: number | null
  note: string | null
  created_at: string
  updated_at: string
}

/**
 * A stored row as the contract sees it.
 *
 * The three newer columns fall back to the defaults rather than trusting the
 * column default alone: a row can arrive from a laptop still running the build
 * that had only a commission, and last-write-wins would land it here with those
 * cells empty. A NULL tax rate reaching the model would price the whole range at
 * nothing.
 */
function toPeriod(r: RateRow): WhatnotRatePeriod {
  return {
    id: r.id,
    fromDate: r.from_date,
    toDate: r.to_date,
    rate: r.rate,
    taxRate: r.tax_rate ?? DEFAULT_TAX_RATE,
    processingRate: r.processing_rate ?? DEFAULT_PROCESSING_RATE,
    processingFlatCents: r.processing_flat_cents ?? DEFAULT_PROCESSING_FLAT_CENTS,
    note: r.note ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** Every period, earliest first — the order the screen reads them in. */
export function listRatePeriods(): WhatnotRatePeriod[] {
  const rows = getDb()
    .prepare(
      `SELECT id, from_date, to_date, rate, tax_rate, processing_rate,
              processing_flat_cents, note, created_at, updated_at
         FROM whatnot_fee_periods
        ORDER BY from_date ASC, rowid ASC`
    )
    .all() as RateRow[]
  return rows.map(toPeriod)
}

/**
 * A rate reader for one pass over the ledger.
 *
 * Loads the periods ONCE and memoises per business day, because the caller asks
 * for a rate per sale row and a nine-thousand-row export would otherwise walk
 * the period list nine thousand times. Snapshotting also means a single
 * derivation cannot see a rate change halfway through and produce a day that
 * disagrees with itself.
 *
 * The parameter is named `day` and it means a BUSINESS day. Every caller passes
 * the row's `stream_date`; passing a calendar date instead is what made one show
 * report two rates and a blended percentage nobody had configured.
 */
export function rateLookup(): (day: string) => WhatnotFeeRates {
  const periods = listRatePeriods()
  const cache = new Map<string, WhatnotFeeRates>()
  return (day: string): WhatnotFeeRates => {
    const hit = cache.get(day)
    if (hit !== undefined) return hit
    const rates = effectiveFeeRates(periods, day)
    cache.set(day, rates)
    return rates
  }
}

/**
 * What the platform charged on one BUSINESS DAY. The defaults where nothing is
 * configured.
 *
 * This is what the Fees & rates preview answers with, and it takes the same kind
 * of key `rateLookup` is called with in `buildView` — a `stream_date`, not a
 * calendar date. That is the whole reason the preview and the statement agree:
 * ask both about 20 July and they are asking the period list the same question.
 */
export function rateForDate(day: string): WhatnotFeeRates {
  return effectiveFeeRates(listRatePeriods(), day)
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/** "6 Jul 2026" — for an error message a person has to act on. */
function dayLabel(day: string): string {
  const [y, m, d] = (day || '').split('-').map(Number)
  if (!y || !m || !d) return day
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${d} ${MON[m - 1]} ${y}`
}

function spanLabel(p: WhatnotRatePeriod): string {
  return p.toDate ? `${dayLabel(p.fromDate)} – ${dayLabel(p.toDate)}` : `${dayLabel(p.fromDate)} onwards`
}

/** The note, bounded. A rate is not a place to keep an essay. */
const NOTE_MAX = 200

/**
 * Create or update one period, returning the whole list back.
 *
 * The list rather than the row: this is a set of ranges that constrain each
 * other, so the only useful answer to "did that save" is what the set looks like
 * now. Every screen showing it replaces its state wholesale and cannot drift.
 */
export function saveRatePeriod(
  input: RatePeriodInput,
  actorId: string | null
): Result<WhatnotRatePeriod[]> {
  // Coerced HERE, not trusted from the renderer: a form sends strings, and
  // Number('') is 0 — a silently booked 0% commission that would double the
  // reported gross of every show in the range.
  //
  // An ABSENT figure takes the default rather than NaN, and only an absent one.
  // A renderer packaged before the three newer terms existed sends the
  // commission alone, and refusing its save outright would leave the operator
  // with a screen that cannot write; taking the defaults puts that period on
  // exactly the terms the app assumed before the columns existed. A field that
  // is PRESENT and unparseable still arrives as NaN and is still refused.
  const num = (v: unknown, fallback: number): number =>
    v === undefined || v === null || v === '' ? fallback : typeof v === 'number' ? v : Number(v)
  const clean: RatePeriodInput = {
    id: typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : undefined,
    fromDate: String(input?.fromDate ?? '').trim(),
    toDate:
      input?.toDate === null || input?.toDate === undefined || String(input.toDate).trim() === ''
        ? null
        : String(input.toDate).trim(),
    rate: typeof input?.rate === 'number' ? input.rate : Number(input?.rate),
    taxRate: num(input?.taxRate, DEFAULT_FEE_RATES.taxRate),
    processingRate: num(input?.processingRate, DEFAULT_FEE_RATES.processingRate),
    processingFlatCents: Math.round(
      num(input?.processingFlatCents, DEFAULT_FEE_RATES.processingFlatCents)
    ),
    note: String(input?.note ?? '').trim().slice(0, NOTE_MAX)
  }

  const invalid = validateRatePeriod(clean)
  if (invalid) return { ok: false, error: invalid }

  const db = getDb()
  const ts = nowIso()
  const run = db.transaction((): Result<WhatnotRatePeriod[]> => {
    const existing = listRatePeriods()
    if (clean.id && !existing.some((p) => p.id === clean.id)) {
      return { ok: false, error: 'That rate period no longer exists.' }
    }
    const clash = overlappingRatePeriod(existing, clean, clean.id)
    if (clash) {
      return {
        ok: false,
        error:
          `That range overlaps ${spanLabel(clash)} at ${(clash.rate * 100).toFixed(2).replace(/\.?0+$/, '')}%. ` +
          `Two periods cannot both claim a day — a show's fee would depend on which one was read first. ` +
          `Narrow one of them, or edit the existing period instead.`
      }
    }

    if (clean.id) {
      db.prepare(
        `UPDATE whatnot_fee_periods
            SET from_date = @from, to_date = @to, rate = @rate, tax_rate = @tax,
                processing_rate = @proc, processing_flat_cents = @flat,
                note = @note, updated_at = @ts
          WHERE id = @id`
      ).run({
        id: clean.id,
        from: clean.fromDate,
        to: clean.toDate,
        rate: clean.rate,
        tax: clean.taxRate,
        proc: clean.processingRate,
        flat: clean.processingFlatCents,
        note: clean.note,
        ts
      })
    } else {
      db.prepare(
        `INSERT INTO whatnot_fee_periods
           (id, from_date, to_date, rate, tax_rate, processing_rate,
            processing_flat_cents, note, created_at, updated_at, created_by)
         VALUES (@id, @from, @to, @rate, @tax, @proc, @flat, @note, @ts, @ts, @by)`
      ).run({
        id: newId(),
        from: clean.fromDate,
        to: clean.toDate,
        rate: clean.rate,
        tax: clean.taxRate,
        proc: clean.processingRate,
        flat: clean.processingFlatCents,
        note: clean.note,
        ts,
        by: actorId
      })
    }
    return { ok: true, data: listRatePeriods() }
  })

  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

/**
 * Remove a period. The nights it covered fall back to whatever else covers them,
 * and to the contract's defaults if nothing does — which is a real change to the
 * P&L, so the caller is expected to confirm it first.
 */
export function deleteRatePeriod(id: string): Result<WhatnotRatePeriod[]> {
  const db = getDb()
  try {
    const info = db.prepare('DELETE FROM whatnot_fee_periods WHERE id = ?').run(String(id ?? '').trim())
    if (info.changes === 0) return { ok: false, error: 'That rate period no longer exists.' }
    return { ok: true, data: listRatePeriods() }
  } catch (err) {
    return fail(err)
  }
}

export { DEFAULT_FEE_RATES }
