import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PricingRow } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'
import { formatDate, formatMoney } from '../../lib/format'
import { ProductQuickView } from './ProductCases'

/**
 * Daily Pricing: a fast list of every in-stock product with an inline high-bid
 * field for the morning market-value update. Saving a bid instantly recomputes
 * that item's inventory value + spread (and refreshes the rest of the module).
 */
export function DailyPricingTab({ onChanged }: { onChanged: () => Promise<void> }): JSX.Element {
  const toast = useToast()
  const [rows, setRows] = useState<PricingRow[] | null>(null)
  const [query, setQuery] = useState('')
  const [quick, setQuick] = useState<PricingRow | null>(null)

  const load = useCallback(async () => {
    setRows(await api.inventory.pricingList())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = rows ?? []
    if (!q) return list
    return list.filter((r) =>
      q.split(/\s+/).every((t) => `${r.name} ${r.sku} ${r.category}`.toLowerCase().includes(t))
    )
  }, [rows, query])

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => {
          acc.value += r.invValue
          acc.spread += r.spread
          return acc
        },
        { value: 0, spread: 0 }
      ),
    [filtered]
  )

  const commitBid = async (row: PricingRow, raw: string): Promise<void> => {
    const trimmed = raw.trim()
    const num = trimmed === '' ? null : Number(trimmed)
    if (num != null && (!Number.isFinite(num) || num < 0)) {
      toast.error('Enter a valid high bid.')
      return
    }
    // 0 or blank means "not priced".
    const highBid = num == null || num === 0 ? null : num
    if ((row.highBid ?? null) === highBid) return // no change
    const res = await api.inventory.updateHighBid(row.id, highBid)
    if (res.ok && res.data) {
      const p = res.data
      const market = p.highBid != null && p.highBid > 0 ? p.highBid : p.unitCost
      // Mirror the backend: stamp "last priced" only when a bid is set.
      const at = p.highBid != null ? new Date().toISOString() : null
      setRows((prev) =>
        (prev ?? []).map((r) =>
          r.id === row.id
            ? {
                ...r,
                highBid: p.highBid,
                highBidAt: at,
                unitCost: p.unitCost,
                invValue: p.quantity * market,
                spread: p.quantity * market - p.quantity * p.unitCost
              }
            : r
        )
      )
      toast.success(`Updated ${p.name}.`)
      await onChanged()
    } else {
      toast.error(res.error ?? 'Could not update the high bid.')
    }
  }

  if (rows === null) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Daily pricing</h2>
          <div className="cat-subhead">
            <span>{filtered.length} in stock</span>
            <span className="pricing-tot">
              Value <strong>{formatMoney(totals.value, { compact: true })}</strong> · Spread{' '}
              <strong className={totals.spread < 0 ? 'neg' : totals.spread > 0 ? 'pos' : ''}>
                {formatMoney(totals.spread, { compact: true })}
              </strong>
            </span>
          </div>
        </div>
        <div className="topsearch pricing-search">
          <Icon name="Search" size={16} />
          <input placeholder="Filter products…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="ts-clear" title="Clear" onClick={() => setQuery('')}>
              <Icon name="X" size={14} />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="DollarSign" title="Nothing to price" message="Only products with stock on hand appear here." />
      ) : (
        <div className="table-wrap">
          <table className="data pricing-table">
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ textAlign: 'center' }}>On hand</th>
                <th style={{ textAlign: 'right' }}>Avg cost</th>
                <th style={{ textAlign: 'right' }}>High bid</th>
                <th style={{ textAlign: 'right' }}>Inv. value</th>
                <th style={{ textAlign: 'right' }}>Spread</th>
                <th style={{ textAlign: 'right' }}>Last priced</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button className="pricing-name" onClick={() => setQuick(r)} title="View cases">
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      <span className="p-sub">
                        <span className="mono">{r.sku}</span>
                        {r.category && <span> · {r.category}</span>}
                      </span>
                    </button>
                  </td>
                  <td style={{ textAlign: 'center', fontWeight: 700 }}>{r.quantity}</td>
                  <td className="money">{r.unitCost > 0 ? formatMoney(r.unitCost) : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <BidInput value={r.highBid} onCommit={(raw) => commitBid(r, raw)} />
                  </td>
                  <td className="money">{formatMoney(r.invValue)}</td>
                  <td className={`money ${r.spread < 0 ? 'neg' : r.spread > 0 ? 'pos' : ''}`}>{formatMoney(r.spread)}</td>
                  <td className="money" style={{ color: 'var(--text-3)' }}>{r.highBidAt ? formatDate(r.highBidAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {quick && (
        <ProductQuickView
          productId={quick.id}
          name={quick.name}
          sku={quick.sku}
          category={quick.category}
          unitType={quick.unitType}
          quantity={quick.quantity}
          unitCost={quick.unitCost}
          highBid={quick.highBid}
          onClose={() => setQuick(null)}
        />
      )}
    </>
  )
}

/** Inline high-bid field: commits on blur/Enter, reverts invalid input. */
function BidInput({ value, onCommit }: { value: number | null; onCommit: (raw: string) => void }): JSX.Element {
  const [v, setV] = useState(value != null ? String(value) : '')
  useEffect(() => {
    setV(value != null ? String(value) : '')
  }, [value])
  const commit = (): void => {
    const raw = v.trim()
    if (raw !== '') {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) {
        // Invalid — snap back to the last good value rather than commit it.
        setV(value != null ? String(value) : '')
        return
      }
    }
    onCommit(v)
  }
  return (
    <input
      className="input bid-input"
      type="number"
      min={0}
      step="0.01"
      value={v}
      placeholder="—"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}
