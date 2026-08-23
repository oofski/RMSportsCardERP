import { useState } from 'react'
import type {
  PurchaseOrder,
  PurchaseOrderStatus,
  SupplyOrder,
  SupplyOrderStatus
} from '@shared/types'
import type { PoColumn } from '@shared/purchaseOrders'
import {
  PO_STAGES,
  PO_TRANSITIONS,
  canTransition,
  displayOrderNumber,
  poColumnOf,
  poColumnStatus
} from '@shared/purchaseOrders'
import { receiveProgress } from '@shared/receiving'
import { Icon } from '../../components/Icon'
import { ReceiveBar } from '../../components/ReceiveProgress'
import { FreightLine, TrackingLine } from '../../components/FreightFields'
import { formatDate, formatMoney } from '../../lib/format'
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
 *
 * BOTH TERMINAL STATES LAND IN COMPLETED. Cancelled has to, because the column
 * it used to sit in is gone and a row that reaches no column has no way back to
 * deleteSupplyOrder. Delivered joins it because a supply order carries no
 * payment at all: delivered IS its finish, and leaving it in Received — a column
 * that now reads "the boxes are here and we still owe for them" — would put a
 * paid-for box of sleeves under a heading about money still outstanding.
 *
 * They leave on their own clock, not the PO one: listSupplyOrders keeps a
 * terminal supply order for 14 days, where a completed PO goes at 1. Nothing
 * reconciles the two numbers because nothing needs to — the card says Supply on
 * it, and neither sweep can strand the other's rows.
 */
