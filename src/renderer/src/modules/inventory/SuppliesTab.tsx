import { useCallback, useEffect, useRef, useState } from 'react'
import type { Supply, SupplyOrder, SupplyStats } from '@shared/types'
import { api } from '../../lib/api'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney, formatDate } from '../../lib/format'
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
 *
 * This tab owns the supplies themselves — stock, per-item cost, buy/use/adjust.
 * Tracking a reorder through Ordered → In-transit → Delivered lives on the
 * Purchase Orders tab, next to the buy-side PO board — and once an order has
 * been finished for a day it leaves that board and lands in Order history here,
 * which is the other half of the same change. See SUPPLY_BOARD_WINDOW_MS.
 */
export function SuppliesTab({ canManage }: { canManage: boolean }): JSX.Element {
  const [supplies, setSupplies] = useState<Supply[]>([])
  const [stats, setStats] = useState<SupplyStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Supply | null | 'new'>(null)
  const [stockFor, setStockFor] = useState<StockTarget | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Supply | null>(null)
  const [history, setHistory] = useState<SupplyOrder[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    // The history read is allowed to fail on its own. It is a record of what
    // already happened; a screen that will not open because an extra list did
    // not come back would be a worse trade than a missing panel.
    const [list, st, past] = await Promise.all([
      api.supplies.list(),
      api.supplies.stats(),
      api.supplies.orderHistory().catch((): SupplyOrder[] => [])
    ])
    if (!mounted.current) return
    setSupplies(list)
    setStats(st)
    setHistory(past)
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

  const openReorder = (s: Supply): void => {
    if (s.reorderUrl) api.email.openExternal(s.reorderUrl)
  }

  if (loading) return <CenterLoader />

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Supplies</h2>
          <p className="section-sub">
            Packaging and operating consumables. Reorder them on the Purchase Orders tab.
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
          message="Mailers, bags, labels, tape — anything you buy on repeat and want counted."
          action={
            canManage ? (
              <Button variant="primary" icon="Plus" onClick={() => setEditing('new')}>
                Add your first supply
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-wrap supplies-table">
          {/* Stacks into one card per supply on a phone — see section 3 of
              styles/mobile.css. The supply (thumbnail, name, pack size) is the
              headline; the five action buttons get their own full-width row. */}
          <table className="data as-cards">
            <thead>
              <tr>
                <th>Supply</th>
                <th style={{ textAlign: 'right' }}>On hand</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
                <th style={{ textAlign: 'right' }}>Stock value</th>
                <th style={{ textAlign: 'right' }}>Reorder at</th>
                {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {supplies.map((s) => (
                <tr key={s.id} className={s.lowStock ? 'supply-low-row' : ''}>
                  <td>
                    <div className="supply-row-main">
                      <div className="supply-thumb">
                        {s.imageUrl ? (
                          <img src={s.imageUrl} alt="" />
                        ) : (
                          <Icon name="Package" size={18} />
                        )}
                      </div>
                      <div>
                        <div className="supply-name-cell">
                          <span style={{ fontWeight: 600 }}>{s.name}</span>
                          {s.recurring && (
                            <span className="supply-chip" title="Recurring order">
                              <Icon name="Repeat" size={12} />
                              Recurring
                            </span>
                          )}
                        </div>
                        {(s.itemsPerUnit > 1 || s.notes) && (
                          <div className="p-sub">
                            {[s.itemsPerUnit > 1 ? `Pack of ${s.itemsPerUnit}` : null, s.notes]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }} data-label="On hand">
                    <span className={`supply-onhand ${s.lowStock ? 'low' : ''}`}>{s.quantity}</span>
                    <span className="supply-unit"> {UNIT_LABEL[s.unit] ?? s.unit}</span>
                    {s.lowStock && (
                      <div className="supply-low-tag">
                        <Icon name="AlertTriangle" size={11} /> Low
                      </div>
                    )}
                  </td>
                  <td className="money" style={{ textAlign: 'right' }} data-label="Cost">
                    {s.unitCost > 0 ? (
                      s.itemsPerUnit > 1 ? (
                        <>
                          {formatMoney(s.unitCost * s.itemsPerUnit)}
                          <div className="p-sub">{formatMoney(s.unitCost)}/item</div>
                        </>
                      ) : (
                        formatMoney(s.unitCost)
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="money" style={{ textAlign: 'right' }} data-label="Stock value">
                    {formatMoney(s.stockValue)}
                  </td>
                  <td style={{ textAlign: 'right' }} data-label="Reorder at">
                    {s.reorderPoint > 0 ? s.reorderPoint : <span className="muted">—</span>}
                  </td>
                  {canManage && (
                    <td>
                      <div className="supply-actions">
                        {s.reorderUrl && (
                          <button
                            className={`btn btn-sm ${s.lowStock ? 'btn-primary' : 'btn-ghost'} supply-reorder-btn`}
                            onClick={() => openReorder(s)}
                            title={`Reorder — opens ${s.reorderUrl}`}
                          >
                            <Icon name="ShoppingCart" size={15} /> Reorder
                          </button>
                        )}
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

      <OrderHistory
        orders={history}
        open={showHistory}
        onToggle={() => setShowHistory((v) => !v)}
      />

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

/**
 * WHAT LEFT THE BOARD. The owner: "supply tab purchase orders once they are ...
 * delivered also disappear after 24 hours into history ... those can also be
 * tracked".
 *
 * Shut by default, because the question this tab answers day to day is "what do
 * I have and what do I need to buy", not "what did I buy last month". The count
 * sits on the toggle so the answer to "is anything in there" costs no click.
 *
 * Deliberately read-only. Everything in here is finished and terminal — a
 * delivered order has already moved its stock and booked its spend, and a
 * cancelled one never will. Offering a button would only offer a way to break
 * that.
 */
function OrderHistory({
  orders,
  open,
  onToggle
}: {
  orders: SupplyOrder[]
  open: boolean
  onToggle: () => void
}): JSX.Element | null {
  if (orders.length === 0) return null
  const spend = orders
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + o.total, 0)
  return (
    <div className="supply-history">
      <button className="supply-history-head" onClick={onToggle} aria-expanded={open}>
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={16} />
        <span className="supply-history-title">Order history</span>
        <span className="supply-history-count">{orders.length}</span>
        <span className="supply-history-spend">{formatMoney(spend)} delivered</span>
      </button>
      {open && (
        <div className="table-wrap">
          <table className="data as-cards">
            <thead>
              <tr>
                <th>Supply</th>
                <th style={{ textAlign: 'right' }}>Ordered</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ textAlign: 'right' }}>Finished</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    <div className="supply-name-cell">
                      <span style={{ fontWeight: 600 }}>{o.supplyName}</span>
                      <span
                        className={`supply-chip ${o.status === 'cancelled' ? 'is-cancelled' : ''}`}
                      >
                        {o.status === 'cancelled' ? 'Cancelled' : 'Delivered'}
                      </span>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }} data-label="Ordered">
                    {o.units} {UNIT_LABEL[o.unit] ?? o.unit}
                    {o.itemsPerUnit > 1 && <div className="p-sub">{o.items} items</div>}
                  </td>
                  <td className="money" style={{ textAlign: 'right' }} data-label="Total">
                    {/* A cancelled order was never paid for. Printing its total
                        as money next to delivered spend would read as a cost the
                        business carried. */}
                    {o.status === 'cancelled' ? (
                      <span className="muted">—</span>
                    ) : (
                      formatMoney(o.total)
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }} data-label="Finished">
                    {finishedOn(o) ? (
                      formatDate(finishedOn(o) as string)
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** When an order stopped being live — whichever terminal stamp it carries. */
function finishedOn(o: SupplyOrder): string | null {
  return o.deliveredAt ?? o.cancelledAt ?? null
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
