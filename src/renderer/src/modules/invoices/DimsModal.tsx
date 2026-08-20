import { useState } from 'react'
import type { InvoiceDetail } from '@shared/invoices'
import { api } from '../../lib/api'
import { Button, Field, Input, Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'

/**
 * Weigh it and measure it.
 *
 * All four fields together, because `hasDims` reads a partial set as unmeasured
 * — a carrier prices a case on dimensional weight, so three of the four buys
 * nothing. Saving with the boxes empty clears the measurements, which is the way
 * back for a parcel that was repacked.
 */
export function DimsModal({
  invoice,
  onClose,
  onSaved
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const str = (v: number | null): string => (v == null ? '' : String(v))
  const [weightLb, setWeightLb] = useState(str(invoice.weightLb))
  const [lengthIn, setLengthIn] = useState(str(invoice.lengthIn))
  const [widthIn, setWidthIn] = useState(str(invoice.widthIn))
  const [heightIn, setHeightIn] = useState(str(invoice.heightIn))
  const [busy, setBusy] = useState(false)

  const num = (v: string): number | null => {
    const n = parseFloat(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.invoices.setDims(invoice.id, {
        weightLb: num(weightLb),
        lengthIn: num(lengthIn),
        widthIn: num(widthIn),
        heightIn: num(heightIn)
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save the measurements.')
        return
      }
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  const complete =
    !!num(weightLb) && !!num(lengthIn) && !!num(widthIn) && !!num(heightIn)

  return (
    <Modal
      title="Weigh and measure"
      subtitle={`${invoice.invoiceNumber || 'This order'} — ${invoice.customerName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={save}>
            {complete ? 'Save and mark ready' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Weight" hint="Pounds">
          <Input
            value={weightLb}
            inputMode="decimal"
            placeholder="6.5"
            autoFocus
            onChange={(e) => setWeightLb(e.target.value)}
          />
        </Field>
        <Field label="Length" hint="Inches">
          <Input
            value={lengthIn}
            inputMode="decimal"
            placeholder="12"
            onChange={(e) => setLengthIn(e.target.value)}
          />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Width" hint="Inches">
          <Input
            value={widthIn}
            inputMode="decimal"
            placeholder="9"
            onChange={(e) => setWidthIn(e.target.value)}
          />
        </Field>
        <Field label="Height" hint="Inches">
          <Input
            value={heightIn}
            inputMode="decimal"
            placeholder="4"
            onChange={(e) => setHeightIn(e.target.value)}
          />
        </Field>
      </div>
      {/* SAID PLAINLY, because a partial answer looks saved and does nothing.
          The card would keep its amber chip with numbers printed under it,
          which reads as the board being broken rather than as a field missing. */}
      <p className="sync-note">
        {complete
          ? 'All four are in, so this order moves to Ready to ship.'
          : 'A carrier prices a case on all four, so the order stays in Awaiting dims until every box has a number. Clearing them all is how a repacked parcel gets measured again.'}
      </p>
    </Modal>
  )
}
