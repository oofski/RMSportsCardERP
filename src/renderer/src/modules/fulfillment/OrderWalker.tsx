import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ShipOrderRow } from '@shared/shippingViews'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { OrderCard } from './OrderCard'
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
 * ## Moving on IS the confirmation
 *
 * Somebody at a bench has the customer's cards in front of them, the slip beside
 * them, and the whole order in hand. Asking them to tick forty-seven boxes and
 * THEN press Next asks them to do the job twice, and the second time is the one
 * that gets skipped — after which the board says cards are still out that are
 * already in a box.
 *
 * So the primary button picks the order and moves on, in that order, and says
 * so. Already-ticked cards keep their attribution and timestamp: walking past a
 * package never rewrites who found what. Skip is there for the times the answer
 * is "not this one" — a card missing, a hold, a question — and it moves without
 * claiming anything.
 *
 * `mode` decides what the pane is FOR, not how it looks:
 *   pick  — the cards are check targets, and "still to pick" is the default run
 *   mail  — the cards are a manifest to verify against the box, and the address
 *           and tracking come forward
 */
export type WalkerMode = 'pick' | 'mail'

/** Stable identity, so an order with no known pages does not re-trigger draws. */
const EMPTY_PAGES: number[] = []

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
  /**
   * WHICH ORDER IS ON SCREEN, by id.
   *
   * It used to be a position, and a position is not a thing to hold on to here:
   * the list this screen walks is filtered and it reloads under the operator's
   * hands. Three separate faults came out of that, all with the same shape —
   * the pane silently becomes a DIFFERENT customer while somebody is holding
   * the first one's cards:
   *
   *   · Ticking the last card of an order finished it, so the filter dropped it
   *     and index 2 quietly became the next buyer. No button was pressed.
   *   · A second person finishing an EARLIER order shifted everything after it
   *     down one, so this screen moved on its own, mid-package.
   *   · Finishing the last order in the run clamped the index down and landed
   *     on the order just skipped past — Next moving backwards.
   *
   * An id cannot drift. The anchored order is also exempt from the "only orders
   * with cards left" filter, so finishing it does not remove it from under the
   * cursor; it stays until somebody deliberately moves.
   */
  const [anchorId, setAnchorId] = useState<string | null>(null)
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
      // THE ANCHORED ORDER IS NEVER FILTERED OUT. Somebody who ticks the last
      // card of the package in their hands has finished it, not left it — and
      // dropping it from the list at that moment is what used to swap the whole
      // pane, cards and slip, to the next buyer with no button pressed.
      if (onlyOpen && o.pick.checked >= o.pick.total && o.customerId !== anchorId) return false
      if (!q) return true
      return (
        o.customer.handle.toLowerCase().includes(q) ||
        o.customer.realName.toLowerCase().includes(q) ||
        o.orderIds.some((id) => id.toLowerCase().includes(q)) ||
        (o.trackingNumber ?? '').toLowerCase().includes(q)
      )
    })
  }, [orders, onlyOpen, query, anchorId])

  // Position follows the anchor, not the other way round. `cursor` survives only
  // to place the anchor on the first render and after a search empties the run.
  const anchorIndex = anchorId ? run.findIndex((o) => o.customerId === anchorId) : -1
  const index =
    anchorIndex >= 0 ? anchorIndex : run.length === 0 ? 0 : Math.min(cursor, run.length - 1)
  const order = run[index] ?? null

  // Adopt whatever the position resolved to, so every later move is by id.
  useEffect(() => {
    if (!order) {
      if (anchorId !== null) setAnchorId(null)
      return
    }
    if (order.customerId !== anchorId) setAnchorId(order.customerId)
    if (cursor !== index) setCursor(index)
  }, [order, anchorId, cursor, index])

  const step = useCallback(
    (by: number) => {
      if (run.length === 0) return
      const from = anchorIndex >= 0 ? anchorIndex : Math.min(cursor, run.length - 1)
      let next = from + by
      if (next < 0) next = run.length - 1
      if (next >= run.length) next = 0
      setAnchorId(run[next].customerId)
      setCursor(next)
    },
    [run, anchorIndex, cursor]
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

  /**
   * Pick everything in this package, then move on.
   *
   * `onlyUnchecked` is what makes this repeatable and safe: a card somebody else
   * already found keeps their name and their timestamp on it.
   */
  const pickAllAndAdvance = async (): Promise<void> => {
    if (!order) return
    const left = order.pick.total - order.pick.checked
    // WHERE TO GO NEXT, decided from the list as it stands NOW.
    //
    // Before the reload, because the reload reshuffles: the destination has to
    // be the order the operator can see below this one, not whatever ends up at
    // some index afterwards. That is also the whole of the old "only step when
    // the filter is off" special case, which existed because the list moved —
    // it cannot move under an id, so the rule is simply "go to the next one".
    //
    // Null when this was the last of the work, which lets the anchor clear and
    // the run empty out to the "every card is picked" state instead of wrapping
    // silently to the top of the night.
    const at = run.findIndex((o) => o.customerId === order.customerId)
    const nextId =
      (run.slice(at + 1).find((o) => o.customerId !== order.customerId) ??
        run.slice(0, Math.max(at, 0)).find((o) => o.customerId !== order.customerId))
        ?.customerId ?? null
    setBusy('order')
    try {
      if (left > 0) {
        const res = await api.shipping.setOrderChecked(order.customerId, true, true)
        if (!res.ok) {
          toast.error(res.error ?? 'Could not mark that package picked.')
          return
        }
        toast.success(
          `@${order.customer.handle}: ${left} card${left === 1 ? '' : 's'} picked.`
        )
      }
      await load()
      await onChanged()
      setAnchorId(nextId)
    } finally {
      setBusy(null)
    }
  }

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

  // EVERY page of this order's slip. A big order runs on — one buyer's 47 cards
  // took five pages — and showing only the first is worse than showing none,
  // because a short list that looks complete gets agreed with and sealed.
  const slipPages = order?.customer.pages ?? EMPTY_PAGES

  return (
    <div className="walk-page">
      <div className="walk-bar">
        <div className="topsearch ship-search">
          <Icon name="Search" size={15} />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setAnchorId(null)
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
          {/* Skip moves without claiming anything — for a card that is missing,
              a hold, or a question somebody has to come back to. */}
          <Button size="sm" onClick={() => step(1)} disabled={run.length < 2}>
            Skip
          </Button>
          {mode === 'pick' ? (
            <Button
              size="sm"
              variant="primary"
              icon="CheckCheck"
              loading={busy === 'order'}
              disabled={!order || !canAct || order.onHold}
              title={
                order?.onHold
                  ? 'This package is on hold. Skip past it, or have the hold lifted first.'
                  : canAct
                    ? 'Mark every card in this package picked, then go to the next order'
                    : 'You do not have permission to check cards off.'
              }
              onClick={() => void pickAllAndAdvance()}
            >
              {order?.onHold ? 'On hold' : 'Picked · next order'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              icon="ChevronRight"
              onClick={() => step(1)}
              disabled={run.length < 2}
            >
              Next order
            </Button>
          )}
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
          <OrderCard
            order={order}
            canAct={canAct}
            busySlot={busy}
            onToggleSlot={toggleSlot}
          />

          <SlipPane pages={slipPages} label={`@${order.customer.handle}`} />
        </div>
      )}
    </div>
  )
}
