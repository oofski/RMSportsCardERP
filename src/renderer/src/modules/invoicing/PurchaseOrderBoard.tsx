import { useState } from 'react'
import type {
  PurchaseOrder,
  PurchaseOrderStatus,
  SupplyOrder,
  SupplyOrderStatus
} from '@shared/types'
import { PO_STAGES, PO_TRANSITIONS, canTransition } from '@shared/purchaseOrders'
import { Icon } from '../../components/Icon'
import { FreightLine, TrackingLine } from '../../components/FreightFields'
import { formatMoney } from '../../lib/format'
import { PO_MOVE_LABEL, PO_STAGE_META } from './helpers'

/**
 * Supply reorders share this board with product POs — they are the same job
 * (money committed to a supplier, waiting to land) and splitting them across
 * two lists meant checking two places to answer one question.
 *
 * Their stage vocabulary differs, so it is mapped onto the PO columns rather
 * than renaming anything: a supply order in transit belongs in the same "in
 * flight" column as a paid PO. The card keeps its OWN status word, so nothing
 * claims a supply order was "Paid" when what is known is that it shipped.
 */
const SUPPLY_COLUMN: Record<SupplyOrderStatus, PurchaseOrderStatus> = {
  ordered: 'ordered',
  in_transit: 'paid',
  delivered: 'received',
  cancelled: 'cancelled'
}

/** The forward move offered on a supply card, and what to call it. */
const SUPPLY_NEXT: Partial<
  Record<SupplyOrderStatus, { to: SupplyOrderStatus; label: string }>
> = {
  ordered: { to: 'in_transit', label: 'In transit' },
  in_transit: { to: 'delivered', label: 'Delivered' }
}

const SUPPLY_STATUS_LABEL: Record<SupplyOrderStatus, string> = {
  ordered: 'Ordered',
  in_transit: 'In transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
}

/**
 * The buy-side pipeline. One column per PO_STAGES entry (Ordered / Paid /
 * Received / Cancelled); each PO sits in the column matching its status. Moves
 * are both button-driven (from PO_TRANSITIONS, so terminal stages show none) and
 * drag-and-drop: a card can be dragged into any column its status can legally
 * transition to (canTransition). Clicking a card body opens its receipt.
 */
