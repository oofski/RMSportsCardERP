import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { Freight } from '@shared/freight'
import { LOCATIONS } from '@shared/inventory'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { FreightFields } from '../../components/FreightFields'
import { POCatalogTypeahead } from './POCatalogTypeahead'

/** A working line in the create form — quantity/price kept as strings so the
 *  inputs stay controlled and empty-while-typing is allowed. */
interface DraftLine {
  productId: string
  productName: string
  sku: string
  category: string
  quantity: string
  unitPrice: string
}

/**
 * Build a purchase order from catalog line items: an optional supplier + notes
 * header, a typeahead to append products, and a per-line quantity / unit buy
 * price with a live running total. Saves via api.purchaseOrders.create — the new
 * PO lands in the Ordered column.
 */
export function CreatePurchaseOrderModal({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [supplier, setSupplier] = useState('')
  const [location, setLocation] = useState<string>(LOCATIONS[0].id)
  const [notes, setNotes] = useState('')
  const [freight, setFreight] = useState<Freight>({
    carrier: null,
    service: null,
    trackingNumber: null,
    paymentTiming: null
  })
  const [lines, setLines] = useState<DraftLine[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Append a catalog pick as a line (defaulting the price to its average cost).
  // If the product is already on the PO, just bump its quantity instead.
  const addLine = (p: InventoryProduct): void => {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === p.id)
      if (existing) {
        return prev.map((l) =>
          l.productId === p.id
            ? { ...l, quantity: String((parseInt(l.quantity, 10) || 0) + 1) }
            : l
        )
      }
      return [
        ...prev,
        {
          productId: p.id,
          productName: p.name,
          sku: p.sku,
          category: p.category,
          quantity: '1',
          unitPrice: p.unitCost ? String(p.unitCost) : ''
        }
      ]
    })
  }

  const patchLine = (productId: string, patch: Partial<DraftLine>): void => {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)))
  }

  const removeLine = (productId: string): void => {
    setLines((prev) => prev.filter((l) => l.productId !== productId))
  }

  const grandTotal = useMemo(
    () =>
      lines.reduce((sum, l) => {
        const qty = parseInt(l.quantity, 10) || 0
        const price = parseFloat(l.unitPrice) || 0
        return sum + qty * price
      }, 0),
    [lines]
  )

  const submit = async (): Promise<void> => {
    if (lines.length === 0) {
      setError('Add at least one line item.')
      return
    }
    for (const l of lines) {
      const qty = parseInt(l.quantity, 10)
      if (!Number.isInteger(qty) || qty < 1) {
        setError(`Quantity for ${l.productName} must be a whole number of at least 1.`)
        return
      }
      const price = parseFloat(l.unitPrice)
      if (l.unitPrice.trim() !== '' && (!Number.isFinite(price) || price < 0)) {
        setError(`Price for ${l.productName} must be 0 or more.`)
        return
      }
    }
    setError('')
    setBusy(true)
    try {
      const res = await api.purchaseOrders.create({
        supplier: supplier.trim() || null,
        location,
        notes: notes.trim() || null,
        ...freight,
        lines: lines.map((l) => ({
          productId: l.productId,
          quantity: parseInt(l.quantity, 10),
          unitPrice: parseFloat(l.unitPrice) || 0
        }))
      })
      if (!res.ok || !res.data) {
        setError(res.error ?? 'Could not create the purchase order.')
        return
      }
      toast.success(`Created ${res.data.poNumber}.`)
      await onSaved()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New purchase order"
      subtitle="Add catalog products with a buy price to open a new PO."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="ReceiptText"
            loading={busy}
            disabled={lines.length === 0}
            onClick={submit}
          >
            Create PO
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <div className="field-row">
        <Field label="Supplier" hint="Optional">
          <Input
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="e.g. Steel City Collectibles"
          />
        </Field>
        <Field label="Destination" hint="Where the cases land">
          <Select value={location} onChange={(e) => setLocation(e.target.value)}>
            {LOCATIONS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes" hint="Optional">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Net-30, split shipment"
          />
        </Field>
      </div>

      <FreightFields
        {...freight}
        hint="Who is bringing it"
        onChange={(patch) => setFreight((f) => ({ ...f, ...patch }))}
      />

      <POCatalogTypeahead onSelect={addLine} />

      {lines.length === 0 ? (
        <div className="po-lines-empty">No line items yet — search above to add products.</div>
      ) : (
        <div className="po-lines">
          <table className="data po-lines-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Line total</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const qty = parseInt(l.quantity, 10) || 0
                const price = parseFloat(l.unitPrice) || 0
                return (
                  <tr key={l.productId}>
                    <td>
                      <div className="po-line-name">{l.productName}</div>
                      <div className="po-line-sub">
                        <span className="mono">{l.sku}</span>
                        {l.category && <span> · {l.category}</span>}
                      </div>
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        value={l.quantity}
                        onChange={(e) => patchLine(l.productId, { quantity: e.target.value })}
                        className="po-qty-input"
                      />
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={l.unitPrice}
                        onChange={(e) => patchLine(l.productId, { unitPrice: e.target.value })}
                        placeholder="0.00"
                        className="po-price-input"
                      />
                    </td>
                    <td className="num mono">{formatMoney(qty * price)}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title="Remove line"
                        onClick={() => removeLine(l.productId)}
                      >
                        <Icon name="Trash2" size={15} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="po-total">
            <span>Grand total</span>
            <span className="mono">{formatMoney(grandTotal)}</span>
          </div>
        </div>
      )}
    </Modal>
  )
}
