import { useMemo, useState } from 'react'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { Button, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { CategoryLogo } from '../inventory/CategoryLogo'
import { ContactTypeahead } from './ContactTypeahead'
import { DestinationPicker } from './DestinationPicker'
import {
  newDraftKey,
  splitProblem,
  splitTotal,
  type DraftAllocation,
  type DraftLine
} from './helpers'

/**
 * One line of a purchase order, opened out.
 *
 * ## Why a pop-out and not seven more columns in the table
 *
 * The lines table answers "what is on this order" at a glance and has to stay
 * readable at nine rows. Everything a line can now carry — its own supplier, its
 * own destination, and a split of its units across several of both — does not
 * fit beside a product name without shrinking the money fields to three
 * characters wide. So the table keeps the summary, and the row opens into this.
 *
 * Seven columns, left to right, in the order somebody fills them in: what it is,
 * how many, what each one costs, what that comes to, who it is bought from,
 * where it goes, and — when one answer to "where" is not enough — how it splits.
 *
 * ## The split editor's one rule
 *
 * Σ splits must equal the line's quantity (invariant I1), and every split must
 * be at least one unit (I5). The guard rail says so continuously and Save is
 * refused while it is violated, so the operator never gets a refusal from the
 * main process that this form could have shown them mid-typing.
 *
 * ## ZERO SPLITS IS VALID, and it is the important case
 *
 * No split rows means "not split", and it stores NOTHING — not one allocation
 * covering the whole quantity. The two behave identically, but only one of them
 * leaves an ordinary purchase order byte-for-byte the way purchase orders have
 * always been stored, and that identity is the entire back-compat mechanism. So
 * removing the last split row here deletes rows rather than collapsing them into
 * one, and "Not split" is a state this editor can return to.
 */
export function LineDetailModal({
  line,
  headerSupplier,
  headerDestination,
  thumb,
  onClose,
  onSave
}: {
  line: DraftLine
  /** What the line inherits when its own supplier is null. */
  headerSupplier: string
  /** What the line inherits when its own destination is null. */
  headerDestination: string
  thumb?: string
  onClose: () => void
  onSave: (line: DraftLine) => void
}): JSX.Element {
  const [draft, setDraft] = useState<DraftLine>(line)
  const [expanded, setExpanded] = useState(line.allocations.length > 0)

  const qty = Math.max(0, Math.round(parseInt(draft.quantity, 10) || 0))
  const price = parseFloat(draft.unitPrice) || 0
  const rows = draft.allocations

  // What a split row inherits when the operator does not override it — the
  // line's own answer if it has one, otherwise the header's. R1's chain, one
  // step at a time, so the placeholder in each box names what will actually be
  // stored rather than the top of the chain.
  const effectiveSupplier = draft.supplier ?? headerSupplier
  const effectiveDestination = draft.destination ?? headerDestination

  const patch = (p: Partial<DraftLine>): void => setDraft((d) => ({ ...d, ...p }))

  const patchRow = (key: string, p: Partial<DraftAllocation>): void =>
    setDraft((d) => ({
      ...d,
      allocations: d.allocations.map((a) => (a.key === key ? { ...a, ...p } : a))
    }))

  const removeRow = (key: string): void =>
    setDraft((d) => ({ ...d, allocations: d.allocations.filter((a) => a.key !== key) }))

  const assigned = splitTotal(rows)
  const remainder = Math.max(0, qty - assigned)

  /**
   * A new split takes what is not yet spoken for.
   *
   * Disabled at zero rather than adding a row of nothing: I5 forbids a
   * zero-quantity split, so such a row would exist only to make Save refuse
   * until it was edited or deleted. The title says which, because "greyed out
   * for no stated reason" is the failure this codebase keeps writing down.
   */
  const addRow = (): void =>
    setDraft((d) => ({
      ...d,
      allocations: [
        ...d.allocations,
        {
          key: newDraftKey(),
          quantity: Math.max(1, qty - splitTotal(d.allocations)),
          supplier: null,
          destination: effectiveDestination
        }
      ]
    }))

  const problem = splitProblem(rows, qty)
  const canSave = qty >= 1 && problem === null

  // The line of copy that explains what a drop row DOES appears once, under the
  // first one. Repeating it per row would turn the one sentence somebody has to
  // read into wallpaper they scroll past.
  const firstDropKey = rows.find((a) => !destinationHoldsStock(a.destination))?.key ?? null

  const destinationCount = useMemo(() => {
    const names = rows.length > 0 ? rows.map((a) => a.destination) : [effectiveDestination]
    return new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean)).size
  }, [rows, effectiveDestination])

  return (
    <Modal
      title={draft.productName}
      subtitle="How many, what they cost, and where they are going"
      onClose={onClose}
      wide
      className="modal-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Check"
            disabled={!canSave}
            title={problem ?? (qty < 1 ? 'A line needs at least one unit.' : undefined)}
            onClick={() => onSave({ ...draft, quantity: String(qty) })}
          >
            Save line
          </Button>
        </>
      }
    >
      <div className="po-ld">
        <div className="po-ld-cols">
          <div className="po-ld-col po-ld-product">
            <span className="po-ld-key">Product</span>
            <span className="po-ld-prod">
              <span className="po-line-img po-ld-img">
                {thumb ? (
                  <img src={thumb} alt="" />
                ) : (
                  <CategoryLogo category={draft.category} size={30} />
                )}
              </span>
              <span className="po-ld-prod-main">
                <span className="po-ld-prod-name">{draft.productName}</span>
                <span className="po-ld-prod-sub">
                  <span className="mono">{draft.sku}</span>
                  {draft.category && <span> · {draft.category}</span>}
                </span>
              </span>
            </span>
          </div>

          <div className="po-ld-col">
            <span className="po-ld-key">Quantity</span>
            <Input
              type="number"
              min={1}
              step={1}
              value={draft.quantity}
              aria-label="Quantity"
              onChange={(e) => patch({ quantity: e.target.value })}
            />
          </div>

          <div className="po-ld-col">
            <span className="po-ld-key">Unit price</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder="0.00"
              value={draft.unitPrice}
              aria-label="Unit price"
              onChange={(e) => patch({ unitPrice: e.target.value })}
            />
          </div>

          <div className="po-ld-col po-ld-num">
            <span className="po-ld-key">Line total</span>
            {/* Derived, and stays derived. The one figure on this row nobody
                types, because a total that disagrees with its own quantity ×
                price is a total nobody can reconcile against the order. */}
            <span className="po-ld-total mono">{formatMoney(qty * price)}</span>
          </div>

          <div className="po-ld-col">
            <span className="po-ld-key">Supplier</span>
            <ContactTypeahead
              inline
              ariaLabel="Line supplier"
              value={draft.supplier ?? ''}
              placeholder={headerSupplier || 'Same as the order'}
              onChange={(name) => patch({ supplier: name.trim() ? name : null })}
            />
            <span className="po-ld-inherit">
              {draft.supplier === null
                ? headerSupplier
                  ? `Same as the order — ${headerSupplier}`
                  : 'Same as the order — no supplier named'
                : 'Overrides the order'}
            </span>
          </div>

          <div className="po-ld-col">
            <span className="po-ld-key">Destination</span>
            <DestinationPicker
              inline
              ariaLabel="Line destination"
              value={draft.destination ?? ''}
              placeholder={headerDestination || 'Same as the order'}
              onChange={(dest) => patch({ destination: dest.trim() ? dest : null })}
            />
            <span className="po-ld-inherit">
              {draft.destination === null
                ? `Same as the order — ${headerDestination}`
                : 'Overrides the order'}
            </span>
          </div>

          <div className="po-ld-col po-ld-splitcol">
            <span className="po-ld-key">Split</span>
            <button
              type="button"
              className={`po-ld-splitbtn${rows.length > 0 ? ' is-split' : ''}`}
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              <Icon name={rows.length > 0 ? 'Split' : 'MapPin'} size={14} />
              {destinationCount === 1 ? '1 destination' : `${destinationCount} destinations`}
              <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={15} />
            </button>
            <span className="po-ld-inherit">
              {rows.length === 0 ? 'Not split' : `${rows.length} splits`}
            </span>
          </div>
        </div>

        {expanded && (
          <div className="po-ld-splits">
            <div className="po-ld-splits-head">
              <span className="po-ld-splits-title">
                <Icon name="Split" size={15} />
                Where these {qty} {qty === 1 ? 'unit' : 'units'} go
              </span>
              <button
                type="button"
                className="btn btn-sm po-ld-add"
                disabled={remainder < 1}
                title={
                  remainder < 1
                    ? rows.length === 0
                      ? 'Give the line a quantity first.'
                      : 'Every unit is already assigned — take some off a split to make room.'
                    : `Adds a split of ${remainder}`
                }
                onClick={addRow}
              >
                <Icon name="Plus" size={14} /> Add split
              </button>
            </div>

            {rows.length === 0 ? (
              <p className="po-ld-nosplit">
                Not split — all {qty} {qty === 1 ? 'unit' : 'units'} go to{' '}
                <b>{effectiveDestination || "the order's destination"}</b>. That is the ordinary
                case and stores nothing extra; add a split only when one line is going to more than
                one place.
              </p>
            ) : (
              <div className="po-ld-rows">
                {rows.map((a, i) => {
                  const drop = !destinationHoldsStock(a.destination)
                  return (
                    <div className="po-ld-splitrow-wrap" key={a.key}>
                      <div className={`po-ld-splitrow${drop ? ' is-drop' : ''}`}>
                        <span className="po-ld-splitn">{i + 1}</span>

                        <span className="po-ld-step" aria-label={`Units in split ${i + 1}`}>
                          <button
                            type="button"
                            className="po-deliv-btn"
                            aria-label="One fewer"
                            disabled={a.quantity <= 1}
                            onClick={() => patchRow(a.key, { quantity: a.quantity - 1 })}
                          >
                            <Icon name="Minus" size={14} />
                          </button>
                          <input
                            className="po-deliv-num mono"
                            inputMode="numeric"
                            aria-label={`Units in split ${i + 1}`}
                            value={String(a.quantity)}
                            onChange={(e) =>
                              patchRow(a.key, {
                                quantity: Math.max(
                                  0,
                                  parseInt(e.target.value.replace(/\D+/g, ''), 10) || 0
                                )
                              })
                            }
                          />
                          <button
                            type="button"
                            className="po-deliv-btn"
                            aria-label="One more"
                            onClick={() => patchRow(a.key, { quantity: a.quantity + 1 })}
                          >
                            <Icon name="Plus" size={14} />
                          </button>
                        </span>

                        <span className="po-ld-splitfield">
                          <ContactTypeahead
                            inline
                            ariaLabel={`Supplier for split ${i + 1}`}
                            value={a.supplier ?? ''}
                            placeholder={effectiveSupplier || 'Same as the line'}
                            onChange={(name) =>
                              patchRow(a.key, { supplier: name.trim() ? name : null })
                            }
                          />
                        </span>

                        <span className="po-ld-splitfield">
                          <DestinationPicker
                            inline
                            ariaLabel={`Destination for split ${i + 1}`}
                            value={a.destination}
                            onChange={(dest) => patchRow(a.key, { destination: dest })}
                          />
                        </span>

                        <button
                          type="button"
                          className="btn btn-ghost btn-sm po-ld-splitdrop"
                          aria-label={`Remove split ${i + 1}`}
                          title="Remove this split"
                          onClick={() => removeRow(a.key)}
                        >
                          <Icon name="Trash2" size={15} />
                        </button>
                      </div>

                      {/* Said once, under the first drop row, because it is the
                          one consequence of this screen that is not visible
                          anywhere else: these units are paid for and counted on
                          the order, and no box ever arrives to be checked in. */}
                      {a.key === firstDropKey && (
                        <p className="po-ld-dropnote">
                          <Icon name="Truck" size={14} />
                          These units go straight to the destination — they never reach RM or AM
                          stock.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* THE GUARD RAIL. Live, above the Save it governs, and phrased as
                the arithmetic rather than as an error code: the operator is
                being asked to make two numbers match, so both numbers are on
                screen while they type. */}
            {rows.length > 0 && (
              <div className={`po-ld-guard${problem ? ' is-bad' : ''}`} role="status">
                <Icon name={problem ? 'AlertTriangle' : 'Check'} size={14} />
                <span>
                  <b className="mono">{assigned}</b> of <b className="mono">{qty}</b> units assigned
                  {problem ? ` — ${problem}` : ' — the splits add up.'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
