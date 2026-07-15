import { useState } from 'react'
import type { Employee, EmployeeInvite, EmployeeStatus } from '@shared/types'
import { assignableRoles, ROLES, type Role } from '@shared/permissions'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'

const STATUS_OPTIONS: { value: EmployeeStatus; label: string }[] = [
  { value: 'invited', label: 'Invited' },
  { value: 'active', label: 'Active' },
  { value: 'disabled', label: 'Deactivated' }
]

export function EmployeeFormModal({
  employee,
  onClose,
  onCreated,
  onUpdated
}: {
  employee: Employee | null
  onClose: () => void
  onCreated: (invite: EmployeeInvite) => void | Promise<void>
  onUpdated: () => void | Promise<void>
}): JSX.Element {
  const { user } = useSession()
  const toast = useToast()
  const isEdit = !!employee

  const [form, setForm] = useState({
    firstName: employee?.firstName ?? '',
    lastName: employee?.lastName ?? '',
    companyId: employee?.companyId ?? '',
    title: employee?.title ?? '',
    email: employee?.email ?? '',
    role: (employee?.role ?? 'staff') as Role,
    status: (employee?.status ?? 'invited') as EmployeeStatus
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  // Roles the current user may assign, plus the existing role when editing.
  const allowed = new Set<Role>(user ? assignableRoles(user.role) : ['staff'])
  if (employee) allowed.add(employee.role)
  const roleOptions = ROLES.filter((r) => allowed.has(r.id))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (isEdit && employee) {
        const res = await api.employees.update({
          id: employee.id,
          firstName: form.firstName,
          lastName: form.lastName,
          companyId: form.companyId,
          title: form.title,
          email: form.email,
          role: form.role,
          status: form.status
        })
        if (!res.ok) {
          setError(res.error ?? 'Could not update employee.')
          return
        }
        await onUpdated()
      } else {
        const res = await api.employees.create({
          firstName: form.firstName,
          lastName: form.lastName,
          companyId: form.companyId,
          title: form.title,
          email: form.email,
          role: form.role
        })
        if (!res.ok || !res.data) {
          setError(res.error ?? 'Could not create employee.')
          return
        }
        toast.success(`${form.firstName} ${form.lastName} added.`)
        await onCreated(res.data)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit employee' : 'Add employee'}
      subtitle={
        isEdit
          ? 'Update this employee’s details, role or status.'
          : 'They’ll get a temporary password to set up their account.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={isEdit ? 'Check' : 'UserPlus'}
            loading={busy}
            onClick={submit}
          >
            {isEdit ? 'Save changes' : 'Add employee'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {error && <div className="auth-alert">{error}</div>}

        <div className="field-row">
          <Field label="First name">
            <Input value={form.firstName} onChange={set('firstName')} required autoFocus />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName} onChange={set('lastName')} required />
          </Field>
        </div>

        <div className="field-row">
          <Field label="Company ID">
            <Input value={form.companyId} onChange={set('companyId')} placeholder="RM-002" required />
          </Field>
          <Field label="Title">
            <Input value={form.title} onChange={set('title')} placeholder="e.g. Fulfillment Lead" />
          </Field>
        </div>

        <Field label="Email">
          <Input type="email" value={form.email} onChange={set('email')} required />
        </Field>

        <div className={isEdit ? 'field-row' : ''}>
          <Field label="Role">
            <Select value={form.role} onChange={set('role')}>
              {roleOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>

          {isEdit && (
            <Field label="Status">
              <Select value={form.status} onChange={set('status')}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        {/* Hidden submit to enable Enter-to-save */}
        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  )
}
