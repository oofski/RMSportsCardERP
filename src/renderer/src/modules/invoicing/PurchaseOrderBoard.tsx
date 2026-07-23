import type { PurchaseOrder, PurchaseOrderStatus } from '@shared/types'
import { PO_STAGES, PO_TRANSITIONS } from '@shared/purchaseOrders'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { PO_MOVE_LABEL, PO_STAGE_META } from './helpers'

/**
 * The buy-side pipeline. One column per PO_STAGES entry (Ordered / Paid /
 * Received / Cancelled); each PO sits in the column matching its status. Moves
 * are button-driven (no drag-and-drop for MVP) — the available buttons come from
 * PO_TRANSITIONS so terminal stages show none. Clicking a card body opens its
 * receipt.
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
  return (
    <div className="po-board">
      {PO_STAGES.map((stage) => {
        const inStage = pos.filter((p) => p.status === stage.id)
        const meta = PO_STAGE_META[stage.id]
        return (
          <div className={`po-col po-col-${stage.id}`} key={stage.id}>
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
                  <PoCard key={po.id} po={po} onMove={onMove} onOpen={onOpen} />
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
  onOpen
}: {
  po: PurchaseOrder
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const moves = PO_TRANSITIONS[po.status] ?? []
  return (
    <div
      className="po-card"
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
