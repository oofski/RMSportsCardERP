/**
 * RM Cardz Shipping Workspace — the PDF-text grammar (architecture doc §2).
 *
 * `parsePages(pages, opts)` turns the per-page strings produced by
 * `extractPages` into a normalized `ShippingDataset`. It is PURE: no I/O, no
 * clock, no randomness, no module state — feed it synthetic strings and it is
 * fully unit-testable. All file reading lives in ./pdf.ts.
 *
 * Pipeline (each step maps 1:1 to a section of the doc):
 *   2.1 groupByCustomer      pages -> per-customer { packingPages, breakingPages }
 *   2.2 parseBreakingSlip    the internal pick doc = ground truth for WHICH teams
 *                            are in WHICH break
 *   2.3 parsePackingSlip     the label side = truth for identity, price, tracking
 *   2.4 reconcileBreakNumbers a corrupted break NUMBER is re-voted from packing
 *                            ORDER IDS (never team names)
 *   2.5 emit                 breaks + team slots + mirror orders + the giveaway
 *                            sweep (with dedup)
 *   2.6 materialize          break records + the fidelity audit (missing teams,
 *                            collisions) + USPS batch URLs
 *
 * The robustness rules from §9 are implemented inline and called out in
 * comments where they live.
 */

import type {
  ShipBatchUrl,
  ShipBreakAudit,
  ShipBreakCollision,
  ShipBreakDraft,
  ShipCustomer,
  ShipOrder,
  ShipParseProgress,
  ShipShipmentDraft,
  ShipSport,
  ShipSportOption,
  ShipTeamSlotDraft,
  ShipWarningInput,
  ShippingDataset
} from '@shared/shippingTypes'
import { SHIP_SPORT_LABELS } from '@shared/shippingTypes'
import {
  createNullTeamMatcher,
  createTeamMatcher,
  detectSport,
  normalizeTeamKey,
  type TeamMatcher
} from './teams'

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

const RE_PACKING_HEADER = /Whatnot\s+Packing\s+Slip/i
const RE_BREAKING_HEADER = /Whatnot\s*[-–—]?\s*Break(?:ing)?\s+Slip/i
const RE_TO_HANDLE = /To:\s*(\S+)/
const RE_ORDER_ANY = /Order\s+(\d+)/i
const RE_ORDER_GLOBAL = /Order\s+(\d+)/gi
/** 1–3 digits only: an order id (10 digits) must never read as a break number. */
const RE_BREAK_NUMBER = /Break\s*#\s*(\d{1,3})(?!\d)/i
const RE_CHECKBOX = /^(?:_{2,}|\[[ xX]?\]|[☐☑✓✔❑▢◻◼□■•·])\s+(.+)$/
const RE_ITEMS_NOISE = /^\d+\s*x?\s*items?$/i
const RE_TOTAL_LINE = /^Total\s*:/i
const RE_ORDERS_LINE = /\bOrders?\s*:\s*(.+)$/i
const RE_ORDER_ID_TOKEN = /#\s*(\d+)/g
/**
 * USPS prints tracking in 4-digit groups (`#9400 1118 9922 3197 4284 90`), so the
 * SPACED form must be tried first: the strict pattern's language is a superset and
 * it would happily stop at the first group, truncating every tracking number to
 * `9400` and collapsing every package onto one id.
 *
 * The service-type class deliberately excludes newlines (` ` not `\s`). With `\s`
 * an unanchored match starting at a line-final "USPS" token runs down the page and
 * captures the buyer's name and street address as the shipping service.
 */
const RE_USPS_SPACED = /USPS\s+([\w ®™]+?)\s+#\s*(\d[\d ]{8,})/i
const RE_USPS_STRICT = /USPS\s+([\w ®™]+?)\s+#\s*(\d{6,})/i
const RE_WEIGHT = /([\d.]+)\s*oz\b/i
/** Thousands separators are part of the number: `$1,250.00` is 1250, not 1. */
const RE_PRICE = /\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/
const RE_PRICE_GLOBAL = /\$\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/g
/** `NEW` badge — but never the `NEW` of a city name. */
const RE_NEW_BADGE = /(?:^|\s)NEW(?!\s+(?:YORK|ORLEANS|ENGLAND|JERSEY|MEXICO|HAMPSHIRE))(?:\s|$|!|\*)/
const RE_ADDRESS_STOP =
  /(?:Order\s+\d+|USPS|Break\s*#|\d+(?:\.\d+)?\s*oz\b|\$|\d{1,2}\/\d{1,2}\/\d{2,4}|^Total\b|^Subtotal\b|^Items?\b|^Qty\b|Whatnot|Packing\s+Slip|Breaking\s+Slip|Tracking)/i

const NAME_STOPWORDS = new Set([
  'NEW',
  'USPS',
  'GROUND',
  'ADVANTAGE',
  'PRIORITY',
  'MAIL',
  'FIRST',
  'CLASS',
  'TOTAL',
  'SUBTOTAL',
  'ORDER',
  'ORDERS',
  'BREAK',
  'BREAKS',
  'WHATNOT',
  'SLIP',
  'PACKING',
  'BREAKING',
  'FROM',
  'TO',
  'QTY',
  'ITEM',
  'ITEMS',
  'SHIP',
  'SHIPPING',
  'TRACKING',
  'THANK',
  'THANKS',
  'RETURN',
  'WEIGHT',
  'DATE',
  'INVOICE',
  'SELLER',
  'BUYER',
  'ADDRESS'
])

/** USPS' bulk tracking page accepts a comma-separated batch of labels. */
export const USPS_BATCH_SIZE = 35
const USPS_TRACK_BASE = 'https://tools.usps.com/go/TrackConfirmAction?tLabels='

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** One page of the source PDF, with its 1-based page number preserved. */
export interface PageRef {
  page: number
  text: string
}

interface PageLine {
  page: number
  text: string
}

export interface CustomerGroup {
  handle: string
  packingPages: PageRef[]
  breakingPages: PageRef[]
}

export interface GroupResult {
  groups: CustomerGroup[]
  warnings: ShipWarningInput[]
}

export interface BreakingTeam {
  raw: string
  page: number
}

export interface BreakingBreak {
  breakNumber: number
  orderIds: Set<string>
  teams: BreakingTeam[]
}

export interface BreakingSlip {
  realName: string
  breaks: BreakingBreak[]
  warnings: ShipWarningInput[]
}

export interface PackingOrder {
  orderId: string
  breakNumber: number | null
  /** Canonical team when it resolved, otherwise the best raw candidate. */
  team: string | null
  teamRaw: string | null
  matched: boolean
  price: number
  hasPrice: boolean
  isGiveaway: boolean
  page: number
}

export interface PackingSlip {
  handle: string
  realName: string
  address: string
  isNew: boolean
  trackingNumber: string | null
  carrier: string | null
  serviceType: string | null
  weightOz: number | null
  orders: PackingOrder[]
  warnings: ShipWarningInput[]
  /**
   * The product / pack title printed on the slip, e.g. "2025 FINEST FOOTBALL".
   * Loud all-caps marketing lines like "BREAKERS DELIGHT! RANDOM" sit next to
   * the buyer's address, so they are detected here BOTH to keep them out of the
   * address and to name the import after what was actually broken.
   */
  packTitle: string | null
}

export interface ParsePagesOptions {
  /** A league, or `auto` to run `detectSport` over every team string once. */
  sport?: ShipSportOption
  /** Operator-supplied event identity — carry-forward keys off the NAME. */
  eventName?: string | null
  eventDate?: string | null
  onProgress?: (progress: ShipParseProgress) => void
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function cleanTeamText(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:;,.•·*_]+/, '')
    .replace(/[\s\-–—:;,•·*_]+$/, '')
    .trim()
}

