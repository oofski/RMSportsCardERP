import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Icon } from '../../components/Icon'
import { CenterLoader } from '../../components/ui'
import { EmployeesTab } from './EmployeesTab'
import { HoursTab } from './HoursTab'
import { RolesTab } from './RolesTab'
import { ActivityTab } from './ActivityTab'
import { QuickBooksTab } from './QuickBooksTab'
import { InventoryResetTab } from './InventoryResetTab'
import { CloudSyncTab } from './CloudSyncTab'

type TabId =
  | 'employees'
  | 'hours'
  | 'roles'
  | 'activity'
  | 'reset'
  | 'quickbooks'
  | 'sync'

interface TabDef {
  id: TabId
  label: string
  icon: string
  visible: boolean
}

export function AdminModule(): JSX.Element {
  const { can } = useSession()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)

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
    { id: 'hours', label: 'Hours', icon: 'Clock', visible: can('admin.hours.view') },
    { id: 'roles', label: 'Roles & Permissions', icon: 'ShieldCheck', visible: can('admin.access') },
    { id: 'activity', label: 'Inventory activity', icon: 'Layers', visible: can('module.inventory') },
    // Gated on the write permission, not on module access: this tab rewrites
    // stock and cost for the whole catalog in one action.
    {
      id: 'reset',
      label: 'Inventory reset',
      icon: 'ClipboardList',
      visible: can('inventory.manage')
    },
    { id: 'quickbooks', label: 'QuickBooks', icon: 'Wallet', visible: can('admin.access') },
    // Anyone who runs breaks needs the customer form links and the submissions
    // waiting on them; the connection settings inside are separately gated on
    // admin.access by the handlers.
    {
      id: 'sync',
      label: 'Cloud sync',
      icon: 'Cloud',
      visible: can('admin.access') || can('shipping.manage')
    }
  ]
  const visibleTabs = tabs.filter((t) => t.visible)
  const [tab, setTab] = useState<TabId>(visibleTabs[0]?.id ?? 'employees')

  if (loading) return <CenterLoader />

  return (
    <div className="content-narrow">
      <div className="tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'employees' && (
        <EmployeesTab employees={employees} onChanged={loadEmployees} />
      )}
      {tab === 'hours' && <HoursTab />}
      {tab === 'roles' && <RolesTab employees={employees} onChanged={loadEmployees} />}
      {tab === 'activity' && <ActivityTab />}
      {tab === 'reset' && <InventoryResetTab />}
      {tab === 'quickbooks' && <QuickBooksTab />}
      {tab === 'sync' && <CloudSyncTab />}
    </div>
  )
}
