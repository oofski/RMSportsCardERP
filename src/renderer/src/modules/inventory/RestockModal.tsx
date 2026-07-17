import { useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'

export function RestockModal({
  product,
  onClose,
  onSaved
}: {
  product: InventoryProduct
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [mode, setMode] = useState<'restock' | 'adjustment'>('restock')
  const [amount, setAmount] = useState('1')
  const [unitCost, setUnitCost] = useState(String(product.unitCost))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setError('')
    const n = parseInt(amount, 10)
    if (!Number.isFinite(n) || n === 0) {
      setError('Enter a non-zero quantity.')
      return
    }
    const cost = parseFloat(unitCost)
    if (mode === 'restock' && (!Number.isFinite(cost) || cost < 0)) {
      setError('Enter a valid unit cost.')
      return
    }
    // Restock adds stock; adjustment can be positive or negative.
    const change = mode === 'restock' ? Math.abs(n) : n
    setBusy(true)
    try {
      const res = await api.inventory.adjustStock({
        productId: product.id,
        type: mode,
        quantityChange: change,
        unitCost: mode === 'restock' ? cost : null,
        note: note.trim() || null
      })
      if (!res.ok) {
        setError(res.error ?? 'Could not update stock.')
        return
      }
      toast.success(mode === 'restock' ? 'Stock added.' : 'Stock adjusted.')
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Adjust stock"
      subtitle={`${product.name} · ${product.quantity} in stock`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={submit}>
            {mode === 'restock' ? 'Add stock' : 'Apply adjustment'}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}
      <Field label="Type">
        <Select value={mode} onChange={(e) => setMode(e.target.value as 'restock' | 'adjustment')}>
          <option value="restock">Restock (add stock)</option>
          <option value="adjustment">Adjustment (correct count, +/−)</option>
        </Select>
      </Field>
      <div className="field-row">
        <Field
          label={mode === 'restock' ? 'Quantity to add' : 'Change (use − to reduce)'}
        >
          <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        {mode === 'restock' && (
          <Field label="Unit cost" hint="What you paid per unit">
            <Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Note" hint="Optional">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. New case from vendor" />
      </Field>
    </Modal>
  )
}
