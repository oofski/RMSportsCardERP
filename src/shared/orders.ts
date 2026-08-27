/**
 * What is true of BOTH an order we place and an order we take.
 *
 * A purchase order and a sales order are mirror images — money out and money in
 * — and four questions are asked identically of each: how did it get to the
 * stage it is at, what is it shipping in, what paperwork is attached to it, and
 * who did all that. Modelling those twice, once per side, would be two sets of
 * queries and two sets of migrations, and the first time they drifted would be a
 * feature that quietly only worked on the buy side.
 *
 * So the reference is a PAIR: `kind` says which board the order is on and `id`
 * says which order. Deliberately not a foreign key — SQLite cannot express a
 * reference whose target table depends on a sibling column — and deliberately
 * not two nullable columns with a check constraint, which buys nothing a query
 * does not already have to say.
 */

/** Which board an order lives on. 'po' buys, 'so' sells. */
export type OrderSide = 'po' | 'so'

export function isOrderSide(v: unknown): v is OrderSide {
  return v === 'po' || v === 'so'
}

/** How an order of this side is spoken about, for messages a person reads. */
export function orderSideLabel(side: OrderSide): string {
  return side === 'po' ? 'purchase order' : 'sales order'
}

// ---------------------------------------------------------------------------
// What happened to an order
// ---------------------------------------------------------------------------

/**
 * The kinds of thing worth writing down.
 *
 * WIDER THAN STAGE CHANGES ON PURPOSE. A stage move is the common entry, but
 * "paid up front", "label uploaded", "emailed to the supplier" and "linked to
 * sales order 2301" are the same kind of fact — something a person did to this
 * order at a moment — and splitting them across four tables would mean four
 * queries to draw one list in date order.
 *
 * NOTHING IS EVER REMOVED FROM THIS LIST. A kind is stored as the word itself on
 * rows that are already written, so dropping one does not tidy anything — it
 * orphans every event holding it, and an event whose kind cannot be read is a
 * line in a log that renders blank.
 */
export type OrderEventKind =
  | 'created'
  | 'stage'
  | 'paid'
  | 'ready'
  | 'shipment'
  | 'label'
  | 'email'
  | 'link'
  | 'note'

/** One thing that happened to one order. Immutable once written. */
export interface OrderEvent {
  id: string
  side: OrderSide
  orderId: string
  kind: OrderEventKind
  /** The stage it came from, on a stage move. Null on everything else. */
  fromStage: string | null
  toStage: string | null
  /** A sentence about what happened. Already written for a person to read. */
  detail: string | null
  actorId: string | null
  /**
   * The actor's name AS IT WAS when they did it.
   *
   * Snapshotted for the same reason an invoice snapshots its customer: a log is
   * a record of what happened, and somebody leaving next year must not silently
   * rewrite who did what. The id is kept beside it so the row can still be
   * joined while the person is still here.
   */
  actorName: string | null
  createdAt: string
}

/**
 * The log's line for one event, in words.
 *
 * Built here rather than in the renderer because the log is drawn on two
 * screens, and the same event reading two ways on the buy side and the sell side
 * is exactly the drift this shared module exists to prevent.
 */
export function describeOrderEvent(event: OrderEvent, stageLabel: (id: string) => string): string {
  switch (event.kind) {
    case 'created':
      return 'Created'
    case 'stage':
      // The FROM half is dropped when there is nothing to say. An order's first
      // move has no previous stage, and "moved from nothing to Ordered" reads as
      // a bug rather than as a beginning.
      return event.fromStage
        ? `Moved from ${stageLabel(event.fromStage)} to ${stageLabel(event.toStage ?? '')}`
        : `Moved to ${stageLabel(event.toStage ?? '')}`
    case 'paid':
      return event.detail ?? 'Marked paid'
    case 'ready':
      return event.detail ?? 'Ready to ship'
    case 'shipment':
      return event.detail ?? 'Shipment changed'
    case 'label':
      return event.detail ?? 'Label attached'
    case 'email':
      return event.detail ?? 'Emailed'
    case 'link':
      return event.detail ?? 'Linked to another order'
    default:
      return event.detail ?? 'Note'
  }
}

// ---------------------------------------------------------------------------
// Parcels
// ---------------------------------------------------------------------------

import type { Carrier } from './freight'
import type { ShipStatusCode } from './shippingTypes'

