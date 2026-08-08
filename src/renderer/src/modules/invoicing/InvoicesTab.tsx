import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Invoice, InvoiceCustomer, InvoiceDetail } from '@shared/invoices'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { InvoiceEditor } from './InvoiceEditor'

/**
 * Invoices — the sell side.
 *
 * A purchase order is money this business has committed to a supplier. An
 * invoice is money owed TO it. Same shape, opposite direction, which is why
 * they sit beside each other as two tabs rather than in one list: the question
 * "what do we owe" and the question "what are we owed" are never asked at the
 * same moment, and a board mixing them answers neither.
 *
 * ## The status column is honest about what this app knows
 *
 * Draft → Created → Sent, and nothing after that. There is no "Paid", because
 * this app has no payment ledger: QuickBooks knows when money arrived and this
 * does not, and a Paid column that only moved when somebody remembered to press
 * it would be worse than no column at all.
 */
export function InvoicesTab(): JSX.Element {
  const toast = useToast()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [customers, setCustomers] = useState<InvoiceCustomer[]>([])
  const [stats, setStats] = useState({
    draft: 0,
    created: 0,
    sent: 0,
    outstanding: 0,
    thisMonth: 0
  })
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<InvoiceDetail | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'draft' | 'created' | 'sent'>('all')

  const load = useCallback(async () => {
    const [list, people, s] = await Promise.all([
      api.invoices.list(),
      api.invoices.customers(),
      api.invoices.stats()
    ])
    setInvoices(list)
    setCustomers(people)
    setStats(s)
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

  const shown = useMemo(
    () => (filter === 'all' ? invoices : invoices.filter((i) => i.status === filter)),
    [invoices, filter]
  )

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
   * Create it in QuickBooks.
   *
   * The one button in this app that writes to somebody's books, so it says what
   * happened rather than flashing "Done": if QuickBooks renumbered the invoice
   * — which it does silently unless custom transaction numbers are on — the
   * operator finds out here rather than three weeks later when two systems
   * disagree.
   */
  const createInQbo = async (inv: Invoice): Promise<void> => {
    if (busy) return
    setBusy(inv.id)
    try {
      const res = await api.invoices.createInQbo(inv.id)
      if (!res.ok) {
        toast.error(res.error ?? 'QuickBooks would not take that invoice.')
        return
      }
      await load()
      toast.success(
        res.data?.numberChanged
          ? `Created in QuickBooks as ${res.data.docNumber} — it renumbered ours. Opening it now.`
          : 'Created in QuickBooks. Opening it now — press Send there.'
      )
    } finally {
      setBusy(null)
    }
  }

  const send = async (inv: Invoice): Promise<void> => {
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

  const exportCsv = async (ids?: string[]): Promise<void> => {
    const res = await api.invoices.exportCsv(ids)
    if (res.ok) toast.success(`Exported to ${res.path}`)
    else if (!res.canceled) toast.error(res.error ?? 'Export failed.')
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

  if (loading) return <CenterLoader />

  if (editing || creatingNew) {
    return (
      <InvoiceEditor
        invoice={editing}
        customers={customers}
        onClose={() => {
          setEditing(null)
          setCreatingNew(false)
        }}
        onSaved={async () => {
          await load()
        }}
      />
    )
  }

  return (
    <>
      <div className="stat-grid">
        <Stat icon="FileText" value={String(stats.draft)} label="Drafts" />
        <Stat icon="Send" value={String(stats.created + stats.sent)} label="In QuickBooks" />
        <Stat icon="DollarSign" value={formatMoney(stats.thisMonth)} label="Invoiced this month" />
        <Stat icon="Wallet" value={formatMoney(stats.outstanding)} label="Billed, all time" />
      </div>

      <div className="section-head">
        <div>
          <h2>Invoices</h2>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="seg-row" style={{ margin: 0 }}>
            {(['all', 'draft', 'created', 'sent'] as const).map((f) => (
              <button
                key={f}
                className={`seg ${filter === f ? 'on' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'created' ? 'In QuickBooks' : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <Button variant="secondary" icon="FileSpreadsheet" onClick={() => void exportCsv()}>
            Export CSV
          </Button>
          <Button variant="primary" icon="Plus" onClick={() => setCreatingNew(true)}>
            New invoice
          </Button>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon="ReceiptText"
          title={filter === 'all' ? 'No invoices yet' : 'Nothing in that state'}
          message={
            filter === 'all'
              ? 'Bill a buyer: pick who they are, add what they bought and the price you agreed, then create it in QuickBooks.'
              : undefined
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Number</th>
                <th>Buyer</th>
                <th>Date</th>
                <th>Due</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((inv) => (
                <tr key={inv.id}>
                  <td className="mono">
                    {inv.qboDocNumber && inv.qboDocNumber !== inv.invoiceNumber ? (
                      <span title={`QuickBooks renumbered this from ${inv.invoiceNumber}`}>
                        {inv.qboDocNumber}
                        <span className="muted"> (was {inv.invoiceNumber})</span>
                      </span>
                    ) : (
                      inv.invoiceNumber || '—'
                    )}
                  </td>
                  <td style={{ fontWeight: 600 }}>{inv.customerName}</td>
                  <td className="muted">{inv.invoiceDate}</td>
                  <td className="muted">{inv.dueDate}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(inv.total)}</td>
                  <td>
                    <span className="inv-status" data-status={inv.status}>
                      {inv.status === 'created'
                        ? 'In QuickBooks'
                        : inv.status[0].toUpperCase() + inv.status.slice(1)}
                    </span>
                  </td>
                  <td>
                    <div className="cell-actions">
                      {inv.status === 'draft' ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void open(inv.id)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            icon="Send"
                            loading={busy === inv.id}
                            onClick={() => void createInQbo(inv)}
                          >
                            Create in QuickBooks
                          </Button>
                          <button
                            className="icon-btn"
                            title="Delete this draft"
                            disabled={busy === inv.id}
                            onClick={() => void remove(inv)}
                          >
                            <Icon name="Trash2" size={15} />
                          </button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => void open(inv.id)}>
                            View
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="ExternalLink"
                            onClick={() => void api.invoices.openInQbo(inv.id)}
                          >
                            Open
                          </Button>
                          {inv.status !== 'sent' && (
                            <Button
                              size="sm"
                              variant="primary"
                              icon="Mail"
                              loading={busy === inv.id}
                              disabled={!inv.email}
                              title={
                                inv.email
                                  ? `Email it to ${inv.email}`
                                  : 'That buyer has no email address'
                              }
                              onClick={() => void send(inv)}
                            >
                              Send
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="inv-foot">
        <Icon name="Info" size={14} />
        <span>
          <b>Create in QuickBooks</b> posts the invoice and opens it in your browser so you can
          check it and press Send. It needs the buyer and every product to already exist in
          QuickBooks. <b>Export CSV</b> writes Intuit&rsquo;s own import template and works with
          no connection at all — turn on &ldquo;Custom transaction numbers&rdquo; in QuickBooks
          first, or it will replace these numbers with its own.
        </span>
      </p>
    </>
  )
}

function Stat({
  icon,
  value,
  label
}: {
  icon: string
  value: string
  label: string
}): JSX.Element {
  return (
    <div className="stat-card">
      <div className="stat-icon">
        <Icon name={icon} size={18} />
      </div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
