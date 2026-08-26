import { useEffect, useMemo, useState } from 'react'
import type { SupplyingOrder } from '@shared/poStock'
import { offerableOrders, supplyRefusal } from '@shared/poStock'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'

/**
 * SELL THESE PARTICULAR CASES — the ones a named purchase order brought in.
 *
 * The owner's words: "let's say I buy ten cases of tribute baseball from a
 * roadshow, and then I sell five cases to another person. I would be able to
 * just select the cases when I'm selecting the cases in the inventory UI."
 *
 * ## It is absent on almost every line, and that is the design
 *
 * The control renders NOTHING unless an open roadshow order actually has some
 * of this product on the shelf right now. Every sales order line in this app
 * would otherwise grow a chooser to serve a case that arises on one kind of
 * order — and a control that is empty on nine lines out of ten teaches people
 * to stop reading the row.
 *
 * ## Under the product name, not a seventh column
 *
 * The line table is already six columns inside a 620px modal; the last time
 * something was squeezed in there the money fields came out three characters
 * wide. This sits under the name with the description, where the case being
 * sold is named, which is where a claim about WHICH cases belongs.
 *
 * ## It reads the shelf, not a cached list
 *
 * Asked per product and per shelf when the line appears, because the answer
 * changes as stock moves — another sale saved five minutes ago on another bench
 * is exactly the thing that makes a stale count wrong here. Cheap: one small
 * read, and only for lines that name a catalog product.
 */
export function SourceOrderPicker({
  productId,
  productName,
  location,
  quantity,
  value,
  onChange
}: {
  productId: string
  productName: string
  /** The shelf this line is fulfilled from. A sale takes from one shelf. */
  location: string
  /** What the line is selling, so the refusal can name both numbers. */
  quantity: number
  /** The chosen order, or '' for ordinary stock. */
  value: string
  onChange: (poId: string) => void
}): JSX.Element | null {
  const [orders, setOrders] = useState<SupplyingOrder[] | null>(null)

  useEffect(() => {
    if (!productId) {
      setOrders([])
      return
    }
    let alive = true
    void api.purchaseOrders
      .supplyingOrders(productId, location)
      .then((rows) => {
        if (alive) setOrders(Array.isArray(rows) ? rows : [])
      })
      .catch(() => {
        // A read that failed must not stop somebody writing a sales order. No
        // chooser is the same outcome as no open order holding any, which is
        // what almost every line sees anyway.
        if (alive) setOrders([])
      })
    return () => {
      alive = false
    }
  }, [productId, location])

  const offers = useMemo(() => offerableOrders(orders ?? []), [orders])
  const chosen = offers.find((o) => o.poId === value) ?? null
  /**
   * A CHOSEN ORDER THAT IS NO LONGER ON THE LIST still shows.
   *
   * Reopening a saved sale whose cases have since all been sold would otherwise
   * silently drop the choice back to ordinary stock — and then re-saving would
   * re-cost the line against whatever is oldest, quietly, on a document nobody
   * thought they were changing.
   */
  const stale = !!value && !chosen

  if (offers.length === 0 && !stale) return null

  const problem = supplyRefusal(chosen, quantity, productName)

  return (
    <div className="so-source">
      <label className="so-source-row">
        <Icon name="Store" size={12} />
        <span className="so-source-label">Sell from</span>
        <select
          className="select so-source-select"
          aria-label={`Which purchase order's ${productName} to sell`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* THE DEFAULT IS ORDINARY STOCK and it is named rather than blank.
              An empty first option reads as "not chosen yet"; this one is a
              real answer that most lines want, and saying so is what stops
              somebody feeling they have to pick an order. */}
          <option value="">Any stock (oldest first)</option>
          {offers.map((o) => (
            <option key={o.poId} value={o.poId}>
              {o.poNumber}
              {o.supplier ? ` · ${o.supplier}` : ''} · {o.unitsOnHand} on hand
            </option>
          ))}
          {/* The order this line was saved against, kept selectable even though
              it has nothing left — see `stale`. */}
          {stale && <option value={value}>The order this line was sold from</option>}
        </select>
      </label>
      {problem && <div className="so-source-warn">{problem}</div>}
    </div>
  )
}
