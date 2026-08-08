import { useEffect, useMemo, useState } from 'react'
import type {
  InvoiceCustomer,
  InvoiceDetail,
  InvoiceTerms,
  NewInvoiceLine
} from '@shared/invoices'
import {
  INVOICE_TERMS,
  dueDateFor,
  invoiceTotal,
  lineAmount,
  money
} from '@shared/invoices'
import { api } from '../../lib/api'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

/**
 * Building an invoice.
 *
 * The owner described the flow exactly: pick the buyer and it fills itself in,
 * add what they are buying, put in the price you agreed, create it. So that is
 * the order the screen is in, and each step only asks for what the one before
 * it could not supply.
 *
 * ## Picking the buyer fills the rest in
 *
 * Terms, email, location, class and the standing message are properties of the
 * RELATIONSHIP, not of one sale. Re-typing them per invoice is how one ends up
 * on Net 30 and the next on Net 15 by accident, so choosing a buyer sets all
 * five — and every one stays editable, because the whole point of an agreed
 * price is that this sale might be different.
 *
 * ## Two lists behind the pickers, and only one of them is local
 *
 * The buyer list is this app's own, so somebody can raise an invoice with no
 * connection. The ITEM list comes from QuickBooks when it is connected, because
 * QuickBooks will reject a product it does not know and finding that out at the
 * moment of posting is far too late. When it is not connected the field is a
 * plain text box and the CSV export is the way out.
 *
 * ## The amount is agreed, not computed
 *
 * Quantity × rate fills the amount in and stops the moment somebody edits it.
 * A buyer talked down to a round number is an ordinary thing here, and a form
 * that kept recomputing over the top of it would be arguing with the person who
 * made the deal.
 */

interface DraftLine extends NewInvoiceLine {
  key: string
  /** True once somebody has typed an amount that is not quantity × rate. */
  amountEdited: boolean
}

