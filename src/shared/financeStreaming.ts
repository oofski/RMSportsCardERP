/**
 * Finance → Streaming: the Whatnot ledger, attributed to shows.
 *
 * WHAT THIS IS FOR
 *
 * Whatnot's weekly ledger export is a flat list of money movements stamped with
 * instants. This module turns it into a day-by-day revenue picture by matching
 * each row to the stream session whose window contains it, and then booking it
 * to that session's business day.
 *
 * THE GOVERNING RULE
 *
 * "If the stream started on 7/24 and went till 7/25, count the revenue always to
 * the earlier date."
 *
 * This is not a rounding preference — it is the difference between a correct P&L
 * and a wrong one. Measured on real RM data: of the money earned on the 7/24
 * night show, 80.3% is stamped after midnight on 7/25. Across a five-week
 * export, 24.5% of all money lands between 00:00 and 02:59. Bucketing by the
 * row's own calendar date would move roughly a quarter of the business onto the
 * wrong day, every week, and nothing on screen would look wrong.
 *
 * So: a row's business day is ALWAYS its session's `streamDate`, never anything
 * recomputed from the row's own timestamp.
 *
 * WHAT IS DELIBERATELY NOT DONE
 *
 * There is no nearest-session matching, no snap-to-window, no "before 4am means
 * yesterday" heuristic. A row is inside a session window or it is not. Any
 * tolerance would reintroduce exactly the ambiguity that forbidding overlapping
 * sessions exists to eliminate, and it would invent evidence: a genuine
 * off-stream sale would be silently credited to a show that did not make it.
 * Unattributed rows are kept, counted and shown instead.
 */

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What a ledger row is. Derived from the complete set of message shapes present
 * in real exports — these ten cover 100% of 9,225 real rows, and
 * `unclassified` exists for the shape Whatnot adds next.
 */
export type LedgerBucket =
  | 'sale'
  | 'tip'
  | 'seller_bonus'
  | 'shipping_subsidy'
  | 'giveaway_shipping'
  | 'shipping_charge'
  | 'show_boost'
  | 'refund_shipping'
  | 'sale_reversal'
  | 'payout'
  | 'unclassified'

/**
 * How a bucket lands in the P&L.
 * - revenue  : adds to the top line
 * - contra   : reduces revenue (a genuine sales reversal)
 * - expense  : a cost of running the show
 * - ignored  : not P&L at all
 */
export type LedgerTreatment = 'revenue' | 'contra' | 'expense' | 'ignored'

export interface LedgerBucketDef {
  key: LedgerBucket
  label: string
  treatment: LedgerTreatment
  hint: string
}

export const LEDGER_BUCKETS: readonly LedgerBucketDef[] = [
  {
    key: 'sale',
    label: 'Sales',
    treatment: 'revenue',
    hint: 'Seller earnings on a sold item or break spot.'
  },
  {
    key: 'shipping_subsidy',
    label: 'Shipping subsidy',
    treatment: 'revenue',
    hint: "Whatnot's contribution toward postage."
  },
  { key: 'tip', label: 'Tips', treatment: 'revenue', hint: 'Viewer tips during a show.' },
  {
    key: 'seller_bonus',
    label: 'Seller bonus',
    treatment: 'revenue',
    hint: 'Platform bonus payments.'
  },
  {
    key: 'sale_reversal',
    label: 'Sales reversals',
    treatment: 'contra',
    hint: 'A refunded order — the only true reversal of revenue.'
  },
  {
    key: 'giveaway_shipping',
    label: 'Giveaway postage',
    treatment: 'expense',
    hint: 'What it cost to mail a giveaway won on stream. NOT a refund.'
  },
  {
    key: 'shipping_charge',
    label: 'Shipping charges',
    treatment: 'expense',
    hint: 'Postage Whatnot charged back to the seller.'
  },
  {
    key: 'refund_shipping',
    label: 'Refund postage',
    treatment: 'expense',
    hint: 'Postage cost on a refunded order.'
  },
  {
    key: 'show_boost',
    label: 'Show Boost',
    treatment: 'expense',
    hint: 'Paid promotion of a show.'
  },
  {
    key: 'payout',
    label: 'Payouts',
    treatment: 'ignored',
    hint: 'Transfer to the bank. Money moving, not money earned — excluded from the P&L.'
  },
  {
    key: 'unclassified',
    label: 'Unrecognised',
    treatment: 'revenue',
    hint: 'A message shape this version does not know. Counted at face value and flagged, never dropped.'
  }
] as const

