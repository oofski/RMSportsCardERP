import { useEffect, useMemo, useState } from 'react'
import type {
  FinancePeriod,
  LedgerRow,
  StreamDayFinance,
  StreamFinanceTotals,
  StreamingFinanceView
} from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { BucketChip, Money, plural } from './bits'
import { finance } from './api'
import { compactDayLabel, longDayLabel, shortDayLabel, timeLabel } from './time'

/** A day can carry several hundred rows; this is enough to scan and not enough
 *  to stall the render. The footer says when there are more. */
const DAY_ROW_LIMIT = 300

/** Anything below half a cent is zero — float sums arrive as -0 and 1e-13. */
const isZero = (n: number): boolean => Math.abs(n) < 0.005

/** The money every row carries, whatever grain it is at. Days, weeks and months
 *  are the same P&L; only the grouping changes, so the table is written once. */
type FinanceMoney = Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>

interface FinanceRow extends FinanceMoney {
  key: string
  label: string
  /**
   * Non-null only on a day row, and that is what makes the row expandable. A
   * week has no single business day to open, and pulling a week of ledger rows
   * would be thousands of lines that answer a question nobody asked at that
   * grain — you drill into a day, not into July.
   */
  streamDate: string | null
  sessionTitles: string[]
  /** "Jul 20 – Jul 26 · 7 days". Null on a day row, where it would only repeat
   *  the label. */
  span: string | null
}

function buildRows(view: StreamingFinanceView, period: FinancePeriod): FinanceRow[] {
  if (period === 'day') {
    const days = Array.isArray(view.days) ? view.days : []
    return days.map((d) => ({
      ...d,
      key: d.streamDate,
      label: shortDayLabel(d.streamDate),
      streamDate: d.streamDate,
      span: null
    }))
  }

  // Main ships separately from the renderer — `financeReady` in api.ts exists
  // for exactly that skew. A main that predates the period rollup returns a view
  // with no `weeks`, and reading `.map` off undefined would blank the whole tab
  // rather than degrade to an empty week list.
  const src = period === 'week' ? view.weeks : view.months
  const rows = Array.isArray(src) ? src : []
  return rows.map((p) => ({
    ...p,
    streamDate: null,
    sessionTitles: [],
    span: `${compactDayLabel(p.from)} – ${compactDayLabel(p.to)} · ${plural(p.dayCount, 'day')}`
  }))
}

/** Postage out, as one figure. The three ledger buckets behind it are different
 *  events but the same cash movement, and they are itemised in the tooltip and
 *  in the expanded day rather than costing three columns of a table that is
 *  already wider than the window. */
function postageOut(row: FinanceMoney): number {
  return row.shippingCharges + row.giveawayShipping + row.refundShipping
}

function postageTitle(row: FinanceMoney): string {
  const parts: string[] = []
  if (!isZero(row.shippingCharges)) parts.push(`platform charges ${formatMoney(row.shippingCharges)}`)
  if (!isZero(row.giveawayShipping)) parts.push(`giveaway postage ${formatMoney(row.giveawayShipping)}`)
  if (!isZero(row.refundShipping)) parts.push(`refund postage ${formatMoney(row.refundShipping)}`)
  return parts.length > 0 ? `Postage out — ${parts.join(', ')}` : 'No postage charged'
}

/**
 * The streaming P&L, one row per day, week or month.
 *
 * The columns are laid out as the owner states the model, left to right:
 *
 *   Total revenue  −  Whatnot 6%  −  processing  =  Net revenue
 *   Shipping, on its own
 *   −  show costs  =  Net after costs
 *
 * Shipping is deliberately NOT folded into the fee stack. A subsidy is money in
 * and postage is money out; netting them against a commission would make both
 * unreadable and would hide the one number the operator can actually act on —
 * whether shipping is running at a profit or a loss.
 *
 * This is still a REVENUE view: cost of goods is not in it. The only costs here
 * are the ones the ledger itself charged for running the show. Stock consumed on
 * air is shown inside an expanded day, marked as not counted.
 *
 * Day rows also carry rows that SETTLED after the show ended. That is the
 * correct outcome, and it is marked, because otherwise a show's shipping costs
 * look like they appeared out of nowhere the following afternoon.
 */
