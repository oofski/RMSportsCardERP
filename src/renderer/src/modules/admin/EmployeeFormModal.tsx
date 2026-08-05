import { useState } from 'react'
import type { Employee, EmployeeInvite, EmployeeStatus } from '@shared/types'
import { assignableRoles, roleLabel, ROLES, type Role } from '@shared/permissions'
import { useSession } from '../../lib/session'
import { api } from '../../lib/api'
import { initials } from '../../lib/format'
import { useToast } from '../../components/Toast'
import { Avatar, Button, Field, Input, Modal, Select } from '../../components/ui'

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
    status: (employee?.status ?? 'invited') as EmployeeStatus,
    password: ''
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(employee?.avatarUrl ?? null)
  const [avatarBusy, setAvatarBusy] = useState(false)

  const changePhoto = async (): Promise<void> => {
    if (!employee) return
    setAvatarBusy(true)
    try {
      const res = await api.employees.setAvatar(employee.id)
      if (res.ok && res.data) {
        setAvatarUrl(res.data.avatarUrl)
        await onUpdated()
        toast.success('Profile picture updated.')
      } else if (res.error && res.error !== 'No image selected.') {
        toast.error(res.error)
      }
    } finally {
      setAvatarBusy(false)
    }
  }
  const removePhoto = async (): Promise<void> => {
    if (!employee) return
    setAvatarBusy(true)
    try {
      const res = await api.employees.removeAvatar(employee.id)
      if (res.ok) {
        setAvatarUrl(null)
        await onUpdated()
        toast.success('Profile picture removed.')
      } else {
        toast.error(res.error ?? 'Could not remove the picture.')
      }
    } finally {
      setAvatarBusy(false)
    }
  }

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
      setForm((f) => ({ ...f, [k]: e.target.value }))

  // Roles the current user may assign, plus the existing role when editing.
  const allowed = new Set<Role>(user ? assignableRoles(user.role) : ['staff'])
  if (employee) allowed.add(employee.role)
  const roleOptions = ROLES.filter((r) => allowed.has(r.id))

  // The packing floor is staffed by people who have no company address, so for
  // that role alone the box is optional — they sign in with their Company ID.
  const emailOptional = form.role === 'shipping'

  // …and for that role alone an administrator types the password here, because
  // the computer is shared: there is nobody to own a generated one and nobody
  // who could answer a "choose your own" prompt without locking the other three
  // out. Only on creation — an existing account's password is changed through
  // Reset, which is the one path that invalidates the old one.
  const needsPassword = !isEdit && form.role === 'shipping'

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    // Switching the role back with the box left empty has to say so. The Save
    // button calls this directly, so the input's own `required` never fires.
    if (!emailOptional && !form.email.trim()) {
      setError(`An email address is required for the ${roleLabel(form.role)} role.`)
      return
    }
    if (needsPassword && form.password.length < 8) {
      setError('Set a password of at least 8 characters for this account.')
      return
    }
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
          role: form.role,
          // Only for the role that takes one. Sending it otherwise would put a
          // typed string on a path where nothing hashes it.
          password: needsPassword ? form.password : undefined
        })
        if (!res.ok || !res.data) {
          setError(res.error ?? 'Could not create employee.')
          return
        }
        // Drop the plaintext the moment it is no longer needed — this component
        // stays mounted until its parent closes it.
        setForm((f) => ({ ...f, password: '' }))
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
          : needsPassword
            ? 'Set the password the packing bench signs in with.'
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

        {isEdit && employee && (
          <div className="emp-avatar-row">
            <Avatar text={initials(form.firstName, form.lastName)} src={avatarUrl} />
            <div className="emp-avatar-actions">
              <Button
                size="sm"
                variant="secondary"
                icon="ImagePlus"
                loading={avatarBusy}
                onClick={changePhoto}
                type="button"
              >
                {avatarUrl ? 'Change photo' : 'Add photo'}
              </Button>
              {avatarUrl && (
                <Button size="sm" variant="ghost" icon="Trash2" onClick={removePhoto} type="button">
                  Remove
                </Button>
              )}
            </div>
          </div>
        )}

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

        <Field
          label={emailOptional ? 'Email (optional)' : 'Email'}
          hint={emailOptional ? 'Leave it blank — they’ll sign in with their Company ID.' : undefined}
        >
          <Input
            type="email"
            value={form.email}
            onChange={set('email')}
            required={!emailOptional}
          />
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

        {needsPassword && (
          <Field
            label="Bench password"
            hint="At least 8 characters. They sign in with the Company ID and this password."
          >
            <Input
              type="password"
              value={form.password}
              onChange={set('password')}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </Field>
        )}

        {/* Hidden submit to enable Enter-to-save */}
        <button type="submit" style={{ display: 'none' }} aria-hidden />
      </form>
    </Modal>
  )
}
