import { useCallback, useEffect, useState } from 'react'
import type { Invoice, InvoiceCustomer, InvoiceDetail, InvoiceStatus } from '@shared/invoices'
import {
  INVOICE_STAGES,
  canMoveInvoice,
  isDropshipSale,
  isInvoicePaid,
  money,
  qboTotalState,
  salesOrderKindOf
} from '@shared/invoices'
import {
  FULFILLMENT_STAGE_TONE,
  fulfillmentNextStepDetail,
  fulfillmentStageOf,
  fulfillmentTickShort,
  readyToShipBlockedReason,
  shipsFromAway
} from '@shared/fulfillment'
import {
  ORDER_FILTERS,
  orderStatusChips,
  passesOrderFilters,
  type OrderFilterId
} from '@shared/orderStatus'
import { paidAction, quickBooksAction } from '@shared/orderActions'
import { DimsModal } from './DimsModal'
import { QuickConfirm } from './QuickConfirm'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { FreightLine, TrackingLine } from '../../components/FreightFields'
import { PaymentBar } from '../../components/PaymentProgress'
import { CheckTrackingButton } from '../../components/CheckTrackingButton'
import { MatchByNumberModal } from './MatchByNumberModal'
import { AttachPurchaseOrderModal } from './AttachPurchaseOrderModal'
import { RouteLinesModal } from './RouteLinesModal'
import { EditOrderModal } from './EditOrderModal'
import { PayUpFrontModal } from '../orders/PayUpFrontModal'
import { useToast } from '../../components/Toast'
import { formatDate, formatMoney } from '../../lib/format'
import { CreateInvoiceModal } from './CreateInvoiceModal'
import { DropshipPurchaseStep } from './DropshipPurchaseStep'
import { formatDay } from './helpers'

/**
 * The sell-side pipeline: Draft → In QuickBooks → Sent → Paid.
 *
 * Deliberately the SAME board as purchase orders — same columns, same cards,
 * same drag-and-drop, same CSS. They are mirror images of each other and
 * somebody who has moved a PO from Ordered to Paid already knows how to move an
 * invoice from Sent to Paid. A second, cleverer layout for the same idea would
 * be one more thing to learn for no gain.
 *
 * ## Paid is a tick, and the screen says so
 *
 * This app has no bank feed. "Paid" means somebody recorded that the money
 * arrived, which is a real and useful fact — it is the question the owner
 * actually asks — but it is a note, not a reconciliation, and the footer says
 * that rather than letting the column imply otherwise.
 *
 * ## Moves are forward only
 *
 * An invoice that has been posted cannot be un-posted from here, and one marked
 * paid in error is fixed in QuickBooks rather than by dragging a card back. But
 * `draft → paid` IS allowed, because plenty of invoices here are settled in
 * cash without ever going near QuickBooks, and a board that forced somebody to
 * post an invoice they had already been paid for would simply be lied to.
 */
