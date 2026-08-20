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
import { destinationHoldsStock } from './purchaseOrders'
import { LOCATION_IDS } from './inventory'
import type { Carrier, PaymentTiming } from './freight'
import type { ShipStatusCode } from './shippingTypes'

/**
 * A postal address, in QuickBooks' vocabulary but this app's spelling.
 *
 * `region` is what Intuit calls CountrySubDivisionCode — a two-letter state on a
 * US company. Named for what a person would call it, and translated once at the
 * payload boundary, because "CountrySubDivisionCode" appearing on a form field
 * in this app would be somebody else's schema leaking through the screen.
 *
 * Every part is nullable and none is required. A buyer with a city and no street
 * is a real record on this floor, and refusing to store a partial address only
 * means the address gets typed into the memo instead.
 */
export interface InvoiceAddress {
  line1: string | null
  line2: string | null
  city: string | null
  /** State or province. Intuit: CountrySubDivisionCode. */
  region: string | null
  postalCode: string | null
  country: string | null
}

/** True when any part of an address was actually filled in. */
export function hasAddress(a: InvoiceAddress | null | undefined): boolean {
  if (!a) return false
  return [a.line1, a.line2, a.city, a.region, a.postalCode, a.country].some(
    (v) => (v ?? '').trim() !== ''
  )
}

/** Every part blank — the shape a screen binds to before anything is typed. */
export const EMPTY_ADDRESS: InvoiceAddress = {
  line1: null,
  line2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null
}

export type InvoiceTerms = 'Due on receipt' | 'Net 2' | 'Net 15' | 'Net 30' | 'Net 60'

/**
 * How a sale settles, shortest first.
 *
 * ORDERED BY DAYS, and "Due on receipt" leads because it is the default — see
 * DEFAULT_INVOICE_TERMS. Breaks are paid up front far more often than they are
 * financed, and a picker whose first entry is Net 30 quietly makes thirty days
 * the answer for anybody who does not change it.
 *
 * "Net 2" is here because it is genuinely used: a buyer taking a case off the
 * next stream is given the weekend, not a month.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST. Terms are stored on invoices and on
 * customers as the words themselves, so dropping an entry does not tidy a menu —
 * it orphans every record holding that value, and a `<select>` renders a value
 * it has no option for as BLANK, which reads as the terms having been wiped.
 */
export const INVOICE_TERMS: InvoiceTerms[] = [
  'Due on receipt',
  'Net 2',
  'Net 15',
  'Net 30',
  'Net 60'
]

/**
 * What a picker actually offers.
 *
 * The owner's call: nothing longer than Net 2. This business is paid before a
 * case ships or within a couple of days of it landing, and a menu offering
 * thirty and sixty days makes those a choice somebody can make by accident on
 * an order worth five figures.
 *
 * SEPARATE FROM `INVOICE_TERMS` RATHER THAN A DELETION, for the reason written
 * above it: the words themselves are stored on invoices and on customers, so
 * removing an entry does not tidy a menu — it orphans every record holding that
 * value, and a `<select>` renders a value it has no option for as BLANK, which
 * reads as the terms having been wiped. `INVOICE_TERMS` stays complete so
 * `TERM_DAYS` and every stored value still resolve; this is the shorter list a
 * NEW choice is made from.
 */
export const INVOICE_TERMS_OFFERED: InvoiceTerms[] = ['Due on receipt', 'Net 2']

/**
 * The options to draw, given what this record is already on.
 *
 * An invoice written last year on Net 30 keeps saying Net 30 — it is a fact
 * about a deal that was struck, and a screen that silently redrew it as "Due on
 * receipt" would be rewriting history rather than tightening a policy. So the
 * retired term is offered too, but ONLY on the record that already holds it,
 * and it disappears from that record's menu the moment somebody moves off it.
 */
export function termsOptionsFor(current: string | null | undefined): InvoiceTerms[] {
  const held = String(current ?? '').trim() as InvoiceTerms
  if (held && INVOICE_TERMS.includes(held) && !INVOICE_TERMS_OFFERED.includes(held)) {
    return [...INVOICE_TERMS_OFFERED, held]
  }
  return INVOICE_TERMS_OFFERED
}

/**
 * What a sale is on when nobody says otherwise.
 *
 * ONE constant, imported by the invoice form, the new-customer form and the
 * contact importer, because three places each writing `'Net 30'` is how they
 * came to disagree. A buyer with terms of their own still overrides this — that
 * is the point of storing terms on the relationship — this is only the answer
 * for a sale where nothing else has said.
 */
export const DEFAULT_INVOICE_TERMS: InvoiceTerms = 'Due on receipt'