/**
 * One parcel an order ships in.
 *
 * ## Why this is a table and not three columns
 *
 * It used to be three columns — carrier, service, tracking_number — on the order
 * itself, which asserts that an order ships in exactly one box. That is wrong
 * about how this business actually ships: a case order splits across two boxes
 * on different services more often than not, and the second number had nowhere
 * to go except being typed after the first one in the same field, where nothing
 * could track it.
 *
 * The old columns are still there and still backfilled — an older copy of the
 * app reads them, and they sync — but they are DERIVED from the first shipment
 * now rather than being the answer.
 */
export interface OrderShipment {
  id: string
  side: OrderSide
  orderId: string
  /** Draw order. Rebuilt on every write, so it can never have gaps. */
  position: number
  /**
   * Null until somebody says, which is the ordinary state for the first moment
   * of a parcel's life: the tracking number is typed first and the carrier is
   * guessed from it. See detectCarrier in @shared/freight.
   */
  carrier: Carrier | null
  service: string | null
  trackingNumber: string | null
  /**
   * What the postage cost to buy. Null means nobody has said.
   *
   * Explicitly NOT zero-by-default. "This label was free" and "nobody has filled
   * the cost in" are different facts, and a zero defaulted in reads as the first
   * while meaning the second — which on a page adding up what shipping costs is
   * a total that is quietly too low.
   */
  labelCost: number | null
  status: ShipStatusCode | null
  statusDetail: string | null
  statusAt: string | null
  checkedAt: string | null
  /** Why the LAST check failed, if it did. Null once one succeeds. */
  error: string | null
  /** When we last ASKED — distinct from checkedAt, which means we got an answer. */
  attemptedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
  /** Which line items are in this parcel. Empty means nobody has said. */
  lines: OrderShipmentLine[]
}

export interface OrderShipmentLine {
  id: string
  shipmentId: string
  lineId: string
  quantity: number
}

export interface NewOrderShipment {
  trackingNumber?: string | null
  carrier?: Carrier | null
  service?: string | null
  labelCost?: number | null
  /** Line ids and how many of each are in this parcel. */
  lines?: Array<{ lineId: string; quantity: number }>
}

export const TRACKING_NUMBER_MAX = 64

/**
 * What is wrong with this parcel, or null.
 *
 * A shipment with NOTHING on it is refused. Everything else is optional — a
 * number with no carrier yet is the normal first second of a parcel's life —
 * but a row carrying no number, no carrier and no cost is not a parcel, it is a
 * blank line somebody added by accident, and rows like that accumulate on a
 * screen until nobody trusts the count.
 */
export function validateShipment(input: NewOrderShipment): string | null {
  const tracking = (input.trackingNumber ?? '').trim()
  const hasCost = typeof input.labelCost === 'number' && Number.isFinite(input.labelCost)
  if (!tracking && !input.carrier && !hasCost) {
    return 'Add a tracking number, a carrier, or what the label cost.'
  }
  if (tracking.length > TRACKING_NUMBER_MAX) return 'That tracking number is too long.'
  if (hasCost && (input.labelCost as number) < 0) return 'A label cannot cost less than nothing.'
  for (const l of input.lines ?? []) {
    if (!l.lineId?.trim()) return 'A line assignment needs a line.'
    if (!Number.isFinite(l.quantity) || l.quantity < 0) return 'A line quantity cannot be negative.'
  }
  return null
}

/** What every parcel on an order cost to post. Unfilled costs contribute nothing. */
export function totalLabelCost(shipments: readonly OrderShipment[]): number {
  const cents = shipments.reduce(
    (sum, s) => sum + Math.round(((Number(s.labelCost) || 0) + Number.EPSILON) * 100),
    0
  )
  return cents / 100
}

/**
 * WHAT SHIPPING THIS ORDER COST, in one number.
 *
 * There are two places that answer can come from and letting both speak is how
 * a screen ends up showing a figure that disagrees with the one beside it:
 *
 *   · EVERY PARCEL carries a `labelCost`, which is the precise answer whenever
 *     the labels were bought through the app and their costs filled in.
 *   · THE ORDER carries a typed figure, for the cases the parcels cannot cover
 *     — a courier invoiced monthly, postage bought at a counter, or a cost
 *     somebody knows and has no parcel rows for.
 *
 * The TYPED figure wins where there is one, because somebody stating a number
 * is a stronger claim than a sum this app assembled — and because the moment
 * they disagree, the person who typed it is the one who looked. Where nothing
 * is typed the parcels answer, so an order that never needed the field still
 * reports a real cost.
 *
 * `shippingCostSource` says WHICH, so a screen can label it rather than
 * printing a number of unstated origin.
 */
