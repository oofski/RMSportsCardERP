/**
 * Shipping and payment, as they appear on a printed document.
 *
 * Both PDF builders — the purchase order and the invoice — lay their header out
 * as a row of key/value cells, so this emits cells rather than a block and drops
 * into either header. They style those cells differently (the PO uses .k/.v in
 * a `.meta` row, the invoice .fkey/.fval in a `.facts` row), which is why the
 * class names are arguments: the CONTENT is shared, the look stays each
 * document's own. One copy, because a carrier printed one way on a PO and
 * another way on an invoice is how a document set becomes two document sets.
 *
 * Cells are OMITTED when empty rather than printed as a dash. A purchase order
 * with no tracking number should not print an empty "Tracking" heading; the
 * header simply gets shorter.
 */
import type { Carrier, PaymentTiming } from '@shared/freight'
import { carrierLabel, paymentLabel } from '@shared/freight'

function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface MetaCellClasses {
  /** Class on the cell wrapper. Empty for the PO, which styles bare divs. */
  cell?: string
  key: string
  value: string
}

export function shipMeta(
  f: {
    carrier: Carrier | null
    service: string | null
    trackingNumber: string | null
    paymentTiming: PaymentTiming | null
  },
  classes: MetaCellClasses
): string {
  const cell = (k: string, v: string): string =>
    `<div${classes.cell ? ` class="${classes.cell}"` : ''}>` +
    `<div class="${classes.key}">${esc(k)}</div>` +
    `<div class="${classes.value}">${esc(v)}</div></div>`

  const out: string[] = []

  // Carrier and service read as one fact ("UPS Ground"), so they share a cell —
  // and a service with no carrier still prints, because it is what was agreed.
  const ship = [carrierLabel(f.carrier), f.service].filter(Boolean).join(' ')
  if (ship) out.push(cell('Ship via', ship))

  const tracking = (f.trackingNumber ?? '').trim()
  if (tracking) out.push(cell('Tracking', tracking))

  const pay = paymentLabel(f.paymentTiming)
  if (pay) out.push(cell('Payment', pay))

  return out.join('\n    ')
}
