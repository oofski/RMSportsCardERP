import { useState } from 'react'
import type { InvoiceDetail } from '@shared/invoices'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { DestinationSelect } from '../invoicing/PartySelect'
import { SourceOrderPicker } from './SourceOrderPicker'

/**
 * WHERE THE LINES OF A POSTED SALE ARE FULFILLED FROM.
 *
 * The owner's words: "on a sales order that is posted into QuickBooks I want the
 * ability to change the destination and supplier if needed, for our own purposes
 * and inventory — not the QuickBooks."
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
 * ## The consequences are on the screen, not in a comment
 *
 * Two of them are real and neither is obvious, so both are said out loud before
 * anybody presses Save: the shelf moves, and once any line is a dropship the
 * order waits for somebody to confirm the goods are in hand before it can be
 * called ready to ship.
 */
export function RouteLinesModal({
  invoice,
  onClose,
  onDone
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onDone: () => void | Promise<void>
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

  const headerLocation = (invoice.location || 'RM').trim()
  const routeOf = (lineId: string, current: string | null): string | null =>
    lineId in edits ? edits[lineId] : current

  const routeChanged = (l: (typeof invoice.lines)[number]): boolean => {
    if (!(l.id in edits)) return false
    const now = (edits[l.id] ?? '').trim()
    const was = (l.destination ?? '').trim()
    // The stored value inherits when it matches the header, so compare what each
    // one RESOLVES to rather than the raw strings — otherwise picking "RM" on a
    // line already inheriting RM would read as a change and rewrite the stock
    // for nothing.
    return (now || headerLocation).toLowerCase() !== (was || headerLocation).toLowerCase()
  }
  const sourceChanged = (l: (typeof invoice.lines)[number]): boolean =>
    l.id in sources && (sources[l.id] || '') !== (l.sourcePoId || '')

  const changed = invoice.lines.filter((l) => routeChanged(l) || sourceChanged(l))

  // What the shelf will do, said before it happens rather than discovered after.
  let backToShelf = 0
  let offTheShelf = 0
  for (const l of changed) {
    if (!l.productId || !routeChanged(l)) continue
    const wasStock = destinationHoldsStock((l.destination ?? '').trim() || headerLocation)
    const nowStock = destinationHoldsStock((edits[l.id] ?? '').trim() || headerLocation)
    if (wasStock && !nowStock) backToShelf += l.quantity
    if (!wasStock && nowStock) offTheShelf += l.quantity
  }

  const willHaveDropship = invoice.lines.some((l) => {
    const dest = (routeOf(l.id, l.destination) ?? '').trim() || headerLocation
    return !destinationHoldsStock(dest)
  })
  const hasDropshipNow = invoice.lines.some((l) => l.dropship)

  const save = async (): Promise<void> => {
    if (changed.length === 0) return
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
          ...(l.id in sources ? { sourcePoId: sources[l.id] || null } : {})
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
            disabled={changed.length === 0 || busy}
            loading={busy}
            onClick={() => void save()}
          >
            {changed.length === 0
              ? 'Nothing changed'
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
        A line that DOES come off a shelf may also say <b>whose cases</b> it takes — a roadshow
        week, or any purchase order still holding that product. That decides where its{' '}
        <b>cost</b> comes from, and it shows up on that purchase order&rsquo;s history as well as
        this sale&rsquo;s.
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
                  {l.productId ? (
                    <DestinationSelect
                      className={`po-route-party${dest ? '' : ' is-inherited'}`}
                      ariaLabel={`Fulfilled from, for ${l.item}`}
                      value={dest || null}
                      blankLabel={`Same as order (${headerLocation})`}
                      drop={drop}
                      onChange={(d) => setEdits((prev) => ({ ...prev, [l.id]: d ?? '' }))}
                    />
                  ) : (
                    <span className="muted">not a stocked item</span>
                  )}
                  {/* WHOSE CASES, once it is established that it takes any.
                      
                      The second question, and only ever asked of a line that
                      comes off a shelf: a dropship line went supplier-to-buyer
                      and never sat on one, so there is no order's stock to sell
                      out of. The same picker the invoice form shows on a draft,
                      answering the same question — it renders nothing at all
                      unless some purchase order actually holds this product on
                      this shelf, which is almost never. */}
                  {l.productId && !drop && (
                    <SourceOrderPicker
                      productId={l.productId}
                      productName={l.item}
                      location={(dest ?? '').trim() || headerLocation}
                      quantity={l.quantity}
                      value={l.id in sources ? sources[l.id] : (l.sourcePoId ?? '')}
                      onChange={(poId) => setSources((prev) => ({ ...prev, [l.id]: poId }))}
                    />
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
          does not try — the buyer&rsquo;s document stays exactly as it was sent. What changes is
          your inventory, your cost of goods on this sale, and what the board says about where the
          goods are coming from.
        </span>
      </p>
    </Modal>
  )
}
