import type { PurchaseOrderStatus } from '@shared/types'

/**
 * Per-stage display metadata — a label, an Icon name (all four already live in
 * the Icon MAP) and a tone slug that drives the `.po-badge-<tone>` colourway.
 * Shared by the board columns, the card move buttons and the receipt badge so a
 * stage always looks the same wherever it shows up.
 */
export const PO_STAGE_META: Record<
  PurchaseOrderStatus,
  { label: string; icon: string; tone: string }
> = {
  ordered: { label: 'Ordered', icon: 'ShoppingCart', tone: 'ordered' },
  paid: { label: 'Paid', icon: 'DollarSign', tone: 'paid' },
  received: { label: 'Received', icon: 'PackageCheck', tone: 'received' },
  cancelled: { label: 'Cancelled', icon: 'Ban', tone: 'cancelled' }
}

/** The short verb shown on a card's move button for a given target stage. */
export const PO_MOVE_LABEL: Record<PurchaseOrderStatus, string> = {
  ordered: 'Reopen',
  paid: 'Mark paid',
  received: 'Receive',
  cancelled: 'Cancel'
}
