import { useEffect, useState } from 'react'
import type { ScanDirection } from '@shared/types'
import { LOCATIONS } from '@shared/inventory'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { CategoryLogo } from './CategoryLogo'
import { commitBlockedReason, queueTotals, type PendingLine } from './scanLines'

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
  onAcceptOverage,
  onKeepToOrder,
  onClear,
  onConfirm
}: {
  lines: PendingLine[]
  direction: ScanDirection
  busy: boolean
  onQuantity: (key: string, quantity: number) => void
  /** Answers to the over-scan question. See the note where it is rendered. */
  onAcceptOverage: (key: string) => void
  onKeepToOrder: (key: string) => void
  onLocation: (key: string, location: string) => void
  onUnitCost: (key: string, unitCost: number | null) => void
  onRemove: (key: string) => void
  onClear: () => void
  onConfirm: () => void
}): JSX.Element {
  const totals = queueTotals(lines)
  const out = direction === 'out'
  const blocked = commitBlockedReason(lines)
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
          onAcceptOverage={onAcceptOverage}
          onKeepToOrder={onKeepToOrder}
          onLocation={onLocation}
          onUnitCost={onUnitCost}
          onRemove={onRemove}
        />
      ))}

      {blocked && (
        <div className="scan-banner scan-banner-warn scan-queue-blocked">
          <Icon name="AlertCircle" size={16} />
          <span>{blocked}</span>
        </div>
      )}

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
          // A missing cost blocks it the same way, and the banner above says so
          // rather than leaving a dead grey button.
          disabled={lines.length === 0 || blocked != null}
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
  onAcceptOverage,
  onKeepToOrder,
  onLocation,
  onUnitCost,
  onRemove
}: {
  line: PendingLine
  busy: boolean
  onQuantity: (key: string, quantity: number) => void
  onAcceptOverage: (key: string) => void
  onKeepToOrder: (key: string) => void
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
  const needsCost = line.costRequired && line.unitCost == null
  useEffect(() => setCost(line.unitCost != null ? String(line.unitCost) : ''), [line.unitCost])

  const out = line.kind === 'remove_stock'
  // Only OUTBOUND has a ceiling the stepper must respect. Inbound the + button
  // stayed disabled at the order's quantity, so somebody who saw the count stuck
  // at 1 could not fix it by hand either — the app disagreed with the boxes in
  // their hands and offered no way to say so.
  const atMax = line.direction !== 'in' && line.max != null && line.quantity >= line.max
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
          {/* The ALLOCATION's destination, which for an unsplit line is the
              line's and for a legacy one is the header's — the same shelf this
              pill has always shown. On a line split across both shelves it is
              the half the operator chose, and it is the only thing on the row
              that says which. */}
          {line.kind === 'po_line' && (
            <span className="badge loc-badge" title={`These units go to ${line.location}`}>
              {line.location}
            </span>
          )}
          {line.unitCost != null && <span>{formatMoney(line.unitCost)} each</span>}
          {out && <span>{line.onHand[line.location] ?? 0} on hand</span>}
          {/* SCANS ARE BOXES. Three beeps is three boxes off the pallet, so a
              count that says 3 beside a quantity that says 1 has to explain
              itself where the eye already is — not only in the banner below it.
              The clamp is correct (the order asked for fewer) but silent
              disagreement between the two numbers reads as the app losing
              scans, which is exactly what it was accused of. */}
          <span className={line.scans > line.quantity ? 'scan-count-short' : undefined}>
            {line.scans} scan{line.scans === 1 ? '' : 's'}
            {line.scans > line.quantity && ` · only ${line.quantity} fits`}
          </span>
          {/* MORE ARRIVED THAN WAS ORDERED, said plainly and not in the way.
              Inbound the count follows the boxes, so this is a note about the
              paperwork being behind — a supplier shipped an extra case, or the
              order was raised short. It is worth seeing before the receipt is
              made, and worth nobody's time to answer a dialog about. */}
          {line.direction === 'in' && line.overflow && line.max != null && (
            <span className="scan-count-extra">
              {line.quantity - line.max} more than {line.poNumber ?? 'the order'} expected
            </span>
          )}
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
                <label>
                  Unit cost
                  {needsCost && <em className="scan-queue-cost-req">required</em>}
                </label>
                <input
                  className={`input${needsCost ? ' field-error' : ''}`}
                  type="number"
                  min={0}
                  step="0.01"
                  // The placeholder is the honest description of what a blank
                  // does. "keep average" is right only when there IS an average;
                  // with no cost on record a blank books the stock at nothing,
                  // and the field says so instead.
                  placeholder={line.costRequired ? 'cost required' : 'keep average'}
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

        {/* THE OVER-SCAN QUESTION.
            This used to be a chip beside a number that had quietly stopped
            moving: every beep still sounded like a success and the count simply
            froze. It is a decision now, and nothing on the list commits until
            it is answered — see commitBlockedReason. */}
        {line.needsDecision === 'overage' && (
          <span className="scan-overask">
            <span className="scan-overask-text">
              <Icon name="AlertTriangle" size={14} />
              <b>
                {line.scans} scanned, {line.max} {line.kind === 'so_line' || line.kind === 'remove_stock'
                  ? 'available'
                  : 'ordered'}
                .
              </b>{' '}
              {line.kind === 'po_line'
                ? `${line.poNumber} only asked for ${line.max}.`
                : line.kind === 'so_line'
                  ? `${line.invoiceNumber || 'That order'} only asked for ${line.max}.`
                  : `Only ${line.max} on hand in ${line.location}.`}
            </span>
            <span className="scan-overask-btns">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onKeepToOrder(line.key)}>
                Keep {line.max}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy}
                onClick={() => onAcceptOverage(line.key)}
              >
                Take all {line.scans}
              </button>
            </span>
          </span>
        )}
        {line.overflow && line.needsDecision === null && (
          <span className="scan-warn scan-queue-cap">
            <Icon name="AlertTriangle" size={13} />
            {line.kind === 'po_line'
              ? `Only ${line.max} outstanding on ${line.poNumber}.`
              : `Only ${line.max} on hand in ${line.location}.`}
          </span>
        )}
        {line.override === 'overage' && (
          <span className="scan-warn scan-queue-over">
            <Icon name="AlertTriangle" size={13} />
            More than the order asked for — this will be flagged as an overage.
          </span>
        )}
        {line.override === 'no_order' && (
          <span className="scan-warn scan-queue-over">
            <Icon name="AlertTriangle" size={13} />
            On no open order — recorded as an override.
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
