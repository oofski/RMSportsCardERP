import { useCallback, useEffect, useRef, useState } from 'react'
import type { Supply, SupplyOrder, SupplyOrderStatus } from '@shared/types'
import { api } from '../../lib/api'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney, formatDate } from '../../lib/format'
import { SupplyOrderModal } from './SupplyOrderModal'

type StageId = 'ordered' | 'in_transit' | 'delivered'

const STAGES: {
  id: StageId
  label: string
  icon: string
  tone: string
  next?: SupplyOrderStatus
  nextLabel?: string
}[] = [
  { id: 'ordered', label: 'Ordered', icon: 'ShoppingCart', tone: 'ordered', next: 'in_transit', nextLabel: 'Mark in-transit' },
  { id: 'in_transit', label: 'In-transit', icon: 'Truck', tone: 'transit', next: 'delivered', nextLabel: 'Mark delivered' },
  { id: 'delivered', label: 'Delivered', icon: 'PackageCheck', tone: 'delivered' }
]

/**
 * The supply-order pipeline: a right-side container that tracks reorders moving
 * Ordered → In-transit → Delivered. Delivering an order adds its stock (so the
 * parent reloads via onChanged). A future purchasing API can drive these stages
 * automatically; for now they're advanced by hand.
 */
export function SupplyOrdersPanel({
  supplies,
  canManage,
  onChanged
}: {
  supplies: Supply[]
  canManage: boolean
  onChanged: () => void | Promise<void>
}): JSX.Element {
  const [orders, setOrders] = useState<SupplyOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [newOpen, setNewOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const list = await api.supplies.listOrders()
    if (mounted.current) setOrders(list)
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
      if (res.ok) {
        await load()
        // Delivering an order changes stock/cost — refresh the parent too.
        if (status === 'delivered') await onChanged()
      }
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  const cancel = async (order: SupplyOrder): Promise<void> => {
    setBusyId(order.id)
    try {
      const res = await api.supplies.setOrderStatus(order.id, 'cancelled')
      if (res.ok) await load()
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  return (
    <div className="panel-card supply-orders-panel">
      <div className="panel-head">
        <div>
          <h3>Supply orders</h3>
          <span className="ph-sub">Ordered → In-transit → Delivered</span>
        </div>
        {canManage && (
          <Button size="sm" icon="Plus" onClick={() => setNewOpen(true)} disabled={supplies.length === 0}>
            New
          </Button>
        )}
      </div>

      {loading ? (
        <div className="so-empty-all">Loading…</div>
      ) : orders.length === 0 ? (
        <div className="so-empty-all">
          <Icon name="ShoppingCart" size={22} />
          <div>No open orders.</div>
          {canManage && supplies.length > 0 && (
            <button className="link-btn" onClick={() => setNewOpen(true)}>
              Place a supply order
            </button>
          )}
        </div>
      ) : (
        <div className="so-stages">
          {STAGES.map((stage) => {
            const cards = orders.filter((o) => o.status === stage.id)
            return (
              <div className="so-stage" key={stage.id}>
                <div className="so-stage-head">
                  <span className={`so-badge so-badge-${stage.tone}`}>
                    <Icon name={stage.icon} size={13} />
                    {stage.label}
                  </span>
                  <span className="so-count">{cards.length}</span>
                </div>
                {cards.length === 0 ? (
                  <div className="so-stage-empty">—</div>
                ) : (
                  cards.map((o) => (
                    <div className="so-card" key={o.id}>
                      <div className="so-card-top">
                        <div className="supply-thumb so-thumb">
                          {o.imageUrl ? <img src={o.imageUrl} alt="" /> : <Icon name="Package" size={15} />}
                        </div>
                        <div className="so-card-main">
                          <div className="so-card-name">{o.supplyName}</div>
                          <div className="so-card-sub">
                            {o.units} {o.unit} · {o.items} items · {formatMoney(o.total)}
                          </div>
                        </div>
                      </div>
                      {canManage && stage.next && (
                        <div className="so-card-actions">
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={busyId === o.id}
                            onClick={() => move(o, stage.next as SupplyOrderStatus)}
                          >
                            {stage.nextLabel}
                          </button>
                          <button
                            className="icon-btn danger so-cancel"
                            disabled={busyId === o.id}
                            title="Cancel order"
                            aria-label="Cancel order"
                            onClick={() => cancel(o)}
                          >
                            <Icon name="X" size={14} />
                          </button>
                        </div>
                      )}
                      {stage.id === 'delivered' && (
                        <div className="so-delivered">
                          <Icon name="Check" size={12} /> Delivered {formatDate(o.deliveredAt)}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )
          })}
        </div>
      )}

      {newOpen && (
        <SupplyOrderModal
          supplies={supplies}
          onClose={() => setNewOpen(false)}
          onSaved={load}
        />
      )}
    </div>
  )
}
