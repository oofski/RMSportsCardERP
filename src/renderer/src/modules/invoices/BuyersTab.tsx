import { useCallback, useEffect, useState } from 'react'
import type { InvoiceCustomer, InvoiceTerms } from '@shared/invoices'
import { INVOICE_TERMS } from '@shared/invoices'
import type { ContactImportResult } from '@shared/contacts'
import { summarizeImport } from '@shared/contacts'
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
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<ContactImportResult | null>(null)

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

  /**
   * Bring in the QuickBooks Customer Contact List.
   *
   * The result is kept on screen rather than announced in a toast and lost. An
   * import of 360 rows says something about nearly every one of them — which
   * were added, which already existed, which had an address this app could not
   * take apart — and a line of text that disappears after four seconds is not a
   * report anybody can act on.
   */
  const importContacts = async (): Promise<void> => {
    if (importing) return
    setImporting(true)
    try {
      const res = await api.invoices.importContacts()
      if (!res.ok || !res.data) {
        if (res.error && res.error !== 'No file selected.') toast.error(res.error)
        return
      }
      setImported(res.data)
      await load()
      toast.success(summarizeImport(res.data))
    } finally {
      setImporting(false)
    }
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
        <div className="row" style={{ gap: 8 }}>
          <Button
            variant="secondary"
            icon="FileUp"
            loading={importing}
            onClick={() => void importContacts()}
          >
            Import contacts
          </Button>
          <Button variant="primary" icon="UserPlus" onClick={() => setAdding(true)}>
            Add a buyer
          </Button>
        </div>
      </div>

      {imported && <ImportReport result={imported} onDismiss={() => setImported(null)} />}

      {buyers.length === 0 ? (
        <EmptyState
          icon="Users"
          title="No buyers yet"
          message="Add the people who buy from you, or import your QuickBooks Customer Contact List. Picking one on an invoice fills in their terms, email and standing message."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Where</th>
                <th>Terms</th>
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
                    <td className="muted">{b.phone || b.mobile || '—'}</td>
                    <td className="muted">{whereFrom(b) || '—'}</td>
                    <td className="muted">{b.terms}</td>
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
          write nobody asked for, and one misspelling leaves a duplicate forever. That
          is what <b>Import contacts</b> is for: it reads your QuickBooks Customer
          Contact List and files everybody under the name QuickBooks already knows them
          by, so the match is right without anybody typing it. Run it again whenever
          the list changes — it updates rather than duplicates.
        </span>
      </p>
    </>
  )
}

/**
 * The shortest true answer to "where are they".
 *
 * City and state when both are known, and the country on its own for an
 * overseas buyer whose address this app could not take apart — which is the
 * honest thing to show, because the full address is still on the record and
 * still prints. A blank cell where a country is known would read as "we have
 * nothing", and that is not what happened.
 */
function whereFrom(b: InvoiceCustomer): string {
  const a = b.billAddr
  if (!a) return ''
  const local = [a.city, a.region].filter(Boolean).join(', ')
  if (local) return a.country && a.country !== 'United States' ? `${local}, ${a.country}` : local
  return a.country ?? ''
}

/**
 * What the import did, kept on screen until it is dismissed.
 *
 * Three lists, and they are three different things:
 *
 *   SKIPPED   a row that produced no buyer. The report footer QuickBooks prints
 *             at the bottom of every export lands here every time, which is
 *             correct and is why the reason is spelled out rather than counted.
 *   NOTES     a buyer WAS imported, but something in the row could not be filed
 *             — nearly always an address written on one line. Nothing was lost:
 *             the text is on the record and prints; only the city column is
 *             empty. Naming the rows is what lets somebody tidy them.
 *   UNCHANGED not a failure. Re-importing the same file writes nothing, and the
 *             count is how the operator can tell that is what happened.
 */
function ImportReport({
  result,
  onDismiss
}: {
  result: ContactImportResult
  onDismiss: () => void
}): JSX.Element {
  const [open, setOpen] = useState<'skipped' | 'notes' | null>(null)
  const toggle = (which: 'skipped' | 'notes'): void => setOpen((v) => (v === which ? null : which))

  return (
    <div className="panel-card ci-report">
      <div className="ci-report-head">
        <div>
          <h3>Imported {result.source}</h3>
          <p>
            {result.rowsSeen} {result.rowsSeen === 1 ? 'row' : 'rows'} read.
          </p>
        </div>
        <button className="icon-btn" title="Dismiss" onClick={onDismiss}>
          <Icon name="X" size={16} />
        </button>
      </div>

      <div className="ci-counts">
        <div className="ci-count">
          <b>{result.added}</b>
          <span>added</span>
        </div>
        <div className="ci-count">
          <b>{result.updated}</b>
          <span>updated</span>
        </div>
        <div className="ci-count">
          <b>{result.unchanged}</b>
          <span>already up to date</span>
        </div>
        <button
          type="button"
          className={`ci-count ci-count-btn ${result.skipped.length ? 'warn' : ''}`}
          disabled={result.skipped.length === 0}
          onClick={() => toggle('skipped')}
        >
          <b>{result.skipped.length}</b>
          <span>skipped</span>
        </button>
        <button
          type="button"
          className={`ci-count ci-count-btn ${result.notes.length ? 'warn' : ''}`}
          disabled={result.notes.length === 0}
          onClick={() => toggle('notes')}
        >
          <b>{result.notes.length}</b>
          <span>needs a look</span>
        </button>
      </div>

      {open === 'skipped' && (
        <ul className="ci-list">
          {result.skipped.map((s) => (
            <li key={`${s.row}-${s.reason}`}>
              <span className="ci-row">Row {s.row}</span>
              <span className="ci-who">{s.label || '(blank)'}</span>
              <span className="ci-why">{s.reason}</span>
            </li>
          ))}
        </ul>
      )}

      {open === 'notes' && (
        <ul className="ci-list">
          {result.notes.map((n, i) => (
            <li key={`${n.row}-${i}`}>
              <span className="ci-row">Row {n.row}</span>
              <span className="ci-who">{n.name}</span>
              <span className="ci-why">{n.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  const [phone, setPhone] = useState(buyer?.phone ?? '')
  const [mobile, setMobile] = useState(buyer?.mobile ?? '')
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
        // Sent as null rather than omitted, so clearing the box actually clears
        // the number. saveCustomer leaves phones alone only when neither key is
        // present at all — which is the invoice screen's case, not this one.
        phone: phone || null,
        mobile: mobile || null,
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
          <label className="inv-field">
            Phone
            <input
              value={phone}
              placeholder="(555) 010-1234"
              onChange={(e) => setPhone(e.target.value)}
            />
            <span className="inv-hint">Kept exactly as typed — never reformatted.</span>
          </label>
          <label className="inv-field">
            Mobile
            <input
              value={mobile}
              placeholder="Only if it is a different number"
              onChange={(e) => setMobile(e.target.value)}
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
