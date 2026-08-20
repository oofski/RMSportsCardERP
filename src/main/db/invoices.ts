import { randomUUID } from 'crypto'
import {
  DEFAULT_INVOICE_TERMS,
  INVOICE_TERMS,
  asPushState,
  dueDateFor,
  hasAddress,
  canMoveInvoice,
  invoiceTotal,
  latestPaymentDate,
  lineAmount,
  money,
  INVOICE_NUMBER_START,
  nextInvoiceNumber,
  paymentsApplied,
  validateCustomer,
  validateInvoice,
  validateInvoicePayment,
  type Invoice,
  type InvoiceAddress,
  type InvoiceCustomer,
  type InvoiceDetail,
  type InvoiceLine,
  type InvoiceStatus,
  type InvoiceTerms,
  type InvoicePaymentInput,
  type NewInvoice,
  type QboInvoiceObservation
} from '@shared/invoices'
import type { ScanSoCandidate } from '@shared/types'
import type Database from 'better-sqlite3'
import { asCarrier, asPaymentTiming, detectCarrier } from '@shared/freight'
import { asShipStatus } from '@shared/tracking'
import { getDb, getMeta } from './database'
import { applyInvoiceStock, invoiceStockLocation, releaseInvoiceStock } from './invoiceStock'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import { adoptLegacyFreight, deleteOrderExtras, recordOrderEvent } from './orderExtras'
import { describeDims, hasDims } from '@shared/fulfillment'
import { dealTicketRefFor } from './dealTickets'
import { issueDealTicket, markDropshipPair } from './dealTickets'

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