function stripQty(raw: string): string {
  return raw
    .replace(/^\s*\d+\s*(?:x|×)?\s+/i, '')
    .replace(/\s+\d+\s*$/, '')
    .trim()
}

/** Strip every `$1,250.00`-style token (used on the "team before Order" side). */
function stripPrices(raw: string): string {
  return raw.replace(RE_PRICE_GLOBAL, ' ')
}

/** Cut a candidate at the first `$` / `Order` and keep only its first line. */
function truncateCandidate(raw: string): string {
  let t = raw.split('\n')[0] ?? ''
  const dollar = t.indexOf('$')
  if (dollar >= 0) t = t.slice(0, dollar)
  const order = t.search(/\bOrder\b/i)
  if (order >= 0) t = t.slice(0, order)
  return cleanTeamText(t)
}

/** `$1,250.00` -> 1250. Never negative, always rounded to cents. */
export function toPrice(raw: string | null | undefined): number {
  if (!raw) return 0
  const n = Number.parseFloat(String(raw).replace(/,/g, ''))
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.round(n * 100) / 100)
}

function cleanHandle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const h = raw
    .trim()
    .replace(/^@+/, '')
    .replace(/[.,:;)\]]+$/, '')
    .trim()
  if (h.length < 2) return null
  if (!/[A-Za-z0-9]/.test(h)) return null
  return h
}

function toLines(pages: PageRef[]): PageLine[] {
  const out: PageLine[] = []
  for (const page of pages) {
    for (const raw of page.text.split('\n')) {
      const text = raw.trim()
      if (text) out.push({ page: page.page, text })
    }
  }
  return out
}

function firstLines(text: string, count = 3): string {
  return text.split('\n').slice(0, count).join(' | ').slice(0, 240)
}

/**
 * A product / pack title line: shouty, usually carrying a year and a product
 * word. These print between the buyer name and the street address, so without
 * this they end up inside `address`.
 */
