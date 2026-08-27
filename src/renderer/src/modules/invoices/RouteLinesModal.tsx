import { useState } from 'react'
import type { InvoiceDetail, InvoiceLine } from '@shared/invoices'
import {
  allocationProblem,
  allocationTotal,
  dropUnitsOf,
  stockUnitsOf,
  type InvoiceLineAllocation
} from '@shared/invoiceAllocations'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { DestinationSelect } from '../invoicing/PartySelect'
import { newDraftKey } from '../invoicing/helpers'
import { SourceOrderPicker } from './SourceOrderPicker'
import { SuppliedByPicker } from './SuppliedByPicker'

/**
 * WHERE THE LINES OF A POSTED SALE ARE FULFILLED FROM — case by case.
 *
 * The owner's words: "on a sales order that is posted into QuickBooks I want the
 * ability to change the destination and supplier if needed, for our own purposes
 * and inventory — not the QuickBooks." And then: "for each individual case
 * adjust where it is coming from, and it corresponds back to inventory or the
 * right dropship PO."
 *
 * ## Why this is a separate screen and not the invoice form
 *
 * The invoice form edits the DOCUMENT — number, buyer, dates, prices, the total —
 * and it is refused the moment an invoice reaches QuickBooks, correctly: this app
 * is not the system of record for a document somebody has been billed against,
 * and there is no way to amend the copy Intuit holds.
 *
 * Where the goods come from is not part of that document. "Ten cases at $900" is
 * what the buyer agreed. "Two of those ship direct from the supplier and eight
 * come off the RM shelf" is a fact about this business's inventory, discovered
 * afterwards more often than not, and nothing on the buyer's invoice says it or
 * should. So it gets its own control, editable for the life of the order, and it
 * writes three columns and re-derives the stock — see setInvoiceLineRouting.
 *
 * ## Splitting a line does not split the invoice
 *
 * Eight at $900 plus two at $900 is ten at $900. The quantity, the rate and the
 * amount are never written by this screen, which is exactly what makes it safe
 * on an order somebody has already been billed for: the line stays the line, and
 * the split hangs off it. See @shared/invoiceAllocations.
 *
 * ## The consequences are on the screen, not in a comment
 *
 * Two of them are real and neither is obvious, so both are said out loud before
 * anybody presses Save: the shelf moves, and once any line is a dropship the
 * order waits for somebody to confirm the goods are in hand before it can be
 * called ready to ship.
 */

/** One row of the split editor. Ids are minted on the way in, not here. */
type DraftSlice = {
  key: string
  quantity: number
  /** Always a real destination — a split has no header to inherit from. */
  destination: string
  /** '' means ordinary FIFO stock, exactly as the single-line picker means it. */
  sourcePoId: string
}

