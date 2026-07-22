import { useEffect, useMemo, useState } from 'react'
import type { CategorySummary, InventoryProduct, InventoryStats } from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS } from '@shared/inventory'
import { BarList } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/format'
import { UnitBadge, productMetrics } from './helpers'
import { CategoryLogo } from './CategoryLogo'

type MetricKind = 'value' | 'cost' | 'spread' | 'cases' | 'skus'
type Detail = { kind: 'category'; category: string; label: string } | { kind: MetricKind; label: string }

export function InventoryOverview({
  stats,
  categories
}: {
  stats: InventoryStats
  categories: CategorySummary[]
}): JSX.Element {
  const [detail, setDetail] = useState<Detail | null>(null)

  const orderedCategories = useMemo(() => {
    const rank = (c: string): number => {
      const i = CATEGORY_ORDER.indexOf(c)
      return i === -1 ? CATEGORY_ORDER.length : i
    }
    return [...categories].sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category))
  }, [categories])

  const valueByCategory = useMemo(
    () =>
      [...categories]
        .filter((c) => c.value > 0)
        .sort((a, b) => b.value - a.value)
        .map((c) => ({ label: c.category, value: Math.round(c.value) })),
    [categories]
  )

  if (detail) {
    return <InventoryDetail detail={detail} onBack={() => setDetail(null)} />
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Inventory overview</h2>
        </div>
      </div>

      <div className="stat-grid">
        <Stat icon="DollarSign" value={formatMoney(stats.totalValue, { compact: true })} label="Inventory value" onClick={() => setDetail({ kind: 'value', label: 'Inventory value' })} />
        <Stat icon="Wallet" value={formatMoney(stats.totalCost, { compact: true })} label="Total cost" onClick={() => setDetail({ kind: 'cost', label: 'Total cost' })} />
        <Stat
          icon="TrendingUp"
          value={formatMoney(stats.spread, { compact: true })}
          label="Spread"
          tone={stats.spread < 0 ? 'neg' : stats.spread > 0 ? 'pos' : undefined}
          onClick={() => setDetail({ kind: 'spread', label: 'Spread' })}
        />
        <Stat icon="Boxes" value={String(stats.cases)} label="Cases on hand" onClick={() => setDetail({ kind: 'cases', label: 'Cases on hand' })} />
      </div>

      {stats.lowStockCount > 0 && (
        <div className="lowstock-banner">
          <Icon name="AlertTriangle" size={17} />
          {stats.lowStockCount} product{stats.lowStockCount === 1 ? '' : 's'} at or below the low-stock threshold.
        </div>
      )}

      <div className="panel-card">
        <div className="panel-head">
          <div>
            <h3>Inventory value by category</h3>
            <span className="ph-sub">Market value on hand</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{formatMoney(stats.totalValue)}</div>
            <div className="ph-sub">
              {LOCATIONS.map((l) => `${l.label} ${stats.unitsByLocation[l.id] ?? 0}`).join(' · ')} units
            </div>
          </div>
        </div>
        {valueByCategory.length === 0 ? (
          <div className="chart-empty">
            <Icon name="BarChart3" size={26} />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>No value on hand yet</div>
              <div className="text-sm">Add stock to a product and it'll chart here.</div>
            </div>
          </div>
        ) : (
          <BarList items={valueByCategory} formatValue={(v) => formatMoney(v, { compact: true })} />
        )}
      </div>

      <div className="section-head">
        <div>
          <h2>By category</h2>
        </div>
      </div>

      {orderedCategories.length === 0 ? (
        <EmptyState icon="Boxes" title="No inventory yet" message="Add products and stock to see category totals." />
      ) : (
        <div className="cat-grid">
          {orderedCategories.map((c) => (
            <button
              key={c.category}
              className="cat-card"
              onClick={() => setDetail({ kind: 'category', category: c.category, label: c.category })}
            >
              <div className="cc-head">
                <span className="cc-ico">
                  <CategoryLogo category={c.category} size={20} />
                </span>
                <span className="cc-name">{c.category}</span>
              </div>
              <div className="cc-cases">
                {c.cases} <small>{c.cases === 1 ? 'case' : 'cases'}</small>
              </div>
              <div className="cc-sub">
                <span>{c.productCount} products</span>
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
  tone,
  onClick
}: {
  icon: string
  value: string
  label: string
  tone?: 'pos' | 'neg'
  onClick?: () => void
}): JSX.Element {
  return (
    <button type="button" className="stat stat-btn" onClick={onClick}>
      <div className="stat-ico">
        <Icon name={icon} size={21} />
      </div>
      <div>
        <div className={`stat-val ${tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}`}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
      <Icon name="ChevronRight" size={17} className="stat-go" />
    </button>
  )
}

/** Shared detail view: a product table with the money metrics + a totals row. */
function InventoryDetail({ detail, onBack }: { detail: Detail; onBack: () => void }): JSX.Element {
  const [rows, setRows] = useState<InventoryProduct[] | null>(null)

  useEffect(() => {
    let active = true
    const load = detail.kind === 'category' ? api.inventory.byCategory(detail.category) : api.inventory.list()
    load.then((r) => {
      if (active) setRows(r)
    })
    return () => {
      active = false
    }
  }, [detail])

  const shown = useMemo(() => {
    if (!rows) return []
    const withM = rows.map((p) => ({ p, m: productMetrics(p) }))
    switch (detail.kind) {
      case 'value':
        return withM.filter((x) => x.p.quantity > 0).sort((a, b) => b.m.invValue - a.m.invValue)
      case 'cost':
        return withM.filter((x) => x.p.quantity > 0 && x.m.hasCost).sort((a, b) => b.m.totalCost - a.m.totalCost)
      case 'spread':
        return withM.filter((x) => x.p.quantity > 0 && x.m.hasCost).sort((a, b) => b.m.spread - a.m.spread)
      case 'cases':
        return withM.filter((x) => x.p.unitType === 'case' && x.p.quantity > 0).sort((a, b) => b.p.quantity - a.p.quantity)
      case 'skus':
        return withM.sort((a, b) => a.p.name.localeCompare(b.p.name))
      case 'category':
      default:
        return withM.sort((a, b) => b.p.quantity - a.p.quantity || a.p.name.localeCompare(b.p.name))
    }
  }, [rows, detail])

  if (rows === null) return <CenterLoader />

  const totals = shown.reduce(
    (acc, { p, m }) => {
      acc.value += p.quantity > 0 ? m.invValue : 0
      acc.cost += m.hasCost && p.quantity > 0 ? m.totalCost : 0
      acc.spread += m.hasCost && p.quantity > 0 ? m.spread : 0
      acc.qty += p.quantity
      return acc
    },
    { value: 0, cost: 0, spread: 0, qty: 0 }
  )

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 12 }}>
          <Button variant="ghost" size="sm" icon="ArrowLeft" onClick={onBack}>
            Back
          </Button>
          <div>
            <h2>{detail.label}</h2>
            <p>
              {shown.length} product{shown.length === 1 ? '' : 's'} · {totals.qty} on hand
            </p>
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState icon="Boxes" title="Nothing to show here yet" />
      ) : (
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
              {shown.map(({ p, m }) => (
                <tr key={p.id} style={{ opacity: p.quantity > 0 ? 1 : 0.55 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div className="p-sub mono">{p.sku}</div>
                  </td>
                  <td>
                    <UnitBadge unit={p.unitType} />
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
              ))}
            </tbody>
            <tfoot>
              <tr className="data-total">
                <td colSpan={3 + LOCATIONS.length} style={{ fontWeight: 700 }}>
                  Total
                </td>
                <td />
                <td className="money">{formatMoney(totals.value)}</td>
                <td />
                <td className="money">{formatMoney(totals.cost)}</td>
                <td className={`money ${totals.spread < 0 ? 'neg' : totals.spread > 0 ? 'pos' : ''}`}>
                  {formatMoney(totals.spread)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}

const dash = <span className="muted">—</span>
