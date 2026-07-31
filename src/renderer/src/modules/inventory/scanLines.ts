import type {
  InventoryProduct,
  ScanCommitInput,
  ScanCommitKind,
  ScanDirection,
  ScanMode,
  ScanPoCandidate,
  ScanResolution
} from '@shared/types'

/**
 * The pending scan list — the small piece of state that makes a stack of
 * identical boxes one confirmation instead of five.
 *
 * Scanning a code that is ALREADY pending does not open a second confirm panel;
 * it increments the line that is already there. The unit cost is identical (same
 * product, same PO line), so there is nothing to decide a second time — the
 * operator watches the count climb and confirms ONCE.
 *
 * Deliberately pure and React-free: this is the behaviour worth testing, and it
 * is tested under real SQLite alongside the commit it produces.
 *
 * A line is not a new commit contract. `commitScan` has always taken a quantity,
 * so a line of five is ONE ordinary commit with quantity 5 — not five commits,
 * and not a batch endpoint. Each line carries its OWN clientToken, so a retry
 * replays that line instead of applying it twice.
 */

export interface PendingLine {
  /** Identity for merging repeat scans. One line per product per direction, and
   * one per PO line — never per scan. Immutable once created, so editing a
   * line's location doesn't split the next scan onto a second row. */
  key: string
  /** Idempotency key for THIS line's commit. Stable across quantity edits and
   * across retries; a fresh line always gets a fresh token. */
  token: string
  kind: ScanCommitKind
  direction: ScanDirection
  productId: string
  productName: string
  sku: string
  category: string
  imageUrl: string | null
  location: string
  /** The accumulated count — what the operator is watching. */
  quantity: number
  /** How many barcode reads landed on this line (a hand-edit does not bump it),
   * so "scanned 5×, counted 4" is visible rather than silent. */
  scans: number
  /** Inbound only. On a PO line this is the order's price and is not editable. */
  unitCost: number | null
  costLocked: boolean
  /**
   * The line cannot commit until a cost is entered.
   *
   * Set for an inbound line whose product has NO cost basis to fall back on.
   * addStock(unitCost = null) values the receipt at the product's running
   * average, which for such a product is zero — so the units land on the shelf
   * at $0.00, their whole market value is booked as spread, and the zero cost
   * layer never washes out (a later correct receipt only averages against it).
   * That is where fabricated spread comes from, so the cost stops being
   * optional exactly when it stops being knowable.
   */
  costRequired: boolean
  /** The first scan's raw code / latest scan's input mode, for the audit row. */
  rawCode: string
  mode: ScanMode
  /** PO context ('po_line' only). */
  lineId?: string
  poId?: string
  poNumber?: string
  completesPo?: boolean
  /** Ceiling the operator cannot scan past: the PO's outstanding units inbound,
   * on-hand at the location outbound. null = no ceiling. */
  max: number | null
  /** On-hand per location at the last scan — the outbound ceiling follows the
   * location the operator picks. */
  onHand: Record<string, number>
  /** True when a scan asked for more than `max` allows, so the row can say so
   * instead of silently swallowing beeps. */
  overflow: boolean
  /** Bumped on every scan that lands here; the row flashes on change. */
  bumpedAt: number
}

/** crypto.randomUUID is available in the Electron renderer; the fallback only
 * exists so a missing secure context can never break the idempotency key. */
