import { useMemo, useState } from 'react'
import type { Employee, EmployeeInvite } from '@shared/types'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Avatar, Button, EmptyState, Input, RoleBadge, StatusBadge } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { initials, fullName, formatDate } from '../../lib/format'
import { EmployeeFormModal } from './EmployeeFormModal'
import { InviteModal } from './InviteModal'

export function EmployeesTab({
  employees,
  onChanged
}: {
  employees: Employee[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const { can } = useSession()
  const toast = useToast()
  const canManage = can('admin.employees.manage')

  const [query, setQuery] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [invite, setInvite] = useState<EmployeeInvite | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return employees
    return employees.filter((e) =>
      [e.firstName, e.lastName, e.companyId, e.email, e.title]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [employees, query])

  const stats = useMemo(
    () => ({
      total: employees.length,
      active: employees.filter((e) => e.status === 'active').length,
      invited: employees.filter((e) => e.status === 'invited').length
    }),
    [employees]
  )

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (e: Employee): void => {
    setEditing(e)
    setFormOpen(true)
  }

  const handleCreated = async (created: EmployeeInvite): Promise<void> => {
    setFormOpen(false)
    await onChanged()
    setInvite(created) // open the invite modal so the admin can send the email
  }
  const handleUpdated = async (): Promise<void> => {
    setFormOpen(false)
    await onChanged()
    toast.success('Employee updated.')
  }

  const regenerateInvite = async (e: Employee): Promise<void> => {
    setBusyId(e.id)
    try {
      const res = await api.employees.resetPassword(e.id)
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not create an invite.')
        return
      }
      await onChanged()
      setInvite(res.data)
    } finally {
      setBusyId(null)
    }
  }

  if (employees.length === 0) {
    return (
      <>
        <EmptyState
          icon="Users"
          title="No employees yet"
          message="Add your first team member to get started. They'll receive an invite to set their password."
          action={
            canManage ? (
              <Button variant="primary" icon="UserPlus" onClick={openCreate}>
                Add employee
              </Button>
            ) : undefined
          }
        />
        {formOpen && (
          <EmployeeFormModal
            employee={null}
            onClose={() => setFormOpen(false)}
            onCreated={handleCreated}
            onUpdated={handleUpdated}
          />
        )}
      </>
    )
  }

  return (
    <>
      <div className="stat-grid">
        <Stat icon="Users" value={stats.total} label="Total employees" />
        <Stat icon="CheckCircle2" value={stats.active} label="Active" />
        <Stat icon="Mail" value={stats.invited} label="Pending invites" />
      </div>

      <div className="section-head">
        <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
          <span
            style={{ position: 'absolute', left: 12, top: 11, color: 'var(--text-3)' }}
          >
            <Icon name="Search" size={16} />
          </span>
          <Input
            style={{ paddingLeft: 34 }}
            placeholder="Search employees…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {canManage && (
          <Button variant="primary" icon="UserPlus" onClick={openCreate}>
            Add employee
          </Button>
        )}
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Company ID</th>
              <th>Title</th>
              <th>Role</th>
              <th>Status</th>
              <th>Added</th>
              {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td>
                  <div className="cell-name">
                    <Avatar text={initials(e.firstName, e.lastName)} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{fullName(e.firstName, e.lastName)}</div>
                      <div className="muted text-sm">{e.email}</div>
                    </div>
                  </div>
                </td>
                <td className="mono">{e.companyId}</td>
                <td>{e.title || '—'}</td>
                <td>
                  <RoleBadge role={e.role} />
                </td>
                <td>
                  <StatusBadge status={e.status} />
                </td>
                <td className="muted">{formatDate(e.createdAt)}</td>
                {canManage && (
                  <td>
                    <div className="cell-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={e.status === 'invited' ? 'Send' : 'KeyRound'}
                        loading={busyId === e.id}
                        onClick={() => regenerateInvite(e)}
                        title={e.status === 'invited' ? 'Resend invite email' : 'Reset password & invite'}
                      >
                        {e.status === 'invited' ? 'Resend' : 'Reset'}
                      </Button>
                      <Button size="sm" variant="secondary" icon="Pencil" onClick={() => openEdit(e)}>
                        Edit
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {formOpen && (
        <EmployeeFormModal
          employee={editing}
          onClose={() => setFormOpen(false)}
          onCreated={handleCreated}
          onUpdated={handleUpdated}
        />
      )}

      {invite && <InviteModal invite={invite} onClose={() => setInvite(null)} />}
    </>
  )
}

function Stat({ icon, value, label }: { icon: string; value: number; label: string }): JSX.Element {
  return (
    <div className="stat">
      <div className="stat-ico">
        <Icon name={icon} size={20} />
      </div>
      <div>
        <div className="stat-val">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
