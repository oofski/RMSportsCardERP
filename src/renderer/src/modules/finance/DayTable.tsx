import { useEffect, useMemo, useState } from 'react'
import type { LedgerRow, StreamDayFinance, StreamFinanceTotals } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { BucketChip, Money, plural } from './bits'
import { finance } from './api'
import { longDayLabel, shortDayLabel, timeLabel } from './time'

/** A day can carry several hundred rows; this is enough to scan and not enough
 *  to stall the render. The footer says when there are more. */
const DAY_ROW_LIMIT = 300

/** Anything below half a cent is zero — float sums arrive as -0 and 1e-13. */
const isZero = (n: number): boolean => Math.abs(n) < 0.005

/**
 * The day-by-day revenue table. One row per business day, newest first.
 *
 * This is a REVENUE view: cost of goods is not in it. The only costs here are
 * the ones the ledger itself charged for running the show — giveaway postage,
 * shipping charges, Show Boost — so "net revenue" means revenue after the
 * platform's own deductions, not profit. Stock consumed on air is shown inside
 * an expanded day, clearly marked as not counted.
 *
 * Days also carry rows that SETTLED after the show ended. That is the correct
 * outcome, and it is marked, because otherwise a show's shipping costs look
 * like they appeared out of nowhere the following afternoon and the operator
 * cannot explain their own numbers.
 */
export function DayTable({
  days,
  totals
}: {
  days: StreamDayFinance[]
  totals: StreamFinanceTotals
}): JSX.Element {
  // One day open at a time: expanding is how you read ONE day's ledger rows,
  // and two open lists a page apart is not a comparison anybody can make.
  const [open, setOpen] = useState<string | null>(null)

  // A column that is zero for every day in the export is noise — it costs a
  // fifth of the table's width to say nothing. It reappears the moment a single
  // day carries a value, and since it was zero everywhere, hiding it never
  // makes the arithmetic on screen stop adding up.
  const cols = useMemo(
    () => ({
      reversals: days.some((d) => !isZero(d.reversals)),
      refundShipping: days.some((d) => !isZero(d.refundShipping))
    }),
    [days]
  )

  const columnCount = 9 + (cols.reversals ? 1 : 0) + (cols.refundShipping ? 1 : 0)
  const anyCarried = days.some((d) => d.carriedBackRows > 0)

  return (
    <div className="fin-days">
      <div className="fin-table-wrap">
        <table className="fin-table">
          <thead>
            <tr>
              <th scope="col" className="fin-c-day">
                Day
              </th>
              <th scope="col" className="fin-c-shows">
                Shows
              </th>
              <th scope="col" className="fin-c-dur">
                On air
              </th>
              <th
                scope="col"
                className="fin-num"
                title="Seller earnings on sold items and break spots"
              >
                Sales
              </th>
              <th scope="col" className="fin-num" title="Whatnot's contribution toward postage">
                Shipping subsidy
              </th>
              <th scope="col" className="fin-num" title="Viewer tips and platform seller bonuses">
                Tips &amp; bonuses
              </th>
              {cols.reversals && (
                <th scope="col" className="fin-num" title="Refunded orders — revenue reversed">
                  Reversals
                </th>
              )}
              <th
                scope="col"
                className="fin-num"
                title="What it cost to mail giveaways won on stream"
              >
                Giveaway postage
              </th>
              <th
                scope="col"
                className="fin-num"
                title="Postage Whatnot charged back to the seller"
              >
                Shipping charges
              </th>
              {cols.refundShipping && (
                <th scope="col" className="fin-num" title="Postage cost on a refunded order">
                  Refund postage
                </th>
              )}
              <th scope="col" className="fin-num" title="Paid promotion of a show">
                Show Boost
              </th>
              <th
                scope="col"
                className="fin-num fin-c-net"
                title="Revenue after the costs to its left"
              >
                Net revenue
              </th>
            </tr>
          </thead>

          <tbody>
            {days.map((day) => (
              <DayRow
                key={day.streamDate}
                day={day}
                cols={cols}
                columnCount={columnCount}
                open={open === day.streamDate}
                onToggle={() => setOpen((cur) => (cur === day.streamDate ? null : day.streamDate))}
              />
            ))}
          </tbody>

          <tfoot>
            <tr>
              <th scope="row" className="fin-c-day">
                <span className="fin-foot-label">
                  {totals.dayCount} day{totals.dayCount === 1 ? '' : 's'}
                </span>
                {totals.carriedBackRows > 0 && (
                  <CarriedMark rows={totals.carriedBackRows} amount={totals.carriedBackAmount} />
                )}
              </th>
              <td className="fin-c-shows mono">{totals.sessionCount}</td>
              <td className="fin-c-dur mono">{formatDuration(totals.minutes)}</td>
              <td className="fin-num">
                <Money value={totals.sales} />
              </td>
              <td className="fin-num">
                <Money value={totals.shippingSubsidy} />
              </td>
              <td className="fin-num">
                <Money value={totals.tips + totals.bonuses} />
              </td>
              {cols.reversals && (
                <td className="fin-num">
                  <Money value={totals.reversals} />
                </td>
              )}
              <td className="fin-num">
                <Money value={totals.giveawayShipping} cost />
              </td>
              <td className="fin-num">
                <Money value={totals.shippingCharges} cost />
              </td>
              {cols.refundShipping && (
                <td className="fin-num">
                  <Money value={totals.refundShipping} cost />
                </td>
              )}
              <td className="fin-num">
                <Money value={totals.showBoost} cost />
              </td>
              <td className="fin-num fin-c-net">
                <Money value={totals.netRevenue} strong />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="fin-legend">
        <Icon name="Info" size={13} />
        Every row is booked to the day its show <b>started</b>, so a stream that runs past midnight
        counts entirely on the earlier date.
        {anyCarried && (
          <>
            {' '}
            Settlement rows — shipping subsidies, platform charges, giveaway postage, refunds, tips
            and bonuses — are booked to the show that caused them even when Whatnot posts them hours
            after it ended; those are marked <Icon name="Undo2" size={11} /> below the date. Sales
            are never carried back: a block of sales in a gap is a show nobody logged, not the
            aftermath of the last one.
          </>
        )}
      </p>
    </div>
  )
}

