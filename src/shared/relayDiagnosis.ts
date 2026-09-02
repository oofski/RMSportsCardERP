/**
 * WHICH HOP IS BROKEN. Not "the relay failed" — which part of it, and how it
 * failed.
 *
 * A QuickBooks call from this app crosses three boundaries, and until now every
 * failure anywhere along the chain arrived as one word: aborted. That word is
 * the app giving up waiting. It says nothing about what it was waiting for, so
 * the next move was a guess, and several guesses in a row is what this exists
 * to stop.
 *
 * The chain, and what each step proves when it answers:
 *
 *   1. RELAY      GET /v1/state. Touches the Worker and its sync table, nothing
 *                 else. If this answers, the Worker is deployed, running, the
 *                 address is right and the shared key is accepted. If it does
 *                 NOT, nothing downstream means anything and the sync loop is
 *                 broken too — which is a much louder symptom than the one
 *                 being chased, and its absence is itself informative.
 *
 *   2. QUICKBOOKS TABLES   GET /v1/qbo/status. Adds the QuickBooks routes and
 *                 the connection row: the Worker is new enough to have them, its
 *                 encryption key is present, and a grant is stored. Still no
 *                 call to Intuit. A relay that passes 1 and fails 2 is running
 *                 an old copy of worker.js or is missing a secret.
 *
 *   3. INTUIT     GET /v1/qbo/company. The same path a real invoice takes, and
 *                 the ONLY step that leaves Cloudflare. A relay that passes 2
 *                 and fails 3 is not a relay problem in any sense the owner can
 *                 fix by re-pasting: it is the Worker's own call to Intuit
 *                 hanging or being refused, and the Worker makes that call with
 *                 no timeout of its own.
 *
 * Each step gets its own short deadline so the diagnosis cannot itself hang —
 * a diagnostic that reproduces the bug it is diagnosing is no use to anybody.
 *
 * The timings matter as much as the verdicts. A step that answers in 40ms and a
 * step that answers in 25 seconds are both "ok", and the second one is the
 * finding.
 */

export type HopKey = 'relay' | 'quickbooks-tables' | 'intuit'

export interface HopResult {
  key: HopKey
  /** What this step is called on screen. */
  label: string
  ok: boolean
  /** How long it took, milliseconds. Present even on failure. */
  ms: number
  /** Did it exceed its own deadline rather than fail outright? */
  timedOut: boolean
  /** The failure, verbatim, when there is one. */
  error: string | null
}

export interface RelayDiagnosis {
  hops: HopResult[]
  /** The first step that failed, or null when they all answered. */
  firstFailure: HopKey | null
  /** The relay's own record of the last QuickBooks failure it saw. */
  relayLastError: string | null
  /** One paragraph naming what is wrong and what to do about it. */
  verdict: string
}

/** A step slower than this is reported as slow even though it answered. */
export const HOP_SLOW_MS = 5_000

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/**
 * Turn the timings into the sentence somebody acts on.
 *
 * ORDER IS EVERYTHING: the FIRST failure is the finding, and the ones after it
 * are consequences. Reporting all three as equal problems is how somebody
 * re-pastes a Worker because Intuit was slow.
 */
export function describeRelayDiagnosis(
  hops: readonly HopResult[],
  relayLastError: string | null
): string {
  const by = (k: HopKey): HopResult | undefined => hops.find((h) => h.key === k)
  const relay = by('relay')
  const tables = by('quickbooks-tables')
  const intuit = by('intuit')

  if (!relay || !relay.ok) {
    return (
      'THE RELAY ITSELF DID NOT ANSWER' +
      (relay?.timedOut ? ` within ${secs(relay.ms)}` : '') +
      '. Nothing below this matters until it does, and cloud sync will be failing too — check ' +
      'the relay address and key under Admin → Developer → Cloud sync, and that the Worker is ' +
      'deployed in Cloudflare.' +
      (relay?.error ? ` The exact failure: ${relay.error}` : '')
    )
  }

  if (!tables || !tables.ok) {
    return (
      `The relay answered in ${secs(relay.ms)}, so the Worker is running and the key is right — ` +
      'but its QuickBooks side did not' +
      (tables?.timedOut ? ` within ${secs(tables.ms)}` : '') +
      '. That is the Worker running an older copy of cloud/worker.js, or missing a secret it ' +
      'needs. Re-paste cloud/worker.js in the Cloudflare dashboard and check the Worker has its ' +
      'variables set.' +
      (tables?.error ? ` The exact failure: ${tables.error}` : '')
    )
  }

  if (!intuit || !intuit.ok) {
    return (
      `The relay answered in ${secs(relay.ms)} and its QuickBooks side in ${secs(tables.ms)}, so ` +
      'the Worker is fine and holding a connection. THE STEP THAT FAILED IS THE WORKER CALLING ' +
      'INTUIT' +
      (intuit?.timedOut ? `, which did not come back within ${secs(intuit.ms)}` : '') +
      '. That is not something re-pasting the Worker fixes and it is not this app timing out too ' +
      'early — the Worker makes that call with no deadline of its own, so when Intuit does not ' +
      'answer, nothing does. Check the Worker log in the Cloudflare dashboard for what it was ' +
      'doing, and whether the QuickBooks connection needs re-authorising.' +
      (intuit?.error ? ` The exact failure: ${intuit.error}` : '') +
      (relayLastError ? ` The relay's own last recorded error: ${relayLastError}` : '')
    )
  }

  const slow = [relay, tables, intuit].filter((h) => h.ms >= HOP_SLOW_MS)
  if (slow.length > 0) {
    return (
      'Every step answered, so nothing is broken right now — but ' +
      slow.map((h) => `${h.label} took ${secs(h.ms)}`).join(', ') +
      '. That is slow enough to fail under load even though it passed here, and a call that ' +
      'takes this long is the one that gets given up on. Run this again while it is failing: a ' +
      'fault that comes and goes shows up as a step that is fast now and slow then.' +
      (relayLastError ? ` The relay's own last recorded error: ${relayLastError}` : '')
    )
  }

  return (
    `Every step answered and none was slow — relay ${secs(relay.ms)}, its QuickBooks side ` +
    `${secs(tables.ms)}, Intuit ${secs(intuit.ms)}. The whole chain is healthy at this moment. ` +
    'If a push failed a minute ago the fault is intermittent, so run this again the moment one ' +
    'fails rather than after.' +
    (relayLastError
      ? ` Worth reading anyway — the relay's own last recorded error: ${relayLastError}`
      : '')
  )
}

/** The first hop that failed, in chain order. Null when all of them answered. */
export function firstFailedHop(hops: readonly HopResult[]): HopKey | null {
  const order: HopKey[] = ['relay', 'quickbooks-tables', 'intuit']
  for (const k of order) {
    const h = hops.find((x) => x.key === k)
    if (!h || !h.ok) return k
  }
  return null
}
