import { useEffect, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { LOCATIONS, type Location } from '@shared/inventory'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal } from '../../components/ui'
import { structureLabel } from './helpers'

/**
 * Log an expected shipment of stock. Pick a catalog product, choose where it's
 * headed and how many are coming, then it shows up on the dashboard's "Incoming"
 * panel until someone receives it (which folds it into on-hand stock).
 */
export function IncomingModal({
  onClose,
  onSaved
}: {
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [selected, setSelected] = useState<InventoryProduct | null>(null)
  const [location, setLocation] = useState<Location>('RM')
  const [quantity, setQuantity] = useState('1')
  const [expectedDate, setExpectedDate] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [reference, setReference] = useState('')
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
    const qty = parseInt(quantity, 10)
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be at least 1.')
      return
    }
    const cost = unitCost.trim() === '' ? null : parseFloat(unitCost)
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
      setError('Enter a valid unit cost.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const res = await api.inventory.addIncoming({
        productId: selected.id,
        location,
        quantity: qty,
        unitCost: cost,
        expectedDate: expectedDate || null,
        reference: reference.trim() || null,
        note: note.trim() || null
      })
      if (!res.ok) {
        setError(res.error ?? 'Could not log the shipment.')
        return
      }
      toast.success(`Logged ${qty} incoming to ${location}.`)
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Log incoming shipment"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Truck" loading={busy} onClick={submit} disabled={!selected}>
            Log incoming
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
                {selected.category && <span>{selected.category}</span>}
                <span>{structureLabel(selected)}</span>
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>
              Change
            </button>
          </div>

          <Field label="Destination">
            <div className="loc-pills">
              {LOCATIONS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`loc-pill ${location === l.id ? 'active' : ''}`}
                  onClick={() => setLocation(l.id)}
                >
                  {l.label}
                  <div className="lp-sub">{selected.quantityByLocation[l.id] ?? 0} on hand</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="field-row">
            <Field label="Quantity coming in">
              <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} autoFocus />
            </Field>
            <Field label="Expected date" hint="Optional">
              <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </Field>
          </div>

          <div className="field-row">
            <Field label="Unit cost" hint="Optional — rolls into average cost on receive">
              <Input type="number" min={0} step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Reference" hint="Optional">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PO / vendor / tracking" />
            </Field>
          </div>

          <Field label="Note" hint="Optional">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Split shipment, arriving Fri" />
          </Field>
        </>
      )}
    </Modal>
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
            <div className="ta-empty">No match in the catalog.</div>
          ) : (
            results.map((p) => (
              <button type="button" key={p.id} className="ta-item" onClick={() => onSelect(p)}>
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
