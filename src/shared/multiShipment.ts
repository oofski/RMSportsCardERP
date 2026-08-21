import type { NewInvoice, NewInvoiceLine } from './invoices'

/**
 * ONE PURCHASE, SEVERAL BUYERS.
 *
 * ## The shape of deal this exists for
 *
 * A case of ten boxes is bought from one distributor and shipped straight out to
 * five different people, four of whom want two and one of whom wants the other
 * two. There is ONE purchase order — one supplier, one price A, one commitment —
 * and there are FIVE sales orders, because there are five people who each owe us
 * for their own boxes and each need their own invoice in QuickBooks.
 *
 * ## Why the buyers are named late
 *
 * The purchase is placed when the case is available, and who is taking what is
 * settled afterwards. So the order goes out with `MULTI_SHIPMENT` where a
 * destination would be — a promise that this is a dropship and the buyers are
 * still to come — and the names are filled in on the way to raising the sales
 * orders.
 *
 * That is the whole reason this is not just "split the line across destinations
 * on the purchase order", which the buy side has always been able to do. It can,
 * and when the buyers ARE known that is exactly what to do: this module reads
 * those names as already-assigned and only asks about the slices that say
 * MULTI_SHIPMENT. The two paths meet here.
 *
 * ## Nothing is stored that could disagree
 *
 * There is no `is_multi_shipment` column and no split table. The assignment
 * exists for as long as the screen is open and is then spent: it becomes N sales
 * orders, each carrying its own lines, each linked back to the purchase order.
 * Asking "who got what" afterwards means reading those sales orders, which is
 * the same answer arrived at from the documents that are the truth rather than
 * from a copy taken at the moment somebody pressed a button.
 */

/**
 * The destination that means "several buyers, not named yet".
 *
 * A STRING, in the same column every other destination lives in, and that is
 * deliberate: `destinationHoldsStock` already returns false for it — it is not
 * RM and not AM — so every existing gate treats it as a dropship without being
 * taught about it. Nothing receivable, no box in Incoming, no FIFO layer. A flag
 * on the header would have needed all nine of those gates to learn a new
 * question.
 */
export const MULTI_SHIPMENT = 'Multi-shipment'

/**
 * Is this destination the sentinel?
 *
 * CASE-INSENSITIVE, for the same reason `canonicalDestination` folds `rm` to
 * `RM`: typed as "multi-shipment" and left alone, it is a dropship to a shop of
 * that name. The order would look right, the units would be unreceivable, and
 * the buyer-assignment screen would never appear — a silent failure that reads
 * as the feature being broken rather than as a typo. Both this and
 * `canonicalDestination` fold it, because neither can be the only door.
 */
