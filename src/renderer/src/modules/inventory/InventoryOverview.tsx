import { useState } from 'react'
import type {
  CategoryValue,
  InventoryProduct,
  InventoryStats,
  InventoryTransaction,
  SalesPoint
} from '@shared/types'
import { AreaChart, BarList } from '../../components/charts'
import { Icon } from '../../components/Icon'
import { Button, EmptyState } from '../../components/ui'
import { formatMoney, formatDateTime } from '../../lib/format'
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
  categories: CategoryValue[]
  series: SalesPoint[]
  recentSales: InventoryTransaction[]
  products: InventoryProduct[]
  canManage: boolean
  onChanged: () => Promise<void>
}): JSX.Element {
  const [saleOpen, setSaleOpen] = useState(false)
  const hasSales = series.some((s) => s.revenue > 0)

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Inventory overview</h2>
          <p>What you hold, what it's worth, and what's selling.</p>
        </div>
        {canManage && products.length > 0 && (
          <Button variant="primary" icon="ShoppingCart" onClick={() => setSaleOpen(true)}>
            Record sale
          </Button>
        )}
      </div>

      <div className="stat-grid">
        <Stat icon="DollarSign" value={formatMoney(stats.totalValue, { compact: true })} label="Inventory value" />
        <Stat icon="Package" value={String(stats.boxes)} label="Boxes" />
        <Stat icon="Boxes" value={String(stats.cases)} label="Cases" />
        <Stat icon="Tag" value={String(stats.skuCount)} label="Products (SKUs)" />
      </div>

      {stats.lowStockCount > 0 && (
        <div className="lowstock-banner">
          <Icon name="AlertTriangle" size={17} />
          {stats.lowStockCount} product{stats.lowStockCount === 1 ? '' : 's'} at or below the low-stock
          threshold.
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
              <AreaChart
                series={[{ points: series.map((s) => s.revenue), color: 'var(--chart-green)', fill: true }]}
                labels={series.map((s) => s.label)}
                height={200}
              />
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
              <h3>Value by category</h3>
            </div>
            {categories.length === 0 ? (
              <p className="muted text-sm">No products yet.</p>
            ) : (
              <BarList
                items={categories.slice(0, 6).map((c) => ({ label: c.category, value: c.value }))}
                formatValue={(v) => formatMoney(v, { compact: true })}
              />
            )}
          </div>
        </div>
      </div>

      <div className="section-head" style={{ marginTop: 24 }}>
        <div>
          <h2>Recent sales</h2>
          <p>The latest items sold to clients.</p>
        </div>
      </div>

      {recentSales.length === 0 ? (
        <EmptyState icon="ShoppingCart" title="No sales yet" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Product</th>
                <th>Client</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {recentSales.map((t) => {
                const qty = Math.abs(t.quantityChange)
                const total = qty * (t.unitPrice ?? 0)
                return (
                  <tr key={t.id}>
                    <td className="muted">{formatDateTime(t.createdAt)}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{t.productName}</div>
                      <div className="p-sub mono">{t.sku}</div>
                    </td>
                    <td>{t.counterparty || <span className="muted">—</span>}</td>
                    <td>{qty}</td>
                    <td className="money">{formatMoney(t.unitPrice ?? 0)}</td>
                    <td className="money">{formatMoney(total)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

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
