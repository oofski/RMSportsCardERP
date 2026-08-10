import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LotPickerData } from '@shared/types'
import {
  allocationIsComplete,
  blendedUnitCost,
  lotLabel,
  minusStep,
  needsLotChoice,
  openLots,
  outstandingQty,
  pickFor,
  pickedCost,
  pickedQty,
  plusStep,
  tidyPicks,
  withPick,
  type CostLot,
  type LotPick
} from '@shared/costLots'
import { quantizationSlack } from '@shared/units'
import { api } from '../../lib/api'
import { formatMoney, formatUnitMoney } from '../../lib/format'
import { formatUnitCount } from '../../lib/productUnits'
import { Icon } from '../../components/Icon'
import { Button, Modal } from '../../components/ui'

/**
 * "Which case did you actually rip?"
 *
 * ## The failure this closes
 *
 * We hold three cases of a product at $1,400, five at $1,550 and two at $1,600.
 * Every consumption used to take the OLDEST layer and say nothing. Break the
 * $1,600 case, book $1,400, and that break's margin is wrong — as is the
 * per-break P&L that sums it. Nobody notices, because the number that is wrong
 * was never on screen.
 *
 * So the operator is asked, and may split: two out of the $1,400 lot, one out of
 * the $1,600.
 *
 * ## Two rules the dialog lives or dies by
 *
 * IT DOES NOT APPEAR WHEN THERE IS NOTHING TO DECIDE. One layer, or five layers
 * all bought at the same price, is not a choice — it is a dialog with one
 * possible answer. Show that dialog and it is dismissed unread within a week,
 * and then it is useless on the day two prices differ by two hundred dollars a
 * case. `needsLotChoice` owns that judgement; it lives in @shared/costLots so
 * the write path can be asked the same question with the same answer.
 *
 * CANCEL ABORTS THE WHOLE ACTION. It does not fall back to oldest-first. A
 * fallback would book a cost the operator did not choose at the exact moment
 * they believe they chose one — which is worse than never having asked, because
 * now there is a dialog in the way to make it look handled. `askAllocation`
 * resolves null on cancel and every caller returns without writing anything.
 *
 * ## Why a hook rather than a component the screens render
 *
 * Four screens consume stock (a break, a giveaway, a sale, a stock correction)
 * and one of them does it in a loop over a scan queue. Each needs "ask, then
 * carry on or abandon" as one awaited step in the middle of a submit handler.
 * A rendered component would make each of those a state machine; the hook makes
 * each of them one line.
 */

/** What the caller gets back. `allocation` null means nothing had to be decided. */
export interface LotChoice {
  allocation: LotPick[] | null
}

interface Ask {
  productId: string
  location: string
  quantity: number
  /** Overrides the product name from the read — used where the caller has a
   *  better one to hand (a scan line already showing what it scanned). */
  productName?: string
}

interface Live {
  data: LotPickerData
  quantity: number
}

export function useLotPicker(): {
  /** Render this somewhere in the tree. Null while no question is open. */
  picker: JSX.Element | null
  /** Null means the operator cancelled — abandon the whole action. */
  askAllocation: (ask: Ask) => Promise<LotChoice | null>
} {
  const [live, setLive] = useState<Live | null>(null)
  // The resolver of the promise currently being awaited. In a ref rather than in
  // state because settling it must not depend on a re-render having happened —
  // a Confirm pressed in the same tick a re-render is queued would otherwise
  // resolve nothing and leave the caller awaiting forever.
  const pending = useRef<((choice: LotChoice | null) => void) | null>(null)

  const settle = useCallback((choice: LotChoice | null): void => {
    const resolve = pending.current
    pending.current = null
    setLive(null)
    resolve?.(choice)
  }, [])

  const askAllocation = useCallback(async (ask: Ask): Promise<LotChoice | null> => {
    const quantity = ask.quantity
    if (!Number.isFinite(quantity) || quantity <= 0) return { allocation: null }
    const data = await api.inventory.lotOptions(ask.productId, ask.location)
    // No product, no permission, or a shelf with no cost layers under it at all.
    // Nothing to choose between, so nothing is asked — the write path then does
    // whatever it has always done, including refusing when the layers cannot
    // cover the ask.
    if (!data) return { allocation: null }
    const lots = openLots(data.lots)
    if (!needsLotChoice(lots)) return { allocation: null }
    /**
     * THE LAYERS MUST BE ABLE TO COVER IT.
     *
     * A shelf can legitimately hold more stock than its cost layers account for
     * (found stock recorded before a basis existed, a partial backfill). Prompt
     * in that state and the running total can never reach the quantity, so
     * Confirm never lights up and the only way out is Cancel — a dialog that
     * traps the operator on the one action it was supposed to help with.
     *
     * So it is not shown, and the ordinary path runs: consumeFifo takes what it
     * can and refuses by name if it cannot, which is a message that says what is
     * actually wrong.
     */
    const available = lots.reduce((sum, l) => sum + l.qtyRemaining, 0)
    if (available + quantizationSlack(quantity) < quantity) return { allocation: null }

    return new Promise<LotChoice | null>((resolve) => {
      pending.current = resolve
      setLive({
        data: ask.productName ? { ...data, productName: ask.productName, lots } : { ...data, lots },
        quantity
      })
    })
  }, [])

  const picker = live ? (
    <LotAllocationDialog
      data={live.data}
      quantity={live.quantity}
      onCancel={() => settle(null)}
      onConfirm={(picks) => settle({ allocation: picks })}
    />
  ) : null

  return { picker, askAllocation }
}

