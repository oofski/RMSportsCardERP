import { useState } from 'react'
import { useSession } from '../../lib/session'
import { EmptyState } from '../../components/ui'
import { CloudSyncTab } from './CloudSyncTab'
import { InventoryResetTab } from './InventoryResetTab'

/**
 * The back of the house.
 *
 * Two screens nobody opens in an ordinary week, and the two most consequential
 * in the app. Cloud sync decides which company's data this machine reads and
 * writes; the inventory reset rewrites stock and cost for the whole catalog in
 * one action. Sitting in the tab strip they were a stray click away from a
 * screen about employees, which is the wrong neighbourhood for either.
 *
 * Behind one labelled door instead. The label is the point: somebody who ends up
 * here knows they have left the part of Admin that is about people.
 *
 * Each screen still checks its OWN permission inside — the tab is a place to
 * stand, not a grant, so a lead who can reach it for the sync settings does not
 * thereby gain the ability to rewrite the catalog.
 */
export function DeveloperTab(): JSX.Element {
  const { can } = useSession()
  const canSync = can('admin.access') || can('shipping.manage')
  const canReset = can('inventory.manage')

  const PANELS: Array<{ id: 'sync' | 'reset'; label: string; visible: boolean }> = [
    { id: 'sync', label: 'Cloud sync', visible: canSync },
    { id: 'reset', label: 'Inventory reset', visible: canReset }
  ]
  const visible = PANELS.filter((p) => p.visible)
  const [panel, setPanel] = useState<'sync' | 'reset'>(visible[0]?.id ?? 'sync')
  const active = visible.some((p) => p.id === panel) ? panel : visible[0]?.id

  if (visible.length === 0) {
    return <EmptyState icon="ShieldCheck" title="Nothing here is yours to change." />
  }

  return (
    <>
      {visible.length > 1 && (
        <div className="seg-row">
          {visible.map((p) => (
            <button
              key={p.id}
              className={`seg ${active === p.id ? 'on' : ''}`}
              onClick={() => setPanel(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {active === 'sync' ? <CloudSyncTab /> : <InventoryResetTab />}
    </>
  )
}
