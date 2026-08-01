import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ShipFulfillmentStage, ShipOrderRow } from '@shared/shippingViews'
import { SHIP_STAGES, SHIP_STAGE_LABELS } from '@shared/shippingViews'
import type { ShipTabProps } from './ShippingModule'
import { api } from '../../lib/api'
import { formatDateTime, formatMoney } from '../../lib/format'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import {
  Button,
  Checkbox,
  CenterLoader,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Textarea
} from '../../components/ui'

/**
 * Orders tab — ONE row per package (per shipment), the fulfillment queue.
 *
 * The row is deliberately minimal. Its identity is @handle + the buyer's real
 * name and NOTHING else: no tracking number, no order ids, no row id, no queue
 * position, and no per-card "who checked it / when" stamp. Tracking still lives
 * on the Shipping tracker tab — none of the rest is something an operator
 * picking a package ever needs to read, and printing it only added noise.
 *
 * What the row does carry: the address, the pick progress, the per-break card
 * groups (expandable to each team with price / check state / giveaway /
 * top-sleeve), the value pill, the stage control, hold + reason, the queue
 * arrows, the special request, the notes and the VIP highlight.
 *
 * Two breaks inside ONE package must be impossible to confuse, so every break
 * carries `data-accent` = its index WITHIN that package, mod 6, on both the
 * collapsed chip and the expanded block. It is a per-package hue, not a global
 * identity: break #1 in two different packages need not match.
 *
 * The stage is derived from the shipment's manual status in the domain layer,
 * so this screen and the Shipping tracker can never disagree — changing the
 * stage here writes the status back.
 */

const PIN_KEY = 'rmcardz.shipping.pinSpecial'
const VIP_TOP_KEY = 'rmcardz.shipping.vipTop20'
const VIP_THRESHOLD_KEY = 'rmcardz.shipping.vipThreshold'

type FlagFilter = 'all' | 'special' | 'hold' | 'vip' | 'unpicked' | 'giveaway' | 'untracked'

const FLAG_LABELS: Record<FlagFilter, string> = {
  all: 'Everything',
  special: 'Special requests',
  hold: 'On hold',
  vip: 'VIP / big spenders',
  unpicked: 'Not fully picked',
  giveaway: 'Has a giveaway',
  untracked: 'No tracking'
}

interface EditorState {
  kind: 'hold' | 'special' | 'notes'
  row: ShipOrderRow
}

