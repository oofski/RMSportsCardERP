import { useState } from 'react'
import { AuthHero } from './AuthHero'
import { Button, Field, Input } from '../components/ui'
import { useSession } from '../lib/session'
import { api } from '../lib/api'

export function LoginScreen(): JSX.Element {
  const { setUser } = useSession()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await api.auth.login(identifier, password)
      if (!res.ok || !res.user) {
        setError(res.error ?? 'Sign-in failed.')
        return
      }
      setUser(res.user)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-viewport">
      <AuthHero />
      <div className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="sub">Welcome back. Enter your credentials to continue.</p>
          {error && <div className="auth-alert">{error}</div>}

          <Field label="Company ID or email">
            <Input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="RM-001"
              autoFocus
              required
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>

          <Button type="submit" variant="primary" block loading={busy} icon="ArrowRight">
            Sign in
          </Button>

          <p className="muted text-sm" style={{ marginTop: 18, textAlign: 'center' }}>
            New here? Your administrator sends an invite with a temporary password.
          </p>
        </form>
      </div>
    </div>
  )
}
