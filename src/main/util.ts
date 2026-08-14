import { randomBytes, randomUUID } from 'crypto'
import { DEFAULT_BUSINESS_TIME_ZONE, setBusinessTimeZone } from '@shared/businessTime'
import type { UploadedFile } from '@shared/types'

/**
 * Point the app at the business timezone, once, at boot.
 *
 * Called by BOTH entry points — `main/index.ts` for the desktop app and
 * `server/index.ts` for the web build — because the whole class of bug this
 * guards against is the two disagreeing. The desktop inherits a Central laptop
 * and the Render container is UTC, and until the zone was named the ledger
 * importer used whichever one it happened to be running on.
 *
 * `RMOPS_BUSINESS_TZ` is the override, so moving the business or adding a second
 * location is an environment change rather than a code change. An unrecognised
 * value is REFUSED and reported, leaving the default in force: silently falling
 * back to the machine's zone is the exact failure being eliminated.
 */
/**
 * Point BOTH clocks at the business.
 *
 * ## Why this sets process.env.TZ as well
 *
 * `setBusinessTimeZone` only tells `@shared/businessTime` which zone to measure
 * against. That is enough for the code that ASKS it — and most of this app does
 * not. Dozens of call sites use plain `new Date().getHours()/.getDate()`, which
 * reads the MACHINE's zone.
 *
 * On the desktop those agree: the laptop is in Chicago. In the container they do
 * not. `node:22-bookworm-slim` is UTC, `render.yaml` sets RMOPS_BUSINESS_TZ and
 * nothing set TZ, so every one of those call sites ran five or six hours ahead
 * of the floor. That is one bug in nine places: payroll bucketed overtime into
 * the wrong week and the wrong fortnight, nobody could set availability after
 * 19:00, the owner board's Today read zero all evening, and the shipping
 * performance report dropped the whole evening's bench work.
 *
 * Node reads TZ when it constructs a Date, not once at boot, so setting it here
 * — before any handler runs — makes the machine clock and the business clock the
 * same clock. `businessTime` stays the right thing to call for anything that
 * must be correct regardless of where the process runs; this makes the code that
 * never adopted it correct too.
 *
 * The suites already pin TZ themselves (tests/build.mjs), which is exactly why
 * they could never see any of this.
 */
export function configureBusinessTimeZone(): string {
  const wanted = (process.env.RMOPS_BUSINESS_TZ ?? '').trim()
  if (!wanted) {
    if (!process.env.TZ) process.env.TZ = DEFAULT_BUSINESS_TIME_ZONE
    return DEFAULT_BUSINESS_TIME_ZONE
  }
  if (setBusinessTimeZone(wanted)) {
    process.env.TZ = wanted
    return wanted
  }
  console.error(
    `[businessTime] RMOPS_BUSINESS_TZ="${wanted}" is not a timezone this platform knows. ` +
      `Falling back to ${DEFAULT_BUSINESS_TIME_ZONE}.`
  )
  // The machine clock follows the fallback too. Leaving it on the container's
  // UTC here would reintroduce the split this function exists to close, in the
  // one case where somebody has already mistyped the zone.
  process.env.TZ = DEFAULT_BUSINESS_TIME_ZONE
  return DEFAULT_BUSINESS_TIME_ZONE
}

export function newId(): string {
  return randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Generate a readable, reasonably strong temporary password for a new
 * employee. Avoids ambiguous characters (0/O, 1/l/I) so it can be typed from
 * the invite email without confusion.
 */
export function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower = 'abcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = upper + lower + digits
  const bytes = randomBytes(10)
  let out = ''
  // Guarantee at least one of each class for a valid-looking password.
  out += upper[bytes[0] % upper.length]
  out += lower[bytes[1] % lower.length]
  out += digits[bytes[2] % digits.length]
  for (let i = 3; i < 10; i++) {
    out += all[bytes[i] % all.length]
  }
  // RM-prefixed and hyphenated for a professional, memorable format.
  return `RM-${out.slice(0, 4)}-${out.slice(4)}`
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/**
 * The bytes of an uploaded file, or null when the argument is not one.
 *
 * Returns null rather than throwing so a handler can write
 * `uploadedBytes(arg) ?? <open the native picker>` and keep the desktop path
 * exactly as it was. A malformed base64 string decodes to garbage rather than
 * failing, which is why callers still validate what they got (a PDF that is not
 * a PDF, an image with no recognised extension) instead of trusting this.
 */
export function uploadedBytes(upload: UploadedFile | null | undefined): Buffer | null {
  if (!upload || typeof upload.base64 !== 'string' || !upload.base64) return null
  const bytes = Buffer.from(upload.base64, 'base64')
  return bytes.length > 0 ? bytes : null
}

/** The text of an uploaded file, or null. Same contract as `uploadedBytes`. */
export function uploadedText(upload: UploadedFile | null | undefined): string | null {
  if (!upload || typeof upload.text !== 'string' || !upload.text) return null
  return upload.text
}

/** The name the operator chose, cleaned of any directory part. */
export function uploadedName(upload: UploadedFile | null | undefined, fallback: string): string {
  const raw = String(upload?.filename ?? '').trim()
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base || fallback
}
