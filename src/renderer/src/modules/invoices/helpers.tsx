import type { InvoiceStatus } from '@shared/invoices'
import { Icon } from '../../components/Icon'

/**
 * Per-status display metadata — a label, an Icon name (all five are already in
 * the Icon MAP) and a tone slug driving the `.inv-badge-<tone>` colourway.
 * Shared by the board cards and the invoice modal so a status looks the same
 * wherever it appears, exactly as PO_STAGE_META does on the buy side.
 *
 * Deliberately NOT the same table as PO_STAGE_META even though both have a
 * "Paid": a PO's paid means money left, an invoice's means money arrived, and
 * one record indexed by two different vocabularies is how "Received" ends up on
 * an invoice.
 *
 * The labels match INVOICE_STAGES so a card and its column never call the same
 * status two things; `void` is here and not there because it is a status a card
 * can hold but not a column anybody drags to.
 */
const INVOICE_STAGE_META: Record<InvoiceStatus, { label: string; icon: string; tone: string }> = {
  draft: { label: 'Draft', icon: 'Pencil', tone: 'draft' },
  created: { label: 'In QuickBooks', icon: 'ReceiptText', tone: 'created' },
  sent: { label: 'Sent', icon: 'Send', tone: 'sent' },
  paid: { label: 'Paid', icon: 'DollarSign', tone: 'paid' },
  void: { label: 'Void', icon: 'Ban', tone: 'void' }
}

/**
 * Where an invoice is, as a chip.
 *
 * Reuses `.badge` and `.po-badge` — the geometry is identical to a PO's stage
 * chip and cloning it would be two pill shapes to keep in step — and adds only
 * the colourway, which is the one thing that has to differ.
 */
export function InvoiceStatusChip({ status }: { status: InvoiceStatus }): JSX.Element {
  const meta = INVOICE_STAGE_META[status]
  return (
    <span className={`badge po-badge inv-badge-${meta.tone}`}>
      <Icon name={meta.icon} size={13} />
      {meta.label}
    </span>
  )
}

/**
 * A YYYY-MM-DD as words, parsed at UTC NOON.
 *
 * `formatDate` would read as the obvious choice and would be wrong here: it
 * hands the string to `new Date`, which reads a date-only value as UTC
 * midnight, and midnight UTC rendered in any western zone is the day before —
 * so an invoice dated today would print as yesterday for everybody west of
 * Greenwich. Noon is far enough from both edges that no offset can move the
 * calendar day. Same reason as `addDays` in @shared/invoices.
 */
export function formatDay(day: string | null | undefined): string {
  if (!day) return '—'
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

