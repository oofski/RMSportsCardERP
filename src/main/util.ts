import { randomBytes, randomUUID } from 'crypto'

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
