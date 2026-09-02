/**
 * The app's half of the relay-held QuickBooks connection: forwarding, and
 * nothing else.
 *
 * Every credential lives in cloud/worker.js and in D1 behind it. This file only
 * knows how to ASK. That asymmetry is the entire feature: an admin's laptop has
 * no client secret, no access token and no refresh token, so there is nothing to
 * set up when a new admin joins and nothing to rotate when one leaves.
 *
 * The transport is the sync loop's `call` — the one place that already knows the
 * relay's address, its bearer key, the 30-second timeout and how it fails. A
 * second copy of that resolution is how one of them ends up pointing somewhere
 * else after a settings change nobody remembered applied to both.
 *
 * Everything here fails SOFT and NAMES THE RELAY. A build with no relay must
 * show a screen that explains that rather than throwing, and an unreachable
 * relay must produce an error that says the relay was unreachable — because the
 * button somebody pressed said "QuickBooks" and every single person reads a bare
 * transport error under it as QuickBooks being down.
 */
import type { QboRelayProbe } from '@shared/quickbooksRelay'
import {
  describeRelayFailure,
  emptyRelayProbe,
  explainQboRelayProblem,
  isSafeQboPath,
  relayCanUpload,
  RELAY_UPLOAD_UNSUPPORTED,
  type QboCallEnvelope
} from '@shared/quickbooksRelay'
import { call, getSyncConfig } from '../services/cloudSync'
import { getQboRelayMemo, setQboRelayMemo, type QboRelayMemo } from './store'

/** Is this build wired to a relay at all? A standalone laptop is not. */
export function relayConfigured(): boolean {
  return getSyncConfig().url.trim().length > 0
}

const NO_RELAY =
  'This copy of the app is not connected to the cloud relay, and the relay is where the ' +
  'QuickBooks connection lives. Set it up under Admin → Developer → Cloud sync.'

/**
 * How long the remembered answer is used before asking again.
 *
 * Two minutes. Long enough that a screen full of invoices does not produce a
 * round trip per card; short enough that an owner who has just finished the
 * one-time setup on one machine sees the others pick it up while they are still
 * sitting at the desk, rather than after a restart.
 */
const MEMO_TTL_MS = 2 * 60 * 1000

/**
 * How long to wait for a QuickBooks call that goes THROUGH the relay.
 *
 * A sync pull is one hop and the loop's 30 seconds is generous for it. This is
 * three: this app, the relay, and Intuit — with a token refresh possible in the
 * middle that waits up to six seconds on another invocation's lease before it
 * even begins its own round trip to Intuit. On the same ceiling, the longest
 * chain got the shortest patience and gave up on work that was still running,
 * reported as "This operation was aborted", which reads like a refusal.
 *
 * Ninety seconds. Long enough that a slow-but-working call finishes; short
 * enough that a relay which is genuinely dead does not hold a button down for
 * minutes. An upload carries a file as well, so it gets more again.
 */
const QBO_CALL_TIMEOUT_MS = 90 * 1000
const QBO_UPLOAD_TIMEOUT_MS = 180 * 1000

interface RelayStatusReply {
  ok?: boolean
  hasConfig?: boolean
  connected?: boolean
  realmId?: string | null
  companyName?: string | null
  clientIdHint?: string | null
  expiresAt?: string | null
  refreshExpiresAt?: string | null
  encryption?: string
  lastError?: string | null
  features?: unknown
}

function toProbe(reply: RelayStatusReply): QboRelayProbe {
  const encryption =
    reply.encryption === 'dedicated' ? 'dedicated' : reply.encryption === 'shared' ? 'shared' : 'none'
  return {
    configured: true,
    reachable: true,
    hasConfig: reply.hasConfig === true,
    connected: reply.connected === true,
    realmId: reply.realmId ?? null,
    companyName: reply.companyName ?? null,
    clientIdHint: reply.clientIdHint ?? null,
    expiresAt: reply.expiresAt ?? null,
    refreshExpiresAt: reply.refreshExpiresAt ?? null,
    encryption,
    lastError: reply.lastError ?? null,
    // A relay deployed before capabilities existed sends nothing here, and an
    // empty list reads correctly as "cannot do any of it" — which is the truth.
    features: Array.isArray(reply.features)
      ? reply.features.filter((f): f is string => typeof f === 'string')
      : [],
    problem: null
  }
}

function remember(probe: QboRelayProbe): QboRelayProbe {
  setQboRelayMemo({ ...probe, checkedAt: new Date().toISOString() })
  return probe
}

