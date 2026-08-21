import { Fragment, useMemo, useState } from 'react'
import type { InventoryProduct, PurchaseOrderDetail } from '@shared/types'
import type { Freight } from '@shared/freight'
import { LOCATION_IDS } from '@shared/inventory'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { isMultiShipment } from '@shared/multiShipment'
import type { DropshipPurchasePrefill } from '@shared/orders'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { FreightFields } from '../../components/FreightFields'
import { DestinationSelect, SupplierSelect } from './PartySelect'
import { LineSplitEditor } from './LineSplitEditor'
import { POCatalogTypeahead } from './POCatalogTypeahead'
import { PasteOfferPanel, type OfferDraftLine } from './PasteOfferPanel'
import { splitProblem, splitTotal, type DraftAllocation, type DraftLine } from './helpers'

/**
 * Build a purchase order from catalog line items: a supplier + destination +
 * notes header, a typeahead to append products, and a per-line quantity / unit
 * buy price with a live running total. Saves via api.purchaseOrders.create — the
 * new PO lands in the Ordered column.
 *
 * ## The destination is no longer a shelf
 *
 * It was a two-entry dropdown over RM and AM. It is now a dropdown over every
 * vendor and every invoice customer as well, because a purchase can be shipped
 * straight from the supplier to whoever bought it — and when it is, no box ever
 * arrives here and nothing is ever checked into stock. Nothing on this form
 * decides that: the destination decides it, per allocation, everywhere
 * downstream. See @shared/purchaseOrders.
 *
 * Each LINE can override the header, and each line can be SPLIT across several
 * destinations. The table shows both columns muted while they are inherited and
 * solid once they are not, so "everything goes to RM" and "this one line goes
 * somewhere else" are told apart without opening anything.
 *
 * ## Nothing here opens a second dialog
 *
 * The split editor used to be a modal stacked on this one, which covered the
 * order while you were routing part of it. It is now a panel that expands under
 * the row it belongs to, in this same table — see LineSplitEditor — and a line
 * that is already split, or already going somewhere that does not hold stock,
 * opens itself. Every control on this form is a control you can see.
 *
 * ## Nothing here is typed into either
 *
 * Supplier and destination are native <select>s, on the header, on every line
 * and on every split, with an `Other…` option that reveals a text box for the
 * first order from a new distributor. See PartySelect for why native rather than
 * the typeaheads these replaced — the short version is that a floating menu
 * inside a scrolling modal is a positioning bug waiting to happen, and the OS
 * draws a <select>'s menu outside the page entirely.
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
  onSaved,
  onCreated,
  prefill
}: {
  onClose: () => void
  onSaved: () => void | Promise<void>
  /**
   * Open with the order already written, bar the prices.
   *
   * Used by the dropship flow coming the OTHER way — from a sales order that
   * needs the purchase behind it. Read once, as the initial state: a prefill
   * that kept overwriting the form would fight whoever is typing in it.
   */
  prefill?: DropshipPurchasePrefill | null
  /**
   * The order that was just raised, handed back so a caller can carry on with
   * it. The dropship flow uses it to open the sell side straight afterwards,
   * pre-filled from what was just bought.
   *
   * Called BEFORE onClose, and its result is awaited, so the caller can put a
   * second screen up without the first one having disappeared underneath it.
   */
  onCreated?: (po: PurchaseOrderDetail) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [supplier, setSupplier] = useState(prefill?.supplier ?? '')
  // The buyer, on a prefilled dropship — which is the whole point of the
  // prefill, because a destination that is not one of our shelves is what stops
  // these units being received into stock. See dropshipPurchaseFromSale.
  const [location, setLocation] = useState<string>(prefill?.destination || LOCATION_IDS[0])
  const [notes, setNotes] = useState('')
  const [freight, setFreight] = useState<Freight>({
    carrier: null,
    service: null,
    trackingNumber: null,
    paymentTiming: null
  })
  /** Freight the supplier charges. Joins the total and the COGS row with it. */
  const [shippingCost, setShippingCost] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() =>
    (prefill?.lines ?? []).map((l) => ({
      productId: l.productId,
      productName: l.productName,
      sku: l.sku,
      category: '',
      quantity: String(l.quantity),
      // Blank, not the catalog's average cost: this asks what the SUPPLIER
      // charges for this deal, and a number already in the box is a number
      // somebody accepts without reading.
      unitPrice: '',
      // Null so every line follows the header. Copying the destination onto
      // each one would make them all overrides, and changing the order's
      // destination afterwards would then move nothing.
      supplier: null,
      destination: null,
      allocations: []
    }))
  )
  /**
   * The rows somebody has pressed open or pressed shut, by product id.
   *
   * An OVERRIDE map rather than the set of open rows, because most rows are
   * neither: `autoOpen` below decides for them, and a row that has never been
   * touched has to keep following that decision. Storing "open" alone would mean
   * a row could be opened by the rule and never closed by hand.
   */
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({})
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
    // Otherwise a product removed and re-added would come back carrying whatever
    // had been decided about a row that no longer exists.
    setOpenOverride((o) => {
      const next = { ...o }
      delete next[productId]
      return next
    })
  }

  /**
   * A row that is already doing something unusual is already open.
   *
   * "If you know it is a drop ship" was the complaint this answers: a line that
   * has been split, or sent somewhere that does not hold stock, has detail the
   * operator has to see, and making them click for it is exactly the pop-out
   * that was removed.
   *
   * Deliberately the LINE's own destination and not its effective one. Inherited
   * lines follow the header, so an order whose header is a drop-ship would open
   * every row at once the moment that header was chosen — nine panels unfolding
   * under a single click, telling nobody anything they had not just typed. The
   * header already says where an inherited line is going; only a line that
   * disagrees with it has something extra to show.
   */
  const autoOpen = (l: DraftLine): boolean =>
    l.allocations.length > 0 || (l.destination !== null && !destinationHoldsStock(l.destination))

  const isOpen = (l: DraftLine): boolean => openOverride[l.productId] ?? autoOpen(l)

  const toggleLine = (l: DraftLine): void => {
    const next = !isOpen(l)
    setOpenOverride((o) => ({ ...o, [l.productId]: next }))
  }

  /**
   * Re-route a line, without the panel moving underneath the hand that did it.
   *
   * `autoOpen` opens a row the moment its destination stops holding stock, which
   * is the whole point of it — but read in the other direction it also SHUTS one
   * the moment the destination goes back to a shelf, and a panel folding up
   * because somebody corrected a dropdown is the row moving for a reason nobody
   * asked for. So a row that was open when it was re-routed stays open, by hand
   * from then on. Used for the supplier too, where it changes nothing, because a
   * rule that applies to one of two identical-looking cells is a rule the next
   * person will get wrong.
   */
  const routeLine = (l: DraftLine, patch: Partial<DraftLine>): void => {
    const wasOpen = isOpen(l)
    patchLine(l.productId, patch)
    if (wasOpen) setOpenOverride((o) => ({ ...o, [l.productId]: true }))
  }

  const setAllocations = (l: DraftLine, allocations: DraftAllocation[]): void => {
    patchLine(l.productId, { allocations })
    // A split that was just added must be visible even if this row had been
    // pressed shut — the Add split button lives inside the panel, so the only
    // way to get here with a closed row is a race, but a closed row holding a
    // half-built split is the one state this form must never sit in.
    if (allocations.length > 0) setOpenOverride((o) => ({ ...o, [l.productId]: true }))
  }

  /**
   * What this order comes to — FREIGHT INCLUDED, because that is what will be
   * owed and what the saved total will say. A running total that quietly left
   * it out would disagree with the order the moment it saved.
   */
  const grandTotal = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const qty = parseInt(l.quantity, 10) || 0
        const price = parseFloat(l.unitPrice) || 0
        return sum + qty * price
      }, 0) + (parseFloat(shippingCost) || 0),
    [lines, shippingCost]
  )

  /**
   * Why Create PO is refused, or null when it is not.
   *
   * I1 and I5, live rather than on submit. The pop-out used to hold this rule
   * behind its own Save button; with the editor inline there is only one Save on
   * this form, so the rule attaches to it — and the button carries the reason as
   * its title, because a disabled control with no stated cause is the failure
   * this codebase keeps writing down. `submit` re-checks anyway: it is also the
   * guard for quantity and price, and it is the last thing between this form and
   * a whole order the main process would refuse.
   */
  const blocked = useMemo(() => {
    for (const l of lines) {
      const bad = splitProblem(l.allocations, parseInt(l.quantity, 10) || 0)
      if (bad) return `${l.productName}: ${bad}`
    }
    // Only reachable through the destination's Other… box, left empty. The
    // dropdown itself cannot produce it: its blank option is disabled precisely
    // because an order has to go somewhere.
    if (!location.trim()) return 'Choose where this order is going.'
    return null
  }, [lines, location])

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
        shippingCost: shippingCost.trim() === '' ? null : parseFloat(shippingCost),
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
      if (onCreated) await onCreated(res.data)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New purchase order"
      subtitle="Paste a supplier's message or search the catalog, then check the lines."
      onClose={onClose}
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
            disabled={lines.length === 0 || blocked !== null}
            title={blocked ?? (lines.length === 0 ? 'Add at least one line item.' : undefined)}
            onClick={submit}
          >
            Create PO
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <div className="po-head-row">
        <Field label="Supplier" hint="Who this is being bought from">
          <SupplierSelect
            value={supplier || null}
            ariaLabel="Supplier"
            blankLabel="No supplier named"
            onChange={(name) => setSupplier(name ?? '')}
          />
        </Field>
        <Field
          label="Destination"
          hint={
            isMultiShipment(location)
              ? 'You name the buyers when you raise the sales orders'
              : 'RM or AM to stock it; anyone else drop-ships'
          }
        >
          <DestinationSelect
            value={location}
            ariaLabel="Destination"
            drop={location.trim().length > 0 && !destinationHoldsStock(location)}
            // The ONE place a pin can be set, now that the typeahead's per-row
            // star is gone. Without it the Pinned group could only ever shrink.
            pinnable
            // And the one place "several buyers" can be chosen — see the `multi`
            // prop, which is off on every line and split row deliberately.
            multi
            onChange={(dest) => setLocation(dest ?? '')}
          />
        </Field>
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

      {/* WHAT THE SUPPLIER CHARGES TO GET IT HERE. Beside the carrier, because
          that is the same question asked about money — and it is part of what
          this order costs, so it joins the total above the Create button. */}
      <Field label="Shipping" hint="What the supplier charges for freight — added to the order total">
        <Input
          value={shippingCost}
          inputMode="decimal"
          placeholder="0.00"
          onChange={(e) => setShippingCost(e.target.value)}
        />
      </Field>

      <PasteOfferPanel onApply={addReviewedLines} />

      <POCatalogTypeahead onSelect={addLine} />

      {lines.length === 0 ? (
        <div className="po-lines-empty">No line items yet — search above to add products.</div>
      ) : (
        <div className="po-lines">
          <table className="data po-lines-table po-lines-routed">
            {/* FIXED WIDTHS, declared once. The money columns used to be sized by
                whatever text happened to be in them, so typing a longer supplier
                name shoved the price field sideways and every row in the table
                re-flowed under the cursor. Every column but the product is now a
                stated width and the product takes the slack. */}
            <colgroup>
              <col />
              <col className="po-col-qty" />
              <col className="po-col-price" />
              <col className="po-col-total" />
              <col className="po-col-supplier" />
              <col className="po-col-dest" />
              <col className="po-col-remove" />
            </colgroup>
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
                const open = isOpen(l)
                // A split line has no single destination to print, so the cell
                // names the split instead — and the drop marker follows the
                // allocations rather than the header it no longer obeys.
                const drop = split
                  ? l.allocations.some((a) => !destinationHoldsStock(a.destination))
                  : !destinationHoldsStock(dest)
                const destinations = split
                  ? new Set(l.allocations.map((a) => a.destination.trim().toLowerCase())).size
                  : 1
                return (
                  <Fragment key={l.productId}>
                    <tr className={open ? 'is-open' : undefined}>
                      {/* The product cell is the way in and out of the panel. A
                          button rather than a click handler on the <td>, so it is
                          reachable from the keyboard and announces itself. */}
                      <td>
                        <button
                          type="button"
                          className="po-line-open"
                          aria-expanded={open}
                          title={
                            open
                              ? 'Close this line'
                              : 'Open this line — split it across several destinations'
                          }
                          onClick={() => toggleLine(l)}
                        >
                          <span className="po-line-caret">
                            <Icon name="ChevronRight" size={14} />
                          </span>
                          {/* NAME, then SKU, then category, then the split
                              indicator — one under the next. All four used to run
                              together on a single sub-line, where the SKU and the
                              category were separated by a dot and read as one
                              string. */}
                          <span className="po-line-main">
                            <span className="po-line-name">{l.productName}</span>
                            <span className="po-line-sku mono">{l.sku}</span>
                            {l.category && <span className="po-line-cat">{l.category}</span>}
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
                          aria-label={`Quantity for ${l.productName}`}
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
                          aria-label={`Unit price for ${l.productName}`}
                          onChange={(e) => patchLine(l.productId, { unitPrice: e.target.value })}
                          placeholder="0.00"
                          className="po-price-input"
                        />
                      </td>
                      <td className="num mono">{formatMoney(qty * price)}</td>
                      {/* Both routing cells are inheritance-first: their opening
                          option IS "same as the order", it is what a new line is
                          set to, and choosing it stores NULL rather than a copy of
                          the header. Muted while inherited, solid once overridden —
                          the difference between an order that all goes one place
                          and one that does not, readable down the column without
                          opening a row. */}
                      <td>
                        <SupplierSelect
                          className={`po-route-party${l.supplier === null ? ' is-inherited' : ''}`}
                          ariaLabel={`Supplier for ${l.productName}`}
                          value={l.supplier}
                          blankLabel={
                            supplier.trim()
                              ? `Same as order (${supplier.trim()})`
                              : 'Same as order (none)'
                          }
                          onChange={(name) => routeLine(l, { supplier: name })}
                        />
                      </td>
                      <td>
                        {split ? (
                          // A split line has no single destination, so the cell
                          // names the split and opens the panel that owns it. The
                          // chip sits UNDER the pill rather than inside it: at 196px
                          // the two together did not fit, and a chip that wraps on
                          // some rows and not others changes the row height for a
                          // reason nobody watching can see.
                          <span className="po-route-cell">
                            <button
                              type="button"
                              className="po-route-split"
                              aria-expanded={open}
                              title="Split across several destinations — open the line to change it"
                              onClick={() => toggleLine(l)}
                            >
                              <Icon name="Split" size={13} />
                              {destinations} destinations
                            </button>
                            {drop && <span className="po-drop-chip">Drop</span>}
                          </span>
                        ) : (
                          <DestinationSelect
                            className={`po-route-party${l.destination === null ? ' is-inherited' : ''}`}
                            ariaLabel={`Destination for ${l.productName}`}
                            value={l.destination}
                            blankLabel={`Same as order (${location || 'RM'})`}
                            drop={drop}
                            onChange={(d) => routeLine(l, { destination: d })}
                          />
                        )}
                      </td>
                      <td className="num po-line-remove-cell">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm po-line-remove"
                          title="Remove line"
                          aria-label={`Remove ${l.productName}`}
                          onClick={() => removeLine(l.productId)}
                        >
                          <Icon name="Trash2" size={15} />
                        </button>
                      </td>
                    </tr>

                    {/* THE PANEL, in the same table, under the row it belongs to.
                        Two <tr>s rather than one tall cell, so the columns above
                        it keep their widths and nothing in the row moves when it
                        opens. Rendered only while open — an always-present row
                        with a collapsed height still owns a border and a hover
                        state, and the table grew a hairline under every line. */}
                    {open && (
                      <tr className="po-line-detail">
                        <td colSpan={7}>
                          <div className="po-line-panel">
                            <div className="po-line-panel-in">
                              <div className="po-line-panel-body">
                                {/* The two columns the phone layer hides, because
                                    seven of them do not fit in 390px. Inert at a
                                    desktop width, where the cells above carry
                                    them — see .po-line-route in styles/app.css. */}
                                <div className="po-line-route">
                                  <label className="po-line-route-field">
                                    <span className="po-ld-key">Supplier</span>
                                    <SupplierSelect
                                      value={l.supplier}
                                      ariaLabel={`Supplier for ${l.productName}`}
                                      blankLabel={
                                        supplier.trim()
                                          ? `Same as order (${supplier.trim()})`
                                          : 'Same as order (none)'
                                      }
                                      onChange={(name) => routeLine(l, { supplier: name })}
                                    />
                                  </label>
                                  <label className="po-line-route-field">
                                    <span className="po-ld-key">Destination</span>
                                    <DestinationSelect
                                      value={l.destination}
                                      ariaLabel={`Destination for ${l.productName}`}
                                      blankLabel={`Same as order (${location || 'RM'})`}
                                      drop={drop}
                                      onChange={(d) => routeLine(l, { destination: d })}
                                    />
                                  </label>
                                </div>

                                <LineSplitEditor
                                  line={l}
                                  headerSupplier={supplier.trim()}
                                  headerDestination={location}
                                  onChange={(allocations) => setAllocations(l, allocations)}
                                />
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
  )
}