/** The quiet marker on a day whose totals include rows that settled later. */
function CarriedMark({ rows, amount }: { rows: number; amount: number }): JSX.Element {
  return (
    <span
      className="fin-carry"
      title={`${plural(rows, 'row')} worth ${formatMoney(
        amount
      )} settled after this show ended and were booked back to it — Whatnot posts shipping economics hours later.`}
    >
      <Icon name="Undo2" size={10} />
      {rows.toLocaleString()} settled later
      <Money value={amount} />
    </span>
  )
}

function DayRow({
  day,
  cols,
  columnCount,
  open,
  onToggle
}: {
  day: StreamDayFinance
  cols: { reversals: boolean; refundShipping: boolean }
  columnCount: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const titles = day.sessionTitles.join(' · ')

  return (
    <>
      <tr className={`fin-day-row${open ? ' is-open' : ''}`}>
        <th scope="row" className="fin-c-day">
          <button
            type="button"
            className="fin-day-toggle"
            onClick={onToggle}
            aria-expanded={open}
            title={`${open ? 'Hide' : 'Show'} the ledger rows for ${longDayLabel(day.streamDate)}`}
          >
            <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
            <span>{shortDayLabel(day.streamDate)}</span>
          </button>
          {day.carriedBackRows > 0 && (
            <CarriedMark rows={day.carriedBackRows} amount={day.carriedBackAmount} />
          )}
        </th>
        <td className="fin-c-shows mono" title={titles || 'No show titles recorded'}>
          {day.sessionCount}
        </td>
        <td className="fin-c-dur mono">{formatDuration(day.minutes)}</td>
        <td className="fin-num">
          <Money value={day.sales} dash />
        </td>
        <td className="fin-num">
          <Money value={day.shippingSubsidy} dash />
        </td>
        <td className="fin-num">
          <Money value={day.tips + day.bonuses} dash />
        </td>
        {cols.reversals && (
          <td className="fin-num">
            <Money value={day.reversals} dash />
          </td>
        )}
        <td className="fin-num">
          <Money value={day.giveawayShipping} cost dash />
        </td>
        <td className="fin-num">
          <Money value={day.shippingCharges} cost dash />
        </td>
        {cols.refundShipping && (
          <td className="fin-num">
            <Money value={day.refundShipping} cost dash />
          </td>
        )}
        <td className="fin-num">
          <Money value={day.showBoost} cost dash />
        </td>
        <td className="fin-num fin-c-net">
          <Money value={day.netRevenue} strong />
        </td>
      </tr>

      {open && (
        <tr className="fin-detail-row">
          <td colSpan={columnCount}>
            <DayDetail day={day} />
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * One day, opened up: which shows ran, what stock they consumed, and the ledger
 * rows themselves. The rows are fetched on expand rather than with the view — a
 * five-week export is thousands of rows and almost none are ever looked at.
 */
function DayDetail({ day }: { day: StreamDayFinance }): JSX.Element {
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.rows({ streamDate: day.streamDate, limit: DAY_ROW_LIMIT })
        if (alive) setRows(next)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Those rows could not be read.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [day.streamDate])

  const stockCost = day.breakCost + day.giveawayCost

  return (
    <div className="fin-detail">
      <div className="fin-detail-head">
        <span className="fin-detail-date">
          <Icon name="CalendarDays" size={14} />
          {longDayLabel(day.streamDate)}
        </span>
        {day.sessionTitles.length > 0 && (
          <span className="fin-detail-shows">
            {day.sessionTitles.map((t, i) => (
              <span className="fin-show-tag" key={`${t}-${i}`}>
                <Icon name="CircleDot" size={10} />
                {t}
              </span>
            ))}
          </span>
        )}
      </div>

      {!isZero(stockCost) && (
        <p className="fin-detail-stock">
          <Icon name="Layers" size={13} />
          Stock consumed on air that day cost <b>{formatMoney(stockCost)}</b> — breaks{' '}
          {formatMoney(day.breakCost)}, giveaways {formatMoney(day.giveawayCost)}.{' '}
          <em>Not in the net revenue above: cost of goods lands in the complete P&amp;L.</em>
        </p>
      )}

      {error ? (
        <p className="fin-detail-empty">
          <Icon name="AlertTriangle" size={14} />
          {error}
        </p>
      ) : loading ? (
        <p className="fin-detail-empty">
          <span className="spinner dark" />
          Reading this day&rsquo;s ledger rows…
        </p>
      ) : rows.length === 0 ? (
        <p className="fin-detail-empty">
          <Icon name="Info" size={14} />
          No ledger rows are stored against this day.
        </p>
      ) : (
        <>
          <ul className="fin-rows">
            {rows.map((row) => (
              <li className="fin-row" key={row.id}>
                <span className="fin-row-time mono">{timeLabel(row.occurredAt)}</span>
                <BucketChip bucket={row.bucket} />
                {row.attribution === 'carried_back' && (
                  <span
                    className="fin-row-carry"
                    title="This settled after the show ended and was booked back to it. Expected for shipping and adjustment rows."
                  >
                    <Icon name="Undo2" size={10} />
                    settled later
                  </span>
                )}
                <span className="fin-row-msg" title={row.message}>
                  {row.message}
                </span>
                {row.breakNumber !== null && (
                  <span className="fin-row-break">
                    <Icon name="Hash" size={10} />
                    Break {row.breakNumber}
                  </span>
                )}
                {row.repaired && (
                  <span
                    className="fin-row-flag"
                    title="This row was exported malformed and was stitched back together on import."
                  >
                    repaired
                  </span>
                )}
                <Money value={row.amount} />
              </li>
            ))}
          </ul>
          <p className="fin-detail-foot">
            Showing {rows.length.toLocaleString()} of {plural(day.rowCount, 'row')} on this day
            {rows.length < day.rowCount ? ' — the rest are stored but not listed here.' : '.'}
          </p>
        </>
      )}
    </div>
  )
}
