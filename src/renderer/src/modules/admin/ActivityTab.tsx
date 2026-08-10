import { useCallback, useEffect, useState } from 'react'
import type { InventoryTransaction } from '@shared/types'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
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

  const load = useCallback(async () => {
    const list = await api.inventory.transactions(300)
    setTxns(list)
  }, [])

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

  // This tab exists to answer "what has been happening" — the one screen where
  // showing yesterday's answer defeats the purpose.
  useLiveRefresh(LIVE.activity, load)

  if (loading) return <CenterLoader />
  if (txns.length === 0) {
    return (
      <EmptyState icon="Layers" title="No activity yet" />
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
        {/* Eight columns, so on a phone it stacks into one card per movement —
            see section 3 of styles/mobile.css. The product is the headline and
            carries no label; everything else prints its column header. */}
        <table className="data as-cards">
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
                <td className="muted" data-label="When">
                  {formatDateTime(t.createdAt)}
                </td>
                {/* The only cell that says WHICH thing moved, so it is the
                    card's headline rather than another labelled line. */}
                <td>
                  <div style={{ fontWeight: 600 }}>{t.productName}</div>
                  <div className="p-sub mono">{t.sku}</div>
                </td>
                <td data-label="Type">
                  <TxnBadge type={t.type} />
                </td>
                <td data-label="Location">
                  <LocBadge location={t.location} />
                </td>
                <td
                  style={{ fontWeight: 600, color: t.quantityChange < 0 ? 'var(--danger)' : 'var(--success)' }}
                  data-label="Change"
                >
                  {t.quantityChange > 0 ? '+' : ''}
                  {t.quantityChange}
                </td>
                <td className="money" data-label="Unit price">
                  {t.unitPrice != null ? formatMoney(t.unitPrice) : '—'}
                </td>
                <td data-label="Client / vendor">{t.counterparty || <span className="muted">—</span>}</td>
                <td className="muted" data-label="By">
                  {t.actorName || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