/**
 * Ask the relay what it is holding.
 *
 * A failure comes back as a probe with `reachable: false` and a sentence, never
 * as a throw: this is called from status screens somebody opened to read a
 * label, and an exception there makes a whole tab unopenable because Cloudflare
 * was slow.
 *
 * A FAILED PROBE DOES NOT OVERWRITE THE MEMO. What the relay last said is more
 * useful than "we could not ask", and forgetting it is what would let an outage
 * re-promote a laptop's stale tokens. Only an answer replaces an answer.
 */
export async function probeRelayQbo(): Promise<QboRelayProbe> {
  if (!relayConfigured()) return emptyRelayProbe(false, NO_RELAY)
  try {
    const reply = (await call('/v1/qbo/status', { method: 'GET' })) as RelayStatusReply
    return remember(toProbe(reply))
  } catch (err) {
    const memo = getQboRelayMemo()
    const problem = explainQboRelayProblem(err instanceof Error ? err.message : String(err))
    if (memo) return { ...memo, reachable: false, problem }
    return emptyRelayProbe(true, problem)
  }
}

/**
 * The relay's answer, asked again only if the remembered one has gone stale.
 *
 * Used on the hot path — every invoice push consults it — where a fresh probe
 * per call would double the round trips for information that changes about once
 * a year.
 */
export async function relayQbo(): Promise<QboRelayProbe> {
  const memo: QboRelayMemo | null = getQboRelayMemo()
  if (memo && Date.now() - Date.parse(memo.checkedAt) < MEMO_TTL_MS) {
    return { ...memo, configured: relayConfigured() }
  }
  return probeRelayQbo()
}

/**
 * What this machine believes without asking anybody.
 *
 * Synchronous, for the handlers that only need to know which company id is in
 * play. Never triggers a network call — a status screen that blocks on
 * Cloudflare to render a dropdown is worse than one rendering a stale label.
 */
export function rememberedRelayQbo(): QboRelayProbe | null {
  const memo = getQboRelayMemo()
  if (!memo) return null
  return { ...memo, configured: relayConfigured() }
}

// ---------------------------------------------------------------------------
// Making a call
// ---------------------------------------------------------------------------

interface RelayRequestReply {
  ok?: boolean
  status?: number
  body?: unknown
  error?: string
}

/**
 * One QuickBooks call, made by the relay on this machine's behalf.
 *
 * The signature deliberately matches `qboRequest` in client.ts so that
 * invoices.ts, invoiceStatus.ts, invoiceRefs.ts and accounts.ts did not have to
 * change at all — they build a path and a body and do not know, or need to know,
 * which side of the Atlantic the token is on.
 *
 * The two error shapes are kept apart because they mean opposite things to
 * whoever is looking at the screen:
 *
 *   · The relay answered and QuickBooks refused → Intuit's own sentence, passed
 *     through. "There is no customer called X" is actionable and retrying it is
 *     pointless.
 *   · The relay did not answer → a sentence naming the RELAY. The invoice is
 *     saved locally, nothing is wrong with QuickBooks, and pressing retry in a
 *     minute is exactly the right move.
 */
export async function relayQboRequest<T = unknown>(options: QboCallEnvelope): Promise<T> {
  if (!relayConfigured()) throw new Error(NO_RELAY)
  if (!isSafeQboPath(options.path)) {
    throw new Error(`"${options.path}" is not a QuickBooks path this app builds.`)
  }
  let reply: RelayRequestReply
  try {
    reply = (await call('/v1/qbo/request', {
      timeoutMs: QBO_CALL_TIMEOUT_MS,
      method: 'POST',
      body: {
        method: options.method ?? 'GET',
        path: options.path,
        query: options.query ?? {},
        body: options.body
      }
    })) as RelayRequestReply
  } catch (err) {
    // `call` already throws on { ok: false }, so an Intuit fault arrives here
    // too — and it must NOT be dressed up as a relay problem. See
    // describeRelayFailure for which hop gets the blame and why it matters.
    throw new Error(describeRelayFailure(err instanceof Error ? err.message : String(err)))
  }
  return (reply.body ?? {}) as T
}

/**
 * Send a file to the relay, for it to attach in QuickBooks.
 *
 * The bytes go up base64-encoded inside JSON rather than as a multipart body.
 * That costs a third in transfer and buys the app not having to build a
 * multipart body it would then have to keep in step with cloud/worker.js — the
 * relay frames it, because the relay is the side that talks to Intuit.
 *
 * REFUSED EARLY when the deployed Worker predates attachments. The relay is
 * deployed by hand and is routinely older than the app; without this check the
 * call is a 404 arriving from a button about invoices, which reads as
 * QuickBooks being down. See explainQboRelayProblem — the same lesson, learned
 * expensively enough to be worth not repeating.
 */
