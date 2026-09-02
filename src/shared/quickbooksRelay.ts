/**
 * QuickBooks, held by the relay instead of by a laptop.
 *
 * ## The problem this exists to remove
 *
 * The connection used to live in one Electron process, in that machine's
 * keychain. That has two consequences the owner met head on:
 *
 *   1. INTUIT ROTATES THE REFRESH TOKEN ON EVERY REFRESH. The response to a
 *      refresh carries a NEW refresh token and retires the one that was sent.
 *      Copy the grant onto three laptops and two of them will eventually refresh
 *      within the same hour: the first rotation succeeds, the second is answered
 *      with a fresh pair as well, and whichever machine stored last is the only
 *      one still holding a live token. The others do not fail immediately —
 *      their access token is good for another hour — so the breakage surfaces
 *      later, in the middle of raising an invoice, as an authentication error
 *      that names none of this. ONE holder removes the race outright; it is not
 *      mitigated, it cannot occur.
 *   2. THE CLIENT SECRET WOULD BE ON EVERY MACHINE. Handing it out means
 *      rotating it and reconnecting everybody the day somebody leaves, and it
 *      means the secret exists in as many places as there are laptops.
 *
 * So the Cloudflare Worker becomes the only holder of the config and the tokens,
 * performs the refresh, and makes the Intuit calls. Every laptop and the web app
 * ask it. Nothing about QuickBooks is set up per machine, ever again.
 *
 * ## What is in THIS file
 *
 * Only the decisions — no network, no Electron, no D1 — so they can be tested
 * without any of the three. The transport lives in main/quickbooks/relay.ts and
 * the QuickBooks client itself lives in cloud/worker.js.
 */

/** Who is holding the QuickBooks grant for the call that is about to be made. */
export type QboHolder = 'relay' | 'local' | 'none'

/** How the relay is protecting the tokens it stores. Reported, never assumed. */
export type QboRelayEncryption = 'dedicated' | 'shared' | 'none'

/**
 * What the relay says about itself, as the app records it.
 *
 * `reachable` is separate from `connected` on purpose, and the separation is the
 * whole point of the shape: "the relay says QuickBooks is not connected" and
 * "nobody could ask the relay" are different facts with different fixes, and
 * collapsing them into one boolean is how an outage comes out on screen as
 * "QuickBooks is not set up" and sends somebody to reconnect a connection that
 * was never broken.
 */
export interface QboRelayProbe {
  /** Is this build wired to a relay at all? A standalone build is not. */
  configured: boolean
  /** Did the relay answer just now? */
  reachable: boolean
  /** Has the relay been given a client id and secret? */
  hasConfig: boolean
  /** Is the relay holding a usable grant for a company? */
  connected: boolean
  realmId: string | null
  companyName: string | null
  /** Last four of the client id. Enough to tell two app registrations apart. */
  clientIdHint: string | null
  /** ISO, informational. */
  expiresAt: string | null
  refreshExpiresAt: string | null
  encryption: QboRelayEncryption
  /** The last failure the relay recorded against a QuickBooks call. */
  lastError: string | null
  /**
   * What the DEPLOYED Worker can do, by name.
   *
   * The relay is deployed by hand, separately from the app, so the two are
   * routinely different ages and nothing in Cloudflare says the running code is
   * older than the repository. Asking "can you do this" beats asking "are you
   * new enough": a relay that predates a feature simply does not list it, and an
   * older relay still answers with no `features` at all — which reads correctly
   * as "no" without any version arithmetic.
   */
  features: string[]
  /** Why this probe is not usable, in a sentence. Null when it is. */
  problem: string | null
}

/**
 * Can the deployed relay carry a file to QuickBooks?
 *
 * False for a relay that has not been redeployed since attachments were added.
 * The caller uses this to say so plainly rather than letting the call 404 from
 * behind a button that says "Send to QuickBooks" — which everybody reads as
 * QuickBooks being down. See explainQboRelayProblem for the same lesson learned
 * the expensive way.
 */
export function relayCanUpload(probe: QboRelayProbe | null): boolean {
  return !!probe?.features?.includes('upload')
}

