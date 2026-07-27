/**
 * Authenticated QuickBooks Online requests.
 *
 * One place owns the access token, so nothing else has to think about
 * expiry: every call refreshes first when the token is stale, and retries once
 * on a 401 in case the token was revoked or rotated behind our back. The
 * refreshed tokens are persisted immediately — Intuit rotates refresh tokens,
 * and a rotation we fail to store works exactly once more and then stops.
 */
import type { QboConfig, QboTokens } from '@shared/quickbooks'
import { QBO_MINOR_VERSION, needsReconsent, needsRefresh, qboApiBase } from '@shared/quickbooks'
import { refreshTokens } from './oauth'
import { getQboConfig, getQboTokens, setQboTokens } from './store'

export class QboNotConnectedError extends Error {}
export class QboReconsentRequiredError extends Error {}

interface Ready {
  config: QboConfig
  tokens: QboTokens
}

/**
 * Config + a usable access token, refreshing if needed. Throws a typed error
 * the caller can turn into the right message: "not set up" and "your grant
 * expired, reconnect" are different problems with different fixes.
 */
async function ready(): Promise<Ready> {
  const config = getQboConfig()
  if (!config) throw new QboNotConnectedError('QuickBooks is not set up yet.')
  let tokens = getQboTokens()
  if (!tokens) throw new QboNotConnectedError('QuickBooks is not connected yet.')

  const now = Date.now()
  if (needsReconsent(tokens, now)) {
    throw new QboReconsentRequiredError(
      'The QuickBooks connection has expired. Connect again to re-authorise.'
    )
  }
  if (needsRefresh(tokens, now)) {
    tokens = await refreshTokens(config, tokens)
    setQboTokens(tokens)
  }
  return { config, tokens }
}

export interface QboRequestOptions {
  method?: 'GET' | 'POST'
  /** Path AFTER /v3/company/{realmId}, e.g. 'companyinfo/123'. */
  path: string
  body?: unknown
  query?: Record<string, string>
}

/**
 * Call the Accounting API for the connected company. Returns parsed JSON.
 *
 * The 401 retry is deliberately once: a token that is still rejected after a
 * fresh refresh is not a timing problem, and retrying again would just turn a
 * clear failure into a slow one.
 */
export async function qboRequest<T = unknown>(options: QboRequestOptions): Promise<T> {
  const { config, tokens } = await ready()

  const send = async (accessToken: string): Promise<Response> => {
    const url = new URL(
      `${qboApiBase(config.environment)}/v3/company/${tokens.realmId}/${options.path}`
    )
    url.searchParams.set('minorversion', QBO_MINOR_VERSION)
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v)

    return fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    })
  }

  let res = await send(tokens.accessToken)

  if (res.status === 401) {
    const fresh = await refreshTokens(config, tokens)
    setQboTokens(fresh)
    res = await send(fresh.accessToken)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new Error(describeQboError(res.status, text))
  }
  return (text ? JSON.parse(text) : {}) as T
}

/**
 * Turn an Intuit error body into one useful sentence. Their faults nest as
 * { Fault: { Error: [{ Message, Detail }] } }, and the Detail is usually the
 * part that says what actually went wrong.
 */
export function describeQboError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      Fault?: { Error?: Array<{ Message?: string; Detail?: string }> }
      fault?: { error?: Array<{ message?: string; detail?: string }> }
    }
    const err = parsed.Fault?.Error?.[0] ?? parsed.fault?.error?.[0]
    if (err) {
      const message = (err as { Message?: string }).Message ?? (err as { message?: string }).message
      const detail = (err as { Detail?: string }).Detail ?? (err as { detail?: string }).detail
      const parts = [message, detail].filter(Boolean)
      if (parts.length > 0) return `QuickBooks: ${parts.join(' — ')}`
    }
  } catch {
    // Not JSON; fall through to the status.
  }
  if (status === 403) return 'QuickBooks refused the request (403). Check the app has accounting scope.'
  if (status === 429) return 'QuickBooks is rate limiting requests. Try again shortly.'
  return `QuickBooks request failed (HTTP ${status}).`
}

export interface QboCompanyInfo {
  CompanyName?: string
  LegalName?: string
  Country?: string
  CompanyAddr?: { Line1?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string }
}

/** The cheapest authenticated read there is — used as the connection test. */
export async function fetchCompanyInfo(): Promise<QboCompanyInfo> {
  const tokens = getQboTokens()
  if (!tokens) throw new QboNotConnectedError('QuickBooks is not connected yet.')
  const body = await qboRequest<{ CompanyInfo?: QboCompanyInfo }>({
    path: `companyinfo/${tokens.realmId}`
  })
  return body.CompanyInfo ?? {}
}
