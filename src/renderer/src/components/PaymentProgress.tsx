import type { Invoice } from '@shared/invoices'
import {
  clearedWithoutPayment,
  invoicePaymentProgress,
  paidHereNotThere,
  paymentSummary,
  paymentTone
} from '@shared/invoices'
import { formatMoney } from '../lib/format'
import { Icon } from './Icon'

/**
 * How much of an invoice has been paid — the sell-side mirror of ReceiveBar.
 *
 * Deliberately the SAME rail, the same tones and the same rounding as the
 * receiving progress on a purchase order, down to reusing its CSS. A PO asks how
 * much of what we ordered has arrived; a sales order asks how much of what we
 * billed has been paid. One idea seen from each end, so somebody who has read
 * one bar already knows how to read the other, and money is the only thing that
 * differs from units.
 *
 * ## Green is reserved, exactly as it is over there
 *
 * Only a fully settled invoice is green. A part-paid one is amber at 99%,
 * because the reading that matters is "is anything still owed" and green answers
 * that wrongly on a screen whose whole job is who still owes us. More money than
 * the invoice is the danger tone: it is a discrepancy to go and look at, not
 * progress.
 *
 * ## Two things the bar alone cannot say, so they are said in words
 *
 * A balance can reach zero WITHOUT anybody sending money — a credit memo, a
 * write-off, a discount — and the rail fills up identically in all of them.
 * `clearedWithoutPayment` is how the card says so instead of showing a settled
 * invoice with a mysteriously absent date.
 *
 * And an invoice ticked paid here can still be open in QuickBooks: paid is
 * operator-recorded on this floor and plenty settle in cash QuickBooks never
 * sees. That card sits in the Paid column above a half-full rail, which looks
 * like a bug until something explains it — `paidHereNotThere` is that something.
 */
export function PaymentBar({
  invoice,
  /** Compact form for a board card: rail and figures, no sentence. */
  compact = false,
  className = ''
}: {
  invoice: Invoice
  compact?: boolean
  className?: string
}): JSX.Element | null {
  const progress = invoicePaymentProgress(invoice)
  // NOTHING RATHER THAN AN EMPTY RAIL. A receiving bar at zero is a real reading
  // — none of it has arrived — but a payment bar with no reading behind it would
  // be drawing "nothing paid" for every draft that has never been near
  // QuickBooks, which is a claim about money that nobody has made.
  if (progress.state === 'unknown') return null

  const tone = paymentTone(progress)
  const summary = paymentSummary(progress, (n) => formatMoney(n))
  const disputed = paidHereNotThere(invoice)
  const credited = clearedWithoutPayment(invoice)

  return (
    <div className={`recv ${compact ? 'recv-compact' : ''} ${className}`.trim()} data-tone={tone}>
      <div className="recv-line">
        <span className="recv-text">
          {tone === 'done' && <Icon name="DollarSign" size={13} />}
          {tone === 'over' && <Icon name="AlertTriangle" size={13} />}
          {compact ? (
            <>
              <b className="mono">{formatMoney(progress.paid)}</b>
              <span className="recv-of">/{formatMoney(progress.total)}</span>
            </>
          ) : (
            summary
          )}
        </span>
        {/* The percentage trails the figures and never leads them: the number
            somebody acts on is "$412.50 still owed". */}
        {progress.state === 'partial' && (
          <span className="recv-pct mono">{progress.percent}%</span>
        )}
      </div>
      <div className="recv-rail" role="img" aria-label={summary}>
        <span style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
      </div>
      {disputed && (
        <div className="inv-pay-note" title={summary}>
          <Icon name="Info" size={12} />
          Marked paid here — QuickBooks still shows {formatMoney(progress.outstanding)} owing.
        </div>
      )}
      {!disputed && credited && (
        <div className="inv-pay-note" title={summary}>
          <Icon name="Info" size={12} />
          Cleared without a payment — a credit or write-off, not money in.
        </div>
      )}
    </div>
  )
}
