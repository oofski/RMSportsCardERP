import { randomUUID } from 'crypto'
import {
  DEFAULT_INVOICE_TERMS,
  INVOICE_TERMS,
  INVOICE_TERMS_OFFERED,
  asPushState,
  isSettledInvoice,
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
import {
  applyInvoiceStock,
  invoiceStockLocation,
  releaseInvoiceStock,
  type InvoiceStockLine,
  type InvoiceStockMove
} from './invoiceStock'
import {
  allocationProblem,
  effectiveSlices,
  stockUnitsOf,
  type InvoiceAllocationInput,
  type InvoiceLineAllocation
} from '@shared/invoiceAllocations'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import type { LinkablePurchaseOrder } from '@shared/orders'
import { adoptLegacyFreight, deleteOrderExtras, recordOrderEvent } from './orderExtras'
import { describeDims, hasDims, readyToShipBlockedReason } from '@shared/fulfillment'
import { dealTicketRefFor } from './dealTickets'
import { foldTicketIntoDocument, issueDealTicket, markDropshipPair } from './dealTickets'
import { isOpenTab } from '@shared/roadshowTab'
import { addSaleLink, listSaleLinks } from './salePurchaseLinks'
import { soleSourceOrder } from '@shared/poStock'

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

/**
 * A postage figure on the way in. Null when nobody said, never negative.
 *
 * Zero survives as zero: "this one went free" is an answer, and it is not the
 * same as an empty box.
 */
function shippingIn(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100) / 100
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
 * The SHIP-TO half, on the same two tables and read by the same helpers.
 *
 * Optional on the interface rather than required, because a packaged main older
 * than v91 selects rows without these columns and would otherwise typecheck into
 * something it cannot produce. Absent reads as blank, which reads as "the same
 * place the bill goes" — see shipToAddress.
 */
interface ShipAddressRow {
  ship_line1?: string | null
  ship_line2?: string | null
  ship_city?: string | null
  ship_region?: string | null
  ship_postal_code?: string | null
  ship_country?: string | null
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

/** The ship-to columns off a row. Same rule: all blank reads as absent. */
function toShipAddress(r: ShipAddressRow): InvoiceAddress | null {
  const a: InvoiceAddress = {
    line1: r.ship_line1 ?? null,
    line2: r.ship_line2 ?? null,
    city: r.ship_city ?? null,
    region: r.ship_region ?? null,
    postalCode: r.ship_postal_code ?? null,
    country: r.ship_country ?? null
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

function shipAddressParams(a: InvoiceAddress | null | undefined): {
  shipLine1: string | null
  shipLine2: string | null
  shipCity: string | null
  shipRegion: string | null
  shipPostalCode: string | null
  shipCountry: string | null
} {
  return {
    shipLine1: clean(a?.line1),
    shipLine2: clean(a?.line2),
    shipCity: clean(a?.city),
    shipRegion: clean(a?.region),
    shipPostalCode: clean(a?.postalCode),
    shipCountry: clean(a?.country)
  }
}

const ADDRESS_COLS = `bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country`
/**
 * WHERE THE BOX GOES, selected alongside the bill-to everywhere it is.
 *
 * A separate constant rather than six more names inside ADDRESS_COLS, because
 * the two are read by different code for different jobs — the bill-to goes to
 * QuickBooks, the ship-to goes on a label — and a single blob would make it
 * impossible to see at a call site which of the two a query was actually after.
 */
const SHIP_ADDRESS_COLS = `ship_line1, ship_line2, ship_city, ship_region, ship_postal_code, ship_country`

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

interface CustomerRow extends AddressRow, ShipAddressRow {
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
    shipAddr: toShipAddress(r),
    qboId: r.qbo_id,
    active: r.active === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const CUSTOMER_COLS = `id, name, email, phone, mobile, terms, location, class_name, message, notes,
                       qbo_id, ${ADDRESS_COLS}, ${SHIP_ADDRESS_COLS},
                       active, created_at, updated_at`

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
  /**
   * Where this buyer's goods usually go, when that is not where the bill goes.
   *
   * Its own field and its own whole-or-nothing flag on the upsert, deliberately
   * not folded in with billAddr: typing a billing address on a buyer who has a
   * different ship-to must not blank the ship-to.
   */
  shipAddr?: InvoiceAddress | null
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
        ship_line1, ship_line2, ship_city, ship_region, ship_postal_code, ship_country,
        active, is_customer, created_at, updated_at)
     VALUES (@id, @name, @email, @phone, @mobile, @terms, @location, @className, @message, @notes,
             @qboId,
             @billLine1, @billLine2, @billCity, @billRegion, @billPostalCode, @billCountry,
             @shipLine1, @shipLine2, @shipCity, @shipRegion, @shipPostalCode, @shipCountry,
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
       -- THE SHIP-TO MOVES AS A WHOLE TOO, on its OWN flag. Sharing the bill-to's
       -- would tie the two together: typing a billing address on a buyer who has
       -- a different ship-to would blank the ship-to, which is the exact mistake
       -- the whole-or-nothing rule above exists to prevent, one field wider.
       ship_line1       = CASE WHEN @hasShipAddress = 1 THEN excluded.ship_line1
                               ELSE invoice_customers.ship_line1 END,
       ship_line2       = CASE WHEN @hasShipAddress = 1 THEN excluded.ship_line2
                               ELSE invoice_customers.ship_line2 END,
       ship_city        = CASE WHEN @hasShipAddress = 1 THEN excluded.ship_city
                               ELSE invoice_customers.ship_city END,
       ship_region      = CASE WHEN @hasShipAddress = 1 THEN excluded.ship_region
                               ELSE invoice_customers.ship_region END,
       ship_postal_code = CASE WHEN @hasShipAddress = 1 THEN excluded.ship_postal_code
                               ELSE invoice_customers.ship_postal_code END,
       ship_country     = CASE WHEN @hasShipAddress = 1 THEN excluded.ship_country
                               ELSE invoice_customers.ship_country END,
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
    ...shipAddressParams(input.shipAddr),
    // An edit that carries no address at all leaves the stored one alone. The
    // buyer form is not the only thing that saves a customer — writing one from
    // the invoice screen passes a name and an email and nothing else, and that
    // must not wipe an address somebody typed.
    hasAddress: hasAddress(input.billAddr) ? 1 : 0,
    hasShipAddress: hasAddress(input.shipAddr) ? 1 : 0,
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

interface InvoiceRow extends AddressRow, ShipAddressRow {
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
  source_po_count: number | null
  stock_units: number | null
  drop_units: number | null
  drawn_units: number | null
  tracked_parcels: number | null
  last_tracked_at: string | null
  drop_supplier_count: number | null
  drop_supplier: string | null
  source_po_supplier: string | null
  source_po_number: string | null
  ship_weight_lb: number | null
  ship_length_in: number | null
  ship_width_in: number | null
  ship_height_in: number | null
  items_in_hand_at: string | null
  items_in_hand_by: string | null
  force_ready_at: string | null
  force_ready_by: string | null
  shipping_cost: number | null
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
  source_po_id: string | null
  source_po_number: string | null
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
    shipAddr: toShipAddress(r),
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
    sourcePoNumber: (r.source_po_number ?? '').trim() || null,
    /**
     * WHO SHIPS IT, worked out here so no screen has to know the order.
     *
     * The lines first, and only when they AGREE: a mixed sale can have two
     * suppliers shipping two halves, and naming one of them would send somebody
     * to the wrong building. Then the source purchase order's supplier, which
     * is what a sale raised by dropshipSaleFromPurchase inherits and never
     * writes onto its own lines. Null when neither answers, which is the
     * ordinary state of a sale off our own shelf.
     */
    dropSupplier:
      Number(r.drop_supplier_count) === 1
        ? (r.drop_supplier ?? '').trim() || null
        : Number(r.drop_supplier_count) > 1
          ? null
          : (r.source_po_supplier ?? '').trim() || null,
    dropSupplierCount: Number(r.drop_supplier_count) || 0,
    trackedParcels: Number(r.tracked_parcels) || 0,
    lastTrackedAt: r.last_tracked_at ?? null,
    sourcePoCount: Number(r.source_po_count) || 0,
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
    // What POSTING it cost us. Never a charge to the buyer, so it is not in
    // `total` and never reaches QuickBooks — see the v82 note.
    shippingCost: r.shipping_cost == null ? null : Number(r.shipping_cost),
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
function toLine(
  r: LineRow,
  headerLocation: string,
  allocations: InvoiceLineAllocation[] = []
): InvoiceLine {
  const destination = (r.destination ?? '').trim() || headerLocation
  return {
    allocations,
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
    sourcePoId: r.source_po_id ?? null,
    sourcePoNumber: (r.source_po_number ?? '').trim() || null,
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
                      ${SHIP_ADDRESS_COLS},
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
                      -- READ OFF invoice_unit_sources, THE VIEW, and not off the
                      -- lines. A line split by quantity is eight units off the
                      -- shelf and two shipped direct, and counting the LINE puts
                      -- all ten on one side of that -- so a part-dropship order
                      -- would report as wholly one thing and the board's
                      -- Awaiting items gate would be answering about units that
                      -- were never coming. The view's second arm reproduces the
                      -- inheritance these subqueries used to spell out inline (a
                      -- blank line destination takes the order's, a blank order
                      -- location means RM), so an unsplit sale counts exactly
                      -- what it counted before.
                      (SELECT COALESCE(SUM(CASE WHEN UPPER(u.destination) IN ('RM', 'AM')
                                                THEN u.quantity ELSE 0 END), 0)
                         FROM invoice_unit_sources u WHERE u.invoice_id = invoices.id)
                        AS stock_units,
                      (SELECT COALESCE(SUM(CASE WHEN UPPER(u.destination) IN ('RM', 'AM')
                                                THEN 0 ELSE u.quantity END), 0)
                         FROM invoice_unit_sources u WHERE u.invoice_id = invoices.id)
                        AS drop_units,
                      -- THE FULFILMENT GATES. See @shared/fulfillment.
                      ship_weight_lb, ship_length_in, ship_width_in, ship_height_in,
                      items_in_hand_at, items_in_hand_by, force_ready_at, force_ready_by,
                      shipping_cost,
                      -- WHAT THE SHELF ACTUALLY GAVE, which is not always what was
                      -- asked for: applyInvoiceStock takes MIN(asked, on hand), so a
                      -- sale for ten boxes against three draws three and leaves seven
                      -- owed. Compared against stock_units above, this is the only
                      -- honest signal that a stock order is not yet fillable -- and
                      -- without it Awaiting items could only ever speak for dropships.
                      (SELECT COALESCE(SUM(m.quantity), 0)
                         FROM invoice_stock_moves m WHERE m.invoice_id = invoices.id) AS drawn_units,
                      -- HAS ANY OF THIS SHIPPED?
                      --
                      -- The header tracking column is only half the answer. A
                      -- four-box order split across two labels has two rows in
                      -- order_shipments and may carry nothing on the header at
                      -- all, so a board reading only the header reports a fully
                      -- shipped order as not shipped. Counted rather than
                      -- fetched: the card needs a yes-or-no, and the parcels
                      -- themselves are read when somebody opens the order.
                      (SELECT COUNT(*) FROM order_shipments s
                        WHERE s.order_kind = 'so' AND s.order_id = invoices.id
                          AND TRIM(COALESCE(s.tracking_number, '')) != '') AS tracked_parcels,
                      -- WHEN IT WENT, as near as this app can honestly say.
                      --
                      -- Nothing stamps "shipped" here, deliberately -- see
                      -- shipChip in @shared/orderStatus: a tracking number IS
                      -- the event, and a second flag beside it would be a fact
                      -- that could disagree with the one the carrier answers
                      -- about. So the instant is the moment the NUMBER appeared,
                      -- which is this row's created_at, and a header number
                      -- adopted by adoptLegacyFreight gets a row too -- so every
                      -- number the app knows about is covered.
                      --
                      -- MAX, not MIN: a four-box order split over two labels is
                      -- out the door when the LAST label exists. Taking the
                      -- first would start the settle clock while boxes were
                      -- still on the bench.
                      (SELECT MAX(s.created_at) FROM order_shipments s
                        WHERE s.order_kind = 'so' AND s.order_id = invoices.id
                          AND TRIM(COALESCE(s.tracking_number, '')) != '') AS last_tracked_at,
                      -- WHO IS SHIPPING THIS, on a dropship.
                      --
                      -- The sale knows source_po_id and nothing about who the
                      -- supplier IS, so a dropship card could say it was a
                      -- dropship and never say from whom -- which is the one
                      -- fact somebody needs to chase it, or to send the label.
                      --
                      -- THE LINE WINS OVER THE ORDER. A line carries its own
                      -- supplier for the mixed case, where two suppliers ship
                      -- two halves of one sale; a blank line supplier means the
                      -- source purchase order's, which is what
                      -- dropshipSaleFromPurchase leaves behind. Only reported
                      -- when the whole thing agrees -- MIN over DISTINCT with a
                      -- COUNT beside it -- because naming one of two suppliers
                      -- would point somebody at the wrong building, the same
                      -- rule the provenance read keeps about destinations.
                      --
                      -- Off the view as well, so a line split into "eight off
                      -- the shelf, two shipped by Kestrel" can name Kestrel. The
                      -- unsplit arm carries l.supplier verbatim, so an ordinary
                      -- sale answers exactly what it answered before.
                      (SELECT COUNT(DISTINCT TRIM(u.supplier)) FROM invoice_unit_sources u
                        WHERE u.invoice_id = invoices.id
                          AND TRIM(COALESCE(u.supplier, '')) != '') AS drop_supplier_count,
                      (SELECT MIN(TRIM(u.supplier)) FROM invoice_unit_sources u
                        WHERE u.invoice_id = invoices.id
                          AND TRIM(COALESCE(u.supplier, '')) != '') AS drop_supplier,
                      (SELECT po.supplier FROM purchase_orders po
                        WHERE po.id = invoices.source_po_id) AS source_po_supplier,
                      (SELECT po.po_number FROM purchase_orders po
                        WHERE po.id = invoices.source_po_id) AS source_po_number,
                      -- HOW MANY PURCHASES SUPPLY THIS SALE.
                      --
                      -- Not derivable from source_po_id, and that is the point:
                      -- that column is the SOLE link or NULL, so a sale with
                      -- three purchases and a sale with none both read NULL
                      -- there. The card needs to tell those two apart -- one has
                      -- nothing to show and the other has three -- so the count
                      -- comes off the link table itself.
                      (SELECT COUNT(*) FROM sale_purchase_links sl
                        WHERE sl.invoice_id = invoices.id) AS source_po_count`

const LINE_COLS = `id, invoice_id, position, item, product_id, sku, description, quantity, rate,
                   amount, tax_rate, class_name, qty_fulfilled, fulfilled_at,
                   destination, supplier, source_po_id,
                   -- The NUMBER beside the id, because a screen prints PO-0042 and
                   -- nothing prints a uuid. A LEFT join by subquery rather than a
                   -- real one: a purchase order deleted after the sale went out
                   -- leaves the line saying nothing rather than dropping it, which
                   -- is the same bargain source_po_id makes on the header.
                   (SELECT po.po_number FROM purchase_orders po
                     WHERE po.id = invoice_lines.source_po_id) AS source_po_number`

/**
 * EVERY sales order, newest first — a list is read from the top.
 *
 * Deliberately unfiltered, and deliberately NOT what the board draws. This is
 * the answer to "what invoices are there", which the CSV export asks when
 * somebody exports without selecting any: an export that quietly left out
 * finished orders would be a different document from the one its name promises.
 * The board's question is narrower and has its own function below.
 *
 * The limit is a backstop against an unbounded read on a table that only grows,
 * not a statement about which orders matter. It used to be 200, which was small
 * enough to be a silent truncation on a real year's trading.
 */
export function listInvoices(limit = 2000): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          ORDER BY invoice_date DESC, created_at DESC LIMIT ?`
      )
      .all(Math.max(1, Math.min(5000, limit))) as InvoiceRow[]
  ).map(toInvoice)
}

/**
 * The sales orders the BOARD draws — everything not yet finished with.
 *
 * ## Finished orders leave, exactly as they do on the buy side
 *
 * The owner asked why sales orders were not doing this. They never had it: the
 * sweep was born as a purchase-order feature — see `listPurchaseOrders`, which
 * filters on `isSettledPurchaseOrder` — and the sell-side board, a mirror of the
 * PO board in columns, cards, drag-and-drop and CSS, was never given one. A paid
 * sales order sat in Payment for ever, and 'paid' is terminal in
 * INVOICE_TRANSITIONS, so nobody could move it on either.
 *
 * A day after a sale is both PAID and SHIPPED it stops being drawn. The filter
 * is the whole mechanism: nothing is deleted, no status changes, no flag is
 * written, and Finance → History reads the same table unfiltered and shows the
 * order exactly as it always did. See `isSettledInvoice`, and read it beside
 * `isSettledPurchaseOrder` — same constant, same derivation, same reasoning.
 *
 * ## Filtered HERE rather than in the SQL above
 *
 * The rule is one function in @shared/invoices, shared with the renderer and
 * with the history view's `settled` flag. Restating it as a WHERE clause would
 * be a second copy that could disagree with the first — and it is the copy
 * nothing would test. The buy side filters in exactly the same place for
 * exactly this reason.
 */
export function listOpenInvoices(limit = 2000): Invoice[] {
  const now = Date.now()
  return listInvoices(limit).filter((invoice) => !isSettledInvoice(invoice, now))
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
  const splits = readLineAllocations(db, id)
  // DETAIL PATH ONLY, and guarded — see dealTicketRefFor. The list query must
  // not depend on the register, or a broken one stops orders being raised.
  return {
    ...head,
    ...dealTicketRefFor(db, 'so', id),
    // Every purchase this sale is linked to. The header's own `sourcePoId` is
    // the sole entry when there is one and null when there are several — see
    // syncSaleSourcePo — so this is the only complete answer.
    sourcePos: listSaleLinks(db, id),
    lines: lines.map((l) =>
      toLine(l, invoiceStockLocation(head.location), splits.get(l.id) ?? [])
    )
  }
}

/**
 * Every split on this order, by line id — ONE query, not one per line.
 *
 * An order of forty lines would otherwise cost forty round trips to read back a
 * table that is empty on almost every order in the database. Lines with no
 * splits are simply absent from the map, and `toLine` defaults them to `[]`,
 * which is the zero-rows case `effectiveSlices` reads as one implicit slice.
 */
function readLineAllocations(
  db: Database.Database,
  invoiceId: string
): Map<string, InvoiceLineAllocation[]> {
  const rows = db
    .prepare(
      `SELECT a.id, a.invoice_line_id, a.quantity, a.destination, a.supplier, a.source_po_id,
              (SELECT po.po_number FROM purchase_orders po WHERE po.id = a.source_po_id)
                AS source_po_number
         FROM invoice_line_allocations a
        WHERE a.invoice_id = ?
        ORDER BY a.position ASC, a.created_at ASC`
    )
    .all(invoiceId) as Array<{
    id: string
    invoice_line_id: string
    quantity: number
    destination: string
    supplier: string | null
    source_po_id: string | null
    source_po_number: string | null
  }>
  const out = new Map<string, InvoiceLineAllocation[]>()
  for (const r of rows) {
    const holdsStock = destinationHoldsStock(r.destination)
    const list = out.get(r.invoice_line_id) ?? []
    list.push({
      id: r.id,
      quantity: r.quantity,
      destination: r.destination,
      // Derived on read from the destination, exactly as a line's is, so a
      // slice cannot end up saying it holds stock at a customer's address.
      supplier: holdsStock ? null : (r.supplier ?? '').trim() || r.destination,
      holdsStock,
      // READ RAW, on a dropship slice as much as a stock one. This is where a
      // slice says WHERE ITS GOODS CAME FROM, and blanking it here is what used
      // to make provenance unrecordable on the roadshow open tabs the owner
      // ships direct. Nothing that spends money sees this value: everything
      // that costs a slice goes through `effectiveSlices`, which is the cost
      // view and blanks it when the slice draws no shelf.
      sourcePoId: r.source_po_id ?? null,
      sourcePoNumber: (r.source_po_number ?? '').trim() || null
    })
    out.set(r.invoice_line_id, list)
  }
  return out
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
 * AN ADDRESS TYPED ON AN ORDER IS REMEMBERED ON THE BUYER.
 *
 * The owner's ask: "if we add an address to a certain customer, next time we do
 * it, it auto-populates with the entered address."
 *
 * The snapshot ran one way only. A buyer who already had an address had it
 * copied onto every new order; a buyer who did not never gained one, however
 * many times somebody typed it in — so the same address was re-typed on every
 * order for that buyer, for ever. This closes the loop.
 *
 * ## FILL WHAT IS MISSING, NEVER OVERWRITE WHAT IS THERE
 *
 * The rule that makes this safe, and the reason it is not simply "save the
 * order's address onto the buyer". A one-off — a card show, a hotel, a friend's
 * shop for one week — is typed on ONE order and must not become that buyer's
 * permanent default, because the next three orders would then silently ship to a
 * convention centre that closed on Sunday.
 *
 * So: nothing stored, and an address typed → remembered. Something stored, and a
 * different address typed → the order keeps its own and the buyer keeps theirs.
 * Correcting a buyer's real address for good is an edit to the BUYER, which is a
 * deliberate act on a different screen, and should be.
 *
 * The two addresses are considered independently, because a buyer can easily
 * have a billing address on file and no ship-to.
 *
 * MUST be called inside the caller's transaction.
 */
function rememberCustomerAddresses(
  db: Database.Database,
  customerId: string | null,
  billAddr: InvoiceAddress | null,
  shipAddr: InvoiceAddress | null,
  stamp: string
): void {
  const id = clean(customerId)
  // No saved buyer, nothing to remember against. A name typed over the top is a
  // one-off by construction — see `typeName` on the form, which detaches the id
  // precisely so a one-off cannot rename or rewrite the record.
  //
  // AN EARLY-OUT, NOT THE SAFETY NET. The lookup below finds no row for a blank
  // id and returns anyway, so removing this changes no outcome and no test can
  // tell the difference. It stays because a query that can only ever come back
  // empty is one worth not running on every save.
  if (!id) return
  if (!hasAddress(billAddr) && !hasAddress(shipAddr)) return
  const row = db
    .prepare(`SELECT ${ADDRESS_COLS}, ${SHIP_ADDRESS_COLS} FROM invoice_customers WHERE id = ?`)
    .get(id) as (AddressRow & ShipAddressRow) | undefined
  if (!row) return

  const learnBill = hasAddress(billAddr) && !hasAddress(toAddress(row))
  const learnShip = hasAddress(shipAddr) && !hasAddress(toShipAddress(row))
  if (!learnBill && !learnShip) return

  // Each half moves as a WHOLE or not at all, the same rule saveCustomer's upsert
  // keeps: six independent COALESCEs would merge a new street onto an old city
  // the first time one was cleared, producing an address that was never anybody's.
  const sets: string[] = []
  const params: Record<string, unknown> = { id, stamp }
  if (learnBill) {
    sets.push(
      'bill_line1 = @billLine1',
      'bill_line2 = @billLine2',
      'bill_city = @billCity',
      'bill_region = @billRegion',
      'bill_postal_code = @billPostalCode',
      'bill_country = @billCountry'
    )
    Object.assign(params, addressParams(billAddr))
  }
  if (learnShip) {
    sets.push(
      'ship_line1 = @shipLine1',
      'ship_line2 = @shipLine2',
      'ship_city = @shipCity',
      'ship_region = @shipRegion',
      'ship_postal_code = @shipPostalCode',
      'ship_country = @shipCountry'
    )
    Object.assign(params, shipAddressParams(shipAddr))
  }
  db.prepare(
    `UPDATE invoice_customers SET ${sets.join(', ')}, updated_at = @stamp WHERE id = @id`
  ).run(params)
}

/** The buyer's stored ship-to. Null on almost everybody — see shipToAddress. */
function customerShipAddress(customerId: string | null): InvoiceAddress | null {
  if (!customerId) return null
  const row = getDb()
    .prepare(`SELECT ${SHIP_ADDRESS_COLS} FROM invoice_customers WHERE id = ?`)
    .get(customerId) as ShipAddressRow | undefined
  return row ? toShipAddress(row) : null
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
    .prepare(`SELECT created_at, status, allow_credit_card, shipping_cost FROM invoices WHERE id = ?`)
    .get(id) as
    | {
        created_at: string
        status: string
        allow_credit_card: number | null
        shipping_cost: number | null
      }
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
  /**
   * AND THE SHIP-TO, snapshotted on exactly the same rule.
   *
   * "The QBO invoice will have the customer's typical billing address, but the
   * SO must be referred to prior to making a label." So this is the address the
   * label is made from, and it is copied off the buyer at save time rather than
   * joined at read time — a buyer who moves next year must not rewrite where
   * last year's parcel actually went.
   *
   * NULL WHEN THE BUYER HAS NONE EITHER, and that is correct rather than a hole:
   * `shipToAddress` falls back to the bill-to, which is where their parcels have
   * always gone. Deliberately NOT defaulted to `billAddr` here — storing a copy
   * of the billing address in the ship-to columns would make every order claim a
   * ship-to it was never given, and `shipsElsewhere` could then never tell a
   * real difference from an inherited sameness.
   */
  const shipAddr =
    hasAddress(input.shipAddr)
      ? (input.shipAddr ?? null)
      : customerShipAddress(clean(input.customerId))

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
      supplier: clean(l.supplier),
      // WHICH PURCHASE ORDER THESE UNITS CAME OUT OF, when the operator said.
      // Null on every ordinary line — see @shared/poStock for why only an open
      // roadshow order is ever offered, and consumeFromPo for what naming one
      // does to the cost.
      sourcePoId: clean(l.sourcePoId)
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
          shipping_cost,
          bill_line1, bill_line2, bill_city, bill_region, bill_postal_code, bill_country,
          ship_line1, ship_line2, ship_city, ship_region, ship_postal_code, ship_country,
          created_by, created_at, updated_at)
       VALUES (@id, @invoiceNumber, @customerId, @customerName, @email, @terms, @invoiceDate,
               @dueDate, @location, @memo, @message, @sendLater, @className, 'draft',
               NULL, NULL, NULL, @total, @carrier, @service, @trackingNumber, @paymentTiming,
               @allowCreditCard, @shippingCost,
               @billLine1, @billLine2, @billCity, @billRegion, @billPostalCode, @billCountry,
               @shipLine1, @shipLine2, @shipCity, @shipRegion, @shipPostalCode, @shipCountry,
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
         ship_line1       = excluded.ship_line1,
         ship_line2       = excluded.ship_line2,
         ship_city        = excluded.ship_city,
         ship_region      = excluded.ship_region,
         ship_postal_code = excluded.ship_postal_code,
         ship_country     = excluded.ship_country,
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
         shipping_cost  = excluded.shipping_cost,
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
      /**
       * WHAT POSTING IT COST US, never a charge to the buyer.
       *
       * Absent leaves whatever is stored alone on an edit and writes nothing on
       * a create, for the same reason allowCreditCard does: this is an upsert,
       * and a payload that simply does not mention a field must not erase it.
       */
      shippingCost:
        input.shippingCost === undefined
          ? (existing?.shipping_cost ?? null)
          : shippingIn(input.shippingCost),
      ...addressParams(billAddr),
      ...shipAddressParams(shipAddr),
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
     * AND THE BUYER LEARNS IT, when they had none. See rememberCustomerAddresses.
     *
     * Inside this transaction on purpose: the order and what the buyer learned
     * from it are one act, and a crash between them would leave a buyer holding
     * an address off an order that was never saved.
     */
    rememberCustomerAddresses(db, clean(input.customerId), billAddr, shipAddr, stamp)

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
    // See stockDrawingLines — shared with setInvoiceLineRouting, which asks the
    // identical question of a posted order's lines.
    const stockLines = stockDrawingLines(lines, stockLocation)
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
    const movedQty = movedByPosition(moved)

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
          destination, supplier, source_po_id)
       VALUES (@id, @invoiceId, @position, @item, @productId, @sku, @description, @quantity,
               @rate, @amount, @taxRate, @className, @qtyFulfilled, @fulfilledAt, @stamp, @stamp,
               @destination, @supplier, @sourcePoId)`
    )
    /**
     * A SALE OUT OF ONE PURCHASE ORDER'S STOCK JOINS THAT ORDER'S DEAL TICKET.
     *
     * "The deal ticket is just linked to the ongoing PO until the PO is paid
     * out" — a week of buying from one shop and everything sold out of it is one
     * deal, and the register should say so under one number.
     *
     * ## NOT by setting invoices.source_po_id
     *
     * That column means one specific thing: this sale is the sell-half of a
     * DROPSHIP. `salesOrderKindOf` reads it, and a sale of our own roadshow
     * cases would start reporting as "mixed" — part drop-shipped — on a document
     * where every unit came off our shelf. The provenance already lives on the
     * lines, which is the honest place for it: one sale can have five roadshow
     * cases and a T-shirt off ordinary stock, and those are two different
     * answers on one document.
     *
     * ## Which is why it needs the lines to AGREE
     *
     * `soleSourceOrder` yields null when two lines name two orders. A deal
     * ticket is a claim about one deal, and folding a sale into one of the two
     * orders that supplied it would put a week's figure on the wrong shop.
     *
     * Runs on EVERY save, including edits, and is idempotent: the fold returns
     * false when it has already happened, which is what keeps the log from
     * gaining a line every time somebody fixes a typo.
     */
    foldRoadshowTicket(db, id, lines, clean(input.customerName), actorId)

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
 * ## WHAT TAKES AN INVOICE OFF THIS LIST IS QUICKBOOKS' OWN ANSWER
 *
 * There has to be a stopping rule — an invoice settled in cash that QuickBooks
 * never saw would otherwise be asked about on every refresh for the rest of its
 * life — and the whole bug lived in which fact was used as one.
 *
 * It used to be `NOT (status = 'paid' AND qbo_status_checked_at IS NOT NULL)`:
 * stop once the card is paid and we have checked it at least once. Both halves
 * look like they are about the payment. Neither is.
 *
 * `qbo_status_checked_at` is stamped by EVERY check, including the ones that ran
 * days earlier while the invoice was still open — so it is already set long
 * before anybody pays. And `status = 'paid'` is a LOCAL fact: it is written by
 * `setInvoiceStatus`, from the card being moved into the Paid column on this
 * floor or from the paid-up-front receipt, which is somebody's word and not
 * Intuit's. (Not by `setInvoicePaid`, the Mark paid button — that writes
 * `paid_at`/`paid_by` and never touches the stage. The two are deliberately
 * separate and it is the STAGE that armed this.)
 *
 * Put together, the moment a card reached Paid here the invoice dropped out of
 * the sweep forever — `'paid'` is terminal in INVOICE_TRANSITIONS, so it could
 * never re-enter — carrying whatever balance had been read back when it was
 * still unpaid. The money then landed in QuickBooks and nothing here ever asked
 * again: the card sat in Paid above an empty rail reading "$0.00 of $5,200.00 —
 * QuickBooks still shows $5,200.00 owing", and pressing Check QuickBooks could
 * not fix it, because the sweep no longer included the row. Reported by the
 * owner against invoices 2362 and 2367, both of which QuickBooks showed as Paid.
 *
 * `status = 'paid'` beside `qbo_balance == qbo_total_amt` is in fact a signature
 * only a local stage move can leave: had QUICKBOOKS been what set the stage, it
 * would have gone through `observedInvoiceStage`, which requires a zero balance,
 * and the zero would have been written first.
 *
 * So the stopping rule is now QuickBooks' own reading and nothing else: a
 * BALANCE OF ZERO, or a VOID. Those are terminal in the books — a settled
 * invoice's balance does not move again — which makes the rule true structurally
 * rather than by anybody remembering to keep the two facts apart. An invoice
 * ticked paid here that QuickBooks still shows owing stays on the list, which is
 * exactly the invoice most worth asking about.
 *
 * The residue is real and bounded: a cash sale never entered in QuickBooks never
 * reaches a zero balance, so it is asked about until `invoice_date DESC` and the
 * limit carry it off the end. Those are the oldest and least likely to change,
 * which is the right thing to drop first.
 */
/**
 * Move every CUSTOMER AND VENDOR off a payment term the picker no longer offers.
 *
 * The owner's words: "remove Net 30 as a payment option for all customers in
 * sales order and purchase orders."
 *
 * ## Why retiring it from the menu was not enough on its own
 *
 * `INVOICE_TERMS_OFFERED` stopped offering anything longer than Net 2 a while
 * back, but that only governs a NEW choice. `termsOptionsFor` deliberately hands
 * a retired term back on a record that already holds one — otherwise a `<select>`
 * renders a value it has no option for as blank, which reads as the terms having
 * been wiped. So the menu tightened and almost nothing changed, because almost
 * every contact was already on Net 30: the vendor import wrote it as a SQL
 * literal on every supplier it created, and both `terms` columns were declared
 * `DEFAULT 'Net 30'` from before the default moved to Due on receipt.
 *
 * ## The relationship, not the document
 *
 * This is the term a NEW order starts from, which is the thing the owner is
 * asking to change. It deliberately does not touch `invoices.terms`: an invoice
 * written last year on Net 30 keeps saying Net 30, because its `due_date` was
 * computed from those terms and sent to a buyer, and rewriting the words would
 * either contradict the date beside them or move a date somebody has been told.
 *
 * ## Everything unoffered, not Net 30 by name
 *
 * Net 15 and Net 60 sit behind the same door. Naming only Net 30 would leave
 * them to produce the identical complaint the first time somebody hit one, and
 * "the terms nobody may choose any more" is one rule rather than a list to keep
 * in step with `INVOICE_TERMS_OFFERED`.
 *
 * Idempotent, and a no-op where nobody is on a long term — which matters,
 * because invoice_customers is a synced table and touching rows that did not
 * change would push every one of them to every other machine.
 */
export function retireUnofferedCustomerTerms(db: Database.Database): number {
  const marks = INVOICE_TERMS_OFFERED.map(() => '?').join(', ')
  const info = db
    .prepare(
      `UPDATE invoice_customers
          SET terms = ?, updated_at = ?
        WHERE terms NOT IN (${marks})`
    )
    .run(DEFAULT_INVOICE_TERMS, nowIso(), ...INVOICE_TERMS_OFFERED)
  return info.changes
}

export function listPostedInvoices(limit = 200): Invoice[] {
  return (
    getDb()
      .prepare(
        `SELECT ${INVOICE_COLS} FROM invoices
          WHERE qbo_id IS NOT NULL AND qbo_id != ''
            AND status != 'void'
            AND NOT (
              qbo_status_checked_at IS NOT NULL
              AND (qbo_voided = 1 OR (qbo_balance IS NOT NULL AND qbo_balance <= 0))
            )
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
 *
 * ## It reports whether anything a person would SEE actually moved
 *
 * Every check stamps `qbo_status_checked_at`, so "did this write change
 * anything" cannot be read off the row count — it is always 1. The caller needs
 * the real answer for two reasons: the board only re-reads itself when something
 * changed, and the toast after Check QuickBooks used to say "nothing has
 * changed" on the strength of no card having moved COLUMN, which was a flat
 * untruth on the press that finally picked up a payment.
 *
 * Compared before the write, over the four figures the card actually draws.
 */
export function recordQboObservation(id: string, o: QboInvoiceObservation): boolean {
  const stamp = nowIso()
  const looked = o.payments.length > 0 || o.linkedPayments === 0
  const before = getDb()
    .prepare(
      `SELECT qbo_balance, qbo_total_amt, qbo_voided, qbo_paid_at, qbo_email_status
         FROM invoices WHERE id = ?`
    )
    .get(id) as
    | {
        qbo_balance: number | null
        qbo_total_amt: number | null
        qbo_voided: number | null
        qbo_paid_at: string | null
        qbo_email_status: string | null
      }
    | undefined
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
  if (!before) return false
  // The paid date is compared only when we actually looked for one — the write
  // above leaves it alone otherwise, so a round trip that skipped the payment
  // fetch must not report itself as having changed it.
  return (
    before.qbo_balance !== o.balance ||
    before.qbo_total_amt !== o.totalAmt ||
    !!before.qbo_voided !== o.voided ||
    (before.qbo_email_status ?? null) !== (o.emailStatus ?? null) ||
    (looked && (before.qbo_paid_at ?? null) !== latestPaymentDate(o.payments))
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
 * ## A purchase order may hold MORE THAN ONE sale
 *
 * One case bought from one distributor and shipped out to five people is one
 * purchase order and five sales orders — see @shared/multiShipment. So the many
 * side is `invoices.source_po_id`, which has always been able to hold it, and
 * `purchase_orders.linked_invoice_id` keeps the FIRST sale only, as a
 * convenience pointer for the callers that predate multi-shipment.
 *
 * It is therefore NOT the place to ask "which sales came from this order" —
 * `dropshipSalesFor` is. Reading the single column would answer with one of five
 * and give no sign that the other four exist, which is the failure mode this
 * note is here to stop somebody walking back into.
 *
 * What is still refused is REPOINTING a sale that already came from a different
 * purchase order. That is not a second buyer, it is the same boxes claimed by
 * two purchases, and it would leave the first one silently orphaned.
 */
/**
 * The purchase orders a saved sale could be attached to.
 *
 * ## Why this read did not exist until now
 *
 * Both dropship flows could only ever RAISE the missing document. Sell first and
 * the app offers to write the purchase; buy first and it offers to write the
 * sale. Neither could say "I already made that one — attach it", so
 * `linkDropshipPair` had exactly two callers and both fired in the moment after
 * a brand-new document was created.
 *
 * The gap showed in the app's own words: DropshipPurchaseStep's footnote tells
 * the operator to choose "Not now" if the goods were bought already, and the
 * buy-side interstitial promises the sale can be raised "from the Sales Orders
 * board whenever you like, and link it there". It could not be. The owner's case
 * was exactly that — one invoice already sent to a buyer, two of its cases
 * dropshipped, and the purchase order for them raised by hand beforehand.
 *
 * ## Everything not cancelled, ranked rather than filtered
 *
 * A purchase order that supplies a sale is not required to look like it. The
 * supplier the sale's lines name is the usual answer and leads the list — see
 * `linkableOrder` in @shared/orders — but a sale whose lines name nobody is
 * precisely the one that sent somebody here, and hiding everything on a supplier
 * mismatch would hand it an empty picker.
 *
 * Orders already supplying OTHER sales stay on the list: a multi-shipment
 * purchase legitimately supplies several. `otherSales` is carried so the picker
 * can say so rather than the operator finding out afterwards.
 */
export function linkablePurchaseOrders(invoiceId: string, limit = 60): LinkablePurchaseOrder[] {
  const rows = getDb()
    .prepare(
      `SELECT po.id, po.po_number, po.supplier, po.location, po.status, po.total,
              COALESCE(po.ordered_at, po.created_at) AS ordered_at,
              (SELECT COALESCE(SUM(l.quantity), 0)
                 FROM purchase_order_lines l WHERE l.po_id = po.id) AS units,
              -- OFF THE LINK TABLE, both of them. invoices.source_po_id goes
              -- NULL the moment a sale names more than one purchase (see
              -- syncSaleSourcePo), so counting through it would make a purchase
              -- look unused the moment its sale gained a second supplier.
              (SELECT COUNT(*) FROM sale_purchase_links sl
                 JOIN invoices i ON i.id = sl.invoice_id
                WHERE sl.po_id = po.id AND i.status != 'void' AND i.id != ?) AS other_sales,
              (SELECT COUNT(*) FROM sale_purchase_links sl
                WHERE sl.po_id = po.id AND sl.invoice_id = ?) AS linked_here,
              -- HOW MANY OF THIS SALE'S PRODUCTS THIS PURCHASE CARRIES.
              --
              -- What makes the list a shortlist instead of every order ever
              -- raised. DISTINCT on the product, so a purchase holding the same
              -- box on three lines counts once and does not out-rank one holding
              -- three different things the sale actually needs.
              --
              -- Catalog product ids only. A hand-typed line on either side has
              -- no id to match on, which is the ordinary shape of a dropship --
              -- and those still appear, at zero, because a purchase sharing no
              -- product with the sale is exactly the case the linking was asked
              -- for. NO BACKTICKS in these comments: this is a template literal.
              (SELECT COUNT(DISTINCT pl.product_id)
                 FROM purchase_order_lines pl
                WHERE pl.po_id = po.id AND pl.product_id IS NOT NULL
                  AND pl.product_id IN (SELECT il.product_id FROM invoice_lines il
                                         WHERE il.invoice_id = ? AND il.product_id IS NOT NULL))
                AS matching_products
         FROM purchase_orders po
        WHERE po.status != 'cancelled'
        ORDER BY COALESCE(po.ordered_at, po.created_at) DESC, po.po_number DESC
        LIMIT ?`
    )
    .all(invoiceId, invoiceId, invoiceId, Math.max(1, Math.min(500, limit))) as Array<{
    id: string
    po_number: string
    supplier: string | null
    location: string | null
    status: string
    total: number
    ordered_at: string | null
    units: number
    other_sales: number
    linked_here: number
    matching_products: number
  }>
  return rows.map((r) => ({
    poId: r.id,
    poNumber: r.po_number,
    supplier: (r.supplier ?? '').trim() || null,
    destination: (r.location ?? '').trim() || null,
    status: r.status,
    // A DAY, not an instant. Two orders to one supplier are told apart by when
    // they were raised, and nobody reads a timestamp to do it.
    orderedOn: r.ordered_at ? r.ordered_at.slice(0, 10) : null,
    total: money(Number(r.total) || 0),
    unitsOrdered: Number(r.units) || 0,
    linkedHere: Number(r.linked_here) > 0,
    otherSales: Number(r.other_sales) || 0,
    matchingProducts: Number(r.matching_products) || 0
  }))
}

export function linkDropshipPair(
  poId: string,
  invoiceId: string,
  actorId: string | null
): { ok: boolean; error?: string } {
  const db = getDb()
  const run = db.transaction((): { ok: boolean; error?: string } => {
    const po = db
      .prepare(
        `SELECT po_number, supplier, linked_invoice_id, tab_opened_at, tab_closed_at
           FROM purchase_orders WHERE id = ?`
      )
      .get(poId) as
      | {
          po_number: string
          supplier: string | null
          linked_invoice_id: string | null
          tab_opened_at: string | null
          tab_closed_at: string | null
        }
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

    /**
     * IT USED TO REFUSE HERE, and that refusal was the whole of the owner's
     * first ask: "allow for multiple POs to be added to one sales order."
     *
     *     if (invoice.source_po_id && invoice.source_po_id !== poId) {
     *       return { ok: false, error: 'That sales order already came from
     *                another purchase order.' }
     *     }
     *
     * True of the storage — one column — and never true of the trade. Ten cases
     * to one buyer sourced from three purchases is an ordinary week here.
     * `sale_purchase_links` is the many-to-many that replaced the column, so a
     * second purchase adds a second link and overwrites nothing.
     */
    const stamp = nowIso()
    // FIRST SALE ONLY, and only while the column is empty. A multi-shipment
    // purchase raises several sales in one go; overwriting this each time would
    // leave it pointing at whichever happened to be saved last, so the callers
    // still reading it would follow a different sale on every refresh.
    if (!po.linked_invoice_id) {
      db.prepare(
        `UPDATE purchase_orders SET linked_invoice_id = ?, updated_at = ? WHERE id = ?`
      ).run(invoiceId, stamp, poId)
    } else {
      db.prepare(`UPDATE purchase_orders SET updated_at = ? WHERE id = ?`).run(stamp, poId)
    }
    // THE LINK IS THE RECORD; the column is an answer derived from it — the sole
    // purchase when there is one, NULL when there are several. See
    // syncSaleSourcePo for why NULL rather than the first.
    //
    // FALSE MEANS IT WAS ALREADY LINKED, and everything below is then skipped.
    // Two people on two benches attaching the same purchase is a race, not a
    // mistake — so it is not refused — but a re-attach must not write a second
    // pair of history lines saying a thing that happened once happened twice.
    // Nor may it re-fold the deal ticket. It is a no-op, and a no-op leaves no
    // trace.
    const linked = addSaleLink(db, invoiceId, poId, actorId, stamp)
    if (!linked) return { ok: true }

    const runningTab = isOpenTab({
      tabOpenedAt: po.tab_opened_at,
      tabClosedAt: po.tab_closed_at
    })
    const soLabel = invoice.invoice_number ? `sales order ${invoice.invoice_number}` : 'a sales order'
    recordOrderEvent('po', poId, 'link', {
      detail: runningTab
        ? `Sold on to ${invoice.customer_name} as ${soLabel}, off this running tab`
        : `Dropship — sold on to ${invoice.customer_name} as ${soLabel}`,
      actorId,
      db
    })
    recordOrderEvent('so', invoiceId, 'link', {
      detail: runningTab
        ? `Off the running tab with ${po.supplier ?? 'a roadshow'} (${po.po_number})`
        : `Dropship — bought from ${po.supplier ?? 'a supplier'} on ${po.po_number}`,
      actorId,
      db
    })

    // Both tickets keep their numbers and change their KIND. The two documents
    // have just been declared one deal, and the register is where somebody asks
    // what was dropshipped — see markDropshipPair for why re-issuing would be
    // the wrong repair.
    markDropshipPair(db, poId, invoiceId)

    /**
     * A SALE OFF A RUNNING TAB JOINS THE TAB'S TICKET.
     *
     * "The deal ticket is just linked to the ongoing PO until the PO is paid
     * out" — a week of buying from one shop and everything sold out of it is one
     * deal, and the register should say so under one number rather than list
     * eleven unrelated-looking movements nothing ties together.
     *
     * ONLY WHILE IT IS OPEN, which is what "until it is paid out" means: once the
     * tab has been settled the week is closed, and a sale raised afterwards is
     * its own piece of trade with its own number.
     *
     * The merge is NOT undone at settling. Settling is the moment the week
     * becomes a finished, auditable deal — scattering its documents back to
     * eleven numbers exactly then would be the wrong way round.
     */
    if (runningTab) {
      foldTicketIntoDocument(db, { kind: 'po', id: poId }, { kind: 'so', id: invoiceId }, actorId)
    }
    return { ok: true }
  })
  return run()
}

/**
 * The other half of a dropship pair, or null when there is not one.
 *
 * SINGULAR, and it answers a narrower question than it used to: since a
 * multi-shipment purchase can raise several sales, this returns the FIRST of
 * them. Callers that want the set want `dropshipSalesFor`.
 */
export function linkedDropshipInvoice(poId: string): InvoiceDetail | null {
  const row = getDb()
    .prepare(`SELECT linked_invoice_id AS id FROM purchase_orders WHERE id = ?`)
    .get(poId) as { id: string | null } | undefined
  return row?.id ? getInvoice(row.id) : null
}

/**
 * Every sales order raised against one purchase order, oldest first.
 *
 * Read from `invoices.source_po_id` — the MANY side — rather than from
 * `purchase_orders.linked_invoice_id`, which holds only the first. A
 * multi-shipment purchase has as many sales as it has buyers, and a read that
 * followed the single column would report one of five with nothing to say the
 * other four existed.
 *
 * Ordered by `created_at` so the list reads in the order the buyers were named,
 * which is the order somebody assigned them in and therefore the order they
 * expect to see them back in.
 */
export function dropshipSalesFor(poId: string): InvoiceDetail[] {
  const rows = getDb()
    .prepare(`SELECT id FROM invoices WHERE source_po_id = ? ORDER BY created_at ASC, id ASC`)
    .all(poId) as Array<{ id: string }>
  return rows.map((r) => getInvoice(r.id)).filter((i): i is InvoiceDetail => i !== null)
}

/**
 * Every sales order that took units OUT OF this purchase order's stock.
 *
 * A DIFFERENT QUESTION from `dropshipSalesFor`, and therefore a different read.
 * That one answers "which sales was this purchase raised to supply" — the
 * dropship pairing, off `invoices.source_po_id`. This answers "which sales have
 * sold the cases this order brought in", off the LINES, and the two are only
 * the same document by coincidence.
 *
 * It is the question a roadshow order is opened to ask: the order stays running
 * all week, cases go on it and come off it, and what somebody wants at the end
 * is the list of who bought them.
 *
 * DISTINCT, because one sale can have three lines out of the same order and is
 * still one sale on the list.
 */
export function salesFromPoStock(poId: string): InvoiceDetail[] {
  const id = String(poId ?? '').trim()
  if (!id) return []
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT i.id, i.created_at
         FROM invoice_lines l
         JOIN invoices i ON i.id = l.invoice_id
        WHERE l.source_po_id = ?
        ORDER BY i.created_at ASC, i.id ASC`
    )
    .all(id) as Array<{ id: string }>
  return rows.map((r) => getInvoice(r.id)).filter((i): i is InvoiceDetail => i !== null)
}

/**
 * Raise every buyer's sales order for one multi-shipment purchase, at once.
 *
 * ## All of them or none of them
 *
 * One transaction around the whole batch, because a partial batch is the worst
 * outcome available here. Five buyers assigned and three orders written leaves
 * two people uninvoiced for boxes that have already shipped, and NOTHING on
 * screen says which two — the assignment that knew is spent the moment the modal
 * closes. Rolling the lot back leaves the purchase order exactly as it was, with
 * the assignment still on screen to try again.
 *
 * ## Drafts, deliberately
 *
 * Each order is written the way `saveInvoice` writes any new one: status
 * `draft`, nothing posted. Pushing five invoices into the owner's real
 * QuickBooks books from one button — with prices nobody has typed yet, because
 * the rate is 0 until somebody sets it — would be five documents to void over
 * there to undo one mistake here. They go to the board, get priced, and go to
 * QuickBooks one at a time like every other sales order.
 *
 * ## Numbers look after themselves
 *
 * `saveInvoice` already moves a number up when it is taken, and says so on the
 * order's own history. Five saves in one transaction is exactly the collision
 * that guard exists for, so the batch offers a starting number and lets it work
 * rather than reserving a block — which would be a second numbering scheme that
 * could disagree with the first.
 */
export function splitDropshipSales(
  poId: string,
  orders: Array<NewInvoice>,
  actorId: string | null
): { ok: boolean; created?: InvoiceDetail[]; error?: string } {
  if (orders.length === 0) return { ok: false, error: 'Assign at least one buyer first.' }
  const db = getDb()
  const po = db.prepare(`SELECT po_number FROM purchase_orders WHERE id = ?`).get(poId) as
    | { po_number: string }
    | undefined
  if (!po) return { ok: false, error: 'That purchase order is gone.' }

  /**
   * ONCE PER PURCHASE ORDER, and this guard is on the SERVER because the ways
   * back in are not all in one screen.
   *
   * An assignment covers every unit the order bought — `shipmentProblem` refuses
   * anything less — so a second batch is not "more buyers", it is the same boxes
   * billed twice: every buyer gets a duplicate invoice, and the totals on this
   * deal double. The routes to a second press are ordinary ones: a double click,
   * a failed refresh after a good save, reopening the interstitial on a purchase
   * that was already split.
   *
   * Refused rather than made idempotent, because there is no key to be
   * idempotent ON. The assignment is never stored; two presses can legitimately
   * carry different buyers and quantities, so "the same batch again" is not
   * something this function can recognise. What it CAN see is that the purchase
   * has already been sold on, and that is the question worth asking.
   */
  const already = db
    .prepare(`SELECT COUNT(*) AS n FROM invoices WHERE source_po_id = ?`)
    .get(poId) as { n: number }
  if (already.n > 0) {
    return {
      ok: false,
      error:
        `${po.po_number} has already been split — ${already.n} sales order` +
        `${already.n === 1 ? '' : 's'} were raised from it. Open them from the Sales Orders board, ` +
        `or delete one there before splitting again.`
    }
  }

  const run = db.transaction((): { ok: boolean; created?: InvoiceDetail[]; error?: string } => {
    const created: InvoiceDetail[] = []
    for (const order of orders) {
      const saved = saveInvoice(order, actorId)
      const link = linkDropshipPair(poId, saved.id, actorId)
      // Thrown rather than returned, because a `return` inside a better-sqlite3
      // transaction COMMITS what came before it. The throw is what rolls the
      // whole batch back, and it is caught immediately below.
      if (!link.ok) throw new Error(link.error ?? 'That sales order could not be linked.')
      created.push(saved)
    }
    return { ok: true, created }
  })

  try {
    return run()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not raise the sales orders.' }
  }
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
 *
 * AND REFUSED ON AN UNPAID UP-FRONT ORDER, which is the other half of the same
 * rule the stage move now keeps — see invoiceStageRefusal. This is the second
 * door onto the packing list, and gating one of two doors is not a gate.
 *
 * Only on the way IN. TAKING an order back off the list is always allowed: it
 * is the correction for having put it there, and a rule that refused it would
 * trap an order somebody had just released by mistake.
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
  if (ready) {
    const refusal = invoiceStageRefusal(id, 'sent')
    if (refusal) return { invoice: getInvoice(id), error: refusal }
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
/**
 * WHICH LINES OF A SALE DRAW A SHELF DOWN. The one answer, asked twice.
 *
 * A DROPSHIPPED LINE MOVES NO STOCK, and this is the assertion the whole feature
 * rests on. The units went from the supplier straight to the buyer; this
 * business never held them, so drawing a shelf down for them would invent a sale
 * out of inventory that was never there — and on a product carried in stock it
 * would quietly consume somebody else's boxes.
 *
 * Shared by `saveInvoice`, which writes a whole order, and by
 * `setInvoiceLineRouting`, which re-routes two lines of a posted one. Restating
 * it in the second would be a second answer to the same question, and the first
 * time they disagreed a line would be billed as a dropship and picked as stock.
 */
/**
 * A SALE OUT OF ONE ROADSHOW ORDER'S STOCK JOINS THAT ORDER'S DEAL TICKET.
 *
 * "The deal ticket is just linked to the ongoing PO until the PO is paid out" —
 * a week of buying from one shop and everything sold out of it is one deal, and
 * the register should say so under one number.
 *
 * ## Only a RUNNING roadshow order
 *
 * A line may name ANY purchase order holding stock — five cases from a roadshow
 * beside five from a distributor is the case the chooser exists for. Naming one
 * decides where the COST comes from, and that is right whoever the order is
 * with. It does not decide the two documents are one DEAL: a case bought from a
 * distributor in March and sold to somebody unrelated in August is two pieces of
 * trade that happen to share a box. A roadshow week is the opposite — bought and
 * sold against itself all week, one shop, one payment.
 *
 * ## And only when every line AGREES
 *
 * `soleSourceOrder` yields null when two lines name two orders. A deal ticket is
 * a claim about one deal, and folding a sale into one of the two orders that
 * supplied it would put a week's figure on the wrong shop.
 *
 * Shared by `saveInvoice` and `setInvoiceLineRouting`, because naming an order
 * on a posted sale means exactly what naming it on a draft did. Idempotent: the
 * fold returns false once it has happened, which is what keeps the log from
 * gaining a line every time somebody fixes a typo.
 */
function foldRoadshowTicket(
  db: Database.Database,
  invoiceId: string,
  lines: ReadonlyArray<{ sourcePoId?: string | null }>,
  customerName: string | null,
  actorId: string | null
): void {
  const fromOrder = soleSourceOrder(lines)
  if (!fromOrder) return
  const src = db
    .prepare(
      `SELECT po_number, supplier, tab_opened_at, tab_closed_at
         FROM purchase_orders WHERE id = ?`
    )
    .get(fromOrder) as
    | {
        po_number: string
        supplier: string | null
        tab_opened_at: string | null
        tab_closed_at: string | null
      }
    | undefined
  if (!src) return
  if (!isOpenTab({ tabOpenedAt: src.tab_opened_at, tabClosedAt: src.tab_closed_at })) return
  const folded = foldTicketIntoDocument(
    db,
    { kind: 'po', id: fromOrder },
    { kind: 'so', id: invoiceId },
    actorId
  )
  if (!folded) return
  recordOrderEvent('so', invoiceId, 'link', {
    detail: `Sold out of ${src.po_number}${src.supplier ? ` (${src.supplier})` : ''}`,
    actorId,
    db
  })
  recordOrderEvent('po', fromOrder, 'link', {
    detail: `Sold on to ${customerName ?? 'a buyer'} out of this order's stock`,
    actorId,
    db
  })
}

/**
 * WHICH UNITS OF THIS ORDER COME OFF A SHELF — one entry per SLICE, not per line.
 *
 * Shared by `saveInvoice` and `setInvoiceLineRouting` so there is one answer to
 * "what moves stock" rather than two that can drift.
 *
 * An unsplit line yields at most one entry and is byte-for-byte what this
 * returned before splits existed. A line split by quantity yields one entry per
 * slice that holds stock, each with its own quantity, its own shelf and its own
 * source purchase order — so "eight off RM out of PO-0042, two shipped direct by
 * Kestrel" draws eight and leaves two alone, which is the whole point of the
 * feature.
 *
 * `effectiveSlices` is asked rather than `allocations.length` being tested here,
 * because that rule has to live in exactly one place. See @shared/invoiceAllocations.
 */
function stockDrawingLines(
  lines: ReadonlyArray<{
    position: number
    productId?: string | null
    product_id?: string | null
    quantity: number
    destination?: string | null
    supplier?: string | null
    sourcePoId?: string | null
    source_po_id?: string | null
    allocations?: readonly InvoiceLineAllocation[]
  }>,
  stockLocation: string
): InvoiceStockLine[] {
  const out: InvoiceStockLine[] = []
  for (const l of lines) {
    const productId = l.productId ?? l.product_id ?? null
    if (!productId || !(l.quantity > 0)) continue
    for (const slice of effectiveSlices(
      {
        quantity: l.quantity,
        // Stored inheritance resolved the same way it always was: a blank line
        // destination means the order's shelf.
        destination: lineDestination(l.destination, stockLocation) ?? stockLocation,
        supplier: l.supplier ?? null,
        sourcePoId: l.sourcePoId ?? l.source_po_id ?? null,
        allocations: l.allocations
      },
      stockLocation
    )) {
      if (!slice.holdsStock || !(slice.quantity > 0)) continue
      out.push({
        position: l.position,
        allocationId: slice.id,
        productId,
        quantity: slice.quantity,
        // THE SLICE'S OWN SHELF, not the order's. A split that says "six off RM
        // and four off AM" has to draw two different shelves, and handing the
        // header's location to both would take ten off one of them.
        location: slice.destination,
        sourcePoId: slice.sourcePoId
      })
    }
  }
  return out
}

/**
 * How many units the shelf actually gave EACH LINE — the moves SUMMED.
 *
 * Summed rather than indexed, because a split line writes one move per stock
 * slice and both carry the same line position. `new Map(moves.map(...))` kept
 * whichever came last, so a line of ten split six-and-four reported four
 * fulfilled and six still owed, and the scan queue offered six units that had
 * already gone. `qty_fulfilled` is a per-LINE number, so this is the shape it
 * needs. The dropship half of a line contributes nothing here, correctly: the
 * shelf never gave those units.
 */
function movedByPosition(moves: readonly InvoiceStockMove[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const m of moves) out.set(m.position, (out.get(m.position) ?? 0) + m.quantity)
  return out
}

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
/**
 * RE-ROUTE THE LINES OF A SALE THAT HAS ALREADY BEEN POSTED.
 *
 * The owner's words: "on a sales order that is posted into QuickBooks I want the
 * ability to change the destination and supplier if needed, for our own purposes
 * and inventory — not the QuickBooks."
 *
 * ## Why this cannot go through `saveInvoice`
 *
 * `saveInvoice` throws on anything that is not a draft, and it is right to:
 * it rewrites EVERY column — number, buyer, dates, terms, every line's price and
 * quantity, the total — and once a document is on somebody's books this app is
 * not its system of record. Widening that guard would let a total drift away
 * from the invoice a buyer is holding, with nothing on either screen to say
 * which is true.
 *
 * So this is a separate, narrow write, and the narrowness IS the safety. It
 * touches three columns on the lines named — `destination`, `supplier` and the
 * roadshow `source_po_id` — and then re-derives the stock. It cannot change what
 * anybody is billed, because it never writes a rate, a quantity or a total, and
 * it never speaks to Intuit. The same shape as `setInvoiceItemsInHand` and
 * `setInvoicePaid` beside it: one fact about OUR handling of an order, editable
 * for the life of the order.
 *
 * ## Where the goods come from is not a fact about the invoice
 *
 * That is the whole justification. "Ten cases at $900" is what the buyer agreed
 * and is fixed the moment it is sent. "Two of those ship direct from Kestrel and
 * eight come off the RM shelf" is a fact about THIS business's inventory and
 * logistics, discovered afterwards more often than not, and nothing on the
 * buyer's document says it or should.
 *
 * ## The stock is re-derived, not adjusted
 *
 * Release everything this order ever took, then take again from the lines that
 * still draw a shelf — the identical release-then-apply `saveInvoice` performs,
 * calling the identical `stockDrawingLines` filter, so there is one answer to
 * "which lines move stock" and not two that can drift. `restoreFifo` puts units
 * back into the exact layers they came from, so the re-take walks the same FIFO
 * order and lands on the same layers at the same costs: nothing to get wrong
 * arithmetically, and a line flipped to dropship simply is not in the re-take
 * and its units stay on the shelf.
 *
 * ## SPLITTING A LINE BY QUANTITY
 *
 * The owner again: "for each individual case adjust where it is coming from, and
 * then it corresponds back to inventory or the right dropship PO." Ten cases on
 * one line, eight off the shelf and two shipped direct, is one line with two
 * answers — so a change may carry `allocations`, and each one is a slice of the
 * line's quantity with its own destination and its own source purchase order.
 *
 * The quantity, the rate and the amount are still never written. Eight at $900
 * plus two at $900 is ten at $900: the document is untouched and the buyer's
 * copy stays true, which is the same reasoning that makes the rest of this
 * function safe on a posted order.
 *
 * `allocationProblem` is the gate — Σ slices must equal the line's quantity, and
 * every slice must be at least one whole unit. A line of ten split six-and-three
 * is not a line of nine, it is a line of ten with a case coming from nowhere, so
 * the whole change is refused rather than stored.
 *
 * ## What it deliberately does to `qty_fulfilled`
 *
 * On a stock line that number means "the shelf gave these units". Flip the line
 * to a dropship and the claim is void — the release just took it back — so it
 * goes to zero rather than being carried forward as picking that never happened.
 * A line that was ALWAYS a dropship is left alone: its number came from somebody
 * scanning, which this has no business erasing.
 *
 * On a SPLIT line it is the sum of what every stock slice drew, which is why
 * `movedByPosition` sums rather than indexes.
 *
 * ## What it does NOT do
 *
 * It does not touch QuickBooks, and it cannot: `pushToQbo` refuses an invoice
 * that already has an id and there is no update path in this app at all. It does
 * not move the card, change the total, or link a purchase order — that is
 * `linkDropshipPair`, deliberately separate, because being supplied by an order
 * and being routed from a supplier are two different claims.
 *
 * Refused on a VOID order only. A void sale has already handed its stock back,
 * and re-applying would take it a second time.
 */
export function setInvoiceLineRouting(
  id: string,
  changes: ReadonlyArray<{
    lineId: string
    destination: string | null
    supplier: string | null
    /**
     * WHICH PURCHASE ORDER'S CASES this line takes, when it takes any.
     *
     * `undefined` leaves whatever the line already names — a caller changing
     * only the destination must not silently drop a roadshow pointer somebody
     * set. `null` clears it. Accepted on a DROPSHIP line too, where it is a
     * record of where the goods came from rather than a claim on cost layers —
     * see the long note at the write below.
     */
    sourcePoId?: string | null
    /**
     * THE LINE SPLIT BY QUANTITY, when somebody split it.
     *
     * Three states, and they are three different instructions:
     *
     *   undefined  leave whatever splits the line already has
     *   []         collapse it back to one line with one answer, deleting rows
     *   [a, b, …]  replace the splits with exactly these
     *
     * An empty array is not the same as undefined and must not be flattened into
     * it: "not split" is a state this feature can return to, and it is stored as
     * ZERO ROWS rather than as one allocation covering the whole quantity —
     * which is what keeps an ordinary sale byte-for-byte the way sales have
     * always been stored. See @shared/invoiceAllocations.
     *
     * `destination` and `supplier` above still apply to the line, and a split
     * line's own columns go on describing its FIRST slice so nothing that reads
     * a line without knowing about splits reads a blank.
     */
    allocations?: ReadonlyArray<InvoiceAllocationInput>
  }>,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const guard = liveInvoiceOr(db, id)
  if (!guard.ok) return guard.result
  if (changes.length === 0) return { invoice: getInvoice(id) }

  const run = db.transaction((): { invoice: InvoiceDetail | null; error?: string } => {
    const header = db
      .prepare(`SELECT invoice_number, customer_name, location FROM invoices WHERE id = ?`)
      .get(id) as
      | { invoice_number: string | null; customer_name: string; location: string | null }
      | undefined
    if (!header) return { invoice: null, error: 'That order is gone.' }
    const stockLocation = invoiceStockLocation(header.location)
    const stamp = nowIso()

    type Row = {
      id: string
      position: number
      item: string
      product_id: string | null
      quantity: number
      destination: string | null
      supplier: string | null
      source_po_id: string | null
      qty_fulfilled: number
    }
    const readLines = (): Row[] =>
      db
        .prepare(
          `SELECT id, position, item, product_id, quantity, destination, supplier,
                  source_po_id, qty_fulfilled
             FROM invoice_lines WHERE invoice_id = ? ORDER BY position`
        )
        .all(id) as Row[]

    const before = readLines()
    const splitsBefore = readLineAllocations(db, id)
    /** What a line looks like to the shared slice rule — splits included. */
    const asSliceable = (
      l: Row,
      splits: Map<string, InvoiceLineAllocation[]>
    ): Parameters<typeof effectiveSlices>[0] => ({
      quantity: l.quantity,
      destination: lineDestination(l.destination, stockLocation) ?? stockLocation,
      supplier: l.supplier,
      sourcePoId: l.source_po_id,
      allocations: splits.get(l.id)
    })
    // DID THIS LINE DRAW A SHELF AT ALL, splits accounted for. Read off the
    // slices rather than off the line's own destination: a split line's column
    // describes only its first slice, so a line that was eight-on-the-shelf and
    // two-dropship would answer for the eight and lose the rest.
    const wasStock = new Map(
      before.map((l) => [l.id, stockUnitsOf(asSliceable(l, splitsBefore), stockLocation) > 0])
    )

    const setLine = db.prepare(
      `UPDATE invoice_lines
          SET destination = ?, supplier = ?, source_po_id = ?, updated_at = ?
        WHERE id = ? AND invoice_id = ?`
    )
    const clearSplits = db.prepare(
      `DELETE FROM invoice_line_allocations WHERE invoice_id = ? AND invoice_line_id = ?`
    )
    const insertSplit = db.prepare(
      `INSERT INTO invoice_line_allocations
         (id, invoice_id, invoice_line_id, quantity, destination, supplier, source_po_id,
          position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const holdsStmt = db.prepare(
      `SELECT po.po_number,
              (SELECT COALESCE(SUM(l2.qty_remaining), 0)
                 FROM inventory_lots l2
                 JOIN po_line_receipts r ON r.lot_id = l2.id
                WHERE r.po_id = po.id AND l2.product_id = ? AND l2.location = ?
                  AND l2.qty_remaining > 0) AS on_hand
         FROM purchase_orders po WHERE po.id = ?`
    )
    /**
     * What this line claims FROM each purchase order, on each shelf.
     *
     * The pair is kept in the VALUE and only ever grouped by the key, never
     * parsed back out of it. An earlier cut joined the two into a string and
     * split them again on the way out, and it went in carrying a literal NUL as
     * the separator: invisible in every editor, every diff and every review, and
     * working perfectly right up until something reformatted the file. Nothing
     * here encodes, so there is nothing to decode wrongly.
     */
    const claimsOf = (
      slices: ReturnType<typeof effectiveSlices>
    ): Map<string, { poId: string; shelf: string; quantity: number }> => {
      const out = new Map<string, { poId: string; shelf: string; quantity: number }>()
      for (const s of slices) {
        if (!s.holdsStock || !s.sourcePoId) continue
        const key = `${s.sourcePoId} at ${s.destination}`
        const seen = out.get(key)
        if (seen) seen.quantity += s.quantity
        else out.set(key, { poId: s.sourcePoId, shelf: s.destination, quantity: s.quantity })
      }
      return out
    }

    const touched: string[] = []
    for (const change of changes) {
      const line = before.find((l) => l.id === change.lineId)
      if (!line) return { invoice: null, error: 'That line is no longer on this order.' }
      // NULL means "the order's location", the same inheritance a line stores
      // when it is typed. Keeping the inheritance rather than a copy is what
      // stops a line disagreeing with its header after the header moves.
      const dest = lineDestination(change.destination, stockLocation)
      const drawsStock = destinationHoldsStock(dest ?? stockLocation)
      // A dropship line has no supplier to derive from anything else — the
      // destination IS the party shipping it, exactly as the sales form derives
      // it. A stock line has no supplier at all.
      const supplier = drawsStock ? null : (change.supplier ?? '').trim() || dest || null
      /**
       * WHICH PURCHASE ORDER THESE GOODS CAME FROM — on ANY line, including a
       * dropship.
       *
       * This used to be forced to null the moment a line became a dropship, on
       * the reasoning that `source_po_id` says which cost layers to consume and
       * a line consuming none cannot name whose. True of the COST, and it threw
       * away the thing the owner actually needs: "we need to know where products
       * are coming from, and those are open tabs" — a case bought on a roadshow
       * tab and shipped straight to the buyer never reaches a shelf here, so it
       * has no layers to consume and nowhere to record where it came from
       * either. The provenance was unrecordable on exactly the orders where it
       * mattered most.
       *
       * ## ONE COLUMN, AND THE STOCK ENGINE STRUCTURALLY CANNOT READ IT WRONG
       *
       * It answers "where did this line come from", and each kind of line can
       * only answer that one way:
       *
       *   stock line     out of THAT order's cost layers — and consumeFromPo is
       *                  handed it, so it moves real money.
       *   dropship line  supplied by that order, shipped direct. A record, and
       *                  nothing else reads it.
       *
       * The safety is not a guard that could be forgotten; it is the shape of
       * the code. `stockDrawingLines` filters on `holdsStock` BEFORE it ever
       * looks at `sourcePoId`, so a dropship line's value cannot reach
       * `applyInvoiceStock` at all — there is no path. `effectiveSlices` nulls it
       * on a non-stock slice for the same reason, which is why the raw column is
       * read for provenance and the slice rule is read for cost.
       */
      const asked = change.sourcePoId === undefined ? line.source_po_id : change.sourcePoId
      const sourcePo = (asked ?? '').trim() || null

      /**
       * THE SPLITS THIS LINE WILL HAVE, in the three states the caller can ask
       * for. Undefined leaves the rows alone entirely — including their ids, so
       * a caller changing only a destination does not churn every allocation
       * through sync for nothing.
       */
      const rewriteSplits = change.allocations !== undefined
      const keepSplits = !rewriteSplits && (splitsBefore.get(line.id)?.length ?? 0) > 0
      let slices: ReturnType<typeof effectiveSlices>
      if (keepSplits) {
        // The splits govern and they are not being touched, so the change's own
        // destination is not the answer to anything here — it only goes on to
        // describe the first slice. See the setLine call below.
        slices = effectiveSlices(asSliceable(line, splitsBefore), stockLocation)
      } else if (!rewriteSplits || (change.allocations ?? []).length === 0) {
        // ONE ANSWER FOR THE WHOLE LINE, taken from THIS change and not from the
        // row as it stands. Reading the old row here would compare the line's
        // claim against itself, find nothing new, skip the coverage check below
        // and let consumeFromPo throw a transaction away instead.
        slices = effectiveSlices(
          { quantity: line.quantity, destination: dest, supplier, sourcePoId: sourcePo },
          stockLocation
        )
      } else {
        const proposed = change.allocations ?? []
        const problem = allocationProblem(proposed, line.quantity)
        if (problem) return { invoice: null, error: `${line.item}: ${problem}` }
        slices = proposed.map((a, i) => {
          // A slice with no destination of its own takes the LINE's, which is
          // the same one-step inheritance a line takes from the header. It is
          // resolved here and stored resolved — see the v89 note.
          const where = (a.destination ?? '').trim() || dest || stockLocation
          const holds = destinationHoldsStock(where)
          return {
            id: `new-${i}`,
            quantity: Math.round(a.quantity),
            destination: where,
            supplier: holds ? null : where,
            holdsStock: holds,
            // STORED RAW on a dropship slice as much as a stock one — the same
            // provenance-not-cost rule the line's own column now keeps. These
            // slices are handed to `claimsOf` below, which skips anything that
            // draws no shelf before it ever reads this, and to the INSERT, which
            // is where the record belongs.
            sourcePoId: (a.sourcePoId ?? '').trim() || null
          }
        })
      }

      /**
       * NAMED, SO IT MUST BE REAL AND IT MUST HOLD THEM.
       *
       * `consumeFromPo` throws rather than topping up from elsewhere when an
       * order is short — the right behaviour, and a thrown transaction is a
       * worse message than a sentence naming both numbers. Checked here so the
       * refusal can name them.
       *
       * Against the INCREASE, not the total. This order's own units have already
       * left the shelf and are not in `on_hand`, so re-saving an unchanged claim
       * of six would compare six against the nought that is left and refuse a
       * change that took nothing.
       */
      const already = claimsOf(effectiveSlices(asSliceable(line, splitsBefore), stockLocation))
      for (const [key, want] of claimsOf(slices)) {
        const extra = want.quantity - (already.get(key)?.quantity ?? 0)
        if (extra <= 0) continue
        const { poId, shelf } = want
        const holds = holdsStmt.get(line.product_id, shelf, poId) as
          | { po_number: string; on_hand: number }
          | undefined
        if (!holds) return { invoice: null, error: 'That purchase order is gone.' }
        const onHand = Number(holds.on_hand) || 0
        if (onHand < extra) {
          return {
            invoice: null,
            error:
              `${holds.po_number} has ${onHand} of ${line.item} left on the ${shelf} shelf, ` +
              `and this asks it for ${extra} more. Lower the quantity taken from that order, ` +
              'or leave those units on ordinary stock.'
          }
        }
      }

      if (rewriteSplits) {
        clearSplits.run(id, line.id)
        // ZERO ROWS FOR AN UNSPLIT LINE, never one row covering the whole
        // quantity. The two would behave identically and only one of them keeps
        // an ordinary sale stored the way sales have always been stored, which
        // is the entire back-compat mechanism — see @shared/invoiceAllocations.
        if ((change.allocations ?? []).length > 0) {
          slices.forEach((s, i) =>
            insertSplit.run(
              randomUUID(),
              id,
              line.id,
              s.quantity,
              s.destination,
              s.supplier,
              s.sourcePoId,
              i,
              stamp,
              stamp
            )
          )
        }
      }

      // A SPLIT LINE'S OWN COLUMNS DESCRIBE ITS FIRST SLICE.
      //
      // They no longer govern anything — the slices do — but they are still what
      // every reader that predates splits looks at, and leaving them stale would
      // have a line saying RM while all ten of its cases ship direct. First
      // rather than "mixed": these columns have to hold a real destination, and
      // a made-up word in them would reach the QuickBooks export and the board.
      const head = keepSplits || (rewriteSplits && slices.length > 1) ? slices[0] : null
      // THE FIRST SLICE'S RAW PROVENANCE, which is not always what `slices`
      // carries. In the keep-splits branch `slices` came out of
      // `effectiveSlices` — the cost view — so a first slice that ships direct
      // has already had its purchase order blanked. Writing that into the line's
      // own column would quietly erase the record while the allocation row it is
      // supposed to describe still holds it.
      const headSourcePo = keepSplits
        ? (splitsBefore.get(line.id)?.[0]?.sourcePoId ?? null)
        : (slices[0]?.sourcePoId ?? null)
      setLine.run(
        head ? lineDestination(head.destination, stockLocation) : dest,
        head ? head.supplier : supplier,
        head ? headSourcePo : sourcePo,
        stamp,
        line.id,
        id
      )
      touched.push(line.id)
    }

    const after = readLines()
    const splitsAfter = readLineAllocations(db, id)
    const stockLines = stockDrawingLines(
      after.map((l) => ({ ...l, allocations: splitsAfter.get(l.id) })),
      stockLocation
    )
    releaseInvoiceStock(db, id)
    const moved = applyInvoiceStock(
      db,
      id,
      (header.invoice_number ?? '').trim() || null,
      header.customer_name?.trim() || null,
      stockLines,
      stockLocation,
      actorId
    )
    const movedQty = movedByPosition(moved)

    const drawing = new Set(stockLines.map((l) => l.position))
    const setFulfilled = db.prepare(
      `UPDATE invoice_lines SET qty_fulfilled = ?, fulfilled_at = ?, updated_at = ?
        WHERE id = ? AND invoice_id = ?`
    )
    for (const line of after) {
      if (drawing.has(line.position)) {
        // Read off what the shelf ACTUALLY gave, never off the quantity asked
        // for — the same rule saveInvoice keeps, so the record and the shelf say
        // the same number when the consumption takes less than was wanted.
        const qty = movedQty.get(line.position) ?? 0
        setFulfilled.run(qty, qty > 0 ? stamp : null, stamp, line.id, id)
      } else if (touched.includes(line.id) && wasStock.get(line.id)) {
        // It drew a shelf until a moment ago and does not any more. The number
        // described that draw, and the draw has been given back.
        setFulfilled.run(0, null, stamp, line.id, id)
      }
    }

    db.prepare(`UPDATE invoices SET updated_at = ? WHERE id = ?`).run(stamp, id)

    /**
     * THE PURCHASE ORDER'S OWN HISTORY, which is the half nobody sees coming.
     *
     * The owner's requirement was "our own inventory and PO and SO history that
     * it is reflective of that". A line that starts or stops taking a purchase
     * order's cases changes what that ORDER supplied, and reading only the
     * sale's log would leave the purchase silently different from what its
     * history says about it.
     *
     * One entry per purchase order, not per line: three lines moved onto one
     * order is one thing that happened to that order.
     *
     * Read off the SLICES, so a split line that takes six cases out of PO-0042
     * and leaves four on ordinary stock shows up on PO-0042's history — reading
     * the line's own column would see only its first slice and quietly lose the
     * rest. The quantity is named because it is the thing that changed: "6 × Foo"
     * on a line of ten says something a bare item name does not.
     */
    const poBefore = new Map<string, string[]>()
    const poAfter = new Map<string, string[]>()
    const push = (m: Map<string, string[]>, po: string | null, item: string): void => {
      if (!po) return
      m.set(po, [...(m.get(po) ?? []), item])
    }
    /**
     * WHERE EACH SLICE'S GOODS CAME FROM — the raw answer, cost view or not.
     *
     * `effectiveSlices` blanks the purchase order on a slice that draws no
     * shelf, which is right for money and wrong for the question these two
     * histories ask. A stock slice reads identically either way; a dropship
     * slice is the whole reason this exists.
     */
    const provenanceOf = (
      l: Row,
      splits: Map<string, InvoiceLineAllocation[]>
    ): Array<{ quantity: number; holdsStock: boolean; sourcePoId: string | null }> => {
      const rows = splits.get(l.id) ?? []
      if (rows.length > 0) {
        return rows.map((a) => ({
          quantity: a.quantity,
          holdsStock: a.holdsStock,
          sourcePoId: a.sourcePoId
        }))
      }
      // The zero-rows case, resolved exactly as effectiveSlices resolves it —
      // one implicit slice of the whole line at the line's own destination.
      const where = lineDestination(l.destination, stockLocation) ?? stockLocation
      return [
        {
          quantity: l.quantity,
          holdsStock: destinationHoldsStock(where),
          sourcePoId: (l.source_po_id ?? '').trim() || null
        }
      ]
    }
    const pushSlices = (
      m: Map<string, string[]>,
      rows: Row[],
      splits: Map<string, InvoiceLineAllocation[]>,
      /** true collects the slices that draw a shelf, false the ones that do not. */
      wantStock: boolean
    ): void => {
      for (const l of rows) {
        if (!touched.includes(l.id)) continue
        // Summed per order first, so one line split into two slices of the same
        // purchase order reads as one claim of six rather than two of three.
        const byPo = new Map<string, number>()
        for (const s of provenanceOf(l, splits)) {
          if (s.holdsStock !== wantStock || !s.sourcePoId) continue
          byPo.set(s.sourcePoId, (byPo.get(s.sourcePoId) ?? 0) + s.quantity)
        }
        for (const [poId, qty] of byPo) {
          push(m, poId, qty === l.quantity ? l.item : `${qty} × ${l.item}`)
        }
      }
    }
    pushSlices(poBefore, before, splitsBefore, true)
    pushSlices(poAfter, after, splitsAfter, true)
    const soLabel = (header.invoice_number ?? '').trim()
      ? `sales order ${(header.invoice_number ?? '').trim()}`
      : 'a sales order'
    for (const [poId, items] of poAfter) {
      if ((poBefore.get(poId) ?? []).join('|') === items.join('|')) continue
      recordOrderEvent('po', poId, 'link', {
        detail: `${items.join(', ')} on ${soLabel} now come out of this order's stock`,
        actorId,
        db
      })
    }
    for (const [poId, items] of poBefore) {
      if (poAfter.has(poId)) continue
      recordOrderEvent('po', poId, 'link', {
        detail: `${items.join(', ')} on ${soLabel} no longer come out of this order's stock`,
        actorId,
        db
      })
    }

    /**
     * AND THE SAME AGAIN FOR THE CASES A SUPPLIER SHIPS DIRECT.
     *
     * A SEPARATE PASS WITH ITS OWN WORDING, not a widening of the one above,
     * because the two say different things and only one of them is about money.
     * "These come out of this order's stock" is a claim on cost layers. "These
     * are supplied by this order, shipped direct" is provenance — the owner's
     * open-tab case, where a case bought on a roadshow never reaches a shelf
     * here and there is no stock sentence that would be true about it.
     *
     * Writing both in one sentence would have a roadshow tab's history claiming
     * a draw on stock it never held, which is the sort of half-truth in a log
     * that costs somebody an afternoon a year later.
     */
    const dropBefore = new Map<string, string[]>()
    const dropAfter = new Map<string, string[]>()
    pushSlices(dropBefore, before, splitsBefore, false)
    pushSlices(dropAfter, after, splitsAfter, false)
    for (const [poId, items] of dropAfter) {
      if ((dropBefore.get(poId) ?? []).join('|') === items.join('|')) continue
      recordOrderEvent('po', poId, 'link', {
        detail: `${items.join(', ')} on ${soLabel} are supplied by this order, shipped direct`,
        actorId,
        db
      })
    }
    for (const [poId, items] of dropBefore) {
      if (dropAfter.has(poId)) continue
      recordOrderEvent('po', poId, 'link', {
        detail: `${items.join(', ')} on ${soLabel} are no longer supplied by this order`,
        actorId,
        db
      })
    }

    // The same fold a draft save performs. Naming an order on a posted sale
    // means exactly what naming it on a draft did — see foldRoadshowTicket.
    //
    // ONE ENTRY PER SLICE, not per line, so `soleSourceOrder` sees two purchase
    // orders when a split line takes cases from two of them and declines to fold
    // — which is exactly what it should do: a deal ticket is a claim about one
    // deal, and picking one of the two would put a week's figure on the wrong shop.
    //
    // RAW PROVENANCE, not the cost view, and the distinction matters here. A case
    // bought on a roadshow tab and shipped straight to the buyer IS sold out of
    // that tab — it just never touched a shelf on the way — and a deal ticket
    // groups DOCUMENTS, it does not spend anything. `saveInvoice` has always
    // folded off the raw line for the same reason, so reading the cost view here
    // would have a draft and the identical posted order land on two different
    // tickets. The narrowing that keeps this honest is inside foldRoadshowTicket:
    // a RUNNING open tab only, and only when every slice names the same one.
    foldRoadshowTicket(
      db,
      id,
      after.flatMap((l) => provenanceOf(l, splitsAfter).map((s) => ({ sourcePoId: s.sourcePoId }))),
      header.customer_name,
      actorId
    )

    const names = after.filter((l) => touched.includes(l.id)).map((l) => l.item)
    // 'note', not a new kind. The event log's kinds are the things that happen
    // TO an order — created, staged, paid, shipped, linked — and re-routing is a
    // correction somebody made, which is what a note is. Minting a kind for it
    // would make every reader of describeOrderEvent handle a case that means
    // "something else happened".
    recordOrderEvent('so', id, 'note', {
      detail:
        `Re-routed ${names.length} line${names.length === 1 ? '' : 's'} — ${names.join(', ')}. ` +
        'Stock re-derived; nothing on the invoice or in QuickBooks changed.',
      actorId,
      db
    })
    return { invoice: getInvoice(id) }
  })
  return run()
}

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
 * CORRECT THE MONEY ON A SALE THAT HAS ALREADY BEEN POSTED.
 *
 * The owner's words: "add an edit button on sales orders that I can edit the
 * price in the software — I know I would have to manually do that in
 * QuickBooks."
 *
 * ## Why this is not `saveInvoice`, and why it is allowed anyway
 *
 * `saveInvoice` throws the moment an invoice is not a draft, with the reason
 * written above it: this app is not the system of record for a document
 * somebody has been billed against, and there is no update path to Intuit.
 * Every word of that is still true, and none of it is an argument for the app
 * being unable to hold a corrected figure — a price agreed on the phone after
 * the invoice went out is an ordinary Tuesday here, and the choice today is
 * between the app knowing the real number and the app being confidently wrong
 * in every report it produces.
 *
 * So the gate moves rather than opens. `saveInvoice` rewrites EVERY column —
 * buyer, number, dates, terms, quantities, lines added and removed — and
 * widening it would let all of that drift silently. This writes exactly two
 * money columns on the lines named, re-derives the header total from the line
 * amounts, and touches nothing else at all.
 *
 * ## It changes NO quantity, so it moves NO stock
 *
 * That is the property that makes it safe on a posted order, and it is
 * structural rather than a promise: there is no path from here to
 * `applyInvoiceStock`, because the only inputs are a rate and an amount and
 * neither is read by anything that costs a shelf. A sale of ten cases whose
 * price was cut is still a sale of ten cases; the FIFO layers it consumed are
 * the layers it consumed. Changing what a line SELLS is a different act, it
 * belongs to `setInvoiceLineRouting` and the split editor, and it is not here.
 *
 * ## QuickBooks is not told, and the divergence is the point
 *
 * `pushToQbo` refuses an invoice that already has an id, and this app has no
 * update path to Intuit at all — so the operator changes it there by hand, in
 * their own words when they asked for this. What this does is make the gap
 * VISIBLE: `qbo_total_amt` is Intuit's own figure and is deliberately left
 * alone, so after an edit the two disagree, and `qboTotalMismatch` puts that
 * disagreement on the card until somebody squares it. A silent local edit that
 * nobody could see afterwards would be a worse feature than no edit at all.
 *
 * ## And the history says what happened, per line, in dollars
 *
 * Not "prices edited" — the old figure and the new one, so the trail survives
 * the person who made it. Refused on a VOID order only.
 */
export function setInvoicePricing(
  id: string,
  changes: ReadonlyArray<{
    lineId: string
    /**
     * The new unit price. `undefined` leaves it; the amount then follows the
     * rate unless the caller overrides it below.
     */
    rate?: number | null
    /**
     * WHAT THE LINE ACTUALLY COMES TO, when it is not quantity × rate.
     *
     * The override exists because `amount` on this table has always been what
     * was AGREED rather than arithmetic — "a buyer talked down to a round
     * number is a real thing that happens on this floor" — and a screen that
     * could only set the rate would make that number unreachable on exactly
     * the orders somebody is here to correct. Absent means "follow the rate".
     */
    amount?: number | null
  }>,
  actorId: string | null
): { invoice: InvoiceDetail | null; error?: string } {
  const db = getDb()
  const guard = liveInvoiceOr(db, id)
  if (!guard.ok) return guard.result
  if (changes.length === 0) return { invoice: getInvoice(id) }

  const run = db.transaction((): { invoice: InvoiceDetail | null; error?: string } => {
    const header = db.prepare(`SELECT invoice_number, total FROM invoices WHERE id = ?`).get(id) as
      | { invoice_number: string | null; total: number | null }
      | undefined
    if (!header) return { invoice: null, error: 'That order is gone.' }
    const stamp = nowIso()

    type Row = { id: string; item: string; quantity: number; rate: number; amount: number }
    const before = db
      .prepare(`SELECT id, item, quantity, rate, amount FROM invoice_lines WHERE invoice_id = ?`)
      .all(id) as Row[]

    const setLine = db.prepare(
      `UPDATE invoice_lines SET rate = ?, amount = ?, updated_at = ?
        WHERE id = ? AND invoice_id = ?`
    )
    /** What changed, in words, for the history entry. */
    const said: string[] = []

    for (const change of changes) {
      const line = before.find((l) => l.id === change.lineId)
      if (!line) return { invoice: null, error: 'That line is no longer on this order.' }
      if (change.rate === undefined && change.amount === undefined) continue

      /**
       * A FIGURE, AND NOT A TYPO. NaN and Infinity are refused rather than
       * stored as zero — a blank box read as "free" is the one failure of this
       * screen that would look like a successful save. The magnitude cap is
       * the same reasoning as `setInvoiceDims`: nothing on this floor sells
       * for ten million dollars a case, and a pasted account number that lands
       * in a rate box should be a sentence rather than a total.
       */
      const num = (v: number | null | undefined, fallback: number, what: string): number | string => {
        if (v === undefined || v === null) return fallback
        const n = Number(v)
        if (!Number.isFinite(n)) return `${line.item}: that ${what} is not a number.`
        if (Math.abs(n) > 10_000_000) return `${line.item}: that ${what} is not a price.`
        return money(n)
      }
      const rate = num(change.rate, line.rate, 'price')
      if (typeof rate === 'string') return { invoice: null, error: rate }
      // THE AMOUNT FOLLOWS THE RATE unless it was given its own answer. A
      // caller that moves the price and says nothing about the total means the
      // ordinary thing, and making them restate the multiplication would be a
      // second place for the two to disagree.
      const amount =
        change.amount === undefined
          ? lineAmount(line.quantity, rate)
          : num(change.amount, line.amount, 'amount')
      if (typeof amount === 'string') return { invoice: null, error: amount }

      if (money(rate) === money(line.rate) && money(amount) === money(line.amount)) continue
      setLine.run(rate, amount, stamp, line.id, id)
      said.push(
        `${line.item}: ${fmtMoney(line.rate)} → ${fmtMoney(rate)} each` +
          (money(amount) === lineAmount(line.quantity, rate)
            ? ''
            : `, line total ${fmtMoney(amount)}`)
      )
    }

    if (said.length === 0) return { invoice: getInvoice(id) }

    /**
     * THE HEADER TOTAL IS RE-DERIVED FROM THE LINES, never adjusted by the
     * delta. Summing what is actually stored is the only version that cannot
     * drift: an arithmetic patch would stay right until the first line this
     * screen did not touch, and then be wrong for ever with nothing to show it.
     */
    const after = db
      .prepare(`SELECT amount FROM invoice_lines WHERE invoice_id = ?`)
      .all(id) as Array<{ amount: number }>
    const total = invoiceTotal(after)
    db.prepare(`UPDATE invoices SET total = ?, updated_at = ? WHERE id = ?`).run(total, stamp, id)

    // 'note', for the same reason re-routing is a note: the log's kinds are the
    // things that happen TO an order, and a correction somebody made is a note.
    recordOrderEvent('so', id, 'note', {
      detail:
        `Price corrected — ${said.join('; ')}. ` +
        `Order total ${fmtMoney(header.total ?? 0)} → ${fmtMoney(total)}. ` +
        'QuickBooks was NOT changed; it has to be corrected there by hand.',
      actorId,
      db
    })
    return { invoice: getInvoice(id) }
  })
  return run()
}

/** Dollars, for a sentence in a log. Not a screen — no locale, no symbol drift. */
function fmtMoney(n: number): string {
  const v = money(Number(n) || 0)
  return `$${v.toFixed(2)}`
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
 * WHY THE PACKING LIST IS REFUSING THIS ORDER, or null when it is not.
 *
 * Reads the six facts `readyToShipBlockedReason` judges on and hands them to it.
 * Deliberately NOT a second copy of the rule — the rule is one function in
 * @shared/fulfillment, and this is a query.
 *
 * A row that is GONE comes back null, not a sentence. "That order is gone" is
 * the caller's answer to a different question, and answering it here would have
 * every caller printing whichever of the two sentences it happened to reach
 * first.
 */
export function invoiceStageRefusal(id: string, to: InvoiceStatus): string | null {
  // Only the move onto the packing list is gated. Posting to QuickBooks, taking
  // a payment and voiding are all legal on an unpaid order — the second one is
  // how it stops being unpaid.
  if (to !== 'sent') return null
  const row = getDb()
    .prepare(
      `SELECT status, payment_timing, paid_at, qbo_paid_at, qbo_voided, force_ready_at
         FROM invoices WHERE id = ?`
    )
    .get(id) as
    | {
        status: string
        payment_timing: string | null
        paid_at: string | null
        qbo_paid_at: string | null
        qbo_voided: number | null
        force_ready_at: string | null
      }
    | undefined
  if (!row) return null
  return readyToShipBlockedReason({
    status: asStatus(row.status),
    paymentTiming: asPaymentTiming(row.payment_timing),
    paidAt: row.paid_at,
    qboPaidAt: row.qbo_paid_at,
    qboVoided: row.qbo_voided === 1,
    forceReadyAt: row.force_ready_at
  })
}

/**
 * Move an invoice along the board.
 *
 * Marking it paid STAMPS THE DATE, and moving it off paid clears it — so the
 * date can never outlive the claim it belongs to. A stale "paid 3 March" on an
 * invoice that is no longer marked paid is the kind of thing somebody reads off
 * a screen and repeats to a buyer.
 *
 * ## Refusing Ready to ship is done HERE, not at the caller
 *
 * Three different things move a card to that stage — a drag, the QuickBooks
 * pull, and the send-from-QuickBooks button — and only one of them is a person
 * who could be shown a message. A gate in the screen would have been no gate at
 * all: the pull was the path that actually did it, silently, on a timer, the
 * moment Intuit reported the invoice emailed. See invoiceStageRefusal.
 *
 * It returns FALSE rather than throwing, because the pull moves a list and one
 * refused order must not abandon the rest of it. Callers with somebody to talk
 * to ask invoiceStageRefusal first, which is where the sentence comes from.
 */
export function setInvoiceStatus(
  id: string,
  status: InvoiceStatus,
  actorId: string | null = null
): boolean {
  const db = getDb()
  const stamp = nowIso()
  const run = db.transaction((): boolean => {
    // THE GATE, BEFORE ANYTHING IS WRITTEN. Inside the transaction so the facts
    // it judges on are the ones this move is about to overwrite, and ahead of
    // the void branch so a refusal never gets as far as handing stock back.
    if (invoiceStageRefusal(id, status)) return false
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
    // Which purchases supplied it goes with it. No foreign key on that table by
    // design — see the v90 note — so the rows are removed here rather than
    // cascaded, and a purchase that supplied this sale and three others keeps
    // the other three.
    db.prepare(`DELETE FROM sale_purchase_links WHERE invoice_id = ?`).run(id)
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

  /**
   * THE MONEY IS COUNTED OFF THE MONEY, NOT OFF THE COLUMN.
   *
   * Both figures used to come from the query above — paid was `status='paid'`
   * and outstanding was everything else — and that was right for exactly as long
   * as the last column meant "we have been paid". It is called PAYMENT now: the
   * settling-up step, which an order reaches before the money lands. See
   * INVOICE_STAGES and isInvoicePaid, where the split is written down.
   *
   * So the old arithmetic reported two lies at once, in opposite directions:
   *
   *   · An order dragged into Payment that nobody had paid counted as PAID, and
   *     its whole total went into a figure the owner reads as money received.
   *   · An order QuickBooks says is settled, still sitting in Ready to ship
   *     because the boxes have not gone out, counted as AWAITING PAYMENT —
   *     money the screen says is owed and that is already in the account.
   *
   * This is the SQL form of isInvoicePaid, and it has to stay that way: an
   * invoice Intuit reports paid is paid whatever this floor ticked, an invoice
   * Intuit reports VOIDED is not paid whatever it says here, and a tick on this
   * board is the answer the rest of the time. A void is in neither figure —
   * nobody is waiting on it and nobody sent anything.
   */
  // COALESCE on the flag even though the column is NOT NULL DEFAULT 0. The two
  // figures are complements — one is NOT the other — so a single NULL would
  // drop that invoice out of BOTH and quietly lose its total off a screen whose
  // whole job is totals. Cheap insurance against a column that changes shape.
  const PAID_SQL = `status != 'void' AND COALESCE(qbo_voided, 0) != 1 AND (paid_at IS NOT NULL OR qbo_paid_at IS NOT NULL)`
  const sumWhere = (where: string): number =>
    (
      getDb()
        .prepare(`SELECT COALESCE(SUM(total), 0) AS value FROM invoices WHERE ${where}`)
        .get() as { value: number }
    ).value
  const paidTotal = sumWhere(PAID_SQL)
  const outstanding = sumWhere(`status != 'void' AND NOT (${PAID_SQL})`)

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

