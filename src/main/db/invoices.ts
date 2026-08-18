import { randomUUID } from 'crypto'
import {
  DEFAULT_INVOICE_TERMS,
  INVOICE_TERMS,
  asPushState,
  dueDateFor,
  hasAddress,
  invoiceTotal,
  latestPaymentDate,
  lineAmount,
  money,
  nextInvoiceNumber,
  paymentsApplied,
  validateCustomer,
  validateInvoice,
  type Invoice,
  type InvoiceAddress,
  type InvoiceCustomer,
  type InvoiceDetail,
  type InvoiceLine,
  type InvoiceStatus,
  type InvoiceTerms,
  type NewInvoice,
  type QboInvoiceObservation
} from '@shared/invoices'
import type { ScanSoCandidate } from '@shared/types'
import type Database from 'better-sqlite3'
import { asCarrier, asPaymentTiming, detectCarrier } from '@shared/freight'
import { asShipStatus } from '@shared/tracking'
import { getDb } from './database'
import { applyInvoiceStock, invoiceStockLocation, releaseInvoiceStock } from './invoiceStock'
import { destinationHoldsStock } from '@shared/purchaseOrders'

/**
 * What to STORE in a line's destination column.
 *
 * Null when it is the same as the order's, which is the ordinary case and is
 * what makes the value inherit. Trimmed, and compared case-insensitively,
 * because "rm" typed into a box and "RM" chosen from a list are the same shelf
 * and storing one of them as an override would make the line stop following the
 * header for no reason anybody could see.
 */
function lineDestination(value: string | null | undefined, headerLocation: string): string | null {
  const v = String(value ?? '').trim()
  if (!v) return null
  return v.toLowerCase() === headerLocation.trim().toLowerCase() ? null : v
}

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

/**
 * Coerce a stored/incoming terms value to one this app offers.
 *
 * READS THE LIST RATHER THAN RESTATING IT. The previous version spelled three of
 * the terms out by hand, so when "Net 2" was added to INVOICE_TERMS this
 * function silently mapped it to Net 30 — on write AND on read, so the value
 * could never be stored or displayed and a buyer given two days got thirty. A
 * second copy of a list is a second thing to remember to update, and this is the
 * copy that was forgotten.
 */
function asTerms(v: unknown): InvoiceTerms {
  return INVOICE_TERMS.includes(v as InvoiceTerms) ? (v as InvoiceTerms) : DEFAULT_INVOICE_TERMS
}

/**
 * The six bill-to columns, in and out.
 *
 * One pair of helpers shared by the buyer and the invoice, because the two
 * tables hold the same six columns for the same reason and a second copy of this
 * mapping is a second place for a typo to put the zip in the state.
 */
interface AddressRow {
  bill_line1: string | null
  bill_line2: string | null
  bill_city: string | null
  bill_region: string | null
  bill_postal_code: string | null
  bill_country: string | null
}

/**
 * Null when nothing was filled in.
 *
 * An all-blank address must read as ABSENT rather than as an object of nulls:
 * the posting code decides whether to fall back to the address QuickBooks holds
 * by asking whether we have one, and an empty shell would answer yes and send
 * QuickBooks an address that erases theirs.
 */
function toAddress(r: AddressRow): InvoiceAddress | null {
  const a: InvoiceAddress = {
    line1: r.bill_line1,
    line2: r.bill_line2,
    city: r.bill_city,
    region: r.bill_region,
    postalCode: r.bill_postal_code,
    country: r.bill_country
  }
  return hasAddress(a) ? a : null
}

function addressParams(a: InvoiceAddress | null | undefined): {
  billLine1: string | null
  billLine2: string | null
  billCity: string | null
  billRegion: string | null
  billPostalCode: string | null
  billCountry: string | null
} {
  return {
    billLine1: clean(a?.line1),
    billLine2: clean(a?.line2),
    billCity: clean(a?.city),
    billRegion: clean(a?.region),
    billPostalCode: clean(a?.postalCode),
    billCountry: clean(a?.country)
  }
}

const ADDRESS_COLS = `bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country`

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

