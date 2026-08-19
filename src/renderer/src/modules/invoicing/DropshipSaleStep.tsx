import { useState } from 'react'
import type { InvoiceCustomer, InvoiceDetail } from '@shared/invoices'
import type { PurchaseOrderDetail } from '@shared/types'
import { dropshipSaleFromPurchase } from '@shared/orders'
import { destinationHoldsStock, destinationSummary } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { CreateInvoiceModal } from '../invoices/CreateInvoiceModal'

/**
 * The second half of a dropship: the sale that pays for the purchase.
 *
 * ## Why there are two screens and not one
 *
 * Because there are two documents, and they are commitments to two different
 * people. We owe supplier A for goods at price A; buyer B owes us for the same
 * goods at price B. Cancelling one does not cancel the other — a supplier is
 * still owed for boxes they shipped even if the buyer falls through — and
 * collapsing them into one form would have to invent an answer for what happens
 * to the other half every time either one moves.
 *
 * So the purchase order is written and saved first, on its own, by the ordinary
 * form. Then this appears with everything it can already work out filled in, and
 * the only thing left to type is the one thing the purchase could not know:
 * price B.
 *
 * ## Two records, two logs
 *
 * That was the explicit requirement, and it is what `linkDropship` does: the
 * purchase order's history gains a line saying what it was sold on as, and the
 * sales order's gains one saying what it was bought as. Each reads correctly to
 * somebody who only ever opens one of them.
 *
 * ## An interstitial, not an automatic jump
 *
 * A form that opened by itself the instant a purchase order saved would be a
 * screen appearing under somebody's cursor after they pressed a button that said
 * "Create". This says what it is about to do and lets them decline — plenty of
 * dropships are billed later, or on a consolidated invoice, or not through this
 * app at all.
 */
export function DropshipSaleStep({
  po,
  onClose,
  onDone
}: {
  po: PurchaseOrderDetail
  onClose: () => void
  onDone: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [selling, setSelling] = useState(false)
  const [customers, setCustomers] = useState<InvoiceCustomer[]>([])
  const [nextNumber, setNextNumber] = useState('')

  /**
   * Where the goods went, which on a dropship is the buyer.
   *
   * A mixed order ships some units to a shelf and some to a third party, so it
   * has more than one destination. The BUYER is whichever of them is not ours,
   * and `destinationSummary` already words that for a screen — but on a mixed
   * order it can genuinely be several, and picking one would be guessing.
   */
  const dropDestinations = po.lines
    .flatMap((l) =>
      l.allocations.length > 0
        ? l.allocations.map((a) => a.destination)
        : [l.destination ?? po.location]
    )
    // destinationHoldsStock is the ONE place that decides what is a shelf. A
    // second test spelled out here is how a screen comes to disagree with the
    // stock code about which orders are dropships.
    .filter((d): d is string => !!d && !destinationHoldsStock(d))
  const buyer = destinationSummary([...new Set(dropDestinations)]) || po.location

  const begin = async (): Promise<void> => {
    // Fetched at the moment the form opens rather than held: the number is a
    // SUGGESTION computed from what exists now, and one read at module load
    // would hand the same number to two orders raised in one sitting.
    const [people, suggested] = await Promise.all([
      api.invoices.customers(),
      api.invoices.nextNumber()
    ])
    setCustomers(people)
    setNextNumber(suggested)
    setSelling(true)
  }

  if (selling) {
    return (
      <CreateInvoiceModal
        invoice={null}
        prefill={dropshipSaleFromPurchase({
          supplier: po.supplier,
          destination: buyer,
          invoiceDate: new Date().toISOString().slice(0, 10),
          lines: po.lines.map((l) => ({
            item: l.productName ?? 'Item',
            productId: l.productId,
            sku: l.sku ?? null,
            quantity: l.quantity
          }))
        })}
        customers={customers}
        nextNumber={nextNumber}
        thumbnails={{}}
        onClose={onClose}
        onSaved={onDone}
        onSavedInvoice={async (saved: InvoiceDetail) => {
          const res = await api.orders.linkDropship(po.id, saved.id)
          // A FAILED LINK IS NOT A FAILED SALE. Both documents exist and both
          // are correct; what is missing is the note that they are the same
          // deal, and saying so is better than implying the invoice did not
          // save.
          if (!res.ok) {
            toast.error(
              `${saved.invoiceNumber || 'The sales order'} saved, but it could not be linked to ` +
                `${po.poNumber} — ${res.error ?? 'unknown reason'}.`
            )
            return
          }
          toast.success(`${po.poNumber} and ${saved.invoiceNumber || 'the sale'} are linked.`)
        }}
        onOpenQuickBooks={() => undefined}
      />
    )
  }

  return (
    <Modal
      title="Now bill the buyer"
      subtitle={`${po.poNumber} is raised — this is the other half of it`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" icon="ReceiptText" onClick={() => void begin()}>
            Write the sales order
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">
        <b>{po.poNumber}</b> buys {po.orderedUnits} unit{po.orderedUnits === 1 ? '' : 's'} from{' '}
        <b>{po.supplier ?? 'a supplier'}</b> for <b>{formatMoney(po.total)}</b>, shipping straight
        to <b>{buyer}</b>. None of it touches a shelf here.
      </p>
      <p className="fin-confirm-lead">
        The sales order bills <b>{buyer}</b> for the same goods at <b>your</b> price. The lines
        come across already marked as shipped by {po.supplier ?? 'the supplier'}, so no stock
        moves — <b>the only thing to type is what you are selling it for.</b>
      </p>
      <p className="ds-note">
        <Icon name="Info" size={14} />
        <span>
          Saving the sales order <b>posts it to QuickBooks</b>, the same as any other. If this one
          is going on a consolidated invoice later, choose <b>Not now</b> — you can raise it from
          the Sales Orders board whenever you like, and link it there.
        </span>
      </p>
    </Modal>
  )
}