export function OrdersTab({ canManage, canFind, canPack, onChanged, onGoTo }: ShipTabProps): JSX.Element {
  const toast = useToast()

  const [rows, setRows] = useState<ShipOrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [stageFilter, setStageFilter] = useState<'all' | ShipFulfillmentStage>('all')
  const [flag, setFlag] = useState<FlagFilter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showVip, setShowVip] = useState(false)
  const [slotBusy, setSlotBusy] = useState<string | null>(null)

  // Both VIP controls and the special-request pin are operator preferences, so
  // they persist locally rather than in the shared dataset.
  const [pinSpecial, setPinSpecial] = useState(
    () => (localStorage.getItem(PIN_KEY) ?? '1') === '1'
  )
  const [vipTop20, setVipTop20] = useState(() => (localStorage.getItem(VIP_TOP_KEY) ?? '1') === '1')
  const [vipThreshold, setVipThreshold] = useState(
    () => Number(localStorage.getItem(VIP_THRESHOLD_KEY) ?? '0') || 0
  )

  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(async () => {
    setRows(await api.shipping.orders())
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

  /** Swap one freshly derived row back into the list without a refetch. */
  const applyRow = useCallback((next: ShipOrderRow) => {
    setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)))
  }, [])

  // ---- VIP cutoff (doc 4.2): top-20%-by-value and/or a manual $ threshold ----
  const vipCutoff = useMemo(() => {
    const vals = rows.map((r) => r.value).filter((v) => v > 0).sort((a, b) => b - a)
    if (vals.length === 0) return Number.POSITIVE_INFINITY
    return vals[Math.ceil(vals.length * 0.2) - 1] ?? vals[vals.length - 1]
  }, [rows])

  const isVip = useCallback(
    (row: ShipOrderRow) => {
      if (row.value <= 0) return false
      if (vipTop20 && row.value >= vipCutoff) return true
      if (vipThreshold > 0 && row.value >= vipThreshold) return true
      return false
    },
    [vipTop20, vipCutoff, vipThreshold]
  )

  // ---- Queue positions come from the SERVER order, never the display order ---
  // `moveOrder` swaps within the hold group only, so the arrows are gated on the
  // row's index inside its own group.
  const groupPos = useMemo(() => {
    const map = new Map<string, { index: number; size: number }>()
    for (const held of [false, true]) {
      const group = rows.filter((r) => r.onHold === held)
      group.forEach((r, i) => map.set(r.id, { index: i, size: group.length }))
    }
    return map
  }, [rows])

  const specialCount = rows.filter((r) => r.specialRequest).length
  // Pinning changes the visual order, which would make the queue arrows swap
  // rows that are no longer neighbours — so pinning and reordering are mutually
  // exclusive, and the arrows say why when they are off.
  const pinning = pinSpecial && specialCount > 0

  const ordered = useMemo(() => {
    if (!pinning) return rows
    const holdRank = (r: ShipOrderRow): number => (r.onHold ? 1 : 0)
    const specialRank = (r: ShipOrderRow): number => (r.specialRequest ? 0 : 1)
    // Array#sort is stable, so rows that tie keep their queue order.
    return [...rows].sort((a, b) => holdRank(a) - holdRank(b) || specialRank(a) - specialRank(b))
  }, [rows, pinning])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ordered.filter((r) => {
      if (stageFilter !== 'all' && r.stage !== stageFilter) return false
      if (flag === 'special' && !r.specialRequest) return false
      if (flag === 'hold' && !r.onHold) return false
      if (flag === 'vip' && !isVip(r)) return false
      if (flag === 'unpicked' && r.pick.total > 0 && r.pick.checked >= r.pick.total) return false
      if (flag === 'unpicked' && r.pick.total === 0) return false
      if (flag === 'giveaway' && !r.hasGiveaway) return false
      if (flag === 'untracked' && r.trackingNumber) return false
      if (!q) return true
      return (
        r.customer.handle.toLowerCase().includes(q) ||
        r.customer.realName.toLowerCase().includes(q) ||
        r.customer.address.toLowerCase().includes(q) ||
        (r.trackingNumber ?? '').toLowerCase().includes(q) ||
        r.orderIds.some((id) => id.toLowerCase().includes(q)) ||
        r.breaks.some(
          (b) =>
            `break #${b.breakNumber ?? ''}`.includes(q) ||
            b.teams.some((t) => t.teamName.toLowerCase().includes(q))
        )
      )
    })
  }, [ordered, query, stageFilter, flag, isVip])

  const stageCounts = useMemo(() => {
    const counts = Object.fromEntries(SHIP_STAGES.map((s) => [s, 0])) as Record<
      ShipFulfillmentStage,
      number
    >
    for (const r of rows) counts[r.stage] += 1
    return counts
  }, [rows])

  const totals = useMemo(
    () => ({
      packages: visible.length,
      cards: visible.reduce((n, r) => n + r.cardCount, 0),
      value: visible.reduce((n, r) => n + r.value, 0),
      picked: visible.reduce((n, r) => n + r.pick.checked, 0)
    }),
    [visible]
  )

  // ---- Mutations -----------------------------------------------------------
  const guard = useCallback(async <T,>(id: string, run: () => Promise<T>): Promise<T> => {
    setBusyId(id)
    try {
      return await run()
    } finally {
      setBusyId(null)
    }
  }, [])

  const setStage = useCallback(
    async (row: ShipOrderRow, stage: ShipFulfillmentStage) => {
      await guard(row.id, async () => {
        const res = await api.shipping.setStage(row.id, stage)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not change the stage.')
          return
        }
        applyRow(res.data)
        await onChangedRef.current()
      })
    },
    [applyRow, guard, toast]
  )

  // Check a single card off from inside the order — the same slot the Checker
  // flips, so both views stay in step. Patched locally first so the click feels
  // instant, then reconciled from the row the backend returns.
  const toggleSlot = useCallback(
    async (slotId: string, checked: boolean) => {
      setSlotBusy(slotId)
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          breaks: r.breaks.map((b) => ({
            ...b,
            teams: b.teams.map((t) => (t.slotId === slotId ? { ...t, checkedOff: checked } : t))
          }))
        }))
      )
      try {
        const res = await api.shipping.setSlotChecked(slotId, checked)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not update that card.')
          await reload()
          return
        }
        if (res.data?.order) applyRow(res.data.order)
        await onChangedRef.current()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not update that card.')
        await reload()
      } finally {
        setSlotBusy(null)
      }
    },
    [applyRow, reload, toast]
  )

  const setHold = useCallback(
    async (row: ShipOrderRow, onHold: boolean, reason: string | null) => {
      await guard(row.id, async () => {
        const res = await api.shipping.setHold(row.id, onHold, reason)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not change the hold.')
          return
        }
        applyRow(res.data)
        setEditor(null)
        await onChangedRef.current()
      })
    },
    [applyRow, guard, toast]
  )

  const move = useCallback(
    async (row: ShipOrderRow, direction: 'up' | 'down') => {
      await guard(row.id, async () => {
        const res = await api.shipping.moveOrder(row.id, direction)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not move the package.')
          return
        }
        // A swap changes two positions, so the whole ordered queue comes back.
        setRows(res.data)
      })
    },
    [guard, toast]
  )

  const saveSpecial = useCallback(
    async (row: ShipOrderRow, text: string) => {
      await guard(row.id, async () => {
        const res = await api.shipping.setSpecialRequest(row.id, text)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not save the request.')
          return
        }
        applyRow(res.data)
        setEditor(null)
        await onChangedRef.current()
      })
    },
    [applyRow, guard, toast]
  )

  const saveNotes = useCallback(
    async (row: ShipOrderRow, notes: string) => {
      await guard(row.id, async () => {
        const res = await api.shipping.setOrderNotes(row.id, notes)
        if (!res.ok || !res.data) {
          toast.error(res.error ?? 'Could not save the note.')
          return
        }
        applyRow(res.data)
        setEditor(null)
      })
    },
    [applyRow, guard, toast]
  )

  const resetQueue = useCallback(async () => {
    const res = await api.shipping.resetQueue()
    if (!res.ok || !res.data) {
      toast.error(res.error ?? 'Could not reset the queue.')
      return
    }
    setRows(res.data)
    toast.success('Queue reset to import order.')
  }, [toast])

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

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

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="ClipboardList"
        title="No packages yet"
        message="Import a Whatnot packing-slip PDF and every customer's package shows up here as one row."
        action={
          <Button variant="primary" icon="UploadCloud" onClick={() => onGoTo('setup')}>
            Go to Upload
          </Button>
        }
      />
    )
  }

  const allExpanded = visible.length > 0 && visible.every((r) => expanded.has(r.id))

  return (
    <div className="ship-page">
      <div className="ship-toolbar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={16} />
          <input
            placeholder="Search handle, name, address, order id, tracking or team…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="ts-clear" title="Clear" onClick={() => setQuery('')}>
              <Icon name="X" size={14} />
            </button>
          )}
        </div>

        <Select
          className="ship-filter"
          value={flag}
          onChange={(e) => setFlag(e.target.value as FlagFilter)}
        >
          {(Object.keys(FLAG_LABELS) as FlagFilter[]).map((f) => (
            <option key={f} value={f}>
              {FLAG_LABELS[f]}
            </option>
          ))}
        </Select>

        <div className="ship-toolbar-right">
          <button className="ship-vip-btn" onClick={() => setShowVip(true)} title="VIP highlight">
            <Icon name="Crown" size={15} />
            VIP
          </button>
          {canManage && (
            <Button size="sm" icon="RotateCcw" onClick={resetQueue}>
              Reset queue
            </Button>
          )}
          <Button
            size="sm"
            icon={allExpanded ? 'ChevronUp' : 'ChevronDown'}
            onClick={() =>
              setExpanded(allExpanded ? new Set() : new Set(visible.map((r) => r.id)))
            }
          >
            {allExpanded ? 'Collapse' : 'Expand'} all
          </Button>
        </div>
      </div>

      <div className="ship-stage-bar">
        <button
          className={`ship-stage-chip ${stageFilter === 'all' ? 'active' : ''}`}
          onClick={() => setStageFilter('all')}
        >
          All <span className="mono">{rows.length}</span>
        </button>
        {SHIP_STAGES.map((s) => (
          <button
            key={s}
            data-stage={s}
            className={`ship-stage-chip ${stageFilter === s ? 'active' : ''}`}
            onClick={() => setStageFilter(stageFilter === s ? 'all' : s)}
          >
            {SHIP_STAGE_LABELS[s]} <span className="mono">{stageCounts[s]}</span>
          </button>
        ))}
        <span className="spacer" />
        <span className="ship-totals">
          <b className="mono">{totals.packages}</b> packages ·{' '}
          <b className="mono">{totals.cards}</b> cards ·{' '}
          <b className="mono">
            {totals.picked}/{totals.cards}
          </b>{' '}
          picked ·{' '}
          <b className="mono ship-total-money">{formatMoney(totals.value)}</b>
        </span>
      </div>

      {specialCount > 0 && (
        <div className="ship-special-strip">
          <Icon name="Megaphone" size={15} />
          <span>
            <b>
              {specialCount} special request{specialCount === 1 ? '' : 's'}
            </b>{' '}
            on this queue.
          </span>
          <label className="ship-pin-toggle">
            <input
              type="checkbox"
              checked={pinSpecial}
              onChange={(e) => {
                setPinSpecial(e.target.checked)
                localStorage.setItem(PIN_KEY, e.target.checked ? '1' : '0')
              }}
            />
            Pin to top
          </label>
          <button className="link-btn" onClick={() => setFlag('special')}>
            Show only these
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon="Search"
          title="Nothing matches"
          message="No package matches the current search and filters."
          action={
            <Button
              icon="X"
              onClick={() => {
                setQuery('')
                setFlag('all')
                setStageFilter('all')
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="ship-orders">
          {visible.map((row) => (
            <OrderRow
              key={row.id}
              row={row}
              pos={groupPos.get(row.id)}
              vip={isVip(row)}
              pinning={pinning}
              canManage={canManage}
              canFind={canFind}
              canPack={canPack}
              busy={busyId === row.id}
              expanded={expanded.has(row.id)}
              onToggle={() => toggleExpanded(row.id)}
              onStage={(s) => setStage(row, s)}
              onMove={(d) => move(row, d)}
              onHoldOff={() => setHold(row, false, null)}
              onEdit={(kind) => setEditor({ kind, row })}
              slotBusy={slotBusy}
              onToggleSlot={toggleSlot}
            />
          ))}
        </div>
      )}

      {showVip && (
        <Modal
          title="VIP / big-spender highlight"
          subtitle="Local to this computer — it changes what you see, never the data."
          onClose={() => setShowVip(false)}
          footer={<Button variant="primary" onClick={() => setShowVip(false)}>Done</Button>}
        >
          <div className="ship-vip-form">
            <Checkbox
              checked={vipTop20}
              onChange={(v) => {
                setVipTop20(v)
                localStorage.setItem(VIP_TOP_KEY, v ? '1' : '0')
              }}
              label={`Highlight the top 20% by value${
                Number.isFinite(vipCutoff) ? ` (currently ${formatMoney(vipCutoff)} and up)` : ''
              }`}
            />
            <Field
              label="Manual threshold"
              hint="Any package at or above this value is highlighted too. 0 turns it off."
            >
              <Input
                type="number"
                min={0}
                step="5"
                value={vipThreshold || ''}
                placeholder="0"
                onChange={(e) => {
                  const v = Number(e.target.value) || 0
                  setVipThreshold(v)
                  localStorage.setItem(VIP_THRESHOLD_KEY, String(v))
                }}
              />
            </Field>
            <p className="muted text-sm">
              {rows.filter(isVip).length} of {rows.length} packages are highlighted right now.
            </p>
          </div>
        </Modal>
      )}

      {editor && (
        <EditorModal
          key={`${editor.kind}:${editor.row.id}`}
          state={editor}
          busy={busyId === editor.row.id}
          onClose={() => setEditor(null)}
          onHold={(reason) => setHold(editor.row, true, reason)}
          onSpecial={(text) => saveSpecial(editor.row, text)}
          onNotes={(notes) => saveNotes(editor.row, notes)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// One package
// ---------------------------------------------------------------------------

function OrderRow({
  row,
  pos,
  vip,
  pinning,
  canManage,
  canFind,
  canPack,
  busy,
  expanded,
  onToggle,
  onStage,
  onMove,
  onHoldOff,
  onEdit,
  slotBusy,
  onToggleSlot
}: {
  row: ShipOrderRow
  pos?: { index: number; size: number }
  vip: boolean
  pinning: boolean
  canManage: boolean
  /** Tick a card off inside the package — the same act the Checker performs. */
  canFind: boolean
  /** Advance the package through its fulfilment stages. */
  canPack: boolean
  busy: boolean
  expanded: boolean
  onToggle: () => void
  onStage: (stage: ShipFulfillmentStage) => void
  onMove: (direction: 'up' | 'down') => void
  onHoldOff: () => void
  onEdit: (kind: 'hold' | 'special' | 'notes') => void
  /** slotId currently being written, so its row can show as busy. */
  slotBusy: string | null
  onToggleSlot: (slotId: string, checked: boolean) => void
}): JSX.Element {
  const pickPct = row.pick.total > 0 ? Math.round((row.pick.checked / row.pick.total) * 100) : 0
  const fullyPicked = row.pick.total > 0 && row.pick.checked >= row.pick.total
  const moveTitle = pinning
    ? 'Turn off “Pin to top” to reorder the queue.'
    : row.onHold
      ? 'Held packages reorder within the held group.'
      : undefined

  return (
    <div
      className={`ship-order ${busy ? 'busy' : ''}`}
      data-stage={row.stage}
      data-hold={row.onHold ? 'true' : undefined}
      data-special={row.specialRequest ? 'true' : undefined}
      data-vip={vip ? 'true' : undefined}
    >
      {row.specialRequest && (
        <div className="ship-special">
          <Icon name="Megaphone" size={14} />
          <span className="ship-special-text">{row.specialRequest.text}</span>
          <span className="ship-special-meta">
            {row.specialRequest.setBy ? `${row.specialRequest.setBy} · ` : ''}
            {formatDateTime(row.specialRequest.setAt)}
          </span>
          {canManage && (
            <button className="link-btn" onClick={() => onEdit('special')}>
              Edit
            </button>
          )}
        </div>
      )}

      <div className="ship-order-main">
        {/* Arrows only — the queue position is a number the operator never
            needs to read, so it is not printed. Reordering is unchanged. */}
        <div className="sor-rank">
          <button
            className="sor-arrow"
            title={moveTitle ?? 'Move up'}
            disabled={!canManage || pinning || !pos || pos.index === 0}
            onClick={() => onMove('up')}
          >
            <Icon name="ArrowUp" size={13} strokeWidth={2.4} />
          </button>
          <button
            className="sor-arrow"
            title={moveTitle ?? 'Move down'}
            disabled={!canManage || pinning || !pos || pos.index >= pos.size - 1}
            onClick={() => onMove('down')}
          >
            <Icon name="ArrowDown" size={13} strokeWidth={2.4} />
          </button>
        </div>

        <div className="sor-body">
          <div className="sor-head">
            <button className="sor-handle" onClick={onToggle} title="Show the cards">
              <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={15} />
              @{row.customer.handle}
            </button>
            <span className="sor-name">{row.customer.realName || '—'}</span>
            {row.customer.isNew && <span className="ship-chip info">NEW</span>}
            {vip && (
              <span className="ship-chip vip">
                <Icon name="Crown" size={12} /> VIP
              </span>
            )}
            {row.multiCard && (
              <span className="ship-chip cards" title={`${row.cardCount} cards in this package`}>
                <Icon name="SquareStack" size={12} /> {row.cardCount} cards
              </span>
            )}
            {row.hasGiveaway && (
              <span className="ship-chip gift" title={`${row.giveawayCount} giveaway card(s)`}>
                <Icon name="Gift" size={12} /> {row.giveawayCount}
              </span>
            )}
            {row.topSleevedCount > 0 && (
              <span className="ship-chip sticker" title="Top-sleeved cards">
                <Icon name="Sticker" size={12} /> {row.topSleevedCount}
              </span>
            )}
            {row.onHold && (
              <span className="ship-chip warn" title={row.heldReason ?? undefined}>
                <Icon name="PauseCircle" size={12} /> On hold
                {row.heldReason ? ` — ${row.heldReason}` : ''}
              </span>
            )}
          </div>

          <div className="sor-addr" title={row.customer.address}>
            {row.customer.address || 'No address on the slip'}
          </div>

          <div className="sor-meta">
            <span className={`sor-pick ${fullyPicked ? 'done' : ''}`} title="Cards checked off">
              <span className="sor-pick-bar">
                <span className="sor-pick-fill" style={{ width: `${pickPct}%` }} />
              </span>
              <span className="mono">
                {row.pick.checked}/{row.pick.total}
              </span>
            </span>

            <span className="sor-breaks">
              {row.breaks.length === 0 ? (
                <span className="muted">No cards</span>
              ) : (
                // data-accent is the break's position WITHIN this package, so two
                // breaks on one row can never be confused. It deliberately does
                // not mean the same colour across packages.
                row.breaks.map((b, i) => (
                  <span className="sor-break-chip" data-accent={String(i % 6)} key={b.breakId}>
                    {b.breakNumber == null ? 'Giveaway' : `#${b.breakNumber}`}
                    <em className="mono">{b.total}</em>
                  </span>
                ))
              )}
            </span>

            {row.notes && (
              <div className="sor-note">
                <Icon name="StickyNote" size={13} />
                {row.notes}
              </div>
            )}
          </div>
        </div>

        <div className="sor-side">
          <span className="sor-value mono">{formatMoney(row.value)}</span>
          {/* The one-click move an operator makes all day: picked -> put together.
              Once it IS put together the button flips to the next step (Sent), so
              the row always offers the obvious next action without hunting in the
              dropdown. */}
          {canPack && (row.stage === 'to_pick' || row.stage === 'put_together') && (
            <button
              type="button"
              className={`sor-advance ${row.stage === 'put_together' ? 'next' : ''}`}
              disabled={busy}
              title={
                row.stage === 'to_pick'
                  ? fullyPicked
                    ? 'Mark this package put together'
                    : `Mark put together (${row.pick.checked}/${row.pick.total} picked)`
                  : 'Mark this package sent'
              }
              onClick={() => onStage(row.stage === 'to_pick' ? 'put_together' : 'sent')}
            >
              <Icon name={row.stage === 'to_pick' ? 'PackageCheck' : 'Truck'} size={14} />
              {row.stage === 'to_pick' ? 'Put together' : 'Mark sent'}
            </button>
          )}
          <Select
            className="ship-stage-select"
            data-stage={row.stage}
            value={row.stage}
            disabled={!canPack || busy}
            onChange={(e) => onStage(e.target.value as ShipFulfillmentStage)}
          >
            {SHIP_STAGES.map((s) => (
              <option key={s} value={s}>
                {SHIP_STAGE_LABELS[s]}
              </option>
            ))}
          </Select>
          <div className="sor-actions">
            <button
              className={`sor-act ${row.onHold ? 'on' : ''}`}
              title={row.onHold ? 'Release the hold' : 'Put this package on hold'}
              disabled={!canManage || busy}
              onClick={() => (row.onHold ? onHoldOff() : onEdit('hold'))}
            >
              <Icon name="PauseCircle" size={15} />
            </button>
            <button
              className={`sor-act ${row.specialRequest ? 'alert' : ''}`}
              title="Special request"
              disabled={!canManage || busy}
              onClick={() => onEdit('special')}
            >
              <Icon name="Megaphone" size={15} />
            </button>
            <button
              className={`sor-act ${row.notes ? 'on' : ''}`}
              title="Note"
              disabled={!canManage || busy}
              onClick={() => onEdit('notes')}
            >
              <Icon name="StickyNote" size={15} />
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="sor-expand">
          {row.breaks.length === 0 ? (
            <div className="sor-empty-cards">
              This package has no cards — a giveaway-only or empty order.
            </div>
          ) : (
            // Same accent index as the collapsed chip above, so the chip and the
            // expanded block for one break read as the same thing.
            row.breaks.map((b, i) => (
              <div className="sor-break" data-accent={String(i % 6)} key={b.breakId}>
                <div className="sor-break-head">
                  <span className="sor-break-title">
                    {b.breakNumber == null ? (
                      <>
                        <Icon name="Gift" size={14} /> Giveaway (no break)
                      </>
                    ) : (
                      <>
                        <Icon name="Layers" size={14} /> Break #{b.breakNumber}
                      </>
                    )}
                  </span>
                  <span className="sor-break-prog mono">
                    {b.checked}/{b.total} picked
                  </span>
                  <span className="sor-break-val mono">{formatMoney(b.value)}</span>
                </div>
                <div className="sor-teams">
                  {b.teams.map((t) => (
                    <button
                      type="button"
                      className={`sor-team ${t.checkedOff ? 'checked' : ''}`}
                      key={t.slotId}
                      disabled={!canFind || slotBusy === t.slotId}
                      aria-pressed={t.checkedOff}
                      title={
                        canFind
                          ? t.checkedOff
                            ? `Uncheck ${t.teamName}`
                            : `Check off ${t.teamName}`
                          : undefined
                      }
                      onClick={() => onToggleSlot(t.slotId, !t.checkedOff)}
                    >
                      <span className="sor-team-check">
                        <Icon
                          name={t.checkedOff ? 'CheckCircle2' : 'CircleDot'}
                          size={14}
                          strokeWidth={t.checkedOff ? 2.4 : 2}
                        />
                      </span>
                      <span className="sor-team-name">{t.teamName}</span>
                      {t.isGiveaway && (
                        <span className="ship-chip mini">
                          <Icon name="Gift" size={11} /> Giveaway
                        </span>
                      )}
                      {t.topSleeved && (
                        <span className="ship-chip mini">
                          <Icon name="Sticker" size={11} /> Top-sleeved
                        </span>
                      )}
                      {/* Checked reads as checked: the glyph fills and the row
                          changes colour. No stamp, no id, nothing numeric. */}
                      <span className="sor-team-price mono">{formatMoney(t.price)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}

          {/* No address here: .sor-addr already prints it two inches above, and
              saying it twice on one row is exactly the clutter this pass is
              removing. Only what the row does NOT already show belongs here. */}
          <div className="sor-footer">
            {row.weightOz != null && (
              <span>
                <Icon name="Package" size={13} /> {row.weightOz} oz
              </span>
            )}
            {row.carrier && (
              <span>
                <Icon name="Truck" size={13} /> {row.carrier}
              </span>
            )}
            {row.packedAt && (
              <span>
                <Icon name="PackageCheck" size={13} /> Packed {formatDateTime(row.packedAt)}
                {row.packedBy ? ` by ${row.packedBy}` : ''}
              </span>
            )}
            {row.manualStatus.setAt && (
              <span>
                <Icon name="Clock" size={13} /> Status set {formatDateTime(row.manualStatus.setAt)}
                {row.manualStatus.setBy ? ` by ${row.manualStatus.setBy}` : ''}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hold / special request / note editors
// ---------------------------------------------------------------------------

function EditorModal({
  state,
  busy,
  onClose,
  onHold,
  onSpecial,
  onNotes
}: {
  state: EditorState
  busy: boolean
  onClose: () => void
  onHold: (reason: string | null) => void
  onSpecial: (text: string) => void
  onNotes: (notes: string) => void
}): JSX.Element {
  const { kind, row } = state
  const [value, setValue] = useState(
    kind === 'hold'
      ? row.heldReason ?? ''
      : kind === 'special'
        ? row.specialRequest?.text ?? ''
        : row.notes ?? ''
  )

  const title =
    kind === 'hold' ? 'Hold this package' : kind === 'special' ? 'Special request' : 'Package note'
  const subtitle =
    kind === 'hold'
      ? `@${row.customer.handle} sinks to the bottom of the queue until released.`
      : kind === 'special'
        ? `@${row.customer.handle} — the row turns red and pins to the top. Empty clears it.`
        : `@${row.customer.handle} — an internal note on this package.`

  const submit = (): void => {
    if (kind === 'hold') onHold(value.trim() || null)
    else if (kind === 'special') onSpecial(value.trim())
    else onNotes(value)
  }

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {kind === 'special' && row.specialRequest && (
            <Button variant="danger" icon="Eraser" loading={busy} onClick={() => onSpecial('')}>
              Clear request
            </Button>
          )}
          <Button
            variant={kind === 'hold' ? 'danger' : 'primary'}
            icon={kind === 'hold' ? 'PauseCircle' : 'Check'}
            loading={busy}
            onClick={submit}
          >
            {kind === 'hold' ? 'Hold package' : 'Save'}
          </Button>
        </>
      }
    >
      <Field
        label={kind === 'hold' ? 'Reason (optional)' : kind === 'special' ? 'Request' : 'Note'}
      >
        {kind === 'hold' ? (
          <Input
            autoFocus
            value={value}
            placeholder="Waiting on a replacement card"
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <Textarea
            autoFocus
            rows={4}
            value={value}
            placeholder={
              kind === 'special'
                ? 'Ship in a team bag, add the extra hit…'
                : 'Anything the next person should know'
            }
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
    </Modal>
  )
}
