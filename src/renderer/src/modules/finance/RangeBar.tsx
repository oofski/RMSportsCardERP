import type { FinancePeriodRow } from '@shared/financeStreaming'
import { Icon } from '../../components/Icon'
import { type DayRange, RANGE_PRESETS, activePreset } from './range'
import { dayRangeLabel } from './time'

/**
 * The one control that decides what every figure on this screen is about.
 *
 * It replaced the Calendar / Week / Month grain switch. That switch changed
 * WHICH LIST was on screen and left the headline figures describing the entire
 * ledger regardless — so "Week" showed weekly rows under an all-time total, and
 * the operator had to hold in their head which number answered which question.
 * Nothing was lost in dropping it: the weeks and months it used to list are the
 * two dropdowns here, and picking one sets the range, which moves the widgets,
 * the calendar highlight and the statement together.
 *
 * "All time" is the null range and is always reachable — every other control
 * here narrows, and a narrowing control with no way back is a trap.
 */
export function RangeBar({
  range,
  weeks,
  months,
  onRange
}: {
  range: DayRange | null
  weeks: FinancePeriodRow[]
  months: FinancePeriodRow[]
  onRange: (range: DayRange | null) => void
}): JSX.Element {
  const preset = activePreset(range)

  // Newest first. An operator opening a period dropdown is nearly always after
  // the most recent one, and a list that starts in January makes them scroll
  // past a year of history to reach it.
  const weekOpts = [...weeks].reverse()
  const monthOpts = [...months].reverse()

  /** The key a period select shows as chosen, so the two dropdowns reflect the
   *  range rather than remembering their own selection and drifting out of step
   *  with the calendar the moment anyone clicks a day. */
  const matching = (rows: FinancePeriodRow[]): string =>
    (range && rows.find((r) => r.from === range.from && r.to === range.to)?.key) || ''

  return (
    <div className="fin-rangebar" role="group" aria-label="Reporting period">
      <button
        type="button"
        className={`fin-range-btn${range === null ? ' is-on' : ''}`}
        aria-pressed={range === null}
        onClick={() => onRange(null)}
      >
        All time
      </button>

      {RANGE_PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          className={`fin-range-btn${preset === p.key ? ' is-on' : ''}`}
          aria-pressed={preset === p.key}
          title={p.hint}
          onClick={() => onRange(p.build())}
        >
          {p.label}
        </button>
      ))}

      <PeriodSelect
        label="Week"
        rows={weekOpts}
        value={matching(weeks)}
        onPick={(row) => onRange({ from: row.from, to: row.to })}
      />
      <PeriodSelect
        label="Month"
        rows={monthOpts}
        value={matching(months)}
        onPick={(row) => onRange({ from: row.from, to: row.to })}
      />

      <span className="fin-range-now">
        <Icon name="CalendarRange" size={13} />
        {range ? dayRangeLabel(range.from, range.to) : 'Everything imported'}
        {range && (
          <button
            type="button"
            className="fin-range-clear"
            onClick={() => onRange(null)}
            aria-label="Clear the range and show all time"
          >
            <Icon name="X" size={12} />
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * The weeks and months, as a native select.
 *
 * Native because this list is as long as the ledger is old — a custom menu
 * would need its own scrolling, keyboard handling and type-ahead to match what
 * the platform already does, and none of that is the interesting part of this
 * screen. It renders nothing at all when the rollup is empty rather than
 * offering a dropdown with one placeholder in it.
 */
function PeriodSelect({
  label,
  rows,
  value,
  onPick
}: {
  label: string
  rows: FinancePeriodRow[]
  value: string
  onPick: (row: FinancePeriodRow) => void
}): JSX.Element | null {
  if (rows.length === 0) return null

  return (
    <label className={`fin-range-select${value ? ' is-on' : ''}`}>
      <span className="fin-sr">Jump to a {label.toLowerCase()}</span>
      <select
        value={value}
        onChange={(e) => {
          const row = rows.find((r) => r.key === e.target.value)
          if (row) onPick(row)
        }}
      >
        <option value="">{label}</option>
        {rows.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
      <Icon name="ChevronDown" size={13} />
    </label>
  )
}
