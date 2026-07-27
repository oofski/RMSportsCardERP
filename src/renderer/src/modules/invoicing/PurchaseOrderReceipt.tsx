import { useEffect, useState } from 'react'
import type { PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderStatus } from '@shared/types'
import { PO_TRANSITIONS } from '@shared/purchaseOrders'
import { api } from '../../lib/api'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { Icon } from '../../components/Icon'
import { formatDate, formatMoney } from '../../lib/format'
import { CategoryLogo } from '../inventory/CategoryLogo'
import { PO_MOVE_LABEL, PO_STAGE_META } from './helpers'

/**
 * A receipt for one PO: header (number, supplier, date, status) then one row per
 * line showing the product image, name/SKU, quantity, unit price paid and line
 * total, closing with the grand total. Stage controls live here too, so a PO can
 * be advanced straight from its receipt.
 *
 * "Open as PDF" does NOT print this markup. window.print() used to, behind a
 * pile of @media rules that hid the app and un-hid `.po-receipt` — but the
 * receipt sits inside a modal inside a fixed-height overflow:hidden shell, so
 * the output was clipped to one viewport and long POs came out blank. The main
 * process now builds a real paginated A4 document from the PO's data instead;
 * see src/main/poPdf.ts.
 */
export function PurchaseOrderReceipt({
  id,
  thumbnails,
  onMove,
  onDelete,
  onClose
}: {
  id: string
  thumbnails: Record<string, string>
  onMove: (id: string, to: PurchaseOrderStatus) => void | Promise<void>
  /** Absent for users who cannot manage POs, which hides the action entirely. */
  onDelete?: (id: string, poNumber: string) => void | Promise<void>
  onClose: () => void
}): JSX.Element {
  const toast = useToast()
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)
  const [pdfBusy, setPdfBusy] = useState<'open' | 'save' | null>(null)

  useEffect(() => {
    let active = true
    api.purchaseOrders.get(id).then((d) => {
      if (active) setDetail(d)
    })
    return () => {
      active = false
    }
  }, [id])

  if (!detail) {
    return (
      <Modal title="Purchase order" onClose={onClose} wide>
        <CenterLoader />
      </Modal>
    )
  }

  const meta = PO_STAGE_META[detail.status]
  const moves = PO_TRANSITIONS[detail.status] ?? []

  return (
    <Modal
      title={detail.poNumber}
      subtitle={`${detail.supplier || 'No supplier'} · ${meta.label}`}
      onClose={onClose}
      wide
      footer={
        <>
          {moves.map((to) => (
            <Button
              key={to}
              variant="secondary"
              onClick={async () => {
                await onMove(detail.id, to)
                const fresh = await api.purchaseOrders.get(id)
                setDetail(fresh)
              }}
            >
              {PO_MOVE_LABEL[to]}
            </Button>
          ))}
          {onDelete && (
            <Button
              variant="danger"
              icon="Trash2"
              onClick={() => void onDelete(detail.id, detail.poNumber)}
            >
              Delete
            </Button>
          )}
          <Button
            icon="Save"
            loading={pdfBusy === 'save'}
            disabled={pdfBusy !== null}
            onClick={async () => {
              setPdfBusy('save')
              try {
                const res = await api.purchaseOrders.savePdf(detail.id)
                // A cancelled save dialog is not a failure — say nothing.
                if (!res.ok && !res.canceled) {
                  toast.error(res.error ?? 'Could not save the PDF.')
                } else if (res.ok) {
                  toast.success('PDF saved.')
                }
              } finally {
                setPdfBusy(null)
              }
            }}
          >
            Save PDF
          </Button>
          <Button
            variant="primary"
            icon="FileText"
            loading={pdfBusy === 'open'}
            disabled={pdfBusy !== null}
            onClick={async () => {
              setPdfBusy('open')
              try {
                const res = await api.purchaseOrders.openPdf(detail.id)
                if (!res.ok) toast.error(res.error ?? 'Could not open the PDF.')
              } finally {
                setPdfBusy(null)
              }
            }}
          >
            Open as PDF
          </Button>
        </>
      }
    >
      <div className="po-receipt">
        <div className="po-receipt-head">
          <div className="po-rh-left">
            <div className="po-rh-num mono">{detail.poNumber}</div>
            <div className="po-rh-supplier">{detail.supplier || 'No supplier'}</div>
            <div className="po-rh-date">
              {formatDate(detail.createdAt)} · Ships to {detail.location}
            </div>
          </div>
          <span className={`badge po-badge po-badge-${meta.tone}`}>
            <Icon name={meta.icon} size={13} />
            {meta.label}
          </span>
        </div>

        <div className="po-receipt-timeline">
          <TimeRow icon="ShoppingCart" label="Ordered" date={detail.orderedAt} />
          <TimeRow icon="DollarSign" label="Paid" date={detail.paidAt} />
          <TimeRow icon="PackageCheck" label="Received" date={detail.receivedAt} />
        </div>

        {detail.notes && <div className="po-receipt-notes">{detail.notes}</div>}

        <div className="po-receipt-lines">
          <div className="po-receipt-line po-receipt-line-head">
            <span className="po-rl-img" aria-hidden="true" />
            <span className="po-rl-name">Product</span>
            <span className="po-rl-qty">Qty</span>
            <span className="po-rl-price">Unit price</span>
            <span className="po-rl-total">Line total</span>
          </div>
          {detail.lines.map((line) => (
            <ReceiptLine key={line.id} line={line} thumb={thumbnails[line.productId]} />
          ))}
        </div>

        <div className="po-grand-total">
          <span>Grand total</span>
          <span className="mono">{formatMoney(detail.total)}</span>
        </div>
      </div>
    </Modal>
  )
}

function TimeRow({
  icon,
  label,
  date
}: {
  icon: string
  label: string
  date: string | null
}): JSX.Element {
  return (
    <div className="po-rt-row">
      <Icon name={icon} size={14} />
      <span className="po-rt-label">{label}</span>
      <span className="po-rt-date mono">{date ? formatDate(date) : '—'}</span>
    </div>
  )
}

function ReceiptLine({
  line,
  thumb
}: {
  line: PurchaseOrderLine
  thumb: string | undefined
}): JSX.Element {
  return (
    <div className="po-receipt-line">
      <span className="po-rl-img po-line-img">
        {thumb ? (
          <img src={thumb} alt={line.productName} />
        ) : (
          <CategoryLogo category={line.category} size={34} />
        )}
      </span>
      <span className="po-rl-name">
        <span className="po-rl-pname">{line.productName}</span>
        <span className="po-rl-sku mono">{line.sku}</span>
      </span>
      <span className="po-rl-qty">{line.quantity}</span>
      <span className="po-rl-price mono">{formatMoney(line.unitPrice)}</span>
      <span className="po-rl-total mono">{formatMoney(line.lineTotal)}</span>
    </div>
  )
}
