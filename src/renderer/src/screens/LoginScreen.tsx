import { useEffect, useState } from 'react'
import { AuthHero } from './AuthHero'
import { Button, Checkbox, Field, Input } from '../components/ui'
import { useSession } from '../lib/session'
import { api } from '../lib/api'

export function LoginScreen(): JSX.Element {
  const { setUser, refresh } = useSession()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Prefill from remembered credentials so people just click Sign in.
  useEffect(() => {
    api.credentials.get().then((creds) => {
      if (creds) {
        setIdentifier(creds.identifier)
        setPassword(creds.password)
        setRemember(true)
      }
    })
  }, [])

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
      // Persist or clear remembered credentials based on the checkbox.
      if (remember) await api.credentials.set({ identifier, password })
      else await api.credentials.clear()
      setUser(res.user)
      /**
       * AND RE-READ THE SESSION, which is what hydrates the shelf registry.
       *
       * `refresh` runs once on mount — before anybody is signed in, when the
       * locations read 401s and is swallowed — so a session that signed in on
       * this page-load kept the built-in RM/AM registry until somebody reloaded
       * the window. Every screen that asks `destinationHoldsStock` was then
       * drawing a Roadshow shop as a dropship, and the roadshow tab picker came
       * up empty because it had no shops to list.
       *
       * Swallowed, and AFTER setUser: the sign-in itself has already succeeded,
       * and a failed re-read must not bounce somebody back to this form.
       */
      await refresh().catch(() => undefined)
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

          <div style={{ margin: '2px 0 18px' }}>
            <Checkbox checked={remember} onChange={setRemember} label="Remember me on this device" />
          </div>

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
