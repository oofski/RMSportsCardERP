import type { FinancePeriod, FinancePeriodRow } from '@shared/financeStreaming'
import { formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { Money, Profit, plural } from './bits'
import { PeriodStatement } from './Statement'
import { compactDayLabel } from './time'

/**
 * Weeks and months, as a list that opens into the same statement.
 *
 * NO CALENDAR HERE, deliberately. A calendar's job is to put a figure where the
 * eye already expects that date to be; a week has no cell on any grid, and
 * drawing four boxes in a row would be a calendar in shape only. A list is
 * honest about what these are — periods, in order, each one openable.
 *
 * The bottom line sits on the closed row, so the list answers "which week was
 * bad" without opening anything. Revenue and net profit are two fixed columns
 * rather than two labelled clumps, so every row's figures land on the same two
 * right edges and the column can be read straight down.
 *
 * WHICH ROW IS OPEN IS A PROP. It used to be state in here, which meant a trip
 * through Calendar and back closed whatever you had been reading.
 */
export function PeriodList({
  rows,
  period,
  open,
  onOpen
}: {
  rows: FinancePeriodRow[]
  period: FinancePeriod
  /** One open at a time. Two statements a page apart is not a comparison
   *  anybody can actually make, and the closed rows already carry the figure
   *  you would be comparing. */
  open: string | null
  onOpen: (key: string | null) => void
}): JSX.Element {
  return (
    <div className="fin-plist">
      <div className="fin-plist-legend" aria-hidden="true">
        <span className="fin-plist-figs">
          <span className="fin-plist-rev">Revenue</span>
          <span className="fin-plist-net">Net profit</span>
        </span>
      </div>

      {rows.map((row) => {
        const isOpen = open === row.key
        const net = Number.isFinite(row.netProfit) ? row.netProfit : 0
        return (
          <div className={`fin-plist-item${isOpen ? ' is-open' : ''}`} key={row.key}>
            <button
              type="button"
              className="fin-plist-row"
              aria-expanded={isOpen}
              onClick={() => onOpen(isOpen ? null : row.key)}
            >
              <Icon name={isOpen ? 'ChevronDown' : 'ChevronRight'} size={15} />
              <span className="fin-plist-main">
                <b>{row.label}</b>
                <em>
                  {compactDayLabel(row.from)} – {compactDayLabel(row.to)} ·{' '}
                  {plural(row.dayCount, 'day')} · {plural(row.sessionCount, 'show')} ·{' '}
                  {formatDuration(row.minutes)}
                </em>
              </span>
              <span className="fin-plist-figs">
                <span className="fin-plist-rev">
                  <Money value={row.totalRevenue} strong />
                </span>
                <span className="fin-plist-net">
                  <Profit value={net} />
                </span>
              </span>
            </button>

            {isOpen && (
              <div className="fin-plist-body">
                <PeriodStatement row={row} />
              </div>
            )}
          </div>
        )
      })}

      <p className="fin-legend">
        <Icon name="Info" size={13} />
        Every {period === 'week' ? 'week' : 'month'} is the sum of the days inside it, and each day
        is booked to the date its show <b>started</b> — so a stream that ran past midnight counts
        entirely on the earlier date. A period can never disagree with its days, because it is
        nothing but their total.
      </p>
    </div>
  )
}
