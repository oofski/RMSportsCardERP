import { useState } from 'react'
import type { Supply, SupplyUnit } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Checkbox, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'

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
  const [itemsPerUnit, setItemsPerUnit] = useState(
    supply && supply.itemsPerUnit > 1 ? String(supply.itemsPerUnit) : ''
  )
  // Price the user actually pays: the cost of one ordering unit (a box/pack).
  // Stored as a per-item cost internally; prefilled as unitCost × itemsPerUnit.
  const [costPerUnit, setCostPerUnit] = useState(
    supply && supply.unitCost > 0
      ? String(Math.round(supply.unitCost * supply.itemsPerUnit * 100) / 100)
      : ''
  )
  const [reorderPoint, setReorderPoint] = useState(
    supply?.reorderPoint ? String(supply.reorderPoint) : ''
  )
  const [recurring, setRecurring] = useState(supply?.recurring ?? false)
  const [notes, setNotes] = useState(supply?.notes ?? '')
  const [reorderUrl, setReorderUrl] = useState(supply?.reorderUrl ?? '')
  const [imageUrl, setImageUrl] = useState<string | null>(supply?.imageUrl ?? null)
  const [imgBusy, setImgBusy] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const changePhoto = async (): Promise<void> => {
    if (!supply) return
    setImgBusy(true)
    try {
      const res = await api.supplies.setImage(supply.id)
      if (res.ok) {
        setImageUrl(res.data?.imageUrl ?? null)
        await onSaved()
      } else if (res.error && res.error !== 'No image selected.') {
        toast.error(res.error)
      }
    } finally {
      setImgBusy(false)
    }
  }

  const removePhoto = async (): Promise<void> => {
    if (!supply) return
    setImgBusy(true)
    try {
      const res = await api.supplies.removeImage(supply.id)
      if (res.ok) {
        setImageUrl(null)
        await onSaved()
      } else if (res.error) {
        toast.error(res.error)
      }
    } finally {
      setImgBusy(false)
    }
  }

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
    const perUnit = numOrNull(itemsPerUnit)
    if (perUnit != null && perUnit < 1) {
      setError('Items per unit must be at least 1.')
      return
    }
    const reorder = numOrNull(reorderPoint)
    if (reorder != null && reorder < 0) {
      setError('Reorder point must be 0 or more.')
      return
    }
    const cpu = numOrNull(costPerUnit)
    if (cpu != null && cpu < 0) {
      setError('Cost must be 0 or more.')
      return
    }
    const link = reorderUrl.trim()
    if (link && !/^https?:\/\//i.test(link)) {
      setError('Reorder link must start with http:// or https://')
      return
    }
    setError('')
    setBusy(true)
    const ipu = perUnit ?? 1
    // Store the per-item cost derived from the per-unit price they entered.
    const perItemCost = cpu != null ? cpu / ipu : 0
    try {
      let res
      if (isEdit) {
        res = await api.supplies.update({
          id: supply!.id,
          name: name.trim(),
          unit,
          unitCost: perItemCost,
          itemsPerUnit: ipu,
          reorderPoint: reorder ?? 0,
          recurring,
          notes: notes.trim() || null,
          reorderUrl: link || null
        })
      } else {
        res = await api.supplies.create({
          name: name.trim(),
          unit,
          unitCost: perItemCost,
          itemsPerUnit: ipu,
          reorderPoint: reorder ?? 0,
          recurring,
          notes: notes.trim() || null,
          reorderUrl: link || null
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

  const unitLabel = (UNIT_OPTIONS.find((u) => u.id === unit)?.label ?? 'unit').toLowerCase()
  const ipuNum = parseInt(itemsPerUnit || '1', 10) || 1
  const cpuNum = parseFloat(costPerUnit)
  const costHint =
    ipuNum > 1
      ? `Price for one ${unitLabel} of ${ipuNum}` +
        (Number.isFinite(cpuNum) && cpuNum > 0 ? ` · ≈ $${(cpuNum / ipuNum).toFixed(2)}/item` : '')
      : 'What you pay for one'

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

      {isEdit && (
        <div className="emp-avatar-row supply-photo-row">
          <div className="supply-photo">
            {imageUrl ? (
              <img src={imageUrl} alt="" />
            ) : (
              <Icon name="Package" size={26} />
            )}
          </div>
          <div className="emp-avatar-actions">
            <Button variant="secondary" size="sm" icon="ImagePlus" loading={imgBusy} onClick={changePhoto}>
              {imageUrl ? 'Change photo' : 'Add photo'}
            </Button>
            {imageUrl && (
              <Button variant="ghost" size="sm" icon="Trash2" disabled={imgBusy} onClick={removePhoto}>
                Remove
              </Button>
            )}
          </div>
        </div>
      )}

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
        <Field label="Items per unit" hint="How many come in one box/pack (default 1)">
          <Input
            type="number"
            min={1}
            step="1"
            value={itemsPerUnit}
            onChange={(e) => setItemsPerUnit(e.target.value)}
            placeholder="1"
          />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Cost per unit" hint={costHint}>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={costPerUnit}
            onChange={(e) => setCostPerUnit(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field label="Reorder at" hint="Flag low when on-hand items hit this (0 = off)">
          <Input
            type="number"
            min={0}
            step="1"
            value={reorderPoint}
            onChange={(e) => setReorderPoint(e.target.value)}
            placeholder="0"
          />
        </Field>
      </div>

      <div style={{ margin: '10px 0' }}>
        <Checkbox
          checked={recurring}
          onChange={setRecurring}
          label="Recurring — we reorder this on repeat"
        />
      </div>

      <Field label="Reorder link" hint="Paste the Amazon (or supplier) product URL to reorder in one click">
        <Input
          type="url"
          value={reorderUrl}
          onChange={(e) => setReorderUrl(e.target.value)}
          placeholder="https://www.amazon.com/…"
        />
      </Field>

      <Field label="Notes" hint="Optional">
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Amazon, 200-count box"
        />
      </Field>

      {!isEdit && (
        <p className="muted text-sm" style={{ marginTop: 4 }}>
          Set the price here, or leave it — logging a <strong>Buy</strong> also updates the cost from the
          order. Add stock and a photo once it&apos;s saved.
        </p>
      )}
    </Modal>
  )
}
