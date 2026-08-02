import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShipOrderRow } from '@shared/shippingViews'
import { SHIP_STAGE_LABELS } from '@shared/shippingViews'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import { BreakChip } from './BreakChip'
import { SlipPane } from './SlipPane'

/**
 * One order at a time, with the customer's own slip open beside it.
 *
 * The break view answers "I have break 12's thirty cards, whose are they". This
 * answers the other half of the same night: "I am building ONE person's package
 * — what am I putting in it, and does it match what they actually bought". Both
 * are real jobs on the same data, and the second one had no screen at all.
 *
 * The layout is deliberate. Cards on the left because that is what gets touched;
 * paper on the right because it is the reference, not the work. Next/Previous
 * move both together, which is the entire point — the operator never hunts for
 * a page number, and the paper can never drift out of step with the list.
 *
 * `mode` decides what the pane is FOR, not how it looks:
 *   pick  — the cards are check targets, and "still to pick" is the default run
 *   mail  — the cards are a manifest to verify against the box, and the address
 *           and tracking come forward
 */
export type WalkerMode = 'pick' | 'mail'

export function OrderWalker({
  mode,
  canAct,
  onChanged
}: {
  mode: WalkerMode
  canAct: boolean
  onChanged: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [orders, setOrders] = useState<ShipOrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(0)
  const [query, setQuery] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(mode === 'pick')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    setOrders(await api.shipping.orders())
  }, [])

  useLiveRefresh(LIVE.shipping, load)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  /**
   * The run being walked.
   *
   * "Only orders with cards left" is on by default for picking, because the
   * point of Next is to reach the next thing to do — not to march past forty
   * finished packages first. It is a filter on the RUN, never on the counts: a
   * package that finishes while you are on it stays put until you move.
   */
  const run = useMemo(() => {
    const q = query.trim().toLowerCase()
    return orders.filter((o) => {
      if (onlyOpen && o.pick.checked >= o.pick.total) return false
      if (!q) return true
      return (
        o.customer.handle.toLowerCase().includes(q) ||
        o.customer.realName.toLowerCase().includes(q) ||
        o.orderIds.some((id) => id.toLowerCase().includes(q)) ||
        (o.trackingNumber ?? '').toLowerCase().includes(q)
      )
    })
  }, [orders, onlyOpen, query])

  // The cursor is an index into a list that shrinks under it — clamp rather
  // than reset, so finishing an order lands you on the next one rather than
  // back at the top of the night.
  const index = run.length === 0 ? 0 : Math.min(cursor, run.length - 1)
  const order = run[index] ?? null

  useEffect(() => {
    if (cursor !== index) setCursor(index)
  }, [cursor, index])

  const step = useCallback(
    (by: number) => {
      setCursor((c) => {
        if (run.length === 0) return 0
        const next = c + by
        if (next < 0) return run.length - 1
        return next >= run.length ? 0 : next
      })
    },
    [run.length]
  )

  // Arrow keys and J/K walk the run. A bench operator has cards in one hand.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.key === 'ArrowRight' || e.key === 'j') step(1)
      else if (e.key === 'ArrowLeft' || e.key === 'k') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  const toggleSlot = async (slotId: string, checked: boolean): Promise<void> => {
    setBusy(slotId)
    try {
      const res = await api.shipping.setSlotChecked(slotId, checked)
      if (!res.ok) {
        toast.error(res.error ?? 'That did not save.')
        return
      }
      await load()
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <CenterLoader />

  if (orders.length === 0) {
    return (
      <EmptyState
        icon="Package"
        title="No packages"
        message="Import tonight's packing slips and every order becomes a stop on this list."
      />
    )
  }

  const done = order ? order.pick.checked >= order.pick.total : false
  // A customer's slip can run to several pages; the first is the one with the
  // header, the address and the order lines on it.
  const slipPage = order?.customer.pages?.[0] ?? null

  return (
    <div className="walk-page">
      <div className="walk-bar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={15} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            placeholder="Jump to a username, a name, an order or a tracking number…"
          />
          {query && (
            <button className="ts-clear" onClick={() => setQuery('')} title="Clear">
              <Icon name="X" size={14} />
            </button>
          )}
        </div>
        <label className="ship-pin-toggle">
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={(e) => {
              setOnlyOpen(e.target.checked)
              setCursor(0)
            }}
          />
          {mode === 'pick' ? 'Only orders with cards left' : 'Only orders still to send'}
        </label>
        <span className="walk-count mono">
          {run.length === 0 ? '0 of 0' : `${index + 1} of ${run.length}`}
        </span>
        <div className="walk-nav">
          <Button size="sm" icon="ChevronLeft" onClick={() => step(-1)} disabled={run.length < 2}>
            Previous
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon="ChevronRight"
            onClick={() => step(1)}
            disabled={run.length < 2}
          >
            Next order
          </Button>
        </div>
      </div>

      {!order ? (
        <EmptyState
          icon="CheckCircle2"
          title={
            onlyOpen && query.trim() === ''
              ? mode === 'pick'
                ? 'Every card is picked'
                : 'Every package has gone out'
              : 'Nothing matches'
          }
          message={
            onlyOpen && query.trim() === ''
              ? 'Nothing is left in this run.'
              : 'No package matches that search.'
          }
          action={
            <Button
              icon="X"
              onClick={() => {
                setQuery('')
                setOnlyOpen(false)
              }}
            >
              Show everything
            </Button>
          }
        />
      ) : (
        <div className="walk-split">
          <div className="walk-order" data-done={done ? 'true' : 'false'}>
            <div className="walk-order-head">
              <span className="walk-who">
                <b>{order.customer.realName || '—'}</b>
                <span className="walk-handle">@{order.customer.handle}</span>
                {order.customer.isNew && <span className="ship-chip info mini">NEW</span>}
              </span>
              <span className="ship-chip mini" data-stage={order.stage}>
                {SHIP_STAGE_LABELS[order.stage]}
              </span>
              <span className={`walk-prog mono ${done ? 'done' : ''}`}>
                {order.pick.checked}/{order.pick.total} picked
              </span>
              <span className="walk-value mono">{formatMoney(order.value)}</span>
            </div>

            <div className="walk-meta">
              <span title={order.customer.address}>
                <Icon name="MapPin" size={13} /> {order.customer.address || 'No address on the slip'}
              </span>
              {order.trackingNumber && (
                <span className="mono">
                  <Icon name="Truck" size={13} /> {order.trackingNumber}
                </span>
              )}
              {order.onHold && (
                <span className="ship-chip warn mini">
                  <Icon name="PauseCircle" size={11} /> {order.heldReason || 'On hold'}
                </span>
              )}
              {order.specialRequest && (
                <span className="ship-chip warn mini" title={order.specialRequest.text}>
                  <Icon name="MessageSquare" size={11} /> {order.specialRequest.text}
                </span>
              )}
            </div>

            {/* The cards, grouped the way the slip groups them: by break. */}
            <div className="walk-breaks">
              {order.breaks.map((b) => (
                <div className="walk-break" key={b.breakId}>
                  <div className="walk-break-head">
                    {b.breakLabel == null ? (
                      <span className="ship-chip mini">
                        <Icon name="Gift" size={11} /> Giveaway
                      </span>
                    ) : (
                      <BreakChip label={b.breakLabel} size="sm" />
                    )}
                    <span className="walk-break-count mono">
                      {b.checked}/{b.total}
                    </span>
                    <span className="walk-break-val mono">{formatMoney(b.value)}</span>
                  </div>
                  <div className="walk-teams">
                    {b.teams.map((t) => (
                      <button
                        key={t.slotId}
                        type="button"
                        className={`walk-team ${t.checkedOff ? 'checked' : ''}`}
                        disabled={!canAct || busy === t.slotId}
                        aria-pressed={t.checkedOff}
                        title={
                          canAct
                            ? t.checkedOff
                              ? `Un-check ${t.teamName}`
                              : `Check off ${t.teamName}`
                            : 'You do not have permission to check cards off.'
                        }
                        onClick={() => void toggleSlot(t.slotId, !t.checkedOff)}
                      >
                        <Icon
                          name={t.checkedOff ? 'CheckCircle2' : 'Circle'}
                          size={15}
                          strokeWidth={t.checkedOff ? 2.4 : 1.9}
                        />
                        <span className="walk-team-name">{t.teamName}</span>
                        {t.isGiveaway && <span className="ship-chip mini">Giveaway</span>}
                        <span className="walk-team-price mono">{formatMoney(t.price)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <SlipPane page={slipPage} label={`@${order.customer.handle}`} />
        </div>
      )}
    </div>
  )
}
