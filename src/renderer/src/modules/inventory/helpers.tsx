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
