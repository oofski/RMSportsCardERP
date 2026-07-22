import { useEffect, useMemo, useState } from 'react'
import type { CategorySummary, InventoryProduct, InventoryStats } from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS } from '@shared/inventory'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/format'
import { UnitBadge, productMetrics } from './helpers'

export function InventoryOverview({
  stats,
  categories
}: {
  stats: InventoryStats
  categories: CategorySummary[]
}): JSX.Element {
  const [drill, setDrill] = useState<string | null>(null)

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
          <p>Cases and boxes on hand across RM and AM, with value and spread.</p>
        </div>
      </div>

      <div className="stat-grid">
        <Stat icon="DollarSign" value={formatMoney(stats.totalValue, { compact: true })} label="Inventory value" />
        <Stat icon="Wallet" value={formatMoney(stats.totalCost, { compact: true })} label="Total cost" />
        <Stat
          icon="TrendingUp"
          value={formatMoney(stats.spread, { compact: true })}
          label="Spread"
          tone={stats.spread < 0 ? 'neg' : stats.spread > 0 ? 'pos' : undefined}
        />
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
                <span>{formatMoney(c.value, { compact: true })}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function Stat({
  icon,
  value,
  label,
  tone
}: {
  icon: string
  value: string
  label: string
  tone?: 'pos' | 'neg'
}): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name={icon} size={21} />
      </div>
      <div>
        <div className={`stat-val ${tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}`}>{value}</div>
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
              <th style={{ textAlign: 'center' }}>Total</th>
              <th style={{ textAlign: 'right' }}>High bid</th>
              <th style={{ textAlign: 'right' }}>Inv. value</th>
              <th style={{ textAlign: 'right' }}>Avg cost</th>
              <th style={{ textAlign: 'right' }}>Total cost</th>
              <th style={{ textAlign: 'right' }}>Spread</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const m = productMetrics(p)
              return (
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
                  <td style={{ fontWeight: 700, textAlign: 'center' }}>{p.quantity}</td>
                  <td className="money">{m.hasBid ? formatMoney(m.marketUnit) : dash}</td>
                  <td className="money">{p.quantity > 0 ? formatMoney(m.invValue) : dash}</td>
                  <td className="money">{m.hasCost ? formatMoney(m.avgCost) : dash}</td>
                  <td className="money">{m.hasCost && p.quantity > 0 ? formatMoney(m.totalCost) : dash}</td>
                  <td className={`money ${m.hasCost ? (m.spread < 0 ? 'neg' : m.spread > 0 ? 'pos' : '') : ''}`}>
                    {m.hasCost && p.quantity > 0 ? formatMoney(m.spread) : dash}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

const dash = <span className="muted">—</span>
