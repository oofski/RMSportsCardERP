import { useCallback, useEffect, useState } from 'react'
import type { ShipSopState, ShipSopStep, ShipSopStepView } from '@shared/shippingSupplies'
import { SHIP_SUPPLY_ROLE_LABELS } from '@shared/shippingSupplies'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader, EmptyState } from '../../components/ui'
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

export function SopTab({ canPack, canManage, onChanged }: ShipTabProps): JSX.Element {
  const { can } = useSession()
  const toast = useToast()
  const [state, setState] = useState<ShipSopState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<ShipSopStep | null>(null)
  const [open, setOpen] = useState<ShipSopStep | null>(null)

  const canTick = canPack || canManage
  const showCosts = can('module.inventory')

  const load = useCallback(async () => {
    setState(await api.shipping.sop())
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
          `${names} ${skippedRoles.length === 1 ? 'is' : 'are'} not linked to a product, so nothing came out of stock for ${skippedRoles.length === 1 ? 'it' : 'them'}. Link ${skippedRoles.length === 1 ? 'it' : 'them'} in Setup → What it takes.`
        )
      }
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  const blocked = !state.eventDate
  const progress = state.steps.length > 0 ? state.doneCount / state.steps.length : 0

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
            date or they never reach the P&amp;L, so nothing can be ticked until Setup or the home
            board gives this show a day.
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
            Setup → What it takes is where the link is made.
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
          // What this step actually took. Empty when the step is done but every
          // quantity was zero — a show with no slips loaded, which the banner
          // above already explains. The list decides whether the separator is
          // written at all, so a done step never trails a lone middot.
          const took = s.lines
            .filter((l) => l.used > 0)
            .map((l) => `${l.used.toLocaleString()} ${l.label.toLowerCase()}`)
          return (
            <li key={s.step} className={s.done ? 'sop-step done' : 'sop-step'}>
              <button
                className="sop-tick"
                disabled={!canTick || blocked || busy !== null}
                onClick={() => void toggle(s)}
                title={
                  blocked
                    ? 'Assign this show to a day first'
                    : !canTick
                      ? 'You do not have permission to work packing'
                      : s.done
                        ? 'Untick — puts the supplies back'
                        : 'Tick — takes the supplies out of stock'
                }
              >
                {busy === s.step ? (
                  <Icon name="Loader2" size={17} />
                ) : (
                  <Icon name={s.done ? 'CheckSquare' : 'Square'} size={19} />
                )}
              </button>

              <div className="sop-body">
                <div className="sop-title">
                  <span className="sop-num">{i + 1}</span>
                  <b>{s.title}</b>
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

                {s.done && (
                  <p className="sop-when">
                    <Icon name="Check" size={12} />
                    {s.doneByName ? `${s.doneByName} · ` : ''}
                    {s.doneAt ? new Date(s.doneAt).toLocaleString() : 'done'}
                    {took.length > 0 && ` · ${took.join(', ')}`}
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
          Ticking a step takes its supplies out of stock at today&apos;s average unit cost and books
          them to {state.eventDate ?? 'the show day'} in the Whatnot P&amp;L. Unticking puts them
          back. Steps with no supplies under them are recorded only.
        </span>
      </div>
    </div>
  )
}
