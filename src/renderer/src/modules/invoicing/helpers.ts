import type { PurchaseOrderDetail, PurchaseOrderLine, PurchaseOrderStatus } from '@shared/types'
import type { PoColumn } from '@shared/purchaseOrders'
import { canonicalDestination, destinationHoldsStock } from '@shared/purchaseOrders'

/**
 * Per-stage display metadata — a label, an Icon name (all of them already live
 * in the Icon MAP) and a tone slug that drives the `.po-badge-<tone>` colourway.
 * Shared by the board columns, the card move buttons and the receipt badge so a
 * stage always looks the same wherever it shows up.
 *
 * KEYED ON BOTH a status and a column, because the two are no longer the same
 * set. `cancelled` is a status an order can hold and never a column of its own
 * any more; `completed` is a column derived from two dates and never a status.
 * Both are looked up here — the receipt badges the STATUS, the board heads the
 * COLUMN — so dropping either key would leave one of them rendering nothing.
 */
export const PO_STAGE_META: Record<
  PurchaseOrderStatus | PoColumn,
  { label: string; icon: string; tone: string }
> = {
  ordered: { label: 'Ordered', icon: 'ShoppingCart', tone: 'ordered' },
  paid: { label: 'Paid', icon: 'DollarSign', tone: 'paid' },
  received: { label: 'Received', icon: 'PackageCheck', tone: 'received' },
  completed: { label: 'Completed', icon: 'CheckCircle2', tone: 'completed' },
  cancelled: { label: 'Cancelled', icon: 'Ban', tone: 'cancelled' }
}

/** The short verb shown on a card's move button for a given target stage. */
export const PO_MOVE_LABEL: Record<PurchaseOrderStatus, string> = {
  // From cancelled this is the way back, and "Reopen" is what it does there.
  ordered: 'Reopen',
  // Kept for the stage move only — the CARD does not render it. Payment has its
  // own button that stamps the date without moving anything, and offering both
  // put two "Mark paid" buttons on every ordered card, one of which quietly
  // moved the order to a different column. See `moves` in PoCard.
  paid: 'Move to Paid',
  received: 'Receive',
  cancelled: 'Cancel'
}

/* -------------------------------------------------------------------------- */
/* Where a line's units are actually going                                     */
/* -------------------------------------------------------------------------- */

/**
 * How many of this line are still to ARRIVE HERE.
 *
 * `qtyOutstanding` is `quantity − qtyReceived` and it counts every unit on the
 * line, drop-shipped ones included. That is the right meaning for the money —
 * eight boxes going straight to a shop are still eight boxes this business is
 * paying for — and the wrong one for every screen that asks "what is coming to
 * the building". Left unadjusted, Incoming Inventory offers a Record-delivery
 * box for units that were never addressed here, and `receivePoLine` throws when
 * somebody presses it: a button whose only outcome is a refusal.
 *
 * `qtyReceived` can only ever have come from a stock allocation (invariant I4 —
 * nothing receives a drop), so the receivable remainder is the receivable total
 * minus everything received, and it is never negative in practice.
 *
 * On every line raised before dropship existed, `qtyReceivable === quantity`, so
 * this returns `qtyOutstanding` exactly.
 */
export function receivableOutstanding(line: {
  qtyReceivable: number
  qtyReceived: number
}): number {
  return Math.max(0, (line.qtyReceivable ?? 0) - (line.qtyReceived ?? 0))
}

/**
 * Every distinct place this order's units are going, in the order they are met.
 *
 * Read from the allocations first, then the line, then the header — R1's
 * inheritance chain, walked in the renderer so the receipt, the shipping box and
 * the drop-ship caption all name the same set of parties. An order with no lines
 * at all still has a destination: its header's.
 */
export function orderDestinations(detail: PurchaseOrderDetail): string[] {
  const seen: string[] = []
  const add = (raw: string | null | undefined): void => {
    const name = canonicalDestination(String(raw ?? ''))
    if (name && !seen.includes(name)) seen.push(name)
  }
  for (const line of detail.lines) {
    if (line.allocations.length > 0) for (const a of line.allocations) add(a.destination)
    else add(line.destination ?? detail.location)
  }
  if (seen.length === 0) add(detail.location)
  return seen
}

