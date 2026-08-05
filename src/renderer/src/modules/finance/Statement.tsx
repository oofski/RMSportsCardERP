import { useState } from 'react'
import type {
  StreamDayFinance,
  StreamFinanceTotals,
  UnattributedDay
} from '@shared/financeStreaming'
import { bucketDef } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui'
import { useChrome } from '../../lib/chrome'
import { useSession } from '../../lib/session'
import { BucketChip, Money, moneyText, plural } from './bits'
import { shortDayLabel, timeLabel } from './time'
import { LedgerRows } from './LedgerRows'
import { PnlStatement } from './Pnl'
import type { DayRange } from './range'

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
  range,
  spanDays,
  day,
  waiting,
  onReattribute,
  onPickDay,
  onCosted
}: {
  totals: StreamFinanceTotals
  /** How the range reads in words — "Jul 19 – Jul 27, 2026". */
  label: string
  /** The same range as figures, so a click on one of them asks main for the
   *  records inside exactly this window rather than guessing at one. Null is
   *  all time. */
  range: DayRange | null
  /** Calendar days the range covers, or null for all time. Printed beside the
   *  days that actually had a show, because "6 days streamed" out of 9 and out
   *  of 90 are very different months. */
  spanDays: number | null
  /** The single day, when the range is exactly one — unlocks the ledger rows. */
  day: StreamDayFinance | null
  /** Money inside this range that no logged show covers, per day. */
  waiting: UnattributedDay[]
  onReattribute: () => void | Promise<void>
  /** Narrow the whole screen to one waiting day. */
  onPickDay: (dayKey: string) => void
  /** A cost was entered against one of the statement's uncosted stream lines;
   *  every figure on the page has moved and has to be re-read. Absent for a
   *  reader who may not write one. */
  onCosted?: () => void | Promise<void>
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
        //
        // But "nothing was streamed" is FALSE on a day holding unattributed
        // money — the ledger plainly earned on it, there is simply no session to
        // book it to, and telling the operator nothing happened while the panel
        // below shows $24,745.57 is the kind of contradiction that makes someone
        // stop trusting the screen.
        <p className="fin-detail-empty">
          <Icon name="Moon" size={14} />
          {waiting.length > 0
            ? 'No show is logged in this range. Log it in Streaming and this money lands on a day.'
            : 'Nothing streamed in this range. Widen it, or pick a month with shows.'}
        </p>
      ) : (
        <PnlStatement money={totals} range={range} rangeLabel={label} onCosted={onCosted} />
      )}

      <WaitingPanel days={waiting} onReattribute={onReattribute} onPickDay={onPickDay} />

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

/**
 * Money in this range that no logged show covers — ON THE DAY IT BELONGS TO.
 *
 * This replaced a panel that lived below the whole P&L: one total, a paragraph,
 * a row of bucket chips and a table of every burst across the entire ledger. The
 * figures were right and the shape was wrong — it answered "how much is
 * unmatched overall" while the operator was looking at a calendar of days,
 * leaving them to work out which days it meant. Selecting a day now brings its
 * own share with it.
 *
 * It is INFORMATION, not a failure, per the owner's instruction: a show that was
 * never in the schedule has nothing to attach to, so its money sitting here is
 * the system working. What it does carry is the two things you can act on — log
 * the show, then re-attribute.
 *
 * IT RENDERS EVEN WHEN NOTHING IS WAITING, reduced to a green line and the
 * Re-attribute button. Hiding the whole panel on `waiting.length === 0` made
 * the app's ONLY Re-attribute control disappear exactly when it was needed for
 * the other repair it performs: correcting a logged show's times leaves rows
 * attributed but on the wrong day or outside the new window, and nothing is
 * unattributed in that state — so the fix was on screen only while a different
 * problem happened to be present.
 */
function WaitingPanel({
  days,
  onReattribute,
  onPickDay
}: {
  days: UnattributedDay[]
  onReattribute: () => void | Promise<void>
  onPickDay: (dayKey: string) => void
}): JSX.Element {
  const { navigate } = useChrome()
  const { can } = useSession()

  const rows = days.reduce((n, d) => n + d.rowCount, 0)
  const amount = Math.round(days.reduce((n, d) => n + d.amount, 0) * 100) / 100
  // One day needs no date column and no per-day total: the heading figure IS
  // that day's figure, and repeating it beside itself reads as two numbers.
  const single = days.length === 1
  const clear = days.length === 0

  return (
    <section className={`fin-waiting${clear ? ' is-clear' : ''}`} id="fin-unattributed">
      <div className="fin-waiting-head">
        <span className="fin-section-title">
          <Icon name={clear ? 'CheckCircle2' : 'CalendarRange'} size={14} />
          {clear ? 'Every row is on a show' : 'Waiting for a show'}
        </span>
        {!clear && (
          <span className="fin-waiting-figure">
            <Money value={amount} strong />
            <em>{plural(rows, 'row')}</em>
          </span>
        )}
        <span className="fin-waiting-acts">
          {!clear && can('module.streaming') && (
            <Button size="sm" icon="ArrowRight" onClick={() => navigate('streaming')}>
              Log the show
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon="RefreshCw"
            title="Re-checks stored rows against logged sessions. Never moves money on its own."
            onClick={() => void onReattribute()}
          >
            Re-attribute
          </Button>
        </span>
      </div>

      {/* Over a range this lists every day in it, biggest first, and each row
          narrows the screen to that one day. At all-time that makes this the
          complete list of shows worth logging — so nothing is stranded in a
          month nobody thought to page to. */}
      {days.map((d) => (
        <button
          type="button"
          className={`fin-waiting-day${single ? ' is-single' : ''}`}
          key={d.localDate}
          onClick={() => onPickDay(d.localDate)}
          title={single ? undefined : `Show only ${shortDayLabel(d.localDate)}`}
        >
          {!single && <span className="fin-waiting-date">{shortDayLabel(d.localDate)}</span>}
          {/* The windows ARE the finding: a burst with a gap either side is what
              a show looks like in the ledger, so printing its hours is what makes
              "log the show" a two-minute job rather than a guess. */}
          <span className="fin-waiting-when">
            {d.windows.map((w) => (
              <span className="fin-waiting-window mono" key={w.from}>
                {timeLabel(w.from)}–{timeLabel(w.to)}
              </span>
            ))}
          </span>
          <span className="fin-waiting-buckets">
            {d.byBucket.map((b) => (
              <span className="fin-waiting-bucket" key={b.bucket}>
                <BucketChip bucket={b.bucket} />
                <Money value={b.amount} cost={bucketDef(b.bucket).treatment === 'expense'} />
              </span>
            ))}
          </span>
          {!single && <Money value={d.amount} strong />}
        </button>
      ))}
    </section>
  )
}
