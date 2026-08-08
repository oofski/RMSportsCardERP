import { useCallback, useEffect, useState } from 'react'
import type { InvoiceCustomer, InvoiceTerms } from '@shared/invoices'
import { INVOICE_TERMS } from '@shared/invoices'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

/**
 * The people who buy from us.
 *
 * Its own tab rather than a modal reachable only from inside an invoice, which
 * is where this started. That arrangement meant a buyer could only be corrected
 * while writing an invoice TO them — so a wrong email sat wrong until the next
 * sale, and nobody could answer "who do we sell to" without opening a form.
 *
 * ## What is stored is the RELATIONSHIP
 *
 * Terms, email, location, class and the standing message. Every one of them is
 * a fact about dealing with this person rather than about one sale, which is
 * exactly why picking them on an invoice fills all five in — and why they are
 * worth keeping in one place that can be edited on its own.
 */
export function BuyersTab(): JSX.Element {
  const toast = useToast()
  const [buyers, setBuyers] = useState<InvoiceCustomer[]>([])
  const [totals, setTotals] = useState<Record<string, { count: number; value: number }>>({})
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<InvoiceCustomer | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    const [list, invoices] = await Promise.all([api.invoices.customers(), api.invoices.list()])
    setBuyers(list)
    // What each buyer has been billed, so the list answers "who is worth
    // chasing" rather than just "who exists". Voided invoices are not money.
    const sums: Record<string, { count: number; value: number }> = {}
    for (const inv of invoices) {
      if (!inv.customerId || inv.status === 'void') continue
      const row = sums[inv.customerId] ?? { count: 0, value: 0 }
      row.count += 1
      row.value += inv.total
      sums[inv.customerId] = row
    }
    setTotals(sums)
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

  const remove = async (buyer: InvoiceCustomer): Promise<void> => {
    const res = await api.invoices.deleteCustomer(buyer.id)
    if (!res.ok) {
      toast.error(res.error ?? 'Could not remove that buyer.')
      return
    }
    await load()
    // Retired vs deleted is a real difference and the toast says which happened
    // — somebody who expects a name gone and finds it merely hidden should not
    // have to work that out from the list.
    toast.success(
      res.data?.deleted
        ? `${buyer.name} removed.`
        : `${buyer.name} retired — their invoices keep their history.`
    )
  }

  if (loading) return <CenterLoader />

  if (editing || adding) {
    return (
      <BuyerForm
        buyer={editing}
        onClose={() => {
          setEditing(null)
          setAdding(false)
        }}
        onSaved={async () => {
          await load()
          setEditing(null)
          setAdding(false)
        }}
      />
    )
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Buyers</h2>
        </div>
        <Button variant="primary" icon="UserPlus" onClick={() => setAdding(true)}>
          Add a buyer
        </Button>
      </div>

      {buyers.length === 0 ? (
        <EmptyState
          icon="Users"
          title="No buyers yet"
          message="Add the people who buy from you. Picking one on an invoice fills in their terms, email and standing message."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Terms</th>
                <th>Location</th>
                <th style={{ textAlign: 'right' }}>Invoices</th>
                <th style={{ textAlign: 'right' }}>Billed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {buyers.map((b) => {
                const t = totals[b.id]
                return (
                  <tr
                    key={b.id}
                    onClick={() => setEditing(b)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ fontWeight: 600 }}>{b.name}</td>
                    <td className="muted">{b.email || '—'}</td>
                    <td className="muted">{b.terms}</td>
                    <td className="muted">{b.location || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{t?.count ?? 0}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatMoney(t?.value ?? 0)}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="cell-actions">
                        <button
                          className="icon-btn"
                          title={
                            t?.count
                              ? 'Retire this buyer — their invoices keep their history'
                              : 'Remove this buyer'
                          }
                          onClick={() => void remove(b)}
                        >
                          <Icon name="Trash2" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="inv-foot">
        <Icon name="Info" size={14} />
        <span>
          To create an invoice in QuickBooks the buyer must exist there under the{' '}
          <b>same name</b>. This app deliberately does not add them for you — creating a
          contact in your accounting system as a side effect of billing somebody is a
          write nobody asked for, and one misspelling leaves a duplicate forever.
        </span>
      </p>
    </>
  )
}

function BuyerForm({
  buyer,
  onClose,
  onSaved
}: {
  buyer: InvoiceCustomer | null
  onClose: () => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [name, setName] = useState(buyer?.name ?? '')
  const [email, setEmail] = useState(buyer?.email ?? '')
  const [terms, setTerms] = useState<InvoiceTerms>(buyer?.terms ?? 'Net 30')
  const [location, setLocation] = useState(buyer?.location ?? '')
  const [className, setClassName] = useState(buyer?.className ?? '')
  const [message, setMessage] = useState(buyer?.message ?? '')
  const [notes, setNotes] = useState(buyer?.notes ?? '')
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const res = await api.invoices.saveCustomer({
        id: buyer?.id ?? null,
        name,
        email: email || null,
        terms,
        location: location || null,
        className: className || null,
        message: message || null,
        notes: notes || null
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save that buyer.')
        return
      }
      await onSaved()
      toast.success(`Saved ${res.data?.name}.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <button className="icon-btn" onClick={onClose} title="Back to buyers">
            <Icon name="ArrowLeft" size={18} />
          </button>
          <h2 style={{ margin: 0 }}>{buyer ? buyer.name : 'New buyer'}</h2>
        </div>
      </div>

      <div className="panel-card">
        <div className="inv-grid">
          <label className="inv-field" style={{ gridColumn: 'span 2' }}>
            Name
            <input
              value={name}
              placeholder="Chris Smith"
              onChange={(e) => setName(e.target.value)}
            />
            <span className="inv-hint">Must match QuickBooks exactly to post there.</span>
          </label>
          <label className="inv-field">
            Terms
            <select value={terms} onChange={(e) => setTerms(e.target.value as InvoiceTerms)}>
              {INVOICE_TERMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="inv-field" style={{ gridColumn: 'span 2' }}>
            Email
            <input
              value={email}
              placeholder="buyer@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="inv-hint">Where QuickBooks sends the invoice.</span>
          </label>
          <label className="inv-field">
            Location
            <input
              value={location}
              placeholder="West"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
          <label className="inv-field" style={{ gridColumn: 'span 2' }}>
            Standing message on their invoices
            <input
              value={message}
              placeholder="Thank you for your business!"
              onChange={(e) => setMessage(e.target.value)}
            />
          </label>
          <label className="inv-field">
            Class
            <input
              value={className}
              placeholder="Class A:Subclass B"
              onChange={(e) => setClassName(e.target.value)}
            />
          </label>
          <label className="inv-field" style={{ gridColumn: 'span 3' }}>
            Notes
            <input
              value={notes}
              placeholder="Buys sealed wax, pays fast"
              onChange={(e) => setNotes(e.target.value)}
            />
            <span className="inv-hint">Internal — never exported and never shown to them.</span>
          </label>
        </div>
      </div>

      <div className="inv-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="Check"
          loading={saving}
          disabled={!name.trim()}
          onClick={() => void save()}
        >
          Save buyer
        </Button>
      </div>
    </>
  )
}
