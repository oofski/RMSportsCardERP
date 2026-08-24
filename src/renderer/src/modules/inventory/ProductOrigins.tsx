import { useCallback, useEffect, useState } from 'react'
import type { StockProvenance } from '@shared/provenance'
import {
  groupSources,
  incomingUnits,
  onHandUnits,
  unaccounted,
  type IncomingSource,
  type SourceGroup
} from '@shared/provenance'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { formatDate, formatMoney } from '../../lib/format'

/**
 * WHERE THESE CASES CAME FROM, and which purchase orders are bringing more.
 *
 * ## The question
 *
 * Somebody is holding four cases and wants to know which order bought them,
 * what each one cost, and whether more are on the way. Every part of that was
 * already in the database and none of it was on a screen: the catalog said how
 * many, the cost-lot picker said what a layer cost, the purchase-order board
 * said what had been ordered, and getting from a case in your hand to the
 * document that bought it meant three screens and matching dates by eye.
 *
 * ## Two lists, never one number
 *
 * ON THE SHELF is history — stock that is here, and the paperwork it arrived on.
 * ON THE WAY is a forecast — orders with units still outstanding.
 *
 * They are deliberately not added together. An ordered case and a case in the
 * room are not the same thing, and a screen that totals them is how a break gets
 * scheduled against stock that has not shipped.
 *
 * ## It loads on demand
 *
 * One read per product, and a catalog page can be showing thirty. The panel is
 * collapsed until asked for, so the cost of the answer is paid by whoever wants
 * it rather than by everybody scrolling past.
 */
export function ProductOrigins({
  productId,
  onOpenPo
}: {
  productId: string
  /**
   * Open a purchase order. Optional: without it every row still says which PO
   * and everything on it, it just is not somewhere to go. That keeps the panel
   * usable anywhere it is mounted rather than only where navigation reaches.
   */
  onOpenPo?: (poId: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<StockProvenance | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.inventory.productProvenance(productId)
      setData(res ?? { productId, onHand: [], incoming: [] })
      setError(null)
    } catch {
      setError('Could not read where this stock came from.')
    }
  }, [productId])

  useEffect(() => {
    if (open && !data) void load()
  }, [open, data, load])

  // A product that changed under the panel gets re-read next time it opens
  // rather than showing the previous product's deliveries.
  useEffect(() => {
    setData(null)
    setError(null)
  }, [productId])

  const groups = data ? groupSources(data.onHand) : []
  const coming = data?.incoming ?? []

  return (
    <div className="po-origins">
      <button
        type="button"
        className={`po-origins-toggle ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={13} />
        <span>Where these came from</span>
        {/* The headline before it is opened: the reason to open it at all is
            usually "is anything coming", and that is answerable without the
            list. Only shown once the data is in hand — a count that appears a
            second late reads as the number changing. */}
        {data && (
          <span className="po-origins-count">
            {groups.length} {groups.length === 1 ? 'delivery' : 'deliveries'}
            {coming.length > 0 ? ` · ${incomingUnits(data)} on order` : ''}
          </span>
        )}
      </button>

      {open && !data && !error && (
        <div className="po-origins-loading">
          <span className="spinner dark" />
        </div>
      )}

      {open && error && <div className="po-origins-note">{error}</div>}

      {open && data && (
        <div className="po-origins-body">
          <div className="po-origins-head">
            On the shelf
            <span>
              {onHandUnits(data)} on hand
            </span>
          </div>
          {groups.length === 0 ? (
            <div className="po-origins-note">Nothing on hand.</div>
          ) : (
            groups.map((g) => <OriginRow key={g.key} group={g} onOpenPo={onOpenPo} />)
          )}

          {/* Only drawn when something IS coming. An empty "On the way" heading
              on every product in the catalog is a question mark beside stock
              that is completely fine. */}
          {coming.length > 0 && (
            <>
              <div className="po-origins-head">
                On the way
                <span>{incomingUnits(data)} still to arrive</span>
              </div>
              {coming.map((c) => (
                <IncomingRow key={c.poId} incoming={c} onOpenPo={onOpenPo} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** One delivery: a purchase order, or a layer that arrived without one. */
function OriginRow({
  group,
  onOpenPo
}: {
  group: SourceGroup
  onOpenPo?: (poId: string) => void
}): JSX.Element {
  const clickable = !!group.poId && !!onOpenPo
  const shelves = [...new Set(group.layers.map((l) => l.location).filter(Boolean))]
  // Only when there is more than one layer: "2 cases (2 receipts)" on a single
  // delivery is noise about a distinction nobody is asking about.
  const commits = group.layers.length > 1 ? ` · ${group.layers.length} receipts` : ''
  const missing = group.layers.every(unaccounted)

  const body = (
    <>
      <div className="po-origins-main">
        <b>{group.label}</b>
        <span>
          {group.qty} {group.qty === 1 ? 'unit' : 'units'} · {formatMoney(group.cost)}
          {shelves.length > 0 ? ` · ${shelves.join(', ')}` : ''}
          {commits}
        </span>
      </div>
      <div className="po-origins-side">
        <span className="po-origins-when">{formatDate(group.receivedAt)}</span>
        {/* A case nobody can account for. Not an error — opening balances and
            count sheets are ordinary — but it is the answer to "why does the
            count not match the orders", so it is the one thing marked. */}
        {missing && (
          <span className="po-origins-flag" title="No purchase order and no supplier recorded">
            <Icon name="HelpCircle" size={11} /> No paperwork
          </span>
        )}
        {clickable && <Icon name="ArrowUpRight" size={13} />}
      </div>
    </>
  )

  if (!clickable) return <div className="po-origins-row">{body}</div>
  return (
    <button
      type="button"
      className="po-origins-row is-link"
      title={`Open ${group.poNumber}`}
      onClick={() => onOpenPo?.(group.poId as string)}
    >
      {body}
    </button>
  )
}

/** One purchase order with units of this product still outstanding. */
function IncomingRow({
  incoming,
  onOpenPo
}: {
  incoming: IncomingSource
  onOpenPo?: (poId: string) => void
}): JSX.Element {
  const body = (
    <>
      <div className="po-origins-main">
        <b>{incoming.poNumber}</b>
        <span>
          {incoming.outstanding} of {incoming.ordered} still to come
          {incoming.supplier ? ` · ${incoming.supplier}` : ''}
          {incoming.destination ? ` · to ${incoming.destination}` : ''}
        </span>
      </div>
      <div className="po-origins-side">
        {/* Paid is the useful "is this real" flag — an order that has been paid
            for is one somebody is definitely sending. */}
        <span className={`po-origins-stage ${incoming.paid ? 'paid' : ''}`}>
          {incoming.paid ? 'Paid' : 'Ordered'}
        </span>
        {onOpenPo && <Icon name="ArrowUpRight" size={13} />}
      </div>
    </>
  )

  if (!onOpenPo) return <div className="po-origins-row">{body}</div>
  return (
    <button
      type="button"
      className="po-origins-row is-link"
      title={`Open ${incoming.poNumber}`}
      onClick={() => onOpenPo(incoming.poId)}
    >
      {body}
    </button>
  )
}
