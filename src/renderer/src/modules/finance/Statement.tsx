import { useState } from 'react'
import type { FinancePeriodRow, StreamDayFinance } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { Money, plural } from './bits'
import { LedgerRows } from './LedgerRows'
import { PnlStatement } from './Pnl'
import { compactDayLabel, longDayLabel } from './time'

/**
 * A day, or a period, opened up.
 *
 * Both wrap the SAME `PnlStatement`. A week is not a different report from a
 * day — `view.weeks` carries byte-for-byte the same fields, summed — so the only
 * thing that differs is the header above it and whether there are ledger rows
 * underneath to drill into. Writing the statement twice would be two chances for
 * a week to disagree with the days inside it.
 */

/** The quiet marker on a total that includes rows which settled after the show.
 *  Deliberately unalarming: that is the CORRECT outcome, and the day's figures
 *  are only explainable once you know those rows are in them. */
export function CarriedMark({ rows, amount }: { rows: number; amount: number }): JSX.Element {
  return (
    <span
      className="fin-carry"
      title={`${plural(rows, 'row')} worth ${formatMoney(
        amount
      )} settled after the show ended and were booked back to it — Whatnot posts shipping economics hours later.`}
    >
      <Icon name="Undo2" size={10} />
      {rows.toLocaleString()} settled later
      <Money value={amount} />
    </span>
  )
}

export function DayStatement({
  day,
  onClose
}: {
  day: StreamDayFinance
  onClose: () => void
}): JSX.Element {
  // Closed by default. The statement is the answer; the rows are the evidence,
  // and pulling several hundred of them for every day anyone glances at would
  // make the calendar feel broken.
  const [rowsOpen, setRowsOpen] = useState(false)

  return (
    <section className="fin-stmt" aria-label={`Profit and loss for ${longDayLabel(day.streamDate)}`}>
      <header className="fin-stmt-head">
        <div className="fin-stmt-title">
          <h3>
            <Icon name="CalendarDays" size={15} />
            {longDayLabel(day.streamDate)}
          </h3>
          <span className="fin-stmt-meta">
            {plural(day.sessionCount, 'show')} · {formatDuration(day.minutes)} on air ·{' '}
            {plural(day.rowCount, 'ledger row')}
          </span>
          {day.sessionTitles.length > 0 && (
            <span className="fin-stmt-shows">
              {day.sessionTitles.map((t, i) => (
                <span className="fin-show-tag" key={`${t}-${i}`}>
                  <Icon name="CircleDot" size={10} />
                  {t}
                </span>
              ))}
            </span>
          )}
          {day.carriedBackRows > 0 && (
            <CarriedMark rows={day.carriedBackRows} amount={day.carriedBackAmount} />
          )}
        </div>
        <button type="button" className="fin-stmt-close" onClick={onClose} aria-label="Close this day">
          <Icon name="X" size={16} />
        </button>
      </header>

      <PnlStatement money={day} />

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
    </section>
  )
}

/**
 * A week or a month. No ledger drill-down: you drill into a day, not into July.
 * A month of rows is thousands of lines answering a question nobody asked at
 * that grain, and the days it is made of are one click away in the calendar.
 */
export function PeriodStatement({ row }: { row: FinancePeriodRow }): JSX.Element {
  return (
    <section className="fin-stmt is-period" aria-label={`Profit and loss for ${row.label}`}>
      <header className="fin-stmt-head">
        <div className="fin-stmt-title">
          <h3>
            <Icon name="CalendarRange" size={15} />
            {row.label}
          </h3>
          <span className="fin-stmt-meta">
            {compactDayLabel(row.from)} – {compactDayLabel(row.to)} ·{' '}
            {plural(row.dayCount, 'day')} streamed · {plural(row.sessionCount, 'show')} ·{' '}
            {formatDuration(row.minutes)} on air
          </span>
          {row.carriedBackRows > 0 && (
            <CarriedMark rows={row.carriedBackRows} amount={row.carriedBackAmount} />
          )}
        </div>
      </header>

      <PnlStatement money={row} />
    </section>
  )
}
