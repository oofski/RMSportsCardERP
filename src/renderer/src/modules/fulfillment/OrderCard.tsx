import type { ShipOrderRow } from '@shared/shippingViews'
import { SHIP_STAGE_LABELS } from '@shared/shippingViews'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { BreakChip } from './BreakChip'

/**
 * ONE order, the way this app draws an order — everywhere.
 *
 * There used to be two of these. The Orders tab's "one order at a time" drew the
 * customer, their address, every break and every team as a tickable line; the
 * bench you reach from step 5 drew a handle, a name and "3/12 cards". Same job,
 * same night, same person walking between the two screens — and the one they
 * were sent to by the checklist was the one that did not say WHICH teams to
 * gather. The list was in the PDF and nowhere else.
 *
 * So the pane is a component rather than a layout, and both screens mount it.
 * That is the whole point: not that the two look similar today, but that they
 * cannot drift apart again, because there is only one of them.
 *
 * What each screen still owns is what surrounds it — the bar above and what the
 * buttons in it do. A picker walking the run needs search and Previous; a packer
 * at a bench must never see the night's list at all. Those are genuinely
 * different screens. The order in the middle of them is not.
 *
 * `banner` sits under the head, above the cards: for the bench, a packer's
 * rejection reason, which has to be read BEFORE the picking starts rather than
 * discovered after. `footer` is for anything a screen wants below the cards;
 * both are optional and neither is used by the walker.
 */
export function OrderCard({
  order,
  canAct,
  busySlot,
  onToggleSlot,
  actLabel,
  banner,
  footer
}: {
  order: ShipOrderRow
  /** May this person tick a team off? A packer verifying a box may not. */
  canAct: boolean
  /** The slot mid-save, so only that one line goes inert. */
  busySlot: string | null
  onToggleSlot: (slotId: string, checked: boolean) => void | Promise<void>
  /** Why ticking is unavailable, when it is. Shown as the line's tooltip. */
  actLabel?: string
  banner?: JSX.Element | null
  footer?: JSX.Element | null
}): JSX.Element {
  const done = order.pick.checked >= order.pick.total
  const noActReason = actLabel ?? 'You do not have permission to check cards off.'

  return (
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
        {order.customer.pages && order.customer.pages.length > 1 && (
          <span
            className="ship-chip mini"
            title="This order's slip runs onto more than one page — the whole run is on the right"
          >
            <Icon name="Copy" size={11} /> {order.customer.pages.length}-page slip
          </span>
        )}
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

      {banner}

      {/* The cards, grouped the way the slip groups them: by break. */}
      <div className="walk-breaks">
        {order.breaks.map((b) => (
          <div className="walk-break" key={b.breakId}>
            <div className="walk-break-head">
              {/* A group with no break label is one of TWO things, and calling
                  both of them "Giveaway" told a picker that a card they have to
                  go and find in a break was a free rider from the promo pile.
                  A giveaway is free; a loose card has a price on it and the
                  slip simply never said which break it came out of. */}
              {b.breakLabel == null ? (
                b.teams.every((t) => t.isGiveaway) ? (
                  <span className="ship-chip mini">
                    <Icon name="Gift" size={11} /> Giveaway
                  </span>
                ) : (
                  <span
                    className="ship-chip mini warn"
                    title="The slip did not say which break these came from. Check the paper on the right."
                  >
                    <Icon name="AlertTriangle" size={11} /> No break on the slip
                  </span>
                )
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
                  disabled={!canAct || busySlot === t.slotId}
                  aria-pressed={t.checkedOff}
                  title={
                    canAct
                      ? t.checkedOff
                        ? `Un-check ${t.teamName}`
                        : `Check off ${t.teamName}`
                      : noActReason
                  }
                  onClick={() => void onToggleSlot(t.slotId, !t.checkedOff)}
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

      {footer}
    </div>
  )
}
