import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useToast } from '../components/Toast'
import { Button } from './ui'

/**
 * "Check tracking" — read every active order's carrier page right now.
 *
 * The same sweep the app runs hourly, on demand. One button covers purchase
 * orders AND invoices because it is one sweep: the carrier does not care which
 * side of the money a package is on, and two buttons would double the request
 * rate for the same answer.
 *
 * ## It says what actually happened
 *
 * Carrier pages get restructured and reads get refused, so some checks fail.
 * The toast reports updated / unchanged / failed rather than a flat "done",
 * because "checked 12, updated 0, 12 failed" is the difference between "nothing
 * moved today" and "this stopped working" — and a button that says "done" to
 * both teaches people to ignore it.
 *
 * ## It hides itself where it cannot work
 *
 * Reading is done by the desktop app's own browser. The web build has none, so
 * rather than offering a button that always fails, it is not rendered — the
 * statuses there are whatever a desktop machine last synced, which the age on
 * each card already makes clear.
 */
export function CheckTrackingButton({
  onDone
}: {
  /** Re-read the board: a sweep changes statuses on cards already on screen. */
  onDone: () => void | Promise<void>
}): JSX.Element | null {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [can, setCan] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void api.purchaseOrders.canReadTracking().then((v) => {
      if (alive) setCan(v)
    })
    return () => {
      alive = false
    }
  }, [])

  if (can === false) return null

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.purchaseOrders.checkTracking()
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not check tracking.')
        return
      }
      const { checked, updated, failed, error } = res.data
      if (error) {
        toast.error(error)
        return
      }
      await onDone()
      if (checked === 0) {
        toast.success('Nothing to check — no active orders have a tracking number.')
      } else if (failed === 0) {
        toast.success(
          updated > 0
            ? `Checked ${checked}, ${updated} moved on.`
            : `Checked ${checked} — nothing has moved.`
        )
      } else if (failed === checked) {
        // EVERY read failed. That is not "nothing moved" — it is the feature
        // being broken, and it gets said as an error so nobody reads a board of
        // stale statuses as a quiet day.
        toast.error(
          `Could not read any of the ${checked} carrier pages. The statuses on screen are the last ones that worked.`
        )
      } else {
        // Some worked. Still stated plainly rather than as a flat "done": a
        // number that keeps climbing is how somebody notices a carrier has
        // started refusing us.
        toast.success(`Checked ${checked}: ${updated} moved on, ${failed} could not be read.`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="secondary"
      icon="RefreshCw"
      loading={busy}
      title="Read every active order's carrier page now. Runs on its own every hour."
      onClick={() => void run()}
    >
      Check tracking
    </Button>
  )
}
