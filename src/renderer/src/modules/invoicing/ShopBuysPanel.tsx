import { useEffect, useState } from 'react'
import type { ShopBuy, StockAtLocationRow } from '@shared/availability'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader, Modal } from '../../components/ui'
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
 */
export function ShopBuysPanel({
  shop,
  product,
  onClose
}: {
  shop: string
  product: StockAtLocationRow
  onClose: () => void
}): JSX.Element {
  const [buys, setBuys] = useState<ShopBuy[] | null>(null)

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

  return (
    <Modal
      title={product.name}
      subtitle={`${product.quantity} standing at ${shop}`}
      onClose={onClose}
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
    </Modal>
  )
}