/** A stored measurement, or null. Zero and NaN both read as "nobody said". */
function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
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
  paid_up_front: number | null
  payment_method: string | null
  payment_reference: string | null
  ready_to_ship_at: string | null
  ready_to_ship_by: string | null
  source_po_id: string | null
  allow_credit_card: number | null
  stock_units: number | null
  drop_units: number | null
  drawn_units: number | null
  ship_weight_lb: number | null
  ship_length_in: number | null
  ship_width_in: number | null
  ship_height_in: number | null
  items_in_hand_at: string | null
  items_in_hand_by: string | null
  force_ready_at: string | null
  force_ready_by: string | null
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
    paidUpFront: r.paid_up_front === 1,
    paymentMethod: r.payment_method ?? null,
    paymentReference: r.payment_reference ?? null,
    readyToShipAt: r.ready_to_ship_at ?? null,
    readyToShipBy: r.ready_to_ship_by ?? null,
    // Absent reads as ALLOWED, matching the column default. A NULL here means a
    // row written before v76, and those were raised under whatever the
    // QuickBooks company default was — which is the same thing 'allowed' sends.
    allowCreditCard: r.allow_credit_card !== 0,
    sourcePoId: r.source_po_id ?? null,
    stockUnits: Number(r.stock_units) || 0,
    dropshipUnits: Number(r.drop_units) || 0,
    drawnUnits: Number(r.drawn_units) || 0,
    // Nulls kept as nulls rather than coerced to 0: "not measured" and "measured
    // as nothing" are different facts, and hasDims reads a zero as absent
    // anyway — but a 0 written into the form would look like somebody's answer.
    weightLb: numOrNull(r.ship_weight_lb),
    lengthIn: numOrNull(r.ship_length_in),
    widthIn: numOrNull(r.ship_width_in),
    heightIn: numOrNull(r.ship_height_in),
    itemsInHandAt: r.items_in_hand_at ?? null,
    itemsInHandBy: r.items_in_hand_by ?? null,
    forceReadyAt: r.force_ready_at ?? null,
    forceReadyBy: r.force_ready_by ?? null,
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
                      paid_up_front, payment_method, payment_reference,
                      ready_to_ship_at, ready_to_ship_by, source_po_id, allow_credit_card,
                      carrier, service, tracking_number, payment_timing,
                      tracking_status, tracking_status_detail, tracking_status_at,
                      tracking_checked_at, tracking_error, tracking_attempted_at,
                      created_by, created_at, updated_at,
                      -- HOW MUCH OF THIS SALE COMES OFF OUR OWN SHELF, and how
                      -- much a supplier ships direct. Two figures rather than a
                      -- flag, because after mixed sales orders landed an order
                      -- can be part of a dropship without being one -- which is
                      -- exactly the distinction the buy side already draws (see
                      -- orderKindOf) and the board now mirrors.
                      --
                      -- Written against invoices.id rather than an alias so this
                      -- one definition works in all six queries that select these
                      -- columns, none of which aliases the table. NO BACKTICKS in
                      -- these comments: this whole block is a template literal,
                      -- and one would end it hundreds of lines from the error.
                      --
                      -- The destination test is the same one listAwaitingShipment
                      -- uses: a blank line destination inherits the order's, and a
                      -- blank order location means RM. Spelling it differently
                      -- here is how a board comes to disagree with the stock
                      -- engine about which lines are a dropship.
                      (SELECT COALESCE(SUM(CASE WHEN UPPER(COALESCE(NULLIF(TRIM(l.destination), ''),
                                                                    invoices.location, 'RM'))
                                                     IN ('RM', 'AM')
                                                THEN l.quantity ELSE 0 END), 0)
                         FROM invoice_lines l WHERE l.invoice_id = invoices.id) AS stock_units,
                      (SELECT COALESCE(SUM(CASE WHEN UPPER(COALESCE(NULLIF(TRIM(l.destination), ''),
                                                                    invoices.location, 'RM'))
                                                     IN ('RM', 'AM')
                                                THEN 0 ELSE l.quantity END), 0)
                         FROM invoice_lines l WHERE l.invoice_id = invoices.id) AS drop_units,
                      -- THE FULFILMENT GATES. See @shared/fulfillment.
                      ship_weight_lb, ship_length_in, ship_width_in, ship_height_in,
                      items_in_hand_at, items_in_hand_by, force_ready_at, force_ready_by,
                      -- WHAT THE SHELF ACTUALLY GAVE, which is not always what was
                      -- asked for: applyInvoiceStock takes MIN(asked, on hand), so a
                      -- sale for ten boxes against three draws three and leaves seven
                      -- owed. Compared against stock_units above, this is the only
                      -- honest signal that a stock order is not yet fillable -- and
                      -- without it Awaiting items could only ever speak for dropships.
                      (SELECT COALESCE(SUM(m.quantity), 0)
                         FROM invoice_stock_moves m WHERE m.invoice_id = invoices.id) AS drawn_units`

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
  // DETAIL PATH ONLY, and guarded — see dealTicketRefFor. The list query must
  // not depend on the register, or a broken one stops orders being raised.
  return {
    ...head,
    ...dealTicketRefFor(db, 'so', id),
    lines: lines.map((l) => toLine(l, invoiceStockLocation(head.location)))
  }
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

/**
 * The highest number an invoice actually carries. 0 when none are numeric.
 *
 * Numeric only, and for the same reason `nextInvoiceNumber` filters: a
 * hand-typed "INV-0042" has no counter in it that this app is entitled to guess
 * at, so it is not allowed to move the series.
 */
export function invoiceIssued(): number {
  const row = getDb()
    .prepare(
      `SELECT MAX(CAST(invoice_number AS INTEGER)) AS n
         FROM invoices WHERE invoice_number GLOB '[0-9]*'`
    )
    .get() as { n: number | null } | undefined
  return Number(row?.n ?? 0) || 0
}

/**
 * Where the invoice series starts, as configured.
 *
 * `INVOICE_NUMBER_START` is the value the app shipped with — the point the
 * owner's QuickBooks history had reached when this was first wired up. It is now
 * only the DEFAULT: the numbering screen writes a replacement into `meta`, and
 * that is what a business changing its scheme actually needs. Reading it here
 * rather than at the call site means every path that suggests a number honours
 * it, including any added later.
 */
export function invoiceStart(): number {
  const raw = Number(getMeta(getDb(), 'invoice_number_start') ?? '')
  return Number.isInteger(raw) && raw > 0 ? raw : INVOICE_NUMBER_START
}

/**
 * The next number NOTHING ELSE ALREADY HOLDS.
 *
 * `nextInvoiceNumber` answers max+1, which is right until a number in the middle
 * of the range is taken — by a hand-typed one, or by an order that arrived from
 * another machine. This walks up from that answer until it finds a free one, so
 * the value handed out is one that can actually be saved.
 *
 * Takes the caller's transaction so `saveInvoice` can look and write without a
 * gap in between.
 */
function freeInvoiceNumber(db: Database.Database, from: number, exceptId: string): string {
  const taken = db.prepare(
    `SELECT 1 FROM invoices WHERE invoice_number = ? AND id <> ? LIMIT 1`
  )
  let n = Math.max(1, Math.trunc(from))
  // Bounded so a corrupt table can never spin forever. Ten thousand consecutive
  // taken numbers is not a state this business reaches; it is a state something
  // is badly wrong in, and looping is the wrong response to that.
  for (let i = 0; i < 10000; i++) {
    if (!taken.get(String(n), exceptId)) return String(n)
    n += 1
  }
  return String(n)
}

/**
 * The next number in the series, on a caller's handle.
 *
 * Split from the public function so the save path can ask INSIDE its own
 * transaction. Asking through getDb() from in there would be a second
 * connection reading a table the transaction is midway through writing.
 */
function suggestInvoiceNumberIn(db: Database.Database): string {
  const rows = db
    .prepare(`SELECT invoice_number FROM invoices WHERE invoice_number IS NOT NULL`)
    .all() as Array<{ invoice_number: string }>
  return nextInvoiceNumber(
    rows.map((r) => r.invoice_number),
    invoiceStart()
  )
}

/**
 * The next number nothing holds, on a caller's handle.
 *
 * The relabel hook sync calls when two machines mint the same one — see
 * RELABEL_ON_CONFLICT. It has to walk past taken numbers rather than take max+1,
 * because the row that lost the collision is still sitting in the table holding
 * the number being replaced.
 */
export function nextFreeInvoiceNumber(db: Database.Database): string {
  return freeInvoiceNumber(db, Number(suggestInvoiceNumberIn(db)) || 1, '')
}

/** The next number in the series, so the editor opens with one filled in. */
export function suggestInvoiceNumber(): string {
  return suggestInvoiceNumberIn(getDb())
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
  const existing = db
    .prepare(`SELECT created_at, status, allow_credit_card FROM invoices WHERE id = ?`)
    .get(id) as
    | { created_at: string; status: string; allow_credit_card: number | null }
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

  /**
   * Set when the number asked for was already taken and this save had to move.
   * Reported back so the screen can say so — silently changing the number on a
   * document somebody is looking at is the failure this whole guard exists to
   * avoid a worse version of.
   */
  let renumberedFrom: string | null = null
  const run = db.transaction(() => {
    /**
     * CLAIM THE NUMBER HERE, not on the screen that suggested it.
     *
     * `suggestInvoiceNumber` is a READ. It reserves nothing, and two places call
     * it independently — the board holds one from its last refresh, and the
     * dropship step fetches its own when that flow starts. Nothing had been
     * saved in between, so both were handed the same number and both saved it:
     * two sales orders answering to 2337, which then go to QuickBooks as the
     * same DocNumber and produce two documents claiming one number.
     *
     * There was no guard anywhere. The column had no UNIQUE constraint and this
     * function stored whatever the form sent, so the collision was silent on
     * both sides.
     *
     * Resolved by MOVING rather than refusing. The operator did nothing wrong —
     * they filled in a form the app pre-filled — and failing their save would
     * lose the order to protect a label. The number moves up to the first free
     * one and `renumberedFrom` says so, which the screen reports.
     *
     * A number somebody TYPED is treated exactly the same. There is no way to
     * tell a typed number from a suggested one by the time it arrives here, and
     * two invoices sharing a number is the wrong outcome either way.
     */
    const asked = clean(input.invoiceNumber)
    let numberToStore = asked
    if (asked) {
      const clash = db
        .prepare(`SELECT 1 FROM invoices WHERE invoice_number = ? AND id <> ? LIMIT 1`)
        .get(asked, id)
      if (clash) {
        // Walk up from what they asked for when it is a number, so the result is
        // recognisably next to it. A non-numeric label falls back to the series.
        const from = Number(asked)
        numberToStore = freeInvoiceNumber(
          db,
          Number.isFinite(from) && from > 0 ? from + 1 : Number(suggestInvoiceNumberIn(db)),
          id
        )
        renumberedFrom = asked
      }
    }
    // ON THE ORDER'S OWN HISTORY, so the gap in the sequence is explainable a
    // year later. A number that silently moved is exactly the kind of thing
    // somebody rediscovers while reconciling and cannot account for.
    if (renumberedFrom) {
      recordOrderEvent('so', id, 'note', {
        detail: `Number ${renumberedFrom} was already taken, so this order is ${numberToStore}`,
        actorId,
        db
      })
    }
    db.prepare(
      `INSERT INTO invoices
         (id, invoice_number, customer_id, customer_name, email, terms, invoice_date, due_date,
          location, memo, message, send_later, class_name, status, qbo_id, qbo_doc_number,
          qbo_synced_at, total, carrier, service, tracking_number, payment_timing, allow_credit_card,
          bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country,
          created_by, created_at, updated_at)
       VALUES (@id, @invoiceNumber, @customerId, @customerName, @email, @terms, @invoiceDate,
               @dueDate, @location, @memo, @message, @sendLater, @className, 'draft',
               NULL, NULL, NULL, @total, @carrier, @service, @trackingNumber, @paymentTiming,
               @allowCreditCard,
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
         allow_credit_card = excluded.allow_credit_card,
         updated_at     = excluded.updated_at`
    ).run({
      id,
      invoiceNumber: numberToStore,
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
      /**
       * OFF UNLESS SOMEBODY SAYS OTHERWISE.
       *
       * This read "omitted means allowed" while the box was new and the point
       * was that nothing changed for callers written before it. The owner has
       * since asked for the opposite default, and a default that lives only in
       * the create form is not a default — the next caller to omit the field
       * would quietly start offering a card again.
       *
       * An EDIT is the exception, and it matters: this is an upsert, so every
       * save rewrites the column. A payload that omits the field on an existing
       * order must leave that order's own answer alone, or editing an address
       * on an invoice raised last month would silently withdraw a card button
       * the buyer has already been shown.
       */
      allowCreditCard:
        input.allowCreditCard === undefined
          ? existing
            ? existing.allow_credit_card === 0
              ? 0
              : 1
            : 0
          : input.allowCreditCard
            ? 1
            : 0,
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

    // The first line of the log, and only for a genuinely new order. A save that
    // edits a draft is not a creation, and stamping one on every keystroke would
    // fill the history with the same sentence.
    if (!existing) {
      recordOrderEvent('so', id, 'created', {
        toStage: 'draft',
        detail: `Raised for ${input.customerName.trim()}`,
        actorId,
        db
      })

      // The deal ticket, struck on the same condition and in the same
      // transaction — see @shared/dealTickets, and createPurchaseOrder for the
      // matching call on the buy side.
      //
      // ON FIRST SAVE, INCLUDING A DRAFT. A draft sales order is already a real
      // commitment on this floor: it is on the board, it is being picked
      // against, and it is the thing somebody rings up about. Waiting for it to
      // post would leave the movement everybody is discussing without the number
      // they would discuss it by. A draft later abandoned burns its number, and
      // that is correct — a gap in a register means a deal that fell through,
      // which is a fact worth being able to see.
      issueDealTicket(db, {
        kind: 'sales_order',
        documentKind: 'so',
        documentId: id,
        documentNumber: clean(input.invoiceNumber),
        party: input.customerName.trim(),
        amount: invoiceTotal(lines),
        issuedAt: stamp,
        actorId
      })
    }

    // Same rule on the sell side: the carrier box on the form is the order's
    // first parcel, not a second store. Idempotent, so re-saving a draft that
    // has since been split into three boxes adds nothing.
    adoptLegacyFreight(
      'so',
      id,
      {
        carrier: input.carrier ?? null,
        service: input.service ?? null,
        trackingNumber: input.trackingNumber ?? null
      },
      actorId,
      db
    )

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
 * Bind a sales order to the purchase order it was raised against.
 *
 * ## Two documents, two events, one deal
 *
 * A dropship is a purchase and a sale that happen to be about the same boxes,
 * and the owner's requirement was explicit: two individual records, synced,
 * each specific to its own half of the process. So this writes the pointer on
 * BOTH rows and an event on BOTH logs — the purchase order's log says what it
 * was sold as, the sales order's log says what it was bought as, and each reads
 * correctly to somebody who only ever opens one of them.
 *
 * ## By id, in one transaction
 *
 * Never by number: sync rewrites `po_number` on a cross-machine collision and
 * `invoice_number` is neither unique nor relabelled, so a link keyed on either
 * would silently repoint at whatever order inherited it. And both writes commit
 * together, because a half-written link is a purchase order claiming a sale that
 * does not point back — which is worse than no link, since it reads as one.
 *
 * Refuses to steal a link that already exists. Re-running the flow against an
 * order already paired would otherwise orphan the first sale silently.
 */
export function linkDropshipPair(
  poId: string,
  invoiceId: string,
  actorId: string | null
): { ok: boolean; error?: string } {
  const db = getDb()
  const run = db.transaction((): { ok: boolean; error?: string } => {
    const po = db
      .prepare(`SELECT po_number, supplier, linked_invoice_id FROM purchase_orders WHERE id = ?`)
      .get(poId) as
      | { po_number: string; supplier: string | null; linked_invoice_id: string | null }
      | undefined
    if (!po) return { ok: false, error: 'That purchase order is gone.' }
    const invoice = db
      .prepare(`SELECT invoice_number, customer_name, source_po_id, total FROM invoices WHERE id = ?`)
      .get(invoiceId) as
      | {
          invoice_number: string | null
          customer_name: string
          source_po_id: string | null
          total: number
        }
      | undefined
    if (!invoice) return { ok: false, error: 'That sales order is gone.' }

    if (po.linked_invoice_id && po.linked_invoice_id !== invoiceId) {
      return { ok: false, error: `${po.po_number} is already linked to another sales order.` }
    }
    if (invoice.source_po_id && invoice.source_po_id !== poId) {
      return { ok: false, error: 'That sales order already came from another purchase order.' }
    }

    const stamp = nowIso()
    db.prepare(`UPDATE purchase_orders SET linked_invoice_id = ?, updated_at = ? WHERE id = ?`).run(
      invoiceId,
      stamp,
      poId
    )
    db.prepare(`UPDATE invoices SET source_po_id = ?, updated_at = ? WHERE id = ?`).run(
      poId,
      stamp,
      invoiceId
    )

    const soLabel = invoice.invoice_number ? `sales order ${invoice.invoice_number}` : 'a sales order'
    recordOrderEvent('po', poId, 'link', {
      detail: `Dropship — sold on to ${invoice.customer_name} as ${soLabel}`,
      actorId,
      db
    })
    recordOrderEvent('so', invoiceId, 'link', {
      detail: `Dropship — bought from ${po.supplier ?? 'a supplier'} on ${po.po_number}`,
      actorId,
      db
    })

    // Both tickets keep their numbers and change their KIND. The two documents
    // have just been declared one deal, and the register is where somebody asks
    // what was dropshipped — see markDropshipPair for why re-issuing would be
    // the wrong repair.
    markDropshipPair(db, poId, invoiceId)
    return { ok: true }
  })
  return run()
}

/** The other half of a dropship pair, or null when there is not one. */
export function linkedDropshipInvoice(poId: string): InvoiceDetail | null {
  const row = getDb()
    .prepare(`SELECT linked_invoice_id AS id FROM purchase_orders WHERE id = ?`)
    .get(poId) as { id: string | null } | undefined
  return row?.id ? getInvoice(row.id) : null
}

/**
 * Record that a buyer paid, and — usually — release the order to be picked.
 *
 * ## Payment and readiness are two facts, not one
 *
 * The buy side has worked this way all along: `setPurchaseOrderPaid` records
 * money WITHOUT moving a purchase order's stage, precisely so a
 * received-but-unpaid order is not dragged backwards to say the money arrived.
 * The sell side had no equivalent — the only way to record that a buyer had paid
 * was to drag the card to Paid, which is the LAST column, so an order paid up
 * front looked finished before anybody had picked a single box.
 *
 * So this writes up to three separate things and the caller chooses which:
 * the payment itself, the stage move, and the release to the packing floor. A
 * deposit against a bigger order is payment with no stage move; a trusted buyer
 * on terms is a release with no payment at all.
 *
 * ## It refuses on a voided order and nothing else
 *
 * Deliberately not gated on the stage. A draft settled in cash before it was
 * ever posted is the ordinary case on this floor — that is what `draft → paid`
 * exists for in INVOICE_TRANSITIONS — and a rule that made somebody post an
 * invoice they had already been paid for would simply be worked around.
 */
export function recordInvoicePayment(
  id: string,
  input: InvoicePaymentInput,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const run = db.transaction((): { invoice: InvoiceDetail | null; error?: string } => {
    const row = db
      .prepare(`SELECT status, total, invoice_number FROM invoices WHERE id = ?`)
      .get(id) as { status: string; total: number; invoice_number: string | null } | undefined
    if (!row) return { invoice: null, error: 'That order is gone.' }
    if (asStatus(row.status) === 'void') {
      return { invoice: getInvoice(id), error: 'That order was voided, so it cannot take a payment.' }
    }

    const problem = validateInvoicePayment(input, row.total)
    if (problem) return { invoice: getInvoice(id), error: problem }

    const stamp = nowIso()
    const amount = money(
      input.amount === undefined || input.amount === null ? row.total : input.amount
    )
    const markPaid = input.markPaid !== false
    const ready = input.readyToShip !== false

    db.prepare(
      `UPDATE invoices
          SET paid_up_front = 1,
              payment_method = COALESCE(?, payment_method),
              payment_reference = COALESCE(?, payment_reference),
              paid_at = COALESCE(paid_at, ?),
              paid_by = COALESCE(paid_by, ?),
              ready_to_ship_at = CASE WHEN ? THEN COALESCE(ready_to_ship_at, ?) ELSE ready_to_ship_at END,
              ready_to_ship_by = CASE WHEN ? THEN COALESCE(ready_to_ship_by, ?) ELSE ready_to_ship_by END,
              updated_at = ?
        WHERE id = ?`
    ).run(
      (input.method ?? '').trim() || null,
      (input.reference ?? '').trim() || null,
      stamp,
      actorId,
      ready ? 1 : 0,
      stamp,
      ready ? 1 : 0,
      actorId,
      stamp,
      id
    )

    const how = (input.method ?? '').trim()
    recordOrderEvent('so', id, 'paid', {
      detail:
        `Paid up front — ${amount.toFixed(2)}` +
        (how ? ` by ${how}` : '') +
        ((input.reference ?? '').trim() ? ` (${(input.reference as string).trim()})` : ''),
      actorId,
      db
    })

    // THE STAGE MOVE IS LAST and goes through the ordinary machinery, so it is
    // checked against INVOICE_TRANSITIONS and logged like every other move.
    // Writing 'paid' straight into the column here would skip both and put the
    // one status nothing can move off behind a check nobody performed.
    if (markPaid && canMoveInvoice(asStatus(row.status), 'paid')) {
      setInvoiceStatus(id, 'paid', actorId)
    }
    if (ready) {
      recordOrderEvent('so', id, 'ready', {
        detail: 'Released to be picked and packed',
        actorId,
        db
      })
    }
    return { invoice: getInvoice(id) }
  })
  return run()
}

/**
 * Say whether the money has arrived.
 *
 * The other half of splitting the stage from the fact. Marking an order paid
 * does NOT move it — it may already be sitting in Payment, and dragging it
 * somewhere on a tick would be the app deciding what the board should look like
 * on somebody's behalf.
 *
 * Refused on a void, which is owed nothing and owes nothing.
 *
 * QUICKBOOKS IS NOT OVERWRITTEN. `qbo_paid_at` is Intuit's own record of an
 * applied payment and this never touches it — `isInvoicePaid` prefers it, so an
 * order the books say is paid stays paid whatever is ticked here. Un-marking one
 * of those is not a thing this app can do, and pretending otherwise would put a
 * screen at odds with the ledger.
 */
export function setInvoicePaid(
  id: string,
  paid: boolean,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const row = db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(id) as
    | { status: string }
    | undefined
  if (!row) return { invoice: null, error: 'That order is gone.' }
  if (asStatus(row.status) === 'void') {
    return { invoice: getInvoice(id), error: 'That order was voided.' }
  }
  const stamp = nowIso()
  db.prepare(
    `UPDATE invoices SET paid_at = ?, paid_by = ?, updated_at = ? WHERE id = ?`
  ).run(paid ? stamp : null, paid ? actorId : null, stamp, id)
  recordOrderEvent('so', id, 'paid', {
    detail: paid ? 'Marked paid' : 'Marked not paid — the payment was withdrawn',
    actorId,
    db
  })
  return { invoice: getInvoice(id) }
}

/**
 * Release an order to the packing floor, or take it back off.
 *
 * Separate from payment because the two genuinely come apart: a trusted buyer on
 * Net 30 is ready to ship and has paid nothing, and an order paid by deposit is
 * paid and not ready. Refused on a void, which has no boxes left to pick.
 */
export function setInvoiceReadyToShip(
  id: string,
  ready: boolean,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const row = db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(id) as
    | { status: string }
    | undefined
  if (!row) return { invoice: null, error: 'That order is gone.' }
  if (asStatus(row.status) === 'void') {
    return { invoice: getInvoice(id), error: 'That order was voided.' }
  }
  const stamp = nowIso()
  db.prepare(
    `UPDATE invoices
        SET ready_to_ship_at = ?, ready_to_ship_by = ?, updated_at = ?
      WHERE id = ?`
  ).run(ready ? stamp : null, ready ? actorId : null, stamp, id)
  recordOrderEvent('so', id, 'ready', {
    detail: ready ? 'Released to be picked and packed' : 'Taken back off the packing list',
    actorId,
    db
  })
  return { invoice: getInvoice(id) }
}

/** Refuse to touch an order that is gone or voided, in one place. */
function liveInvoiceOr(
  db: Database.Database,
  id: string
): { ok: true } | { ok: false; result: { invoice: InvoiceDetail | null; error: string } } {
  const row = db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(id) as
    | { status: string }
    | undefined
  if (!row) return { ok: false, result: { invoice: null, error: 'That order is gone.' } }
  if (asStatus(row.status) === 'void') {
    return { ok: false, result: { invoice: getInvoice(id), error: 'That order was voided.' } }
  }
  return { ok: true }
}

/**
 * Weigh and measure the box.
 *
 * All four together or all four cleared. A carrier prices a case on dimensional
 * weight, so three of the four buys nothing — and `hasDims` reads a partial set
 * as unmeasured anyway, which would leave the order sitting in Awaiting dims
 * with numbers on its card, looking like the board was broken.
 */
export function setInvoiceDims(
  id: string,
  dims: { weightLb: number | null; lengthIn: number | null; widthIn: number | null; heightIn: number | null },
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const guard = liveInvoiceOr(db, id)
  if (!guard.ok) return guard.result

  const at = (v: number | null): number | null => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const weightLb = at(dims.weightLb)
  const lengthIn = at(dims.lengthIn)
  const widthIn = at(dims.widthIn)
  const heightIn = at(dims.heightIn)
  for (const v of [weightLb, lengthIn, widthIn, heightIn]) {
    if (v !== null && v > 10000) return { invoice: getInvoice(id), error: 'That is not a parcel.' }
  }

  const stamp = nowIso()
  db.prepare(
    `UPDATE invoices
        SET ship_weight_lb = ?, ship_length_in = ?, ship_width_in = ?, ship_height_in = ?,
            updated_at = ?
      WHERE id = ?`
  ).run(weightLb, lengthIn, widthIn, heightIn, stamp, id)

  const measured = hasDims({ weightLb, lengthIn, widthIn, heightIn })
  recordOrderEvent('so', id, 'ready', {
    detail: measured
      ? `Measured — ${describeDims({ weightLb, lengthIn, widthIn, heightIn })}`
      : 'Measurements cleared',
    actorId,
    db
  })
  return { invoice: getInvoice(id) }
}

/**
 * Somebody confirmed the goods are in hand.
 *
 * ONLY MEANINGFUL ON A DROPSHIP, and that is not enforced here on purpose: a
 * stock order answers this question from its own shelf (see itemsInHand), so
 * setting the flag on one changes nothing and refusing it would be a button
 * that errors for no reason the operator can see. The gate reads what it needs.
 */
export function setInvoiceItemsInHand(
  id: string,
  inHand: boolean,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const guard = liveInvoiceOr(db, id)
  if (!guard.ok) return guard.result
  const stamp = nowIso()
  db.prepare(
    `UPDATE invoices
        SET items_in_hand_at = ?, items_in_hand_by = ?, updated_at = ?
      WHERE id = ?`
  ).run(inHand ? stamp : null, inHand ? actorId : null, stamp, id)
  recordOrderEvent('so', id, 'ready', {
    detail: inHand
      ? 'Goods confirmed in hand'
      : 'Goods no longer confirmed in hand — back to Awaiting items',
    actorId,
    db
  })
  return { invoice: getInvoice(id) }
}

/**
 * Send it anyway.
 *
 * The owner's case: a buyer on up-front terms whose package is going out
 * regardless. It clears every gate — see forcedReady — so it is recorded as its
 * own fact with its own author, rather than by faking the thing it is
 * overriding. Somebody reading this order in six months can see that a person
 * decided, and which person.
 */
export function setInvoiceForceReady(
  id: string,
  forced: boolean,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const guard = liveInvoiceOr(db, id)
  if (!guard.ok) return guard.result
  const stamp = nowIso()
  db.prepare(
    `UPDATE invoices
        SET force_ready_at = ?, force_ready_by = ?, updated_at = ?
      WHERE id = ?`
  ).run(forced ? stamp : null, forced ? actorId : null, stamp, id)
  recordOrderEvent('so', id, 'ready', {
    detail: forced
      ? 'Moved to Ready to ship by hand, ahead of the usual gates'
      : 'Manual release withdrawn — back to the usual gates',
    actorId,
    db
  })
  return { invoice: getInvoice(id) }
}

/**
 * Everything the fulfilment board draws, oldest first.
 *
 * ONE READ FOR ALL THREE COLUMNS, because the column an order belongs in is
 * derived — `fulfillmentStageOf` in @shared/fulfillment — and three queries each
 * spelling one of those gates in SQL is three chances to disagree with the rule
 * the cards are labelled by.
 *
 * Drafts are IN. An order can be in hand, measured and on delivery terms while
 * it is still a draft in this app, and the boxes do not care that nobody has
 * posted it to QuickBooks yet. Voids are excluded here rather than filtered
 * later, since nothing about them is ever packable.
 *
 * Oldest first, for the reason listAwaitingShipment is: it is a QUEUE, and a
 * newest-first packing list leaves somebody's order at the bottom for a
 * fortnight.
 */
export function listFulfillment(limit = 400): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          WHERE status != 'void'
          ORDER BY invoice_date ASC, created_at ASC LIMIT ?`
      )
      .all(Math.max(1, Math.min(2000, limit))) as InvoiceRow[]
  ).map(toInvoice)
}

