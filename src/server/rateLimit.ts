/**
 * Login throttling.
 *
 * The desktop app assumed a trusted machine: to try passwords you had to be
 * sitting at the computer. A public URL removes that assumption entirely, and
 * bcrypt at cost 12 — which is the right cost, and cheap enough on a real
 * server — protects the STORED hashes, not the login form. Nothing stopped a
 * script working through a Company ID with a password list.
 *
 * So attempts are counted per client and per identifier, and both have to be
 * under the limit. Per-client alone lets a botnet spread one account's attempts
 * across many addresses; per-identifier alone lets one address work through
 * every account in the company at the full rate.
 *
 * In memory on purpose. A redeploy forgets the counters, which is a real
 * weakness and is written down in docs/WEB.md rather than papered over: the
 * alternative is a table, and a lockout table on the same SQLite file that the
 * warehouse is writing to is a worse trade at this size. If this server ever
 * runs more than one process, this stops being adequate.
 */

const WINDOW_MS = 15 * 60 * 1000
/** Attempts allowed per window, from one address or against one account. */
const MAX_ATTEMPTS = 10

interface Bucket {
  count: number
  /** When the window opened. Everything is measured from here. */
  since: number
}

const buckets = new Map<string, Bucket>()

function bucketFor(key: string, now: number): Bucket {
  const found = buckets.get(key)
  if (!found || now - found.since > WINDOW_MS) {
    const fresh = { count: 0, since: now }
    buckets.set(key, fresh)
    return fresh
  }
  return found
}

/**
 * May this login attempt proceed?
 *
 * Checked BEFORE the password is verified, so a blocked attempt costs no bcrypt
 * work — otherwise the throttle would be the thing that lets someone exhaust
 * the CPU.
 */
export function loginAllowed(client: string, identifier: string): boolean {
  const now = Date.now()
  const byClient = bucketFor(`ip:${client}`, now)
  const byAccount = bucketFor(`id:${identifier.trim().toLowerCase()}`, now)
  return byClient.count < MAX_ATTEMPTS && byAccount.count < MAX_ATTEMPTS
}

/** Record a FAILED attempt. Successes deliberately do not count against anyone. */
export function loginFailed(client: string, identifier: string): void {
  const now = Date.now()
  bucketFor(`ip:${client}`, now).count += 1
  bucketFor(`id:${identifier.trim().toLowerCase()}`, now).count += 1
}

/** Clear the identifier's count after a successful sign-in. */
export function loginSucceeded(client: string, identifier: string): void {
  buckets.delete(`id:${identifier.trim().toLowerCase()}`)
  buckets.delete(`ip:${client}`)
}

/** Drop windows that have expired, so the map cannot grow without bound. */
export function purgeRateLimits(): void {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (now - bucket.since > WINDOW_MS) buckets.delete(key)
  }
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear()
}
