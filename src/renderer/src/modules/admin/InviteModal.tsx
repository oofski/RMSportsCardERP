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
  const [email, setEmail] = useState<ComposedEmail | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    api.email.composeInvite(employee.id, temporaryPassword).then((res) => {
      if (res.ok && res.data) setEmail(res.data)
    })
  }, [employee.id, temporaryPassword])

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
      title="Invite sent-ready"
      subtitle={`Share these details with ${fullName(employee.firstName, employee.lastName)}.`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="secondary"
            icon="Copy"
            onClick={() => email && copy(email.body, 'Email text')}
            disabled={!email}
          >
            Copy email
          </Button>
          <Button variant="primary" icon="Send" loading={sending} onClick={sendEmail} disabled={!email}>
            Send email
          </Button>
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
        <div className="cred-row">
          <span className="k">Email</span>
          <span className="v">
            {employee.email}
            <button className="modal-close" onClick={() => copy(employee.email, 'Email')} title="Copy">
              <Icon name="Copy" size={14} />
            </button>
          </span>
        </div>
        <div className="cred-row">
          <span className="k">Temporary password</span>
          <span className="v">
            {temporaryPassword}
            <button
              className="modal-close"
              onClick={() => temporaryPassword && copy(temporaryPassword, 'Temporary password')}
              title="Copy"
            >
              <Icon name="Copy" size={14} />
            </button>
          </span>
        </div>
      </div>

      <div className="field">
        <label>Invite email preview</label>
        <div className="email-preview">
          {email ? `Subject: ${email.subject}\n\n${email.body}` : 'Preparing email…'}
        </div>
      </div>

      <p className="muted text-sm mt-16">
        “Send email” opens your default mail app with this message pre-filled — review it and hit
        send. The employee sets their own password on first sign-in.
      </p>
    </Modal>
  )
}
