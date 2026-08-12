import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { Freight } from '@shared/freight'
import { LOCATION_IDS } from '@shared/inventory'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { FreightFields } from '../../components/FreightFields'
import { ContactTypeahead } from './ContactTypeahead'
import { DestinationPicker } from './DestinationPicker'
import { LineDetailModal } from './LineDetailModal'
import { POCatalogTypeahead } from './POCatalogTypeahead'
import { PasteOfferPanel, type OfferDraftLine } from './PasteOfferPanel'
import { splitProblem, splitTotal, type DraftLine } from './helpers'

/**
 * Build a purchase order from catalog line items: a supplier + destination +
 * notes header, a typeahead to append products, and a per-line quantity / unit
 * buy price with a live running total. Saves via api.purchaseOrders.create — the
 * new PO lands in the Ordered column.
 *
 * The supplier box searches the contact list and the suppliers already used on
 * previous POs, and picking one only fills the box in: the value sent is still
 * the free text this form has always sent. See ContactTypeahead.
 *
 * ## The destination is no longer a shelf
 *
 * It was a two-entry dropdown over RM and AM. It is now a picker over every
 * vendor and every invoice customer as well, because a purchase can be shipped
 * straight from the supplier to whoever bought it — and when it is, no box ever
 * arrives here and nothing is ever checked into stock. Nothing on this form
 * decides that: the destination decides it, per allocation, everywhere
 * downstream. See @shared/purchaseOrders.
 *
 * Each LINE can override the header, and each line can be SPLIT across several
 * destinations. The table shows both columns muted while they are inherited and
 * solid once they are not, so "everything goes to RM" and "this one line goes
 * somewhere else" are told apart without opening anything. The pop-out behind
 * the product cell is where the split is built — see LineDetailModal.
 *
 * Two ways in, one way out. PasteOfferPanel reads a supplier's text message
 * into a review the operator confirms, and the typeahead adds one product at a
 * time; both do nothing but append to the same `lines` below, and NEITHER
 * creates anything. A purchase order is still made by this form, by somebody
 * pressing Create PO — the paste is a way of filling the form in, not a second
 * path to the same table.
 */
