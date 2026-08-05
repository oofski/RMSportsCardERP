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

  /**
   * Pick everything in this package, then move on.
   *
   * `onlyUnchecked` is what makes this repeatable and safe: a card somebody else
   * already found keeps their name and their timestamp on it.
   */
  const pickAllAndAdvance = async (): Promise<void> => {
    if (!order) return
    const left = order.pick.total - order.pick.checked
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
      // DO NOT step when the run is filtered. This is the "it goes odds only"
      // bug, and the comment that used to sit here had the reasoning exactly
      // backwards.
      //
      // With "only orders with cards left" on — the default for picking — the
      // order just finished DROPS OUT of the run on reload. The list shrinks
      // under the cursor, so the index the cursor already holds is now the next
      // order. Stepping on top of that advances a second time and walks past
      // one, which is why every other order was being skipped: pick page 1, land
      // on page 3, pick page 3, land on page 5.
      //
      // With the filter off, nothing drops out and the cursor must move, or the
      // button would re-show the order it just finished.
      if (!onlyOpen) step(1)
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
              disabled={!order || !canAct}
              title={
                canAct
                  ? 'Mark every card in this package picked, then go to the next order'
                  : 'You do not have permission to check cards off.'
              }
              onClick={() => void pickAllAndAdvance()}
            >
              Picked · next order
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
