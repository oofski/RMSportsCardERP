import { useEffect, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { StreamItemKind, StreamSessionDetail } from '@shared/streaming'
import { LOCATIONS, type Location } from '@shared/inventory'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Field, Input } from '../../components/ui'
import { structureLabel } from '../inventory/helpers'
import { resultError, streaming } from './api'

/**
 * Record a break or a giveaway.
 *
 * Both are the same operation against inventory — pull N units out of a
 * location at their real FIFO cost — so they share this form and differ only in
 * the one field that says what the cost was FOR. The line that matters most is
 * the last one before the button: adding this TAKES STOCK. That is not a
 * side effect the operator should discover from the inventory screen later.
 */
export function AddItemForm({
  sessionId,
  kind,
  canSearchCatalog,
  onAdded,
  onCancel
}: {
  sessionId: string
  kind: StreamItemKind
  /** The catalog search lives behind the Inventory module's permission. */
  canSearchCatalog: boolean
  onAdded: (detail: StreamSessionDetail) => void
  onCancel: () => void
}): JSX.Element {
  const toast = useToast()
  const [product, setProduct] = useState<InventoryProduct | null>(null)
  const [location, setLocation] = useState<Location>('RM')
  const [quantity, setQuantity] = useState('1')
  const [breakNumber, setBreakNumber] = useState('')
  const [recipient, setRecipient] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const qty = Number.parseInt(quantity, 10)
  const onHand = product ? (product.quantityByLocation[location] ?? 0) : 0
  const short = product && Number.isFinite(qty) && qty > onHand

  const choose = (p: InventoryProduct): void => {
    setProduct(p)
    // Land on a location that can actually cover it, so the common case needs
    // no second decision.
    const best = LOCATIONS.find((l) => (p.quantityByLocation[l.id] ?? 0) > 0)?.id ?? 'RM'
    setLocation(best)
  }

  const submit = async (): Promise<void> => {
    if (!product) {
      setError('Pick a product first.')
      return
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Quantity must be at least 1.')
      return
    }
    const num = breakNumber.trim() === '' ? null : Number.parseInt(breakNumber, 10)
    if (num !== null && (!Number.isFinite(num) || num <= 0)) {
      setError('Break number must be a whole number.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const res = await streaming.addItem({
        sessionId,
        kind,
        productId: product.id,
        quantity: qty,
        location,
        breakNumber: kind === 'break' ? num : null,
        recipient: kind === 'giveaway' ? recipient.trim() || null : null,
        note: note.trim() || null
      })
      if (!res.ok || !res.data) {
        setError(resultError(res, 'Could not record that.'))
        return
      }
      toast.success(`${qty} × ${product.name} out of ${location}.`)
      onAdded(res.data)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`stm-additem ${kind}`}>
      {error && <div className="auth-alert">{error}</div>}

      {!product ? (
        canSearchCatalog ? (
          <ProductTypeahead onSelect={choose} />
        ) : (
          <div className="stm-inline-note warn">
            <Icon name="ShieldCheck" size={14} />
            Searching the catalog needs Inventory access. Ask an admin to grant it before recording{' '}
            {kind === 'break' ? 'breaks' : 'giveaways'}.
          </div>
        )
      ) : (
        <>
          <div className="selected-product">
            <div>
              <div className="sp-name">{product.name}</div>
              <div className="sp-meta">
                <span className="mono">{product.sku}</span>
                {product.category && <span>{product.category}</span>}
                <span>{structureLabel(product)}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setProduct(null)}
            >
              Change
            </button>
          </div>

          <Field label="Take it out of">
            <div className="loc-pills">
              {LOCATIONS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={`loc-pill ${location === l.id ? 'active' : ''}`}
                  onClick={() => setLocation(l.id)}
                >
                  {l.label}
                  <div className="lp-sub">{product.quantityByLocation[l.id] ?? 0} on hand</div>
                </button>
              ))}
            </div>
          </Field>

          <div className="stm-form-row">
            <Field
              label="Quantity"
              error={short ? `${location} has only ${onHand} on hand.` : undefined}
            >
              <Input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                autoFocus
              />
            </Field>
            {kind === 'break' ? (
              <Field label="Break number" hint="Matches “Break #N” on Whatnot — optional">
                <Input
                  type="number"
                  min={1}
                  value={breakNumber}
                  onChange={(e) => setBreakNumber(e.target.value)}
                  placeholder="e.g. 4"
                />
              </Field>
            ) : (
              <Field label="Recipient" hint="Optional">
                <Input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Whatnot username"
                />
              </Field>
            )}
            <Field label="Note" hint="Optional">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything worth recording"
              />
            </Field>
          </div>

          <div className="stm-consume">
            <Icon name="PackageMinus" size={15} />
            <span>
              This takes <b>{Number.isFinite(qty) && qty > 0 ? qty : 0}</b>{' '}
              {Number.isFinite(qty) && qty === 1 ? 'unit' : 'units'} of <b>{product.name}</b> out of{' '}
              <b>{location}</b> at their FIFO cost. Removing the line later puts them back.
            </span>
          </div>
        </>
      )}

      <div className="stm-additem-acts">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={kind === 'break' ? 'Layers' : 'Gift'}
          loading={busy}
          disabled={!product}
          onClick={() => void submit()}
        >
          {kind === 'break' ? 'Record break' : 'Record giveaway'}
        </Button>
      </div>
    </div>
  )
}

/**
 * The catalog typeahead, same debounce and same read as Inventory's — a second
 * search implementation would be a second set of matching rules to keep in step.
 */
function ProductTypeahead({ onSelect }: { onSelect: (p: InventoryProduct) => void }): JSX.Element {
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
      <Field label="Product" hint="Search the catalog by name, SKU or UPC">
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
                  {p.sku} · {p.category || 'Uncategorized'} · {structureLabel(p)} · {p.quantity} on
                  hand
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
