import { useCallback, useEffect, useState } from 'react'
import type { ShipStationBoard } from '@shared/shipStations'
import type { ShipSopState, ShipSopStep, ShipSopStepView } from '@shared/shippingSupplies'
import { SHIP_SUPPLY_ROLE_LABELS, shipSopBlockedBy } from '@shared/shippingSupplies'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button, CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'
import type { ShipTabProps } from './ShippingModule'

/**
 * The night's checklist — the seven steps of the shipping SOP.
 *
 * Ticking a step is not a note to self. It takes that step's materials out of
 * stock, at the unit cost they are carried at, booked to the show's day. That is
 * the whole reason the list is here rather than on a whiteboard: the moment
 * somebody says "the sleeving is done" is the same moment the sleeves are gone,
 * so it should be one action and not two.
 *
 * Everything a tick will do is on screen BEFORE it is ticked — the quantity, the
 * product, what is on hand, what it costs. A button that quietly moves four
 * hundred units of anything is a button people learn to be afraid of.
 *
 * ## The list is a line
 *
 * Step N cannot be ticked until step N-1 is. That is not decoration: the
 * ordering is enforced in the main process, and the same shared function that
 * refuses the write greys the control out here, so the two never disagree about
 * what is allowed or about the sentence they say when it is not.
 *
 * Unticking is free and never cascades — see the un-tick note on `toggle` — so
 * the list is allowed to have a HOLE in it. A hole is not a corruption; it is
 * somebody saying "we had not really finished that". It gets its own colour
 * rather than being smoothed over, because it is the thing that needs doing.
 *
 * ## Step 5 is not a box
 *
 * Nobody ticks the shipping off. Shipping is finished when the last order has
 * been picked at the bench, and the bench says so — see `pickAdvance`. What this
 * screen offers for step 5 is a door: **Open**, which is where the work is.
 */
/**
 * Is the product's name just the role's name typed out again?
 *
 * If so, printing both is a stutter. An exact compare is too strict for this:
 * the role reads "4×6 shipping labels" with a real multiplication sign, and
 * somebody naming the product typed an ASCII x. Same words, and showing them
 * side by side looks like a bug rather than like extra information.
 *
 * The × has to become an x BEFORE punctuation is dropped, not with it. Strip it
 * as punctuation and "4×6" collapses to "46" while "4x6" stays "4x6" — the two
 * spellings this exists to reconcile end up further apart than they started.
 */
function sameName(a: string, b: string): boolean {
  const key = (s: string): string =>
    s.toLowerCase().replace(/[×✕✖]/g, 'x').replace(/[^a-z0-9]+/g, '')
  return key(a) === key(b)
}

/** The one step the bench closes rather than a person. */
const BENCH_STEP: ShipSopStep = 'ship'

/** How a row reads: finished, open for work, a gap left behind, or not yet. */
type RowState = 'done' | 'now' | 'gap' | 'waiting'

