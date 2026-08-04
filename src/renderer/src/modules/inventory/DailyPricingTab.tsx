import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PricingRow } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'
import { formatDate, formatMoney, formatUnitMoney } from '../../lib/format'
import { ProductQuickView } from './ProductCases'
import { productMetrics } from './helpers'

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

  // `outside` is the money the Spread beside it is not speaking for — boxes with
  // no cost basis, which the dashboard excludes for the same reason. Carried in
  // the same reduce as the figure it qualifies, so the header can never state a
  // spread without stating what is missing from it.
  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, r) => {
          acc.value += r.invValue
          acc.spread += r.spread
          if (r.outsideSpread) {
            acc.outside += r.invValue
            acc.outsideCount += 1
          }
          return acc
        },
        { value: 0, spread: 0, outside: 0, outsideCount: 0 }
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
      // Mirror the backend: stamp "last priced" only when a bid is set.
      const at = p.highBid != null ? new Date().toISOString() : null
      // The money on the row comes from the shared helper rather than being
      // re-derived here: the cost side is READ from the product's layers, not
      // rebuilt as quantity × average, and the spread follows the same
      // uncosted-box rule pricingList applies. A row updated in place and a row
      // reloaded from the database have to show the same money.
      const m = productMetrics(p)
      setRows((prev) =>
        (prev ?? []).map((r) =>
          r.id === row.id
            ? {
                ...r,
                highBid: p.highBid,
                highBidAt: at,
                unitCost: m.avgCost,
                costValue: m.totalCost,
                invValue: m.invValue,
                outsideSpread: m.outsideSpread,
                spread: m.spread
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
          <h2>Pricing</h2>
          <div className="cat-subhead">
            <span>{filtered.length} in stock</span>
            <span className="pricing-tot">
              Value <strong>{formatMoney(totals.value, { compact: true })}</strong> · Spread{' '}
              <strong className={totals.spread < 0 ? 'neg' : totals.spread > 0 ? 'pos' : ''}>
                {formatMoney(totals.spread, { compact: true })}
              </strong>
              {totals.outsideCount > 0 && (
                <span>
                  {' '}
                  · {formatMoney(totals.outside, { compact: true })} on {totals.outsideCount} box
                  {totals.outsideCount === 1 ? '' : 'es'} with no cost, outside the spread
                </span>
              )}
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
                  <td className="money">{r.unitCost > 0 ? formatUnitMoney(r.unitCost) : <span className="muted">—</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <BidInput value={r.highBid} onCommit={(raw) => commitBid(r, raw)} />
                  </td>
                  <td className="money">{formatMoney(r.invValue)}</td>
                  {/* A box with no cost basis has no spread to show — a dash,
                      matching its Avg cost cell and the dashboard tile, rather
                      than a $0.00 that would read as a measured result. */}
                  <td
                    className={`money ${r.outsideSpread ? '' : r.spread < 0 ? 'neg' : r.spread > 0 ? 'pos' : ''}`}
                    title={r.outsideSpread ? 'No cost recorded — this stock is outside the spread.' : undefined}
                  >
                    {r.outsideSpread ? <span className="muted">—</span> : formatMoney(r.spread)}
                  </td>
                  <td className="money" style={{ color: 'var(--text-3)' }}>{r.highBidAt ? formatDate(r.highBidAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {quick && (
        <ProductQuickView
          data={{
            productId: quick.id,
            name: quick.name,
            sku: quick.sku,
            category: quick.category,
            unitType: quick.unitType,
            quantity: quick.quantity,
            unitCost: quick.unitCost,
            highBid: quick.highBid,
            costValue: quick.costValue,
            marketValue: quick.invValue
          }}
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
