import { useState } from 'react'
import type { InvoiceCustomer, InvoiceDetail } from '@shared/invoices'
import type { PurchaseOrderDetail } from '@shared/types'
import { dropshipSaleFromPurchase } from '@shared/orders'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { isMultiShipment } from '@shared/multiShipment'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { CreateInvoiceModal } from '../invoices/CreateInvoiceModal'
import { MultiShipmentSplit } from './MultiShipmentSplit'

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
  /**
   * ONLY THE UNITS THAT ACTUALLY LEFT THE BUILDING, at the quantity that left.
   *
   * ## The bug this shape exists to prevent
   *
   * A MIXED order — say ten units onto the RM shelf and five straight to a shop
   * — was previously prefilled from `po.lines` at the LINE's full quantity, with
   * every line stamped as a dropship. Two things went wrong at once and both
   * cost money: the buyer was invoiced for fifteen units when they are receiving
   * five, and the ten that really did come here were marked as never having
   * touched a shelf, so the sale drew no stock and the shelf stayed up for units
   * that had been sold.
   *
   * So the prefill is built from ALLOCATIONS — the actual slices of each line
   * and where each slice went — and only the slices whose destination is not one
   * of ours. An unsplit line has no allocations and is treated as one slice of
   * its whole quantity, which is what it is.
   *
   * `destinationHoldsStock` is the ONE place that decides what counts as a
   * shelf. Spelling that test out a second time here is how a screen comes to
   * disagree with the stock code about which units are a dropship.
   */
  const dropSlices = po.lines.flatMap((line, li) => {
    const slices =
      line.allocations.length > 0
        ? line.allocations.map((a, ai) => ({
            key: `a-${li}-${ai}`,
            destination: a.destination,
            quantity: a.quantity
          }))
        : [{ key: `l-${li}`, destination: line.destination ?? po.location, quantity: line.quantity }]
    return slices
      .filter((s) => !!s.destination && !destinationHoldsStock(s.destination))
      .map((s) => ({
        key: s.key,
        destination: s.destination as string,
        quantity: s.quantity,
        item: line.productName ?? 'Item',
        productId: line.productId,
        sku: line.sku ?? null
      }))
  })

  /**
   * THE SENTINEL IS NOT A BUYER. A slice reading MULTI_SHIPMENT is a slice whose
   * buyer has not been named yet — see @shared/multiShipment — so it is excluded
   * from the buyer list rather than counted as somebody called that. Left in, it
   * would reach `customerName` and become a CUSTOMER OF THAT NAME in this app,
   * and then an offer to create one in the owner's real QuickBooks books.
   *
   * That is the same failure `destinationSummary` would cause by returning the
   * literal string "2 destinations", which is why this list is built from the
   * slices rather than from that.
   */
  const buyers = [...new Set(dropSlices.map((s) => s.destination).filter((d) => !isMultiShipment(d)))]
  const unassigned = dropSlices.some((s) => isMultiShipment(s.destination))
  /**
   * ONE BUYER AND EVERY UNIT SPOKEN FOR — the ordinary dropship, billed as one
   * sales order by the flow that has always handled it.
   *
   * Anything else goes to MultiShipmentSplit: several buyers named on the order,
   * or buyers still to name, or both at once on a purchase that was partly
   * assigned when it was raised. All three are one act of dividing units between
   * people, and one screen does it.
   */
  const buyer = buyers.length === 1 && !unassigned ? buyers[0] : null
  const needsSplit = dropSlices.length > 0 && !buyer
  const dropUnits = dropSlices.reduce((sum, s) => sum + s.quantity, 0)

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

  // One purchase going out to several people. Handed the slices already
  // flattened, so that module never has to know how a purchase order stores its
  // routing — and a slice that already names a buyer arrives pre-filled rather
  // than being asked about again.
  if (needsSplit) {
    return (
      <MultiShipmentSplit
        poId={po.id}
        poNumber={po.poNumber}
        supplier={po.supplier}
        sources={dropSlices.map((s) => ({
          key: s.key,
          productId: s.productId,
          item: s.item,
          sku: s.sku,
          quantity: s.quantity,
          buyer: isMultiShipment(s.destination) ? null : s.destination
        }))}
        onClose={onClose}
        onDone={onDone}
      />
    )
  }

  if (selling) {
    return (
      <CreateInvoiceModal
        invoice={null}
        prefill={dropshipSaleFromPurchase({
          supplier: po.supplier,
          destination: buyer as string,
          invoiceDate: new Date().toISOString().slice(0, 10),
          lines: dropSlices.map((s) => ({
            item: s.item,
            productId: s.productId,
            sku: s.sku,
            quantity: s.quantity
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
          {!!buyer && (
            <Button variant="primary" icon="ReceiptText" onClick={() => void begin()}>
              Write the sales order
            </Button>
          )}
        </>
      }
    >
      {/* ONE WAY THIS CANNOT PROCEED, and it is not an error worth a red banner
          — it is an ordinary purchase that simply has nothing to bill on.

          There used to be a second: a purchase going to several places was
          refused outright and the operator was sent to retype it N times. That
          case never reaches this body now — `needsSplit` catches it above and
          MultiShipmentSplit does the dividing. */}
      {!buyer ? (
        <p className="fin-confirm-lead">
          Every unit on <b>{po.poNumber}</b> is coming to one of your own shelves, so there is
          nothing here to bill on. Sell it from stock in the ordinary way when it arrives.
        </p>
      ) : (
        <>
          <p className="fin-confirm-lead">
            <b>{po.poNumber}</b> buys {po.orderedUnits} unit{po.orderedUnits === 1 ? '' : 's'} from{' '}
            <b>{po.supplier ?? 'a supplier'}</b> for <b>{formatMoney(po.total)}</b>.{' '}
            <b>{dropUnits}</b> of {po.orderedUnits === dropUnits ? 'them ship' : 'those ship'}{' '}
            straight to <b>{buyer}</b> and never touch a shelf here.
          </p>
          <p className="fin-confirm-lead">
            The sales order bills <b>{buyer}</b> for <b>those {dropUnits}</b> at <b>your</b> price
            — {po.orderedUnits === dropUnits
              ? 'the whole order'
              : `not the ${po.orderedUnits - dropUnits} coming to your own shelf, which you sell separately`}
            . The lines come across already marked as shipped by{' '}
            {po.supplier ?? 'the supplier'}, so <b>no stock moves for them</b>.
          </p>
          {/* THE ORDER IS NOT SEALED. It opens as an ordinary sales order form,
              so anything else going to the same buyer in the same box belongs on
              it — which is the common case, not an edge one. Said here because
              the previous wording ("the only thing to type is the price") read
              as a closed form and nobody looked for the search box. */}
          <p className="fin-confirm-lead">
            You can <b>add more lines</b> on the next screen — search your inventory the same way
            you do on a purchase order. Anything you add is <b>sold off your own shelf</b> and
            draws stock normally, so a dropship of {dropUnits} plus a few of your own goes out as
            one order to one buyer. Each line says where it is <b>fulfilled from</b>, and only the
            ones coming off a shelf move any stock.
          </p>
        </>
      )}
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
