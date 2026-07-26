import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShipBreakStatus } from '@shared/shippingTypes'
import { SHIP_BREAK_STATUSES } from '@shared/shippingTypes'
import type {
  ShipBreakDetail,
  ShipBreakSlotRow,
  ShipBreakSummary,
  ShipOrderRow,
  ShipOrderTeam
} from '@shared/shippingViews'
import { SHIP_STAGE_LABELS } from '@shared/shippingViews'
import type { ShipTabProps } from './ShippingModule'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, CenterLoader, EmptyState, Modal, Select } from '../../components/ui'

/**
 * Checker tab — the pick list, grouped BY BREAK (architecture doc section 5).
 *
 * This is the exact inverse of Orders: Orders is one row per package, the
 * Checker puts every customer's cards from break N together, because that is
 * how the physical work happens — you open one break's cards and sort them into
 * customer piles.
 *
 * Both screens read the SAME team slots, so checking a card here and expanding
 * that card in Orders always show identical progress. Every mutation returns the
 * freshly derived break AND order from the domain layer, so nothing is computed
 * twice on this side.
 *
 * Two rules from the doc are load-bearing here:
 *  - **A packed / shipped break is never silently downgraded.** Un-checking a
 *    card leaves the status alone; `Clear` is the one deliberate un-pack, and it
 *    asks first.
 *  - **A break-less giveaway is NOT a break.** Its `breakId` is
 *    `giveaway_<handle>` and it has no `ship_breaks` row, so it can never show up
 *    as a phantom break in this list. It still has to get picked, though, so it
 *    gets its own clearly-separate section below the breaks.
 */

type StatusFilter = 'all' | ShipBreakStatus
type GroupMode = 'team' | 'customer'

const STATUS_LABELS: Record<ShipBreakStatus, string> = {
  pending: 'Pending',
  picking: 'Picking',
  packed: 'Packed',
  shipped: 'Shipped'
}

const STATUS_ICONS: Record<ShipBreakStatus, string> = {
  pending: 'CircleDot',
  picking: 'ListChecks',
  packed: 'PackageCheck',
  shipped: 'Truck'
}

/** A break-less giveaway package — cards that belong to no break at all. */
interface LooseGiveaway {
  shipmentId: string
  handle: string
  realName: string
  address: string
  isNew: boolean
  teams: ShipOrderTeam[]
  checked: number
}