const BUCKET_BY_KEY = new Map(LEDGER_BUCKETS.map((b) => [b.key, b]))

export function bucketDef(bucket: LedgerBucket): LedgerBucketDef {
  return BUCKET_BY_KEY.get(bucket) ?? LEDGER_BUCKETS[LEDGER_BUCKETS.length - 1]
}

export function bucketTreatment(bucket: LedgerBucket): LedgerTreatment {
  return bucketDef(bucket).treatment
}

/**
 * Bumped whenever the rules below change. Stored on each row so a later version
 * can find rows classified by an older ruleset and re-run them, rather than
 * leaving a database with two generations of answers silently mixed together.
 */
export const LEDGER_CLASSIFIER_VERSION = 1

/**
 * Classify one row. Precedence is top to bottom — first match wins.
 *
 * Every rule matches on a PREFIX of the message rather than the whole string,
 * because Whatnot appends order ids, show titles and punctuation that vary per
 * row. Matching the stable leading phrase is what makes this survive contact
 * with real data.
 */
export function classifyLedgerRow(txnType: string, message: string): LedgerBucket {
  const type = (txnType || '').trim().toUpperCase()
  const msg = (message || '').trim()

  if (type === 'PAYOUT') return 'payout'
  if (type === 'TIP') return 'tip'

  if (type === 'SALES') {
    if (msg.startsWith('Earnings for selling')) return 'sale'
    // Negative SALES rows are NOT refunds. Every one is the postage Whatnot
    // charged for mailing a giveaway won on stream — a cost of running the
    // show. Booking them as refunds would understate both revenue and shipping
    // expense by the same amount and hide the cost entirely.
    if (msg.startsWith('Charged deduction of') && msg.includes('for giveaway order')) {
      return 'giveaway_shipping'
    }
    return 'unclassified'
  }

  if (type === 'ADJUSTMENT') {
    if (msg === 'Shipping Subsidy') return 'shipping_subsidy'
    if (msg.startsWith('Whatnot platform charge for shipping adjustment')) return 'shipping_charge'
    if (msg.startsWith('Seller purchased Show Boost for')) return 'show_boost'
    if (msg.startsWith('Reversal of sales transaction for order refund')) return 'sale_reversal'
    if (msg.startsWith('Deduction for order refund shipping costs')) return 'refund_shipping'
    if (msg === 'Super Seller Bonus') return 'seller_bonus'
    return 'unclassified'
  }

  return 'unclassified'
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
}

/** "Jul 17, 2026, 3:07:44 AM" — non-zero-padded day and hour, uppercase AM/PM. */
const LEDGER_DATE_RE = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/

/**
 * Parse a Whatnot timestamp into an ISO instant.
 *
 * Deliberately NOT `new Date(string)`. Date.parse on this format is
 * implementation-defined — V8 happens to accept it, the result depends on host
 * locale, and a silent misparse here would move money between days without any
 * error surfacing. An explicit regex fails loudly instead.
 *
 * The string carries no offset, so it is interpreted in the MACHINE'S local
 * zone, which is correct for a desktop app used in one place: the operator's
 * clock and Whatnot's display agree.
 *
 * Returns null when the shape is unrecognised — the caller must quarantine that
 * row rather than guess at it.
 */
export function parseLedgerDate(value: string): string | null {
  const m = LEDGER_DATE_RE.exec((value || '').trim())
  if (!m) return null
  const month = MONTHS[m[1]]
  if (month === undefined) return null
  const day = Number(m[2])
  const year = Number(m[3])
  let hour = Number(m[4]) % 12
  if (m[7] === 'PM') hour += 12
  const d = new Date(year, month, day, hour, Number(m[5]), Number(m[6]), 0)
  if (Number.isNaN(d.getTime())) return null
  // Reject a date the calendar rolled over (e.g. "Feb 31") rather than
  // accepting JS's silent normalisation to March 3.
  if (d.getDate() !== day || d.getMonth() !== month || d.getFullYear() !== year) return null
  return d.toISOString()
}