const RE_PACK_YEAR = /\b(19|20)\d{2}\b/
function isPackTitleLine(line: string): boolean {
  if (!line || line.length < 6 || line.length > 90) return false
  const letters = line.replace(/[^A-Za-z]/g, '')
  if (letters.length < 4) return false
  // Overwhelmingly upper-case is the signal — a street address is title-case.
  const upper = letters.replace(/[^A-Z]/g, '').length / letters.length
  if (upper < 0.8) return false
  // A pure ALL-CAPS city/state line ("LOS ANGELES CA") is an address, not a pack.
  if (/^[A-Z .'-]+,?\s*[A-Z]{2}\s*\d{5}(-\d{4})?$/.test(line.trim())) return false
  return RE_PACK_YEAR.test(line) || /\b(BREAK|BREAKERS|RANDOM|PYT|MIXER|CASE|BOX|HOBBY|PACK|RIP)\b/.test(line)
}

/** Prefer the most specific title seen: the one carrying a year. */
function bestPackTitle(titles: string[]): string | null {
  if (!titles.length) return null
  const withYear = titles.filter((t) => RE_PACK_YEAR.test(t))
  const pool = withYear.length ? withYear : titles
  const counts = new Map<string, number>()
  for (const t of pool) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0]
}

function isProperNameLine(line: string): boolean {
  if (!line) return false
  if (line.length < 2 || line.length > 60) return false
  if (/\d/.test(line)) return false
  if (/[$:@#]/.test(line)) return false
  if (!/^[A-Za-z]/.test(line)) return false
  if (!/^[A-Za-z][A-Za-z.'\u00C0-\u024F-]*(?:\s+[A-Za-z.'\u00C0-\u024F-]+)*$/.test(line)) return false
  const words = line.split(/\s+/)
  if (words.length > 5) return false
  for (const w of words) {
    if (NAME_STOPWORDS.has(w.toUpperCase().replace(/[.'-]/g, ''))) return false
  }
  return true
}

/**
 * Defensive last pass over a buyer's real name.
 *
 * WHY: a pre-v0.0.25 build shipped names with the slip's pack title glued on
 * ("Bailey Arnett 2025 FINEST FOOTBALL"), and those names are still sitting in
 * saved datasets. `isProperNameLine` rejects any line containing a digit, so
 * the current parser cannot reproduce the year-bearing form — but a YEAR-LESS
 * shouty tail ("Bailey Arnett FINEST FOOTBALL") is all letters, four words and
 * carries no stopword, so it would still pass. This trims that tail plus the
 * stray box / bullet glyphs the PDF text layer leaves behind.
 *
 * It is deliberately conservative: a name that is uniformly shouty is a real
 * name printed in caps ("BAILEY ARNETT") with nothing to tell head from tail,
 * so it is left exactly as it is, and the first word is never dropped.
 *
 * A LONE shouty tail word is also kept. All-caps surnames are ordinary in a
 * shipping address ("Kevin MCDONALD", "Anne-Marie DE LA CRUZ"), and dropping
 * one silently mails a package to half a name — much worse than leaving a
 * stray title word on. A real glued-on pack title always shows itself as
 * either a year/number or two or more shouty words, so that is what is cut.
 */
export function sanitizeRealName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '').replace(/[☐☑✓✔❑▢◻◼□■•·*_]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  // A pack-title word: carries a digit, or is >=4 chars of pure upper case.
  // The length floor keeps real suffixes ("JR", "III") out of it.
  const isPackWord = (w: string): boolean =>
    /\d/.test(w) || (w.length >= 4 && /^[A-Z][A-Z.'À-ɏ-]*$/.test(w))
  const words = cleaned.split(' ')
  if (words.every(isPackWord)) return cleaned
  // Measure the trailing run first, then decide whether it is a title at all.
  let run = words.length
  while (run > 1 && isPackWord(words[run - 1])) run--
  const tail = words.slice(run)
  // A year opens the pack title, so cut from it and keep whatever shouty word
  // came before ("Kevin MCDONALD 2025 PRIZM" -> "Kevin MCDONALD").
  const year = tail.findIndex((w) => /\d/.test(w))
  if (year >= 0) return words.slice(0, run + year).join(' ')
  // No number to anchor on, so this is a guess — take it only when it is safe.
  // Two or more shouty words read as a title ("Bailey Arnett FINEST FOOTBALL"),
  // but never cut down to a lone first name: "Mary SMITH JONES" is a person
  // with a double-barrelled surname, not a pack title. Losing half of a real
  // name is worse than keeping a title we were not sure about.
  const keptWords = run
  if (tail.length >= 2 && keptWords >= 2) return words.slice(0, run).join(' ')
  return words.join(' ')
}

export function trackingUrl(tracking: string): string {
  return `${USPS_TRACK_BASE}${encodeURIComponent(tracking)}`
}

/** Batch the tracking numbers into USPS "open all" bulk URLs. */
export function buildBatchUrls(trackingNumbers: string[], batchSize = USPS_BATCH_SIZE): ShipBatchUrl[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const t of trackingNumbers) {
    const v = (t ?? '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    unique.push(v)
  }
  const out: ShipBatchUrl[] = []
  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize)
    out.push({
      batchNumber: out.length + 1,
      count: chunk.length,
      url: `${USPS_TRACK_BASE}${encodeURIComponent(chunk.join(','))}`
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// §2.1 — group pages into per-customer blocks
// ---------------------------------------------------------------------------

/**
 * The handle a breaking slip claims for itself: `Whatnot - Breaking Slip
 * (handle)` wins over the carried-over one.
 */
function breakingHandle(text: string): string | null {
  const to = text.match(RE_TO_HANDLE)
  if (to) {
    const handle = cleanHandle(to[1])
    if (handle) return handle
  }
  // `Real Name (handle)` under the header. Whatnot handles are lowercase, which
  // is what keeps an all-caps product title — `(GIVEAWAY RELEASE)` — from being
  // mistaken for a handle.
  for (const m of text.matchAll(/\(\s*@?([A-Za-z0-9._-]{2,})\s*\)/g)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(m[1])) continue
    if (!/[a-z]/.test(m[1])) continue
    const handle = cleanHandle(m[1])
    if (handle) return handle
  }
  return null
}

/**
 * Bucket pages by customer handle, carrying `currentHandle` / `currentSlip`
 * across header-less continuation pages.
 *
 * Rule 6 lives here: a bare shipping-LABEL page (address + barcode, no `Order
 * <id>` line) printed before its own packing slip must NOT attach to the
 * previous customer, or it hijacks their tracking. Such pages are skipped
 * WITHOUT resetting the carried state, so a genuine continuation that follows
 * still lands on the right customer.
 */
export function groupByCustomer(pages: string[]): GroupResult {
  const byHandle = new Map<string, CustomerGroup>()
  const groups: CustomerGroup[] = []
  const warnings: ShipWarningInput[] = []

  const ensure = (handle: string): CustomerGroup => {
    let g = byHandle.get(handle)
    if (!g) {
      g = { handle, packingPages: [], breakingPages: [] }
      byHandle.set(handle, g)
      groups.push(g)
    }
    return g
  }

  let currentHandle: string | null = null
  let currentSlip: 'packing' | 'breaking' | null = null

  pages.forEach((text, index) => {
    const page = index + 1
    if (!text || !text.trim()) return // blank page: skip, keep the carried state

    const isPacking = RE_PACKING_HEADER.test(text)
    const isBreaking = RE_BREAKING_HEADER.test(text)

    if (isPacking) {
      const handle = cleanHandle(text.match(RE_TO_HANDLE)?.[1])
      if (handle) currentHandle = handle
      currentSlip = 'packing'
      if (!currentHandle) {
        warnings.push({
          page,
          message: 'Packing slip page has no "To:" handle — the page could not be attributed to a customer.',
          rawText: firstLines(text)
        })
        return
      }
      ensure(currentHandle).packingPages.push({ page, text })
      return
    }

    if (isBreaking) {
      const handle = breakingHandle(text) ?? currentHandle
      currentSlip = 'breaking'
      if (!handle) {
        warnings.push({
          page,
          message: 'Breaking slip page has no handle and no preceding packing slip — the page was skipped.',
          rawText: firstLines(text)
        })
        return
      }
      currentHandle = handle
      ensure(handle).breakingPages.push({ page, text })
      return
    }

    // Header-less page: a continuation, or a stray shipping label.
    if (currentSlip === 'breaking' && currentHandle) {
      // Breaking slips do NOT repeat their header on continuation pages — a page
      // can start with `Total:` / `Orders:` / a bare `__ Team`. Attach it or
      // every break after page 1 is lost.
      ensure(currentHandle).breakingPages.push({ page, text })
      return
    }
    if (currentSlip === 'packing' && currentHandle && RE_ORDER_ANY.test(text)) {
      // Real item continuation only. Packing slips repeat their header, so a
      // genuine 2/2 page is caught by `isPacking` above.
      ensure(currentHandle).packingPages.push({ page, text })
      return
    }
    if (!currentHandle) {
      warnings.push({
        page,
        message: 'Page appears before any slip header — skipped.',
        rawText: firstLines(text)
      })
    }
    // Otherwise: a bare label page. Skip it, but do NOT reset the carried state.
  })

  return { groups, warnings }
}

// ---------------------------------------------------------------------------
// §2.2 — the breaking slip (ground truth for which teams sit in which break)
// ---------------------------------------------------------------------------

/**
 * Rule 2: the section title can wrap so a line ends on the word `Break` and its
 * `#N` drops to the next line. Stitch them back together BEFORE walking. The
 * `{1,3}` digit cap stops a 10-digit order-id line being swallowed as a break
 * number.
 */
export function stitchWrappedBreakHeaders(lines: PageLine[]): PageLine[] {
  const out: PageLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    if (next && /(?:^|\s)Break$/i.test(cur.text) && /^#\s*\d{1,3}(?:\s|$)/.test(next.text)) {
      out.push({ page: cur.page, text: `${cur.text} ${next.text}` })
      i++
      continue
    }
    out.push(cur)
  }
  return out
}

function isStructuralLine(text: string): boolean {
  return (
    RE_BREAK_NUMBER.test(text) ||
    RE_TOTAL_LINE.test(text) ||
    RE_ORDERS_LINE.test(text) ||
    RE_ORDER_ANY.test(text) ||
    /Whatnot|Packing\s+Slip|Breaking\s+Slip|USPS|Tracking/i.test(text) ||
    /\$/.test(text)
  )
}

/**
 * The glyph-loss fallback: some exports drop the checkbox glyph entirely. A
 * short, non-structural line inside a break that RESOLVES to a known team is a
 * purchased slot. Kept deliberately narrow (short line, few words, no digits
 * beyond a team name) so an all-caps product title never sneaks in.
 */
function isPlausibleBareTeamLine(text: string): boolean {
  if (text.length < 3 || text.length > 40) return false
  if (isStructuralLine(text)) return false
  if (/[#$:@]/.test(text)) return false
  if (RE_ITEMS_NOISE.test(text)) return false
  const words = text.split(/\s+/)
  if (words.length > 5) return false
  return /[A-Za-z]/.test(text)
}

function guessBreakingRealName(text: string): string | null {
  const m = text.match(/^([A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*)+)\s*\(\s*@?[a-z0-9][a-z0-9._-]*\s*\)/)
  return m ? m[1].trim() : null
}

export function parseBreakingSlip(pages: PageRef[], matcher: TeamMatcher): BreakingSlip {
  const warnings: ShipWarningInput[] = []
  const lines = stitchWrappedBreakHeaders(toLines(pages))

  const byNumber = new Map<number, BreakingBreak>()
  const breaks: BreakingBreak[] = []
  const ensureBreak = (n: number): BreakingBreak => {
    let b = byNumber.get(n)
    if (!b) {
      b = { breakNumber: n, orderIds: new Set<string>(), teams: [] }
      byNumber.set(n, b)
      breaks.push(b)
    }
    return b
  }

  // The current-break pointer is carried ACROSS pages — never reset per page.
  let current: BreakingBreak | null = null
  let realName = ''
  let orphanTeams = 0

  for (const line of lines) {
    const text = line.text

    if (!realName) {
      const guess = guessBreakingRealName(text)
      // Same defensive trim as the packing side — the breaking slip's
      // `Real Name (handle)` capture has no digit guard at all.
      if (guess) realName = sanitizeRealName(guess) || guess
    }

    const header = text.match(RE_BREAK_NUMBER)
    if (header) {
      current = ensureBreak(Number(header[1]))
      continue
    }

    if (RE_TOTAL_LINE.test(text)) {
      current = null
      continue
    }

    const ordersLine = text.match(RE_ORDERS_LINE)
    if (ordersLine) {
      if (current) {
        for (const m of ordersLine[1].matchAll(RE_ORDER_ID_TOKEN)) current.orderIds.add(m[1])
      }
      continue
    }
    if (current && /^#\s*\d{4,}/.test(text)) {
      for (const m of text.matchAll(RE_ORDER_ID_TOKEN)) current.orderIds.add(m[1])
      continue
    }

    const checkbox = text.match(RE_CHECKBOX)
    if (checkbox) {
      const team = cleanTeamText(checkbox[1])
      if (!team || RE_ITEMS_NOISE.test(team)) continue // rule 4: `N Items` is noise
      if (!current) {
        orphanTeams++
        continue
      }
      current.teams.push({ raw: team, page: line.page })
      continue
    }

    if (current && isPlausibleBareTeamLine(text) && matcher.matchTeam(text).team) {
      current.teams.push({ raw: cleanTeamText(text), page: line.page })
    }
  }

  if (orphanTeams > 0) {
    warnings.push({
      page: lines[0]?.page ?? null,
      message: `${orphanTeams} checkbox team${orphanTeams === 1 ? '' : 's'} on the breaking slip sat outside any "Break #N" section and were skipped.`,
      rawText: null
    })
  }

  return { realName, breaks, warnings }
}

// ---------------------------------------------------------------------------
// §2.3 — the packing slip (identity, price, tracking)
// ---------------------------------------------------------------------------

interface OrderPosition {
  lineIndex: number
  start: number
  end: number
  id: string
}

export function parsePackingSlip(
  handle: string,
  pages: PageRef[],
  matcher: TeamMatcher | null
): PackingSlip {
  const warnings: ShipWarningInput[] = []
  const slip: PackingSlip = {
    handle,
    realName: '',
    address: '',
    packTitle: null,
    isNew: false,
    trackingNumber: null,
    carrier: null,
    serviceType: null,
    weightOz: null,
    orders: [],
    warnings
  }
  if (!pages.length) return slip

  // --- identity + address (first page only) -------------------------------
  const firstLinesOfSlip = pages[0].text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const toIndex = firstLinesOfSlip.findIndex((l) => RE_TO_HANDLE.test(l))
  const fromIndex = firstLinesOfSlip.findIndex((l) => /^From:/i.test(l))
  const anchor = toIndex >= 0 ? toIndex : fromIndex

  if (anchor >= 0) {
    const addressLines: string[] = []
    const packTitles: string[] = []
    // Lines seen while hunting for the name — used as the address when the slip
    // has no proper-case buyer name at all.
    const beforeName: string[] = []
    for (let i = anchor + 1; i < firstLinesOfSlip.length; i++) {
      const line = firstLinesOfSlip[i]
      if (RE_ADDRESS_STOP.test(line)) break
      if (!slip.realName) {
        // Skip the badge / blank filler that can sit between To: and the name.
        if (/^NEW\b/i.test(line)) continue
        if (isProperNameLine(line)) {
          // Defensive only — see sanitizeRealName. Never let the sanitiser blank
          // a name it could not read: fall back to the line as printed.
          slip.realName = sanitizeRealName(line) || line
          continue
        }
        beforeName.push(line)
        if (i - anchor > 5) break
        continue
      }
      // A pack title is not part of the address — bank it and carry on.
      if (isPackTitleLine(line)) {
        packTitles.push(line.replace(/\s+/g, ' ').trim())
        continue
      }
      addressLines.push(line)
      if (addressLines.length >= 3) break
    }
    slip.address = (addressLines.length ? addressLines : beforeName).slice(0, 3).join(', ')
    slip.packTitle = bestPackTitle(packTitles)
  }

  // The `NEW` badge sits on (or right under) the To: line. Never treat the
  // `New` of `New York` as the badge.
  if (toIndex >= 0) {
    for (let i = toIndex; i <= Math.min(toIndex + 2, firstLinesOfSlip.length - 1); i++) {
      if (RE_NEW_BADGE.test(firstLinesOfSlip[i])) {
        slip.isNew = true
        break
      }
    }
  }

  // --- tracking / service / weight: the LAST page with a USPS line wins ----
  for (const page of pages) {
    // Spaced first (see the regex comments): a real label is grouped, and the
    // strict form would win on just its first group.
    const spaced = page.text.match(RE_USPS_SPACED)
    const hit = spaced ?? page.text.match(RE_USPS_STRICT)
    if (hit) {
      slip.serviceType = hit[1].replace(/\s+/g, ' ').trim() || null
      slip.trackingNumber = hit[2].replace(/\s+/g, '')
      slip.carrier = 'USPS'
    }
    const weight = page.text.match(RE_WEIGHT)
    if (weight) {
      const oz = Number.parseFloat(weight[1])
      if (Number.isFinite(oz)) slip.weightOz = oz
    }
  }

  // --- per-order lines ----------------------------------------------------
  const lines = toLines(pages)
  const positions: OrderPosition[] = []
  lines.forEach((line, lineIndex) => {
    RE_ORDER_GLOBAL.lastIndex = 0
    for (const m of line.text.matchAll(RE_ORDER_GLOBAL)) {
      positions.push({
        lineIndex,
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        id: m[1]
      })
    }
  })

  for (let j = 0; j < positions.length; j++) {
    const pos = positions[j]
    const prev = positions[j - 1]
    const next = positions[j + 1]
    const lineText = lines[pos.lineIndex].text
    const sameLinePrev = prev && prev.lineIndex === pos.lineIndex
    const sameLineNext = next && next.lineIndex === pos.lineIndex

    const sliceStart = sameLinePrev ? prev.end : 0
    const sliceEnd = sameLineNext ? next.start : lineText.length

    // Text before this `Order` on its own line, and the window from the order
    // id forward — capped at 8 lines, stopping at the next order line.
    const beforeOrder = lineText.slice(sliceStart, pos.start)
    const tail: string[] = []
    if (!sameLineNext) {
      const endLine = next ? next.lineIndex : lines.length
      for (let k = pos.lineIndex + 1; k < Math.min(endLine, pos.lineIndex + 8); k++) {
        tail.push(lines[k].text)
      }
    }
    const windowText = [lineText.slice(pos.start, sliceEnd), ...tail].join('\n')
    const fullWindow = `${beforeOrder}\n${windowText}`

    // break number (rule 2's `{1,3}` cap applies here too)
    const breakMatch = fullWindow.match(RE_BREAK_NUMBER)
    const breakNumber = breakMatch ? Number(breakMatch[1]) : null

    // team — two real layouts; prefer whichever resolves canonically.
    const candidates: string[] = []
    if (breakMatch) {
      const after = fullWindow.slice((breakMatch.index ?? 0) + breakMatch[0].length)
      const candidate = truncateCandidate(after)
      if (candidate) candidates.push(candidate)
    }
    // Test the noise guard BEFORE stripQty: it anchors on the leading digits
    // ("1 Item"), and stripping the quantity first leaves a bare "Item" that
    // sails through and becomes a team name in the pick list.
    const beforePre = cleanTeamText(stripPrices(beforeOrder))
    const beforeCandidate = RE_ITEMS_NOISE.test(beforePre)
      ? ''
      : cleanTeamText(stripQty(beforePre))
    if (beforeCandidate) candidates.push(beforeCandidate)

    let team: string | null = null
    let teamRaw: string | null = null
    let matched = false
    for (const candidate of candidates) {
      if (RE_ITEMS_NOISE.test(candidate)) continue // rule 4: never let "1 Item" be a team
      const hit = matcher ? matcher.matchTeam(candidate) : null
      if (hit?.team) {
        team = hit.team
        teamRaw = candidate
        matched = true
        break
      }
      if (!team) {
        team = candidate
        teamRaw = candidate
      }
    }

    // price — first `$` at or after the order id; only fall back to the text
    // before it when no earlier order shares this line (never steal a
    // neighbour's subtotal).
    let priceMatch = windowText.match(RE_PRICE)
    if (!priceMatch && !sameLinePrev) priceMatch = fullWindow.match(RE_PRICE)
    const price = priceMatch ? toPrice(priceMatch[1]) : 0
    if (!priceMatch) {
      warnings.push({
        page: lines[pos.lineIndex].page,
        message: `No subtotal found for order ${pos.id} (@${handle}) — treated as a $0 giveaway.`,
        rawText: lineText.slice(0, 200)
      })
    }

    slip.orders.push({
      orderId: pos.id,
      breakNumber,
      team,
      teamRaw,
      matched,
      price,
      hasPrice: Boolean(priceMatch),
      // Rule 1: a giveaway is a $0 SUBTOTAL. Never the `GIVEAWAY` substring —
      // it appears inside all-caps break titles and would zero out every paid
      // card in a giveaway-themed break.
      isGiveaway: price === 0,
      page: lines[pos.lineIndex].page
    })
  }

  return slip
}

// ---------------------------------------------------------------------------
// §2.4 — reconcile a corrupted break NUMBER against the packing slip
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  breaks: BreakingBreak[]
  changed: boolean
  notes: ShipWarningInput[]
}

/**
 * Some compressed exports corrupt the DIGITS in the breaking slip's font while
 * the packing slip stays clean. The breaking slip is still ground truth for
 * which teams go together — only its number is wrong. Vote on ORDER IDS ONLY:
 * a team can legitimately be owned in two breaks, so team-name voting would
 * silently FUSE two distinct breaks. An order id belongs to exactly one break.
 *
 * Only a strict-majority, unambiguous winner overrides, so a clean PDF is
 * always a no-op.
 */
export function reconcileBreakNumbers(
  breaks: BreakingBreak[],
  packingOrders: PackingOrder[],
  handle = ''
): ReconcileResult {
  const notes: ShipWarningInput[] = []
  const packOrderBreak = new Map<string, number>()
  for (const o of packingOrders) {
    if (o.breakNumber != null) packOrderBreak.set(o.orderId, o.breakNumber)
  }
  if (!packOrderBreak.size) return { breaks, changed: false, notes }

  let changed = false
  for (const b of breaks) {
    const votes = new Map<number, number>()
    for (const oid of b.orderIds) {
      const bn = packOrderBreak.get(oid)
      if (bn == null) continue
      votes.set(bn, (votes.get(bn) ?? 0) + 1)
    }
    if (!votes.size) continue // no evidence -> trust the breaking slip
    const ranked = [...votes.entries()].sort((a, c) => c[1] - a[1] || a[0] - c[0])
    const [topBn, topVotes] = ranked[0]
    const secondVotes = ranked[1]?.[1] ?? 0
    if (topBn !== b.breakNumber && topVotes > secondVotes && topVotes * 2 > b.orderIds.size) {
      notes.push({
        page: null,
        message: `Break #${b.breakNumber}${handle ? ` on @${handle}'s breaking slip` : ''} was re-read as Break #${topBn} from the packing slip order ids (${topVotes}/${b.orderIds.size} agree).`,
        rawText: null
      })
      b.breakNumber = topBn
      changed = true
    }
  }

  if (!changed) return { breaks, changed, notes }

  // Merge the breaks that now share a number.
  const merged = new Map<number, BreakingBreak>()
  const out: BreakingBreak[] = []
  for (const b of breaks) {
    const existing = merged.get(b.breakNumber)
    if (!existing) {
      merged.set(b.breakNumber, b)
      out.push(b)
      continue
    }
    for (const oid of b.orderIds) existing.orderIds.add(oid)
    existing.teams.push(...b.teams)
  }
  return { breaks: out, changed, notes }
}

// ---------------------------------------------------------------------------
// §2.5 — emit breaks, team slots, mirror orders + the giveaway sweep
// ---------------------------------------------------------------------------

interface CustomerEmit {
  slots: ShipTeamSlotDraft[]
  orders: ShipOrder[]
  warnings: ShipWarningInput[]
}

function packCanonical(pack: PackingOrder, matcher: TeamMatcher): string {
  if (!pack.team) return ''
  return matcher.canonical(pack.team) ?? normalizeTeamKey(pack.team)
}

function emitCustomerRecords(
  handle: string,
  breaking: BreakingSlip | null,
  packing: PackingSlip | null,
  matcher: TeamMatcher
): CustomerEmit {
  const slots: ShipTeamSlotDraft[] = []
  const orders: ShipOrder[] = []
  const warnings: ShipWarningInput[] = []
  const mirror = new Map<string, ShipOrder>()
  const packOrders = packing?.orders ?? []
  /** Packs already represented by a slot — the giveaway sweep reads this. */
  const consumedPacks = new Set<PackingOrder>()
  let counter = 0

  const pushSlot = (
    breakNumber: number | null,
    breakId: string,
    teamName: string,
    pack: PackingOrder | null,
    forceGiveaway = false
  ): ShipTeamSlotDraft => {
    const id = `slot_${breakNumber ?? 'na'}_${handle}_${counter++}`
    const price = forceGiveaway ? 0 : pack?.price ?? 0
    const isGiveaway = forceGiveaway || (pack?.isGiveaway ?? false)
    const slot: ShipTeamSlotDraft = {
      id,
      breakId,
      breakNumber,
      teamName,
      customerId: handle,
      orderId: pack?.orderId ?? null,
      price,
      isGiveaway
    }
    const order: ShipOrder = {
      id: `ord_${id}`,
      customerId: handle,
      breakId,
      breakNumber,
      teamName,
      price,
      isGiveaway
    }
    slots.push(slot)
    orders.push(order)
    mirror.set(id, order)
    return slot
  }

  // Choose the break spec: the breaking slip when we have one, otherwise fall
  // back to grouping the packing orders by break number.
  const fromBreaking = Boolean(breaking && breaking.breaks.length)
  const spec: { breakNumber: number; teams: BreakingTeam[] }[] = fromBreaking
    ? breaking!.breaks.map((b) => ({ breakNumber: b.breakNumber, teams: b.teams }))
    : [
        ...new Set(
          packOrders.filter((o) => o.breakNumber != null).map((o) => o.breakNumber as number)
        )
      ]
        .sort((a, b) => a - b)
        .map((breakNumber) => ({ breakNumber, teams: [] as BreakingTeam[] }))

  for (const entry of spec) {
    const breakNumber = entry.breakNumber
    const breakId = `break_${breakNumber}`
    const packsForBreak = packOrders.filter((o) => o.breakNumber === breakNumber)
    const usedInBreak = new Set<PackingOrder>()
    const teamsSeen = new Set<string>()

    if (!fromBreaking) {
      // Packing-only fallback: every packing line in this break is a card.
      for (const pack of packsForBreak) {
        usedInBreak.add(pack)
        consumedPacks.add(pack)
        const hit = pack.team ? matcher.matchTeam(pack.team) : null
        const teamName = hit?.team || cleanTeamText(pack.team) || 'Unknown team'
        if (!hit?.team && pack.team) {
          warnings.push({
            page: pack.page,
            message: `Could not match “${pack.team}” (@${handle}, break #${breakNumber}) to a ${matcher.sport.toUpperCase()} team — kept as printed.`,
            rawText: pack.team
          })
        }
        if (teamsSeen.has(teamName)) {
          warnings.push({
            page: pack.page,
            message: `@${handle} has ${teamName} twice in break #${breakNumber} — both cards kept, please verify.`,
            rawText: null
          })
        }
        teamsSeen.add(teamName)
        pushSlot(breakNumber, breakId, teamName, pack)
      }
      continue
    }

    // Pair each breaking-slip team with a packing order: FIRST by canonical
    // team across the whole break, THEN hand the leftovers to whichever teams
    // are still unpaired, in order. Resolving the canonical matches globally
    // (rather than greedily, team by team) stops an unmatched team from
    // swallowing the pack that belongs by name to a later team.
    const resolved = entry.teams.map((team) => {
      const hit = matcher.matchTeam(team.raw)
      return {
        team,
        hit,
        teamName: hit.team || cleanTeamText(team.raw) || 'Unknown team',
        wanted: hit.team ?? normalizeTeamKey(team.raw),
        pack: null as PackingOrder | null
      }
    })
    for (const item of resolved) {
      if (!item.wanted) continue
      const pack = packsForBreak.find(
        (p) => !usedInBreak.has(p) && packCanonical(p, matcher) === item.wanted
      )
      if (pack) {
        item.pack = pack
        usedInBreak.add(pack)
        consumedPacks.add(pack)
      }
    }
    for (const item of resolved) {
      if (item.pack) continue
      const pack = packsForBreak.find((p) => !usedInBreak.has(p))
      if (!pack) continue
      item.pack = pack
      usedInBreak.add(pack)
      consumedPacks.add(pack)
    }

    for (const item of resolved) {
      if (!item.hit.team) {
        warnings.push({
          page: item.team.page,
          message: `Could not match “${item.team.raw}” (@${handle}, break #${breakNumber}) to a ${matcher.sport.toUpperCase()} team — kept as printed.`,
          rawText: item.team.raw
        })
      }
      if (!item.pack) {
        warnings.push({
          page: item.team.page,
          message: `${item.teamName} in break #${breakNumber} (@${handle}) has no matching line on the packing slip — the card is still pickable at $0.`,
          rawText: null
        })
      }
      if (teamsSeen.has(item.teamName)) {
        warnings.push({
          page: item.team.page,
          message: `@${handle} has ${item.teamName} twice in break #${breakNumber} — both cards kept, please verify.`,
          rawText: null
        })
      }
      teamsSeen.add(item.teamName)
      pushSlot(breakNumber, breakId, item.teamName, item.pack)
    }
  }

  // --- the sweep: nothing on the packing slip is allowed to vanish ---------
  for (const pack of packOrders) {
    if (consumedPacks.has(pack)) continue
    const canonical = pack.team ? matcher.canonical(pack.team) : null

    if (pack.isGiveaway) {
      // Rule 8 dedup: a giveaway whose team is ALREADY a slot for this customer
      // (listed on the breaking slip, but its packing line was break-less) marks
      // THAT slot as the giveaway instead of emitting a duplicate — so every
      // giveaway is exactly one checkable card, never zero, never two.
      if (canonical) {
        const existing = slots.find((s) => s.teamName === canonical && !s.isGiveaway)
        if (existing) {
          existing.isGiveaway = true
          existing.price = 0
          const mirrored = mirror.get(existing.id)
          if (mirrored) {
            mirrored.isGiveaway = true
            mirrored.price = 0
          }
          consumedPacks.add(pack)
          continue
        }
      }
      // Rule 9: a break-less giveaway keeps breakNumber null and lives under
      // `giveaway_<handle>` — NEVER fabricate a phantom Break record for it.
      const breakId = pack.breakNumber != null ? `break_${pack.breakNumber}` : `giveaway_${handle}`
      const teamName = canonical || cleanTeamText(pack.team) || 'Giveaway'
      pushSlot(pack.breakNumber, breakId, teamName, pack, true)
      consumedPacks.add(pack)
      continue
    }

    // A PAID packing line the breaking slip never listed. Emit it too (a card
    // that exists must be pickable) and flag it for the operator.
    const breakId = pack.breakNumber != null ? `break_${pack.breakNumber}` : `nobreak_${handle}`
    const teamName = canonical || cleanTeamText(pack.team) || 'Unknown team'
    warnings.push({
      page: pack.page,
      message: `Order ${pack.orderId} (@${handle}, ${teamName}) is on the packing slip but not on the breaking slip — added as a loose card.`,
      rawText: null
    })
    pushSlot(pack.breakNumber, breakId, teamName, pack)
    consumedPacks.add(pack)
  }

  return { slots, orders, warnings }
}

// ---------------------------------------------------------------------------
// §2.6 — materialize breaks + the fidelity audit
// ---------------------------------------------------------------------------

function buildBreakAudit(
  teamSlots: ShipTeamSlotDraft[],
  breakNumbers: number[],
  matcher: TeamMatcher
): ShipBreakAudit[] {
  const slate = new Set(matcher.teams)
  const audits: ShipBreakAudit[] = []
  for (const breakNumber of breakNumbers) {
    const slots = teamSlots.filter((s) => s.breakNumber === breakNumber)
    const byTeam = new Map<string, Set<string>>()
    for (const slot of slots) {
      let handles = byTeam.get(slot.teamName)
      if (!handles) {
        handles = new Set<string>()
        byTeam.set(slot.teamName, handles)
      }
      handles.add(slot.customerId)
    }
    const captured = new Set<string>()
    for (const teamName of byTeam.keys()) if (slate.has(teamName)) captured.add(teamName)
    const missingTeams = matcher.teams.filter((t) => !captured.has(t))
    const collisions: ShipBreakCollision[] = []
    for (const [teamName, handles] of byTeam) {
      // One team claimed by two customers in the same break is a real data
      // error (usually a page too corrupted to read). Surface it rather than
      // silently guessing which customer owns the card.
      if (handles.size > 1) collisions.push({ teamName, handles: [...handles].sort() })
    }
    collisions.sort((a, b) => a.teamName.localeCompare(b.teamName))
    audits.push({
      breakNumber,
      teamCount: slots.length,
      distinctTeamCount: byTeam.size,
      maxTeams: matcher.maxTeams,
      missingCount: missingTeams.length,
      missingTeams,
      hasAll: missingTeams.length === 0,
      collisions
    })
  }
  return audits
}

// ---------------------------------------------------------------------------
// League auto-detection harvest
// ---------------------------------------------------------------------------

/**
 * Collect every team-ish string in the upload WITHOUT a bound league, so
 * `detectSport` can be run exactly once. Uses a null matcher for the packing
 * pass, which makes every candidate fall through to its raw text.
 */
export function collectTeamCandidates(groups: CustomerGroup[]): string[] {
  const out: string[] = []
  const nullMatcher = createNullTeamMatcher()
  for (const group of groups) {
    for (const page of group.breakingPages) {
      for (const raw of page.text.split('\n')) {
        const checkbox = raw.trim().match(RE_CHECKBOX)
        if (!checkbox) continue
        const team = cleanTeamText(checkbox[1])
        if (team && !RE_ITEMS_NOISE.test(team)) out.push(team)
      }
    }
    if (group.packingPages.length) {
      const packing = parsePackingSlip(group.handle, group.packingPages, nullMatcher)
      for (const order of packing.orders) if (order.team) out.push(order.team)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

function emptyDataset(sport: ShipSport | null, eventName: string, eventDate: string): ShippingDataset {
  return {
    event: { name: eventName, date: eventDate },
    sport,
    breaks: [],
    customers: [],
    teamSlots: [],
    shipments: [],
    orders: [],
    batchUrls: [],
    breakAudit: [],
    warnings: []
  }
}

/**
 * The name the Upload screen would otherwise make the operator type:
 * `[Sport] - [Pack] - [Date]`, e.g. "Football - 2025 Finest Football - 26/07".
 * Built from what the slips already say, so the field can fill itself in.
 * Any segment that cannot be determined is simply left out.
 */
function buildAutoEventName(
  sport: ShipSport | null,
  packTitle: string | null,
  eventDate: string
): string {
  const sportPart = sport ? SHIP_SPORT_LABELS[sport] : ''
  // Titles print in shouty caps; Title Case reads better in a form field.
  const packPart = packTitle
    ? packTitle
        .toLowerCase()
        .replace(/\b[a-z]/g, (c) => c.toUpperCase())
        .replace(/\s+/g, ' ')
        .trim()
    : ''
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : ''
  const datePart = iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : ''
  return [sportPart, packPart, datePart].filter(Boolean).join(' - ')
}

/**
 * pages -> normalized dataset. PURE.
 */
export function parsePages(pages: string[], options: ParsePagesOptions = {}): ShippingDataset {
  const eventName = (options.eventName ?? '').trim()
  const eventDate = (options.eventDate ?? '').trim()
  const onProgress = options.onProgress
  const totalPages = pages.length

  onProgress?.({ phase: 'parse', page: 0, totalPages, message: 'Grouping pages by customer…' })

  const { groups, warnings: groupWarnings } = groupByCustomer(pages)
  if (!groups.length) {
    onProgress?.({
      phase: 'done',
      page: totalPages,
      totalPages,
      message: 'No Whatnot slips found in this PDF.'
    })
    const dataset = emptyDataset(null, eventName, eventDate)
    dataset.warnings = [
      ...groupWarnings,
      {
        page: null,
        message:
          'No “Whatnot Packing Slip” or “Whatnot - Breaking Slip” pages were found. Is this the combined labels + packing slips export?',
        rawText: null
      }
    ]
    return dataset
  }

  // Product titles seen across the slips, used to name the import.
  const seenPackTitles: string[] = []

  // Bind the league ONCE for the whole upload.
  const requested: ShipSportOption = options.sport ?? 'auto'
  const sport: ShipSport = requested === 'auto' ? detectSport(collectTeamCandidates(groups)) : requested
  const matcher = createTeamMatcher(sport)

  const customers: ShipCustomer[] = []
  const shipments: ShipShipmentDraft[] = []
  const teamSlots: ShipTeamSlotDraft[] = []
  const orders: ShipOrder[] = []
  const warnings: ShipWarningInput[] = [...groupWarnings]

  let processedPages = 0
  groups.forEach((group, index) => {
    processedPages += group.packingPages.length + group.breakingPages.length
    onProgress?.({
      phase: 'parse',
      page: Math.min(processedPages, totalPages),
      totalPages,
      message: `Parsing @${group.handle} (${index + 1} of ${groups.length})…`
    })

    const packing = group.packingPages.length
      ? parsePackingSlip(group.handle, group.packingPages, matcher)
      : null
    const breaking = group.breakingPages.length
      ? parseBreakingSlip(group.breakingPages, matcher)
      : null

    if (packing) warnings.push(...packing.warnings)
    if (breaking) warnings.push(...breaking.warnings)
    if (packing?.packTitle) seenPackTitles.push(packing.packTitle)

    // §2.4 — fix a corrupted break NUMBER before anything is emitted.
    if (breaking && breaking.breaks.length && packing) {
      const reconciled = reconcileBreakNumbers(breaking.breaks, packing.orders, group.handle)
      breaking.breaks = reconciled.breaks
      warnings.push(...reconciled.notes)
    }

    const emitted = emitCustomerRecords(group.handle, breaking, packing, matcher)
    teamSlots.push(...emitted.slots)
    orders.push(...emitted.orders)
    warnings.push(...emitted.warnings)

    // A customer with a shipment but genuinely no cards is legitimate (an
    // empty / giveaway-only order) — they still get Customer + Shipment rows.
    customers.push({
      id: group.handle,
      whatnotHandle: group.handle,
      realName: packing?.realName || breaking?.realName || '',
      address: packing?.address ?? '',
      isNew: packing?.isNew ?? false
    })
    shipments.push({
      id: `ship_${group.handle}`,
      customerId: group.handle,
      trackingNumber: packing?.trackingNumber ?? null,
      carrier: packing?.carrier ?? null,
      serviceType: packing?.serviceType ?? null,
      weightOz: packing?.weightOz ?? null,
      uspsUrl: packing?.trackingNumber ? trackingUrl(packing.trackingNumber) : null
    })
  })

  // §2.6 — one break record per DISTINCT break number that appeared. A
  // break-less giveaway's `giveaway_<handle>` id intentionally has no record.
  const breakNumbers = [
    ...new Set(teamSlots.filter((s) => s.breakNumber != null).map((s) => s.breakNumber as number))
  ].sort((a, b) => a - b)
  const breaks: ShipBreakDraft[] = breakNumbers.map((breakNumber) => ({
    id: `break_${breakNumber}`,
    breakNumber,
    eventName,
    eventDate,
    status: 'pending'
  }))

  const breakAudit = buildBreakAudit(teamSlots, breakNumbers, matcher)
  const batchUrls = buildBatchUrls(
    shipments.map((s) => s.trackingNumber ?? '').filter((t): t is string => Boolean(t))
  )

  for (const audit of breakAudit) {
    for (const collision of audit.collisions) {
      warnings.push({
        page: null,
        message: `Break #${audit.breakNumber}: ${collision.teamName} is assigned to ${collision.handles.length} customers (${collision.handles.map((h) => `@${h}`).join(', ')}).`,
        rawText: null
      })
    }
  }

  onProgress?.({
    phase: 'done',
    page: totalPages,
    totalPages,
    message: `Parsed ${customers.length} customers, ${breaks.length} breaks, ${teamSlots.length} cards.`
  })

  // The operator can always type their own name; when they leave it blank we
  // name the import after what the slips say was actually broken.
  const packTitle = bestPackTitle(seenPackTitles)
  const resolvedEventName = eventName || buildAutoEventName(sport, packTitle, eventDate)

  return {
    event: { name: resolvedEventName, date: eventDate },
    sport,
    breaks,
    customers,
    teamSlots,
    shipments,
    orders,
    batchUrls,
    breakAudit,
    warnings
  }
}