/** What to tell somebody whose relay is too old to carry an attachment. */
export const RELAY_UPLOAD_UNSUPPORTED =
  'The cloud relay is running an older copy of the Worker, which cannot carry attachments. ' +
  'Deploy the current cloud/worker.js to Cloudflare and try again — the invoice itself is ' +
  'already in QuickBooks.'

export function emptyRelayProbe(configured: boolean, problem: string | null): QboRelayProbe {
  return {
    configured,
    reachable: false,
    hasConfig: false,
    connected: false,
    realmId: null,
    companyName: null,
    clientIdHint: null,
    expiresAt: null,
    refreshExpiresAt: null,
    encryption: 'none',
    features: [],
    lastError: null,
    problem
  }
}

export interface QboHolderInput {
  /** Is this build wired to a relay at all? */
  relayConfigured: boolean
  /**
   * Did the relay say it holds the connection, THE LAST TIME ANYBODY ASKED?
   *
   * Remembered rather than probed per call. A laptop that has learned the relay
   * is the holder must keep believing that while the relay is unreachable —
   * otherwise a five-minute Cloudflare wobble silently re-promotes whatever
   * stale tokens happen to be left on that machine, and those tokens refreshing
   * is exactly the rotation race this design removed.
   */
  relayHolds: boolean
  /** Does THIS machine have both an app registration and a live grant? */
  localConnected: boolean
}

/**
 * Which credentials the next QuickBooks call should use.
 *
 * The relay wins whenever it holds the connection, EVEN IF this machine still
 * has local tokens. That is deliberate and it is the rule that keeps the
 * guarantee: two holders refreshing the same grant is the failure being
 * designed out, and "use whichever is nearer" is how a machine that was never
 * cleaned up quietly becomes a second holder.
 */
export function chooseQboHolder(input: QboHolderInput): QboHolder {
  if (input.relayConfigured && input.relayHolds) return 'relay'
  if (input.localConnected) return 'local'
  return 'none'
}

/**
 * Why there is nothing to call, in words somebody can act on.
 *
 * Only ever asked when `chooseQboHolder` returned 'none', and it answers the
 * question the operator actually has — "what do I do about it" — rather than
 * restating that nothing is connected.
 */
export function qboNotConnectedReason(input: QboHolderInput): string {
  if (input.relayConfigured) {
    return (
      'QuickBooks is not connected. The connection lives in the cloud relay and is set up once, ' +
      'by the owner, under Sales Orders → QuickBooks — not on this computer.'
    )
  }
  return (
    'QuickBooks is not connected, and this copy of the app is not wired to the cloud relay ' +
    'either. Set the relay up under Admin → Developer → Cloud sync, or connect QuickBooks on ' +
    'this machine under Sales Orders → QuickBooks.'
  )
}

/**
 * Turn a relay transport failure into something that names the relay.
 *
 * This exists because of a specific, repeatable misdiagnosis. When the relay is
 * unreachable the invoice screen used to show whatever the transport threw —
 * "fetch failed", "Relay error 404" — attached to a button labelled "Send to
 * QuickBooks", and every single person read that as QuickBooks being down. It
 * is not: the invoice is saved, Intuit is fine, and the thing in the middle did
 * not answer. Two of these are worth naming individually:
 *
 *   404  The Worker is running an older copy of cloud/worker.js. The relay is
 *        healthy and simply does not have these routes — there is nothing in the
 *        Cloudflare dashboard that says the deployed code is older than the
 *        repository, so nobody finds this without being told.
 *   401  The shared key does not match. Nothing to do with Intuit at all.
 *
 * Everything else keeps its own text and gains one clause saying which hop
 * failed. An invented explanation would be worse than a plain error.
 */
