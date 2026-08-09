import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { OrderWalker, type WalkerMode } from './OrderWalker'
import type { ShipTabProps } from './ShippingModule'

/**
 * WHICH JOB ARE YOU DOING TONIGHT — sorting, or shipping.
 *
 * These two buttons used to say "One order at a time" and "All breaks", which
 * named the LAYOUTS rather than the work. Two people on a floor doing two
 * different jobs both had to know that the layout called "one order at a time"
 * was the packing bench and the one called "all breaks" was the sorting bench,
 * and nothing on the screen said so.
 *
 * They are the same two views. They are labelled by the job now:
 *
 *   SORTING   the breaks, and each break's five-step checklist. Steps 1-3 are
 *             the work; 4 and 5 show what it unlocks.
 *   SHIPPING  one order at a time with the customer's own slip beside it —
 *             which is step 4, and is now reachable from step 4 rather than
 *             being a mode you had to already know about.
 *
 * Sorting leads because it comes first: nothing can be packed until every break
 * is off the bench, so landing a fresh floor on the packing screen showed them
 * a queue they were not allowed to start.
 *
 * The choice is per tab and does not persist: it is a posture for the next ten
 * minutes, not a setting, and restoring yesterday's would just surprise whoever
 * opens the app tomorrow.
 */
export function WithSlipMode({
  mode,
  canAct,
  props,
  children
}: {
  mode: WalkerMode
  canAct: boolean
  props: ShipTabProps
  /**
   * The sorting view, given a way back to shipping.
   *
   * A render prop rather than an element because the checklist inside it needs
   * to be able to send somebody to step 4, and the switch that does that lives
   * here.
   */
  children: (goToShipping: () => void) => JSX.Element
}): JSX.Element {
  const [job, setJob] = useState<'sorting' | 'shipping'>('sorting')

  return (
    <div className="slipmode">
      <div className="slipmode-switch">
        <button
          className={job === 'sorting' ? 'active' : ''}
          onClick={() => setJob('sorting')}
          title="The breaks and their checklists — steps 1 to 3"
        >
          <Icon name="LayoutGrid" size={14} />
          Sorting
        </button>
        <button
          className={job === 'shipping' ? 'active' : ''}
          onClick={() => setJob('shipping')}
          title="One order at a time with the slip beside it — steps 4 and 5"
        >
          <Icon name="FileText" size={14} />
          Shipping
        </button>
      </div>
      {job === 'shipping' ? (
        <OrderWalker mode={mode} canAct={canAct} onChanged={props.onChanged} />
      ) : (
        children(() => setJob('shipping'))
      )}
    </div>
  )
}