/**
 * The dialog itself.
 *
 * STARTS AT ZERO, deliberately not prefilled with what FIFO would have done. The
 * complaint was that the app answered this question by itself; a pre-filled
 * answer sitting under a live Confirm button answers it again, just with an
 * extra click in front of it. The operator says what they took.
 */
function LotAllocationDialog({
  data,
  quantity,
  onCancel,
  onConfirm
}: {
  data: LotPickerData
  quantity: number
  onCancel: () => void
  onConfirm: (picks: LotPick[]) => void
}): JSX.Element {
  const [picks, setPicks] = useState<LotPick[]>([])
  const lots = useMemo(() => openLots(data.lots), [data.lots])

  /**
   * ESCAPE CLOSES THIS AND NOTHING ELSE.
   *
   * Three of the four callers already have a Modal open — the sale form, the
   * stock form, the scan station — and `Modal` closes itself on Escape from a
   * listener on `window`. Two of those firing on one keypress would cancel the
   * allocation AND throw away the half-filled form behind it, which is a much
   * bigger loss than the one the operator asked for.
   *
   * Registered in the CAPTURE phase, which runs before every bubble-phase
   * listener on window, and stops propagation there. That suppresses this
   * dialog's own Modal handler too, so the cancel is invoked here explicitly.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const allocated = pickedQty(picks)
  const left = outstandingQty(picks, quantity)
  const complete = allocationIsComplete(picks, quantity)
  const cost = pickedCost(lots, picks)
  const blended = blendedUnitCost(lots, picks)

  const bump = (lot: CostLot, delta: number): void => {
    const current = pickFor(picks, lot.lotId)
    const step = delta > 0 ? plusStep(lot, current, picks, quantity) : -minusStep(current)
    if (step === 0) return
    setPicks((p) => withPick(p, lot.lotId, current + step))
  }

  return (
    <Modal
      title="Which cost layer did this come out of?"
      subtitle={`${data.productName} · ${formatUnitCount(quantity)} from ${data.location}`}
      wide
      onClose={onCancel}
      footer={
        <>
          {/* "Cancel" and it means it: nothing is written, and no oldest-first
              fallback runs behind it. The caller abandons the whole action. */}
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" icon="Layers" disabled={!complete} onClick={() => onConfirm(tidyPicks(picks))}>
            {complete ? `Confirm · ${formatMoney(cost)}` : `${formatUnitCount(left)} still to place`}
          </Button>
        </>
      }
    >
      {/* The reference figure the owner asked to stay visible throughout. It is
          NOT what anything books — what books is the blend of the layers picked
          — and it is here so "$1,550" means something at a glance. */}
      <div className="lotpick-avg">
        <Icon name="Scale" size={15} />
        <span>
          This product averages <b>{formatUnitMoney(data.averageCost)}</b> a unit across everything on
          hand. The layers below are what it is actually made of.
        </span>
      </div>

      <div className="lotpick-rows" role="group" aria-label="Cost layers">
        {lots.map((lot) => {
          const taken = pickFor(picks, lot.lotId)
          const canAdd = plusStep(lot, taken, picks, quantity) > 0
          return (
            <div key={lot.lotId} className={`lotpick-row ${taken > 0 ? 'is-taking' : ''}`}>
              <div className="lotpick-who">
                <span className="lotpick-vendor">{lotLabel(lot)}</span>
                <span className="lotpick-sub">
                  {formatUnitCount(lot.qtyRemaining)} left · received{' '}
                  {new Date(lot.receivedAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  })}
                </span>
              </div>
              <div className="lotpick-cost">
                <span className="lotpick-price">{formatUnitMoney(lot.unitCost)}</span>
                <span className="lotpick-sub">each</span>
              </div>
              <div className="lotpick-step">
                <button
                  type="button"
                  className="lotpick-btn"
                  aria-label={`Take one fewer from ${lotLabel(lot)}`}
                  disabled={taken <= 0}
                  onClick={() => bump(lot, -1)}
                >
                  <Icon name="Minus" size={16} />
                </button>
                <span className="lotpick-qty" aria-live="polite">
                  {formatUnitCount(taken)}
                </span>
                <button
                  type="button"
                  className="lotpick-btn"
                  aria-label={`Take one more from ${lotLabel(lot)}`}
                  /* Disabled once the whole quantity is placed or the layer is
                     empty — so over-allocating is not a state the dialog can be
                     in, and the only thing the running total can be is short. */
                  disabled={!canAdd}
                  onClick={() => bump(lot, 1)}
                >
                  <Icon name="Plus" size={16} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className={`lotpick-total ${complete ? 'is-done' : ''}`}>
        <Icon name={complete ? 'CheckCircle2' : 'PackageMinus'} size={15} />
        <div className="lotpick-total-body">
          <span>
            <b>{formatUnitCount(allocated)}</b> of <b>{formatUnitCount(quantity)}</b> allocated
            {allocated > 0 && (
              <>
                {' '}
                — <b>{formatMoney(cost)}</b> at {formatUnitMoney(blended)} a unit
              </>
            )}
          </span>
          {!complete && (
            <span className="lotpick-hint">
              {/* Named rather than implied. A greyed-out button with no reason
                  beside it is read as the app being broken. */}
              Place all {formatUnitCount(quantity)} before this can be recorded.
            </span>
          )}
        </div>
      </div>
    </Modal>
  )
}