export function orderShippingCost(order: {
  shippingCost?: number | null
  shipments?: readonly OrderShipment[]
}): number {
  const typed = Number(order.shippingCost)
  if (Number.isFinite(typed) && typed > 0) return typed
  return totalLabelCost(order.shipments ?? [])
}

export function shippingCostSource(order: {
  shippingCost?: number | null
  shipments?: readonly OrderShipment[]
}): 'typed' | 'labels' | 'none' {
  const typed = Number(order.shippingCost)
  if (Number.isFinite(typed) && typed > 0) return 'typed'
  return totalLabelCost(order.shipments ?? []) > 0 ? 'labels' : 'none'
}

/** How many parcels carry a cost, so a screen can say what the total is missing. */
export function shipmentsMissingCost(shipments: readonly OrderShipment[]): number {
  return shipments.filter((s) => s.labelCost === null || s.labelCost === undefined).length
}

// ---------------------------------------------------------------------------
// Paperwork
// ---------------------------------------------------------------------------

/** A file attached to an order. A shipping label, mostly. */
export interface OrderDocument {
  id: string
  side: OrderSide
  orderId: string
  /** The parcel it belongs to, when it belongs to one. */
  shipmentId: string | null
  kind: 'label' | 'other'
  name: string
  mimeType: string
  byteSize: number
  uploadedBy: string | null
  uploadedAt: string
  /**
   * Is the file itself on THIS machine?
   *
   * A document row travels as slices and is rebuilt by whoever receives them
   * (see rebuildOrderDocuments), so between the metadata arriving and the last
   * slice landing there is a real window where the app knows a label exists and
   * cannot open it. Saying so is the whole point of this flag: "no label on this
   * machine" and "the label is 3 of 5 slices in" are the same blank pane and
   * completely different situations.
   */
  present: boolean
}

/**
 * How big a file may be attached.
 *
 * A shipping label is a page — tens of kilobytes as a PDF, a few hundred as a
 * PNG from a carrier's site. Eight megabytes is generous for a scanned document
 * and small enough that the slices it becomes cannot choke the relay: at 512KB
 * each that is sixteen ordinary synced rows, against the several hundred a
 * careless limit would produce.
 */
export const ORDER_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024

/** What a label may be. Anything else is refused at the door rather than stored. */
export const ORDER_DOCUMENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
] as const

export function validateOrderDocument(input: {
  name: string
  mimeType: string
  byteSize: number
}): string | null {
  if (!(input.name ?? '').trim()) return 'That file has no name.'
  if (!(input.byteSize > 0)) return 'That file is empty.'
  if (input.byteSize > ORDER_DOCUMENT_MAX_BYTES) {
    return `Labels have to be under ${Math.round(ORDER_DOCUMENT_MAX_BYTES / (1024 * 1024))}MB.`
  }
  if (!(ORDER_DOCUMENT_TYPES as readonly string[]).includes(input.mimeType)) {
    return 'A label has to be a PDF or an image.'
  }
  return null
}

// ---------------------------------------------------------------------------
// Turning a dropship purchase into the sale that pays for it
// ---------------------------------------------------------------------------

import type { NewInvoice, NewInvoiceLine } from './invoices'

/**
 * The sales order that goes with a dropship purchase, pre-filled.
 *
 * ## The one thing that must not be got wrong
 *
 * EVERY LINE CARRIES A DESTINATION, and it is the supplier's name. On a sales
 * order `destination` means "fulfilled FROM", and anything that is not RM or AM
 * is a dropship that moves no stock. The header cannot express this: the stock
 * code collapses any header location that is not a real shelf back to RM, so a
 * sales order whose header says "Fenwick Distribution" still draws every line
 * off the RM shelf. Setting only the header would take real boxes off a real
 * shelf for units this business never held — silently, at save time, for every
 * dropship raised through this flow.
 *
 * So the line is where it is written, on every line, without exception. That is
 * also why this function exists at all rather than the screen building the
 * payload: a rule that has to be applied to every line every time is a rule that
 * belongs in one testable place.
 *
 * ## Prices are NOT carried over
 *
 * `rate` comes out as 0, deliberately. Price A is what we pay the supplier and
 * price B is what the buyer pays us; defaulting the sell price to the buy price
 * would put a zero-margin invoice one careless Enter away, and the whole reason
 * there is a second screen is that somebody has to say what B is.
 */
