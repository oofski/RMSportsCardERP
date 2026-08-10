import { EmptyState } from '../../components/ui'

/**
 * Streaming performance — a door, and nothing behind it yet.
 *
 * The tab exists on purpose rather than being hidden until it works. The owner
 * asked for two, and a module that quietly ships one of them reads as though the
 * second was forgotten; a tab that says plainly it is not built says which half
 * of the request is outstanding.
 *
 * It shows NOTHING — no placeholder chart, no zeroed tiles, no sample rows. A
 * screen full of zeros is indistinguishable from a screen full of real figures
 * that happen to be zero, and this app has already decided (see the per-break
 * P&L, and every dash on the Shipping tab) that an absent number is written as
 * absent.
 */
export function StreamingTab(): JSX.Element {
  return (
    <EmptyState
      icon="CircleDot"
      title="Streaming performance is not built yet"
      message="Only the Shipping tab has been built. Nothing is being measured about shows here — this tab is a placeholder so it is clear which half is outstanding, not a screen waiting for data."
    />
  )
}
