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
  day,
  waiting,
  onReattribute,
  onPickDay
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
  /** Money inside this range that no logged show covers, per day. */
  waiting: UnattributedDay[]
  onReattribute: () => void | Promise<void>
  /** Narrow the whole screen to one waiting day. */
  onPickDay: (dayKey: string) => void
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
            ? 'No show is logged in this range, so none of the money below is on a day yet. Log it in Streaming and it lands here.'
            : 'Nothing was streamed in this range, so there is no statement for it. Widen the range or pick a month with shows in it.'}
        </p>
      ) : (
        <PnlStatement money={totals} />
      )}

      {waiting.length > 0 && (
        <WaitingPanel days={waiting} onReattribute={onReattribute} onPickDay={onPickDay} />
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

  return (
    <section className="fin-waiting" id="fin-unattributed">
      <div className="fin-waiting-head">
        <span className="fin-section-title">
          <Icon name="CalendarRange" size={14} />
          Waiting for a show
        </span>
        <span className="fin-waiting-figure">
          <Money value={amount} strong />
          <em>{plural(rows, 'row')}</em>
        </span>
        <span className="fin-waiting-acts">
          {can('module.streaming') && (
            <Button size="sm" icon="ArrowRight" onClick={() => navigate('streaming')}>
              Log the show
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon="RefreshCw"
            title="Re-check every stored row against the logged sessions. It only matches what a session already covers — it never moves money on its own."
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