export function InvoicesBoard({
  onOpenQuickBooks
}: {
  onOpenQuickBooks: () => void
}): JSX.Element {
  const toast = useToast()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customers, setCustomers] = useState<InvoiceCustomer[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [stats, setStats] = useState({
    draft: 0,
    created: 0,
    sent: 0,
    paid: 0,
    outstanding: 0,
    owedCount: 0,
    paidTotal: 0,
    thisMonth: 0
  })
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<InvoiceDetail | null>(null)
  /** The sale whose purchase has not been raised yet. See DropshipPurchaseStep. */
  const [needsPurchase, setNeedsPurchase] = useState<InvoiceDetail | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [matching, setMatching] = useState(false)
  /**
   * The sale somebody is attaching a purchase order to.
   *
   * A summary, not a detail: attaching touches only the link, so nothing here
   * needs the lines — which is also what lets it work on an order that has left
   * draft and can no longer be opened as a form.
   */
  const [attaching, setAttaching] = useState<Invoice | null>(null)
  /**
   * The sale whose lines are being re-routed.
   *
   * A DETAIL, unlike `attaching` — this one edits the lines, so it needs them.
   * Fetched on demand rather than held for every card.
   */
  const [routing, setRouting] = useState<InvoiceDetail | null>(null)
  /** The order being corrected. See EditOrderModal. */
  const [pricing, setPricing] = useState<InvoiceDetail | null>(null)
  const [paying, setPaying] = useState<InvoiceDetail | null>(null)
  const [nextNumber, setNextNumber] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  /**
   * The invoice somebody has asked to delete, held until they confirm it.
   *
   * A held record rather than a window.confirm because the thing worth showing
   * is WHICH invoice and for how much — "Delete 1043 · Chris Smith · $412.50"
   * is checkable, and "Are you sure?" is not. Deleting the wrong one is
   * unrecoverable: there is no undo and no trash.
   */
  const [deleting, setDeleting] = useState<Invoice | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overStage, setOverStage] = useState<InvoiceStatus | null>(null)
  /**
   * Which of the six filters are ticked.
   *
   * NOT REMEMBERED between visits, and that is deliberate. A filter is a
   * question somebody is asking right now — "which of these have not shipped?" —
   * not a preference, and a board that opens two days later still hiding half
   * its orders is a board somebody reports as having lost their invoices.
   */
  const [filters, setFilters] = useState<Set<OrderFilterId>>(() => new Set())

  const load = useCallback(async () => {
    const [list, people, s, next] = await Promise.all([
      api.invoices.list(),
      api.invoices.customers(),
      api.invoices.stats(),
      api.invoices.nextNumber()
    ])
    setInvoices(list)
    setCustomers(people)
    setStats(s)
    setNextNumber(next)
  }, [])

  /**
   * Ask QuickBooks what it knows about the invoices already posted there.
   *
   * QuickBooks does not call this app — there is no webhook on this
   * integration — so an invoice emailed from their UI, or a payment recorded
   * against one, stays invisible here until something asks. This is that ask,
   * and it is the whole of the status feature: sent and paid are read back and
   * the invoice's stage moves to match.
   *
   * QUIET UNLESS ASKED. On the timer it says nothing when nothing changed —
   * a toast every quarter hour announcing "0 invoices moved" trains people to
   * dismiss toasts without reading them, and the next one matters. Pressed by
   * hand it always answers, because silence after pressing a button reads as a
   * broken button.
   *
   * ## MOVING COLUMN IS NOT THE ONLY THING A CHECK CAN CHANGE
   *
   * This watched `moved` alone, and `moved` counts cards that changed STAGE. A
   * card already sitting in Paid on this floor does not change
   * stage when the money finally appears in QuickBooks — `nextStageFromQbo`
   * returns null the moment what Intuit says matches where the card already is —
   * so the board never re-read itself and the payment bar went on drawing the
   * balance from before the payment. Pressing Check QuickBooks then answered
   * "nothing has changed" over a row whose balance had just gone to zero, which
   * is how a working button convinces somebody it is broken.
   *
   * `updated` is the count that actually means "a figure moved", so it drives
   * both the redraw and the sentence.
   */
  const syncStatus = useCallback(
    async (announce: boolean): Promise<void> => {
      setSyncing(true)
      try {
        const res = await api.invoices.syncQboStatus()
        if (!res.ok || !res.data) {
          if (announce) toast.error(res.error ?? 'Could not reach QuickBooks.')
          return
        }
        const moved = res.data.moved.length
        const updated = res.data.updated ?? 0
        if (moved > 0 || updated > 0) await load()
        if (moved > 0) {
          toast.success(
            moved === 1
              ? `1 invoice moved to ${res.data.moved[0].to}.`
              : `${moved} invoices moved.`
          )
        } else if (updated > 0) {
          // Nothing changed column, but something changed. Naming the figure
          // rather than the count would be better still and needs the backend to
          // say WHICH figure; this at least never claims nothing happened.
          toast.success(
            updated === 1
              ? '1 invoice updated from QuickBooks.'
              : `${updated} invoices updated from QuickBooks.`
          )
        } else if (announce) {
          toast.success(
            res.data.checked === 0
              ? 'Nothing posted to QuickBooks yet.'
              : `Checked ${res.data.checked} — nothing has changed.`
          )
        }
      } finally {
        setSyncing(false)
      }
    },
    [load, toast]
  )

  // FIFTEEN MINUTES, and the first run is immediate. Invoices are not a
  // real-time object — a payment lands when it lands and nobody is watching the
  // second it does — so polling harder would spend somebody's API quota to
  // shorten a wait nobody is sitting through. The manual button covers the
  // moment when somebody IS waiting.
  useEffect(() => {
    void syncStatus(false)
    const t = setInterval(() => void syncStatus(false), 15 * 60 * 1000)
    return () => clearInterval(t)
  }, [syncStatus])

  useLiveRefresh(LIVE.invoices, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  // Line-item images for the invoice receipt, loaded once and shared by every
  // invoice opened this session — base64 thumbnails are comparatively heavy, and
  // the same catalog backs every line. Same call the PO board makes.
  useEffect(() => {
    let active = true
    void api.purchaseOrders.thumbnails().then((t) => {
      if (active) setThumbnails(t)
    })
    return () => {
      active = false
    }
  }, [])

  /**
   * Open the paid-up-front dialog, which needs the whole order rather than the
   * card's summary: the amount defaults to the total and the warning about a
   * part payment is arithmetic against it.
   */
  const openForPayment = async (id: string): Promise<void> => {
    const detail = await api.invoices.get(id)
    if (!detail) {
      toast.error('That order is gone.')
      await load()
      return
    }
    setPaying(detail)
  }

  const open = async (id: string): Promise<void> => {
    const detail = await api.invoices.get(id)
    if (!detail) {
      toast.error('That invoice is gone.')
      await load()
      return
    }
    setEditing(detail)
  }

  /**
   * Move a card.
   *
   * `created` is not a status somebody can simply assign — getting into
   * QuickBooks means actually posting — so dropping a card there runs the real
   * thing. Every other move is a local status change.
   */
  const move = async (inv: Invoice, to: InvoiceStatus): Promise<void> => {
    if (busy || !canMoveInvoice(inv.status, to)) return
    setBusy(inv.id)
    try {
      if (to === 'created') {
        const res = await api.invoices.createInQbo(inv.id)
        if (!res.ok) {
          toast.error(res.error ?? 'QuickBooks would not take that invoice.')
          return
        }
        toast.success(
          res.data?.numberChanged
            ? `Created in QuickBooks as ${res.data.docNumber} — it renumbered ours. Opening it now.`
            : 'Created in QuickBooks. Opening it now — press Send there.'
        )
      } else {
        const res = await api.invoices.setStatus(inv.id, to)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not move that.')
          return
        }
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  // Emailing the buyer used to be a button on every card. It is not here any
  // more — see the note in the card footer — and the handler went with it
  // rather than being left behind as dead code that a future edit would wire
  // back up without re-reading why it was removed. `api.invoices.sendFromQbo`
  // is still there for whenever this app wants to do the emailing itself.

  /**
   * Delete, once it has been confirmed.
   *
   * The open receipt is closed on the way out. Leaving it up would leave a
   * modal describing a row that no longer exists, and its own Delete button
   * would then fail with "already gone" — which reads as the app being broken
   * rather than as the delete having worked.
   */
  const remove = async (): Promise<void> => {
    const target = deleting
    if (!target || busy) return
    setBusy(target.id)
    try {
      const res = await api.invoices.remove(target.id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not delete that.')
        return
      }
      // WHICH OF THE TWO HAPPENED. The local delete always succeeds; the
      // QuickBooks one is attempted and may be refused — a paid invoice cannot
      // be deleted there. Saying only "deleted" would leave somebody believing
      // their books are clear when an invoice is still sitting on them.
      const label = target.invoiceNumber ? `Invoice ${target.invoiceNumber}` : 'Invoice'
      if (res.data?.qboError) {
        toast.error(
          `${label} deleted here, but it is STILL IN QUICKBOOKS — ${res.data.qboError}. ` +
            'Void or delete it there if it should not be on the books.'
        )
      } else if (res.data?.removedFromQbo) {
        toast.success(`${label} deleted here and in QuickBooks.`)
      } else {
        toast.success(`${label} deleted.`)
      }
      setDeleting(null)
      setEditing(null)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const exportCsv = async (): Promise<void> => {
    const res = await api.invoices.exportCsv()
    if (res.ok) toast.success(`Exported to ${res.path}`)
    else if (!res.canceled) toast.error(res.error ?? 'Export failed.')
  }

  if (loading) return <CenterLoader />

  const toggleFilter = (id: OrderFilterId): void =>
    setFilters((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /**
   * The orders that survive the ticked filters.
   *
   * `readyToPack` is handed in rather than re-derived inside the predicate:
   * `fulfillmentStageOf` owns that answer, it reads eleven facts off the order,
   * and a second spelling of it in the filter module would be a second set of
   * gates to keep in step with the cards' own chips.
   */
  const shown = invoices.filter((i) =>
    passesOrderFilters(
      { ...i, readyToPack: fulfillmentStageOf(i) === 'ready' },
      filters
    )
  )

  const dragging = dragId ? invoices.find((i) => i.id === dragId) ?? null : null
  const fromStatus = dragging?.status ?? null
  // WHY READY TO SHIP WOULD TURN THIS CARD DOWN, worked out once for the drag
  // rather than per column. `canMoveInvoice` only knows the SHAPE of the
  // pipeline; this is the money rule, and the server keeps it whatever this
  // says — see invoiceStageRefusal. Dimming the column is so the answer arrives
  // before the drop rather than as a toast after it.
  const dragBlocked = dragging ? readyToShipBlockedReason(dragging) : null

  return (
    <>
      <div className="po-page-head">
        <h2>Invoices</h2>
        <div className="po-page-stats">
          {/* OPEN, first and in the same place as the buy side.
              The purchase board has always led with a count and this led with
              money, so the two halves of the same question — who still owes
              us, who do we still owe — could not be read the same way. Counted
              off the same predicate as the figure beside it, so the pair can
              never describe different sets of orders. */}
          <div className="po-page-stat">
            <span className="po-page-stat-val">{stats.owedCount}</span>
            <span className="po-page-stat-label">Open</span>
          </div>
          <div className="po-page-stat">
            <span className="po-page-stat-val mono">
              {formatMoney(stats.outstanding, { compact: true })}
            </span>
            <span className="po-page-stat-label">Awaiting payment</span>
          </div>
          <div className="po-page-stat">
            <span className="po-page-stat-val mono">
              {formatMoney(stats.paidTotal, { compact: true })}
            </span>
            <span className="po-page-stat-label">Paid</span>
          </div>
          <div className="po-page-stat">
            <span className="po-page-stat-val mono">
              {formatMoney(stats.thisMonth, { compact: true })}
            </span>
            <span className="po-page-stat-label">Billed this month</span>
          </div>
        </div>
        {/* The actions travel as one group for the same reason they do on the PO
            page: loose siblings after a margin-left:auto stats block wrap one at
            a time, and New invoice was the one that fell off the edge. */}
        <div className="po-page-actions">
          <Button variant="secondary" icon="FileSpreadsheet" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
          <CheckTrackingButton onDone={load} />
          {/* THE ONLY WAY AN INVOICE MOVES ON ITS OWN. QuickBooks does not call
              this app, so a payment recorded there is invisible here until
              somebody asks. It also runs on a timer below; the button exists
              because "did that just land?" is asked at a moment, not on a
              schedule, and waiting a quarter of an hour to find out is how
              people go and look in QuickBooks instead. */}
          <Button
            variant="secondary"
            icon="RefreshCw"
            loading={syncing}
            disabled={syncing}
            onClick={() => void syncStatus(true)}
          >
            Check QuickBooks
          </Button>
          {/* A PRESS, NOT A TIMER, and the modal explains why at length. Short
              version: a shared invoice number is a uniqueness test, not an
              identity test, and the id a match writes is what Delete deletes and
              Send emails. What IS automatic is everything after — an attached
              order moves to Paid on the ordinary check like any other. */}
          <Button variant="secondary" icon="Link" onClick={() => setMatching(true)}>
            Attach by number
          </Button>
          <Button variant="primary" icon="Plus" onClick={() => setCreatingNew(true)}>
            New invoice
          </Button>
        </div>
      </div>

      {invoices.length === 0 ? (
        <div className="po-page-empty">
          <Icon name="ReceiptText" size={26} />
          <div className="po-page-empty-title">Nothing billed yet</div>
          <p>
            Write an invoice to bill a buyer for what they bought. It stays a draft here until
            you post it to QuickBooks or mark it paid.
          </p>
          <Button variant="primary" icon="Plus" onClick={() => setCreatingNew(true)}>
            New invoice
          </Button>
        </div>
      ) : (
        <>
        {/* NARROWING THE BOARD DOWN TO THE QUESTION SOMEBODY CAME WITH.

            The chips on each card make the three facts readable one at a time.
            This is what makes them readable ACROSS a board: "unpaid and not
            shipped" is the pile where nothing has happened, and "paid and ready
            to pack" is the list of labels to go and buy — which is the view the
            owner asked for by name and the one that had no home.

            Combined with AND, and nothing ticked shows everything. See
            passesOrderFilters, which owns both rules so this row and the cards
            cannot disagree about what "shipped" means. */}
        <div className="inv-filters">
          <span className="inv-filters-lead">Show only</span>
          {ORDER_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`inv-filter${filters.has(f.id) ? ' on' : ''}`}
              title={f.hint}
              aria-pressed={filters.has(f.id)}
              onClick={() => toggleFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
          {/* Only once something is ticked. A permanent "showing 12 of 12" is a
              number nobody reads, and the count matters exactly when a filter is
              hiding things — including when it is hiding all of them. */}
          {filters.size > 0 && (
            <>
              <span className="inv-filters-count">
                {shown.length} of {invoices.length}
              </span>
              <button type="button" className="link-btn" onClick={() => setFilters(new Set())}>
                Clear
              </button>
            </>
          )}
        </div>
        <div className="po-board">
          {INVOICE_STAGES.map((stage) => {
            const inStage = shown.filter((i) => i.status === stage.id)
            const moneyBlocks = stage.id === 'sent' && !!dragBlocked
            const canDrop = !!(
              dragId &&
              fromStatus &&
              canMoveInvoice(fromStatus, stage.id) &&
              !moneyBlocks
            )
            // While dragging, dim the columns this card cannot reach — never the
            // one it came from — so valid and invalid targets are both explicit.
            const noAllow = !!dragId && fromStatus !== stage.id && !canDrop
            return (
              <div
                key={stage.id}
                className={`po-col po-col-${stage.id}${
                  overStage === stage.id ? ' po-col-dragover' : ''
                }${noAllow ? ' po-col-noallow' : ''}`}
                onDragOver={(e) => {
                  if (!canDrop) return
                  e.preventDefault()
                  setOverStage(stage.id)
                }}
                onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
                onDrop={(e) => {
                  e.preventDefault()
                  setOverStage(null)
                  const inv = invoices.find((i) => i.id === dragId)
                  setDragId(null)
                  if (inv) void move(inv, stage.id)
                }}
              >
                <div className="po-col-head">
                  {/* The dimmed column says WHY while the card is still in the
                      air. A column that simply refuses the drop reads as a
                      broken drag, and the answer — they have not paid — is one
                      somebody can act on immediately. */}
                  <span className="po-col-title" title={moneyBlocks ? dragBlocked : stage.hint}>
                    {stage.label}
                  </span>
                  <span className="po-col-count">{inStage.length}</span>
                </div>
                <div className="po-col-body">
                  {inStage.length === 0 && <div className="po-col-empty">Nothing here.</div>}
                  {inStage.map((inv) => (
                    <InvoiceCard
                      key={inv.id}
                      invoice={inv}
                      busy={busy === inv.id}
                      onOpen={() => void open(inv.id)}
                      onDragStart={() => setDragId(inv.id)}
                      onDragEnd={() => {
                        setDragId(null)
                        setOverStage(null)
                      }}
                      onMove={(to) => void move(inv, to)}
                      onItemsInHand={async () => {
                        if (busy) return
                        setBusy(inv.id)
                        try {
                          const res = await api.invoices.setItemsInHand(inv.id, true)
                          if (!res.ok) {
                            toast.error(res.error ?? 'Could not mark the goods in hand.')
                            return
                          }
                          await load()
                        } finally {
                          setBusy(null)
                        }
                      }}
                      onSendAnyway={async () => {
                        if (busy) return
                        setBusy(inv.id)
                        try {
                          const res = await api.invoices.setForceReady(inv.id, true)
                          if (!res.ok) {
                            toast.error(res.error ?? 'Could not move it.')
                            return
                          }
                          toast.success('Moved to ready to ship.')
                          await load()
                        } finally {
                          setBusy(null)
                        }
                      }}
                      onSetPaid={async (next) => {
                        if (busy) return
                        setBusy(inv.id)
                        try {
                          const res = await api.invoices.setPaid(inv.id, next)
                          if (!res.ok) {
                            toast.error(res.error ?? 'Could not record that.')
                            return
                          }
                          await load()
                        } finally {
                          setBusy(null)
                        }
                      }}
                      onReload={load}
                      onRetryPush={async () => {
                        // BUSY, LIKE EVERY OTHER ACTION ON THIS CARD. This one
                        // was the exception, and it is the one action that
                        // WRITES TO SOMEBODY'S BOOKS: a second click while the
                        // first push was still in the air sent a second invoice.
                        // The main process refuses the duplicate now, but a
                        // button that stays live during a three-second network
                        // call still invites the click.
                        if (busy) return
                        setBusy(inv.id)
                        try {
                          const res = await api.invoices.retryQboPush(inv.id)
                          if (!res.ok || !res.data) {
                            toast.error(res.error ?? 'Could not reach QuickBooks.')
                            return
                          }
                          if (!res.data.pushed) {
                            toast.error(res.data.error ?? 'QuickBooks refused it again.')
                          } else {
                            toast.success(`Now in QuickBooks as invoice ${res.data.docNumber}.`)
                          }
                          await load()
                        } finally {
                          setBusy(null)
                        }
                      }}
                      onDelete={() => setDeleting(inv)}
                      onPdf={() => void api.invoices.openPdf(inv.id)}
                      onEditPrices={async () => {
                        const full = await api.invoices.get(inv.id)
                        if (full) setPricing(full)
                        else toast.error('That order is gone.')
                      }}
                      onPayUpFront={() => void openForPayment(inv.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        </>
      )}

      {(editing || creatingNew) && (
        <CreateInvoiceModal
          invoice={editing}
          customers={customers}
          nextNumber={nextNumber}
          thumbnails={thumbnails}
          onClose={() => {
            setEditing(null)
            setCreatingNew(false)
          }}
          onSaved={load}
          // A DROPSHIP IS TWO DEALS AND THIS IS THE HINGE BETWEEN THEM — the
          // mirror of what the Purchase Orders board does after a purchase that
          // ships somewhere that is not ours. The sale is written; the purchase
          // that supplies it has not been.
          onSavedInvoice={(saved) => {
            // Nothing to buy on a sale that comes off our own shelf.
            if (!isDropshipSale(saved)) return
            // ALREADY HALF OF A PAIR. A sale raised through the purchase-side
            // flow arrives here carrying its own purchase order, and asking
            // again would be asking somebody to buy the same goods twice.
            if (saved.sourcePoId) return
            setNeedsPurchase(saved)
          }}
          onDelete={(inv) => setDeleting(inv)}
          onOpenQuickBooks={onOpenQuickBooks}
        />
      )}

      {needsPurchase && (
        <DropshipPurchaseStep
          invoice={needsPurchase}
          onClose={() => setNeedsPurchase(null)}
          onDone={load}
        />
      )}

      {attaching && (
        <AttachPurchaseOrderModal
          invoice={attaching}
          onClose={() => setAttaching(null)}
          onDone={load}
        />
      )}

      {routing && (
        <RouteLinesModal
          invoice={routing}
          onClose={() => setRouting(null)}
          onDone={load}
          // A line a supplier ships direct records where its goods came from by
          // naming one of the purchase orders attached to this sale, so a sale
          // with none attached needs a way to get there. Hands over rather than
          // stacking two modals: the attach screen reloads the board, and the
          // routing screen has to come back with the new list to offer it.
          onAttachOrders={() => {
            setRouting(null)
            setAttaching(routing)
          }}
        />
      )}

      {pricing && (
        <EditOrderModal
          invoice={pricing}
          onClose={() => setPricing(null)}
          onDone={load}
          /* The three that left the card. Each hand-off closes Edit first, so
             only one of these screens is ever open — see EditOrderModal's
             header on why they are hand-offs and not sections. */
          onRoute={() => setRouting(pricing)}
          onAttachPo={() => setAttaching(pricing)}
          onBookStock={async () => {
            const res = await api.invoices.rebookStock(pricing.id)
            if (!res.ok) {
              toast.error(res.error || 'The stock could not be booked.')
              return
            }
            // BOOKED and STILL-NOTHING are both successes and must read
            // differently: "no stock on the shelf" is a different problem from
            // "done", and a green tick on it would be a lie.
            if ((res.data?.units ?? 0) > 0) toast.success(res.data!.message)
            else toast.error(res.data?.message ?? 'Nothing was booked.')
            await load()
          }}
        />
      )}

      {paying && (
        <PayUpFrontModal
          invoice={paying}
          onClose={() => setPaying(null)}
          onSaved={load}
        />
      )}

      {matching && (
        <MatchByNumberModal
          onClose={() => setMatching(false)}
          onMatched={async () => {
            await load()
            // Attaching writes an id and nothing else — the card is where it
            // was. This is the run that reads a stage off the new id, so a
            // settled invoice lands in Paid while somebody is still looking at
            // the board rather than a quarter of an hour later.
            await syncStatus(false)
          }}
        />
      )}

      {deleting && (
        <DeleteInvoiceModal
          invoice={deleting}
          busy={busy === deleting.id}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}

      <p className="inv-foot">
        <Icon name="Info" size={14} />
        <span>
          <b>Paid</b> is a note somebody ticks when the money arrives — this app has no
          bank feed, so it records what you tell it rather than reconciling an account.
          Dragging a card to <b>In QuickBooks</b> actually posts the invoice; everything
          else just moves it.
        </span>
      </p>
    </>
  )
}

/**
 * One invoice, as a card.
 *
 * Same shell as a PO card so the two boards read identically, down to the
 * footer: full-width `.po-move` buttons in a column, the destructive one last.
 * They were bare `.po-card-btn` elements with no rule behind that class at all,
 * so every action on this board rendered as a raw browser button on a themed
 * card — the single loudest reason the sell side looked older than the buy side.
 *
 * What differs from a PO card is what it says: a PO card leads with the supplier
 * because that is who is owed, and this leads with the BUYER because that is who
 * owes.
 */
/**
 * The face of the one QuickBooks button, per act.
 *
 * `none` gets the same info glyph as a disabled state elsewhere rather than a
 * warning one: an order that never went to QuickBooks is a fact about how it was
 * settled, not a problem to fix.
 */
const QBO_ICON: Record<ReturnType<typeof quickBooksAction>['id'], string> = {
  push: 'ArrowUpRight',
  'push-again': 'RefreshCw',
  retry: 'RefreshCw',
  check: 'RefreshCw',
  'record-payment': 'DollarSign',
  open: 'ExternalLink',
  none: 'Info'
}

/** The confirmations this card can raise. See the ASKS table below. */
type AskId = 'items' | 'send' | 'unpaid' | 'push-again' | 'qbo-payment'

/**
 * WHAT EACH CONFIRMATION SAYS.
 *
 * Keyed rather than nested, so a new one is a new entry instead of a sixth arm
 * on five separate ternaries. Every one of them names the ORDER — a dialog that
 * only asks "are you sure?" is answered yes by reflex.
 *
 * Two of these are new, and both guard a press that reaches somebody's real
 * books: sending an invoice that a crashed attempt may already have posted, and
 * banking a payment in QuickBooks. Neither can be undone from this app.
 */
const ASKS: Record<
  AskId,
  (
    label: string,
    qbo: ReturnType<typeof quickBooksAction>,
    pay: ReturnType<typeof paidAction>
  ) => { title: string; detail: string; confirmLabel: string; confirmIcon: string; tone?: 'danger' | 'primary' }
> = {
  items: (label) => ({
    title: 'Goods are in hand?',
    detail: `${label} moves on to be weighed and measured.`,
    confirmLabel: 'Yes, they are here',
    confirmIcon: 'Check',
    tone: 'primary'
  }),
  send: (label) => ({
    title: 'Send it anyway?',
    detail: `${label} moves straight to ready to ship, ahead of the usual gates.`,
    confirmLabel: 'Move it',
    confirmIcon: 'ArrowRight',
    tone: 'primary'
  }),
  unpaid: (label, _qbo, pay) => ({
    title: 'Withdraw the payment?',
    detail: `${label} goes back to unpaid. ${pay.title}`,
    confirmLabel: 'Mark not paid',
    confirmIcon: 'RotateCcw',
    tone: 'danger'
  }),
  'push-again': (label, qbo) => ({
    title: 'Send it again?',
    detail: `${label} ${qbo.title}`,
    confirmLabel: 'Send it',
    confirmIcon: 'RefreshCw',
    tone: 'danger'
  }),
  'qbo-payment': (_label, qbo) => ({
    title: 'Record this payment in QuickBooks?',
    detail: qbo.title,
    confirmLabel: 'Record it',
    confirmIcon: 'DollarSign',
    tone: 'primary'
  })
}

function InvoiceCard({
  invoice,
  busy,
  onOpen,
  onDragStart,
  onDragEnd,
  onMove,
  onRetryPush,
  onDelete,
  onPdf,
  onEditPrices,
  onPayUpFront,
  onItemsInHand,
  onSendAnyway,
  onSetPaid,
  onReload
}: {
  invoice: Invoice
  busy: boolean
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (to: InvoiceStatus) => void
  /** Try a QuickBooks push that failed on save. */
  onRetryPush: () => Promise<void>
  onDelete: () => void
  onPdf: () => void
  /**
   * Open the Edit screen. It is the door to routing, the attached purchases and
   * re-taking the shelf as well — see EditOrderModal.
   */
  onEditPrices: () => void
  /** Open the record-a-payment dialog. See paidAction in @shared/orderActions. */
  onPayUpFront: () => void
  /** Confirm the goods arrived — the only signal a dropship has. */
  onItemsInHand: () => Promise<void>
  /** Move it straight to ready, ahead of the gates. */
  onSendAnyway: () => Promise<void>
  /** Record, or withdraw, that the money arrived. Never moves the order. */
  onSetPaid: (paid: boolean) => Promise<void>
  /** Reload the board — after the dims editor writes, or a QuickBooks re-check. */
  onReload: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [measuring, setMeasuring] = useState(false)
  const [asking, setAsking] = useState<AskId | null>(null)
  /** A payment is being recorded in QuickBooks. Locks the button so a slow
   *  relay cannot be pressed twice into two payments. */
  const [payingQbo, setPayingQbo] = useState(false)
  // What to call this order in a sentence. The number if it has one; a draft
  // may not, and "Invoice null moves on" is worse than the vaguer phrase.
  const label = invoice.invoiceNumber ? `Sales order ${invoice.invoiceNumber}` : 'This order'

  // THE FACT, NOT THE COLUMN. An order sitting in Payment that nobody has been
  // paid for is exactly the one that can be overdue, and reading the stage here
  // made every one of them look settled the moment its card was dragged.
  const paid = isInvoicePaid(invoice)
  const overdue =
    !paid && invoice.status !== 'void' && invoice.dueDate < new Date().toISOString().slice(0, 10)

  // ALWAYS DELETABLE. This was gated on the invoice not yet being in
  // QuickBooks, which was right when saving and posting were separate steps and
  // became wrong the moment Save started posting immediately: every invoice
  // carries a QuickBooks id within seconds, so the button had effectively
  // disappeared. Delete now removes the remote copy first and only then the
  // local one — see the IPC handler for why that order is not interchangeable.
  const deletable = true
  const settled = paid || invoice.status === 'void'
  /**
   * THE SAME YELLOW THE BUY SIDE USES, and deliberately the same class names.
   *
   * A dropship is one deal with two documents, and until now only the purchase
   * order looked like one. Somebody scanning the Sales Orders board had no way
   * to tell that an order's boxes never touch a shelf here — which is exactly
   * the thing that decides whether the packing floor should expect it.
   *
   * `po-card-drop` and `po-card-mixed` are reused rather than mirrored under new
   * names: this card already renders as `po-card`, so the two boards are the
   * same component family and a parallel set of sell-side classes would be two
   * definitions of one colour, drifting the first time either is adjusted.
   */
  const kind = salesOrderKindOf(invoice)
  const kindClass = kind === 'drop' ? ' po-card-drop' : kind === 'mixed' ? ' po-card-mixed' : ''
  /**
   * What this card may claim about our total versus QuickBooks'. See
   * qboTotalState — it distinguishes a real disagreement from a reading that is
   * simply older than the change, which is what the banner used to conflate.
   */
  const qboState = qboTotalState(invoice)
  /**
   * THE TWO BUTTONS THE OWNER ASKED FOR, decided in one place each.
   *
   * "have a quickbooks button just one that tells me the status and moves it
   * into quickbooks if needed, mark it as paid, like dont need 2 buttons there".
   *
   * Nine buttons on this card; five of them were QuickBooks and two were money.
   * The reason there were five and two is that each was gated separately, months
   * apart, and separately-written gates overlap — which is how "Mark paid" and
   * "Paid up front…" came to sit side by side both claiming the same word for
   * the second time in this file's history.
   *
   * These two calls return exactly ONE action each, so that arrangement is no
   * longer expressible. Every word on the faces and in the tooltips comes from
   * @shared/orderActions, which is tested against every field combination the
   * two can be in; nothing below decides anything.
   */
  const qbo = quickBooksAction(invoice, { money: formatMoney, day: formatDay })
  const pay = paidAction(invoice)
  const [checkingQbo, setCheckingQbo] = useState(false)
  /**
   * Bank the payment in QuickBooks.
   *
   * Moved off its own button and onto the shared one, but nothing else about it
   * changed: it stays a SEPARATE PRESS from ticking paid, because an action that
   * moves money has to be the thing somebody pressed rather than something that
   * happened while they pressed something else, and it is still the only
   * arrangement where a failure reaches the person who caused it instead of a
   * log. It now asks first — the merge put it one press from acts that are
   * harmless, and this one is not.
   *
   * The amount is deliberately absent from the button: the backend takes a FRESH
   * reading and pays what QuickBooks says is outstanding at that moment, which
   * is not necessarily what this screen is displaying. See @shared/quickbooksPayment.
   */
  const recordQboPayment = async (): Promise<void> => {
    setPayingQbo(true)
    try {
      const res = await api.invoices.recordQboPayment(invoice.id)
      if (!res.ok) {
        toast.error(res.error || 'QuickBooks would not take the payment.')
        return
      }
      // POSTED and DID-NOT-NEED-POSTING are both successes and read differently
      // on purpose: "nothing was owing" is not a thing that went wrong, and a
      // red box for it teaches people to dismiss the red box that matters.
      toast.success(res.data?.message ?? 'Nothing needed recording.')
      await onReload()
    } finally {
      setPayingQbo(false)
    }
  }

  /**
   * Ask QuickBooks about THIS ONE invoice, now.
   *
   * The same read the board's Check QuickBooks button runs across everything —
   * one invoice at a time so answering a banner costs one call rather than a
   * sweep. Silent on failure beyond the toast: a reading that did not happen
   * must never overwrite one that did, which the handler already guarantees.
   */
  const onCheckQbo = async (): Promise<void> => {
    setCheckingQbo(true)
    try {
      const res = await api.invoices.syncQboStatus(invoice.id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not reach QuickBooks.')
        return
      }
      await onReload()
    } finally {
      setCheckingQbo(false)
    }
  }

  /**
   * WHERE THE GOODS ARE, on the board about where the DOCUMENT is.
   *
   * A STRIPE rather than a tint, and that is the whole reason it can be here at
   * all: the card's background already says whether this is a dropship, and a
   * sale can be a dropship AND be waiting on measurements. Two facts, two
   * devices — the warm background stays dropship's, the left edge is the
   * fulfilment colour, and neither has to give way to the other.
   *
   * Blue for items, amber for dims, the same pair the Ready to Ship board uses,
   * because a colour that means one thing on one board and another elsewhere is
   * worse than no colour.
   */
  const fxStage = fulfillmentStageOf(invoice)
  const fxTone = fxStage && fxStage !== 'ready' ? FULFILLMENT_STAGE_TONE[fxStage] : null
  const fxWhy = fulfillmentNextStepDetail(invoice)
  // Null on everything the packing floor can have — a void included, which has
  // its own greyed card and does not need a second reason printed on it.
  //
  // It no longer draws a chip of its own. "Unpaid" and "Pay up front" already
  // say it between them, and a third red chip repeating the same fact is how a
  // card stops being scannable. What it still does is put a padlock on the money
  // chip and the full sentence on its tooltip — see the strip below.
  const heldForPayment =
    invoice.status === 'void' ? null : readyToShipBlockedReason(invoice)

  const chips = orderStatusChips(invoice)
  if (heldForPayment) chips[0] = { ...chips[0], title: heldForPayment }

  /**
   * "from Steel City Collectibles", when a supplier ships this one.
   *
   * Two suppliers on one sale is a real shape — a mixed order with two halves
   * from two places — and it is COUNTED rather than named, because naming one of
   * them would send somebody to the wrong building. A dropship whose supplier
   * nobody has typed says so plainly rather than going quiet, since "we do not
   * know who is shipping this" is the most useful thing this line can say.
   */
  /**
   * OURS, AND NOT IN THIS BUILDING — the roadshow case, said out loud.
   *
   * The owner's answer when asked whether these orders should show on the
   * packing board at all: "show it, but marked as shipping from the shop." So
   * the card keeps its place in the queue — somebody still has to confirm it
   * went out — and the packer is told not to go downstairs looking for a box
   * that is in Wichita.
   *
   * One shop is NAMED and two are COUNTED, the same rule the supplier line
   * below keeps: naming one of two would send somebody to the wrong state.
   */
  const awayUnits = shipsFromAway(invoice) ? Number(invoice.remoteUnits) || 0 : 0
  const awayLine =
    awayUnits === 0
      ? null
      : invoice.remoteFrom
        ? {
            text: `ships from ${invoice.remoteFrom}`,
            title:
              `${awayUnits} unit${awayUnits === 1 ? '' : 's'} on this order ${awayUnits === 1 ? 'is' : 'are'} ours ` +
              `and already bought, sitting at ${invoice.remoteFrom} — so the box goes out from there and ` +
              'nothing here gets packed. The label is still bought here.'
          }
        : {
            text: `ships from ${invoice.remotePlaceCount} shops`,
            title:
              `${awayUnits} units on this order are ours and already bought, split across ` +
              `${invoice.remotePlaceCount} shops — so nothing here gets packed. Open it for the split.`
          }
  /**
   * EVERY UNIT OFF OUR SHELVES IS AT ONE OF OUR OWN SHOPS.
   *
   * Then there is no supplier to chase and none to name, and the away line
   * above has already said everything there is to say. Without this the card
   * would print "supplier not named" under it — a warning about a fact that is
   * not actually missing, on the commonest roadshow order there is.
   */
  const noSupplierToName = (Number(invoice.dropshipUnits) || 0) - awayUnits <= 0 && awayUnits > 0

  const sourceLine =
    kind === 'stock'
      ? null
      : invoice.dropSupplierCount > 1
        ? {
            text: `from ${invoice.dropSupplierCount} suppliers`,
            title: 'The lines on this order name more than one supplier. Open it for the split.'
          }
        : invoice.dropSupplier
          ? {
              text: `from ${invoice.dropSupplier}`,
              title: invoice.sourcePoNumber
                ? `Ships from ${invoice.dropSupplier}, bought on ${invoice.sourcePoNumber}`
                : `Ships from ${invoice.dropSupplier}`
            }
          : noSupplierToName
            ? null
            : {
                text: 'supplier not named',
                title:
                  'Nothing on this order says who ships it. Open it and name the supplier on the line.'
              }

  return (
    <div
      className={`po-card${kindClass}${fxTone ? ` fx-lane fx-lane-${fxTone}` : ''}`}
      data-status={invoice.status}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      style={{ cursor: 'pointer' }}
    >
      <div className="po-card-top">
        {/* THE NUMBER IS THE DOOR TO QUICKBOOKS, and that is what buys the
            footer its ninth button back.

            Merging four QuickBooks buttons into one costs something real: the
            single button says the ONE act the order needs, so in the states
            where that act is "check" or "record the payment", plain "open it
            over there" has nowhere to go. It is the press with no precondition —
            an invoice in QuickBooks can always be looked at — so it belongs on
            the thing that already NAMES the QuickBooks document rather than in a
            queue behind acts that do.

            The precedent is FreightLine, whose tracking chip has been a link
            that stops propagation since it was written; the same two lines are
            what keep this from also opening the order. */}
        {invoice.qboId ? (
          <button
            type="button"
            className="po-card-num mono po-card-num-link"
            title={`Open ${invoice.qboDocNumber ? `invoice ${invoice.qboDocNumber}` : 'this invoice'} in QuickBooks`}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void api.invoices.openInQbo(invoice.id)
            }}
          >
            {invoice.qboDocNumber || invoice.invoiceNumber || 'Draft'}
          </button>
        ) : (
          <span className="po-card-num mono">
            {invoice.qboDocNumber || invoice.invoiceNumber || 'Draft'}
          </span>
        )}
        {/* NAMED, not just tinted. A purchase order can say it in the number —
            displayOrderNumber turns PO-0042 into Drop-0042 — and an invoice
            number cannot, because it is the string QuickBooks receives. So the
            sell side carries the word instead, and says which of the two it is:
            the whole order, or only part of it. */}
        {kind !== 'stock' && (
          <span
            className="po-drop-chip"
            title={
              kind === 'drop'
                ? 'Every unit ships straight from the supplier — nothing comes off a shelf here'
                : 'Part of this order ships straight from the supplier; the rest comes off a shelf here'
            }
          >
            {kind === 'drop' ? 'Drop' : 'Part drop'}
          </span>
        )}
        {/* NAMED, not just striped — the same rule the Drop chip above follows,
            and for the same reason: a colour nobody can read is decoration. */}
        {fxTone && (
          <span className={`fx-chip fx-chip-${fxTone}`} title={fxWhy ?? undefined}>
            {fxStage === 'awaiting_items' ? 'Awaiting items' : 'Awaiting dims'}
          </span>
        )}
        {/* An unpaid invoice past its due date is the one thing on this board
            somebody would act on today, so it is the only badge. */}
        {overdue && (
          <span className="po-card-dest" title={`Was due ${formatDay(invoice.dueDate)}`}>
            Overdue
          </span>
        )}
      </div>
      {/* The full name on hover, since the line now truncates. */}
      <div className="po-card-supplier" title={invoice.customerName}>
        {invoice.customerName}
      </div>

      {/* WHO SHIPS IT, on a dropship — the one fact these cards could never say.

          The Drop chip above has always announced that a supplier ships this
          order and never WHICH supplier, so chasing the goods or sending the
          label meant opening the sale, reading the source purchase order's
          number, and going to find it on the other board.

          TEXT, not a link. There is no cross-module navigation in this app —
          ProductOrigins' PO rows take an optional opener that nothing passes,
          for the same reason — and the purchase order's NUMBER is on the
          tooltip, which is what somebody needs to find it on the other board.
          A button that opened a purchase-order receipt from here would drag the
          whole PO stage machinery onto the sell side to save one click. */}
      {sourceLine && (
        <div className="inv-source" title={sourceLine.title}>
          <Icon name="Truck" size={12} />
          <span>{sourceLine.text}</span>
          {invoice.sourcePoNumber && (
            <span className="inv-source-po mono">{invoice.sourcePoNumber}</span>
          )}
        </div>
      )}

      {/* AND WHEN IT IS OURS BUT NOT HERE, which is neither of the two states
          this card could describe before.

          A SHOP, not a truck: the icon is the difference between "somebody
          else's goods are coming" and "our goods are standing somewhere else",
          and those are the two things a packer has to tell apart. It sits under
          the supplier line rather than replacing it, because a mixed order can
          have a supplier shipping one half and a shop holding the other, and
          both halves have to be findable. */}
      {awayLine && (
        <div className="inv-source inv-source-away" title={awayLine.title}>
          <Icon name="Store" size={12} />
          <span>{awayLine.text}</span>
          <span className="inv-source-away-n">
            {awayUnits} unit{awayUnits === 1 ? '' : 's'}
          </span>
        </div>
      )}

      {/* THE THREE THINGS SOMEBODY SCANS THIS BOARD FOR, in a fixed order and a
          fixed place, so a column reads down.

          Every one of these was already knowable and none of them was READABLE,
          because each was shown by something being there: paid was a date where
          unpaid was a different date in the same grey, shipped was a carrier
          line that is simply not drawn without one, and the terms were not on
          the card at all. Absence is not something anybody scans for — see the
          note at the top of @shared/orderStatus, and the Owing chip the purchase
          board grew for exactly this reason. */}
      <div className="inv-chips">
        {chips.map((c) => (
          <span key={c.slot} className={`inv-chip inv-chip-${c.tone}`} title={c.title}>
            {c.slot === 'money' && heldForPayment && <Icon name="Lock" size={10} />}
            {c.label}
          </span>
        ))}
      </div>
      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(invoice.total)}</span>
        {/* THREE DIFFERENT KINDS OF DATE, and each is formatted by the function
            that matches what it IS.

            `qboPaidAt` is QuickBooks' answer: the calendar day the money is
            dated in the books, so formatDay. `paidAt` is an INSTANT — the
            moment somebody on this floor ticked the box — so formatDate.
            `dueDate` is a calendar day again. Slicing the instant to ten
            characters and running it through formatDay would print the UTC day,
            which after 5pm on the west coast is tomorrow.

            QuickBooks' day WINS when there is one. The two routinely differ by
            days: the money landed on the 12th and the sync that noticed ran on
            the 18th, and it is the 12th somebody repeats to a buyer. */}
        <span className="po-card-meta">
          {paid
            ? invoice.qboPaidAt
              ? `paid ${formatDay(invoice.qboPaidAt)}`
              : invoice.paidAt
                ? `paid ${formatDate(invoice.paidAt)}`
                : 'paid'
            : `due ${formatDay(invoice.dueDate)}`}
        </span>
      </div>
      {/* OUR TOTAL AND QUICKBOOKS' DISAGREE, and the card is where somebody
          will see it.

          Editing a price here cannot reach Intuit, so the copy over there is
          corrected by hand — which means the whole feature turns on somebody
          remembering. This is what removes the remembering: the gap opens the
          moment a price moves and stays on the card until the two agree. Silent
          on an invoice QuickBooks has not been read for, because an absence of
          evidence is not agreement. See qboTotalMismatch. */}
      {(qboState.kind === 'differs' || qboState.kind === 'unverified') && (
        <div
          className={`po-card-qbogap${qboState.kind === 'unverified' ? ' is-unsure' : ''}`}
          onClick={(e) => e.stopPropagation()}
          title={
            qboState.kind === 'differs'
              ? `QuickBooks said ${formatMoney(money(invoice.qboTotalAmt ?? 0))} when it was last read${
                  qboState.checkedAt ? ` on ${formatDate(qboState.checkedAt)}` : ''
                } — open it there and set it to ${formatMoney(invoice.total)}`
              : 'Your total has changed since QuickBooks was last read, so the two cannot be compared yet'
          }
        >
          <Icon name={qboState.kind === 'differs' ? 'AlertTriangle' : 'Info'} size={12} />
          <span className="po-card-qbogap-text">
            {qboState.kind === 'differs'
              ? `QuickBooks is ${formatMoney(Math.abs(qboState.gap))} ${qboState.gap > 0 ? 'lower' : 'higher'}`
              : 'QuickBooks not checked since you edited'}
          </span>
          {/* THE BANNER NO LONGER CARRIES ITS OWN BUTTON.

              It had one — "Check now" — because a banner accusing a difference
              with nothing to press about it is a nag rather than a warning. That
              is still true, and the answer is still one press away: in exactly
              the two states that draw this banner, the QuickBooks button below
              reads "Check QuickBooks". Keeping both would have left two
              QuickBooks controls on one card in precisely the states the owner
              was complaining about. The affordance moved four inches; it did not
              go. */}
        </div>
      )}
      {/* Drawn only once QuickBooks has said something — see PaymentBar, which
          returns nothing rather than an empty rail, because "nothing paid" on a
          draft nobody has posted is a claim about money that nobody has made. */}
      <PaymentBar invoice={invoice} compact className="po-card-recv" />
      <FreightLine
        carrier={invoice.carrier}
        service={invoice.service}
        trackingNumber={invoice.trackingNumber}
      />
      <TrackingLine
        status={invoice.trackingStatus}
        checkedAt={invoice.trackingCheckedAt}
        detail={invoice.trackingStatusDetail}
        error={invoice.trackingError}
        attemptedAt={invoice.trackingAttemptedAt}
        hasTracking={!!invoice.trackingNumber}
      />

      {asking && (
        <div onClick={(e) => e.stopPropagation()}>
          {/* ONE TABLE, NOT A LADDER OF TERNARIES. This was five nested
              conditionals repeated across five props, so adding a sixth confirm
              meant editing five expressions and getting all five right. The
              merge needed two more, which is the point at which the shape had to
              change. */}
          <QuickConfirm
            {...ASKS[asking](label, qbo, pay)}
            onConfirm={
              asking === 'items'
                ? onItemsInHand
                : asking === 'send'
                  ? onSendAnyway
                  : asking === 'unpaid'
                    ? () => onSetPaid(false)
                    : asking === 'push-again'
                      ? onRetryPush
                      : recordQboPayment
            }
            onClose={() => setAsking(null)}
          />
        </div>
      )}
      {measuring && (
        <div onClick={(e) => e.stopPropagation()}>
          <DimsModal
            invoice={invoice as InvoiceDetail}
            onClose={() => setMeasuring(false)}
            onSaved={async () => {
              setMeasuring(false)
              await onReload()
            }}
          />
        </div>
      )}
      <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
        {/* WHERE THE GOODS ARE, ACTED ON WHERE THE ORDER ALREADY IS.
            
            These two lived on a board of their own for a version. A second
            board meant a second place to look for the same orders, so the state
            became a colour on this card — and the buttons had to follow it, or
            the colour would say what was missing with no way to answer it.
            
            Drawn only while the order is WAITING. A card that is ready, or one
            payment has not cleared, has nothing here to press. */}
        {/* ONE MONEY BUTTON. See paidAction in @shared/orderActions.

            There were two, and they were the second pair on this card to share a
            word: "Mark paid" stamped a date and nothing else, in the Payment
            column only, while "Paid up front…" beside it recorded the amount,
            the method, the reference, moved the card AND released the order to
            be picked. Which of the two somebody got depended on which column the
            card happened to be standing in.

            Now one button, and the order's own terms decide what it says: an
            up-front buyer is being HELD by this press, an on-delivery buyer is
            not, and either way the money is recorded properly rather than only
            when somebody found the right one of the two.

            IT REACHES FURTHER THAN EITHER DID. Recording is offered on any
            unsettled order in any column, and withdrawing on any order paid
            here — where before the pair between them left an order paid in the
            Ready to ship column with no way to say so. */}
        {pay.id !== 'none' && (
          <button
            type="button"
            className="btn po-move inv-move-paid"
            disabled={busy}
            title={pay.title}
            onClick={() => (pay.id === 'withdraw' ? setAsking('unpaid') : onPayUpFront())}
          >
            <Icon name={pay.id === 'withdraw' ? 'RotateCcw' : 'DollarSign'} size={14} />
            {pay.label}
          </button>
        )}
        {fxTone && (
          <>
            <button
              type="button"
              className={`btn po-move inv-move-${fxTone}`}
              disabled={busy}
              title={fxWhy ?? undefined}
              onClick={() => (fxStage === 'awaiting_items' ? setAsking('items') : setMeasuring(true))}
            >
              <Icon name={fxStage === 'awaiting_items' ? 'Check' : 'Ruler'} size={14} />
              {fulfillmentTickShort(fxStage as 'awaiting_items' | 'awaiting_dims')}
            </button>
            <button
              type="button"
              className="btn po-move"
              disabled={busy}
              title="Move it straight to ready, ahead of the usual gates"
              onClick={() => setAsking('send')}
            >
              <Icon name="ArrowRight" size={14} />
              Send anyway
            </button>
          </>
        )}
        {/* ONE QUICKBOOKS BUTTON. See quickBooksAction in @shared/orderActions.

            There were five: To QuickBooks, Retry QuickBooks, Record payment in
            QuickBooks, Open in QuickBooks, and Check now up on the gap banner.
            Each was gated on a different field and none of them said where the
            order actually stood — the owner asked for "a quickbooks button just
            one that tells me the status and moves it into quickbooks if needed",
            which is exactly the two halves those five were missing between them.

            THE STATUS IS IN THE TOOLTIP AND THE ACT IS ON THE FACE. "In
            QuickBooks as invoice 1043, $6,900.00 owing." is a sentence a label
            cannot hold, and the label has to name what pressing does or the
            button is a badge. So both, and the helper writes both together so
            they can never describe different states.

            Plain "open it over there" is the press this merge would otherwise
            bury, because it is never the most useful act. It moved to the
            invoice number at the top of the card — see po-card-num-link, which
            is also a shorter reach than the bottom of a footer.

            SEND IS STILL NOT ON THE CARD, for the reason it never was: it emails
            the BUYER, which is a different act from putting the invoice on the
            books, and it read as "send it to QuickBooks" beside an invoice
            already there. QuickBooks does the sending, on the screen the number
            above opens. */}
        <button
          type="button"
          className={`btn po-move${qbo.warn ? ' inv-move-retry' : ''}`}
          disabled={busy || qbo.id === 'none' || checkingQbo || payingQbo}
          title={qbo.title}
          onClick={() => {
            if (qbo.confirm) {
              setAsking(qbo.id === 'push-again' ? 'push-again' : 'qbo-payment')
              return
            }
            if (qbo.id === 'push') return onMove('created')
            if (qbo.id === 'retry') return void onRetryPush()
            if (qbo.id === 'check') return void onCheckQbo()
            if (qbo.id === 'open') return void api.invoices.openInQbo(invoice.id)
          }}
        >
          <Icon name={QBO_ICON[qbo.id]} size={14} />
          {qbo.id === 'check' && checkingQbo
            ? 'Checking…'
            : qbo.id === 'record-payment' && payingQbo
              ? 'Recording…'
              : qbo.label}
        </button>


        {/* MOVING THE CARD, AND SAYING SO.

            This button said "Mark paid" and moved the card to the last column
            without recording a penny — so the card landed in Payment still
            reading UNPAID, beside a second button also called "Mark paid" that
            was the one that actually stamped the date. Two controls with one
            name, doing different things, on the same card.

            The column is called Payment, so this is called what it does. The
            money is recorded by the one button that records money, which is
            Mark paid… above — this only moves the card. */}
        {!settled && invoice.status !== 'paid' && canMoveInvoice(invoice.status, 'paid') && (
          <button
            type="button"
            className="btn po-move inv-move-paid"
            disabled={busy}
            title="Move it to the Payment column. This does not record any money."
            onClick={() => onMove('paid')}
          >
            To payment
          </button>
        )}

        {/* PDF ONLY WHILE IT IS STILL OURS. Once an invoice is in QuickBooks,
            THEIR document is the one the buyer gets and the one that prints —
            a locally rendered PDF beside it is a second version of the same
            invoice that can quietly disagree with it. Drafts still need one,
            because there is nothing on the other side to open yet. */}
        {!invoice.qboId && (
          <button
            type="button"
            className="btn po-move"
            title="Open the invoice as a PDF"
            onClick={onPdf}
          >
            Open as PDF
          </button>
        )}

        {/* EDIT THE LINES, on an order already on the books.

            The invoice form is refused once a document posts, and rightly: it
            rewrites every column and reaches QuickBooks, and this app is not
            the system of record for something a buyer has been billed against.
            But a price renegotiated after the invoice went out is ordinary
            trade here, and the choice was between the app holding the real
            figure and the app being confidently wrong in every report it
            produces.

            So the gate moved rather than opened. This edits the LINES —
            quantity, price, and splitting one line into two when half went at a
            different price — re-derives the stock and the total, and says on
            its face that QuickBooks has to be corrected by hand.

            CALLED "EDIT" AND NOT "EDIT PRICES", because it stopped being only
            about prices the moment quantity came with it, and a button that
            undersells what it does is one people do not press when they need
            it.

            AND IT IS NOW THE SCREEN THE OWNER ASKED FOR: "I just really need a
            way to edit to sales order at any point, add in dimensions ... the
            edit button should let me do a lot to the sales order too". So it
            opens on a draft as well — the gate that hid it there was this line,
            not a rule in the backend — and it carries the box measurements plus
            the doors to routing, the attached purchases and re-taking the shelf,
            which were three more buttons on this card until now. */}
        {invoice.status !== 'void' && (
          <button
            type="button"
            className="btn po-move"
            title="Change quantities, prices and the box measurements on your copy. QuickBooks has to be changed separately."
            onClick={onEditPrices}
          >
            <Icon name="Pencil" size={14} />
            Edit
          </button>
        )}

        {deletable && (
          <button
            type="button"
            className="btn po-move po-move-remove"
            title={`Delete invoice ${invoice.invoiceNumber || ''}`.trim()}
            onClick={onDelete}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Confirm a delete, by showing what is about to go.
 *
 * The number, the buyer and the amount, because those are what somebody checks
 * before agreeing — a dialog that only asks "are you sure?" is answered yes by
 * reflex. There is no undo behind this and no trash to fish it out of, which is
 * the sentence the modal ends on.
 */
function DeleteInvoiceModal({
  invoice,
  busy,
  onClose,
  onConfirm
}: {
  invoice: Invoice
  busy: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}): JSX.Element {
  return (
    <Modal
      title={`Delete invoice ${invoice.invoiceNumber || ''}`.trim()}
      subtitle="This cannot be undone"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" icon="Trash2" loading={busy} onClick={() => void onConfirm()}>
            Delete invoice
          </Button>
        </>
      }
    >
      <p className="fin-confirm-lead">
        <b>{invoice.customerName}</b> · {formatMoney(invoice.total)} · dated{' '}
        {formatDay(invoice.invoiceDate)}
      </p>
      <p className="fin-confirm-lead">
        The invoice and its line items are removed from this app for good. Nothing is archived
        and there is no undo — if you only want it off the board, mark it <b>void</b> instead.
      </p>
      {/* HEDGED ON PURPOSE, because the outcome genuinely varies. QuickBooks
          will not delete an invoice with a payment applied, and the button
          must not stop working because of that — so it is attempted, and
          whichever happened is reported afterwards rather than promised
          here. */}
      {invoice.qboId && (
        <p className="fin-confirm-lead">
          It is <b>also removed from QuickBooks</b> if QuickBooks allows it — it will not delete
          an invoice that has a payment applied. Either way it goes from here, and you will be
          told which happened.
        </p>
      )}
    </Modal>
  )
}
