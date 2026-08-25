import { useEffect, useState } from 'react'
import type {
  InventoryProduct,
  PurchaseOrderDetail,
  PurchaseOrderLine,
  PurchaseOrderStatus
} from '@shared/types'
import type { Freight } from '@shared/freight'
import {
  PO_TRANSITIONS,
  destinationHoldsStock,
  destinationSummary,
  displayOrderNumber,
  orderGlows
} from '@shared/purchaseOrders'
import { receiveProgress, receivableProgressOf } from '@shared/receiving'
import { purchaseQtyFloor, stepDownBlockedReason, stepQty } from '@shared/lineQty'
import { api } from '../../lib/api'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { FreightFields } from '../../components/FreightFields'
import { ReceiveBar, ReceivePill } from '../../components/ReceiveProgress'
import { Icon } from '../../components/Icon'
import { OrderHistory } from '../orders/OrderHistory'
import { OrderLabels } from '../orders/OrderLabels'
import { OrderShipments } from '../orders/OrderShipments'
import { formatDate, formatMoney } from '../../lib/format'
import { CategoryLogo } from '../inventory/CategoryLogo'
import { SupplierSelect } from './PartySelect'
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
  const [payBusy, setPayBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  /**
   * Record the payment and refresh in place.
   *
   * Not `onMove(id, 'paid')`. The order does not move: one sitting in Received
   * that has now been paid for has not gone backwards, and sending it to the
   * Paid column would tell everyone looking at the board that its stock had not
   * arrived. `onSaved` repaints the card behind this modal, for the same reason
   * editing the carrier does.
   */
  const markPaid = async (): Promise<void> => {
    if (!detail) return
    setPayBusy(true)
    try {
      const res = await api.purchaseOrders.setPaid(detail.id, true)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not record the payment.')
        return
      }
      setDetail(res.data)
      toast.success(`${res.data.poNumber} is marked paid.`)
      await onSaved()
    } finally {
      setPayBusy(false)
    }
  }

  /**
   * One line's quantity or price, saved and repainted.
   *
   * The whole order comes back from the write, so the grand total and the
   * per-line total are the database's answer rather than one computed here —
   * two arithmetics for one figure is how a receipt starts disagreeing with the
   * ledger. `onSaved` repaints the card behind the modal, which prints the same
   * total.
   */
  const editLine = async (
    lineId: string,
    patch: { quantity?: number; unitPrice?: number }
  ): Promise<void> => {
    const res = await api.purchaseOrders.updateLine(id, lineId, patch)
    if (!res.ok || !res.data) {
      // The refusals are sentences — "3 have already been checked in, so this
      // line cannot go below 3" — so they are shown as written rather than
      // replaced with a generic failure.
      toast.error(res.error ?? 'Could not save that change.')
      // Repaint from the database so the box goes back to the stored figure
      // rather than keeping a number that was not accepted.
      const fresh = await api.purchaseOrders.get(id)
      if (fresh) setDetail(fresh)
      return
    }
    setDetail(res.data)
    await onSaved()
  }

  const removeLine = async (lineId: string, productName: string): Promise<void> => {
    const res = await api.purchaseOrders.removeLine(id, lineId)
    if (!res.ok || !res.data) {
      toast.error(res.error ?? 'Could not remove that line.')
      return
    }
    setDetail(res.data)
    toast.success(`${productName} removed.`)
    await onSaved()
  }

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
  /**
   * Whether the lines accept edits at all.
   *
   * The same two states `addPurchaseOrderLines` refuses, for the same reasons: a
   * cancelled order's cost is out of the ledger, and a received one is closed.
   * The repository refuses either way — this only decides whether to draw
   * controls that would be rejected.
   */
  const linesEditable = detail.status !== 'cancelled' && detail.status !== 'received'
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
      /* ALWAYS the document width, and this was the bug.
         `.modal-lg` is 620px. Take off the padding and the five fixed columns
         and the product name was left with about 110px, so every line on a real
         order read "2025 Topp…" — nine of them in a column, none of them
         distinguishable from each other. A receipt whose whole job is to say
         WHAT was bought cannot be narrower than the names of the things.
         `modal-xl` when there is a Destination column to hold as well. */
      className={routed ? 'modal-xl' : 'modal-po'}
      footer={
        <>
          {/* Adding to an order that already exists.
              A PO was write-once: a missed case meant cancelling and retyping
              the whole thing under a new number, losing the number, the dates
              and any paperwork already sent to the supplier. Hidden once the
              order is closed or cancelled, because addPurchaseOrderLines
              refuses both — a button whose only outcome is a refusal teaches
              people the feature is broken. */}
          {detail.status !== 'cancelled' && detail.status !== 'received' && (
            <Button variant="secondary" icon="Plus" onClick={() => setAdding((a) => !a)}>
              {adding ? 'Done adding' : 'Add product'}
            </Button>
          )}
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
            <SupplierEditor
              po={detail}
              onSaved={(fresh) => {
                setDetail(fresh)
                // The board card behind this modal prints the supplier too.
                void onSaved()
              }}
            />
            <div className="po-rh-date">
              {formatDate(detail.createdAt)} · {shipsTo(detail.orderKind, destinations)}
            </div>
            {/* WHICH DEAL THIS BELONGS TO. The register can fold several
                documents under one number, and until now that was only visible
                from Finance — standing on the order there was nothing to say it
                had been grouped with anything. The number shown is the GROUP's
                when it has one, because that is the number somebody writes on
                paperwork. */}
            {detail.dealTicket && (
              <span
                className="dt-chip mono"
                title={
                  detail.dealTicketMerged
                    ? `Part of deal ticket ${detail.dealTicket}, together with other documents`
                    : `Deal ticket ${detail.dealTicket}`
                }
              >
                {detail.dealTicket}
                {detail.dealTicketMerged ? ' +' : ''}
              </span>
            )}
          </div>
          <div className="po-rh-right">
            <span className={`badge po-badge po-badge-${meta.tone}`}>
              <Icon name={meta.icon} size={13} />
              {meta.label}
            </span>
            {/* The stage badge answers "where is this order"; this answers
                "have we paid for it", and on an order that arrived before the
                invoice was settled those are different questions. Shown as a
                button while the money is owed and as a chip once it is not, so
                the same spot always carries the answer. */}
            {detail.status !== 'cancelled' &&
              (detail.paidAt ? (
                <span className="badge po-badge po-badge-paid" title={`Paid ${formatDate(detail.paidAt)}`}>
                  <Icon name="DollarSign" size={13} />
                  Paid
                </span>
              ) : (
                <button
                  type="button"
                  className="btn po-markpaid"
                  disabled={payBusy}
                  title={`Record that ${detail.poNumber} has been paid. It stays in ${meta.label} — this is the payment, not a stage.`}
                  onClick={() => void markPaid()}
                >
                  <Icon name="DollarSign" size={13} />
                  Mark paid
                </button>
              ))}
          </div>
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

        {adding && (
          <AddLinePanel
            poId={detail.id}
            poNumber={number}
            onAdded={async (fresh) => {
              setDetail(fresh)
              // The board holds its own copy of every PO, and the total and the
              // item count both just moved. Without this the card behind the
              // modal keeps the old figures and closing looks like the add was
              // thrown away — the same reason editing freight repaints.
              await onSaved()
            }}
          />
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

        <div
          className={`po-receipt-lines${routed ? ' po-receipt-lines-routed' : ''}${
            linesEditable ? ' po-receipt-lines-editable' : ''
          }`}
        >
          <div className="po-receipt-line po-receipt-line-head">
            <span className="po-rl-img" aria-hidden="true" />
            <span className="po-rl-name">Product</span>
            <span className="po-rl-qty">Qty</span>
            <span className="po-rl-recv">In</span>
            {routed && <span className="po-rl-dest">Destination</span>}
            <span className="po-rl-price">Unit price</span>
            <span className="po-rl-total">Line total</span>
            {linesEditable && <span className="po-rl-kill" aria-hidden="true" />}
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
                  editable={linesEditable}
                  onEdit={editLine}
                  onRemove={removeLine}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="po-grand-total">
          <span>Grand total</span>
          <span className="mono">{formatMoney(detail.total)}</span>
        </div>

        {/* PARCELS, PAPERWORK AND HISTORY, in that order and all at the bottom.
            Every one of them is read after the thing the document is actually
            for — what was bought, from whom, for how much — so none of them may
            push that below the fold. The history is collapsed on top of that,
            because it is opened when something looks wrong, which is rarely. */}
        <OrderShipments
          side="po"
          orderId={detail.id}
          canEdit={linesEditable}
          lines={detail.lines.map((l) => ({
            id: l.id,
            label: l.productName ?? 'Item',
            quantity: l.quantity
          }))}
        />
        <OrderLabels
          side="po"
          orderId={detail.id}
          // The supplier is who ships a purchase, so they are who a label goes
          // to. A PO's supplier is a NAME on a document rather than a record, so
          // there is no address to hand down — but the contact directory usually
          // holds one under that name, and lookupName is what finds it.
          defaultTo={null}
          lookupName={detail.supplier}
          canEdit={linesEditable}
        />
        <OrderHistory side="po" orderId={detail.id} stageLabel={poStageLabel} />
      </div>
    </Modal>
  )
}

/**
 * How this board names a stage, for the history log.
 *
 * The two boards do not share a vocabulary — 'received' is a purchase order's
 * word and 'sent' is a sales order's — so each supplies its own translation
 * rather than the log guessing from which side it is on. An id with no entry
 * prints itself, which is the right answer for a stage that existed when the
 * event was written and has since been renamed.
 */
function poStageLabel(id: string): string {
  return PO_STAGE_META[id as PurchaseOrderStatus]?.label ?? id
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
  thumb,
  editable,
  onEdit,
  onRemove
}: {
  line: PurchaseOrderLine
  /** Whether this receipt is drawing the Destination column at all. */
  routed: boolean
  headerDestination: string
  thumb: string | undefined
  /**
   * Whether this order is in a state that accepts edits at all. False on a
   * cancelled or closed order, where the repository would refuse anyway — the
   * controls are hidden rather than shown and then rejected, because a button
   * whose only outcome is a refusal teaches people the feature is broken.
   */
  editable: boolean
  onEdit: (lineId: string, patch: { quantity?: number; unitPrice?: number }) => Promise<void>
  onRemove: (lineId: string, productName: string) => Promise<void>
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
        {editable ? (
          <NumberCell
            className="po-rl-qty"
            value={line.quantity}
            step={1}
            min={purchaseQtyFloor(line)}
            format={(v) => String(Math.round(v))}
            label={`Quantity of ${line.productName}`}
            onCommit={(v) => onEdit(line.id, { quantity: Math.round(v) })}
            /* One more, or one fewer. The box stays for "make it 40"; this is
               the change somebody actually makes standing at a shelf, and the
               one that is fiddly to type on a phone. */
            onStep={(delta) =>
              onEdit(line.id, {
                quantity: stepQty(line.quantity, delta, purchaseQtyFloor(line))
              })
            }
            downBlocked={stepDownBlockedReason(
              line.quantity,
              purchaseQtyFloor(line),
              line.qtyReceived
            )}
          />
        ) : (
          <span className="po-rl-qty">{line.quantity}</span>
        )}
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
        {/* Frozen once anything has landed, and it says why on hover rather
            than silently doing nothing. The repository refuses this too — this
            is the courtesy, not the rule. */}
        {editable && line.qtyReceived === 0 ? (
          <NumberCell
            className="po-rl-price"
            value={line.unitPrice}
            step={0.01}
            min={0}
            format={(v) => v.toFixed(2)}
            label={`Unit price of ${line.productName}`}
            onCommit={(v) => onEdit(line.id, { unitPrice: v })}
          />
        ) : (
          <span
            className="po-rl-price mono"
            title={
              editable && line.qtyReceived > 0
                ? `${line.qtyReceived} already received at this price, which is what the stock is costed at. It cannot be changed here.`
                : undefined
            }
          >
            {formatMoney(line.unitPrice)}
          </span>
        )}
        <span className="po-rl-total mono">{formatMoney(line.lineTotal)}</span>
        {editable && (
          <span className="po-rl-kill">
            <button
              type="button"
              className="po-rl-killbtn"
              aria-label={`Remove ${line.productName} from this order`}
              title={
                line.qtyReceived > 0
                  ? `${line.qtyReceived} already checked in against this line, so it cannot be removed.`
                  : `Remove ${line.productName}`
              }
              disabled={line.qtyReceived > 0}
              onClick={() => void onRemove(line.id, line.productName)}
            >
              <Icon name="X" size={14} />
            </button>
          </span>
        )}
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

/**
 * One number, edited where it is displayed.
 *
 * ## Commits on blur and on Enter, never on keystroke
 *
 * Every commit is a round trip that restates the order total and the ledger
 * row, so saving per keystroke would write five times while somebody types
 * "1250" — and the intermediate "1", "12", "125" are all valid numbers the
 * repository would happily accept. Escape puts back what was there, which is
 * the only way out of a half-typed figure that does not involve guessing.
 *
 * Reverts on a refusal rather than keeping the typed value. The caller reports
 * the reason in a toast; leaving the rejected number in the box would show the
 * document saying something the database does not.
 */
function NumberCell({
  value,
  min,
  step,
  format,
  label,
  className,
  onCommit,
  onStep,
  downBlocked
}: {
  value: number
  min: number
  step: number
  format: (v: number) => string
  label: string
  className: string
  onCommit: (v: number) => Promise<void>
  /**
   * Nudge by one. Given only where stepping means something — a unit price has
   * no natural step, and a pair of arrows beside one would invite somebody to
   * walk a price up a cent at a time.
   */
  onStep?: (delta: number) => Promise<void>
  /** Why the minus is greyed out, when it is. Null when it is not. */
  downBlocked?: string | null
}): JSX.Element {
  const [draft, setDraft] = useState(format(value))
  const [busy, setBusy] = useState(false)

  // Follow the saved value when it changes underneath — a successful commit
  // returns the whole order, and a refusal returns the old figure.
  useEffect(() => {
    setDraft(format(value))
    // `format` is a fresh closure each render; the value is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const commit = async (): Promise<void> => {
    const next = Number(draft)
    if (!Number.isFinite(next) || next === value) {
      setDraft(format(value))
      return
    }
    setBusy(true)
    try {
      await onCommit(next)
    } finally {
      setBusy(false)
    }
  }

  const nudge = async (delta: number): Promise<void> => {
    if (!onStep || busy) return
    setBusy(true)
    try {
      await onStep(delta)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className={`${className} po-rl-edit${onStep ? ' has-step' : ''}`}>
      {onStep && (
        <button
          type="button"
          className="po-rl-step"
          disabled={busy || !!downBlocked}
          title={downBlocked ?? 'One fewer'}
          aria-label="One fewer"
          onClick={() => void nudge(-1)}
        >
          <Icon name="Minus" size={12} />
        </button>
      )}
      <input
        className="po-rl-input mono"
        type="number"
        inputMode="decimal"
        aria-label={label}
        min={min}
        step={step}
        disabled={busy}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setDraft(format(value))
            e.currentTarget.blur()
          }
        }}
      />
      {onStep && (
        <button
          type="button"
          className="po-rl-step"
          disabled={busy}
          title="One more"
          aria-label="One more"
          onClick={() => void nudge(1)}
        >
          <Icon name="Plus" size={12} />
        </button>
      )}
    </span>
  )
}

/**
 * Who the order is from, edited on the document itself.
 *
 * ## Why this is a field and not a modal
 *
 * The question it answers — "PO says no supplier, how do I change it to a
 * name?" — was asked while looking straight at the words "No supplier" on this
 * receipt. Anything that made the answer "open a different screen" would be a
 * worse answer than the one the page can give in place.
 *
 * The name is FREE TEXT with suggestions, exactly as it is when an order is
 * raised; see @shared/purchaseOrders for why a supplier is not a foreign key.
 * So this box offers the names already used and accepts one that has never been
 * seen before, with no difference in what gets stored.
 */
function SupplierEditor({
  po,
  onSaved
}: {
  po: PurchaseOrderDetail
  onSaved: (po: PurchaseOrderDetail) => void
}): JSX.Element {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(po.supplier ?? '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(po.supplier ?? '')
  }, [po.id, po.supplier])

  const save = async (): Promise<void> => {
    const next = draft.trim()
    if (next === (po.supplier ?? '').trim()) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      const res = await api.purchaseOrders.setHeader(po.id, { supplier: next || null })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not save the supplier.')
        return
      }
      onSaved(res.data)
      setEditing(false)
      toast.success(next ? `Supplier set to ${next}.` : 'Supplier cleared.')
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={`po-rh-supplier po-rh-supplier-edit${po.supplier ? '' : ' is-empty'}`}
        title="Click to set the supplier"
        onClick={() => setEditing(true)}
      >
        {po.supplier || 'No supplier'}
        <Icon name="Pencil" size={12} />
      </button>
    )
  }

  return (
    <div className="po-rh-supplier-form">
      {/* The SAME control the create form uses, deliberately. A supplier
          chosen here and a supplier chosen there must be the same act, or the
          two screens teach two different ideas of what a supplier is. It
          already carries the "Other…" escape for a distributor nobody has
          bought from yet, which is what keeps the field free text. */}
      <SupplierSelect
        value={draft || null}
        ariaLabel="Supplier"
        blankLabel="No supplier named"
        onChange={(name) => setDraft(name ?? '')}
      />
      <Button variant="primary" loading={busy} onClick={() => void save()}>
        Save
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setDraft(po.supplier ?? '')
          setEditing(false)
        }}
      >
        Cancel
      </Button>
    </div>
  )
}

