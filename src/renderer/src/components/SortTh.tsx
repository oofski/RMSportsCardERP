import type { SortState } from '@shared/inventorySort'
import { Icon } from './Icon'

/**
 * A column header you can rank the table by.
 *
 * The arrow is always drawn, faint until the column is the one in use, because
 * an arrow that only appears on hover is a feature nobody finds. The whole
 * header is the button, so the target is the width of the column rather than a
 * 13px glyph.
 *
 * ## Why this lives in components/ rather than beside one table
 *
 * It was written for the on-hand Overview and then the owner asked for "the
 * sort buttons on the pricing tab like it is added on the inventory on hand
 * page" — LIKE, meaning the same control, not another one that resembles it.
 * Copying it would have been three lines shorter today and would have drifted
 * the first time either table's arrow, tooltip or alignment rule was touched;
 * two headers that sort differently are worse than one that sorts imperfectly.
 * The sorting itself is already shared — see @shared/inventorySort — so this is
 * the last piece that was not.
 */
export function SortTh({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left'
}: {
  label: string
  sortKey: string
  sort: SortState
  onSort: (key: string) => void
  align?: 'left' | 'center' | 'right'
}): JSX.Element {
  const active = sort.key === sortKey
  const dir = active ? sort.dir : null
  const arrow = (
    <Icon
      name={dir === 'asc' ? 'ChevronUp' : dir === 'desc' ? 'ChevronDown' : 'ChevronsUpDown'}
      size={13}
      className="sort-arrow"
    />
  )
  return (
    <th
      className={`sort-th sort-${align}${active ? ' sorted' : ''}`}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
    >
      <button
        type="button"
        className="sort-btn"
        onClick={() => onSort(sortKey)}
        title={
          active
            ? `Sorted by ${label}, ${dir === 'asc' ? 'lowest' : 'highest'} first — click to reverse`
            : `Sort by ${label}`
        }
      >
        {/* THE ARROW LEADS ON A MONEY COLUMN. Trailing it would push the
            heading left by its own width and the heading would stop lining up
            with the right-aligned figures under it — the same complaint the PO
            card headers drew, one column over. */}
        {align === 'right' && arrow}
        <span className="sort-label">{label}</span>
        {align !== 'right' && arrow}
      </button>
    </th>
  )
}
