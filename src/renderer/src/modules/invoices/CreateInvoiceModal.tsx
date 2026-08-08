import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { Carrier, PaymentTiming } from '@shared/freight'
import type { InvoiceCustomer, InvoiceDetail, InvoiceTerms } from '@shared/invoices'
import { INVOICE_TERMS, dueDateFor, lineAmount, money } from '@shared/invoices'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { FreightFields } from '../../components/FreightFields'
import { POCatalogTypeahead } from '../invoicing/POCatalogTypeahead'
import { CustomerTypeahead } from './CustomerTypeahead'

/**
 * Build an invoice — the mirror of "New purchase order", on purpose.
 *
 * The owner pointed at the PO modal and said "this". So this is that: the same
 * dialog, the same header row of fields, the SAME product typeahead component,
 * the same line table with a running total, the same footer. A PO adds catalog
 * products with a BUY price; this adds the same catalog products with a SELL
 * price. Somebody who can raise a PO can raise an invoice without being taught
 * anything.
 *
 * ## Every field QuickBooks needs, and no more
 *
 * Invoice number, customer, email, terms, invoice date, due date, location,
 * memo, message, class — Intuit's own import template, which is the definition
 * of "enough to create it over there". Nothing else is asked for, because a
 * field that is not on their template is a field that cannot travel.
 *
 * ## Picking a buyer fills five things in
 *
 * Terms, email, location, class and their standing message. All are properties
 * of the RELATIONSHIP rather than of one sale, and every one stays editable —
 * the point of an agreed price is that this sale might be different.
 */

/** A working line. Quantity and prices are strings so the inputs stay
 *  controlled and empty-while-typing is allowed, exactly as the PO modal does. */
