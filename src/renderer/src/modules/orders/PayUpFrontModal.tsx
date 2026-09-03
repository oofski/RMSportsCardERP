import { useState } from 'react'
import type { InvoiceDetail } from '@shared/invoices'
import { PAYMENT_METHODS, PAYMENT_REFERENCE_MAX, validateInvoicePayment } from '@shared/invoices'
import { api } from '../../lib/api'
import { Button, Checkbox, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { paidAction } from '@shared/orderActions'

/**
 * RECORD THE MONEY. One dialog, whichever terms the buyer is on.
 *
 * ## It used to be half of a pair, and the pair was the owner's complaint
 *
 * "mark it as paid, like dont need 2 buttons there because if something is set
 * as marked as paid in the begingin marking it paid would mark it paid according
 * to the terms." There were two: this one, called "Paid up front…", which
 * recorded the amount, the method, the reference, moved the card and released
 * the order to be picked — and a plain "Mark paid" tick in the Payment column
 * that stamped a date and nothing else. Which of the two somebody got depended
 * on which column the card was standing in.
 *
 * This is now the only one, because it is a strict superset: leave every field
 * alone and it does exactly what the tick did. The terms decide the WORDS, not
 * which screen opens — see `paidAction` in @shared/orderActions, which also
 * decides whether the payment counts as having arrived before anything shipped.
 *
 * ## Why this is a dialog and not a button
 *
 * Because it does up to three separate things and somebody has to be able to
 * choose which. Recording money is one fact; moving the card to Paid is another;
 * releasing the order to the packing floor is a third. They usually happen
 * together — a case sold off a stream, paid by Zelle, pick it tonight — but each
 * of them comes apart in a real case:
 *
 *   A DEPOSIT is money with no release and no stage move. Half up front on a
 *   case order is normal and the order is nowhere near ready to go.
 *
 *   A TRUSTED BUYER ON TERMS is a release with no money at all — which is why
 *   there is a separate control for readiness elsewhere.
 *
 * A single button would have to pick one of those and be wrong about the others,
 * silently, on somebody's real money.
 *
 * ## The buy side is the precedent
 *
 * `setPurchaseOrderPaid` has recorded payment on a purchase order WITHOUT moving
 * its stage since the beginning, precisely so a received-but-unpaid order is not
 * dragged backwards to say the money arrived. The sell side had no equivalent:
 * the only way to say a buyer had paid was to drag the card to Paid, which is
 * the LAST column — so an order paid up front looked finished before anybody had
 * picked a single box.
 */
export function PayUpFrontModal({
  invoice,
  onClose,
  onSaved
}: {
  invoice: InvoiceDetail
  onClose: () => void
  onSaved: (updated: InvoiceDetail) => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [amount, setAmount] = useState(String(invoice.total.toFixed(2)))
  const [method, setMethod] = useState<string>(PAYMENT_METHODS[1])
  const [otherMethod, setOtherMethod] = useState('')
  const [reference, setReference] = useState('')
  const [readyToShip, setReadyToShip] = useState(true)
  const [markPaid, setMarkPaid] = useState(true)
  const [saving, setSaving] = useState(false)
  /** The words and the up-front flag, from the order's own terms. */
  const plan = paidAction(invoice)

  const value = Number(amount)
  const partial = Number.isFinite(value) && value > 0 && value < invoice.total - 0.005
  const problem = validateInvoicePayment({ amount: Number.isFinite(value) ? value : null }, invoice.total)

  const save = async (): Promise<void> => {
    if (saving || problem) return
    setSaving(true)
    try {
      const res = await api.invoices.payUpFront(invoice.id, {
        amount: Number.isFinite(value) ? value : null,
        method: method === 'Other' ? otherMethod.trim() || 'Other' : method,
        reference: reference.trim() || null,
        readyToShip,
        markPaid,
        // NOT ALWAYS TRUE ANY MORE. This call used to be reachable only from a
        // button called "Paid up front…", so the column it writes agreed with
        // the door by construction. One button now serves both terms, and an
        // on-delivery buyer paying on delivery did not pay up front.
        upFront: plan.upFront
      })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not record that payment.')
        return
      }
      toast.success(
        readyToShip
          ? `Payment recorded — ${invoice.invoiceNumber || 'the order'} is ready to ship.`
          : 'Payment recorded.'
      )
      await onSaved(res.data)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Record the payment"
      subtitle={`${invoice.customerName} · ${formatMoney(invoice.total)}`}
      onClose={() => (saving ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Check"
            loading={saving}
            disabled={saving || !!problem}
            onClick={() => void save()}
          >
            {readyToShip ? 'Record it and get it ready' : 'Record it'}
          </Button>
        </>
      }
    >
      {/* WHAT THE TERMS MEAN FOR THIS PRESS, in one sentence, written by the
          same helper that put the button on the card — so the card and the
          dialog can never describe the order differently. */}
      <p className="fin-confirm-lead">{plan.detail}</p>

      <Field label="How much arrived" hint={problem ?? 'Defaults to the whole order.'}>
        <Input
          type="number"
          step="0.01"
          min="0"
          value={amount}
          autoFocus
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>

      <Field label="How">
        <Select value={method} onChange={(e) => setMethod(e.target.value)}>
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
      {/* The list can only ever hold the ways people have paid so far, and the
          next one is always possible. What the list buys is that the four that
          happen constantly are one tap rather than four spellings of "zelle"
          that no report can group. */}
      {method === 'Other' && (
        <Field label="Say how">
          <Input
            value={otherMethod}
            placeholder="Cheque, trade, …"
            onChange={(e) => setOtherMethod(e.target.value)}
          />
        </Field>
      )}

      <Field label="Reference" hint="A confirmation number, a last four, a note. Optional.">
        <Input
          value={reference}
          maxLength={PAYMENT_REFERENCE_MAX}
          placeholder="ZL-4417"
          onChange={(e) => setReference(e.target.value)}
        />
      </Field>

      <Checkbox
        checked={readyToShip}
        onChange={setReadyToShip}
        label="Get it ready to ship"
        hint={
          invoice.paymentTiming === 'front'
            ? 'This is the gate that is holding it — nothing ships on these terms until the money is in.'
            : 'Puts it on the packing list. This is separate from the money — a deposit usually is not ready.'
        }
      />
      <Checkbox
        checked={markPaid}
        onChange={setMarkPaid}
        label="Move the card to Paid"
        hint="Leave this off for a deposit against a bigger order — Paid is where an order stops moving."
      />

      {/* SAID BEFORE IT HAPPENS, not after. Paid is terminal on this board, and
          a part payment that quietly marked the whole order settled would take
          the rest of the money off every outstanding figure the owner reads. */}
      {partial && markPaid && (
        <p className="ord-pay-warn">
          <Icon name="AlertTriangle" size={14} />
          <span>
            That is {formatMoney(value)} of {formatMoney(invoice.total)}. Marking the card{' '}
            <b>Paid</b> says the whole order is settled and it cannot be moved back — for a
            deposit, untick it.
          </span>
        </p>
      )}
    </Modal>
  )
}
