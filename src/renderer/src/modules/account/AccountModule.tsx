import { useState } from 'react'
import { Button, Field, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useSession } from '../../lib/session'
import { useToast } from '../../components/Toast'
import { api } from '../../lib/api'
import { roleLabel } from '@shared/permissions'
import { NotificationsPanel } from './NotificationsPanel'

/**
 * Your own account: the two things every person here needs to be able to do for
 * themselves, and previously could not.
 *
 * ## Why this module exists at all
 *
 * Both halves already worked. Neither was reachable.
 *
 * Changing a password existed only as the FORCED screen an invited employee
 * meets once, before they are let into the app — after that there was no route
 * back to it. Somebody who thought their password had been seen over their
 * shoulder had to ask an administrator to reset it, which means the fix for a
 * compromised credential ran through a second person and a conversation.
 *
 * Turning notifications on lived in Admin, behind `admin.access`, which is
 * exactly the set of people who are already at a desk. The floor — the people a
 * notification is FOR — could not open the screen, and the IPC underneath it
 * refused them anyway. See src/main/pushIpc.ts for that half of the fix.
 *
 * So: no permission on this module. `permission: null` in the registry, and it
 * is deliberate rather than an omission. There is nothing here to gate — it is
 * your password and your phone, and every gate that was ever put in front of
 * either turned out to be protecting nothing while locking out the person the
 * feature was built for.
 */
export function AccountModule(): JSX.Element {
  const { user, can } = useSession()

  return (
    <div className="content-narrow acct">
      <section className="acct-who">
        <div className="acct-who-id">
          <h2>
            {user ? `${user.firstName} ${user.lastName}`.trim() || 'Your account' : 'Your account'}
          </h2>
          <p>
            {[user ? roleLabel(user.role) : null, user?.title, user?.companyId, user?.email]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </section>

      {/* THE PACKING BENCH DOES NOT GET THIS, and it is the one exception in a
          module whose whole argument is that there is nothing here to gate.
          A bench account is SHARED — `insertEmployee` types a password and
          reads it out rather than generating one, and `setTemporaryPassword`
          pointedly skips the must-change prompt, both for the same reason: "the
          four people using the computer" cannot agree on a password, and
          whoever sits down first would be changing it out from under the other
          three. Worse, `setChosenPassword` revokes every other session for that
          employee id, so one packer pressing this would sign out every other
          bench mid-shift. That is not somebody managing their own credential;
          it is one person taking a shared one hostage.

          Not a permission, because it is not about trust or rank — it is about
          the account being a place rather than a person. */}
      {user?.role === 'shipping' ? (
        <section className="acct-section">
          <header className="acct-head">
            <Icon name="KeyRound" size={17} />
            <div>
              <h3>Password</h3>
              <p>This is a shared bench account, so its password is not yours to change.</p>
            </div>
          </header>
          <p className="acct-note" style={{ padding: '14px 18px' }}>
            Everybody on this bench signs in with the same details, so changing them here would
            lock out whoever is packing next to you. Ask whoever runs the floor if it needs
            changing — they can set a new one and read it out.
          </p>
        </section>
      ) : (
        <PasswordPanel />
      )}

      <section className="acct-section">
        <header className="acct-head">
          <Icon name="Bell" size={17} />
          <div>
            <h3>Notifications on your phone</h3>
            <p>Turn them on for the device you are reading this on.</p>
          </div>
        </header>
        <NotificationsPanel canClock={can('notifications.clock')} />
      </section>
    </div>
  )
}

/**
 * Change your own password.
 *
 * The current password is required and that is not a formality: it is the only
 * thing standing between an unattended, unlocked machine and a permanent
 * takeover of somebody's account. A form that let you set a new password from an
 * already-signed-in session without proving you knew the old one would make
 * every unlocked laptop a door.
 *
 * Every other browser this person is signed in on is signed out when it
 * succeeds, and the one they are using is not — that rule lives in
 * `setChosenPassword`, and the sentence under the button is here so the effect
 * is not a surprise. Somebody changing their password because they think it was
 * seen NEEDS the other sessions dropped; being thrown out of the page they are
 * standing on would just make them think it failed.
 */
function PasswordPanel(): JSX.Element {
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    // Checked here for a civil message, and again in the main process, which is
    // the boundary that counts. The floor is 8 in both places.
    if (next !== confirm) {
      setError('The new passwords do not match.')
      return
    }
    if (next.length < 8) {
      setError('The new password must be at least 8 characters.')
      return
    }
    if (next === current) {
      setError('That is the password you already have.')
      return
    }
    setBusy(true)
    try {
      const res = await api.auth.changePassword(current, next)
      if (!res.ok) {
        setError(res.error ?? 'Could not change your password.')
        return
      }
      // Cleared on success only. Leaving what they typed in the boxes after a
      // failure means they can fix the one field that was wrong instead of
      // starting again.
      setCurrent('')
      setNext('')
      setConfirm('')
      toast.success('Password changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="acct-section">
      <header className="acct-head">
        <Icon name="KeyRound" size={17} />
        <div>
          <h3>Password</h3>
          <p>Change it here. You do not need an administrator.</p>
        </div>
      </header>

      <form className="acct-form" onSubmit={submit}>
        {error && <div className="auth-alert">{error}</div>}

        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <Input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </Field>
        <Field label="Confirm new password">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>

        <div className="acct-actions">
          <Button type="submit" variant="primary" loading={busy} icon="Check">
            Change password
          </Button>
          <p className="acct-note">
            Changing it signs you out everywhere else — another computer, a phone, a browser you
            forgot about. This one stays signed in.
          </p>
        </div>
      </form>
    </section>
  )
}
