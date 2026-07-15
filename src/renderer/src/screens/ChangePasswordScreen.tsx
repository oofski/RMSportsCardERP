import { useState } from 'react'
import { AuthHero } from './AuthHero'
import { Button, Field, Input } from '../components/ui'
import { useSession } from '../lib/session'
import { useToast } from '../components/Toast'
import { api } from '../lib/api'

/**
 * Shown after an invited employee signs in with their temporary password. They
 * must choose their own password before reaching the app.
 */
export function ChangePasswordScreen(): JSX.Element {
  const { user, refresh, logout } = useSession()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    if (next !== confirm) {
      setError('New passwords do not match.')
      return
    }
    if (next.length < 8) {
      setError('New password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      const res = await api.auth.changePassword(current, next)
      if (!res.ok) {
        setError(res.error ?? 'Could not change password.')
        return
      }
      await refresh()
      toast.success('Password updated. Welcome aboard!')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-viewport">
      <AuthHero />
      <div className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <h2>Set your password</h2>
          <p className="sub">
            Hi {user?.firstName}, choose a password to secure your account before continuing.
          </p>
          <div className="auth-note">
            Enter the temporary password from your invite email, then pick a new one.
          </div>
          {error && <div className="auth-alert">{error}</div>}

          <Field label="Temporary password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </Field>

          <Button type="submit" variant="primary" block loading={busy} icon="Check">
            Save password & continue
          </Button>
          <Button
            type="button"
            variant="ghost"
            block
            className="mt-16"
            onClick={() => logout()}
          >
            Sign out
          </Button>
        </form>
      </div>
    </div>
  )
}
