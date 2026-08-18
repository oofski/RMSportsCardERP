import { useState } from 'react'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { allOrdersPacked } from '@shared/shippingViews'
import { api } from '../../lib/api'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * "Every order is packed — finish these orders?"
 *
 * ## Why this appears at all
 *
 * The uploaded PDF of packing slips is the paper the bench works against, and
 * the moment the last order is bagged it stops being useful and starts being in
 * the way — a megabyte on every machine, and a screen still offering a slip
 * nobody needs to read. Nothing said the night was over, so nothing ever put it
 * away.
 *
 * ## PACKED, not shipped
 *
 * The test is `allOrdersPacked` — nothing left in `to_pick`. Waiting for
 * everything to be `sent` would mean this never appeared until the carrier
 * scans came back, which is the next morning at best: long after the bench has
 * gone home and precisely when nobody is looking at this screen. See the note
 * on `allOrdersPacked` for why the exception and returned side-states are not
 * counted.
 *
 * ## What the button actually does, said before it is pressed
 *
 * It is NOT a delete, and the confirmation says so in those words, because
 * "finish" reads like one. Every package, card, claim and assignment stays
 * exactly where it is; tracking still works; an order can still ship. What goes
 * is the paper, and what arrives is a dated capture in Reports that survives
 * tomorrow's import overwriting the dataset.
 *
 * Gated on `canManage`. A packer finishing the night from the bench would put
 * the slip away for everybody, including whoever was still reading it.
 */
export function FinishNightBar({
  summary,
  canManage,
  onFinished
}: {
  summary: ShipWorkspaceSummary | null
  canManage: boolean
  onFinished: () => void | Promise<void>
}): JSX.Element | null {
  const toast = useToast()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')

  if (!canManage || !allOrdersPacked(summary)) return null

  const orders = summary?.counts.orders ?? 0
  const event = summary?.event?.name?.trim() || 'this event'

  const finish = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.shipping.finishNight(name.trim())
      if (!res.ok || !res.data) {
        // The refusals are sentences — "3 orders are still waiting to be picked"
        // — because the summary this screen rendered can be stale by the time
        // the click lands. Shown as written rather than replaced.
        toast.error(res.error ?? 'Could not finish these orders.')
        await onFinished()
        return
      }
      const { snapshotName, documentsCleared } = res.data
      toast.success(
        documentsCleared > 0
          ? `Saved as "${snapshotName}". The slip has been put away.`
          : `Saved as "${snapshotName}".`
      )
      setAsking(false)
      setName('')
      await onFinished()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="ship-finish-strip" role="status">
        <Icon name="PackageCheck" size={17} />
        <span>
          <b>Every order is packed.</b> All {orders} order{orders === 1 ? '' : 's'} on {event} have
          been put together — the slip is not needed any more.
        </span>
        <Button variant="primary" icon="Check" onClick={() => setAsking(true)}>
          Finish these orders
        </Button>
      </div>

      {asking && (
        <Modal
          title="Finish these orders"
          subtitle={`${orders} order${orders === 1 ? '' : 's'} · ${event}`}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Not yet
              </Button>
              <Button variant="primary" icon="Check" loading={busy} onClick={() => void finish()}>
                Finish and save the report
              </Button>
            </>
          }
        >
          {/* SAYS WHAT IT DOES, in the order somebody worries about it. The
              first thing anyone reading "finish" wants to know is whether the
              work is about to disappear, so that is answered first and
              plainly. */}
          <div className="ship-finish-body">
            <p>
              <b>Nothing is deleted.</b> Every package, card and claim stays exactly where it is.
              Orders that have not shipped yet can still be tracked and marked sent.
            </p>
            <p>
              What happens is two things: tonight is saved as a report you can open and export from
              the Reports tab, and the uploaded slip PDF is put away — it has done its job, and it
              is a megabyte sitting on every machine in the building.
            </p>
            <p className="muted">
              The report is a copy, not a link, so it still opens after tomorrow&apos;s import
              replaces this dataset.
            </p>

            <label className="field">
              <span className="field-label">Name this report</span>
              <input
                className="input"
                value={name}
                placeholder={`${event} — tonight`}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
              <span className="hint">Optional. Left blank, it is named after the event and date.</span>
            </label>
          </div>
        </Modal>
      )}
    </>
  )
}
