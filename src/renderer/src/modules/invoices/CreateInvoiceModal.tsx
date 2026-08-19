import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { Carrier, PaymentTiming } from '@shared/freight'
import { carrierLabel } from '@shared/freight'
import type {
  InvoiceCustomer,
  InvoiceDetail,
  InvoiceLine,
  InvoiceStatus,
  InvoiceTerms,
  NewInvoice,
  NewInvoiceLine
} from '@shared/invoices'
import {
  DEFAULT_INVOICE_TERMS,
  INVOICE_STAGES,
  INVOICE_TERMS,
  dueDateFor,
  lineAmount,
  money
} from '@shared/invoices'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatDate, formatMoney } from '../../lib/format'
import { FreightFields } from '../../components/FreightFields'
import { PaymentBar } from '../../components/PaymentProgress'
import { OrderHistory } from '../orders/OrderHistory'
import { OrderLabels } from '../orders/OrderLabels'
import { OrderShipments } from '../orders/OrderShipments'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { DestinationSelect, SupplierSelect } from '../invoicing/PartySelect'
import { CategoryLogo } from '../inventory/CategoryLogo'
import { POCatalogTypeahead } from '../invoicing/POCatalogTypeahead'
import { CustomerTypeahead } from './CustomerTypeahead'
import { QboReadiness } from './QboReadiness'
import { InvoiceStatusChip, formatDay } from './helpers'

/**
 * One invoice, in the shape of a purchase order.
 *
 * The owner pointed at the PO modal and said "this", so this is that, down to
 * the class names: the same header block with the number, the party and a
 * status chip; the same compact date strip; the same shipping fields with their
 * helper text and the same boxed PAYMENT pair; the same line rows with a
 * product name over its SKU; the same grand total; the same footer.
 *
 * ## Two faces, because the backend has two answers
 *
 * A DRAFT is a form. Anything past draft is a RECEIPT — read-only, laid out
 * exactly like `PurchaseOrderReceipt`. That is not a styling preference:
 * `saveInvoice` refuses any invoice that has already gone to QuickBooks, so the
 * editable form on a posted invoice was a screenful of inputs whose only
 * possible outcome was an error at the end. Showing what it says instead is the
 * honest version of the same screen.
 *
 * ## Every field QuickBooks needs, and no more
 *
 * Invoice number, customer, email, terms, invoice date, due date, location,
 * memo, message, class — Intuit's own import template, which is the definition
 * of "enough to create it over there". A field that is not on their template is
 * a field that cannot travel.
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
  /**
   * The catalog product this line came from. Empty for a line somebody typed
   * freehand, which stays legal — plenty of what gets billed here is a service
   * that was never stock. It is what the picker de-duplicates on, so an empty
   * one must never match another empty one; see `addLine`.
   */
  productId: string
  item: string
  sku: string
  /**
   * Shown beside the SKU while the line is being built. Not stored on the saved
   * line — `InvoiceLine` snapshots the name and SKU because those print on the
   * document, and a category does not — so it is blank on reopen rather than
   * fetched back, which would be a catalog read per line to decorate a subtitle.
   */
  category: string
  description: string
  quantity: string
  rate: string
  amount: string
  /** True once somebody types an amount that is not quantity × rate. */
  amountEdited: boolean
  /**
   * Where this line is fulfilled FROM. Empty means the order's location.
   *
   * The sell-side mirror of a purchase order line's destination. 'RM' or 'AM'
   * draws that shelf down; any other name is a DROPSHIP — the supplier sent it
   * straight to the buyer and no stock moves here.
   */
  destination: string
  /** Who shipped a dropshipped line. Empty means nobody has said. */
  supplier: string
}

