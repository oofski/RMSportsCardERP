/**
 * QuickBooks Online integration — shared shapes and endpoint constants.
 *
 * Kept in @shared so the renderer can type the settings screen without pulling
 * in anything from the main process. NOTHING secret lives here: the client id
 * and secret are entered by the operator and stored encrypted on their machine
 * (see main/quickbooks/store.ts).
 */

export type QboEnvironment = 'sandbox' | 'production'

export interface QboConfig {
  clientId: string
  clientSecret: string
  environment: QboEnvironment
}

export interface QboTokens {
  accessToken: string
  refreshToken: string
  /** The QuickBooks company this grant is for. */
  realmId: string
  /** Epoch ms. Access tokens last an hour. */
  expiresAt: number
  /** Epoch ms. Refresh tokens last ~100 days and rotate on use. */
  refreshExpiresAt: number
}

/** What the settings screen renders. Never includes the secret or the tokens. */
export interface QboStatus {
  configured: boolean
  connected: boolean
  environment: QboEnvironment
  /** Last four of the client id, so the operator can tell which app is wired. */
  clientIdHint: string | null
  realmId: string | null
  companyName: string | null
  /** ISO. When the access token needs refreshing — informational. */
  expiresAt: string | null
  /** ISO. When the operator will have to re-consent. */
  refreshExpiresAt: string | null
  lastError: string | null
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2'
export const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
export const QBO_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'

/** Accounting scope only. Widen deliberately, not by default. */
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting'

/**
 * The loopback port the desktop app listens on to catch Intuit's redirect.
 * Fixed rather than random because Intuit requires the redirect URI to be
 * registered up front and matched exactly.
 */
export const QBO_REDIRECT_PORT = 8462
export const QBO_REDIRECT_URI = `http://localhost:${QBO_REDIRECT_PORT}/callback`

export function qboApiBase(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com'
}

/**
 * Pinned so a minor-version bump at Intuit cannot silently change response
 * shapes underneath a running install.
 */
export const QBO_MINOR_VERSION = '75'

/**
 * Refresh this long before the access token actually expires, so a call that
 * starts just under the wire does not land just over it.
 */
export const QBO_REFRESH_SKEW_MS = 5 * 60 * 1000

/** True when the access token is missing, expired, or about to be. */
export function needsRefresh(tokens: QboTokens | null, now: number): boolean {
  if (!tokens?.accessToken) return true
  return tokens.expiresAt - QBO_REFRESH_SKEW_MS <= now
}

/** True when even the refresh token is done and the operator must re-consent. */
export function needsReconsent(tokens: QboTokens | null, now: number): boolean {
  if (!tokens?.refreshToken) return true
  return tokens.refreshExpiresAt <= now
}

/** Build the consent URL the operator's browser is sent to. */
export function buildAuthorizeUrl(clientId: string, state: string, redirectUri = QBO_REDIRECT_URI): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: QBO_SCOPE,
    redirect_uri: redirectUri,
    state
  })
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`
}
