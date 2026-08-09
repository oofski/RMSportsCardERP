import { useCallback, useEffect, useState } from 'react'
import type { Invoice, InvoiceCustomer, InvoiceDetail, InvoiceStatus } from '@shared/invoices'
import { INVOICE_STAGES, canMoveInvoice } from '@shared/invoices'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { FreightLine, TrackingLine } from '../../components/FreightFields'
import { CheckTrackingButton } from '../../components/CheckTrackingButton'
import { useToast } from '../../components/Toast'
import { formatDate, formatMoney } from '../../lib/format'
import { CreateInvoiceModal } from './CreateInvoiceModal'
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
  const [creatingNew, setCreatingNew] = useState(false)
  const [syncing, setSyncing] = useState(false)
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

  const sendIt = async (inv: Invoice): Promise<void> => {
    if (busy) return
    setBusy(inv.id)
    try {
      const res = await api.invoices.sendFromQbo(inv.id)
      if (!res.ok) {
        toast.error(res.error ?? 'QuickBooks would not send that.')
        return
      }
      await load()
      toast.success(`Sent to ${inv.email}.`)
    } finally {
      setBusy(null)
    }
  }

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
      toast.success(
        target.invoiceNumber ? `Invoice ${target.invoiceNumber} deleted.` : 'Invoice deleted.'
      )
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

  const fromStatus = dragId ? invoices.find((i) => i.id === dragId)?.status ?? null : null

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
            const canDrop = !!(dragId && fromStatus && canMoveInvoice(fromStatus, stage.id))
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
                  <span className="po-col-title" title={stage.hint}>
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
                      onRetryPush={async () => {
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
                      }}
                      onSend={() => void sendIt(inv)}
                      onDelete={() => setDeleting(inv)}
                      onPdf={() => void api.invoices.openPdf(inv.id)}
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
          onDelete={(inv) => setDeleting(inv)}
          onOpenQuickBooks={onOpenQuickBooks}
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
  onSend,
  onDelete,
  onPdf
}: {
  invoice: Invoice
  busy: boolean
  onOpen: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (to: InvoiceStatus) => void
  /** Try a QuickBooks push that failed on save. */
  onRetryPush: () => Promise<void>
  onSend: () => void
  onDelete: () => void
  onPdf: () => void
}): JSX.Element {
  const overdue =
    invoice.status !== 'paid' &&
    invoice.status !== 'void' &&
    invoice.dueDate < new Date().toISOString().slice(0, 10)

  // ALWAYS DELETABLE. This was gated on the invoice not yet being in
  // QuickBooks, which was right when saving and posting were separate steps and
  // became wrong the moment Save started posting immediately: every invoice
  // carries a QuickBooks id within seconds, so the button had effectively
  // disappeared. Delete now removes the remote copy first and only then the
  // local one — see the IPC handler for why that order is not interchangeable.
  const deletable = true
  const settled = invoice.status === 'paid' || invoice.status === 'void'

  return (
    <div
      className="po-card"
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
        {/* An unpaid invoice past its due date is the one thing on this board
            somebody would act on today, so it is the only badge. */}
        {overdue && (
          <span className="po-card-dest" title={`Was due ${formatDay(invoice.dueDate)}`}>
            Overdue
          </span>
        )}
      </div>
      <div className="po-card-supplier">{invoice.customerName}</div>
      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(invoice.total)}</span>
        {/* paidAt is an INSTANT and dueDate is a calendar day, so they are
            formatted by different functions on purpose. Slicing the instant to
            ten characters and running it through formatDay would print the UTC
            day, which after 5pm on the west coast is tomorrow. */}
        <span className="po-card-meta">
          {invoice.status === 'paid' && invoice.paidAt
            ? `paid ${formatDate(invoice.paidAt)}`
            : `due ${formatDay(invoice.dueDate)}`}
        </span>
      </div>
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

      <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
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

        {invoice.status === 'created' && (
          <button
            type="button"
            className="btn po-move inv-move-send"
            disabled={busy || !invoice.email}
            title={invoice.email ? `Email it to ${invoice.email}` : 'That buyer has no email'}
            onClick={onSend}
          >
            Send
          </button>
        )}

        {!settled && (
          <button
            type="button"
            className="btn po-move inv-move-paid"
            disabled={busy}
            onClick={() => onMove('paid')}
          >
            Mark paid
          </button>
        )}

        <button
          type="button"
          className="btn po-move"
          title="Open the invoice as a PDF"
          onClick={onPdf}
        >
          Open as PDF
        </button>

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
      {/* NAMED, because deleting from a local app and deleting out of the
          company books are very different acts and the button is the same
          button. Somebody clearing a mistyped invoice needs to know this
          reaches their accounts. */}
      {invoice.qboId && (
        <p className="fin-confirm-lead">
          It is also deleted <b>in QuickBooks</b>, where it is invoice{' '}
          {invoice.qboDocNumber || invoice.invoiceNumber}. QuickBooks goes first: if it refuses,
          nothing is removed here either and you can try again.
        </p>
      )}
    </Modal>
  )
}
