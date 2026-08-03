import type { InventoryProduct, InventoryTxnType, UnitType } from '@shared/types'

/** The text a product is searchable by. */
function haystack(p: InventoryProduct): string {
  return [p.name, p.sku, p.upc ?? '', p.category, p.brand, p.setName, p.year].join(' ').toLowerCase()
}

/**
 * Keyword search: every whitespace-separated term must appear somewhere in the
 * product's text, in ANY order (so "bowman 2026" and "2026 bowman" both match
 * "2026 Bowman Baseball Hobby 12-Box Case"). Empty query matches everything.
 */
export function productMatches(p: InventoryProduct, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = haystack(p)
  return q.split(/\s+/).every((term) => hay.includes(term))
}

export const UNIT_TYPES: { value: UnitType; label: string; plural: string }[] = [
  { value: 'case', label: 'Case', plural: 'Cases' },
  { value: 'box', label: 'Box', plural: 'Boxes' },
  { value: 'pack', label: 'Pack', plural: 'Packs' },
  { value: 'single', label: 'Single', plural: 'Singles' },
  { value: 'other', label: 'Other', plural: 'Other' }
]

export function unitLabel(unit: UnitType): string {
  return UNIT_TYPES.find((u) => u.value === unit)?.label ?? unit
}

export function UnitBadge({ unit }: { unit: UnitType }): JSX.Element {
  return <span className={`badge unit-${unit}`}>{unitLabel(unit)}</span>
}

/** e.g. "12-box case" or "case" — the pack/box structure of a product. */
export function structureLabel(p: Pick<InventoryProduct, 'unitType' | 'boxesPerCase'>): string {
  if (p.unitType === 'case') {
    return p.boxesPerCase ? `${p.boxesPerCase}-box case` : 'Case'
  }
  return unitLabel(p.unitType)
}

export interface ProductMetrics {
  /** Per-unit value: high bid when set, else average cost. */
  marketUnit: number
  /** On-hand market value. */
  invValue: number
  /** Average cost per unit — the cost basis divided back down. */
  avgCost: number
  /** On-hand cost basis, from the FIFO cost layers. */
  totalCost: number
  /** invValue − totalCost. */
  spread: number
  /** Whether we have a cost basis (drives whether cost/spread show a value). */
  hasCost: boolean
  /** Whether a high bid is recorded. */
  hasBid: boolean
}

/**
 * The money metrics for a product.
 *
 * The totals are READ, not recomputed. `costValue` and `marketValue` come off
 * the cost layers in the main process; deriving them here as quantity × unitCost
 * is the defect this whole model exists to remove — 7 boxes averaging $15.7142…
 * are worth $110.00, and no per-unit number multiplied by 7 says so. The average
 * runs the other way: it is the basis divided back down, so what is displayed
 * per unit and what is displayed as a total can never tell different stories.
 */
export function productMetrics(
  p: Pick<InventoryProduct, 'quantity' | 'unitCost' | 'highBid' | 'costValue' | 'marketValue'>
): ProductMetrics {
  const hasBid = p.highBid != null && p.highBid > 0
  const marketUnit = hasBid ? (p.highBid as number) : p.unitCost
  return {
    marketUnit,
    invValue: p.marketValue,
    avgCost: p.quantity > 0 ? p.costValue / p.quantity : p.unitCost,
    totalCost: p.costValue,
    spread: p.marketValue - p.costValue,
    hasCost: p.costValue > 0 || p.unitCost > 0,
    hasBid
  }
}

// Record<> rather than a partial map on purpose: adding a transaction type
// without a label here becomes a type error instead of a blank badge.
const TXN_LABEL: Record<InventoryTxnType, string> = {
  sale: 'Sale',
  purchase: 'Purchase',
  restock: 'Restock',
  adjustment: 'Adjustment',
  stream_break: 'Break',
  stream_giveaway: 'Giveaway'
}

export function TxnBadge({ type }: { type: InventoryTxnType }): JSX.Element {
  return <span className={`badge txn-${type}`}>{TXN_LABEL[type]}</span>
}

export function LocBadge({ location }: { location: string | null }): JSX.Element {
  if (!location) return <span className="muted">—</span>
  return <span className="badge loc-badge">{location}</span>
}