function today(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Quantity × rate, unless somebody has taken the amount over.
 *
 * Pulled out of the change handler because the picker bumps a quantity too, and
 * a second copy of this rule there was how adding the same product twice left a
 * line whose amount still said one unit.
 */
function withAmount(line: DraftLine): DraftLine {
  if (line.amountEdited) return line
  const q = parseFloat(line.quantity)
  const r = parseFloat(line.rate)
  if (!Number.isFinite(q) || !Number.isFinite(r)) return line
  return { ...line, amount: String(lineAmount(q, r)) }
}

export function CreateInvoiceModal({
  invoice,
  prefill,
  onSavedInvoice,
  customers,
  nextNumber,
  thumbnails,
  onClose,
  onSaved,
  onDelete,
  onOpenQuickBooks
}: {
  /** Null for a new one; an existing invoice to open otherwise. */
  invoice: InvoiceDetail | null
  /**
   * A new order that arrives PART-FILLED, for the second screen of a dropship.
   *
   * Ignored entirely when `invoice` is set — an existing document has its own
   * values and a prefill on top of them would be a form quietly disagreeing with
   * what is stored. Every field remains editable; this only saves typing what
   * the purchase order already said.
   */
  prefill?: NewInvoice | null
  /**
   * What was saved, handed back so a caller can do something with it — the
   * dropship flow uses it to link the two halves. `onSaved` is still called for
   * the ordinary "reload the board" job, because most callers want only that.
   */
  onSavedInvoice?: (invoice: InvoiceDetail) => void | Promise<void>
  customers: InvoiceCustomer[]
  /** Suggested number for a new invoice, already fetched by the board. */
  nextNumber: string
  /** Catalog thumbnails by product id, loaded once by the board. */
  thumbnails: Record<string, string>
  onClose: () => void
  onSaved: () => void | Promise<void>
  /**
   * Ask to delete this invoice. Absent when there is nothing to delete yet (a
   * new invoice) — the board owns the confirmation, because it also owns the
   * list that has to lose a row afterwards.
   */
  onDelete?: (invoice: InvoiceDetail) => void
  onOpenQuickBooks: () => void
}): JSX.Element {
  const toast = useToast()

  const [invoiceNumber, setInvoiceNumber] = useState(invoice?.invoiceNumber || nextNumber)
  const [customerId, setCustomerId] = useState(invoice?.customerId ?? '')
  const [customerName, setCustomerName] = useState(
    invoice?.customerName ?? prefill?.customerName ?? ''
  )
  const [email, setEmail] = useState(invoice?.email ?? '')
  const [terms, setTerms] = useState<InvoiceTerms>(invoice?.terms ?? DEFAULT_INVOICE_TERMS)
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? today())
  const [dueDate, setDueDate] = useState(invoice?.dueDate ?? dueDateFor(today(), DEFAULT_INVOICE_TERMS))
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
  const [lines, setLines] = useState<DraftLine[]>(() => {
    // A PREFILLED ORDER SEEDS ITS OWN LINES, and every one of them carries the
    // destination the purchase order implied. That destination is what makes
    // each line a dropship and stops it drawing stock off a shelf this business
    // never put the units on — see dropshipSaleFromPurchase, which is the one
    // place that rule is applied.
    if (!invoice && prefill) {
      return prefill.lines.map((l, i) => ({
        key: `pre_${i}`,
        productId: l.productId ?? '',
        item: l.item,
        sku: l.sku ?? '',
        category: '',
        description: l.description ?? '',
        quantity: String(l.quantity),
        rate: l.rate ? String(l.rate) : '',
        amount: l.rate ? String(lineAmount(l.quantity, l.rate)) : '',
        amountEdited: false,
        destination: l.destination ?? '',
        supplier: l.supplier ?? ''
      }))
    }
    return (invoice?.lines ?? []).map((l) => ({
      key: l.id,
      productId: l.productId ?? '',
      item: l.item,
      sku: l.sku ?? '',
      category: '',
      description: l.description ?? '',
      quantity: String(l.quantity),
      rate: String(l.rate),
      amount: String(l.amount),
      amountEdited: money(l.amount) !== lineAmount(l.quantity, l.rate),
      // Read back RESOLVED — `toLine` has already turned an inherited NULL into
      // the order's location — so the picker shows what the line actually says
      // rather than a blank that means "ask the header".
      destination: l.destination ?? '',
      supplier: l.supplier ?? ''
    }))
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * Whether this screen is a form or a receipt.
   *
   * The condition is `saveInvoice`'s, not a guess: it throws on any invoice that
   * is no longer a draft, so anything else has to be shown rather than edited.
   */
  const editable = !invoice || invoice.status === 'draft'

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

  /**
   * Append a catalog pick, exactly as `CreatePurchaseOrderModal` does it: the
   * product's own name, SKU and category come across, the sale price is offered
   * as the rate, and picking something already on the invoice bumps its
   * quantity rather than opening a second row for the same box.
   *
   * The SKU is the point of the change. Before this the picker put a NAME on
   * the line and dropped everything else, so two products filed a word apart
   * were indistinguishable on the finished document — which is the whole reason
   * the PO rows carry a SKU under the name.
   */
  const addLine = (p: InventoryProduct): void => {
    setLines((prev) => {
      // Only a real id counts as "already here". Saved lines carry an empty one
      // and would otherwise all collapse onto whichever was picked first.
      if (p.id && prev.some((l) => l.productId === p.id)) {
        return prev.map((l) =>
          l.productId === p.id
            ? withAmount({ ...l, quantity: String((parseFloat(l.quantity) || 0) + 1) })
            : l
        )
      }
      return [
        ...prev,
        withAmount({
          key: `${p.id}-${prev.length}-${p.sku ?? ''}`,
          productId: p.id,
          item: p.name,
          sku: p.sku ?? '',
          category: p.category ?? '',
          description: '',
          quantity: '1',
          // The catalog's sale price is OFFERED. It is a starting point, not the
          // deal — which is why the amount stops following it the moment
          // somebody types over either field.
          rate: p.salePrice ? String(p.salePrice) : '',
          amount: '',
          amountEdited: false,
          // Empty inherits the order's location, which is what nearly every line
          // wants. Somebody drop-shipping changes this one line.
          destination: '',
          supplier: ''
        })
      ]
    })
  }

  const patch = (key: string, next: Partial<DraftLine>): void => {
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l
        const merged = { ...l, ...next }
        // Quantity and rate recompute the amount only while nobody has taken it
        // over. Once they have, it is the agreed price and this form stops
        // arguing with the person who made the deal.
        return 'quantity' in next || 'rate' in next ? withAmount(merged) : merged
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
    // productId and sku travel with every line. They are what makes the SKU
    // under a product name survive a reload — and what lets the posting code
    // match a QuickBooks Item on its SKU before falling back to a name somebody
    // may have edited over there.
    lines: lines.map(
      (l): NewInvoiceLine => ({
        item: l.item,
        productId: l.productId || null,
        sku: l.sku || null,
        description: l.description || null,
        quantity: parseFloat(l.quantity) || 0,
        rate: parseFloat(l.rate) || 0,
        amount: parseFloat(l.amount) || 0,
        taxRate: null,
        className: null,
        destination: l.destination || null,
        supplier: l.supplier || null
      })
    )
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
    // SAVE PUTS IT ON THE BOOKS. There is no separate "send to QuickBooks"
    // step any more — the document exists in both places or the reason is on
    // screen.
    //
    // The result shape is the load-bearing part: a QuickBooks failure comes
    // back as ok:true with pushed:false, because the invoice IS saved and only
    // the push has to be retried. Reading that as a failed save would tell
    // somebody their work was lost while it sat on disk, and they would type
    // it again.
    const res = await api.invoices.saveAndPush(build())
    if (!res.ok || !res.data) {
      setError(res.error ?? 'Could not save the invoice.')
      return null
    }
    if (!res.data.pushed) {
      // Saved locally, not in QuickBooks. Said out loud rather than swallowed:
      // an invoice that only exists here will not be on the books, and the
      // board's retry is the way out.
      toast.error(
        res.data.error
          ? `Saved here, but QuickBooks refused it: ${res.data.error}`
          : 'Saved here, but it did not reach QuickBooks. Retry it from the invoice card.'
      )
    } else if (res.data.numberChanged) {
      // QuickBooks assigns its own document numbers and will not always take
      // ours. Silently keeping the old one on screen means the number in the
      // app and the number the buyer receives disagree.
      toast.success(`Sent to QuickBooks as invoice ${res.data.docNumber}.`)
    }
    for (const note of res.data.notes ?? []) toast.error(note)
    // Handed to the caller BEFORE the modal closes, so a flow that has more to
    // do with this order — linking a dropship pair, say — acts on the document
    // that was actually written rather than on the draft that was submitted.
    if (onSavedInvoice) await onSavedInvoice(res.data.invoice)
    return res.data.invoice
  }

  /**
   * Save and close. The only Save there is.
   *
   * It was "Save draft" beside a "PDF" that also saved, which read as three
   * ways out of one form and hid which of them was the ordinary one. The PDF
   * lives on the board card now, where it can be reached without opening
   * anything.
   */
  const saveIt = async (): Promise<void> => {
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

  /**
   * Delete is offered only where it can succeed.
   *
   * `deleteInvoice` refuses anything with a QuickBooks id — deleting it here
   * would leave the invoice in the accounts with nothing on this side — and the
   * PO board settled the same question the same way: a button whose only
   * outcome is a refusal teaches the operator that delete is broken rather than
   * that this invoice is posted. Void it in QuickBooks instead.
   */
  const deletable = invoice !== null && onDelete !== undefined && !invoice.qboId

  return (
    <Modal
      title={
        invoice ? `Invoice ${invoice.qboDocNumber || invoice.invoiceNumber || ''}` : 'New invoice'
      }
      subtitle={
        editable
          ? 'Pick a buyer, add what they bought, and set the price you agreed.'
          : // Not "already in QuickBooks": an invoice settled in cash goes
            // draft → paid without ever being posted, and is just as uneditable.
            `${invoice?.customerName ?? ''} · no longer a draft, so this is a record rather than a form`
      }
      onClose={onClose}
      wide
      // THE SAME WIDTH AS A PURCHASE ORDER, and for the same stated reason.
      // At .modal-lg's 620px the money columns were squeezed to three characters
      // and the description had to be exiled under the product name. The two
      // documents are mirror images and are entered by the same person on the
      // same afternoon; they should not be two different shapes.
      className="modal-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {editable ? 'Cancel' : 'Close'}
          </Button>
          {deletable && (
            <Button
              variant="danger"
              icon="Trash2"
              disabled={busy}
              onClick={() => onDelete?.(invoice)}
            >
              Delete
            </Button>
          )}
          {editable && (
            <>
              <Button variant="secondary" icon="Save" loading={busy} onClick={saveIt}>
                Save
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
          )}
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      {/* Fed from the LIVE fields, not from `invoice`. A header sourced from the
          saved record kept showing the buyer and dates the invoice had when it
          was opened, so retyping the buyer left the top of the modal naming
          somebody else until the form was saved and reopened. */}
      <InvoiceHead
        number={invoice?.qboDocNumber || invoiceNumber}
        customerName={customerName}
        invoiceDate={invoiceDate}
        dueDate={dueDate}
        location={location}
        status={invoice?.status ?? 'draft'}
      />

      {editable ? (
        <>
          {/* ---- Who, and on what terms --------------------------------- */}
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
              <Select value={terms} onChange={(e) => setTermsAndDue(e.target.value as InvoiceTerms)}>
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
            <Field label="Invoice date" hint="The day it was billed">
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

          {/* ---- How it gets there, and when it gets paid for ------------- */}
          <FreightFields
            carrier={carrier}
            service={service}
            trackingNumber={trackingNumber}
            paymentTiming={paymentTiming}
            hint="Who is taking it to them"
            onChange={(p) => {
              if ('carrier' in p) setCarrier(p.carrier ?? null)
              if ('service' in p) setService(p.service ?? null)
              if ('trackingNumber' in p) setTrackingNumber(p.trackingNumber ?? null)
              if ('paymentTiming' in p) setPaymentTiming(p.paymentTiming ?? null)
            }}
          />

          {/* ---- What they are buying ------------------------------------ */}
          <POCatalogTypeahead onSelect={addLine} />

          {lines.length === 0 ? (
            <div className="po-lines-empty">
              No line items yet — search your inventory above to add products.
            </div>
          ) : (
            <div className="po-lines">
              <table className="data po-lines-table po-lines-routed">
                {/* THE SAME COLGROUP AS A PURCHASE ORDER. Fixed widths declared
                    once, product takes the slack — without it the money columns
                    were sized by whatever text happened to be in them, so typing
                    a longer supplier name shoved the rate field sideways and
                    every row re-flowed under the cursor. */}
                <colgroup>
                  <col />
                  <col className="po-col-qty" />
                  <col className="po-col-price" />
                  <col className="po-col-total" />
                  <col className="po-col-supplier" />
                  <col className="po-col-dest" />
                  <col className="po-col-remove" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">Rate</th>
                    <th className="num">Amount</th>
                    <th>Supplier</th>
                    {/* "Fulfilled from", not "Destination". On a purchase order
                        the column is where the goods GO; on a sales order they
                        always go to the buyer, so the open question is where they
                        COME FROM — our shelf, or a supplier who ships direct. */}
                    <th>Fulfilled from</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const from = l.destination || location || 'RM'
                    // DERIVED from where it comes from, exactly as the buy side
                    // derives it. A stored flag would be a second truth that
                    // drifts the first time a line is re-routed.
                    const drop = !destinationHoldsStock(from)
                    return (
                    <tr key={l.key}>
                      <td>
                        <div className="po-line-name">{l.item}</div>
                        {(l.sku || l.category) && (
                          <div className="po-line-sub">
                            {l.sku && <span className="mono">{l.sku}</span>}
                            {l.sku && l.category && <span> · </span>}
                            {l.category && <span>{l.category}</span>}
                          </div>
                        )}
                        {/* Description sits UNDER the name rather than in a
                            column of its own. Six columns inside a 620px modal
                            squeezed the money to three characters wide, and the
                            description is the one field on the row that is
                            usually empty. */}
                        <Input
                          value={l.description}
                          placeholder="Description (optional)"
                          className="inv-line-desc"
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
                          onChange={(e) =>
                            patch(l.key, { amount: e.target.value, amountEdited: true })
                          }
                        />
                      </td>
                      {/* Both routing cells are inheritance-first, the same as a
                          purchase order's: the opening option IS "same as the
                          order", it is what a new line is set to, and choosing it
                          stores NULL rather than a copy of the header. Muted
                          while inherited, solid once overridden — readable down
                          the column without opening a row. */}
                      <td>
                        <SupplierSelect
                          className={`po-route-party${l.supplier ? '' : ' is-inherited'}`}
                          ariaLabel={`Supplier for ${l.item}`}
                          value={l.supplier || null}
                          blankLabel={drop ? 'Who ships it?' : 'Off our own shelf'}
                          onChange={(name) => patch(l.key, { supplier: name ?? '' })}
                        />
                      </td>
                      <td>
                        <DestinationSelect
                          className={`po-route-party${l.destination ? '' : ' is-inherited'}`}
                          ariaLabel={`Fulfilled from, for ${l.item}`}
                          value={l.destination || null}
                          blankLabel={`Same as order (${location || 'RM'})`}
                          drop={drop}
                          onChange={(d) => patch(l.key, { destination: d ?? '' })}
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
                    )
                  })}
                </tbody>
              </table>
              <div className="po-total">
                <span>Grand total</span>
                <span className="mono">{formatMoney(total)}</span>
              </div>
            </div>
          )}

          {/* Directly under the lines, because that is what it is about. The
              refusal it predicts used to arrive after Save as a toast, by which
              point the invoice existed here and not there. */}
          <QboReadiness customerName={customerName} lines={lines} email={email} />

          {/* ---- What it says -------------------------------------------- */}
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
        </>
      ) : (
        invoice && <InvoiceReceipt invoice={invoice} thumbnails={thumbnails} />
      )}
    </Modal>
  )
}