export function PurchaseOrderBoard({
  pos,
  supplyOrders,
  canManageSupplies,
  onMove,
  onOpen,
  onDeletePo,
  onMoveSupply,
  onDeleteSupply
}: {
  pos: PurchaseOrder[]
  /** Supply reorders, shown in the same columns and badged as supplies. */
  supplyOrders: SupplyOrder[]
  canManageSupplies: boolean
  /** Receipt line images, kept in the props for parity with the receipt view;
   *  the compact cards don't render thumbnails. */
  thumbnails: Record<string, string>
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
  /** Undefined without the manage permission — the button is then not rendered
   *  at all rather than rendered and refused. */
  onDeletePo?: (id: string, poNumber: string) => void
  onMoveSupply: (order: SupplyOrder, to: SupplyOrderStatus) => void
  onDeleteSupply: (order: SupplyOrder) => void
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<PurchaseOrderStatus | null>(null)
  const fromStatus = dragId ? pos.find((p) => p.id === dragId)?.status ?? null : null

  return (
    <div className="po-board">
      {PO_STAGES.map((stage) => {
        const inStage = pos.filter((p) => p.status === stage.id)
        const suppliesInStage = supplyOrders.filter((o) => SUPPLY_COLUMN[o.status] === stage.id)
        const columnCount = inStage.length + suppliesInStage.length
        const meta = PO_STAGE_META[stage.id]
        const canDrop = !!(dragId && fromStatus && canTransition(fromStatus, stage.id))
        // While dragging, dim the columns this card can't move to (never the
        // column it came from) so valid vs invalid targets are both explicit.
        const noAllow = !!dragId && fromStatus !== stage.id && !canDrop
        return (
          <div
            className={`po-col po-col-${stage.id}${overStage === stage.id ? ' po-col-dragover' : ''}${
              noAllow ? ' po-col-noallow' : ''
            }`}
            key={stage.id}
            onDragOver={(e) => {
              if (canDrop) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overStage !== stage.id) setOverStage(stage.id)
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setOverStage((s) => (s === stage.id ? null : s))
              }
            }}
            onDrop={(e) => {
              e.preventDefault()
              const id = dragId
              if (id && fromStatus && canTransition(fromStatus, stage.id)) onMove(id, stage.id)
              setDragId(null)
              setOverStage(null)
            }}
          >
            <div className="po-col-head">
              <span className="po-col-title">
                <Icon name={meta.icon} size={15} />
                {stage.label}
              </span>
              <span className="po-col-count">{columnCount}</span>
            </div>
            <div className="po-col-body">
              {columnCount === 0 ? (
                <div className="po-col-empty">Nothing here.</div>
              ) : (
                <>
                  {inStage.map((po) => (
                    <PoCard
                      key={po.id}
                      po={po}
                      onMove={onMove}
                      onOpen={onOpen}
                      onDelete={onDeletePo}
                      dragging={dragId === po.id}
                      onDragStart={setDragId}
                      onDragEnd={() => {
                        setDragId(null)
                        setOverStage(null)
                      }}
                    />
                  ))}
                  {suppliesInStage.map((o) => (
                    <SupplyCard
                      key={o.id}
                      order={o}
                      canManage={canManageSupplies}
                      onMove={onMoveSupply}
                      onDelete={onDeleteSupply}
                    />
                  ))}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function PoCard({
  po,
  onMove,
  onOpen,
  onDelete,
  dragging,
  onDragStart,
  onDragEnd
}: {
  po: PurchaseOrder
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
  onDelete?: (id: string, poNumber: string) => void
  dragging: boolean
  onDragStart: (id: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const moves = PO_TRANSITIONS[po.status] ?? []

  /**
   * DELETE LIVES ON THE CARD NOW, and only where it can succeed.
   *
   * It was reachable in exactly one place before — open the PO, scroll the
   * receipt modal, Delete in the footer beside "Open as PDF" — so from the board
   * there was no way to remove a purchase order at all, which reads as the app
   * refusing to let you. A cancelled PO in particular has no moves left and
   * nothing to open it for; it just sits there.
   *
   * Shown only while NOTHING has been checked in, because that is the exact
   * condition `deletePurchaseOrder` enforces. A button whose only outcome is a
   * refusal toast is worse than no button: it teaches the operator that delete
   * is broken rather than that this PO has stock behind it. When units have
   * landed, Cancel is already in `moves` for every non-terminal status — which
   * is the correct next step, and the one the refusal used to have to explain.
   */
  const deletable = onDelete !== undefined && po.receivedUnits === 0
  return (
    <div
      className={`po-card${dragging ? ' po-card-dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', po.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(po.id)
      }}
      onDragEnd={() => onDragEnd()}
      onClick={() => onOpen(po.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(po.id)
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="po-card-top">
        <span className="po-card-num mono">{po.poNumber}</span>
        <span className="po-card-dest" title={`Boxes land at ${po.location}`}>
          → {po.location}
        </span>
      </div>
      <div className="po-card-supplier">{po.supplier || 'No supplier'}</div>
      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(po.total)}</span>
        <span className="po-card-meta">
          {po.lineCount} {po.lineCount === 1 ? 'item' : 'items'}
        </span>
      </div>
      <FreightLine
        carrier={po.carrier}
        service={po.service}
        trackingNumber={po.trackingNumber}
      />
      <TrackingLine
        status={po.trackingStatus}
        checkedAt={po.trackingCheckedAt}
        detail={po.trackingStatusDetail}
        error={po.trackingError}
        attemptedAt={po.trackingAttemptedAt}
        hasTracking={!!po.trackingNumber}
      />
      {(moves.length > 0 || deletable) && (
        <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
          {moves.map((to) => (
            <button
              key={to}
              type="button"
              className={`btn po-move po-move-${to}`}
              onClick={() => onMove(po.id, to)}
            >
              {PO_MOVE_LABEL[to]}
            </button>
          ))}
          {deletable && (
            <button
              type="button"
              className="btn po-move po-move-remove"
              title={`Delete ${po.poNumber}. Nothing checked in, so no stock is affected.`}
              onClick={() => onDelete?.(po.id, po.poNumber)}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A supply reorder, sitting in the same column as the product POs. Everything
 * about it says "supply" before anything else does: a tinted card, a Supply
 * badge in the top row, and the item name where a PO shows its number.
 *
 * The Auto badge is the point of the source field. Once the low-stock reorder
 * automation is buying packaging on its own, this board is where an operator
 * finds out it happened — a card nobody remembers creating has to explain
 * itself rather than look like someone else's mistake.
 */
function SupplyCard({
  order,
  canManage,
  onMove,
  onDelete
}: {
  order: SupplyOrder
  canManage: boolean
  onMove: (order: SupplyOrder, to: SupplyOrderStatus) => void
  onDelete: (order: SupplyOrder) => void
}): JSX.Element {
  const next = SUPPLY_NEXT[order.status]
  const terminal = order.status === 'delivered' || order.status === 'cancelled'
  const perItem = order.items > 0 ? order.total / order.items : 0

  return (
    <div className="po-card po-card-supply" data-status={order.status}>
      <div className="po-card-top">
        <span className="po-supply-badge">
          <Icon name="Package" size={12} />
          Supply
        </span>
        {order.source === 'auto' && (
          <span className="po-supply-auto" title="Placed automatically by the low-stock reorder">
            <Icon name="Zap" size={11} />
            Auto
          </span>
        )}
        <span className="po-card-dest">{SUPPLY_STATUS_LABEL[order.status]}</span>
      </div>

      <div className="po-card-supplier">{order.supplyName}</div>

      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(order.total)}</span>
        <span className="po-card-meta">
          {order.units} {order.unit} · {order.items.toLocaleString()} items
          {perItem > 0 ? ` · ${formatMoney(perItem)}/item` : ''}
        </span>
      </div>

      {canManage && (next || terminal) && (
        <div className="po-card-foot">
          {next && (
            <button
              type="button"
              className="btn po-move po-move-supply"
              onClick={() => onMove(order, next.to)}
            >
              {next.label}
            </button>
          )}
          {!terminal && (
            <button
              type="button"
              className="btn po-move po-move-cancelled"
              onClick={() => onMove(order, 'cancelled')}
            >
              Cancel
            </button>
          )}
          {terminal && (
            <button
              type="button"
              className="btn po-move po-move-remove"
              onClick={() => onDelete(order)}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}
