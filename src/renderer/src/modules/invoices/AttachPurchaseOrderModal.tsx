import { useEffect, useState } from 'react'
import type { Invoice } from '@shared/invoices'
import type { LinkablePurchaseOrder } from '@shared/orders'
import { linkPurchaseRefusal, linkableOrder, linkableOrderLabel } from '@shared/orders'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

/**
 * ATTACH A SALE TO A PURCHASE ORDER THAT ALREADY EXISTS.
 *
 * ## The hole this fills
 *
 * Both dropship flows could only ever RAISE the missing document. Sell first and
 * `DropshipPurchaseStep` offers to write the purchase; buy first and
 * `DropshipSaleStep` offers to write the sale. Neither could say "I already made
 * that one" — `linkDropshipPair` had exactly two callers and both fired in the
 * moment after a brand-new document was created.
 *
 * The app said so in its own words and could not act on them.
 * DropshipPurchaseStep's footnote tells the operator to choose "Not now" if the
 * goods were bought already, and the buy-side interstitial promises the sale can
 * be raised "from the Sales Orders board whenever you like, and link it there".
 * It could not be.
 *
 * The owner's case, in his words: "made an invoice for a ton of stuff going to
 * one buyer, two of the cases are being drop shipped, I made a PO for the two
 * drop ship sources, didn't make any new SOs — can I make any changes on the SOs
 * page to show the two dropships without changing the invoice or invoicing
 * again?"
 *
 * ## It touches the LINK and nothing else
 *
 * No line, no quantity, no price, no total, and nothing in QuickBooks. That is
 * what makes it reachable on an invoice that has already been sent — the two
 * documents stay exactly as they were and gain a note that they are one deal.
 *
 * The consequence is worth stating on the screen rather than leaving somebody to
 * discover it: `salesOrderKindOf` reads a linked sale as "Part drop" even when
 * every line still comes off a shelf, deliberately — the link is a statement
 * about the DEAL, not about the routing of the lines. What it does NOT do is
 * hand stock back. If those cases were drawn off a shelf when the order was
 * written, they are still off it, and that is a separate correction.
 */
export function AttachPurchaseOrderModal({
  invoice,
  onClose,
  onDone
}: {
  invoice: Invoice
  onClose: () => void
  onDone: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [orders, setOrders] = useState<LinkablePurchaseOrder[] | null>(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void api.orders
      .linkablePos(invoice.id)
      .then((res) => {
        if (alive) setOrders(res.ok && res.data ? res.data : [])
      })
      .catch(() => {
        if (alive) setOrders([])
      })
    return () => {
      alive = false
    }
  }, [invoice.id])

  /**
   * The supplier the sale's own lines name, when they name one.
   *
   * Used only to RANK, never to filter — see `linkableOrder`. A sale whose lines
   * name nobody is precisely the one that sent somebody here, and hiding
   * everything on a mismatch would hand it an empty picker.
   */
  const suppliers = invoice.dropSupplier ? [invoice.dropSupplier] : []
  const offers = linkableOrder(orders ?? [], suppliers)
  const picked = offers.find((o) => o.poId === chosen) ?? null
  const problem = linkPurchaseRefusal(picked, invoice)
  const soLabel = invoice.invoiceNumber ? `Sales order ${invoice.invoiceNumber}` : 'This sales order'

  const attach = async (): Promise<void> => {
    if (!picked || problem) return
    setBusy(true)
    try {
      const res = await api.orders.linkDropship(picked.poId, invoice.id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not attach that purchase order.')
        return
      }
      toast.success(`${picked.poNumber} and ${invoice.invoiceNumber || 'this sale'} are linked.`)
      await onDone()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Attach a purchase order"
      subtitle={`${soLabel} — the purchase that supplied it`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Link"
            disabled={!picked || !!problem || busy}
            loading={busy}
            onClick={() => void attach()}
          >
            Attach it
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">
        This records that <b>{soLabel.toLowerCase()}</b> and a purchase order are{' '}
        <b>one deal</b>. It changes <b>no line, no price and no total</b>, and it does not touch
        the copy in QuickBooks — which is why it works on an order that has already been sent.
      </p>

      {orders === null ? (
        <p className="fin-confirm-lead">Reading your purchase orders…</p>
      ) : offers.length === 0 ? (
        <p className="fin-confirm-lead">
          There are <b>no purchase orders to attach</b> — every one you have is cancelled, or
          there are none yet. Raise it from the Purchase Orders board and it will be here.
        </p>
      ) : (
        <label className="field">
          <span>Purchase order</span>
          <select
            className="select"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            aria-label="Which purchase order supplied this sale"
          >
            {/* NAMED, not blank. An empty first option reads as "not loaded yet";
                this one says a choice has not been made, which is true. */}
            <option value="">Choose the purchase order…</option>
            {offers.map((o) => (
              <option key={o.poId} value={o.poId}>
                {linkableOrderLabel(o)}
                {o.linkedHere ? ' · already attached' : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {picked && (
        <p className="fin-confirm-lead">
          <b>{picked.poNumber}</b>
          {picked.supplier ? (
            <>
              {' '}
              buys from <b>{picked.supplier}</b>
            </>
          ) : (
            <> names no supplier</>
          )}
          {picked.destination ? (
            <>
              , shipping to <b>{picked.destination}</b>
            </>
          ) : null}{' '}
          — {picked.unitsOrdered} unit{picked.unitsOrdered === 1 ? '' : 's'} for{' '}
          <b>{formatMoney(picked.total)}</b>.
          {/* A PURCHASE MAY SUPPLY SEVERAL SALES — that is what multi-shipment is
              — so this is said rather than refused. Somebody attaching to an
              order that already feeds three other buyers should know before
              pressing, not afterwards. */}
          {picked.otherSales > 0 && (
            <>
              {' '}
              It already supplies <b>{picked.otherSales}</b> other sales order
              {picked.otherSales === 1 ? '' : 's'}, which is allowed — one purchase can be split
              across several buyers.
            </>
          )}
        </p>
      )}

      {/* The same warn style the sales-order line uses for a refusal, rather
          than a new class with no rule behind it. */}
      {problem && <p className="so-source-warn">{problem}</p>}

      <p className="ds-note">
        <Icon name="Info" size={14} />
        <span>
          The two orders stay <b>separate documents</b>. Attaching them only records that they are
          one deal, on both of their histories — and marks this sale <b>Part drop</b> on the board.
          It does <b>not</b> put stock back on a shelf: if these goods were written as coming off
          your own shelf, they are still drawn down, and that is a separate correction.
        </span>
      </p>
    </Modal>
  )
}