export function dropshipSaleFromPurchase(input: {
  /** Who we bought from — price A's counterparty, and who ships the goods. */
  supplier: string | null
  /** Where the PO said the goods were going: the buyer, on a dropship. */
  destination: string
  invoiceDate: string
  lines: Array<{ item: string; productId?: string | null; sku?: string | null; quantity: number }>
}): NewInvoice {
  const from = (input.supplier ?? '').trim() || input.destination.trim()
  const lines: NewInvoiceLine[] = input.lines.map((l) => ({
    item: l.item,
    productId: l.productId ?? null,
    sku: l.sku ?? null,
    quantity: l.quantity,
    rate: 0,
    // BOTH, and both are the supplier. `destination` is where the line was
    // fulfilled from, which is what makes it a dropship and stops the stock
    // move; `supplier` is who actually shipped it, which is what the screen
    // prints. They are the same party here and are two fields because on a
    // mixed order they are not.
    destination: from,
    supplier: from
  }))
  return {
    customerName: input.destination.trim(),
    invoiceDate: input.invoiceDate,
    // The header location is left alone on purpose. It is the fallback for a
    // line that says nothing, and every line here says something — writing the
    // supplier here as well would look tidier and would be the exact mistake
    // described above if a line were ever added without a destination.
    lines
  }
}

// ---------------------------------------------------------------------------
// Turning a dropship sale into the purchase that supplies it
// ---------------------------------------------------------------------------

/** What the purchase order form needs to open pre-filled from a sale. */
export interface DropshipPurchasePrefill {
  /** Who we are buying from. */
  supplier: string
  /** Where the goods go — on a dropship, the buyer. */
  destination: string
  /**
   * PRODUCT-BACKED LINES ONLY. A purchase order line is a catalog product — it
   * has to be, because receiving one puts units on a shelf against a cost
   * layer, and there is nothing to put them against otherwise. A sales order
   * may carry freehand lines, so the caller filters and SAYS what it left out;
   * a prefill that silently dropped them would raise a purchase for less than
   * was sold.
   */
  lines: Array<{
    productId: string
    productName: string
    sku: string
    quantity: number
  }>
}

/**
 * The purchase order that supplies a dropship sale, pre-filled.
 *
 * The mirror of `dropshipSaleFromPurchase`, for the half of the flow that was
 * missing: a dropship raised from the Sales Orders board had no way to reach the
 * purchase side, even though the buy-side interstitial promises exactly that
 * ("you can raise it from the Sales Orders board whenever you like, and link it
 * there").
 *
 * ## The destination goes on the HEADER here, and that is not an oversight
 *
 * Its mirror writes the routing onto every LINE and explains at length why the
 * header will not do. That reasoning is real and it does not apply in this
 * direction: on the SELL side a header location that is not a real shelf is
 * collapsed back to RM by the stock code, so only the lines can carry it. On the
 * BUY side the header destination is honoured as typed — `po_unit_destinations`
 * resolves a line's destination as COALESCE(line, header) — so the header is the
 * right place, and it is also what the form's inheritance-first convention
 * expects: a line that does not disagree with its order stores null.
 *
 * Writing it onto every line as well would look symmetrical and would be wrong:
 * every line would read as an override, so changing the destination on the order
 * afterwards would move nothing.
 *
 * ## Prices are NOT carried over
 *
 * `unitPrice` is left blank, for the mirror of the reason the sale side leaves
 * the rate at zero. The sale says what the buyer pays us; this asks what we pay
 * the supplier, and defaulting one to the other would put a zero-margin deal one
 * careless Enter away.
 */
export function dropshipPurchaseFromSale(input: {
  /** Who the sale said would ship each line. */
  supplier: string
  /** Who bought it — the sales order's customer. */
  customerName: string
  lines: Array<{
    productId: string
    item: string
    sku?: string | null
    quantity: number
  }>
}): DropshipPurchasePrefill {
  return {
    supplier: input.supplier.trim(),
    destination: input.customerName.trim(),
    lines: input.lines.map((l) => ({
      productId: l.productId,
      productName: l.item,
      sku: l.sku ?? '',
      quantity: l.quantity
    }))
  }
}

