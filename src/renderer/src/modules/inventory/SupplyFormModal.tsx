import { useState } from 'react'
import type { Supply, SupplyUnit } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Checkbox, Field, Input, Modal, Select } from '../../components/ui'

const UNIT_OPTIONS: { id: SupplyUnit; label: string }[] = [
  { id: 'each', label: 'Each' },
  { id: 'roll', label: 'Roll' },
  { id: 'pack', label: 'Pack' },
  { id: 'box', label: 'Box' },
  { id: 'case', label: 'Case' },
  { id: 'other', label: 'Other' }
]

/** Create or edit an operating supply (bubble mailers, poly bags, labels…). */
export function SupplyFormModal({
  supply,
  onClose,
  onSaved
}: {
  supply?: Supply | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const isEdit = !!supply
  const [name, setName] = useState(supply?.name ?? '')
  const [unit, setUnit] = useState<SupplyUnit>(supply?.unit ?? 'each')
  const [unitCost, setUnitCost] = useState(supply?.unitCost ? String(supply.unitCost) : '')
  const [reorderPoint, setReorderPoint] = useState(
    supply?.reorderPoint ? String(supply.reorderPoint) : ''
  )
  const [recurring, setRecurring] = useState(supply?.recurring ?? false)
  const [openingQty, setOpeningQty] = useState('')
  const [notes, setNotes] = useState(supply?.notes ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const numOrNull = (v: string): number | null => {
    if (v.trim() === '') return null
    const n = parseFloat(v)
    return Number.isFinite(n) ? n : null
  }

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setError('Enter a name.')
      return
    }
    const cost = numOrNull(unitCost)
    if (cost != null && cost < 0) {
      setError('Unit cost must be 0 or more.')
      return
    }
    const reorder = numOrNull(reorderPoint)
    if (reorder != null && reorder < 0) {
      setError('Reorder point must be 0 or more.')
      return
    }
    setError('')
    setBusy(true)
    try {
      let res
      if (isEdit) {
        res = await api.supplies.update({
          id: supply!.id,
          name: name.trim(),
          unit,
          unitCost: cost ?? 0,
          reorderPoint: reorder ?? 0,
          recurring,
          notes: notes.trim() || null
        })
      } else {
        const opening = numOrNull(openingQty)
        if (opening != null && opening < 0) {
          setError('Opening quantity must be 0 or more.')
          setBusy(false)
          return
        }
        res = await api.supplies.create({
          name: name.trim(),
          unit,
          unitCost: cost ?? 0,
          reorderPoint: reorder ?? 0,
          recurring,
          notes: notes.trim() || null,
          openingQuantity: opening ?? 0
        })
      }
      if (!res.ok) {
        setError(res.error ?? 'Could not save the supply.')
        return
      }
      toast.success(isEdit ? 'Supply updated.' : `Added ${name.trim()}.`)
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit supply' : 'Add supply'}
      subtitle={isEdit ? supply?.name : 'Bubble mailers, poly bags, labels, tape…'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={submit}>
            {isEdit ? 'Save changes' : 'Add supply'}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. #4 Bubble mailers"
          autoFocus
        />
      </Field>

      <div className="field-row">
        <Field label="Unit">
          <Select value={unit} onChange={(e) => setUnit(e.target.value as SupplyUnit)}>
            {UNIT_OPTIONS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cost per unit" hint="What you pay each">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Reorder at" hint="Flag low when on-hand hits this (0 = off)">
          <Input
            type="number"
            min={0}
            step="1"
            value={reorderPoint}
            onChange={(e) => setReorderPoint(e.target.value)}
            placeholder="0"
          />
        </Field>
        {!isEdit && (
          <Field label="On hand now" hint="Opening count (optional)">
            <Input
              type="number"
              min={0}
              step="1"
              value={openingQty}
              onChange={(e) => setOpeningQty(e.target.value)}
              placeholder="0"
            />
          </Field>
        )}
      </div>

      <div style={{ margin: '4px 0 10px' }}>
        <Checkbox
          checked={recurring}
          onChange={setRecurring}
          label="Recurring — we reorder this on repeat"
        />
      </div>

      <Field label="Notes" hint="Optional">
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Amazon, 200-count box"
        />
      </Field>
    </Modal>
  )
}
