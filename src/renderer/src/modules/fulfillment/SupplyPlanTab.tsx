import { useCallback, useEffect, useState } from 'react'
import type { ShipSupplyPlanCosted, ShipSupplyRole } from '@shared/shippingSupplies'
import type { Supply } from '@shared/types'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { CenterLoader, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

/**
 * What tonight's show costs in supplies, and which product is which.
 *
 * Read only where stock is concerned: nothing on this screen decrements
 * anything — that happens on the Steps tab, when somebody ticks the step whose
 * work consumed it. The one thing this screen writes is the LINK — saying that
 * this row in the supplies list is the team bags — because that mapping has to
 * exist before any of the arithmetic can find a real product to cost against,
 * and before a tick has anywhere to take stock from.
 *
 * Role-first on purpose. The alternative is a field buried on each supply,
 * which means opening six products to answer one question and no way to see
 * that toploaders were never linked at all. Here the six roles are the list,
 * and an unlinked one is visibly unlinked.
 */
export function SupplyPlanTab(): JSX.Element {
  const { can } = useSession()
  const toast = useToast()
  const [plan, setPlan] = useState<ShipSupplyPlanCosted | null>(null)
  const [supplies, setSupplies] = useState<Supply[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const canSeeCosts = can('module.inventory')
  const canLink = can('inventory.manage')

  const load = useCallback(async () => {
    const [costed, list] = await Promise.all([
      api.shipping.supplyPlanCosted(),
      canSeeCosts ? api.supplies.list() : Promise.resolve([] as Supply[])
    ])
    setPlan(costed)
    setSupplies(list)
  }, [canSeeCosts])

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

  if (!plan) {
    return (
      <EmptyState
        icon="Boxes"
        title="Supplies are not visible to you"
        message="Costing a show reads the supplies list, which needs the Inventory module."
      />
    )
  }

  if (plan.packs === 0 && plan.orderCount === 0) {
    return (
      <EmptyState
        icon="Boxes"
        title="Nothing to cost yet"
        message="Import tonight's slips and this works out what the show takes out of supplies."
      />
    )
  }

  const link = async (role: ShipSupplyRole, supplyId: string): Promise<void> => {
    setBusy(role)
    try {
      const res = await api.supplies.setShipRole(supplyId || '', supplyId ? role : null)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not link that supply.')
        return
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  const unlink = async (supplyId: string, role: ShipSupplyRole): Promise<void> => {
    setBusy(role)
    try {
      const res = await api.supplies.setShipRole(supplyId, null)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not unlink that supply.')
        return
      }
      await load()
    } finally {
      setBusy(null)
    }
  }

  const slate = plan.breakCount > 0 ? Math.round(plan.packs / plan.breakCount) : 0

  return (
    <div className="splan">
      <div className="splan-basis">
        <BasisStat value={plan.breakCount} label={plan.breakCount === 1 ? 'break' : 'breaks'} />
        <span className="splan-times">×</span>
        <BasisStat value={slate} label="team slate" />
        <span className="splan-times">=</span>
        <BasisStat value={plan.packs} label="packs" strong />
        <span className="splan-sep" />
        <BasisStat value={plan.orderCount} label="packages" strong />
        {plan.totalCost > 0 && (
          <span className="splan-total">
            <b>{formatMoney(plan.totalCost)}</b>
            <em>supplies for this show</em>
          </span>
        )}
      </div>

      <p className="splan-note">
        The slate, not the sales — every team in a break gets pulled. Giveaways add nothing.
      </p>

      {plan.unmappedRoles.length > 0 && (
        <div className="splan-warn">
          <Icon name="Link2Off" size={15} />
          <span>
            <b>
              {plan.unmappedRoles.length} of {plan.lines.length}
            </b>{' '}
            lines have no supply linked. Quantities are right; they cannot be costed until each one
            is linked to a supply.
          </span>
        </div>
      )}

      <ul className="splan-list">
        {plan.lines.map((l) => (
          <li key={l.role} data-short={l.shortBy > 0 ? 'true' : 'false'}>
            <span className="splan-qty mono">{l.quantity.toLocaleString()}</span>
            <div className="splan-mid">
              <span className="splan-name">{l.label}</span>
              <span className="splan-basis-text">{l.basis}</span>
            </div>

            <div className="splan-link">
              {canLink ? (
                <select
                  className="select"
                  value={l.supplyId ?? ''}
                  disabled={busy === l.role}
                  onChange={(e) => {
                    const next = e.target.value
                    if (next) void link(l.role, next)
                    else if (l.supplyId) void unlink(l.supplyId, l.role)
                  }}
                >
                  <option value="">Not linked</option>
                  {supplies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="splan-linked">{l.supplyName ?? 'Not linked'}</span>
              )}
            </div>

            <div className="splan-nums">
              {l.supplyId ? (
                <>
                  <span className={`splan-onhand ${l.shortBy > 0 ? 'short' : ''}`}>
                    {l.onHand.toLocaleString()} on hand
                    {l.shortBy > 0 && ` · ${l.shortBy.toLocaleString()} short`}
                  </span>
                  <span className="splan-cost mono">{formatMoney(l.lineCost)}</span>
                </>
              ) : (
                <span className="splan-onhand muted">no cost</span>
              )}
            </div>
          </li>
        ))}
      </ul>
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