/**
 * The header every invoice gets, form or receipt: the number, who owes, when it
 * was billed and when it falls due, and where it has got to.
 *
 * Same block as `po-receipt-head` — number large and monospaced, party under
 * it, dates under that, status chip pinned right — because a person who has
 * opened a PO should recognise this before reading a word of it.
 */
function InvoiceHead({
  number,
  customerName,
  invoiceDate,
  dueDate,
  location,
  status
}: {
  number: string
  customerName: string
  invoiceDate: string
  dueDate: string
  location: string
  status: InvoiceStatus
}): JSX.Element {
  return (
    <div className="po-receipt-head">
      <div className="po-rh-left">
        <div className="po-rh-num mono">{number || 'No number'}</div>
        {/* Says so rather than collapsing to nothing: an empty line here reads
            as a rendering fault, and "who is this for" is the one question a
            brand-new invoice most needs asked. */}
        <div className="po-rh-supplier">{customerName || 'No buyer yet'}</div>
        <div className="po-rh-date">
          {formatDay(invoiceDate)} · due {formatDay(dueDate)}
          {location ? ` · ${location}` : ''}
        </div>
      </div>
      <InvoiceStatusChip status={status} />
    </div>
  )
}

/**
 * A posted invoice as a document: the date strip, how it travels, the lines
 * with a thumbnail and a SKU under each name, and the grand total.
 *
 * Deliberately the same markup as `PurchaseOrderReceipt` rather than a
 * lookalike — the grid that lines those five columns up lives in `.po-receipt-*`
 * and a second copy of it would drift the first time a column moved.
 */