export function SopTab({ canPack, canManage, onGoTo, onChanged }: ShipTabProps): JSX.Element {
  const { can } = useSession()
  const toast = useToast()
  const [state, setState] = useState<ShipSopState | null>(null)
  const [board, setBoard] = useState<ShipStationBoard | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<ShipSopStep | null>(null)
  const [open, setOpen] = useState<ShipSopStep | null>(null)

  const canTick = canPack || canManage
  const showCosts = can('module.inventory')

  const load = useCallback(async () => {
    // The bench board comes along for the ride because step 5's row is about the
    // bench: whether picking is over, and how many boxes are still stacked up
    // behind it. Both are things this screen would otherwise have to guess.
    const [next, b] = await Promise.all([api.shipping.sop(), api.shipping.stationBoard()])
    setState(next)
    setBoard(b)
  }, [])

  useLiveRefresh(LIVE.shipping, load)
  useLiveRefresh(LIVE.inventory, load)

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

  if (loading) return <CenterLoader />
  if (!state) {
    return (
      <EmptyState
        icon="ListTodo"
        title="Checklist not available"
        message="The shipping module has to be open to you to see where the night is up to."
      />
    )
  }

  /**
   * Tick a step, or take the tick back.
   *
   * UN-TICKING DOES NOT CASCADE. Taking step two back off leaves three, four and
   * five exactly as they were — the work under them really happened, and undoing
   * it to keep the list tidy would hand back stock nobody put back on a shelf
   * and, for step five, throw away a night at the bench. What is left is a hole,
   * which the person closes by ticking it on again. Re-ticking a hole never asks
   * anybody to redo anything above it.
   */
  const toggle = async (step: ShipSopStepView): Promise<void> => {
    setBusy(step.step)
    try {
      const res = await api.shipping.sopSetStep(step.step, !step.done)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not update that step.')
        return
      }
      const { state: next, wentNegative, skippedRoles, released, stranded } = res.data
      setState(next)
      // Units that could not be put back because the product they came from has
      // been deleted. Nothing can fix this on its own, so it has to be said.
      for (const s of stranded) {
        toast.error(
          `${s.quantity.toLocaleString()} ${(SHIP_SUPPLY_ROLE_LABELS[s.role] ?? s.role).toLowerCase()} could not go back — that product no longer exists. Correct the count in Inventory.`
        )
      }
      // The role was pointed at a different product since it was ticked. Say
      // that the old one was paid back, or it reads as stock appearing.
      for (const r of released) {
        toast.toast(
          `${r.quantity.toLocaleString()} ${(SHIP_SUPPLY_ROLE_LABELS[r.role] ?? r.role).toLowerCase()} went back to the product this role used to point at.`
        )
      }
      // Loud, as agreed: a supply that just went below zero means somebody's
      // count is wrong, and the tick is the only moment anyone is looking.
      for (const n of wentNegative) {
        toast.error(`${n.supplyName} is now ${n.onHand} — the count was short. Recount and correct it.`)
      }
      if (skippedRoles.length > 0) {
        // Name them. "1 of this step's supplies" tells somebody a thing is
        // wrong and nothing about which thing, which is the same as not saying.
        const names = skippedRoles.map((r) => SHIP_SUPPLY_ROLE_LABELS[r] ?? r).join(', ')
        toast.toast(
          `${names} ${skippedRoles.length === 1 ? 'is' : 'are'} not linked to a product, so nothing came out of stock for ${skippedRoles.length === 1 ? 'it' : 'them'}. Link ${skippedRoles.length === 1 ? 'it' : 'them'} in Admin → Shipping → Setup.`
        )
      }
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  const blocked = !state.eventDate
  const progress = state.steps.length > 0 ? state.doneCount / state.steps.length : 0
  const doneSet = new Set(state.steps.filter((s) => s.done).map((s) => s.step))
  const isDone = (s: ShipSopStep): boolean => doneSet.has(s)
  const packQueue = board?.packQueue ?? 0
  // Nothing left for a picker, so nothing at the bench will close step 5 on its
  // own any more. Two ways to get here: the night finished and somebody took the
  // tick back off, or the last card was found in Orders rather than at a bench.
  // Either way the work IS done and there has to be a way to say so — otherwise
  // an untick would strand the checklist one step from the end for ever.
  const pickingOver = board !== null && board.toPick === 0

  return (
    <div className="sop">
      <div className="sop-head">
        <div className="sop-progress">
          <div className="sop-bar">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <b>
            {state.doneCount} of {state.steps.length}
          </b>
          <em>steps done{state.eventDate ? ` · ${state.eventDate}` : ''}</em>
        </div>
        {showCosts && (
          <div className="sop-money">
            <span className="sop-money-item">
              <b>{formatMoney(state.bookedCost)}</b>
              <em>taken from stock</em>
            </span>
            <span className="sop-money-item muted">
              <b>{formatMoney(state.plannedCost)}</b>
              <em>the whole night</em>
            </span>
          </div>
        )}
      </div>

      {blocked && (
        <div className="sop-warn danger">
          <Icon name="CalendarX" size={15} />
          <span>
            <b>This show has no day assigned.</b> Supplies that leave the shelf have to book to a
            date or they never reach the P&amp;L, so nothing can be ticked until a lead gives this
            show a day in Admin or on the home board.
          </span>
        </div>
      )}

      {!blocked && !state.hasDataset && (
        <div className="sop-warn">
          <Icon name="FileQuestion" size={15} />
          <span>
            No packing slips are loaded, so every quantity below is zero. Ticking still records the
            step — it just has nothing to take out.
          </span>
        </div>
      )}

      {state.unmappedRoles.length > 0 && (
        <div className="sop-warn">
          <Icon name="Link2Off" size={15} />
          <span>
            <b>
              {state.unmappedRoles.length}{' '}
              {state.unmappedRoles.length === 1 ? 'consumable is' : 'consumables are'}
            </b>{' '}
            not linked to a product yet, so ticking their step records the count and moves no stock.
            Admin → Shipping → Setup is where the link is made.
          </span>
        </div>
      )}

      {state.negatives.length > 0 && (
        <div className="sop-warn danger">
          <Icon name="AlertTriangle" size={15} />
          <span>
            <b>Below zero:</b>{' '}
            {state.negatives.map((n) => `${n.supplyName} (${n.onHand})`).join(', ')}. The work was
            recorded anyway — the shelf count is what needs fixing, in Inventory.
          </span>
        </div>
      )}

      <ol className="sop-list">
        {state.steps.map((s, i) => {
          const expanded = open === s.step
          const hasLines = s.lines.length > 0
          // What is standing in the way of ticking this one — the SAME rule the
          // main process refuses the write with, not a second copy of it.
          const blocker = shipSopBlockedBy(isDone, s.step)
          // A step that is not done with finished work ABOVE it is a hole, not
          // the frontier. Both are actionable; they mean different things, so
          // they do not look the same. Scanning top-down for "the first unticked
          // one" would call the hole the current step and the real frontier
          // nothing at all.
          const laterDone = state.steps.slice(i + 1).some((x) => x.done)
          const rowState: RowState = s.done
            ? 'done'
            : blocker
              ? 'waiting'
              : laterDone
                ? 'gap'
                : 'now'
          const isBench = s.step === BENCH_STEP
          // Step 5 is closed by the bench, so while there is picking left its box
          // is a DOOR rather than a box — there is nothing here for anybody to
          // tick. Once picking is over nothing at the bench will close it, and it
          // becomes an ordinary tick: the only way back after somebody takes it
          // off, and the only way to record a night whose last card was found in
          // Orders rather than at a bench.
          const benchDoor = isBench && !s.done && rowState !== 'waiting' && !pickingOver
          // Unticking is always allowed. Ticking waits for the step in front.
          const canTickThis = canTick && !blocked && (s.done || !blocker)

          return (
            <li
              key={s.step}
              className={s.done ? 'sop-step done' : 'sop-step'}
              data-state={rowState}
            >
              {benchDoor ? (
                <button
                  className="sop-tick sop-tick-door"
                  onClick={() => onGoTo('floor')}
                  title="Open the bench — picking and packing"
                >
                  <Icon name="PackageOpen" size={19} />
                </button>
              ) : (
                <button
                  className="sop-tick"
                  disabled={!canTickThis || busy !== null}
                  onClick={() => void toggle(s)}
                  title={
                    blocked
                      ? 'Assign this show to a day first'
                      : !canTick
                        ? 'You do not have permission to work packing'
                        : blocker
                          ? `${blocker.title} has to be ticked off first`
                          : s.done
                            ? 'Untick — puts the supplies back. Nothing else is undone.'
                            : 'Tick — takes the supplies out of stock'
                  }
                >
                  {busy === s.step ? (
                    <Icon name="Loader2" size={17} />
                  ) : (
                    <Icon
                      name={s.done ? 'CheckSquare' : rowState === 'waiting' ? 'Lock' : 'Square'}
                      size={rowState === 'waiting' ? 15 : 19}
                    />
                  )}
                </button>
              )}

              <div className="sop-body">
                <div className="sop-title">
                  <span className="sop-num">{i + 1}</span>
                  <b>{s.title}</b>
                  {rowState === 'now' && <span className="sop-flag now">Now</span>}
                  {rowState === 'gap' && <span className="sop-flag gap">Unticked</span>}
                  {hasLines && (
                    <button
                      className="sop-expand"
                      onClick={() => setOpen(expanded ? null : s.step)}
                      aria-expanded={expanded}
                    >
                      <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14} />
                      {s.lines.length} {s.lines.length === 1 ? 'supply' : 'supplies'}
                      {showCosts && s.cost > 0 && ` · ${formatMoney(s.cost)}`}
                    </button>
                  )}
                  {!hasLines && <span className="sop-nosupply">no supplies</span>}
                </div>

                <p className="sop-detail">{s.detail}</p>

                {/* Waiting reads as NOT YET, never as broken. It says which step
                    is in front of it, because "do that one first" is the only
                    useful thing a locked row can tell anybody. */}
                {rowState === 'waiting' && blocker && (
                  <p className="sop-wait">
                    <Icon name="ArrowUp" size={12} />
                    Not yet — {blocker.title.toLowerCase()} comes first.
                  </p>
                )}

                {rowState === 'gap' && (
                  <p className="sop-wait gap">
                    <Icon name="Undo2" size={12} />
                    Taken back off. Later steps are untouched — tick this one again when it really is
                    done.
                  </p>
                )}

                {/* Who and when. The quantities used to ride along here — "371
                    top sleeves, 195 toploaders" — and they are inventory's news,
                    not the floor's. They are one click away in the disclosure
                    above, where somebody who wants them is already looking. */}
                {s.done && (
                  <p className="sop-when">
                    <Icon name="Check" size={12} />
                    {s.doneByName ? `${s.doneByName} · ` : ''}
                    {s.doneAt ? new Date(s.doneAt).toLocaleString() : 'done'}
                  </p>
                )}

                {/* ---- Step 5: the door, and the honest gap behind it ------- */}
                {isBench && rowState !== 'waiting' && (
                  <div className="sop-bench">
                    <Button
                      size="sm"
                      variant={benchDoor ? 'primary' : 'ghost'}
                      icon="PackageOpen"
                      onClick={() => onGoTo('floor')}
                    >
                      {benchDoor ? 'Open' : 'Back to the bench'}
                    </Button>
                    {benchDoor && (
                      <span className="sop-bench-note">
                        Pick or pack from here. This step ticks itself off when the last order has
                        been picked — nobody has to remember to.
                      </span>
                    )}
                    {!benchDoor && !s.done && (
                      <span className="sop-bench-note">
                        Nothing is left to pick, so the bench will not close this on its own — the
                        box beside it is how to say the shipping is done.
                      </span>
                    )}
                  </div>
                )}

                {/* Picking finishing is what closes step 5, and picking finishing
                    is not packing finishing. In a two-person night the packer can
                    still have a stack when this goes green and steps 6 and 7 come
                    open. That gap is real; it gets said out loud rather than
                    hidden, on the row where somebody can act on it. */}
                {isBench && packQueue > 0 && (
                  <p className="sop-wait">
                    <Icon name="Boxes" size={12} />
                    {packQueue} {packQueue === 1 ? 'order is' : 'orders are'} still waiting to be
                    packed
                    {s.done ? ' — this step follows the picking, not the packing.' : '.'}
                  </p>
                )}

                {expanded && hasLines && (
                  <ul className="sop-lines">
                    {s.lines.map((l) => (
                      <li key={l.role} data-short={l.shortBy > 0 ? 'true' : 'false'}>
                        <span className="sop-qty mono">
                          {(s.done ? l.used : l.quantity).toLocaleString()}
                        </span>
                        <div className="sop-line-mid">
                          <span className="sop-line-name">
                            {l.label}
                            {/* WHICH product loses the stock, not just which
                                role. This panel exists so that everything a
                                tick will do is visible before it is ticked, and
                                the product is the part somebody would want to
                                check. It is also what the toast names a second
                                later, so the two have to agree. */}
                            {l.supplyName && !sameName(l.supplyName, l.label) && (
                              <em className="sop-line-product">{l.supplyName}</em>
                            )}
                          </span>
                          <span className="sop-line-basis">{l.basis}</span>
                        </div>
                        <div className="sop-line-nums">
                          {l.supplyId ? (
                            <>
                              <span
                                className={
                                  l.onHand < 0
                                    ? 'sop-onhand neg'
                                    : l.shortBy > 0
                                      ? 'sop-onhand short'
                                      : 'sop-onhand'
                                }
                              >
                                {l.onHand.toLocaleString()} on hand
                                {l.shortBy > 0 && ` · ${l.shortBy.toLocaleString()} short`}
                              </span>
                              {showCosts && (
                                <span className="sop-line-cost mono">
                                  {formatMoney(s.done ? l.usedCost : l.lineCost)}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="sop-onhand muted">not linked</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="sop-foot">
        <Icon name="Info" size={14} />
        <span>
          The steps run in order — each one opens when the one before it is ticked. Ticking takes its
          supplies out of stock at today&apos;s average unit cost and books them to{' '}
          {state.eventDate ?? 'the show day'} in the Whatnot P&amp;L. Unticking puts them back and
          changes nothing else on the list.
        </span>
      </div>
    </div>
  )
}
