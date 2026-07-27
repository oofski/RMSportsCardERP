import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PurchaseOrder, PurchaseOrderStatus } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { PurchaseOrderBoard } from './PurchaseOrderBoard'
import { CreatePurchaseOrderModal } from './CreatePurchaseOrderModal'
import { PurchaseOrderReceipt } from './PurchaseOrderReceipt'
import { SupplyOrdersSection } from './SupplyOrdersSection'

/**
 * Invoicing & POs module — the buy side of the business, as two stacked
 * sections that share one header-band + body shell:
 *
 *   [ Purchase orders ]  the kanban board: Ordered → Paid → Received/Cancelled
 *   [ Supply orders   ]  packaging reorders: Ordered → In-transit → Delivered
 *
 * Supply-order tracking used to sit in a narrow right rail on Inventory >
 * Supplies; it lives here now, beneath the POs, because both are the same job:
 * money committed to a supplier, waiting to land. Supplies themselves (stock,
 * cost, buy/use/adjust) stay on the Inventory tab.
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
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [receiptId, setReceiptId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const list = await api.purchaseOrders.list()
    setPos(list)
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

  const openPos = useMemo(
    () => pos.filter((p) => p.status === 'ordered' || p.status === 'paid'),
    [pos]
  )
  const committed = useMemo(() => openPos.reduce((sum, p) => sum + p.total, 0), [openPos])

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow inv-shell">
      <div className="inv-scroll po-tab">
        <section className="wsec wsec-po">
          <header className="wsec-head">
            <div className="wsec-ico">
              <Icon name="ReceiptText" size={22} />
            </div>
            <div className="wsec-title">
              <h3>Purchase orders</h3>
              <p>Buys moving Ordered → Paid → Received. Drag a card to move it.</p>
            </div>
            <div className="wsec-actions">
              <div className="wsec-stats">
                <div className="wsec-stat">
                  <span className="wsec-stat-val">{openPos.length}</span>
                  <span className="wsec-stat-label">Open</span>
                </div>
                <div className="wsec-stat">
                  <span className="wsec-stat-val mono">
                    {formatMoney(committed, { compact: true })}
                  </span>
                  <span className="wsec-stat-label">Committed</span>
                </div>
              </div>
              {canManage && (
                <Button variant="primary" icon="Plus" onClick={() => setShowCreate(true)}>
                  New PO
                </Button>
              )}
            </div>
          </header>

          <div className="wsec-body">
            {pos.length === 0 ? (
              <div className="wsec-empty">
                <div className="wsec-empty-ico">
                  <Icon name="ReceiptText" size={26} />
                </div>
                <div className="wsec-empty-title">No purchase orders yet</div>
                <p className="wsec-empty-msg">
                  Create a PO to start tracking a buy — its lines, its cost and where the boxes
                  land when they arrive.
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
                thumbnails={thumbnails}
                onMove={move}
                onOpen={(id) => setReceiptId(id)}
              />
            )}
          </div>
        </section>

        <SupplyOrdersSection canManage={canManageSupplies} />
      </div>

      {showCreate && (
        <CreatePurchaseOrderModal onClose={() => setShowCreate(false)} onSaved={reload} />
      )}
      {receiptId && (
        <PurchaseOrderReceipt
          id={receiptId}
          thumbnails={thumbnails}
          onMove={move}
          onClose={() => setReceiptId(null)}
        />
      )}
    </div>
  )
}
