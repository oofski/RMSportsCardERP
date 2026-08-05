import { useMemo, useState } from 'react'
import type { Supply } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { formatMoney } from '../../lib/format'

/**
 * Place a supply order — it enters the pipeline at "Ordered". Stock and cost are
 * applied when the order is later marked Delivered. Same units × items-per-unit
 * + order-total math as a direct Buy.
 */
export function SupplyOrderModal({
  supplies,
  initialSupplyId,
  onClose,
  onSaved
}: {
  supplies: Supply[]
  initialSupplyId?: string
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const first = initialSupplyId ?? supplies[0]?.id ?? ''
  const [supplyId, setSupplyId] = useState(first)
  const selected = supplies.find((s) => s.id === supplyId) ?? null
  const [units, setUnits] = useState('1')
  const [itemsPerUnit, setItemsPerUnit] = useState(String(selected?.itemsPerUnit || 1))
  const [total, setTotal] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const chooseSupply = (id: string): void => {
    setSupplyId(id)
    const s = supplies.find((x) => x.id === id)
    setItemsPerUnit(String(s?.itemsPerUnit || 1))
  }

  const breakdown = useMemo(() => {
    const u = parseFloat(units)
    const ipu = parseFloat(itemsPerUnit)
    const t = parseFloat(total)
    if (!Number.isFinite(u) || !Number.isFinite(ipu) || u <= 0 || ipu <= 0) return null
    const items = Math.round(u) * Math.round(ipu)
    const hasTotal = Number.isFinite(t) && t >= 0
    return {
      items,
      perUnit: hasTotal && u > 0 ? t / Math.round(u) : null,
      perItem: hasTotal && items > 0 ? t / items : null
    }
  }, [units, itemsPerUnit, total])

  const submit = async (): Promise<void> => {
    if (!supplyId) {
      setError('Choose a supply.')
      return
    }
    const u = parseInt(units, 10)
    const ipu = parseInt(itemsPerUnit, 10)
    const t = total.trim() === '' ? NaN : parseFloat(total)
    if (!Number.isFinite(u) || u <= 0) {
      setError('Enter at least 1 unit.')
      return
    }
    if (!Number.isFinite(ipu) || ipu < 1) {
      setError('Items per unit must be at least 1.')
      return
    }
    if (!Number.isFinite(t) || t < 0) {
      setError('Enter the order total.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const res = await api.supplies.createOrder({
        supplyId,
        units: u,
        itemsPerUnit: ipu,
        total: t,
        note: note.trim() || null
      })
      if (!res.ok) {
        setError(res.error ?? 'Could not create the order.')
        return
      }
      toast.success(`Order placed for ${selected?.name ?? 'supply'}.`)
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  // No empty-state branch. The button that opens this is disabled while there
  // are no supplies and says why, so a modal explaining the same thing after the
  // click was a second answer to a question already answered before it.

  return (
    <Modal
      title="New supply order"
      subtitle="Enters the pipeline at Ordered"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="ShoppingCart" loading={busy} onClick={submit}>
            Place order
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <Field label="Supply">
        <Select value={supplyId} onChange={(e) => chooseSupply(e.target.value)}>
          {supplies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>

      <div className="field-row">
        <Field label="Units ordered" hint="Boxes / packs">
          <Input type="number" min={1} step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
        </Field>
        <Field label="Items per unit" hint="Pieces in each">
          <Input
            type="number"
            min={1}
            step="1"
            value={itemsPerUnit}
            onChange={(e) => setItemsPerUnit(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Order total" hint="What you paid for the whole order">
        <Input
          type="number"
          min={0}
          step="0.01"
          value={total}
          onChange={(e) => setTotal(e.target.value)}
          placeholder="0.00"
        />
      </Field>

      {breakdown && (
        <div className="supply-order-summary">
          <div className="sos-row">
            <span>Adds on delivery</span>
            <strong>
              {breakdown.items} {selected?.unit ?? ''}
            </strong>
          </div>
          <div className="sos-row">
            <span>Per unit</span>
            <strong>{breakdown.perUnit != null ? formatMoney(breakdown.perUnit) : '—'}</strong>
          </div>
          <div className="sos-row">
            <span>Per item</span>
            <strong>{breakdown.perItem != null ? formatMoney(breakdown.perItem) : '—'}</strong>
          </div>
        </div>
      )}

      <Field label="Note" hint="Optional">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. PO #, tracking" />
      </Field>
    </Modal>
  )
}
