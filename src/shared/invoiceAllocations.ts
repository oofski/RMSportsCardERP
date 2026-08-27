/**
 * SPLITTING ONE SALES-ORDER LINE ACROSS SEVERAL SOURCES.
 *
 * The owner's words: "for each item in any sales order we can go in and for
 * each individual case adjust where it is coming from, and then basically it
 * corresponds back to inventory or the right dropship PO."
 *
 * Ten cases on one line: eight off the RM shelf, two shipped direct by a
 * supplier. Or five out of a roadshow week, three off the shelf, two dropship.
 * Until now a line could name exactly one answer, so making two of ten a
 * dropship meant the line was all dropship or none.
 *
 * ## The deliberate mirror of the buy side
 *
 * `PurchaseOrderAllocation` in @shared/types is the same idea pointed the other
 * way, and this copies its shape, its invariants and its back-compat mechanism
 * on purpose. Read that one alongside this: a purchase splits a line across
 * destinations it is going TO, a sale splits a line across places its units come
 * FROM, and everything else about the two is identical.
 *
 * ## ZERO ROWS IS THE IMPORTANT CASE
 *
 * A line with NO allocations is a line with ONE implicit allocation of its whole
 * quantity, at the line's own destination and source order. That is not a
 * convenience — it is the entire back-compat mechanism. Every sales order in the
 * database has zero allocation rows and goes on behaving byte for byte as it
 * did, because the path that reads "no rows" produces exactly what the path that
 * read the line used to produce. The migration writes no rows for anything.
 *
 * ## What a split does NOT touch
 *
 * The line's quantity, its rate and its amount. Splitting is a statement about
 * where units come from, not about what was sold: eight at $900 plus two at $900
 * is ten at $900, and the invoice the buyer is holding is the same document
 * either way. That is what makes this safe on an order already in QuickBooks —
 * the same reasoning as `setInvoiceLineRouting`, which is where it is written.
 */

import { destinationHoldsStock } from './purchaseOrders'

/** A slice of a line: some of its units, coming from one place. */
export interface InvoiceLineAllocation {
  id: string
  /** How many of the line's units this slice accounts for. Always ≥ 1. */
  quantity: number
  /**
   * Where these units come from, after inheritance. 'RM' or 'AM' draws that
   * shelf down; anything else is a dropship and moves no stock.
   */
  destination: string
  /** Who ships them, on a dropship slice. Null when they come off a shelf. */
  supplier: string | null
  /** `destinationHoldsStock(destination)` — RM or AM, and nothing else. */
  holdsStock: boolean
  /**
   * WHICH PURCHASE ORDER THESE UNITS CAME FROM. Set on ANY slice.
   *
   * It used to be blanked on a dropship slice, on the reasoning that this
   * column says which cost layers to consume and a slice consuming none cannot
   * say whose. True of the COST — and it made the owner's case unrecordable:
   * "we need to know where products are coming from, and those are open tabs".
   * A case bought on a roadshow tab and shipped straight to the buyer never
   * reaches a shelf here, so it has no layers to consume and, under the old
   * rule, nowhere to record where it came from either.
   *
   * So the raw value is provenance, and `holdsStock` beside it says which of
   * the two things it means:
   *
   *   holdsStock true   these units come out of THAT order's cost layers, and
   *                     consumeFromPo is handed it, so it moves real money.
   *   holdsStock false  supplied by that order, shipped direct. A record, and
   *                     nothing that costs anything reads it.
   *
   * `effectiveSlices` is the COST view and blanks it on a non-stock slice, so
   * every consumer that asks the shared rule is structurally unable to spend
   * against a dropship — see there.
   */
  sourcePoId: string | null
  sourcePoNumber: string | null
}

/** What a caller proposes, before it is stored. Ids are minted on write. */
export interface InvoiceAllocationInput {
  quantity: number
  destination: string | null
  sourcePoId?: string | null
}

/** How many of the line's units the splits account for. */
export function allocationTotal(rows: ReadonlyArray<{ quantity: number }>): number {
  return rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
}

/**
 * Why this set of splits cannot be stored — null when it can.
 *
 * The invariants SQLite cannot express, checked in code before any insert, with
 * the whole line refused if one fails. They are the buy side's I1 and I5, said
 * for a sale:
 *
 *   I1  Σ allocations.quantity = line.quantity
 *   I5  quantity ≥ 1; a zero-unit split is deleted, never stored
 *
 * I1 is the one that matters and the one a person gets wrong. A line of ten split
 * into six and three is not a line of nine — it is a line of ten with one case
 * unaccounted for, and storing it would leave a case that was sold coming from
 * nowhere, drawing no shelf and appearing on no purchase order.
 */
