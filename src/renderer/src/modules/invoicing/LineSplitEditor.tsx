import { destinationHoldsStock } from '@shared/purchaseOrders'
import { Icon } from '../../components/Icon'
import { DestinationSelect, SupplierSelect } from './PartySelect'
import {
  newDraftKey,
  splitProblem,
  splitTotal,
  type DraftAllocation,
  type DraftLine
} from './helpers'

/**
 * Where one line's units go, edited in place under its own row.
 *
 * ## This used to be a dialog on top of a dialog
 *
 * The lines table opened a second modal to edit a line, and the second modal
 * covered the first — so building a split meant losing sight of the order it was
 * part of, and a drop-ship, which is the case you most need to SEE, was the case
 * hidden behind the most furniture. It is now a panel that expands under the row
 * it belongs to, inside the same table, and a line that is already split or
 * already dropping opens itself. Nothing has to be clicked to find out what a
 * line is doing.
 *
 * ## Edits land immediately — there is no Save on a panel
 *
 * A pop-out needed Save and Cancel because it was a transaction over a copy of
 * the line. A panel is not: it edits the draft the table is showing, so the
 * quantity in the row and the guard rail below it move together as somebody
 * types. The refusal that Save used to carry moved out to Create PO, which is
 * the only Save this form ever had.
 *
 * ## The one rule
 *
 * Σ splits must equal the line's quantity (invariant I1) and every split must be
 * at least one unit (I5). The guard rail says so continuously and Create PO is
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
export function LineSplitEditor({
  line,
  headerSupplier,
  headerDestination,
  onChange
}: {
  line: DraftLine
  /** What a split inherits when neither it nor the line names a supplier. */
  headerSupplier: string
  /** What a split starts at when the line does not override the order. */
  headerDestination: string
  onChange: (allocations: DraftAllocation[]) => void
}): JSX.Element {
  const rows = line.allocations
  const qty = Math.max(0, Math.round(parseInt(line.quantity, 10) || 0))

  // R1's inheritance chain, one step at a time, so the label on each split names
  // what will actually be stored rather than the top of the chain.
  const effectiveSupplier = line.supplier ?? headerSupplier
  const effectiveDestination = line.destination ?? headerDestination

  const assigned = splitTotal(rows)
  const remainder = Math.max(0, qty - assigned)
  const problem = splitProblem(rows, qty)

  const patchRow = (key: string, patch: Partial<DraftAllocation>): void =>
    onChange(rows.map((a) => (a.key === key ? { ...a, ...patch } : a)))

  /**
   * A new split takes what is not yet spoken for.
   *
   * Disabled at zero rather than adding a row of nothing: I5 forbids a
   * zero-quantity split, so such a row would exist only to make Create PO refuse
   * until it was edited or deleted. The title says which, because "greyed out
   * for no stated reason" is the failure this codebase keeps writing down.
   */
  const addRow = (): void =>
    onChange([
      ...rows,
      {
        key: newDraftKey(),
        quantity: Math.max(1, remainder),
        supplier: null,
        destination: effectiveDestination
      }
    ])

  // The line of copy that explains what a drop row DOES appears once, under the
  // first one. Repeating it per row would turn the one sentence somebody has to
  // read into wallpaper they scroll past.
  const firstDropKey = rows.find((a) => !destinationHoldsStock(a.destination))?.key ?? null

  return (
    <>
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
          <b>{effectiveDestination || "the order's destination"}</b>. That is the ordinary case and
          stores nothing extra; add a split only when one line is going to more than one place.
        </p>
      ) : (
        <div className="po-ld-rows">
          {rows.map((a, i) => {
            const drop = !destinationHoldsStock(a.destination)
            return (
              <div className="po-ld-splitrow-wrap" key={a.key}>
                <div className={`po-ld-splitrow${drop ? ' is-drop' : ''}`}>
                  <span className="po-ld-splitn">{i + 1}</span>

                  <span className="po-ld-step">
                    <button
                      type="button"
                      className="po-deliv-btn"
                      aria-label={`One fewer in split ${i + 1}`}
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
                          quantity: Math.max(0, parseInt(e.target.value.replace(/\D+/g, ''), 10) || 0)
                        })
                      }
                    />
                    <button
                      type="button"
                      className="po-deliv-btn"
                      aria-label={`One more in split ${i + 1}`}
                      onClick={() => patchRow(a.key, { quantity: a.quantity + 1 })}
                    >
                      <Icon name="Plus" size={14} />
                    </button>
                  </span>

                  <SupplierSelect
                    className="po-ld-splitfield"
                    ariaLabel={`Supplier for split ${i + 1}`}
                    value={a.supplier}
                    blankLabel={
                      effectiveSupplier
                        ? `Same as line (${effectiveSupplier})`
                        : 'Same as line (no supplier)'
                    }
                    onChange={(name) => patchRow(a.key, { supplier: name })}
                  />

                  <DestinationSelect
                    className="po-ld-splitfield"
                    ariaLabel={`Destination for split ${i + 1}`}
                    value={a.destination}
                    drop={drop}
                    // A split has no header to fall back on — it is the thing
                    // that decides where these units go — so there is no blank
                    // label and splitProblem refuses an empty one.
                    onChange={(dest) => patchRow(a.key, { destination: dest ?? '' })}
                  />

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm po-ld-splitdrop"
                    aria-label={`Remove split ${i + 1}`}
                    title="Remove this split"
                    onClick={() => onChange(rows.filter((r) => r.key !== a.key))}
                  >
                    <Icon name="Trash2" size={15} />
                  </button>
                </div>

                {/* Said once, under the first drop row, because it is the one
                    consequence of this screen that is not visible anywhere else:
                    these units are paid for and counted on the order, and no box
                    ever arrives to be checked in. */}
                {a.key === firstDropKey && (
                  <p className="po-ld-dropnote">
                    <Icon name="Truck" size={14} />
                    These units go straight to the destination — they never reach RM or AM stock.
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* THE GUARD RAIL. Live, above the Create PO it governs, and phrased as the
          arithmetic rather than as an error code: the operator is being asked to
          make two numbers match, so both numbers are on screen while they type. */}
      {rows.length > 0 && (
        <div className={`po-ld-guard${problem ? ' is-bad' : ''}`} role="status">
          <Icon name={problem ? 'AlertTriangle' : 'Check'} size={14} />
          <span>
            <b className="mono">{assigned}</b> of <b className="mono">{qty}</b> units assigned
            {problem ? ` — ${problem}` : ' — the splits add up.'}
          </span>
        </div>
      )}
    </>
  )
}
