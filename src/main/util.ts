import { randomBytes, randomUUID } from 'crypto'
import type { UploadedFile } from '@shared/types'

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
