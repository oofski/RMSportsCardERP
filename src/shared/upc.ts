/**
 * Barcode / UPC normalisation. Shared by the main process and the renderer so
 * the write path (product create/update) and the read path (scan resolve) can
 * never disagree about what a barcode *is*.
 *
 * Pure functions only — no I/O, no DB, no Electron imports.
 */

/** Longest gap between two keystrokes still counted as one scanner burst (ms).
 * A human cannot type faster than this; a keyboard-wedge scanner always does. */
export const WEDGE_GAP_MS = 80
/** A whole wedge burst must complete inside this window (ms). */
export const WEDGE_MAX_TOTAL_MS = 800
/** Ignore a repeat camera decode of the same code inside this window (ms). */
export const CAMERA_COOLDOWN_MS = 1500
/** Shortest / longest cleaned payload still treated as a barcode. */
export const SCAN_MIN_LENGTH = 6
export const SCAN_MAX_LENGTH = 48

/**
 * First stage of normalisation: strip everything a scanner or a human puts
 * around the actual code. Kept separate from normalizeUpc so the "not
 * recognised" UI can echo exactly what was scanned without GTIN semantics.
 */
export function cleanScan(raw: string): string {
  if (typeof raw !== 'string' || !raw) return ''
  // \p{C} = control + format characters (the CR/LF/Tab a keyboard wedge appends,
  // plus zero-width marks and the BOM); \s = every whitespace form; and the
  // hyphens / underscores people type into a UPC field ("0 12345-67890 5").
  return raw.replace(/[\p{C}\s_-]/gu, '').toUpperCase()
}

/**
 * Expand a compressed 8-digit UPC-E code to its 12-digit UPC-A equivalent.
 * A handheld scanner that has not been configured to "expand UPC-E" transmits
 * the short form, which would otherwise never match the 12-digit UPC in the
 * catalog — i.e. a real product on the shelf reporting "not recognised".
 *
 * Rules are keyed on the last data digit (d6); the leading digit is the number
 * system (UPC-E only defines 0 and 1) and the trailing digit is the check digit.
 * Returns null when the input is not an expandable UPC-E.
 */
export function expandUpcE(digits: string): string | null {
  if (!/^\d{8}$/.test(digits)) return null
  const ns = digits[0]
  if (ns !== '0' && ns !== '1') return null
  const d = digits.slice(1, 7) // n1..n6
  const c = digits[7] // check digit
  switch (d[5]) {
    case '0':
    case '1':
    case '2':
      return `${ns}${d[0]}${d[1]}${d[5]}0000${d[2]}${d[3]}${d[4]}${c}`
    case '3':
      return `${ns}${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}${c}`
    case '4':
      return `${ns}${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}${c}`
    default:
      return `${ns}${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${d[5]}${c}`
  }
}

/**
 * THE canonical form of a barcode — the only key scan lookups compare on.
 *
 * UPC-A ("012345678905"), EAN-13 ("0012345678905") and GTIN-14 are the same
 * GTIN, so everything numeric is stripped of leading zeros and left-padded to
 * 14: a scanner that drops or adds them still matches. Non-numeric payloads
 * (Code-128 internal SKU labels) round-trip cleaned + uppercased.
 *
 * Returns null when nothing usable was scanned.
 */
export function normalizeUpc(raw: string | null | undefined): string | null {
  const cleaned = cleanScan(typeof raw === 'string' ? raw : '')
  if (!cleaned) return null
  // Not a GTIN at all (Code-128 internal label) — keep it verbatim.
  if (!/^\d+$/.test(cleaned)) return cleaned
  // A compressed UPC-E expands to UPC-A; anything else 8 digits is a real EAN-8.
  const digits = cleaned.length === 8 ? (expandUpcE(cleaned) ?? cleaned) : cleaned
  return digits.replace(/^0+/, '').padStart(14, '0')
}

/** Reject stray keystrokes before firing a resolve. */
export function isLikelyScan(value: string): boolean {
  const len = cleanScan(value).length
  return len >= SCAN_MIN_LENGTH && len <= SCAN_MAX_LENGTH
}
