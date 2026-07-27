import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Supply, SupplyOrder, SupplyOrderStatus } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney, formatDate } from '../../lib/format'
import { SupplyOrderModal } from './SupplyOrderModal'

type Lane = {
  id: SupplyOrderStatus
  label: string
  icon: string
  /** The one forward move offered on a card in this lane, if any. */
  next?: SupplyOrderStatus
  nextLabel?: string
  nextIcon?: string
  /** Terminal lanes are closed history: collapsed to the newest few. */
  closed?: boolean
}

const LANES: Lane[] = [
  {
    id: 'ordered',
    label: 'Ordered',
    icon: 'ShoppingCart',
    next: 'in_transit',
    nextLabel: 'Mark in-transit',
    nextIcon: 'Truck'
  },
  {
    id: 'in_transit',
    label: 'In-transit',
    icon: 'Truck',
    next: 'delivered',
    nextLabel: 'Mark delivered',
    nextIcon: 'PackageCheck'
  },
  { id: 'delivered', label: 'Delivered', icon: 'PackageCheck', closed: true },
  { id: 'cancelled', label: 'Cancelled', icon: 'Ban', closed: true }
]

/** How many rows a closed lane shows before the "show all" toggle. */
const CLOSED_PREVIEW = 4

/**
 * The supply-order pipeline, relocated out of Inventory > Supplies and into the
 * Purchase Orders tab so both buy-side trackers sit in one place: purchase
 * orders on top, supply reorders beneath.
 *
 * Ordered → In-transit → Delivered, one lane each plus a Cancelled history.
 * Delivering routes through the main-process applySupplyPurchase path (via
 * supplyOrderSetStatus), which lands the stock and the spend on the supply —
 * never on card inventory value, average cost or spread.
 */
