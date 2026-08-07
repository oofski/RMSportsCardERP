import { useCallback, useEffect, useState } from 'react'
import type { ShipWorkspaceSummary } from '@shared/shippingViews'
import { useSession } from '../../lib/session'
import { useChrome } from '../../lib/chrome'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { SetupTab } from '../fulfillment/SetupTab'
import { FlagsTab } from '../fulfillment/FlagsTab'
import { HistoryTab } from '../fulfillment/HistoryTab'
import type { ShipTabId, ShipTabProps } from '../fulfillment/ShippingModule'

/**
 * The three shipping screens that run the show rather than do it, hosted here.
 *
 * The shipping module is what somebody stands in front of at a packing bench:
 * Today, Orders, Steps, Bench. Importing the night's slips, reading what the
 * import flagged, and keeping the imports/snapshots/exports log are none of
 * those — they are the lead's job, and the lead is already in Admin. So the
 * screens moved and the components did not: these are the SAME `SetupTab`,
 * `FlagsTab` and `HistoryTab` the workspace rendered, given the same props by
 * a different shell.
 *
 * That shell is this file. `ShippingModule` owns the workspace summary for its
 * own tabs; Admin needs the identical read for the identical reason (the tab
 * badge has to agree with the rows), so the read, the live refresh and the
 * parse-progress subscription are reproduced here rather than reached for
 * across module boundaries.
 */

/**
 * Admin's ids for the three, deliberately its own union rather than a re-use of
 * `ShipTabId`: the shipping module is shedding those members as the tabs leave,
 * and Admin's tab strip should not be pinned to a type that is about to change
 * underneath it.
 */
export type ShipAdminTabId = 'shipping'

export interface ShipAdminWorkspace {
  /** Everything the three tabs need, ready to spread. */
  props: ShipTabProps
  loading: boolean
  loadError: string | null
  retry: () => void
  /** Open flags — the Flags tab badge. */
  warnings: number
  /** A team claimed twice in one break. Louder than a count, and rarer. */
  collisions: boolean
}

/**
 * Owns the workspace summary on Admin's behalf.
 *
 * Split from the panel below because the Flags badge lives in the tab strip,
 * which is drawn whether or not a shipping tab is the one open — the summary
 * has to be loaded by then, not by the tab body.
 */
export function useShipAdminWorkspace(goTo: (tab: ShipAdminTabId) => void): ShipAdminWorkspace {
  const { can } = useSession()
  const { navigate } = useChrome()

  const canManage = can('shipping.manage')
  // shipping.manage implies both, exactly as the shipping module reads it — a
  // lead who could do a thing on the bench can still do it from here.
  const canFind = canManage || can('shipping.find')
  const canPack = canManage || can('shipping.pack')
  // Whether "go to the bench" is a place this account can actually be sent.
  const canOpenBench = can('module.fulfillment')

  const [summary, setSummary] = useState<ShipWorkspaceSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    // These tabs are gated on shipping.manage, so for everybody else this is a
    // read the module would make and never show — skip it rather than spend it.
    if (!canManage) return
    setSummary(await api.shipping.summary())
  }, [canManage])

  // Two people work one event from two machines. What the floor checks off
  // changes what is flagged and what an export would say, so this screen has to
  // move with them.
  useLiveRefresh(LIVE.shipping, reload)

  useEffect(() => {
    let active = true
    void (async () => {
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

  // A parse can finish while the lead is on Employees or Hours — the import
  // runs in the main process and does not care which tab is open. Without this
  // the Flags badge would keep showing the previous import's count until
  // something else happened to reload.
  useEffect(() => {
    if (!canManage) return
    const off = api.shipping.onParseProgress((job) => {
      if (job.status === 'done') void reload()
    })
    return off
  }, [canManage, reload])

  const retry = useCallback(() => {
    setLoadError(null)
    setLoading(true)
    void reload()
      .catch((err) =>
        setLoadError(err instanceof Error ? err.message : 'Could not load shipping data.')
      )
      .finally(() => setLoading(false))
  }, [reload])

  /**
   * Where "go there" means inside Admin.
   *
   * Setup, Flags and History are the three these components ask for by name —
   * History's empty state sends you to the import, and the import sends you on
   * to Orders when it finishes. The first three land on the equivalent Admin
   * tab; anything else is a bench screen that does not exist here, so the click
   * hands off to the app shell and opens the Shipping workspace instead. An
   * account that cannot open that workspace would be dropped on Home by the
   * shell, which is worse than not moving, so it stays put.
   *
   * The id is compared as a plain string on purpose. `ShipTabId` is losing the
   * members that moved here, and a switch over the union would stop compiling
   * the moment it does — for a mapping that is still exactly right.
   */
  const onGoTo = useCallback(
    (tab: ShipTabId): void => {
      switch (tab as string) {
        case 'setup':
        case 'flags':
        case 'history':
          // All three now live inside ONE Admin tab, so "go there" is the same
          // destination whichever of them asked. The tab opens on Import; the
          // steps inside it are one click apart.
          goTo('shipping')
          return
        default:
          if (canOpenBench) navigate('fulfillment')
      }
    },
    [goTo, navigate, canOpenBench]
  )

  return {
    props: { summary, canManage, canFind, canPack, onChanged: reload, onGoTo },
    loading,
    loadError,
    retry,
    warnings: summary?.counts?.warnings ?? 0,
    collisions: summary?.hasCollisions ?? false
  }
}

/** The body of whichever of the three is open. */
/**
 * ONE Admin tab, three screens inside it.
 *
 * They were three tabs in the strip, which made Admin read as a shipping module
 * with an employees page attached. They are one job — running the show — done in
 * three steps, so they are one tab with the steps inside it: import the slips,
 * read what the import flagged, look back at what has been imported before.
 */
export function ShipAdminTab({
  workspace
}: {
  workspace: ShipAdminWorkspace
}): JSX.Element {
  const [inner, setInner] = useState<'setup' | 'flags' | 'history'>('setup')

  if (workspace.loading) return <CenterLoader />
  // A failed load is a dead end otherwise — show what happened and offer a retry.
  if (workspace.loadError) {
    return (
      <EmptyState
        icon="AlertTriangle"
        title="Could not load shipping data"
        message={workspace.loadError}
        action={
          <Button variant="primary" icon="RefreshCw" onClick={workspace.retry}>
            Try again
          </Button>
        }
      />
    )
  }

  const INNER: Array<{ id: 'setup' | 'flags' | 'history'; label: string }> = [
    { id: 'setup', label: 'Import' },
    { id: 'flags', label: 'Flags' },
    { id: 'history', label: 'History' }
  ]

  return (
    <>
      <div className="seg-row">
        {INNER.map((t) => (
          <button
            key={t.id}
            className={`seg ${inner === t.id ? 'on' : ''}`}
            onClick={() => setInner(t.id)}
          >
            {t.label}
            {t.id === 'flags' && workspace.warnings > 0 && (
              <span className="ship-tab-badge warning">{workspace.warnings}</span>
            )}
          </button>
        ))}
      </div>
      {inner === 'setup' && <SetupTab {...workspace.props} />}
      {inner === 'flags' && <FlagsTab {...workspace.props} />}
      {inner === 'history' && <HistoryTab {...workspace.props} />}
    </>
  )
}
