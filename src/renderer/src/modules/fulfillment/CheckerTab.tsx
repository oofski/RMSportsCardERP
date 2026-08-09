import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShipBreakStatus } from '@shared/shippingTypes'
import { SHIP_BREAK_STATUSES } from '@shared/shippingTypes'
import type {
  ShipBreakAssignee,
  ShipBreakDetail,
  ShipBreakSlotRow,
  ShipBreakSummary,
  ShipFulfillmentStage,
  ShipOrderRow,
  ShipOrderTeam
} from '@shared/shippingViews'
import { SHIP_STAGE_LABELS } from '@shared/shippingViews'
import { BreakChip } from './BreakChip'
import { BreakBench } from './BreakBench'
import type { ShipTabProps } from './ShippingModule'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Avatar, Button, CenterLoader, EmptyState, Modal, Select } from '../../components/ui'

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

/**
 * One line of the by-team list: either a card somebody bought, or a team in the
 * league slate that nobody did. Both are physically in the box.
 */
type SlateRow =
  | { kind: 'slot'; key: string; teamName: string; slot: ShipBreakSlotRow }
  | { kind: 'unsold'; key: string; teamName: string }

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

/**
 * One customer's share of a break, folded up into the package the picker is
 * actually building. Totals are precomputed so the card's header can state the
 * whole story with the body collapsed.
 */