export function newToken(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export function lineKey(kind: ScanCommitKind, productId: string, lineId?: string): string {
  return kind === 'po_line' ? `po:${lineId ?? ''}` : `${kind}:${productId}`
}

/** On-hand map for a product, defaulted so a missing location reads 0. */
function onHandOf(product: InventoryProduct): Record<string, number> {
  return { ...product.quantityByLocation }
}

/** The ceiling for a line: a PO line cannot receive more than is outstanding,
 * and stock cannot go out that is not there. */
function ceilingOf(
  kind: ScanCommitKind,
  candidate: ScanPoCandidate | null | undefined,
  onHand: Record<string, number>,
  location: string
): number | null {
  if (kind === 'po_line') return candidate ? candidate.qtyOutstanding : null
  if (kind === 'remove_stock') return Math.max(0, onHand[location] ?? 0)
  return null // an inbound stock-in has no natural ceiling
}

/**
 * Build the line a resolved scan would add. `candidate` is required for a PO
 * line (the caller has either the only candidate or the one the operator
 * picked); everything else becomes a direct product line whose direction decides
 * whether it raises or lowers stock.
 */
export function lineFromScan(args: {
  resolution: ScanResolution
  product: InventoryProduct
  direction: ScanDirection
  mode: ScanMode
  candidate?: ScanPoCandidate | null
  imageUrl?: string | null
  now?: number
}): PendingLine {
  const { resolution, product, direction, mode } = args
  const candidate = args.candidate ?? null
  const kind: ScanCommitKind = candidate ? 'po_line' : direction === 'out' ? 'remove_stock' : 'add_stock'
  const onHand = onHandOf(product)
  const location = candidate
    ? candidate.location
    : isKnownLocation(resolution.suggestedLocation, onHand)
      ? resolution.suggestedLocation
      : Object.keys(onHand)[0] ?? resolution.suggestedLocation
  const max = ceilingOf(kind, candidate, onHand, location)
  return {
    key: lineKey(kind, product.id, candidate?.lineId),
    token: newToken(),
    kind,
    direction,
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    category: product.category,
    imageUrl: args.imageUrl ?? resolution.imageUrl,
    location,
    quantity: max != null ? Math.min(1, Math.max(0, max)) : 1,
    scans: 1,
    unitCost: candidate ? candidate.unitPrice : direction === 'out' ? null : resolution.suggestedUnitCost,
    costLocked: !!candidate,
    // A PO line carries the order's price and outbound never touches cost, so
    // only a bare inbound scan can be missing one — and only when the product
    // has no average to inherit.
    costRequired: !candidate && direction === 'in' && !(product.unitCost > 0),
    rawCode: resolution.rawCode,
    mode,
    lineId: candidate?.lineId,
    poId: candidate?.poId,
    poNumber: candidate?.poNumber,
    completesPo: candidate?.completesPo,
    max,
    onHand,
    overflow: max != null && max < 1,
    bumpedAt: args.now ?? Date.now()
  }
}

function isKnownLocation(loc: string, onHand: Record<string, number>): boolean {
  return Object.prototype.hasOwnProperty.call(onHand, loc)
}

const clamp = (qty: number, max: number | null): number =>
  max == null ? Math.max(1, qty) : Math.min(Math.max(0, max), Math.max(0, qty))

/**
 * Fold one scanned line into the pending list: a repeat scan of something
 * already pending just adds one to that line's count (refreshing the PO
 * outstanding / on-hand ceiling it was resolved against), and anything new is
 * appended. The list order never changes, so the row an operator is watching
 * does not jump.
 */
export function mergeScan(lines: PendingLine[], incoming: PendingLine): PendingLine[] {
  const at = lines.findIndex((l) => l.key === incoming.key)
  if (at < 0) return [...lines, incoming]
  const prev = lines[at]
  // The ceiling follows the freshly-resolved reality, but the location, cost and
  // any hand-typed count stay the operator's.
  const max = prev.kind === 'remove_stock' ? Math.max(0, incoming.onHand[prev.location] ?? 0) : incoming.max
  const wanted = prev.quantity + 1
  const merged: PendingLine = {
    ...prev,
    quantity: clamp(wanted, max),
    scans: prev.scans + 1,
    max,
    onHand: incoming.onHand,
    completesPo: incoming.completesPo ?? prev.completesPo,
    costRequired: incoming.costRequired,
    rawCode: prev.rawCode,
    mode: incoming.mode,
    overflow: max != null && wanted > max,
    bumpedAt: incoming.bumpedAt
  }
  const next = [...lines]
  next[at] = merged
  return next
}

/** Hand-edit the count. Clamped to the same ceiling a scan obeys, so a typo
 * cannot promise stock a PO or a shelf does not have. */
export function setQuantity(lines: PendingLine[], key: string, quantity: number): PendingLine[] {
  return lines.map((l) =>
    l.key === key
      ? { ...l, quantity: clamp(Math.round(quantity), l.max), overflow: l.max != null && quantity > l.max }
      : l
  )
}

/** Move a line to the other stock location. Outbound, the ceiling moves with it. */
export function setLocation(lines: PendingLine[], key: string, location: string): PendingLine[] {
  return lines.map((l) => {
    if (l.key !== key) return l
    const max = l.kind === 'remove_stock' ? Math.max(0, l.onHand[location] ?? 0) : l.max
    return { ...l, location, max, quantity: clamp(l.quantity, max), overflow: false }
  })
}

/** Inbound cost basis; null means "keep the running average". */
export function setUnitCost(lines: PendingLine[], key: string, unitCost: number | null): PendingLine[] {
  return lines.map((l) => (l.key === key && !l.costLocked ? { ...l, unitCost } : l))
}

export function removeLine(lines: PendingLine[], key: string): PendingLine[] {
  return lines.filter((l) => l.key !== key)
}

/** What the header shows: how many lines and how many units are waiting. */
export function queueTotals(lines: PendingLine[]): { lines: number; units: number } {
  return { lines: lines.length, units: lines.reduce((n, l) => n + l.quantity, 0) }
}

/** Lines that still need a unit cost before the list can be confirmed. */
export function linesNeedingCost(lines: PendingLine[]): PendingLine[] {
  return lines.filter((l) => l.costRequired && l.unitCost == null)
}

/**
 * Why the list cannot be confirmed yet, or null when it can.
 *
 * Kept here rather than in the button so the rule is testable and so the reason
 * can be SHOWN — a Confirm that is merely greyed out with no explanation is the
 * same dead end as one that silently books stock at nothing.
 */
export function commitBlockedReason(lines: PendingLine[]): string | null {
  if (lines.length === 0) return null
  if (lines.some((l) => l.quantity < 1)) return 'Every line needs a count of at least 1.'
  const needCost = linesNeedingCost(lines)
  if (needCost.length === 0) return null
  return needCost.length === 1
    ? `Enter what ${needCost[0].productName} cost — it has no cost on record, so it would go on the shelf at $0.00.`
    : `${needCost.length} items have no cost on record. Enter what they cost, or they go on the shelf at $0.00.`
}

/**
 * The commit for one line — the SAME shape the single-scan flow has always
 * sent, carrying the accumulated quantity. Nothing about the commit contract
 * changed; a line of five is one of these with quantity: 5.
 */
export function toCommitInput(line: PendingLine): ScanCommitInput {
  const base = {
    rawCode: line.rawCode,
    mode: line.mode,
    quantity: line.quantity,
    clientToken: line.token
  }
  if (line.kind === 'po_line') return { ...base, kind: 'po_line', lineId: line.lineId }
  if (line.kind === 'remove_stock') {
    return { ...base, kind: 'remove_stock', productId: line.productId, location: line.location }
  }
  return {
    ...base,
    kind: 'add_stock',
    productId: line.productId,
    location: line.location,
    unitCost: line.unitCost
  }
}
