import { randomUUID } from 'crypto'
import {
  dueDateFor,
  invoiceTotal,
  lineAmount,
  money,
  nextInvoiceNumber,
  validateCustomer,
  validateInvoice,
  type Invoice,
  type InvoiceCustomer,
  type InvoiceDetail,
  type InvoiceLine,
  type InvoiceStatus,
  type InvoiceTerms,
  type NewInvoice
} from '@shared/invoices'
import { asCarrier, asPaymentTiming, detectCarrier } from '@shared/freight'
import { asShipStatus } from '@shared/tracking'
import { getDb } from './database'

/**
 * Invoices and the people who buy from us.
 *
 * The sell side, and deliberately its own file rather than a section of
 * purchaseOrders.ts. They are mirror images at the level of shape — a party,
 * some lines, a total — and share nothing at the level of behaviour: a PO
 * receives stock and opens cost lots, an invoice does neither and instead has
 * to survive a round trip to somebody else's accounting system.
 */

function nowIso(): string {
  return new Date().toISOString()
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

function asTerms(v: unknown): InvoiceTerms {
  return v === 'Due on receipt' || v === 'Net 15' || v === 'Net 60' ? v : 'Net 30'
}

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

interface CustomerRow {
  id: string
  name: string
  email: string | null
  terms: string
  location: string | null
  class_name: string | null
  message: string | null
  notes: string | null
  qbo_id: string | null
  active: number
  created_at: string
  updated_at: string
}

function toCustomer(r: CustomerRow): InvoiceCustomer {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    terms: asTerms(r.terms),
    location: r.location,
    className: r.class_name,
    message: r.message,
    notes: r.notes,
    qboId: r.qbo_id,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const CUSTOMER_COLS = `id, name, email, terms, location, class_name, message, notes, qbo_id,
                       active, created_at, updated_at`

export function listCustomers(includeInactive = false): InvoiceCustomer[] {
  const rows = getDb()
    .prepare(
      `SELECT ${CUSTOMER_COLS} FROM invoice_customers
        ${includeInactive ? '' : 'WHERE active = 1'}
        ORDER BY name COLLATE NOCASE ASC`
    )
    .all() as CustomerRow[]
  return rows.map(toCustomer)
}

export function getCustomer(id: string): InvoiceCustomer | null {
  const row = getDb()
    .prepare(`SELECT ${CUSTOMER_COLS} FROM invoice_customers WHERE id = ?`)
    .get(id) as CustomerRow | undefined
  return row ? toCustomer(row) : null
}

export interface CustomerInput {
  id?: string | null
  name: string
  email?: string | null
  terms?: InvoiceTerms
  location?: string | null
  className?: string | null
  message?: string | null
  notes?: string | null
  qboId?: string | null
}

/**
 * Add or update a buyer.
 *
 * One operation rather than create/update, because the screen has one gesture:
 * you are either filling in a new buyer or correcting one, and a separate
 * "update" endpoint would only differ by which id it refuses.
 */
export function saveCustomer(input: CustomerInput): InvoiceCustomer {
  const problem = validateCustomer(input)
  if (problem) throw new Error(problem)

  const db = getDb()
  const stamp = nowIso()
  const id = clean(input.id) ?? randomUUID()
  const existing = db
    .prepare(`SELECT created_at FROM invoice_customers WHERE id = ?`)
    .get(id) as { created_at: string } | undefined

  // A buyer typed twice under the same name is one buyer. Matching on the name
  // rather than refusing keeps the common case — somebody adding "Chris Smith"
  // from the invoice screen without checking the list first — from producing a
  // second record that then diverges.
  //
  // THE MATCHED RECORD KEEPS ITS OWN NAME. The match is case-insensitive, so
  // typing "chris smith" finds "Chris Smith" — and taking the typed casing
  // would restyle a buyer's name as a side effect of writing an invoice, which
  // nobody asked for and which then appears on every future document. Renaming
  // is what editing them BY ID is for.
  if (!existing) {
    const byName = db
      .prepare(`SELECT id, name FROM invoice_customers WHERE name = ? COLLATE NOCASE`)
      .get(input.name.trim()) as { id: string; name: string } | undefined
    if (byName && byName.id !== id) {
      return saveCustomer({ ...input, id: byName.id, name: byName.name })
    }
  }

  db.prepare(
    `INSERT INTO invoice_customers
       (id, name, email, terms, location, class_name, message, notes, qbo_id, active,
        created_at, updated_at)
     VALUES (@id, @name, @email, @terms, @location, @className, @message, @notes, @qboId, 1,
             @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       email      = excluded.email,
       terms      = excluded.terms,
       location   = excluded.location,
       class_name = excluded.class_name,
       message    = excluded.message,
       notes      = excluded.notes,
       -- Only ever SET, never cleared by an ordinary edit. The QuickBooks id is
       -- learned from a successful post; a later rename typed on this screen
       -- must not throw it away and force the match to be made again.
       qbo_id     = COALESCE(excluded.qbo_id, invoice_customers.qbo_id),
       updated_at = excluded.updated_at`
  ).run({
    id,
    name: input.name.trim(),
    email: clean(input.email),
    terms: asTerms(input.terms),
    location: clean(input.location),
    className: clean(input.className),
    message: clean(input.message),
    notes: clean(input.notes),
    qboId: clean(input.qboId),
    createdAt: existing?.created_at ?? stamp,
    updatedAt: stamp
  })

  const saved = getCustomer(id)
  if (!saved) throw new Error('That buyer could not be saved.')
  return saved
}

/**
 * Retire a buyer.
 *
 * DEACTIVATED, not deleted, whenever they have any history. An invoice keeps
 * the name it was raised under, so deleting the record would not corrupt a
 * document — but it would break "show me everything this buyer has bought",
 * which is the one question a customer list exists to answer.
 */
export function removeCustomer(id: string): { deleted: boolean } {
  const db = getDb()
  const used = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?`).get(id) as {
    n: number
  }
  if (used.n > 0) {
    db.prepare(`UPDATE invoice_customers SET active = 0, updated_at = ? WHERE id = ?`).run(
      nowIso(),
      id
    )
    return { deleted: false }
  }
  db.prepare(`DELETE FROM invoice_customers WHERE id = ?`).run(id)
  return { deleted: true }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

interface InvoiceRow {
  id: string
  invoice_number: string | null
  customer_id: string | null
  customer_name: string
  email: string | null
  terms: string
  invoice_date: string
  due_date: string
  location: string | null
  memo: string | null
  message: string | null
  send_later: number
  class_name: string | null
  status: string
  qbo_id: string | null
  qbo_doc_number: string | null
  qbo_synced_at: string | null
  total: number
  paid_at: string | null
  paid_by: string | null
  carrier: string | null
  service: string | null
  tracking_number: string | null
  payment_timing: string | null
  tracking_status: string | null
  tracking_status_detail: string | null
  tracking_status_at: string | null
  tracking_checked_at: string | null
  tracking_error: string | null
  tracking_attempted_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface LineRow {
  id: string
  invoice_id: string
  position: number
  item: string
  description: string | null
  quantity: number
  rate: number
  amount: number
  tax_rate: string | null
  class_name: string | null
}

function asStatus(v: string): InvoiceStatus {
  return v === 'created' || v === 'sent' || v === 'paid' || v === 'void' ? v : 'draft'
}

function toInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id,
    invoiceNumber: r.invoice_number ?? '',
    customerId: r.customer_id,
    customerName: r.customer_name,
    email: r.email,
    terms: asTerms(r.terms),
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    location: r.location,
    memo: r.memo,
    message: r.message,
    sendLater: r.send_later === 1,
    className: r.class_name,
    status: asStatus(r.status),
    qboId: r.qbo_id,
    qboDocNumber: r.qbo_doc_number,
    qboSyncedAt: r.qbo_synced_at,
    total: r.total,
    paidAt: r.paid_at,
    paidBy: r.paid_by,
    carrier: asCarrier(r.carrier),
    service: r.service,
    trackingNumber: r.tracking_number,
    paymentTiming: asPaymentTiming(r.payment_timing),
    trackingStatus: asShipStatus(r.tracking_status),
    trackingStatusDetail: r.tracking_status_detail ?? null,
    trackingStatusAt: r.tracking_status_at ?? null,
    trackingCheckedAt: r.tracking_checked_at ?? null,
    trackingError: r.tracking_error ?? null,
    trackingAttemptedAt: r.tracking_attempted_at ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function toLine(r: LineRow): InvoiceLine {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    position: r.position,
    item: r.item,
    description: r.description,
    quantity: r.quantity,
    rate: r.rate,
    amount: r.amount,
    taxRate: r.tax_rate,
    className: r.class_name
  }
}

const INVOICE_COLS = `id, invoice_number, customer_id, customer_name, email, terms, invoice_date,
                      due_date, location, memo, message, send_later, class_name, status,
                      qbo_id, qbo_doc_number, qbo_synced_at, total, paid_at, paid_by,
                      carrier, service, tracking_number, payment_timing,
                      tracking_status, tracking_status_detail, tracking_status_at,
                      tracking_checked_at, tracking_error, tracking_attempted_at,
                      created_by, created_at, updated_at`

/** Newest first — an invoice list is read from the top. */
export function listInvoices(limit = 200): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          ORDER BY invoice_date DESC, created_at DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(1000, limit))) as InvoiceRow[]
  ).map(toInvoice)
}

export function getInvoice(id: string): InvoiceDetail | null {
  const db = getDb()
  const row = db.prepare(`SELECT ${INVOICE_COLS} FROM invoices WHERE id = ?`).get(id) as
    | InvoiceRow
    | undefined
  if (!row) return null
  const lines = db
    .prepare(
      `SELECT id, invoice_id, position, item, description, quantity, rate, amount,
              tax_rate, class_name
         FROM invoice_lines WHERE invoice_id = ? ORDER BY position ASC`
    )
    .all(id) as LineRow[]
  return { ...toInvoice(row), lines: lines.map(toLine) }
}

/** Several invoices with their lines, for the CSV export. */
export function getInvoices(ids: string[]): InvoiceDetail[] {
  return ids.map((id) => getInvoice(id)).filter((i): i is InvoiceDetail => i !== null)
}

/** The next number in the series, so the editor opens with one filled in. */
export function suggestInvoiceNumber(): string {
  const rows = getDb()
    .prepare(`SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL`)
    .all() as Array<{ invoice_number: string }>
  return nextInvoiceNumber(rows.map((r) => r.invoice_number))
}

/**
 * Write an invoice and its lines, in one transaction.
 *
 * The lines are REPLACED wholesale rather than diffed. An invoice is edited as
 * a document — you change a price, delete a line, add another — and matching
 * rows up to work out which of those happened would be a lot of machinery whose
 * only job is to preserve line ids nobody refers to. Replacing means the
 * position column can never have gaps, either.
 */
export function saveInvoice(
  input: NewInvoice & { id?: string | null },
  actorId: string | null
): InvoiceDetail {
  const problem = validateInvoice(input)
  if (problem) throw new Error(problem)

  const db = getDb()
  const stamp = nowIso()
  const id = clean(input.id) ?? randomUUID()
  const existing = db.prepare(`SELECT created_at, status FROM invoices WHERE id = ?`).get(id) as
    | { created_at: string; status: string }
    | undefined

  // An invoice already in QuickBooks is not editable from here. Changing our
  // copy would make the two disagree with nothing on either screen to say which
  // is right, and this app is not the system of record once it has posted.
  if (existing && asStatus(existing.status) !== 'draft') {
    throw new Error('That invoice has already gone to QuickBooks and can no longer be edited.')
  }

  const terms = asTerms(input.terms)
  const invoiceDate = input.invoiceDate
  const dueDate = clean(input.dueDate) ?? dueDateFor(invoiceDate, terms)

  const lines = input.lines.map((l, i) => ({
    id: randomUUID(),
    invoiceId: id,
    position: i,
    item: l.item.trim(),
    description: clean(l.description),
    quantity: Number(l.quantity) || 0,
    rate: money(Number(l.rate) || 0),
    // The agreed amount wins when one was given; quantity × rate is only the
    // suggestion. See the note on InvoiceLine.amount.
    amount: money(l.amount ?? lineAmount(l.quantity, l.rate)),
    taxRate: clean(l.taxRate),
    className: clean(l.className)
  }))

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO invoices
         (id, invoice_number, customer_id, customer_name, email, terms, invoice_date, due_date,
          location, memo, message, send_later, class_name, status, qbo_id, qbo_doc_number,
          qbo_synced_at, total, carrier, service, tracking_number, payment_timing,
          created_by, created_at, updated_at)
       VALUES (@id, @invoiceNumber, @customerId, @customerName, @email, @terms, @invoiceDate,
               @dueDate, @location, @memo, @message, @sendLater, @className, 'draft',
               NULL, NULL, NULL, @total, @carrier, @service, @trackingNumber, @paymentTiming,
               @createdBy, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         invoice_number = excluded.invoice_number,
         customer_id    = excluded.customer_id,
         customer_name  = excluded.customer_name,
         email          = excluded.email,
         terms          = excluded.terms,
         invoice_date   = excluded.invoice_date,
         due_date       = excluded.due_date,
         location       = excluded.location,
         memo           = excluded.memo,
         message        = excluded.message,
         send_later     = excluded.send_later,
         class_name     = excluded.class_name,
         total          = excluded.total,
         carrier        = excluded.carrier,
         service        = excluded.service,
         tracking_number= excluded.tracking_number,
         payment_timing = excluded.payment_timing,
         updated_at     = excluded.updated_at`
    ).run({
      id,
      invoiceNumber: clean(input.invoiceNumber),
      customerId: clean(input.customerId),
      customerName: input.customerName.trim(),
      email: clean(input.email),
      terms,
      invoiceDate,
      dueDate,
      location: clean(input.location),
      memo: clean(input.memo),
      message: clean(input.message),
      sendLater: input.sendLater ? 1 : 0,
      className: clean(input.className),
      // An explicit carrier wins; otherwise the number names itself. Same rule
      // as createPurchaseOrder, so a tracking number pasted on either side of
      // the money behaves identically.
      carrier: asCarrier(input.carrier) ?? detectCarrier(input.trackingNumber ?? ''),
      service: clean(input.service),
      trackingNumber: clean(input.trackingNumber),
      paymentTiming: asPaymentTiming(input.paymentTiming),
      total: invoiceTotal(lines),
      // Null on an edit. The ON CONFLICT branch does not touch created_by, so
      // whatever is bound here is discarded on that path — but bind the value
      // that MEANS "no author", rather than relying on the driver's handling of
      // undefined, so the intent survives if that clause ever gains a column.
      createdBy: existing ? null : actorId,
      createdAt: existing?.created_at ?? stamp,
      updatedAt: stamp
    })

    db.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?`).run(id)
    const insert = db.prepare(
      `INSERT INTO invoice_lines
         (id, invoice_id, position, item, description, quantity, rate, amount, tax_rate,
          class_name, created_at, updated_at)
       VALUES (@id, @invoiceId, @position, @item, @description, @quantity, @rate, @amount,
               @taxRate, @className, @stamp, @stamp)`
    )
    for (const l of lines) insert.run({ ...l, stamp })
  })
  run()

  const saved = getInvoice(id)
  if (!saved) throw new Error('That invoice could not be saved.')
  return saved
}

/** Record what QuickBooks said after a successful post. */
export function markPosted(
  id: string,
  qbo: { id: string; docNumber: string | null },
  status: InvoiceStatus = 'created'
): void {
  getDb()
    .prepare(
      `UPDATE invoices
          SET qbo_id = ?, qbo_doc_number = ?, qbo_synced_at = ?, status = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(qbo.id, qbo.docNumber, nowIso(), status, nowIso(), id)
}

/**
 * Move an invoice along the board.
 *
 * Marking it paid STAMPS THE DATE, and moving it off paid clears it — so the
 * date can never outlive the claim it belongs to. A stale "paid 3 March" on an
 * invoice that is no longer marked paid is the kind of thing somebody reads off
 * a screen and repeats to a buyer.
 */
export function setInvoiceStatus(
  id: string,
  status: InvoiceStatus,
  actorId: string | null = null
): boolean {
  const stamp = nowIso()
  return (
    getDb()
      .prepare(
        `UPDATE invoices
            SET status  = ?,
                paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE NULL END,
                paid_by = CASE WHEN ? = 'paid' THEN COALESCE(paid_by, ?) ELSE NULL END,
                updated_at = ?
          WHERE id = ?`
      )
      .run(status, status, stamp, status, actorId, stamp, id).changes > 0
  )
}

/**
 * Delete an invoice.
 *
 * Refused once it is in QuickBooks. Removing our copy would not remove theirs,
 * and an invoice that exists in the accounts and nowhere else is worse than one
 * that is merely voided — so voiding is what is offered instead.
 */
export function deleteInvoice(id: string): void {
  const db = getDb()
  const row = db.prepare(`SELECT qbo_id FROM invoices WHERE id = ?`).get(id) as
    | { qbo_id: string | null }
    | undefined
  if (!row) throw new Error('That invoice is already gone.')
  if (row.qbo_id) {
    throw new Error(
      'That invoice is in QuickBooks. Void it there, then mark it void here — deleting it ' +
        'would leave it in the accounts with no record on this side.'
    )
  }
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?`).run(id)
    db.prepare(`DELETE FROM invoices WHERE id = ?`).run(id)
  })
  run()
}

/** Headline numbers for the tab. */
export function invoiceStats(): {
  draft: number
  created: number
  sent: number
  paid: number
  outstanding: number
  paidTotal: number
  thisMonth: number
} {
  const db = getDb()
  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n, SUM(total) AS value FROM invoices GROUP BY status`)
    .all() as Array<{ status: string; n: number; value: number | null }>

  const count = (s: string): number => byStatus.find((r) => r.status === s)?.n ?? 0
  // OUTSTANDING is what has been billed and not yet ticked as paid — voided
  // invoices are money nobody is waiting on, and paid ones have arrived. Both
  // figures rest on somebody having ticked the box, which is why the screen
  // labels this a record rather than a bank balance.
  const outstanding = byStatus
    .filter((r) => r.status !== 'void' && r.status !== 'paid')
    .reduce((sum, r) => sum + (r.value ?? 0), 0)
  const paidTotal = byStatus
    .filter((r) => r.status === 'paid')
    .reduce((sum, r) => sum + (r.value ?? 0), 0)

  const month = new Date().toISOString().slice(0, 7)
  const thisMonth = (
    db
      .prepare(
        `SELECT COALESCE(SUM(total), 0) AS value FROM invoices
          WHERE status != 'void' AND substr(invoice_date, 1, 7) = ?`
      )
      .get(month) as { value: number }
  ).value

  return {
    draft: count('draft'),
    created: count('created'),
    sent: count('sent'),
    paid: count('paid'),
    outstanding: money(outstanding),
    paidTotal: money(paidTotal),
    thisMonth: money(thisMonth)
  }
}
