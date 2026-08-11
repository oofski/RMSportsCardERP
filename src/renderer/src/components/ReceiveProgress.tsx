import type { ReceiveProgress as Progress } from '@shared/receiving'
import { receiveSummary, receiveTone } from '@shared/receiving'
import { Icon } from './Icon'

/**
 * How much of a purchase order has landed, drawn the same way everywhere.
 *
 * The board card, the receipt and the Incoming Inventory panel all answer the
 * same question — "is this shipment all here?" — and before this they answered
 * it in three different vocabularies, or not at all. One component means the
 * colour, the wording and the rounding cannot drift apart between the screen
 * somebody checks and the screen somebody acts on.
 *
 * ## Green is reserved
 *
 * Only a fully received order is green. A part-received one is amber, always,
 * even at 97% — because the reading that matters is "is anything still owed",
 * and green answers that question wrongly. Over-receipt is red: more arrived
 * than was ordered is a discrepancy to go and look at, not progress.
 */
export function ReceiveBar({
  progress,
  /** Compact form for a card: bar and counts, no sentence. */
  compact = false,
  className = ''
}: {
  progress: Progress
  compact?: boolean
  className?: string
}): JSX.Element {
  const tone = receiveTone(progress)
  return (
    <div className={`recv ${compact ? 'recv-compact' : ''} ${className}`} data-tone={tone}>
      <div className="recv-line">
        <span className="recv-text">
          {tone === 'done' && <Icon name="PackageCheck" size={13} />}
          {tone === 'over' && <Icon name="AlertTriangle" size={13} />}
          {compact ? (
            <>
              <b className="mono">{progress.received}</b>
              <span className="recv-of">/{progress.ordered}</span> units
            </>
          ) : (
            receiveSummary(progress)
          )}
        </span>
        {/* The percentage trails the counts and never leads them: the number
            somebody acts on is "15 units still to come". */}
        {progress.state === 'partial' && (
          <span className="recv-pct mono">{progress.percent}%</span>
        )}
      </div>
      {/* Drawn even at zero — an empty rail is the reading "none of this has
          arrived", which is a real answer and the one a fresh PO should give. */}
      <div className="recv-rail" role="img" aria-label={receiveSummary(progress)}>
        <span style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
      </div>
    </div>
  )
}

/**
 * One line's state, as a pill beside its quantity.
 *
 * `2 of 5` rather than a bar, because a line is a handful of units and a bar
 * across six pixels tells nobody anything. The count is the whole message.
 */
export function ReceivePill({ progress }: { progress: Progress }): JSX.Element {
  const tone = receiveTone(progress)
  return (
    <span className="recv-pill" data-tone={tone} title={receiveSummary(progress)}>
      {tone === 'done' ? (
        <>
          <Icon name="PackageCheck" size={12} />
          {progress.ordered}
        </>
      ) : (
        <>
          <b className="mono">{progress.received}</b>
          <span className="recv-of">of {progress.ordered}</span>
        </>
      )}
    </span>
  )
}
