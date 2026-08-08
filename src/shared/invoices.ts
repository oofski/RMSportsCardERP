/**
 * Invoices — the SELL side, and the mirror image of a purchase order.
 *
 * A PO is money this business has committed to a supplier. An invoice is money
 * somebody owes this business: a buyer, the things they bought, the price
 * agreed, and a total. Same shape, opposite direction, which is exactly why
 * they belong beside each other and not in the same list.
 *
 * ## The QuickBooks template is the specification
 *
 * The owner supplied Intuit's own "import invoices" CSV, and its columns are
 * the fields modelled here — not because a CSV should drive a schema, but
 * because those columns ARE the invoice as QuickBooks understands one, and this
 * app's job is to produce something QuickBooks will accept. Inventing a
 * different set and mapping it later is how an export ends up with a column
 * nobody can fill in.
 *
 *   Invoice Number, *Customer, Email, Terms, *Invoice Date, Due Date, Location,
 *   Memo, Message on Invoice, Send Later, *Product/Service, Description,
 *   Quantity, Rate, *Amount, Tax Rate, Class
 *
 * The starred ones are required by Intuit. A multi-line invoice repeats the
 * Invoice Number and leaves the header columns blank on every row after the
 * first — see `invoicesToCsv`, which is the one place that shape is built.
 *
 * ## Two ways out, and the second one is the safety net
 *
 * CREATE IN QUICKBOOKS is the everyday path: the invoice is posted over the
 * API and the browser opens on it so somebody can press Send. That needs a live
 * connection, a consented company, and every item to exist in QuickBooks.
 *
 * EXPORT THE CSV always works. No connection, no OAuth, no item lookup — the
 * file drops onto disk in Intuit's own template and can be imported by hand.
 * It exists because the API path has four ways to fail that are outside this
 * app's control, and an invoice somebody cannot get out of the building is
 * worse than one they have to import themselves.
 */

/** Payment terms, as QuickBooks names them. */
import type { Carrier, PaymentTiming } from './freight'

export type InvoiceTerms = 'Due on receipt' | 'Net 15' | 'Net 30' | 'Net 60'

export const INVOICE_TERMS: InvoiceTerms[] = ['Due on receipt', 'Net 15', 'Net 30', 'Net 60']

/** How many days after the invoice date each term falls due. */
export const TERM_DAYS: Record<InvoiceTerms, number> = {
  'Due on receipt': 0,
  'Net 15': 15,
  'Net 30': 30,
  'Net 60': 60
}

/**
 * Somebody who buys from this business.
 *
 * Kept as its own record rather than typed onto each invoice, because the whole
 * point of the ask was "click the buyer and it auto-populates". Terms, email,
 * location and class are properties of the RELATIONSHIP, not of one sale, and
 * re-typing them is how one invoice ends up on Net 30 and the next on Net 15 by
 * accident.
 */
