import { useEffect, useMemo, useState } from 'react'
import type { ShopBuy, StockAtLocationRow } from '@shared/availability'
import { LOCATIONS } from '@shared/inventory'
import { isRoadshowLocation } from '@shared/roadshowTab'
import { moveRefusal } from '@shared/stockMove'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, Field, Input, Modal, Select } from '../../components/ui'
import { formatDate, formatMoney } from '../../lib/format'

/**
 * WHEN THESE WERE BOUGHT, AND ON WHICH ORDER.
 *
 * The owner: "the products in the roadshow tab should be more like smooth tiles
 * that I can click on and see dates at which I bought, and remember that each
 * time I add a product it is a PO number."
 *
 * A column says Kentucky is holding four. It cannot say they arrived on three
 * different days, on two different tabs, at two different prices — which is
 * exactly what somebody needs when they are settling a week up, or working out
 * what a case actually cost, or asking why a shelf has more than they
 * remember. Every one of those facts was already recorded; none of them had
 * anywhere to be read.
 *
 * ## One row per RECEIPT, not per order
 *
 * A tab takes a case on Tuesday and two more on Thursday: two acts of buying
 * against one bill, which is the shape of a roadshow week. Rolling them onto
 * the order would collapse the dates, and the dates are the thing being asked
 * for. The order number is on every row, so a week still reads as a week.
 *
 * ## What was bought, beside what is left
 *
 * A receipt of three with one remaining says the other two have gone. Showing
 * only what arrived would make the shelf look fuller than it is; showing only
 * what is left would lose the history. Both, and the row says which is which.
 *
 * ## A price nobody has entered says so
 *
 * Not $0.00. "We don't always know in the moment" is what the whole tab feature
 * exists for, and a zero printed here would be this screen quietly agreeing
 * that a case was free. See pricePending.
 *
 * ## AND IT IS WHERE YOU BRING THEM HOME
 *
 * The owner: "sometimes I want to be able to take things that I buy from
 * roadshow and move them out of roadshow inventory and then move it to be with
 * us." Here rather than on a screen of its own, because this is already the
 * panel somebody opens holding the question "what are these and where did they
 * come from" — and the answer to "should I drive them back" is the buying
 * history sitting directly above the box.
 *
 * It moves the COST LAYERS, not just the count. See @shared/stockMove for why
 * two hand adjustments would quietly re-value a $400 case, and why a case still
 * waiting on a price can be moved and priced afterwards.
 */
export function ShopBuysPanel({
  shop,
  product,
  onClose,
  onMoved
}: {
  shop: string
  product: StockAtLocationRow
  onClose: () => void
  /** Called once the shelf has actually changed, with the sentence to toast. */
  onMoved?: (message: string) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [buys, setBuys] = useState<ShopBuy[] | null>(null)
  const [qty, setQty] = useState(String(product.quantity))
  /**
   * HOME IS THE DEFAULT, and it is the only one that needs no thought.
   *
   * The ask was about bringing cases back, so the box opens on the first shelf
   * that is not a shop. Every other place is still offered — moving between two
   * roadshows is a real, if rarer, thing — but the common case is one press.
   */
  const homeShelves = useMemo(() => LOCATIONS.filter((l) => !isRoadshowLocation(l.id)), [])
  const [to, setTo] = useState(() => homeShelves[0]?.id ?? 'RM')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void api.inventory
      .shopBuys(shop, product.productId)
      .then((r) => alive && setBuys(r))
      .catch(() => alive && setBuys([]))
    return () => {
      alive = false
    }
  }, [shop, product.productId])

  const wanted = Math.round(Number(qty))
  // THE SAME RULE THE STORE ENFORCES, asked here so the button can explain
  // itself before it is pressed rather than after. The store asks again against
  // what the shelf actually holds, because this count is as old as the screen.
  const refusal = moveRefusal(
    { productId: product.productId, from: shop, to, quantity: wanted },
    product.quantity
  )

  const move = async (): Promise<void> => {
    if (refusal) return
    setBusy(true)
    try {
      const res = await api.inventory.moveStock({
        productId: product.productId,
        from: shop,
        to,
        quantity: wanted
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Those could not be moved.')
        return
      }
      const said = `${wanted} × ${product.name} moved from ${shop} to ${to}`
      if (onMoved) await onMoved(said)
      else toast.success(said)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={product.name}
      subtitle={`${product.quantity} standing at ${shop}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button
            variant="primary"
            icon="Truck"
            onClick={move}
            disabled={busy || !!refusal}
            title={refusal ?? `Move ${wanted} to ${to}, cost and all`}
          >
            {busy ? 'Moving…' : `Move to ${to}`}
          </Button>
        </>
      }
    >
      {buys === null ? (
        <CenterLoader />
      ) : buys.length === 0 ? (
        /**
         * Stock with no receipt behind it. Real, and worth saying plainly
         * rather than showing an empty box: an opening count, a transfer, or a
         * hand adjustment all put units on a shelf without a purchase order,
         * and none of them is a fault.
         */
        <p className="sb-none">
          Nothing here came in on a purchase order — these were counted in or moved here by hand,
          so there is no buying history to show.
        </p>
      ) : (
        <ul className="sb-list">
          {buys.map((b) => (
            <li className="sb-row" key={b.id}>
              <div className="sb-when">
                <span className="sb-date">{formatDate(b.boughtAt)}</span>
                {/* THE ORDER NUMBER, on every row. "Each time I add a product it
                    is a PO number" — this is where that number becomes
                    findable, so a case on this shelf can be traced to the bill
                    it belongs to. */}
                <span className="sb-po mono">{b.poNumber}</span>
              </div>
              <div className="sb-what">
                <span className="sb-qty">
                  <b>{b.quantity}</b> bought
                  {/* Only when they differ. "3 bought · 3 left" on every row is
                      noise; "3 bought · 1 left" is the whole story. */}
                  {b.remaining !== b.quantity && (
                    <span className="sb-left"> · {b.remaining} left</span>
                  )}
                </span>
                <span className={`sb-cost${b.unitCost === null ? ' is-pending' : ''}`}>
                  {b.unitCost === null ? 'price to come' : `${formatMoney(b.unitCost)} each`}
                </span>
              </div>
              <div className="sb-state">
                {b.settled ? (
                  <span className="sb-chip is-paid">
                    <Icon name="Check" size={11} />
                    paid
                  </span>
                ) : b.tabOpen ? (
                  <span className="sb-chip is-open">this week’s tab</span>
                ) : (
                  <span className="sb-chip">unpaid</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* BELOW the history, because the history is what the decision is made
          on. The note says the one thing somebody would otherwise have to
          trust: the money comes with the boxes. */}
      <div className="sb-move">
        <div className="sb-move-row">
          <Field label="How many">
            <Input
              value={qty}
              inputMode="numeric"
              onChange={(e) => setQty(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
          </Field>
          <Field label="Move them to">
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              {LOCATIONS.filter((l) => l.id !== shop).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className={`sb-move-note${refusal ? ' is-bad' : ''}`}>
          <Icon name={refusal ? 'AlertTriangle' : 'Info'} size={13} />
          {refusal ??
            'What they cost comes with them — the same figure, the same purchase order, ' +
              'and a price entered later still lands on them.'}
        </p>
      </div>
    </Modal>
  )
}