/**
 * Add a product to an order that already exists.
 *
 * ## Why it lives on the receipt and not on the board
 *
 * The receipt is the document: it is the one place showing what was ordered,
 * from whom, at what price, and how much of it has landed. Adding a line is an
 * edit to that document, and doing it here means the person adding can see the
 * lines already on the order — which is what stops the same case being added
 * twice, the failure this feature otherwise invites.
 *
 * ## The price is the BUY price, and it is not guessed
 *
 * It defaults to the product's recorded unit cost because that is the best
 * available answer, but it is a plain editable field with no clever behaviour:
 * this figure becomes the FIFO cost basis of the units when they are received,
 * so a number quietly filled in from somewhere the operator did not look at
 * would misstate the margin on everything sold out of that layer.
 *
 * Stays open after each add. Somebody correcting an order usually has more than
 * one thing to put on it, and closing after the first would make the second a
 * fresh trip through the button.
 */
function AddLinePanel({
  poId,
  poNumber,
  onAdded
}: {
  poId: string
  poNumber: string
  onAdded: (fresh: PurchaseOrderDetail) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<InventoryProduct[]>([])
  const [picked, setPicked] = useState<InventoryProduct | null>(null)
  const [qty, setQty] = useState('1')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (picked || q.length < 2) {
      setHits([])
      return
    }
    // Debounced, and the result of a stale keystroke is discarded rather than
    // rendered: typing quickly otherwise lets an earlier, slower search land
    // last and replace the list with matches for a prefix of what is in the box.
    let alive = true
    const t = window.setTimeout(() => {
      void api.purchaseOrders.searchCatalog(q).then((r) => {
        if (alive) setHits(r.slice(0, 8))
      })
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [query, picked])

  const choose = (p: InventoryProduct): void => {
    setPicked(p)
    setQuery(p.name)
    setHits([])
    // The recorded cost is a starting point, not an answer — see the note above.
    setPrice(p.unitCost > 0 ? String(p.unitCost) : '')
  }

  const reset = (): void => {
    setPicked(null)
    setQuery('')
    setQty('1')
    setPrice('')
  }

  const n = Math.round(Number(qty))
  const p = Number(price)
  const problem = !picked
    ? 'Pick a product.'
    : !Number.isFinite(n) || n < 1
      ? 'Quantity must be at least 1.'
      : !Number.isFinite(p) || p < 0
        ? 'Enter a unit price.'
        : null

  const submit = async (): Promise<void> => {
    if (!picked || problem) return
    setBusy(true)
    try {
      const res = await api.purchaseOrders.addLines(poId, [
        { productId: picked.id, quantity: n, unitPrice: p }
      ])
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not add that product.')
        return
      }
      toast.success(`${picked.name} added to ${poNumber}.`)
      reset()
      await onAdded(res.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="po-addline">
      <div className="po-addline-head">Add a product to {poNumber}</div>
      <div className="po-addline-row">
        <div className="typeahead po-addline-search">
          <input
            className="input"
            value={query}
            placeholder="Search the catalog…"
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value)
              setPicked(null)
            }}
          />
          {hits.length > 0 && (
            <div className="ta-menu">
              {hits.map((h) => (
                <button key={h.id} type="button" className="ta-item" onClick={() => choose(h)}>
                  <span className="ta-name">{h.name}</span>
                  <span className="ta-detail">{h.sku || h.category}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          className="input po-addline-qty"
          value={qty}
          inputMode="numeric"
          aria-label="Quantity"
          disabled={busy}
          onChange={(e) => setQty(e.target.value)}
        />
        <input
          className="input po-addline-price"
          value={price}
          inputMode="decimal"
          placeholder="Unit price"
          aria-label="Unit price"
          disabled={busy}
          onChange={(e) => setPrice(e.target.value)}
        />
        <Button
          variant="primary"
          loading={busy}
          disabled={busy || !!problem}
          onClick={() => void submit()}
        >
          Add
        </Button>
      </div>
      <div className="po-addline-note">
        {problem ?? `Adds ${n} × ${formatMoney(p)} — ${formatMoney(n * p)} onto this order.`}
      </div>
    </div>
  )
}
