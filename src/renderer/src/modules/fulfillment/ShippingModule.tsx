import { useCallback, useEffect, useState } from 'react'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { CheckerTab } from './CheckerTab'
import { TodayTab } from './TodayTab'
import { FloorView } from './FloorView'
import { WithSlipMode } from './WithSlipMode'

/**
 * RM Cardz Shipping Workspace — the module shell.
 *
 * The shell owns the workspace summary — the single cheap read that feeds the
 * tab badges and the header strip — and hands every tab `onChanged`, which
 * refetches it after a mutation so badges never drift from the rows.
 */
/**
 * Three screens, and nothing that is not somebody's next action.
 *
 * Today   the show-day board, and the button that starts the night
 * Orders  ONE order at a time with the customer's slip beside it, in the order
 *         the slip prints them, which is how both picking and mailing are really
 *         done. The whole-night list is still here, one click away, for a lead
 *         scanning what is left.
 * Bench   picking or packing, one order in front of you
 *
 * Flags, Setup and History left for Admin, where a lead already goes to run the
 * show. None of the three is a thing anybody does with cards in their hands, and
 * a packing bench that offers seven tabs to somebody with one job is a bench
 * where the wrong tab gets opened. What LEAVING them costs is answered in two
 * places rather than deleted: the collision strip below still says a lead has to
 * look, and Today's empty state says who imports the show.
 */
export type ShipTabId = 'today' | 'find' | 'floor'

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
  // Everybody lands on Today, loaded show or not. There is nowhere else worth
  // landing now that importing has moved to Admin — an empty board says who
  // imports, and a full one says start.
  const [tab, setTab] = useState<ShipTabId>('today')

  const reload = useCallback(async () => {
    setSummary(await api.shipping.summary())
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
  const collisions = summary?.hasCollisions ?? false

  const tabs: TabDef[] = [
    { id: 'today', label: 'Today', icon: 'LayoutGrid', badge: 0 },
    { id: 'find', label: 'Orders', icon: 'ListChecks', badge: cardsLeft, tone: 'warning' },
    // The bench. Deliberately its own tab rather than a mode of Orders: a
    // picker and a packer are doing different jobs on different screens, and
    // the whole point is that neither is looking at the other's list.
    { id: 'floor', label: 'Bench', icon: 'Boxes', badge: 0 }
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
              {t.badge > 0 && (
                <span className={`ship-tab-badge ${t.tone === 'warning' ? 'warning' : ''}`}>
                  {t.badge}
                </span>
              )}
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
          the same break is a real data error, so it stays visible on every tab.
          It is a NOTICE now rather than a button, because the audit it used to
          open lives in Admin and a bench operator cannot act on it. Saying who
          can is more use than a link nobody standing here may follow — and far
          more use than removing the warning along with the tab. */}
      {collisions && (
        <div className="ship-collision-strip" role="status">
          <Icon name="Siren" size={16} />
          <span>
            A team was captured for two customers. Keep picking — a lead reviews Flags before
            these ship.
          </span>
        </div>
      )}

      <div className="ship-scroll">
        {tab === 'today' && <TodayTab {...tabProps} />}
        {tab === 'find' && (
          <WithSlipMode mode="pick" canAct={canFind} props={tabProps}>
            <CheckerTab {...tabProps} />
          </WithSlipMode>
        )}
        {tab === 'floor' && <FloorView {...tabProps} />}
      </div>
    </div>
  )
}
