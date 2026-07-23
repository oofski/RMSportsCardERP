import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { CategorySummary, IncomingShipment, InventoryProduct, InventoryStats } from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS, categoryColor } from '@shared/inventory'
import { BarList } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { api } from '../../lib/api'
import { formatDate, formatMoney } from '../../lib/format'
import { UnitBadge, productMetrics } from './helpers'
import { CategoryLogo } from './CategoryLogo'
import { IncomingModal } from './IncomingModal'

type MetricKind = 'value' | 'cost' | 'spread' | 'cases' | 'skus'
type Detail = { kind: 'category'; category: string; label: string } | { kind: MetricKind; label: string }

export function InventoryOverview({
  stats,
  categories,
  canManage,
  onChanged
}: {
  stats: InventoryStats
  categories: CategorySummary[]
  canManage: boolean
  onChanged: () => Promise<void>
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

      <div className="panel-row">
        <div className="panel-card">
          <div className="panel-head">
            <div>
              <h3>Inventory value by category</h3>
              <span className="ph-sub">Market value on hand</span>
            </div>
            <div className="ph-right">
              <div className="ph-total">{formatMoney(stats.totalValue, { compact: true })}</div>
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
            <BarList
              items={valueByCategory}
              formatValue={(v) => formatMoney(v, { compact: true })}
              colorFor={(label) => categoryColor(label)}
              renderIcon={(label) => <CategoryLogo category={label} size={16} />}
              showShare
            />
          )}
        </div>

        <IncomingPanel canManage={canManage} onReceived={onChanged} />
      </div>

      <div className="section-head">
        <div>
          <h2>By category</h2>
        </div>
        <button className="link-btn" onClick={() => setDetail({ kind: 'skus', label: 'All products' })}>
          View all {stats.skuCount} products
        </button>
      </div>

      {orderedCategories.length === 0 ? (
        <EmptyState icon="Boxes" title="No inventory yet" message="Add products and stock to see category totals." />
      ) : (
        <div className="cat-grid">
          {orderedCategories.map((c) => (
            <button
              key={c.category}
              className="cat-card"
              style={{ '--cat': categoryColor(c.category) } as CSSProperties}
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

/** Dashboard panel: stock on its way in, with receive / cancel actions. */
function IncomingPanel({
  canManage,
  onReceived
}: {
  canManage: boolean
  onReceived: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [items, setItems] = useState<IncomingShipment[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setItems(await api.inventory.listIncoming())
  }, [])

  // Guarded initial fetch — the whole panel unmounts if the user opens a stat
  // detail mid-load, so don't set state after that.
  useEffect(() => {
    let active = true
    api.inventory.listIncoming().then((r) => {
      if (active) setItems(r)
    })
    return () => {
      active = false
    }
  }, [])

  const setBusyFor = (id: string, on: boolean): void =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const totalUnits = (items ?? []).reduce((sum, i) => sum + i.quantity, 0)

  const receive = async (s: IncomingShipment): Promise<void> => {
    setBusyFor(s.id, true)
    try {
      const res = await api.inventory.receiveIncoming(s.id)
      if (res.ok) {
        toast.success(`Received ${s.quantity} × ${s.productName} into ${s.location}.`)
        await load()
        await onReceived()
      } else {
        toast.error(res.error ?? 'Could not receive the shipment.')
      }
    } finally {
      setBusyFor(s.id, false)
    }
  }

  const cancel = async (s: IncomingShipment): Promise<void> => {
    setBusyFor(s.id, true)
    try {
      const res = await api.inventory.cancelIncoming(s.id)
      if (res.ok) {
        toast.success(`Cancelled incoming ${s.productName}.`)
        await load()
      } else {
        toast.error(res.error ?? 'Could not cancel the shipment.')
      }
    } finally {
      setBusyFor(s.id, false)
    }
  }

  return (
    <div className="panel-card incoming-card">
      <div className="panel-head">
        <div>
          <h3>Incoming inventory</h3>
          <span className="ph-sub">Stock on its way in</span>
        </div>
        <div className="ph-right">
          <div className="ph-total">{items === null ? '—' : totalUnits}</div>
          <div className="ph-sub">unit{totalUnits === 1 ? '' : 's'}</div>
        </div>
      </div>

      {items === null ? (
        <div className="incoming-loading">
          <span className="spinner dark" />
        </div>
      ) : items.length === 0 ? (
        <div className="incoming-empty">
          <Icon name="Truck" size={24} />
          <div className="text-sm">Nothing scheduled to arrive.</div>
          {canManage && (
            <Button size="sm" variant="secondary" icon="Plus" onClick={() => setAdding(true)}>
              Log a shipment
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="incoming-list">
            {items.map((s) => (
              <div className="incoming-row" key={s.id} style={{ '--cat': categoryColor(s.category) } as CSSProperties}>
                <span className="inc-dot" />
                <div className="inc-main">
                  <span className="inc-name" title={s.productName}>
                    {s.productName}
                  </span>
                  <span className="inc-meta">
                    <span className="inc-loc">{s.location}</span>
                    <span>{s.expectedDate ? formatDate(s.expectedDate) : 'No ETA'}</span>
                    {s.reference && <span className="inc-ref">{s.reference}</span>}
                  </span>
                </div>
                <span className="inc-qty">+{s.quantity}</span>
                {canManage && (
                  <span className="inc-actions">
                    <button
                      type="button"
                      className="inc-btn receive"
                      title="Receive into stock"
                      aria-label={`Receive ${s.productName} into ${s.location}`}
                      disabled={busy.has(s.id)}
                      onClick={() => receive(s)}
                    >
                      <Icon name="PackageCheck" size={15} />
                    </button>
                    <button
                      type="button"
                      className="inc-btn"
                      title="Cancel shipment"
                      aria-label={`Cancel incoming ${s.productName}`}
                      disabled={busy.has(s.id)}
                      onClick={() => cancel(s)}
                    >
                      <Icon name="X" size={14} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
          {canManage && (
            <button type="button" className="incoming-add" onClick={() => setAdding(true)}>
              <Icon name="Plus" size={14} /> Log a shipment
            </button>
          )}
        </>
      )}

      {adding && (
        <IncomingModal
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false)
            await load()
          }}
        />
      )}
    </div>
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