/** The destinations on this order that do NOT hold stock — the drop half. */
export function dropDestinations(detail: PurchaseOrderDetail): string[] {
  return orderDestinations(detail).filter((d) => !destinationHoldsStock(d))
}

/**
 * Is this line wholly drop-shipped — nothing on it is coming here at all?
 *
 * Deliberately not "has any drop units": a line split 12 → RM and 8 → a shop is
 * still a line the receiving desk has to count twelve of. Only a line with
 * nothing receivable gets the Drop treatment in place of a progress figure,
 * because only that line has no progress to report.
 */
export function lineIsWhollyDrop(line: PurchaseOrderLine): boolean {
  return line.quantity > 0 && line.qtyReceivable <= 0
}

/* -------------------------------------------------------------------------- */
/* Per-line routing while a purchase order is being drafted                    */
/* -------------------------------------------------------------------------- */

/**
 * One split row in the line editor.
 *
 * `key` is local to the editor and exists so a row keeps its identity across
 * re-orders and edits; `id` is the STORED allocation this row came from, and is
 * absent on a row the operator has just added. Keeping the two apart is what
 * lets the editor be used both on a draft (no ids yet) and on an existing order.
 */
export interface DraftAllocation {
  key: string
  /** The stored allocation row this came from, when re-routing a live order. */
  id?: string
  quantity: number
  /** null means "inherit the line's supplier" — store the inheritance, not a copy. */
  supplier: string | null
  destination: string
}

/**
 * A working line in the create form.
 *
 * Quantity and unit price stay STRINGS so the inputs remain controlled and can
 * be empty mid-typing — the create form has always done this, and turning them
 * into numbers here would make backspacing the last digit snap the field to 0.
 */
export interface DraftLine {
  productId: string
  productName: string
  sku: string
  category: string
  quantity: string
  unitPrice: string
  /**
   * null means "same as the header".
   *
   * The inheritance is stored, not a copy of the header's value: changing the
   * order's supplier afterwards has to move every line that never disagreed with
   * it, and a line holding a snapshot of the old name would silently stay behind.
   */
  supplier: string | null
  destination: string | null
  /**
   * Empty means NOT SPLIT, and writes no allocation rows at all.
   *
   * Never a single full-quantity row. A line with one allocation covering
   * everything is indistinguishable in behaviour from a line with none, but it
   * is distinguishable in the database — and the whole back-compat story rests
   * on an ordinary line storing nothing.
   */
  allocations: DraftAllocation[]
}

/** Row identity for the split editor. Never stored, never sent. */
let draftSeq = 0
export function newDraftKey(): string {
  draftSeq += 1
  return `split-${draftSeq}`
}

/** Σ of a split set, rounded the same way the write path rounds it. */
export function splitTotal(rows: DraftAllocation[]): number {
  return rows.reduce((n, r) => n + Math.max(0, Math.round(Number(r.quantity) || 0)), 0)
}

/**
 * Why this line's splits cannot be saved yet, or null when they can.
 *
 * Invariant I1 (Σ splits = line quantity) and I5 (every split ≥ 1) checked in
 * the same order and with the same numbers the main process will check them in,
 * so the operator never gets a refusal from the backend that the form could have
 * told them about while they were typing.
 *
 * ZERO ROWS IS VALID and means "not split" — the one case that must not be
 * mistaken for a violation of I1.
 */
export function splitProblem(rows: DraftAllocation[], quantity: number): string | null {
  if (rows.length === 0) return null
  if (rows.some((r) => Math.round(Number(r.quantity) || 0) < 1)) {
    return 'Every split needs at least 1 unit. Remove the empty ones instead of leaving them at zero.'
  }
  if (rows.some((r) => !r.destination.trim())) return 'Every split needs a destination.'
  const sum = splitTotal(rows)
  if (sum === quantity) return null
  return sum < quantity
    ? `${quantity - sum} of ${quantity} units are not assigned yet.`
    : `${sum - quantity} more units are assigned than the line has.`
}