export function allocationProblem(
  rows: ReadonlyArray<{ quantity: number }>,
  lineQuantity: number
): string | null {
  if (rows.length === 0) return null
  const want = Number(lineQuantity) || 0
  for (const r of rows) {
    const q = Number(r.quantity) || 0
    if (!Number.isFinite(q) || q <= 0) {
      return 'Every split has to be at least one unit. Remove the empty one instead.'
    }
    if (!Number.isInteger(q)) return 'A split has to be a whole number of units.'
  }
  const sum = allocationTotal(rows)
  if (sum !== want) {
    return sum < want
      ? `${want - sum} of the ${want} is not accounted for. Every unit has to come from somewhere.`
      : `That is ${sum} units split across a line of ${want}. Take ${sum - want} back off.`
  }
  // ONE SPLIT OF THE WHOLE LINE IS NOT A SPLIT. Storing it would be a second way
  // to say what the line already says, and the two could then disagree.
  if (rows.length === 1) {
    return 'One split for the whole line is just the line. Set it on the line itself instead.'
  }
  return null
}

/**
 * The slices a line ACTUALLY has, splits or not — THE COST VIEW.
 *
 * The one function every reader should use, because it is where "no rows means
 * one implicit slice" lives. Ask it rather than checking `allocations.length`
 * and branching, or the zero-row case gets handled correctly in some places and
 * forgotten in others — which is how a back-compat mechanism becomes a bug.
 *
 * ## IT BLANKS `sourcePoId` ON EVERY SLICE THAT DRAWS NO SHELF
 *
 * A slice may now RECORD which purchase order supplied it even when it is a
 * dropship — that is provenance, and the owner needs it on exactly those lines.
 * But a dropship consumes no cost layers, so the answer to "whose layers does
 * this spend" is nothing, and this is the function everything that spends asks:
 * `stockDrawingLines`, `claimsOf`, the purchase-order history, the deal-ticket
 * fold. Blanking here means none of them can be handed a purchase order to
 * charge against goods that never touched a shelf, and none of them needs a
 * guard of its own that somebody could forget to write.
 *
 * Read the stored row directly when you want the provenance. Ask this when you
 * want the cost. They are two questions and they now have two answers.
 */
export function effectiveSlices(
  line: {
    quantity: number
    destination: string | null
    supplier?: string | null
    sourcePoId?: string | null
    allocations?: readonly InvoiceLineAllocation[]
  },
  headerLocation: string
): Array<{
  id: string | null
  quantity: number
  destination: string
  supplier: string | null
  holdsStock: boolean
  sourcePoId: string | null
}> {
  const rows = line.allocations ?? []
  if (rows.length > 0) {
    return rows.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      destination: a.destination,
      supplier: a.supplier,
      holdsStock: a.holdsStock,
      // The cost view — see above. The row keeps its own answer; this is what
      // everything that spends money is allowed to see.
      sourcePoId: a.holdsStock ? a.sourcePoId : null
    }))
  }
  const destination = (line.destination ?? '').trim() || headerLocation
  const holdsStock = destinationHoldsStock(destination)
  return [
    {
      id: null,
      quantity: line.quantity,
      destination,
      supplier: holdsStock ? null : ((line.supplier ?? '').trim() || destination),
      holdsStock,
      sourcePoId: holdsStock ? ((line.sourcePoId ?? '').trim() || null) : null
    }
  ]
}

/** Units of a line that come off a shelf, splits accounted for. */
export function stockUnitsOf(
  line: Parameters<typeof effectiveSlices>[0],
  headerLocation: string
): number {
  return effectiveSlices(line, headerLocation)
    .filter((s) => s.holdsStock)
    .reduce((n, s) => n + s.quantity, 0)
}

/** Units of a line a supplier ships direct, splits accounted for. */
export function dropUnitsOf(
  line: Parameters<typeof effectiveSlices>[0],
  headerLocation: string
): number {
  return effectiveSlices(line, headerLocation)
    .filter((s) => !s.holdsStock)
    .reduce((n, s) => n + s.quantity, 0)
}
