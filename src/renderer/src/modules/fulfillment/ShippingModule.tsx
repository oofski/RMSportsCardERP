import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { SetupTab } from './SetupTab'
import { CheckerTab } from './CheckerTab'
import { HistoryTab } from './HistoryTab'
import { FlagsTab } from './FlagsTab'
import { TodayTab } from './TodayTab'
import { WithSlipMode } from './WithSlipMode'

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
/**
 * The workspace, down to the screens the floor actually stands in front of.
 *
 * Today   the show-day board — what is mine, what is blocking the room
 * Orders  ONE order at a time with the customer's slip beside it, which is how
 *         both picking and mailing are really done. The whole-night list is
 *         still here, one click away, for a lead scanning what is left.
 * Flags   what the import noticed that a person should look at
 * Setup   import the slips, assign the breaks (running the show)
 * History imports, snapshots, exports — on its way to the admin home page
 *
 * Pack and Ship are gone. Pack was the same packages as a queue rather than one
 * at a time, and Ship was tracking numbers arriving from USPS — both of which
 * belong to the order in front of you, not to a tab of their own.
 */
export type ShipTabId =
  | 'today'
  | 'find'
  | 'flags'
  | 'setup'
  | 'history'

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
  const [tab, setTab] = useState<ShipTabId>('today')
  // The landing tab is chosen once, on the first load: a workspace that already
  // holds a dataset opens on Orders (the daily driver), an empty one on Upload.
  const landed = useRef(false)

  const reload = useCallback(async () => {
    const next = await api.shipping.summary()
    setSummary(next)
    if (!landed.current) {
      landed.current = true
      if (next?.hasDataset) setTab('today')
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
  // Cards still to find. The Find badge, and the thing that gates packing: a
  // package cannot close while any break it touches still has cards out.
  const cardsLeft = Math.max(0, (counts?.teamSlots ?? 0) - (counts?.checkedSlots ?? 0))
  const hasDataset = !!summary?.hasDataset
  const warningCount = counts?.warnings ?? 0
  const collisions = summary?.hasCollisions ?? false

  const tabs: TabDef[] = [
    { id: 'today', label: 'Today', icon: 'LayoutGrid', badge: 0 },
    { id: 'find', label: 'Orders', icon: 'ListChecks', badge: cardsLeft, tone: 'warning' },
    { id: 'flags', label: 'Flags', icon: 'Flag', badge: warningCount, tone: 'warning' },
    // Running the show, not doing it — hidden from people who cannot.
    ...(canManage
      ? [{ id: 'setup' as const, label: 'Setup', icon: 'UploadCloud', badge: 0 }]
      : []),
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
              {t.id === 'flags' && collisions ? (
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
          until somebody has looked at it in Flags. */}
      {collisions && tab !== 'flags' && (
        <button className="ship-collision-strip" onClick={() => setTab('flags')}>
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
        {tab === 'today' && <TodayTab {...tabProps} />}
        {tab === 'find' && (
          <WithSlipMode mode="pick" canAct={canFind} props={tabProps}>
            <CheckerTab {...tabProps} />
          </WithSlipMode>
        )}
        {tab === 'flags' && <FlagsTab {...tabProps} />}
        {tab === 'setup' && <SetupTab {...tabProps} />}
        {tab === 'history' && <HistoryTab {...tabProps} />}
      </div>
    </div>
  )
}