/** How many days after the invoice date each term falls due. */
export const TERM_DAYS: Record<InvoiceTerms, number> = {
  'Due on receipt': 0,
  'Net 2': 2,
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
  /**
   * How to reach them, kept exactly as it was written.
   *
   * Never reformatted. This list has US, UK and Hong Kong numbers in it, in
   * fourteen different notations, and any rule that tidies a ten-digit US number
   * into brackets also mangles a `+44` one. A phone number is a string somebody
   * dials, not a quantity. `mobile` is null when it is the same number as
   * `phone`, which is what a QuickBooks export usually says.
   */
  phone: string | null
  mobile: string | null
  terms: InvoiceTerms
  /** QuickBooks Location, when the company has them switched on. */
  location: string | null
  /** QuickBooks Class, e.g. "Class A:Subclass B". */
  className: string | null
  /** The default "Message on Invoice" for this buyer. */
  message: string | null
  /** Internal note. Never exported — this is for the floor, not the buyer. */
  notes: string | null
  /**
   * Where the invoice is billed to, which is a property of the BUYER and not of
   * one sale — the same argument that put terms and email on this record. Null
   * when nobody has typed one, and null is not a problem: the posting code falls
   * back to the address QuickBooks already holds for the matched customer, which
   * is exactly what their own invoice form does.
   */
  billAddr: InvoiceAddress | null
  /** QuickBooks Customer id, once matched. Null until it is. */
  qboId: string | null
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface InvoiceLine {
  id: string
  invoiceId: string
  /**
   * Units already scanned out against this line — the sell-side mirror of a
   * purchase order line's `qtyReceived`.
   *
   * An order goes out in two vans as easily as one arrives in two, so this is a
   * running count rather than a done flag. Zero on a line that was never
   * scanned, including every line written before scanning-out matched orders at
   * all.
   */
  qtyFulfilled: number
  /** quantity − qtyFulfilled, floored at 0. */
  qtyOutstanding: number
  /** When the LAST unit went out. Null while any is still owed. */
  fulfilledAt: string | null
  /** Order on the document. Rebuilt on every save, so it can never have gaps. */
  position: number
  /** QuickBooks "Product/Service". Required by Intuit. */
  item: string
  /**
   * The catalog product this line came from, when it came from one.
   *
   * Null for a line somebody typed freehand, which stays legal — plenty of what
   * gets billed here is a service or a one-off that was never stock. The id is
   * kept so "what did we sell of this product" can be asked later; the NAME and
   * the SKU beside it are snapshots, not a join, for the same reason
   * `customerName` is: renaming a product next year must not rewrite a document
   * that has already been sent.
   */
  productId: string | null
  /**
   * The SKU as it stood when the line was written.
   *
   * Auto-filled from the chosen product and then left alone. It is what the
   * posting code matches a QuickBooks Item on FIRST, before falling back to the
   * name — an item renamed in QuickBooks still carries its SKU, and matching on
   * a name alone is how a line silently attaches to the wrong product.
   */
  sku: string | null
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
  /**
   * Where this line was fulfilled FROM, once inheritance is resolved.
   *
   * Never null on a line that has been read back: an empty column means "the
   * order's location", and this is that answer already worked out, so no screen
   * has to know the rule. See NewInvoiceLine.destination for the direction.
   */
  destination: string
  /** Who shipped a dropshipped line. Null when it came off our own shelf. */
  supplier: string | null
  /**
   * Did this line move stock?
   *
   * DERIVED from the destination rather than stored, for the same reason a PO's
   * dropship flag is: a stored boolean is a second source of truth that drifts
   * the first time a line is re-routed, and the failure mode is a dropship that
   * still draws a shelf down.
   */
  dropship: boolean
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
/**
 * The board's columns, left to right — the order the work moves in.
 *
 * ## The last two changed what they mean
 *
 * They were "Sent" and "Paid", and the second of those was doing two jobs: it
 * was a STAGE on the pipeline and it was the only place the app recorded that
 * money had arrived. The owner asked for the pipeline to read
 * Draft → In QuickBooks → Ready to ship → Payment, with paid-or-not marked
 * inside the last column — which is the same split the BUY side has had since
 * `setPurchaseOrderPaid` was written: where an order is, and whether it has been
 * settled, are two facts.
 *
 * So the stage values are unchanged — nothing stored moves, nothing re-syncs —
 * and what they mean has narrowed. `paid` is now the PAYMENT stage, and whether
 * the money is in is `isInvoicePaid`, read from `paidAt` and from what
 * QuickBooks says. An order raised before this still reads as paid, because
 * reaching that stage always stamped `paid_at`.
 */
export const INVOICE_STAGES: Array<{ id: InvoiceStatus; label: string; hint: string }> = [
  { id: 'draft', label: 'Draft', hint: 'Being built — not sent to anybody yet' },
  { id: 'created', label: 'In QuickBooks', hint: 'Posted, waiting to be sent' },
  { id: 'sent', label: 'Ready to ship', hint: 'With the buyer, or on the bench being packed' },
  { id: 'paid', label: 'Payment', hint: 'Settling up — mark it paid when the money lands' }
]

/**
 * Has the money actually arrived?
 *
 * SEPARATE FROM THE STAGE, and that separation is the point. Reaching the
 * Payment column means an order is at the settling-up step; it does not mean
 * anybody has been paid, and a board that conflated the two could only ever
 * show one of them.
 *
 * QUICKBOOKS WINS WHERE IT SPEAKS. `qboPaidAt` is Intuit's own record that a
 * payment was applied, and it is the answer whenever there is one — the books
 * are the system of record for money, and a tick on this board is somebody's
 * word. `paidAt` is that word, and it is what the rest of the time reads.
 *
 * Deliberately NOT derived from the balance: a partly-paid invoice has a
 * balance and is not paid, and `invoicePaymentState` already models that
 * properly for the progress bar. This is the yes-or-no the column needs.
 */
export function isInvoicePaid(invoice: {
  paidAt: string | null
  qboPaidAt?: string | null
  qboVoided?: boolean | null
}): boolean {
  if (invoice.qboVoided) return false
  return !!invoice.qboPaidAt || !!invoice.paidAt
}

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

/**
 * How a buyer paid, as a list somebody picks from.
 *
 * OFFERED, NOT ENFORCED. The column is free text and the last option types
 * anything, because this list can only ever hold the ways people have paid so
 * far and the next one is always possible. What the list buys is that the four
 * that happen constantly are one tap rather than four spellings of "zelle" that
 * no report can group.
 *
 * NOTHING IS EVER REMOVED. The words themselves are stored on orders already
 * written, so dropping an entry does not tidy a menu — it orphans every record
 * holding that value.
 */
export const PAYMENT_METHODS = ['Cash', 'Zelle', 'Card', 'Bank transfer', 'PayPal', 'Other'] as const

/** What a payment recorded up front says about itself. */
export interface InvoicePaymentInput {
  /** How much arrived. Defaults to the order's total when nobody says. */
  amount?: number | null
  method?: string | null
  reference?: string | null
  /** Release it to the packing floor at the same time. */
  readyToShip?: boolean
  /** Move the card to Paid as well. Off for a deposit against a bigger order. */
  markPaid?: boolean
}

export const PAYMENT_REFERENCE_MAX = 120

export function validateInvoicePayment(
  input: InvoicePaymentInput,
  orderTotal: number
): string | null {
  if (input.amount !== undefined && input.amount !== null) {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return 'A payment has to be more than nothing.'
    }
    // A cent of tolerance, because a total is money() rounded and an operator
    // typing the figure off the order should not be told it disagrees with
    // itself. Anything genuinely larger is worth stopping on: overpayment is a
    // real event and it should be a deliberate one, not a typo.
    if (input.amount > money(orderTotal) + 0.01) {
      return 'That is more than the order comes to. Check the amount.'
    }
  }
  if ((input.reference ?? '').length > PAYMENT_REFERENCE_MAX) {
    return 'That reference is too long.'
  }
  return null
}

/**
 * Is this order waiting to be picked?
 *
 * The question the packing floor asks, and the reason readiness is its own
 * timestamp rather than a stage: an order can be paid and not ready (nothing has
 * been said about picking it), ready and not paid (a trusted buyer on terms),
 * and it stops being either the moment it is voided.
 */
export function awaitingShipment(invoice: {
  status: InvoiceStatus
  readyToShipAt: string | null
}): boolean {
  return invoice.status !== 'void' && !!invoice.readyToShipAt
}

/**
 * How the last attempt to put this invoice into QuickBooks went.
 *
 * Separate from `status` because they answer different questions. `status` is
 * where the DOCUMENT is — draft, posted, sent, paid. This is whether the last
 * PUSH worked, and it exists so a failed push is a thing somebody can see and
 * retry instead of an invoice that quietly never left the building.
 *
 *   none    nobody has tried; the everyday state of a draft
 *   pending a push is in flight, or the app died mid-push
 *   ok      QuickBooks has it, and `qboId` says which one
 *   failed  it was tried and refused; `qboPushError` says what Intuit said
 *
 * PENDING IS THE ONE THAT EARNS ITS KEEP. It is written before the network call
 * and cleared after, so a crash or a power cut between the two leaves a row that
 * says "we may have posted this" rather than one that says "never tried" — the
 * difference between checking QuickBooks and creating the invoice twice.
 */
export type InvoicePushState = 'none' | 'pending' | 'ok' | 'failed'

export function asPushState(v: unknown): InvoicePushState {
  return v === 'pending' || v === 'ok' || v === 'failed' ? v : 'none'
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
  /**
   * Bill-to, SNAPSHOTTED off the buyer the same way the name is. An address is
   * where a document was sent, and a buyer who moves next year must not rewrite
   * where last year's invoice says it went.
   */
  billAddr: InvoiceAddress | null
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
  /** See InvoicePushState. Whether the last PUSH worked, not where the document is. */
  qboPushState: InvoicePushState
  /** What Intuit said when it refused. Null once a push succeeds. */
  qboPushError: string | null
  /** When we last TRIED — distinct from qboSyncedAt, which means it worked. */
  qboPushAttemptedAt: string | null
  /** How many times. A number that keeps climbing is a problem, not a blip. */
  qboPushAttempts: number
  /**
   * What QuickBooks last told us about this invoice, and when.
   *
   * Stored rather than derived because the answer comes from somebody else's
   * system over a network that is allowed to be down. Same discipline as the
   * carrier tracking columns: a reading that FAILS never overwrites one that
   * worked, `checkedAt` means we got an answer and `attemptedAt` means we asked,
   * and the screen shows how old the answer is instead of implying it is now.
   *
   * See QboInvoiceObservation for which of these QuickBooks genuinely reports
   * and which two states of the owner's five it does not report at all.
   */
  qboEmailStatus: string | null
  qboDeliveredAt: string | null
  qboBalance: number | null
  qboTotalAmt: number | null
  qboVoided: boolean
  /**
   * The day QuickBooks says the LAST payment against this invoice landed.
   *
   * `YYYY-MM-DD`, and a CALENDAR DAY rather than an instant — it is
   * Payment.TxnDate, the day the money is dated in the books. Format it with
   * formatDay; running it through formatDate prints the day before for everybody
   * west of Greenwich.
   *
   * A DIFFERENT FACT FROM `paidAt`, which is why it is a different column.
   * `paidAt` is the instant somebody on this floor ticked the box, and plenty of
   * invoices here settle in cash that QuickBooks never sees. This is the books'
   * answer, and it is null on every one of those — including, importantly, on an
   * invoice whose balance QuickBooks cleared with a CREDIT MEMO rather than
   * money, where there is no payment and so no date to name.
   */
  qboPaidAt: string | null
  /**
   * What payments — as opposed to credits — have put against this invoice.
   *
   * Kept beside the balance rather than derived from it because they can
   * disagree, and the disagreement is the interesting part: a balance that fell
   * to zero with nothing here is an invoice cleared by a credit memo, a discount
   * or a write-off, not one somebody paid.
   */
  qboPaymentsApplied: number | null
  /** How many payments. Null means nobody has looked; 0 is a real answer. */
  qboPaymentCount: number | null
  qboStatusCheckedAt: string | null
  qboStatusAttemptedAt: string | null
  qboStatusError: string | null
  /** Σ of the line amounts, stored so a list does not have to read every line. */
  total: number
  /** When somebody recorded the money as arrived. Null until they do. */
  paidAt: string | null
  paidBy: string | null
  /**
   * Did the money arrive BEFORE we shipped?
   *
   * A different fact from `paidAt`, not a refinement of it. "They paid the
   * invoice we sent" and "they paid before we picked a single box" are the same
   * amount of money and completely different situations: the second one is what
   * releases an order to the packing floor, and on this floor it is the common
   * case for a case break sold off a stream.
   */
  paidUpFront: boolean
  /** Cash, Zelle, card, wire — whatever the operator says. Never validated. */
  paymentMethod: string | null
  /** A confirmation number, a last four, a note. Theirs, kept verbatim. */
  paymentReference: string | null
  /**
   * When this order was released to be picked and packed. Null until it is.
   *
   * Separate from the stage, deliberately, and the buy side is the precedent:
   * `setPurchaseOrderPaid` records payment WITHOUT moving a purchase order's
   * stage, precisely so a received-but-unpaid order is not dragged backwards to
   * say the money arrived. The sell side had no equivalent — the only way to
   * record that a buyer had paid was to move the card to Paid, which is the LAST
   * column, so an order paid up front looked finished before anybody had picked
   * it.
   */
  readyToShipAt: string | null
  readyToShipBy: string | null
  /**
   * The fulfilment gates. See @shared/fulfillment for what each one decides and
   * why they are asked in the order they are asked in.
   */
  drawnUnits: number
  weightLb: number | null
  lengthIn: number | null
  widthIn: number | null
  heightIn: number | null
  itemsInHandAt: string | null
  itemsInHandBy: string | null
  forceReadyAt: string | null
  forceReadyBy: string | null
  /**
   * What POSTING this order cost us.
   *
   * A cost we carry, not a charge to the buyer — so it is deliberately NOT in
   * `total` and never reaches QuickBooks. Putting it in one and not the other is
   * how our copy and Intuit's come to disagree about a document already sent.
   *
   * Null when nobody has said. See `orderShippingCost` for how this and the
   * per-parcel label costs resolve to ONE number rather than two.
   */
  shippingCost: number | null
  /**
   * The deal ticket this document answers to — the GROUP's number when it has
   * been folded in with others, not its own retired one. Null on anything
   * raised before the register existed.
   */
  dealTicket?: string | null
  /** Was this folded under another document's ticket? */
  dealTicketMerged?: boolean
  /**
   * May the buyer pay this invoice by CARD in QuickBooks?
   *
   * ## What it actually does
   *
   * Sent to Intuit as `AllowOnlineCreditCardPayment`. Unticked, the Pay-by-card
   * button does not appear on the invoice the buyer opens, so the only routes
   * left are the ones that cost this business nothing to receive.
   *
   * ## Why it is per invoice and not a setting
   *
   * Card fees are a percentage, so they scale with the invoice. A few percent is
   * noise on a single box and is real money on a wholesale case order — which is
   * exactly the split this business bills across, and exactly why the answer
   * cannot be one company-wide switch.
   *
   * ## It needs QuickBooks Payments to mean anything
   *
   * The field governs which online methods QuickBooks OFFERS. A company with no
   * Payments connection offers none of them, so the flag changes nothing there —
   * it is not broken, there was simply no button either way.
   *
   * ## It starts OFF
   *
   * It defaulted to true while the box was new, so that nothing changed for
   * invoices raised before it existed. The owner has since asked for the
   * opposite: the fee is a percentage, so OFFERING a card is the decision worth
   * making deliberately, and it should not be the one that happens by not
   * looking at the box.
   *
   * Invoices raised under the old default keep their stored answer — the change
   * is to what a NEW order starts as, never a rewrite of what an existing one
   * already told a buyer.
   */
  allowCreditCard: boolean
  /**
   * The purchase order this sale came from, on a dropship. Null otherwise.
   *
   * By ID and never by number: sync REWRITES po_number on a cross-machine
   * collision, so a link keyed on the number would silently repoint at whatever
   * order inherited it.
   */
  sourcePoId: string | null
  /** Units on this order coming off our own shelf (RM or AM). */
  stockUnits: number
  /** Units a supplier ships straight to the buyer. Never touch a shelf here. */
  dropshipUnits: number
  /** How it ships, and when it settles. See @shared/freight. */
  carrier: Carrier | null
  service: string | null
  trackingNumber: string | null
  paymentTiming: PaymentTiming | null
  trackingStatus: ShipStatusCode | null
  trackingStatusDetail: string | null
  trackingStatusAt: string | null
  trackingCheckedAt: string | null
  /** Why the LAST attempt failed, if it did. Null once one succeeds. */
  trackingError: string | null
  /** When we last ASKED — distinct from checkedAt, which means we got an answer. */
  trackingAttemptedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface InvoiceDetail extends Invoice {
  lines: InvoiceLine[]
}

/**
 * What came back from "save it, and put it in QuickBooks".
 *
 * `invoice` is ALWAYS the saved document, and that is the contract the whole
 * feature rests on: the local write is committed before the network call is
 * made, so a refused push costs the push and never the invoice. A caller that
 * treats a failed push as a failed save would be throwing away a document
 * somebody just typed because Intuit was having an afternoon.
 *
 * So `pushed: false` with a sentence in `error` is a SUCCESSFUL save. The screen
 * says the invoice is safe and the push can be tried again — which is what
 * `qboPushState` on the invoice is for.
 */
export interface InvoicePushResult {
  invoice: InvoiceDetail
  pushed: boolean
  /** Where to look at it in QuickBooks. Null when it did not get there. */
  url: string | null
  docNumber: string | null
  numberChanged: boolean
  /** Why the push failed. Null when it did not. */
  error: string | null
  /**
   * Things that were WANTED and were not resolved — a missing class, a term this
   * company does not have, a SKU that disagrees. Not errors: the invoice posted.
   * They exist so an omission has a voice instead of looking identical to a
   * clean post.
   */
  notes: string[]
}

export interface NewInvoiceLine {
  item: string
  /** The catalog product, when the line was picked rather than typed. */
  productId?: string | null
  /** Omit to take the chosen product's SKU. See resolveLineSku. */
  sku?: string | null
  description?: string | null
  quantity: number
  rate: number
  /** Omit to take quantity × rate. */
  amount?: number | null
  taxRate?: string | null
  className?: string | null
  /**
   * Where this line is fulfilled FROM. Null means the order's location.
   *
   * The sell-side mirror of a purchase order line's destination, and the
   * direction is the only difference: on a PO it is where the goods go, and on a
   * sales order they always go to the buyer, so this is where they come from.
   * 'RM' or 'AM' draws that shelf down. Any other name is a DROPSHIP — the
   * supplier sent it straight to the customer, this business never held it, and
   * no stock moves.
   */
  destination?: string | null
  /** Who shipped it, on a dropshipped line. Null means the order's supplier. */
  supplier?: string | null
}

export interface NewInvoice {
  /**
   * May the buyer pay by card? See Invoice.allowCreditCard.
   *
   * Omitting it means NO on a new order — the default lives in saveInvoice, not
   * only in the form, so a caller that never sets the field cannot quietly
   * start offering cards again.
   *
   * Omitting it on an EDIT leaves the order's own answer alone. The save is an
   * upsert and rewrites the column every time, so anything else would let a
   * change of address withdraw a card button the buyer has already been shown.
   */
  allowCreditCard?: boolean
  /** What postage cost us. Omit to leave it alone. See Invoice.shippingCost. */
  shippingCost?: number | null
  invoiceNumber?: string | null
  customerId?: string | null
  customerName: string
  email?: string | null
  billAddr?: InvoiceAddress | null
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
 *
 * ## The target is the owner's own invoice screen, field for field
 *
 *   QBO form field      Invoice entity field
 *   ------------------  --------------------------------------------------
 *   Customer            CustomerRef.value (+ .name, the display name)
 *   Customer email      BillEmail.Address
 *   Bill-to address     BillAddr.{Line1,Line2,City,CountrySubDivisionCode,
 *                                 PostalCode,Country}
 *   Invoice no.         DocNumber
 *   Terms               SalesTermRef.value
 *   Invoice date        TxnDate
 *   Due date            DueDate
 *   Product/service     Line[].SalesItemLineDetail.ItemRef.value
 *   Description         Line[].Description
 *   Qty                 Line[].SalesItemLineDetail.Qty
 *   Rate                Line[].SalesItemLineDetail.UnitPrice
 *   Amount              Line[].Amount
 *   Class               Line[].SalesItemLineDetail.ClassRef, or the header
 *                       ClassRef — see the note on QboInvoiceRefs.classOn
 *
 * ## SKU IS THE ONE COLUMN WITH NOWHERE TO PUT IT
 *
 * There is no SKU field on an invoice line. SalesItemLineDetail carries
 * ItemRef, ClassRef, TaxCodeRef, MarkupInfo, ItemAccountRef, ServiceDate, Qty,
 * UnitPrice, TaxClassificationRef, TaxInclusiveAmt, DiscountAmt and
 * DiscountRate — and nothing else. The SKU on a printed QuickBooks invoice is
 * read off the ITEM (Item.Sku) and shown when "SKU" is switched on in the sales
 * form settings.
 *
 * So a SKU cannot be pushed onto a line, and pretending otherwise by stuffing it
 * into Description would put a string in the customer-visible column that the
 * SKU column is meant to hold. What this app does instead is make sure the line
 * points at the RIGHT item: the ItemRef is resolved by SKU first and only falls
 * back to the name. Get that right and the SKU column is right, because it is
 * the item's own.
 */
export interface QboRef {
  value: string
  name?: string
}

export interface QboAddress {
  Line1?: string
  Line2?: string
  City?: string
  /** Intuit's name for the state/province. */
  CountrySubDivisionCode?: string
  PostalCode?: string
  Country?: string
}

export interface QboInvoiceLine {
  DetailType: 'SalesItemLineDetail'
  Amount: number
  Description?: string
  SalesItemLineDetail: {
    ItemRef: QboRef
    Qty: number
    UnitPrice: number
    ClassRef?: QboRef
  }
}

export interface QboInvoicePayload {
  DocNumber?: string
  TxnDate: string
  DueDate: string
  CustomerRef: QboRef
  BillEmail?: { Address: string }
  BillAddr?: QboAddress
  SalesTermRef?: QboRef
  ClassRef?: QboRef
  CustomerMemo?: { value: string }
  PrivateNote?: string
  /**
   * Whether QuickBooks offers the buyer a Pay-by-card button.
   *
   * Always sent, never omitted-when-true. Leaving it off would hand the decision
   * back to the company default, so an invoice deliberately marked no-card would
   * silently offer one — and the screen would have said otherwise.
   *
   * Inert without a QuickBooks Payments connection: with no online methods
   * configured there is no button to suppress.
   */
  AllowOnlineCreditCardPayment?: boolean
  Line: QboInvoiceLine[]
}

/** What one QuickBooks Item looks like to the mapper. */
export interface QboItemMatch {
  id: string
  name?: string
  sku?: string | null
}

/**
 * Where a class goes on this company's transactions.
 *
 * Not a preference of ours — it is theirs, read from
 * Preferences.AccountingInfoPrefs.ClassTrackingPerTxn / ...PerTxnLine. Sending
 * a ClassRef to the wrong place is not an error: QuickBooks accepts the payload
 * and DROPS the reference silently, which is the worst possible outcome because
 * the invoice posts and the class is simply missing.
 *
 * 'both' is the honest answer when their preferences could not be read: a
 * reference in the slot their company ignores is discarded without complaint, so
 * sending both lands the class rather than guessing wrong and losing it.
 */
export type QboClassPlacement = 'line' | 'transaction' | 'both' | 'none'

/**
 * The QuickBooks ids this app does not mint, resolved by the caller before the
 * payload is built. Everything here is optional and every one of them is omitted
 * rather than guessed when it could not be resolved — a ClassRef pointing at an
 * id we invented posts real money against the wrong class, and no invoice is
 * worth that.
 */
export interface QboInvoiceRefs {
  /** Resolved from `invoice.terms` against the company's Term list. */
  termRef?: QboRef | null
  /** The "United States" class, resolved or created once. */
  classRef?: QboRef | null
  classOn?: QboClassPlacement
  /** Bill-to. Falls back to the QuickBooks customer's own address. */
  billAddr?: InvoiceAddress | null
  /** Used when the invoice itself carries no email — same fallback rule. */
  billEmail?: string | null
  /** Items keyed by lowercased SKU. Consulted BEFORE the name map. */
  itemsBySku?: Map<string, QboItemMatch>
}

function trimLower(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase()
}

/**
 * Which QuickBooks item a line points at, and why.
 *
 * SKU FIRST. An item renamed in QuickBooks — which happens, because that name is
 * a merchandising decision and gets tidied — still carries the same SKU, and a
 * name-only match would either fail outright or, worse, land on a different item
 * that happens to have taken the old name. The name is the fallback, not the
 * key, and a line with no SKU (a service, a one-off) still resolves by name
 * exactly as it always did.
 */
export function resolveLineItemRef(
  line: { item: string; sku?: string | null },
  itemsByName: Map<string, QboItemMatch>,
  itemsBySku?: Map<string, QboItemMatch>
): QboItemMatch | null {
  const sku = trimLower(line.sku)
  if (sku && itemsBySku) {
    const bySku = itemsBySku.get(sku)
    if (bySku) return bySku
  }
  return itemsByName.get(trimLower(line.item)) ?? null
}

/**
 * Something the invoice names that the connected company does not have.
 *
 * `sku` is carried because it is what a fix should be made ON: creating the item
 * with our SKU makes the NEXT invoice match by SKU, which survives somebody
 * renaming it in QuickBooks afterwards. Creating it by name alone matches once
 * and then breaks the first time the name is tidied.
 */
export interface QboMissingTarget {
  kind: 'customer' | 'item'
  /** Exactly the string that was looked up, so a fix can be made against it. */
  name: string
  /** Ours, for an item. Null for a customer and for a line that carries none. */
  sku: string | null
}

/**
 * What a company would refuse about this invoice, asked before it is sent.
 *
 * Only ever reports things that would STOP the post. The class and the payment
 * terms are deliberately not checked here: both are wanted rather than required,
 * both merely add a note when they miss, and putting them in front of somebody
 * as part of a readiness list would make an invoice that is completely fine look
 * like it has two problems.
 */
export interface QboInvoicePreflight {
  /** True when nothing is missing — the post would not be refused. */
  ready: boolean
  customerName: string
  /** False means QuickBooks has no customer by that name. */
  customerFound: boolean
  missingItems: QboMissingTarget[]
  /**
   * SKU disagreements. NOT blockers — the invoice posts — but worth reading
   * before rather than after, because the fix is on the QuickBooks item and
   * doing it first means the document is right the first time.
   */
  notes: string[]
  /** The subset of those that are a blank SKU, which is fixable in one press. */
  skuFixes: QboSkuFix[]
}

/**
 * Every line QuickBooks cannot resolve — the ONE place that decides that.
 *
 * Both the pre-flight check and the payload builder call this. That is the whole
 * point of it existing: the check that runs while somebody is still typing and
 * the refusal that fires at post time have to agree, and two functions applying
 * "the same" rule is how they come to disagree about a line with a SKU that
 * matches and a name that does not. One function, two callers, no drift.
 *
 * Deduplicated by SKU-then-name. The same missing case on four lines of one
 * invoice is one thing to go and create, and saying it four times reads as four
 * problems.
 */
export function missingQboItems(
  lines: readonly { item: string; sku?: string | null }[],
  itemsByName: Map<string, QboItemMatch>,
  itemsBySku?: Map<string, QboItemMatch>
): QboMissingTarget[] {
  const out: QboMissingTarget[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (resolveLineItemRef(line, itemsByName, itemsBySku)) continue
    const sku = (line.sku ?? '').trim()
    const key = sku ? `s:${sku.toLowerCase()}` : `n:${trimLower(line.item)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: 'item', name: line.item, sku: sku || null })
  }
  return out
}

/**
 * A QuickBooks item that this invoice could give a SKU to.
 *
 * ONLY EVER RAISED FOR A BLANK ONE. An item whose SKU disagrees with ours is a
 * genuine conflict — theirs may be the one their accountant reconciles against —
 * and silently overwriting it from an invoice would be this app deciding a
 * question it has no standing to decide. That case gets a sentence and no
 * button; this one gets a button, because filling in a blank field takes nothing
 * away.
 */
export interface QboSkuFix {
  itemId: string
  itemName: string
  /** Ours, from the line — what the item's blank Sku would be set to. */
  sku: string
}

/**
 * What the SKUs on this invoice say about the items behind them.
 *
 * There is NO SKU field on an invoice line — SalesItemLineDetail carries
 * ItemRef, ClassRef, TaxCodeRef, MarkupInfo, ItemAccountRef, ServiceDate, Qty,
 * UnitPrice, TaxClassificationRef, TaxInclusiveAmt, DiscountAmt and
 * DiscountRate, and that is the whole list. The SKU column on a printed
 * QuickBooks invoice is read off the ITEM. So "send the SKU with the line" is
 * not a thing that can be done, and getting the SKU right means getting the
 * ITEM right — which is why matching resolves by SKU first, and why an item
 * with no SKU is worth saying out loud rather than leaving to be noticed on a
 * document in front of a customer.
 *
 * Neither outcome blocks the invoice. Both change what PRINTS on it.
 */
export function skuReconciliation(
  lines: readonly { item: string; sku?: string | null }[],
  itemsByName: Map<string, QboItemMatch>,
  itemsBySku?: Map<string, QboItemMatch>
): { notes: string[]; fixes: QboSkuFix[] } {
  const notes: string[] = []
  const fixes: QboSkuFix[] = []
  // One item can be on several lines; it is still one item to fix.
  const seen = new Set<string>()

  for (const line of lines) {
    const ours = (line.sku ?? '').trim()
    if (!ours) continue
    const ref = resolveLineItemRef(line, itemsByName, itemsBySku)
    if (!ref) continue
    const theirs = (ref.sku ?? '').trim()

    if (theirs && theirs.toLowerCase() !== ours.toLowerCase()) {
      notes.push(
        `“${line.item}” is SKU ${ours} here and ${theirs} in QuickBooks. The invoice will show ` +
          `${theirs}, because the SKU on an invoice belongs to the QuickBooks item.`
      )
    } else if (!theirs) {
      notes.push(
        `The QuickBooks item for “${line.item}” has no SKU, so SKU ${ours} will not appear on ` +
          'the invoice.'
      )
      if (!seen.has(ref.id)) {
        seen.add(ref.id)
        fixes.push({ itemId: ref.id, itemName: ref.name ?? line.item, sku: ours })
      }
    }
  }
  return { notes, fixes }
}

/**
 * The refusal, in one sentence, from a list of misses.
 *
 * Shared with the pre-flight panel so the warning somebody sees BEFORE pressing
 * Send is word for word the error they would have got after — the two reading
 * differently is what makes a warning feel like a different, second problem.
 */
export function describeMissingQboItems(missing: readonly QboMissingTarget[]): string {
  return (
    `QuickBooks has no product or service called ${missing
      .map((m) => `“${m.name}”`)
      .join(', ')}. Add it in QuickBooks first, or export the CSV instead.`
  )
}

// ---------------------------------------------------------------------------
// Attaching a document
// ---------------------------------------------------------------------------

/** What may carry an attachment. Mirrored in cloud/worker.js, which enforces it. */
export const QBO_ATTACHABLE_ENTITIES = [
  'Invoice',
  'PurchaseOrder',
  'Bill',
  'SalesReceipt',
  'Estimate'
] as const
export type QboAttachableEntity = (typeof QBO_ATTACHABLE_ENTITIES)[number]

/**
 * The Attachable record that goes up beside the bytes.
 *
 * `AttachableRef` IS THE FEATURE. Without it the file uploads perfectly, gets an
 * id, and is attached to nothing — sitting in the company's Attachments list
 * where nobody looking at the invoice will ever see it. That is the failure that
 * looks most like success, so it is built in one place, shared by the direct and
 * the relay paths, and asserted by a test.
 */
export function toQboAttachablePayload(input: {
  entityType: string
  entityId: string
  fileName: string
  mimeType: string
}): Record<string, unknown> {
  const entityType = (input.entityType ?? '').trim()
  if (!(QBO_ATTACHABLE_ENTITIES as readonly string[]).includes(entityType)) {
    throw new Error(`QuickBooks will not take an attachment on a ${entityType || 'blank'}.`)
  }
  const entityId = (input.entityId ?? '').trim()
  // Intuit's ids are numeric. Anything else is a bug on this side, and it is
  // worth failing on rather than posting a reference that resolves to nothing.
  if (!/^[0-9]{1,20}$/.test(entityId)) throw new Error('That is not a QuickBooks id.')
  const fileName = (input.fileName ?? '').trim()
  if (!fileName) throw new Error('An attachment needs a file name.')
  const mimeType = (input.mimeType ?? '').trim()
  if (!mimeType) throw new Error('An attachment needs a content type.')

  return {
    AttachableRef: [{ EntityRef: { type: entityType, value: entityId } }],
    FileName: fileName,
    ContentType: mimeType
  }
}

/**
 * Read Intuit's answer to an upload, which is not shaped like their others.
 *
 * `/upload` returns a LIST — one entry per part — and reports a per-part `Fault`
 * INSIDE a 200 rather than as an HTTP error. So checking the status code is not
 * enough: a perfectly successful-looking response can contain a refusal, and
 * treating it as a success records an attachment that is not there.
 */
export function readQboUploadReply(
  body: unknown,
  fallbackName: string
): { id: string; fileName: string } {
  const response = (body as { AttachableResponse?: unknown })?.AttachableResponse
  const entry = Array.isArray(response) ? response[0] : null
  const fault = (entry as { Fault?: { Error?: Array<{ Message?: string; Detail?: string }> } })?.Fault
  if (fault) {
    const first = fault.Error?.[0]
    const parts = [first?.Message, first?.Detail].filter(Boolean)
    throw new Error(
      parts.length > 0 ? `QuickBooks: ${parts.join(' — ')}` : 'QuickBooks refused the attachment.'
    )
  }
  const attachable = (entry as { Attachable?: { Id?: unknown; FileName?: unknown } })?.Attachable
  const id = attachable?.Id
  if (!id) throw new Error('QuickBooks accepted the file but did not say where it went.')
  return {
    id: String(id),
    fileName: typeof attachable?.FileName === 'string' ? attachable.FileName : fallbackName
  }
}

/** Intuit's own limit on Item.Name. Longer is refused with a numbered fault. */
export const QBO_ITEM_NAME_MAX = 100

/**
 * The body that creates a Product/Service.
 *
 * Pure, and separate from the call, for the same reason `toQboInvoice` is: the
 * two decisions encoded here are about somebody's real books, and both should be
 * pinned by a test rather than discovered in an accountant's report.
 *
 * NON-INVENTORY. QuickBooks would also take `Inventory`, and that would make it
 * track quantity on hand and value the stock — a job this app already does
 * against FIFO cost lots, per location. Two systems counting the same boxes
 * disagree the moment one of them is not told something. `Inventory` also
 * requires an asset account and an inventory start date, which is a balance
 * sheet decision that a button beside an invoice line has no business making.
 * A NonInventory item sells identically on an invoice; it just does not claim to
 * know where the stock is.
 *
 * THE INCOME ACCOUNT IS PASSED IN, NEVER PICKED. An account id this app invented
 * posts real revenue somewhere nobody chose — the same rule the whole
 * integration runs on. A blank one throws here rather than defaulting.
 */
export function toQboItemPayload(input: {
  name: string
  incomeAccountId: string
  sku?: string | null
  rate?: number | null
  description?: string | null
}): Record<string, unknown> {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('An item needs a name.')
  if (name.length > QBO_ITEM_NAME_MAX) {
    throw new Error(
      `QuickBooks item names stop at ${QBO_ITEM_NAME_MAX} characters. Shorten it and try again.`
    )
  }
  const income = (input.incomeAccountId ?? '').trim()
  if (!income) {
    throw new Error(
      'Pick the “Break sales income” account first — Invoices → QuickBooks → Account mapping. ' +
        'A new product has to post its revenue somewhere, and this app will not choose that for ' +
        'you.'
    )
  }
  const sku = (input.sku ?? '').trim()
  const description = (input.description ?? '').trim()
  return {
    Name: name,
    Type: 'NonInventory',
    IncomeAccountRef: { value: income },
    // The SKU is why creating it from here beats creating it by hand: the NEXT
    // invoice matches on it, and a SKU match survives the item being renamed in
    // QuickBooks afterwards. A name match does not.
    ...(sku ? { Sku: sku } : {}),
    ...(description ? { Description: description } : {}),
    ...(typeof input.rate === 'number' && Number.isFinite(input.rate) && input.rate > 0
      ? { UnitPrice: input.rate }
      : {})
  }
}

/**
 * The body that creates a customer.
 *
 * DisplayName and nothing else by default, because DisplayName is the field an
 * invoice matches on. Setting GivenName/FamilyName instead would have
 * QuickBooks compose a display name in an order that may not be the one written
 * here, and the very next send would fail to find the customer just created.
 */
export function toQboCustomerPayload(input: {
  name: string
  email?: string | null
  billAddr?: InvoiceAddress | null
}): Record<string, unknown> {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('A customer needs a name.')
  const email = (input.email ?? '').trim()
  const addr = input.billAddr && hasAddress(input.billAddr) ? toQboAddress(input.billAddr) : null
  return {
    DisplayName: name,
    ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    ...(addr ? { BillAddr: addr } : {})
  }
}

function toQboAddress(a: InvoiceAddress): QboAddress {
  const put = (v: string | null): string | undefined => {
    const s = (v ?? '').trim()
    return s === '' ? undefined : s
  }
  const out: QboAddress = {}
  const line1 = put(a.line1)
  const line2 = put(a.line2)
  const city = put(a.city)
  const region = put(a.region)
  const postal = put(a.postalCode)
  const country = put(a.country)
  if (line1) out.Line1 = line1
  if (line2) out.Line2 = line2
  if (city) out.City = city
  if (region) out.CountrySubDivisionCode = region
  if (postal) out.PostalCode = postal
  if (country) out.Country = country
  return out
}

/**
 * Map one invoice onto Intuit's Invoice resource.
 *
 * `customerRef` and the per-line item refs are QuickBooks ids that this app does
 * not mint — they are looked up from the connected company before this is
 * called. A line whose item resolves to nothing is a line QuickBooks would
 * reject, so the caller resolves them first and this refuses BY NAME rather than
 * posting a document that will half-fail.
 *
 * `refs` is everything else that had to be looked up. Each part is independently
 * optional: a company with no matching Term still gets an invoice, it just gets
 * one on QuickBooks' own default terms rather than one stamped with an id this
 * app made up.
 */
export function toQboInvoice(
  invoice: InvoiceDetail,
  customerRef: { id: string; name?: string },
  itemRefs: Map<string, QboItemMatch>,
  refs: QboInvoiceRefs = {}
): QboInvoicePayload {
  const missing = missingQboItems(invoice.lines, itemRefs, refs.itemsBySku)
  if (missing.length > 0) throw new Error(describeMissingQboItems(missing))

  const classOn = refs.classOn ?? 'none'
  const classRef = refs.classRef ?? null
  const onLine = !!classRef && (classOn === 'line' || classOn === 'both')
  const onTxn = !!classRef && (classOn === 'transaction' || classOn === 'both')

  // The invoice's own snapshot wins; the QuickBooks customer's address is the
  // fallback. That order matters — a buyer who moved is corrected here first,
  // and copying their address onto the document explicitly is precisely what
  // QuickBooks' own form does when you pick a customer.
  const addr = hasAddress(invoice.billAddr)
    ? invoice.billAddr
    : hasAddress(refs.billAddr)
      ? refs.billAddr
      : null
  const email = (invoice.email ?? '').trim() || (refs.billEmail ?? '').trim()

  return {
    // Only sent when we have one. QuickBooks replaces it silently unless the
    // company has "Custom transaction numbers" switched on — which is exactly
    // what Intuit's own template warns about — so `qboDocNumber` records what
    // came back rather than assuming ours survived.
    ...(invoice.invoiceNumber ? { DocNumber: invoice.invoiceNumber } : {}),
    // ALWAYS SENT, both ways. Omitting it when true would hand the decision back
    // to the QuickBooks company default, so an invoice the operator deliberately
    // marked no-card could still show a Pay-by-card button — with this app's own
    // screen saying otherwise. Inert on a company with no QuickBooks Payments
    // connection, which offers no online methods to suppress.
    AllowOnlineCreditCardPayment: invoice.allowCreditCard !== false,
    TxnDate: invoice.invoiceDate,
    DueDate: invoice.dueDate,
    CustomerRef: { value: customerRef.id, ...(customerRef.name ? { name: customerRef.name } : {}) },
    ...(email ? { BillEmail: { Address: email } } : {}),
    ...(addr ? { BillAddr: toQboAddress(addr) } : {}),
    // Terms are a REFERENCE, not the words "Net 30". Sending the string does
    // nothing at all — QuickBooks ignores an unrecognised shape here — so an
    // invoice would silently take the customer's default terms and a due date
    // computed from them, disagreeing with the one on this side.
    ...(refs.termRef ? { SalesTermRef: refs.termRef } : {}),
    ...(onTxn && classRef ? { ClassRef: classRef } : {}),
    // CustomerMemo is the message the BUYER sees; PrivateNote is the internal
    // memo. Intuit's names for them are the wrong way round from how they read,
    // and putting an internal note in front of a customer is the sort of mistake
    // that only gets noticed after it is sent.
    ...(invoice.message ? { CustomerMemo: { value: invoice.message } } : {}),
    ...(invoice.memo ? { PrivateNote: invoice.memo } : {}),
    Line: invoice.lines.map((l) => {
      const ref = resolveLineItemRef(l, itemRefs, refs.itemsBySku)
      return {
        DetailType: 'SalesItemLineDetail' as const,
        Amount: money(l.amount),
        ...(l.description ? { Description: l.description } : {}),
        SalesItemLineDetail: {
          ItemRef: { value: ref?.id ?? '', ...(ref?.name ? { name: ref.name } : {}) },
          Qty: l.quantity,
          UnitPrice: l.rate,
          ...(onLine && classRef ? { ClassRef: classRef } : {})
        }
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Reading a status back out of QuickBooks
//
// THE OWNER NAMED FIVE STATES. QuickBooks reports three of them. This block is
// the honest accounting of which is which, and it is written down here rather
// than discovered later by somebody wondering why a card never says "Viewed".
//
//   OPEN         REAL. An invoice that exists, is not voided, and still has a
//                balance. Read from Balance vs TotalAmt — there is no status
//                string on the entity to read instead.
//   SENT         REAL. EmailStatus becomes 'EmailSent' and DeliveryInfo gains a
//                DeliveryTime the moment QuickBooks emails it. Both are on the
//                Invoice entity. Note it only reflects mail QUICKBOOKS sent: an
//                invoice printed and handed over stays 'NotSet' forever, which
//                is correct rather than broken.
//   VIEWED       NOT AVAILABLE. The "Viewed" state in the QuickBooks web UI is
//                an e-invoicing engagement signal. Nothing on the Invoice entity
//                in the Accounting API reports it — not EmailStatus, whose only
//                values are NotSet / NeedToSend / EmailSent, and not
//                DeliveryInfo, which records when WE sent, not when they opened.
//                So this app does not claim it. A stage that silently never
//                arrives is worse than one that was never offered.
//   PAID         REAL. Balance drops to zero against a non-zero TotalAmt, and
//                LinkedTxn gains entries of TxnType 'Payment'. Partial payment
//                is visible too (0 < Balance < TotalAmt) and is deliberately NOT
//                reported as paid.
//   PAYOUT SENT  NOT AVAILABLE. Money leaving QuickBooks Payments for the
//                owner's bank is a QuickBooks PAYMENTS concept, on a different
//                API behind the com.intuit.quickbooks.payment scope, which this
//                app does not request (see QBO_SCOPE — accounting only). The
//                Accounting API's Invoice carries no link to a payout, and the
//                Payment entity's DepositToAccountRef describes a bookkeeping
//                destination rather than a bank transfer that actually settled.
//                Inferring "payout sent" from it would be a guess about somebody
//                else's money.
//
// VOIDED is a fourth thing worth reading and is only HALF available: v3 has no
// status field for it, and the recognised signature is a zeroed invoice whose
// PrivateNote begins "Voided". That is a heuristic, it is labelled as one below,
// and it is only ever allowed to move an invoice to void — never to move one
// back out of it.
// ---------------------------------------------------------------------------

/**
 * Does this look like a voided invoice?
 *
 * There is no field to ask. v3 has no status on the Invoice entity for it, so
 * the recognised signature is the one QuickBooks leaves behind: every amount
 * zeroed and the word written into the private note.
 *
 * BOTH HALVES ARE REQUIRED. A genuinely zero-value invoice with a note somebody
 * typed must not read as voided, and a note mentioning a void on an invoice that
 * still has a balance is describing something else entirely — most often the
 * instruction not to.
 *
 * The note QuickBooks writes reads "Voided" or "Voided - RC 93", so the test is
 * on the START of it rather than a substring anywhere inside: "do not void this
 * one" contains the word and means the opposite.
 *
 * Lives here, with the rest of the mapping, so it can be tested without a
 * network or an OAuth token — which is the part a live call is worst at
 * checking.
 */
export function looksVoidedInQbo(raw: {
  totalAmt?: number | null
  balance?: number | null
  privateNote?: string | null
}): boolean {
  const zeroed = (raw.totalAmt ?? 0) === 0 && (raw.balance ?? 0) === 0
  return zeroed && (raw.privateNote ?? '').trim().toLowerCase().startsWith('voided')
}

/**
 * One payment QuickBooks has applied to an invoice.
 *
 * Reached by FOLLOWING the invoice's LinkedTxn. The Invoice entity carries only
 * `{ TxnId, TxnType: 'Payment' }` — an id and a word — and every fact worth
 * having about the money is on the Payment entity that id points at. This app
 * used to read that link and COUNT it, which is why it could say an invoice was
 * paid and never when.
 */
export interface QboInvoicePayment {
  /** The Payment entity's id. */
  id: string
  /**
   * Payment.TxnDate — A CALENDAR DAY, `YYYY-MM-DD`, and never an instant.
   *
   * This is the day a payment is DATED in somebody's books: a wall-clock fact
   * about a ledger, not a physical moment. Promoting it to an instant to sit
   * beside `paidAt` would be the mistake written down all over this codebase — a
   * date-only string read as local midnight and shifted lands on the day before,
   * and on a payment that is the wrong month at every month end.
   */
  date: string
  /**
   * How much of this payment landed on THIS invoice.
   *
   * NOT `Payment.TotalAmt`. One payment settles several invoices — a buyer
   * clearing three cases with one transfer is the ordinary case here — and the
   * share belonging to this invoice is on the payment LINE that links to it.
   * Taking the payment's total would credit every invoice in the batch with the
   * whole transfer.
   */
  amount: number
}

/** What QuickBooks actually said about one invoice, verbatim where possible. */
export interface QboInvoiceObservation {
  qboId: string
  docNumber: string | null
  /** 'NotSet' | 'NeedToSend' | 'EmailSent'. Kept as a string: it is theirs. */
  emailStatus: string | null
  /** DeliveryInfo.DeliveryTime — when QUICKBOOKS sent it, not when it was read. */
  deliveredAt: string | null
  balance: number | null
  totalAmt: number | null
  /** LinkedTxn entries of TxnType 'Payment'. Zero is a real answer, not unknown. */
  linkedPayments: number
  /**
   * The payments themselves, once the linked ids have been followed.
   *
   * EMPTY IS AMBIGUOUS AND THAT IS DELIBERATE: it means either "no payments" or
   * "we did not go and look", and `linkedPayments` beside it is what tells the
   * two apart. A reader that needs to know which is which compares the two
   * rather than being handed a third field that can fall out of step with both.
   */
  payments: QboInvoicePayment[]
  /** The zeroed-and-annotated signature described above. A heuristic. */
  voided: boolean
}

/**
 * The day of the LATEST payment, or null when there is none to name.
 *
 * Latest rather than first, because the question being asked is "when was this
 * settled" and an invoice paid in three instalments was settled on the third.
 * The first instalment is still visible — every payment is carried — this is
 * only which one gets to be the date on the card.
 *
 * Compared as strings, which is exact for `YYYY-MM-DD` and avoids parsing a
 * calendar day into an instant to sort it. Anything not shaped like a day is
 * skipped rather than coerced: QuickBooks always sends one, and a value that is
 * not one is better absent than silently ordered as NaN.
 */
export function latestPaymentDate(payments: readonly QboInvoicePayment[]): string | null {
  let latest: string | null = null
  for (const p of payments) {
    // ZERO-AMOUNT LINES DO NOT GET TO BE THE DATE, and this is the subtle one.
    // QuickBooks materialises the application of a CREDIT MEMO as a Payment of
    // $0.00 carrying a perfectly real TxnDate. Following the link and taking that
    // date would print "paid 12 Aug" on an invoice against which no money has
    // ever moved — the single most misleading thing this feature could do, since
    // the whole point of it is to answer when the money arrived.
    if (!((Number(p?.amount) || 0) > 0)) continue
    const day = (p?.date ?? '').trim()
    if (!DAY_RE.test(day)) continue
    if (latest === null || day > latest) latest = day
  }
  return latest
}

/** What payments — as opposed to credits — have actually put against an invoice. */
export function paymentsApplied(payments: readonly QboInvoicePayment[]): number {
  return money(payments.reduce((sum, p) => sum + (Number(p?.amount) || 0), 0))
}

// ---------------------------------------------------------------------------
// How far through being paid an invoice is
//
// THE SELL-SIDE MIRROR OF RECEIVING PROGRESS, and deliberately the same shape as
// @shared/receiving so the two rails on the two boards are one idea seen from
// each end: a purchase order asks how much of what we ordered has ARRIVED, and a
// sales order asks how much of what we billed has been PAID. Same component,
// same colours, same rounding rule — money in place of units.
// ---------------------------------------------------------------------------

export type InvoicePaymentState = 'unknown' | 'unpaid' | 'partial' | 'paid' | 'over'

export interface InvoicePaymentProgress {
  state: InvoicePaymentState
  /**
   * Where these numbers came from, because the two are not the same kind of fact.
   *
   *   quickbooks  a balance read off the books
   *   local       the tick somebody put on the board — their word that the money
   *               arrived, which is real and useful and is NOT a reconciliation
   *   none        nobody has said anything either way
   */
  source: 'quickbooks' | 'local' | 'none'
  total: number
  paid: number
  /** What is still owed. Never negative — see `excess` for the other direction. */
  outstanding: number
  /** How much MORE than the invoice arrived. 0 in every ordinary case. */
  excess: number
  /** 0..1, clamped. For a bar's width. */
  fraction: number
  /** 0..100, for print. Pinned inside 1..99 while partial — see below. */
  percent: number
  /** The day QuickBooks says the last payment landed. Null when unknown. */
  paidOn: string | null
}

/**
 * How far through being paid this invoice is.
 *
 * ## The thresholds are the stage machinery's, not new ones
 *
 * `balance <= 0` against a positive total is paid, exactly as `observedPaid`
 * decides it. Inventing a cent of tolerance here would let the rail read "paid"
 * on a card the board still has sitting in Sent, and two screens disagreeing
 * about the same invoice is worse than either being slightly conservative.
 *
 * ## The rounding rule, which is the only subtle thing here
 *
 * Copied from `receiveProgress` for the same reason it exists there. $999.50 of
 * $1000 is 99.95%, which rounds to 100 — and a "100%" on an invoice with money
 * still owed is the reading that stops somebody chasing it. Fifty cents of
 * $1000 is 0.05%, which rounds to 0 — and "0%" on an invoice that has started
 * being paid sends somebody chasing a buyer who has already sent something. So
 * a PARTIAL payment is pinned inside 1..99, and 0 and 100 are reserved for the
 * two states that really are none and all.
 */
export function invoicePaymentProgress(invoice: {
  status: InvoiceStatus
  total: number
  qboBalance: number | null
  qboTotalAmt: number | null
  qboVoided: boolean
  qboPaidAt: string | null
}): InvoicePaymentProgress {
  const paidOn = (invoice.qboPaidAt ?? '').trim() || null
  const total = money(Number(invoice.qboTotalAmt) || 0)
  const readable =
    invoice.qboTotalAmt !== null && invoice.qboBalance !== null && !invoice.qboVoided && total > 0

  if (!readable) {
    // No balance to read. The only other fact available is the tick on the
    // board, and it is a different KIND of fact — somebody's word that the money
    // arrived — so it is labelled as one rather than dressed up as a reading.
    if (invoice.status === 'paid') {
      const local = money(Number(invoice.total) || 0)
      return {
        state: 'paid',
        source: 'local',
        total: local,
        paid: local,
        outstanding: 0,
        excess: 0,
        fraction: 1,
        percent: 100,
        paidOn
      }
    }
    return {
      state: 'unknown',
      source: 'none',
      total: 0,
      paid: 0,
      outstanding: 0,
      excess: 0,
      fraction: 0,
      percent: 0,
      paidOn
    }
  }

  const balance = money(Number(invoice.qboBalance) || 0)
  const paid = money(total - balance)
  const state: InvoicePaymentState =
    balance < 0 ? 'over' : balance === 0 ? 'paid' : paid <= 0 ? 'unpaid' : 'partial'
  const fraction = Math.max(0, Math.min(1, paid / total))
  const percent =
    state === 'partial'
      ? Math.min(99, Math.max(1, Math.round(fraction * 100)))
      : Math.round(fraction * 100)

  return {
    state,
    source: 'quickbooks',
    total,
    paid,
    outstanding: money(Math.max(0, balance)),
    excess: money(Math.max(0, -balance)),
    fraction,
    percent,
    paidOn
  }
}

/**
 * The tone a screen paints this in.
 *
 * GREEN ONLY WHEN IT IS SETTLED, the same rule the receiving rail follows. A
 * part-paid invoice in green reads as collected to anybody not reading the
 * figures, which is precisely the mistake worth preventing on a screen whose job
 * is "who still owes us". Over-payment is the danger tone because more money
 * than the invoice is a discrepancy to go and look at, not progress.
 */
export function paymentTone(p: InvoicePaymentProgress): 'idle' | 'partial' | 'done' | 'over' {
  switch (p.state) {
    case 'paid':
      return 'done'
    case 'partial':
      return 'partial'
    case 'over':
      return 'over'
    default:
      return 'idle'
  }
}

/**
 * The rail's sentence, in one place so the card and its tooltip agree.
 *
 * Takes the money formatter rather than importing one: formatting lives in the
 * renderer, this file is shared with the main process, and a second rounding
 * rule invented here to avoid the import is how two screens come to print the
 * same figure differently.
 */
export function paymentSummary(
  p: InvoicePaymentProgress,
  fmt: (n: number) => string
): string {
  switch (p.state) {
    case 'unknown':
      return 'QuickBooks has not said anything about this invoice yet'
    case 'unpaid':
      return `Nothing paid of ${fmt(p.total)}`
    case 'partial':
      return `${fmt(p.paid)} of ${fmt(p.total)} paid · ${fmt(p.outstanding)} still owed`
    case 'over':
      return `${fmt(p.paid)} received against ${fmt(p.total)} — ${fmt(p.excess)} more than the invoice`
    default:
      return p.source === 'local'
        ? `${fmt(p.total)} — marked paid here, not read from QuickBooks`
        : `${fmt(p.total)} paid in full`
  }
}

/**
 * Ticked paid on this board while QuickBooks still shows money owing.
 *
 * Not an error, and deliberately not something that moves the card: paid is
 * operator-recorded here and plenty of these settle in cash QuickBooks never
 * sees, which is exactly why `nextStageFromQbo` refuses to drag a paid invoice
 * back. But a card sitting in Paid above a half-full rail looks like a bug
 * unless something says why, so this is the flag that lets the screen say it.
 */
export function paidHereNotThere(invoice: {
  status: InvoiceStatus
  qboBalance: number | null
  qboTotalAmt: number | null
  qboVoided: boolean
}): boolean {
  if (invoice.status !== 'paid' || invoice.qboVoided) return false
  if (invoice.qboBalance === null || invoice.qboTotalAmt === null) return false
  return invoice.qboTotalAmt > 0 && invoice.qboBalance > 0
}

/**
 * Settled, but not by anybody sending money.
 *
 * A balance reaching zero is what `observedPaid` reads, and at least three
 * things get it there without a payment: a CREDIT MEMO applied against the
 * invoice, a bad-debt WRITE-OFF, and a DISCOUNT or deposit recorded on the
 * document. In every one of them the invoice is genuinely closed and genuinely
 * unpaid, and a card reading "Paid" with no date beside it looks like the date
 * is missing rather than like there was never a payment to date.
 *
 * Null `qboPaymentsApplied` means nobody has looked, which is not evidence of
 * anything, so it is deliberately NOT reported as a clearance.
 */
export function clearedWithoutPayment(invoice: {
  qboBalance: number | null
  qboTotalAmt: number | null
  qboVoided: boolean
  qboPaymentsApplied: number | null
}): boolean {
  if (invoice.qboVoided) return false
  if (invoice.qboBalance === null || invoice.qboTotalAmt === null) return false
  if (!(invoice.qboTotalAmt > 0 && invoice.qboBalance <= 0)) return false
  if (invoice.qboPaymentsApplied === null) return false
  return money(invoice.qboPaymentsApplied) < money(invoice.qboTotalAmt)
}

// ---------------------------------------------------------------------------
// Binding a local order to a QuickBooks invoice by the number on it
//
// THE PROBLEM THIS SOLVES: an order written here that was invoiced in QuickBooks
// by hand has no `qboId`, so nothing on this side ever hears that it was paid.
// The number is the only thing the two documents have in common.
//
// THE REASON IT IS NOT AUTOMATIC: a number is a UNIQUENESS test, never an
// IDENTITY test. The two series are computed from disjoint knowledge — this app
// takes max+1 over its own rows (see nextInvoiceNumber) while QuickBooks takes
// max+1 over its own — so the moment the owner raises one invoice by hand the
// two counters both offer the same next number for two unrelated documents.
// That is not an edge case; it is what both counters do when they are working.
//
// And a wrong binding is not a wrong label. `qboId` is what Delete sends
// `operation=delete` against, what Send emails to this buyer, and what the
// status pull reads a stage from — and a QuickBooks invoice that has been voided
// reads back as `void`, which on this side calls releaseInvoiceStock and DELETES
// the order's stock ledger. Every one of those is unrecoverable.
//
// So the app finds the candidates, checks everything it can check, and shows its
// working to somebody who presses the button. What is automatic is what happens
// AFTER: once an order is bound, the ordinary status pull moves it to paid the
// moment QuickBooks says the balance is clear. The dangerous half is the press;
// the useful half is free.
// ---------------------------------------------------------------------------

/** A QuickBooks invoice offered as the counterpart of a local one. */
export interface QboInvoiceMatch {
  qboId: string
  docNumber: string | null
  /** CustomerRef.name — the only customer key this app actually has. */
  customerName: string | null
  /** TxnDate, a calendar day. */
  txnDate: string | null
  totalAmt: number | null
  balance: number | null
  voided: boolean
}

/**
 * Why a candidate was refused. Each one is shown to somebody, so each one is a
 * distinct thing that could be true rather than a general "no".
 */
export type InvoiceMatchRefusal =
  | 'no-number'
  | 'not-eligible'
  | 'none'
  | 'ambiguous-there'
  | 'ambiguous-here'
  | 'claimed'
  | 'voided'
  | 'customer'
  | 'total'
  | 'date'

/** How far apart the two dates may be before the match is refused. */
export const MATCH_DAY_WINDOW = 7

export type InvoiceMatchVerdict =
  | { ok: true; match: QboInvoiceMatch }
  | { ok: false; reason: InvoiceMatchRefusal }

function dayGap(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T12:00:00Z`)
  const tb = Date.parse(`${b}T12:00:00Z`)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.abs(Math.round((ta - tb) / DAY_MS))
}

/**
 * Whether this local order may be bound to one of these QuickBooks invoices.
 *
 * `candidates` is every QuickBooks invoice carrying this local one's number —
 * every one, including the several that come back when a company has custom
 * transaction numbers switched off and QuickBooks has allowed a duplicate.
 * Narrowing that list before it arrives here would hide the ambiguity from the
 * only code equipped to refuse it.
 *
 * Refuses on the FIRST thing that is wrong, in the order somebody would check
 * them, so the reason reported is the most fundamental one rather than whichever
 * test happened to run last.
 */
export function matchInvoiceByDocNumber(
  local: {
    invoiceNumber: string
    customerName: string
    invoiceDate: string
    total: number
    status: InvoiceStatus
    qboPushState: InvoicePushState
  },
  candidates: readonly QboInvoiceMatch[],
  context: {
    /** How many LOCAL rows carry this number, across every status. */
    localsWithNumber: number
    /** QuickBooks ids some local row already holds. */
    claimed: ReadonlySet<string>
  }
): InvoiceMatchVerdict {
  const number = (local.invoiceNumber ?? '').trim()
  if (!number) return { ok: false, reason: 'no-number' }

  // A voided order has already released its stock and a paid one is terminal;
  // binding either can only cause a move that cannot be taken back. 'pending'
  // means a push may be in flight or may have died mid-flight — the one state
  // where this app already believes a QuickBooks invoice might exist for this
  // row, and the last state in which to go guessing which one it is.
  if (local.status === 'void' || local.status === 'paid') {
    return { ok: false, reason: 'not-eligible' }
  }
  if (local.qboPushState === 'pending') return { ok: false, reason: 'not-eligible' }

  if (candidates.length === 0) return { ok: false, reason: 'none' }
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous-there' }
  // Checked across every status, not just the ones offered for matching: two
  // local rows numbered 2301 means binding one of them is a coin toss, and which
  // row is processed first is arbitrary.
  if (context.localsWithNumber !== 1) return { ok: false, reason: 'ambiguous-here' }

  const match = candidates[0]
  if (context.claimed.has(match.qboId)) return { ok: false, reason: 'claimed' }

  // NEVER A VOID SHELL. This is the guard standing between a string comparison
  // and a deleted stock ledger: a bound void reads back as stage 'void', and
  // moving a local order there restores its FIFO layers and erases its stock
  // moves, for units a picker may already have shipped.
  if (match.voided) return { ok: false, reason: 'voided' }

  const here = (local.customerName ?? '').trim().toLowerCase()
  const there = (match.customerName ?? '').trim().toLowerCase()
  // The same key the push itself matches customers on. InvoiceCustomer.qboId
  // exists on the type but nothing in this app ever writes it, so a check
  // against it would either block everything or do nothing.
  if (!here || !there || here !== there) return { ok: false, reason: 'customer' }

  // TO THE CENT, and this is the guard that kills the case nothing else catches:
  // one local order billed as TWO QuickBooks invoices. Exactly one of them
  // carries the number, its balance clears, and the whole order would be
  // reported collected while half of it is still owed.
  if (match.totalAmt === null || money(match.totalAmt) !== money(local.total)) {
    return { ok: false, reason: 'total' }
  }

  const gap = match.txnDate ? dayGap(match.txnDate, local.invoiceDate) : null
  if (gap === null || gap > MATCH_DAY_WINDOW) return { ok: false, reason: 'date' }

  return { ok: true, match }
}

/** One local order, and the QuickBooks invoice it could be bound to. */
export interface InvoiceMatchProposal {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  invoiceDate: string
  total: number
  status: InvoiceStatus
  /** The QuickBooks side, exactly as it came back, so a person can compare. */
  match: QboInvoiceMatch
}

/** A local order that was looked at and refused, and what stopped it. */
export interface InvoiceMatchRejection {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  reason: InvoiceMatchRefusal
  /** The candidate refused, when exactly one could be named. */
  match: QboInvoiceMatch | null
}

/** What a scan for matchable orders found. A pure READ — nothing is bound by it. */
export interface InvoiceMatchScan {
  proposals: InvoiceMatchProposal[]
  /**
   * Refusals worth putting in front of somebody. 'none' is left out: an order
   * QuickBooks has never heard of is the ordinary case, not a problem, and a
   * list mostly made of it would bury the four that nearly matched.
   */
  rejected: InvoiceMatchRejection[]
  scanned: number
  /**
   * How many invoices this app has posted whose QuickBooks number came back
   * DIFFERENT from the one sent.
   *
   * The premise of matching on a number is that both systems use the same one.
   * QuickBooks silently replaces DocNumber unless the company has "Custom
   * transaction numbers" switched on — and when it does, `invoice_number` and
   * `DocNumber` are two unrelated series and every match found here is a
   * coincidence. This app already records both, so the evidence is free: any
   * non-zero count means the screen should say so before anybody presses a
   * button.
   */
  renumbered: number
}

/** The refusal in words, for the screen that lists what was and was not matched. */
export function describeMatchRefusal(reason: InvoiceMatchRefusal): string {
  switch (reason) {
    case 'no-number':
      return 'This order has no invoice number to match on.'
    case 'not-eligible':
      return 'Only orders that are still open can be matched — this one is paid, void, or mid-push.'
    case 'none':
      return 'QuickBooks has no invoice with this number.'
    case 'ambiguous-there':
      return 'QuickBooks has more than one invoice with this number, so which one this is cannot be told from the number alone.'
    case 'ambiguous-here':
      return 'More than one order here carries this number.'
    case 'claimed':
      return 'That QuickBooks invoice is already attached to another order.'
    case 'voided':
      return 'That QuickBooks invoice has been voided.'
    case 'customer':
      return 'The buyer on the QuickBooks invoice is a different name.'
    case 'total':
      return 'The QuickBooks invoice is for a different amount.'
    default:
      return `The QuickBooks invoice is dated more than ${MATCH_DAY_WINDOW} days from this one.`
  }
}

/**
 * Fully settled?
 *
 * A zero balance on a zero total is NOT paid — that is what a voided or empty
 * invoice looks like, and reporting it as paid would put money in the paid total
 * that nobody ever sent.
 */
export function observedPaid(o: QboInvoiceObservation): boolean {
  if (o.voided) return false
  if (o.balance === null || o.totalAmt === null) return false
  return o.totalAmt > 0 && o.balance <= 0
}

/** Some money in, but not all of it. Reported separately — it is not paid. */
export function observedPartiallyPaid(o: QboInvoiceObservation): boolean {
  if (o.voided) return false
  if (o.balance === null || o.totalAmt === null) return false
  return o.totalAmt > 0 && o.balance > 0 && o.balance < o.totalAmt
}

/** Did QuickBooks email it? The only "sent" this API can honestly report. */
export function observedSent(o: QboInvoiceObservation): boolean {
  return o.emailStatus === 'EmailSent' || !!o.deliveredAt
}

/**
 * The stage QuickBooks' answer implies — or null when it implies nothing.
 *
 * Highest-water-mark order, because these are not exclusive: a paid invoice was
 * also emailed, and reporting it as merely sent would walk the board backwards
 * every time it was refreshed.
 *
 * Null rather than 'draft' when nothing can be concluded. A draft is a local
 * state that by definition has no QuickBooks invoice behind it, so an
 * observation can never mean it, and returning it would drag a posted invoice
 * back to the first column.
 */
export function observedInvoiceStage(o: QboInvoiceObservation): InvoiceStatus | null {
  if (o.voided) return 'void'
  if (observedPaid(o)) return 'paid'
  if (observedSent(o)) return 'sent'
  // It exists in QuickBooks and nothing more can be said about it. That IS the
  // "Open" state on their screen, and 'created' is this board's name for it.
  if (o.balance !== null || o.totalAmt !== null) return 'created'
  return null
}

/**
 * What a pull should do to one local invoice, given what QuickBooks said.
 *
 * Only ever FORWARD, and only along a legal transition. Two rules are doing real
 * work here:
 *
 *   - A locally-paid invoice is never dragged back. Paid is operator-recorded on
 *     this floor — cash and Zelle settle plenty of these without QuickBooks ever
 *     seeing the money — so QuickBooks reporting an outstanding balance is not
 *     evidence the money did not arrive. INVOICE_TRANSITIONS already makes paid
 *     terminal, and this leans on that rather than restating it.
 *   - An observation that implies nothing changes nothing. A network answer we
 *     could not read must never be the reason a card moves.
 */
export function nextStageFromQbo(
  current: InvoiceStatus,
  o: QboInvoiceObservation
): InvoiceStatus | null {
  const observed = observedInvoiceStage(o)
  if (!observed || observed === current) return null
  return canMoveInvoice(current, observed) ? observed : null
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
 * WHERE THE APP'S NUMBERING BEGINS.
 *
 * Set to the owner's next real invoice number, because the series did not start
 * here — invoices were raised in QuickBooks by hand first, and the app must
 * carry on from where the business actually is rather than opening a second
 * series that collides with it.
 *
 * A floor, not a fixed value: once local numbering passes it, the highest
 * number seen wins. See `nextInvoiceNumber`.
 */
export const INVOICE_NUMBER_START = 2293

/**
 * The next invoice number, given what has been used.
 *
 * Numeric strings advance; anything else falls back to a fresh series rather
 * than guessing. "INV-0042" incremented naively becomes "INV-0043" only if you
 * decide which digits are the counter, and deciding wrong on somebody's real
 * numbering is worse than starting a new one they can overwrite.
 */
export function nextInvoiceNumber(existing: string[], start = INVOICE_NUMBER_START): string {
  const numeric = existing
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0)
  // THE FLOOR IS NOT JUST FOR AN EMPTY LIST. The app's own history begins after
  // a run of invoices raised in QuickBooks by hand, so the highest number here
  // can be far below the highest number the BUSINESS has issued. Taking
  // max+1 from local rows alone would re-issue numbers a customer has already
  // been billed under, and QuickBooks would either refuse the duplicate or
  // accept it and leave two documents claiming one number.
  const highest = numeric.length ? Math.max(...numeric) : 0
  return String(Math.max(highest + 1, start))
}

/**
 * One product line sold on a sales order, priced against the exact FIFO layers
 * it consumed — the Wholesale report's row.
 *
 * Lives here rather than beside the query because three layers name it: the main
 * process builds it, the bridge declares it, and the screen renders it. A type
 * that crosses the boundary belongs on the boundary.
 */
export interface WholesaleSaleRow {
  invoiceId: string
  invoiceNumber: string
  invoiceDate: string
  customerName: string
  status: string
  productId: string
  productName: string
  sku: string
  location: string
  quantity: number
  unitPrice: number
  revenue: number
  cost: number
  margin: number
  /** False for a pre-v68 line, whose layers cannot be recovered. */
  costKnown: boolean
}

// ---------------------------------------------------------------------------
// Adding a product to an order that already has it
// ---------------------------------------------------------------------------

/** The parts of a draft line that decide how it is fulfilled. */
export interface FulfilmentLine {
  /** Stable identity of the row on screen. */
  key: string
  productId: string
  /** Where it is fulfilled FROM. Empty inherits the order's location. */
  destination: string
}

/**
 * The line a newly picked product should be ADDED TO, or undefined for a new one.
 *
 * ## One order can sell the same product two ways at once
 *
 * A dropship of three cases straight from the supplier, plus two off our own
 * shelf, is one sale to one buyer — and it has to be two lines, because only one
 * of them draws stock. `saveInvoice` has always decided that per line, and
 * `tests/invoiceDropship.test.ts` pins it with the same product on both halves.
 *
 * The screen was the half that could not express it. Picking a product already
 * on the order bumped whichever line held it, so on a dropship-prefilled order
 * the only way to add two from stock was to turn three dropshipped cases into
 * five — which invoices the buyer for the right total by accident while drawing
 * no stock at all, leaving the shelf up for units that have been sold.
 *
 * ## The rule
 *
 * A pick merges only into a line fulfilled the way the new line would be: off
 * our own shelf. A dropship line is never absorbed, which is what makes the
 * second line possible. `destinationHoldsStock` is the same test the save path
 * applies, so the screen cannot disagree with the stock engine about which lines
 * are which.
 *
 * Returns ONE line. The rule this replaced mapped across every line carrying the
 * product, so once an order legitimately held two of them a single pick added
 * one to both.
 */
export function stockLineForProduct<T extends FulfilmentLine>(
  lines: readonly T[],
  productId: string,
  orderLocation: string
): T | undefined {
  // An empty id is a saved or hand-typed line with no catalog link. Treating
  // those as matches would collapse every one of them onto the first pick.
  if (!productId) return undefined
  return lines.find(
    (l) =>
      l.productId === productId &&
      destinationHoldsStock(l.destination || orderLocation || LOCATION_IDS[0])
  )
}

/**
 * What kind of sale this is, derived from where its units come FROM.
 *
 * The exact mirror of `orderKindOf` on the buy side, and derived for the same
 * reason: a stored flag would be a second truth that drifts the first time
 * somebody re-routes a line, and the failure mode is a sale that still looks
 * like ordinary stock while drawing none.
 *
 * Three answers rather than two, because after mixed sales orders landed an
 * order can be PART of a dropship without being one — three cases shipped
 * direct from the supplier plus two off our own shelf is one sale to one buyer.
 * The board colours those differently: a full dropship is the warm card, a mixed
 * one gets the stripe, exactly as a purchase order does.
 *
 * A LINKED SALE COUNTS EVEN WITH NO DROPSHIPPED UNITS. `sourcePoId` is set when
 * somebody declares this sale to be the other half of a purchase order, and that
 * is a statement about the deal rather than about the routing on its lines. An
 * order whose lines were later re-pointed at a shelf is still the sale that
 * purchase was raised for, and hiding that on the board would lose the only
 * on-screen trace of the pair.
 */
export type SalesOrderKind = 'stock' | 'drop' | 'mixed'

export function salesOrderKindOf(invoice: {
  stockUnits: number
  dropshipUnits: number
  sourcePoId: string | null
}): SalesOrderKind {
  const stock = Number(invoice.stockUnits) || 0
  const drop = Number(invoice.dropshipUnits) || 0
  // An order with no lines yet has nothing to derive from. It reads as ordinary
  // stock unless it is LINKED, which is a fact somebody asserted rather than one
  // inferred from an empty list — without this an empty draft raised from a
  // dropship would show as plain until its first line was typed.
  if (stock <= 0 && drop <= 0) return invoice.sourcePoId ? 'drop' : 'stock'
  if (drop <= 0) return invoice.sourcePoId ? 'mixed' : 'stock'
  if (stock <= 0) return 'drop'
  return 'mixed'
}

/** True when any part of this sale is a dropship — either routing or a link. */
export function isDropshipSale(invoice: {
  stockUnits: number
  dropshipUnits: number
  sourcePoId: string | null
}): boolean {
  return salesOrderKindOf(invoice) !== 'stock'
}
