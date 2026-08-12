import { useState } from 'react'
import type {
  PurchaseOrder,
  PurchaseOrderStatus,
  SupplyOrder,
  SupplyOrderStatus
} from '@shared/types'
import { PO_STAGES, PO_TRANSITIONS, canTransition, displayOrderNumber } from '@shared/purchaseOrders'
import { receiveProgress } from '@shared/receiving'
import { Icon } from '../../components/Icon'
import { ReceiveBar } from '../../components/ReceiveProgress'
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
  onMarkPaid,
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
  /** Record a payment without moving the card. See `payable` in PoCard. */
  onMarkPaid?: (id: string, poNumber: string) => void
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
                      onMarkPaid={onMarkPaid}
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
  onMarkPaid,
  dragging,
  onDragStart,
  onDragEnd
}: {
  po: PurchaseOrder
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
  onDelete?: (id: string, poNumber: string) => void
  onMarkPaid?: (id: string, poNumber: string) => void
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
  /**
   * "Mark paid" is offered wherever the money is still owed — which is most
   * often on an order sitting in RECEIVED.
   *
   * Stock regularly turns up before the invoice is settled. Until now the only
   * way to record that payment was the Paid stage, and a received order cannot
   * move backwards into it, so the payment simply went unrecorded; worse, the
   * habit it created was clicking Paid on arrival to unblock Received, which
   * made the paid date on those orders mean nothing at all.
   *
   * So it is not a stage button. It stamps a date and the card stays exactly
   * where it is. Hidden once paid — the chip in the header says so from then on
   * — and hidden on a cancelled order, whose money is already back out of COGS.
   */
  const payable = onMarkPaid !== undefined && !po.paidAt && po.status !== 'cancelled'
  // Only worth a rail once something has actually landed. A whole column of
  // empty bars on orders still with the supplier is noise that makes the ONE
  // half-arrived shipment harder to pick out, which is the opposite of the job.
  //
  // Measured against RECEIVABLE units, so a pure dropship shows no rail at all:
  // its denominator is zero, nothing is arriving, and a bar is a promise that
  // something will.
  const received = receiveProgress(po.receivableUnits, po.receivedUnits)
  const showProgress =
    po.receivableUnits > 0 && received.state !== 'none' && po.status !== 'cancelled'

  /**
   * The glow is a class on the EXISTING card, not a second kind of card.
   *
   * A dropship is a purchase order: same columns, same moves, same money, same
   * counter. What differs is where its boxes go, and that is a property of the
   * order rather than a different sort of document — so it gets a tint and a
   * prefix, not a component of its own.
   */
  const kindClass =
    po.orderKind === 'drop' ? ' po-card-drop' : po.orderKind === 'mixed' ? ' po-card-mixed' : ''
  const multi = po.destinationCount > 1
  const destination = multi ? `${po.destinationCount} destinations` : po.location

  return (
    <div
      className={`po-card${kindClass}${dragging ? ' po-card-dragging' : ''}`}
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
        {/* Drop-0042 for an order where nothing is coming here; PO-0042 for
            everything else, MIXED INCLUDED. The prefix answers exactly one
            question — are boxes coming to this building? — and on a mixed order
            they are. See displayOrderNumber. */}
        <span className="po-card-num mono">{displayOrderNumber(po.poNumber, po.orderKind)}</span>
        <span
          className="po-card-dest"
          title={
            multi
              ? `Its units go to ${po.destinationCount} destinations — open the order for the list. Default: ${po.location}`
              : po.receivableUnits > 0
                ? `Boxes land at ${po.location}`
                : `Ships straight to ${po.location} — nothing arrives here`
          }
        >
          → {destination}
        </span>
      </div>
      <div className="po-card-supplier">{po.supplier || 'No supplier'}</div>
      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(po.total)}</span>
        <span className="po-card-meta">
          {po.lineCount} {po.lineCount === 1 ? 'item' : 'items'}
          {/* Units, next to items, because they are different numbers and the
              gap between them is where a partial delivery hides: nine items can
              be thirty-eight units. */}
          {po.orderedUnits > 0 && ` · ${po.orderedUnits} ${po.orderedUnits === 1 ? 'unit' : 'units'}`}
        </span>
      </div>
      {/* The split, named on the card. The glow says part of this order never
          arrives; this says how much and stops the receiving desk counting the
          whole ordered figure off the line above. */}
      {po.dropshipUnits > 0 && (
        <div className="po-card-drops">
          <Icon name="Truck" size={12} />
          {po.receivableUnits > 0
            ? `${po.receivableUnits} here · ${po.dropshipUnits} drop-shipped`
            : `${po.dropshipUnits} ${po.dropshipUnits === 1 ? 'unit' : 'units'} drop-shipped — none arrive here`}
        </div>
      )}
      {showProgress && <ReceiveBar progress={received} compact className="po-card-recv" />}
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
      {(moves.length > 0 || deletable || payable) && (
        <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
          {payable && (
            <button
              type="button"
              className="btn po-move po-move-paid"
              title={`Record that ${po.poNumber} has been paid. It stays where it is — this is the payment, not a stage.`}
              onClick={() => onMarkPaid?.(po.id, po.poNumber)}
            >
              Mark paid
            </button>
          )}
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
