import { useEffect, useRef, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { api } from '../../lib/api'
import { Field, Input } from '../../components/ui'
import { structureLabel } from '../inventory/helpers'
import { CatalogEmpty } from '../inventory/CatalogEmpty'

/**
 * Debounced typeahead over the inventory catalog, cloned from the Inventory
 * IncomingModal's CatalogTypeahead but pointed at api.purchaseOrders.searchCatalog
 * so a module.invoicing-only user can find products without holding
 * module.inventory. Picking a match appends it as a PO line item.
 *
 * The wording is overridable because the pasted-offer review reuses this exact
 * control to attach a product to a line the parser could not place — the same
 * search, the same permission, the same result rows. Two typeaheads over one
 * catalog would be two things to keep in step and two ways to disagree about
 * what a product is; the labels are the only part that differs, so they are the
 * only part that is a prop. Every default below is the original text, so the
 * create form's own call site is unchanged.
 */
export function POCatalogTypeahead({
  onSelect,
  label = 'Add a product',
  hint = 'Search the catalog by name, SKU or UPC',
  placeholder = 'Start typing a product name, SKU or UPC…',
  initialQuery = ''
}: {
  onSelect: (p: InventoryProduct) => void
  label?: string
  hint?: string
  placeholder?: string
  /** Pre-fill, so a row can open its search already asking for its own words. */
  initialQuery?: string
}): JSX.Element {
  const [query, setQuery] = useState(initialQuery)
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
      <Field label={label} hint={hint}>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder} />
      </Field>
      {query.trim().length >= 2 && (
        <div className="ta-menu">
          {loading && results.length === 0 ? (
            <div className="ta-empty">Searching…</div>
          ) : results.length === 0 ? (
            /**
             * The dead end, with a way out of it.
             *
             * A product that is not in the catalog used to end the line here:
             * leave the order, open Inventory, add it, come back, and retype
             * what you had already typed. See CatalogEmpty — the same escape
             * hatch answers all three of this app's catalog searches.
             */
            <CatalogEmpty
              query={query}
              onCreated={(p) => {
                onSelect(p)
                setQuery('')
                setResults([])
              }}
            />
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