function InvoiceReceipt({
  invoice,
  thumbnails
}: {
  invoice: InvoiceDetail
  thumbnails: Record<string, string>
}): JSX.Element {
  const shipsWith = [carrierLabel(invoice.carrier), invoice.service].filter(Boolean).join(' · ')

  return (
    <div className="po-receipt">
      <div className="po-receipt-timeline">
        <TimeRow icon="ReceiptText" label="Invoiced" value={formatDay(invoice.invoiceDate)} />
        <TimeRow icon="CalendarClock" label="Due" value={formatDay(invoice.dueDate)} />
        {/* QuickBooks' day beats our instant when there is one. `qboPaidAt` is
            Payment.TxnDate — the calendar day the money is dated in the books,
            so formatDay — while `paidAt` is the instant somebody here ticked
            the box, which is often days later and is the wrong answer to "when
            was this paid". */}
        <TimeRow
          icon="DollarSign"
          label="Paid"
          value={
            invoice.qboPaidAt
              ? formatDay(invoice.qboPaidAt)
              : invoice.paidAt
                ? formatDate(invoice.paidAt)
                : '—'
          }
        />
      </div>

      {/* How much of it has actually been collected, on the same rail the buy
          side draws a part-received shipment with. Absent entirely until
          QuickBooks has said something — see PaymentBar. */}
      <PaymentBar invoice={invoice} className="po-ship-recv" />

      {/* Shipping is READ-ONLY here, which is a gap rather than a decision: the
          buy side can edit a PO's carrier from its receipt because
          api.purchaseOrders.setFreight exists, and there is no invoice
          equivalent yet. A tracking number typically arrives after the invoice
          has been sent, so this is exactly where it would be typed. */}
      {(shipsWith || invoice.trackingNumber) && (
        <div className="po-receipt-timeline">
          <TimeRow icon="Truck" label="Ships with" value={shipsWith || '—'} />
          <TimeRow icon="Hash" label="Tracking" value={invoice.trackingNumber || '—'} mono />
        </div>
      )}

      {invoice.message && <div className="po-receipt-notes">{invoice.message}</div>}

      <div className="po-receipt-lines">
        <div className="po-receipt-line po-receipt-line-head">
          <span className="po-rl-img" aria-hidden="true" />
          <span className="po-rl-name">Product</span>
          <span className="po-rl-qty">Qty</span>
          <span className="po-rl-price">Rate</span>
          <span className="po-rl-total">Amount</span>
        </div>
        {invoice.lines.map((line) => (
          <ReceiptLine key={line.id} line={line} thumbnails={thumbnails} />
        ))}
      </div>

      <div className="po-grand-total">
        <span>Grand total</span>
        <span className="mono">{formatMoney(invoice.total)}</span>
      </div>

      {/* The same three panels the buy side carries, in the same order and at
          the same place. A purchase order and a sales order are mirror images
          and somebody who has read one receipt should not have to learn the
          other. */}
      <OrderShipments
        side="so"
        orderId={invoice.id}
        canEdit={invoice.status !== 'void'}
        lines={invoice.lines.map((l) => ({ id: l.id, label: l.item, quantity: l.quantity }))}
      />
      <OrderLabels
        side="so"
        orderId={invoice.id}
        // The buyer is who the goods go to, so their address is the one already
        // on the document. On a dropship the label usually goes to the SUPPLIER
        // instead, which is why this is a default rather than a fixed value.
        defaultTo={invoice.email}
        lookupName={invoice.customerName}
        canEdit={invoice.status !== 'void'}
      />
      <OrderHistory side="so" orderId={invoice.id} stageLabel={invoiceStageLabel} />
    </div>
  )
}

