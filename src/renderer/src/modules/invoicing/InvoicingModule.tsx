import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  PurchaseOrder,
  PurchaseOrderStatus,
  Supply,
  SupplyOrder,
  SupplyOrderStatus
} from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { PurchaseOrderBoard } from './PurchaseOrderBoard'
import { CreatePurchaseOrderModal } from './CreatePurchaseOrderModal'
import { PurchaseOrderReceipt } from './PurchaseOrderReceipt'
import { SupplyOrderModal } from './SupplyOrderModal'

/**
 * Invoicing & POs module — the buy side of the business as ONE board:
 * Ordered → Paid → Received / Cancelled.
 *
 * Product purchase orders and supply reorders share those columns. They are the
 * same job — money committed to a supplier, waiting to land — and keeping two
 * separate lists meant looking in two places to answer one question. Supply
 * cards are tinted and badged "Supply" so the two are never confused, and they
 * keep their own status wording (a supply order is "In transit", not "Paid").
 *
 * Supplies are increasingly bought without anyone pressing a button: once the
 * low-stock reorder automation is live it writes orders with source='auto', and
 * this board is where they surface. Supplies themselves (stock, cost,
 * buy/use/adjust) stay on the Inventory tab.
 *
 * Access to the tab is gated by AppShell on 'module.invoicing'. Writing to a
 * supply order still needs 'inventory.manage', exactly as it did in its old
 * home — the move must not widen who can spend.
 */
export function InvoicingModule(): JSX.Element {
  const { can } = useSession()
  const canManage = can('module.invoicing')
  const canManageSupplies = can('inventory.manage')
  const toast = useToast()

  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [supplyOrders, setSupplyOrders] = useState<SupplyOrder[]>([])
  const [supplies, setSupplies] = useState<Supply[]>([])
  const [newSupplyOpen, setNewSupplyOpen] = useState(false)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    // One board, so both halves are refetched together — a stale supply column
    // beside a fresh PO column would be worse than a slightly slower load.
    const [list, orders, sup] = await Promise.all([
      api.purchaseOrders.list(),
      api.supplies.listOrders(),
      api.supplies.list()
    ])
    setPos(list)
    setSupplyOrders(orders)
    setSupplies(sup)
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      await reload()
      if (active) setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [reload])

  // Receipt line images — loaded once; base64 thumbnails are comparatively heavy.
  useEffect(() => {
    let active = true
    api.purchaseOrders.thumbnails().then((t) => {
      if (active) setThumbnails(t)
    })
    return () => {
      active = false
    }
  }, [])

  const move = useCallback(
    async (id: string, to: PurchaseOrderStatus) => {
      const res = await api.purchaseOrders.setStatus(id, to)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not move the purchase order.')
        return
      }
      toast.success(`${res.data.poNumber} → ${to}.`)
      await reload()
    },
    [reload, toast]
  )

  const moveSupply = useCallback(
    async (order: SupplyOrder, to: SupplyOrderStatus) => {
      const res = await api.supplies.setOrderStatus(order.id, to)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not move the supply order.')
        return
      }
      toast.success(
        to === 'delivered'
          ? `${order.supplyName} delivered — ${order.items.toLocaleString()} items added.`
          : `${order.supplyName} → ${to.replace('_', ' ')}.`
      )
      await reload()
    },
    [reload, toast]
  )

  const removeSupply = useCallback(
    async (order: SupplyOrder) => {
      if (!window.confirm(`Delete this ${order.supplyName} order? Stock already delivered stays.`)) {
        return
      }
      const res = await api.supplies.deleteOrder(order.id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not delete the supply order.')
        return
      }
      await reload()
    },
    [reload, toast]
  )

  // Deleting a PO is refused once any of its stock has been checked in — the
  // backend owns that rule, so the error it returns is what the operator sees.
  const removePo = useCallback(
    async (id: string, poNumber: string) => {
      if (!window.confirm(`Delete ${poNumber}? This cannot be undone.`)) return
      const res = await api.purchaseOrders.remove(id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not delete the purchase order.')
        return
      }
      toast.success(`${poNumber} deleted.`)
      setReceiptId(null)
      await reload()
    },
    [reload, toast]
  )

  const openPos = useMemo(
    () => pos.filter((p) => p.status === 'ordered' || p.status === 'paid'),
    [pos]
  )
  const committed = useMemo(() => openPos.reduce((sum, p) => sum + p.total, 0), [openPos])

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow inv-shell">
      <div className="inv-scroll po-tab">
        {/* No section shell: the board IS the page. A card-in-a-card added a
            border, a tinted band and an icon plate around content that already
            reads as columns of cards, so the chrome went and the page flows. */}
        <div className="po-page-head">
          <h2>Purchase orders</h2>
          <div className="po-page-stats">
            <div className="po-page-stat">
              <span className="po-page-stat-val">{openPos.length}</span>
              <span className="po-page-stat-label">Open</span>
            </div>
            <div className="po-page-stat">
              <span className="po-page-stat-val mono">
                {formatMoney(committed, { compact: true })}
              </span>
              <span className="po-page-stat-label">Committed</span>
            </div>
          </div>
          {canManageSupplies && supplies.length > 0 && (
            <Button icon="Package" onClick={() => setNewSupplyOpen(true)}>
              New supply order
            </Button>
          )}
          {canManage && (
            <Button variant="primary" icon="Plus" onClick={() => setShowCreate(true)}>
              New PO
            </Button>
          )}
        </div>

        {pos.length === 0 && supplyOrders.length === 0 ? (
          <div className="po-page-empty">
            <Icon name="ReceiptText" size={26} />
            <div className="po-page-empty-title">Nothing on order</div>
            <p>
              Create a PO to start tracking a product buy — its lines, its cost and where the
              boxes land — or log a supply reorder for packaging.
            </p>
            {canManage && (
              <Button variant="primary" icon="Plus" onClick={() => setShowCreate(true)}>
                New PO
              </Button>
            )}
          </div>
        ) : (
          <PurchaseOrderBoard
            pos={pos}
            supplyOrders={supplyOrders}
            canManageSupplies={canManageSupplies}
            thumbnails={thumbnails}
            onMove={move}
            onOpen={(id) => setReceiptId(id)}
            onMoveSupply={moveSupply}
            onDeleteSupply={removeSupply}
          />
        )}

      </div>

      {showCreate && (
        <CreatePurchaseOrderModal onClose={() => setShowCreate(false)} onSaved={reload} />
      )}
      {receiptId && (
        <PurchaseOrderReceipt
          id={receiptId}
          thumbnails={thumbnails}
          onMove={move}
          onDelete={canManage ? removePo : undefined}
          onClose={() => setReceiptId(null)}
        />
      )}
      {newSupplyOpen && (
        <SupplyOrderModal
          supplies={supplies}
          onClose={() => setNewSupplyOpen(false)}
          onSaved={reload}
        />
      )}
    </div>
  )
}
