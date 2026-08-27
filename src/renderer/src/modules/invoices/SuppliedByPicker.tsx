import type { SaleSourceLink } from '@shared/orders'
import { Icon } from '../../components/Icon'

/**
 * WHERE THESE CASES CAME FROM, on a line a supplier ships direct.
 *
 * The owner's words: "we need to know where products are coming from and that is
 * important, and those are open tabs — so if we attach the roadshow open PO the
 * correct products just have to be attached in the sales order."
 *
 * ## Why this is not SourceOrderPicker
 *
 * That one asks the SHELF what it is holding: which purchase orders still have
 * this product on hand here, so the line can be costed against that order's
 * layers. A dropship line has no shelf to ask. The cases went from the supplier
 * to the buyer and were never here, so every answer that picker could give is
 * empty — which is exactly why the question was unanswerable on the orders where
 * the owner most needs it answered. A roadshow open tab is the commonest case of
 * all: bought in a hotel ballroom, shipped from there, never seen by this
 * building.
 *
 * So the candidates come from the DOCUMENT instead: the purchase orders somebody
 * has already attached to this sale. See AttachPurchaseOrderModal, which is where
 * that claim is made, and `invoice.sourcePos`, which is the list of it.
 *
 * ## It records; it never spends
 *
 * Nothing this picker writes reaches a cost layer, and the safety is structural
 * rather than a check somebody has to remember: `effectiveSlices` blanks a
 * non-stock slice's purchase order, and everything that costs a sale asks
 * `effectiveSlices`. See @shared/invoiceAllocations.
 *
 * ## Absent unless there is something to choose between
 *
 * No attached purchase orders and nothing already recorded means no control and
 * one quiet sentence saying where to go instead — an empty dropdown would read
 * as a broken feature rather than as a step not yet taken.
 */
export function SuppliedByPicker({
  orders,
  productName,
  value,
  onChange,
  onAttach
}: {
  /** The purchase orders attached to this sale — `invoice.sourcePos`. */
  orders: readonly SaleSourceLink[]
  /** What the line is selling, so the control can name itself for a screen reader. */
  productName: string
  /** The recorded order, or '' for "not recorded". */
  value: string
  onChange: (poId: string) => void
  /** Open the attach screen. Absent when there is nowhere to send somebody. */
  onAttach?: () => void
}): JSX.Element | null {
  const chosen = orders.find((o) => o.poId === value) ?? null
  /**
   * A RECORDED ORDER THAT IS NO LONGER ATTACHED still shows.
   *
   * Somebody detaching a purchase at the document level does not erase what a
   * line said about where its goods came from — that is a separate claim, made
   * separately — so the answer stays visible and stays selectable rather than
   * silently reverting to "not recorded" the next time this screen opens.
   */
  const stale = !!value && !chosen

  if (orders.length === 0 && !stale) {
    if (!onAttach) return null
    return (
      <div className="so-source">
        <button type="button" className="btn btn-ghost btn-sm so-source-attach" onClick={onAttach}>
          <Icon name="Link2" size={12} /> Attach a purchase order to say where these came from
        </button>
      </div>
    )
  }

  return (
    <div className="so-source">
      <label className="so-source-row">
        <Icon name="Truck" size={12} />
        <span className="so-source-label">Came from</span>
        <select
          className="select so-source-select"
          aria-label={`Which purchase order supplied the ${productName}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* NOT RECORDED IS A REAL ANSWER and is named as one. Most sales are
              supplied by nothing anybody needs to write down, and a blank first
              option would read as a question waiting to be answered. */}
          <option value="">Not recorded</option>
          {orders.map((o) => (
            <option key={o.poId} value={o.poId}>
              {o.poNumber}
              {o.supplier ? ` · ${o.supplier}` : ''}
              {o.orderedOn ? ` · ${o.orderedOn}` : ''}
            </option>
          ))}
          {/* Detached from the sale since this was recorded — see `stale`. */}
          {stale && <option value={value}>The order this line was recorded against</option>}
        </select>
      </label>
      {stale && (
        <div className="so-source-warn">
          That purchase order is no longer attached to this sales order. The line still remembers it.
        </div>
      )}
    </div>
  )
}
