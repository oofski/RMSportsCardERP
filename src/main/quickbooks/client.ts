/**
 * Authenticated QuickBooks Online requests — and the one decision about WHO
 * holds the grant that makes them.
 *
 * ## Two holders, one signature
 *
 * The connection now lives in the Cloudflare relay: it stores the client secret
 * and the tokens, it performs the refresh, and it makes the Intuit call. A
 * laptop has none of that and never will. But an app that predates the relay, or
 * a standalone build with no relay at all, still holds its own credentials — so
 * this file routes rather than assumes, and `qboRequest` keeps the shape it
 * always had. invoices.ts, invoiceStatus.ts, invoiceRefs.ts and accounts.ts
 * build a path and a body and do not know which side answers.
 *
 * ## Why the relay always wins when it has the connection
 *
 * Intuit ROTATES the refresh token on every refresh: the reply carries a new one
 * and retires the one that was sent. Two holders refreshing the same grant means
 * the loser is silently dead an hour later, in the middle of somebody raising an
 * invoice. So "use whichever is nearer" is not a tie-break, it is the bug — if
 * the relay is holding the connection, local tokens left on a machine are
 * ignored entirely, and the migration erases them anyway.
 *
 * ## Why an unreachable relay does NOT fall back
 *
 * See chooseQboHolder. A laptop that has learned the relay is the holder keeps
 * believing that while Cloudflare is unreachable, and says so. Falling back
 * would re-create the second holder that this whole change removed, and it would
 * do it precisely during an outage, when nobody is watching.
 */
import type { QboConfig, QboTokens } from '@shared/quickbooks'
import { QBO_MINOR_VERSION, needsReconsent, needsRefresh, qboApiBase } from '@shared/quickbooks'
import type { QboCallEnvelope, QboHolder } from '@shared/quickbooksRelay'
import { chooseQboHolder, qboNotConnectedReason } from '@shared/quickbooksRelay'
import { refreshTokens } from './oauth'
import { getQboConfig, getQboTokens, setQboTokens } from './store'
import { readQboUploadReply, toQboAttachablePayload } from '@shared/invoices'
import {
  relayConfigured,
  relayQbo,
  relayQboCompany,
  relayQboRequest,
  relayQboUpload,
  rememberedRelayQbo
} from './relay'

export class QboNotConnectedError extends Error {}
export class QboReconsentRequiredError extends Error {}

interface Ready {
  config: QboConfig
  tokens: QboTokens
}

/** Does THIS machine still have a complete connection of its own? */
function localConnected(): boolean {
  return !!getQboConfig() && !!getQboTokens()
}

/**
 * Who answers the next call. Consults the relay when what we remember has gone
 * stale, and never blocks on it for longer than the sync transport's own
 * timeout.
 */
export async function qboHolder(): Promise<QboHolder> {
  const configured = relayConfigured()
  const probe = configured ? await relayQbo() : null
  return chooseQboHolder({
    relayConfigured: configured,
    relayHolds: probe?.connected === true,
    localConnected: localConnected()
  })
}

/** The same question, answered from memory only. For synchronous callers. */
export function qboHolderNow(): QboHolder {
  const probe = rememberedRelayQbo()
  return chooseQboHolder({
    relayConfigured: relayConfigured(),
    relayHolds: probe?.connected === true,
    localConnected: localConnected()
  })
}

/**
 * The company these calls are against.
 *
 * Needed by the parts of the app that key something on the realm — the account
 * mapping and the reference caches — because an id is company-local and reusing
 * one across two companies posts real money against the wrong account.
 */
export function activeRealmId(): string | null {
  if (qboHolderNow() === 'relay') {
    const realm = rememberedRelayQbo()?.realmId
    return realm && realm.trim() ? realm.trim() : null
  }
  return getQboTokens()?.realmId ?? null
}

function notConnected(): QboNotConnectedError {
  return new QboNotConnectedError(
    qboNotConnectedReason({
      relayConfigured: relayConfigured(),
      relayHolds: rememberedRelayQbo()?.connected === true,
      localConnected: localConnected()
    })
  )
}

/**
 * Config + a usable access token from THIS machine, refreshing if needed.
 *
 * Only reached when the local holder is in play. Throws a typed error the caller
 * can turn into the right message: "not set up" and "your grant expired,
 * reconnect" are different problems with different fixes.
 */
