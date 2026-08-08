import { useCallback, useEffect, useState } from 'react'
import type { Invoice, InvoiceCustomer, InvoiceDetail, InvoiceStatus } from '@shared/invoices'
import { INVOICE_STAGES, canMoveInvoice } from '@shared/invoices'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { FreightLine } from '../../components/FreightFields'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { CreateInvoiceModal } from './CreateInvoiceModal'

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
  const [nextNumber, setNextNumber] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
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

  const remove = async (inv: Invoice): Promise<void> => {
    if (busy) return
    setBusy(inv.id)
    try {
      const res = await api.invoices.remove(inv.id)
      if (!res.ok) toast.error(res.error ?? 'Could not delete that.')
      else await load()
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
            <span className="mono">{formatMoney(stats.outstanding)}</span>
            <em>awaiting payment</em>
          </div>
          <div className="po-page-stat">
            <span className="mono">{formatMoney(stats.paidTotal)}</span>
            <em>paid</em>
          </div>
          <div className="po-page-stat">
            <span className="mono">{formatMoney(stats.thisMonth)}</span>
            <em>billed this month</em>
          </div>
        </div>
        <div className="row" style={{ gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <Button variant="secondary" icon="FileSpreadsheet" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
          <Button variant="primary" icon="Plus" onClick={() => setCreatingNew(true)}>
            New invoice
          </Button>
        </div>
      </div>

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
              className={`po-col po-col-${stage.id}${overStage === stage.id ? ' po-col-dragover' : ''}${
                noAllow ? ' po-col-noallow' : ''
              }`}
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
                    onSend={() => void sendIt(inv)}
                    onDelete={() => void remove(inv)}
                    onPdf={() => void api.invoices.openPdf(inv.id)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {(editing || creatingNew) && (
        <CreateInvoiceModal
          invoice={editing}
          customers={customers}
          nextNumber={nextNumber}
          onClose={() => {
            setEditing(null)
            setCreatingNew(false)
          }}
          onSaved={load}
          onOpenQuickBooks={onOpenQuickBooks}
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
 * Same shell as a PO card so the two boards read identically. What differs is
 * what is on it: a PO card leads with the supplier because that is who is owed,
 * and this leads with the BUYER because that is who owes.
 */
function InvoiceCard({
  invoice,
  busy,
  onOpen,
  onDragStart,
  onDragEnd,
  onMove,
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
  onSend: () => void
  onDelete: () => void
  onPdf: () => void
}): JSX.Element {
  const overdue =
    invoice.status !== 'paid' &&
    invoice.status !== 'void' &&
    invoice.dueDate < new Date().toISOString().slice(0, 10)

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
          <span className="po-card-dest" title={`Was due ${invoice.dueDate}`}>
            Overdue
          </span>
        )}
      </div>
      <div className="po-card-supplier">{invoice.customerName}</div>
      <div className="po-card-figs">
        <span className="po-card-total mono">{formatMoney(invoice.total)}</span>
        <span className="po-card-meta">
          {invoice.status === 'paid' && invoice.paidAt
            ? `paid ${invoice.paidAt.slice(0, 10)}`
            : `due ${invoice.dueDate}`}
        </span>
      </div>
      <FreightLine
        carrier={invoice.carrier}
        service={invoice.service}
        trackingNumber={invoice.trackingNumber}
      />

      <div className="po-card-foot" onClick={(e) => e.stopPropagation()}>
        <button className="po-card-btn" title="Open the invoice as a PDF" onClick={onPdf}>
          <Icon name="FileText" size={13} />
          PDF
        </button>

        {invoice.status === 'draft' && (
          <>
            <button className="po-card-btn" disabled={busy} onClick={() => onMove('created')}>
              To QuickBooks
            </button>
            <button className="po-card-btn" title="Delete this draft" onClick={onDelete}>
              <Icon name="Trash2" size={13} />
            </button>
          </>
        )}

        {invoice.status === 'created' && (
          <button
            className="po-card-btn"
            disabled={busy || !invoice.email}
            title={invoice.email ? `Email it to ${invoice.email}` : 'That buyer has no email'}
            onClick={onSend}
          >
            <Icon name="Mail" size={13} />
            Send
          </button>
        )}

        {invoice.status !== 'paid' && invoice.status !== 'void' && (
          <button className="po-card-btn" disabled={busy} onClick={() => onMove('paid')}>
            <Icon name="Check" size={13} />
            Paid
          </button>
        )}

        {invoice.qboId && (
          <button
            className="po-card-btn"
            title="Open it in QuickBooks"
            onClick={() => void api.invoices.openInQbo(invoice.id)}
          >
            <Icon name="ExternalLink" size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
