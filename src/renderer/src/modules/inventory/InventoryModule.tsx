import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CategorySummary, InventoryProduct, InventoryStats } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader } from '../../components/ui'
import { InventoryOverview } from './InventoryOverview'
import { ProductsTab } from './ProductsTab'
import { SuppliesTab } from './SuppliesTab'
import { DailyPricingTab } from './DailyPricingTab'
import { ScanStation } from './ScanStation'
import { productMatches } from './helpers'

type TabId = 'overview' | 'products' | 'pricing' | 'supplies'

const EMPTY_STATS: InventoryStats = {
  totalValue: 0,
  totalCost: 0,
  spread: 0,
  outsideSpreadValue: 0,
  outsideSpreadCount: 0,
  boxes: 0,
  cases: 0,
  packs: 0,
  singles: 0,
  units: 0,
  skuCount: 0,
  lowStockCount: 0,
  salesRevenue: 0,
  salesCount: 0,
  unitsByLocation: {},
  zeroCost: [],
  layerGaps: []
}

export function InventoryModule(): JSX.Element {
  const { can } = useSession()
  const canManage = can('inventory.manage')
  const canPrice = can('inventory.pricing') || canManage

  const [products, setProducts] = useState<InventoryProduct[]>([])
  const [stats, setStats] = useState<InventoryStats>(EMPTY_STATS)
  const [categories, setCategories] = useState<CategorySummary[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [thumbVersion, setThumbVersion] = useState(0)
  // Bumped by every reload so panels holding their own data (the Incoming
  // panel's PO boxes) re-read too — scanning a PO's last line completes it, and
  // its box has to leave the panel without a manual refresh.
  const [dataVersion, setDataVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabId>('overview')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [scanning, setScanning] = useState(false)

  // Product/catalog data — refetched after edits (does NOT re-read images).
  const reload = useCallback(async () => {
    const [prods, st, cats] = await Promise.all([
      api.inventory.list(),
      api.inventory.stats(),
      api.inventory.categories()
    ])
    setProducts(prods)
    setStats(st ?? EMPTY_STATS)
    setCategories(cats)
    setDataVersion((v) => v + 1)
  }, [])

  // Thumbnails are comparatively expensive (base64), so load them on their own
  // cadence — only on mount and when an image is actually added/removed.
  // Stock, cost and the catalog all move under this screen while somebody is
  // reading it — a case received at the other bench changes what is on the shelf.
  useLiveRefresh(LIVE.inventory, reload)

  useEffect(() => {
    api.inventory.thumbnails().then(setThumbnails)
  }, [thumbVersion])

  const refreshThumbs = useCallback(() => setThumbVersion((v) => v + 1), [])

  useEffect(() => {
    ;(async () => {
      await reload()
      setLoading(false)
    })()
  }, [reload])

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'overview', label: 'Dashboard', icon: 'LayoutDashboard' },
    { id: 'products', label: 'Catalog', icon: 'Boxes' },
    ...(canPrice ? [{ id: 'pricing' as TabId, label: 'Pricing', icon: 'DollarSign' }] : []),
    { id: 'supplies', label: 'Supplies', icon: 'Package' }
  ]

  // Jump to the Catalog, optionally focused on a single product (clearing any
  // active category filter so the chosen product is never hidden).
  const goToCatalog = (p?: InventoryProduct): void => {
    if (p) {
      setQuery(p.name)
      setCategory('')
    }
    setTab('products')
  }

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow inv-shell">
      <div className="inv-header">
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={16} />
              {t.label}
            </button>
          ))}
        </div>
        <QuickSearch products={products} query={query} onQuery={setQuery} onGo={goToCatalog} />
        {canManage && (
          <Button variant="primary" icon="ScanBarcode" onClick={() => setScanning(true)}>
            Scan
          </Button>
        )}
      </div>

      <div className="inv-scroll">
        {tab === 'overview' && (
          <InventoryOverview
            stats={stats}
            categories={categories}
            // The dashboard's missing-identifier tile counts off this same
            // array, so it can never promise a number the Catalog does not hold.
            products={products}
            canManage={canManage}
            onChanged={reload}
            onScan={() => setScanning(true)}
            onOpenProduct={(name) => {
              setQuery(name)
              setCategory('')
              setTab('products')
            }}
            refreshKey={dataVersion}
          />
        )}
        {tab === 'products' && (
          <ProductsTab
            products={products}
            query={query}
            category={category}
            onCategory={setCategory}
            thumbnails={thumbnails}
            canManage={canManage}
            onChanged={reload}
            onImagesChanged={refreshThumbs}
          />
        )}
        {tab === 'pricing' && canPrice && <DailyPricingTab onChanged={reload} />}
        {tab === 'supplies' && <SuppliesTab canManage={canManage} />}
      </div>

      {scanning && (
        <ScanStation
          products={products}
          canManage={canManage}
          onClose={() => setScanning(false)}
          onChanged={reload}
        />
      )}
    </div>
  )
}

/**
 * Quick product finder in the Inventory header. Type to see matches across all
 * 122 products with their on-hand counts; pick one to jump straight to it in the
 * Catalog, or press Enter to open the Catalog filtered to what you typed.
 */
function QuickSearch({
  products,
  query,
  onQuery,
  onGo
}: {
  products: InventoryProduct[]
  query: string
  onQuery: (q: string) => void
  onGo: (p?: InventoryProduct) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  const matches = useMemo(() => {
    if (!query.trim()) return []
    return products.filter((p) => productMatches(p, query)).slice(0, 8)
  }, [products, query])

  return (
    <div className="inv-search">
      <div className="topsearch">
        <Icon name="Search" size={16} />
        <input
          placeholder="Quick search products…"
          value={query}
          onChange={(e) => {
            onQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setOpen(false)
              onGo()
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
        />
        {query && (
          <button className="ts-clear" title="Clear" onClick={() => onQuery('')}>
            <Icon name="X" size={14} />
          </button>
        )}
      </div>

      {open && query.trim() && (
        <>
          <div className="ta-backdrop" onClick={() => setOpen(false)} />
          <div className="ta-menu inv-search-menu">
            {matches.length === 0 ? (
              <div className="ta-empty">No products match “{query.trim()}”.</div>
            ) : (
              matches.map((p) => (
                <button
                  key={p.id}
                  className="ta-item"
                  onClick={() => {
                    setOpen(false)
                    onGo(p)
                  }}
                >
                  <span className="ta-name">{p.name}</span>
                  <span className="ta-sub">
                    {p.sku} · {p.category || 'Uncategorized'}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  )
}
