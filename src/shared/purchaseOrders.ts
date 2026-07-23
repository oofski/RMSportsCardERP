import type { PurchaseOrderStatus } from './types'

export const PO_STATUSES: PurchaseOrderStatus[] = ['ordered', 'paid', 'received', 'cancelled']

/** Pipeline columns in display order. */
export const PO_STAGES: { id: PurchaseOrderStatus; label: string }[] = [
  { id: 'ordered', label: 'Ordered' },
  { id: 'paid', label: 'Paid' },
  { id: 'received', label: 'Received' },
  { id: 'cancelled', label: 'Cancelled' }
]

/** Allowed forward/back moves between stages. received & cancelled are terminal. */
export const PO_TRANSITIONS: Record<PurchaseOrderStatus, PurchaseOrderStatus[]> = {
  ordered: ['paid', 'cancelled'],
  paid: ['ordered', 'received', 'cancelled'],
  received: [],
  cancelled: []
}

export function isPurchaseOrderStatus(value: unknown): value is PurchaseOrderStatus {
  return PO_STATUSES.includes(value as PurchaseOrderStatus)
}

export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PO_TRANSITIONS[from]?.includes(to) ?? false
}
