import { useEffect, useState } from 'react'
import type { ScanDirection } from '@shared/types'
import { LOCATIONS } from '@shared/inventory'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { CategoryLogo } from './CategoryLogo'
import { queueTotals, type PendingLine } from './scanLines'

/**
 * The pending list: what the next confirmation will do, one row per item.
 *
 * Scanning the same box five times lands on ONE row whose count says 5 — the
 * operator watches the number, not the product name, so the count is the
 * loudest thing on the row and sits in the same place on every row. It is a
 * plain input, not a read-out: a miscount is fixed by typing over it, never by
 * rescanning or by starting again.
 *
 * Nothing here writes. Confirm hands each line back to ScanStation, which
 * commits it through the one existing commit path.
 */
export function ScanQueue({
  lines,
  direction,
  busy,
  onQuantity,
  onLocation,
  onUnitCost,
  onRemove,
  onClear,
  onConfirm
}: {
  lines: PendingLine[]
  direction: ScanDirection
  busy: boolean
  onQuantity: (key: string, quantity: number) => void
  onLocation: (key: string, location: string) => void
  onUnitCost: (key: string, unitCost: number | null) => void
  onRemove: (key: string) => void
  onClear: () => void
  onConfirm: () => void
}): JSX.Element {
  const totals = queueTotals(lines)
  const out = direction === 'out'
  return (
    <div className={`scan-result scan-queue scan-queue-${direction}`}>
      <div className="scan-hist-head scan-queue-head">
        <Icon name={out ? 'PackageMinus' : 'PackagePlus'} size={15} />
        <span className="scan-queue-title">{out ? 'Going out' : 'Coming in'}</span>
        <span className="scan-chip scan-chip-brand" style={{ marginLeft: 'auto' }}>
          {totals.units} unit{totals.units === 1 ? '' : 's'} · {totals.lines} item
          {totals.lines === 1 ? '' : 's'}
        </span>
      </div>

      {lines.map((line) => (
        <QueueRow
          key={line.key}
          line={line}
          busy={busy}
          onQuantity={onQuantity}
          onLocation={onLocation}
          onUnitCost={onUnitCost}
          onRemove={onRemove}
        />
      ))}

      <div className="scan-actions scan-queue-actions">
        <Button variant="ghost" onClick={onClear} disabled={busy}>
          Clear the list
        </Button>
        <Button
          variant={out ? 'danger' : 'primary'}
          icon={out ? 'PackageMinus' : 'PackageCheck'}
          loading={busy}
          // Gated on the LINES, not the summed units. A remove_stock line
          // pinned to 0 by a location switch left the total looking fine while
          // the commit loop threw on that line and stopped before the rest — the
          // button was enabled, said how many units would move, and moved none.
          disabled={lines.length === 0 || lines.some((l) => l.quantity < 1)}
          onClick={onConfirm}
        >
          {out
            ? `Take ${totals.units} out of stock`
            : `Add ${totals.units} to stock`}
        </Button>
      </div>
    </div>
  )
}