/**
 * How this board names a stage, for the history log.
 *
 * Its own translation rather than one shared with purchase orders: 'sent' means
 * something here and nothing there, and an id with no entry prints itself so a
 * stage renamed after an event was written still reads.
 */
function invoiceStageLabel(id: string): string {
  return INVOICE_STAGES.find((s) => s.id === id)?.label ?? (id === 'void' ? 'Void' : id)
}

function TimeRow({
  icon,
  label,
  value,
  mono
}: {
  icon: string
  label: string
  value: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className="po-rt-row">
      <Icon name={icon} size={14} />
      <span className="po-rt-label">{label}</span>
      <span className={`po-rt-date${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}

function ReceiptLine({
  line,
  thumbnails
}: {
  line: InvoiceLine
  thumbnails: Record<string, string>
}): JSX.Element {
  const thumb = line.productId ? thumbnails[line.productId] : undefined

  return (
    <div className="po-receipt-line">
      <span className="po-rl-img po-line-img">
        {/* A line typed freehand has no product and so no picture. The category
            glyph is the same fallback the PO receipt uses, and an empty
            category resolves to its generic boxes mark — a filled cell keeps
            the five columns aligned where a missing one would not. */}
        {thumb ? <img src={thumb} alt={line.item} /> : <CategoryLogo category="" size={34} />}
      </span>
      <span className="po-rl-name">
        <span className="po-rl-pname">{line.item}</span>
        {line.sku && <span className="po-rl-sku mono">{line.sku}</span>}
        {line.description && <span className="po-line-sub">{line.description}</span>}
      </span>
      <span className="po-rl-qty">{line.quantity}</span>
      <span className="po-rl-price mono">{formatMoney(line.rate)}</span>
      <span className="po-rl-total mono">{formatMoney(line.amount)}</span>
    </div>
  )
}