interface CustomerRow extends AddressRow {
  id: string
  name: string
  email: string | null
  phone: string | null
  mobile: string | null
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
    phone: r.phone,
    mobile: r.mobile,
    terms: asTerms(r.terms),
    location: r.location,
    className: r.class_name,
    message: r.message,
    notes: r.notes,
    billAddr: toAddress(r),
    qboId: r.qbo_id,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const CUSTOMER_COLS = `id, name, email, phone, mobile, terms, location, class_name, message, notes,
                       qbo_id, ${ADDRESS_COLS}, active, created_at, updated_at`

/**
 * The buyers.
 *
 * `is_customer = 1` and not merely "every row in the table", because since v62
 * this table also holds the vendor directory — the same table on purpose, so a
 * business that both buys and sells is ONE record (see the v62 note in
 * database.ts). Without this predicate importing 151 suppliers would add 151
 * names to the customer list, to the sales-order buyer picker and to the count
 * on the Admin tile, none of whom has ever bought anything.
 *
 * A contact who is both matches this and the vendor list, which is the point.
 */
export function listCustomers(includeInactive = false): InvoiceCustomer[] {
  const rows = getDb()
    .prepare(
      `SELECT ${CUSTOMER_COLS} FROM invoice_customers
        WHERE is_customer = 1 ${includeInactive ? '' : 'AND active = 1'}
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
  /**
   * Omit BOTH of these entirely to leave the stored numbers alone; pass either
   * one as null to clear them. Same contract as billAddr, for the same reason:
   * the invoice screen saves a buyer with a name and an email and nothing else,
   * and that must not wipe a number the contact import brought in.
   */
  phone?: string | null
  mobile?: string | null
  terms?: InvoiceTerms
  location?: string | null
  className?: string | null
  message?: string | null
  notes?: string | null
  billAddr?: InvoiceAddress | null
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
       (id, name, email, phone, mobile, terms, location, class_name, message, notes, qbo_id,
        bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country,
        active, is_customer, created_at, updated_at)
     VALUES (@id, @name, @email, @phone, @mobile, @terms, @location, @className, @message, @notes,
             @qboId,
             @billLine1, @billLine2, @billCity, @billRegion, @billPostalCode, @billCountry,
             1, 1, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       email      = excluded.email,
       -- Saving somebody from the buyer screen IS the assertion that they are a
       -- buyer, so it is made here. It matters for the by-name branch above: a
       -- business already on file as a vendor and now being sold to must join the
       -- customer list rather than get a second record under the same name.
       --
       -- is_vendor is deliberately not mentioned. This screen knows nothing about
       -- the buy side, and clearing a flag it was never shown would delete a
       -- vendor from the directory as a side effect of correcting an email.
       is_customer = 1,
       -- Left alone by a save that did not mention them, exactly as the address
       -- below is. A buyer written from the invoice screen carries a name and an
       -- email; without this guard every such save would blank a phone number
       -- that only the contact import knows.
       phone      = CASE WHEN @hasPhone = 1 THEN excluded.phone ELSE invoice_customers.phone END,
       mobile     = CASE WHEN @hasPhone = 1 THEN excluded.mobile ELSE invoice_customers.mobile END,
       terms      = excluded.terms,
       location   = excluded.location,
       class_name = excluded.class_name,
       message    = excluded.message,
       notes      = excluded.notes,
       -- Only ever SET, never cleared by an ordinary edit. The QuickBooks id is
       -- learned from a successful post; a later rename typed on this screen
       -- must not throw it away and force the match to be made again.
       qbo_id     = COALESCE(excluded.qbo_id, invoice_customers.qbo_id),
       -- The address moves as a WHOLE or not at all. Six independent COALESCEs
       -- would merge a new street onto an old city the first time somebody
       -- cleared a field, producing an address that was never anybody's.
       bill_line1       = CASE WHEN @hasAddress = 1 THEN excluded.bill_line1
                               ELSE invoice_customers.bill_line1 END,
       bill_line2       = CASE WHEN @hasAddress = 1 THEN excluded.bill_line2
                               ELSE invoice_customers.bill_line2 END,
       bill_city        = CASE WHEN @hasAddress = 1 THEN excluded.bill_city
                               ELSE invoice_customers.bill_city END,
       bill_region      = CASE WHEN @hasAddress = 1 THEN excluded.bill_region
                               ELSE invoice_customers.bill_region END,
       bill_postal_code = CASE WHEN @hasAddress = 1 THEN excluded.bill_postal_code
                               ELSE invoice_customers.bill_postal_code END,
       bill_country     = CASE WHEN @hasAddress = 1 THEN excluded.bill_country
                               ELSE invoice_customers.bill_country END,
       updated_at = excluded.updated_at`
  ).run({
    id,
    name: input.name.trim(),
    email: clean(input.email),
    phone: clean(input.phone),
    mobile: clean(input.mobile),
    hasPhone: input.phone === undefined && input.mobile === undefined ? 0 : 1,
    terms: asTerms(input.terms),
    location: clean(input.location),
    className: clean(input.className),
    message: clean(input.message),
    notes: clean(input.notes),
    qboId: clean(input.qboId),
    ...addressParams(input.billAddr),
    // An edit that carries no address at all leaves the stored one alone. The
    // buyer form is not the only thing that saves a customer — writing one from
    // the invoice screen passes a name and an email and nothing else, and that
    // must not wipe an address somebody typed.
    hasAddress: hasAddress(input.billAddr) ? 1 : 0,
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
 *
 * ## And never deleted at all when they are also a vendor
 *
 * Since v62 one row can be both sides of the business. Deleting a buyer who is
 * also on the vendor list would take a supplier's address off the vendor
 * directory from a screen that does not show the vendor directory and gives no
 * hint that it is about to — which is precisely the failure mode a single
 * contact table was chosen to prevent, arriving from the other direction. So
 * they stop being a customer and stay a vendor, and the caller is told which of
 * the three things happened so the confirmation can say it out loud.
 */
export function removeCustomer(id: string): { deleted: boolean; keptAsVendor: boolean } {
  const db = getDb()
  const used = db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ?`).get(id) as {
    n: number
  }
  if (used.n > 0) {
    db.prepare(`UPDATE invoice_customers SET active = 0, updated_at = ? WHERE id = ?`).run(
      nowIso(),
      id
    )
    return { deleted: false, keptAsVendor: false }
  }
  const row = db.prepare(`SELECT is_vendor FROM invoice_customers WHERE id = ?`).get(id) as
    | { is_vendor: number }
    | undefined
  if (row?.is_vendor === 1) {
    db.prepare(
      `UPDATE invoice_customers SET is_customer = 0, updated_at = ? WHERE id = ?`
    ).run(nowIso(), id)
    return { deleted: false, keptAsVendor: true }
  }
  db.prepare(`DELETE FROM invoice_customers WHERE id = ?`).run(id)
  return { deleted: true, keptAsVendor: false }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

interface InvoiceRow extends AddressRow {
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
  qbo_push_state: string | null
  qbo_push_error: string | null
  qbo_push_attempted_at: string | null
  qbo_push_attempts: number | null
  qbo_email_status: string | null
  qbo_delivered_at: string | null
  qbo_balance: number | null
  qbo_total_amt: number | null
  qbo_voided: number | null
  qbo_paid_at: string | null
  qbo_payments_applied: number | null
  qbo_payment_count: number | null
  qbo_status_checked_at: string | null
  qbo_status_attempted_at: string | null
  qbo_status_error: string | null
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
  product_id: string | null
  sku: string | null
  description: string | null
  quantity: number
  rate: number
  amount: number
  tax_rate: string | null
  class_name: string | null
  qty_fulfilled: number
  fulfilled_at: string | null
  /** NULL means "the order's location" — see toLine. */
  destination: string | null
  supplier: string | null
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
    billAddr: toAddress(r),
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
    qboPushState: asPushState(r.qbo_push_state),
    qboPushError: r.qbo_push_error ?? null,
    qboPushAttemptedAt: r.qbo_push_attempted_at ?? null,
    qboPushAttempts: r.qbo_push_attempts ?? 0,
    qboEmailStatus: r.qbo_email_status ?? null,
    qboDeliveredAt: r.qbo_delivered_at ?? null,
    // Nullable on purpose, and null is not zero. "QuickBooks says nothing is
    // owed" and "we have never asked QuickBooks" are different facts, and a
    // balance defaulted to 0 would read as paid in full on a card nobody has
    // ever synced.
    qboBalance: r.qbo_balance ?? null,
    qboTotalAmt: r.qbo_total_amt ?? null,
    qboVoided: r.qbo_voided === 1,
    // A CALENDAR DAY from QuickBooks, not an instant, and a different fact from
    // paidAt below — see the column comment in the v71 migration.
    qboPaidAt: r.qbo_paid_at ?? null,
    qboPaymentsApplied: r.qbo_payments_applied ?? null,
    qboPaymentCount: r.qbo_payment_count ?? null,
    qboStatusCheckedAt: r.qbo_status_checked_at ?? null,
    qboStatusAttemptedAt: r.qbo_status_attempted_at ?? null,
    qboStatusError: r.qbo_status_error ?? null,
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

/**
 * `headerLocation` is where the ORDER is fulfilled from, and it is what an empty
 * `destination` column means. Resolved here so no screen has to know the rule —
 * the same reason a purchase order line's destination is resolved on read.
 */
function toLine(r: LineRow, headerLocation: string): InvoiceLine {
  const destination = (r.destination ?? '').trim() || headerLocation
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    position: r.position,
    item: r.item,
    productId: r.product_id,
    sku: r.sku,
    description: r.description,
    quantity: r.quantity,
    rate: r.rate,
    amount: r.amount,
    taxRate: r.tax_rate,
    className: r.class_name,
    qtyFulfilled: r.qty_fulfilled ?? 0,
    qtyOutstanding: Math.max(0, r.quantity - (r.qty_fulfilled ?? 0)),
    fulfilledAt: r.fulfilled_at ?? null,
    destination,
    supplier: (r.supplier ?? '').trim() || null,
    // DERIVED, never stored. A stored flag is a second source of truth that
    // drifts the first time a line is re-routed.
    dropship: !destinationHoldsStock(destination)
  }
}

const INVOICE_COLS = `id, invoice_number, customer_id, customer_name, email, terms, invoice_date,
                      due_date, location, memo, message, send_later, class_name, status,
                      qbo_id, qbo_doc_number, qbo_synced_at,
                      qbo_push_state, qbo_push_error, qbo_push_attempted_at, qbo_push_attempts,
                      qbo_email_status, qbo_delivered_at, qbo_balance, qbo_total_amt,
                      qbo_voided, qbo_paid_at, qbo_payments_applied, qbo_payment_count,
                      qbo_status_checked_at, qbo_status_attempted_at,
                      qbo_status_error,
                      ${ADDRESS_COLS},
                      total, paid_at, paid_by,
                      carrier, service, tracking_number, payment_timing,
                      tracking_status, tracking_status_detail, tracking_status_at,
                      tracking_checked_at, tracking_error, tracking_attempted_at,
                      created_by, created_at, updated_at`

const LINE_COLS = `id, invoice_id, position, item, product_id, sku, description, quantity, rate,
                   amount, tax_rate, class_name, qty_fulfilled, fulfilled_at,
                   destination, supplier`

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
    .prepare(`SELECT ${LINE_COLS} FROM invoice_lines WHERE invoice_id = ? ORDER BY position ASC`)
    .all(id) as LineRow[]
  const head = toInvoice(row)
  return { ...head, lines: lines.map((l) => toLine(l, invoiceStockLocation(head.location))) }
}

/** Several invoices with their lines, for the CSV export. */
export function getInvoices(ids: string[]): InvoiceDetail[] {
  return ids.map((id) => getInvoice(id)).filter((i): i is InvoiceDetail => i !== null)
}

/**
 * A catalog product's SKU, or null.
 *
 * Its own read rather than a join in saveInvoice because the link is allowed to
 * dangle: a product deleted after an invoice was raised leaves the line's
 * snapshotted name and SKU intact, which is the behaviour a sent document needs.
 */
function productSku(productId: string): string | null {
  const row = getDb().prepare(`SELECT sku FROM inventory_products WHERE id = ?`).get(productId) as
    | { sku: string | null }
    | undefined
  return clean(row?.sku)
}

/** The buyer's stored bill-to, for snapshotting onto a new invoice. */
function customerAddress(customerId: string | null): InvoiceAddress | null {
  if (!customerId) return null
  const row = getDb()
    .prepare(`SELECT ${ADDRESS_COLS} FROM invoice_customers WHERE id = ?`)
    .get(customerId) as AddressRow | undefined
  return row ? toAddress(row) : null
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

  // The bill-to, snapshotted. When the invoice carries none of its own but names
  // a buyer we hold, theirs is copied ONTO the invoice rather than joined at read
  // time — which is the entire point of a snapshot, and the reason a buyer who
  // moves next year cannot rewrite where this document says it went.
  const billAddr =
    hasAddress(input.billAddr) ? (input.billAddr ?? null) : customerAddress(clean(input.customerId))

  const lines = input.lines.map((l, i) => {
    // THE SKU IS AUTO-FILLED FROM THE PRODUCT, once, at save time. Looked up
    // here rather than trusted from the caller because the caller is a form: a
    // screen that fills the box on selection still leaves it stale if somebody
    // changes the product afterwards, and an explicit blank must not silently
    // undo the link. A SKU that WAS typed is kept — a one-off line is allowed to
    // carry a code that is not in this catalog.
    const productId = clean(l.productId)
    const sku = clean(l.sku) ?? (productId ? productSku(productId) : null)
    return {
      id: randomUUID(),
      invoiceId: id,
      position: i,
      item: l.item.trim(),
      productId,
      sku,
      description: clean(l.description),
      quantity: Number(l.quantity) || 0,
      rate: money(Number(l.rate) || 0),
      // The agreed amount wins when one was given; quantity × rate is only the
      // suggestion. See the note on InvoiceLine.amount.
      amount: money(l.amount ?? lineAmount(l.quantity, l.rate)),
      taxRate: clean(l.taxRate),
      className: clean(l.className),
      // Carried through as typed; `lineDestination` decides what is actually
      // stored, because "same as the header" has to become NULL to inherit.
      destination: clean(l.destination),
      supplier: clean(l.supplier)
    }
  })

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO invoices
         (id, invoice_number, customer_id, customer_name, email, terms, invoice_date, due_date,
          location, memo, message, send_later, class_name, status, qbo_id, qbo_doc_number,
          qbo_synced_at, total, carrier, service, tracking_number, payment_timing,
          bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country,
          created_by, created_at, updated_at)
       VALUES (@id, @invoiceNumber, @customerId, @customerName, @email, @terms, @invoiceDate,
               @dueDate, @location, @memo, @message, @sendLater, @className, 'draft',
               NULL, NULL, NULL, @total, @carrier, @service, @trackingNumber, @paymentTiming,
               @billLine1, @billLine2, @billCity, @billRegion, @billPostalCode, @billCountry,
               @createdBy, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         invoice_number = excluded.invoice_number,
         customer_id    = excluded.customer_id,
         customer_name  = excluded.customer_name,
         email          = excluded.email,
         bill_line1       = excluded.bill_line1,
         bill_line2       = excluded.bill_line2,
         bill_city        = excluded.bill_city,
         bill_region      = excluded.bill_region,
         bill_postal_code = excluded.bill_postal_code,
         bill_country     = excluded.bill_country,
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
      ...addressParams(billAddr),
      total: invoiceTotal(lines),
      // Null on an edit. The ON CONFLICT branch does not touch created_by, so
      // whatever is bound here is discarded on that path — but bind the value
      // that MEANS "no author", rather than relying on the driver's handling of
      // undefined, so the intent survives if that clause ever gains a column.
      createdBy: existing ? null : actorId,
      createdAt: existing?.created_at ?? stamp,
      updatedAt: stamp
    })

    /**
     * THE SHELF. Everything this order was holding goes back, and then it takes
     * what it now sells.
     *
     * A sales order is a sale — saving one moves stock, the same way recording a
     * counter sale does. Release-then-apply rather than a per-line delta because
     * a delta is where an off-by-one becomes a box that does not exist:
     * `restoreFifo` puts units back into the exact layers they came from, so the
     * re-take walks the same FIFO order and lands on the same layers at the same
     * costs. Identical result, no arithmetic to get wrong.
     *
     * The release runs FIRST, so the re-take sees a shelf that already has this
     * order's units back on it. The other order would find a shelf of 4 empty
     * when editing an order for 4 up to 5, and take nothing.
     *
     * A line takes what is on the shelf and no more — see applyInvoiceStock. An
     * order written the day before the pallet lands is a real thing somebody
     * does, so the save is never refused; the part that could not be filled stays
     * outstanding on the line and goes out when the stock does.
     */
    const stockLocation = invoiceStockLocation(input.location)
    const stockLines = lines
      .filter((l) => {
        if (!l.productId || !(l.quantity > 0)) return false
        // A DROPSHIPPED LINE MOVES NO STOCK, and this is the assertion the whole
        // feature rests on. The units went from the supplier straight to the
        // buyer; this business never held them, so drawing a shelf down for them
        // would invent a sale out of inventory that was never there — and on a
        // product carried in stock it would quietly consume somebody else's
        // boxes.
        const dest = lineDestination(l.destination, stockLocation) ?? stockLocation
        return destinationHoldsStock(dest)
      })
      .map((l) => ({ position: l.position, productId: l.productId as string, quantity: l.quantity }))
    releaseInvoiceStock(db, id)
    const moved = applyInvoiceStock(
      db,
      id,
      clean(input.invoiceNumber),
      input.customerName?.trim() || null,
      stockLines,
      stockLocation,
      actorId
    )
    const movedQty = new Map(moved.map((m) => [m.position, m.quantity]))

    /**
     * WHAT HAS ALREADY LEFT THE BUILDING, carried across the rewrite.
     *
     * Saving replaces every line rather than diffing them, which is fine for
     * everything the operator typed — but `qty_fulfilled` is not typed, it is
     * PHYSICAL. It records boxes a picker has already scanned out, and
     * `fulfilSalesLine` decremented real stock when it was written.
     *
     * The insert below did not name the column, so it took its schema default of
     * 0 and every save silently forgot the picking. Editing a memo on an order
     * that was 6 of 10 picked reset it to 0 of 10, the scan queue offered all ten
     * units again, and a second scan-out took ten more boxes off the shelf
     * against a ten-box sale. Sixteen units gone, no error anywhere.
     *
     * Keyed on the PRODUCT, not the line id: the rewrite mints new line ids, so
     * matching on id would carry nothing. A line with no product (a service, a
     * one-off) falls back to its item name. Anything that matches nothing starts
     * at 0, which is correct — it is a line that did not exist before.
     *
     * It is a POOL PER PRODUCT, drawn down line by line, and that matters as soon
     * as an order lists the same box twice — two lines of three at different
     * prices, which is an ordinary thing to type. The first version handed the
     * whole pool to the first matching line and then DELETED the key, so a 3+3
     * order that had shipped all six came back as 3 fulfilled and 3 outstanding.
     * The scan queue then offered three units that were already in a box on a
     * van, and the picker taking them off the shelf again is the same
     * shelf-emptying failure this carry-forward was written to stop.
     *
     * ## It now only governs lines that are NOT stock
     *
     * A line with a product is fulfilled by the block above: its stock came off
     * the shelf as part of this save, so `qty_fulfilled` is its full quantity and
     * there is nothing left to pick. Everything below is for the lines that never
     * had stock behind them — a grading fee, a shipping charge, a one-off typed
     * by hand — which nothing has ever scanned and which keep exactly the
     * behaviour they had.
     */
    const priorFulfilled = new Map<string, { qty: number; at: string | null }>()
    if (existing) {
      const rows = db
        .prepare(
          `SELECT product_id, item, qty_fulfilled, fulfilled_at
             FROM invoice_lines WHERE invoice_id = ? AND qty_fulfilled > 0`
        )
        .all(id) as Array<{
        product_id: string | null
        item: string
        qty_fulfilled: number
        fulfilled_at: string | null
      }>
      for (const r of rows) {
        const key = r.product_id ? `p:${r.product_id}` : `i:${r.item.trim().toLowerCase()}`
        const prev = priorFulfilled.get(key)
        priorFulfilled.set(key, {
          qty: (prev?.qty ?? 0) + r.qty_fulfilled,
          at: prev?.at ?? r.fulfilled_at
        })
      }
    }

    db.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?`).run(id)
    const insert = db.prepare(
      `INSERT INTO invoice_lines
         (id, invoice_id, position, item, product_id, sku, description, quantity, rate, amount,
          tax_rate, class_name, qty_fulfilled, fulfilled_at, created_at, updated_at,
          destination, supplier)
       VALUES (@id, @invoiceId, @position, @item, @productId, @sku, @description, @quantity,
               @rate, @amount, @taxRate, @className, @qtyFulfilled, @fulfilledAt, @stamp, @stamp,
               @destination, @supplier)`
    )
    for (const l of lines) {
      const key = l.productId ? `p:${l.productId}` : `i:${l.item.trim().toLowerCase()}`
      const carried = priorFulfilled.get(key)
      // Never claim more picked than the line now sells. Editing 10 down to 4
      // after 6 went out is a real thing somebody may do; the honest record is
      // that the line is fully fulfilled, not that 6 of 4 left.
      const carriedQty = Math.min(carried?.qty ?? 0, l.quantity)
      // Draw down rather than discard: whatever this line could not absorb is
      // still owed to the NEXT line that names the same product.
      if (carried) {
        carried.qty -= carriedQty
        if (carried.qty <= 0) priorFulfilled.delete(key)
      }
      // A STOCK LINE IS FULFILLED THE MOMENT ITS STOCK LEAVES, which is now this
      // save. Reading it off `moved` rather than assuming `l.quantity` keeps the
      // record and the shelf saying the same number even if the consumption ever
      // takes less than it was asked for.
      const qty = movedQty.get(l.position) ?? carriedQty
      insert.run({
        ...l,
        qtyFulfilled: qty,
        fulfilledAt: qty > 0 ? (carried?.at ?? stamp) : null,
        stamp,
        // NULL means "the order's location", the same inheritance a PO line
        // stores. Keeping the inheritance rather than a copy is what stops a
        // later change of the order's location leaving stale values behind.
        destination: lineDestination(l.destination, stockLocation),
        supplier: (l.supplier ?? '').trim() || null
      })
    }
  })
  run()

  const saved = getInvoice(id)
  if (!saved) throw new Error('That invoice could not be saved.')
  return saved
}

/**
 * Record what QuickBooks said after a successful post.
 *
 * Clears the push error as well as stamping the id: an invoice that failed
 * yesterday and posted today is not a failure any more, and leaving the sentence
 * behind would keep it on a retry list for ever.
 */
export function markPosted(
  id: string,
  qbo: { id: string; docNumber: string | null },
  status: InvoiceStatus = 'created'
): void {
  const stamp = nowIso()
  getDb()
    .prepare(
      `UPDATE invoices
          SET qbo_id = ?, qbo_doc_number = ?, qbo_synced_at = ?, status = ?,
              qbo_push_state = 'ok', qbo_push_error = NULL, qbo_push_attempted_at = ?,
              updated_at = ?
        WHERE id = ?`
    )
    .run(qbo.id, qbo.docNumber, stamp, status, stamp, stamp, id)
}

/**
 * Take the right to push this invoice, or report that somebody else has it.
 *
 * ## Why this is a claim and not a stamp
 *
 * It used to be `markPushPending` — an unconditional UPDATE — and the only thing
 * standing between an invoice and TWO copies of it in a real company's books was
 * the caller reading `invoice.qboId` off a snapshot taken before an `await`. Two
 * overlapping pushes both read that snapshot, both saw no id, and both posted.
 * A double-clicked Retry button was enough; two browser tabs on the web build
 * were certain.
 *
 * The WHERE clause is the fix, and it is the fix because SQLite applies it and
 * reports the row count atomically. The caller no longer asks "is this already
 * posted?" and then acts on the answer — the question and the act are one
 * statement, so the second caller loses and is told it lost.
 *
 * Returns false when the row is gone, already carries a QuickBooks id, or has
 * been voided. All three mean "do not post this", which is the only answer the
 * caller needs.
 *
 * ## What it deliberately does NOT refuse
 *
 * A row already reading 'pending'. That state survives a process killed
 * mid-flight and is the flag that says "this may be in QuickBooks" — the whole
 * reason `listInvoicesNeedingPush` includes it. Refusing here would make a
 * crashed push unretryable for ever. Concurrency inside one process is held off
 * by the in-flight set in invoicesIpc, which is where "right now" is knowable;
 * this statement is what stops a push against a row that has ALREADY landed.
 *
 * ## The ordering that has not changed
 *
 * 'pending' is still written BEFORE the network call. A process killed between
 * the request leaving and the reply arriving leaves a row saying "this may be in
 * QuickBooks", which is what makes somebody look before pushing again. Written
 * after the call it would read 'none' — "never tried" — and that claim leads
 * straight to the duplicate. The attempt COUNTER climbs here rather than on
 * failure for the same reason: an attempt that vanished mid-flight still
 * happened.
 */
export function claimPushSlot(id: string): boolean {
  const stamp = nowIso()
  const res = getDb()
    .prepare(
      `UPDATE invoices
          SET qbo_push_state = 'pending',
              qbo_push_attempted_at = ?,
              qbo_push_attempts = COALESCE(qbo_push_attempts, 0) + 1,
              updated_at = ?
        WHERE id = ?
          AND (qbo_id IS NULL OR qbo_id = '')
          AND status != 'void'`
    )
    .run(stamp, stamp, id)
  return res.changes === 1
}

/**
 * It was refused, and this is what Intuit said.
 *
 * The local invoice is untouched apart from these three columns. That is the
 * whole contract of "save first, then push": a QuickBooks failure costs the
 * push, never the document.
 */
export function markPushFailed(id: string, error: string): void {
  const stamp = nowIso()
  getDb()
    .prepare(
      `UPDATE invoices
          SET qbo_push_state = 'failed', qbo_push_error = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(error.slice(0, 2000), stamp, id)
}

/**
 * Invoices that tried to reach QuickBooks and did not.
 *
 * Deliberately excludes anything that already has a qbo_id — a row can only be
 * on this list if there is nothing in QuickBooks to duplicate. 'pending' is
 * included because a push interrupted mid-flight needs a human eye, and the
 * screen offering the retry is the place to say so.
 */
export function listInvoicesNeedingPush(limit = 100): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          WHERE (qbo_id IS NULL OR qbo_id = '')
            AND qbo_push_state IN ('failed', 'pending')
            AND status != 'void'
          ORDER BY qbo_push_attempted_at DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(500, limit))) as InvoiceRow[]
  ).map(toInvoice)
}

/**
 * Everything this app has posted, so a status pull knows what to ask about.
 *
 * PAID IS NOT THE END OF THE QUESTION any more. It used to be — an invoice that
 * reached the last column had nothing left worth asking — but the pull now also
 * fetches WHEN the money landed, and an invoice that arrived in paid before this
 * existed has a date sitting in QuickBooks that nothing here has ever gone and
 * read. So a paid invoice stays on the list until it has an answer.
 *
 * It stops after that answer whichever way it came out, including "there is no
 * payment behind this" — an invoice settled in cash that QuickBooks never saw
 * would otherwise be asked about on every refresh for the rest of its life. One
 * extra read each, once, and the per-card refresh is always available for the
 * one somebody is actually looking at.
 */
export function listPostedInvoices(limit = 200): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          WHERE qbo_id IS NOT NULL AND qbo_id != ''
            AND status != 'void'
            AND NOT (status = 'paid' AND qbo_status_checked_at IS NOT NULL)
          ORDER BY invoice_date DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(1000, limit))) as InvoiceRow[]
  ).map(toInvoice)
}

/**
 * Write down what QuickBooks said about an invoice.
 *
 * Facts only — this does NOT move the card. The caller decides that, through
 * nextStageFromQbo, because moving a card is a judgement about two systems and
 * recording an observation is not.
 *
 * ## The payment columns are written CONDITIONALLY, and that is the whole trick
 *
 * `payments` is empty for two completely different reasons: QuickBooks says
 * there are none, or the second round trip that fetches them did not happen —
 * it was throttled, refused, or the network went. Writing an empty array through
 * unconditionally would blank a true "paid 12 August" on the strength of an
 * answer nobody ever got, which is the same mistake recordQboStatusFailure was
 * written to avoid.
 *
 * `linkedPayments` is what tells the two apart, because it comes off the invoice
 * itself and is therefore always present. Zero links and no payments is a real
 * answer and IS written — a payment deleted in QuickBooks should take its date
 * with it. Links but no payments means we did not look, and leaves all three
 * columns exactly as they were.
 */
export function recordQboObservation(id: string, o: QboInvoiceObservation): void {
  const stamp = nowIso()
  const looked = o.payments.length > 0 || o.linkedPayments === 0
  getDb()
    .prepare(
      `UPDATE invoices
          SET qbo_email_status = ?, qbo_delivered_at = ?, qbo_balance = ?, qbo_total_amt = ?,
              qbo_voided = ?, qbo_doc_number = COALESCE(?, qbo_doc_number),
              qbo_paid_at = CASE WHEN ? THEN ? ELSE qbo_paid_at END,
              qbo_payments_applied = CASE WHEN ? THEN ? ELSE qbo_payments_applied END,
              qbo_payment_count = CASE WHEN ? THEN ? ELSE qbo_payment_count END,
              qbo_status_checked_at = ?, qbo_status_attempted_at = ?, qbo_status_error = NULL,
              updated_at = ?
        WHERE id = ?`
    )
    .run(
      o.emailStatus,
      o.deliveredAt,
      o.balance,
      o.totalAmt,
      o.voided ? 1 : 0,
      o.docNumber,
      looked ? 1 : 0,
      latestPaymentDate(o.payments),
      looked ? 1 : 0,
      paymentsApplied(o.payments),
      looked ? 1 : 0,
      o.payments.length,
      stamp,
      stamp,
      stamp,
      id
    )
}

/**
 * Local orders that could be bound to a QuickBooks invoice by their number.
 *
 * Nothing here is a match — these are the rows worth ASKING about. An order that
 * already carries a qbo_id has its counterpart; one with no number has nothing
 * to ask on; a void or paid order can only be moved somewhere terminal by the
 * answer; and 'pending' is the one state where this app already suspects a
 * QuickBooks invoice may exist for this row, which makes it the last state in
 * which to go guessing which one.
 *
 * Drafts are deliberately IN. An order typed here and then invoiced in
 * QuickBooks by hand is exactly the case this exists for, and it never left
 * draft on this side.
 */
export function listInvoicesForDocNumberMatch(limit = 200): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          WHERE (qbo_id IS NULL OR qbo_id = '')
            AND invoice_number IS NOT NULL AND invoice_number != ''
            AND status NOT IN ('void', 'paid')
            AND qbo_push_state != 'pending'
          ORDER BY invoice_date DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(500, limit))) as InvoiceRow[]
  ).map(toInvoice)
}

/**
 * How many local rows carry each of these numbers, ACROSS EVERY STATUS.
 *
 * Every status on purpose. The question a match has to answer is "does this
 * number name one document here", and a second row numbered 2301 makes the
 * answer no whether or not that row is one this pass would otherwise consider.
 */
export function countInvoiceNumbers(numbers: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  const clean = Array.from(new Set(numbers.map((n) => String(n ?? '').trim()).filter(Boolean)))
  if (clean.length === 0) return out
  const db = getDb()
  const CHUNK = 400
  for (let i = 0; i < clean.length; i += CHUNK) {
    const chunk = clean.slice(i, i + CHUNK)
    const rows = db
      .prepare(
        `SELECT invoice_number AS n, COUNT(*) AS c FROM invoices
          WHERE invoice_number IN (${chunk.map(() => '?').join(',')})
          GROUP BY invoice_number`
      )
      .all(...chunk) as Array<{ n: string; c: number }>
    for (const r of rows) out.set(r.n, r.c)
  }
  return out
}

/**
 * How many posted invoices came back from QuickBooks under a DIFFERENT number.
 *
 * The premise of matching on a number is that both systems use the same one, and
 * QuickBooks silently replaces DocNumber unless the company has "Custom
 * transaction numbers" switched on. This app already stores what it sent
 * (invoice_number) beside what came back (qbo_doc_number), so the evidence costs
 * one query and no API call: any non-zero answer means the two are separate
 * series and a number match is a coincidence.
 */
export function countRenumberedInvoices(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM invoices
        WHERE qbo_id IS NOT NULL AND qbo_id != ''
          AND qbo_doc_number IS NOT NULL AND qbo_doc_number != ''
          AND invoice_number IS NOT NULL AND invoice_number != ''
          AND qbo_doc_number != invoice_number`
    )
    .get() as { c: number } | undefined
  return row?.c ?? 0
}

/** Which of these QuickBooks ids some local row already holds. */
export function claimedQboIds(qboIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  const clean = Array.from(new Set(qboIds.map((v) => String(v ?? '').trim()).filter(Boolean)))
  if (clean.length === 0) return out
  const db = getDb()
  const CHUNK = 400
  for (let i = 0; i < clean.length; i += CHUNK) {
    const chunk = clean.slice(i, i + CHUNK)
    const rows = db
      .prepare(
        `SELECT qbo_id FROM invoices WHERE qbo_id IN (${chunk.map(() => '?').join(',')})`
      )
      .all(...chunk) as Array<{ qbo_id: string }>
    for (const r of rows) out.add(r.qbo_id)
  }
  return out
}

/**
 * Bind a local order to a QuickBooks invoice.
 *
 * GUARDED, and it returns false rather than throwing when the guard bites. The
 * WHERE clause repeats "and this row still has no id" for the same reason
 * claimPushSlot does: between a screen listing a proposal and somebody pressing
 * the button, a push or another window may have given this row an id, and
 * overwriting one qbo_id with another silently re-points Delete and Send at a
 * different document in somebody's real books.
 *
 * `qbo_push_state` goes to 'ok' because that is what this codebase means by it —
 * see the v22 backfill, which sets exactly that for every row holding an id. It
 * is not a claim that a push happened; it is the absence of one still to do.
 * `qbo_synced_at` is deliberately left alone: it means when this app PUT the
 * invoice there, and this app did not.
 */
export function adoptQboInvoice(id: string, qboId: string, docNumber: string | null): boolean {
  const stamp = nowIso()
  return (
    getDb()
      .prepare(
        `UPDATE invoices
            SET qbo_id = ?, qbo_doc_number = COALESCE(?, qbo_doc_number),
                qbo_push_state = 'ok', qbo_push_error = NULL,
                updated_at = ?
          WHERE id = ? AND (qbo_id IS NULL OR qbo_id = '')`
      )
      .run(qboId, docNumber, stamp, id).changes > 0
  )
}

/**
 * We asked and could not get an answer.
 *
 * Touches attempted_at and the error and NOTHING else — the same rule the
 * carrier tracking columns follow. Stale-but-true beats fresh-and-wrong: an
 * invoice QuickBooks said was paid last week is still paid during an outage, and
 * blanking the reading because the network was down would take a true answer off
 * the screen and replace it with nothing.
 */
export function recordQboStatusFailure(id: string, error: string): void {
  const stamp = nowIso()
  getDb()
    .prepare(
      `UPDATE invoices
          SET qbo_status_attempted_at = ?, qbo_status_error = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(stamp, error.slice(0, 2000), stamp, id)
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
  const db = getDb()
  const stamp = nowIso()
  const run = db.transaction((): boolean => {
    /**
     * VOIDING PUTS THE BOXES BACK.
     *
     * Since a sales order takes its stock the moment it is saved, voiding one is
     * the moment that stock is no longer sold — the buyer fell through, the order
     * was a mistake, the show did not happen. Leaving the shelf down would mean
     * an order that bills nobody is still holding four boxes nobody can sell, and
     * the only way to get them back would be a manual count correction that
     * invents a cost basis.
     *
     * `releaseInvoiceStock` restores the exact layers, so the FIFO order and
     * every unit cost end up as if the order had never been written.
     *
     * Only on the way IN to void. Every other status — draft, created, sent,
     * paid — describes where an order is in the billing cycle, and the boxes are
     * gone in all of them.
     */
    if (status === 'void') releaseInvoiceStock(db, id)
    return (
      db
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
  })
  return run()
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
  // DELETING HERE NEVER DEPENDS ON QUICKBOOKS.
  //
  // This refused anything with a qbo_id, then required the caller to have
  // deleted the remote copy first. Both blocked the button in practice: saving
  // posts immediately, so every invoice has an id within seconds, and Intuit
  // refuses to delete an invoice that has a payment applied — which is exactly
  // the invoice somebody wants off their board. The result was a Delete button
  // that returned "Access Denied" and removed nothing.
  //
  // This is the owner's record. Clearing a mistake out of it is not conditional
  // on another system's opinion. The caller still tries QuickBooks first and
  // reports what happened, so a surviving copy over there is stated rather than
  // discovered later.
  const run = db.transaction(() => {
    // The shelf first, and BEFORE the row goes: invoice_stock_moves cascades on
    // the invoice, so deleting the header first would take the receipt with it
    // and there would be nothing left to say which layers to restore. The boxes
    // would simply be gone, with a cost basis attached to a document that no
    // longer exists.
    releaseInvoiceStock(db, id)
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

// ---------------------------------------------------------------------------
// Fulfilment — matching stock scanned OUT against an open sales order
// ---------------------------------------------------------------------------

/**
 * Open sales order lines this product could be scanned out against.
 *
 * The mirror of `outstandingLinesForProduct` on the buy side, and it makes the
 * same two judgements for the same reasons:
 *
 * VOID IS EXCLUDED, PAID IS NOT. A void order is cancelled and nothing should
 * ship against it. A PAID one is the ordinary case for this business — money
 * arrives before the boxes go out — so refusing to fulfil a paid order would
 * refuse most of the work.
 *
 * A DRAFT COUNTS. Somebody who wrote the order up and is now standing at the
 * shelf with the boxes has a real order; making them post it to QuickBooks
 * first would put an accounting step in the middle of a physical one.
 *
 * Oldest order first, so the queue that has waited longest is offered first.
 */
export function outstandingSalesLinesForProduct(productId: string): ScanSoCandidate[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id AS line_id, l.invoice_id, l.quantity, l.qty_fulfilled, l.rate,
              i.invoice_number, i.customer_name, i.status, i.invoice_date,
              (SELECT COUNT(*) FROM invoice_lines x WHERE x.invoice_id = l.invoice_id)
                AS lines_total,
              (SELECT COUNT(*) FROM invoice_lines x
                WHERE x.invoice_id = l.invoice_id AND x.qty_fulfilled < x.quantity)
                AS lines_outstanding
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
        WHERE l.product_id = ?
          AND i.status != 'void'
          AND l.qty_fulfilled < l.quantity
        ORDER BY i.invoice_date ASC, i.invoice_number ASC, l.position ASC`
    )
    .all(productId) as Array<{
    line_id: string
    invoice_id: string
    quantity: number
    qty_fulfilled: number
    rate: number
    invoice_number: string | null
    customer_name: string | null
    status: string
    invoice_date: string
    lines_total: number
    lines_outstanding: number
  }>
  return rows.map((r) => ({
    lineId: r.line_id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number ?? '',
    customerName: r.customer_name,
    status: r.status as InvoiceStatus,
    quantity: r.quantity,
    qtyFulfilled: r.qty_fulfilled,
    qtyOutstanding: Math.max(0, r.quantity - r.qty_fulfilled),
    unitPrice: r.rate,
    invoiceDate: r.invoice_date,
    completesOrder: r.lines_outstanding === 1,
    orderLinesTotal: r.lines_total,
    orderLinesOutstanding: r.lines_outstanding
  }))
}

/** What one scan took off a sales order line, for the audit row. */
export interface FulfilledSalesLine {
  lineId: string
  invoiceId: string
  invoiceNumber: string
  productId: string
  quantity: number
  /** True when this scan finished the last outstanding line on the order. */
  completesOrder: boolean
}

/**
 * Take units off ONE sales order line. Call inside the caller's transaction.
 *
 * `allowOverage` is the operator's recorded answer to "you have scanned more
 * than this order asked for". Without it the ask is clamped to what is
 * outstanding, exactly as receiving is — the clamp is right for a scan, where
 * each beep is one unit and it is what stops a double-beep double-counting.
 * With it, the line goes past its ordered quantity and reads as over-fulfilled,
 * which the progress bars already paint as a discrepancy rather than as done.
 */
export function fulfilSalesLine(
  db: Database.Database,
  lineId: string,
  qty: number,
  allowOverage: boolean
): FulfilledSalesLine {
  const row = db
    .prepare(
      `SELECT l.id, l.invoice_id, l.product_id, l.quantity, l.qty_fulfilled,
              i.invoice_number, i.status
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
        WHERE l.id = ?`
    )
    .get(lineId) as
    | {
        id: string
        invoice_id: string
        product_id: string | null
        quantity: number
        qty_fulfilled: number
        invoice_number: string | null
        status: string
      }
    | undefined
  if (!row) throw new Error('That sales order line no longer exists.')
  // Re-read inside the transaction, so an order voided between resolve and
  // commit is caught here and rolls the whole thing back.
  if (row.status === 'void') throw new Error('That sales order was voided.')

  const outstanding = Math.max(0, row.quantity - row.qty_fulfilled)
  if (outstanding <= 0 && !allowOverage) {
    throw new Error('That line has already been fully fulfilled.')
  }
  const want = Number.isFinite(qty) ? Math.round(qty) : outstanding
  // Refused rather than trimmed, for the reason `receivePoLine` gives on the
  // buy side: a number somebody sent is a claim, and quietly booking less of it
  // leaves them believing the rest went out.
  if (!allowOverage && Number.isFinite(qty) && want > outstanding) {
    throw new Error(
      `Only ${outstanding} of ${row.quantity} ${
        outstanding === 1 ? 'is' : 'are'
      } still to go out on ${row.invoice_number ?? 'that order'}, so ${want} cannot be fulfilled.`
    )
  }
  const take = allowOverage ? Math.max(1, want) : Math.min(Math.max(1, want), outstanding)

  const ts = nowIso()
  db.prepare(
    `UPDATE invoice_lines
        SET qty_fulfilled = qty_fulfilled + @take,
            fulfilled_at  = CASE WHEN qty_fulfilled + @take >= quantity THEN @ts ELSE fulfilled_at END,
            updated_at    = @ts
      WHERE id = @id`
  ).run({ take, ts, id: lineId })

  const left = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invoice_lines
        WHERE invoice_id = ? AND qty_fulfilled < quantity`
    )
    .get(row.invoice_id) as { n: number }

  return {
    lineId,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number ?? '',
    productId: row.product_id ?? '',
    quantity: take,
    completesOrder: left.n === 0
  }
}

