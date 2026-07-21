import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { LOCATIONS, type Location } from '@shared/inventory'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { formatMoney } from '../../lib/format'

export function RecordSaleModal({
  products,
  presetProductId,
  onClose,
  onSaved
}: {
  products: InventoryProduct[]
  presetProductId?: string
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const sellable = useMemo(() => products.filter((p) => p.quantity > 0), [products])
  const [productId, setProductId] = useState(presetProductId ?? sellable[0]?.id ?? '')
  const selected = products.find((p) => p.id === productId) ?? null

  // Default to a location that actually has stock.
  const firstStocked = (p: InventoryProduct | null): Location =>
    (LOCATIONS.find((l) => (p?.quantityByLocation[l.id] ?? 0) > 0)?.id ?? 'RM') as Location

  const [location, setLocation] = useState<Location>(firstStocked(selected))
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState(selected?.salePrice != null ? String(selected.salePrice) : '')
  const [client, setClient] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const onProductChange = (id: string): void => {
    setProductId(id)
    const p = products.find((x) => x.id === id) ?? null
    setUnitPrice(p?.salePrice != null ? String(p.salePrice) : '')
    setLocation(firstStocked(p))
  }

  const available = selected?.quantityByLocation[location] ?? 0
  const qtyNum = parseInt(quantity, 10)
  const priceNum = parseFloat(unitPrice)
  const total = Number.isFinite(qtyNum) && Number.isFinite(priceNum) ? qtyNum * priceNum : 0

  const submit = async (): Promise<void> => {
    setError('')
    if (!productId) {
      setError('Select a product.')
      return
    }
    setBusy(true)
    try {
      const res = await api.inventory.recordSale({
        productId,
        location,
        quantity: qtyNum,
        unitPrice: priceNum,
        client,
        note: note.trim() || null
      })
      if (!res.ok) {
        setError(res.error ?? 'Could not record the sale.')
        return
      }
      toast.success(`Sold ${qtyNum} × ${selected?.name ?? 'item'} to ${client}.`)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Record a sale"
      subtitle="Selling reduces stock at the chosen location and logs it to your sales ledger."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="ShoppingCart" loading={busy} onClick={submit} disabled={!selected}>
            Record sale · {formatMoney(total)}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      {sellable.length === 0 ? (
        <p className="muted">Nothing in stock to sell yet. Add stock first.</p>
      ) : (
        <>
          <Field label="Product">
            <Select value={productId} onChange={(e) => onProductChange(e.target.value)}>
              {products.map((p) => (
                <option key={p.id} value={p.id} disabled={p.quantity <= 0}>
                  {p.name} · {p.sku} ({p.quantity} on hand)
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sell from">
            <div className="loc-pills">
              {LOCATIONS.map((l) => {
                const have = selected?.quantityByLocation[l.id] ?? 0
                return (
                  <button
                    key={l.id}
                    type="button"
                    className={`loc-pill ${location === l.id ? 'active' : ''}`}
                    onClick={() => setLocation(l.id)}
                  >
                    {l.label}
                    <div className="lp-sub">{have} on hand</div>
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="field-row">
            <Field label="Quantity" hint={`${available} available in ${location}`}>
              <Input type="number" min={1} max={available} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </Field>
            <Field label="Sale price (each)">
              <Input type="number" min={0} step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.00" />
            </Field>
          </div>

          <Field label="Client">
            <Input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Buyer name" required />
          </Field>
          <Field label="Note" hint="Optional">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. eBay order #1234" />
          </Field>
        </>
      )}
    </Modal>
  )
}
