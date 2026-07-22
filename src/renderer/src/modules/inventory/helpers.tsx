import type { InventoryProduct, InventoryTxnType, UnitType } from '@shared/types'

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
  /** On-hand market value = quantity × marketUnit. */
  invValue: number
  /** Average cost per unit. */
  avgCost: number
  /** On-hand cost basis = quantity × average cost. */
  totalCost: number
  /** invValue − totalCost. */
  spread: number
  /** Whether we have a cost basis (drives whether cost/spread show a value). */
  hasCost: boolean
  /** Whether a high bid is recorded. */
  hasBid: boolean
}

/** The money metrics for a product from its quantity, cost and high bid. */
export function productMetrics(
  p: Pick<InventoryProduct, 'quantity' | 'unitCost' | 'highBid'>
): ProductMetrics {
  const hasBid = p.highBid != null && p.highBid > 0
  const marketUnit = hasBid ? (p.highBid as number) : p.unitCost
  const invValue = p.quantity * marketUnit
  const totalCost = p.quantity * p.unitCost
  return {
    marketUnit,
    invValue,
    avgCost: p.unitCost,
    totalCost,
    spread: invValue - totalCost,
    hasCost: p.unitCost > 0,
    hasBid
  }
}

const TXN_LABEL: Record<InventoryTxnType, string> = {
  sale: 'Sale',
  purchase: 'Purchase',
  restock: 'Restock',
  adjustment: 'Adjustment'
}

export function TxnBadge({ type }: { type: InventoryTxnType }): JSX.Element {
  return <span className={`badge txn-${type}`}>{TXN_LABEL[type]}</span>
}

export function LocBadge({ location }: { location: string | null }): JSX.Element {
  if (!location) return <span className="muted">—</span>
  return <span className="badge loc-badge">{location}</span>
}
