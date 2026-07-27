import { useCallback, useEffect, useState } from 'react'
import type { QboEnvironment, QboStatus } from '@shared/quickbooks'
import { QBO_REDIRECT_URI } from '@shared/quickbooks'
import { api } from '../../lib/api'
import { Button, CenterLoader, Field, Input, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'

/**
 * QuickBooks Online connection.
 *
 * The secret is write-only: it is typed here, sent once, and stored encrypted
 * by the main process. Nothing ever reads it back, so the field is always blank
 * on load and "saved" is shown by the client-id hint rather than by echoing
 * anything sensitive into the DOM.
 *
 * Connecting opens the operator's real browser — Intuit blocks embedded
 * webviews for sign-in, and it means their password manager and MFA work
 * normally.
 */
export function QuickBooksTab(): JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<QboStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [environment, setEnvironment] = useState<QboEnvironment>('sandbox')
  const [busy, setBusy] = useState<'save' | 'connect' | 'test' | 'disconnect' | 'forget' | null>(null)

  const load = useCallback(async () => {
    const s = await api.quickbooks.status()
    setStatus(s)
    if (s) setEnvironment(s.environment)
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  if (loading) return <CenterLoader />

  if (!status) {
    return (
      <div className="qbo-denied">
        <Icon name="ShieldCheck" size={22} />
        <span>Only an admin can manage the QuickBooks connection.</span>
      </div>
    )
  }

  const run = async (
    key: NonNullable<typeof busy>,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMessage: string
  ): Promise<void> => {
    setBusy(key)
    try {
      const res = await fn()
      if (!res.ok) toast.error(res.error ?? 'That did not work.')
      else toast.success(okMessage)
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="qbo-page">
      <div className="qbo-state" data-connected={status.connected ? 'true' : 'false'}>
        <span className="qbo-dot" />
        <div className="qbo-state-main">
          <div className="qbo-state-title">
            {status.connected
              ? `Connected${status.companyName ? ` — ${status.companyName}` : ''}`
              : status.configured
                ? 'Set up, not connected'
                : 'Not set up'}
          </div>
          <div className="qbo-state-sub">
            {status.connected ? (
              <>
                {status.environment === 'production' ? 'Production' : 'Sandbox'} · company{' '}
                {status.realmId}
                {status.refreshExpiresAt && (
                  <> · re-authorise by {formatDateTime(status.refreshExpiresAt)}</>
                )}
              </>
            ) : status.configured ? (
              <>
                Client …{status.clientIdHint} ·{' '}
                {status.environment === 'production' ? 'production' : 'sandbox'}
              </>
            ) : (
              'Enter the app credentials from the Intuit developer portal to begin.'
            )}
          </div>
        </div>
        {status.connected && (
          <Button
            icon="RefreshCw"
            loading={busy === 'test'}
            disabled={busy !== null}
            onClick={() => void run('test', () => api.quickbooks.test(), 'QuickBooks responded.')}
          >
            Test
          </Button>
        )}
      </div>

      {status.lastError && (
        <div className="qbo-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{status.lastError}</span>
        </div>
      )}

      <div className="qbo-form">
        <Field label="Client ID">
          <Input
            value={clientId}
            placeholder={status.configured ? `Saved — ends …${status.clientIdHint}` : 'From the Intuit developer portal'}
            onChange={(e) => setClientId(e.target.value)}
          />
        </Field>
        <Field label="Client secret">
          <Input
            type="password"
            value={clientSecret}
            placeholder={status.configured ? 'Saved — type to replace' : 'From the Intuit developer portal'}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </Field>
        <Field label="Environment">
          <Select value={environment} onChange={(e) => setEnvironment(e.target.value as QboEnvironment)}>
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </Select>
        </Field>
      </div>

      {/* The single most common reason a connection fails, so it is stated
          rather than left in a doc nobody opens. */}
      <div className="qbo-note">
        <Icon name="Info" size={15} />
        <div>
          Add this exact redirect URI to the app in the Intuit developer portal, or consent will be
          rejected:
          <code className="qbo-uri">{QBO_REDIRECT_URI}</code>
        </div>
      </div>

      <div className="qbo-actions">
        <Button
          variant="primary"
          icon="Save"
          loading={busy === 'save'}
          disabled={busy !== null || !clientId.trim() || !clientSecret.trim()}
          onClick={() =>
            void run(
              'save',
              async () => {
                const res = await api.quickbooks.saveConfig(clientId, clientSecret, environment)
                if (res.ok) {
                  // Never keep the secret in renderer state longer than the call.
                  setClientId('')
                  setClientSecret('')
                }
                return res
              },
              'Credentials saved.'
            )
          }
        >
          Save credentials
        </Button>

        <Button
          icon="ExternalLink"
          loading={busy === 'connect'}
          disabled={busy !== null || !status.configured}
          onClick={() =>
            void run('connect', () => api.quickbooks.connect(), 'QuickBooks connected.')
          }
        >
          {status.connected ? 'Reconnect' : 'Connect to QuickBooks'}
        </Button>

        <span className="qbo-spacer" />

        {status.connected && (
          <Button
            icon="Ban"
            loading={busy === 'disconnect'}
            disabled={busy !== null}
            onClick={() =>
              void run('disconnect', () => api.quickbooks.disconnect(), 'Disconnected.')
            }
          >
            Disconnect
          </Button>
        )}
        {status.configured && (
          <Button
            variant="danger"
            icon="Trash2"
            loading={busy === 'forget'}
            disabled={busy !== null}
            onClick={() => {
              if (!window.confirm('Forget the QuickBooks client id and secret on this machine?')) return
              void run('forget', () => api.quickbooks.forget(), 'Credentials removed.')
            }}
          >
            Forget credentials
          </Button>
        )}
      </div>
    </div>
  )
}
