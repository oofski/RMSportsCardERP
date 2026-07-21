import { useEffect, useMemo, useState } from 'react'
import type {
  CategorySummary,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  SalesPoint
} from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS } from '@shared/inventory'
import { AreaChart } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/format'
import { UnitBadge } from './helpers'
import { RecordSaleModal } from './RecordSaleModal'

export function InventoryOverview({
  stats,
  categories,
  series,
  recentSales,
  products,
  canManage,
  onChanged
}: {
  stats: InventoryStats
  categories: CategorySummary[]
  series: SalesPoint[]
  recentSales: InventoryTransaction[]
  products: InventoryProduct[]
  canManage: boolean
  onChanged: () => Promise<void>
}): JSX.Element {
  const [saleOpen, setSaleOpen] = useState(false)
  const [drill, setDrill] = useState<string | null>(null)
  const hasSales = series.some((s) => s.revenue > 0)

  // Order categories by the preferred order, then any extras alphabetically.
  const orderedCategories = useMemo(() => {
    const rank = (c: string): number => {
      const i = CATEGORY_ORDER.indexOf(c)
      return i === -1 ? CATEGORY_ORDER.length : i
    }
    return [...categories].sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category))
  }, [categories])

  if (drill) {
    return <CategoryDrilldown category={drill} onBack={() => setDrill(null)} />
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Inventory overview</h2>
          <p>Cases and boxes on hand across RM and AM.</p>
        </div>
        {canManage && products.length > 0 && (
          <Button variant="primary" icon="ShoppingCart" onClick={() => setSaleOpen(true)}>
            Record sale
          </Button>
        )}
      </div>

      <div className="stat-grid">
        <Stat icon="DollarSign" value={formatMoney(stats.totalValue, { compact: true })} label="Inventory value" />
        <Stat icon="Boxes" value={String(stats.cases)} label="Cases on hand" />
        <Stat icon="Package" value={String(stats.boxes)} label="Boxes on hand" />
        <Stat icon="Tag" value={String(stats.skuCount)} label="Products (SKUs)" />
      </div>

      {stats.lowStockCount > 0 && (
        <div className="lowstock-banner">
          <Icon name="AlertTriangle" size={17} />
          {stats.lowStockCount} product{stats.lowStockCount === 1 ? '' : 's'} at or below the low-stock threshold.
        </div>
      )}

      <div className="section-head">
        <div>
          <h2>By category</h2>
          <p>Click a category to see the full breakdown. Cases shown; boxes below.</p>
        </div>
        <div className="muted text-sm">
          {LOCATIONS.map((l) => `${l.label}: ${stats.unitsByLocation[l.id] ?? 0}`).join('  ·  ')} units
        </div>
      </div>

      {orderedCategories.length === 0 ? (
        <EmptyState icon="Boxes" title="No inventory yet" message="Add products and stock to see category totals." />
      ) : (
        <div className="cat-grid">
          {orderedCategories.map((c) => (
            <button key={c.category} className="cat-card" onClick={() => setDrill(c.category)}>
              <div className="cc-head">
                <span className="cc-ico">
                  <Icon name="Boxes" size={18} />
                </span>
                <span className="cc-name">{c.category}</span>
              </div>
              <div className="cc-cases">
                {c.cases} <small>{c.cases === 1 ? 'case' : 'cases'}</small>
              </div>
              <div className="cc-sub">
                <span>{c.boxes} boxes</span>
                <span>{c.productCount} products</span>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="dash-grid">
        <div className="dash-col">
          <div className="panel-card">
            <div className="panel-head">
              <div>
                <h3>Sales</h3>
                <span className="ph-sub">Last 14 days</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{formatMoney(stats.salesRevenue)}</div>
                <div className="ph-sub">
                  {stats.salesCount} sale{stats.salesCount === 1 ? '' : 's'} all-time
                </div>
              </div>
            </div>
            {hasSales ? (
              <AreaChart series={[{ points: series.map((s) => s.revenue), color: 'var(--chart-green)', fill: true }]} labels={series.map((s) => s.label)} height={190} />
            ) : (
              <div className="chart-empty">
                <Icon name="TrendingUp" size={26} />
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>No sales in the last 14 days</div>
                  <div className="text-sm">Record a sale and it'll chart here.</div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dash-col">
          <div className="panel-card">
            <div className="panel-head">
              <h3>Recent sales</h3>
            </div>
            {recentSales.length === 0 ? (
              <p className="muted text-sm">No sales yet.</p>
            ) : (
              <div className="metric-list">
                {recentSales.slice(0, 6).map((t) => (
                  <div className="metric-row" key={t.id}>
                    <span className="m-k" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{t.productName}</span>
                      <span className="text-sm muted">
                        {Math.abs(t.quantityChange)} · {t.counterparty || '—'} · {t.location ?? '—'}
                      </span>
                    </span>
                    <span className="m-v">{formatMoney(Math.abs(t.quantityChange) * (t.unitPrice ?? 0))}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {saleOpen && (
        <RecordSaleModal
          products={products}
          onClose={() => setSaleOpen(false)}
          onSaved={async () => {
            setSaleOpen(false)
            await onChanged()
          }}
        />
      )}
    </>
  )
}

function Stat({ icon, value, label }: { icon: string; value: string; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name={icon} size={21} />
      </div>
      <div>
        <div className="stat-val">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}

function CategoryDrilldown({ category, onBack }: { category: string; onBack: () => void }): JSX.Element {
  const [rows, setRows] = useState<InventoryProduct[] | null>(null)

  useEffect(() => {
    let active = true
    api.inventory.byCategory(category).then((r) => {
      if (active) setRows(r)
    })
    return () => {
      active = false
    }
  }, [category])

  if (rows === null) return <CenterLoader />

  const inStock = rows.filter((r) => r.quantity > 0)

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 12 }}>
          <Button variant="ghost" size="sm" icon="ArrowLeft" onClick={onBack}>
            Back
          </Button>
          <div>
            <h2>{category}</h2>
            <p>
              {inStock.length} in stock · {rows.length} products in catalog
            </p>
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Product</th>
              <th>Structure</th>
              {LOCATIONS.map((l) => (
                <th key={l.id} style={{ textAlign: 'center' }}>
                  {l.label}
                </th>
              ))}
              <th>Total</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} style={{ opacity: p.quantity > 0 ? 1 : 0.55 }}>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div className="p-sub mono">{p.sku}</div>
                </td>
                <td>
                  <UnitBadge unit={p.unitType} />
                  {p.unitType === 'case' && p.boxesPerCase ? (
                    <span className="muted text-sm"> {p.boxesPerCase}/case</span>
                  ) : null}
                </td>
                {LOCATIONS.map((l) => (
                  <td key={l.id} style={{ textAlign: 'center' }} className="mono">
                    {p.quantityByLocation[l.id] ?? 0}
                  </td>
                ))}
                <td style={{ fontWeight: 700 }}>{p.quantity}</td>
                <td className="money">{formatMoney(p.quantity * p.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