/**
 * Parse a money cell.
 *
 * Whatnot has shipped TWO formats. The original wrote negatives with a minus
 * ("-$4.15"); the current export uses accounting parentheses ("($4.15)") and
 * pads values with a trailing space. Both must work, because an operator's
 * archive contains files of both vintages.
 *
 * The parenthesis case is the dangerous one: strip the punctuation without
 * checking for it and "($4.15)" reads as +4.15, turning an expense into
 * revenue. That is silent and plausible, so it is handled explicitly and
 * anything unrecognised returns null to be quarantined rather than guessed.
 */
export function parseLedgerAmount(value: string): number | null {
  const raw = (value || '').trim()
  if (!raw) return null
  const neg = raw.startsWith('-') || (raw.startsWith('(') && raw.endsWith(')'))
  const digits = raw.replace(/[^0-9.]/g, '')
  // Guard the empty string: Number('') is 0, which would turn an unparseable
  // cell into a confident zero.
  if (!digits || !/[0-9]/.test(digits)) return null
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

/**
 * A ledger timestamp reduced to its wall-clock components: YYYYMMDDHHMMSS.
 *
 * Identity must not depend on how Whatnot happens to FORMAT a date. They have
 * already changed the amount format once ("-$4.15" became "($4.15)"), and the
 * same class of change to the timestamp — zero-padding an hour, a different
 * month abbreviation — would make every stored row look new and silently
 * double the archive on the next upload.
 *
 * Built from local wall-clock parts rather than the instant, so a machine that
 * changes timezone does not re-identify every row it already has.
 */
export function canonicalLedgerTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    p(d.getFullYear(), 4) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

/**
 * The canonical identity of a ledger row, for de-duplicating re-uploads.
 *
 * SIX fields, and every one is load-bearing. Anything smaller collides on real
 * data: `Order ID` repeats across a sale and its shipping subsidy, and there are
 * scores of identical platform charges plus whole batches of $0.00 subsidies
 * that differ only by their timestamp. A key of (order, type, amount) silently
 * discards 156-274 genuine rows per export — money that vanishes with no error.
 *
 * `Status` and `Completed Date` are deliberately EXCLUDED: a row can move from
 * pending to completed between two exports, and including them would make the
 * same row look new and double-count it.
 *
 * Both the timestamp and the amount are normalised — to wall-clock digits and
 * to integer cents — so identity survives a change in how Whatnot formats
 * either. That is what let the parenthesised-negative format change land
 * without doubling anybody's ledger.
 */
export function ledgerFingerprintSource(
  occurredAtIso: string,
  amount: number,
  listingId: string,
  orderId: string,
  message: string,
  txnType: string
): string {
  const c = Math.round(amount * 100)
  // Joined on the ASCII unit separator, which cannot occur in any of these
  // fields. An empty join would leave the boundaries ambiguous — ("ab","cdef")
  // and ("abc","def") would hash identically — and the failure mode is a real
  // row silently swallowed as a duplicate: money gone, no error anywhere.
  return [
    canonicalLedgerTimestamp(occurredAtIso),
    String(c),
    (listingId || '').trim(),
    (orderId || '').trim(),
    (message || '').trim(),
    (txnType || '').trim().toUpperCase()
  ].join('\u001F')
}

/**
 * The break number on a sale, if it has one.
 *
 * Two layouts, both live in real exports:
 *   older  "...HOBBY BOX (NEW RELEASE!)- Break #18 - Arizona Diamondbacks"
 *   newer  "Earnings for selling a Break 19: 4x TOPPS CHROME... - Phillies"
 * The number moved to the front and lost its hash, so one pattern cannot cover
 * both and a single-pattern parser silently returns null on half the file.
 */
export function parseBreakNumber(message: string): number | null {
  const m = message || ''
  const trailing = /-\s*Break\s*#\s*(\d+)/i.exec(m)
  if (trailing) return Number(trailing[1])
  const leading = /\bBreak\s+(\d+)\s*:/i.exec(m)
  if (leading) return Number(leading[1])
  return null
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Is this instant inside this session?
 *
 * HALF-OPEN [start, end) — matching `sessionsOverlap` in @shared/streaming,
 * which permits one show to end exactly as the next begins. If attribution used
 * closed bounds, a row stamped on that exact boundary would match BOTH sessions
 * and be counted twice, while the overlap validation reported no conflict.
 * Half-open makes the two agree by construction, so a row matches at most one
 * session — always.
 *
 * A live session (no end) runs to infinity, exactly as `sessionsOverlap` treats
 * it. Correct — nothing else can be on air — but it is also why a forgotten
 * "End stream" must be surfaced loudly: it would otherwise swallow every later
 * row in the file.
 */
export function rowInSession(instantMs: number, startedAt: string, endedAt: string | null): boolean {
  const s = new Date(startedAt).getTime()
  if (Number.isNaN(s)) return false
  const e = endedAt ? new Date(endedAt).getTime() : Number.POSITIVE_INFINITY
  return instantMs >= s && instantMs < e
}

/**
 * A single session absorbing this share of an import is almost certainly a
 * forgotten "End stream" rather than a real show.
 */
export const SESSION_VACUUM_SHARE = 0.4

/**
 * How a row found its day.
 * - in_window    : its instant fell inside a session. The strong case.
 * - carried_back : it settled after the show that caused it (see below).
 * - unattributed : nothing owns it, and the app says so rather than guessing.
 */
export type LedgerAttribution = 'in_window' | 'carried_back' | 'unattributed'

/**
 * CARRY-BACK: settlement rows belong to the show that caused them.
 *
 * Whatnot does not post a show's shipping economics while the show is running.
 * Subsidies batch hours later, platform shipping charges post the next morning,
 * giveaway postage lands whenever the label is bought. A show that runs 11pm to
 * 3am produces adjustment rows all the way through the following afternoon —
 * and if the next show starts at 9pm, every one of those rows sits in the gap
 * between two sessions, owned by neither.
 *
 * Leaving them unattributed would be technically defensible and practically
 * useless: the operator would see a permanent pile of shipping costs that can
 * never be assigned to anything, no matter how carefully they log their shows.
 * These rows are not missing a session — they are the *aftermath* of one.
 *
 * So a row in a gap attaches to the session that most recently ENDED before it.
 *
 * WHY THIS IS NOT APPLIED TO SALES — the important half of the rule.
 *
 * A sale is not a settlement, it is an event with its own time. RM runs two
 * shows most days, and an unlogged afternoon show produces a solid block of
 * genuine sales sitting in exactly the same gap. Carrying those back would
 * silently merge a whole missing show into the previous night's numbers, and
 * the operator would never learn the session was missing — the money would just
 * be quietly on the wrong day. That is the one failure this design exists to
 * prevent, so sales stay unattributed and visible until a session is added.
 *
 * Show Boost is excluded for the opposite reason: it is bought FOR an upcoming
 * show, so attaching it to the previous one books it backwards in time.
 */
const CARRY_BACK_BUCKETS = new Set<LedgerBucket>([
  'shipping_subsidy',
  'shipping_charge',
  'giveaway_shipping',
  'refund_shipping',
  'sale_reversal',
  'seller_bonus',
  'tip'
])

export function carryBackEligible(bucket: LedgerBucket): boolean {
  return CARRY_BACK_BUCKETS.has(bucket)
}

/**
 * A settlement row will not reach back further than this to find its show.
 *
 * The natural boundary is the next session starting, and that alone handles the
 * normal case. This bound covers the abnormal one: after a week off, the first
 * subsidy batch of the new week must not attach itself to a show from six days
 * ago. Generous enough for the real pattern (a 3am finish still settling at 8pm
 * is 17 hours) without spanning a gap that means something.
 */
export const CARRY_BACK_MAX_HOURS = 36

/**
 * Find the session a gap row settles against: the latest one that ended at or
 * before the row, within the bound. `sessions` must be sorted by startedAt.
 *
 * A live session (no end) is skipped — it has not finished, so nothing can be
 * settling after it, and anything inside it was already matched in-window.
 */
export function findCarryBackSession<T extends { startedAt: string; endedAt: string | null }>(
  instantMs: number,
  sessions: readonly T[]
): T | null {
  let best: T | null = null
  let bestEnd = -Infinity
  for (const s of sessions) {
    if (!s.endedAt) continue
    const end = new Date(s.endedAt).getTime()
    if (Number.isNaN(end) || end > instantMs) continue
    if (end > bestEnd) {
      bestEnd = end
      best = s
    }
  }
  if (!best) return null
  if (instantMs - bestEnd > CARRY_BACK_MAX_HOURS * 3600_000) return null
  return best
}

// ---------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string
  importId: string
  /** ISO instant from Created Date. Attribution ALWAYS uses this, never
   *  Completed Date — settlement can precede creation by a second and lag it by
   *  days. */
  occurredAt: string
  amount: number
  orderId: string | null
  listingId: string | null
  message: string
  txnType: string
  bucket: LedgerBucket
  /** The show this belongs to; null when it fell outside every session. */
  sessionId: string | null
  /** Business day — the session's streamDate. null while unattributed. */
  streamDate: string | null
  /** How it got that day. 'carried_back' means it settled after the show. */
  attribution: LedgerAttribution
  breakNumber: number | null
  /** Stable identity for de-duplicating re-uploads of overlapping weeks. */
  fingerprint: string
  /** The source row needed repairing (Whatnot's unescaped-quote export bug). */
  repaired: boolean
  classifierVersion: number
}

export interface LedgerImport {
  id: string
  filename: string
  rowsParsed: number
  rowsImported: number
  rowsDuplicate: number
  rowsRepaired: number
  rowsQuarantined: number
  attributedRows: number
  unattributedRows: number
  unattributedAmount: number
  firstOccurredAt: string | null
  lastOccurredAt: string | null
  /** Things the operator needs to see: a vacuuming session, quarantined rows,
   *  unrecognised message shapes. */
  warnings: string[]
  createdAt: string
  createdBy: string | null
}

/** A row that could not be parsed at all. Kept verbatim — never dropped, because
 *  a silently missing row is money that vanished with no trace. */
export interface LedgerQuarantine {
  id: string
  importId: string
  lineNumber: number
  rawLine: string
  reason: string
}

// ---------------------------------------------------------------------------
// The day-by-day view
// ---------------------------------------------------------------------------

/**
 * WHAT WHATNOT ACTUALLY KEEPS
 *
 * The ledger's "Earnings for selling" figure is GROSS — the buyer's price,
 * before Whatnot takes anything. Two charges come off it:
 *
 *   commission  6%   of the sale
 *   processing  2.9% of the sale, plus 30c on every single transaction
 *
 * Both are computed on the GROSS amount, not one after the other. The flat 30c
 * is what makes this worth modelling properly rather than applying a blended
 * 8.9%: a show that sells 1,900 break spots at small ticket prices pays that
 * 30c 1,900 times, and on a $20 spot the flat fee is another 1.5% on top. A
 * percentage-only model quietly understates fees on exactly the shows that sell
 * the most spots.
 *
 * Fees apply to SALES ONLY. Shipping subsidies, tips and bonuses arrive whole.
 */
export const WHATNOT_COMMISSION_RATE = 0.06
export const PROCESSING_RATE = 0.029
export const PROCESSING_PER_TRANSACTION = 0.3

export interface FeeBreakdown {
  /** Gross sales the fees were computed on. */
  grossSales: number
  /** Number of chargeable transactions — one per sale row. */
  saleCount: number
  /** Negative. */
  whatnotFee: number
  /** Negative. Percentage plus the per-transaction flat fee. */
  processingFee: number
  /** Negative. whatnotFee + processingFee. */
  totalFees: number
}

const cents = (n: number): number => Math.round(n * 100) / 100

/** Fees are returned NEGATIVE so every downstream total is a plain sum and no
 *  screen has to remember which way to apply them. */
export function computeFees(grossSales: number, saleCount: number): FeeBreakdown {
  const whatnotFee = -cents(grossSales * WHATNOT_COMMISSION_RATE)
  const processingFee = -cents(
    grossSales * PROCESSING_RATE + saleCount * PROCESSING_PER_TRANSACTION
  )
  return {
    grossSales: cents(grossSales),
    saleCount,
    whatnotFee,
    processingFee,
    totalFees: cents(whatnotFee + processingFee)
  }
}

export interface StreamDayFinance {
  /** Business day (a session's streamDate). */
  streamDate: string
  sessionCount: number
  sessionTitles: string[]
  /** Total minutes streamed that day. */
  minutes: number

  // --- Revenue ------------------------------------------------------------
  /** Gross sales, before Whatnot's cut. */
  sales: number
  /** Sale rows — the per-transaction fee is charged this many times. */
  saleCount: number
  tips: number
  bonuses: number
  /** sales + tips + bonuses. What came in before fees. */
  totalRevenue: number

  // --- Fees (all negative) ------------------------------------------------
  whatnotFee: number
  processingFee: number
  totalFees: number
  /** totalRevenue + totalFees. What Whatnot actually keeps for you. */
  netRevenue: number

  // --- Shipping, tracked on its own -------------------------------------
  /** Whatnot's contribution toward postage. Positive. */
  shippingSubsidy: number
  /** Postage charged back by Whatnot. Negative. */
  shippingCharges: number
  /** Postage for mailing giveaways won on stream. Negative. */
  giveawayShipping: number
  /** Postage on a refunded order. Negative. */
  refundShipping: number
  /** Subsidy less all postage. Can land either side of zero. */
  netShipping: number

  // --- Other show costs ---------------------------------------------------
  /** Paid promotion. Negative. */
  showBoost: number
  /** Refunded orders. Negative. */
  reversals: number

  /** netRevenue + netShipping + showBoost + reversals. The day's bottom line
   *  before cost of goods. */
  netAfterCosts: number

  rowCount: number
  /** How many of those rows settled after the show rather than during it. Shown
   *  so a day's total is explainable: without it, a show's shipping costs look
   *  like they appeared from nowhere hours after it ended. */
  carriedBackRows: number
  carriedBackAmount: number

  /** From the Streaming module: cost of stock consumed that day. Informational
   *  here — the full COGS treatment belongs to the complete P&L tab. */
  breakCost: number
  giveawayCost: number
}

/** How the day rows are rolled up. Days always exist underneath; a period is
 *  only ever a sum of them, so a week and a month can never disagree. */
export type FinancePeriod = 'day' | 'week' | 'month'

export interface FinancePeriodRow extends Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'> {
  /** Period key: '2026-07-24' | '2026-W30' | '2026-07'. */
  key: string
  /** Human label: 'Fri, Jul 24' | 'Week of Jul 20' | 'July 2026'. */
  label: string
  /** First and last business day actually present in this period. */
  from: string
  to: string
  dayCount: number
}

