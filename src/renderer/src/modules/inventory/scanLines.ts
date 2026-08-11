import type {
  InventoryProduct,
  ScanCommitInput,
  ScanCommitKind,
  ScanDirection,
  ScanMode,
  ScanOverride,
  ScanPoCandidate,
  ScanResolution,
  ScanSoCandidate
} from '@shared/types'
import type { LotPick } from '@shared/costLots'

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
  /** Order context: the PO line ('po_line') or the sales order line ('so_line'). */
  lineId?: string
  poId?: string
  poNumber?: string
  completesPo?: boolean
  /** Sales order context ('so_line' only). */
  invoiceId?: string
  invoiceNumber?: string
  customerName?: string | null
  /**
   * The operator's recorded answer to a scan that did not fit, once they have
   * given one. Null until then — and a line that NEEDS one cannot commit, so an
   * override is never assumed from the numbers.
   */
  override: ScanOverride | null
  /**
   * A question this line is waiting on, if any.
   *
   * 'overage'  more beeps landed here than the order has outstanding
   * 'no_order' the product matched no open order at all
   *
   * The station opens a modal on this and does not merge further scans into the
   * line until it is answered. It used to clamp silently: the count stopped
   * moving while `scans` kept climbing, every beep still sounded like a success,
   * and the only sign was a chip beside a number that had frozen.
   */
  needsDecision: ScanOverride | null
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
  outstanding: number | null,
  onHand: Record<string, number>,
  location: string
): number | null {
  if (kind === 'po_line' || kind === 'so_line') return outstanding
  if (kind === 'remove_stock') return Math.max(0, onHand[location] ?? 0)
  return null // an override'd stock-in has no natural ceiling
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
  /** The open PURCHASE order line this inbound scan is against. */
  candidate?: ScanPoCandidate | null
  /** The open SALES order line this outbound scan is against. */
  soCandidate?: ScanSoCandidate | null
  /** Set when the operator has already answered "this is on no open order". */
  override?: ScanOverride | null
  imageUrl?: string | null
  now?: number
}): PendingLine {
  const { resolution, product, direction, mode } = args
  const candidate = args.candidate ?? null
  const soCandidate = args.soCandidate ?? null
  const override = args.override ?? null
  const kind: ScanCommitKind = candidate
    ? 'po_line'
    : soCandidate
      ? 'so_line'
      : direction === 'out'
        ? 'remove_stock'
        : 'add_stock'
  const onHand = onHandOf(product)
  const location = candidate
    ? candidate.location
    : isKnownLocation(resolution.suggestedLocation, onHand)
      ? resolution.suggestedLocation
      : Object.keys(onHand)[0] ?? resolution.suggestedLocation
  const outstanding = candidate
    ? candidate.qtyOutstanding
    : soCandidate
      ? soCandidate.qtyOutstanding
      : null
  const max = ceilingOf(kind, outstanding, onHand, location)
  return {
    key: lineKey(kind, product.id, candidate?.lineId ?? soCandidate?.lineId),
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
    costRequired:
      !candidate && !soCandidate && direction === 'in' && !(product.unitCost > 0),
    rawCode: resolution.rawCode,
    mode,
    lineId: candidate?.lineId ?? soCandidate?.lineId,
    poId: candidate?.poId,
    poNumber: candidate?.poNumber,
    completesPo: candidate?.completesPo,
    invoiceId: soCandidate?.invoiceId,
    invoiceNumber: soCandidate?.invoiceNumber,
    customerName: soCandidate?.customerName ?? null,
    override,
    // A first scan onto a line with no room left is already the over-scan
    // question — it does not need a second beep to become one.
    needsDecision: !override && max != null && max < 1 ? 'overage' : null,
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
  // any hand-typed count stay the operator's. An override already given lifts
  // the ceiling entirely — that is what the operator agreed to.
  const max = prev.override
    ? null
    : prev.kind === 'remove_stock'
      ? Math.max(0, incoming.onHand[prev.location] ?? 0)
      : incoming.max
  const wanted = prev.quantity + 1
  const over = max != null && wanted > max

  const merged: PendingLine = {
    ...prev,
    // Held at the ceiling while the question is open. The count is not the lie
    // — the SILENCE was. `scans` says how many beeps landed and `needsDecision`
    // puts the difference in front of a person instead of dropping it.
    quantity: clamp(wanted, max),
    scans: prev.scans + 1,
    max,
    onHand: incoming.onHand,
    completesPo: incoming.completesPo ?? prev.completesPo,
    costRequired: incoming.costRequired,
    rawCode: prev.rawCode,
    mode: incoming.mode,
    needsDecision: over ? 'overage' : prev.needsDecision,
    overflow: over,
    bumpedAt: incoming.bumpedAt
  }
  const next = [...lines]
  next[at] = merged
  return next
}

/**
 * The operator answered an over-scan: take everything that was beeped.
 *
 * The ceiling comes off for good on this line — they have said the extra units
 * are really there — and the count jumps to the number of scans, which is what
 * they physically counted. The override rides to the commit, which refuses to
 * exceed an order without one.
 */
export function acceptOverage(lines: PendingLine[], key: string): PendingLine[] {
  return lines.map((l) =>
    l.key === key
      ? {
          ...l,
          override: 'overage' as ScanOverride,
          quantity: Math.max(l.quantity, l.scans),
          max: null,
          needsDecision: null,
          overflow: false
        }
      : l
  )
}

/**
 * The operator answered an over-scan the other way: stick to the order.
 *
 * The count stays at the ceiling and the extra beeps are dropped — but they were
 * SHOWN first, which is the whole difference from what this replaced. `scans` is
 * reset to the count so the row stops claiming a discrepancy that has been
 * settled.
 */
export function keepToOrder(lines: PendingLine[], key: string): PendingLine[] {
  return lines.map((l) =>
    l.key === key
      ? { ...l, scans: l.quantity, needsDecision: null, overflow: false }
      : l
  )
}

/** Is anything on the list waiting on a person? Nothing commits while it is. */
export function firstUndecided(lines: PendingLine[]): PendingLine | null {
  return lines.find((l) => l.needsDecision !== null) ?? null
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
  // An unanswered question outranks everything: the whole point of raising it
  // is that nothing goes through until a person has settled it.
  const undecided = firstUndecided(lines)
  if (undecided) {
    return undecided.needsDecision === 'overage'
      ? `${undecided.productName}: more was scanned than the order asked for. Answer that first.`
      : `${undecided.productName} is on no open order. Answer that first.`
  }
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
 *
 * `allocation` is the operator's cost-layer choice for an OUTBOUND line, passed
 * in rather than stored on the line: repeat scans of one code accumulate, and an
 * allocation chosen while the line read 1 would be wrong the moment it reads 5.
 * It is therefore asked once, at confirm, against the count that is about to be
 * committed.
 */
export function toCommitInput(line: PendingLine, allocation?: LotPick[] | null): ScanCommitInput {
  const base = {
    rawCode: line.rawCode,
    mode: line.mode,
    quantity: line.quantity,
    // Carried on every kind. The main process refuses a bare stock movement
    // without one, and refuses to exceed an order's outstanding without one, so
    // dropping it here would turn an answered question back into a refusal.
    override: line.override,
    clientToken: line.token
  }
  if (line.kind === 'po_line') return { ...base, kind: 'po_line', lineId: line.lineId }
  if (line.kind === 'so_line') {
    return {
      ...base,
      kind: 'so_line',
      lineId: line.lineId,
      location: line.location,
      allocation: allocation ?? null
    }
  }
  if (line.kind === 'remove_stock') {
    return {
      ...base,
      kind: 'remove_stock',
      productId: line.productId,
      location: line.location,
      allocation: allocation ?? null
    }
  }
  return {
    ...base,
    kind: 'add_stock',
    productId: line.productId,
    location: line.location,
    unitCost: line.unitCost
  }
}