export function FinanceTable({
  view,
  period,
  totals
}: {
  view: StreamingFinanceView
  period: FinancePeriod
  totals: StreamFinanceTotals
}): JSX.Element {
  // One row open at a time: expanding is how you read ONE day's ledger rows, and
  // two open lists a page apart is not a comparison anybody can make.
  const [open, setOpen] = useState<string | null>(null)

  const rows = useMemo(() => buildRows(view, period), [view, period])

  // A column that is zero for every row in the export is noise — it costs a
  // slice of a table that already scrolls, to say nothing. It reappears the
  // moment a single row carries a value, and since it was zero everywhere,
  // hiding it never makes the arithmetic on screen stop adding up.
  const cols = useMemo(
    () => ({
      extras: rows.some((r) => !isZero(r.tips) || !isZero(r.bonuses)),
      showBoost: rows.some((r) => !isZero(r.showBoost)),
      reversals: rows.some((r) => !isZero(r.reversals))
    }),
    [rows]
  )

  const revenueSpan = cols.extras ? 3 : 2
  const costSpan = 1 + (cols.showBoost ? 1 : 0) + (cols.reversals ? 1 : 0)
  const columnCount = 1 + revenueSpan + 3 + 3 + costSpan
  const anyCarried = rows.some((r) => r.carriedBackRows > 0)

  const grain = period === 'day' ? 'Day' : period === 'week' ? 'Week' : 'Month'
  // With both cost columns hidden the group is nothing but its own result, and
  // heading a lone total "− Show costs" would claim a subtraction that did not
  // happen. Naming it for what it is keeps the header honest.
  const costGroup = costSpan > 1 ? 'Show costs' : 'Bottom line'

  return (
    <div className="fin-days">
      <div className="fin-table-wrap">
        <table className="fin-table">
          <thead>
            {/* The group row is what makes the fee stack read as a subtraction
                rather than as five unrelated money columns. */}
            <tr className="fin-grp-row">
              <th scope="col" rowSpan={2} className="fin-c-day">
                {grain}
              </th>
              <th scope="colgroup" colSpan={revenueSpan} className="fin-grp fin-edge">
                Revenue in
              </th>
              <th scope="colgroup" colSpan={3} className="fin-grp fin-edge">
                <span aria-hidden="true">− </span>Whatnot&rsquo;s cut
              </th>
              <th scope="colgroup" colSpan={3} className="fin-grp fin-edge">
                Shipping, on its own
              </th>
              <th scope="colgroup" colSpan={costSpan} className="fin-grp">
                {costSpan > 1 && <span aria-hidden="true">− </span>}
                {costGroup}
              </th>
            </tr>
            <tr>
              <th scope="col" className="fin-num" title="Gross seller earnings on sold items and break spots, before Whatnot takes anything">
                Sales
              </th>
              {cols.extras && (
                <th scope="col" className="fin-num" title="Viewer tips and platform seller bonuses — these arrive whole, with no fee taken">
                  Tips &amp; bonuses
                </th>
              )}
              <th scope="col" className="fin-num fin-edge" title="Sales plus tips and bonuses. The top line, before any deduction.">
                Total revenue
              </th>

              <th scope="col" className="fin-num" title="Whatnot's 6% commission on sales">
                Whatnot 6%
              </th>
              <th scope="col" className="fin-num" title="2.9% of sales plus 30¢ on every transaction — the flat part is why a show that sells many small spots pays more than 8.9%">
                Processing
              </th>
              <th scope="col" className="fin-num fin-edge" title="Total revenue less both fees. What Whatnot actually keeps for you.">
                <span aria-hidden="true">= </span>Net revenue
              </th>

              <th scope="col" className="fin-num" title="Whatnot's contribution toward postage — money in">
                Subsidy in
              </th>
              <th scope="col" className="fin-num" title="Platform shipping charges, giveaway postage and refund postage — money out">
                Postage out
              </th>
              <th scope="col" className="fin-num fin-edge" title="Subsidy less all postage. Either side of zero: it says whether shipping paid for itself.">
                <span aria-hidden="true">= </span>Net shipping
              </th>

              {cols.showBoost && (
                <th scope="col" className="fin-num" title="Paid promotion of a show">
                  Show Boost
                </th>
              )}
              {cols.reversals && (
                <th scope="col" className="fin-num" title="Refunded orders — revenue reversed">
                  Reversals
                </th>
              )}
              <th scope="col" className="fin-num fin-c-net" title="Net revenue, plus net shipping, less show costs. The bottom line before cost of goods.">
                <span aria-hidden="true">= </span>Net after costs
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row) => (
              <TableRow
                key={row.key}
                row={row}
                cols={cols}
                columnCount={columnCount}
                open={open === row.key}
                onToggle={() => setOpen((cur) => (cur === row.key ? null : row.key))}
              />
            ))}
          </tbody>

          <tfoot>
            <tr>
              <th scope="row" className="fin-c-day">
                <span className="fin-foot-label">
                  All {plural(totals.dayCount, 'day')}
                </span>
                <span className="fin-row-meta">
                  {plural(totals.sessionCount, 'show')} · {formatDuration(totals.minutes)}
                </span>
                {totals.carriedBackRows > 0 && (
                  <CarriedMark rows={totals.carriedBackRows} amount={totals.carriedBackAmount} />
                )}
              </th>
              <MoneyCells row={totals} cols={cols} />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="fin-legend">
        <Icon name="Info" size={13} />
        Every row is booked to the day its show <b>started</b>, so a stream that runs past midnight
        counts entirely on the earlier date. Weeks and months are sums of those days, so a period can
        never disagree with the days inside it.
        {anyCarried && (
          <>
            {' '}
            Settlement rows — shipping subsidies, platform charges, giveaway postage, refunds, tips
            and bonuses — are booked to the show that caused them even when Whatnot posts them hours
            after it ended; those are marked <Icon name="Undo2" size={11} /> below the label. Sales
            are never carried back: a block of sales in a gap is a show nobody logged, not the
            aftermath of the last one.
          </>
        )}
      </p>
    </div>
  )
}

