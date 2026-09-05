import { useEffect, useMemo, useState } from 'react'
import type { ShopBuy, ShopSale, ShopShelfRow } from '@shared/availability'
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
 *
 * ## AND IT IS WHERE A MISTAKE IS UNDONE
 *
 * The owner: "need a delete button for items added on the thing." Every row is a
 * receipt, so every row can be taken back — which is the only place in the app
 * that can, because `removePurchaseOrderLine` refuses anything already checked
 * in and a tab line always is. See removeTabLine.
 *
 * The button is offered only on a row that can actually go: the week still open,
 * and every unit still standing. A row with any of it sold is left with the
 * reason on the button rather than no button at all — "why can I not delete
 * this" is a question the screen should answer, and a control that silently
 * vanishes answers nothing.
 */
export function ShopBuysPanel({
  shop,
  product,
  onClose,
  onMoved,
  onRemoved
}: {
  shop: string
  product: ShopShelfRow
  onClose: () => void
  /** Called once the shelf has actually changed, with the sentence to toast. */
  onMoved?: (message: string) => void | Promise<void>
  /** Called once a line has been taken back off the tab. */
  onRemoved?: (message: string) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [buys, setBuys] = useState<ShopBuy[] | null>(null)
  const [sales, setSales] = useState<ShopSale[]>([])
  const [qty, setQty] = useState(String(product.here))
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
    // WHERE IT WENT, beside where it came from. Fetched separately rather than
    // folded into shopBuys because they are different questions about different
    // documents, and a receipt does not know which sale later drew on it.
    void api.inventory
      .shopSales(shop, product.productId)
      .then((r) => alive && setSales(r))
      .catch(() => alive && setSales([]))
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
    product.here
  )

  /**
   * Why this receipt cannot be taken back, or null when it can.
   *
   * Asked here so the button can SAY the reason rather than be missing. The
   * store checks again — see removeTabLine — because this row is as old as the
   * last refresh and somebody else may have sold it since.
   */
  const undoRefusal = (b: ShopBuy): string | null => {
    if (!b.tabOpen) {
      return `${b.poNumber} has been settled, so what was on it is the record of a bill that was paid.`
    }
    if (b.remaining < b.quantity) {
      const gone = b.quantity - b.remaining
      return `${gone} of these ${gone === 1 ? 'has' : 'have'} already gone, so this cannot be un-bought. Put the real price on the line instead.`
    }
    return null
  }

  const undo = async (b: ShopBuy): Promise<void> => {
    if (undoRefusal(b)) return
    setBusy(true)
    try {
      const res = await api.purchaseOrders.removeTabLine(b.poId, b.poLineId)
      if (!res.ok) {
        toast.error(res.error ?? 'That could not be removed.')
        return
      }
      const said = `${b.quantity} × ${product.name} taken back off ${b.poNumber}`
      if (onRemoved) await onRemoved(said)
      else toast.success(said)
      onClose()
    } finally {
      setBusy(false)
    }
  }

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
      /* ALL THREE FIGURES, because "3 standing" alone cannot tell a quiet week
         from a busy one — and a row reachable only because it SOLD would have
         read "0 standing" and looked like a mistake. */
      subtitle={[
        `${product.here} standing at ${shop}`,
        product.sold > 0 ? `${product.sold} sold from here` : '',
        product.movedOn > 0 ? `${product.movedOn} moved on` : ''
      ]
        .filter(Boolean)
        .join(' · ')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
          {product.here > 0 && (
            <Button
              variant="primary"
              icon="Truck"
              onClick={move}
              disabled={busy || !!refusal}
              title={refusal ?? `Move ${wanted} to ${to}, cost and all`}
            >
              {busy ? 'Moving…' : `Move to ${to}`}
            </Button>
          )}
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
                {/* THE UNDO. Shown on every row and disabled with its reason
                    rather than hidden, so "why can I not remove this" is
                    answered by the control itself. */}
                <button
                  type="button"
                  className="sb-undo"
                  onClick={() => void undo(b)}
                  disabled={busy || !!undoRefusal(b)}
                  aria-label={`Take these back off ${b.poNumber}`}
                  title={
                    undoRefusal(b) ??
                    `Take these ${b.quantity} back off ${b.poNumber} — the shelf goes back as it was`
                  }
                >
                  <Icon name="Trash2" size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* WHERE IT WENT. The owner: "let me click on it if it was sold and then
          it tells me which PO and SO it was attached to." The purchase orders
          are the rows above; these are the sales, and between them a case that
          arrived and left in one afternoon can be followed end to end. */}
      {sales.length > 0 && (
        <div className="sb-sold">
          <div className="sb-sold-head">
            <Icon name="Send" size={13} />
            Sold from {shop}
          </div>
          <ul className="sb-sold-list">
            {sales.map((sale) => (
              <li className="sb-sold-row" key={sale.invoiceId}>
                <span className="sb-sold-when">{formatDate(sale.soldOn)}</span>
                <span className="sb-sold-so mono">{sale.invoiceNumber || 'draft'}</span>
                <span className="sb-sold-who">{sale.customerName || '—'}</span>
                <span className="sb-sold-qty">{sale.quantity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* BELOW the history, because the history is what the decision is made
          on. The note says the one thing somebody would otherwise have to
          trust: the money comes with the boxes.

          HIDDEN ENTIRELY when the shelf is empty. A row reachable only because
          it SOLD has nothing to move, and offering the box anyway put a warning
          triangle and "how many are you moving?" on a panel whose answer is
          none — a control that can only ever refuse is worse than no control. */}
      {product.here > 0 && (
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
      )}
    </Modal>
  )
}
