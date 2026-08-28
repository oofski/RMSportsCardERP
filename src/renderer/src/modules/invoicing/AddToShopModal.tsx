import { useState } from 'react'
import type { InventoryProduct, PurchaseOrder } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'
import { POCatalogTypeahead } from './POCatalogTypeahead'

/**
 * PUT SOMETHING YOU JUST BOUGHT ONTO A SHOP'S SHELF.
 *
 * One product, one quantity, one price. The whole form, because at a roadshow
 * that is the whole act: somebody is standing at a counter with a case in their
 * hands and a phone in the other, and every extra field is a field they fill in
 * wrong or skip.
 *
 * ## What it does underneath, and why none of it is on screen
 *
 * It puts the line on the shop's OPEN TAB, opening one if the week has not
 * started yet — and because a tab checks its cases in as they are typed (see
 * takeTabDelivery), the stock is on the shelf before this modal closes. So the
 * three decisions the old path asked for are all gone:
 *
 *   · WHICH SUPPLIER — the shop is the supplier, and it came from the column.
 *   · WHICH DESTINATION — the shop is the shelf, and it came from the column.
 *   · IS THIS A ROADSHOW — you pressed a button on a roadshow column.
 *
 * The one that mattered was the first. The supplier was free text and it BECAME
 * the shelf, so a spelling somebody improvised on a Tuesday opened a second
 * shelf holding half the week's stock. Nothing is typed here, so nothing can be.
 *
 * ## The price may be left blank
 *
 * "We don't always know in the moment" is the case the whole tab feature was
 * built around, and the line records at no price until somebody fills it in on
 * the purchase order. Blank is NOT zero: zero is an answer — the shop gave it to
 * us — and a case booked at nothing would understate a week's cost of goods for
 * ever. See `pricePending`.
 */
export function AddToShopModal({
  shop,
  tab,
  onClose,
  onAdded
}: {
  shop: string
  /** The shop's open tab, or null when this is the first buy of the week. */
  tab: PurchaseOrder | null
  onClose: () => void
  /** Called with the sentence to toast, once the shelf actually holds it. */
  onAdded: (message: string) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [product, setProduct] = useState<InventoryProduct | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)

  const qty = Math.round(Number(quantity))
  const qtyOk = Number.isFinite(qty) && qty > 0
  // Blank is a real answer — "nobody has said yet" — and only a typed value has
  // to parse. See the note above on why blank is not zero.
  const typed = price.trim()
  const priceNum = Number(typed.replace(/[$,\s]/g, ''))
  const priceOk = typed === '' || (Number.isFinite(priceNum) && priceNum >= 0)

  const save = async (): Promise<void> => {
    if (!product || !qtyOk || !priceOk) return
    setBusy(true)
    try {
      const line = {
        productId: product.id,
        quantity: qty,
        unitPrice: typed === '' ? 0 : priceNum,
        pricePending: typed === ''
      }
      /**
       * ADD TO THE WEEK'S TAB, or open the week.
       *
       * Reusing the open tab is what keeps a week on ONE bill — the shop is
       * expecting one payment, and four separate orders would be four amounts
       * owed to somebody who thinks they are owed one.
       */
      const res = tab
        ? await api.purchaseOrders.addLines(tab.id, [line])
        : await api.purchaseOrders.create({
            supplier: shop,
            // Left unstated on purpose. An ongoing order resolves its own
            // destination to the shop — see createPurchaseOrder — so naming it
            // here would be a second place that has to agree with the first.
            location: '',
            ongoing: true,
            lines: [line]
          })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not add that.')
        return
      }
      const unit = qty === 1 ? '' : 's'
      await onAdded(
        `${qty} × ${product.name} at ${shop}${typed === '' ? ' — price still to come' : ''}` +
          (qty === 1 ? '' : ` (${qty} unit${unit})`)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Add to ${shop}`}
      subtitle={
        tab
          ? `Goes onto ${tab.poNumber}, this week's open tab — one bill for the shop.`
          : 'Opens this shop’s tab for the week. Everything else you buy goes on the same one.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Plus"
            onClick={save}
            disabled={busy || !product || !qtyOk || !priceOk}
            title={
              !product
                ? 'Pick a product first'
                : !qtyOk
                  ? 'How many did you buy?'
                  : !priceOk
                    ? 'That is not a price'
                    : `Put it on the shelf at ${shop}`
            }
          >
            {busy ? 'Adding…' : 'Add to shelf'}
          </Button>
        </>
      }
    >
      {product ? (
        <div className="rs-picked">
          <div className="rs-picked-name">
            <b>{product.name}</b>
            {product.sku && <span className="mono">{product.sku}</span>}
          </div>
          <button type="button" className="rs-picked-clear" onClick={() => setProduct(null)}>
            Change
          </button>
        </div>
      ) : (
        <POCatalogTypeahead
          onSelect={setProduct}
          label="What did you buy?"
          hint="Search the catalog by name, SKU or UPC"
        />
      )}

      <div className="rs-add-row">
        <Field label="How many">
          <Input
            value={quantity}
            inputMode="numeric"
            onChange={(e) => setQuantity(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Field>
        {/* THE PRICE IS OPTIONAL AND SAYS SO. The hint is the whole rule: an
            empty box is "not known yet", not "free", and the difference is a
            week's cost of goods. */}
        <Field label="What it cost, each" hint="Leave blank if you do not know yet">
          <Input
            value={price}
            inputMode="decimal"
            placeholder="—"
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}
