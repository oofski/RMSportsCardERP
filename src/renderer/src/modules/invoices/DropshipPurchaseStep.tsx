import { useState } from 'react'
import type { InvoiceDetail } from '@shared/invoices'
import type { PurchaseOrderDetail } from '@shared/types'
import { dropshipPurchaseFromSale, dropshipSuppliersOf } from '@shared/orders'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { CreatePurchaseOrderModal } from '../invoicing/CreatePurchaseOrderModal'

/**
 * The other half of a dropship, coming the other way: the purchase that
 * supplies a sale.
 *
 * ## The promise this keeps
 *
 * The buy-side interstitial already tells people they can start from the other
 * end — "you can raise it from the Sales Orders board whenever you like, and
 * link it there". They could not. `linkDropship` had exactly one caller, on the
 * purchase side, so a dropship begun as a sale left the buyer billed and the
 * supplier never ordered from, with nothing on either board saying the pair was
 * half-written. This is the missing half.
 *
 * Everything about the shape is the mirror of DropshipSaleStep, deliberately:
 * an interstitial rather than a form that opens by itself, a plain way to
 * decline, and the two documents kept separate because they are commitments to
 * two different people. Read that file for why.
 *
 * ## What it refuses to guess
 *
 * TWO SUPPLIERS IS TWO PURCHASE ORDERS. The sale's dropship lines can name
 * different suppliers, and one order to one of them for all of it would put
 * goods on a supplier who never agreed to ship them. A line with no supplier
 * named counts as a separate unknown rather than as agreement with the rest —
 * it is precisely the line somebody has not finished.
 *
 * FREEHAND LINES CANNOT BE BOUGHT. A purchase order line is a catalog product,
 * because receiving one puts units on a shelf against a cost layer. A sale may
 * carry a typed one-off, and those are named and left out rather than silently
 * dropped — a purchase raised for less than was sold is the kind of error that
 * surfaces as a short delivery weeks later.
 */
export function DropshipPurchaseStep({
  invoice,
  onClose,
  onDone
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onDone: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [buying, setBuying] = useState(false)

  const dropLines = invoice.lines.filter((l) => l.dropship)
  const suppliers = dropshipSuppliersOf(dropLines)
  const supplier = suppliers.length === 1 && suppliers[0] !== '(not named)' ? suppliers[0] : null
  const splitAcrossSuppliers = suppliers.length > 1
  const supplierUnnamed = suppliers.length === 1 && suppliers[0] === '(not named)'

  // Only what a purchase order can actually carry. Counted both ways so the
  // screen can say what it is leaving behind.
  const buyable = dropLines.filter((l) => !!l.productId)
  const freehand = dropLines.filter((l) => !l.productId)
  const dropUnits = buyable.reduce((sum, l) => sum + l.quantity, 0)

  if (buying && supplier) {
    return (
      <CreatePurchaseOrderModal
        prefill={dropshipPurchaseFromSale({
          supplier,
          customerName: invoice.customerName,
          lines: buyable.map((l) => ({
            productId: l.productId as string,
            item: l.item,
            sku: l.sku,
            quantity: l.quantity
          }))
        })}
        onClose={onClose}
        onSaved={onDone}
        onCreated={async (po: PurchaseOrderDetail) => {
          const res = await api.orders.linkDropship(po.id, invoice.id)
          // A FAILED LINK IS NOT A FAILED PURCHASE. Both documents exist and
          // both are correct; what is missing is the note that they are one
          // deal. The mirror of the same decision on the buy side.
          if (!res.ok) {
            toast.error(
              `${po.poNumber} saved, but it could not be linked to ` +
                `${invoice.invoiceNumber || 'the sales order'} — ${res.error ?? 'unknown reason'}.`
            )
            return
          }
          toast.success(`${po.poNumber} and ${invoice.invoiceNumber || 'the sale'} are linked.`)
        }}
      />
    )
  }

  const soLabel = invoice.invoiceNumber ? `Sales order ${invoice.invoiceNumber}` : 'This sales order'

  return (
    <Modal
      title="Now buy the goods"
      subtitle={`${soLabel} is raised — this is the other half of it`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          {!!supplier && buyable.length > 0 && (
            <Button variant="primary" icon="ClipboardList" onClick={() => setBuying(true)}>
              Write the purchase order
            </Button>
          )}
        </>
      }
    >
      {/* THE WAYS THIS CANNOT PROCEED, and none of them is an error worth a red
          banner — each is an ordinary shape of order that simply is not one
          purchase. Saying which, and offering the door out, beats an order
          placed with the wrong supplier for the wrong goods. */}
      {splitAcrossSuppliers ? (
        <p className="fin-confirm-lead">
          The dropshipped lines on <b>{soLabel.toLowerCase()}</b> come from{' '}
          <b>{suppliers.length} different suppliers</b> — {suppliers.join(', ')}. That is{' '}
          {suppliers.length} separate purchase orders, so it cannot be bought as one. Raise each of
          them from the Purchase Orders board.
        </p>
      ) : supplierUnnamed ? (
        <p className="fin-confirm-lead">
          Those lines do not say <b>who is shipping them</b>. Set a supplier on each dropshipped
          line and this can raise the purchase order for you — without it there is nobody to place
          the order with.
        </p>
      ) : !supplier || buyable.length === 0 ? (
        <p className="fin-confirm-lead">
          There is nothing here to buy. Every line on <b>{soLabel.toLowerCase()}</b> is either
          coming off one of your own shelves or is a one-off that is not a catalog product.
        </p>
      ) : (
        <>
          <p className="fin-confirm-lead">
            <b>{soLabel}</b> sells {invoice.lines.length} line
            {invoice.lines.length === 1 ? '' : 's'} to <b>{invoice.customerName}</b> for{' '}
            <b>{formatMoney(invoice.total)}</b>. <b>{dropUnits}</b> of those units ship straight
            from <b>{supplier}</b> and never touch a shelf here — so they have to be bought.
          </p>
          <p className="fin-confirm-lead">
            The purchase order buys <b>those {dropUnits}</b> from <b>{supplier}</b> at{' '}
            <b>your cost</b>, shipping direct to <b>{invoice.customerName}</b>. It comes across
            with the prices <b>blank</b>, because what you pay {supplier} is not what{' '}
            {invoice.customerName} pays you — that is the one thing this cannot work out for you.
          </p>
          {freehand.length > 0 && (
            /* NAMED, NOT SILENTLY DROPPED. A purchase raised for fewer lines
               than were sold turns up as a short delivery weeks later, and the
               only moment anybody can catch it is this one. */
            <p className="fin-confirm-lead">
              <b>
                {freehand.length} line{freehand.length === 1 ? '' : 's'} will not be on it
              </b>{' '}
              — {freehand.map((l) => l.item).join(', ')}. A purchase order line has to be a catalog
              product, and {freehand.length === 1 ? 'that one was' : 'those were'} typed in by hand.
              Order {freehand.length === 1 ? 'it' : 'them'} separately, or add{' '}
              {freehand.length === 1 ? 'it' : 'them'} to the catalog first.
            </p>
          )}
        </>
      )}
      <p className="ds-note">
        <Icon name="Info" size={14} />
        <span>
          The two orders stay <b>separate documents</b> — you still owe {supplier ?? 'the supplier'}{' '}
          for what they ship even if the buyer falls through. Linking them only records that they
          are one deal, on both of their histories. Choose <b>Not now</b> if this was bought
          already, or is going on a standing order.
        </span>
      </p>
    </Modal>
  )
}