/**
 * Every money cell of one row, in P&L order. Shared by the body and the footer
 * so a total can never be built from a different column list than the rows above
 * it — the failure mode there is a footer that silently does not add up.
 */
function MoneyCells({
  row,
  cols,
  dash = false
}: {
  row: FinanceMoney
  cols: { extras: boolean; showBoost: boolean; reversals: boolean }
  /** Body rows print an em dash for an empty bucket; a footer zero is a real
   *  answer and prints as $0.00. */
  dash?: boolean
}): JSX.Element {
  return (
    <>
      <td className="fin-num">
        <Money value={row.sales} dash={dash} />
      </td>
      {cols.extras && (
        <td className="fin-num">
          <Money value={row.tips + row.bonuses} dash={dash} />
        </td>
      )}
      <td className="fin-num fin-edge">
        <Money value={row.totalRevenue} strong dash={dash} />
      </td>

      {/* The fee fields arrive NEGATIVE from the contract. They are printed as
          they are stored — negating them here would flip a deduction into
          income the first time somebody changed the sign upstream. */}
      <td className="fin-num">
        <Money value={row.whatnotFee} dash={dash} />
      </td>
      <td className="fin-num">
        <Money value={row.processingFee} dash={dash} />
      </td>
      <td className="fin-num fin-edge">
        <Money value={row.netRevenue} strong dash={dash} />
      </td>

      <td className="fin-num">
        <Money value={row.shippingSubsidy} dash={dash} />
      </td>
      <td className="fin-num">
        <Money value={postageOut(row)} cost dash={dash} title={postageTitle(row)} />
      </td>
      <td className="fin-num fin-edge">
        <Money
          value={row.netShipping}
          strong
          dash={dash}
          title="Subsidy in less all postage out. Positive means shipping paid for itself."
        />
      </td>

      {cols.showBoost && (
        <td className="fin-num">
          <Money value={row.showBoost} cost dash={dash} />
        </td>
      )}
      {cols.reversals && (
        <td className="fin-num">
          <Money value={row.reversals} cost dash={dash} />
        </td>
      )}
      <td className="fin-num fin-c-net">
        <Money value={row.netAfterCosts} strong dash={dash} />
      </td>
    </>
  )
}

