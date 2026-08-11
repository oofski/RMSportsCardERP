import { useEffect, useState } from 'react'
import type { PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderStatus } from '@shared/types'
import type { Freight } from '@shared/freight'
import { PO_TRANSITIONS } from '@shared/purchaseOrders'
import { receiveProgress, receiveProgressOf } from '@shared/receiving'
import { api } from '../../lib/api'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { FreightFields } from '../../components/FreightFields'
import { ReceiveBar, ReceivePill } from '../../components/ReceiveProgress'
import { Icon } from '../../components/Icon'
import { formatDate, formatMoney } from '../../lib/format'
import { CategoryLogo } from '../inventory/CategoryLogo'
import { DeliveryPanel } from './DeliveryPanel'
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
  canReceive = false,
  onClose,
  onSaved
}: {
  id: string
  thumbnails: Record<string, string>
  onMove: (id: string, to: PurchaseOrderStatus) => void | Promise<void>
  /** Absent for users who cannot manage POs, which hides the action entirely. */
  onDelete?: (id: string, poNumber: string) => void | Promise<void>
  /**
   * Whether this person may book a delivery into stock.
   *
   * The main process gates it too — this only decides whether to draw a form
   * whose only outcome would be a refusal.
   */
  canReceive?: boolean
  onClose: () => void
  /**
   * Re-read the board.
   *
   * Editing shipping here changes what the CARD behind this modal says, and the
   * board holds its own copy of every PO. Without this the receipt showed the
   * new carrier, the card behind it showed the old one, and closing the modal
   * looked like the save had been thrown away.
   */
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)

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
          {/* One PDF button, not two. Opening the document already offers Save
              in the viewer — on the desktop and in the browser alike — so a
              separate Save button was a second way to do a thing the first way
              already did, taking up the widest row on the receipt. */}
          <Button
            variant="primary"
            icon="FileText"
            loading={pdfBusy}
            disabled={pdfBusy}
            onClick={async () => {
              setPdfBusy(true)
              try {
                const res = await api.purchaseOrders.openPdf(detail.id)
                if (!res.ok) toast.error(res.error ?? 'Could not open the PDF.')
              } finally {
                setPdfBusy(false)
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

        {/* What has actually landed, directly under the dates.
            The "Received" date above is stamped only when the LAST unit lands,
            so on a half-arrived order it reads "—" — which is true and useless.
            This is the line that answers the question that was actually asked. */}
        <ReceiveBar progress={receiveProgressOf(detail.lines)} className="po-receipt-recv" />

        {canReceive && (
          <DeliveryPanel
            po={detail}
            onReceived={(fresh) => {
              setDetail(fresh)
              void onSaved()
            }}
          />
        )}

        {detail.notes && <div className="po-receipt-notes">{detail.notes}</div>}

        <FreightEditor
          po={detail}
          onSaved={(fresh) => {
            setDetail(fresh)
            void onSaved()
          }}
        />

        <div className="po-receipt-lines">
          <div className="po-receipt-line po-receipt-line-head">
            <span className="po-rl-img" aria-hidden="true" />
            <span className="po-rl-name">Product</span>
            <span className="po-rl-qty">Qty</span>
            <span className="po-rl-recv">In</span>
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

/**
 * Shipping and payment on an EXISTING order.
 *
 * This is where a tracking number is actually entered, because it does not
 * exist when the PO is raised — it arrives in a shipping confirmation hours or
 * days later. Save appears only once something has changed, so the receipt does
 * not carry a button that usually does nothing.
 */
function FreightEditor({
  po,
  onSaved
}: {
  po: PurchaseOrderDetail
  onSaved: (po: PurchaseOrderDetail) => void
}): JSX.Element {
  const toast = useToast()
  const saved: Freight = {
    carrier: po.carrier,
    service: po.service,
    trackingNumber: po.trackingNumber,
    paymentTiming: po.paymentTiming
  }
  const [draft, setDraft] = useState<Freight>(saved)
  const [busy, setBusy] = useState(false)

  // Reset when a different PO is shown, or when a save returns a normalised
  // value (a pasted number can set a carrier nobody chose).
  useEffect(() => {
    setDraft({
      carrier: po.carrier,
      service: po.service,
      trackingNumber: po.trackingNumber,
      paymentTiming: po.paymentTiming
    })
  }, [po.id, po.carrier, po.service, po.trackingNumber, po.paymentTiming])

  const dirty =
    draft.carrier !== saved.carrier ||
    (draft.service ?? '') !== (saved.service ?? '') ||
    (draft.trackingNumber ?? '') !== (saved.trackingNumber ?? '') ||
    draft.paymentTiming !== saved.paymentTiming

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.purchaseOrders.setFreight(po.id, draft)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not save the shipping details.')
        return
      }
      onSaved(res.data)
      toast.success('Shipping details saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="po-receipt-freight">
      <FreightFields
        {...draft}
        hint="Who is bringing it"
        onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      />
      {dirty && (
        <div className="po-receipt-freight-save">
          <Button variant="primary" icon="Save" loading={busy} onClick={save}>
            Save shipping
          </Button>
        </div>
      )}
    </div>
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
  // Per LINE, not per order. A shipment that arrives in two vans is not evenly
  // spread across the order — five of one item and none of another is the
  // ordinary case, and the order-level percentage cannot show it.
  const got = receiveProgress(line.quantity, line.qtyReceived)
  return (
    <div className="po-receipt-line" data-recv={got.state}>
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
      <span className="po-rl-recv">
        <ReceivePill progress={got} />
      </span>
      <span className="po-rl-price mono">{formatMoney(line.unitPrice)}</span>
      <span className="po-rl-total mono">{formatMoney(line.lineTotal)}</span>
    </div>
  )
}
