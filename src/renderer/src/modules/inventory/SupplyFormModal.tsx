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
  const [reorderPoint, setReorderPoint] = useState(
    supply?.reorderPoint ? String(supply.reorderPoint) : ''
  )
  const [recurring, setRecurring] = useState(supply?.recurring ?? false)
  const [notes, setNotes] = useState(supply?.notes ?? '')
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
    setError('')
    setBusy(true)
    try {
      let res
      if (isEdit) {
        res = await api.supplies.update({
          id: supply!.id,
          name: name.trim(),
          unit,
          itemsPerUnit: perUnit ?? 1,
          reorderPoint: reorder ?? 0,
          recurring,
          notes: notes.trim() || null
        })
      } else {
        res = await api.supplies.create({
          name: name.trim(),
          unit,
          unitCost: 0,
          itemsPerUnit: perUnit ?? 1,
          reorderPoint: reorder ?? 0,
          recurring,
          notes: notes.trim() || null
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

      <div style={{ margin: '10px 0' }}>
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

      {!isEdit && (
        <p className="muted text-sm" style={{ marginTop: 4 }}>
          Add stock and its cost afterwards with <strong>Buy</strong> — you can also add a photo once
          it&apos;s saved.
        </p>
      )}
    </Modal>
  )
}
