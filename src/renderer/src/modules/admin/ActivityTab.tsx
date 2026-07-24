import { useEffect, useState } from 'react'
import type { InventoryTransaction } from '@shared/types'
import { api } from '../../lib/api'
import { CenterLoader, EmptyState } from '../../components/ui'
import { formatMoney, formatDateTime } from '../../lib/format'
import { TxnBadge, LocBadge } from '../inventory/helpers'

/**
 * Inventory activity log — every sale, restock and adjustment across the
 * catalog. Lives in Admin as an oversight tool.
 */
export function ActivityTab(): JSX.Element {
  const [txns, setTxns] = useState<InventoryTransaction[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      const list = await api.inventory.transactions(300)
      if (!mounted) return
      setTxns(list)
      setLoading(false)
    })()
    return () => {
      mounted = false
    }
  }, [])

  if (loading) return <CenterLoader />
  if (txns.length === 0) {
    return (
      <EmptyState
        icon="Layers"
        title="No activity yet"
        message="Sales, restocks and adjustments will show up here as they happen."
      />
    )
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Inventory activity</h2>
          <p className="section-sub">Every sale, restock and adjustment across the catalog.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When</th>
              <th>Product</th>
              <th>Type</th>
              <th>Location</th>
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
                <td>
                  <LocBadge location={t.location} />
                </td>
                <td style={{ fontWeight: 600, color: t.quantityChange < 0 ? 'var(--danger)' : 'var(--success)' }}>
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