export interface StreamFinanceTotals extends Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'> {
  dayCount: number
}

/**
 * Activity that matched no session. Clustered so the operator can SEE the
 * missing show rather than being told a number: real RM data runs two shows most
 * days, so an evening-only session log misses every afternoon block.
 */
export interface UnattributedCluster {
  from: string
  to: string
  rowCount: number
  amount: number
  /** Local date the cluster starts on — the day a session is probably missing. */
  localDate: string
}

export interface UnattributedSummary {
  rowCount: number
  amount: number
  firstOccurredAt: string | null
  lastOccurredAt: string | null
  byBucket: Array<{ bucket: LedgerBucket; rowCount: number; amount: number }>
  clusters: UnattributedCluster[]
}

export interface StreamingFinanceView {
  days: StreamDayFinance[]
  /** The same days rolled into weeks and months. Derived from `days`, never
   *  recomputed from rows, so a period can never disagree with the days inside
   *  it. */
  weeks: FinancePeriodRow[]
  months: FinancePeriodRow[]
  totals: StreamFinanceTotals
  unattributed: UnattributedSummary
  imports: LedgerImport[]
  /**
   * Every non-ignored row is either on a day or in `unattributed`. False means
   * the numbers do not add up and must not be trusted — shown, not hidden.
   */
  reconciled: boolean
  reconcileNote: string | null
}

export interface LedgerImportResult {
  import: LedgerImport
  view: StreamingFinanceView
}

/** Gap that separates one burst of activity from the next when clustering. */
export const CLUSTER_GAP_MINUTES = 90

/** Signed total for a set of buckets, used by both main and the renderer so a
 *  day's arithmetic is defined in exactly one place. */
export function sumTreatment(
  amounts: Partial<Record<LedgerBucket, number>>,
  treatment: LedgerTreatment
): number {
  let total = 0
  for (const def of LEDGER_BUCKETS) {
    if (def.treatment !== treatment) continue
    total += amounts[def.key] ?? 0
  }
  return Math.round(total * 100) / 100
}
