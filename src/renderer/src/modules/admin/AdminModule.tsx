import { useCallback, useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader } from '../../components/ui'
import { EmployeesTab } from './EmployeesTab'
import { HoursTab } from './HoursTab'
import { RolesTab } from './RolesTab'

type TabId = 'employees' | 'hours' | 'roles'

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

  useEffect(() => {
    ;(async () => {
      await loadEmployees()
      setLoading(false)
    })()
  }, [loadEmployees])

  const tabs: TabDef[] = [
    { id: 'employees', label: 'Employees', icon: 'Users', visible: can('admin.employees.view') },
    { id: 'hours', label: 'Hours', icon: 'Clock', visible: can('admin.hours.view') },
    { id: 'roles', label: 'Roles & Permissions', icon: 'ShieldCheck', visible: can('admin.access') }
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
    </div>
  )
}
