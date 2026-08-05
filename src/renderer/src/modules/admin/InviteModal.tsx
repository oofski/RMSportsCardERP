import { useEffect, useState } from 'react'
import type { ComposedEmail, EmployeeInvite } from '@shared/types'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { fullName } from '../../lib/format'

/**
 * Shown right after an employee is created or re-invited. Presents the
 * temporary credentials and a ready-to-send invite email explaining how to
 * download / access the app and set a password.
 *
 * Shipping staff often have no company address, and for them this is the whole
 * handover: the credentials on screen get read out at the bench. There is no
 * email to compose, so the modal drops that half of itself rather than offering
 * a Send button that opens a mail client addressed to nobody.
 *
 * Not shown at all when nothing was generated — a shipping account is created
 * with a password the administrator typed, and there is no reason to hand one
 * back. See handleCreated in EmployeesTab.
 */
export function InviteModal({
  invite,
  onClose
}: {
  invite: EmployeeInvite
  onClose: () => void
}): JSX.Element {
  const toast = useToast()
  const { employee, temporaryPassword } = invite
  const hasEmail = !!employee.email
  const [email, setEmail] = useState<ComposedEmail | null>(null)
  const [sending, setSending] = useState(false)

  // What happens after they sign in. A shared packing computer is never asked
  // to change its password — there is nobody to own the new one — so promising
  // a prompt that will not appear would leave an admin waiting for a change
  // that never lands.
  const passwordNote = employee.mustChangePassword
    ? 'They set their own password on first sign-in.'
    : 'This password stays as it is — they are not asked to change it.'

  useEffect(() => {
    if (!hasEmail || !temporaryPassword) return
    api.email.composeInvite(employee.id, temporaryPassword).then((res) => {
      if (res.ok && res.data) setEmail(res.data)
    })
  }, [employee.id, temporaryPassword, hasEmail])

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied.`)
    } catch {
      toast.error('Could not copy to clipboard.')
    }
  }

  const sendEmail = async (): Promise<void> => {
    if (!email) return
    setSending(true)
    try {
      const res = await api.email.openExternal(email.mailtoUrl)
      if (res.ok) toast.success('Opening your email client…')
      else toast.error(res.error ?? 'Could not open the email client.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      title={hasEmail ? 'Invite sent-ready' : 'Sign-in details'}
      subtitle={`Share these details with ${fullName(employee.firstName, employee.lastName)}.`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          {hasEmail && (
            <>
              <Button
                variant="secondary"
                icon="Copy"
                onClick={() => email && copy(email.body, 'Email text')}
                disabled={!email}
              >
                Copy email
              </Button>
              <Button
                variant="primary"
                icon="Send"
                loading={sending}
                onClick={sendEmail}
                disabled={!email}
              >
                Send email
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="cred-box">
        <div className="cred-row">
          <span className="k">Company ID</span>
          <span className="v">
            {employee.companyId}
            <button className="modal-close" onClick={() => copy(employee.companyId, 'Company ID')} title="Copy">
              <Icon name="Copy" size={14} />
            </button>
          </span>
        </div>
        {hasEmail && (
          <div className="cred-row">
            <span className="k">Email</span>
            <span className="v">
              {employee.email}
              <button
                className="modal-close"
                onClick={() => copy(employee.email, 'Email')}
                title="Copy"
              >
                <Icon name="Copy" size={14} />
              </button>
            </span>
          </div>
        )}
        {temporaryPassword && (
          <div className="cred-row">
            <span className="k">Temporary password</span>
            <span className="v">
              {temporaryPassword}
              <button
                className="modal-close"
                onClick={() => copy(temporaryPassword, 'Temporary password')}
                title="Copy"
              >
                <Icon name="Copy" size={14} />
              </button>
            </span>
          </div>
        )}
      </div>

      {hasEmail ? (
        <>
          <div className="field">
            <label>Invite email preview</label>
            <div className="email-preview">
              {email ? `Subject: ${email.subject}\n\n${email.body}` : 'Preparing email…'}
            </div>
          </div>

          <p className="muted text-sm mt-16">
            “Send email” opens your default mail app with this message pre-filled — review it and hit
            send. {passwordNote}
          </p>
        </>
      ) : (
        <p className="muted text-sm mt-16">
          No email on this account — read these out. They sign in with the Company ID above.
        </p>
      )}
    </Modal>
  )
}
