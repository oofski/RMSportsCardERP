import { useState } from 'react'
import { Button, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useSession } from '../../lib/session'
import { useToast } from '../../components/Toast'
import { api } from '../../lib/api'
import { roleLabel } from '@shared/permissions'
import { NotificationsPanel } from './NotificationsPanel'

/**
 * Your own account, in a panel off your own name.
 *
 * ## Why this is not a screen
 *
 * It was one, briefly, and it should not have been. The sidebar is a list of
 * places the WORK happens; your password and your phone are not work, they are
 * housekeeping, and giving them a permanent slot in that list put them
 * alongside Inventory and Finance as though somebody might spend their morning
 * there. It is opened perhaps twice a year.
 *
 * So it hangs off the name in the top right, which is where every other
 * application puts it and therefore the first place anybody looks — and it
 * opens where it was clicked rather than replacing the screen behind it.
 * Nobody navigates AWAY from what they were doing to change a password.
 *
 * ## A modal rather than the menu itself
 *
 * The obvious reading of "put it under the dropdown" is to inline it, and it
 * does not survive contact with the content: three password fields, a
 * notification toggle, a device list, the iOS home-screen instructions in full
 * and a note about where the notifications go. That is a popover taller than
 * the window, anchored to a corner, scrolling inside itself. The menu holds the
 * ENTRY; the panel holds the content.
 *
 * ## What is inside is unchanged
 *
 * Both halves already worked and neither was reachable. Changing a password
 * existed only as the FORCED screen an invited employee meets once, so the fix
 * for a credential somebody thought was seen ran through an administrator and a
 * conversation. Turning notifications on lived in Admin behind `admin.access` —
 * exactly the people already at a desk — and the IPC underneath refused the
 * floor anyway. See src/main/pushIpc.ts for that half.
 *
 * No permission on any of it. It is your password and your phone, and every
 * gate ever put in front of either turned out to be protecting nothing while
 * locking out the person the feature was built for.
 */
export function AccountPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const { user, can } = useSession()

  return (
    <Modal
      title="My account"
      subtitle={[user ? roleLabel(user.role) : null, user?.title, user?.companyId, user?.email]
        .filter(Boolean)
        .join(' · ')}
      onClose={onClose}
      wide
      className="acct-modal"
    >
    <div className="acct">

      {/* A SHARED BENCH DOES NOT GET THIS, and it is the one exception in a
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
          the account being a place rather than a person.

          THAT IS NOW READ FROM THE ACCOUNT, NOT THE ROLE. This tested
          `role === 'shipping'`, which is the role real packers work on, so every
          actual employee on the floor was refused their own credential and no
          administrator could grant it. `sharedAccount` is the fact itself; see
          the v75 migration. The refusal is also enforced in changeOwnPassword,
          because hiding a form is not the same as saying no. */}
      {user?.sharedAccount ? (
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
    </Modal>
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