export function isMultiShipment(destination: string | null | undefined): boolean {
  return String(destination ?? '').trim().toLowerCase() === MULTI_SHIPMENT.toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* What is being assigned                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One slice of a purchase order that is going out to somebody.
 *
 * This is what the assignment screen is handed: the drop half of the order,
 * already flattened out of its lines and allocations by the caller, so this
 * module never has to know how a purchase order stores its routing.
 */
export interface ShipmentSource {
  /** Stable per slice, so a row keeps its identity across edits and re-orders. */
  key: string
  productId: string | null
  item: string
  sku: string | null
  quantity: number
  /**
   * The buyer this slice already names, or null when it says MULTI_SHIPMENT.
   *
   * A purchase order split across three named shops arrives here fully assigned
   * and needs no typing at all — the screen shows what it already says and moves
   * straight to "create three sales orders".
   */
  buyer: string | null
}

/**
 * One row on the assignment screen: this many of this product, to this buyer.
 *
 * `sourceKey` is what ties a row back to the slice it came from, and it is what
 * makes splitting possible: three rows sharing a sourceKey are three buyers
 * dividing one line, and their quantities have to add up to that line's.
 */
export interface ShipmentRow {
  key: string
  sourceKey: string
  /** Empty until somebody names one. Never trimmed in place — see buyerKey. */
  buyer: string
  quantity: number
}

/** Row identity for the split editor. Never stored, never sent. */
let rowSeq = 0
export function newShipmentRowKey(): string {
  rowSeq += 1
  return `ship-${rowSeq}`
}

/** One row per source, pre-filled with whatever the purchase order already says. */
export function shipmentRowsFrom(sources: ReadonlyArray<ShipmentSource>): ShipmentRow[] {
  return sources.map((s) => ({
    key: newShipmentRowKey(),
    sourceKey: s.key,
    buyer: s.buyer ?? '',
    quantity: s.quantity
  }))
}

/**
 * Two buyers are the same buyer when their names differ only in case or spacing.
 *
 * Without this, "Fenwick Cards" and "fenwick cards " are two customers in this
 * app and then two customers offered for creation in the owner's real QuickBooks
 * books — from one screen, in one sitting, for one deal. The buy side already
 * merges vendor names this way; this is the same rule pointed the other way.
 */
export function buyerKey(name: string): string {
  return name.trim().toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* Whether it can be saved yet                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why these rows cannot become sales orders yet, or null when they can.
 *
 * The rules are the sell-side mirror of `splitProblem`, which guards the same
 * arithmetic on a purchase order line, and they are checked in the same order
 * and worded the same way so an operator meets one rule rather than two.
 *
 * ## Every unit has to be assigned
 *
 * Not "at most the line's quantity" — EXACTLY it. These units are already bought
 * and already shipping; a unit nobody is assigned is a box leaving the
 * distributor addressed to nobody, and the money for it has already been
 * committed. Under-assigning is the mistake worth catching, because the missing
 * invoice is the one nobody notices until the case has gone.
 *
 * Over-assigning is caught by the same test and is the more obvious error: it
 * would invoice more boxes than were bought.
 */
export function shipmentProblem(
  rows: ReadonlyArray<ShipmentRow>,
  sources: ReadonlyArray<ShipmentSource>
): string | null {
  if (rows.length === 0) return 'Nothing to assign yet.'
  if (rows.some((r) => !Number.isFinite(r.quantity) || Math.round(r.quantity) < 1)) {
    return 'Every row needs at least 1 unit. Remove the empty ones instead of leaving them at zero.'
  }
  // A row still naming the sentinel is a row nobody has answered — treated as
  // unnamed rather than as a buyer called "Multi-shipment", which is what would
  // otherwise reach QuickBooks as a customer.
  const unnamed = rows.find((r) => !r.buyer.trim() || isMultiShipment(r.buyer))
  if (unnamed) return 'Every row needs a buyer.'

  for (const source of sources) {
    const own = rows.filter((r) => r.sourceKey === source.key)
    if (own.length === 0) {
      return `${source.item} is not assigned to anybody — all ${source.quantity} of them are going out.`
    }
    const sum = own.reduce((n, r) => n + Math.max(0, Math.round(r.quantity)), 0)
    if (sum === source.quantity) continue
    return sum < source.quantity
      ? `${source.quantity - sum} of ${source.quantity} ${source.item} are not assigned yet.`
      : `${sum - source.quantity} more ${source.item} are assigned than the order bought.`
  }
  return null
}

/**
 * How many units of one source are still to be handed out.
 *
 * Used by the screen to size a new split row, so adding one offers the rest
 * rather than a zero somebody then has to work out for themselves.
 */
export function unassignedUnits(
  rows: ReadonlyArray<ShipmentRow>,
  source: ShipmentSource
): number {
  const taken = rows
    .filter((r) => r.sourceKey === source.key)
    .reduce((n, r) => n + Math.max(0, Math.round(r.quantity) || 0), 0)
  return Math.max(0, source.quantity - taken)
}

/* -------------------------------------------------------------------------- */
/* Turning the assignment into sales orders                                    */
/* -------------------------------------------------------------------------- */

/** One buyer's share of the purchase, ready to become a sales order. */
export interface BuyerShare {
  buyer: string
  lines: Array<{
    productId: string | null
    item: string
    sku: string | null
    quantity: number
  }>
  units: number
}

/**
 * Group the rows by buyer, in the order the buyers were first named.
 *
 * ONE ORDER PER BUYER, not per row. Somebody taking two boxes off one line and
 * three off another is one person receiving one parcel and owing one amount, so
 * they get one invoice — two would bill the same deal twice and post two
 * documents to QuickBooks for it.
 *
 * Rows for the same buyer AND the same product merge into one line for the same
 * reason: an invoice reading "2 × Hobby Box" and "3 × Hobby Box" on separate
 * lines is a document that has to be added up before it can be read.
 */
export function buyerShares(
  rows: ReadonlyArray<ShipmentRow>,
  sources: ReadonlyArray<ShipmentSource>
): BuyerShare[] {
  const byKey = new Map<string, BuyerShare>()
  const sourceOf = new Map(sources.map((s) => [s.key, s]))

  for (const row of rows) {
    const source = sourceOf.get(row.sourceKey)
    if (!source) continue
    const quantity = Math.max(0, Math.round(row.quantity) || 0)
    if (quantity < 1) continue
    const name = row.buyer.trim()
    if (!name) continue

    const key = buyerKey(name)
    // FIRST SPELLING WINS. The name is snapshotted onto an invoice and offered
    // to QuickBooks as a customer, so it has to be one of the spellings an
    // operator actually typed rather than a normalised form nobody chose.
    const share = byKey.get(key) ?? { buyer: name, lines: [], units: 0 }
    const sameLine = share.lines.find(
      (l) =>
        (source.productId ? l.productId === source.productId : false) ||
        (!source.productId && !l.productId && l.item === source.item)
    )
    if (sameLine) sameLine.quantity += quantity
    else {
      share.lines.push({
        productId: source.productId,
        item: source.item,
        sku: source.sku,
        quantity
      })
    }
    share.units += quantity
    byKey.set(key, share)
  }
  return [...byKey.values()]
}

/**
 * The sales orders themselves, one per buyer.
 *
 * ## The routing rules are the single-buyer ones, unchanged
 *
 * Every line carries `destination` and `supplier`, both set to the party that
 * ships the goods, exactly as `dropshipSaleFromPurchase` does for a one-buyer
 * dropship — and for the same reason spelled out there: the header cannot
 * express it, because the stock code collapses any header location that is not a
 * real shelf back to RM, so a sales order that said it only on the header would
 * take real boxes off a real shelf for units this business never held.
 *
 * That rule is not restated here so much as reused: a multi-shipment sale is
 * five ordinary dropship sales that happen to have been raised together, and the
 * moment they differ in how a line is routed is the moment one of them starts
 * moving stock the others do not.
 *
 * ## Prices are NOT carried over
 *
 * `rate` is 0 on every line, the same as the single-buyer flow. Price A is what
 * we pay the distributor and price B is what each of these five people pays us —
 * and they are five different numbers, which is the whole reason they are five
 * documents. Defaulting any of them to the buy price would put a zero-margin
 * invoice one careless Enter away, five times over.
 *
 * ## Numbers are left to the save
 *
 * `invoiceNumber` is offered as a starting point and `saveInvoice` moves it up
 * if it is taken — which is exactly what happens when five orders are saved in
 * one go, and is a guard that already exists and is already tested rather than a
 * second numbering scheme invented here.
 */
export function salesOrdersFromShipment(input: {
  /** Who we bought from — the party that ships every one of these. */
  supplier: string | null
  invoiceDate: string
  /** The first number to offer. Each order after the first counts up from it. */
  firstNumber?: string | null
  rows: ReadonlyArray<ShipmentRow>
  sources: ReadonlyArray<ShipmentSource>
}): NewInvoice[] {
  const named = (input.supplier ?? '').trim()
  const base = Number(input.firstNumber)
  const numbered = Number.isFinite(base) && base > 0

  return buyerShares(input.rows, input.sources).map((share, i) => {
    /**
     * NEVER EMPTY, AND THAT IS THE WHOLE SAFETY PROPERTY OF THIS FUNCTION.
     *
     * `purchase_orders.supplier` is nullable and the create form does not
     * require it — "No supplier named" is an offered option. This used to write
     * `destination: from || null` straight from it, and null on a sales-order
     * line means INHERIT THE HEADER; the header of these orders is unset, and
     * `invoiceStockLocation` falls back to RM. So every line of a supplier-less
     * multi-shipment split came out as an ordinary from-stock line: saveInvoice
     * ran `applyInvoiceStock`, drew down real FIFO layers, and billed the buyer
     * for boxes that were dropshipped from a distributor and never touched a
     * shelf here. The shelf went down, the cost basis moved, and nothing said so.
     *
     * The buyer's own name is the fallback, which is exactly what
     * `dropshipSaleFromPurchase` has always done on the single-buyer path
     * (`(supplier ?? '').trim() || destination.trim()`). Reading "fulfilled from
     * the person who bought it" is a bit odd on the page — and it is the RIGHT
     * kind of odd, because the only property that matters here is that the name
     * is not a shelf: `destinationHoldsStock` says no, the stock move is
     * suppressed, and the line stays a dropship. An honest oddity beats a silent
     * stock write, and it keeps the two paths on one rule instead of two.
     */
    const from = named || share.buyer.trim()
    const lines: NewInvoiceLine[] = share.lines.map((l) => ({
      item: l.item,
      productId: l.productId,
      sku: l.sku,
      quantity: l.quantity,
      rate: 0,
      // BOTH, and both name the party that shipped it — see
      // dropshipSaleFromPurchase, which writes the same two fields the same way.
      destination: from,
      supplier: from
    }))
    return {
      customerName: share.buyer,
      invoiceDate: input.invoiceDate,
      invoiceNumber: numbered ? String(base + i) : null,
      lines
    }
  })
}
