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
import { LIVE, useLiveRefresh } from '../../lib/live'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { PurchaseOrderBoard } from './PurchaseOrderBoard'
import { CreatePurchaseOrderModal } from './CreatePurchaseOrderModal'
import { PurchaseOrderReceipt } from './PurchaseOrderReceipt'
import { CheckTrackingButton } from '../../components/CheckTrackingButton'
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
  /**
   * A PO the ordinary delete refused, held so the operator can decide what to do
   * about it instead of just being told no.
   *
   * The refusal used to be a toast and nothing else, which was the whole problem:
   * a PO received before this app tracked its cost layers cannot be cancelled
   * either, so the two messages sent you in a circle and the card stayed on the
   * board for good.
   */
  const [stuck, setStuck] = useState<{ id: string; poNumber: string; reason: string } | null>(null)
  const [forcing, setForcing] = useState(false)

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

  // A PO received on another machine has to leave this list here too.
  useLiveRefresh(LIVE.purchasing, reload)

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
        // Not a dead end any more. The backend's reason is shown as-is inside a
        // dialog that offers the two ways forward, because the reason is always
        // "stock has been checked in" and the only open question is whether those
        // boxes are physically there.
        setStuck({ id, poNumber, reason: res.error ?? 'This purchase order could not be deleted.' })
        return
      }
      toast.success(`${poNumber} deleted.`)
      setReceiptId(null)
      await reload()
    },
    [reload, toast]
  )

  const forceRemovePo = useCallback(
    async (removeStock: boolean) => {
      if (!stuck) return
      setForcing(true)
      try {
        const res = await api.purchaseOrders.forceRemove(stuck.id, removeStock)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not delete the purchase order.')
          return
        }
        const { removedUnits, soldUnits } = res.data
        toast.success(
          !removeStock
            ? `${stuck.poNumber} deleted. Its stock was left on the shelf.`
            : soldUnits > 0
              ? `${stuck.poNumber} deleted. ${removedUnits} unit(s) came out of stock; ${soldUnits} had already been sold and stayed.`
              : `${stuck.poNumber} deleted. ${removedUnits} unit(s) came out of stock.`
        )
        setStuck(null)
        setReceiptId(null)
        await reload()
      } finally {
        setForcing(false)
      }
    },
    [reload, stuck, toast]
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
          {/* The actions travel together. Loose siblings after a margin-left:auto
              stats block wrapped one at a time, so a third button pushed New PO
              onto its own line — or off the edge on a narrow window, which is
              how somebody ends up unable to find a button that is right there. */}
          <div className="po-page-actions">
            {/* SHOWN AND DISABLED, not hidden. A button that disappears when there
                are no supplies teaches nothing — somebody looking for "where do I
                order supplies" finds nothing at all and concludes the app cannot.
                Disabled with the reason on it answers the question instead. */}
            {canManageSupplies && (
              <Button
                icon="Package"
                disabled={supplies.length === 0}
                title={
                  supplies.length === 0
                    ? 'Add a supply on the Inventory → Supplies tab first — an order has to be for something.'
                    : undefined
                }
                onClick={() => setNewSupplyOpen(true)}
              >
                New supply order
              </Button>
            )}
            {canManage && <CheckTrackingButton onDone={reload} />}
            {canManage && (
              <Button variant="primary" icon="Plus" onClick={() => setShowCreate(true)}>
                New PO
              </Button>
            )}
          </div>
        </div>

        {pos.length === 0 && supplyOrders.length === 0 ? (
          <div className="po-page-empty">
            <Icon name="ReceiptText" size={26} />
            <div className="po-page-empty-title">Nothing on order</div>
            <p>Create a PO to track a product buy, or log a supply reorder.</p>
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
            onDeletePo={canManage ? removePo : undefined}
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
          onSaved={reload}
        />
      )}
      {stuck && <StuckPoModal
        stuck={stuck}
        units={pos.find((p) => p.id === stuck.id)?.receivedUnits ?? 0}
        busy={forcing}
        onClose={() => setStuck(null)}
        onForce={forceRemovePo}
      />}
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

/**
 * What to do with a purchase order that will not delete.
 *
 * ONE question, asked once: are the boxes actually there? Everything else
 * follows from the answer, and neither answer is presented as the safe default
 * because neither is — leaving stock that never arrived overstates inventory,
 * and removing stock that is on the shelf understates it. The operator is the
 * only one who knows.
 *
 * The backend's own refusal is printed verbatim rather than paraphrased. It
 * names the PO and says what is blocking it, and rewriting that here would put
 * two versions of the same sentence in the app.
 */
function StuckPoModal({
  stuck,
  units,
  busy,
  onClose,
  onForce
}: {
  stuck: { id: string; poNumber: string; reason: string }
  /** Units checked in across every line — what "remove the stock" would remove. */
  units: number
  busy: boolean
  onClose: () => void
  onForce: (removeStock: boolean) => void | Promise<void>
}): JSX.Element {
  return (
    <Modal
      title={`${stuck.poNumber} will not delete`}
      subtitle="Its stock has been checked in, so the ordinary delete refuses"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Leave it alone
          </Button>
          <Button
            variant="secondary"
            icon="Trash2"
            loading={busy}
            onClick={() => void onForce(false)}
          >
            Delete, keep the stock
          </Button>
          <Button variant="danger" icon="Trash2" loading={busy} onClick={() => void onForce(true)}>
            Delete and remove {units > 0 ? `${units.toLocaleString()} unit${units === 1 ? '' : 's'}` : 'the stock'}
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">{stuck.reason}</p>
      <p className="fin-confirm-lead">
        <b>Are those boxes physically on the shelf?</b>
      </p>
      <ul className="inv-stuck-list">
        <li>
          <b>No, they never arrived</b> — this was a test or a mistake. Choose{' '}
          <b>Delete and remove the stock</b>. The units come out of inventory, each one against its
          own cost layer where that layer is known and as an ordinary correction down where it is
          not. Every removal is recorded in the product&rsquo;s history naming {stuck.poNumber}.
          Anything already sold cannot come back and is left alone.
        </li>
        <li>
          <b>Yes, they are here</b> — choose <b>Delete, keep the stock</b>. Only the paperwork goes.
          The stock keeps its cost, so what it is worth does not change; what is lost is this
          purchase&rsquo;s row in the cost ledger and the link from the scan history to this order.
        </li>
      </ul>
      <p className="fin-confirm-lead">Either way the purchase order is gone for good.</p>
    </Modal>
  )
}