/**
 * Everything waiting to be picked, oldest first.
 *
 * Oldest first because it is a QUEUE: the order that has been waiting longest is
 * the one to do next, and a newest-first packing list quietly leaves somebody's
 * order at the bottom for a fortnight.
 */
export function listAwaitingShipment(limit = 200): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          WHERE ready_to_ship_at IS NOT NULL AND status != 'void'
          ORDER BY ready_to_ship_at ASC LIMIT ?`
      )
      .all(Math.max(1, Math.min(1000, limit))) as InvoiceRow[]
  ).map(toInvoice)
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
    // Read BEFORE the write, so the log can say what it moved from. Reading
    // after would report the new stage twice and lose the only fact the entry
    // is worth writing for.
    const before = db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(id) as
      | { status: string }
      | undefined
    const moved =
      db
        .prepare(
          /**
           * REACHING THE PAYMENT STAGE IS NOT BEING PAID.
           *
           * This used to stamp paid_at the moment an order landed in what was
           * then called Paid, which made the stage and the money one fact. The
           * column is Payment now — the settling-up step — and whether the
           * money arrived is marked inside it (setInvoicePaid) or read from
           * QuickBooks. See isInvoicePaid.
           *
           * The clearing arm STAYS, and only for a void: an order that has been
           * cancelled has not been paid, whatever it said a moment ago. Moving
           * BACKWARDS off Payment no longer wipes a real payment date either,
           * which the old rule did — silently, on a drag.
           */
          `UPDATE invoices
              SET status  = ?,
                  paid_at = CASE WHEN ? = 'void' THEN NULL ELSE paid_at END,
                  paid_by = CASE WHEN ? = 'void' THEN NULL ELSE paid_by END,
                  ready_to_ship_at = CASE WHEN ? = 'void' THEN NULL ELSE ready_to_ship_at END,
                  ready_to_ship_by = CASE WHEN ? = 'void' THEN NULL ELSE ready_to_ship_by END,
                  updated_at = ?
            WHERE id = ?`
        )
        .run(status, status, status, status, status, stamp, id).changes > 0
    // VOIDING UN-READIES IT. An order whose stock has just been handed back is
    // not waiting to be picked, and leaving it on the packing floor's list is
    // how somebody goes looking for boxes that are back on the shelf.
    if (moved) {
      recordOrderEvent('so', id, 'stage', {
        fromStage: before?.status ?? null,
        toStage: status,
        actorId,
        db
      })
    }
    return moved
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
    /**
     * THE PURCHASE ORDER ON THE OTHER END LETS GO FIRST.
     *
     * The mirror of what deletePurchaseOrder does, and broken the same way:
     * `purchase_orders.linked_invoice_id` has no foreign key behind it, so this
     * row's departure left the order claiming a sale that no longer exists —
     * and `linkDropshipPair` refuses an order that already carries a pointer, so
     * it could never be sold on to anybody else. See the v80 migration.
     */
    const linkedPos = db
      .prepare(`SELECT id, po_number FROM purchase_orders WHERE linked_invoice_id = ?`)
      .all(id) as Array<{ id: string; po_number: string }>
    for (const po of linkedPos) {
      db.prepare(
        `UPDATE purchase_orders SET linked_invoice_id = NULL, updated_at = ? WHERE id = ?`
      ).run(nowIso(), po.id)
      recordOrderEvent('po', po.id, 'link', {
        detail: 'Dropship link cleared — the sales order it was sold on to was deleted',
        actorId: null,
        db
      })
    }

    // The shelf first, and BEFORE the row goes: invoice_stock_moves cascades on
    // the invoice, so deleting the header first would take the receipt with it
    // and there would be nothing left to say which layers to restore. The boxes
    // would simply be gone, with a cost basis attached to a document that no
    // longer exists.
    releaseInvoiceStock(db, id)
    db.prepare(`DELETE FROM invoice_lines WHERE invoice_id = ?`).run(id)
    // The parcels and the paperwork go with the order; the EVENTS stay. A
    // deleted sales order is itself a thing that happened, and the log is the
    // only place left that would say so.
    deleteOrderExtras('so', id, db)
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
          -- A DROPSHIPPED LINE IS NOT PICKABLE, and leaving it out of this queue
          -- is the whole of the fix.
          --
          -- The units went from the supplier straight to the buyer; this
          -- business never held them, so there is nothing on any shelf to scan
          -- out. But the line's qty_fulfilled stays 0 for ever precisely BECAUSE
          -- nothing left here, which made it look permanently outstanding — so
          -- it was offered to the scanner, and scanning it called fulfilSalesLine
          -- and adjustStock, taking real boxes off a real shelf for units that
          -- were never on it.
          --
          -- Rare while dropship sales orders were hand-typed; routine the moment
          -- they are raised by the dropship flow. The test is the line's own
          -- destination falling back to the header, which is the same rule
          -- destinationHoldsStock applies everywhere else — spelled in SQL here
          -- because this runs in the database, and case-folded because a
          -- hand-typed 'rm' is the RM shelf.
          AND UPPER(COALESCE(NULLIF(TRIM(l.destination), ''), i.location, 'RM'))
              IN ('RM', 'AM')
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

