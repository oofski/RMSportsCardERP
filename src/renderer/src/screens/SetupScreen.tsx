import { useState } from 'react'
import { AuthHero } from './AuthHero'
import { Button, Field, Input } from '../components/ui'
import { useSession } from '../lib/session'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'

/**
 * First-run screen. When the database has no accounts, the very first person to
 * open the app creates the Owner account. Everyone else is added afterwards
 * from the Admin module.
 */
export function SetupScreen(): JSX.Element {
  const { refresh, setUser } = useSession()
  const toast = useToast()
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    companyId: '',
    title: 'Owner',
    email: '',
    password: '',
    confirm: ''
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    if (form.password !== form.confirm) {
      setError('Passwords do not match.')
      return
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      const res = await api.auth.createOwner({
        firstName: form.firstName,
        lastName: form.lastName,
        companyId: form.companyId,
        title: form.title,
        email: form.email,
        password: form.password
      })
      if (!res.ok || !res.user) {
        setError(res.error ?? 'Could not complete setup.')
        return
      }
      await refresh()
      setUser(res.user)
      toast.success('Owner account created. Welcome!')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-viewport">
      <AuthHero />
      <div className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <h2>Set up your workspace</h2>
          <p className="sub">
            You're the first one here. Create the <strong>Owner</strong> account to get started.
          </p>
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
              <Input value={form.companyId} onChange={set('companyId')} placeholder="e.g. RM-001" required />
            </Field>
            <Field label="Title">
              <Input value={form.title} onChange={set('title')} />
            </Field>
          </div>
          <Field label="Email">
            <Input type="email" value={form.email} onChange={set('email')} required />
          </Field>
          <div className="field-row">
            <Field label="Password" hint="At least 8 characters">
              <Input type="password" value={form.password} onChange={set('password')} required />
            </Field>
            <Field label="Confirm password">
              <Input type="password" value={form.confirm} onChange={set('confirm')} required />
            </Field>
          </div>

          <Button type="submit" variant="primary" block loading={busy} icon="ArrowRight">
            Create Owner account
          </Button>
        </form>
      </div>
    </div>
  )
}
