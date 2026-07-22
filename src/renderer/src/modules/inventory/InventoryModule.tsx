import { useCallback, useEffect, useState } from 'react'
import type { CategorySummary, InventoryProduct, InventoryStats } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader } from '../../components/ui'
import { InventoryOverview } from './InventoryOverview'
import { ProductsTab } from './ProductsTab'
import { ActivityTab } from './ActivityTab'

type TabId = 'overview' | 'products' | 'activity'

const EMPTY_STATS: InventoryStats = {
  totalValue: 0,
  totalCost: 0,
  spread: 0,
  boxes: 0,
  cases: 0,
  packs: 0,
  singles: 0,
  units: 0,
  skuCount: 0,
  lowStockCount: 0,
  salesRevenue: 0,
  salesCount: 0,
  unitsByLocation: {}
}

export function InventoryModule(): JSX.Element {
  const { can } = useSession()
  const canManage = can('inventory.manage')

  const [products, setProducts] = useState<InventoryProduct[]>([])
  const [stats, setStats] = useState<InventoryStats>(EMPTY_STATS)
  const [categories, setCategories] = useState<CategorySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabId>('overview')

  const reload = useCallback(async () => {
    const [prods, st, cats] = await Promise.all([
      api.inventory.list(),
      api.inventory.stats(),
      api.inventory.categories()
    ])
    setProducts(prods)
    setStats(st ?? EMPTY_STATS)
    setCategories(cats)
  }, [])

  useEffect(() => {
    ;(async () => {
      await reload()
      setLoading(false)
    })()
  }, [reload])

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'overview', label: 'Dashboard', icon: 'LayoutDashboard' },
    { id: 'products', label: 'Catalog', icon: 'Boxes' },
    { id: 'activity', label: 'Activity', icon: 'Layers' }
  ]

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow">
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

      {tab === 'overview' && <InventoryOverview stats={stats} categories={categories} />}
      {tab === 'products' && (
        <ProductsTab products={products} canManage={canManage} onChanged={reload} />
      )}
      {tab === 'activity' && <ActivityTab />}
    </div>
  )
}