export interface InvoiceCustomer {
  id: string
  name: string
  email: string | null
  terms: InvoiceTerms
  /** QuickBooks Location, when the company has them switched on. */
  location: string | null
  /** QuickBooks Class, e.g. "Class A:Subclass B". */
  className: string | null
  /** The default "Message on Invoice" for this buyer. */
  message: string | null
  /** Internal note. Never exported — this is for the floor, not the buyer. */
  notes: string | null
  /** QuickBooks Customer id, once matched. Null until it is. */
  qboId: string | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface InvoiceLine {
  id: string
  invoiceId: string
  /** Order on the document. Rebuilt on every save, so it can never have gaps. */
  position: number
  /** QuickBooks "Product/Service". Required by Intuit. */
  item: string
  description: string | null
  quantity: number
  rate: number
  /**
   * quantity × rate, STORED rather than derived on read.
   *
   * The agreed price is the fact, and it is allowed to disagree with the
   * arithmetic: a buyer talked down to a round number is a real thing that
   * happens on this floor, and an invoice that silently recomputed it would
   * quietly overcharge them. `lineAmount` is what the editor suggests; this is
   * what was agreed.
   */
  amount: number
  /** Passed through to the export verbatim; this app does no tax arithmetic. */
  taxRate: string | null
  className: string | null
}

/**
 * Where an invoice is.
 *
 * PAID is operator-recorded, not read from a bank feed. The first cut stopped
 * at `sent` on the argument that QuickBooks knows when money arrived and this
 * does not — right about the plumbing, wrong about the job. The question being
 * asked is "which ones are paid", and a board that cannot answer it sends
 * somebody to a second system to find out. So it is a tick, with a date, and
 * the screen says it is a note rather than a bank feed.
 */
export type InvoiceStatus = 'draft' | 'created' | 'sent' | 'paid' | 'void'

/** The board's columns, left to right — the order the work moves in. */
export const INVOICE_STAGES: Array<{ id: InvoiceStatus; label: string; hint: string }> = [
  { id: 'draft', label: 'Draft', hint: 'Being built — not sent to anybody yet' },
  { id: 'created', label: 'In QuickBooks', hint: 'Posted, waiting to be sent' },
  { id: 'sent', label: 'Sent', hint: 'With the buyer, waiting to be paid' },
  { id: 'paid', label: 'Paid', hint: 'Money in' }
]

/**
 * Which moves are legal.
 *
 * Forward-only along the pipeline, plus void from anywhere that is not already
 * paid. Going backwards is deliberately not offered: an invoice that has been
 * posted to QuickBooks cannot be un-posted from here, and one marked paid in
 * error is fixed by saying so in QuickBooks, not by dragging a card.
 *
 * `draft → paid` IS allowed, and it is the case that matters most on this
 * floor: plenty of invoices are settled by cash or Zelle without ever going
 * near QuickBooks, and a board that made somebody post an invoice they have
 * already been paid for would just be lied to.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['created', 'sent', 'paid', 'void'],
  created: ['sent', 'paid', 'void'],
  sent: ['paid', 'void'],
  paid: [],
  void: []
}

export function canMoveInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[from] ?? []).includes(to)
}

export interface Invoice {
  id: string
  /** Human number, e.g. "1001". Unique within the company. */
  invoiceNumber: string
  /** Null when the buyer record has since been deleted. */
  customerId: string | null
  /**
   * The buyer's name AS IT WAS when the invoice was made.
   *
   * Snapshotted deliberately. A customer renamed next year must not silently
   * rewrite a document somebody has already been sent — an invoice is a record
   * of what was said, not a view of who they are now.
   */
  customerName: string
  email: string | null
  terms: InvoiceTerms
  /** YYYY-MM-DD, local calendar day. */
  invoiceDate: string
  dueDate: string
  location: string | null
  /** Internal. Intuit calls this Memo and does not show it to the buyer. */
  memo: string | null
  /** Shown ON the invoice. */
  message: string | null
  sendLater: boolean
  className: string | null
  status: InvoiceStatus
  /** The QuickBooks Invoice id, once posted. */
  qboId: string | null
  /** What QuickBooks called it — may differ from ours if custom numbers are off. */
  qboDocNumber: string | null
  qboSyncedAt: string | null
  /** Σ of the line amounts, stored so a list does not have to read every line. */
  total: number
  /** When somebody recorded the money as arrived. Null until they do. */
  paidAt: string | null
  paidBy: string | null
  /** How it ships, and when it settles. See @shared/freight. */
  carrier: Carrier | null
  service: string | null
  trackingNumber: string | null
  paymentTiming: PaymentTiming | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[]
}

export interface NewInvoiceLine {
  item: string
  description?: string | null
  quantity: number
  rate: number
  /** Omit to take quantity × rate. */
  amount?: number | null
  taxRate?: string | null
  className?: string | null
}

export interface NewInvoice {
  invoiceNumber?: string | null
  customerId?: string | null
  customerName: string
  email?: string | null
  terms?: InvoiceTerms
  invoiceDate: string
  dueDate?: string | null
  location?: string | null
  memo?: string | null
  message?: string | null
  sendLater?: boolean
  className?: string | null
  carrier?: Carrier | null
  service?: string | null
  trackingNumber?: string | null
  paymentTiming?: PaymentTiming | null
  lines: NewInvoiceLine[]
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Round to cents.
 *
 * Applied at every boundary rather than trusted to come out right: 0.1 + 0.2 is
 * 0.30000000000000004 in binary floating point, and an invoice total that reads
 * $170.00000000000003 is one somebody stops trusting even though it is only
 * wrong by a rounding error nobody can see.
 */
export function money(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/** What a line comes to, before anybody overrides it. */
export function lineAmount(quantity: number, rate: number): number {
  return money((Number(quantity) || 0) * (Number(rate) || 0))
}

/** The invoice total: the sum of what was AGREED, not of quantity × rate. */
export function invoiceTotal(lines: Array<{ amount: number }>): number {
  return money(lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0))
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Shift a YYYY-MM-DD by whole days, parsed at UTC noon.
 *
 * Noon rather than midnight for the same reason as everywhere else in this
 * codebase: a date-only string parsed as local midnight and shifted across a
 * daylight-saving boundary can land on 23:00 the day before and round down a
 * day — which on an invoice is a due date that is wrong by one, twice a year.
 */
export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10)
}

/** When an invoice dated `invoiceDate` on these terms falls due. */
export function dueDateFor(invoiceDate: string, terms: InvoiceTerms): string {
  return addDays(invoiceDate, TERM_DAYS[terms] ?? 0)
}

