import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { LOCATIONS, type Location } from '@shared/inventory'
import { validateConsignment } from '@shared/consignment'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { SupplierSelect } from '../invoicing/PartySelect'
import { unitLabel } from './helpers'

/**
 * SENDING A CASE TO SOMEBODY TO SELL FOR US.
 *
 * ## What this actually does to the shelf
 *
 * It takes the units OFF it, at their real FIFO cost, exactly as a break or a
 * giveaway does — see @shared/consignment for why that is the design. So this
 * dialog is not marking a flag; it is moving stock, and it says so, because
 * somebody who thinks they are ticking a box will not expect the on-hand figure
 * to drop.
 *
 * ## Who it goes to comes off the same list the purchase side uses
 *
 * `SupplierSelect` — vendors, contacts and everybody already bought from, in
 * one search, with the same fold-to-the-list-spelling behaviour so "Fenwick" and
 * "fenwick" do not become two consignees. And the same escape hatch: a one-off
 * to a shop nobody has filed is typed in, because a form that cannot express the
 * first time is a form somebody works around.
 *
 * ## The shelf is picked, and it matters
 *
 * A case at AM is not something RM can send, and the return has to know which
 * shelf to put it back on. Defaulted to one that actually has stock, so the
 * ordinary case is one fewer decision.
 */
export function ConsignModal({
  product,
  onClose,
  onSaved
}: {
  product: InventoryProduct
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  // LOWERCASED here rather than in the helper: `unitLabel` is a title — it is
  // what the badge and the column heading say — and these two uses put it in
  // the middle of a sentence, where "These Cases come off the shelf" reads as a
  // proper noun.
  const noun = unitLabel(product.unitType).toLowerCase()

  // Default to a shelf that has something on it — the same rule RecordSaleModal
  // follows, and for the same reason: the first thing this form does otherwise
  // is refuse.
  const firstStocked = useMemo<Location>(
    () => (LOCATIONS.find((l) => (product.quantityByLocation[l.id] ?? 0) > 0)?.id ?? 'RM') as Location,
    [product]
  )
  const [location, setLocation] = useState<Location>(firstStocked)
  const [consignee, setConsignee] = useState<string | null>(null)
  const [quantity, setQuantity] = useState('1')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const available = product.quantityByLocation[location] ?? 0
  const qty = parseInt(quantity, 10)
  const problem = validateConsignment(
    { productId: product.id, consignee: consignee ?? '', location, quantity: qty },
    available
  )

  const submit = async (): Promise<void> => {
    if (busy || problem) return
    setBusy(true)
    try {
      const res = await api.inventory.sendOnConsignment({
        productId: product.id,
        consignee: consignee ?? '',
        location,
        quantity: qty,
        note: note.trim() || null
      })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not send that.')
        return
      }
      toast.success(
        `${res.data.quantity} ${res.data.quantity === 1 ? noun : noun + 's'} out with ${res.data.consignee}.`
      )
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Send on consignment"
      subtitle={`${product.name} (${product.sku})`}
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="Send"
            loading={busy}
            disabled={busy || !!problem}
            onClick={() => void submit()}
          >
            Send it
          </Button>
        </>
      }
    >
      <Field label="Who has it" hint="Vendors, suppliers and anybody already dealt with. Not listed? Type the name.">
        <SupplierSelect
          value={consignee}
          onChange={setConsignee}
          ariaLabel="Consignee"
          blankLabel=""
        />
      </Field>

      <div className="row" style={{ gap: 10 }}>
        <Field label="Off which shelf" hint={`${available} on hand there`}>
          <Select value={location} onChange={(e) => setLocation(e.target.value as Location)}>
            {LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label} · {product.quantityByLocation[l.id] ?? 0}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How many">
          <Input
            value={quantity}
            inputMode="numeric"
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Note" hint="Optional — terms, when it is due back, anything worth remembering.">
        <Input
          value={note}
          placeholder="Back by the end of the month"
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>

      {/* SAID BEFORE THE PRESS, not discovered after it.

          Somebody who believes they are ticking a flag will not expect the
          on-hand figure to drop, and the drop is the whole point: it is what
          stops the case being sold or broken while it is in somebody else's
          shop. */}
      <div className="qbo-note">
        <Icon name="Info" size={15} />
        <div>
          These {noun}s come <b>off the shelf</b> — they cannot be sold or broken on a stream while
          they are out. Their cost goes with them and comes back at exactly the same price if the
          consignment returns.
        </div>
      </div>

      {problem && consignee !== null && <div className="form-error">{problem}</div>}
    </Modal>
  )
}
