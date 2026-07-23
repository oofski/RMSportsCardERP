import { useCallback, useEffect, useState } from 'react'
import type { PurchaseOrder, PurchaseOrderStatus } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { PurchaseOrderBoard } from './PurchaseOrderBoard'
import { CreatePurchaseOrderModal } from './CreatePurchaseOrderModal'
import { PurchaseOrderReceipt } from './PurchaseOrderReceipt'

/**
 * Invoicing & POs module. A buy-side pipeline: purchase orders move through
 * Ordered → Paid → Received (or Cancelled) on a kanban board, each PO built from
 * real catalog products with a per-line buy price. Clicking a card opens its
 * printable receipt. Access is gated by AppShell on 'module.invoicing'.
 */
export function InvoicingModule(): JSX.Element {
  const { can } = useSession()
  const canManage = can('module.invoicing')
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

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow inv-shell">
      <div className="section-head">
        <div>
          <h2>Purchase Orders</h2>
          <p>Track buys through the ordered → paid → received pipeline.</p>
        </div>
        {canManage && (
          <Button variant="primary" icon="Plus" onClick={() => setShowCreate(true)}>
            New PO
          </Button>
        )}
      </div>

      <div className="inv-scroll">
        {pos.length === 0 ? (
          <EmptyState
            icon="ReceiptText"
            title="No purchase orders yet"
            message="Create a PO to start tracking a buy."
            action={
              canManage ? (
                <Button variant="primary" icon="Plus" onClick={() => setShowCreate(true)}>
                  New PO
                </Button>
              ) : undefined
            }
          />
        ) : (
          <PurchaseOrderBoard
            pos={pos}
            thumbnails={thumbnails}
            onMove={move}
            onOpen={(id) => setReceiptId(id)}
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
          onClose={() => setReceiptId(null)}
        />
      )}
    </div>
  )
}