async function ready(): Promise<Ready> {
  const config = getQboConfig()
  if (!config) throw notConnected()
  let tokens = getQboTokens()
  if (!tokens) throw notConnected()

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

export type QboRequestOptions = QboCallEnvelope

/**
 * Call the Accounting API for the connected company. Returns parsed JSON.
 *
 * The 401 retry on the local path is deliberately once: a token that is still
 * rejected after a fresh refresh is not a timing problem, and retrying again
 * would just turn a clear failure into a slow one. The relay does the same on
 * its side, for the same reason.
 */
export async function qboRequest<T = unknown>(options: QboRequestOptions): Promise<T> {
  const holder = await qboHolder()
  if (holder === 'relay') return relayQboRequest<T>(options)
  if (holder === 'none') throw notConnected()

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
 * Attach a document to a transaction in QuickBooks.
 *
 * Kept separate from `qboRequest` rather than folded into it as a flag, because
 * it is a different kind of call: multipart rather than JSON, bytes rather than
 * an object, and with limits on what it may attach to. One function doing both
 * would make every ordinary call carry checks that only matter here.
 *
 * The multipart framing itself is Intuit's, and it is picky: exactly two parts,
 * named `file_metadata_01` and `file_content_01`, the first being the Attachable
 * record as JSON. The `AttachableRef` inside it is what LINKS the file to the
 * transaction — without it the upload succeeds and the document lands attached
 * to nothing, which is the failure that looks most like success.
 *
 * Routes by holder exactly as `qboRequest` does, so a machine whose grant lives
 * in the relay uploads through the relay and never sees a token.
 */
export async function qboUpload(input: {
  entityType: string
  entityId: string
  fileName: string
  mimeType: string
  bytes: Buffer
}): Promise<{ id: string; fileName: string }> {
  const holder = await qboHolder()
  if (holder === 'relay') return relayQboUpload(input)
  if (holder === 'none') throw notConnected()

  const { config, tokens } = await ready()

  const send = async (accessToken: string): Promise<Response> => {
    const url = new URL(`${qboApiBase(config.environment)}/v3/company/${tokens.realmId}/upload`)
    url.searchParams.set('minorversion', QBO_MINOR_VERSION)

    // Rebuilt per attempt. The 401 path below sends a SECOND time, and a body
    // that has already been streamed reads as empty the next time — which would
    // upload a zero-byte file after a token refresh and report success.
    const form = new FormData()
    form.append(
      'file_metadata_01',
      new Blob([JSON.stringify(toQboAttachablePayload(input))], { type: 'application/json' }),
      'metadata.json'
    )
    form.append(
      'file_content_01',
      new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
      input.fileName
    )

    return fetch(url.toString(), {
      // NO content-type header: fetch sets multipart/form-data WITH the boundary
      // it generated, and naming the type without the boundary produces a body
      // Intuit cannot parse.
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      body: form
    })
  }

  let res = await send(tokens.accessToken)
  if (res.status === 401) {
    const fresh = await refreshTokens(config, tokens)
    setQboTokens(fresh)
    res = await send(fresh.accessToken)
  }

  const text = await res.text()
  if (!res.ok) throw new Error(describeQboError(res.status, text))

  // /upload answers with a LIST — one entry per part — and reports a per-part
  // Fault rather than an HTTP error, so a 200 does not by itself mean the file
  // landed. readQboUploadReply is shared with the relay's copy of this check.
  return readQboUploadReply(text ? JSON.parse(text) : {}, input.fileName)
}

/**
 * Turn an Intuit error body into one useful sentence. Their faults nest as
 * { Fault: { Error: [{ Message, Detail }] } }, and the Detail is usually the
 * part that says what actually went wrong.
 *
 * Mirrored as describeQboFault in cloud/worker.js — the relay has to do this
 * itself, because once it is the caller the app never sees the raw body.
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

/**
 * The cheapest authenticated read there is — used as the connection test.
 *
 * The relay has its own route for this rather than being asked for
 * `companyinfo/{realm}`: it already knows which company it is connected to, and
 * a caller that supplied the realm could aim the test at a different set of
 * books than the one the invoices go to.
 */
export async function fetchCompanyInfo(): Promise<QboCompanyInfo> {
  const holder = await qboHolder()
  if (holder === 'relay') {
    const info = await relayQboCompany()
    return { CompanyName: info.companyName }
  }
  const tokens = getQboTokens()
  if (!tokens) throw notConnected()
  const body = await qboRequest<{ CompanyInfo?: QboCompanyInfo }>({
    path: `companyinfo/${tokens.realmId}`
  })
  return body.CompanyInfo ?? {}
}
