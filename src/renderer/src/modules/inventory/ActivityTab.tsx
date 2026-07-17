import { useEffect, useState } from 'react'
import type { InventoryTransaction } from '@shared/types'
import { api } from '../../lib/api'
import { CenterLoader, EmptyState } from '../../components/ui'
import { formatMoney, formatDateTime } from '../../lib/format'
import { TxnBadge } from './helpers'

export function ActivityTab(): JSX.Element {
  const [txns, setTxns] = useState<InventoryTransaction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ;(async () => {
      setTxns(await api.inventory.transactions(300))
      setLoading(false)
    })()
  }, [])

  if (loading) return <CenterLoader />
  if (txns.length === 0) {
    return (
      <EmptyState
        icon="Layers"
        title="No activity yet"
        message="Sales, restocks and adjustments will show up here as you make them."
      />
    )
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Activity</h2>
          <p>Every stock movement — sales, purchases, restocks and adjustments.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Product</th>
              <th>Type</th>
              <th>Change</th>
              <th>Unit price</th>
              <th>Client / vendor</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td className="muted">{formatDateTime(t.createdAt)}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{t.productName}</div>
                  <div className="p-sub mono">{t.sku}</div>
                </td>
                <td>
                  <TxnBadge type={t.type} />
                </td>
                <td
                  style={{ fontWeight: 600, color: t.quantityChange < 0 ? 'var(--danger)' : 'var(--success)' }}
                >
                  {t.quantityChange > 0 ? '+' : ''}
                  {t.quantityChange}
                </td>
                <td className="money">{t.unitPrice != null ? formatMoney(t.unitPrice) : '—'}</td>
                <td>{t.counterparty || <span className="muted">—</span>}</td>
                <td className="muted">{t.actorName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