export async function relayQboUpload(input: {
  entityType: string
  entityId: string
  fileName: string
  mimeType: string
  bytes: Buffer
}): Promise<{ id: string; fileName: string }> {
  if (!relayConfigured()) throw new Error(NO_RELAY)
  if (!relayCanUpload(await relayQbo())) throw new Error(RELAY_UPLOAD_UNSUPPORTED)

  try {
    const reply = (await call('/v1/qbo/upload', {
      timeoutMs: QBO_UPLOAD_TIMEOUT_MS,
      method: 'POST',
      body: {
        entityType: input.entityType,
        entityId: input.entityId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        contentBase64: input.bytes.toString('base64')
      }
    })) as { id?: string; fileName?: string }
    if (!reply?.id) throw new Error('The relay did not say where the file went.')
    return { id: String(reply.id), fileName: String(reply.fileName ?? input.fileName) }
  } catch (err) {
    throw new Error(describeRelayFailure(err instanceof Error ? err.message : String(err)))
  }
}

/** The cheapest authenticated read there is, used as the connection test. */
export async function relayQboCompany(): Promise<{ companyName: string; realmId: string }> {
  if (!relayConfigured()) throw new Error(NO_RELAY)
  try {
    const reply = (await call('/v1/qbo/company', { method: 'GET' })) as {
      companyName?: string
      realmId?: string
    }
    return { companyName: reply.companyName ?? '', realmId: reply.realmId ?? '' }
  } catch (err) {
    throw new Error(describeRelayFailure(err instanceof Error ? err.message : String(err)))
  }
}

// ---------------------------------------------------------------------------
// Setting it up, once
// ---------------------------------------------------------------------------

async function relayPost(path: string, body: unknown): Promise<QboRelayProbe> {
  if (!relayConfigured()) throw new Error(NO_RELAY)
  try {
    const reply = (await call(path, { method: 'POST', body })) as RelayStatusReply
    return remember(toProbe(reply))
  } catch (err) {
    throw new Error(describeRelayFailure(err instanceof Error ? err.message : String(err)))
  }
}

export function relaySaveQboConfig(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): Promise<QboRelayProbe> {
  return relayPost('/v1/qbo/config', { clientId, clientSecret, redirectUri: redirectUri ?? '' })
}

export function relayExchangeQboCode(
  code: string,
  realmId: string,
  redirectUri?: string
): Promise<QboRelayProbe> {
  return relayPost('/v1/qbo/exchange', { code, realmId, redirectUri: redirectUri ?? '' })
}

/**
 * Hand the relay a token pair minted elsewhere.
 *
 * Both the owner's one-time PROMOTION of an existing laptop connection and the
 * OAuth Playground escape hatch land here, because they are the same act: tokens
 * from the same app registration, adopted once, refreshed by the relay from then
 * on.
 */
export function relayAdoptQboTokens(input: {
  refreshToken: string
  realmId: string
  refreshExpiresAt?: number
}): Promise<QboRelayProbe> {
  return relayPost('/v1/qbo/adopt', input)
}

export function relayDisconnectQbo(): Promise<QboRelayProbe> {
  return relayPost('/v1/qbo/disconnect', {})
}

export function relayForgetQbo(): Promise<QboRelayProbe> {
  return relayPost('/v1/qbo/forget', {})
}

/**
 * The consent URL, built by the relay because the relay holds the client id.
 *
 * `state` is minted by the caller and checked on the way back when the loopback
 * listener is in play; with the Playground redirect nothing can check it, which
 * is a property of that redirect and not of this call.
 */
export async function relayQboAuthorizeUrl(
  state: string,
  redirectUri?: string
): Promise<{ url: string; redirectUri: string }> {
  if (!relayConfigured()) throw new Error(NO_RELAY)
  const params = new URLSearchParams({ state })
  if (redirectUri) params.set('redirect', redirectUri)
  try {
    const reply = (await call(`/v1/qbo/authorize-url?${params.toString()}`, { method: 'GET' })) as {
      url?: string
      redirectUri?: string
    }
    if (!reply.url) throw new Error('The relay did not return a consent URL.')
    return { url: reply.url, redirectUri: reply.redirectUri ?? '' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(explainQboRelayProblem(message))
  }
}
