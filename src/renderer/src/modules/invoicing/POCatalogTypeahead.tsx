import { useEffect, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { api } from '../../lib/api'
import { Field, Input } from '../../components/ui'
import { structureLabel } from '../inventory/helpers'

/**
 * Debounced typeahead over the inventory catalog, cloned from the Inventory
 * IncomingModal's CatalogTypeahead but pointed at api.purchaseOrders.searchCatalog
 * so a module.invoicing-only user can find products without holding
 * module.inventory. Picking a match appends it as a PO line item.
 */
export function POCatalogTypeahead({
  onSelect
}: {
  onSelect: (p: InventoryProduct) => void
}): JSX.Element {
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
      const r = await api.purchaseOrders.searchCatalog(query)
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
      <Field label="Add a product" hint="Search the catalog by name, SKU or UPC">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Start typing a product name, SKU or UPC…"
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
              <button
                type="button"
                key={p.id}
                className="ta-item"
                onClick={() => {
                  onSelect(p)
                  setQuery('')
                  setResults([])
                }}
              >
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
