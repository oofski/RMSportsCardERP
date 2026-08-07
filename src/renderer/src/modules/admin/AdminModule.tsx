import { Fragment, useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { CenterLoader } from '../../components/ui'
import { EmployeesTab } from './EmployeesTab'
import { OnboardingTab } from './OnboardingTab'
import { RolesTab } from './RolesTab'
import { ActivityTab } from './ActivityTab'
import { DeveloperTab } from './DeveloperTab'

type TabId = 'employees' | 'onboarding' | 'roles' | 'activity' | 'developer'

interface TabDef {
  id: TabId
  label: string
  icon: string
  visible: boolean
  /** Count badge; 0 hides it. */
  badge?: number
  /** Louder than a count: something is wrong, not merely outstanding. */
  alarm?: boolean
  /** Draw the group rule before this tab. */
  startsGroup?: boolean
}

export function AdminModule(): JSX.Element {
  const { can } = useSession()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<TabId>('employees')

  const loadEmployees = useCallback(async () => {
    const list = await api.employees.list()
    setEmployees(list)
  }, [])

  // The roster is shared, so somebody added on another machine belongs here now.
  useLiveRefresh(LIVE.people, loadEmployees)

  useEffect(() => {
    ;(async () => {
      // A rejected roster read must never strand the whole module on a spinner —
      // the tabs that do not need employees (Hours, Break assignments, Activity)
      // still work, so always clear loading.
      try {
        await loadEmployees()
      } catch {
        setEmployees([])
      } finally {
        setLoading(false)
      }
    })()
  }, [loadEmployees])

  const tabs: TabDef[] = [
    { id: 'employees', label: 'Employees', icon: 'Users', visible: can('admin.employees.view') },
    // ---- People. This is what Admin IS ------------------------------------
    // Who works here, how they get in, and what they may touch. Everything
    // below the rule is a system setting that ended up here because there was
    // nowhere else to put it, and it reads as such.
    //
    // Hours is NOT here any more: Time & Payroll is a module of its own with
    // the same timesheets, the period selector and the Gusto export on its
    // landing screen. Two doors onto one table meant nobody knew which was the
    // real one.
    { id: 'onboarding', label: 'Onboarding', icon: 'UserPlus', visible: can('admin.employees.view') },
    { id: 'roles', label: 'Roles & Permissions', icon: 'ShieldCheck', visible: can('admin.access') },
    // ---- Everything else, behind a rule -----------------------------------
    {
      id: 'activity',
      label: 'Inventory activity',
      icon: 'Layers',
      visible: can('module.inventory'),
      startsGroup: true
    },
    // THE BACK OF THE HOUSE, in one tab.
    //
    // Cloud sync and the inventory reset are not administration in the sense the
    // three tabs above the rule are — nobody opens either in an ordinary week.
    // One decides which company's data this machine reads and writes; the other
    // rewrites stock and cost for the whole catalog in a single action. They are
    // the two most consequential screens in the app and the two least visited,
    // which is exactly the pair that should be behind one clearly-labelled door
    // rather than sitting in the strip inviting a stray click.
    //
    // Gated on the WIDER of the two permissions, and each screen re-checks its
    // own inside — the tab is a place to stand, not a grant.
    {
      id: 'developer',
      label: 'Developer',
      icon: 'Terminal',
      visible: can('admin.access') || can('inventory.manage') || can('shipping.manage')
    }
  ]
  const visibleTabs = tabs.filter((t) => t.visible)
  // Everything here is permission-gated, so the first tab a given account can
  // see is the one it lands on — including when that is not Employees.
  const active = visibleTabs.some((t) => t.id === tab) ? tab : visibleTabs[0]?.id ?? 'employees'

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow">
      <div className="tabs">
        {visibleTabs.map((t, i) => (
          <Fragment key={t.id}>
            {/* Only between groups, never leading — a rule with nothing to its
                left is just an odd edge on the pill. */}
            {t.startsGroup && i > 0 && <span className="tab-rule" aria-hidden="true" />}
            <button
              className={`tab ${active === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon name={t.icon} size={16} />
              {t.label}
              {/* The same badge the shipping module drew, because it means the
                  same thing: a collision is a team claimed twice and is worth an
                  alarm, a count is just work outstanding. */}
              {t.alarm ? (
                <span className="ship-tab-badge danger">
                  <Icon name="Siren" size={11} strokeWidth={2.6} />
                </span>
              ) : (t.badge ?? 0) > 0 ? (
                <span className="ship-tab-badge warning">{t.badge}</span>
              ) : null}
            </button>
          </Fragment>
        ))}
      </div>

      {active === 'employees' && (
        <EmployeesTab employees={employees} onChanged={loadEmployees} />
      )}
      {active === 'onboarding' && <OnboardingTab />}
      {active === 'roles' && <RolesTab employees={employees} onChanged={loadEmployees} />}
      {active === 'activity' && <ActivityTab />}
      {active === 'developer' && <DeveloperTab />}
    </div>
  )
}