export function RouteLinesModal({
  invoice,
  onClose,
  onDone,
  onAttachOrders
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onDone: () => void | Promise<void>
  /**
   * Leave for the screen that attaches purchase orders to this sale.
   *
   * A line a supplier ships direct records where its goods came from by naming
   * one of the orders ATTACHED to the sale — see SuppliedByPicker — so a sale
   * with none attached has an empty list and nothing to say about it. This is
   * the way out of that, offered in place of the dropdown rather than as a
   * dropdown with nothing in it.
   */
  onAttachOrders?: () => void
}): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  /** Line id -> the destination it should have. Only what has been touched. */
  const [edits, setEdits] = useState<Record<string, string | null>>({})
  /**
   * Line id -> which purchase order's cases it takes. Only what has been touched.
   *
   * SEPARATE FROM `edits` because the two questions are separate: one is whether
   * a line comes off a shelf at all, the other is whose cases it takes when it
   * does. Somebody moving a line onto the other shelf must not silently drop a
   * roadshow pointer they set last week, and a key that is absent here means
   * exactly that — leave it alone.
   */
  const [sources, setSources] = useState<Record<string, string>>({})
  /**
   * Line id -> the line broken up by quantity. Only what has been touched.
   *
   * THREE STATES, and they are three different instructions, matching the three
   * the main process accepts:
   *
   *   key absent   leave whatever splits the line already has
   *   []           collapse it back to one line with one answer
   *   [a, b, …]    these splits, replacing whatever was there
   *
   * An empty array is NOT the same as an absent key. "Not split" is a state this
   * editor can return to, and it is stored as zero rows rather than as one
   * allocation covering the whole quantity — which is what keeps an ordinary
   * sale stored the way sales have always been stored.
   */
  const [splits, setSplits] = useState<Record<string, DraftSlice[]>>({})

  const headerLocation = (invoice.location || 'RM').trim()
  const routeOf = (lineId: string, current: string | null): string | null =>
    lineId in edits ? edits[lineId] : current
  /** The destination a line's units come from once inheritance is resolved. */
  const effectiveDest = (l: InvoiceLine): string =>
    (routeOf(l.id, l.destination) ?? '').trim() || headerLocation

  /** The line's stored splits, as this editor's rows. Empty when it is unsplit. */
  const storedSlices = (l: InvoiceLine): DraftSlice[] =>
    l.allocations.map((a) => ({
      key: a.id,
      quantity: a.quantity,
      destination: a.destination,
      sourcePoId: a.sourcePoId ?? ''
    }))
  /** What the line's splits will BE, touched or not. */
  const draftOf = (l: InvoiceLine): DraftSlice[] =>
    l.id in splits ? splits[l.id] : storedSlices(l)
  const isSplit = (l: InvoiceLine): boolean => draftOf(l).length > 0
  /** The draft in the shape the shared slice rule reads. */
  const draftAllocations = (l: InvoiceLine): InvoiceLineAllocation[] =>
    draftOf(l).map((s) => {
      const where = s.destination.trim() || effectiveDest(l)
      const holdsStock = destinationHoldsStock(where)
      return {
        id: s.key,
        quantity: s.quantity,
        destination: where,
        supplier: holdsStock ? null : where,
        holdsStock,
        // RAW, on a dropship slice as much as a stock one: this field is now
        // where a slice records which purchase order supplied it, and
        // `effectiveSlices` is what blanks it for anything that costs money.
        sourcePoId: s.sourcePoId || null,
        sourcePoNumber: null
      }
    })

  const setSlices = (lineId: string, rows: DraftSlice[]): void =>
    setSplits((prev) => ({ ...prev, [lineId]: rows }))
  const patchSlice = (l: InvoiceLine, key: string, patch: Partial<DraftSlice>): void =>
    setSlices(
      l.id,
      draftOf(l).map((s) => (s.key === key ? { ...s, ...patch } : s))
    )

  const routeChanged = (l: InvoiceLine): boolean => {
    if (!(l.id in edits)) return false
    const now = (edits[l.id] ?? '').trim()
    const was = (l.destination ?? '').trim()
    // The stored value inherits when it matches the header, so compare what each
    // one RESOLVES to rather than the raw strings — otherwise picking "RM" on a
    // line already inheriting RM would read as a change and rewrite the stock
    // for nothing.
    return (now || headerLocation).toLowerCase() !== (was || headerLocation).toLowerCase()
  }
  const sourceChanged = (l: InvoiceLine): boolean =>
    l.id in sources && (sources[l.id] || '') !== (l.sourcePoId || '')
  /** Serialised so "same rows, re-keyed" does not read as a change. */
  const sliceKey = (rows: DraftSlice[]): string =>
    rows.map((s) => `${s.quantity}|${s.destination.trim().toLowerCase()}|${s.sourcePoId}`).join('/')
  const splitChanged = (l: InvoiceLine): boolean =>
    l.id in splits && sliceKey(splits[l.id]) !== sliceKey(storedSlices(l))

  const changed = invoice.lines.filter(
    (l) => routeChanged(l) || sourceChanged(l) || splitChanged(l)
  )

  /**
   * WHY SAVE IS REFUSED, said as arithmetic rather than as an error code.
   *
   * Σ splits must equal the line's quantity. A line of ten split into six and
   * three is not a line of nine — it is a line of ten with a case coming from
   * nowhere, drawing no shelf and appearing on no purchase order. The main
   * process refuses it too; this is so nobody has to press Save to find out.
   */
  const problems = changed
    .map((l) => {
      const rows = draftOf(l)
      if (rows.length === 0) return null
      const problem = allocationProblem(rows, l.quantity)
      return problem ? `${l.item}: ${problem}` : null
    })
    .filter((p): p is string => p !== null)

  // What the shelf will do, said before it happens rather than discovered after.
  // Counted in UNITS through the shared slice rule, because a split line is
  // partly on the shelf and partly not — a whole-line count would put all ten
  // cases on one side of that and name a number nobody is going to see.
  let backToShelf = 0
  let offTheShelf = 0
  for (const l of changed) {
    if (!l.productId) continue
    const was = stockUnitsOf(
      {
        quantity: l.quantity,
        destination: l.destination,
        supplier: l.supplier,
        sourcePoId: l.sourcePoId,
        allocations: l.allocations
      },
      headerLocation
    )
    const now = stockUnitsOf(
      {
        quantity: l.quantity,
        destination: effectiveDest(l),
        allocations: draftAllocations(l)
      },
      headerLocation
    )
    if (now > was) offTheShelf += now - was
    if (was > now) backToShelf += was - now
  }

  const willHaveDropship = invoice.lines.some(
    (l) =>
      dropUnitsOf(
        { quantity: l.quantity, destination: effectiveDest(l), allocations: draftAllocations(l) },
        headerLocation
      ) > 0
  )
  const hasDropshipNow = invoice.lines.some((l) => l.dropship)

  const save = async (): Promise<void> => {
    if (changed.length === 0 || problems.length > 0) return
    setBusy(true)
    try {
      const res = await api.invoices.setLineRouting(
        invoice.id,
        changed.map((l) => ({
          lineId: l.id,
          // A line whose route was not touched keeps the one it has — this
          // screen may be here only to change whose cases it takes.
          destination: l.id in edits ? edits[l.id] : (l.destination ?? null),
          // The destination IS the party shipping a dropship line, exactly as
          // the sales form derives it — there is no second question to ask.
          supplier: null,
          // Absent unless somebody touched it, so a route-only change leaves a
          // roadshow pointer exactly where it was.
          ...(l.id in sources ? { sourcePoId: sources[l.id] || null } : {}),
          // Same rule again: absent means leave the splits alone, [] means
          // collapse the line back to one answer.
          ...(l.id in splits
            ? {
                allocations: splits[l.id].map((s) => ({
                  quantity: s.quantity,
                  destination: s.destination.trim() || null,
                  sourcePoId: s.sourcePoId || null
                }))
              }
            : {})
        }))
      )
      if (!res.ok) {
        toast.error(res.error ?? 'Could not change where those lines come from.')
        return
      }
      toast.success(
        changed.length === 1
          ? '1 line re-routed. The invoice and QuickBooks are untouched.'
          : `${changed.length} lines re-routed. The invoice and QuickBooks are untouched.`
      )
      await onDone()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Where these lines come from"
      subtitle={`${invoice.invoiceNumber ? `Sales order ${invoice.invoiceNumber}` : 'This sales order'} — for your inventory, not the buyer's invoice`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Check"
            disabled={changed.length === 0 || problems.length > 0 || busy}
            loading={busy}
            onClick={() => void save()}
          >
            {changed.length === 0
              ? 'Nothing changed'
              : problems.length > 0
                ? 'The splits do not add up'
                : `Save ${changed.length} line${changed.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">
        A line coming off <b>RM</b> or <b>AM</b> draws that shelf down. Anything else is a{' '}
        <b>dropship</b> — the supplier ships it straight to the buyer and it never touches a shelf
        here. Changing this moves your <b>stock</b>. It does not change a price, the total, or the
        invoice the buyer is holding.
      </p>
      <p className="fin-confirm-lead">
        A line of several cases can be <b>split</b>, so each case says where it comes from on its
        own — eight off the shelf and two shipped direct is one line with two answers. And a line
        that DOES come off a shelf may say <b>whose cases</b> it takes: a roadshow week, or any
        purchase order still holding that product. That decides where its <b>cost</b> comes from,
        and it shows up on that purchase order&rsquo;s history as well as this sale&rsquo;s.
      </p>

      <table className="data po-lines-table">
        <thead>
          <tr>
            <th>Line</th>
            <th className="num">Qty</th>
            <th>Fulfilled from</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => {
            const dest = routeOf(l.id, l.destination)
            const drop = !destinationHoldsStock((dest ?? '').trim() || headerLocation)
            const rows = draftOf(l)
            const split = isSplit(l)
            const assigned = allocationTotal(rows)
            const remainder = Math.max(0, l.quantity - assigned)
            const problem = split ? allocationProblem(rows, l.quantity) : null
            const firstDropKey =
              rows.find((s) => !destinationHoldsStock(s.destination.trim() || effectiveDest(l)))
                ?.key ?? null
            return (
              <tr key={l.id}>
                <td>
                  <div className="po-line-name">{l.item}</div>
                  {l.sku && <div className="po-line-sub mono">{l.sku}</div>}
                </td>
                <td className="num mono">{l.quantity}</td>
                <td>
                  {/* A LINE WITH NO CATALOG PRODUCT MOVES NO STOCK EITHER WAY —
                      a grading fee, a one-off typed by hand — so re-routing it
                      claims something about goods that do not exist. Shown as
                      what it is rather than offered as a choice. */}
                  {!l.productId ? (
                    <span className="muted">not a stocked item</span>
                  ) : split ? (
                    <>
                      <div className="po-ld-splits-head">
                        <span className="po-ld-splits-title">
                          <Icon name="Split" size={15} />
                          Where these {l.quantity} come from
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm po-ld-add"
                          disabled={remainder < 1}
                          title={
                            remainder < 1
                              ? 'Every case is already accounted for — take some off a split to make room.'
                              : `Adds a split of ${remainder}`
                          }
                          onClick={() =>
                            setSlices(l.id, [
                              ...rows,
                              {
                                key: newDraftKey(),
                                quantity: Math.max(1, remainder),
                                destination: effectiveDest(l),
                                sourcePoId: ''
                              }
                            ])
                          }
                        >
                          <Icon name="Plus" size={14} /> Add split
                        </button>
                      </div>
                      <div className="po-ld-rows">
                        {rows.map((s, i) => {
                          const where = s.destination.trim() || effectiveDest(l)
                          const sliceDrop = !destinationHoldsStock(where)
                          return (
                            <div key={s.key}>
                              <div
                                className={`po-ld-splitrow so-slice-row${sliceDrop ? ' is-drop' : ''}`}
                              >
                                <span className="po-ld-splitn">{i + 1}</span>
                                <span className="po-ld-step">
                                  <button
                                    type="button"
                                    className="po-deliv-btn"
                                    aria-label={`One fewer case in split ${i + 1} of ${l.item}`}
                                    disabled={s.quantity <= 1}
                                    onClick={() => patchSlice(l, s.key, { quantity: s.quantity - 1 })}
                                  >
                                    <Icon name="Minus" size={14} />
                                  </button>
                                  <input
                                    className="po-deliv-num mono"
                                    inputMode="numeric"
                                    aria-label={`Cases in split ${i + 1} of ${l.item}`}
                                    value={String(s.quantity)}
                                    onChange={(e) =>
                                      patchSlice(l, s.key, {
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
                                    aria-label={`One more case in split ${i + 1} of ${l.item}`}
                                    onClick={() => patchSlice(l, s.key, { quantity: s.quantity + 1 })}
                                  >
                                    <Icon name="Plus" size={14} />
                                  </button>
                                </span>
                                <DestinationSelect
                                  className="po-ld-splitfield"
                                  ariaLabel={`Where split ${i + 1} of ${l.item} comes from`}
                                  value={s.destination || null}
                                  drop={sliceDrop}
                                  // THE ANSWER SURVIVES THE MOVE. This used to
                                  // blank the purchase order the moment a split
                                  // stopped coming off a shelf, because a
                                  // dropship consumes no cost layers and so
                                  // could not name whose. It can now RECORD
                                  // which order supplied it — that is the whole
                                  // point of the open-tab case — so throwing the
                                  // answer away would be destroying provenance
                                  // on the one kind of line that most needs it.
                                  onChange={(d) => patchSlice(l, s.key, { destination: d ?? '' })}
                                />
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-sm po-ld-splitdrop"
                                  aria-label={`Remove split ${i + 1} of ${l.item}`}
                                  title="Remove this split"
                                  onClick={() =>
                                    setSlices(
                                      l.id,
                                      rows.filter((r) => r.key !== s.key)
                                    )
                                  }
                                >
                                  <Icon name="Trash2" size={15} />
                                </button>
                              </div>
                              {/* WHERE THESE CASES CAME FROM — the same question
                                  of both kinds of split, asked of whichever
                                  thing can answer it. A split off a shelf asks
                                  the shelf what is on it and is costed against
                                  that order's layers; a split a supplier ships
                                  direct never touched a shelf, so it names one
                                  of the purchase orders attached to this sale
                                  and the answer is a record rather than a
                                  charge. See SuppliedByPicker. */}
                              {sliceDrop ? (
                                <SuppliedByPicker
                                  orders={invoice.sourcePos}
                                  productName={l.item}
                                  value={s.sourcePoId}
                                  onChange={(poId) => patchSlice(l, s.key, { sourcePoId: poId })}
                                  onAttach={onAttachOrders}
                                />
                              ) : (
                                <SourceOrderPicker
                                  productId={l.productId as string}
                                  productName={l.item}
                                  location={where}
                                  quantity={s.quantity}
                                  value={s.sourcePoId}
                                  onChange={(poId) => patchSlice(l, s.key, { sourcePoId: poId })}
                                />
                              )}
                              {/* Said once, under the first dropship split: it
                                  is the one consequence of this row that is
                                  invisible anywhere else. */}
                              {s.key === firstDropKey && (
                                <p className="po-ld-dropnote">
                                  <Icon name="Truck" size={14} />
                                  These cases go straight from the supplier to the buyer — they
                                  never touch a shelf here, so they come back off it.
                                </p>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <div className={`po-ld-guard${problem ? ' is-bad' : ''}`} role="status">
                        <Icon name={problem ? 'AlertTriangle' : 'Check'} size={14} />
                        <span>
                          <b className="mono">{assigned}</b> of <b className="mono">{l.quantity}</b>{' '}
                          accounted for{problem ? ` — ${problem}` : ' — the splits add up.'}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm so-split-toggle"
                        onClick={() => setSlices(l.id, [])}
                      >
                        <Icon name="ChevronsDownUp" size={14} /> Stop splitting — all {l.quantity}{' '}
                        from one place
                      </button>
                    </>
                  ) : (
                    <>
                      <DestinationSelect
                        className={`po-route-party${dest ? '' : ' is-inherited'}`}
                        ariaLabel={`Fulfilled from, for ${l.item}`}
                        value={dest || null}
                        blankLabel={`Same as order (${headerLocation})`}
                        drop={drop}
                        onChange={(d) => setEdits((prev) => ({ ...prev, [l.id]: d ?? '' }))}
                      />
                      {/* WHICH PURCHASE ORDER, the second question — and it is
                          asked of BOTH kinds of line, because both have an
                          answer and only one of them costs anything.

                          A line off a shelf asks the shelf: the same picker the
                          invoice form shows on a draft, offering the orders that
                          actually hold this product here, and naming one decides
                          which cost layers the line spends.

                          A line a supplier ships direct has no shelf to ask —
                          the cases went straight to the buyer and were never
                          here — which is precisely why the question used to go
                          unasked on the orders where the owner most needs it
                          answered: "those are open tabs". So it names one of the
                          purchase orders ATTACHED to this sale instead, and the
                          answer is provenance rather than a charge. See
                          SuppliedByPicker. */}
                      {drop ? (
                        <SuppliedByPicker
                          orders={invoice.sourcePos}
                          productName={l.item}
                          value={l.id in sources ? sources[l.id] : (l.sourcePoId ?? '')}
                          onChange={(poId) => setSources((prev) => ({ ...prev, [l.id]: poId }))}
                          onAttach={onAttachOrders}
                        />
                      ) : (
                        <SourceOrderPicker
                          productId={l.productId}
                          productName={l.item}
                          location={(dest ?? '').trim() || headerLocation}
                          quantity={l.quantity}
                          value={l.id in sources ? sources[l.id] : (l.sourcePoId ?? '')}
                          onChange={(poId) => setSources((prev) => ({ ...prev, [l.id]: poId }))}
                        />
                      )}
                      {/* ONLY OFFERED ON A LINE OF MORE THAN ONE. Splitting a
                          single case has no meaning it could express, and the
                          guard rail would refuse every arrangement of it. */}
                      {l.quantity > 1 && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm so-split-toggle"
                          onClick={() =>
                            setSlices(l.id, [
                              {
                                key: newDraftKey(),
                                quantity: l.quantity - 1,
                                destination: effectiveDest(l),
                                sourcePoId: l.id in sources ? sources[l.id] : (l.sourcePoId ?? '')
                              },
                              {
                                key: newDraftKey(),
                                quantity: 1,
                                destination: effectiveDest(l),
                                sourcePoId: ''
                              }
                            ])
                          }
                        >
                          <Icon name="Split" size={14} /> Split these {l.quantity} up
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {(backToShelf > 0 || offTheShelf > 0) && (
        <p className="fin-confirm-lead">
          <b>Your stock will move.</b>
          {backToShelf > 0 && (
            <>
              {' '}
              <b>{backToShelf}</b> unit{backToShelf === 1 ? '' : 's'} go back on the shelf — they
              are being shipped by a supplier, so this business never held them.
            </>
          )}
          {offTheShelf > 0 && (
            <>
              {' '}
              <b>{offTheShelf}</b> unit{offTheShelf === 1 ? '' : 's'} come off the shelf, at the
              cost of the layers they are taken from.
            </>
          )}
        </p>
      )}

      {/* The gate flip is the surprise worth naming. Once ANY line is a dropship
          the order waits for somebody to confirm the goods exist before it can be
          called ready to ship — even if every other line is on a shelf. */}
      {willHaveDropship && !hasDropshipNow && (
        <p className="so-source-warn">
          This makes it a part-dropship order, so it will wait for <b>Items in hand</b> before it
          can be marked ready to ship — the app does not assume goods it never held have arrived.
        </p>
      )}

      <p className="ds-note">
        <Icon name="Info" size={14} />
        <span>
          Nothing here reaches QuickBooks. This app cannot amend an invoice Intuit already has, and
          does not try — the buyer&rsquo;s document stays exactly as it was sent. Splitting a line
          does not split what was billed either: eight at one price plus two at the same price is
          still ten at that price. What changes is your inventory, your cost of goods on this sale,
          and what the board says about where the goods are coming from.
        </span>
      </p>
    </Modal>
  )
}
