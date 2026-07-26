import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'
import { UploadTab } from './UploadTab'
import { OrdersTab } from './OrdersTab'

/**
 * RM Cardz Shipping Workspace — the module shell.
 *
 * One Whatnot "combined labels + packing slips" PDF becomes a normalized dataset
 * (Upload), which then drives three operational views that all read the SAME
 * team slots: **Orders** (one row per package), **Checker** (one pick list per
 * break) and **Shipping** (tracking), plus **History** (imports, snapshots, CSV).
 *
 * The shell owns the workspace summary — the single cheap read that feeds the
 * tab badges and the header strip — and hands every tab `onChanged`, which
 * refetches it after a mutation so badges never drift from the rows.
 */
export type ShipTabId = 'upload' | 'orders' | 'checker' | 'shipping' | 'history'

/**
 * The prop contract every tab in this workspace takes. FRONTEND-2's Checker /
 * Shipping / History tabs plug in with exactly this shape.
 */
export interface ShipTabProps {
  summary: ShipWorkspaceSummary | null
  canManage: boolean
  onChanged: () => Promise<void>
  onGoTo: (tab: ShipTabId) => void
}

interface TabDef {
  id: ShipTabId
  label: string
  icon: string
  /** Badge count; 0 hides the badge. */
  badge: number
  tone?: 'default' | 'warning' | 'danger'
}

export function ShippingModule(): JSX.Element {
  const { can } = useSession()
  const canManage = can('shipping.manage')

  const [summary, setSummary] = useState<ShipWorkspaceSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ShipTabId>('upload')
  // The landing tab is chosen once, on the first load: a workspace that already
  // holds a dataset opens on Orders (the daily driver), an empty one on Upload.
  const landed = useRef(false)

  const reload = useCallback(async () => {
    const next = await api.shipping.summary()
    setSummary(next)
    if (!landed.current) {
      landed.current = true
      if (next?.hasDataset) setTab('orders')
    }
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      await reload()
      if (active) setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [reload])

  if (loading) return <CenterLoader />

  const counts = summary?.counts
  const hasDataset = !!summary?.hasDataset
  const warningCount = counts?.warnings ?? 0
  const collisions = summary?.hasCollisions ?? false

  const tabs: TabDef[] = [
    {
      id: 'upload',
      label: 'Upload',
      icon: 'UploadCloud',
      badge: collisions ? 0 : warningCount,
      tone: collisions ? 'danger' : 'warning'
    },
    { id: 'orders', label: 'Orders', icon: 'ClipboardList', badge: counts?.shipments ?? 0 },
    { id: 'checker', label: 'Checker', icon: 'ListChecks', badge: counts?.breaks ?? 0 },
    { id: 'shipping', label: 'Shipping', icon: 'Truck', badge: summary?.trackingCount ?? 0 },
    { id: 'history', label: 'History', icon: 'History', badge: 0 }
  ]

  const tabProps: ShipTabProps = { summary, canManage, onChanged: reload, onGoTo: setTab }
  const event = summary?.event
  const eventLabel = event?.name
    ? `${event.name}${event.date ? ` · ${event.date}` : ''}`
    : 'Unnamed event'

  return (
    <div className="content-narrow ship-shell">
      <div className="ship-topbar">
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={16} />
              {t.label}
              {t.id === 'upload' && collisions ? (
                <span className="ship-tab-badge danger">
                  <Icon name="Siren" size={11} strokeWidth={2.6} />
                </span>
              ) : t.badge > 0 ? (
                <span className={`ship-tab-badge ${t.tone === 'warning' ? 'warning' : ''}`}>
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {hasDataset && (
          <div className="ship-topmeta">
            <span className="ship-meta-item" title="Active dataset">
              <Icon name="CalendarDays" size={14} />
              {eventLabel}
            </span>
            <span className="ship-meta-item">
              <Icon name="Package" size={14} />
              {counts?.shipments ?? 0} packages
            </span>
            <span className="ship-meta-item">
              <Icon name="Layers" size={14} />
              {counts?.teamSlots ?? 0} cards
            </span>
            <span className="ship-meta-item money">{formatMoney(summary?.value ?? 0)}</span>
          </div>
        )}
      </div>

      {/* The safety net follows you around: a team claimed by two customers in
          the same break is a real data error, so it stays visible on every tab
          until it is reviewed on Upload. */}
      {collisions && tab !== 'upload' && (
        <button className="ship-collision-strip" onClick={() => setTab('upload')}>
          <Icon name="Siren" size={16} />
          <span>
            <b>Team collisions detected.</b> One or more teams were captured for two
            customers in the same break — review the audit before picking.
          </span>
          <span className="ship-collision-go">
            Review <Icon name="ArrowRight" size={14} />
          </span>
        </button>
      )}

      <div className="ship-scroll">
        {tab === 'upload' && <UploadTab {...tabProps} />}
        {tab === 'orders' && <OrdersTab {...tabProps} />}

        {/* ---------------------------------------------------------------
            FRONTEND-2 owns these three. Swap each placeholder for the real
            component — the props are already the shared `ShipTabProps`:
              {tab === 'checker'  && <CheckerTab  {...tabProps} />}
              {tab === 'shipping' && <ShippingTab {...tabProps} />}
              {tab === 'history'  && <HistoryTab  {...tabProps} />}
            --------------------------------------------------------------- */}
        {tab === 'checker' && (
          <TabPlaceholder
            icon="ListChecks"
            title="Checker"
            message="The per-break pick list lands here — every customer's teams in break order, with check-off and top-sleeve tracking."
          />
        )}
        {tab === 'shipping' && (
          <TabPlaceholder
            icon="Truck"
            title="Shipping tracker"
            message="Manual tracking status, bulk status paste and the USPS “open all” batch links land here."
          />
        )}
        {tab === 'history' && (
          <TabPlaceholder
            icon="History"
            title="History"
            message="Import history, dated snapshots and CSV exports land here."
          />
        )}
      </div>
    </div>
  )
}

function TabPlaceholder({
  icon,
  title,
  message
}: {
  icon: string
  title: string
  message: string
}): JSX.Element {
  return (
    <div className="ship-placeholder">
      <EmptyState icon={icon} title={title} message={message} />
    </div>
  )
}