interface PickPackData {
  key: string
  handle: string
  realName: string
  address: string
  isNew: boolean
  onHold: boolean
  stage: ShipFulfillmentStage
  trackingNumber: string | null
  slots: ShipBreakSlotRow[]
  /** Split so the body can head each run the way the slip reads. */
  cards: ShipBreakSlotRow[]
  giveaways: ShipBreakSlotRow[]
  total: number
  checked: number
  sleeved: number
  value: number
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

export function CheckerTab({
  canManage,
  canFind,
  onChanged,
  onGoToShipping
}: ShipTabProps & {
  /** Step 4's doorway: hand this floor over to the packing screen. */
  onGoToShipping?: () => void
}): JSX.Element {
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

  /**
   * Check off (or un-check) a whole customer's cards in one gesture — the
   * "Done" button on a pick card. Sequential on purpose: better-sqlite3 is
   * synchronous and each write hands back a freshly derived break, so racing
   * them would just make the last reply win. Only the final break is applied
   * and the workspace is told once, rather than N times.
   */
  const checkSlots = useCallback(
    async (slotIds: string[], checked: boolean) => {
      if (slotIds.length === 0) return
      let latest: ShipBreakDetail | null = null
      let failed = 0
      for (const slotId of slotIds) {
        const res = await api.shipping.setSlotChecked(slotId, checked)
        if (!res.ok || !res.data) {
          failed += 1
          continue
        }
        if (res.data.break) latest = res.data.break
        if (res.data.order) applyOrder(res.data.order)
      }
      if (latest) applyBreak(latest)
      if (failed > 0) {
        toast.error(`${failed} card${failed === 1 ? '' : 's'} could not be updated.`)
      }
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

  /**
   * Who, across every break.
   *
   * The question the floor actually asks is not "show me break 12", it is
   * "@someone messaged, where are their cards". That answer was only reachable
   * by opening each break in turn and searching inside it, because the one
   * search box on this screen filtered breaks by number and nothing else. Here
   * one query over the packages says which breaks a person is in, how far each
   * has got, and opens the right one in a click.
   */
  const people = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Two characters: one letter matches most of the room and is never the
    // question somebody meant to ask.
    if (q.length < 2) return []
    return orders
      .filter(
        (o) =>
          o.customer.handle.toLowerCase().includes(q) ||
          o.customer.realName.toLowerCase().includes(q)
      )
      .sort((a, b) => a.customer.handle.localeCompare(b.customer.handle))
      .slice(0, 12)
  }, [orders, query])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return breaks.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false
      if (!q) return true
      return (
        b.breakLabel.toLowerCase().includes(q) ||
        `break #${b.breakLabel}`.toLowerCase().includes(q) ||
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
          canFind={canFind}
          busy={busy}
          onBack={() => setDetail(null)}
          onToggleSlot={toggleSlot}
          onToggleSleeve={toggleSleeve}
          onCheckSlots={checkSlots}
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
          onBenchChanged={async () => {
            // Bagging a SOLD team writes checked_off, which is what the pick
            // list below is drawing — so this break has to be re-read, not just
            // the workspace summary, or the two halves of one screen disagree.
            const fresh = await api.shipping.break(detail.id)
            if (fresh) applyBreak(fresh)
            await onChangedRef.current()
          }}
          onGoToShipping={onGoToShipping}
        />
        {confirmClear && (
          <Modal
            title={`Clear break #${confirmClear.breakLabel}?`}
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
      // No button: importing is a lead's job and it happens in Admin, so the
      // bench is told what has not happened rather than sent at a locked door.
      <EmptyState
        icon="ListChecks"
        title="No breaks to pick"
        message="A lead imports the slips in Admin → Shipping and every break becomes a pick list."
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
            placeholder="Find a break, a username or a name…"
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

      {people.length > 0 && (
        <div className="chk-people">
          <div className="chk-people-head">
            <Icon name="User" size={15} />
            <span className="chk-people-title">
              {people.length === 1 ? '1 person matches' : `${people.length} people match`} “
              {query.trim()}”
            </span>
          </div>
          {people.map((o) => (
            <div className="chk-person" key={o.id}>
              <span className="chk-person-who">
                <b>{o.customer.realName || '—'}</b>
                <span className="chk-person-handle">@{o.customer.handle}</span>
                {o.customer.isNew && <span className="ship-chip info mini">NEW</span>}
              </span>
              <span className="chk-person-breaks">
                {o.breaks.map((b) => (
                  <button
                    key={b.breakId}
                    className="chk-person-break"
                    data-done={b.checked >= b.total ? 'true' : 'false'}
                    // A break-less giveaway has no break to open; its cards live
                    // in the Loose giveaways section below.
                    disabled={b.breakLabel == null || openingId === b.breakId}
                    title={
                      b.breakLabel == null
                        ? 'A giveaway with no break — see Loose giveaways below'
                        : `Open break #${b.breakLabel}`
                    }
                    onClick={() => void open(b.breakId)}
                  >
                    <BreakChip label={b.breakLabel} size="sm" />
                    <span className="mono">
                      {b.checked}/{b.total}
                    </span>
                  </button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        people.length > 0 ? null : (
          <EmptyState
            icon="Search"
            title="Nothing matches"
            message="No break, username or name matches the current search and status filter."
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
        )
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
              These belong to no break, so no pick list shows them — check them off here.
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
                      disabled={!canFind}
                      title={
                        canFind
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

/**
 * What to print for an assignee. An orphaned row carries the raw employee id in
 * `name` (the record is gone), which is noise on a pick list — so it reads
 * "Removed employee" and the id stays in the hover title.
 */
function crewLabel(a: ShipBreakAssignee): string {
  return a.found ? a.name : 'Removed employee'
}

/** "Maya Ortiz, Dev Patel" — the hover title for a crowded assignee strip. */
function crewNames(assignees: ShipBreakAssignee[]): string {
  return assignees.map(crewLabel).join(', ')
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
          <BreakChip label={summary.breakLabel} size="sm" />
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

      {/* Who is sorting this break. Assignments are made in Admin › Break
          assignments; the Checker only shows them, so a picker can spot their
          own work at a glance. Nothing is drawn when nobody is on the break —
          an absent strip already reads as "unassigned". */}
      {summary.assignees.length > 0 && (
        <div className="chk-crew" title={`Sorting this break: ${crewNames(summary.assignees)}`}>
          {/* One face, then a count. Four faces beside "Maya Ortiz +5" makes a
              reader who counts faces disagree with the number beside them. */}
          <span className="chk-crew-faces">
            <Avatar
              text={summary.assignees[0].initials}
              src={summary.assignees[0].avatarUrl}
              small
            />
          </span>
          <span className="chk-crew-name">
            {crewLabel(summary.assignees[0])}
            {summary.assignees.length > 1 && (
              <span className="chk-crew-more"> +{summary.assignees.length - 1}</span>
            )}
          </span>
        </div>
      )}

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
  canFind,
  busy,
  onBack,
  onToggleSlot,
  onToggleSleeve,
  onCheckSlots,
  onCheckAll,
  onPack,
  onSleeve,
  onStatus,
  onClear,
  onBenchChanged,
  onGoToShipping
}: {
  detail: ShipBreakDetail
  /** Run the break: mark it packed, clear it, change its status. */
  canManage: boolean
  /** Do the finding: tick individual cards off. */
  canFind: boolean
  busy: boolean
  onBack: () => void
  onToggleSlot: (slotId: string, checked: boolean) => void
  onToggleSleeve: (slotId: string, topSleeved: boolean) => void
  /** Check off a whole customer's cards at once (the pick card's Done). */
  onCheckSlots: (slotIds: string[], checked: boolean) => Promise<void>
  onCheckAll: (checked: boolean) => void
  onPack: () => void
  onSleeve: (on: boolean) => void
  onStatus: (status: ShipBreakStatus) => void
  onClear: () => void
  /** Re-read this break after a bench tick — step 3 writes the same flag the
   *  pick list below is showing, so both have to move together. */
  onBenchChanged: () => void | Promise<void>
  /** Step 4's doorway: leave the bench and start packing orders. */
  onGoToShipping?: () => void
}): JSX.Element {
  // By team by default.
  //
  // Find and Pack are different jobs on different benches: the finder has one
  // break's thirty cards in a stack and works down the slate; the packer has one
  // customer's box. Landing Find on the per-customer view made it a second copy
  // of Pack, and left the finder re-sorting a customer list in their head.
  const [group, setGroup] = useState<GroupMode>('team')
  const [hideChecked, setHideChecked] = useState(false)
  const [find, setFind] = useState('')

  // OPENING A BREAK LANDS ON THE CHECKLIST. It used to land on the pick list
  // with the checklist stacked above it, which meant the five steps — the
  // actual sequence of the job — were something you scrolled past on the way to
  // a search box. The pick list is still here and still does things the
  // checklist cannot (group by customer, search, sleeve toggles); it is one
  // click away rather than the thing in front of you.
  const [view, setView] = useState<'steps' | 'pick'>('steps')

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

  /**
   * The FULL slate, in team order — what is physically in the finder's hands.
   *
   * A break is thirty (or thirty-two) cards whether or not all thirty sold. The
   * list used to hold only the sold ones, so a finder holding the Yankees in a
   * break that sold twenty-nine had no way to tell "nobody bought this, it goes
   * to the house" from "the slip did not read and this card belongs to someone".
   * Those need completely different actions, and the screen said nothing.
   *
   * So the unsold teams are drawn too — greyed, un-checkable, and named. The
   * slate comes from the import's own audit, which is now measured per printed
   * label, so #11 and #11A each get their own thirty.
   */
  const slate = useMemo<SlateRow[]>(() => {
    const rows: SlateRow[] = filtered.map((slot) => ({ kind: 'slot', key: slot.id, teamName: slot.teamName, slot }))
    // "Hide picked" means "show me what is left". An unsold team is not left to
    // do, so it goes with the picked ones.
    if (!hideChecked) {
      const q = find.trim().toLowerCase()
      for (const teamName of detail.audit?.missingTeams ?? []) {
        if (q && !teamName.toLowerCase().includes(q)) continue
        rows.push({ kind: 'unsold', key: `unsold_${teamName}`, teamName })
      }
    }
    return rows.sort(
      (a, b) =>
        a.teamName.localeCompare(b.teamName) ||
        (a.kind === 'slot' ? a.slot.handle : '').localeCompare(b.kind === 'slot' ? b.slot.handle : '')
    )
  }, [filtered, detail.audit, hideChecked, find])

  /**
   * One pack per customer, carrying its own totals so the header can state the
   * whole story without the body being open — the same shape the Orders queue
   * shows for a package.
   */
  const packs = useMemo<PickPackData[]>(() => {
    // Which packs appear, and which tiles are inside them, follows the filter.
    const shown = new Map<string, ShipBreakSlotRow[]>()
    for (const s of filtered) {
      const list = shown.get(s.customerId)
      if (list) list.push(s)
      else shown.set(s.customerId, [s])
    }
    // The header's counts do NOT. "Hide picked" is a way to see what is left,
    // not a claim that the picked cards stopped existing — a pack that is
    // really 3 of 5 must never read 0/2 because two rows are hidden.
    const all = new Map<string, ShipBreakSlotRow[]>()
    for (const s of detail.slots) {
      const list = all.get(s.customerId)
      if (list) list.push(s)
      else all.set(s.customerId, [s])
    }

    return [...shown.entries()]
      .map(([customerId, visible]) => {
        const sorted = [...visible].sort((a, b) => a.teamName.localeCompare(b.teamName))
        const every = all.get(customerId) ?? sorted
        const head = sorted[0]
        return {
          key: customerId,
          handle: head.handle,
          realName: head.realName,
          address: head.address,
          isNew: head.isNew,
          // A hold or a stage belongs to the PACKAGE, so every slot carries the
          // same value — read it off the first rather than re-deriving.
          onHold: head.onHold,
          stage: head.stage,
          trackingNumber: head.trackingNumber,
          slots: every,
          cards: sorted.filter((s) => !s.isGiveaway),
          giveaways: sorted.filter((s) => s.isGiveaway),
          total: every.length,
          checked: every.filter((s) => s.checkedOff).length,
          sleeved: every.filter((s) => s.topSleeved).length,
          value: every.reduce((sum, s) => sum + s.price, 0)
        }
      })
      .sort((a, b) => a.handle.localeCompare(b.handle))
  }, [filtered, detail.slots])

  /**
   * Which packs the operator has collapsed. Open is the default — a picker
   * wants the cards in front of them, not a list of names to click through.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <div className="ship-page chk-detail">
      <div className="chk-detail-head">
        <button className="chk-back" onClick={onBack}>
          <Icon name="ArrowLeft" size={16} />
          All breaks
        </button>
        <span className="chk-detail-title">
          <BreakChip label={detail.breakLabel} />
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

      {/* Who owns this break. Read-only here on purpose — the assignment
          framework lives in Admin › Break assignments. */}
      <div className="chk-crew-row">
        <span className="chk-crew-label">
          <Icon name="UserCheck" size={14} />
          Sorting
        </span>
        {detail.assignees.length === 0 ? (
          <span className="chk-crew-empty">
            Nobody is assigned yet — breaks are handed out in Admin › Break assignments.
          </span>
        ) : (
          detail.assignees.map((a) => (
            <span
              key={a.id}
              className={`chk-crew-chip ${a.found ? '' : 'gone'}`}
              title={
                a.found
                  ? `Assigned ${formatDateTime(a.assignedAt)}${a.note ? ` · ${a.note}` : ''}`
                  : `This employee record has been removed (${a.employeeId}).`
              }
            >
              <Avatar text={a.initials} src={a.avatarUrl} small />
              {!a.found && <Icon name="AlertTriangle" size={12} />}
              {crewLabel(a)}
            </span>
          ))
        )}
      </div>

      <div className="chk-viewtabs">
        <button
          className={view === 'steps' ? 'active' : ''}
          onClick={() => setView('steps')}
          title="The five steps this break goes through"
        >
          <Icon name="ListChecks" size={14} /> Checklist
        </button>
        <button
          className={view === 'pick' ? 'active' : ''}
          onClick={() => setView('pick')}
          title="Every card, grouped and searchable"
        >
          <Icon name="Search" size={14} /> Pick list
        </button>
      </div>

      {/* The bench checklist — the default view, because it IS the job. */}
      {view === 'steps' && (
        <BreakBench
          breakId={detail.id}
          canAct={canFind}
          onChanged={onBenchChanged}
          onGoToPack={onGoToShipping}
        />
      )}

      <div className="chk-actions">
        <Button
          size="sm"
          icon="CheckCheck"
          disabled={!canFind || busy || done || detail.slots.length === 0}
          onClick={() => onCheckAll(true)}
        >
          Check all
        </Button>
        <Button
          size="sm"
          icon="Circle"
          disabled={!canFind || busy || detail.checkedTeams === 0}
          onClick={() => onCheckAll(false)}
        >
          Un-check all
        </Button>
        <Button
          size="sm"
          icon="Sticker"
          disabled={!canFind || busy || detail.slots.length === 0}
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

      {/* Everything below is the pick list. Collisions and the sticky-status
          note above it are deliberately OUTSIDE this switch: a team captured
          for two customers is how a stranger's card ends up in somebody's
          mailer, and hiding that behind a tab nobody is on would be hiding the
          one thing on this page that must not wait. */}
      {view === 'pick' && audit && (
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
          {audit.missingCount > 0 &&
            (group === 'team' ? (
              // In the by-team list every one of these is already drawn in place,
              // greyed and in slate order. Repeating them here as chips would say
              // the same thing twice and push the actual work down the page.
              <span className="chk-missing">
                <span className="chk-missing-label">
                  {audit.missingCount} not sold — shown greyed in the list below
                </span>
              </span>
            ) : (
              <span className="chk-missing">
                <span className="chk-missing-label">{audit.missingCount} not sold:</span>
                {audit.missingTeams.slice(0, 14).map((t) => (
                  <span className="ship-team-chip" key={t}>
                    {t}
                  </span>
                ))}
                {audit.missingTeams.length > 14 && (
                  <span className="ship-more">+{audit.missingTeams.length - 14} more</span>
                )}
              </span>
            ))}
        </div>
      )}

      {view === 'pick' && (
      <>
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
              className={group === 'customer' ? 'active' : ''}
              onClick={() => setGroup('customer')}
              title="One card per customer — matches the piles you are building"
            >
              <Icon name="User" size={14} /> Packs
            </button>
            <button
              className={group === 'team' ? 'active' : ''}
              onClick={() => setGroup('team')}
              title="The whole slate in team order — matches the stack in your hand"
            >
              <Icon name="ListChecks" size={14} /> By team
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
      ) : filtered.length === 0 && !(group === 'team' && slate.length > 0) ? (
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
          {group === 'customer' ? (
            packs.map((p) => (
              <PickPack
                key={p.key}
                pack={p}
                canFind={canFind}
                open={!collapsed.has(p.key)}
                onToggleOpen={() => toggleCollapsed(p.key)}
                onToggleSlot={onToggleSlot}
                onToggleSleeve={onToggleSleeve}
                onCheckSlots={onCheckSlots}
              />
            ))
          ) : (
            <div className="chk-flat">
              {slate.map((r) =>
                r.kind === 'unsold' ? (
                  <UnsoldTile key={r.key} teamName={r.teamName} />
                ) : (
                  <PickTile
                    key={r.key}
                    slot={r.slot}
                    showCustomer
                    canFind={canFind}
                    onToggle={() => onToggleSlot(r.slot.id, !r.slot.checkedOff)}
                    onSleeve={() => onToggleSleeve(r.slot.id, !r.slot.topSleeved)}
                  />
                )
              )}
            </div>
          )}
        </div>
      )}
      </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The pick card — one customer's package, shaped like the Orders queue row so
// the two screens read as the same object seen from two jobs.
// ---------------------------------------------------------------------------

function PickPack({
  pack,
  canFind,
  open,
  onToggleOpen,
  onToggleSlot,
  onToggleSleeve,
  onCheckSlots
}: {
  pack: PickPackData
  canFind: boolean
  open: boolean
  onToggleOpen: () => void
  onToggleSlot: (slotId: string, checked: boolean) => void
  onToggleSleeve: (slotId: string, topSleeved: boolean) => void
  onCheckSlots: (slotIds: string[], checked: boolean) => Promise<void>
}): JSX.Element {
  // Local, because the bulk write is a loop of round-trips and the operator
  // needs the card to say it is working rather than look inert.
  const [bulking, setBulking] = useState(false)
  const pct = pack.total > 0 ? Math.round((pack.checked / pack.total) * 100) : 0
  const done = pack.total > 0 && pack.checked >= pack.total
  // Off the FULL slot set: `pack.cards` / `pack.giveaways` are what survived the
  // filter, and a hidden won card must not turn the pack into a giveaway.
  const giveawayTotal = pack.slots.filter((s) => s.isGiveaway).length
  const giveawayOnly = giveawayTotal > 0 && giveawayTotal === pack.total

  const runBulk = async (): Promise<void> => {
    const target = !done
    const ids = pack.slots.filter((s) => s.checkedOff !== target).map((s) => s.id)
    setBulking(true)
    try {
      await onCheckSlots(ids, target)
    } finally {
      setBulking(false)
    }
  }

  return (
    <div
      className={`chk-pack ${done ? 'done' : ''} ${bulking ? 'busy' : ''}`}
      data-stage={pack.stage}
      data-hold={pack.onHold ? 'true' : undefined}
    >
      <div className="chk-pack-head">
        {/* The package's own stage, first — a picker has to know before they
            start that this one has already gone out. */}
        <span className="chk-pack-stage" data-stage={pack.stage}>
          <span className="chk-pack-dot" />
          {SHIP_STAGE_LABELS[pack.stage]}
        </span>

        <span className="chk-pack-name">{pack.realName || '—'}</span>
        <span className="chk-pack-handle">@{pack.handle}</span>
        <span className="chk-pack-value mono">{formatMoney(pack.value)}</span>

        {pack.isNew && <span className="ship-chip info">NEW</span>}
        {giveawayOnly && (
          <span className="ship-chip giveaway">
            <Icon name="Gift" size={12} /> Giveaway only
          </span>
        )}
        {!giveawayOnly && giveawayTotal > 0 && (
          <span className="ship-chip" title={`${giveawayTotal} giveaway card(s)`}>
            <Icon name="Gift" size={12} /> {giveawayTotal}
          </span>
        )}
        {pack.sleeved > 0 && (
          <span className="ship-chip" title={`${pack.sleeved} card(s) top-sleeved`}>
            <Icon name="Sticker" size={12} /> {pack.sleeved}
          </span>
        )}
        {pack.onHold && (
          <span className="ship-chip warn">
            <Icon name="PauseCircle" size={12} /> On hold
          </span>
        )}

        <span className="chk-pack-spacer" />

        <span className={`chk-pack-prog ${done ? 'done' : ''}`}>
          <span className="chk-pack-bar">
            <span className="chk-pack-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="chk-pack-num mono">
            {pack.checked}/{pack.total}
          </span>
        </span>

        {canFind && (
          <button
            type="button"
            className={`chk-pack-done ${done ? 'undo' : ''}`}
            disabled={bulking}
            title={
              done
                ? 'Un-check every card in this pack'
                : `Check off the remaining ${pack.total - pack.checked} card(s)`
            }
            onClick={() => void runBulk()}
          >
            <Icon name={bulking ? 'Loader2' : done ? 'RotateCcw' : 'CheckCheck'} size={14} className={bulking ? 'spin-ico' : undefined} />
            {done ? 'Undo' : 'Done'}
          </button>
        )}

        <button
          type="button"
          className="chk-pack-caret"
          aria-expanded={open}
          title={open ? 'Collapse this pack' : 'Show the cards'}
          onClick={onToggleOpen}
        >
          <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={16} />
        </button>
      </div>

      {open && (
        <div className="chk-pack-body">
          {pack.cards.length > 0 && (
            <PackRun
              icon="SquareStack"
              label="Cards"
              slots={pack.cards}
              stats={runStats(pack.slots, false)}
              canFind={canFind}
              onToggleSlot={onToggleSlot}
              onToggleSleeve={onToggleSleeve}
            />
          )}
          {pack.giveaways.length > 0 && (
            <PackRun
              icon="Gift"
              label="Giveaway"
              slots={pack.giveaways}
              stats={runStats(pack.slots, true)}
              canFind={canFind}
              onToggleSlot={onToggleSlot}
              onToggleSleeve={onToggleSleeve}
            />
          )}

          <div className="chk-pack-foot">
            <span title={pack.address}>
              <Icon name="MapPin" size={13} /> {pack.address || 'No address on the slip'}
            </span>
            {pack.trackingNumber && (
              <span className="mono">
                <Icon name="Truck" size={13} /> {pack.trackingNumber}
              </span>
            )}
            {pack.sleeved > 0 && (
              <span>
                <Icon name="Sticker" size={13} /> {pack.sleeved} top-sleeved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface RunStats {
  total: number
  checked: number
  value: number
}

/**
 * A run's headline counts come from every card in it, not from the ones the
 * filter left on screen — same reason the pack header does.
 */
function runStats(slots: ShipBreakSlotRow[], giveaway: boolean): RunStats {
  const mine = slots.filter((s) => s.isGiveaway === giveaway)
  return {
    total: mine.length,
    checked: mine.filter((s) => s.checkedOff).length,
    value: mine.reduce((sum, s) => sum + s.price, 0)
  }
}

/** One labelled run of cards inside a pack — the cards, then the giveaways. */
function PackRun({
  icon,
  label,
  slots,
  stats,
  canFind,
  onToggleSlot,
  onToggleSleeve
}: {
  icon: string
  label: string
  /** The tiles to draw — already filtered. */
  slots: ShipBreakSlotRow[]
  /** The run's real totals, filter or no filter. */
  stats: RunStats
  canFind: boolean
  onToggleSlot: (slotId: string, checked: boolean) => void
  onToggleSleeve: (slotId: string, topSleeved: boolean) => void
}): JSX.Element {
  return (
    <div className="chk-run">
      <div className="chk-run-head">
        <span className="chk-run-title">
          <Icon name={icon} size={13} /> {label}
        </span>
        <span className="chk-run-spacer" />
        <span className="chk-run-value mono">{formatMoney(stats.value)}</span>
        <span className={`chk-run-count mono ${stats.checked >= stats.total ? 'done' : ''}`}>
          {stats.checked}/{stats.total}
        </span>
      </div>
      <div className="chk-run-tiles">
        {slots.map((s) => (
          <PickTile
            key={s.id}
            slot={s}
            showCustomer={false}
            canFind={canFind}
            onToggle={() => onToggleSlot(s.id, !s.checkedOff)}
            onSleeve={() => onToggleSleeve(s.id, !s.topSleeved)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * A team in this break's slate that nobody bought.
 *
 * Deliberately inert: there is no customer, so there is nothing to check off and
 * nothing to sleeve. It exists so the finder can account for every card in their
 * hand — this one goes to the house — instead of being left to wonder whether
 * the slip failed to read. Not a flag: nothing went wrong, a team just did not
 * sell, which happens in most breaks.
 */
function UnsoldTile({ teamName }: { teamName: string }): JSX.Element {
  return (
    <div className="chk-tile unsold wide" aria-disabled="true">
      <div className="chk-tile-main">
        <span className="chk-tile-check">
          <Icon name="Minus" size={20} strokeWidth={1.9} />
        </span>
        <span className="chk-tile-body">
          <span className="chk-tile-team">{teamName}</span>
          <span className="chk-tile-owner">
            <span className="chk-unsold-note">Nobody bought this one — it goes to the house</span>
          </span>
        </span>
        <span className="chk-tile-flags">
          <span className="ship-chip mini">Not sold</span>
        </span>
        <span className="chk-tile-price mono">—</span>
      </div>
    </div>
  )
}

/**
 * One card. The tile is the check target — big enough to hit while holding a
 * stack of cards — with the top-sleeve toggle as a SIBLING button rather than
 * nested inside it, which would be invalid and unreachable by keyboard.
 */
function PickTile({
  slot,
  showCustomer,
  canFind,
  onToggle,
  onSleeve
}: {
  slot: ShipBreakSlotRow
  showCustomer: boolean
  canFind: boolean
  onToggle: () => void
  onSleeve: () => void
}): JSX.Element {
  return (
    <div className={`chk-tile ${slot.checkedOff ? 'checked' : ''} ${showCustomer ? 'wide' : ''}`}>
      <button
        type="button"
        className="chk-tile-main"
        disabled={!canFind}
        aria-pressed={slot.checkedOff}
        title={
          canFind
            ? slot.checkedOff
              ? `Un-check ${slot.teamName}`
              : `Check off ${slot.teamName}`
            : 'You do not have permission to check cards off.'
        }
        onClick={onToggle}
      >
        <span className="chk-tile-check">
          <Icon
            name={slot.checkedOff ? 'CheckCircle2' : 'Circle'}
            size={20}
            strokeWidth={slot.checkedOff ? 2.4 : 1.9}
          />
        </span>

        <span className="chk-tile-body">
          <span className="chk-tile-team">{slot.teamName}</span>

          {showCustomer && (
            <span className="chk-tile-owner">
              <b>{slot.realName || '—'}</b>
              <span className="chk-tile-handle">@{slot.handle}</span>
              <span className="chk-tile-addr" title={slot.address}>
                {slot.address || 'No address on the slip'}
              </span>
            </span>
          )}

          {slot.checkedOff && (slot.checkedOffBy || slot.checkedOffAt) && (
            <span className="chk-tile-by">
              {slot.checkedOffBy ? `${slot.checkedOffBy} · ` : ''}
              {formatDateTime(slot.checkedOffAt)}
            </span>
          )}
        </span>

        <span className="chk-tile-flags">
          {slot.isNew && showCustomer && <span className="ship-chip info mini">NEW</span>}
          {slot.isGiveaway && (
            <span className="ship-chip mini">
              <Icon name="Gift" size={11} /> Giveaway
            </span>
          )}
          {slot.onHold && showCustomer && (
            <span className="ship-chip warn mini">
              <Icon name="PauseCircle" size={11} /> Hold
            </span>
          )}
          {showCustomer && slot.stage !== 'to_pick' && (
            <span className="ship-chip mini" data-stage={slot.stage} title="The package's stage">
              {SHIP_STAGE_LABELS[slot.stage]}
            </span>
          )}
        </span>

        <span className="chk-tile-price mono">{formatMoney(slot.price)}</span>
      </button>

      <button
        type="button"
        className={`chk-tile-sleeve ${slot.topSleeved ? 'on' : ''}`}
        disabled={!canFind}
        title={slot.topSleeved ? 'Remove the top sleeve' : 'Mark this card top-sleeved'}
        onClick={onSleeve}
      >
        <Icon name="Sticker" size={16} />
      </button>
    </div>
  )
}
