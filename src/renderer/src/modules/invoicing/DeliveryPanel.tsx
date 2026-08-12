import { useEffect, useState } from 'react'
import type { PurchaseOrderDetail } from '@shared/types'
import { receivableProgressOf } from '@shared/receiving'
import { api } from '../../lib/api'
import { Button } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { Icon } from '../../components/Icon'
import { receivableOutstanding } from './helpers'

/**
 * "How many turned up today?"
 *
 * The form that was missing. Before this the only ways to receive a PO were a
 * UPC scan — which needs a barcode most of this catalog does not carry — and
 * "Scanned in", which takes the entire order at once. A delivery of twenty-three
 * of thirty-eight units had to be recorded as complete, inventing fifteen units
 * of stock at a cost basis, or left alone, hiding twenty-three real ones.
 *
 * ## Every box starts at zero
 *
 * Not pre-filled with what is outstanding. A form pre-filled with the full
 * remainder and a Record button is the same all-or-nothing button with extra
 * steps, and it is one careless click away from booking a delivery that did not
 * arrive. Somebody counting boxes on a floor types what they counted. "All"
 * per line and "Everything arrived" are there for the ordinary case where the
 * whole order did land, because making that person type nine numbers is its own
 * kind of wrong.
 *
 * ## Only outstanding lines
 *
 * A line already fully received is not part of today's delivery and cannot take
 * another unit, so it is not offered. It stays visible in the receipt below,
 * ticked, which is where "what did we already get" belongs.
 *
 * ## Only units that are COMING HERE
 *
 * Every count on this form is the RECEIVABLE remainder, never the ordered one.
 * A line of twenty with eight going straight from the supplier to a shop offers
 * twelve, and its "All" fills twelve. Offering twenty would put a Record button
 * in front of somebody for boxes that were never addressed to this building —
 * and `receivePoLine` throws on a drop allocation, so pressing it produces a
 * refusal and nothing else. On every line raised before dropship existed the two
 * figures are the same number, so this form behaves exactly as it always has.
 *
 * ## This is now the only place a delivery can be recorded
 *
 * It used to sit inside the purchase order receipt as well. The receipt shows
 * what arrived; it does not book it.
 */
export function DeliveryPanel({
  po,
  onReceived
}: {
  po: PurchaseOrderDetail
  onReceived: (po: PurchaseOrderDetail) => void
}): JSX.Element | null {
  const toast = useToast()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)

  // Every line with something still due HERE, paired with how much that is. A
  // wholly drop-shipped line has a receivable remainder of zero and drops out,
  // which is what makes a pure-drop order show no form at all.
  const open = po.lines
    .map((l) => ({ line: l, left: receivableOutstanding(l) }))
    .filter((l) => l.left > 0)

  // Reset when a different PO is shown, and after a delivery lands — the lines
  // that were just received are gone from `open`, and a leftover count keyed to
  // one of them would be sent again on the next submit.
  useEffect(() => {
    setCounts({})
  }, [po.id, po.receivedUnits])

  if (po.status === 'cancelled' || open.length === 0) return null

  const set = (lineId: string, n: number, max: number): void =>
    setCounts((c) => ({ ...c, [lineId]: Math.max(0, Math.min(max, Math.round(n) || 0)) }))

  const entered = open.reduce((sum, l) => sum + (counts[l.line.id] ?? 0), 0)
  const remaining = open.reduce((sum, l) => sum + l.left, 0)
  const wholeOrder = entered === remaining && entered > 0

  const submit = async (): Promise<void> => {
    const items = open
      .map((l) => ({ lineId: l.line.id, quantity: counts[l.line.id] ?? 0 }))
      .filter((i) => i.quantity > 0)
    if (!items.length) {
      toast.error('Enter how many of at least one item arrived.')
      return
    }
    setBusy(true)
    try {
      const res = await api.purchaseOrders.receiveLines(po.id, items)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not record that delivery.')
        return
      }
      const after = receivableProgressOf(res.data.lines)
      toast.success(
        after.state === 'complete'
          ? `${po.poNumber} is fully received — all ${after.ordered} units are in stock.`
          : `${entered} unit${entered === 1 ? '' : 's'} received. ${after.outstanding} still to come.`
      )
      onReceived(res.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="po-deliv">
      <div className="po-deliv-head">
        <span className="po-deliv-title">
          <Icon name="PackageCheck" size={15} />
          How many arrived?
        </span>
        <button
          type="button"
          className="btn btn-sm po-deliv-all"
          disabled={busy}
          onClick={() =>
            setCounts(
              wholeOrder
                ? {}
                : Object.fromEntries(open.map((l) => [l.line.id, l.left]))
            )
          }
        >
          {wholeOrder ? 'Clear' : 'Everything arrived'}
        </button>
      </div>
      <p className="po-deliv-hint">
        Type what you counted. A part delivery is normal — the rest stays outstanding and this
        order stays open until it turns up.
      </p>

      <div className="po-deliv-rows">
        {open.map(({ line: l, left }) => {
          const n = counts[l.id] ?? 0
          const dropped = l.quantity - l.qtyReceivable
          return (
            <div className={`po-deliv-row ${n > 0 ? 'has' : ''}`} key={l.id}>
              <span className="po-deliv-name" title={l.productName}>
                {l.productName}
              </span>
              <span className="po-deliv-left mono">
                {left} left
                {l.qtyReceived > 0 && <em> · {l.qtyReceived} in</em>}
                {/* Non-counting, and said here so the number beside it
                    reconciles against the receipt without opening the order:
                    twelve left of a twenty-unit line is not a miscount. */}
                {dropped > 0 && <em> · {dropped} drop-shipped</em>}
              </span>
              <span className="po-deliv-step">
                <button
                  type="button"
                  className="po-deliv-btn"
                  aria-label={`One fewer ${l.productName}`}
                  disabled={busy || n <= 0}
                  onClick={() => set(l.id, n - 1, left)}
                >
                  <Icon name="Minus" size={14} />
                </button>
                <input
                  className="po-deliv-num mono"
                  inputMode="numeric"
                  value={String(n)}
                  aria-label={`Units of ${l.productName} received`}
                  disabled={busy}
                  onChange={(e) => set(l.id, Number(e.target.value.replace(/\D+/g, '')), left)}
                />
                <button
                  type="button"
                  className="po-deliv-btn"
                  aria-label={`One more ${l.productName}`}
                  disabled={busy || n >= left}
                  onClick={() => set(l.id, n + 1, left)}
                >
                  <Icon name="Plus" size={14} />
                </button>
                <button
                  type="button"
                  className="po-deliv-fill"
                  disabled={busy || n >= left}
                  onClick={() => set(l.id, left, left)}
                >
                  All
                </button>
              </span>
            </div>
          )
        })}
      </div>

      <div className="po-deliv-foot">
        <span className="po-deliv-sum">
          {/* The consequence, spelled out before the button rather than in a
              toast after it: this books stock at a cost basis and cannot be
              undone from here. */}
          <b className="mono">{entered}</b> of {remaining} outstanding{' '}
          {remaining === 1 ? 'unit' : 'units'}
          {entered > 0 && ' into stock'}
        </span>
        <Button icon="PackageCheck" disabled={busy || entered === 0} onClick={() => void submit()}>
          {busy ? 'Receiving…' : 'Record delivery'}
        </Button>
      </div>
    </div>
  )
}