/** The quiet marker on a row whose totals include rows that settled later. */
function CarriedMark({ rows, amount }: { rows: number; amount: number }): JSX.Element {
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

function TableRow({
  row,
  cols,
  columnCount,
  open,
  onToggle
}: {
  row: FinanceRow
  cols: { extras: boolean; showBoost: boolean; reversals: boolean }
  columnCount: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const titles = row.sessionTitles.join(' · ')
  const meta = `${plural(row.sessionCount, 'show')} · ${formatDuration(row.minutes)}`

  return (
    <>
      <tr className={`fin-day-row${open ? ' is-open' : ''}`}>
        {/* Shows and time on air live in the pinned label cell rather than in
            columns of their own: they are the context you want to keep seeing
            while the money columns scroll sideways under them. */}
        <th scope="row" className="fin-c-day">
          {row.streamDate ? (
            <button
              type="button"
              className="fin-day-toggle"
              onClick={onToggle}
              aria-expanded={open}
              title={`${open ? 'Hide' : 'Show'} the ledger rows for ${longDayLabel(row.streamDate)}`}
            >
              <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={14} />
              <span>{row.label}</span>
            </button>
          ) : (
            <span className="fin-period-label">{row.label}</span>
          )}
          {row.span && <span className="fin-row-meta">{row.span}</span>}
          <span className="fin-row-meta" title={titles || undefined}>
            {meta}
          </span>
          {row.carriedBackRows > 0 && (
            <CarriedMark rows={row.carriedBackRows} amount={row.carriedBackAmount} />
          )}
        </th>
        <MoneyCells row={row} cols={cols} dash />
      </tr>

      {open && row.streamDate && (
        <tr className="fin-detail-row">
          <td colSpan={columnCount}>
            <DayDetail row={row} streamDate={row.streamDate} />
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
function DayDetail({ row, streamDate }: { row: FinanceRow; streamDate: string }): JSX.Element {
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const next = await finance.rows({ streamDate, limit: DAY_ROW_LIMIT })
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
  }, [streamDate])

  const stockCost = row.breakCost + row.giveawayCost

  return (
    <div className="fin-detail">
      <div className="fin-detail-head">
        <span className="fin-detail-date">
          <Icon name="CalendarDays" size={14} />
          {longDayLabel(streamDate)}
        </span>
        {row.sessionTitles.length > 0 && (
          <span className="fin-detail-shows">
            {row.sessionTitles.map((t, i) => (
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
          {formatMoney(row.breakCost)}, giveaways {formatMoney(row.giveawayCost)}.{' '}
          <em>Not in any figure above: cost of goods lands in the complete P&amp;L.</em>
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
            {rows.map((r) => (
              <li className="fin-row" key={r.id}>
                <span className="fin-row-time mono">{timeLabel(r.occurredAt)}</span>
                <BucketChip bucket={r.bucket} />
                {r.attribution === 'carried_back' && (
                  <span
                    className="fin-row-carry"
                    title="This settled after the show ended and was booked back to it. Expected for shipping and adjustment rows."
                  >
                    <Icon name="Undo2" size={10} />
                    settled later
                  </span>
                )}
                <span className="fin-row-msg" title={r.message}>
                  {r.message}
                </span>
                {r.breakNumber !== null && (
                  <span className="fin-row-break">
                    <Icon name="Hash" size={10} />
                    Break {r.breakNumber}
                  </span>
                )}
                {r.repaired && (
                  <span
                    className="fin-row-flag"
                    title="This row was exported malformed and was stitched back together on import."
                  >
                    repaired
                  </span>
                )}
                <Money value={r.amount} />
              </li>
            ))}
          </ul>
          <p className="fin-detail-foot">
            Showing {rows.length.toLocaleString()} of {plural(row.rowCount, 'row')} on this day
            {rows.length < row.rowCount ? ' — the rest are stored but not listed here.' : '.'}
          </p>
        </>
      )}
    </div>
  )
}
