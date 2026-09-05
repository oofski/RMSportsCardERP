import { PRICE_BANDS } from '@shared/priceBands'

/**
 * "Show me the cheap ones" as a row of chips.
 *
 * ## One selected at a time, and clicking it again clears it
 *
 * Multi-select was the other option and it is the wrong one here: the bands
 * tile the number line, so "under $100 OR $500–$1,999" is a question nobody
 * standing at this screen has ever asked, and offering it would mean every
 * chip needs a tick box and the row stops reading at a glance. One band is a
 * range; two bands with a hole in the middle is a report.
 *
 * The selected chip toggles OFF when clicked again, which is the only way back
 * to the full list that does not need a separate Clear button sitting there
 * doing nothing most of the time.
 *
 * ## The counts are the point
 *
 * A chip that says "Unpriced 14" answers the question before it is clicked, and
 * on a pricing screen that number IS the work queue. They are counted over the
 * rows the other filters have already narrowed — see countByPriceBand — so a
 * chip never promises more than a click delivers.
 *
 * A band with nothing in it is drawn disabled rather than hidden: a row of
 * chips that changes length as you type is one whose buttons move under the
 * cursor, and the fact that a band is empty is itself worth seeing.
 */
export function PriceBandChips({
  value,
  counts,
  onChange,
  label = 'Price'
}: {
  /** The selected band id, or null for "all". */
  value: string | null
  /** Band id → how many rows it would show. See countByPriceBand. */
  counts: Record<string, number>
  onChange: (bandId: string | null) => void
  label?: string
}): JSX.Element {
  return (
    <div className="band-chips" role="group" aria-label={`${label} filter`}>
      <span className="band-chips-label">{label}</span>
      {PRICE_BANDS.map((band) => {
        const n = counts[band.id] ?? 0
        const on = value === band.id
        return (
          <button
            key={band.id}
            type="button"
            className={`band-chip${on ? ' is-on' : ''}`}
            aria-pressed={on}
            // Never disable the chip that is currently ON. Filtering down to a
            // band and then having its own count fall to zero — which happens
            // the moment somebody types in the search box — would leave the
            // only way back to the full list greyed out.
            disabled={n === 0 && !on}
            title={
              on
                ? `Showing ${band.label} only — click to clear`
                : `Show ${band.label} (${n})`
            }
            onClick={() => onChange(on ? null : band.id)}
          >
            {band.label}
            <span className="band-chip-n">{n}</span>
          </button>
        )
      })}
    </div>
  )
}