const SUPPLY_COLUMN: Record<SupplyOrderStatus, PoColumn> = {
  ordered: 'ordered',
  in_transit: 'paid',
  delivered: 'completed',
  cancelled: 'completed'
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
 * The buy-side pipeline. One column per PO_STAGES entry (Ordered / Received /
 * Paid / Completed); each PO sits in the column `poColumnOf` derives for it,
 * which is not always its status. Moves are both button-driven (from
 * PO_TRANSITIONS, so terminal stages show none) and drag-and-drop: a card can be
 * dragged into any column its status can legally transition to (canTransition).
 * Clicking a card body expands it.
 *
 * COMPLETED TAKES NO DROPS — see poColumnStatus. An order arrives there by being
 * paid AND received, or by being cancelled, and it leaves for history a day
 * later. Dragging into it would have to invent the dates it is derived from.
 */
export function PurchaseOrderBoard({
  pos,
  supplyOrders,
  canManageSupplies,
  onMove,
  onOpen,
  onDeletePo,
  onMarkPaid,
  onBillBuyers,
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
  /** Record a payment, or take one back, without moving the card. See `payable`
   *  in PoCard — the false case is how a mis-ticked payment is undone. */
  onMarkPaid?: (id: string, poNumber: string, paid: boolean) => void
  /**
   * Open the buyer-assignment screen for a dropship that has not been billed.
   *
   * The way back to a screen that used to exist for one moment only — see
   * `billBuyers` in InvoicingModule.
   */
  onBillBuyers?: (id: string) => void
  onMoveSupply: (order: SupplyOrder, to: SupplyOrderStatus) => void
  onDeleteSupply: (order: SupplyOrder) => void
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<PoColumn | null>(null)
  const dragged = dragId ? pos.find((p) => p.id === dragId) ?? null : null
  // The real STATUS decides which moves are legal; the COLUMN decides where the
  // card is drawn. They come apart on an order that is received and paid — see
  // poColumnOf — and using the status for both would dim the very column that
  // card is sitting in the moment somebody picks it up.
  const fromStatus = dragged?.status ?? null
  const fromColumn = dragged ? poColumnOf(dragged) : null

  return (
    <div className="po-board">
      {PO_STAGES.map((stage) => {
        const inStage = pos.filter((p) => poColumnOf(p) === stage.id)
        const suppliesInStage = supplyOrders.filter((o) => SUPPLY_COLUMN[o.status] === stage.id)
        const columnCount = inStage.length + suppliesInStage.length
        const meta = PO_STAGE_META[stage.id]
        // Null on Completed, which is derived rather than set — so it is never a
        // drop target, and the guard is the same one the drop handler uses.
        const dropTo = poColumnStatus(stage.id)
        const canDrop = !!(dragId && fromStatus && dropTo && canTransition(fromStatus, dropTo))
        // While dragging, dim the columns this card can't move to (never the
        // column it came from) so valid vs invalid targets are both explicit.
        const noAllow = !!dragId && fromColumn !== stage.id && !canDrop
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
              if (id && fromStatus && dropTo && canTransition(fromStatus, dropTo)) onMove(id, dropTo)
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
                      onBillBuyers={onBillBuyers}
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
  onBillBuyers,
  dragging,
  onDragStart,
  onDragEnd
}: {
  po: PurchaseOrder
  onMove: (id: string, to: PurchaseOrderStatus) => void
  onOpen: (id: string) => void
  onDelete?: (id: string, poNumber: string) => void
  onMarkPaid?: (id: string, poNumber: string, paid: boolean) => void
  onBillBuyers?: (id: string) => void
  dragging: boolean
  onDragStart: (id: string) => void
  onDragEnd: () => void
}): JSX.Element {
  /**
   * ONE way to say an order has been paid, and it is not a stage move.
   *
   * 'paid' is filtered out here on purpose. It is still a legal transition — the
   * Paid column exists and a card can be dragged into it — but offering it as a
   * button put TWO "Mark paid" buttons on every ordered card: this one, which
   * moved the order into a different column, and the payment button below,
   * which records the payment where the order stands. Two controls with the same
   * words and different effects is worse than either on its own.
   *
   * The payment button wins because it is the one that answers the question
   * being asked — has this been paid for — without also claiming something about
   * where the stock is.
   */
  const moves = (PO_TRANSITIONS[po.status] ?? []).filter((to) => to !== 'paid')

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
   * where it is. Hidden on a cancelled order, whose money is already back out of
   * COGS.
   *
   * IT UN-MARKS TOO, and hiding it once paid was the mistake. A payment ticked
   * on the wrong card had no way back from this board at all: the only thing
   * that cleared `paid_at` was cancelling the order and reopening it, which
   * reverses stock and voids the purchase's cost to undo a mis-click about
   * money. The backend has taken a boolean and logged "Payment un-marked" all
   * along — nothing reached it.
   */
  const payable = onMarkPaid !== undefined && po.status !== 'cancelled'
  /**
   * Has this dropship been sold on yet?
   *
   * `linkedInvoiceId` holds the FIRST sale raised against the order — see
   * linkDropshipPair, which keeps it rather than overwriting it per buyer — so
   * its absence is the honest test for "nothing has been billed". Reading it as
   * "the sale" would be wrong on a multi-shipment order; reading it as "any
   * sale" is exactly what it is.
   *
   * Offered on drop and MIXED orders alike: a mixed order has units going out to
   * somebody as well as onto our own shelf, and those units still need billing.
   */
  const billable =
    onBillBuyers !== undefined &&
    po.dropshipUnits > 0 &&
    !po.linkedInvoiceId &&
    po.status !== 'cancelled'
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
  /**
   * CARDS ARE CLOSED UNTIL ASKED.
   *
   * There are enough purchase orders now that a column of fully-detailed cards
   * is a column nobody can scan: the progress rail, the tracking line, the
   * dropship split and five buttons on every one of them, so finding the order
   * you came for means reading all of them. Closed, a card carries the five
   * things somebody scans a board FOR — which order, who from, how much, how
   * many, and who is carrying it — and nothing else.
   *
   * Per card, and not remembered between visits: expanding one is a question
   * about that order right now ("what can I do with this?"), not a preference,
   * and restoring six open cards on the next load would recreate the wall this
   * exists to remove.
   */
  const [open, setOpen] = useState(false)
  const kindClass =
    po.orderKind === 'drop' ? ' po-card-drop' : po.orderKind === 'mixed' ? ' po-card-mixed' : ''
  const multi = po.destinationCount > 1
  const destination = multi ? `${po.destinationCount} destinations` : po.location

  return (
    <div
      className={`po-card${kindClass}${
        /* THE ORDER SOMEBODY HAS TO CHASE. When the sale on the other end of a
           dropship says it has nothing in hand, this is the document with the
           supplier's name and the tracking number on it — and until now the
           Ready to Ship board knew and this one did not. Blue, the same blue
           awaiting-items wears everywhere else. */
        po.saleAwaitsItems ? ' fx-lane fx-lane-items' : ''
      }${dragging ? ' po-card-dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', po.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(po.id)
      }}
      onDragEnd={() => onDragEnd()}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen((o) => !o)
        }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={open}
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
        {/* Whether it has been paid for, visible WITHOUT opening the card. It is
            the question most often asked of a board like this, and burying it
            one click down would mean expanding every card to answer it. */}
        {po.paidAt && po.status !== 'cancelled' && (
          <span className="po-card-paid" title={`Paid ${formatDate(po.paidAt)}`}>
            <Icon name="Check" size={11} />
            Paid
          </span>
        )}
        {/* STOCK IS HERE AND WE STILL OWE FOR IT.
            Arriving and being paid for are two events that happen in either
            order, and the app never conflates them — but an unpaid order used
            to be shown only by the ABSENCE of the Paid chip, and absence is not
            something anybody scans a board for. A received order carrying a
            balance is the one combination worth interrupting for, so it says so
            rather than leaving the reader to notice a missing badge.

            Deliberately not shown on an order that has arrived nothing yet:
            everything on the board would wear it, and a warning on every card is
            a warning on none. */}
        {!po.paidAt && po.receivedUnits > 0 && po.status !== 'cancelled' && (
          <span
            className="po-card-owed"
            title={`${po.receivedUnits} unit${po.receivedUnits === 1 ? '' : 's'} received and not paid for — ${formatMoney(po.total)} outstanding`}
          >
            Unpaid
          </span>
        )}
        {/* WHICH KIND OF FINISHED. Completed holds two things that arrived there
            for opposite reasons — settled up, and called off — and the column
            heading can only name one of them. Without this chip a cancelled
            order sitting beside a paid one reads as another job well done.

            It says Reopen on the button below, so this is also the only thing
            explaining why that button is there. */}
        {po.status === 'cancelled' && (
          <span
            className="po-card-cancelled"
            title={
              po.cancelledAt
                ? `Cancelled ${formatDate(po.cancelledAt)} — reopen it below if that was a mistake. It files itself away after a day.`
                : 'Cancelled — reopen it below if that was a mistake.'
            }
          >
            <Icon name="Ban" size={11} />
            Cancelled
          </span>
        )}
        <Icon
          name={open ? 'ChevronUp' : 'ChevronDown'}
          size={14}
          className="po-card-chev"
        />
      </div>
      {/* The full name on hover. Truncating without this would LOSE the tail
          of a long party name rather than fold it. */}
      <div className="po-card-supplier" title={po.supplier || 'No supplier'}>
        {po.supplier || 'No supplier'}
      </div>
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
      {open && po.dropshipUnits > 0 && (
        <div className="po-card-drops">
          <Icon name="Truck" size={12} />
          {po.receivableUnits > 0
            ? `${po.receivableUnits} here · ${po.dropshipUnits} drop-shipped`
            : `${po.dropshipUnits} ${po.dropshipUnits === 1 ? 'unit' : 'units'} drop-shipped — none arrive here`}
        </div>
      )}
      {open && showProgress && <ReceiveBar progress={received} compact className="po-card-recv" />}
      {/* Who is carrying it stays on the CLOSED card. It is one of the five
          things the owner asked to still see, and it is what somebody chasing a
          late delivery reads before anything else. */}
      <FreightLine
        carrier={po.carrier}
        service={po.service}
        trackingNumber={po.trackingNumber}
      />
      {open && (
        <TrackingLine
          status={po.trackingStatus}
          checkedAt={po.trackingCheckedAt}
          detail={po.trackingStatusDetail}
          error={po.trackingError}
          attemptedAt={po.trackingAttemptedAt}
          hasTracking={!!po.trackingNumber}
        />
      )}
      {open && (
        <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
          {/* Opening the full order is now an explicit button rather than a
              click on the card, because the click expands. Without it the
              receipt — and with it the PDF, the freight editor and the line
              detail — would have no way in from the board at all. */}
          <button
            type="button"
            className="btn po-move po-move-open"
            onClick={() => onOpen(po.id)}
          >
            Open
          </button>
          {/* THE OTHER HALF OF THE DEAL, and it used to be reachable for about
              five seconds. This offered itself once — the instant the purchase
              order was created — and never again: "Not now", a closed tab or an
              order raised yesterday all left the buyers unnamed with no control
              anywhere that would name them.

              Only while nothing has been billed. Once a sale points back at this
              purchase the assignment is spent, and splitDropshipSales refuses a
              second batch anyway — a button whose only outcome is that refusal
              teaches the operator the feature is broken. */}
          {billable && (
            <button
              type="button"
              className="btn po-move po-move-bill"
              title={`Say who is getting these units and raise ${po.dropshipUnits > 0 ? 'their sales orders' : 'the sales order'}`}
              onClick={() => onBillBuyers?.(po.id)}
            >
              Bill the buyers
            </button>
          )}
          {payable && (
            <button
              type="button"
              className={`btn po-move ${po.paidAt ? 'po-move-unpaid' : 'po-move-paid'}`}
              title={
                po.paidAt
                  ? `${po.poNumber} was marked paid ${formatDate(po.paidAt)}. This takes that back — the order stays exactly where it is and no stock moves.`
                  : `Record that ${po.poNumber} has been paid. It stays where it is — this is the payment, not a stage.`
              }
              onClick={() => onMarkPaid?.(po.id, po.poNumber, !po.paidAt)}
            >
              {po.paidAt ? 'Un-mark paid' : 'Mark paid'}
            </button>
          )}
          {moves.map((to) => (
            <button
              key={to}
              type="button"
              className={`btn po-move po-move-${to}`}
              title={
                po.status === 'received' && to !== 'cancelled'
                  ? `These boxes were not actually checked in — hands the stock back and puts ${po.poNumber} where it was. Refused if any of it has already been sold.`
                  : undefined
              }
              onClick={() => onMove(po.id, to)}
            >
              {/* "Undo receipt", not "Reopen". From CANCELLED, moving to ordered
                  is reopening a dead order; from RECEIVED it is saying the boxes
                  never arrived, which is a different act with different
                  consequences — stock goes back, the purchase stays a purchase.
                  One label for both would describe neither. */}
              {po.status === 'received' && to === 'ordered' ? 'Undo receipt' : PO_MOVE_LABEL[to]}
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

      <div className="po-card-supplier" title={order.supplyName}>
        {order.supplyName}
      </div>

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
