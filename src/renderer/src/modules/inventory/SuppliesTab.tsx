import { useCallback, useEffect, useRef, useState } from 'react'
import type { Supply, SupplyStats } from '@shared/types'
import { api } from '../../lib/api'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { SupplyFormModal } from './SupplyFormModal'
import { SupplyStockModal } from './SupplyStockModal'

const UNIT_LABEL: Record<string, string> = {
  each: 'each',
  roll: 'rolls',
  pack: 'packs',
  box: 'boxes',
  case: 'cases',
  other: 'units'
}

type StockTarget = { supply: Supply; mode: 'purchase' | 'use' | 'adjust' }

/**
 * Operating supplies — consumables like bubble mailers, poly bags, labels and
 * tape. Separate from the sellable card catalog: their stock and cost never
 * touch inventory value or spread. Track how many you have, log purchases (which
 * records the spend), and get low-stock flags on the repeat items.
 */
export function SuppliesTab({ canManage }: { canManage: boolean }): JSX.Element {
  const [supplies, setSupplies] = useState<Supply[]>([])
  const [stats, setStats] = useState<SupplyStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Supply | null | 'new'>(null)
  const [stockFor, setStockFor] = useState<StockTarget | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Supply | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const [list, st] = await Promise.all([api.supplies.list(), api.supplies.stats()])
    if (!mounted.current) return
    setSupplies(list)
    setStats(st)
  }, [])

  useEffect(() => {
    ;(async () => {
      await load()
      if (mounted.current) setLoading(false)
    })()
  }, [load])

  const remove = async (s: Supply): Promise<void> => {
    const res = await api.supplies.delete(s.id)
    if (res.ok) await load()
    if (mounted.current) setConfirmDelete(null)
  }

  if (loading) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Supplies</h2>
          <p className="section-sub">
            Packaging &amp; operating consumables — kept separate from card inventory.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" icon="Plus" onClick={() => setEditing('new')}>
            Add supply
          </Button>
        )}
      </div>

      {stats && (
        <div className="stat-grid supply-stats">
          <SupplyStat icon="Package" value={String(stats.itemCount)} label="Supply items" />
          <SupplyStat
            icon="Wallet"
            value={formatMoney(stats.stockValue, { compact: true })}
            label="On-hand value"
          />
          <SupplyStat
            icon="DollarSign"
            value={formatMoney(stats.spendThisMonth, { compact: true })}
            label="Spend this month"
          />
          <SupplyStat
            icon="AlertTriangle"
            value={String(stats.lowStockCount)}
            label="Low stock"
            tone={stats.lowStockCount > 0 ? 'warn' : undefined}
          />
        </div>
      )}

      {supplies.length === 0 ? (
        <EmptyState
          icon="Package"
          title="No supplies yet"
          message="Add the things you buy on repeat — bubble mailers, poly bags, labels, tape — to track how many you have and what they cost."
          action={
            canManage ? (
              <Button variant="primary" icon="Plus" onClick={() => setEditing('new')}>
                Add your first supply
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Supply</th>
                <th style={{ textAlign: 'right' }}>On hand</th>
                <th style={{ textAlign: 'right' }}>Unit cost</th>
                <th style={{ textAlign: 'right' }}>Stock value</th>
                <th style={{ textAlign: 'right' }}>Reorder at</th>
                {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {supplies.map((s) => (
                <tr key={s.id} className={s.lowStock ? 'supply-low-row' : ''}>
                  <td>
                    <div className="supply-name-cell">
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      {s.recurring && (
                        <span className="supply-chip" title="Recurring order">
                          <Icon name="Repeat" size={12} />
                          Recurring
                        </span>
                      )}
                    </div>
                    {s.notes && <div className="p-sub">{s.notes}</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`supply-onhand ${s.lowStock ? 'low' : ''}`}>{s.quantity}</span>
                    <span className="supply-unit"> {UNIT_LABEL[s.unit] ?? s.unit}</span>
                    {s.lowStock && (
                      <div className="supply-low-tag">
                        <Icon name="AlertTriangle" size={11} /> Low
                      </div>
                    )}
                  </td>
                  <td className="money" style={{ textAlign: 'right' }}>
                    {s.unitCost > 0 ? formatMoney(s.unitCost) : <span className="muted">—</span>}
                  </td>
                  <td className="money" style={{ textAlign: 'right' }}>
                    {formatMoney(s.stockValue)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {s.reorderPoint > 0 ? s.reorderPoint : <span className="muted">—</span>}
                  </td>
                  {canManage && (
                    <td>
                      <div className="supply-actions">
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => setStockFor({ supply: s, mode: 'purchase' })}
                          title="Log a purchase"
                        >
                          <Icon name="PackagePlus" size={15} /> Buy
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => setStockFor({ supply: s, mode: 'use' })}
                          title="Record usage"
                        >
                          <Icon name="PackageMinus" size={15} /> Use
                        </button>
                        <button
                          className="icon-btn"
                          onClick={() => setEditing(s)}
                          title="Edit supply"
                          aria-label="Edit supply"
                        >
                          <Icon name="Pencil" size={15} />
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => setConfirmDelete(s)}
                          title="Delete supply"
                          aria-label="Delete supply"
                        >
                          <Icon name="Trash2" size={15} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing === 'new' && (
        <SupplyFormModal onClose={() => setEditing(null)} onSaved={load} />
      )}
      {editing && editing !== 'new' && (
        <SupplyFormModal supply={editing} onClose={() => setEditing(null)} onSaved={load} />
      )}
      {stockFor && (
        <SupplyStockModal
          supply={stockFor.supply}
          initialMode={stockFor.mode}
          onClose={() => setStockFor(null)}
          onSaved={load}
        />
      )}
      {confirmDelete && (
        <ConfirmDelete
          supply={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => remove(confirmDelete)}
        />
      )}
    </>
  )
}

function SupplyStat({
  icon,
  value,
  label,
  tone
}: {
  icon: string
  value: string
  label: string
  tone?: 'warn'
}): JSX.Element {
  return (
    <div className="stat">
      <div className={`stat-ico ${tone === 'warn' ? 'stat-ico-warn' : ''}`}>
        <Icon name={icon} size={21} />
      </div>
      <div>
        <div className={`stat-val ${tone === 'warn' ? 'neg' : ''}`}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}

function ConfirmDelete({
  supply,
  onCancel,
  onConfirm
}: {
  supply: Supply
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h3>Delete supply</h3>
            <p>{supply.name}</p>
          </div>
        </div>
        <div className="modal-body">
          <p className="muted">
            Remove <strong>{supply.name}</strong> and its purchase history? This can&apos;t be undone.
          </p>
        </div>
        <div className="modal-foot">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon="Trash2"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              await onConfirm()
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  )
}
