import { useState } from 'react'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'

/**
 * A small centred pop-up for an action that happens in one press.
 *
 * ## Why these are not instant any more
 *
 * "Goods are in hand" and "Send anyway" used to fire the moment they were
 * clicked, from a button sitting in a stack of other buttons on a card. Both
 * move an order along, and one of them overrides a payment gate — and the only
 * feedback either gave was the board redrawing underneath the cursor. On a card
 * that already carries Retry QuickBooks, To QuickBooks and a delete, a mis-click
 * was a change nobody asked for and nothing to show it had happened.
 *
 * So they ask, in the middle of the screen, in one line, with one button. The
 * point is not friction — this is deliberately the SMALLEST possible dialog, no
 * fields and no second thought — it is that an action worth doing is worth
 * seeing yourself do.
 *
 * ## Centred, like every other dialog here
 *
 * The owner asked for these to be centred pop-ups rather than anything anchored
 * to a card or a rail. `Modal` already centres — see `.modal-overlay` — so this
 * is that, kept deliberately short so it reads in one glance and closes in one
 * click.
 */
export function QuickConfirm({
  title,
  detail,
  confirmLabel,
  confirmIcon = 'Check',
  tone = 'primary',
  onConfirm,
  onClose
}: {
  title: string
  /** One sentence: what is about to happen, and to which order. */
  detail: string
  confirmLabel: string
  confirmIcon?: string
  tone?: 'primary' | 'danger'
  /** Resolves when the work is done; the dialog closes itself afterwards. */
  onConfirm: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)

  const go = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} icon={confirmIcon} loading={busy} onClick={() => void go()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="qc-line">
        <Icon name={confirmIcon} size={15} />
        <span>{detail}</span>
      </p>
    </Modal>
  )
}
