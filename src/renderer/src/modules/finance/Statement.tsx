import { useState } from 'react'
import type { StreamDayFinance, StreamFinanceTotals } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Money, moneyText, plural } from './bits'
import { LedgerRows } from './LedgerRows'
import { PnlStatement } from './Pnl'

/**
 * The statement for whatever range is selected.
 *
 * ONE component now, where there used to be a day statement and a period
 * statement. They already wrapped the same `PnlStatement` over the same fields
 * — a week is not a different report from a day, it is the same fields summed —
 * and the only thing that differed was the header. Two of them was two chances
 * for a week to disagree with the days inside it about how to describe itself.
 *
 * The LEDGER ROWS appear only for a single day. That is a limit of the drill-in
 * rather than a design preference: rows are fetched by `streamDate`, so a
 * month's worth would be thousands of lines answering a question nobody asked
 * at that grain. Narrow to a day and they are there.
 */

/** The quiet marker on a total that includes rows which settled after the show.
 *  Deliberately unalarming: that is the CORRECT outcome, and the day's figures
 *  are only explainable once you know those rows are in them. */
export function CarriedMark({ rows, amount }: { rows: number; amount: number }): JSX.Element {
  return (
    <span
      className="fin-carry"
      title={`${plural(rows, 'row')} worth ${moneyText(
        amount
      )} settled after the show ended and were booked back to it — Whatnot posts shipping economics hours later.`}
    >
      <Icon name="Undo2" size={10} />
      {plural(rows, 'row')} settled later
      <Money value={amount} />
    </span>
  )
}

export function RangeStatement({
  totals,
  label,
  spanDays,
  day
}: {
  totals: StreamFinanceTotals
  /** How the range reads in words — "Jul 19 – Jul 27, 2026". */
  label: string
  /** Calendar days the range covers, or null for all time. Printed beside the
   *  days that actually had a show, because "6 days streamed" out of 9 and out
   *  of 90 are very different months. */
  spanDays: number | null
  /** The single day, when the range is exactly one — unlocks the ledger rows. */
  day: StreamDayFinance | null
}): JSX.Element {
  /**
   * CLOSED. The rows used to open with the day, on the reasoning that a day is
   * only ever opened deliberately so the read is cheap. It is — but a few
   * hundred rows below a statement is a long scroll past the thing that was
   * actually asked for, and the statement itself now opens closed too. One
   * click, and it remembers nothing between days on purpose: the rows are the
   * answer to a specific question about a specific day, not a mode.
   */
  const [rowsOpen, setRowsOpen] = useState(false)

  const quiet = totals.dayCount === 0

  return (
    <section className="fin-stmt" aria-label={`Profit and loss for ${label}`}>
      <header className="fin-stmt-head">
        <div className="fin-stmt-title">
          <h3>{label}</h3>
          <span className="fin-stmt-meta">
            {quiet ? (
              'No show landed in this range'
            ) : (
              <>
                {plural(totals.dayCount, 'day')} streamed
                {spanDays !== null && spanDays !== totals.dayCount && ` of ${spanDays}`}
                {' · '}
                {plural(totals.sessionCount, 'show')} · {formatDuration(totals.minutes)} on air ·{' '}
                {plural(totals.rowCount, 'ledger row')}
              </>
            )}
          </span>
          {day && day.sessionTitles.length > 0 && (
            <span className="fin-stmt-shows">
              {day.sessionTitles.map((t, i) => (
                <span className="fin-show-tag" key={`${t}-${i}`}>
                  <Icon name="CircleDot" size={10} />
                  {t}
                </span>
              ))}
            </span>
          )}
          {totals.carriedBackRows > 0 && (
            <CarriedMark rows={totals.carriedBackRows} amount={totals.carriedBackAmount} />
          )}
        </div>
      </header>

      {quiet ? (
        // Every figure would be zero, and a full statement of zeros invites the
        // reader to wonder which of them is a finding. None of them is.
        <p className="fin-detail-empty">
          <Icon name="Moon" size={14} />
          Nothing was streamed in this range, so there is no statement for it. Widen the range or
          pick a month with shows in it.
        </p>
      ) : (
        <PnlStatement money={totals} />
      )}

      {day && day.rowCount > 0 && (
        <div className="fin-stmt-rows">
          <button
            type="button"
            className="fin-more"
            aria-expanded={rowsOpen}
            onClick={() => setRowsOpen((v) => !v)}
          >
            <Icon name={rowsOpen ? 'ChevronUp' : 'ChevronDown'} size={14} />
            {rowsOpen
              ? 'Hide the ledger rows'
              : `Show the ${plural(day.rowCount, 'ledger row')} behind this day`}
          </button>
          {rowsOpen && <LedgerRows streamDate={day.streamDate} rowCount={day.rowCount} />}
        </div>
      )}
    </section>
  )
}
