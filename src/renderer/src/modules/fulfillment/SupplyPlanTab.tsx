import { useCallback, useEffect, useState } from 'react'
import type { ShipSupplyPlan } from '@shared/shippingSupplies'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'

/**
 * What tonight's show costs in supplies.
 *
 * Read only, deliberately. Every number here is derived from two facts — how
 * many packs the show produced and how many packages went out — and each line
 * states the arithmetic that produced it, so somebody can check the screen
 * against a calculator before anything is ordered or deducted.
 *
 * Nothing on this screen moves stock. Wiring it to actually decrement supplies
 * is a separate decision (when does it fire: at import, per package, or on a
 * button) and a separate risk: `supplies.quantity` is a stored column arbitrated
 * last-write-wins across laptops, so two machines deducting the same show would
 * silently lose one of the deductions. That has to be solved before consumption
 * is automatic, not after.
 */
export function SupplyPlanTab(): JSX.Element {
  const [plan, setPlan] = useState<ShipSupplyPlan | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setPlan(await api.shipping.supplyPlan())
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

  if (loading) return <CenterLoader />

  if (!plan || plan.packs === 0) {
    return (
      <EmptyState
        icon="Boxes"
        title="Nothing to cost yet"
        message="Import tonight's packing slips and this works out what the show will take out of supplies."
      />
    )
  }

  return (
    <div className="splan">
      <div className="splan-basis">
        <BasisStat value={plan.breakCount} label={plan.breakCount === 1 ? 'break' : 'breaks'} />
        <span className="splan-times">×</span>
        <BasisStat
          value={plan.breakCount > 0 ? Math.round(plan.packs / plan.breakCount) : 0}
          label="team slate"
        />
        <span className="splan-times">=</span>
        <BasisStat value={plan.packs} label="packs" strong />
        <span className="splan-sep" />
        <BasisStat value={plan.orderCount} label="packages" strong />
      </div>

      <p className="splan-note">
        The slate, not the sales: every team in a break gets pulled, sleeved and bagged whether or
        not somebody bought it. Giveaways never add a pack — that card came out of a break already
        counted.
      </p>

      <ul className="splan-list">
        {plan.lines.map((l) => (
          <li key={l.role}>
            <span className="splan-qty mono">{l.quantity.toLocaleString()}</span>
            <span className="splan-name">{l.label}</span>
            <span className="splan-basis-text">{l.basis}</span>
          </li>
        ))}
      </ul>

      <div className="splan-foot">
        <Icon name="Info" size={14} />
        <span>
          Nothing here has come out of stock. Say when it should — at import, as each package is
          finished, or on a button somebody presses — and it gets wired to Supplies.
        </span>
      </div>
    </div>
  )
}

function BasisStat({
  value,
  label,
  strong
}: {
  value: number
  label: string
  strong?: boolean
}): JSX.Element {
  return (
    <span className={`splan-stat ${strong ? 'strong' : ''}`}>
      <b>{value.toLocaleString()}</b>
      <em>{label}</em>
    </span>
  )
}
