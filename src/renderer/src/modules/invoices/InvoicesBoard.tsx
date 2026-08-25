import { useCallback, useEffect, useState } from 'react'
import type { Invoice, InvoiceCustomer, InvoiceDetail, InvoiceStatus } from '@shared/invoices'
import {
  INVOICE_STAGES,
  canMoveInvoice,
  isDropshipSale,
  isInvoicePaid,
  salesOrderKindOf
} from '@shared/invoices'
import {
  FULFILLMENT_STAGE_TONE,
  fulfillmentNextStepDetail,
  fulfillmentStageOf,
  fulfillmentTickShort,
  readyToShipBlockedReason
} from '@shared/fulfillment'
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
        if (moved > 0) {
          await load()
          toast.success(
            moved === 1
              ? `1 invoice moved to ${res.data.moved[0].to}.`
              : `${moved} invoices moved.`
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
        <div className="po-board">
          {INVOICE_STAGES.map((stage) => {
            const inStage = invoices.filter((i) => i.status === stage.id)
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
                      onFulfillmentChanged={load}
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
                      onPayUpFront={() => void openForPayment(inv.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
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
  onPayUpFront,
  onItemsInHand,
  onSendAnyway,
  onSetPaid,
  onFulfillmentChanged
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
  /** Open the paid-up-front dialog for this order. */
  onPayUpFront: () => void
  /** Confirm the goods arrived — the only signal a dropship has. */
  onItemsInHand: () => Promise<void>
  /** Move it straight to ready, ahead of the gates. */
  onSendAnyway: () => Promise<void>
  /** Record, or withdraw, that the money arrived. Never moves the order. */
  onSetPaid: (paid: boolean) => Promise<void>
  /** Reload after the dims editor writes. */
  onFulfillmentChanged: () => Promise<void>
}): JSX.Element {
  const [measuring, setMeasuring] = useState(false)
  const [asking, setAsking] = useState<'items' | 'send' | 'paid' | 'unpaid' | null>(null)
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
  const heldForPayment =
    invoice.status === 'void' ? null : readyToShipBlockedReason(invoice)

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
        <span className="po-card-num mono">
          {invoice.qboDocNumber || invoice.invoiceNumber || 'Draft'}
        </span>
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
        {/* HELD FOR THE MONEY, said on the card.

            The lane above only draws for an order that is ON the packing
            pipeline, and this is the one that never got onto it: up-front terms,
            nothing received. Before this the card looked ordinary and simply
            refused to be dragged into Ready to ship, which reads as a broken
            drag rather than as a rule.

            Not drawn on a forced order — that is exactly the order somebody
            already decided to send, and marking it held would contradict the
            decision. `readyToShipBlockedReason` handles that; this only asks. */}
        {heldForPayment && (
          <span className="fx-chip fx-chip-hold" title={heldForPayment}>
            Awaiting payment
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
          <QuickConfirm
            title={
              asking === 'items'
                ? 'Goods are in hand?'
                : asking === 'send'
                  ? 'Send it anyway?'
                  : asking === 'paid'
                    ? 'Mark it paid?'
                    : 'Withdraw the payment?'
            }
            detail={
              asking === 'items'
                ? `${label} moves on to be weighed and measured.`
                : asking === 'send'
                  ? `${label} moves straight to ready to ship, ahead of the usual gates.`
                  : asking === 'paid'
                    ? `${label} is recorded as settled, dated today.`
                    : `${label} goes back to unpaid. Nothing is refunded — this only changes what the board says.`
            }
            confirmLabel={
              asking === 'items'
                ? 'Yes, they are here'
                : asking === 'send'
                  ? 'Move it'
                  : asking === 'paid'
                    ? 'Mark paid'
                    : 'Mark not paid'
            }
            confirmIcon={
              asking === 'items'
                ? 'Check'
                : asking === 'send'
                  ? 'ArrowRight'
                  : asking === 'paid'
                    ? 'DollarSign'
                    : 'RotateCcw'
            }
            tone={asking === 'unpaid' ? 'danger' : 'primary'}
            onConfirm={
              asking === 'items'
                ? onItemsInHand
                : asking === 'send'
                  ? onSendAnyway
                  : () => onSetPaid(asking === 'paid')
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
              await onFulfillmentChanged()
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
        {/* MARK IT PAID, IN THE COLUMN NAMED FOR IT.
            
            Only on Payment cards: the column is the settling-up step, and a tick
            anywhere earlier would be recording money against an order nobody has
            finished. QuickBooks wins where it speaks — an order Intuit says is
            paid shows as paid and is not un-tickable here, because the books are
            the record for money and this board is not. */}
        {invoice.status === 'paid' && !invoice.qboPaidAt && (
          <button
            type="button"
            className={`btn po-move ${paid ? 'inv-move-paid' : ''}`}
            disabled={busy}
            title={paid ? 'Withdraw the payment on this order' : 'Record that the money arrived'}
            onClick={() => setAsking(paid ? 'unpaid' : 'paid')}
          >
            <Icon name={paid ? 'RotateCcw' : 'DollarSign'} size={14} />
            {paid ? 'Mark not paid' : 'Mark paid'}
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
        {/* SAVED HERE, NOT IN QUICKBOOKS. The push runs on save and can fail —
            no network, an expired grant, an item QuickBooks will not accept —
            and the invoice is deliberately kept when it does, because throwing
            away a document somebody just typed is worse than one that has not
            reached the books yet. This is the way back. Without it the failure
            toast pointed at a button that did not exist. */}
        {invoice.qboPushState === 'failed' && (
          <button
            type="button"
            className="btn po-move inv-move-retry"
            disabled={busy}
            title={invoice.qboPushError ?? 'QuickBooks refused this invoice.'}
            onClick={() => void onRetryPush()}
          >
            <Icon name="RefreshCw" size={14} />
            Retry QuickBooks
          </button>
        )}
        {invoice.status === 'draft' && (
          <button
            type="button"
            className="btn po-move"
            disabled={busy}
            onClick={() => onMove('created')}
          >
            To QuickBooks
          </button>
        )}

        {/* SEND IS NOT ON THE CARD. It emails the invoice to the BUYER, which
            is a different act from putting it on the books — but read as "send
            it to QuickBooks" beside an invoice already in QuickBooks, which
            made it look like an unfinished step on a finished document. The
            owner does not email from here; QuickBooks does the sending, and
            Open in QuickBooks is one click away with Send, print and payment
            all on that screen. Emailing a buyer now happens in QuickBooks,
            which is also where a record of having sent it lives. */}

        {/* PAID UP FRONT is a different act from moving the card, and it is the
            one that happens on this floor: a case sold off a stream is paid by
            Zelle before anybody picks a box. It records the money, says how it
            arrived, and RELEASES THE ORDER TO BE PICKED — which "Mark paid"
            never did, because Paid is the last column and an order that lands
            there looks finished. */}
        {!settled && (
          <button
            type="button"
            className="btn po-move inv-move-upfront"
            disabled={busy}
            title="Record money that arrived before it shipped, and put it on the packing list"
            onClick={onPayUpFront}
          >
            Paid up front…
          </button>
        )}

        {/* MOVING THE CARD, AND SAYING SO.

            This button said "Mark paid" and moved the card to the last column
            without recording a penny — so the card landed in Payment still
            reading UNPAID, beside a second button also called "Mark paid" that
            was the one that actually stamped the date. Two controls with one
            name, doing different things, on the same card.

            The column is called Payment, so this is called what it does. The
            money is recorded by the two buttons that record money: the tick in
            that column, and Paid up front… beside this one. */}
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

        {invoice.qboId && (
          <button
            type="button"
            className="btn po-move"
            onClick={() => void api.invoices.openInQbo(invoice.id)}
          >
            Open in QuickBooks
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
