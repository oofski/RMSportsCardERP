import { useState } from 'react'
import type { PurchaseOrder, PurchaseOrderStatus } from '@shared/types'
import { PO_STAGES, PO_TRANSITIONS, canTransition } from '@shared/purchaseOrders'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { PO_MOVE_LABEL, PO_STAGE_META } from './helpers'

/**
 * The buy-side pipeline. One column per PO_STAGES entry (Ordered / Paid /
 * Received / Cancelled); each PO sits in the column matching its status. Moves
 * are both button-driven (from PO_TRANSITIONS, so terminal stages show none) and
 * drag-and-drop: a card can be dragged into any column its status can legally
 * transition to (canTransition). Clicking a card body opens its receipt.
 */
export function PurchaseOrderBoard({
  pos,
  onMove,
  onOpen
}: {
  pos: PurchaseOrder[]
  /** Receipt line images, kept in the props for parity with the receipt view;
   *  the compact cards don't render thumbnails. */
  thumbnails: Record<string, string>
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<PurchaseOrderStatus | null>(null)
  const fromStatus = dragId ? pos.find((p) => p.id === dragId)?.status ?? null : null

  return (
    <div className="po-board">
      {PO_STAGES.map((stage) => {
        const inStage = pos.filter((p) => p.status === stage.id)
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
              <span className="po-col-count">{inStage.length}</span>
            </div>
            <div className="po-col-body">
              {inStage.length === 0 ? (
                <div className="po-col-empty">Nothing here.</div>
              ) : (
                inStage.map((po) => (
                  <PoCard
                    key={po.id}
                    po={po}
                    onMove={onMove}
                    onOpen={onOpen}
                    dragging={dragId === po.id}
                    onDragStart={setDragId}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverStage(null)
                    }}
                  />
                ))
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
  dragging,
  onDragStart,
  onDragEnd
}: {
  po: PurchaseOrder
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
  dragging: boolean
  onDragStart: (id: string) => void
  onDragEnd: () => void
}): JSX.Element {
  const moves = PO_TRANSITIONS[po.status] ?? []
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
        <span className="po-card-total mono">{formatMoney(po.total)}</span>
      </div>
      <div className="po-card-supplier">{po.supplier || 'No supplier'}</div>
      <div className="po-card-meta">
        {po.lineCount} {po.lineCount === 1 ? 'item' : 'items'} · → {po.location}
      </div>
      {moves.length > 0 && (
        <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
          {moves.map((to) => (
            <button
              key={to}
              type="button"
              className={`btn btn-sm po-move po-move-${to}`}
              onClick={() => onMove(po.id, to)}
            >
              {PO_MOVE_LABEL[to]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
