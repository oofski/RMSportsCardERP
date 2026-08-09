/**
 * QuickBooks Online OAuth 2.0, authorization-code flow for a desktop app.
 *
 * There is no server to redirect to, so the app briefly becomes one: it listens
 * on a fixed loopback port, opens the operator's real browser at Intuit's
 * consent screen, and catches the redirect back. The browser is used rather
 * than an embedded window on purpose — the operator can see the address bar and
 * their password manager works, and Intuit blocks embedded webviews for login.
 *
 * The listener is short-lived and always closed: on success, on error, on
 * timeout, and on cancel. A process left holding port 8462 would make every
 * subsequent connection attempt fail with an error about the port, which looks
 * nothing like the actual problem.
 */
import { createServer, type Server } from 'http'
import { randomUUID } from 'crypto'
import { shell } from 'electron'
import type { QboConfig, QboTokens } from '@shared/quickbooks'
import {
  QBO_REDIRECT_PORT,
  QBO_REDIRECT_URI,
  QBO_REVOKE_URL,
  QBO_TOKEN_URL,
  buildAuthorizeUrl
} from '@shared/quickbooks'

/** How long the operator gets to finish consenting before the listener closes. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000

export interface AuthorizeResult {
  code: string
  realmId: string
}

/** Basic auth header for the token endpoint: base64(clientId:clientSecret). */
function basicAuth(config: QboConfig): string {
  return 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')
}

/** What the operator's browser shows after Intuit redirects back. */
function closingPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:#f5f6f8; color:#131722; }
  .card { text-align:center; padding:40px 44px; background:#fff; border-radius:14px;
          box-shadow:0 8px 30px rgba(16,24,40,.10); max-width:420px; }
  h1 { margin:0 0 8px; font-size:19px; }
  p { margin:0; font-size:14px; line-height:1.55; color:#4b5565; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`
}

/**
 * Open the consent screen and resolve with the authorization code.
 *
 * `state` is generated here and checked on the way back: without it, anything
 * that can reach localhost could feed this listener a code of its choosing.
 */
export function authorize(config: QboConfig): Promise<AuthorizeResult> {
  return new Promise<AuthorizeResult>((resolve, reject) => {
    const state = randomUUID()
    let server: Server | null = null
    let timer: NodeJS.Timeout | null = null
    let settled = false

    const finish = (err: Error | null, value?: AuthorizeResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // close() stops accepting; the callback fires once existing sockets end.
      server?.close()
      if (err) reject(err)
      else resolve(value as AuthorizeResult)
    }

    server = createServer((req, res) => {
      // The URL is relative, so it needs a base to parse against.
      const url = new URL(req.url ?? '/', `http://localhost:${QBO_REDIRECT_PORT}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }

      const respond = (code: number, title: string, message: string): void => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(closingPage(title, message))
      }

      const error = url.searchParams.get('error')
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error
        respond(200, 'Not connected', 'QuickBooks reported: ' + desc)
        finish(new Error(desc))
        return
      }

      if (url.searchParams.get('state') !== state) {
        respond(400, 'Not connected', 'That response did not match the request that started it.')
        finish(new Error('The QuickBooks response did not match the request that started it.'))
        return
      }

      const code = url.searchParams.get('code')
      const realmId = url.searchParams.get('realmId')
      if (!code || !realmId) {
        respond(400, 'Not connected', 'QuickBooks did not return a company to connect to.')
        finish(new Error('QuickBooks did not return an authorization code and company id.'))
        return
      }

      respond(200, 'Connected', 'You can close this tab and go back to RM Operations.')
      finish(null, { code, realmId })
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${QBO_REDIRECT_PORT} is already in use, so the QuickBooks redirect cannot be received. Close whatever is using it and try again.`
            : err.message
        )
      )
    })

    // Loopback only — never 0.0.0.0, which would expose the callback to the
    // local network for as long as the window is open.
    server.listen(QBO_REDIRECT_PORT, '127.0.0.1', () => {
      timer = setTimeout(
        () => finish(new Error('The QuickBooks connection timed out waiting for consent.')),
        CONSENT_TIMEOUT_MS
      )
      void shell.openExternal(buildAuthorizeUrl(config.clientId, state))
    })
  })
}

/** Intuit's token responses, in the shape the docs promise. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  x_refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Turn a token response into stored tokens.
 *
 * `realmId` and the previous refresh token are carried in because a REFRESH
 * response contains neither the company nor, always, a new refresh token —
 * dropping them would silently disconnect the integration an hour later.
 */
export function toTokens(
  body: TokenResponse,
  realmId: string,
  now: number,
  previousRefreshToken?: string
): QboTokens {
  const refreshToken = body.refresh_token ?? previousRefreshToken
  if (!body.access_token || !refreshToken) {
    throw new Error('QuickBooks did not return a usable token.')
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    realmId,
    expiresAt: now + (body.expires_in ?? 3600) * 1000,
    refreshExpiresAt: now + (body.x_refresh_token_expires_in ?? 8726400) * 1000
  }
}

async function postToken(config: QboConfig, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(config),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString()
  })
  const text = await res.text()
  let parsed: TokenResponse = {}
  try {
    parsed = JSON.parse(text) as TokenResponse
  } catch {
    // Intuit returns HTML on some failures; the status is the useful part.
    if (!res.ok) throw new Error(`QuickBooks rejected the token request (HTTP ${res.status}).`)
    throw new Error('QuickBooks returned a token response that could not be read.')
  }
  if (!res.ok || parsed.error) {
    throw new Error(
      parsed.error_description ?? parsed.error ?? `QuickBooks rejected the token request (HTTP ${res.status}).`
    )
  }
  return parsed
}

/**
 * The redirect this connection actually uses.
 *
 * The SAME value must go out with the authorize request and come back with the
 * token exchange — Intuit compares them and refuses the exchange if they
 * differ, which is a confusing failure precisely because consent appeared to
 * work.
 */
export function effectiveRedirectUri(config: QboConfig): string {
  return (config.redirectUri ?? '').trim() || QBO_REDIRECT_URI
}

export async function exchangeCode(
  config: QboConfig,
  code: string,
  realmId: string
): Promise<QboTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: effectiveRedirectUri(config)
  })
  return toTokens(await postToken(config, body), realmId, Date.now())
}

/**
 * Swap the refresh token for a fresh access token. Intuit ROTATES refresh
 * tokens, so whatever comes back must be persisted by the caller — keeping the
 * old one would work exactly once more and then stop.
 */
export async function refreshTokens(config: QboConfig, tokens: QboTokens): Promise<QboTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken
  })
  return toTokens(await postToken(config, body), tokens.realmId, Date.now(), tokens.refreshToken)
}

/** Best-effort revoke on disconnect. Local tokens are cleared regardless. */
export async function revokeTokens(config: QboConfig, tokens: QboTokens): Promise<void> {
  await fetch(QBO_REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(config),
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ token: tokens.refreshToken })
  })
}