export function SupplyOrdersSection({ canManage }: { canManage: boolean }): JSX.Element {
  const toast = useToast()
  const [orders, setOrders] = useState<SupplyOrder[]>([])
  const [supplies, setSupplies] = useState<Supply[]>([])
  const [loading, setLoading] = useState(true)
  const [newOpen, setNewOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const [list, sup] = await Promise.all([api.supplies.listOrders(), api.supplies.list()])
    if (!mounted.current) return
    setOrders(list)
    setSupplies(sup)
  }, [])

  useEffect(() => {
    ;(async () => {
      await load()
      if (mounted.current) setLoading(false)
    })()
  }, [load])

  const move = async (order: SupplyOrder, status: SupplyOrderStatus): Promise<void> => {
    setBusyId(order.id)
    try {
      const res = await api.supplies.setOrderStatus(order.id, status)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not move the order.')
        return
      }
      if (status === 'delivered') {
        toast.success(`${order.supplyName} delivered — ${order.items} added to supplies.`)
      } else if (status === 'cancelled') {
        toast.success(`Order for ${order.supplyName} cancelled.`)
      }
      await load()
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  const remove = async (order: SupplyOrder): Promise<void> => {
    setBusyId(order.id)
    try {
      const res = await api.supplies.deleteOrder(order.id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not delete the order.')
        return
      }
      await load()
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  const open = useMemo(
    () => orders.filter((o) => o.status === 'ordered' || o.status === 'in_transit'),
    [orders]
  )
  const committed = useMemo(() => open.reduce((sum, o) => sum + o.total, 0), [open])

  return (
    <section className="wsec wsec-supply">
      <header className="wsec-head">
        <div className="wsec-ico">
          <Icon name="Truck" size={22} />
        </div>
        <div className="wsec-title">
          <h3>Supply orders</h3>
          <p>Packaging reorders moving Ordered → In-transit → Delivered.</p>
        </div>
        <div className="wsec-actions">
          {!loading && (
            <div className="wsec-stats">
              <div className="wsec-stat">
                <span className="wsec-stat-val">{open.length}</span>
                <span className="wsec-stat-label">Open</span>
              </div>
              <div className="wsec-stat">
                <span className="wsec-stat-val mono">
                  {formatMoney(committed, { compact: true })}
                </span>
                <span className="wsec-stat-label">On order</span>
              </div>
            </div>
          )}
          {canManage && (
            <Button
              variant="primary"
              icon="Plus"
              onClick={() => setNewOpen(true)}
              disabled={supplies.length === 0}
              title={
                supplies.length === 0
                  ? 'Add a supply in Inventory → Supplies first'
                  : 'Place a supply order'
              }
            >
              New supply order
            </Button>
          )}
        </div>
      </header>

      <div className="wsec-body">
        {loading ? (
          <div className="wsec-loading">Loading…</div>
        ) : orders.length === 0 ? (
          <div className="wsec-empty">
            <div className="wsec-empty-ico">
              <Icon name="ShoppingCart" size={26} />
            </div>
            <div className="wsec-empty-title">No supply orders yet</div>
            <p className="wsec-empty-msg">
              Place an order for a packaging supply and track it here until it lands. Delivering an
              order adds the stock and records the spend as an operating expense — it never touches
              card inventory value.
            </p>
            {canManage && supplies.length > 0 && (
              <Button variant="primary" icon="Plus" onClick={() => setNewOpen(true)}>
                Place a supply order
              </Button>
            )}
          </div>
        ) : (
          <div className="so-lanes">
            {LANES.map((lane) => {
              const rows = orders.filter((o) => o.status === lane.id)
              if (lane.closed && rows.length === 0) return null
              const expanded = !!showAll[lane.id]
              const visible = lane.closed && !expanded ? rows.slice(0, CLOSED_PREVIEW) : rows
              const hidden = rows.length - visible.length
              return (
                <div className="so-lane" key={lane.id} data-lane={lane.id}>
                  <div className="so-lane-head">
                    <span className="so-lane-badge" data-lane={lane.id}>
                      <Icon name={lane.icon} size={15} />
                      {lane.label}
                    </span>
                    <span className="so-lane-count">{rows.length}</span>
                    <span className="so-lane-rule" />
                  </div>
                  {rows.length === 0 ? (
                    <div className="so-lane-empty">Nothing {lane.label.toLowerCase()}.</div>
                  ) : (
                    <div className="so-rows">
                      {visible.map((o) => (
                        <OrderRow
                          key={o.id}
                          order={o}
                          lane={lane}
                          canManage={canManage}
                          busy={busyId === o.id}
                          onMove={move}
                          onRemove={remove}
                        />
                      ))}
                    </div>
                  )}
                  {hidden > 0 && (
                    <button
                      className="link-btn so-lane-more"
                      onClick={() => setShowAll((s) => ({ ...s, [lane.id]: true }))}
                    >
                      Show {hidden} more
                    </button>
                  )}
                  {lane.closed && expanded && rows.length > CLOSED_PREVIEW && (
                    <button
                      className="link-btn so-lane-more"
                      onClick={() => setShowAll((s) => ({ ...s, [lane.id]: false }))}
                    >
                      Show fewer
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {newOpen && (
        <SupplyOrderModal supplies={supplies} onClose={() => setNewOpen(false)} onSaved={load} />
      )}
    </section>
  )
}

function OrderRow({
  order,
  lane,
  canManage,
  busy,
  onMove,
  onRemove
}: {
  order: SupplyOrder
  lane: Lane
  canManage: boolean
  busy: boolean
  onMove: (o: SupplyOrder, s: SupplyOrderStatus) => void | Promise<void>
  onRemove: (o: SupplyOrder) => void | Promise<void>
}): JSX.Element {
  const perItem = order.items > 0 ? order.total / order.items : 0
  const stamp =
    order.status === 'delivered'
      ? `Delivered ${formatDate(order.deliveredAt)}`
      : order.status === 'cancelled'
        ? `Cancelled ${formatDate(order.cancelledAt)}`
        : order.status === 'in_transit'
          ? `Shipped ${formatDate(order.inTransitAt)}`
          : `Ordered ${formatDate(order.orderedAt)}`

  return (
    <div className={`so-row${busy ? ' busy' : ''}`} data-lane={lane.id}>
      <div className="so-row-thumb">
        {order.imageUrl ? <img src={order.imageUrl} alt="" /> : <Icon name="Package" size={22} />}
      </div>

      <div className="so-row-body">
        <div className="so-row-name">{order.supplyName}</div>
        <div className="so-row-meta">
          <span className="so-row-qty">
            {order.units} {order.unit}
          </span>
          <span className="so-row-dot" />
          <span>
            {order.items.toLocaleString()} items
            {order.status === 'delivered'
              ? ' added'
              : order.status === 'cancelled'
                ? ' never shipped'
                : ' on delivery'}
          </span>
          {perItem > 0 && (
            <>
              <span className="so-row-dot" />
              <span>{formatMoney(perItem)}/item</span>
            </>
          )}
        </div>
        <div className="so-row-sub">
          <span className="so-row-stamp">
            <Icon name="Clock" size={13} />
            {stamp}
          </span>
          {order.note && <span className="so-row-note">{order.note}</span>}
        </div>
      </div>

      <div className="so-row-right">
        <div className="so-row-total mono">{formatMoney(order.total)}</div>
        {canManage && (
          <div className="so-row-actions">
            {lane.next && lane.nextLabel && (
              <button
                type="button"
                className="btn btn-primary so-advance"
                disabled={busy}
                onClick={() => onMove(order, lane.next as SupplyOrderStatus)}
              >
                <Icon name={lane.nextIcon ?? 'ArrowRight'} size={16} />
                {lane.nextLabel}
              </button>
            )}
            {lane.next ? (
              <button
                type="button"
                className="btn btn-ghost so-cancel"
                disabled={busy}
                title="Cancel this order"
                onClick={() => onMove(order, 'cancelled')}
              >
                <Icon name="X" size={16} />
                Cancel
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost so-delete"
                disabled={busy}
                title="Delete this order from the tracker"
                onClick={() => onRemove(order)}
              >
                <Icon name="Trash2" size={16} />
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