export function explainQboRelayProblem(message: string): string {
  const text = String(message || '').trim()
  if (!text) return 'The cloud relay could not be reached, so QuickBooks was not called.'
  if (/\b404\b|not found/i.test(text)) {
    return (
      `${text} The relay does not have the QuickBooks routes, which almost always means it is ` +
      'running an older copy of cloud/worker.js. Re-paste that file in the Cloudflare dashboard ' +
      '(Worker → Edit code → select all → paste → Deploy). See docs/CLOUDFLARE.md.'
    )
  }
  if (/\b401\b|unauthori[sz]ed/i.test(text)) {
    return (
      `${text} That is the RELAY refusing this app's shared key, not QuickBooks refusing the ` +
      'connection. Check the key under Admin → Developer → Cloud sync.'
    )
  }
  // A TIMEOUT IS NOT A REFUSAL, and "This operation was aborted" reads like one
  // — like QuickBooks looked at the invoice and said no. Nothing looked at it.
  // The relay did not answer in time and this app gave up waiting, which is a
  // different problem with a different fix, and the raw wording sent people to
  // check their QuickBooks data for a fault that was never there.
  if (/operation was aborted|aborterror|timed out|timeout/i.test(text)) {
    return (
      'The cloud relay did not answer in time, so this app stopped waiting. NOTHING WAS REFUSED ' +
      'and nothing is wrong with the invoice — it is saved here, and QuickBooks may or may not ' +
      'have received it. Check the invoice in QuickBooks before sending it again, then press ' +
      'retry. If it keeps happening, the Worker log in the Cloudflare dashboard says what the ' +
      'relay was doing.'
    )
  }
  return `${text} That is the cloud relay, not QuickBooks — the invoice itself is saved here.`
}

/**
 * One failed relay call, attributed to whichever hop actually failed.
 *
 * This is the decision `explainQboRelayProblem` is one half of, and getting it
 * backwards is worse than having neither. The relay repeats Intuit's own words
 * for a business refusal — "QuickBooks has no customer called Nobody" — and
 * burying that under a sentence about Cloudflare sends somebody to the wrong
 * dashboard for an hour. Equally, a bare "fetch failed" under a button labelled
 * "Send to QuickBooks" reads as QuickBooks being down when the invoice is safely
 * saved and Intuit is perfectly healthy.
 *
 * So: anything that NAMES QuickBooks and is not a transport failure keeps its
 * own text; everything else is dressed as what it is, a relay that did not
 * answer. Every message the Worker produces about the accounting side contains
 * the word QuickBooks, and no transport failure does.
 */
export function describeRelayFailure(message: string): string {
  const text = String(message || '')
  if (/quickbooks/i.test(text) && !isRelayTransportFailure(text)) return text
  return explainQboRelayProblem(text)
}

/**
 * Does this error text describe the relay failing to answer, rather than
 * QuickBooks refusing something?
 *
 * Used to decide whether a failed invoice push is worth retrying unchanged. A
 * relay that timed out will succeed on the same payload in a minute; "there is
 * no customer called X in QuickBooks" never will, and telling somebody to press
 * retry on that is how an afternoon disappears.
 */
export function isRelayTransportFailure(message: string): boolean {
  const text = String(message || '').toLowerCase()
  if (!text) return false
  return (
    text.includes('cloud relay') ||
    text.includes('relay error') ||
    text.includes('sync is not configured') ||
    text.includes('fetch failed') ||
    // BOTH SPELLINGS, because they are different events and only one of them
    // was here. `controller.abort()` — which is what the relay's own timeout
    // does — produces "THIS operation was aborted"; `AbortSignal.timeout()`
    // produces "THE operation was aborted due to timeout". Matching only the
    // second meant the timeout this app causes itself was the one shape that
    // did not read as a transport failure.
    text.includes('operation was aborted') ||
    text.includes('aborterror') ||
    text.includes('network') ||
    text.includes('timed out') ||
    text.includes('econnrefused') ||
    text.includes('enotfound')
  )
}

// ---------------------------------------------------------------------------
// The one-time promotion
// ---------------------------------------------------------------------------

/**
 * What promoting an existing local connection is going to do, before it does
 * it.
 *
 * The owner is connected on one machine today. Reconnecting from scratch means
 * going back to Intuit's portal, re-consenting and picking the company again —
 * so the connection is MOVED instead: the client id, the secret and the live
 * token pair are handed to the relay, the relay proves the grant works by
 * calling QuickBooks with it, and only then is the local copy erased.
 *
 * The order matters and is the reason this can be offered as one button. Erase
 * first and a relay that refuses the tokens leaves the owner with no connection
 * anywhere and a re-consent to do. Verify first and the worst outcome is that
 * nothing changed.
 */