export function CreatePurchaseOrderModal({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [supplier, setSupplier] = useState('')
  const [location, setLocation] = useState<string>(LOCATION_IDS[0])
  const [notes, setNotes] = useState('')
  const [freight, setFreight] = useState<Freight>({
    carrier: null,
    service: null,
    trackingNumber: null,
    paymentTiming: null
  })
  const [lines, setLines] = useState<DraftLine[]>([])
  /** The line whose pop-out is open, by product id. */
  const [detailId, setDetailId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Append a catalog pick as a line (defaulting the price to its average cost).
  // If the product is already on the PO, just bump its quantity instead.
  const addLine = (p: InventoryProduct): void => {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === p.id)
      if (existing) {
        return prev.map((l) =>
          l.productId === p.id
            ? { ...l, quantity: String((parseInt(l.quantity, 10) || 0) + 1) }
            : l
        )
      }
      return [
        ...prev,
        {
          productId: p.id,
          productName: p.name,
          sku: p.sku,
          category: p.category,
          quantity: '1',
          unitPrice: p.unitCost ? String(p.unitCost) : '',
          // Null, not a copy of the header. A line that never disagreed with the
          // order has to follow it when the header changes, and a snapshot taken
          // at the moment the line was added would silently stay behind.
          supplier: null,
          destination: null,
          allocations: []
        }
      ]
    })
  }

  /**
   * Take the rows the operator confirmed in the paste review.
   *
   * A reviewed row REPLACES an existing line for the same product rather than
   * bumping its quantity the way addLine does. The two are different acts: the
   * typeahead's "clicked it again" means one more, while a reviewed row carries
   * its own quantity AND its own price straight off the supplier's message, and
   * adding it to whatever was already there would produce a quantity nobody
   * chose at a price from one of two lines. The review has already refused to
   * hand over two rows for one product for the same reason.
   *
   * A replaced row also loses any routing the operator had already given it —
   * deliberately. The reviewed row is a different set of numbers, and a split
   * built against the old quantity would violate I1 the moment it landed.
   */
  const addReviewedLines = (reviewed: OfferDraftLine[]): void => {
    setLines((prev) => {
      const next = [...prev]
      for (const r of reviewed) {
        const line: DraftLine = {
          productId: r.product.id,
          productName: r.product.name,
          sku: r.product.sku,
          category: r.product.category,
          quantity: String(r.quantity),
          unitPrice: String(r.unitPrice),
          supplier: null,
          destination: null,
          allocations: []
        }
        const at = next.findIndex((l) => l.productId === r.product.id)
        if (at >= 0) next[at] = line
        else next.push(line)
      }
      return next
    })
  }

  const patchLine = (productId: string, patch: Partial<DraftLine>): void => {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)))
  }

  const removeLine = (productId: string): void => {
    setLines((prev) => prev.filter((l) => l.productId !== productId))
    setDetailId((id) => (id === productId ? null : id))
  }

  const grandTotal = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const qty = parseInt(l.quantity, 10) || 0
        const price = parseFloat(l.unitPrice) || 0
        return sum + qty * price
      }, 0),
    [lines]
  )

  /**
   * How many of this order's units are actually coming here.
   *
   * Computed from the same inheritance chain the main process will use, so the
   * footer's count and the receipt's agree the moment the order exists. A line
   * with splits is summed per allocation; one without is all-or-nothing at its
   * effective destination.
   */
  const receivable = useMemo(() => {
    let stock = 0
    let drop = 0
    for (const l of lines) {
      const qty = Math.max(0, parseInt(l.quantity, 10) || 0)
      if (l.allocations.length > 0) {
        for (const a of l.allocations) {
          const n = Math.max(0, Math.round(a.quantity) || 0)
          if (destinationHoldsStock(a.destination)) stock += n
          else drop += n
        }
        continue
      }
      if (destinationHoldsStock(l.destination ?? location)) stock += qty
      else drop += qty
    }
    return { stock, drop }
  }, [lines, location])

  const detailLine = detailId ? lines.find((l) => l.productId === detailId) ?? null : null

  /**
   * Escape belongs to whichever dialog is on top.
   *
   * `Modal` listens on `window`, so BOTH dialogs hear the key while the line
   * pop-out is open — and the outer one closing takes the whole draft with it,
   * including every line the operator has added. So the shell ignores a close
   * while something is stacked on it and lets the pop-out have the keystroke.
   */
  const closeShell = (): void => {
    if (detailId) return
    onClose()
  }

  const submit = async (): Promise<void> => {
    if (lines.length === 0) {
      setError('Add at least one line item.')
      return
    }
    for (const l of lines) {
      const qty = parseInt(l.quantity, 10)
      if (!Number.isInteger(qty) || qty < 1) {
        setError(`Quantity for ${l.productName} must be a whole number of at least 1.`)
        return
      }
      const price = parseFloat(l.unitPrice)
      if (l.unitPrice.trim() !== '' && (!Number.isFinite(price) || price < 0)) {
        setError(`Price for ${l.productName} must be 0 or more.`)
        return
      }
      // I1 and I5, checked here for the same reason the delivery form checks its
      // own counts: the main process refuses the WHOLE order if a split does not
      // add up, and finding that out after pressing Create means retyping nine
      // lines to fix one.
      const bad = splitProblem(l.allocations, qty)
      if (bad) {
        setError(`${l.productName}: ${bad}`)
        return
      }
    }
    if (!location.trim()) {
      setError('Choose where this order is going.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const res = await api.purchaseOrders.create({
        supplier: supplier.trim() || null,
        location,
        notes: notes.trim() || null,
        ...freight,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: parseInt(l.quantity, 10),
          unitPrice: parseFloat(l.unitPrice) || 0,
          supplier: l.supplier,
          destination: l.destination,
          // An unsplit line sends NO allocations at all rather than one covering
          // its whole quantity — the difference is the whole back-compat story.
          allocations:
            l.allocations.length > 0
              ? l.allocations.map((a) => ({
                  quantity: Math.max(0, Math.round(a.quantity) || 0),
                  supplier: a.supplier,
                  destination: a.destination.trim()
                }))
              : undefined
        }))
      })
      if (!res.ok || !res.data) {
        setError(res.error ?? 'Could not create the purchase order.')
        return
      }
      toast.success(`Created ${res.data.poNumber}.`)
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title="New purchase order"
        subtitle="Paste a supplier's message or search the catalog, then check the lines."
        onClose={closeShell}
        wide
        // Two more columns than this table used to carry, and both of them hold a
        // party name rather than a number. At 620px the money fields squeezed to
        // three characters wide.
        className="modal-xl"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="ReceiptText"
              loading={busy}
              disabled={lines.length === 0}
              onClick={submit}
            >
              Create PO
            </Button>
          </>
        }
      >
        {error && <div className="auth-alert">{error}</div>}

        <div className="field-row">
          <ContactTypeahead value={supplier} onChange={setSupplier} />
          <DestinationPicker
            value={location}
            onChange={setLocation}
            hint="RM or AM to stock it; anyone else drop-ships"
          />
          <Field label="Notes" hint="Optional">
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Net-30, split shipment"
            />
          </Field>
        </div>

        <FreightFields
          {...freight}
          hint="Who is bringing it"
          onChange={(patch) => setFreight((f) => ({ ...f, ...patch }))}
        />

        <PasteOfferPanel onApply={addReviewedLines} />

        <POCatalogTypeahead onSelect={addLine} />

        {lines.length === 0 ? (
          <div className="po-lines-empty">No line items yet — search above to add products.</div>
        ) : (
          <div className="po-lines">
            <table className="data po-lines-table po-lines-routed">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Line total</th>
                  <th>Supplier</th>
                  <th>Destination</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const qty = parseInt(l.quantity, 10) || 0
                  const price = parseFloat(l.unitPrice) || 0
                  const split = l.allocations.length > 0
                  const dest = l.destination ?? location
                  // A split line has no single destination to print, so the cell
                  // names the split instead — and the drop marker follows the
                  // allocations rather than the header it no longer obeys.
                  const drop = split
                    ? l.allocations.some((a) => !destinationHoldsStock(a.destination))
                    : !destinationHoldsStock(dest)
                  return (
                    <tr key={l.productId}>
                      {/* The product cell is the way into the pop-out. A button
                          rather than a click handler on the <td>, so it is
                          reachable from the keyboard and announces itself. */}
                      <td>
                        <button
                          type="button"
                          className="po-line-open"
                          title="Open this line — price, supplier, destination and splits"
                          onClick={() => setDetailId(l.productId)}
                        >
                          <span className="po-line-name">{l.productName}</span>
                          <span className="po-line-sub">
                            <span className="mono">{l.sku}</span>
                            {l.category && <span> · {l.category}</span>}
                            {split && (
                              <span className="po-line-splits">
                                <Icon name="Split" size={12} />
                                {l.allocations.length} splits · {splitTotal(l.allocations)} of {qty}
                              </span>
                            )}
                          </span>
                        </button>
                      </td>
                      <td className="num">
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={l.quantity}
                          onChange={(e) => patchLine(l.productId, { quantity: e.target.value })}
                          className="po-qty-input"
                        />
                      </td>
                      <td className="num">
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          value={l.unitPrice}
                          onChange={(e) => patchLine(l.productId, { unitPrice: e.target.value })}
                          placeholder="0.00"
                          className="po-price-input"
                        />
                      </td>
                      <td className="num mono">{formatMoney(qty * price)}</td>
                      {/* Both routing cells are placeholder-inherited: empty means
                          "same as the header", and the header's value is what the
                          placeholder prints. Muted while inherited, solid once
                          overridden — the difference between an order that all
                          goes one place and one that does not, readable down the
                          column without opening a row. */}
                      <td>
                        <Input
                          className={`po-route-input${l.supplier === null ? ' is-inherited' : ''}`}
                          value={l.supplier ?? ''}
                          placeholder={supplier.trim() || 'No supplier'}
                          aria-label={`Supplier for ${l.productName}`}
                          onChange={(e) =>
                            patchLine(l.productId, {
                              supplier: e.target.value.trim() ? e.target.value : null
                            })
                          }
                        />
                      </td>
                      <td>
                        {split ? (
                          <button
                            type="button"
                            className="po-route-split"
                            title="Split across several destinations — open the line to change it"
                            onClick={() => setDetailId(l.productId)}
                          >
                            <Icon name="Split" size={13} />
                            {new Set(l.allocations.map((a) => a.destination.trim().toLowerCase())).size}{' '}
                            destinations
                            {drop && <span className="po-drop-chip">Drop</span>}
                          </button>
                        ) : (
                          <span className="po-route-cell">
                            <Input
                              className={`po-route-input${l.destination === null ? ' is-inherited' : ''}`}
                              value={l.destination ?? ''}
                              placeholder={location || 'RM'}
                              aria-label={`Destination for ${l.productName}`}
                              onChange={(e) =>
                                patchLine(l.productId, {
                                  destination: e.target.value.trim() ? e.target.value : null
                                })
                              }
                            />
                            {drop && <span className="po-drop-chip">Drop</span>}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          title="Remove line"
                          onClick={() => removeLine(l.productId)}
                        >
                          <Icon name="Trash2" size={15} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div className="po-total">
              <span>Grand total</span>
              <span className="mono">{formatMoney(grandTotal)}</span>
            </div>
            {/* Stated before the order exists, not discovered on the receipt
                afterwards. The total above covers every unit — drop-shipped ones
                are bought and paid for exactly like the rest — and this is the
                line that says how many of them will ever be checked in here. */}
            {receivable.drop > 0 && (
              <div className="po-lines-dropnote">
                <Icon name="Truck" size={14} />
                {receivable.stock > 0
                  ? `${receivable.stock} unit${receivable.stock === 1 ? '' : 's'} will arrive here; ${receivable.drop} drop-ship straight to their destination and are never checked into stock.`
                  : `All ${receivable.drop} unit${receivable.drop === 1 ? '' : 's'} drop-ship straight to their destination. Nothing on this order arrives here.`}
              </div>
            )}
          </div>
        )}

      </Modal>

      {/* A SIBLING of the form's dialog, not a child of it. Both overlays sit at
          the same z-index, so whichever is later in the DOM is the one the
          operator can reach — the arrangement the scan station already uses for
          its lot picker, and the one that keeps a `position: fixed` overlay out
          of the scrolling modal body it would otherwise be laid out inside. */}
      {detailLine && (
        <LineDetailModal
          line={detailLine}
          headerSupplier={supplier.trim()}
          headerDestination={location}
          onClose={() => setDetailId(null)}
          onSave={(next) => {
            patchLine(next.productId, next)
            setDetailId(null)
          }}
        />
      )}
    </>
  )
}
