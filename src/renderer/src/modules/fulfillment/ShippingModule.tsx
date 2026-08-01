import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { UploadTab } from './UploadTab'
import { OrdersTab } from './OrdersTab'
import { CheckerTab } from './CheckerTab'
import { ShippingTab } from './ShippingTab'
import { HistoryTab } from './HistoryTab'
import { FlagsTab } from './FlagsTab'

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
export type ShipTabId = 'upload' | 'orders' | 'checker' | 'flags' | 'shipping' | 'history'

/**
 * The prop contract every tab in this workspace takes. FRONTEND-2's Checker /
 * Shipping / History tabs plug in with exactly this shape.
 */
export interface ShipTabProps {
  summary: ShipWorkspaceSummary | null
  /** Run the show: import, assign, set statuses, clear the dataset. */
  canManage: boolean
  /** Do the finding — check cards off a break. Staff has this. */
  canFind: boolean
  /** Do the packing — move a package through its stages. Staff has this. */
  canPack: boolean
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
  // shipping.manage implies both, so nothing an existing account could do
  // stops working; these only ADD the floor to people who could not act before.
  const canFind = canManage || can('shipping.find')
  const canPack = canManage || can('shipping.pack')

  const [summary, setSummary] = useState<ShipWorkspaceSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
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

  // Two people pack the same event from two benches. Whoever checks a slip off
  // must stop being work for the other one, without either of them refreshing.
  useLiveRefresh(LIVE.shipping, reload)

  useEffect(() => {
    let active = true
    ;(async () => {
      // A rejected read must never leave the view on a permanent spinner: catch,
      // surface it, and always clear loading.
      try {
        await reload()
      } catch (err) {
        if (active) setLoadError(err instanceof Error ? err.message : 'Could not load shipping data.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [reload])

  // A parse can finish while the operator is on another tab, so the shell — not
  // the Upload tab — owns the "dataset changed" refresh. Without this the tab
  // badges would keep showing the previous import until something else reloaded.
  useEffect(() => {
    const off = api.shipping.onParseProgress((job) => {
      if (job.status === 'done') void reload()
    })
    return off
  }, [reload])

  if (loading) return <CenterLoader />
  // A failed load is a dead end otherwise — show what happened and offer a retry.
  if (loadError) {
    return (
      <EmptyState
        icon="AlertTriangle"
        title="Could not load shipping data"
        message={loadError}
        action={
          <Button
            variant="primary"
            icon="RefreshCw"
            onClick={() => {
              setLoadError(null)
              setLoading(true)
              void reload()
                .catch((err) =>
                  setLoadError(err instanceof Error ? err.message : 'Could not load shipping data.')
                )
                .finally(() => setLoading(false))
            }}
          >
            Try again
          </Button>
        }
      />
    )
  }

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
    // Flags sits next to the work, not on the import screen. An oddity the
    // parser noticed is something a person deals with DURING a show, and
    // nobody opens Upload once the PDF is in.
    {
      id: 'flags',
      label: 'Flags',
      icon: 'Flag',
      badge: warningCount,
      tone: 'warning'
    },
    { id: 'shipping', label: 'Shipping', icon: 'Truck', badge: summary?.trackingCount ?? 0 },
    { id: 'history', label: 'History', icon: 'History', badge: 0 }
  ]

  const tabProps: ShipTabProps = { summary, canManage, canFind, canPack, onChanged: reload, onGoTo: setTab }
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
        {tab === 'checker' && <CheckerTab {...tabProps} />}
        {tab === 'shipping' && <ShippingTab {...tabProps} />}
        {tab === 'flags' && <FlagsTab {...tabProps} />}
        {tab === 'history' && <HistoryTab {...tabProps} />}
      </div>
    </div>
  )
}
