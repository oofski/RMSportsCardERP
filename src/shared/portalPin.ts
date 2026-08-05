/**
 * The clock-in portal's PIN, and the one format the app and the Worker share.
 *
 * ## Why a PIN at all, and not the app password
 *
 * Employee passwords are bcrypt at cost 12 — deliberately expensive, which is
 * right on a laptop and fatal in a Cloudflare Worker on the free plan, where an
 * invocation is killed after 10ms of CPU. Verifying one bcrypt hash is roughly
 * thirty times that budget, so the portal would 500 on every login attempt.
 *
 * So the portal gets its own credential, hashed with something a Worker can
 * actually run: PBKDF2-SHA256 through WebCrypto, which is native rather than
 * interpreted. The app password is untouched and the portal cannot be used to
 * discover it — different secret, different hash, different table column.
 *
 * ## What the iteration count is and is not
 *
 * ITERATIONS is chosen to fit the free plan's CPU budget. It is NOT chosen to
 * make a six-digit PIN expensive to crack offline, and no honest iteration count
 * could: a million candidates is a small number, and anybody holding the hash
 * has already lost. What actually defends this credential is the lockout in the
 * Worker — a handful of wrong tries and that employee cannot be attempted again
 * for a while, recorded server-side so it survives across Worker instances.
 *
 * Stated plainly because the alternative is somebody later reading "PBKDF2" and
 * assuming the stored hash is the defence. It is not. The lockout is.
 *
 * ## The format
 *
 *   pbkdf2$sha256$<iterations>$<salt-b64>$<hash-b64>
 *
 * Self-describing on purpose. The iteration count and the salt travel INSIDE
 * the string, so the Worker needs no shared constant, no config and no redeploy
 * to keep verifying hashes the app wrote — including hashes written before a
 * future change to ITERATIONS. A verifier that reads its parameters from the
 * hash keeps working; one that hardcodes them starts rejecting valid PINs the
 * day the number moves.
 *
 * Base64 is standard, not URL-safe: this string is stored and compared, never
 * put in a URL.
 */

/** Fits the Cloudflare free plan's 10ms CPU budget. See above — not a security parameter. */
export const PORTAL_PIN_ITERATIONS = 25_000

/** Bytes of salt, and bytes of derived key. */
export const PORTAL_PIN_SALT_BYTES = 16
export const PORTAL_PIN_HASH_BYTES = 32

export const PORTAL_PIN_PREFIX = 'pbkdf2$sha256$'

/** Exactly six digits. Anything else is refused before it is hashed. */
export const PORTAL_PIN_RE = /^[0-9]{6}$/

/**
 * PINs a person would pick and an attacker would try first.
 *
 * Rejected at the point the PIN is SET rather than warned about, because the
 * whole credential is six digits and the top few guesses cover a startling share
 * of real-world choices. A repeated digit and a straight run are the two that
 * matter; birthdays are not detectable from six digits alone.
 */
export function isWeakPortalPin(pin: string): boolean {
  if (!PORTAL_PIN_RE.test(pin)) return false
  if (/^(\d)\1{5}$/.test(pin)) return true
  const digits = [...pin].map(Number)
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 1) % 10)
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] + 9) % 10)
  return ascending || descending
}

export interface ParsedPortalPin {
  iterations: number
  salt: Uint8Array
  hash: Uint8Array
}

function fromBase64(s: string): Uint8Array {
  // Works in both runtimes: Node has Buffer, a Worker has atob. Neither is
  // assumed — this file is compiled into the app AND read by whoever maintains
  // the Worker's copy, and it must not depend on which one is looking.
  if (typeof atob === 'function') {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(s, 'base64'))
}

/**
 * Pull the parameters back out of a stored hash.
 *
 * Returns null for anything malformed rather than throwing: this runs on a
 * value that arrived over the network from a database row, and a garbled row
 * must read as "this PIN does not verify", never as a crash on a login page.
 */
export function parsePortalPinHash(stored: string | null | undefined): ParsedPortalPin | null {
  if (!stored || typeof stored !== 'string') return null
  const parts = stored.split('$')
  if (parts.length !== 5) return null
  const [scheme, digest, iterText, saltB64, hashB64] = parts
  if (scheme !== 'pbkdf2' || digest !== 'sha256') return null
  const iterations = Number(iterText)
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) return null
  try {
    const salt = fromBase64(saltB64)
    const hash = fromBase64(hashB64)
    if (salt.length === 0 || hash.length === 0) return null
    return { iterations, salt, hash }
  } catch {
    return null
  }
}

/**
 * Equal, in time that does not depend on HOW equal.
 *
 * The comparison is between a stored hash and one just derived, so a fast exit
 * on the first differing byte leaks where the difference is. Cheap to avoid.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