/**
 * Who is supplying a dropship sale, as far as its lines agree.
 *
 * Null when they do not — a sale whose lines come from two suppliers is two
 * purchase orders, and guessing which one to raise would put the wrong goods on
 * the wrong supplier's order. The mirror of the buy side refusing to bill one
 * invoice for two buyers.
 *
 * A dropship line with NO supplier named counts as an unknown rather than as
 * agreement: it is exactly the line somebody has not finished filling in, and
 * treating it as "whatever the others said" would raise an order against a
 * supplier who was never chosen for it.
 */
export function dropshipSuppliersOf(
  lines: ReadonlyArray<{ supplier: string | null; dropship: boolean }>
): string[] {
  return [
    ...new Set(
      lines.filter((l) => l.dropship).map((l) => (l.supplier ?? '').trim() || '(not named)')
    )
  ]
}

// ---------------------------------------------------------------------------
// Sending a label to whoever is shipping the goods
// ---------------------------------------------------------------------------

/**
 * WHO A SALES ORDER'S SHIPPING LABEL IS ACTUALLY FOR.
 *
 * On an ordinary sale it is the buyer: the boxes are here, we pack them, the
 * label goes on the box, and the buyer's address is already on the document.
 *
 * ON A DROPSHIP IT IS THE SUPPLIER, and that is the whole reason this function
 * exists. The boxes never touch this building — a supplier has them and a
 * supplier puts the label on them — so a label emailed to the buyer reaches
 * somebody who cannot put it on anything. The screen used to hand down the
 * buyer's address on every sale, with a comment beside it saying "on a dropship
 * the label usually goes to the SUPPLIER instead", which described the problem
 * rather than fixing it.
 *
 * ## Why the buyer is not offered as a fallback on a dropship
 *
 * Because the case where the supplier's address is unknown is exactly the case
 * where nobody is expecting an address to appear at all. Falling back would put
 * a plausible, wrong party in the To box of a message about to be sent, and a
 * plausible wrong answer is worse than none: an empty box asks a question and a
 * filled one does not. So the address comes back null and the NOTE says why.
 *
 * ## Two suppliers is a real shape and is refused rather than guessed
 *
 * A mixed sale can have two halves from two places. Naming one of them would
 * send a label to the wrong building — the same rule the provenance read keeps
 * about destinations, and the same rule the card's "from" line keeps.
 */
// ---------------------------------------------------------------------------
// ATTACHING A SALE TO A PURCHASE ORDER THAT ALREADY EXISTS
//
// The other direction of the same pairing, and the one that was missing. Both
// dropship flows could only ever RAISE the missing document: sell first and the
// app offers to write the purchase, buy first and it offers to write the sale.
// Neither could say "I already made that one — attach it."
//
// The gap was visible in the app's own words. DropshipPurchaseStep's footnote
// tells the operator to choose "Not now" if the goods were "bought already",
// and the buy-side interstitial promises they can raise the sale "from the
// Sales Orders board whenever you like, and link it there". The link existed —
// `linkDropshipPair` — with no way in that did not also create a second
// document. The owner's case was exactly this: one big invoice already sent to
// a buyer, two of its cases dropshipped, and the purchase order for them raised
// by hand beforehand.
// ---------------------------------------------------------------------------

/** A purchase order a sale could be attached to, as the picker needs it. */
/**
 * One purchase that supplied a sale.
 *
 * A LIST, because a sale of ten cases sourced from three purchases is ordinary
 * trade here — see @main/db/salePurchaseLinks. An empty list is the commonest
 * state by far and means exactly what it says: this sale claims nothing about
 * where its cases came from, which is what an in-house sale off the shelf is.
 */
export interface SaleSourceLink {
  poId: string
  poNumber: string
  supplier: string | null
  status: string
  total: number
  /** The day it was raised, for telling two orders to one supplier apart. */
  orderedOn: string | null
  /** When somebody attached it, which is not when the purchase was raised. */
  linkedAt: string
}

