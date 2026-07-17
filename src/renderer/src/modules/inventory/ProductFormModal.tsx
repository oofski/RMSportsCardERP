import { useState } from 'react'
import type { InventoryProduct, UnitType } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select, Textarea } from '../../components/ui'
import { UNIT_TYPES } from './helpers'

function numOrNull(v: string): number | null {
  const n = parseFloat(v)
  return v.trim() === '' || Number.isNaN(n) ? null : n
}

export function ProductFormModal({
  product,
  onClose,
  onSaved
}: {
  product: InventoryProduct | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const isEdit = !!product
  const [form, setForm] = useState({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    category: product?.category ?? '',
    brand: product?.brand ?? '',
    setName: product?.setName ?? '',
    year: product?.year ?? '',
    unitType: (product?.unitType ?? 'box') as UnitType,
    quantity: String(product?.quantity ?? 0),
    unitCost: product ? String(product.unitCost) : '',
    salePrice: product?.salePrice != null ? String(product.salePrice) : '',
    boxesPerCase: product?.boxesPerCase != null ? String(product.boxesPerCase) : '',
    packsPerBox: product?.packsPerBox != null ? String(product.packsPerBox) : '',
    reorderPoint: String(product?.reorderPoint ?? 0),
    notes: product?.notes ?? ''
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>): void =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const payloadBase = {
        sku: form.sku,
        name: form.name,
        category: form.category,
        brand: form.brand,
        setName: form.setName,
        year: form.year,
        unitType: form.unitType,
        unitCost: numOrNull(form.unitCost) ?? 0,
        salePrice: numOrNull(form.salePrice),
        boxesPerCase: numOrNull(form.boxesPerCase),
        packsPerBox: numOrNull(form.packsPerBox),
        reorderPoint: numOrNull(form.reorderPoint) ?? 0,
        notes: form.notes.trim() || null
      }
      const res = isEdit
        ? await api.inventory.update({ id: product.id, ...payloadBase })
        : await api.inventory.create({ ...payloadBase, quantity: numOrNull(form.quantity) ?? 0 })
      if (!res.ok) {
        setError(res.error ?? 'Could not save the product.')
        return
      }
      toast.success(isEdit ? 'Product updated.' : `${form.name} added to inventory.`)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit product' : 'Add product'}
      subtitle={
        isEdit
          ? 'Update product details. Quantity changes through sales and restocks.'
          : 'Create an inventory product and set its opening stock.'
      }
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="primary" icon={isEdit ? 'Check' : 'PackagePlus'} loading={busy} onClick={submit}>
            {isEdit ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <div className="auth-alert">{error}</div>}

        <div className="field-row">
          <Field label="SKU">
            <Input value={form.sku} onChange={set('sku')} placeholder="e.g. TOPPS-CHR-2023-HB" required autoFocus />
          </Field>
          <Field label="Unit type">
            <Select value={form.unitType} onChange={set('unitType')}>
              {UNIT_TYPES.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Product name">
          <Input value={form.name} onChange={set('name')} placeholder="2023 Topps Chrome Baseball Hobby Box" required />
        </Field>

        <div className="field-row">
          <Field label="Category">
            <Input value={form.category} onChange={set('category')} placeholder="Baseball" />
          </Field>
          <Field label="Brand">
            <Input value={form.brand} onChange={set('brand')} placeholder="Topps" />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Set">
            <Input value={form.setName} onChange={set('setName')} placeholder="Chrome" />
          </Field>
          <Field label="Year">
            <Input value={form.year} onChange={set('year')} placeholder="2023" />
          </Field>
        </div>

        <div className="field-row">
          <Field label={isEdit ? 'Quantity (change via sales/restock)' : 'Opening quantity'}>
            <Input
              type="number"
              min={0}
              value={form.quantity}
              onChange={set('quantity')}
              disabled={isEdit}
            />
          </Field>
          <Field label="Unit cost" hint="What you paid per unit">
            <Input type="number" min={0} step="0.01" value={form.unitCost} onChange={set('unitCost')} placeholder="0.00" />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Default sale price" hint="Optional">
            <Input type="number" min={0} step="0.01" value={form.salePrice} onChange={set('salePrice')} placeholder="0.00" />
          </Field>
          <Field label="Low-stock alert at" hint="0 = off">
            <Input type="number" min={0} value={form.reorderPoint} onChange={set('reorderPoint')} />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Boxes per case" hint="Optional">
            <Input type="number" min={0} value={form.boxesPerCase} onChange={set('boxesPerCase')} placeholder="—" />
          </Field>
          <Field label="Packs per box" hint="Optional">
            <Input type="number" min={0} value={form.packsPerBox} onChange={set('packsPerBox')} placeholder="—" />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea value={form.notes} onChange={set('notes')} placeholder="Anything worth noting…" />
        </Field>

        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  )
}
