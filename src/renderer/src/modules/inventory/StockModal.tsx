import { useEffect, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { LOCATIONS, type Location } from '@shared/inventory'
import { api } from '../../lib/api'
import { formatUnitCount } from '../../lib/productUnits'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'
import { structureLabel } from './helpers'
import { useLotPicker } from './LotPicker'

/**
 * The fast "add stock" flow: type a name → pick from the catalog → it
 * autopopulates → choose RM/AM → enter quantity → save. Also supports
 * corrections (adjust) once a product is chosen.
 */
export function StockModal({
  presetProduct,
  onClose,
  onSaved
}: {
  presetProduct?: InventoryProduct | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  // Only the DOWNWARD half of "adjust" consumes anything, so this is only ever
  // asked there. An upward correction opens a layer rather than taking one.
  const { picker, askAllocation } = useLotPicker()
  const [selected, setSelected] = useState<InventoryProduct | null>(presetProduct ?? null)
  const [mode, setMode] = useState<'add' | 'adjust'>('add')
  const [location, setLocation] = useState<Location>('RM')
  const [quantity, setQuantity] = useState('1')
  const [unitCost, setUnitCost] = useState('')
  /** Who a RECEIPT was bought from. Stamped on the cost layer it opens, so the
   *  picker can later say which case is which — see lotLabel. */
  const [vendor, setVendor] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const choose = (p: InventoryProduct): void => {
    setSelected(p)
    setUnitCost(p.unitCost ? String(p.unitCost) : '')
  }

  const submit = async (): Promise<void> => {
    if (!selected) {
      setError('Choose a product first.')
      return
    }
    setError('')
    const qty = parseInt(quantity, 10)
    if (!Number.isFinite(qty) || qty === 0) {
      setError('Enter a non-zero quantity.')
      return
    }
    if (mode === 'add' && qty < 0) {
      setError('Quantity must be positive when adding stock.')
      return
    }
    setBusy(true)
    try {
      let res
      if (mode === 'add') {
        const cost = unitCost.trim() === '' ? null : parseFloat(unitCost)
        if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
          setError('Enter a valid unit cost.')
          return
        }
        res = await api.inventory.addStock({
          productId: selected.id,
          location,
          quantity: qty,
          unitCost: cost,
          note: note.trim() || null,
          vendor: vendor.trim() || null
        })
      } else {
        // Only a correction DOWN takes cost layers, and only then is there
        // anything to ask about. A cancel abandons the correction rather than
        // letting oldest-first run behind the operator's back.
        let allocation: Awaited<ReturnType<typeof askAllocation>> = { allocation: null }
        if (qty < 0) {
          allocation = await askAllocation({
            productId: selected.id,
            location,
            quantity: -qty,
            productName: selected.name
          })
          if (!allocation) return
        }
        res = await api.inventory.adjustStock({
          productId: selected.id,
          location,
          quantityChange: qty,
          note: note.trim() || null,
          allocation: allocation.allocation
        })
      }
      if (!res.ok) {
        setError(res.error ?? 'Could not update stock.')
        return
      }
      toast.success(mode === 'add' ? `Added ${qty} to ${location}.` : `Adjusted ${location}.`)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Modal
        title={presetProduct ? 'Update stock' : 'Add stock'}
        subtitle={presetProduct ? presetProduct.name : undefined}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="PackagePlus" loading={busy} onClick={submit} disabled={!selected}>
              {mode === 'add' ? `Add to ${location}` : `Adjust ${location}`}
            </Button>
          </>
        }
      >
        {error && <div className="auth-alert">{error}</div>}

        {!selected ? (
          <CatalogTypeahead onSelect={choose} />
        ) : (
          <>
            <div className="selected-product">
              <div>
                <div className="sp-name">{selected.name}</div>
                <div className="sp-meta">
                  <span className="mono">{selected.sku}</span>
                  {selected.upc && <span className="mono">{selected.upc}</span>}
                  {selected.category && <span>{selected.category}</span>}
                  <span>{structureLabel(selected)}</span>
                </div>
              </div>
              {!presetProduct && (
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>
                  Change
                </button>
              )}
            </div>

            <Field label="Location">
              <div className="loc-pills">
                {LOCATIONS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className={`loc-pill ${location === l.id ? 'active' : ''}`}
                    onClick={() => setLocation(l.id)}
                  >
                    {l.label}
                    <div className="lp-sub">{formatUnitCount(selected.quantityByLocation[l.id] ?? 0)} on hand</div>
                  </button>
                ))}
              </div>
            </Field>

            <div className="field-row">
              <Field label="Mode">
                <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'add' | 'adjust')}>
                  <option value="add">Add received stock</option>
                  <option value="adjust">Adjust / correct (+/−)</option>
                </select>
              </Field>
              <Field label={mode === 'add' ? 'Quantity' : 'Change (use − to reduce)'}>
                <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
              </Field>
            </div>

            {mode === 'add' && (
              <div className="field-row">
                <Field label="Unit cost" hint="Per unit — also updates the product cost.">
                  <Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="0.00" />
                </Field>
                {/* Optional, and left blank rather than guessed at. It rides onto
                    the cost layer this receipt opens: when the same product is
                    later held at two prices, this is what tells the operator which
                    case is which — a picker showing "$1,400" and "$1,600" and
                    nothing else is a coin toss. */}
                <Field label="Vendor" hint="Optional — who it was bought from.">
                  <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Supplier name" />
                </Field>
              </div>
            )}
            <Field label="Note" hint="Optional">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. New case from vendor" />
            </Field>
          </>
        )}
      </Modal>
      {/* After the modal, so it stacks above it — the two overlays share a
          z-index and DOM order is what decides. */}
      {picker}
    </>
  )
}

function CatalogTypeahead({ onSelect }: { onSelect: (p: InventoryProduct) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<InventoryProduct[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([])
      return
    }
    let cancelled = false
    setLoading(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      const r = await api.inventory.search(query)
      if (!cancelled) {
        setResults(r)
        setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [query])

  return (
    <div className="typeahead">
      <Field label="Product">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing a product name, SKU or UPC…"
          autoFocus
        />
      </Field>
      {query.trim().length >= 2 && (
        <div className="ta-menu">
          {loading && results.length === 0 ? (
            <div className="ta-empty">Searching…</div>
          ) : results.length === 0 ? (
            <div className="ta-empty">
              No match. Add it as a new product from the catalog.
            </div>
          ) : (
            results.map((p) => (
              <button key={p.id} className="ta-item" onClick={() => onSelect(p)}>
                <span className="ta-name">{p.name}</span>
                <span className="ta-sub">
                  {p.sku} · {p.category || 'Uncategorized'} · {structureLabel(p)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