export interface LinkablePurchaseOrder {
  poId: string
  poNumber: string
  supplier: string | null
  /** Where its goods were headed. A dropship names the buyer, not a shelf. */
  destination: string | null
  status: string
  /** The calendar day it was raised, for telling two orders to one supplier apart. */
  orderedOn: string | null
  total: number
  unitsOrdered: number
  /** True when THIS sale is already the one it points at. */
  linkedHere: boolean
  /** How many other sales it already supplies. A purchase may supply several. */
  otherSales: number
  /**
   * HOW MANY OF THIS SALE'S PRODUCTS THIS PURCHASE ACTUALLY CARRIES.
   *
   * The owner asked for multiple purchases per sale "in terms of matching
   * products", and this is what makes that concrete rather than a list of every
   * order ever raised. A purchase holding two of the three things being sold is
   * almost certainly one of the ones being looked for; a purchase holding none
   * of them is almost certainly not, and says so instead of sitting in the list
   * looking identical to the right answer.
   *
   * A COUNT, NOT A FILTER. Zero is still offered and still linkable, because a
   * dropship is exactly the case where the sale and the purchase are the same
   * deal and share no catalog product at all — the sale may be a hand-typed line
   * and the purchase a case nobody put in the catalog. Hiding those would break
   * the one scenario the linking was asked for.
   */
  matchingProducts: number
}

/**
 * Why this sale cannot be attached to that purchase order — null when it can.
 *
 * Deliberately short. Two documents being one deal is a claim a person makes,
 * not something to be second-guessed: a supplier that does not match the line,
 * a date weeks apart, a total that is nothing like the sale's are all ordinary
 * shapes of real trade. Only the things that would produce a WRONG record are
 * refused.
 */
export function linkPurchaseRefusal(
  po: LinkablePurchaseOrder | null | undefined
): string | null {
  if (!po) return null
  /**
   * A SALE NO LONGER BELONGS TO ONE PURCHASE.
   *
   * This used to refuse outright when the sale already named a different order:
   * "detach it there first — a sale belongs to one purchase." That was true of
   * the storage and never true of the trade. Ten cases to one buyer, sourced
   * from three purchases because that is who had them, is an ordinary week here,
   * and the app made it unrecordable.
   *
   * `sale_purchase_links` is the many-to-many that replaced it, so there is
   * nothing left to refuse on the sale's side at all — which is why this takes
   * only the purchase now. The sale argument went with the rule: a parameter
   * nothing reads is one somebody eventually passes wrongly.
   */
  if (po.status === 'cancelled') {
    return `${po.poNumber} was cancelled, so nothing on it is being bought.`
  }
  return null
}

/**
 * The purchase orders worth offering for one sale, best first.
 *
 * THE SUPPLIER THE LINES NAME COMES FIRST, because on a dropship the sale
 * already says who is shipping it and that is almost always the order somebody
 * is looking for. After that the newest, because a purchase raised for a sale is
 * raised near it in time.
 *
 * Nothing is HIDDEN on a supplier mismatch, only sorted down. A sale whose lines
 * name no supplier at all — which is the shape that sent somebody here in the
 * first place — would otherwise be offered an empty list.
 */
export function linkableOrder(
  orders: readonly LinkablePurchaseOrder[],
  suppliers: readonly string[]
): LinkablePurchaseOrder[] {
  const wanted = new Set(
    suppliers.map((s) => s.trim().toLowerCase()).filter((s) => s && s !== '(not named)')
  )
  const rank = (po: LinkablePurchaseOrder): number =>
    wanted.size > 0 && wanted.has((po.supplier ?? '').trim().toLowerCase()) ? 0 : 1
  return [...orders].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      // THEN BY WHAT IT ACTUALLY CARRIES, which is what the owner meant by
      // matching "in terms of matching products". A purchase holding two of the
      // three things being sold belongs above one holding none of them, and
      // below the named supplier only because on a dropship the supplier IS the
      // answer and the two documents often share no catalog product at all.
      b.matchingProducts - a.matchingProducts ||
      (b.orderedOn ?? '').localeCompare(a.orderedOn ?? '') ||
      b.poNumber.localeCompare(a.poNumber)
  )
}

/**
 * How it reads in the picker: "PO-0042 · Panini · 24 Aug · 2 units · 2 of these
 * products".
 *
 * The product match is last and only appears when there IS one, because it is
 * the only part of this label that is a judgement rather than a fact about the
 * order. Silence on a purchase that shares nothing is the right silence: it is
 * still perfectly linkable, and a "0 of these products" on every dropship would
 * read as a warning about the commonest correct answer.
 */
export function linkableOrderLabel(po: LinkablePurchaseOrder): string {
  const bits = [po.poNumber]
  if (po.supplier) bits.push(po.supplier)
  if (po.orderedOn) bits.push(po.orderedOn)
  bits.push(`${po.unitsOrdered} unit${po.unitsOrdered === 1 ? '' : 's'}`)
  if (po.matchingProducts > 0) {
    bits.push(
      po.matchingProducts === 1 ? '1 of these products' : `${po.matchingProducts} of these products`
    )
  }
  return bits.join(' · ')
}

