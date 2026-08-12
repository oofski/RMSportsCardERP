import { useEffect, useState } from 'react'
import type { PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderStatus } from '@shared/types'
import type { Freight } from '@shared/freight'
import {
  PO_TRANSITIONS,
  destinationHoldsStock,
  destinationSummary,
  displayOrderNumber,
  orderGlows
} from '@shared/purchaseOrders'
import { receiveProgress, receivableProgressOf } from '@shared/receiving'
import { api } from '../../lib/api'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { FreightFields } from '../../components/FreightFields'
import { ReceiveBar, ReceivePill } from '../../components/ReceiveProgress'
import { Icon } from '../../components/Icon'
import { formatDate, formatMoney } from '../../lib/format'
import { CategoryLogo } from '../inventory/CategoryLogo'
import {
  PO_MOVE_LABEL,
  PO_STAGE_META,
  lineIsWhollyDrop,
  orderDestinations
} from './helpers'

/**
 * A receipt for one PO: header (number, supplier, date, status) then one row per
 * line showing the product image, name/SKU, quantity, unit price paid and line
 * total, closing with the grand total. Stage controls live here too, so a PO can
 * be advanced straight from its receipt.
 *
 * ## The receipt SHOWS what arrived. It does not RECORD it.
 *
 * The count-it-in form used to sit in the middle of this document, and it does
 * not belong here: a part delivery is unpacked at the shelf by somebody holding
 * boxes, not at a desk with a purchase order open, and putting the only form
 * that books stock inside a receipt made the receipt a place where inventory
 * could be changed by accident. It lives on Incoming Inventory now, beside the
 * boxes it is counting, and it lives there ONLY. What stays here is read-only:
 * the progress rail and the per-line pills, so this document can still answer
 * "how much of this turned up" without being able to answer it wrongly.
 *
 * ## Progress is measured against what is COMING HERE
 *
 * `receivableProgressOf`, not `receiveProgressOf`. A drop-shipped unit is
 * ordered and paid for and will never be received, so counting it in the
 * denominator leaves a fully-arrived mixed order stuck at "12 of 20 · 60%" for
 * ever and sends the receiving desk chasing eight boxes that were never
 * addressed to this building.
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
  onClose,
  onSaved
}: {
  id: string
  thumbnails: Record<string, string>
  onMove: (id: string, to: PurchaseOrderStatus) => void | Promise<void>
  /** Absent for users who cannot manage POs, which hides the action entirely. */
  onDelete?: (id: string, poNumber: string) => void | Promise<void>
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
  const number = displayOrderNumber(detail.poNumber, detail.orderKind)
  const destinations = orderDestinations(detail)
  const glow = orderGlows(detail.orderKind)

  /**
   * Lines grouped by the supplier they are actually bought from.
   *
   * A multi-supplier order is one document that has to read as one, and a flat
   * list of nine lines with three different vendors behind them reads as a
   * mistake. A SINGLE-supplier order — which is every order raised before lines
   * could carry their own — renders with no subheading at all, exactly as it
   * always has.
   */
  const groups = groupBySupplier(detail)
  // The Destination column earns its place only when there is more than one
  // answer, the same rule the PDF follows: an ordinary order all going to RM
  // prints the five columns it has always printed.
  const routed = destinations.length > 1 || detail.orderKind !== 'stock'

  return (
    <Modal
      title={number}
      subtitle={`${detail.supplier || 'No supplier'} · ${meta.label}`}
      onClose={onClose}
      wide
      // Only when there is a seventh column to hold. A plain stock PO's receipt
      // is the document it has always been, at the width it has always been.
      className={routed ? 'modal-xl' : ''}
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
              // A pure-drop order never has anything checked in, so the ordinary
              // delete always succeeds on one — which makes it the right button,
              // and Cancel the wrong one unless the money should come back out
              // of COGS.
              title={
                detail.receivableUnits === 0
                  ? `Delete ${number}. Nothing on it ever arrives here, so no stock is affected. Cancel instead if the money should come back out of COGS.`
                  : `Delete ${number}.`
              }
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
      <div className={`po-receipt${glow ? ' po-receipt-drop' : ''}`}>
        <div className="po-receipt-head">
          <div className="po-rh-left">
            {/* Drop-0042, computed here and stored nowhere. `po_number` holds
                PO-0042 for a dropship too, and the two share one counter. */}
            <div className="po-rh-num mono">{number}</div>
            <div className="po-rh-supplier">{detail.supplier || 'No supplier'}</div>
            <div className="po-rh-date">
              {formatDate(detail.createdAt)} · {shipsTo(detail.orderKind, destinations)}
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
            This is the line that answers the question that was actually asked.

            Absent entirely on a pure dropship: there is no delivery to this
            building to measure, and an empty rail would read as one that has
            not started. */}
        {detail.receivableUnits > 0 && (
          <ReceiveBar progress={receivableProgressOf(detail.lines)} className="po-receipt-recv" />
        )}

        {/* Said in words, because "Received" on a mixed order means only that
            everything DUE HERE is here — there is no signal anywhere in this app
            for "the shop got theirs", and inventing a fifth status nobody can
            update would be worse than saying so plainly. */}
        {detail.dropshipUnits > 0 && (
          <div className="po-receipt-dropline">
            <Icon name="Truck" size={15} />
            <span>
              {detail.receivableUnits > 0
                ? `${detail.receivableUnits} unit${detail.receivableUnits === 1 ? '' : 's'} due here. ${detail.dropshipUnits} drop-shipped to ${destinationSummary(destinations.filter((d) => !destinationHoldsStock(d)))} — those never reach RM or AM stock.`
                : `All ${detail.dropshipUnits} unit${detail.dropshipUnits === 1 ? '' : 's'} drop-ship to ${destinationSummary(destinations)}. Nothing on this order arrives here, so it never completes on its own — close it by hand when it is done.`}
            </span>
          </div>
        )}

        {detail.notes && <div className="po-receipt-notes">{detail.notes}</div>}

        <FreightEditor
          po={detail}
          onSaved={(fresh) => {
            setDetail(fresh)
            void onSaved()
          }}
        />

        <div className={`po-receipt-lines${routed ? ' po-receipt-lines-routed' : ''}`}>
          <div className="po-receipt-line po-receipt-line-head">
            <span className="po-rl-img" aria-hidden="true" />
            <span className="po-rl-name">Product</span>
            <span className="po-rl-qty">Qty</span>
            <span className="po-rl-recv">In</span>
            {routed && <span className="po-rl-dest">Destination</span>}
            <span className="po-rl-price">Unit price</span>
            <span className="po-rl-total">Line total</span>
          </div>
          {groups.map((g) => (
            <div className="po-receipt-group" key={g.supplier}>
              {groups.length > 1 && (
                <div className="po-receipt-group-head">
                  <Icon name="Store" size={13} />
                  {g.supplier || 'No supplier'}
                  <em>
                    {g.lines.length} {g.lines.length === 1 ? 'line' : 'lines'}
                  </em>
                </div>
              )}
              {g.lines.map((line) => (
                <ReceiptLine
                  key={line.id}
                  line={line}
                  routed={routed}
                  headerDestination={detail.location}
                  thumb={thumbnails[line.productId]}
                />
              ))}
            </div>
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

/** "Ships to RM" / "Drop-ships to Fenwick Cards" / "2 destinations". */
function shipsTo(kind: PurchaseOrderDetail['orderKind'], destinations: string[]): string {
  const summary = destinationSummary(destinations)
  if (!summary) return 'No destination'
  if (kind === 'mixed') return summary
  return kind === 'drop' ? `Drop-ships to ${summary}` : `Ships to ${summary}`
}

/**
 * Lines under the supplier they are actually bought from, in the order the
 * suppliers first appear on the order.
 *
 * The effective supplier — the allocation's, or the line's, or the header's —
 * because that is the name the money will be attributed to and the name the
 * cost layer will carry. A line whose SPLITS name different suppliers has no
 * single answer (`line.supplier` is null for exactly that reason), so it is
 * filed under the header and its splits say the rest inside the row.
 */
function groupBySupplier(
  detail: PurchaseOrderDetail
): Array<{ supplier: string; lines: PurchaseOrderLine[] }> {
  const groups: Array<{ supplier: string; lines: PurchaseOrderLine[] }> = []
  for (const line of detail.lines) {
    const name = (line.supplier ?? detail.supplier ?? '').trim()
    const at = groups.findIndex((g) => g.supplier.toLowerCase() === name.toLowerCase())
    if (at >= 0) groups[at].lines.push(line)
    else groups.push({ supplier: name, lines: [line] })
  }
  return groups
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
  routed,
  headerDestination,
  thumb
}: {
  line: PurchaseOrderLine
  /** Whether this receipt is drawing the Destination column at all. */
  routed: boolean
  headerDestination: string
  thumb: string | undefined
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // Per LINE, not per order. A shipment that arrives in two vans is not evenly
  // spread across the order — five of one item and none of another is the
  // ordinary case, and the order-level percentage cannot show it.
  //
  // Measured against the line's RECEIVABLE units: a line of 20 with 8 going
  // straight to a shop is complete at 12, and reading it against 20 would leave
  // it amber for ever.
  const got = receiveProgress(line.qtyReceivable, line.qtyReceived)
  const wholly = lineIsWhollyDrop(line)
  const split = line.allocations.length > 0
  const dest = split
    ? `${new Set(line.allocations.map((a) => a.destination)).size} destinations`
    : line.destination ?? headerDestination

  return (
    <>
      <div className="po-receipt-line" data-recv={wholly ? 'drop' : got.state}>
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
          {/* A wholly drop-shipped line has no progress to report, so it does
              not get a progress pill. "0 of 0" would read as a delivery that has
              not started; the marker says it is never coming. */}
          {wholly ? <span className="po-drop-chip">Drop</span> : <ReceivePill progress={got} />}
        </span>
        {routed && (
          <span className="po-rl-dest">
            {split ? (
              <button
                type="button"
                className="po-rl-splitbtn"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                <Icon name="Split" size={12} />
                {dest}
                <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={13} />
              </button>
            ) : (
              <span className="po-rl-destname" title={dest}>
                {dest || '—'}
                {/* Only when there IS a destination. An empty cell is a line
                    whose routing has not been read yet, not a dropship. */}
                {dest.trim().length > 0 && !destinationHoldsStock(dest) && (
                  <span className="po-drop-chip">Drop</span>
                )}
              </span>
            )}
          </span>
        )}
        <span className="po-rl-price mono">{formatMoney(line.unitPrice)}</span>
        <span className="po-rl-total mono">{formatMoney(line.lineTotal)}</span>
      </div>

      {/* The split, opened out. No money is repeated: the allocations divide the
          line's units, not its total, and printing a share of the money against
          each would invite somebody to add them up and reconcile them against a
          figure that was never apportioned. */}
      {split &&
        open &&
        line.allocations.map((a) => (
          <div className="po-receipt-alloc" key={a.id}>
            <span className="po-ra-qty mono">{a.quantity}</span>
            <span className="po-ra-dest">
              {a.destination}
              {!a.holdsStock && <span className="po-drop-chip">Drop</span>}
            </span>
            <span className="po-ra-sup">{a.supplier || '—'}</span>
            <span className="po-ra-in">
              {a.holdsStock ? `${a.qtyReceived} of ${a.quantity} in` : 'Never arrives here'}
            </span>
          </div>
        ))}
    </>
  )
}