export function CheckerTab({ canManage, onChanged, onGoTo }: ShipTabProps): JSX.Element {
  const toast = useToast()

  const [breaks, setBreaks] = useState<ShipBreakSummary[]>([])
  const [orders, setOrders] = useState<ShipOrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detail, setDetail] = useState<ShipBreakDetail | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [confirmClear, setConfirmClear] = useState<ShipBreakDetail | null>(null)
  const [busy, setBusy] = useState(false)

  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(async () => {
    const [b, o] = await Promise.all([api.shipping.breaks(), api.shipping.orders()])
    // Defensive belt-and-braces for the doc's section 5 gotcha: only real breaks
    // belong in this list. `listBreaks()` already reads `ship_breaks` (which a
    // `giveaway_<handle>` id is deliberately absent from), so this filter should
    // never fire — but a phantom break in a pick list is a silent data lie, and
    // the guard costs nothing.
    setBreaks(b.filter((x) => x.breakNumber != null && !x.id.startsWith('giveaway_')))
    setOrders(o)
  }, [])

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

  /** Swap a freshly derived break into both the list and the open detail. */
  const applyBreak = useCallback((next: ShipBreakDetail) => {
    setBreaks((prev) => prev.map((b) => (b.id === next.id ? { ...b, ...stripSlots(next) } : b)))
    setDetail((prev) => (prev && prev.id === next.id ? next : prev))
  }, [])

  /** Swap a freshly derived order row in — this is what keeps the loose
   * giveaway section and the Orders tab showing the same progress. */
  const applyOrder = useCallback((next: ShipOrderRow) => {
    setOrders((prev) => prev.map((o) => (o.id === next.id ? next : o)))
  }, [])

  const open = useCallback(async (id: string) => {
    setOpeningId(id)
    try {
      const next = await api.shipping.break(id)
      if (next) setDetail(next)
    } finally {
      setOpeningId(null)
    }
  }, [])

  // ---- Slot mutations (shared by the break detail and the loose section) ----
  const toggleSlot = useCallback(
    async (slotId: string, checked: boolean) => {
      const res = await api.shipping.setSlotChecked(slotId, checked)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not check that card off.')
        return
      }
      if (res.data.break) applyBreak(res.data.break)
      if (res.data.order) applyOrder(res.data.order)
      await onChangedRef.current()
    },
    [applyBreak, applyOrder, toast]
  )

  const toggleSleeve = useCallback(
    async (slotId: string, topSleeved: boolean) => {
      const res = await api.shipping.setSlotTopSleeved(slotId, topSleeved)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not change the top sleeve.')
        return
      }
      if (res.data.break) applyBreak(res.data.break)
      if (res.data.order) applyOrder(res.data.order)
      await onChangedRef.current()
    },
    [applyBreak, applyOrder, toast]
  )

  // ---- Break-level actions -------------------------------------------------
  const runBreakAction = useCallback(
    async (label: string, run: () => Promise<{ ok: boolean; data?: ShipBreakDetail; error?: string }>) => {
      setBusy(true)
      try {
        const res = await run()
        if (!res.ok || !res.data) {
          toast.error(res.error ?? `Could not ${label}.`)
          return
        }
        applyBreak(res.data)
        await onChangedRef.current()
      } finally {
        setBusy(false)
      }
    },
    [applyBreak, toast]
  )

  const looseGiveaways = useMemo<LooseGiveaway[]>(() => {
    const rows: LooseGiveaway[] = []
    for (const o of orders) {
      const teams: ShipOrderTeam[] = []
      for (const b of o.breaks) if (b.breakNumber == null) teams.push(...b.teams)
      if (teams.length === 0) continue
      rows.push({
        shipmentId: o.id,
        handle: o.customer.handle,
        realName: o.customer.realName,
        address: o.customer.address,
        isNew: o.customer.isNew,
        teams,
        checked: teams.filter((t) => t.checkedOff).length
      })
    }
    return rows.sort((a, b) => a.handle.localeCompare(b.handle))
  }, [orders])

  const totals = useMemo(() => {
    let cards = 0
    let checked = 0
    for (const b of breaks) {
      cards += b.totalTeams
      checked += b.checkedTeams
    }
    const looseCards = looseGiveaways.reduce((n, g) => n + g.teams.length, 0)
    const looseChecked = looseGiveaways.reduce((n, g) => n + g.checked, 0)
    return {
      breaks: breaks.length,
      cards: cards + looseCards,
      checked: checked + looseChecked,
      packed: breaks.filter((b) => b.status === 'packed' || b.status === 'shipped').length
    }
  }, [breaks, looseGiveaways])

  const statusCounts = useMemo(() => {
    const counts: Record<ShipBreakStatus, number> = {
      pending: 0,
      picking: 0,
      packed: 0,
      shipped: 0
    }
    for (const b of breaks) counts[b.status] += 1
    return counts
  }, [breaks])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return breaks.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false
      if (!q) return true
      return (
        String(b.breakNumber).includes(q) ||
        `break #${b.breakNumber}`.includes(q) ||
        b.eventName.toLowerCase().includes(q)
      )
    })
  }, [breaks, query, statusFilter])

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

  // ---- The open break's pick list -----------------------------------------
  if (detail) {
    return (
      <>
        <BreakDetailView
          // Keyed on the break so opening a different one starts with a clean
          // search / grouping / hide-picked state instead of inheriting the
          // last break's filters.
          key={detail.id}
          detail={detail}
          canManage={canManage}
          busy={busy}
          onBack={() => setDetail(null)}
          onToggleSlot={toggleSlot}
          onToggleSleeve={toggleSleeve}
          onCheckAll={(checked) =>
            runBreakAction(checked ? 'check every card' : 'un-check every card', () =>
              api.shipping.setBreakChecked(detail.id, checked)
            )
          }
          onPack={() => runBreakAction('mark the break packed', () => api.shipping.packBreak(detail.id))}
          onSleeve={(on) =>
            runBreakAction('change the sleeves', () => api.shipping.sleeveBreak(detail.id, on))
          }
          onStatus={(status) =>
            runBreakAction('change the status', () => api.shipping.setBreakStatus(detail.id, status))
          }
          onClear={() => setConfirmClear(detail)}
        />
        {confirmClear && (
          <Modal
            title={`Clear break #${confirmClear.breakNumber}?`}
            subtitle="This is the deliberate un-pack."
            onClose={() => setConfirmClear(null)}
            footer={
              <>
                <Button onClick={() => setConfirmClear(null)}>Cancel</Button>
                <Button
                  variant="danger"
                  icon="PackageOpen"
                  loading={busy}
                  onClick={async () => {
                    await runBreakAction('clear the break', () =>
                      api.shipping.clearBreak(confirmClear.id)
                    )
                    setConfirmClear(null)
                  }}
                >
                  Clear the break
                </Button>
              </>
            }
          >
            <p className="ship-confirm-body">
              Every one of the <b>{confirmClear.checkedTeams}</b> checked card
              {confirmClear.checkedTeams === 1 ? '' : 's'} is un-checked and the break goes back to{' '}
              <b>Pending</b>. Checking cards off never lowers a packed break on its own — this is the
              only action that does, which is why it asks first.
            </p>
          </Modal>
        )}
      </>
    )
  }

  // ---- The break list ------------------------------------------------------
  if (breaks.length === 0 && looseGiveaways.length === 0) {
    return (
      <EmptyState
        icon="ListChecks"
        title="No breaks to pick"
        message="Import a Whatnot packing-slip PDF and every break becomes a pick list here."
        action={
          <Button variant="primary" icon="UploadCloud" onClick={() => onGoTo('upload')}>
            Go to Upload
          </Button>
        }
      />
    )
  }

  const pickPct = totals.cards > 0 ? Math.round((totals.checked / totals.cards) * 100) : 0

  return (
    <div className="ship-page">
      <div className="ship-toolbar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={16} />
          <input
            placeholder="Find a break by number…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="ts-clear" title="Clear" onClick={() => setQuery('')}>
              <Icon name="X" size={14} />
            </button>
          )}
        </div>

        <div className="ship-toolbar-right">
          <span className="ship-check-total">
            <span className="chk-total-bar">
              <span className="chk-total-fill" style={{ width: `${pickPct}%` }} />
            </span>
            <b className="mono">
              {totals.checked}/{totals.cards}
            </b>{' '}
            cards picked
          </span>
          <Button size="sm" icon="RefreshCw" onClick={reload}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="ship-stage-bar">
        <button
          className={`ship-stage-chip ${statusFilter === 'all' ? 'active' : ''}`}
          onClick={() => setStatusFilter('all')}
        >
          All breaks <span className="mono">{breaks.length}</span>
        </button>
        {SHIP_BREAK_STATUSES.map((s) => (
          <button
            key={s}
            data-bstatus={s}
            className={`ship-stage-chip ${statusFilter === s ? 'active' : ''}`}
            onClick={() => setStatusFilter(statusFilter === s ? 'all' : s)}
          >
            {STATUS_LABELS[s]} <span className="mono">{statusCounts[s]}</span>
          </button>
        ))}
        <span className="spacer" />
        <span className="ship-totals">
          <b className="mono">{totals.packed}</b> of <b className="mono">{totals.breaks}</b> breaks
          packed
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon="Search"
          title="No breaks match"
          message="Nothing matches the current search and status filter."
          action={
            <Button
              icon="X"
              onClick={() => {
                setQuery('')
                setStatusFilter('all')
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="chk-grid">
          {visible.map((b) => (
            <BreakCard
              key={b.id}
              summary={b}
              opening={openingId === b.id}
              onOpen={() => open(b.id)}
            />
          ))}
        </div>
      )}

      {/* Break-less giveaways: real, checkable cards that belong to NO break.
          They are rendered in their own section — never as a break card — so the
          list above stays an honest picture of the actual breaks. */}
      {looseGiveaways.length > 0 && (
        <div className="chk-loose">
          <div className="chk-loose-head">
            <span className="chk-loose-title">
              <Icon name="Gift" size={15} /> Loose giveaways
            </span>
            <span className="chk-loose-note">
              These cards belong to no break, so they never appear in a pick list above — check them
              off here or they never get picked.
            </span>
            <span className="chk-loose-count mono">
              {looseGiveaways.reduce((n, g) => n + g.checked, 0)}/
              {looseGiveaways.reduce((n, g) => n + g.teams.length, 0)}
            </span>
          </div>
          <div className="chk-loose-list">
            {looseGiveaways.map((g) => (
              <div className="chk-loose-row" key={g.shipmentId}>
                <div className="chk-loose-cust">
                  <span className="chk-loose-handle">@{g.handle}</span>
                  {g.isNew && <span className="ship-chip info">NEW</span>}
                  <span className="chk-loose-name">{g.realName || '—'}</span>
                  <span className="chk-loose-addr" title={g.address}>
                    {g.address || 'No address on the slip'}
                  </span>
                </div>
                <div className="chk-loose-teams">
                  {g.teams.map((t) => (
                    <button
                      key={t.slotId}
                      className={`chk-loose-team ${t.checkedOff ? 'checked' : ''}`}
                      disabled={!canManage}
                      title={
                        canManage
                          ? t.checkedOff
                            ? 'Un-check this giveaway'
                            : 'Check this giveaway off'
                          : 'You do not have permission to check cards off.'
                      }
                      onClick={() => toggleSlot(t.slotId, !t.checkedOff)}
                    >
                      <Icon
                        name={t.checkedOff ? 'CheckCircle2' : 'Circle'}
                        size={14}
                        strokeWidth={t.checkedOff ? 2.5 : 2}
                      />
                      {t.teamName}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Drop the detail's slots so a summary in the list stays a summary. */
function stripSlots(detail: ShipBreakDetail): ShipBreakSummary {
  const { slots: _slots, ...summary } = detail
  return summary
}

// ---------------------------------------------------------------------------
// One break in the grid
// ---------------------------------------------------------------------------

function BreakCard({
  summary,
  opening,
  onOpen
}: {
  summary: ShipBreakSummary
  opening: boolean
  onOpen: () => void
}): JSX.Element {
  const pct =
    summary.totalTeams > 0 ? Math.round((summary.checkedTeams / summary.totalTeams) * 100) : 0
  const done = summary.totalTeams > 0 && summary.checkedTeams >= summary.totalTeams
  const audit = summary.audit
  const collisions = audit?.collisions ?? []

  return (
    <button
      className={`chk-card ${opening ? 'busy' : ''}`}
      data-bstatus={summary.status}
      onClick={onOpen}
    >
      <div className="chk-card-head">
        <span className="chk-num">
          <Icon name="Layers" size={14} />#{summary.breakNumber}
        </span>
        <span className={`chk-status ${summary.status}`}>
          <Icon name={STATUS_ICONS[summary.status]} size={12} />
          {STATUS_LABELS[summary.status]}
        </span>
        <span className="chk-card-open">
          <Icon
            name={opening ? 'Loader2' : 'ChevronRight'}
            size={16}
            className={opening ? 'spin-ico' : undefined}
          />
        </span>
      </div>

      <div className={`chk-prog ${done ? 'done' : ''}`}>
        <span className="chk-prog-bar">
          <span className="chk-prog-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="chk-prog-num mono">
          {summary.checkedTeams}/{summary.totalTeams}
        </span>
      </div>

      <div className="chk-card-meta">
        <span title="Customers in this break">
          <Icon name="Users" size={12} /> {summary.customerCount}
        </span>
        {summary.giveawayCount > 0 && (
          <span title="Giveaway cards">
            <Icon name="Gift" size={12} /> {summary.giveawayCount}
          </span>
        )}
        {summary.topSleevedTeams > 0 && (
          <span title="Top-sleeved cards">
            <Icon name="Sticker" size={12} /> {summary.topSleevedTeams}
          </span>
        )}
        <span className="chk-card-value mono">{formatMoney(summary.value)}</span>
      </div>

      {/* The fidelity audit — how much of the league slate this break captured. */}
      {audit ? (
        <div className={`chk-audit ${collisions.length > 0 ? 'danger' : audit.hasAll ? 'ok' : 'warn'}`}>
          {collisions.length > 0 ? (
            <>
              <Icon name="Siren" size={12} />
              {collisions.length} team collision{collisions.length === 1 ? '' : 's'}
            </>
          ) : audit.hasAll ? (
            <>
              <Icon name="CheckCircle2" size={12} />
              All {audit.maxTeams} teams captured
            </>
          ) : (
            <>
              <Icon name="AlertTriangle" size={12} />
              {audit.missingCount} of {audit.maxTeams} missing
            </>
          )}
        </div>
      ) : (
        <div className="chk-audit muted-audit">
          <Icon name="Info" size={12} /> No slate audit
        </div>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// The pick list
// ---------------------------------------------------------------------------

function BreakDetailView({
  detail,
  canManage,
  busy,
  onBack,
  onToggleSlot,
  onToggleSleeve,
  onCheckAll,
  onPack,
  onSleeve,
  onStatus,
  onClear
}: {
  detail: ShipBreakDetail
  canManage: boolean
  busy: boolean
  onBack: () => void
  onToggleSlot: (slotId: string, checked: boolean) => void
  onToggleSleeve: (slotId: string, topSleeved: boolean) => void
  onCheckAll: (checked: boolean) => void
  onPack: () => void
  onSleeve: (on: boolean) => void
  onStatus: (status: ShipBreakStatus) => void
  onClear: () => void
}): JSX.Element {
  const [group, setGroup] = useState<GroupMode>('team')
  const [hideChecked, setHideChecked] = useState(false)
  const [find, setFind] = useState('')

  const pct =
    detail.totalTeams > 0 ? Math.round((detail.checkedTeams / detail.totalTeams) * 100) : 0
  const done = detail.totalTeams > 0 && detail.checkedTeams >= detail.totalTeams
  const sticky = detail.status === 'packed' || detail.status === 'shipped'
  const audit = detail.audit
  const collisions = audit?.collisions ?? []
  const allSleeved = detail.slots.length > 0 && detail.slots.every((s) => s.topSleeved)

  const filtered = useMemo(() => {
    const q = find.trim().toLowerCase()
    return detail.slots.filter((s) => {
      if (hideChecked && s.checkedOff) return false
      if (!q) return true
      return (
        s.teamName.toLowerCase().includes(q) ||
        s.handle.toLowerCase().includes(q) ||
        s.realName.toLowerCase().includes(q) ||
        (s.orderId ?? '').toLowerCase().includes(q)
      )
    })
  }, [detail.slots, hideChecked, find])

  /** Sorted flat (by team) or bucketed per customer — same slots either way. */
  const groups = useMemo(() => {
    if (group === 'team') {
      const sorted = [...filtered].sort(
        (a, b) => a.teamName.localeCompare(b.teamName) || a.handle.localeCompare(b.handle)
      )
      return [{ key: '__all__', label: null as string | null, slots: sorted }]
    }
    const byCustomer = new Map<string, ShipBreakSlotRow[]>()
    for (const s of filtered) {
      const list = byCustomer.get(s.customerId)
      if (list) list.push(s)
      else byCustomer.set(s.customerId, [s])
    }
    return [...byCustomer.entries()]
      .map(([key, slots]) => ({
        key,
        label: slots[0].handle,
        slots: [...slots].sort((a, b) => a.teamName.localeCompare(b.teamName))
      }))
      .sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''))
  }, [filtered, group])

  return (
    <div className="ship-page chk-detail">
      <div className="chk-detail-head">
        <button className="chk-back" onClick={onBack}>
          <Icon name="ArrowLeft" size={16} />
          All breaks
        </button>
        <span className="chk-detail-title">
          <Icon name="Layers" size={18} />
          Break #{detail.breakNumber}
        </span>
        <span className={`chk-status ${detail.status}`}>
          <Icon name={STATUS_ICONS[detail.status]} size={12} />
          {STATUS_LABELS[detail.status]}
        </span>
        <div className={`chk-prog wide ${done ? 'done' : ''}`}>
          <span className="chk-prog-bar">
            <span className="chk-prog-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="chk-prog-num mono">
            {detail.checkedTeams}/{detail.totalTeams} picked
          </span>
        </div>
        <span className="chk-detail-value mono">{formatMoney(detail.value)}</span>
      </div>

      <div className="chk-actions">
        <Button
          size="sm"
          icon="CheckCheck"
          disabled={!canManage || busy || done || detail.slots.length === 0}
          onClick={() => onCheckAll(true)}
        >
          Check all
        </Button>
        <Button
          size="sm"
          icon="Circle"
          disabled={!canManage || busy || detail.checkedTeams === 0}
          onClick={() => onCheckAll(false)}
        >
          Un-check all
        </Button>
        <Button
          size="sm"
          icon="Sticker"
          disabled={!canManage || busy || detail.slots.length === 0}
          onClick={() => onSleeve(!allSleeved)}
        >
          {allSleeved ? 'Remove top sleeves' : 'Top-sleeve all'}
        </Button>
        <span className="spacer" />
        <Select
          className="chk-status-select"
          data-bstatus={detail.status}
          value={detail.status}
          disabled={!canManage || busy}
          title="Break status"
          onChange={(e) => onStatus(e.target.value as ShipBreakStatus)}
        >
          {SHIP_BREAK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="primary"
          icon="PackageCheck"
          disabled={!canManage || busy || detail.status === 'packed'}
          onClick={onPack}
        >
          Mark packed
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="PackageOpen"
          disabled={!canManage || busy}
          onClick={onClear}
        >
          Clear
        </Button>
      </div>

      {/* Sticky-status explainer — the operator has to know that un-checking a
          card will NOT reopen a packed break, or they will think it broke. */}
      {sticky && (
        <div className="chk-sticky-note">
          <Icon name="ShieldCheck" size={15} />
          <span>
            This break is <b>{STATUS_LABELS[detail.status]}</b>. Checking cards on or off leaves that
            alone — only <b>Clear</b> reopens it, and it asks first.
          </span>
        </div>
      )}

      {collisions.length > 0 && (
        <div className="ship-danger-card chk-collisions">
          <div className="ship-danger-head">
            <span className="ship-danger-ico">
              <Icon name="Siren" size={18} />
            </span>
            <div>
              <h3>
                {collisions.length} team collision{collisions.length === 1 ? '' : 's'} in this break
              </h3>
              <p>
                One team was captured for two customers. One of them is wrong — check the paper slips
                before you hand these cards out.
              </p>
            </div>
          </div>
          <div className="ship-collision-list">
            {collisions.map((c) => (
              <div className="ship-collision-row" key={c.teamName}>
                <span className="ship-collision-team">{c.teamName}</span>
                <span className="ship-collision-handles">
                  {c.handles.map((h) => (
                    <span className="ship-handle-chip" key={h}>
                      @{h}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {audit && (
        <div className={`chk-audit-strip ${audit.hasAll ? 'ok' : 'warn'}`}>
          <span>
            <Icon name={audit.hasAll ? 'CheckCircle2' : 'AlertTriangle'} size={14} />
            <b className="mono">
              {audit.distinctTeamCount}/{audit.maxTeams}
            </b>{' '}
            of the slate captured
            {audit.teamCount !== audit.distinctTeamCount && (
              <em>
                {' '}
                · {audit.teamCount - audit.distinctTeamCount} duplicate
                {audit.teamCount - audit.distinctTeamCount === 1 ? '' : 's'}
              </em>
            )}
          </span>
          {audit.missingCount > 0 && (
            <span className="chk-missing">
              <span className="chk-missing-label">{audit.missingCount} not sold / not captured:</span>
              {audit.missingTeams.slice(0, 14).map((t) => (
                <span className="ship-team-chip" key={t}>
                  {t}
                </span>
              ))}
              {audit.missingTeams.length > 14 && (
                <span className="ship-more">+{audit.missingTeams.length - 14} more</span>
              )}
            </span>
          )}
        </div>
      )}

      <div className="ship-toolbar chk-pick-toolbar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={16} />
          <input
            placeholder="Find a team, handle, name or order id…"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
          {find && (
            <button className="ts-clear" title="Clear" onClick={() => setFind('')}>
              <Icon name="X" size={14} />
            </button>
          )}
        </div>
        <div className="ship-toolbar-right">
          <div className="chk-group-toggle">
            <button
              className={group === 'team' ? 'active' : ''}
              onClick={() => setGroup('team')}
              title="One flat list in team order — fastest when you have the break's cards in hand"
            >
              <Icon name="ListChecks" size={14} /> By team
            </button>
            <button
              className={group === 'customer' ? 'active' : ''}
              onClick={() => setGroup('customer')}
              title="Bucketed per customer — matches the piles you are building"
            >
              <Icon name="User" size={14} /> By customer
            </button>
          </div>
          <label className="ship-pin-toggle">
            <input
              type="checkbox"
              checked={hideChecked}
              onChange={(e) => setHideChecked(e.target.checked)}
            />
            Hide picked
          </label>
        </div>
      </div>

      {detail.slots.length === 0 ? (
        <EmptyState
          icon="ListChecks"
          title="This break has no cards"
          message="No customer won a team in this break, or the slips could not be read."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="CheckCircle2"
          title={hideChecked && find.trim() === '' ? 'Everything here is picked' : 'Nothing matches'}
          message={
            hideChecked && find.trim() === ''
              ? 'Every card in this break has been checked off.'
              : 'No card in this break matches that search.'
          }
          action={
            <Button
              icon="X"
              onClick={() => {
                setFind('')
                setHideChecked(false)
              }}
            >
              Show everything
            </Button>
          }
        />
      ) : (
        <div className="chk-picklist">
          {groups.map((g) => (
            <div className="chk-group" key={g.key}>
              {g.label && (
                <div className="chk-group-head">
                  <Icon name="User" size={13} />@{g.label}
                  <span className="chk-group-count mono">
                    {g.slots.filter((s) => s.checkedOff).length}/{g.slots.length}
                  </span>
                  <span className="chk-group-addr" title={g.slots[0].address}>
                    {g.slots[0].address || 'No address on the slip'}
                  </span>
                </div>
              )}
              {g.slots.map((s) => (
                <PickRow
                  key={s.id}
                  slot={s}
                  showCustomer={group === 'team'}
                  canManage={canManage}
                  onToggle={() => onToggleSlot(s.id, !s.checkedOff)}
                  onSleeve={() => onToggleSleeve(s.id, !s.topSleeved)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PickRow({
  slot,
  showCustomer,
  canManage,
  onToggle,
  onSleeve
}: {
  slot: ShipBreakSlotRow
  showCustomer: boolean
  canManage: boolean
  onToggle: () => void
  onSleeve: () => void
}): JSX.Element {
  return (
    <div className={`chk-row ${slot.checkedOff ? 'checked' : ''}`}>
      <button
        className="chk-check"
        disabled={!canManage}
        title={
          canManage
            ? slot.checkedOff
              ? 'Un-check this card'
              : 'Check this card off'
            : 'You do not have permission to check cards off.'
        }
        onClick={onToggle}
      >
        <Icon
          name={slot.checkedOff ? 'CheckCircle2' : 'Circle'}
          size={19}
          strokeWidth={slot.checkedOff ? 2.4 : 1.9}
        />
      </button>

      <span className="chk-team">{slot.teamName}</span>

      {showCustomer && (
        <span className="chk-owner">
          <span className="chk-owner-handle">@{slot.handle}</span>
          <span className="chk-owner-name">{slot.realName || '—'}</span>
          <span className="chk-owner-addr" title={slot.address}>
            {slot.address || 'No address on the slip'}
          </span>
        </span>
      )}

      <span className="chk-flags">
        {slot.isNew && showCustomer && <span className="ship-chip info mini">NEW</span>}
        {slot.isGiveaway && (
          <span className="ship-chip mini">
            <Icon name="Gift" size={11} /> Giveaway
          </span>
        )}
        {slot.onHold && (
          <span className="ship-chip warn mini">
            <Icon name="PauseCircle" size={11} /> Hold
          </span>
        )}
        {slot.stage !== 'to_pick' && (
          <span className="ship-chip mini" data-stage={slot.stage} title="The package's stage">
            {SHIP_STAGE_LABELS[slot.stage]}
          </span>
        )}
      </span>

      {slot.orderId && <span className="chk-order mono">#{slot.orderId}</span>}
      <span className="chk-price mono">{formatMoney(slot.price)}</span>

      <button
        className={`chk-sleeve ${slot.topSleeved ? 'on' : ''}`}
        disabled={!canManage}
        title={slot.topSleeved ? 'Remove the top sleeve' : 'Mark this card top-sleeved'}
        onClick={onSleeve}
      >
        <Icon name="Sticker" size={15} />
      </button>

      <span className="chk-by">
        {slot.checkedOff
          ? `${slot.checkedOffBy ? `${slot.checkedOffBy} · ` : ''}${formatDateTime(slot.checkedOffAt)}`
          : ''}
      </span>
    </div>
  )
}