/** MM/DD/YYYY — the only date format Intuit's importer accepts. */
export function toUsDate(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return ''
  const [y, m, d] = day.split('-')
  return `${m}/${d}/${y}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const INVOICE_NUMBER_MAX = 21
export const INVOICE_TEXT_MAX = 1000

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export function validateInvoice(input: NewInvoice): string | null {
  if (!(input.customerName ?? '').trim()) return 'Say who the invoice is for.'
  if (!DAY_RE.test(input.invoiceDate ?? '')) return 'Pick an invoice date.'
  if (input.dueDate && !DAY_RE.test(input.dueDate)) return 'The due date has to be a date.'
  // A due date BEFORE the invoice date is the one combination that is certainly
  // a mistake rather than an unusual arrangement — QuickBooks accepts it and
  // then reports the invoice as overdue on the day it is written.
  if (input.dueDate && input.dueDate < input.invoiceDate) {
    return 'The due date cannot be before the invoice date.'
  }
  if ((input.invoiceNumber ?? '').length > INVOICE_NUMBER_MAX) {
    return `Invoice numbers cannot be longer than ${INVOICE_NUMBER_MAX} characters.`
  }
  const lines = input.lines ?? []
  if (lines.length === 0) return 'Add at least one thing they are buying.'
  for (const [i, l] of lines.entries()) {
    if (!(l.item ?? '').trim()) return `Line ${i + 1} needs a product or service.`
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
      return `Line ${i + 1} needs a quantity above zero.`
    }
    if (!Number.isFinite(l.rate) || l.rate < 0) return `Line ${i + 1} needs a rate.`
    const amount = l.amount ?? lineAmount(l.quantity, l.rate)
    if (!Number.isFinite(amount) || amount < 0) return `Line ${i + 1} needs an amount.`
  }
  return null
}

export function validateCustomer(input: {
  name: string
  email?: string | null
}): string | null {
  const name = (input.name ?? '').trim()
  if (!name) return 'Give the buyer a name.'
  if (name.length > 200) return 'That name is too long.'
  const email = (input.email ?? '').trim()
  // Deliberately loose. A stricter pattern rejects real addresses, and the only
  // consequence of a bad one here is that QuickBooks refuses to send — which it
  // will say clearly, at the moment it matters.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'That does not look like an email address.'
  }
  return null
}

// ---------------------------------------------------------------------------
// The QuickBooks import template
// ---------------------------------------------------------------------------

export const INVOICE_CSV_HEADERS = [
  'Invoice Number',
  'Customer',
  'Email',
  'Terms',
  'Invoice Date',
  'Due Date',
  'Location',
  'Memo',
  'Message on Invoice',
  'Send Later',
  'Product/Service',
  'Description',
  'Quantity',
  'Rate',
  'Amount',
  'Tax Rate',
  'Class'
]

/** RFC 4180: quote anything containing a comma, quote or newline. */
function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (s === '') return ''
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Intuit's invoice-import CSV, exactly as their template lays it out.
 *
 * THE HEADER COLUMNS APPEAR ONCE PER INVOICE, on its first line only; every
 * further line repeats the Invoice Number and leaves them blank. That is not a
 * stylistic choice — it is how their importer decides where one invoice ends
 * and the next begins, and filling the customer in on every row produces one
 * invoice per line on import.
 *
 * The instructional footer rows from the sample are NOT reproduced. Intuit's own
 * template says to delete them, and a file that has to be edited before it can
 * be used is a file somebody will forget to edit.
 */
export function invoicesToCsv(invoices: InvoiceDetail[]): string {
  const rows: string[] = [INVOICE_CSV_HEADERS.map(csvCell).join(',')]

  for (const inv of invoices) {
    const lines = inv.lines.length > 0 ? inv.lines : []
    for (const [i, line] of lines.entries()) {
      const head = i === 0
      rows.push(
        [
          // The number repeats on every row — it is the key that groups them.
          csvCell(inv.invoiceNumber),
          csvCell(head ? inv.customerName : ''),
          csvCell(head ? (inv.email ?? '') : ''),
          csvCell(head ? inv.terms : ''),
          csvCell(head ? toUsDate(inv.invoiceDate) : ''),
          csvCell(head ? toUsDate(inv.dueDate) : ''),
          csvCell(head ? (inv.location ?? '') : ''),
          csvCell(head ? (inv.memo ?? '') : ''),
          csvCell(head ? (inv.message ?? '') : ''),
          // Blank rather than FALSE when it is off, matching the sample: their
          // importer reads an empty cell as "no" and a stray FALSE on every
          // line of a three-line invoice is noise.
          csvCell(head && inv.sendLater ? 'TRUE' : ''),
          csvCell(line.item),
          csvCell(line.description ?? ''),
          csvCell(line.quantity),
          csvCell(line.rate),
          csvCell(line.amount.toFixed(2)),
          csvCell(line.taxRate ?? ''),
          csvCell(line.className ?? inv.className ?? '')
        ].join(',')
      )
    }
  }

  return rows.join('\n') + '\n'
}

/**
 * The shape this app posts to the QuickBooks Accounting API.
 *
 * Built here rather than in main so it can be unit-tested without a network or
 * an OAuth token — the mapping from our record to theirs is the part that is
 * easy to get quietly wrong, and the part a live call is worst at checking.
 */
export interface QboInvoicePayload {
  DocNumber?: string
  TxnDate: string
  DueDate: string
  CustomerRef: { value: string; name?: string }
  BillEmail?: { Address: string }
  CustomerMemo?: { value: string }
  PrivateNote?: string
  Line: Array<{
    DetailType: 'SalesItemLineDetail'
    Amount: number
    Description?: string
    SalesItemLineDetail: {
      ItemRef: { value: string; name?: string }
      Qty: number
      UnitPrice: number
    }
  }>
}

/**
 * Map one invoice onto Intuit's Invoice resource.
 *
 * `customerRef` and the per-line `itemRefs` are QuickBooks ids that this app
 * does not mint — they are looked up from the connected company before this is
 * called. A line whose item has no id is a line QuickBooks would reject, so the
 * caller resolves them first and this refuses rather than posting a document
 * that will half-fail.
 */
export function toQboInvoice(
  invoice: InvoiceDetail,
  customerRef: { id: string; name?: string },
  itemRefs: Map<string, { id: string; name?: string }>
): QboInvoicePayload {
  const missing = invoice.lines.filter((l) => !itemRefs.has(l.item.trim().toLowerCase()))
  if (missing.length > 0) {
    throw new Error(
      `QuickBooks has no product or service called ${missing
        .map((l) => `“${l.item}”`)
        .join(', ')}. Add it in QuickBooks first, or export the CSV instead.`
    )
  }

  return {
    // Only sent when we have one. QuickBooks replaces it silently unless the
    // company has "Custom transaction numbers" switched on — which is exactly
    // what Intuit's own template warns about — so `qboDocNumber` records what
    // came back rather than assuming ours survived.
    ...(invoice.invoiceNumber ? { DocNumber: invoice.invoiceNumber } : {}),
    TxnDate: invoice.invoiceDate,
    DueDate: invoice.dueDate,
    CustomerRef: { value: customerRef.id, ...(customerRef.name ? { name: customerRef.name } : {}) },
    ...(invoice.email ? { BillEmail: { Address: invoice.email } } : {}),
    // CustomerMemo is the message the BUYER sees; PrivateNote is the internal
    // memo. Intuit's names for them are the wrong way round from how they read,
    // and putting an internal note in front of a customer is the sort of mistake
    // that only gets noticed after it is sent.
    ...(invoice.message ? { CustomerMemo: { value: invoice.message } } : {}),
    ...(invoice.memo ? { PrivateNote: invoice.memo } : {}),
    Line: invoice.lines.map((l) => {
      const ref = itemRefs.get(l.item.trim().toLowerCase())
      return {
        DetailType: 'SalesItemLineDetail' as const,
        Amount: money(l.amount),
        ...(l.description ? { Description: l.description } : {}),
        SalesItemLineDetail: {
          ItemRef: { value: ref?.id ?? '', ...(ref?.name ? { name: ref.name } : {}) },
          Qty: l.quantity,
          UnitPrice: l.rate
        }
      }
    })
  }
}

/**
 * Where to send somebody's browser so they can look at, and send, the invoice.
 *
 * Two hosts, and picking the wrong one lands on a login page for a company they
 * are not in. Sandbox invoices only exist in the sandbox UI.
 */
export function qboInvoiceUrl(environment: 'sandbox' | 'production', qboId: string): string {
  const host =
    environment === 'sandbox' ? 'https://sandbox.qbo.intuit.com' : 'https://qbo.intuit.com'
  return `${host}/app/invoice?txnId=${encodeURIComponent(qboId)}`
}

/**
 * The next invoice number, given what has been used.
 *
 * Numeric strings advance; anything else falls back to a fresh series rather
 * than guessing. "INV-0042" incremented naively becomes "INV-0043" only if you
 * decide which digits are the counter, and deciding wrong on somebody's real
 * numbering is worse than starting a new one they can overwrite.
 */
export function nextInvoiceNumber(existing: string[], start = 1001): string {
  const numeric = existing
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0)
  if (numeric.length === 0) return String(start)
  return String(Math.max(...numeric) + 1)
}
