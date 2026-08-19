import { useCallback, useEffect, useState } from 'react'
import type { OrderEvent, OrderSide } from '@shared/orders'
import { describeOrderEvent } from '@shared/orders'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { formatDate } from '../../lib/format'

/**
 * What happened to this order, and who did it.
 *
 * ## Why this exists at all
 *
 * Both boards could already say where an order IS; neither could say how it got
 * there. Every stage column on a purchase order holds one timestamp per stage,
 * so an order dragged to Paid and back to Ordered loses the first answer
 * entirely — and none of them ever recorded a person. The question actually
 * asked on the floor is "who marked this received on Tuesday", and the app's
 * honest answer was that nobody knows.
 *
 * ## Collapsed by default, and at the bottom
 *
 * A history is read when something looks wrong, which is rarely. Open by default
 * it would push the lines and the total — the things somebody opened the
 * document to see — below the fold on every single view, to answer a question
 * almost nobody is asking. So it is a `<details>` at the end: one click, no
 * layout cost, and the summary carries the count so it is obvious there is
 * something in there.
 *
 * `<details>` rather than a state flag because the browser already does this
 * correctly, including keyboard and screen readers, and a hand-rolled accordion
 * is a thing to get wrong for no gain.
 *
 * ## Newest first
 *
 * The thing that looks wrong is the most recent thing. A chronological list
 * would put it at the bottom of a panel somebody has to scroll to reach.
 */
export function OrderHistory({
  side,
  orderId,
  stageLabel
}: {
  side: OrderSide
  orderId: string
  /**
   * How this board names a stage. The two sides do not share a vocabulary —
   * 'received' is a purchase order's word and 'sent' is a sales order's — so the
   * caller supplies the translation rather than this guessing from the side.
   */
  stageLabel: (id: string) => string
}): JSX.Element | null {
  const [events, setEvents] = useState<OrderEvent[] | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!orderId) return
    setEvents(await api.orders.events(side, orderId))
  }, [side, orderId])

  useEffect(() => {
    let active = true
    void (async () => {
      const rows = await api.orders.events(side, orderId)
      if (active) setEvents(rows)
    })()
    return () => {
      active = false
    }
  }, [side, orderId])

  // NOTHING RATHER THAN AN EMPTY PANEL. An order raised before this existed has
  // no history and never will, and a permanently empty accordion on every one of
  // them would read as the feature being broken rather than as there being
  // nothing to show.
  if (!events || events.length === 0) return null

  return (
    <details
      className="ord-log"
      open={open}
      onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open
        setOpen(isOpen)
        // Refreshed on open rather than polled. The panel is shut almost all the
        // time, and a history that quietly reloaded every few seconds behind a
        // closed accordion would be spending a query on nobody.
        if (isOpen) void load()
      }}
    >
      <summary>
        <Icon name="History" size={14} />
        <span>History</span>
        <b>{events.length}</b>
      </summary>
      <ol className="ord-log-list">
        {events.map((event) => (
          <li key={event.id} data-kind={event.kind}>
            <span className="ord-log-what">{describeOrderEvent(event, stageLabel)}</span>
            <span className="ord-log-who">
              {/* An event with no actor is work the app did on its own — an
                  order closing itself when the last box is scanned in. Naming
                  nobody is the correct answer and "the system" is a nicer way to
                  say it than a blank. */}
              {event.actorName ?? 'the app'}
              <span className="ord-log-when">{formatDate(event.createdAt)}</span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  )
}