export interface LabelRecipient {
  /** Pre-filled address, or null to leave the box empty and ask. */
  email: string | null
  /** The party's name, for the contact-directory lookup. Null when unknown. */
  name: string | null
  /** Why this party, in one line. Null on the ordinary case, which needs no note. */
  note: string | null
}

export function labelRecipientFor(invoice: {
  email: string | null
  customerName: string
  dropSupplier: string | null
  dropSupplierCount: number
  dropshipUnits: number
  sourcePoId: string | null
}): LabelRecipient {
  const isDrop = (Number(invoice.dropshipUnits) || 0) > 0 || !!invoice.sourcePoId
  if (!isDrop) {
    return { email: invoice.email ?? null, name: invoice.customerName || null, note: null }
  }
  if ((invoice.dropSupplierCount ?? 0) > 1) {
    return {
      email: null,
      name: null,
      note:
        `This order ships from ${invoice.dropSupplierCount} suppliers, so there is no one ` +
        'address to fill in. Type the one this label is for.'
    }
  }
  const supplier = (invoice.dropSupplier ?? '').trim()
  if (!supplier) {
    return {
      email: null,
      name: null,
      note:
        'This is a dropship and nothing on it says who ships it. Name the supplier on the ' +
        'line, or type their address here.'
    }
  }
  return {
    email: null,
    name: supplier,
    note:
      `This is a dropship — ${supplier} has the boxes, so the label goes to them and not to ` +
      `${invoice.customerName || 'the buyer'}.`
  }
}

/**
 * The message that goes out with a label.
 *
 * Composed in shared code so it can be tested without a mail server, and so the
 * preview somebody reads before pressing Send is built by the same function that
 * builds what is sent. Two functions "doing the same thing" is how a preview
 * comes to differ from the message.
 */
export interface LabelEmailInput {
  side: OrderSide
  orderNumber: string
  /** Who the goods are going to, in words. */
  shipTo: string | null
  senderName: string
  companyName: string
  lines: Array<{ description: string; quantity: number }>
  shipments: Array<{ carrier: string | null; service: string | null; trackingNumber: string | null }>
  note: string | null
  labelName: string | null
}

export interface ComposedLabelEmail {
  subject: string
  body: string
}

export function composeLabelEmail(input: LabelEmailInput): ComposedLabelEmail {
  const what = input.side === 'po' ? 'order' : 'order'
  const subject = `Shipping label for ${what} ${input.orderNumber}`.trim()

  const lines: string[] = ['Hi,', '']
  lines.push(
    input.labelName
      ? `The shipping label for ${what} ${input.orderNumber} is attached.`
      : `Here are the shipping details for ${what} ${input.orderNumber}.`
  )
  if (input.shipTo) lines.push('', `Ship to: ${input.shipTo}`)

  if (input.lines.length > 0) {
    lines.push('', 'WHAT TO SHIP', '------------')
    for (const l of input.lines) {
      lines.push(`  ${l.quantity} × ${l.description}`)
    }
  }

  const tracked = input.shipments.filter((s) => (s.trackingNumber ?? '').trim())
  if (tracked.length > 0) {
    lines.push('', 'TRACKING', '--------')
    for (const s of tracked) {
      const how = [s.carrier, s.service].filter(Boolean).join(' ')
      lines.push(`  ${s.trackingNumber}${how ? ` (${how})` : ''}`)
    }
  }

  if (input.note?.trim()) lines.push('', input.note.trim())

  lines.push('', 'Thanks,', input.senderName, input.companyName)
  return { subject, body: lines.join('\n') }
}

/**
 * A `mailto:` for the same message.
 *
 * THE FALLBACK, and it is a real one rather than a courtesy: it needs no server,
 * no password and no setup, and it works the first time somebody presses the
 * button. What it cannot do is carry the label — the scheme has no way to attach
 * a file — so the screen that offers it also offers to save the label, and says
 * which is which rather than letting somebody send an email they believe has a
 * label on it.
 */
export function labelMailtoUrl(to: string, composed: ComposedLabelEmail): string {
  return (
    `mailto:${encodeURIComponent(to)}` +
    `?subject=${encodeURIComponent(composed.subject)}` +
    `&body=${encodeURIComponent(composed.body)}`
  )
}
