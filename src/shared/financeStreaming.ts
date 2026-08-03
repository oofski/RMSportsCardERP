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
  | 'product_sale'
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
    label: 'Break spots',
    treatment: 'revenue',
    hint: 'A spot in a break — one team, one buyer.'
  },
  {
    key: 'product_sale',
    label: 'Whole products',
    treatment: 'revenue',
    hint: 'A sealed box or case sold outright, off a listing rather than a break.'
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
export const LEDGER_CLASSIFIER_VERSION = 2

/**
 * A break marker in a listing title.
 *
 * `=` is in there because it is in the real data: "TIER ONE BASEBALL HOBBY BOX
 * - NEW RELEASE!! BREAK #=7" appears 30 times in one export, and without the
 * `=` every one of those spots would be read as a whole-product sale — thirty
 * break spots misfiled as marketplace revenue, and a phantom product to match.
 */
const RE_LEDGER_BREAK = /break\s*#?\s*=?\s*\d/i

/**
 * A numbered lot at the END of a listing title — "... (Fresh From Box) #12".
 *
 * That is one of twelve packs out of a box somebody is selling a pack at a time,
 * not a sealed product. It carries no break number and no team, so nothing else
 * here would catch it, and on real data there are 24 of them in two months: two
 * boxes broken into individual packs. Booking those as whole-product sales would
 * match each one to the BOX in the catalog and take twelve boxes out of stock
 * for a box that was opened once.
 *
 * Anchored to the end, and digits only. A sealed-product listing does not end in
 * "#7"; a spot in a numbered lot always does.
 */
const RE_TRAILING_LOT = /#\s*\d+\s*$/

/** "Earnings for selling a|an|the X" -> "X". */
const RE_EARNINGS_HEAD = /^Earnings for selling\s+(?:a|an|the)\s+/i

/**
 * The product name out of a whole-product sale line.
 *
 * Returns '' for anything that is not one, so a caller cannot accidentally hand
 * a break-spot title to the catalog matcher and get a confident wrong answer.
 */
export function parseProductSaleName(message: string): string {
  const msg = (message || '').trim()
  if (!RE_EARNINGS_HEAD.test(msg)) return ''
  return msg.replace(RE_EARNINGS_HEAD, '').replace(/\s+/g, ' ').trim()
}

/**
 * Does this sale line end in a team, i.e. is it one spot in a break?
 *
 * The tail after the LAST " - " is the candidate. Whatnot builds a break-spot
 * title as "<listing title> - <team>", and the listing title itself is full of
 * hyphens ("HOBBY BOX- CHASE PLANETARY PURSUIT", "2025-26", "12-Box"), so only
 * a separator with spaces around it counts and only the last one is considered.
 */
function endsWithTeam(message: string, isTeamName: (s: string) => boolean): boolean {
  const at = message.lastIndexOf(' - ')
  if (at < 0) return false
  const tail = message.slice(at + 3).trim()
  return tail.length > 0 && isTeamName(tail)
}

/**
 * Classify one row. Precedence is top to bottom — first match wins.
 *
 * Every rule matches on a PREFIX of the message rather than the whole string,
 * because Whatnot appends order ids, show titles and punctuation that vary per
 * row. Matching the stable leading phrase is what makes this survive contact
 * with real data.
 */
export function classifyLedgerRow(
  txnType: string,
  message: string,
  /**
   * Is this string the name of a real team, in any league?
   *
   * Injected rather than imported: the canonical slates live with the shipping
   * parser, and this module is the shared contract that both the main process
   * and the tests read. Without it the split still works on structure alone —
   * see below — but with it, it works on evidence.
   */
  isTeamName?: (s: string) => boolean
): LedgerBucket {
  const type = (txnType || '').trim().toUpperCase()
  const msg = (message || '').trim()

  if (type === 'PAYOUT') return 'payout'
  if (type === 'TIP') return 'tip'

  if (type === 'SALES') {
    if (msg.startsWith('Earnings for selling')) {
      // TWO KINDS OF SALE, and until now they were one.
      //
      // A break spot is one team out of a box somebody else paid to open. A
      // whole-product sale is a sealed box or case bought outright off a
      // listing — different money, different cost of goods, and the only one of
      // the two that should reduce inventory.
      //
      // Whatnot's message does not label them, so the split is read off the
      // shape it does have: a break spot carries a break number, or ends in the
      // team the buyer bought. Anything else is the product itself.
      //
      // Erring toward `sale` is deliberate. Calling a break spot a product sale
      // sends the catalog matcher hunting for "COSMIC CHROME FOOTBALL HOBBY
      // BOX ... - Dallas Cowboys" and books stock movement against a box that
      // was already opened; the reverse merely leaves a real product sale in
      // the bucket everything used to be in.
      if (RE_LEDGER_BREAK.test(msg)) return 'sale'
      if (RE_TRAILING_LOT.test(msg)) return 'sale'
      if (isTeamName) {
        if (endsWithTeam(msg, isTeamName)) return 'sale'
      } else if (msg.lastIndexOf(' - ') >= 0) {
        // No team list to consult: treat any " - <tail>" as a spot rather than
        // guess a product out of it.
        return 'sale'
      }
      return 'product_sale'
    }
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
 * - own_day      : it belongs to no show BY NATURE, so it books to its own date.
 * - unattributed : nothing owns it, and the app says so rather than guessing.
 */
export type LedgerAttribution = 'in_window' | 'carried_back' | 'own_day' | 'unattributed'

/**
 * Buckets that book to their OWN calendar day when no session contains them.
 *
 * Only whole-product sales. A sealed box bought off a listing at 2pm on a
 * Tuesday is not a show sale that lost its show — there was never a show. The
 * question "which stream earned this" has no answer because it is the wrong
 * question, and leaving it unattributed was reporting a missing session that
 * does not exist while keeping real revenue out of every day of the P&L.
 *
 * This is precisely why `sale` cannot join it, and the distinction only became
 * safe once the two were told apart. A break spot outside every window IS a
 * missing session — RM runs two shows most days — and giving it a day of its
 * own would hide exactly the gap the operator needs to see.
 */
const OWN_DAY_BUCKETS = new Set<LedgerBucket>(['product_sale'])

export function booksToOwnDay(bucket: LedgerBucket): boolean {
  return OWN_DAY_BUCKETS.has(bucket)
}

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
 * WHAT WHATNOT ALREADY TOOK — AND WHY THE FEE IS DERIVED, NEVER SUBTRACTED
 *
 * THE LEDGER'S `Amount` IS NET. Whatnot deducts its cut before it writes the
 * row, and the file contains no fee line anywhere. That is not an assumption:
 * on the owner's real exports every non-payout row summed equals the payouts, to
 * the cent — $184,624.09 across 2,551 rows in the ten-day file, $285,333.42
 * across 6,674 in the month before it. If a fee were still to come off, those
 * two figures could not balance.
 *
 * This module used to read that net figure as GROSS and take 8.9% off it a
 * second time. On the ten-day export that understated revenue by roughly
 * $35,000 and printed a platform fee that had already been taken. Every Whatnot
 * P&L the owner has ever seen carried the error.
 *
 * So the arithmetic runs the other way now. Net is the STORED TRUTH — it is what
 * reconciles to the bank — and gross and the two fees are reverse-engineered
 * from it, PER SALE ROW:
 *
 *   gross      = (net + 0.30) / (1 − whatnotRate − 0.029)
 *   whatnotFee = gross × whatnotRate
 *   stripeFee  = gross × 0.029 + 0.30
 *
 * THE FLAT 30c IS BACK, and the comment this one replaces argued it should
 * never be. That argument was right about a different mistake: charging 30c ON
 * TOP of a net figure invents money nobody took, which is exactly what the old
 * code did on a show selling 1,900 small spots. Reverse-engineering the same 30c
 * OUT of a net figure invents nothing — the net is unchanged either way, and all
 * that moves is how much of the buyer's payment is attributed to Stripe. The
 * charge is per PURCHASED SLOT, and the file settles that one row is one slot:
 * 1,929 sale rows carry 1,929 distinct Order IDs.
 *
 * Stripe is 2.9% + 30c and is NOT configurable — it is a published card rate,
 * not a term RM negotiates. Whatnot's commission defaults to 6% and IS
 * configurable by date range (see `WhatnotRatePeriod`), because it is a term of
 * the seller agreement and terms change.
 *
 * A NEGATIVE OR ZERO ROW TAKES NO FEE AND NO 30c. A refund is not a purchase and
 * a $0.00 sale is not a transaction; both pass through at face value. Applying
 * the flat charge to them would invent a fee AND get its sign wrong, which is
 * the same class of error this whole comment exists to prevent.
 *
 * Fees apply to SALES ONLY. Tips, seller bonuses, shipping subsidies, shipping
 * charges, giveaway postage and Show Boost arrive whole, exactly as before.
 */

/** Stripe's percentage. Never configurable — it is not RM's to negotiate. */
export const STRIPE_PERCENT_RATE = 0.029
/** Stripe's flat charge per purchased slot, in CENTS so it never rounds. */
export const STRIPE_FLAT_CENTS = 30
/** What Whatnot takes where no period says otherwise. */
export const DEFAULT_WHATNOT_RATE = 0.06

/**
 * The sane band for a commission, enforced in main.
 *
 * Wide on purpose — the point is to catch a typo (600% from a form that meant
 * 6%, or a stray minus) rather than to have an opinion about what Whatnot may
 * charge. The upper bound also keeps `1 − rate − 0.029` safely positive, which
 * is the divisor every derived gross goes through.
 */
export const WHATNOT_RATE_MIN = 0
export const WHATNOT_RATE_MAX = 0.5

/**
 * A stretch of days on which Whatnot's commission was some particular rate.
 *
 * `toDate` null means open-ended — the rate in force until somebody says
 * otherwise. Periods MAY NOT OVERLAP; see `overlappingRatePeriod` for why that
 * is refused on save rather than resolved by precedence.
 */
export interface WhatnotRatePeriod {
  id: string
  /** Inclusive business day, YYYY-MM-DD. */
  fromDate: string
  /** Inclusive business day, or null for "and onwards". */
  toDate: string | null
  /** A fraction: 0.06 is 6%. */
  rate: number
  /** Why this rate, in the operator's words. */
  note: string
  createdAt: string
  updatedAt: string
}

/** What an open-ended `toDate` compares AS. Sorts after any real date. */
const OPEN_ENDED = '9999-12-31'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** A real calendar day, not "2026-02-31" normalised into March. */
export function isDayKey(value: string): boolean {
  if (!DAY_RE.test(value || '')) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export function ratePeriodCovers(period: WhatnotRatePeriod, day: string): boolean {
  return day >= period.fromDate && day <= (period.toDate ?? OPEN_ENDED)
}

/**
 * The period that owns a day, or null when the default applies.
 *
 * A plain linear scan. It stops at the FIRST match because a day cannot be
 * covered twice — that is enforced at the point of writing, and it is the whole
 * reason this function needs no tie-breaker.
 */
export function coveringRatePeriod(
  periods: readonly WhatnotRatePeriod[],
  day: string
): WhatnotRatePeriod | null {
  for (const p of periods) if (ratePeriodCovers(p, day)) return p
  return null
}

/** What Whatnot took on a given day. `DEFAULT_WHATNOT_RATE` where nothing says. */
export function effectiveWhatnotRate(
  periods: readonly WhatnotRatePeriod[],
  day: string
): number {
  return coveringRatePeriod(periods, day)?.rate ?? DEFAULT_WHATNOT_RATE
}

/**
 * The stored period a candidate would collide with, or null.
 *
 * OVERLAP IS REFUSED, NOT RESOLVED. The alternative — a precedence rule, newest
 * wins or narrowest wins — means the rate for a day depends on something the
 * screen does not show, so two periods that both claim 12 July would produce a
 * figure nobody could reproduce by reading the list. Refusing keeps the list
 * itself the answer: read it top to bottom and every day has exactly one rate or
 * the default, with no arbitration happening in anyone's head.
 *
 * `ignoreId` is the row being edited — a period always overlaps itself.
 */
export function overlappingRatePeriod(
  periods: readonly WhatnotRatePeriod[],
  candidate: { fromDate: string; toDate: string | null },
  ignoreId?: string
): WhatnotRatePeriod | null {
  const from = candidate.fromDate
  const to = candidate.toDate ?? OPEN_ENDED
  for (const p of periods) {
    if (ignoreId && p.id === ignoreId) continue
    if (from <= (p.toDate ?? OPEN_ENDED) && to >= p.fromDate) return p
  }
  return null
}

export interface RatePeriodInput {
  id?: string
  fromDate: string
  toDate: string | null
  /** A fraction, 0.06 for 6%. A form string is coerced BEFORE it gets here. */
  rate: number
  note: string
}

/**
 * Everything that can be wrong with a period, as a sentence, or null.
 *
 * Shared so the form can say it early, but MAIN IS THE TRUST BOUNDARY and calls
 * this itself — a renderer is a convenience, not a guarantee, and this figure
 * multiplies every sale the business has ever made.
 */
export function validateRatePeriod(input: RatePeriodInput): string | null {
  if (!isDayKey(input.fromDate)) return 'The start date is not a real date.'
  if (input.toDate !== null && !isDayKey(input.toDate)) return 'The end date is not a real date.'
  if (input.toDate !== null && input.toDate < input.fromDate) {
    return 'The end date is before the start date.'
  }
  // Number('') is 0 and Number('6%') is NaN — a form string reaches here as
  // whatever the coercion made of it, and both must be refused rather than
  // silently booked as a 0% commission.
  if (typeof input.rate !== 'number' || !Number.isFinite(input.rate)) {
    return 'That rate is not a number.'
  }
  if (input.rate < WHATNOT_RATE_MIN || input.rate > WHATNOT_RATE_MAX) {
    return `A commission of ${(input.rate * 100).toFixed(2)}% is outside the ${
      WHATNOT_RATE_MIN * 100
    }–${WHATNOT_RATE_MAX * 100}% this app will accept. Enter it as a percentage of the sale.`
  }
  return null
}

/**
 * One sale row, taken apart.
 *
 * INTEGER CENTS throughout, and the identity `grossCents + whatnotFeeCents +
 * stripeFeeCents === netCents` holds exactly, by construction — the fees are
 * negative, and gross is DEFINED as net plus them rather than as a rounding of
 * the division. That is where the rounding decision lives: each fee is an honest
 * rounding of its rate applied to the exact gross, and the reported gross
 * absorbs the half-cent, so a derived figure can never fail to reconcile to the
 * ledger's own net. Rounding the division instead and plugging one fee would
 * make that fee a residual rather than a rate, which is the one number the
 * operator wants to check against a statement.
 */
export interface SaleFee {
  netCents: number
  /** DERIVED — what the buyer paid. Never a figure Whatnot stated. */
  grossCents: number
  /** NEGATIVE. */
  whatnotFeeCents: number
  /** NEGATIVE. Includes the flat 30c. */
  stripeFeeCents: number
}

export function deriveSaleFee(netCents: number, whatnotRate: number): SaleFee {
  const net = Number.isFinite(netCents) ? Math.round(netCents) : 0
  // A refund is not a purchase and a $0.00 sale is not a transaction. Face
  // value, straight through, and no 30c.
  if (net <= 0) {
    return { netCents: net, grossCents: net, whatnotFeeCents: 0, stripeFeeCents: 0 }
  }
  const rate =
    Number.isFinite(whatnotRate) && whatnotRate >= WHATNOT_RATE_MIN && whatnotRate <= WHATNOT_RATE_MAX
      ? whatnotRate
      : DEFAULT_WHATNOT_RATE
  const kept = 1 - rate - STRIPE_PERCENT_RATE
  // Unreachable through validation, and guarded anyway: a divisor at or below
  // zero would produce an infinite or negative gross and poison every total
  // downstream of it.
  if (!(kept > 0)) {
    return { netCents: net, grossCents: net, whatnotFeeCents: 0, stripeFeeCents: 0 }
  }
  const grossExact = (net + STRIPE_FLAT_CENTS) / kept
  const whatnot = Math.round(grossExact * rate)
  const stripe = Math.round(grossExact * STRIPE_PERCENT_RATE) + STRIPE_FLAT_CENTS
  return {
    netCents: net,
    grossCents: net + whatnot + stripe,
    whatnotFeeCents: -whatnot,
    stripeFeeCents: -stripe
  }
}

export interface FeeBreakdown {
  /** The ledger's own figure for these rows. The stored truth. */
  netSales: number
  /** DERIVED: netSales with both fees added back. */
  grossSales: number
  /** Every sale row behind the figure, whatever its sign. */
  saleCount: number
  /** How many of those actually carried a fee — i.e. were real purchases. */
  chargedCount: number
  /** Negative. */
  whatnotFee: number
  /** Negative. */
  processingFee: number
  /** Negative. whatnotFee + processingFee. */
  totalFees: number
}

const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * Add a set of sale rows up.
 *
 * TAKES ROWS, not a total, and that is the signature doing the work: the rate
 * comes from the row's own date and the flat 30c comes from the row existing, so
 * neither can be recovered from a day's dollar figure. A caller that still has
 * only a total is a caller that cannot compute this, and it should fail to
 * compile rather than approximate.
 *
 * Because every step is linear in the row, summing per-row cents here and
 * summing whole days elsewhere give the SAME answer to the cent. The tests
 * assert exactly that rather than trusting it.
 */
export function computeFees(
  rows: readonly { netCents: number; whatnotRate: number }[]
): FeeBreakdown {
  let net = 0
  let gross = 0
  let whatnot = 0
  let stripe = 0
  let charged = 0
  for (const row of rows) {
    const fee = deriveSaleFee(row.netCents, row.whatnotRate)
    net += fee.netCents
    gross += fee.grossCents
    whatnot += fee.whatnotFeeCents
    stripe += fee.stripeFeeCents
    if (fee.whatnotFeeCents !== 0 || fee.stripeFeeCents !== 0) charged += 1
  }
  return {
    netSales: cents(net / 100),
    grossSales: cents(gross / 100),
    saleCount: rows.length,
    chargedCount: charged,
    whatnotFee: cents(whatnot / 100),
    processingFee: cents(stripe / 100),
    totalFees: cents((whatnot + stripe) / 100)
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
  /**
   * THE STORED TRUTH. What Whatnot actually paid for the sale rows on this day —
   * the ledger's own `Amount`, summed, already net of everything the platform
   * took. This is the figure that reconciles to the payouts, and nothing derives
   * it: it is read straight off the rows. Break spots AND whole products.
   */
  netSales: number
  /**
   * DERIVED. What the buyers paid, reverse-engineered row by row from `netSales`
   * at that row's commission rate — see the fee section above.
   *
   * WHATNOT NEVER STATES THIS NUMBER. It is `netSales` with `totalFees` added
   * back, and that identity is exact to the cent by construction. It is the top
   * line of the statement because a P&L reads gross-down; `netSales` is what it
   * reads back down to.
   */
  grossSales: number
  /** Sale rows behind the two figures above, whatever their sign. */
  saleCount: number
  /** How many of those were real purchases and so carried a fee and a 30c. */
  feeSaleCount: number
  /**
   * The whole-product share of `netSales` — sealed boxes and cases sold outright
   * rather than as break spots.
   *
   * NET, like `netSales` it is a subset of, and a subset rather than an addition:
   * the two are the same money and carry the same fees, and giving them separate
   * top lines would mean every subtotal and every reconciliation had to learn
   * about both. It rides along so a screen can say how much of a day was
   * marketplace without re-querying the ledger.
   */
  productSales: number
  productSaleCount: number
  tips: number
  bonuses: number
  /**
   * Money on a row whose message shape this version does not recognise.
   *
   * Counted at FACE VALUE as revenue — never dropped — and now carried as its
   * own field so the statement can show it. It used to be folded straight into
   * `totalRevenue` with no line of its own, which made the Revenue subtotal
   * larger than the sum of the lines printed under it, with the difference
   * appearing nowhere. `pnlChecksum` still reconciled, so nothing flagged the
   * gap: the statement simply did not explain itself.
   */
  unclassified: number
  /** grossSales + tips + bonuses + unclassified. What the buyers paid. */
  totalRevenue: number

  // --- Fees (all negative) ------------------------------------------------
  /** Whatnot's commission, at the rate in force on each row's own date. */
  whatnotFee: number
  /** Stripe: 2.9% of gross plus 30c per purchased slot. */
  processingFee: number
  totalFees: number
  /** totalRevenue + totalFees. What Whatnot actually paid you — and therefore
   *  netSales + tips + bonuses + unclassified, exactly. */
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
  /**
   * NEGATIVE. What the packing materials cost — mailers, labels, sleeves,
   * toploaders, team bags — priced at the moving average unit cost in Supplies.
   *
   * Postage and packing are different money and the P&L never had the second
   * one. Four hundred bubble mailers is real spend that used to show up only as
   * a supplies purchase weeks earlier, in a month that had nothing to do with
   * the show that consumed them.
   *
   * Like `giveawayLoss`, this comes from OUTSIDE the ledger, so the
   * reconciliation strips it back out before comparing the day to its rows.
   * A role nobody has linked to a product contributes nothing — never a guess.
   */
  packingSupplies: number
  /** Subsidy less all postage AND packing. Can land either side of zero. */
  netShipping: number

  // --- Other show costs ---------------------------------------------------
  /** Paid promotion. Negative. */
  showBoost: number
  /** Refunded orders. Negative. */
  reversals: number
  /**
   * NEGATIVE. The value of stock GIVEN AWAY on the shows that day, taken from
   * the giveaway lines the operator entered in Streaming — never inferred from
   * ledger rows.
   *
   * It is a cost of running the show, exactly like `showBoost`, and it is a
   * DIFFERENT cost from `giveawayShipping`: that is the postage Whatnot charged
   * to mail the prize, this is the prize. Both belong, and neither replaces the
   * other.
   *
   * It is also the only figure on a day that comes from outside the ledger, so
   * the reconciliation strips it back out along with the fees before comparing
   * the day breakdown to the rows.
   */
  giveawayLoss: number

  /** netRevenue + netShipping + showBoost + reversals + giveawayLoss. Every
   *  cost the LEDGER knows about, but not what the stock cost. */
  netAfterCosts: number

  // --- Cost of goods ------------------------------------------------------
  /**
   * What the stock opened on this show cost, at the FIFO layers actually
   * consumed. NEGATIVE.
   *
   * This is the other half of cost of goods and for three releases it sat on
   * the day as information the bottom line ignored — which made every "net"
   * figure a gross margin wearing a net label. Breaking a case to sell spots is
   * the single largest cost of running a show; a P&L that omits it is not
   * conservative, it is wrong.
   */
  breakCost: number
  /** Stock given away, valued at pack cost. NEGATIVE. */
  giveawayCost: number
  /** breakCost + giveawayCost. NEGATIVE. */
  cogs: number
  /** totalRevenue + cogs. What the show made before the platform took its cut. */
  grossProfit: number
  /**
   * The bottom line: grossProfit + fees + shipping + show costs + adjustments.
   * This is the number that goes on the calendar in green or red.
   */
  netProfit: number

  rowCount: number
  /** How many of those rows settled after the show rather than during it. Shown
   *  so a day's total is explainable: without it, a show's shipping costs look
   *  like they appeared from nowhere hours after it ended. */
  carriedBackRows: number
  carriedBackAmount: number
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

/**
 * A P&L rendered as sections, built in ONE place.
 *
 * The alternative — letting the screen decide which fields go in which section
 * and add up to what — is how a statement ends up with sections that each look
 * right and a total that does not match any of them. Here the arithmetic and
 * the layout come from the same function, so a section subtotal cannot drift
 * from the fields inside it and the final figure is the sum of the subtotals by
 * construction.
 */
export interface PnlLine {
  key: string
  label: string
  amount: number
  /** Shown small beside the label — a count, a rate, a caveat. */
  detail?: string
  /** True for a line that is zero and only present to keep the shape stable. */
  empty?: boolean
}

export interface PnlSection {
  key: string
  label: string
  lines: PnlLine[]
  subtotal: number
  subtotalLabel: string
  /** A running figure carried down the statement (gross profit, net profit). */
  running?: boolean
  /**
   * A sentence printed under the section's lines when it is open.
   *
   * Exists for exactly one thing: saying, where the fees are, that the gross
   * above them is DERIVED from the net Whatnot paid rather than stated by
   * Whatnot. That relationship is the whole point of this rewrite, and a reader
   * who does not know it will mistake a reverse-engineered figure for something
   * on a statement somewhere.
   */
  note?: string
}

/**
 * Group a count for reading: 1029 -> "1,029".
 *
 * Pinned to en-US rather than the host locale. These strings are half of a
 * sentence the app writes elsewhere in English, and a separator that changed
 * with the machine would make the same statement render two ways on two desks.
 */
const count = (n: number): string => n.toLocaleString('en-US')

/** "$203,832.85". Pinned to en-US for the same reason `count` is. */
const usd = (n: number): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })

/**
 * A rate as the statement prints it: "6%", "6.5%", "6.8%".
 *
 * ONE decimal, trailing zero dropped, and the precision is chosen rather than
 * lazy. This rate is computed back OUT of a fee and a gross that are each
 * already rounded to the cent, so on a $14 break spot a half-cent of rounding is
 * about a hundredth of a percent — at two decimals a 6% commission prints as
 * "5.99%", which reads as a bug and sends somebody looking for one. At one
 * decimal it prints as "6%", and the "of $X gross" beside it is what actually
 * makes the figure reproducible.
 *
 * Derived rather than read off the configured period, because a range that
 * straddles a rate change has no single configured rate and must print the blend
 * it really charged.
 */
const pctLabel = (fraction: number): string => {
  const pct = Math.round(fraction * 1000) / 10
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`
}

const c2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Build the statement for one day (or any rolled-up period — the shapes match).
 *
 * Order is deliberate and follows how the money actually moves: what came in,
 * what the goods cost, what the platform took, what shipping did, what else the
 * show cost, then the exceptions. Fees sit AFTER cost of goods because they are
 * charged on the sale, not on the margin.
 */
export function buildPnl(d: {
  netSales: number; grossSales: number; saleCount: number
  tips: number; bonuses: number; totalRevenue: number
  unclassified?: number
  /** Optional so a caller built before the fee rewrite still type-checks. */
  feeSaleCount?: number
  breakCost: number; giveawayCost: number; cogs: number; grossProfit: number
  whatnotFee: number; processingFee: number; totalFees: number
  shippingSubsidy: number; shippingCharges: number; giveawayShipping: number
  refundShipping: number; netShipping: number
  /** Optional so a caller built before packing existed still type-checks. */
  packingSupplies?: number
  showBoost: number; reversals: number; netProfit: number
}): PnlSection[] {
  const line = (key: string, label: string, amount: number, detail?: string): PnlLine => ({
    key, label, amount: c2(amount), detail, empty: c2(amount) === 0
  })

  const gross = c2(d.grossSales)
  const charged = d.feeSaleCount ?? d.saleCount
  // Read back OUT of the figures rather than off a setting, so a period that
  // spans a rate change prints the blend it actually charged instead of a rate
  // that is right for only part of it.
  const whatnotRate = gross > 0 ? Math.abs(d.whatnotFee) / gross : null
  const stripePercentPart = c2(gross * STRIPE_PERCENT_RATE)

  return [
    {
      key: 'revenue',
      label: 'Revenue',
      lines: [
        // The count is on the line because it is what the flat 30c multiplies;
        // the fuller sentence about where this figure comes from is the
        // section's note below, where it has room to be a sentence.
        line(
          'sales',
          'Sales',
          gross,
          `${count(d.saleCount)} transaction${d.saleCount === 1 ? '' : 's'} · what buyers paid`
        ),
        line('tips', 'Tips', d.tips),
        line('bonuses', 'Seller bonuses', d.bonuses),
        // Present so the subtotal always equals the lines above it. Optional on
        // the input for one release, because a packaged main that predates the
        // field would otherwise print NaN here.
        line(
          'unclassified',
          'Unrecognised rows',
          d.unclassified ?? 0,
          'a message shape this version does not know, counted at face value'
        )
      ],
      subtotal: c2(d.totalRevenue),
      subtotalLabel: 'Total revenue',
      // THE SENTENCE THAT STOPS A DERIVED FIGURE BEING READ AS A STATED ONE.
      // Whatnot's export contains the second number, never the first, and
      // anybody comparing this statement to a Whatnot screen needs to know which
      // of the two they are looking at.
      note:
        `Sales is a DERIVED gross: the ${usd(c2(d.netSales))} Whatnot actually paid out for ` +
        `these ${count(d.saleCount)} row${d.saleCount === 1 ? '' : 's'}, with the platform fees ` +
        `below added back on. The net is what reconciles to the bank; the gross is what the ` +
        `buyers paid. Whatnot states only the net.`
    },
    {
      key: 'cogs',
      label: 'Cost of goods',
      lines: [
        line('breakCost', 'Stock broken', d.breakCost),
        line('giveawayCost', 'Stock given away', d.giveawayCost)
      ],
      subtotal: c2(d.cogs),
      subtotalLabel: 'Cost of goods'
    },
    {
      key: 'grossProfit',
      label: 'Gross profit',
      lines: [],
      subtotal: c2(d.grossProfit),
      subtotalLabel: 'Gross profit',
      running: true
    },
    {
      key: 'fees',
      label: 'Platform fees',
      lines: [
        // TWO CUTS, SET BY TWO DIFFERENT PARTIES, so they are never one line.
        // Whatnot's is negotiable and configurable by date; Stripe's is a
        // published card rate. The owner's ask was to still see what is lost in
        // fees, and "lost to whom" is half of that answer.
        line(
          'whatnotFee',
          'Whatnot commission',
          d.whatnotFee,
          whatnotRate === null
            ? 'a share of every sale'
            : `${pctLabel(whatnotRate)} of ${usd(gross)} gross`
        ),
        // Written as the sum it is, so a person can reproduce it with a
        // calculator: a percentage of the gross above, plus 30c for each slot
        // somebody bought.
        line(
          'processingFee',
          'Payment processing',
          d.processingFee,
          `2.9% of gross + 30\u00A2 \u00D7 ${count(charged)} order${charged === 1 ? '' : 's'}`
        )
      ],
      subtotal: c2(d.totalFees),
      subtotalLabel: 'Total fees',
      note:
        `Whatnot pays NET \u2014 both of these were already gone before the ledger row was ` +
        `written. Stripe's percentage alone is ${usd(stripePercentPart)}; the rest of that ` +
        `line is 30\u00A2 a slot. Taking the two off the sales line above lands exactly on what ` +
        `was paid out, to the cent.`
    },
    {
      key: 'shipping',
      label: 'Shipping',
      lines: [
        line('shippingSubsidy', 'Subsidy received', d.shippingSubsidy),
        line('shippingCharges', 'Postage charged back', d.shippingCharges),
        line('giveawayShipping', 'Giveaway postage', d.giveawayShipping),
        line('refundShipping', 'Refund postage', d.refundShipping),
        line('packingSupplies', 'Packing supplies', d.packingSupplies ?? 0)
      ],
      subtotal: c2(d.netShipping),
      subtotalLabel: 'Net shipping & packing'
    },
    {
      key: 'showCosts',
      label: 'Other show costs',
      lines: [line('showBoost', 'Show Boost', d.showBoost)],
      subtotal: c2(d.showBoost),
      subtotalLabel: 'Show costs'
    },
    {
      key: 'adjustments',
      label: 'Adjustments and exceptions',
      lines: [line('reversals', 'Refunded orders', d.reversals)],
      subtotal: c2(d.reversals),
      subtotalLabel: 'Adjustments'
    },
    {
      key: 'netProfit',
      label: 'Net profit',
      lines: [],
      subtotal: c2(d.netProfit),
      subtotalLabel: 'Net profit',
      running: true
    }
  ]
}

/**
 * Net profit as a share of total revenue.
 *
 * The denominator is TOTAL REVENUE, not sales — this is "of every dollar that
 * came in, how much did we keep", which is the question a margin answers. (The
 * fee rate elsewhere divides by sales instead, because fees are only charged on
 * sales; the two denominators are different on purpose and each is labelled.)
 *
 * Null rather than zero when nothing came in: a 0% margin on no revenue is a
 * statement about nothing, and printing it invites the reader to compare it to
 * a real one.
 */
export function profitMargin(totalRevenue: number, netProfit: number): number | null {
  if (!Number.isFinite(totalRevenue) || totalRevenue <= 0) return null
  return Math.round((netProfit / totalRevenue) * 1000) / 10
}

/**
 * Every section subtotal that is NOT a running total, summed. Must equal
 * netProfit — exported so the UI and the tests can both assert it rather than
 * trusting it.
 */
export function pnlChecksum(sections: PnlSection[]): number {
  return c2(sections.filter((s) => !s.running).reduce((a, s) => a + s.subtotal, 0))
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

/** One burst of unattributed activity, as an on-air window. */
export interface UnattributedWindow {
  from: string
  to: string
  rowCount: number
  amount: number
}

/**
 * Everything waiting for a show ON ONE DAY.
 *
 * Keyed by the day each burst BEGAN, not by each row's own date, so a block that
 * ran past midnight counts entirely on the evening it started — the same rule
 * that governs a logged show's revenue. Keying rows individually would split one
 * unlogged evening across two calendar days and show two half-shows where there
 * was one.
 *
 * This is what puts the money on the calendar. It used to exist only as one
 * total plus a flat table of every burst, which meant the operator read a
 * $24,616.92 figure and a list, and then had to work out for themselves which
 * days it belonged to — while looking at a calendar of those very days.
 */
export interface UnattributedDay {
  localDate: string
  rowCount: number
  amount: number
  byBucket: Array<{ bucket: LedgerBucket; rowCount: number; amount: number }>
  /** The bursts that make up the day, in time order. */
  windows: UnattributedWindow[]
}

export interface UnattributedSummary {
  rowCount: number
  amount: number
  firstOccurredAt: string | null
  lastOccurredAt: string | null
  byBucket: Array<{ bucket: LedgerBucket; rowCount: number; amount: number }>
  clusters: UnattributedCluster[]
  /** The same money, per business day, biggest day first. */
  byDay: UnattributedDay[]
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

/**
 * What deleting one import would actually cost, read BEFORE the confirmation.
 *
 * `owned` is the file's rows; `covered` is how many of those another import
 * also contains, which now survive by being re-pointed to it. `losing` is the
 * difference — the only money that really leaves. A confirmation quoting the
 * file's own row count would overstate the loss by whatever the overlap is,
 * which on consecutive weekly exports is hundreds of rows.
 */
export interface ImportDeleteImpact {
  exists: boolean
  owned: number
  covered: number
  losing: number
  losingAmount: number
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

// ---------------------------------------------------------------------------
// Adding days up
// ---------------------------------------------------------------------------

/**
 * Every money field a day carries, named once.
 *
 * This list lives in the CONTRACT rather than in main because both sides now
 * sum days: main builds the weeks, the months and the grand total from it, and
 * the renderer builds whatever range the operator dragged out on the calendar.
 * Two lists would mean a range total that quietly disagreed with the week it
 * sits inside — the exact failure the rest of this module is arranged to make
 * impossible.
 */
export const PNL_MONEY_FIELDS = [
  'netSales',
  'grossSales',
  'productSales',
  'tips',
  'bonuses',
  'unclassified',
  'totalRevenue',
  'whatnotFee',
  'processingFee',
  'totalFees',
  'netRevenue',
  'shippingSubsidy',
  'shippingCharges',
  'giveawayShipping',
  'refundShipping',
  'packingSupplies',
  'netShipping',
  'showBoost',
  'reversals',
  'giveawayLoss',
  'netAfterCosts',
  'carriedBackAmount',
  'breakCost',
  'giveawayCost',
  'cogs',
  'grossProfit',
  'netProfit'
] as const

/** Counts, which add as plain integers. */
export const PNL_COUNT_FIELDS = [
  'sessionCount',
  'minutes',
  'saleCount',
  'feeSaleCount',
  'productSaleCount',
  'rowCount',
  'carriedBackRows'
] as const

export type PnlMoneyField = (typeof PNL_MONEY_FIELDS)[number]
export type PnlCountField = (typeof PNL_COUNT_FIELDS)[number]

/** A day with every figure at zero. The shape every sum starts from, so a field
 *  added to `StreamDayFinance` and forgotten here is a type error rather than a
 *  silently absent number. */
export function emptyDayFinance(streamDate: string): StreamDayFinance {
  return {
    streamDate,
    sessionCount: 0,
    sessionTitles: [],
    minutes: 0,
    netSales: 0,
    grossSales: 0,
    saleCount: 0,
    feeSaleCount: 0,
    productSales: 0,
    productSaleCount: 0,
    tips: 0,
    bonuses: 0,
    unclassified: 0,
    totalRevenue: 0,
    whatnotFee: 0,
    processingFee: 0,
    totalFees: 0,
    netRevenue: 0,
    shippingSubsidy: 0,
    shippingCharges: 0,
    giveawayShipping: 0,
    refundShipping: 0,
    packingSupplies: 0,
    netShipping: 0,
    showBoost: 0,
    reversals: 0,
    giveawayLoss: 0,
    netAfterCosts: 0,
    rowCount: 0,
    carriedBackRows: 0,
    carriedBackAmount: 0,
    breakCost: 0,
    giveawayCost: 0,
    cogs: 0,
    grossProfit: 0,
    netProfit: 0
  }
}

/**
 * Add a set of days into one statement-shaped total.
 *
 * In INTEGER CENTS, converted back exactly once at the end. Twenty-eight day
 * figures added as floats and then compared to another float sum is how a
 * reconciliation check reports a phantom cent.
 *
 * Every field is SUMMED, including the fees and the derived gross — never
 * re-derived from the range's net. A range total cannot be taken apart into the
 * rows it came from: the 30c is per ROW and the rate is per row's DATE, so
 * `deriveSaleFee` on a period's net sales would charge one 30c for a month and
 * one rate for a period that may straddle two. The derivation happens once, per
 * row; a day sums its rows and everything above a day sums days.
 *
 * A non-finite figure counts as zero rather than poisoning the whole range: an
 * older packaged main can send days without the cost-of-goods keys, and one
 * NaN would otherwise turn every widget on the screen into NaN. The statement's
 * own checksum then fails loudly, which is the correct outcome — on that build
 * the numbers genuinely do not add up.
 */
export function sumDayFinance(days: StreamDayFinance[]): StreamFinanceTotals {
  const money = new Map<PnlMoneyField, number>()
  const counts = new Map<PnlCountField, number>()

  for (const day of days) {
    const fields = day as unknown as Record<string, number>
    for (const f of PNL_MONEY_FIELDS) {
      const v = fields[f]
      money.set(f, (money.get(f) ?? 0) + Math.round((Number.isFinite(v) ? v : 0) * 100))
    }
    for (const f of PNL_COUNT_FIELDS) {
      const v = fields[f]
      counts.set(f, (counts.get(f) ?? 0) + (Number.isFinite(v) ? v : 0))
    }
  }

  const out = emptyDayFinance('') as unknown as Record<string, unknown>
  for (const f of PNL_MONEY_FIELDS) out[f] = Math.round(money.get(f) ?? 0) / 100
  for (const f of PNL_COUNT_FIELDS) out[f] = counts.get(f) ?? 0
  delete out.streamDate
  delete out.sessionTitles
  return { ...(out as unknown as Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>),
    dayCount: days.length }
}
