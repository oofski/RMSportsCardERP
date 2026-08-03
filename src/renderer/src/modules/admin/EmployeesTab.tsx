import { useMemo, useState } from 'react'
import type { Employee, EmployeeInvite } from '@shared/types'
import { useSession } from '../../lib/session'
import { useChrome } from '../../lib/chrome'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Avatar, Button, EmptyState, Modal, RoleBadge, StatusBadge } from '../../components/ui'
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
  const { search } = useChrome()
  const toast = useToast()
  const canManage = can('admin.employees.manage')

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Employee | null>(null)
  const [invite, setInvite] = useState<EmployeeInvite | null>(null)
  const [confirmReset, setConfirmReset] = useState<Employee | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return employees
    return employees.filter((e) =>
      [e.firstName, e.lastName, e.companyId, e.email, e.title]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [employees, search])

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
    // No temporary password means there is nothing to hand over: a shipping
    // account was created with a password the administrator typed a moment ago
    // and already knows. The invite modal exists to carry a credential the
    // admin has not seen yet — showing it here would just repeat one back and
    // put it on a clipboard button. (Note this does NOT key off `hasEmail`: a
    // bench account may well have an address, and a person may well have none;
    // what decides it is whether a secret was generated.)
    if (!created.temporaryPassword) {
      toast.success(
        `${fullName(created.employee.firstName, created.employee.lastName)} can sign in now with ${
          created.employee.companyId
        } and the password you set.`
      )
      return
    }
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
      setConfirmReset(null)
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
        <div>
          <h2>Employees</h2>
          <p>
            {filtered.length} of {employees.length}
            {search.trim() ? ` matching "${search.trim()}"` : ' team members'}
          </p>
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
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canManage ? 7 : 6}>
                  <div className="muted" style={{ padding: '20px 0', textAlign: 'center' }}>
                    No employees match “{search.trim()}”.
                  </div>
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id}>
                <td>
                  <div className="cell-name">
                    <Avatar text={initials(e.firstName, e.lastName)} src={e.avatarUrl} />
                    <div>
                      <div style={{ fontWeight: 600 }}>{fullName(e.firstName, e.lastName)}</div>
                      <div className="muted text-sm">{e.email || '—'}</div>
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
                        onClick={() =>
                          e.status === 'invited' ? regenerateInvite(e) : setConfirmReset(e)
                        }
                        title={
                          e.status === 'invited'
                            ? 'Resend invite email'
                            : e.email
                              ? 'Reset password & invite'
                              : 'Reset password'
                        }
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

      {confirmReset && (
        <Modal
          title="Reset this password?"
          subtitle={`A new temporary password will be issued for ${fullName(
            confirmReset.firstName,
            confirmReset.lastName
          )}.`}
          onClose={() => setConfirmReset(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmReset(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="KeyRound"
                loading={busyId === confirmReset.id}
                onClick={() => regenerateInvite(confirmReset)}
              >
                Reset password
              </Button>
            </>
          }
        >
          <p className="muted">
            This immediately invalidates {confirmReset.firstName}&rsquo;s current password. They will
            need the new one (shown next) to sign in
            {confirmReset.role === 'shipping'
              ? // A shared bench is not asked to change it — see setTemporaryPassword.
                '. Read it out at the bench; nobody will be prompted to change it.'
              : ' and set a new one.'}
          </p>
        </Modal>
      )}
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
