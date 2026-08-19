import { useCallback, useEffect, useState } from 'react'
import type { RedactedEmailSettings } from '@shared/emailSettings'
import {
  SMTP_STARTTLS_PORT,
  SMTP_TLS_PORT,
  validateEmailSettings
} from '@shared/emailSettings'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import { Button, Checkbox, Field, Input, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'

/**
 * The mail account this app sends labels from.
 *
 * ## Why the app needs one at all
 *
 * Until now the only thing it could do with an email was build a `mailto:` and
 * hand it to whatever the operator has open. That works, needs no setup, and
 * cannot carry an attachment — which is the entire point of the feature it is
 * standing in for. A shipping label is a file, and a supplier waiting on one
 * does not want a message describing it.
 *
 * ## The password never comes back
 *
 * `emailSettings()` returns everything except the password, and the box is drawn
 * blank whether or not one is stored — `hasPassword` is what tells the two
 * apart. Saving with it blank KEEPS the stored one, so correcting a port does
 * not silently wipe the account.
 *
 * That is not politeness about secrets. This renderer is also served as a
 * browser tab, and an SMTP password sitting in a page's memory is reachable by
 * an extension, a heap snapshot or a stray error report — for no gain, because
 * the form never needs to display it.
 *
 * ## It fills itself in from who is signed in
 *
 * Every employee record already carries an email address, so the person setting
 * this up is almost certainly typing their own — and the app already knows it.
 * The sign-in address seeds the username and the from-address, and their name
 * seeds the display name. All three stay editable, because a shared
 * orders@ mailbox is a perfectly ordinary thing to send from and is not anybody's
 * personal address.
 */
export function MailAccountPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const toast = useToast()
  const { user } = useSession()

  const [loaded, setLoaded] = useState(false)
  const [stored, setStored] = useState<RedactedEmailSettings | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(SMTP_TLS_PORT))
  const [secure, setSecure] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [fromName, setFromName] = useState('')
  const [fromAddress, setFromAddress] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const current = await api.orders.emailSettings()
    setStored(current)
    if (current) {
      setHost(current.host)
      setPort(String(current.port))
      setSecure(current.secure)
      setUsername(current.user)
      setFromName(current.fromName)
      setFromAddress(current.fromAddress)
    } else if (user) {
      // NOTHING SAVED YET, so seed from the account of whoever is setting it up.
      // The app already holds their address; making them retype it would be
      // asking for something it can see.
      setUsername(user.email ?? '')
      setFromAddress(user.email ?? '')
      setFromName(`${user.firstName ?? ''} ${user.lastName ?? ''}`.trim())
    }
    setLoaded(true)
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const draft = {
    host: host.trim(),
    port: Number(port),
    secure,
    user: username.trim(),
    // Blank means "keep what is stored", which is only VALID when something is
    // stored. Validating against a placeholder keeps the check honest about
    // which of the two situations the form is in.
    password: password.trim() || (stored?.hasPassword ? 'kept' : ''),
    fromName: fromName.trim(),
    fromAddress: fromAddress.trim()
  }
  const problem = validateEmailSettings(draft)

  const save = async (): Promise<void> => {
    if (busy || problem) return
    setBusy(true)
    try {
      const res = await api.orders.saveEmailSettings({
        host: draft.host,
        port: draft.port,
        secure,
        user: draft.user,
        // The real value, or empty to keep the stored one. Never the placeholder.
        password: password.trim(),
        fromName: draft.fromName,
        fromAddress: draft.fromAddress
      })
      if (!res.ok) {
        toast.error(res.error ?? 'Those settings were refused.')
        return
      }
      setPassword('')
      setStored(res.data ?? null)
      toast.success('Mail account saved. Try it below to be sure it works.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Try the account now.
   *
   * Tests what is STORED, not what is on screen — so what is proved is exactly
   * what a send will use. That is also why the button says to save first: an
   * operator who tested an unsaved form and then closed it would have proved
   * something about a configuration that no longer exists.
   */
  const verify = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.orders.verifyEmailSettings()
      if (!res.ok) {
        toast.error(res.error ?? 'The mail server would not accept it.')
        return
      }
      toast.success('The mail server accepted it. Labels can be sent from here.')
    } finally {
      setBusy(false)
    }
  }

  const forget = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await api.orders.clearEmailSettings()
      setStored(null)
      setPassword('')
      toast.success('Mail account removed. Emails fall back to opening your own mail app.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Send labels from your own email"
      subtitle="So a label goes out attached, instead of being described in a message"
      onClose={() => (busy ? undefined : onClose())}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {stored && (
            <Button variant="secondary" icon="Send" disabled={busy} onClick={() => void verify()}>
              Try it
            </Button>
          )}
          <Button
            variant="primary"
            icon="Save"
            loading={busy}
            disabled={busy || !!problem}
            onClick={() => void save()}
          >
            Save
          </Button>
        </>
      }
    >
      {!loaded ? (
        <p className="fin-confirm-lead">Loading…</p>
      ) : (
        <>
          <p className="mail-lead">
            This is an <b>app password</b> from your email provider, not your normal password —
            every provider refuses the normal one over SMTP once two-factor is on. Nothing here
            leaves this machine: it is encrypted locally, exactly like the QuickBooks connection,
            and it is never synced.
          </p>

          <Field label="Mail server" hint="Just the hostname — no https://, no port.">
            <Input
              value={host}
              placeholder="smtp.gmail.com"
              autoFocus
              onChange={(e) => setHost(e.target.value)}
            />
          </Field>

          <div className="mail-row">
            <Field label="Port">
              <Input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </Field>
            <Checkbox
              checked={secure}
              onChange={(next) => {
                setSecure(next)
                // The two go together and getting them apart is the failure that
                // reports itself worst: a handshake sent at the wrong port does
                // not error, it hangs until the socket times out. Moving the
                // port with the tick means the ordinary case is never wrong.
                setPort(String(next ? SMTP_TLS_PORT : SMTP_STARTTLS_PORT))
              }}
              label={`Encrypted from the start (port ${SMTP_TLS_PORT})`}
              hint={`Untick for STARTTLS on port ${SMTP_STARTTLS_PORT}. Both are encrypted; the wrong pairing just hangs.`}
            />
          </div>

          <Field label="Username" hint="Usually the whole email address.">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </Field>

          <Field
            label="App password"
            hint={
              stored?.hasPassword
                ? 'A password is saved. Leave this blank to keep it.'
                : 'From your provider’s security settings.'
            }
          >
            <Input
              type="password"
              value={password}
              placeholder={stored?.hasPassword ? '••••••••  (saved)' : ''}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field label="Send as" hint="The name and address a supplier sees on the message.">
            <div className="mail-row">
              <Input
                value={fromName}
                placeholder="Your name"
                onChange={(e) => setFromName(e.target.value)}
              />
              <Input
                value={fromAddress}
                type="email"
                placeholder="you@example.com"
                onChange={(e) => setFromAddress(e.target.value)}
              />
            </div>
          </Field>

          {problem && (
            <p className="mail-problem">
              <Icon name="AlertTriangle" size={14} />
              {problem}
            </p>
          )}

          {stored && (
            <p className="mail-foot">
              <button type="button" className="mail-forget" disabled={busy} onClick={() => void forget()}>
                Remove this account
              </button>
              <span>
                {' '}
                — label emails go back to opening your own mail app, where they cannot carry the
                label itself.
              </span>
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
