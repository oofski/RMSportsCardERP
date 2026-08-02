import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { OrderWalker, type WalkerMode } from './OrderWalker'
import type { ShipTabProps } from './ShippingModule'

/**
 * Two ways to do the same job, switched at the top of the tab.
 *
 * The list view is the whole night at once — every break, every package, search
 * and filter across all of it. The slip view is ONE order with the customer's
 * own PDF beside it, and Next walks to the following one.
 *
 * Both had to exist. A lead scanning for what is left needs the list; somebody
 * at a bench with a stack of cards and a pile of boxes needs the one in front of
 * them and a button that says next. Making either the only option means the
 * other job is done by scrolling.
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
  /** The existing list view for this tab. */
  children: JSX.Element
}): JSX.Element {
  // One order at a time is the default. It is the screen the work is actually
  // done on; the whole-night list is what you open when you are looking for
  // something, which is the rarer job and one click away.
  const [slip, setSlip] = useState(true)

  return (
    <div className="slipmode">
      <div className="slipmode-switch">
        <button className={slip ? 'active' : ''} onClick={() => setSlip(true)}>
          <Icon name="FileText" size={14} />
          One order at a time
        </button>
        <button className={slip ? '' : 'active'} onClick={() => setSlip(false)}>
          <Icon name="LayoutGrid" size={14} />
          {mode === 'pick' ? 'All breaks' : 'All packages'}
        </button>
      </div>
      {slip ? (
        <OrderWalker mode={mode} canAct={canAct} onChanged={props.onChanged} />
      ) : (
        children
      )}
    </div>
  )
}