function QueueRow({
  line,
  busy,
  onQuantity,
  onLocation,
  onUnitCost,
  onRemove
}: {
  line: PendingLine
  busy: boolean
  onQuantity: (key: string, quantity: number) => void
  onLocation: (key: string, location: string) => void
  onUnitCost: (key: string, unitCost: number | null) => void
  onRemove: (key: string) => void
}): JSX.Element {
  // A local draft so the field can be emptied mid-edit without the count
  // snapping to 1 under the operator's fingers. Re-synced whenever the line
  // changes underneath — which is what a fresh scan does.
  const [qty, setQty] = useState(String(line.quantity))
  useEffect(() => setQty(String(line.quantity)), [line.quantity, line.bumpedAt])

  const [cost, setCost] = useState(line.unitCost != null ? String(line.unitCost) : '')
  useEffect(() => setCost(line.unitCost != null ? String(line.unitCost) : ''), [line.unitCost])

  const out = line.kind === 'remove_stock'
  const atMax = line.max != null && line.quantity >= line.max
  const extended = line.unitCost != null ? line.unitCost * line.quantity : null

  const commitQty = (value: string): void => {
    const n = parseInt(value, 10)
    if (Number.isInteger(n) && n >= 1) onQuantity(line.key, n)
    else setQty(String(line.quantity))
  }

  return (
    <div className={`scan-hero scan-queue-row ${out ? 'is-out' : ''} ${line.overflow ? 'is-capped' : ''}`}>
      <span className="scan-thumb">
        {line.imageUrl ? <img src={line.imageUrl} alt="" /> : <CategoryLogo category={line.category} size={20} />}
      </span>

      <span className="scan-hero-main scan-queue-main">
        {/* Deliberately NOT the hero's single-line treatment: on a receiving
            list the whole name has to be readable to identify the box. */}
        <strong className="scan-queue-name">{line.productName}</strong>
        <span className="scan-meta scan-queue-sub">
          <span className="mono">{line.sku}</span>
          {line.poNumber && <span className="mono">{line.poNumber}</span>}
          {line.kind === 'po_line' && <span className="badge loc-badge">{line.location}</span>}
          {line.unitCost != null && <span>{formatMoney(line.unitCost)} each</span>}
          {out && <span>{line.onHand[line.location] ?? 0} on hand</span>}
          <span>
            {line.scans} scan{line.scans === 1 ? '' : 's'}
          </span>
        </span>

        {/* Editable per-line detail. A PO line's location and price come from
            the order itself, so neither is offered here. */}
        {line.kind !== 'po_line' && (
          <span className="scan-meta scan-queue-edit">
            <span className="loc-pills scan-queue-locs">
              {LOCATIONS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`loc-pill ${line.location === l.id ? 'active' : ''}`}
                  disabled={busy}
                  onClick={() => onLocation(line.key, l.id)}
                >
                  {l.label}
                  <div className="lp-sub">{line.onHand[l.id] ?? 0} on hand</div>
                </button>
              ))}
            </span>
            {!out && (
              <span className="field scan-queue-cost">
                <label>Unit cost</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="keep average"
                  value={cost}
                  disabled={busy}
                  style={{ width: 132 }}
                  onChange={(e) => setCost(e.target.value)}
                  onBlur={() => {
                    const trimmed = cost.trim()
                    if (trimmed === '') return onUnitCost(line.key, null)
                    const n = parseFloat(trimmed)
                    if (Number.isFinite(n) && n >= 0) onUnitCost(line.key, n)
                    else setCost(line.unitCost != null ? String(line.unitCost) : '')
                  }}
                />
              </span>
            )}
          </span>
        )}

        {line.overflow && (
          <span className="scan-warn scan-queue-cap">
            <Icon name="AlertTriangle" size={13} />
            {line.kind === 'po_line'
              ? `Only ${line.max} outstanding on ${line.poNumber} — extra scans were not counted.`
              : `Only ${line.max} on hand in ${line.location} — extra scans were not counted.`}
          </span>
        )}
      </span>

      {/* THE running count. Same place on every row, and directly typeable. */}
      <span className="loc-pills scan-qty" aria-label={`${line.productName} quantity`}>
        <button
          type="button"
          className="btn btn-secondary btn-sm scan-qty-btn"
          aria-label="One fewer"
          disabled={busy || line.quantity <= 1}
          onClick={() => onQuantity(line.key, line.quantity - 1)}
        >
          −
        </button>
        <input
          className="input scan-qty-input"
          type="number"
          min={1}
          step="1"
          inputMode="numeric"
          value={qty}
          disabled={busy}
          onChange={(e) => {
            setQty(e.target.value)
            commitQty(e.target.value)
          }}
          onBlur={() => commitQty(qty)}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm scan-qty-btn"
          aria-label="One more"
          disabled={busy || atMax}
          onClick={() => onQuantity(line.key, line.quantity + 1)}
        >
          +
        </button>
      </span>

      {/* Outbound lines carry no cost input, so this stays empty for them —
          what leaving stock is "worth" is a FIFO answer, not one to guess at. */}
      <span className="mono scan-queue-money">{extended != null ? formatMoney(extended) : ''}</span>

      <button
        type="button"
        className="btn btn-ghost btn-sm scan-queue-drop"
        aria-label={`Remove ${line.productName} from the list`}
        title="Remove from the list"
        disabled={busy}
        onClick={() => onRemove(line.key)}
      >
        <Icon name="X" size={15} />
      </button>
    </div>
  )
}
