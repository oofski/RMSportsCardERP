import { useCallback, useEffect, useState } from 'react'
import type { QboEnvironment, QboStatus } from '@shared/quickbooks'
import { QBO_REDIRECT_URI } from '@shared/quickbooks'
import { api } from '../../lib/api'
import { Button, CenterLoader, Field, Input, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'
import { QboAccountMapping } from './QboAccountMapping'

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
  const [busy, setBusy] = useState<
    'save' | 'connect' | 'test' | 'disconnect' | 'forget' | 'paste' | null
  >(null)
  // Manual path: tokens minted in Intuit's OAuth Playground, which every app
  // already has a registered redirect for. Needed when the loopback redirect
  // cannot be registered — Intuit rejects some http:// URIs outright.
  const [showManual, setShowManual] = useState(false)
  const [accessToken, setAccessToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [realmId, setRealmId] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)

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
          rather than left in a doc nobody opens — and copyable, because a
          hand-typed redirect URI has to match Intuit's copy character for
          character or consent is refused. */}
      <div className="qbo-note">
        <Icon name="Info" size={15} />
        <div>
          Add this exact redirect URI to the app in the Intuit developer portal — under the SAME
          tab (Development or Production) as the keys you saved — or consent will be rejected:
          <code className="qbo-uri">{QBO_REDIRECT_URI}</code>
          <div className="qbo-note-acts">
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                void navigator.clipboard.writeText(QBO_REDIRECT_URI)
                toast.success('Redirect URI copied.')
              }}
            >
              <Icon name="Copy" size={13} /> Copy redirect URI
            </button>
            {status.configured && (
              <button
                type="button"
                className="link-btn"
                onClick={async () => {
                  const res = await api.quickbooks.authorizeUrl()
                  if (!res.ok || !res.data) {
                    toast.error(res.error ?? 'Could not build the URL.')
                    return
                  }
                  setAuthUrl(res.data.url)
                }}
              >
                <Icon name="Search" size={13} /> Show what the app sends
              </button>
            )}
          </div>
        </div>
      </div>

      {authUrl && (
        <div className="qbo-note">
          <Icon name="ExternalLink" size={15} />
          <div>
            The exact URL the app opens. Paste it into a browser to test consent alone.
            <code className="qbo-uri">{authUrl}</code>
            <div className="qbo-note-acts">
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(authUrl)
                  toast.success('Authorize URL copied.')
                }}
              >
                <Icon name="Copy" size={13} /> Copy
              </button>
              <button type="button" className="link-btn" onClick={() => setAuthUrl(null)}>
                Hide
              </button>
            </div>
          </div>
        </div>
      )}

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
            icon="ClipboardPaste"
            disabled={busy !== null}
            onClick={() => setShowManual((v) => !v)}
          >
            {showManual ? 'Hide manual tokens' : 'Paste tokens instead'}
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
      {showManual && (
        <div className="qbo-manual">
          <div className="qbo-manual-head">
            <Icon name="ClipboardPaste" size={15} />
            <div>
              <b>Connect with tokens from the OAuth Playground</b>
              <p>
                For when the loopback redirect cannot be registered. Authorise in Intuit&rsquo;s
                OAuth Playground and paste the tokens — once only.
              </p>
            </div>
          </div>
          <div className="qbo-form">
            <Field label="Refresh token">
              <Input
                value={refreshToken}
                placeholder="Required — the long-lived one"
                onChange={(e) => setRefreshToken(e.target.value)}
              />
            </Field>
            <Field label="Company (realm) id">
              <Input
                value={realmId}
                placeholder="Required — e.g. 4620816365..."
                onChange={(e) => setRealmId(e.target.value)}
              />
            </Field>
            <Field label="Access token (optional)">
              <Input
                value={accessToken}
                placeholder="Left blank, a fresh one is fetched immediately"
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </Field>
          </div>
          <Button
            variant="primary"
            icon="Check"
            loading={busy === 'paste'}
            disabled={busy !== null || !refreshToken.trim() || !realmId.trim()}
            onClick={() =>
              void run(
                'paste',
                async () => {
                  const res = await api.quickbooks.pasteTokens(accessToken, refreshToken, realmId)
                  if (res.ok) {
                    setAccessToken('')
                    setRefreshToken('')
                    setRealmId('')
                    setShowManual(false)
                  }
                  return res
                },
                'QuickBooks connected.'
              )
            }
          >
            Use these tokens
          </Button>
        </div>
      )}

      <QboAccountMapping connected={status.connected} />
    </div>
  )
}
