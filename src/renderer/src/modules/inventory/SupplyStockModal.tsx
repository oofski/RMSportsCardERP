import { useState } from 'react'
import type { Supply } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'

type Mode = 'purchase' | 'use' | 'adjust'

const MODE_META: Record<Mode, { title: string; icon: string; cta: string }> = {
  purchase: { title: 'Log purchase', icon: 'PackagePlus', cta: 'Add to stock' },
  use: { title: 'Use / consume', icon: 'PackageMinus', cta: 'Record use' },
  adjust: { title: 'Adjust count', icon: 'Pencil', cta: 'Apply adjustment' }
}

/**
 * Move a supply's on-hand count: log a purchase (adds stock + records the
 * spend), record usage (consume), or correct the count up/down.
 */
export function SupplyStockModal({
  supply,
  initialMode = 'purchase',
  onClose,
  onSaved
}: {
  supply: Supply
  initialMode?: Mode
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [mode, setMode] = useState<Mode>(initialMode)
  const [quantity, setQuantity] = useState(mode === 'adjust' ? '' : '1')
  const [unitCost, setUnitCost] = useState(supply.unitCost ? String(supply.unitCost) : '')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const switchMode = (m: Mode): void => {
    setMode(m)
    setError('')
    setQuantity(m === 'adjust' ? '' : '1')
  }

  const submit = async (): Promise<void> => {
    setError('')
    const qty = parseInt(quantity, 10)
    if (!Number.isFinite(qty) || qty === 0) {
      setError('Enter a non-zero quantity.')
      return
    }
    if (mode !== 'adjust' && qty < 0) {
      setError('Quantity must be positive.')
      return
    }
    setBusy(true)
    try {
      let res
      if (mode === 'purchase') {
        const cost = unitCost.trim() === '' ? null : parseFloat(unitCost)
        if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
          setError('Enter a valid unit cost.')
          return
        }
        res = await api.supplies.purchase(supply.id, { quantity: qty, unitCost: cost, note: note.trim() || null })
      } else if (mode === 'use') {
        res = await api.supplies.use(supply.id, { quantity: qty, note: note.trim() || null })
      } else {
        res = await api.supplies.adjust(supply.id, qty, note.trim() || null)
      }
      if (!res.ok) {
        setError(res.error ?? 'Could not update the supply.')
        return
      }
      toast.success(
        mode === 'purchase'
          ? `Added ${qty} to ${supply.name}.`
          : mode === 'use'
            ? `Used ${qty} ${supply.name}.`
            : `Adjusted ${supply.name}.`
      )
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const meta = MODE_META[mode]

  return (
    <Modal
      title={meta.title}
      subtitle={supply.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={meta.icon} loading={busy} onClick={submit}>
            {meta.cta}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <div className="selected-product">
        <div>
          <div className="sp-name">{supply.name}</div>
          <div className="sp-meta">
            <span>{supply.quantity} on hand</span>
            <span>Avg ${supply.unitCost.toFixed(2)}/{supply.unit}</span>
          </div>
        </div>
      </div>

      <Field label="Action">
        <div className="loc-pills">
          {(['purchase', 'use', 'adjust'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`loc-pill ${mode === m ? 'active' : ''}`}
              onClick={() => switchMode(m)}
            >
              {MODE_META[m].title}
            </button>
          ))}
        </div>
      </Field>

      <div className="field-row">
        <Field label={mode === 'adjust' ? 'Change (use − to reduce)' : 'Quantity'}>
          <Input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            autoFocus
          />
        </Field>
        {mode === 'purchase' && (
          <Field label="Cost per unit" hint="Optional — updates avg cost">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              placeholder="0.00"
            />
          </Field>
        )}
      </div>

      <Field label="Note" hint="Optional">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={mode === 'use' ? 'e.g. Shipped 20 orders' : 'e.g. Restock from Amazon'}
        />
      </Field>
    </Modal>
  )
}