function newLine(): DraftLine {
  return {
    key: Math.random().toString(36).slice(2),
    item: '',
    description: '',
    quantity: 1,
    rate: 0,
    amount: 0,
    taxRate: '',
    className: '',
    amountEdited: false
  }
}

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function InvoiceEditor({
  invoice,
  customers,
  onClose,
  onSaved,
  onOpenQuickBooks
}: {
  /** Null when this is a new one. */
  invoice: InvoiceDetail | null
  customers: InvoiceCustomer[]
  onClose: () => void
  onSaved: () => Promise<void>
  /** Where to send somebody when QuickBooks turns out not to be connected. */
  onOpenQuickBooks: () => void
}): JSX.Element {
  const toast = useToast()
  const readOnly = !!invoice && invoice.status !== 'draft'

  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber ?? '')
  const [customerId, setCustomerId] = useState(invoice?.customerId ?? '')
  const [customerName, setCustomerName] = useState(invoice?.customerName ?? '')
  const [email, setEmail] = useState(invoice?.email ?? '')
  const [terms, setTerms] = useState<InvoiceTerms>(invoice?.terms ?? 'Net 30')
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? today())
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? dueDateFor(today(), 'Net 30'))
  const [location, setLocation] = useState(invoice?.location ?? '')
  const [className, setClassName] = useState(invoice?.className ?? '')
  const [memo, setMemo] = useState(invoice?.memo ?? '')
  const [message, setMessage] = useState(invoice?.message ?? '')
  const [sendLater, setSendLater] = useState(invoice?.sendLater ?? false)
  const [lines, setLines] = useState<DraftLine[]>(() =>
    invoice && invoice.lines.length > 0
      ? invoice.lines.map((l) => ({
          key: l.id,
          item: l.item,
          description: l.description ?? '',
          quantity: l.quantity,
          rate: l.rate,
          amount: l.amount,
          taxRate: l.taxRate ?? '',
          className: l.className ?? '',
          amountEdited: money(l.amount) !== lineAmount(l.quantity, l.rate)
        }))
      : [newLine()]
  )
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)

  /**
   * The product list, FROM INVENTORY.
   *
   * This used to read QuickBooks' item list, which was wrong about where the
   * truth lives: what this business sells is what is on its own shelves, and
   * the person writing an invoice knows a box by its catalog name, not by
   * whatever it was called when somebody set up the accounts. So the search is
   * the same catalog the purchase-order builder uses — name, SKU or UPC — and
   * it works with no QuickBooks connection at all.
   *
   * The name still has to MATCH a QuickBooks product to post over the API, and
   * that is checked at the moment of posting, by name, with a clear message.
   * The alternative — hiding every product QuickBooks has not heard of — would
   * make the common case (an invoice destined for the CSV, or for a PDF) unable
   * to name the thing actually being sold.
   */
  const [matches, setMatches] = useState<
    Array<{ id: string; name: string; sku: string | null; salePrice: number | null }>
  >([])
  const [searchFor, setSearchFor] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (readOnly || query.trim().length < 2) {
      setMatches([])
      return
    }
    let cancelled = false
    const t = window.setTimeout(async () => {
      try {
        const r = (await api.purchaseOrders.searchCatalog(query)) as Array<{
          id: string
          name: string
          sku?: string | null
          salePrice?: number | null
        }>
        if (!cancelled) {
          setMatches(
            r.slice(0, 8).map((p) => ({
              id: p.id,
              name: p.name,
              sku: p.sku ?? null,
              salePrice: typeof p.salePrice === 'number' ? p.salePrice : null
            }))
          )
        }
      } catch {
        if (!cancelled) setMatches([])
      }
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [query, readOnly])

  // A new invoice opens with the next number already in it.
  useEffect(() => {
    if (invoice) return
    let active = true
    void (async () => {
      const next = await api.invoices.nextNumber()
      if (active && next) setInvoiceNumber((n) => n || next)
    })()
    return () => {
      active = false
    }
  }, [invoice])

  /** Choosing a buyer fills in everything the relationship already knows. */
  const pickCustomer = (id: string): void => {
    setCustomerId(id)
    const c = customers.find((x) => x.id === id)
    if (!c) return
    setCustomerName(c.name)
    setEmail(c.email ?? '')
    setTerms(c.terms)
    setDueDate(dueDateFor(invoiceDate, c.terms))
    setLocation(c.location ?? '')
    setClassName(c.className ?? '')
    if (c.message) setMessage(c.message)
  }

  const setTermsAndDue = (t: InvoiceTerms): void => {
    setTerms(t)
    setDueDate(dueDateFor(invoiceDate, t))
  }

  const setDateAndDue = (d: string): void => {
    setInvoiceDate(d)
    setDueDate(dueDateFor(d, terms))
  }

  const patchLine = (key: string, patch: Partial<DraftLine>): void => {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        const next = { ...l, ...patch }
        // Quantity and rate recompute the amount only while nobody has taken it
        // over. Once they have, it is the agreed price and this form stops
        // arguing with them.
        if (('quantity' in patch || 'rate' in patch) && !next.amountEdited) {
          next.amount = lineAmount(next.quantity, next.rate)
        }
        return next
      })
    )
  }

  const total = useMemo(
    () => invoiceTotal(lines.map((l) => ({ amount: Number(l.amount) || 0 }))),
    [lines]
  )

  const build = (): Parameters<typeof api.invoices.save>[0] => ({
    id: invoice?.id ?? null,
    invoiceNumber: invoiceNumber.trim() || null,
    customerId: customerId || null,
    customerName: customerName.trim(),
    email: email.trim() || null,
    terms,
    invoiceDate,
    dueDate,
    location: location.trim() || null,
    memo: memo.trim() || null,
    message: message.trim() || null,
    sendLater,
    className: className.trim() || null,
    lines: lines.map((l) => ({
      item: l.item,
      description: l.description || null,
      quantity: Number(l.quantity) || 0,
      rate: Number(l.rate) || 0,
      amount: Number(l.amount) || 0,
      taxRate: l.taxRate || null,
      className: l.className || null
    }))
  })

  const save = async (): Promise<InvoiceDetail | null> => {
    const res = await api.invoices.save(build())
    if (!res.ok) {
      toast.error(res.error ?? 'Could not save that invoice.')
      return null
    }
    return res.data ?? null
  }

  const saveDraft = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const saved = await save()
      if (!saved) return
      await onSaved()
      toast.success('Saved.')
      onClose()
    } finally {
      setSaving(false)
    }
  }

  /**
   * Save, then post, then open the browser.
   *
   * One button because it is one intention. Saving first is not a convenience —
   * QuickBooks is sent what is in the DATABASE, so posting without saving would
   * quietly bill somebody for the previous version of the invoice on screen.
   */
  const createInQbo = async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const saved = await save()
      if (!saved) return
      const res = await api.invoices.createInQbo(saved.id)
      if (!res.ok) {
        // The draft IS saved at this point, which is the useful half. Say so,
        // or somebody retypes an invoice that is already sitting in the list.
        await onSaved()
        const why = res.error ?? 'QuickBooks would not take that.'
        toast.error(`${why} The draft is saved.`)
        // "Not connected" is the one failure with an obvious next step, and
        // leaving somebody to find the setting three screens away is how a
        // feature gets written off as broken.
        if (/not connected|reconnect|consent/i.test(why)) onOpenQuickBooks()
        return
      }
      await onSaved()
      toast.success(
        res.data?.numberChanged
          ? `Created in QuickBooks as ${res.data.docNumber} — it renumbered ours. Opening it now.`
          : 'Created in QuickBooks. Opening it now — press Send there.'
      )
      onClose()
    } finally {
      setCreating(false)
    }
  }

  /** Save this buyer for next time, so the auto-fill has something to fill from. */
  const rememberBuyer = async (): Promise<void> => {
    const res = await api.invoices.saveCustomer({
      id: customerId || null,
      name: customerName,
      email: email || null,
      terms,
      location: location || null,
      className: className || null,
      message: message || null
    })
    if (!res.ok) {
      toast.error(res.error ?? 'Could not save that buyer.')
      return
    }
    setCustomerId(res.data?.id ?? '')
    await onSaved()
    toast.success(`Saved ${res.data?.name} for next time.`)
  }

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <button className="icon-btn" onClick={onClose} title="Back to invoices">
            <Icon name="ArrowLeft" size={18} />
          </button>
          <h2 style={{ margin: 0 }}>
            {invoice ? `Invoice ${invoice.invoiceNumber || ''}` : 'New invoice'}
          </h2>
          {readOnly && (
            <span className="inv-status" data-status={invoice?.status}>
              {invoice?.status === 'created' ? 'In QuickBooks' : 'Sent'}
            </span>
          )}
        </div>
      </div>

      {readOnly && invoice && (
        <div className="inv-actions" style={{ marginTop: 0, marginBottom: 12 }}>
          <Button
            variant="secondary"
            icon="FileText"
            onClick={() => void api.invoices.openPdf(invoice.id)}
          >
            PDF
          </Button>
          {invoice.qboId && (
            <Button
              variant="secondary"
              icon="ExternalLink"
              onClick={() => void api.invoices.openInQbo(invoice.id)}
            >
              Open in QuickBooks
            </Button>
          )}
        </div>
      )}

      {readOnly && (
        <p className="inv-locked">
          <Icon name="Info" size={14} />
          <span>
            This invoice is in QuickBooks, so it is read-only here — editing our copy would
            make the two disagree with nothing to say which is right. Change it in QuickBooks.
          </span>
        </p>
      )}

      {/* ---- Who is buying -------------------------------------------- */}
      <div className="panel-card">
        <div className="panel-head">
          <h3>Buyer</h3>
          <span className="ph-sub">Pick one and the rest fills itself in</span>
        </div>

        <div className="inv-grid">
          <label className="inv-field" style={{ gridColumn: 'span 2' }}>
            Buyer
            <div className="row" style={{ gap: 6 }}>
              <select
                value={customerId}
                disabled={readOnly}
                onChange={(e) => pickCustomer(e.target.value)}
                style={{ flex: 1 }}
              >
                <option value="">— choose a buyer —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <label className="inv-field" style={{ gridColumn: 'span 2' }}>
            Name on the invoice
            <input
              value={customerName}
              disabled={readOnly}
              placeholder="Chris Smith"
              onChange={(e) => {
                setCustomerName(e.target.value)
                // Typing over the name detaches it from the picked record —
                // otherwise a one-off "Chris Smith: Job A" would silently rename
                // the saved buyer the next time this invoice was touched.
                setCustomerId('')
              }}
            />
          </label>

          <label className="inv-field" style={{ gridColumn: 'span 2' }}>
            Email
            <input
              value={email}
              disabled={readOnly}
              placeholder="buyer@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="inv-field">
            Terms
            <select
              value={terms}
              disabled={readOnly}
              onChange={(e) => setTermsAndDue(e.target.value as InvoiceTerms)}
            >
              {INVOICE_TERMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="inv-field">
            Invoice number
            <input
              value={invoiceNumber}
              disabled={readOnly}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />
          </label>

          <label className="inv-field">
            Invoice date
            <input
              type="date"
              value={invoiceDate}
              disabled={readOnly}
              onChange={(e) => setDateAndDue(e.target.value)}
            />
          </label>

          <label className="inv-field">
            Due date
            <input
              type="date"
              value={dueDate}
              disabled={readOnly}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>

          <label className="inv-field">
            Location
            <input
              value={location}
              disabled={readOnly}
              placeholder="West"
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>

          <label className="inv-field">
            Class
            <input
              value={className}
              disabled={readOnly}
              placeholder="Class A:Subclass B"
              onChange={(e) => setClassName(e.target.value)}
            />
          </label>
        </div>

        {!readOnly && customerName.trim() && (
          <div className="inv-remember">
            <Button variant="secondary" size="sm" icon="UserPlus" onClick={() => void rememberBuyer()}>
              {customerId ? 'Update this buyer' : 'Save this buyer for next time'}
            </Button>
          </div>
        )}
      </div>

      {/* ---- What they are buying -------------------------------------- */}
      <div className="panel-card" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h3>What they are buying</h3>
          <span className="ph-sub">
            Searched straight from your inventory — name, SKU or UPC
          </span>
        </div>

        <div className="table-wrap">
          <table className="data inv-lines">
            <thead>
              <tr>
                <th style={{ width: '24%' }}>Product / service</th>
                <th>Description</th>
                <th style={{ width: 80, textAlign: 'right' }}>Qty</th>
                <th style={{ width: 100, textAlign: 'right' }}>Rate</th>
                <th style={{ width: 120, textAlign: 'right' }}>Amount</th>
                <th style={{ width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <div className="inv-item-cell">
                      <input
                        value={l.item}
                        disabled={readOnly}
                        placeholder="Search inventory…"
                        onFocus={() => {
                          setSearchFor(l.key)
                          setQuery(l.item)
                        }}
                        onChange={(e) => {
                          patchLine(l.key, { item: e.target.value })
                          setSearchFor(l.key)
                          setQuery(e.target.value)
                        }}
                        onBlur={() => {
                          // Late enough for a click on a result to land first.
                          window.setTimeout(() => {
                            setSearchFor((k) => (k === l.key ? null : k))
                          }, 160)
                        }}
                      />
                      {searchFor === l.key && matches.length > 0 && (
                        <ul className="inv-item-results">
                          {matches.map((m) => (
                            <li key={m.id}>
                              <button
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  // The catalog's sale price is OFFERED, never
                                  // imposed: it only fills a rate nobody has
                                  // typed and an amount nobody has agreed. The
                                  // whole point of this screen is the price you
                                  // settled on, which is often not the list one.
                                  patchLine(l.key, {
                                    item: m.name,
                                    ...(!l.amountEdited && !l.rate && m.salePrice
                                      ? { rate: m.salePrice }
                                      : {})
                                  })
                                  setSearchFor(null)
                                  setQuery('')
                                }}
                              >
                                <span className="inv-item-name">{m.name}</span>
                                {m.sku && <span className="inv-item-sku">{m.sku}</span>}
                                {m.salePrice ? (
                                  <span className="inv-item-price mono">
                                    {formatMoney(m.salePrice)}
                                  </span>
                                ) : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </td>
                  <td>
                    <input
                      value={l.description ?? ''}
                      disabled={readOnly}
                      placeholder="2 hours of Trimming."
                      onChange={(e) => patchLine(l.key, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.quantity}
                      disabled={readOnly}
                      style={{ textAlign: 'right' }}
                      onChange={(e) => patchLine(l.key, { quantity: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.rate}
                      disabled={readOnly}
                      style={{ textAlign: 'right' }}
                      onChange={(e) => patchLine(l.key, { rate: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.amount ?? 0}
                      disabled={readOnly}
                      style={{ textAlign: 'right', fontWeight: 600 }}
                      title={
                        l.amountEdited
                          ? `Agreed price — quantity × rate would be ${formatMoney(lineAmount(l.quantity, l.rate))}`
                          : undefined
                      }
                      onChange={(e) =>
                        patchLine(l.key, { amount: Number(e.target.value), amountEdited: true })
                      }
                    />
                  </td>
                  <td>
                    {!readOnly && lines.length > 1 && (
                      <button
                        className="icon-btn"
                        title="Remove this line"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                      >
                        <Icon name="X" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="inv-lines-foot">
          {!readOnly && (
            <Button
              variant="secondary"
              size="sm"
              icon="Plus"
              onClick={() => setLines((ls) => [...ls, newLine()])}
            >
              Add a line
            </Button>
          )}
          <span className="inv-total">
            <em>Total</em>
            <b className="mono">{formatMoney(total)}</b>
          </span>
        </div>
      </div>

      {/* ---- Notes ------------------------------------------------------ */}
      <div className="panel-card" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h3>Notes</h3>
        </div>
        <div className="inv-grid">
          <label className="inv-field" style={{ gridColumn: 'span 3' }}>
            Message on the invoice
            <input
              value={message}
              disabled={readOnly}
              placeholder="Thank you for your business!"
              onChange={(e) => setMessage(e.target.value)}
            />
            <span className="inv-hint">The buyer sees this.</span>
          </label>
          <label className="inv-field" style={{ gridColumn: 'span 3' }}>
            Memo
            <input
              value={memo}
              disabled={readOnly}
              placeholder="First invoice of 3 month contract."
              onChange={(e) => setMemo(e.target.value)}
            />
            <span className="inv-hint">Internal — QuickBooks does not show this to them.</span>
          </label>
        </div>
        {!readOnly && (
          <label className="inv-check">
            <input
              type="checkbox"
              checked={sendLater}
              onChange={(e) => setSendLater(e.target.checked)}
            />
            Mark &ldquo;Send later&rdquo; on the CSV export
          </label>
        )}
      </div>

      {!readOnly && (
        <div className="inv-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" icon="Save" loading={saving} onClick={() => void saveDraft()}>
            Save draft
          </Button>
          {/* The document a BUYER reads. Saves first, because the PDF is built
              from the database and printing an unsaved edit would hand somebody
              the previous version of the invoice on screen. */}
          {invoice && (
            <Button
              variant="secondary"
              icon="FileText"
              onClick={async () => {
                const saved = await save()
                if (saved) await api.invoices.openPdf(saved.id)
              }}
            >
              PDF
            </Button>
          )}
          <Button
            variant="primary"
            icon="Send"
            loading={creating}
            onClick={() => void createInQbo()}
          >
            Create in QuickBooks
          </Button>
        </div>
      )}
    </>
  )
}