interface DraftLine {
  key: string
  item: string
  description: string
  quantity: string
  rate: string
  amount: string
  /** True once somebody types an amount that is not quantity × rate. */
  amountEdited: boolean
}

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function CreateInvoiceModal({
  invoice,
  customers,
  nextNumber,
  onClose,
  onSaved,
  onOpenQuickBooks
}: {
  /** Null for a new one; an existing draft to edit otherwise. */
  invoice: InvoiceDetail | null
  customers: InvoiceCustomer[]
  /** Suggested number for a new invoice, already fetched by the board. */
  nextNumber: string
  onClose: () => void
  onSaved: () => void | Promise<void>
  onOpenQuickBooks: () => void
}): JSX.Element {
  const toast = useToast()

  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber || nextNumber)
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
  const [carrier, setCarrier] = useState<Carrier | null>(invoice?.carrier ?? null)
  const [service, setService] = useState<string | null>(invoice?.service ?? null)
  const [trackingNumber, setTrackingNumber] = useState<string | null>(
    invoice?.trackingNumber ?? null
  )
  const [paymentTiming, setPaymentTiming] = useState<PaymentTiming | null>(
    invoice?.paymentTiming ?? null
  )
  const [lines, setLines] = useState<DraftLine[]>(() =>
    (invoice?.lines ?? []).map((l) => ({
      key: l.id,
      item: l.item,
      description: l.description ?? '',
      quantity: String(l.quantity),
      rate: String(l.rate),
      amount: String(l.amount),
      amountEdited: money(l.amount) !== lineAmount(l.quantity, l.rate)
    }))
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /** Choosing a saved buyer takes everything the relationship already knows. */
  const pick = (c: InvoiceCustomer): void => {
    setCustomerId(c.id)
    setCustomerName(c.name)
    setEmail(c.email ?? '')
    setTerms(c.terms)
    setDueDate(dueDateFor(invoiceDate, c.terms))
    setLocation(c.location ?? '')
    setClassName(c.className ?? '')
    if (c.message) setMessage(c.message)
  }

  /** Typing over the name detaches it from the saved record — otherwise a
   *  one-off "Chris Smith: Job A" would rename the buyer on the next save. */
  const typeName = (name: string): void => {
    setCustomerName(name)
    setCustomerId('')
  }

  const setTermsAndDue = (t: InvoiceTerms): void => {
    setTerms(t)
    setDueDate(dueDateFor(invoiceDate, t))
  }

  const setDateAndDue = (d: string): void => {
    setInvoiceDate(d)
    setDueDate(dueDateFor(d, terms))
  }

  /** A product from the SAME catalog typeahead the PO modal uses. */
  const addLine = (p: InventoryProduct): void => {
    setLines((ls) => [
      ...ls,
      {
        key: `${p.id}-${ls.length}-${p.sku ?? ''}`,
        item: p.name,
        description: '',
        quantity: '1',
        // The catalog's sale price is OFFERED. It is a starting point, not the
        // deal — which is why the amount stops following it the moment somebody
        // types over either field.
        rate: p.salePrice ? String(p.salePrice) : '',
        amount: p.salePrice ? String(money(p.salePrice)) : '',
        amountEdited: false
      }
    ])
  }

  const patch = (key: string, next: Partial<DraftLine>): void => {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        const merged = { ...l, ...next }
        // Quantity and rate recompute the amount only while nobody has taken it
        // over. Once they have, it is the agreed price and this form stops
        // arguing with the person who made the deal.
        if (('quantity' in next || 'rate' in next) && !merged.amountEdited) {
          const q = parseFloat(merged.quantity)
          const r = parseFloat(merged.rate)
          merged.amount =
            Number.isFinite(q) && Number.isFinite(r) ? String(lineAmount(q, r)) : merged.amount
        }
        return merged
      })
    )
  }

  const total = useMemo(
    () => money(lines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0)),
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
    sendLater: false,
    className: className.trim() || null,
    carrier,
    service: service?.trim() || null,
    trackingNumber: trackingNumber?.trim() || null,
    paymentTiming,
    lines: lines.map((l) => ({
      item: l.item,
      description: l.description || null,
      quantity: parseFloat(l.quantity) || 0,
      rate: parseFloat(l.rate) || 0,
      amount: parseFloat(l.amount) || 0,
      taxRate: null,
      className: null
    }))
  })

  /** Validate here so the message names the line, not just "something is wrong". */
  const check = (): string => {
    if (!customerName.trim()) return 'Pick a buyer, or type who this is for.'
    if (lines.length === 0) return 'Add at least one thing they are buying.'
    for (const l of lines) {
      const q = parseFloat(l.quantity)
      if (!Number.isFinite(q) || q <= 0) return `Quantity for ${l.item} must be above zero.`
      const r = parseFloat(l.rate)
      if (l.rate.trim() !== '' && (!Number.isFinite(r) || r < 0)) {
        return `Rate for ${l.item} must be 0 or more.`
      }
    }
    if (dueDate < invoiceDate) return 'The due date cannot be before the invoice date.'
    return ''
  }

  const save = async (): Promise<InvoiceDetail | null> => {
    const problem = check()
    if (problem) {
      setError(problem)
      return null
    }
    setError('')
    const res = await api.invoices.save(build())
    if (!res.ok || !res.data) {
      setError(res.error ?? 'Could not save the invoice.')
      return null
    }
    return res.data
  }

  const saveDraft = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await save()
      if (!saved) return
      await onSaved()
      toast.success(`Saved invoice ${saved.invoiceNumber || ''}.`)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Save, post, then open the browser on it.
   *
   * Saving first is not a convenience: QuickBooks is sent what is in the
   * DATABASE, so posting without saving would bill somebody for the previous
   * version of the invoice on screen.
   */
  const createInQbo = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await save()
      if (!saved) return
      const res = await api.invoices.createInQbo(saved.id)
      if (!res.ok) {
        // The draft IS saved by this point, which is the useful half — say so,
        // or somebody retypes an invoice already sitting in the list.
        await onSaved()
        const why = res.error ?? 'QuickBooks would not take that.'
        setError(`${why} The draft is saved.`)
        // "Not connected" is the one failure with an obvious next step.
        if (/not connected|reconnect|consent|client id/i.test(why)) {
          onClose()
          onOpenQuickBooks()
        }
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
      setBusy(false)
    }
  }

  const makePdf = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const saved = await save()
      if (!saved) return
      await onSaved()
      await api.invoices.openPdf(saved.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={invoice ? `Invoice ${invoice.invoiceNumber || ''}` : 'New invoice'}
      subtitle="Pick a buyer, add what they bought, and set the price you agreed."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" icon="FileText" loading={busy} onClick={makePdf}>
            PDF
          </Button>
          <Button variant="secondary" icon="Save" loading={busy} onClick={saveDraft}>
            Save draft
          </Button>
          <Button
            variant="primary"
            icon="ReceiptText"
            loading={busy}
            disabled={lines.length === 0}
            onClick={createInQbo}
          >
            Create in QuickBooks
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      {/* ---- Who, and on what terms ------------------------------------- */}
      <CustomerTypeahead
        customers={customers}
        value={customerName}
        onPick={pick}
        onType={typeName}
      />

      <div className="field-row">
        <Field label="Email" hint="Where QuickBooks sends it">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="buyer@example.com"
          />
        </Field>
        <Field label="Terms" hint="Sets the due date">
          <Select
            value={terms}
            onChange={(e) => setTermsAndDue(e.target.value as InvoiceTerms)}
          >
            {INVOICE_TERMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Invoice number" hint="Yours, unless QuickBooks renumbers it">
          <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Invoice date">
          <Input
            type="date"
            value={invoiceDate}
            onChange={(e) => setDateAndDue(e.target.value)}
          />
        </Field>
        <Field label="Due date" hint="From the terms — change it if you agreed something else">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Location" hint="Optional">
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. West"
          />
        </Field>
      </div>

      {/* ---- How it gets there, and when it gets paid for ------------------ */}
      <FreightFields
        carrier={carrier}
        service={service}
        trackingNumber={trackingNumber}
        paymentTiming={paymentTiming}
        hint="Who is taking it to them"
        onChange={(patch) => {
          if ('carrier' in patch) setCarrier(patch.carrier ?? null)
          if ('service' in patch) setService(patch.service ?? null)
          if ('trackingNumber' in patch) setTrackingNumber(patch.trackingNumber ?? null)
          if ('paymentTiming' in patch) setPaymentTiming(patch.paymentTiming ?? null)
        }}
      />

      {/* ---- What they are buying ---------------------------------------- */}
      <POCatalogTypeahead onSelect={addLine} />

      {lines.length === 0 ? (
        <div className="po-lines-empty">
          No line items yet — search your inventory above to add products.
        </div>
      ) : (
        <div className="po-lines">
          <table className="data po-lines-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Rate</th>
                <th className="num">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>
                    <div className="po-line-name">{l.item}</div>
                  </td>
                  <td>
                    <Input
                      value={l.description}
                      placeholder="Optional"
                      onChange={(e) => patch(l.key, { description: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <Input
                      value={l.quantity}
                      inputMode="decimal"
                      className="po-qty-input"
                      onChange={(e) => patch(l.key, { quantity: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <Input
                      value={l.rate}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="po-price-input"
                      onChange={(e) => patch(l.key, { rate: e.target.value })}
                    />
                  </td>
                  <td className="num">
                    <Input
                      value={l.amount}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="po-price-input"
                      title={
                        l.amountEdited
                          ? `Agreed price — quantity × rate would be ${formatMoney(
                              lineAmount(parseFloat(l.quantity) || 0, parseFloat(l.rate) || 0)
                            )}`
                          : undefined
                      }
                      onChange={(e) => patch(l.key, { amount: e.target.value, amountEdited: true })}
                    />
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      title="Remove line"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Icon name="Trash2" size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="po-total">
            <span>Total</span>
            <span className="mono">{formatMoney(total)}</span>
          </div>
        </div>
      )}

      {/* ---- What it says ------------------------------------------------ */}
      <div className="field-row">
        <Field label="Message on the invoice" hint="The buyer sees this">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. Thank you for your business!"
          />
        </Field>
        <Field label="Memo" hint="Internal — never shown to them">
          <Input
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="e.g. Paid half up front"
          />
        </Field>
        <Field label="Class" hint="Optional, for QuickBooks">
          <Input
            value={className}
            onChange={(e) => setClassName(e.target.value)}
            placeholder="e.g. Class A:Subclass B"
          />
        </Field>
      </div>
    </Modal>
  )
}
