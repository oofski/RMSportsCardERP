import { useCallback, useEffect, useState } from 'react'
import type { QboStatus } from '@shared/quickbooks'
import {
  QBO_DEFAULT_REDIRECT_URI,
  QBO_REDIRECT_URI,
  isLoopbackRedirect,
  readConsentPaste,
  validateClientId,
  validateClientSecret,
  validateRealmId,
  validateRefreshToken
} from '@shared/quickbooks'
import { promotionSummary } from '@shared/quickbooksRelay'
import { api } from '../../lib/api'
import { Button, CenterLoader, Field, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'
import { QboAccountMapping } from './QboAccountMapping'

const INTUIT_APPS_URL = 'https://developer.intuit.com/app/developer/myapps'

/**
 * QuickBooks Online connection — three steps, and nothing else on screen.
 *
 * This used to be one page of fields, warnings and escape hatches, all visible
 * at once, and it was genuinely impossible to follow: the redirect URI mattered
 * only in one case, the Connect button did two different jobs depending on a
 * setting three fields above it, and the manual-token panel looked like a
 * required step. Setting it up failed repeatedly for reasons the screen was
 * technically already explaining.
 *
 * So it is a sequence now. Paste two keys, approve in a browser, paste the
 * address back. Each step appears when the one before it is done, everything
 * conditional lives under Advanced, and the redirect URI has a default that
 * works on production rather than a warning about the one that does not.
 *
 * The secret is still write-only: typed here, sent once, stored encrypted,
 * never read back. "Saved" shows as the last four of the client id rather than
 * by echoing anything sensitive into the DOM.
 *
 * ## And it is now set up ONCE, for the whole company
 *
 * On a build wired to the cloud relay these three steps write to the RELAY, not
 * to this computer. Every admin on every machine, and the web app, then raises
 * invoices through it with nothing to set up — which is the entire point, and is
 * why the screen leads with a strip saying where the connection lives rather
 * than leaving somebody to infer it. `promote` is the one-time move for the
 * machine that was connected before the relay existed.
 */
export function QuickBooksTab(): JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<QboStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [touched, setTouched] = useState<{ id: boolean; secret: boolean }>({ id: false, secret: false })
  /** The whole address the browser landed on. Parsed here, not by the operator. */
  const [landed, setLanded] = useState('')
  const [busy, setBusy] = useState<
    'save' | 'connect' | 'test' | 'disconnect' | 'forget' | 'paste' | 'code' | 'promote' | null
  >(null)
  const [advanced, setAdvanced] = useState(false)
  const [redirectUri, setRedirectUri] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [realmId, setRealmId] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)

  const load = useCallback(async () => {
    const s = await api.quickbooks.status()
    setStatus(s)
    if (s?.redirectUri) setRedirectUri(s.redirectUri)
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

  const idError = clientId.trim() ? validateClientId(clientId) : null
  const secretError = clientSecret.trim() ? validateClientSecret(clientSecret) : null
  const canSave = !!clientId.trim() && !!clientSecret.trim() && !idError && !secretError

  const paste = landed.trim() ? readConsentPaste(landed) : null
  const pasteError = paste && !paste.ok ? paste.error : null

  const onRelay = status.holder === 'relay'
  const relayBuild = !!status.relay

  /**
   * Has step 1 been done — ON THE HOLDER THIS SETUP IS WRITING TO?
   *
   * Not `status.configured`, which is deliberately the LOCAL answer. On a relay
   * build the keys go to Cloudflare and nothing lands on this machine, so
   * reading the local flag would leave step 1 showing as never done and step 2
   * greyed out forever, immediately after a save that worked perfectly.
   */
  const keysSaved = relayBuild ? status.relay?.hasConfig === true : status.configured

  /**
   * WHERE THE CONNECTION LIVES — the first thing on the page, in both states.
   *
   * It leads because it is the question this whole change is the answer to, and
   * because the two possible answers demand completely different actions from
   * whoever is reading. "In the cloud relay" means nobody does anything, ever.
   * "On this computer" means exactly one person has one job left to do.
   */
  const whereItLives = (
    <div className="qbo-where" data-holder={status.holder}>
      <Icon name={onRelay ? 'UploadCloud' : status.holder === 'local' ? 'Lock' : 'Info'} size={16} />
      <div>
        {onRelay ? (
          <>
            <b>The QuickBooks connection lives in the cloud relay.</b> Nothing about QuickBooks is
            set up on this computer, or on anyone else&rsquo;s. Every admin raises invoices through
            it, including from the web app.
          </>
        ) : status.holder === 'local' ? (
          <>
            <b>The QuickBooks connection is on THIS computer only.</b>{' '}
            {relayBuild
              ? 'Nobody else can raise invoices into QuickBooks, and this machine has to be the one that does it. Move it to the relay below and that stops being true.'
              : 'This copy of the app is not wired to a cloud relay, so there is nowhere else it could live.'}
          </>
        ) : (
          <>
            <b>QuickBooks is not connected.</b>{' '}
            {relayBuild
              ? 'Set it up once, here, and it is done for everybody.'
              : 'This copy of the app is not wired to a cloud relay, so the connection will live on this computer.'}
          </>
        )}
        {onRelay && status.relay?.encryption === 'shared' && (
          <div className="qbo-where-warn">
            The relay is encrypting the stored tokens with the shared sync key rather than a key of
            their own. That key is compiled into every laptop&rsquo;s build. Add a Worker secret
            named <code>QBO_ENC_KEY</code> (any long random string) and reconnect — see
            docs/CLOUDFLARE.md.
          </div>
        )}
      </div>
    </div>
  )

  /**
   * The one-time move, offered only on the machine that has something to move.
   *
   * Every consequence is listed BEFORE the button, including the irreversible
   * one, because deleting the local copy is the half nobody can undo and "are
   * you sure?" is not a description of what is about to happen.
   */
  const promotePanel = status.canPromote ? (
    <section className="qbo-promote">
      <div className="qbo-promote-head">
        <Icon name="UploadCloud" size={16} />
        <div>
          <b>Move this connection to the cloud relay</b>
          <p>Once. After this, no admin ever sets QuickBooks up on a laptop again.</p>
        </div>
      </div>
      <ul>
        {promotionSummary(status.companyName).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Button
        variant="primary"
        icon="UploadCloud"
        loading={busy === 'promote'}
        disabled={busy !== null}
        onClick={() => {
          if (
            !window.confirm(
              'Move the QuickBooks connection to the cloud relay?\n\n' +
                'The keys and tokens are copied there and verified against QuickBooks first. ' +
                'Once that works they are DELETED from this computer.'
            )
          ) {
            return
          }
          void run(
            'promote',
            async () => {
              const res = await api.quickbooks.promote()
              return res.ok ? { ok: true } : res
            },
            'Moved. QuickBooks now runs from the relay, and this computer holds nothing.'
          )
        }}
      >
        Move it to the relay
      </Button>
    </section>
  ) : null

  // Connected — by whoever holds it. The steps have nothing left to say, so they
  // go away entirely and the screen becomes the thing that is actually useful
  // from then on: the account mapping.
  if (status.holder !== 'none') {
    return (
      <div className="qbo-page">
        {whereItLives}
        <div className="qbo-state" data-connected="true">
          <span className="qbo-dot" />
          <div className="qbo-state-main">
            <div className="qbo-state-title">
              Connected{status.companyName ? ` — ${status.companyName}` : ''}
            </div>
            <div className="qbo-state-sub">
              Company {status.realmId}
              {status.refreshExpiresAt && (
                <> · re-authorise by {formatDateTime(status.refreshExpiresAt)}</>
              )}
            </div>
          </div>
          <Button
            icon="RefreshCw"
            loading={busy === 'test'}
            disabled={busy !== null}
            onClick={() => void run('test', () => api.quickbooks.test(), 'QuickBooks responded.')}
          >
            Test
          </Button>
          <Button
            icon="Ban"
            loading={busy === 'disconnect'}
            disabled={busy !== null}
            onClick={() => {
              // Disconnecting the relay disconnects EVERY admin, not just this
              // screen. Said out loud, because the button looks identical to the
              // one that used to affect one laptop.
              if (
                onRelay &&
                !window.confirm(
                  'Disconnect QuickBooks for EVERYONE?\n\n' +
                    'The connection lives in the relay, so this stops invoices reaching ' +
                    'QuickBooks from every machine and from the web app until somebody ' +
                    'approves again.'
                )
              ) {
                return
              }
              void run('disconnect', () => api.quickbooks.disconnect(), 'Disconnected.')
            }}
          >
            Disconnect
          </Button>
        </div>

        {status.lastError && (
          <div className="qbo-error">
            <Icon name="AlertTriangle" size={15} />
            <span>{status.lastError}</span>
          </div>
        )}

        {promotePanel}

        <QboAccountMapping connected />
      </div>
    )
  }

  return (
    <div className="qbo-page">
      {whereItLives}
      <div className="qbo-lede">
        Three steps, done once by the owner
        {relayBuild ? ', and they set QuickBooks up for everybody' : ''}. Everything is on one page
        in the Intuit developer portal —
        <button
          type="button"
          className="link-btn"
          onClick={() => void api.email.openExternal(INTUIT_APPS_URL)}
        >
          <Icon name="ExternalLink" size={13} /> open it
        </button>
        , pick your app, then <b>Keys &amp; credentials</b> under Production.
      </div>

      {status.lastError && (
        <div className="qbo-error">
          <Icon name="AlertTriangle" size={15} />
          <span>{status.lastError}</span>
        </div>
      )}

      {/* ---------------------------------------------------------------- 1 */}
      <section className="qbo-step" data-done={keysSaved ? 'true' : 'false'}>
        <div className="qbo-step-num">{keysSaved ? <Icon name="Check" size={15} /> : 1}</div>
        <div className="qbo-step-body">
          <h3>Paste your two keys</h3>
          <p>
            On <b>Keys &amp; credentials</b> there are exactly two long strings, one above the other.
            Copy each one. Not the app name, not the company id.
          </p>
          {/* AUTOFILL IS THE BUG HERE, not a nuisance. A text field directly
              above a password field is precisely the shape Chromium reads as a
              login form, and it filled the app's NAME into the Client ID — which
              then saved, and QuickBooks refused the connection later with an
              error naming none of it. autoComplete="new-password" on the second
              field is what actually stops Chromium offering the pair; the
              data-* attributes are for 1Password and LastPass, which ignore it. */}
          <div className="qbo-form">
            <Field
              label="Client ID"
              hint="About forty characters. Usually starts AB."
              error={touched.id ? (idError ?? undefined) : undefined}
            >
              <Input
                value={clientId}
                name="qbo-app-key"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                invalid={touched.id && !!idError}
                placeholder={keysSaved ? `Saved — ends …${status.clientIdHint}` : 'ABxxxxxxxx…'}
                onChange={(e) => setClientId(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, id: true }))}
              />
            </Field>
            <Field
              label="Client secret"
              hint="The second one, directly below it."
              error={touched.secret ? (secretError ?? undefined) : undefined}
            >
              <Input
                type="password"
                value={clientSecret}
                name="qbo-app-secret"
                autoComplete="new-password"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                invalid={touched.secret && !!secretError}
                placeholder={keysSaved ? 'Saved — type to replace' : 'Forty characters'}
                onChange={(e) => setClientSecret(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, secret: true }))}
              />
            </Field>
          </div>
          <div className="qbo-step-acts">
            <Button
              variant="primary"
              icon="Save"
              loading={busy === 'save'}
              disabled={busy !== null || !canSave}
              onClick={() =>
                void run(
                  'save',
                  async () => {
                    const res = await api.quickbooks.saveConfig(
                      clientId,
                      clientSecret,
                      'production',
                      redirectUri
                    )
                    if (res.ok) {
                      // Never keep the secret in renderer state longer than the call.
                      setClientId('')
                      setClientSecret('')
                      setTouched({ id: false, secret: false })
                    }
                    return res
                  },
                  'Keys saved.'
                )
              }
            >
              {keysSaved ? 'Replace keys' : 'Save keys'}
            </Button>
            {keysSaved && (
              <span className="qbo-step-ok">
                <Icon name="Check" size={13} /> Saved — ends …{status.clientIdHint}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 2 */}
      <section className="qbo-step" data-ready={keysSaved ? 'true' : 'false'}>
        <div className="qbo-step-num">2</div>
        <div className="qbo-step-body">
          <h3>Approve in your browser</h3>
          <p>
            This opens QuickBooks, asks you to pick the company, and lands on an Intuit page.
            Nothing to configure first — the app uses Intuit&rsquo;s own return page, which is
            already registered against every app.
          </p>
          <div className="qbo-step-acts">
            <Button
              variant={keysSaved ? 'primary' : 'secondary'}
              icon="ExternalLink"
              loading={busy === 'connect'}
              disabled={busy !== null || !keysSaved}
              onClick={async () => {
                // The loopback redirect is the only one this app can catch by
                // itself; anything else — including the default — finishes at
                // step 3. Both are one button, because which one is in force is
                // not a decision the operator should have to hold in mind.
                if (isLoopbackRedirect(redirectUri)) {
                  await run('connect', () => api.quickbooks.connect(), 'QuickBooks connected.')
                  return
                }
                setBusy('connect')
                try {
                  const res = await api.quickbooks.authorizeUrl()
                  if (!res.ok || !res.data) {
                    toast.error(res.error ?? 'Could not build the consent URL.')
                    return
                  }
                  await api.email.openExternal(res.data.url)
                  toast.success('Approve in the browser, then copy the address it lands on.')
                } finally {
                  setBusy(null)
                }
              }}
            >
              Open QuickBooks consent
            </Button>
            {!keysSaved && <span className="qbo-step-wait">Save your keys first</span>}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- 3 */}
      {!isLoopbackRedirect(redirectUri) && (
        <section className="qbo-step" data-ready={keysSaved ? 'true' : 'false'}>
          <div className="qbo-step-num">3</div>
          <div className="qbo-step-body">
            <h3>Paste the address it landed on</h3>
            <p>
              After you approve, the browser ends up on a page that looks blank or broken. That is
              expected. Click the address bar, select all, copy, and paste the whole thing here —
              the app takes the two values it needs out of it.
            </p>
            <Field
              label="Address from the browser"
              error={landed.trim() ? (pasteError ?? undefined) : undefined}
            >
              <Input
                value={landed}
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                invalid={!!landed.trim() && !!pasteError}
                placeholder="https://developer.intuit.com/…?code=…&realmId=…"
                onChange={(e) => setLanded(e.target.value)}
              />
            </Field>
            {paste?.ok && (
              <div className="qbo-step-ok">
                <Icon name="Check" size={13} /> Read it — company {paste.realmId}
              </div>
            )}
            <div className="qbo-step-acts">
              <Button
                variant="primary"
                icon="Link"
                loading={busy === 'code'}
                disabled={busy !== null || !paste?.ok}
                onClick={async () => {
                  if (!paste?.ok) return
                  setBusy('code')
                  try {
                    const res = await api.quickbooks.exchangeCode(paste.code, paste.realmId)
                    if (!res.ok || !res.data) {
                      toast.error(res.error ?? 'QuickBooks would not accept that.')
                      return
                    }
                    setStatus(res.data)
                    setLanded('')
                    toast.success('Connected to QuickBooks.')
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                Finish connecting
              </Button>
              <span className="qbo-step-wait">
                The code expires after a few minutes — if it is refused, press step 2 again.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* Everything that used to be on screen at once, and mattered in one case
          each. Shut by default: a setup screen showing an escape hatch beside
          the main path reads as though both are required. */}
      <div className="qbo-advanced">
        <button type="button" className="link-btn" onClick={() => setAdvanced((v) => !v)}>
          <Icon name={advanced ? 'ChevronDown' : 'ChevronRight'} size={13} />
          Advanced — redirect URI, manual tokens, troubleshooting
        </button>
      </div>

      {advanced && (
        <div className="qbo-advanced-body">
          <Field
            label="Redirect URI"
            hint="Leave as-is unless Intuit refuses consent. Must match your app exactly."
          >
            <Input
              value={redirectUri}
              autoComplete="off"
              spellCheck={false}
              placeholder={QBO_DEFAULT_REDIRECT_URI}
              onChange={(e) => setRedirectUri(e.target.value)}
            />
          </Field>
          <div className="qbo-note">
            <Icon name="Info" size={15} />
            <div>
              If consent is refused, add this exact URI to your app&rsquo;s <b>Redirect URIs</b> on
              the same Production tab as the keys:
              <code className="qbo-uri">{redirectUri || QBO_DEFAULT_REDIRECT_URI}</code>
              <div className="qbo-note-acts">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(redirectUri || QBO_DEFAULT_REDIRECT_URI)
                    toast.success('Redirect URI copied.')
                  }}
                >
                  <Icon name="Copy" size={13} /> Copy
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setRedirectUri(QBO_REDIRECT_URI)
                    toast.success('Set to the built-in loopback — Save keys to apply.')
                  }}
                >
                  Use the built-in loopback instead
                </button>
                {keysSaved && (
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
              The loopback URI cannot be registered against production keys — Intuit accepts plain
              HTTP on the Development tab only — so it is here rather than as the default.
            </div>
          </div>

          {authUrl && (
            <div className="qbo-note">
              <Icon name="ExternalLink" size={15} />
              <div>
                The exact URL the app opens. Paste it into a browser to test consent on its own.
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

          <div className="qbo-manual">
            <div className="qbo-manual-head">
              <Icon name="ClipboardPaste" size={15} />
              <div>
                <b>Connect with tokens from the OAuth Playground</b>
                <p>
                  Only if the three steps above will not complete. Authorise in Intuit&rsquo;s OAuth
                  Playground and paste the tokens — once only.
                </p>
              </div>
            </div>
            <div className="qbo-form">
              <Field
                label="Refresh token"
                hint="The long-lived one from the Playground"
                error={refreshToken ? (validateRefreshToken(refreshToken) ?? undefined) : undefined}
              >
                <Input
                  value={refreshToken}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  placeholder="Required — the long-lived one"
                  invalid={!!refreshToken && !!validateRefreshToken(refreshToken)}
                  onChange={(e) => setRefreshToken(e.target.value)}
                />
              </Field>
              <Field
                label="Company (realm) id"
                hint="All digits — not the Client ID"
                error={realmId ? (validateRealmId(realmId) ?? undefined) : undefined}
              >
                <Input
                  value={realmId}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  placeholder="Required — e.g. 9341454816183285"
                  invalid={!!realmId && !!validateRealmId(realmId)}
                  onChange={(e) => setRealmId(e.target.value)}
                />
              </Field>
              <Field label="Access token (optional)">
                <Input
                  value={accessToken}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Left blank, a fresh one is fetched immediately"
                  onChange={(e) => setAccessToken(e.target.value)}
                />
              </Field>
            </div>
            <Button
              icon="Check"
              loading={busy === 'paste'}
              disabled={
                busy !== null || !!validateRefreshToken(refreshToken) || !!validateRealmId(realmId)
              }
              onClick={() =>
                void run(
                  'paste',
                  async () => {
                    const res = await api.quickbooks.pasteTokens(accessToken, refreshToken, realmId)
                    if (res.ok) {
                      setAccessToken('')
                      setRefreshToken('')
                      setRealmId('')
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

          {keysSaved && (
            <Button
              variant="danger"
              icon="Trash2"
              loading={busy === 'forget'}
              disabled={busy !== null}
              onClick={() => {
                if (
                  !window.confirm(
                    relayBuild
                      ? 'Forget the QuickBooks keys IN THE RELAY?\n\nThat removes them for ' +
                        'everybody, and the whole three-step setup has to be done again.'
                      : 'Forget the QuickBooks keys on this machine?'
                  )
                ) {
                  return
                }
                void run('forget', () => api.quickbooks.forget(), 'Keys removed.')
              }}
            >
              Forget keys
            </Button>
          )}
        </div>
      )}

      <QboAccountMapping connected={status.holder !== 'none'} />
    </div>
  )
}