export type QboPromotionBlock =
  | 'no-relay'
  | 'no-local-config'
  | 'no-local-tokens'
  | 'already-there'
  | null

export interface QboPromotionInput {
  relayConfigured: boolean
  relayConnected: boolean
  localConfigured: boolean
  localConnected: boolean
}

/** Null when the promotion can run. A reason code when it cannot. */
export function promotionBlock(input: QboPromotionInput): QboPromotionBlock {
  if (!input.relayConfigured) return 'no-relay'
  if (input.relayConnected) return 'already-there'
  if (!input.localConfigured) return 'no-local-config'
  if (!input.localConnected) return 'no-local-tokens'
  return null
}

export function describePromotionBlock(block: QboPromotionBlock): string | null {
  switch (block) {
    case 'no-relay':
      return (
        'This copy of the app is not wired to the cloud relay, so there is nowhere to move the ' +
        'connection to. Set the relay up under Admin → Developer → Cloud sync first.'
      )
    case 'already-there':
      return 'The relay is already holding a QuickBooks connection. There is nothing to move.'
    case 'no-local-config':
      return 'There are no QuickBooks keys on this computer to move. Paste them in step 1 instead.'
    case 'no-local-tokens':
      return (
        'This computer has the keys but is not connected to a company, so there is no grant to ' +
        'move. Approve in the browser instead — it will connect the relay directly.'
      )
    default:
      return null
  }
}

/**
 * Exactly what the owner is agreeing to, spelled out on the button.
 *
 * Written here rather than in the component so the wording is testable and so
 * both the desktop screen and the web app say the same thing. "The local copy is
 * deleted" is the part somebody has to be told BEFORE pressing, not after: it is
 * the only irreversible half of the operation.
 */
export function promotionSummary(companyName: string | null): string[] {
  const company = (companyName ?? '').trim()
  return [
    `The client id, the client secret and the live QuickBooks grant${
      company ? ` for ${company}` : ''
    } are copied to the cloud relay and encrypted there.`,
    'The relay then calls QuickBooks with them. If that fails, nothing is changed and this ' +
      'computer stays connected exactly as it is.',
    'Once it succeeds, the keys and the tokens are ERASED from this computer. That is the point ' +
      'of the move — this machine stops being a second holder of a grant Intuit rotates.',
    'You will not reconnect QuickBooks again, on this machine or any other. Every admin who ' +
      'signs in from now on raises invoices through the relay with nothing to set up.'
  ]
}

// ---------------------------------------------------------------------------
// The request envelope
// ---------------------------------------------------------------------------

/**
 * One QuickBooks call, described rather than performed.
 *
 * The same shape the local client already takes, so a caller can be pointed at
 * either holder without knowing which. `path` is what follows
 * /v3/company/{realmId}/ — the realm is deliberately NOT in it, because the
 * relay knows which company it is connected to and a caller that supplied one
 * could aim a call at a different set of books.
 */
export interface QboCallEnvelope {
  method?: 'GET' | 'POST'
  path: string
  query?: Record<string, string>
  body?: unknown
}

/**
 * Is this a path the relay should be willing to call?
 *
 * Checked on BOTH sides — here before sending and again in the Worker — because
 * the two checks stop different things. This one catches a bug in this app; the
 * Worker's catches anybody who has the shared key and a curl command. The rule
 * is that the path stays inside the company the relay is connected to: a leading
 * slash, a scheme, or a '..' segment all escape it, and an escaped path is a
 * request aimed at somebody else's books or at a different Intuit API entirely.
 */
export function isSafeQboPath(path: string): boolean {
  const p = String(path ?? '').trim()
  if (!p) return false
  if (p.length > 300) return false
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return false
  if (p.includes('..')) return false
  // The whole surface this app uses is entity names, ids and 'query'. Anything
  // with a character outside that set is not a path this app builds.
  return /^[A-Za-z0-9/_-]+$/.test(p)
}
