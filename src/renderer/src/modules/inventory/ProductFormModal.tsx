import { useState } from 'react'
import type { InventoryProduct, UnitType } from '@shared/types'
import { LOCATIONS, type Location } from '@shared/inventory'
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
    upc: product?.upc ?? '',
    name: product?.name ?? '',
    category: product?.category ?? '',
    brand: product?.brand ?? '',
    setName: product?.setName ?? '',
    year: product?.year ?? '',
    unitType: (product?.unitType ?? 'box') as UnitType,
    boxesPerCase: product?.boxesPerCase != null ? String(product.boxesPerCase) : '',
    packsPerBox: product?.packsPerBox != null ? String(product.packsPerBox) : '',
    unitCost: product ? String(product.unitCost) : '',
    highBid: product?.highBid != null ? String(product.highBid) : '',
    salePrice: product?.salePrice != null ? String(product.salePrice) : '',
    reorderPoint: String(product?.reorderPoint ?? 0),
    notes: product?.notes ?? '',
    openingQuantity: '',
    openingLocation: 'RM' as Location
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
      const base = {
        sku: form.sku,
        upc: form.upc.trim() || null,
        name: form.name,
        category: form.category,
        brand: form.brand,
        setName: form.setName,
        year: form.year,
        unitType: form.unitType,
        boxesPerCase: numOrNull(form.boxesPerCase),
        packsPerBox: numOrNull(form.packsPerBox),
        unitCost: numOrNull(form.unitCost) ?? 0,
        highBid: numOrNull(form.highBid),
        salePrice: numOrNull(form.salePrice),
        reorderPoint: numOrNull(form.reorderPoint) ?? 0,
        notes: form.notes.trim() || null
      }
      const res = isEdit
        ? await api.inventory.update({ id: product.id, ...base })
        : await api.inventory.create({
            ...base,
            openingQuantity: numOrNull(form.openingQuantity) ?? 0,
            openingLocation: form.openingLocation
          })
      if (!res.ok) {
        setError(res.error ?? 'Could not save the product.')
        return
      }
      toast.success(isEdit ? 'Product updated.' : `${form.name} added to the catalog.`)
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
          ? 'Update catalog details. Stock changes through Add stock and sales.'
          : 'Add a product to the catalog (with optional opening stock).'
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

        <Field label="Product name">
          <Input value={form.name} onChange={set('name')} placeholder="2026 Bowman Baseball Hobby 12-Box Case" required autoFocus />
        </Field>

        <div className="field-row">
          <Field label="SKU" hint="Short code — can repeat (e.g. BOX)">
            <Input value={form.sku} onChange={set('sku')} placeholder="6578" />
          </Field>
          <Field label="UPC" hint="Barcode — unique">
            <Input value={form.upc} onChange={set('upc')} placeholder="887521158126" />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Category">
            <Input value={form.category} onChange={set('category')} placeholder="Baseball" />
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

        <div className="field-row">
          <Field label="Brand">
            <Input value={form.brand} onChange={set('brand')} placeholder="Bowman" />
          </Field>
          <Field label="Year">
            <Input value={form.year} onChange={set('year')} placeholder="2026" />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Boxes per case" hint="e.g. 12">
            <Input type="number" min={0} value={form.boxesPerCase} onChange={set('boxesPerCase')} placeholder="—" />
          </Field>
          <Field label="Packs per box" hint="Optional">
            <Input type="number" min={0} value={form.packsPerBox} onChange={set('packsPerBox')} placeholder="—" />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Average cost" hint="Average cost per unit">
            <Input type="number" min={0} step="0.01" value={form.unitCost} onChange={set('unitCost')} placeholder="0.00" />
          </Field>
          <Field label="High bid" hint="Current top bid / market value per unit">
            <Input type="number" min={0} step="0.01" value={form.highBid} onChange={set('highBid')} placeholder="0.00" />
          </Field>
        </div>

        <Field label="Default sale price" hint="Optional">
          <Input type="number" min={0} step="0.01" value={form.salePrice} onChange={set('salePrice')} placeholder="0.00" />
        </Field>

        {!isEdit && (
          <div className="field-row">
            <Field label="Opening quantity" hint="Optional — stock on hand now">
              <Input type="number" min={0} value={form.openingQuantity} onChange={set('openingQuantity')} placeholder="0" />
            </Field>
            <Field label="Opening location">
              <Select value={form.openingLocation} onChange={set('openingLocation')}>
                {LOCATIONS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}

        <Field label="Low-stock alert at" hint="0 = off">
          <Input type="number" min={0} value={form.reorderPoint} onChange={set('reorderPoint')} />
        </Field>

        <Field label="Notes">
          <Textarea value={form.notes} onChange={set('notes')} placeholder="Anything worth noting…" />
        </Field>

        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  )
}
