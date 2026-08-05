/**
 * Finance → Streaming: importing the Whatnot ledger and attributing it to shows.
 *
 * THE GOVERNING RULE
 *
 * A row's business day is ALWAYS its session's `streamDate` — the local date the
 * show STARTED on — and never anything recomputed from the row's own timestamp.
 * Measured on real RM data: 80.3% of the 7/24 night show's money is stamped
 * after midnight on 7/25, and 24.5% of ALL money in a five-week export lands
 * between 00:00 and 02:59. Bucketing by the row's own calendar date moves about
 * a quarter of the business onto the wrong day and nothing on screen looks
 * wrong. So `stream_date` is COPIED from the matched session, full stop.
 *
 * THREE THINGS THIS FILE REFUSES TO DO
 *
 * 1. Drop a line. Whatnot has shipped TWO export formats — the original quotes
 *    every field, writes negatives as "-$4.15" and is not valid RFC4180 (it
 *    wraps Show Boost titles in unescaped double quotes); the current one quotes
 *    minimally, writes negatives as "($4.15)" and is valid. ONE import path
 *    reads both, auto-detected, because asking the operator which format a file
 *    is would be asking them to guess. A line the correct parse rejects goes
 *    through the anchored repair; a line that still cannot be read is written to
 *    `ledger_quarantine` with its raw text. A vanished row is money with no
 *    trace, which is strictly worse than a loud error.
 * 2. Guess an owner for a SALE. There is no nearest-session match, no ±N minute
 *    tolerance and no "before 4am means yesterday". A sale is inside a session
 *    window or it is not; if it is not, it stays unattributed and is SHOWN as
 *    such. On real data a realistic session log leaves ~24% of the money outside
 *    every window (RM runs two shows most days), and silently reassigning it
 *    would merge a whole unlogged afternoon show into the previous night while
 *    the operator never learned the session was missing.
 *
 *    Settlement rows are the exception, and a narrow one. Whatnot posts a show's
 *    shipping economics hours after the show — subsidies batch overnight,
 *    platform charges post next morning, giveaway postage lands whenever the
 *    label is bought — so those rows sit in the gap between two sessions owned
 *    by neither. They are not missing a session; they are the AFTERMATH of one,
 *    and they carry back to the show that most recently ended before them. Which
 *    buckets qualify is decided by `carryBackEligible` in the contract and
 *    deliberately excludes `sale` (see above) and `show_boost` (bought FOR the
 *    NEXT show, so carrying it back books it backwards in time).
 * 3. Shorten the de-dup key. The fingerprint is the full six-tuple from
 *    `ledgerFingerprintSource`. Every measured shorter key — (order, type,
 *    amount) and friends — silently discards 156-274 real rows per export,
 *    because 154 platform charges are identical -$4.15 rows and whole batches of
 *    $0.00 shipping subsidies share one timestamp.
 *
 * WHAT A DAY IS WORTH, AND WHERE THAT IS DECIDED
 *
 * THE LEDGER'S SALE FIGURE IS NET. Whatnot deducts its cut before it writes the
 * row — proved on real exports, where every non-payout row summed equals the
 * payouts to the cent — so `amount` is money already received and it is stored
 * exactly as it arrived. This file used to read it as GROSS and take 8.9% off it
 * a second time, which understated a ten-day export's revenue by about $35,000
 * and printed a fee that had already been taken.
 *
 * The item price and the two fees are DERIVED, per positive sale ROW, on the
 * terms in force on that row's BUSINESS DAY (`deriveSaleFee` in the contract
 * owns the arithmetic and it is never inlined; `whatnotRates.ts` owns the
 * terms). A row is one purchased ORDER — 1,929 sale rows carry 1,929 distinct
 * Order IDs — which is what makes the flat charge per row a fact rather than a
 * model.
 *
 * PER ROW, then summed onto a day; weeks, months and the grand total then sum
 * days. Nothing above a row ever re-derives, and it could not: a day's net sales
 * figure has lost how many flat charges are inside it and which dates they fell
 * on. Because every step is linear the two agree to the cent, and the
 * reconciliation below asserts it rather than trusting it.
 *
 * The fee is computed ON READ. That is what makes a rate change re-derive
 * history: edit the period in Finance, reopen the tab, and every show inside the
 * range moves. No re-upload, no re-attribution, no stored fee to go stale.
 *
 * COST OF GOODS IS NOT IN THE LEDGER, AND IT IS THE BIGGEST COST THERE IS
 *
 * Whatnot's export knows what a show EARNED. It has no idea what the case that
 * was broken to sell those spots cost, because that stock was bought months
 * earlier from somebody else. That figure comes from the Streaming module —
 * `stream_items`, at the FIFO layers those lines actually consumed — and for
 * three releases it rode along on the day as information the bottom line
 * ignored, which made every "net" figure a gross margin wearing a net label.
 *
 * So a day now carries TWO cost-of-goods lines, both NEGATIVE:
 *   breakCost     what the stock opened on the show cost (`cost_total`)
 *   giveawayCost  what the stock given away was worth  (`loss_value`)
 * and `cogs` is their sum, itemised per product in `cogsBreakdown` off the very
 * same rows. `grossProfit` is revenue plus cogs; `netProfit` is gross profit
 * after fees, shipping, show costs, general expenses and adjustments.
 *
 * TWO GIVEAWAY COSTS, AND THEY ARE NOT THE SAME COST. `giveaway_shipping` is a
 * LEDGER row — the postage Whatnot charged to mail a prize — and it stays in
 * Shipping. `giveawayCost` is the prize itself and is cost of goods. Folding
 * either into the other loses a real cost while every total still looks
 * plausible, so the two are counted from different sources and asserted apart.
 *
 * Everything about classification, date parsing, identity, fees and the
 * attribution predicate lives in @shared/financeStreaming and is USED here,
 * never restated: main and the renderer must never be able to disagree about
 * what a row is or what it is worth.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { Result } from '@shared/types'
import type {
  CogsItem,
  FinancePeriodRow,
  LedgerAttribution,
  LedgerBucket,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  MarketplaceItem,
  PnlCountField,
  PnlMoneyField,
  RateSlice,
  StreamDayFinance,
  StreamFinanceTotals,
  StreamingFinanceView,
  UnattributedCluster,
  UnattributedDay,
  UnattributedSummary,
  UnattributedWindow,
  UncostedStreamItem
} from '@shared/financeStreaming'
import {
  CARRY_BACK_MAX_HOURS,
  CLUSTER_GAP_MINUTES,
  LEDGER_BUCKETS,
  LEDGER_CLASSIFIER_VERSION,
  PNL_COUNT_FIELDS,
  PNL_MONEY_FIELDS,
  SESSION_VACUUM_SHARE,
  buildPnl,
  booksToOwnDay,
  carryBackEligible,
  classifyLedgerRow,
  parseProductSaleName,
  deriveSaleFee,
  emptyDayFinance,
  findCarryBackSession,
  ledgerFingerprintSource,
  mergeCogsItems,
  mergeMarketplaceItems,
  mergeRateSlices,
  parseBreakNumber,
  parseLedgerAmount,
  parseLedgerDate,
  pnlChecksum,
  rowInSession
} from '@shared/financeStreaming'
import { computePackagingCosts } from '@shared/packagingCosts'
import type { StreamSession } from '@shared/streaming'
import { durationMinutes, isSuspiciouslyLong, streamDateOf } from '@shared/streaming'
import { getDb } from './database'
import { rateLookup } from './whatnotRates'
import { expenseTotalsByDay } from './financeExpenses'
import { packagingFactsByDay } from './packagingCosts'
import { isAnyLeagueTeam } from '../shipping/teams'
import { matchProductByName, stockUnitOf } from './inventory'
import { newId, nowIso } from '../util'

// ---------------------------------------------------------------------------
// Money. Every total in this file is accumulated in INTEGER CENTS and converted
// back to dollars exactly once, at the edge. Adding 9,225 floats and comparing
// the result to another sum of 9,225 floats is how a reconciliation check
// reports a phantom one-cent break.
// ---------------------------------------------------------------------------

const toCents = (dollars: number): number => Math.round(dollars * 100)
const toDollars = (cents: number): number => Math.round(cents) / 100

/**
 * The packaging section as one signed figure, in cents.
 *
 * Named once and read in the two places that must agree about it — the bottom
 * line adds it, the reconciliation takes it back off — because it is neither a
 * ledger row nor a stored subtotal. Writing the six-term sum out twice is how
 * one of them ends up with five terms, which reads as a phantom break of exactly
 * one packaging line on every day in the period.
 */
function packagingCents(day: Pick<
  StreamDayFinance,
  | 'packagingSleeves'
  | 'packagingTopLoaders'
  | 'packagingTeamBags'
  | 'packagingShippingLabels'
  | 'packagingTeamBagStickers'
  | 'packagingMailers'
>): number {
  return (
    toCents(day.packagingSleeves) +
    toCents(day.packagingTopLoaders) +
    toCents(day.packagingTeamBags) +
    toCents(day.packagingShippingLabels) +
    toCents(day.packagingTeamBagStickers) +
    toCents(day.packagingMailers)
  )
}

/**
 * The four postage buckets as one signed figure, in cents — the mirror of
 * `packagingCents`, and needed for the opposite reason.
 *
 * Packaging is money in the statement that no ledger row carries, so the
 * reconciliation strips it from the DAY side. This is money ledger rows carry
 * that no statement section reads, so the reconciliation strips it from the ROW
 * side. Both strips exist because the check is "the day's fields decompose the
 * same money the attributed rows do", and each of these breaks that equality in
 * one direction.
 *
 * `netShipping` is the same sum and is still computed, but this reads the four
 * buckets rather than the total on purpose: the strip must be the money the
 * BUCKETS carry, so a day whose `netShipping` ever failed to be its own four
 * terms would break the reconciliation instead of hiding inside it.
 */
function shippingCents(day: Pick<
  StreamDayFinance,
  'shippingSubsidy' | 'shippingCharges' | 'giveawayShipping' | 'refundShipping'
>): number {
  return (
    toCents(day.shippingSubsidy) +
    toCents(day.shippingCharges) +
    toCents(day.giveawayShipping) +
    toCents(day.refundShipping)
  )
}

/** "$1,234.56" for a warning string the operator reads. */
function money(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The fixed schema. A mismatch ABORTS the whole import with the offending header
 * echoed back: a silently renamed column is how an entire bucket goes missing
 * while every total still looks plausible.
 */
const LEDGER_HEADER = [
  'Created Date',
  'Amount',
  'Listing ID',
  'Order ID',
  'Message',
  'Status',
  'Transaction Type',
  'Completed Date'
] as const

const COL_CREATED = 0
const COL_AMOUNT = 1
const COL_LISTING = 2
const COL_ORDER = 3
const COL_MESSAGE = 4
const COL_TYPE = 6

const FIELD_COUNT = LEDGER_HEADER.length

/**
 * WHATNOT SHIPPED A SECOND EXPORT FORMAT, AND BOTH MUST WORK
 *
 * The original export quoted every field, wrote negatives with a leading minus
 * and was not valid RFC4180 (it wraps Show Boost titles in unescaped quotes).
 * The current one quotes MINIMALLY — only fields containing a comma — writes
 * negatives as accounting parentheses `($4.15)`, pads amounts with a trailing
 * space, and is valid RFC4180. Measured on the staged pair: the old file needs
 * the repair on 8 of 6,674 rows, the new file needs it on none of 2,551.
 *
 * There is exactly ONE import path and it AUTO-DETECTS. The operator is never
 * asked which format a file is, because the answer would be a guess they cannot
 * verify and a wrong guess silently mangles a whole week of money. A correct
 * RFC4180 parse reads either format natively; the anchored repair below is a
 * fallback for the rows that a correct parse rejects, in either format.
 *
 * The two format-specific traps live in the contract, not here:
 * `parseLedgerAmount` knows `($4.15)` is NEGATIVE (strip the punctuation without
 * checking and it reads as +4.15 — silent, plausible, and an expense becomes
 * revenue), and `ledgerFingerprintSource` hashes the amount as integer cents so
 * `-$4.15` and `($4.15)` are the SAME row. Without that last part the format
 * change would have made every historic row look new and doubled the archive.
 */
type SplitResult =
  | { kind: 'ok'; fields: string[] }
  /** A quoted field ran off the end of the line — under RFC4180 the record may
   *  legitimately continue onto the next physical line. */
  | { kind: 'unterminated' }
  /** Malformed in a way no amount of extra input can fix. */
  | { kind: 'malformed' }

/**
 * Strict RFC4180 for one record's text. Fails the moment anything is not exactly
 * to spec — a bare `"` inside an unquoted field, a quote followed by something
 * other than `,` or end-of-record, an unterminated quote.
 *
 * Strictness is the point. A lenient parser hands back 8 plausible-looking
 * fields for 7 of Whatnot's 8 malformed rows and quietly produces garbage for
 * the 8th (the one whose show title contains commas reads its Transaction Type
 * as " CACTUS JACK BASKETBALL"). Nothing announces the problem. Failing here is
 * what routes those rows into the anchored repair instead.
 *
 * Unquoted fields are fully supported — that is what makes the minimally-quoted
 * new format parse natively rather than through the repair path.
 */
function strictSplit(text: string): SplitResult {
  const out: string[] = []
  const n = text.length
  let i = 0
  for (;;) {
    let field = ''
    if (text[i] === '"') {
      i += 1
      for (;;) {
        if (i >= n) return { kind: 'unterminated' }
        const ch = text[i]
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"'
            i += 2
            continue
          }
          i += 1
          break
        }
        field += ch
        i += 1
      }
      if (i < n && text[i] !== ',') return { kind: 'malformed' } // stray text after the close quote
    } else {
      while (i < n && text[i] !== ',') {
        if (text[i] === '"') return { kind: 'malformed' } // bare quote in an unquoted field
        field += text[i]
        i += 1
      }
    }
    out.push(field)
    if (i >= n) return { kind: 'ok', fields: out }
    i += 1 // consume the comma
  }
}

/**
 * The anchored repair, for Whatnot's unescaped-quote rows.
 *
 * The schema is pinned at BOTH ends: the first four fields and the last three
 * cannot contain a `"` or a `,`. Only `Message` is free text. So bind the head,
 * bind the tail, and let a greedy middle take everything else — which forces the
 * tail anchors onto the LAST three fields and recovers the row with its inner
 * quotes intact.
 *
 * Each anchor accepts a quoted OR a bare field, so the repair works on both
 * export formats. The original version required every field to be quoted, which
 * would silently refuse to repair a minimally-quoted row — and the minimally
 * quoted format is the one Whatnot ships today.
 *
 * Deliberately per-row, and deliberately recorded: regex-replacing quotes across
 * the whole file before parsing would "fix" it invisibly and there would be no
 * way to tell a repaired row from a clean one afterwards.
 */
const ANCHOR = '(?:"[^"]*"|[^",]*)'
const REPAIR_RE = new RegExp(
  `^(${ANCHOR}),(${ANCHOR}),(${ANCHOR}),(${ANCHOR}),(.*),(${ANCHOR}),(${ANCHOR}),(${ANCHOR})$`
)

/** Undo one level of CSV quoting on an anchor capture. */
function unquote(value: string): string {
  const v =
    value.length >= 2 && value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1)
      : value
  return v.replace(/""/g, '"')
}

function repairSplit(line: string): string[] | null {
  const m = REPAIR_RE.exec(line)
  if (!m) return null
  // The message is taken RAW rather than unquoted as a unit: its whole problem
  // is that its quoting is broken, so only the outermost pair is stripped and
  // any doubled quote inside is collapsed.
  let message = m[5]
  if (message.startsWith('"')) message = message.slice(1)
  if (message.endsWith('"')) message = message.slice(0, -1)
  message = message.replace(/""/g, '"')
  return [
    unquote(m[1]),
    unquote(m[2]),
    unquote(m[3]),
    unquote(m[4]),
    message,
    unquote(m[6]),
    unquote(m[7]),
    unquote(m[8])
  ]
}

interface ParsedRow {
  lineNumber: number
  fields: string[]
  repaired: boolean
}

interface QuarantinedLine {
  lineNumber: number
  raw: string
  reason: string
}

interface ParseOutcome {
  rows: ParsedRow[]
  quarantine: QuarantinedLine[]
  repaired: number
  /** Logical records found after the header. rows + quarantine must equal it. */
  dataLines: number
  headerError: string | null
}

/**
 * A quoted field may legally span physical lines under RFC4180. This caps how
 * far a record is allowed to reach for its closing quote — an unterminated quote
 * caused by corruption would otherwise swallow the rest of the file into one
 * record. Beyond the cap the line is repaired or quarantined on its own, which
 * loses one line instead of every line after it.
 */
const MAX_RECORD_LINES = 32

/**
 * Parse strictly, repair second, quarantine third — never in any other order.
 * The same three steps read BOTH export formats; nothing here branches on which
 * one it is looking at.
 *
 * Records are assembled a physical line at a time, and a line is only joined to
 * the next when the strict parse says a quoted field is still open. That is the
 * RFC4180-correct handling of an embedded newline (none occur in the 11,776 real
 * rows measured, but a format that changed once will change again) and it is
 * also the safe one: a malformed line can never desynchronise the parse and
 * consume its neighbours, because a join that does not immediately yield a
 * complete record is abandoned and the line is handled alone.
 */
function parseLedgerCsv(text: string): ParseOutcome {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split('\n').map((l) => l.replace(/\r$/, ''))
  const out: ParseOutcome = {
    rows: [],
    quarantine: [],
    repaired: 0,
    dataLines: 0,
    headerError: null
  }
  if (lines.length === 0) {
    out.headerError = 'That file is empty.'
    return out
  }

  // The header is quoted in the old format and bare in the new one. A correct
  // RFC4180 split makes both read identically, so the column check does not have
  // to know which file it has. It is still exact: a silently renamed column is
  // how a whole bucket goes missing while every total still looks plausible.
  const headerLine = lines[0]
  const header = strictSplit(headerLine)
  const names = header.kind === 'ok' ? header.fields.map((h) => h.trim()) : null

  // Trailing EMPTY columns are tolerated, on the header and on every row.
  //
  // A spreadsheet that has ever held a value to the right of the data writes
  // the sheet's full width, so the export comes out "…,Completed Date,,," with
  // three empty columns and every row ending in the same three commas. That is
  // one of the owner's two copies of the same June export, and rejecting it
  // sent somebody looking for a corruption that was not there.
  //
  // Only NAMELESS trailing columns count. A real column appearing on the right
  // is a format change and must still be refused: a silently renamed or added
  // column is how a whole bucket goes missing while every total still looks
  // plausible, which is the reason this check is exact in the first place.
  let padColumns = 0
  if (names) {
    while (names.length - padColumns > FIELD_COUNT && names[names.length - 1 - padColumns] === '') {
      padColumns += 1
    }
  }
  const width = names ? names.length - padColumns : 0
  if (!names || width !== FIELD_COUNT || LEDGER_HEADER.some((h, i) => names[i] !== h)) {
    out.headerError =
      `That does not look like a Whatnot ledger export. Expected the columns ` +
      `${LEDGER_HEADER.join(', ')} but the file starts with: ${headerLine.slice(0, 300)}`
    return out
  }

  /**
   * The padding comes off the RAW LINE, before anything parses it — and only
   * off a line the parser could not already read.
   *
   * Trimming fields AFTER a split looks equivalent and is not. A row with an
   * unescaped quote in it splits into some arbitrary number of fields, and on a
   * padded file that number can land on exactly `FIELD_COUNT + padColumns` with
   * empty trailing fields purely by coincidence — so a mis-split row gets
   * accepted as a padded good one instead of going to the anchored repair. That
   * is not a parse failure anyone would see: it produces a plausible row with
   * the message cut at the wrong comma, under a fingerprint that no longer
   * matches the same row from an unpadded copy of the same export. Eight rows
   * of the owner's June export did exactly that, and the two copies stopped
   * agreeing on what they held.
   *
   * Taking the padding off the text first means a padded file walks the SAME
   * three paths, in the same order, on the same bytes as an unpadded one. Tried
   * second so a line that already parses is never touched.
   */
  const PAD_SUFFIX = padColumns > 0 ? new RegExp(`(?:,[ \\t]*){${padColumns}}$`) : null
  const unpadded = (line: string): string | null => {
    if (!PAD_SUFFIX) return null
    const stripped = line.replace(PAD_SUFFIX, '')
    return stripped === line ? null : stripped
  }

  let i = 1
  while (i < lines.length) {
    const raw = lines[i]
    if (!raw.trim()) {
      i += 1
      continue // blank lines are not data and are not rejects
    }
    const lineNumber = i + 1
    out.dataLines += 1

    // The padding comes off FIRST, not as a fallback when the line will not
    // parse. Padding is a property of the file, not of the line: every data
    // line in a sheet-width export carries it. Trying the padded form first
    // looks safer and is the same trap one level up — those extra commas can
    // make a row with an unescaped quote split into exactly FIELD_COUNT fields
    // and sail through with its message cut at the wrong one.
    const raw2 = unpadded(raw) ?? raw

    // 1. Strict RFC4180 on the line as it stands. This is the path both real
    //    formats take: 2,551 of 2,551 new-format rows and 6,666 of 6,674
    //    old-format rows.
    const strict = strictSplit(raw2)
    if (strict.kind === 'ok' && strict.fields.length === FIELD_COUNT) {
      out.rows.push({ lineNumber, fields: strict.fields, repaired: false })
      i += 1
      continue
    }

    // 2. An open quoted field: pull in following lines until the record closes.
    //    Abandoned the moment joining stops helping, and it never advances past
    //    the lines it actually consumed.
    if (strict.kind === 'unterminated') {
      let joined = raw2
      let taken = 0
      let closed = false
      while (i + taken + 1 < lines.length && taken < MAX_RECORD_LINES) {
        taken += 1
        const next = lines[i + taken]
        joined += `\n${unpadded(next) ?? next}`
        const again = strictSplit(joined)
        if (again.kind === 'ok') {
          if (again.fields.length === FIELD_COUNT) {
            out.rows.push({ lineNumber, fields: again.fields, repaired: false })
            i += taken + 1
            closed = true
          }
          break
        }
        if (again.kind !== 'unterminated') break
      }
      if (closed) continue
    }

    // 3. The anchored repair, for the unescaped-quote rows.
    //
    // The padding comes off the RAW line first. REPAIR_RE is anchored at both
    // ends, so a padded line ends in commas it cannot account for and matches
    // nothing — which would quarantine exactly the rows that need repairing
    // most, in the one file that carries the padding.
    const fixed = repairSplit(raw2)
    if (fixed) {
      out.repaired += 1
      out.rows.push({ lineNumber, fields: fixed, repaired: true })
      i += 1
      continue
    }

    // 4. Kept verbatim. A vanished row is money with no trace.
    out.quarantine.push({
      lineNumber,
      raw,
      reason:
        strict.kind === 'ok'
          ? `Expected ${FIELD_COUNT} fields, found ${strict.fields.length}.`
          : 'The line is not valid CSV and the anchored repair did not match it.'
    })
    i += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface SessionWindow {
  id: string
  title: string
  streamDate: string
  startedAt: string
  endedAt: string | null
  startMs: number
}

/** `isSuspiciouslyLong` only reads the two instants; this keeps the ONE
 *  definition of "too long to be a real show" in @shared/streaming. */
function longSession(s: SessionWindow): boolean {
  return isSuspiciouslyLong({ startedAt: s.startedAt, endedAt: s.endedAt } as StreamSession)
}

/**
 * Sessions that could contain an instant in [fromMs, toMs], sorted by start.
 * Overlap, not containment: a show that started before the window and has not
 * ended still owns rows inside it. Passing null/null loads every session.
 */
function loadSessions(db: Database, fromMs: number | null, toMs: number | null): SessionWindow[] {
  const rows = db
    .prepare('SELECT id, title, stream_date, started_at, ended_at FROM stream_sessions')
    .all() as Array<{
    id: string
    title: string
    stream_date: string
    started_at: string
    ended_at: string | null
  }>
  const out: SessionWindow[] = []
  for (const r of rows) {
    const startMs = new Date(r.started_at).getTime()
    if (Number.isNaN(startMs)) continue
    if (fromMs !== null && toMs !== null) {
      const endMs = r.ended_at ? new Date(r.ended_at).getTime() : Number.POSITIVE_INFINITY
      if (!(startMs <= toMs && endMs > fromMs)) continue
    }
    out.push({
      id: r.id,
      title: r.title,
      streamDate: r.stream_date,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      startMs
    })
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out
}

/**
 * The one session containing this instant, or null.
 *
 * Sessions may not overlap (enforced in db/streaming.ts), so the only candidate
 * is the LAST one that started at or before the row — binary search finds it,
 * and `rowInSession` (half-open, shared with the renderer) decides. There is no
 * fallback to a neighbour: a row outside every window has no owner, and saying
 * so is the whole point.
 */
function matchSession(sessions: SessionWindow[], instantMs: number): SessionWindow | null {
  let lo = 0
  let hi = sessions.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sessions[mid].startMs <= instantMs) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (found < 0) return null
  const s = sessions[found]
  return rowInSession(instantMs, s.startedAt, s.endedAt) ? s : null
}

interface RowAttribution {
  session: SessionWindow | null
  attribution: LedgerAttribution
}

const UNATTRIBUTED: RowAttribution = { session: null, attribution: 'unattributed' }
/**
 * No session, but a day of its own. `session_id` stays NULL — there is no show
 * to point at — while `stream_date` is filled from the row's own local date, and
 * `attribution` says which of those two states this is. That distinction
 * matters: a row orphaned by a DELETED session also has a null session_id and a
 * leftover stream_date, and counting the two the same way would double it.
 */
const OWN_DAY: RowAttribution = { session: null, attribution: 'own_day' }

/**
 * The TWO passes, in this order, and the order is the whole design.
 *
 * PASS 1 — in-window. The row's instant fell inside a session. The strong case,
 * and it always wins: a row that is inside a show is that show's, full stop.
 *
 * PASS 2 — carry-back, for SETTLEMENT rows only. Whatnot posts a show's shipping
 * economics long after the show: subsidies batch overnight, platform charges
 * post the next morning, giveaway postage lands when the label is bought. Those
 * rows fall in the gap between two sessions, owned by neither, and leaving them
 * there forever would hand the operator a growing pile of shipping costs that no
 * amount of careful session logging could ever assign. They attach to the show
 * that most recently ENDED before them, within CARRY_BACK_MAX_HOURS.
 *
 * `carryBackEligible` decides which buckets qualify and is NOT widened here. It
 * excludes `sale` on purpose: RM runs two shows most days, and an unlogged
 * afternoon show is a solid block of real sales sitting in exactly this gap.
 * Carrying those back would fold a missing show into the previous night and the
 * operator would never find out. It also excludes `show_boost`, which is bought
 * for the show that is about to start, not the one that just finished.
 *
 * PAYOUT is attributed to nothing, ever. It is a transfer of an already-earned
 * balance to the bank — the negative mirror of the takings — so pinning it to a
 * show would cancel that show out.
 */
function attributeRow(
  bucket: LedgerBucket,
  instantMs: number,
  sessions: SessionWindow[]
): RowAttribution {
  if (bucket === 'payout' || Number.isNaN(instantMs)) return UNATTRIBUTED
  const inWindow = matchSession(sessions, instantMs)
  if (inWindow) return { session: inWindow, attribution: 'in_window' }
  // A whole-product sale that fell in no window has not lost its show — it never
  // had one. It books to the day it happened on, which is the only day it could
  // honestly belong to. Still checked AFTER the in-window pass: a box sold live
  // on stream is that show's, and the show is the better answer when there is one.
  if (booksToOwnDay(bucket)) return OWN_DAY
  if (!carryBackEligible(bucket)) return UNATTRIBUTED
  const settled = findCarryBackSession(instantMs, sessions)
  return settled ? { session: settled, attribution: 'carried_back' } : UNATTRIBUTED
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Database = ReturnType<typeof getDb>

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export function fingerprintOf(
  occurredAtIso: string,
  amount: number,
  listingId: string,
  orderId: string,
  message: string,
  txnType: string
): string {
  return createHash('sha256')
    .update(ledgerFingerprintSource(occurredAtIso, amount, listingId, orderId, message, txnType))
    .digest('hex')
}

interface ImportStats {
  inserted: number
  duplicate: number
  attributed: number
  carriedBackRows: number
  carriedBackCents: number
  unattributedRows: number
  unattributedCents: number
  /** Whole-product sales booked to their own calendar day. */
  ownDayRows: number
  ownDayCents: number
  /**
   * Which LOCAL days the unattributed money happened on, and how much on each.
   *
   * The count and the dollar total say there is a problem; only the dates say
   * what to do about it. "272 rows, $24,616.92" sends the operator hunting;
   * "Jul 26 and Jul 27 have no stream logged" is the whole task.
   */
  unattributedByDay: Map<string, { rows: number; cents: number }>
  unclassified: number
  unclassifiedExample: string | null
  firstOccurredAt: string | null
  lastOccurredAt: string | null
  /** newly inserted, attribution-eligible (non-payout) rows */
  eligible: number
  perSession: Map<string, number>
}

/**
 * Import one Whatnot ledger CSV. Parse, repair, quarantine, classify, de-dup,
 * attribute and store — all inside ONE transaction, because an import that
 * committed its rows but not its quarantine (or its rows but not its summary)
 * is a database nobody can reconcile afterwards.
 */
export function importLedger(filePath: string, actorId: string | null): Result<LedgerImportResult> {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return fail(err)
  }

  const parsed = parseLedgerCsv(text)
  if (parsed.headerError) return { ok: false, error: parsed.headerError }
  if (parsed.dataLines === 0) return { ok: false, error: 'That ledger has no data rows.' }

  const db = getDb()
  const importId = newId()
  const filename = basename(filePath)
  const ts = nowIso()

  const run = db.transaction((): Result<LedgerImportResult> => {
    db.prepare(
      `INSERT INTO ledger_imports
         (id, filename, rows_parsed, rows_imported, rows_duplicate, rows_repaired,
          rows_quarantined, first_occurred_at, last_occurred_at, warnings_json,
          created_at, created_by)
       VALUES (@id, @filename, 0, 0, 0, 0, 0, NULL, NULL, '[]', @ts, @created_by)`
    ).run({ id: importId, filename, ts, created_by: actorId })

    const quarantine = db.prepare(
      `INSERT INTO ledger_quarantine (id, import_id, line_number, raw_line, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const q of parsed.quarantine) {
      quarantine.run(newId(), importId, q.lineNumber, q.raw, q.reason, ts)
    }

    // Rows that survived parsing but whose date or amount will not read are
    // quarantined too — with the reason naming the offending cell, because
    // "row 4,812 failed" is not something anyone can act on.
    interface Staged {
      occurredAt: string
      instantMs: number
      amount: number
      listingId: string
      orderId: string
      message: string
      txnType: string
      bucket: LedgerBucket
      breakNumber: number | null
      /** The listing title, for a whole-product sale. '' for anything else. */
      productName: string
      /** The catalog product it resolved to, or '' when nothing confident. */
      productId: string
      fingerprint: string
      repaired: boolean
    }
    const staged: Staged[] = []
    let quarantinedExtra = 0

    for (const row of parsed.rows) {
      const createdRaw = row.fields[COL_CREATED]
      const amountRaw = row.fields[COL_AMOUNT]
      const occurredAt = parseLedgerDate(createdRaw)
      if (!occurredAt) {
        quarantine.run(
          newId(),
          importId,
          row.lineNumber,
          row.fields.join(','),
          `Created Date could not be read: "${createdRaw}"`,
          ts
        )
        quarantinedExtra += 1
        continue
      }
      // `parseLedgerAmount` owns every money shape Whatnot has shipped: "$1.00",
      // "-$4.15", "($4.15)" and "$139.21 " with its trailing pad. It is the ONLY
      // place that knows parentheses mean negative, and it returns null rather
      // than guessing — which is what puts an unreadable cell in quarantine
      // instead of into the P&L as a confident zero. A $0.00 row is real and
      // common (381 of 636 shipping subsidies are zero) and must still import.
      const amount = parseLedgerAmount(amountRaw)
      if (amount === null) {
        quarantine.run(
          newId(),
          importId,
          row.lineNumber,
          row.fields.join(','),
          `Amount could not be read: "${amountRaw}"`,
          ts
        )
        quarantinedExtra += 1
        continue
      }
      const message = row.fields[COL_MESSAGE]
      const txnType = row.fields[COL_TYPE]
      const listingId = row.fields[COL_LISTING]
      const orderId = row.fields[COL_ORDER]
      const bucket = classifyLedgerRow(txnType, message, isAnyLeagueTeam)
      // Only a whole-product sale names a product. Handing a break-spot title to
      // the matcher would find the box the break was cut from and book a sale
      // against stock that was opened days ago.
      const productName = bucket === 'product_sale' ? parseProductSaleName(message) : ''
      const matched = productName ? matchProductByName(productName) : null
      staged.push({
        occurredAt,
        instantMs: new Date(occurredAt).getTime(),
        amount,
        listingId,
        orderId,
        message,
        txnType,
        bucket,
        breakNumber: parseBreakNumber(message),
        productName,
        // An ambiguous match is left unresolved rather than guessed. Two boxes
        // the app cannot tell apart is a fact for a person to settle.
        productId: matched && !matched.ambiguous ? matched.product.id : '',
        fingerprint: fingerprintOf(occurredAt, amount, listingId, orderId, message, txnType),
        repaired: row.repaired
      })
    }

    const stats: ImportStats = {
      inserted: 0,
      duplicate: 0,
      attributed: 0,
      carriedBackRows: 0,
      carriedBackCents: 0,
      unattributedRows: 0,
      unattributedCents: 0,
      ownDayRows: 0,
      ownDayCents: 0,
      unattributedByDay: new Map(),
      unclassified: 0,
      unclassifiedExample: null,
      firstOccurredAt: null,
      lastOccurredAt: null,
      eligible: 0,
      perSession: new Map()
    }

    let minMs = Number.POSITIVE_INFINITY
    let maxMs = Number.NEGATIVE_INFINITY
    for (const s of staged) {
      if (s.instantMs < minMs) minMs = s.instantMs
      if (s.instantMs > maxMs) maxMs = s.instantMs
    }
    // Widened by the carry-back bound at the front: a show that ENDED before the
    // first row of this import is exactly the show those first settlement rows
    // belong to, and a window that started at the first row would never load it.
    const sessions =
      staged.length > 0
        ? loadSessions(db, minMs - CARRY_BACK_MAX_HOURS * 3600_000, maxMs)
        : ([] as SessionWindow[])
    const sessionById = new Map(sessions.map((s) => [s.id, s]))

    const insert = db.prepare(
      `INSERT INTO ledger_rows
         (id, import_id, occurred_at, amount, order_id, listing_id, message, txn_type,
          bucket, session_id, stream_date, attribution, break_number, fingerprint, repaired,
          classifier_version, product_name, product_id, created_at)
       VALUES (@id, @import_id, @occurred_at, @amount, @order_id, @listing_id, @message,
               @txn_type, @bucket, @session_id, @stream_date, @attribution, @break_number,
               @fingerprint, @repaired, @classifier_version, @product_name, @product_id,
               @created_at)
       ON CONFLICT(fingerprint) DO NOTHING`
    )

    /**
     * COVERAGE, recorded for every row in the file — the ones it inserted AND
     * the ones it found already stored.
     *
     * This is what stops a delete from taking money a file still in the list
     * contains. Without it the only record is "who inserted it first", so
     * removing an older overlapping export cascaded away rows the newer one
     * covered, leaving that newer card looking complete with its first days
     * empty and nothing on screen to say so.
     */
    const cover = db.prepare(
      'INSERT OR IGNORE INTO ledger_row_imports (row_id, import_id) VALUES (?, ?)'
    )
    const idOfFingerprint = db.prepare('SELECT id FROM ledger_rows WHERE fingerprint = ?')

    for (const s of staged) {
      const found = attributeRow(s.bucket, s.instantMs, sessions)
      const match = found.session
      const rowId = newId()
      const info = insert.run({
        id: rowId,
        import_id: importId,
        occurred_at: s.occurredAt,
        amount: s.amount,
        order_id: s.orderId || null,
        listing_id: s.listingId || null,
        message: s.message,
        txn_type: s.txnType,
        bucket: s.bucket,
        session_id: match ? match.id : null,
        // A day WITHOUT a session: own-day rows carry a stream_date and no
        // session_id, which is the pair that tells them apart from a row whose
        // session was later deleted.
        stream_date: match
          ? match.streamDate
          : found.attribution === 'own_day'
            ? streamDateOf(s.occurredAt)
            : null,
        attribution: found.attribution,
        break_number: s.breakNumber,
        fingerprint: s.fingerprint,
        repaired: s.repaired ? 1 : 0,
        classifier_version: LEDGER_CLASSIFIER_VERSION,
        // The product name is kept whether or not it matched. A catalog that
        // gains the box next week can re-run the match; a name thrown away at
        // import cannot be recovered from anything.
        product_name: s.productName || null,
        product_id: s.productId || null,
        created_at: ts
      })
      if (info.changes === 0) {
        // Already imported — an overlapping week re-uploaded, which must be a
        // no-op rather than an error or a second copy of the money. It is NOT a
        // no-op for coverage though: this file demonstrably contains that row,
        // and saying so here is what protects the row when the import that first
        // saw it is deleted.
        stats.duplicate += 1
        const existing = idOfFingerprint.get(s.fingerprint) as { id: string } | undefined
        if (existing) cover.run(existing.id, importId)
        continue
      }
      cover.run(rowId, importId)
      stats.inserted += 1
      if (!stats.firstOccurredAt || s.occurredAt < stats.firstOccurredAt) {
        stats.firstOccurredAt = s.occurredAt
      }
      if (!stats.lastOccurredAt || s.occurredAt > stats.lastOccurredAt) {
        stats.lastOccurredAt = s.occurredAt
      }
      if (s.bucket === 'unclassified') {
        stats.unclassified += 1
        if (!stats.unclassifiedExample) stats.unclassifiedExample = s.message
      }
      if (s.bucket === 'payout') continue
      stats.eligible += 1
      if (match) {
        stats.attributed += 1
        stats.perSession.set(match.id, (stats.perSession.get(match.id) ?? 0) + 1)
        if (found.attribution === 'carried_back') {
          stats.carriedBackRows += 1
          stats.carriedBackCents += toCents(s.amount)
        }
      } else if (found.attribution === 'own_day') {
        // Attributed, just not to a show. Counting it as unattributed would put
        // real revenue in the "you forgot to log a stream" pile forever.
        stats.attributed += 1
        stats.ownDayRows += 1
        stats.ownDayCents += toCents(s.amount)
      } else {
        stats.unattributedRows += 1
        stats.unattributedCents += toCents(s.amount)
        // Keyed on the row's OWN local date — it has no session to borrow one
        // from, and its own day is exactly the day a session is missing.
        const key = streamDateOf(s.occurredAt)
        const bucketDay = stats.unattributedByDay.get(key) ?? { rows: 0, cents: 0 }
        bucketDay.rows += 1
        bucketDay.cents += toCents(s.amount)
        stats.unattributedByDay.set(key, bucketDay)
      }
    }

    const rowsQuarantined = parsed.quarantine.length + quarantinedExtra
    const warnings = buildWarnings(stats, sessionById, rowsQuarantined, parsed.repaired)

    db.prepare(
      `UPDATE ledger_imports
          SET rows_parsed = @parsed, rows_imported = @imported, rows_duplicate = @duplicate,
              rows_repaired = @repaired, rows_quarantined = @quarantined,
              first_occurred_at = @first, last_occurred_at = @last, warnings_json = @warnings
        WHERE id = @id`
    ).run({
      id: importId,
      parsed: staged.length,
      imported: stats.inserted,
      duplicate: stats.duplicate,
      repaired: parsed.repaired,
      quarantined: rowsQuarantined,
      first: stats.firstOccurredAt,
      last: stats.lastOccurredAt,
      warnings: JSON.stringify(warnings)
    })

    /**
     * A RE-UPLOAD OF THE SAME FILE LEAVES NO SECOND ENTRY.
     *
     * Uploading a file twice — easy to do, and safe, since every row de-dupes —
     * used to add an import that owned nothing. The list then filled with
     * identical-looking cards, only one of which held any rows, and deleting the
     * wrong one looked like it did nothing while deleting the right one emptied
     * a file that appeared to still be there.
     *
     * So: nothing new AND a file of this name already imported means the
     * existing entry absorbs it. Its COVERAGE is merged first, which is the part
     * that matters — the observations recorded above are the row's protection,
     * and they must not vanish with the record they were attached to. Quarantine
     * rows go with it; the earlier import already holds the same ones.
     *
     * A file with a DIFFERENT name that added nothing new still gets its entry.
     * It is not clutter: it demonstrably covers rows, and that coverage is now
     * load-bearing when another import is deleted.
     */
    if (stats.inserted === 0) {
      const prior = db
        .prepare(
          `SELECT id FROM ledger_imports
            WHERE filename = @filename AND id <> @id
            ORDER BY created_at ASC LIMIT 1`
        )
        .get({ filename, id: importId }) as { id: string } | undefined
      if (prior) {
        db.prepare(
          `INSERT OR IGNORE INTO ledger_row_imports (row_id, import_id)
           SELECT row_id, @prior FROM ledger_row_imports WHERE import_id = @id`
        ).run({ prior: prior.id, id: importId })
        db.prepare('DELETE FROM ledger_imports WHERE id = ?').run(importId)
        const kept = getImport(db, prior.id)
        if (!kept) return { ok: false, error: 'The import record could not be read back.' }
        return { ok: true, data: { import: kept, view: buildView(db) } }
      }
    }

    const record = getImport(db, importId)
    if (!record) return { ok: false, error: 'The import record could not be read back.' }
    return { ok: true, data: { import: record, view: buildView(db) } }
  })

  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

/**
 * What the operator has to be told, in the order it matters.
 *
 * The vacuum warning is first because it is the most destructive failure mode
 * this feature has: a forgotten "End stream" leaves a session running to
 * +Infinity, and it will quietly swallow every subsequent row in the file —
 * next week's shows, batched shipping subsidies, everything — producing a
 * plausible, precisely wrong day total that nothing else flags.
 */
/** "2026-07-26" -> "Sun 26 Jul". Short enough to list several, explicit
 *  enough that nobody has to work out which July the 26th belongs to. */
function shortDay(dayKey: string): string {
  const [y, m, d] = (dayKey || '').split('-').map(Number)
  if (!y || !m || !d) return dayKey
  const dt = new Date(y, m - 1, d)
  if (Number.isNaN(dt.getTime())) return dayKey
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${DAYS[dt.getDay()]} ${d} ${MON[m - 1]}`
}

function buildWarnings(
  stats: ImportStats,
  sessionById: Map<string, SessionWindow>,
  rowsQuarantined: number,
  rowsRepaired: number
): string[] {
  const warnings: string[] = []

  for (const [sessionId, count] of stats.perSession) {
    const session = sessionById.get(sessionId)
    if (!session) continue
    const share = stats.eligible > 0 ? count / stats.eligible : 0
    if (share > SESSION_VACUUM_SHARE) {
      const name = session.title.trim() || 'an untitled stream'
      const tail = session.endedAt
        ? ''
        : ' It has no end time, so it runs to the end of time and will keep absorbing every later row.'
      warnings.push(
        `"${name}" (${session.streamDate}) absorbed ${count} of ${stats.eligible} rows ` +
          `(${Math.round(share * 100)}% of this import).${tail} Check its end time before trusting these day totals.`
      )
    } else if (!session.endedAt || longSession(session)) {
      const name = session.title.trim() || 'an untitled stream'
      warnings.push(
        `"${name}" (${session.streamDate}) is ${session.endedAt ? 'longer than 12 hours' : 'still live with no end time'} ` +
          `and took ${count} rows. A forgotten "End stream" attributes money to the wrong show.`
      )
    }
  }

  if (rowsQuarantined > 0) {
    warnings.push(
      `${rowsQuarantined} line${rowsQuarantined === 1 ? '' : 's'} could not be read and ${rowsQuarantined === 1 ? 'was' : 'were'} ` +
        `quarantined. Every total below is incomplete until they are cleared — the raw lines are kept.`
    )
  }

  if (stats.unclassified > 0) {
    warnings.push(
      `${stats.unclassified} row${stats.unclassified === 1 ? '' : 's'} had an unrecognised message and ` +
        `${stats.unclassified === 1 ? 'was' : 'were'} counted at face value: ` +
        `"${(stats.unclassifiedExample ?? '').slice(0, 90)}".`
    )
  }

  // NOT an error, and worded so it does not read like one. The owner's
  // instruction is explicit: "if a stream isn't in the streaming schedule, don't
  // worry about that ledger row, just let it be." So the money is kept, counted
  // and shown, the import succeeds, and nothing waits on the operator.
  //
  // EVERY WARNING HERE IS ONE SENTENCE: what happened, then what to do about it.
  // They used to explain the mechanism and the reasoning too — why sales are
  // never carried back, what "outside every show" means, that rows are stored
  // rather than dropped — which is all true and none of it is what someone
  // reading a yellow box wants. The reasoning lives in the code; the box gets
  // the finding and the fix.
  if (stats.unattributedRows > 0) {
    // TWO different problems wearing the same number, and they have different
    // fixes — so they get different sentences.
    //
    //   no session at all on that day  -> a show was never logged
    //   a session exists, money outside -> a SECOND show that day, or the times
    //                                      on the logged one are wrong
    //
    // RM runs two shows most days, so the second case is the common one, and
    // telling somebody "no stream is logged for Sunday" when they logged one
    // sends them looking for a bug that is not there.
    const logged = new Set<string>()
    for (const w of sessionById.values()) if (w.streamDate) logged.add(w.streamDate)

    const missing: Array<[string, number]> = []
    const outside: Array<[string, number]> = []
    for (const [day, v] of stats.unattributedByDay) {
      if (!day) continue
      ;(logged.has(day) ? outside : missing).push([day, v.cents])
    }
    const byDay = (a: [string, number], b: [string, number]): number => (a[0] < b[0] ? -1 : 1)
    missing.sort(byDay)
    outside.sort(byDay)

    const phrase = (days: Array<[string, number]>): string => {
      const shown = days.slice(0, 5).map(([d]) => shortDay(d))
      const more = days.length - shown.length
      const list =
        shown.length === 1
          ? shown[0]
          : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
      return more > 0 ? `${list} (+${more} more)` : list
    }
    const sum = (days: Array<[string, number]>): number => days.reduce((a, [, c]) => a + c, 0)

    if (missing.length > 0) {
      warnings.push(
        `${money(sum(missing))} on ${phrase(missing)} has no show logged. ` +
          `Add ${missing.length === 1 ? 'it' : 'them'} in Streaming, then Re-attribute.`
      )
    }
    if (outside.length > 0) {
      warnings.push(
        `${money(sum(outside))} on ${phrase(outside)} fell outside the logged hours. ` +
          `Add the second show, or widen the times.`
      )
    }
    if (missing.length === 0 && outside.length === 0) {
      warnings.push(`${money(stats.unattributedCents)} is not inside any logged show.`)
    }
  }

  if (stats.carriedBackRows > 0) {
    // Previously this explained the mechanism and the design rationale. The
    // operator does not need either — they need to know their shipping numbers
    // landed on the right day and that nothing is missing.
    warnings.push(
      `${stats.carriedBackRows} late shipping and fee row${stats.carriedBackRows === 1 ? '' : 's'} ` +
        `(${money(stats.carriedBackCents)}) ${stats.carriedBackRows === 1 ? 'was' : 'were'} counted on ` +
        `the show that caused ${stats.carriedBackRows === 1 ? 'it' : 'them'}. Nothing to do.`
    )
  }

  if (rowsRepaired > 0) {
    warnings.push(
      `${rowsRepaired} line${rowsRepaired === 1 ? '' : 's'} ${rowsRepaired === 1 ? 'was' : 'were'} repaired — ` +
        `Whatnot writes titles with unescaped quotes. Nothing was lost.`
    )
  }

  return warnings
}

// ---------------------------------------------------------------------------
// Reattribution / reclassification
// ---------------------------------------------------------------------------

export interface ReattributeSummary {
  rowsExamined: number
  rowsMoved: number
  rowsReclassified: number
  inWindow: number
  carriedBack: number
  unattributed: number
}

/**
 * Re-run attribution over EVERY stored row against the sessions as they are now,
 * and re-run classification for rows stamped with an older classifier.
 *
 * This is the fix for unattributed money, and it is deliberately data entry
 * rather than a heuristic: the operator sees "$113,049 outside every show", adds
 * the session they forgot to log, and the rows move to it here. Nothing is
 * re-read from the CSV — the file may be gone, and re-parsing risks a different
 * repair producing a different fingerprint for the same money.
 */
export function reattributeAll(actorId: string | null): Result<ReattributeSummary> {
  void actorId
  const db = getDb()
  const run = db.transaction((): Result<ReattributeSummary> => {
    const sessions = loadSessions(db, null, null)
    const rows = db
      .prepare(
        `SELECT id, occurred_at, message, txn_type, bucket, session_id, stream_date, attribution,
                classifier_version
           FROM ledger_rows`
      )
      .all() as Array<{
      id: string
      occurred_at: string
      message: string
      txn_type: string
      bucket: string
      session_id: string | null
      stream_date: string | null
      attribution: string
      classifier_version: number
    }>

    const update = db.prepare(
      `UPDATE ledger_rows
          SET bucket = ?, session_id = ?, stream_date = ?, attribution = ?, break_number = ?,
              classifier_version = ?
        WHERE id = ?`
    )

    const summary: ReattributeSummary = {
      rowsExamined: rows.length,
      rowsMoved: 0,
      rowsReclassified: 0,
      inWindow: 0,
      carriedBack: 0,
      unattributed: 0
    }

    for (const r of rows) {
      const stale = r.classifier_version !== LEDGER_CLASSIFIER_VERSION
      // Classification is DERIVED, so it is recomputed from the stored raw
      // fields rather than trusted. A database holding two generations of
      // answers at once is one whose totals change between versions with no
      // explanation.
      const bucket = stale
        ? classifyLedgerRow(r.txn_type, r.message, isAnyLeagueTeam)
        : (r.bucket as LedgerBucket)
      const instantMs = new Date(r.occurred_at).getTime()
      // BOTH passes, exactly as an import runs them — otherwise adding a session
      // would re-home in-window rows while leaving that show's own settlement
      // rows stranded, and the two paths would disagree about the same money.
      const found = attributeRow(bucket, instantMs, sessions)
      const sessionId = found.session ? found.session.id : null
      // THREE cases, exactly as the import writes them — see the same expression
      // at the staging insert above. The own-day branch was missing here, and
      // its absence was invisible until something re-attributed the whole table
      // at once.
      //
      // A row that books to its own day carries a stream_date and NO session_id.
      // Dropping the date while keeping the `own_day` label put such a row
      // outside BOTH halves of the reconciliation: the day query wants a date it
      // no longer had, and the unattributed query skips anything labelled
      // own_day. The row still counted in the stored total, so the screen said
      // "these numbers do not add up" and the row's money — a real marketplace
      // sale — silently left the statement.
      //
      // Repair needs no migration and no backfill. `movedNow` below compares the
      // computed date against the stored one, so every row this damaged differs
      // and gets rewritten on the next re-attribution. The date was never lost:
      // it is derived from occurred_at, which nothing here has ever written to.
      const streamDate = found.session
        ? found.session.streamDate
        : found.attribution === 'own_day'
          ? streamDateOf(r.occurred_at)
          : null

      if (bucket !== 'payout') {
        if (found.attribution === 'in_window') summary.inWindow += 1
        else if (found.attribution === 'carried_back') summary.carriedBack += 1
        else summary.unattributed += 1
      }

      const movedNow =
        sessionId !== r.session_id ||
        streamDate !== r.stream_date ||
        found.attribution !== r.attribution
      const reclassedNow = stale && bucket !== r.bucket
      if (!movedNow && !stale) continue

      update.run(
        bucket,
        sessionId,
        streamDate,
        found.attribution,
        parseBreakNumber(r.message),
        LEDGER_CLASSIFIER_VERSION,
        r.id
      )
      if (movedNow) summary.rowsMoved += 1
      if (reclassedNow) summary.rowsReclassified += 1
    }
    return { ok: true, data: summary }
  })

  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

interface ImportRow {
  id: string
  filename: string
  rows_parsed: number
  rows_imported: number
  rows_duplicate: number
  rows_repaired: number
  rows_quarantined: number
  first_occurred_at: string | null
  last_occurred_at: string | null
  warnings_json: string | null
  created_at: string
  created_by: string | null
}

/**
 * Attribution counts are DERIVED, never stored on the import: the operator adds
 * a missing session and money moves from unattributed to a show without the
 * import being touched. A stored count would be a number that silently went
 * stale the moment the thing it describes was fixed.
 */
function toImport(row: ImportRow, db: Database): LedgerImport {
  const agg = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN session_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS attributed,
         COALESCE(SUM(CASE WHEN session_id IS NULL THEN 1 ELSE 0 END), 0) AS unattributed,
         COALESCE(SUM(CASE WHEN session_id IS NULL THEN CAST(ROUND(amount * 100) AS INTEGER) ELSE 0 END), 0) AS cents
       FROM ledger_rows WHERE import_id = ? AND bucket <> 'payout'`
    )
    .get(row.id) as { attributed: number; unattributed: number; cents: number }

  let warnings: string[] = []
  try {
    const parsed = JSON.parse(row.warnings_json || '[]')
    if (Array.isArray(parsed)) warnings = parsed.filter((w): w is string => typeof w === 'string')
  } catch {
    warnings = []
  }

  return {
    id: row.id,
    filename: row.filename,
    rowsParsed: row.rows_parsed,
    rowsImported: row.rows_imported,
    rowsDuplicate: row.rows_duplicate,
    rowsRepaired: row.rows_repaired,
    rowsQuarantined: row.rows_quarantined,
    attributedRows: agg.attributed,
    unattributedRows: agg.unattributed,
    unattributedAmount: toDollars(agg.cents),
    firstOccurredAt: row.first_occurred_at,
    lastOccurredAt: row.last_occurred_at,
    warnings,
    createdAt: row.created_at,
    createdBy: row.created_by
  }
}

const IMPORT_SELECT = `
  SELECT id, filename, rows_parsed, rows_imported, rows_duplicate, rows_repaired,
         rows_quarantined, first_occurred_at, last_occurred_at, warnings_json,
         created_at, created_by
    FROM ledger_imports
`

function getImport(db: Database, id: string): LedgerImport | null {
  const row = db.prepare(`${IMPORT_SELECT} WHERE id = ?`).get(id) as ImportRow | undefined
  return row ? toImport(row, db) : null
}

export function listImports(): LedgerImport[] {
  const db = getDb()
  const rows = db.prepare(`${IMPORT_SELECT} ORDER BY created_at DESC, rowid DESC`).all() as ImportRow[]
  return rows.map((r) => toImport(r, db))
}

/**
 * How much of an import is only in that import.
 *
 * Read before the confirmation is shown, so "delete this file" can say what
 * will actually leave the P&L rather than quoting the file's own row count and
 * being wrong by however much another export also covers.
 */
export function importDeleteImpact(id: string): {
  exists: boolean
  /** Rows currently owned by this import. */
  owned: number
  /** Of those, how many another import also covers — these SURVIVE, re-pointed. */
  covered: number
  /** owned − covered. The money that genuinely leaves. */
  losing: number
  /** Signed sum of the rows that leave. */
  losingAmount: number
} {
  const db = getDb()
  const exists = !!db.prepare('SELECT 1 FROM ledger_imports WHERE id = ?').get(id)
  if (!exists) return { exists: false, owned: 0, covered: 0, losing: 0, losingAmount: 0 }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS owned,
              COALESCE(SUM(CASE WHEN EXISTS (
                SELECT 1 FROM ledger_row_imports o
                 WHERE o.row_id = r.id AND o.import_id <> @id
              ) THEN 1 ELSE 0 END), 0) AS covered,
              -- Payouts EXCLUDED, and summed in integer cents like every other
              -- aggregate in this file. A payout is the negative mirror of the
              -- week's earnings, so including them collapsed this figure toward
              -- zero: the confirmation offered to delete "1,200 ledger rows worth
              -- $9.94" when the money actually leaving was tens of thousands.
              -- The ROW COUNT still counts every row, payouts included — the
              -- modal's "N ledger rows" is legitimately about all of them.
              COALESCE(SUM(CASE
                WHEN r.bucket = 'payout' THEN 0
                WHEN EXISTS (
                  SELECT 1 FROM ledger_row_imports o
                   WHERE o.row_id = r.id AND o.import_id <> @id
                ) THEN 0
                ELSE CAST(ROUND(r.amount * 100) AS INTEGER)
              END), 0) AS losing_cents
         FROM ledger_rows r
        WHERE r.import_id = @id`
    )
    .get({ id }) as { owned: number; covered: number; losing_cents: number }
  return {
    exists: true,
    owned: row.owned,
    covered: row.covered,
    losing: row.owned - row.covered,
    losingAmount: toDollars(row.losing_cents)
  }
}

/**
 * Undo an upload.
 *
 * A row leaves the P&L only when NOTHING still covers it. Anything another
 * import also contains is re-pointed to that import first and survives.
 *
 * That re-point is the whole change. Before it, a row belonged to the import
 * that FIRST inserted it and the cascade took it regardless — so deleting an
 * older overlapping export removed rows that a file still sitting in the list
 * contained, and that file's card went on reporting its full row count with its
 * first days now empty. The money came back only if you happened to know to
 * re-upload it.
 *
 * Order matters: re-point survivors, THEN delete the import. Whatever still
 * points at it afterwards is by definition covered by nothing else, and the
 * cascade is exactly right for those.
 */
export function deleteImport(id: string, actorId: string | null): Result<StreamingFinanceView> {
  void actorId
  const db = getDb()
  const run = db.transaction((): Result<StreamingFinanceView> => {
    if (!db.prepare('SELECT 1 FROM ledger_imports WHERE id = ?').get(id)) {
      return { ok: false, error: 'That import no longer exists.' }
    }
    db.prepare(
      `UPDATE ledger_rows
          SET import_id = (
                SELECT o.import_id FROM ledger_row_imports o
                 WHERE o.row_id = ledger_rows.id AND o.import_id <> @id
                 LIMIT 1)
        WHERE import_id = @id
          AND EXISTS (SELECT 1 FROM ledger_row_imports o
                       WHERE o.row_id = ledger_rows.id AND o.import_id <> @id)`
    ).run({ id })
    db.prepare('DELETE FROM ledger_imports WHERE id = ?').run(id)
    return { ok: true, data: buildView(db) }
  })
  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface LedgerRowFilter {
  streamDate?: string
  sessionId?: string
  bucket?: string
  unattributed?: boolean
  limit?: number
}

/** Exported with `toLedgerRow` and `LEDGER_ROW_COLUMNS` below, so the drill-down
 *  reads a ledger row through the same three pieces this module does rather than
 *  keeping a second, slowly diverging copy of the column list. */
export interface RawLedgerRow {
  id: string
  import_id: string
  occurred_at: string
  amount: number
  order_id: string | null
  listing_id: string | null
  message: string
  txn_type: string
  bucket: string
  session_id: string | null
  stream_date: string | null
  attribution: string
  break_number: number | null
  fingerprint: string
  repaired: number
  classifier_version: number
}

/** Every column `RawLedgerRow` needs, in one string. A SELECT that drifts from
 *  the interface produces undefined fields on a screen rather than an error. */
export const LEDGER_ROW_COLUMNS =
  `id, import_id, occurred_at, amount, order_id, listing_id, message, txn_type,
   bucket, session_id, stream_date, attribution, break_number, fingerprint, repaired,
   classifier_version`

export function toLedgerRow(r: RawLedgerRow): LedgerRow {
  return {
    id: r.id,
    importId: r.import_id,
    occurredAt: r.occurred_at,
    amount: r.amount,
    orderId: r.order_id,
    listingId: r.listing_id,
    message: r.message,
    txnType: r.txn_type,
    bucket: r.bucket as LedgerBucket,
    sessionId: r.session_id,
    streamDate: r.stream_date,
    attribution: r.attribution as LedgerAttribution,
    breakNumber: r.break_number,
    fingerprint: r.fingerprint,
    repaired: r.repaired === 1,
    classifierVersion: r.classifier_version
  }
}

const ROW_LIMIT_DEFAULT = 500
const ROW_LIMIT_MAX = 20000

export function listRows(filter: LedgerRowFilter): LedgerRow[] {
  const db = getDb()
  const where: string[] = []
  const args: Record<string, unknown> = {}

  if (filter?.streamDate) {
    // Day filters read the ATTRIBUTED rows only, so a row orphaned by a deleted
    // session (session_id SET NULL, stale stream_date) shows up under
    // `unattributed` and not on a day it no longer belongs to.
    where.push('stream_date = @streamDate AND session_id IS NOT NULL')
    args.streamDate = filter.streamDate
  }
  if (filter?.sessionId) {
    where.push('session_id = @sessionId')
    args.sessionId = filter.sessionId
  }
  if (filter?.bucket) {
    where.push('bucket = @bucket')
    args.bucket = filter.bucket
  }
  if (filter?.unattributed) {
    where.push("session_id IS NULL AND bucket <> 'payout'")
  }

  const limit = Math.min(
    Math.max(1, Math.round(Number(filter?.limit) || ROW_LIMIT_DEFAULT)),
    ROW_LIMIT_MAX
  )
  const sql =
    `SELECT ${LEDGER_ROW_COLUMNS}
       FROM ledger_rows
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, rowid DESC
      LIMIT ${limit}`
  return (db.prepare(sql).all(args) as RawLedgerRow[]).map(toLedgerRow)
}

// ---------------------------------------------------------------------------
// The day-by-day view
// ---------------------------------------------------------------------------

/**
 * Every money field a day carries, and the empty day they start from.
 *
 * BOTH COME FROM THE CONTRACT. They used to be declared here, which was fine
 * while main was the only thing that summed days; the renderer now sums an
 * arbitrary calendar range, and a second copy of this list is a range total
 * that disagrees with the week it sits inside. Named once, in the one file
 * both sides already import.
 *
 * The fields worth knowing about while reading the rollups below:
 * `giveawayLoss` comes from the Streaming module rather than the ledger and is
 * kept equal to `giveawayCost`; the cost-of-goods fields are all NEGATIVE and
 * also come from `stream_items`, and they roll up through the same accumulator
 * as everything else because a period that summed the biggest cost of running
 * a show differently from its own days would be worse than no period at all.
 */
const MONEY_FIELDS = PNL_MONEY_FIELDS
const COUNT_FIELDS = PNL_COUNT_FIELDS

type MoneyField = PnlMoneyField
type CountField = PnlCountField

const emptyDay = emptyDayFinance

/**
 * A rollup in progress. Money accumulates in INTEGER CENTS and converts back to
 * dollars exactly once, at the end — adding 27 day figures as floats and then
 * comparing the result to another float sum is how a reconciliation check
 * reports a phantom cent.
 */
interface Rollup {
  money: Map<MoneyField, number>
  counts: Map<CountField, number>
  /** Every rate the days inside this period were charged at. */
  rates: RateSlice[]
  /** Every product cost and every whole-product sale on those days, unmerged.
   *  Folding happens once, at the end, in the contract's own merge — so a week
   *  cannot itemise a product differently from the days inside it. */
  cogsItems: CogsItem[]
  marketplace: MarketplaceItem[]
  dates: string[]
}

function newRollup(): Rollup {
  return {
    money: new Map(),
    counts: new Map(),
    rates: [],
    cogsItems: [],
    marketplace: [],
    dates: []
  }
}

/**
 * Add ONE day to a rollup — the only way a week, a month or the grand total is
 * ever built.
 *
 * Every field is SUMMED, including the fees and the derived gross. A period
 * CANNOT re-derive them: the flat card charge is levied per ROW and the terms
 * come from each row's own BUSINESS DAY, and a month's net-sales total has lost
 * both facts. Running `deriveSaleFee` on it would levy one flat charge for the
 * month on one set of terms for the whole span. The derivation happens once, per
 * row; everything above a row adds.
 *
 * The rate breakdown rides along rather than being dropped at the day boundary:
 * a month is the shape MOST likely to span a rate change, and a month that lost
 * the slices would go back to printing the very blended quotient the days below
 * it now refuse to print.
 */
function addDay(roll: Rollup, day: StreamDayFinance): void {
  const fields = day as unknown as Record<string, number>
  for (const f of MONEY_FIELDS) roll.money.set(f, (roll.money.get(f) ?? 0) + toCents(fields[f]))
  for (const f of COUNT_FIELDS) roll.counts.set(f, (roll.counts.get(f) ?? 0) + fields[f])
  if (Array.isArray(day.rateBreakdown)) roll.rates.push(...day.rateBreakdown)
  if (Array.isArray(day.cogsBreakdown)) roll.cogsItems.push(...day.cogsBreakdown)
  if (Array.isArray(day.marketplaceBreakdown)) roll.marketplace.push(...day.marketplaceBreakdown)
  roll.dates.push(day.streamDate)
}

/**
 * The summed body shared by `StreamFinanceTotals` and `FinancePeriodRow`.
 *
 * Built by starting from an empty DAY and stripping the two day-only fields, so
 * that a field added to `StreamDayFinance` cannot be silently absent from a
 * period — it would be present and zero, and the reconciliation would catch it.
 */
function rollupBody(roll: Rollup): Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'> {
  const out = emptyDay('') as unknown as Record<string, unknown>
  for (const f of MONEY_FIELDS) out[f] = toDollars(roll.money.get(f) ?? 0)
  for (const f of COUNT_FIELDS) out[f] = roll.counts.get(f) ?? 0
  // Neither money nor a count, so all three are carried by hand — each through
  // the contract's own merge, in cents, so a month's slices still sum to the
  // month's gross and a month's product lines still sum to its cost of goods.
  out.rateBreakdown = mergeRateSlices(roll.rates)
  out.cogsBreakdown = mergeCogsItems(roll.cogsItems)
  out.marketplaceBreakdown = mergeMarketplaceItems(roll.marketplace)
  delete out.streamDate
  delete out.sessionTitles
  return out as unknown as Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>
}

function emptyTotals(): StreamFinanceTotals {
  return { ...rollupBody(newRollup()), dayCount: 0 }
}

function emptyUnattributed(): UnattributedSummary {
  return {
    rowCount: 0,
    amount: 0,
    firstOccurredAt: null,
    lastOccurredAt: null,
    byBucket: [],
    clusters: [],
    byDay: []
  }
}

export function emptyView(): StreamingFinanceView {
  return {
    days: [],
    weeks: [],
    months: [],
    totals: emptyTotals(),
    unattributed: emptyUnattributed(),
    imports: [],
    reconciled: true,
    reconcileNote: null
  }
}

// ---------------------------------------------------------------------------
// Week and month keys
//
// A business day is a plain 'YYYY-MM-DD' string with no time and no zone. It is
// read into a UTC instant purely so the weekday arithmetic has somewhere to
// happen — using the local constructor here would let the machine's timezone
// decide which week a day belongs to, and a day that changes week when the
// laptop travels is a period total that changes with it.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTH_LONG = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
]

function dayUtcMs(streamDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(streamDate)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const ms = Date.UTC(year, month, day)
  const d = new Date(ms)
  // Reject a date the calendar rolled over rather than accepting JS's silent
  // normalisation of "2026-02-31" to March 3.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    return null
  }
  return ms
}

/** Weeks start MONDAY. */
function mondayOf(ms: number): number {
  const dow = new Date(ms).getUTCDay() // 0 Sun … 6 Sat
  return ms - ((dow + 6) % 7) * DAY_MS
}

/**
 * ISO-8601 week number and week-YEAR, taken from the Thursday of the week. The
 * week-year is not always the calendar year of the Monday: the week of Mon 2025
 * Dec 29 is 2026-W01, and keying it '2025-W01' would file it next to the
 * previous January.
 */
function isoWeekKey(mondayMs: number): string {
  const thursday = new Date(mondayMs + 3 * DAY_MS)
  const year = thursday.getUTCFullYear()
  const jan1 = Date.UTC(year, 0, 1)
  const week = Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

function weekLabel(mondayMs: number): string {
  const d = new Date(mondayMs)
  return `Week of ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`
}

function monthLabel(streamDate: string): string {
  const ms = dayUtcMs(streamDate)
  if (ms === null) return streamDate
  const d = new Date(ms)
  return `${MONTH_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

interface PeriodPlan {
  key: string
  label: string
}

/**
 * Which week a business day rolls into. A day whose date does not parse gets a
 * period of its own rather than being dropped — a malformed `stream_date` is a
 * bug to find, not money to lose.
 */
function weekOf(streamDate: string): PeriodPlan {
  const ms = dayUtcMs(streamDate)
  if (ms === null) return { key: streamDate, label: streamDate }
  const monday = mondayOf(ms)
  return { key: isoWeekKey(monday), label: weekLabel(monday) }
}

function monthOf(streamDate: string): PeriodPlan {
  const ms = dayUtcMs(streamDate)
  if (ms === null) return { key: streamDate, label: streamDate }
  return { key: streamDate.slice(0, 7), label: monthLabel(streamDate) }
}

/**
 * Roll the day rows into periods BY SUMMING THEM. Nothing here reads the row
 * table: `days` is the only input, so a period is a sum of exactly the days on
 * screen and cannot disagree with them.
 *
 * `from`, `to` and `dayCount` describe the days that are actually PRESENT, not
 * the calendar extent of the period — a week containing two shows reports those
 * two days, because "7 days" would imply five days of measured zero that were
 * never measured at all.
 */
function rollPeriods(
  days: readonly StreamDayFinance[],
  planOf: (streamDate: string) => PeriodPlan
): FinancePeriodRow[] {
  const rolls = new Map<string, { plan: PeriodPlan; roll: Rollup }>()
  for (const day of days) {
    const plan = planOf(day.streamDate)
    let entry = rolls.get(plan.key)
    if (!entry) {
      entry = { plan, roll: newRollup() }
      rolls.set(plan.key, entry)
    }
    addDay(entry.roll, day)
  }
  const out: FinancePeriodRow[] = []
  for (const { plan, roll } of rolls.values()) {
    const dates = [...roll.dates].sort()
    out.push({
      ...rollupBody(roll),
      key: plan.key,
      label: plan.label,
      from: dates[0] ?? '',
      to: dates[dates.length - 1] ?? '',
      dayCount: dates.length
    })
  }
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  return out
}

/**
 * bucket key → the named field it lands in on a day.
 *
 * `payout` is absent because it never reaches a day. `unclassified` is absent
 * because there is no field for a shape this version has never seen — it is
 * handled explicitly in the day arithmetic below, at face value, so the money
 * stays visible instead of falling between two named fields.
 */
const BUCKET_FIELD: Partial<Record<LedgerBucket, keyof StreamDayFinance>> = {
  // `netSales`, and the name is the point: this is the ledger's own figure,
  // summed, with nothing derived. The gross and the fees are built separately
  // from the same rows further down.
  sale: 'netSales',
  // Whole-product sales land in the SAME top line as break spots. They are the
  // same kind of money and carry the same fees, so splitting them here would
  // mean every fee, subtotal and reconciliation had to learn about two revenue
  // fields. They stay separable where it matters — the bucket is on the row, so
  // the split can be shown and the product matched — without a second top line.
  product_sale: 'netSales',
  shipping_subsidy: 'shippingSubsidy',
  tip: 'tips',
  seller_bonus: 'bonuses',
  sale_reversal: 'reversals',
  giveaway_shipping: 'giveawayShipping',
  shipping_charge: 'shippingCharges',
  refund_shipping: 'refundShipping',
  show_boost: 'showBoost'
}

/**
 * Split unattributed activity wherever there is a gap longer than
 * CLUSTER_GAP_MINUTES. This is what shows the operator the show they forgot to
 * log: real RM data runs two shows most days, so an evening-only session log
 * leaves a whole afternoon block outside every window — and a cluster with a
 * start time, an end time, a row count and a dollar total is something they can
 * recognise and type in. A single "N rows unattributed" number is not.
 */
/** A burst of unattributed activity while it is being accumulated, carrying the
 *  bucket split the per-day view needs. */
interface RawCluster {
  from: string
  to: string
  rowCount: number
  cents: number
  lastMs: number
  buckets: Map<LedgerBucket, { rowCount: number; cents: number }>
}

function clusterRows(
  rows: Array<{ occurredAt: string; bucket: LedgerBucket; cents: number }>
): RawCluster[] {
  const gapMs = CLUSTER_GAP_MINUTES * 60_000
  const out: RawCluster[] = []
  let current: RawCluster | null = null

  const add = (c: RawCluster, bucket: LedgerBucket, cents: number): void => {
    const e = c.buckets.get(bucket) ?? { rowCount: 0, cents: 0 }
    e.rowCount += 1
    e.cents += cents
    c.buckets.set(bucket, e)
  }

  for (const r of rows) {
    const ms = new Date(r.occurredAt).getTime()
    if (Number.isNaN(ms)) continue
    if (current && ms - current.lastMs <= gapMs) {
      current.to = r.occurredAt
      current.rowCount += 1
      current.cents += r.cents
      current.lastMs = ms
      add(current, r.bucket, r.cents)
      continue
    }
    if (current) out.push(current)
    current = {
      from: r.occurredAt,
      to: r.occurredAt,
      rowCount: 1,
      cents: r.cents,
      lastMs: ms,
      buckets: new Map()
    }
    add(current, r.bucket, r.cents)
  }
  if (current) out.push(current)
  return out
}

function toClusters(raw: RawCluster[]): UnattributedCluster[] {
  const out = raw.map((c) => ({
    from: c.from,
    to: c.to,
    rowCount: c.rowCount,
    amount: toDollars(c.cents),
    localDate: streamDateOf(c.from)
  }))
  // Biggest money first: that is the show most worth logging.
  out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  return out
}

/**
 * The same bursts, folded onto business days.
 *
 * A cluster counts on the day it BEGAN — `streamDateOf(from)` — which is the
 * governing rule of this whole module applied to money that has no session to
 * take a date from. Keying each ROW by its own date instead would cut an
 * unlogged 11pm–2am evening in half and put two partial shows on two days,
 * which is precisely the error the module exists to avoid.
 */
function daysOf(raw: RawCluster[]): UnattributedDay[] {
  interface DayAcc {
    rowCount: number
    cents: number
    buckets: Map<LedgerBucket, { rowCount: number; cents: number }>
    windows: UnattributedWindow[]
  }
  const byDate = new Map<string, DayAcc>()

  for (const c of raw) {
    const key = streamDateOf(c.from)
    const day: DayAcc =
      byDate.get(key) ?? { rowCount: 0, cents: 0, buckets: new Map(), windows: [] }
    day.rowCount += c.rowCount
    day.cents += c.cents
    for (const [bucket, e] of c.buckets) {
      const acc = day.buckets.get(bucket) ?? { rowCount: 0, cents: 0 }
      acc.rowCount += e.rowCount
      acc.cents += e.cents
      day.buckets.set(bucket, acc)
    }
    day.windows.push({
      from: c.from,
      to: c.to,
      rowCount: c.rowCount,
      amount: toDollars(c.cents)
    })
    byDate.set(key, day)
  }

  const out: UnattributedDay[] = []
  for (const [localDate, day] of byDate) {
    day.windows.sort((a, b) => a.from.localeCompare(b.from))
    out.push({
      localDate,
      rowCount: day.rowCount,
      amount: toDollars(day.cents),
      byBucket: LEDGER_BUCKETS.filter((b) => day.buckets.has(b.key)).map((b) => {
        const e = day.buckets.get(b.key) as { rowCount: number; cents: number }
        return { bucket: b.key, rowCount: e.rowCount, amount: toDollars(e.cents) }
      }),
      windows: day.windows
    })
  }
  // Biggest day first — the one most worth logging a show for.
  out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  return out
}

function buildView(db: Database): StreamingFinanceView {
  // --- days -----------------------------------------------------------------
  const dayMap = new Map<string, StreamDayFinance>()
  const dayCents = new Map<string, Partial<Record<LedgerBucket, number>>>()
  const dayNetCents = new Map<string, number>()

  const dayFor = (date: string): StreamDayFinance => {
    let d = dayMap.get(date)
    if (!d) {
      d = emptyDay(date)
      dayMap.set(date, d)
      dayCents.set(date, {})
      dayNetCents.set(date, 0)
    }
    return d
  }

  const sessions = db
    .prepare('SELECT id, title, stream_date, started_at, ended_at FROM stream_sessions')
    .all() as Array<{
    id: string
    title: string
    stream_date: string
    started_at: string
    ended_at: string | null
  }>
  for (const s of sessions) {
    const day = dayFor(s.stream_date)
    day.sessionCount += 1
    const title = s.title.trim()
    if (title) day.sessionTitles.push(title)
    // A live show contributes no minutes yet: its duration is not a fact until
    // it ends, and "so far" would make yesterday's total change overnight.
    day.minutes += durationMinutes(s.started_at, s.ended_at) ?? 0
  }

  // --- cost of goods, from the Streaming module rather than the ledger --------
  //
  // Stock consumed by the shows on each business day, from the operator's own
  // stream lines. Whatnot's export cannot supply this: it knows what a show
  // earned, not what the case that was broken to fill it cost.
  //
  // `cents` is `cost_total` — the FIFO layers a break actually consumed. `loss`
  // is `loss_value`, the value of the stock GIVEN AWAY, valued at pack cost
  // where packs were entered. Deliberately NOT inferred from the ledger, whose
  // giveaway_shipping rows are the POSTAGE for mailing a prize and remain
  // exactly that, in Shipping, untouched. Two different real costs; the mistake
  // this comment exists to prevent is folding one into the other.
  //
  // GROUPED BY PRODUCT AS WELL AS BY ACT, because the statement now prints one
  // line per product rather than two totals. The totals are summed from these
  // very rows rather than from a second query, which is what makes the itemised
  // lines add up to `cogs` by construction instead of by two queries happening
  // to agree.
  //
  // Keyed on the NAME rather than on `product_id`. The id is nullable and is set
  // to NULL when a catalog product is deleted, which is exactly the case the
  // denormalised name on the line exists to survive; grouping by the id would
  // collapse every deleted product in a range into one unnamed line.
  //
  // AND SPLIT BY WHETHER THE LINE CARRIES A COST AT ALL. Two boxes of one product
  // on one night, one of them priced and one of them not, is two facts, and the
  // group that folds them together reports the first and loses the second — a
  // confident $1,200 against a name half of whose stock nobody has costed. So
  // "was anything recorded for this line" joins the grouping key, and the two
  // halves come back as two entries. They still sum to the same day figures;
  // there are simply more rows to sum.
  const itemRows = db
    .prepare(
      `SELECT s.stream_date AS d, i.kind AS kind, TRIM(i.product_name) AS name,
              CASE WHEN CAST(ROUND(
                     (CASE i.kind WHEN 'giveaway' THEN i.loss_value ELSE i.cost_total END) * 100
                   ) AS INTEGER) = 0 THEN 1 ELSE 0 END AS uncosted,
              COALESCE(SUM(CAST(ROUND(i.cost_total * 100) AS INTEGER)), 0) AS cents,
              COALESCE(SUM(CAST(ROUND(i.loss_value * 100) AS INTEGER)), 0) AS loss
         FROM stream_items i JOIN stream_sessions s ON s.id = i.session_id
        GROUP BY s.stream_date, i.kind, TRIM(i.product_name), uncosted`
    )
    .all() as Array<{
    d: string
    kind: string
    name: string
    uncosted: number
    cents: number
    loss: number
  }>

  // The individual lines behind the uncosted entries, so the statement can offer
  // them back for costing rather than only naming the hole. One query for the
  // whole view, keyed the same way the groups above are.
  //
  // `unit_type` comes off the catalog row and is what says which unit a price
  // for this line would be PER — the same unit AddItemForm prices a
  // reconciliation in. A product deleted since leaves it null, and the form then
  // prices the line as it stands instead of naming a case the product may never
  // have had.
  const uncostedRefs = new Map<string, UncostedStreamItem[]>()
  for (const r of db
    .prepare(
      `SELECT i.id AS id, i.kind AS kind, TRIM(i.product_name) AS name, i.quantity AS quantity,
              i.stated_case_price AS stated, s.stream_date AS d, s.title AS title,
              p.unit_type AS unit_type
         FROM stream_items i
         JOIN stream_sessions s ON s.id = i.session_id
         LEFT JOIN inventory_products p ON p.id = i.product_id
        WHERE CAST(ROUND(
                (CASE i.kind WHEN 'giveaway' THEN i.loss_value ELSE i.cost_total END) * 100
              ) AS INTEGER) = 0
        ORDER BY s.stream_date ASC, i.created_at ASC, i.rowid ASC`
    )
    .all() as Array<{
    id: string
    kind: string
    name: string
    quantity: number
    stated: number | null
    d: string
    title: string
    unit_type: string | null
  }>) {
    const kind = r.kind === 'giveaway' ? 'giveaway' : 'break'
    const key = `${r.d}|${kind}|${r.name}`
    const list = uncostedRefs.get(key) ?? []
    list.push({
      id: r.id,
      kind,
      streamDate: r.d,
      sessionTitle: r.title.trim(),
      quantity: r.quantity,
      priceUnit: r.unit_type ? stockUnitOf(r.unit_type) : null,
      // Read off the LINE, never re-derived from the session's date: a show can
      // be re-dated afterwards, and what a line did when it was written is fixed
      // from then on. Same rule `restoreItemStock` reverses by.
      reconciled: r.stated !== null
    })
    uncostedRefs.set(key, list)
  }

  // Both are stored POSITIVE on the line and reported NEGATIVE here: every
  // figure that feeds a bottom line is a signed number, so the total is a plain
  // sum and no screen has to remember which way to apply it. Getting this sign
  // wrong does not fail anywhere — it silently ADDS the cost of a broken case to
  // the profit of the show that broke it.
  const cogsItems = new Map<string, CogsItem[]>()
  const addCogsItem = (date: string, item: CogsItem): void => {
    // A ZERO-COST LINE IS PRINTED, and this is the whole of the fix.
    //
    // It used to be dropped here, on the reasoning that a product name against
    // $0.00 reads as a costing failure nobody can act on from the statement. The
    // reading was right; dropping it was not. Two supported entries land at zero
    // — a reconciled past show recorded at a price of nothing, and a box entered
    // at cost 0 because "0 means don't track" — and the owner's report of the
    // result was that his cost of goods had been DELETED. A hole you can see is
    // a hole you can fill; a hole that is not printed is data loss.
    //
    // The money is unchanged either way: an uncosted entry carries zero, so the
    // section subtotal and `pnlChecksum(sections) === netProfit` are exactly what
    // they were. What changes is that the statement now says the hole is there,
    // and hands back the lines to fill it.
    const list = cogsItems.get(date) ?? []
    list.push(item)
    cogsItems.set(date, list)
  }
  for (const r of itemRows) {
    const day = dayFor(r.d)
    const uncosted = r.uncosted === 1
    const kind: CogsItem['kind'] = r.kind === 'giveaway' ? 'giveaway' : 'break'
    const refs = uncosted ? (uncostedRefs.get(`${r.d}|${kind}|${r.name}`) ?? []) : []
    if (kind === 'giveaway') {
      // ONE cost-of-goods line for given-away stock, not two. `cost_total` is
      // the balance-sheet movement (stock left the shelf); `loss_value` is what
      // that stock was worth as a cost of the show, valued at pack cost when
      // packs went out. Booking both would count the same prize twice.
      day.giveawayCost = toDollars(toCents(day.giveawayCost) - r.loss)
      // The same money under the name this view has always used for it, kept so
      // netAfterCosts and everything reading it keep meaning what they meant.
      day.giveawayLoss = day.giveawayCost
      addCogsItem(r.d, {
        kind: 'giveaway',
        name: r.name,
        amount: toDollars(-r.loss),
        ...(uncosted ? { uncosted: true, items: refs } : null)
      })
    } else {
      day.breakCost = toDollars(toCents(day.breakCost) - r.cents)
      addCogsItem(r.d, {
        kind: 'break',
        name: r.name,
        amount: toDollars(-r.cents),
        ...(uncosted ? { uncosted: true, items: refs } : null)
      })
    }
  }
  for (const [date, items] of cogsItems) dayFor(date).cogsBreakdown = mergeCogsItems(items)

  // --- what somebody typed against a day -------------------------------------
  //
  // The one figure on a day that is neither in Whatnot's export nor derived from
  // anything: a pack opened for fun, a box written off. NEGATIVE here for the
  // same reason the stock cost is, and NOT a stock movement — see the field in
  // the contract for why the two are kept apart.
  //
  // An entry against a date with no session and no ledger rows still creates a
  // day, which is correct: money was spent on it, so it belongs on the calendar
  // and in whatever range covers it.
  for (const [date, e] of expenseTotalsByDay()) {
    const day = dayFor(date)
    day.generalExpenses = toDollars(toCents(day.generalExpenses) - e.cents)
    day.generalExpenseCount += e.count
  }

  // ATTRIBUTED money only — `session_id IS NOT NULL` rather than `stream_date IS
  // NOT NULL`. Deleting a session orphans its rows (ON DELETE SET NULL) and
  // leaves stream_date behind; counting those here AND in `unattributed` would
  // double them and break the reconciliation for a reason nobody could find.
  const bucketRows = db
    .prepare(
      `SELECT stream_date AS d, bucket, COUNT(*) AS rows,
              COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS cents
         FROM ledger_rows
        WHERE stream_date IS NOT NULL AND bucket <> 'payout'
          AND (session_id IS NOT NULL OR attribution = 'own_day')
        GROUP BY stream_date, bucket`
    )
    .all() as Array<{ d: string; bucket: string; rows: number; cents: number }>

  for (const r of bucketRows) {
    const day = dayFor(r.d)
    day.rowCount += r.rows
    const bucket = r.bucket as LedgerBucket
    // Counted from the row table rather than inferred from a dollar total — no
    // average ticket price can recover it, and the flat card charge is levied
    // once per row, so this count is load-bearing again rather than decoration.
    if (bucket === 'sale' || bucket === 'product_sale') day.saleCount += r.rows
    if (bucket === 'product_sale') {
      day.productSales = toDollars(toCents(day.productSales) + r.cents)
      day.productSaleCount += r.rows
    }
    const amounts = dayCents.get(r.d) as Partial<Record<LedgerBucket, number>>
    amounts[bucket] = (amounts[bucket] ?? 0) + r.cents
    dayNetCents.set(r.d, (dayNetCents.get(r.d) ?? 0) + r.cents)
    const field = BUCKET_FIELD[bucket]
    if (field) {
      const fields = day as unknown as Record<string, number>
      fields[field] = toDollars(toCents(fields[field]) + r.cents)
    }
  }

  // --- packaging, modelled per card / per break / per package -----------------
  //
  // THE ONLY PACKAGING COST THERE IS, and it lands in `netProfit`. It stays out
  // of `netShipping` and `netAfterCosts`, which are the LEDGER's two figures —
  // every term in those can be checked against a Whatnot export, and a modelled
  // cost inside either would break that property. It gets its own statement
  // section instead, and `pnlChecksum` counts it like every other one.
  //
  // AFTER the bucket loop on purpose. `dayMap.get` rather than `dayFor` — this
  // block must never CREATE a business day. A shipping dataset sitting in the
  // workspace is a PDF somebody uploaded; on its own it is not evidence that a
  // show happened, and a day conjured out of it would appear on the calendar
  // with no session, no sales and a packaging cost, which reads as a night
  // nobody can account for. Every day with cards on it already exists, because
  // the very rows this counts created it a few lines above.
  for (const [date, facts] of packagingFactsByDay(db)) {
    const day = dayMap.get(date)
    if (!day) continue
    day.packagingCards = facts.cards
    day.packagingBreaks = facts.breaks
    day.packagingBreaksPriced = facts.breaksPriced
    day.packagingSlateTeams = facts.slateTeams
    day.packagingPackages = facts.packages ?? 0
    day.packagingPaidPackages = facts.paidPackages ?? 0
    const packaging = computePackagingCosts({
      cards: facts.cards,
      slateTeams: facts.slateTeams,
      packages: facts.packages,
      paidPackages: facts.paidPackages
    })
    day.packagingSleeves = packaging.sleeves
    day.packagingTopLoaders = packaging.topLoaders
    day.packagingTeamBags = packaging.teamBags
    day.packagingShippingLabels = packaging.shippingLabels
    day.packagingTeamBagStickers = packaging.teamBagStickers
    day.packagingMailers = packaging.mailers
    // ONE OF TWO COUNTERS, NEVER BOTH AND SOMETIMES NEITHER. A flag would not
    // survive being summed into a week, and a week is exactly where the
    // disclosure matters — at most one night in any month still has its slips
    // loaded, so the honest statement is "this covers 1 of 14 nights" and only
    // counts can carry that through a rollup.
    //
    // A day that sold no break spots is in neither counter: it needed no
    // packaging, so its zero is a real zero and there is nothing to disclose.
    // Putting it in `unknown` would print "not known" beside every day the
    // business did not stream, which is how a warning stops being read.
    if (packaging.packagesKnown) day.packagingDaysCovered = 1
    else if (facts.cards > 0) day.packagingDaysUnknown = 1
  }

  // How much of each day settled AFTER the show rather than during it. Reported
  // separately so a day's total is explainable: without it, a show's shipping
  // costs look like they materialised from nowhere the following afternoon.
  const carriedRows = db
    .prepare(
      `SELECT stream_date AS d, COUNT(*) AS rows,
              COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS cents
         FROM ledger_rows
        WHERE session_id IS NOT NULL AND stream_date IS NOT NULL
          AND bucket <> 'payout' AND attribution = 'carried_back'
        GROUP BY stream_date`
    )
    .all() as Array<{ d: string; rows: number; cents: number }>
  for (const r of carriedRows) {
    const day = dayFor(r.d)
    day.carriedBackRows += r.rows
    day.carriedBackAmount = toDollars(toCents(day.carriedBackAmount) + r.cents)
  }

  // --- what Whatnot already took, taken apart --------------------------------
  //
  // THE LEDGER'S AMOUNT IS NET. Whatnot deducts its cut before writing the row —
  // on the owner's real exports every non-payout row summed equals the payouts
  // to the cent, which could not be true if a fee were still to come off. So
  // nothing is subtracted here. The item price the buyer bid is RECOVERED from
  // the payout, PER ROW, and the fees fall out of it:
  //
  //   commission = round(item x commissionRate)
  //   tax        = round(item x taxRate)
  //   processing = round((item + tax) x processingRate + processingFlat)
  //   payout     = item - commission - processing
  //
  // read backwards. The contract's `deriveSaleFee` owns that arithmetic and it
  // is never restated here; the shipping term is zero on this path because
  // shipping is not inside a Whatnot sale row (it arrives as its own ADJUSTMENT
  // rows, which are classified and booked separately above).
  //
  // ROW BY ROW, AND IT HAS TO BE. The flat charge is levied once per purchased
  // order (1,929 sale rows, 1,929 distinct Order IDs) and the terms come from
  // the period covering THAT ROW'S BUSINESS DAY, so neither survives being
  // aggregated into a day's dollar total first. Only positive rows are charged:
  // a refund is not a purchase and a $0.00 sale is not a transaction, and both
  // pass through at face value.
  //
  // `rateLookup` snapshots the periods once for this whole derivation, so a rate
  // edited mid-pass cannot produce a day that disagrees with itself.
  //
  // THE TAX IS NOT A FEE AND NOT REVENUE. It is accumulated only because the
  // processing charge is levied on a total that contains it; it lands on the day
  // as a memo and in no subtotal anywhere.
  //
  // Fees are on SALES ONLY — tips, bonuses, subsidies, postage and Show Boost
  // arrive whole and are untouched by any of this.
  const rateAt = rateLookup()
  // `occurred_at` is deliberately NOT selected: the business day is the only
  // thing the derivation below reads a date for, and a column nobody uses is an
  // invitation to start pricing by it again.
  //
  // `bucket` and `product_name` ARE selected, and only to split the whole-product
  // share of the gross out of the same pass. That share cannot be recovered
  // afterwards by proportion: the flat card charge is per ROW, so a $10,794 case
  // sold as one order and $10,794 of break spots gross up by different amounts,
  // and apportioning would move real money between the two Revenue lines on
  // exactly the days that carry both.
  const saleRows = db
    .prepare(
      `SELECT stream_date AS d, bucket, product_name AS name,
              CAST(ROUND(amount * 100) AS INTEGER) AS cents
         FROM ledger_rows
        WHERE stream_date IS NOT NULL AND bucket IN ('sale', 'product_sale')
          AND (session_id IS NOT NULL OR attribution = 'own_day')`
    )
    .all() as Array<{ d: string; bucket: string; name: string | null; cents: number }>

  interface DayFees {
    grossCents: number
    whatnotCents: number
    processingCents: number
    taxCents: number
    charged: number
    /** Rows whose payout the model could not reproduce. See below. */
    unresolved: number
    /** Gross cents per SET OF TERMS charged — one entry on an ordinary day. */
    byTerms: Map<string, RateSlice>
    /** The whole-product share of `grossCents`, and the products behind it.
     *  Zero and empty on most days — 14 such sales on 6 days across both of the
     *  owner's real exports. */
    productGrossCents: number
    byProduct: Map<string, { cents: number; count: number }>
  }
  const feesByDay = new Map<string, DayFees>()
  for (const r of saleRows) {
    // A RATE PERIOD FOLLOWS THE SHOW, NOT THE CALENDAR. The rate is looked up by
    // `r.d` — the business day the P&L already groups this row under — so one
    // show is priced at one rate from its first spot to its last, whatever hour
    // the last one settled at.
    //
    // This used to key off `streamDateOf(r.at)`, the row's own calendar date,
    // and the argument for that was real: Whatnot charges by when the sale
    // happened, so a rate change taking effect on the 1st of a month should not
    // be back-dated onto the tail of a show that began on the 31st. That case
    // exists. It is also worth roughly one night a year, and it costs a few
    // hours of one show at the wrong commission.
    //
    // What it was traded against is EVERY RM SHOW. All of them run past
    // midnight, so under the old rule any show that touched a period boundary —
    // including a period the owner set to end ON the night of a show — split
    // into two rates and the statement reported the weighted average. A 4%
    // period ending 20 July produced "5.1%" for the 20 July show: 45% of the
    // gross before midnight at 4%, the rest after it at the standing default. The
    // owner read the period as covering that night's show, which is how a person
    // reads dates against shows, and no screen said otherwise.
    //
    // GIVEN UP, DELIBERATELY: a rate that changes mid-show is applied to the
    // whole of that show at the rate its opening night falls under. Whatnot's
    // own invoice for such a night would differ by the post-midnight hours. The
    // fix when that ever happens is to end the period on the day BEFORE the show
    // whose night it should stop covering — which is what the dates on the rates
    // screen now say they mean.
    const rates = rateAt(r.d)
    const fee = deriveSaleFee(r.cents, rates)
    const acc = feesByDay.get(r.d) ?? {
      grossCents: 0,
      whatnotCents: 0,
      processingCents: 0,
      taxCents: 0,
      charged: 0,
      unresolved: 0,
      byTerms: new Map<string, RateSlice>(),
      productGrossCents: 0,
      byProduct: new Map<string, { cents: number; count: number }>()
    }
    acc.grossCents += fee.grossCents
    acc.whatnotCents += fee.whatnotFeeCents
    acc.processingCents += fee.processingFeeCents
    acc.taxCents += fee.taxCents
    // A payout the forward model cannot reproduce. On the owner's real files
    // this is zero, and it stays zero while the configured terms match the ones
    // Whatnot actually charged; a non-zero count is the app noticing that they
    // do not, rather than printing a bid nobody made.
    if (!fee.exact) acc.unresolved += 1
    // Kept per SET OF TERMS as well as in total, so the statement can name what
    // it was charged instead of dividing one by the other. A day still CAN carry
    // two — two shows on one night with a period boundary between them, or a
    // period edited to end mid-range — and the one thing that must not happen
    // again is an averaged percentage printed as if it were a configured one.
    const key = `${rates.commissionRate}|${rates.processingRate}|${rates.processingFlatCents}`
    const slice = acc.byTerms.get(key) ?? {
      rate: rates.commissionRate,
      grossSales: 0,
      processingRate: rates.processingRate,
      processingFlatCents: rates.processingFlatCents
    }
    slice.grossSales += fee.grossCents
    acc.byTerms.set(key, slice)
    // EITHER fee, not just the commission: a promotional 0% period would leave
    // the commission at zero on rows that still paid the card charge, and
    // counting on the commission alone would then print a flat charge against
    // zero orders beside a real cost.
    if (fee.whatnotFeeCents !== 0 || fee.processingFeeCents !== 0) acc.charged += 1
    // The whole-product share, taken off the same derived figure and in the same
    // pass, so `grossCents - productGrossCents` is the break-spot gross to the
    // cent and the two Revenue lines add to the section subtotal exactly.
    if (r.bucket === 'product_sale') {
      acc.productGrossCents += fee.grossCents
      // The name the import parsed out of the message. Blank is a real outcome —
      // a shape `parseProductSaleName` does not recognise — and the contract's
      // merge gives that money a name rather than dropping the row.
      const name = (r.name ?? '').trim()
      const hit = acc.byProduct.get(name) ?? { cents: 0, count: 0 }
      hit.cents += fee.grossCents
      hit.count += 1
      acc.byProduct.set(name, hit)
    }
    feesByDay.set(r.d, acc)
  }

  for (const [date, day] of dayMap) {
    const cents = dayCents.get(date) ?? {}
    const unknownCents = cents.unclassified ?? 0
    // Carried as its own field as well as into the top line, so the statement
    // has a line to print for it rather than a subtotal that exceeds its lines.
    day.unclassified = toDollars(unknownCents)

    const fees = feesByDay.get(date) ?? {
      grossCents: 0,
      whatnotCents: 0,
      processingCents: 0,
      taxCents: 0,
      charged: 0,
      unresolved: 0,
      byTerms: new Map<string, RateSlice>(),
      productGrossCents: 0,
      byProduct: new Map<string, { cents: number; count: number }>()
    }
    // grossCents is Sigma(net + fees) over exactly the rows `netSales` was summed
    // from, so `grossSales - totalFees == netSales` to the cent, always. The
    // reconciliation below leans on that identity rather than assuming it.
    day.grossSales = toDollars(fees.grossCents)
    day.whatnotFee = toDollars(fees.whatnotCents)
    day.processingFee = toDollars(fees.processingCents)
    day.totalFees = toDollars(fees.whatnotCents + fees.processingCents)
    day.feeSaleCount = fees.charged
    // A MEMO, and it stops here: nothing below adds it to anything. The buyers
    // paid it and the state receives it, so it is neither revenue nor a cost —
    // it exists on the day so the statement can say what the processing fee was
    // charged on, which is the sales figure PLUS this.
    day.salesTax = toDollars(fees.taxCents)
    // The same rows, split by the terms each was charged under. Built from the
    // same accumulator as `grossSales`, so the slices sum to it exactly and the
    // statement's disclosure cannot disagree with the line it is disclosing.
    day.rateBreakdown = mergeRateSlices(
      [...fees.byTerms.values()].map((sl) => ({ ...sl, grossSales: toDollars(sl.grossSales) }))
    )
    // The marketplace share of that same gross, and what sold. `productSales`
    // stays the NET share it has always been — it is what reconciles to the
    // payout — and this is the figure the statement prints beside the sales line
    // it was split out of.
    day.productGrossSales = toDollars(fees.productGrossCents)
    day.marketplaceBreakdown = mergeMarketplaceItems(
      [...fees.byProduct.entries()].map(([name, v]) => ({
        name,
        amount: toDollars(v.cents),
        count: v.count
      }))
    )

    // `unclassified` has no field of its own in the day shape, so its money is
    // carried at FACE VALUE in totalRevenue and flagged in the import warnings.
    // It is deliberately NOT put through the fee derivation: no gross is
    // reverse-engineered from a shape this version cannot identify, because a
    // guess at what was taken invents a cost AND inflates the top line.
    day.totalRevenue = toDollars(
      fees.grossCents + toCents(day.tips) + toCents(day.bonuses) + unknownCents
    )

    // What Whatnot actually paid: the gross with the derived fees taken back
    // off, which lands exactly on netSales + tips + bonuses + unclassified.
    day.netRevenue = toDollars(toCents(day.totalRevenue) + toCents(day.totalFees))

    // Postage only, and every term of it is a ledger row — which is what lets
    // this figure be checked against a Whatnot screen. The modelled packaging
    // deliberately stays out of it and lands in `netProfit` on its own.
    //
    // STILL COMPUTED, AND READ BY NO STATEMENT SECTION. The owner took postage
    // off the P&L pending a different treatment of the cost, so this is the
    // per-night record waiting for that treatment rather than a live input to
    // anything the screen prints. `StreamDayFinance` carries the full argument.
    day.netShipping = toDollars(shippingCents(day))

    // Everything the LEDGER knows about, plus the giveaway loss that has always
    // sat beside showBoost here because it is the same kind of thing: money
    // spent to run the show. It deliberately does NOT include what the broken
    // stock cost, which is what makes it a different figure from netProfit and
    // still a useful one — it is the show's ledger economics on their own.
    day.netAfterCosts = toDollars(
      toCents(day.netRevenue) +
        toCents(day.netShipping) +
        toCents(day.showBoost) +
        toCents(day.reversals) +
        toCents(day.giveawayLoss)
    )

    // --- the statement -------------------------------------------------------
    //
    // Both cost-of-goods terms are already negative, so every line here is a
    // plain sum. Order follows how the money actually moves and matches
    // `buildPnl` in the contract exactly — asserted below, per day and per
    // period, rather than trusted.
    day.cogs = toDollars(toCents(day.breakCost) + toCents(day.giveawayCost))
    day.grossProfit = toDollars(toCents(day.totalRevenue) + toCents(day.cogs))
    // THERE IS NO POSTAGE TERM BELOW, AND ITS ABSENCE IS THE CHANGE. `netShipping`
    // was added into this sum until the owner took shipping off the P&L, so the
    // bottom line is now higher by whatever the subsidy less the postage came to.
    // Every term here is a section of `buildPnl` and postage is no longer one of
    // them — which is the property `pnlChecksum` asserts below at every grain, and
    // the reason the reconciliation has to give the same ground on the row side.
    day.netProfit = toDollars(
      toCents(day.grossProfit) +
        toCents(day.totalFees) +
        // The packaging section, summed from the same six rounded figures the
        // statement prints, so the bottom line is the column added up rather
        // than a second computation that agrees most of the time.
        packagingCents(day) +
        toCents(day.showBoost) +
        // Its own statement section, and in the bottom line: an expense that did
        // not reduce net profit would be a note, and the owner asked for a cost.
        toCents(day.generalExpenses) +
        toCents(day.reversals)
    )
  }

  const days = [...dayMap.values()].sort((a, b) =>
    a.streamDate < b.streamDate ? -1 : a.streamDate > b.streamDate ? 1 : 0
  )

  // --- totals, weeks and months, all summed from `days` ----------------------
  // Same accumulator, same field list, one input. A week that disagreed with the
  // days inside it would be worse than no week at all, and the only way to make
  // that impossible is to give the periods no other source of numbers.
  const grand = newRollup()
  for (const day of days) addDay(grand, day)
  const totals: StreamFinanceTotals = { ...rollupBody(grand), dayCount: days.length }
  const weeks = rollPeriods(days, weekOf)
  const months = rollPeriods(days, monthOf)

  // --- unattributed ---------------------------------------------------------
  const unattributed = emptyUnattributed()
  const unRows = db
    .prepare(
      `SELECT occurred_at, bucket, CAST(ROUND(amount * 100) AS INTEGER) AS cents
         FROM ledger_rows
        WHERE session_id IS NULL AND bucket <> 'payout' AND attribution <> 'own_day'
        ORDER BY occurred_at ASC, rowid ASC`
    )
    .all() as Array<{ occurred_at: string; bucket: string; cents: number }>

  const byBucket = new Map<LedgerBucket, { rowCount: number; cents: number }>()
  let unCents = 0
  for (const r of unRows) {
    unattributed.rowCount += 1
    unCents += r.cents
    const bucket = r.bucket as LedgerBucket
    const entry = byBucket.get(bucket) ?? { rowCount: 0, cents: 0 }
    entry.rowCount += 1
    entry.cents += r.cents
    byBucket.set(bucket, entry)
  }
  unattributed.amount = toDollars(unCents)
  unattributed.firstOccurredAt = unRows.length ? unRows[0].occurred_at : null
  unattributed.lastOccurredAt = unRows.length ? unRows[unRows.length - 1].occurred_at : null
  unattributed.byBucket = LEDGER_BUCKETS.filter((b) => byBucket.has(b.key)).map((b) => {
    const entry = byBucket.get(b.key) as { rowCount: number; cents: number }
    return { bucket: b.key, rowCount: entry.rowCount, amount: toDollars(entry.cents) }
  })
  const rawClusters = clusterRows(
    unRows.map((r) => ({
      occurredAt: r.occurred_at,
      bucket: r.bucket as LedgerBucket,
      cents: r.cents
    }))
  )
  unattributed.clusters = toClusters(rawClusters)
  unattributed.byDay = daysOf(rawClusters)

  // --- reconciliation -------------------------------------------------------
  // Every non-payout row is on exactly one day or in `unattributed`. Asserted in
  // integer cents against the row table itself, so a drift is reported rather
  // than absorbed. A false here is shown, never hidden: numbers that do not add
  // up must not be presented as if they do.
  const all = db
    .prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS cents
         FROM ledger_rows WHERE bucket <> 'payout'`
    )
    .get() as { rows: number; cents: number }

  let daysCents = 0
  let daysRows = 0
  for (const [, c] of dayNetCents) daysCents += c
  for (const day of days) daysRows += day.rowCount

  // The day fields must decompose the SAME money the rows carry, and several of
  // them are not ledger rows at all — both cost-of-goods terms, which come from
  // the Streaming module, the modelled packaging, which comes from counting
  // cards and envelopes, and the manual expenses, which come from somebody
  // typing — while the postage is the reverse, ledger money the statement no
  // longer books. Both sides give ground, and the two must land on each other:
  //     netProfit − cogs − packaging − generalExpenses
  //        == Σ(attributed non-payout rows) − Σ(the four postage buckets)
  //
  // THE FEES ARE NOT STRIPPED, AND THAT IS THE ROUND-TRIP ASSERTION. They used
  // to be, because the top line was the ledger's own figure and the fee was
  // subtracted from it. Now the top line is a DERIVED gross — netSales with the
  // fees added back — and netProfit subtracts them again, so the two cancel by
  // construction. Which means this check no longer merely tolerates the fee: it
  // FAILS if `grossSales − totalFees` is ever a cent away from `netSales`, on
  // any day, for any reason. A rounding rule that stopped closing, a row counted
  // in the gross but not in the net, a rate applied to one and not the other —
  // all of them surface here, on the screen, rather than as a plausible number.
  //
  // It also still catches a future bucket that classification learns to produce
  // but the day shape has no field for. Without it that money would vanish from
  // every screen while the row-level reconciliation above still said "fine",
  // because the rows themselves would all still be present and counted.
  let fieldCents = 0
  // The same test for the OTHER published bottom line. netAfterCosts carries the
  // giveaway loss and no break cost, so it strips differently — and a figure
  // nobody checks is a figure that drifts.
  let ledgerFieldCents = 0
  /**
   * THE POSTAGE THE STATEMENT DELIBERATELY DOES NOT BOOK, taken off the LEDGER
   * side of the comparison. It is the mirror of the packaging strip below, and
   * the only thing standing between the operator and a false alarm on every day
   * that ever shipped a parcel.
   *
   * The failure it prevents, spelled out because it is not visible from here:
   * the four postage buckets are still classified, still attributed to a day and
   * still carry cents, so every one of them is inside `daysCents`. Net profit no
   * longer contains a postage term, so `fieldCents` does not. Compare the two
   * untouched and they differ by exactly the net postage — the check reports
   * "the day breakdown adds to X but Y of ledger money is attributed", the
   * operator gets the "these numbers do not add up" banner on a statement that
   * is entirely correct, and the one flag that means something becomes wallpaper.
   *
   * The rule this obeys is the flat one already written above, read in the other
   * direction: anything in `netProfit` that Whatnot's export cannot corroborate
   * comes off the day side, and any ledger money `netProfit` does not claim
   * comes off the row side. A future section that reinstates postage removes
   * this strip and nothing else.
   */
  let unbookedShippingCents = 0
  for (const day of days) {
    // THE PACKAGING BLOCK IS STRIPPED, because it is now inside `netProfit` and
    // no part of it is a ledger row. It moved in when the shipping checklist —
    // and with it the measured packing figure this line used to subtract — was
    // removed. Forgetting a strip here does not fail loudly: it flags EVERY day
    // unreconciled, which is how an operator learns to ignore the one flag that
    // matters. So the rule is flat — anything in `netProfit` that Whatnot's
    // export cannot corroborate comes back off on this line.
    fieldCents +=
      toCents(day.netProfit) -
      toCents(day.cogs) -
      packagingCents(day) -
      toCents(day.generalExpenses)
    unbookedShippingCents += shippingCents(day)
    // `netAfterCosts` carries neither the manual expenses nor the packaging —
    // it is the show's LEDGER economics — so the giveaway loss is the only
    // non-ledger term there is to take back off. THE POSTAGE IS NOT STRIPPED
    // HERE: this figure still books it, on purpose, so it still decomposes the
    // ledger's own money in full.
    ledgerFieldCents += toCents(day.netAfterCosts) - toCents(day.giveawayLoss)
  }

  /** What the statement is answerable for: the money on the attributed rows,
   *  less the postage no section of it reads. */
  const bookedDayCents = daysCents - unbookedShippingCents

  /**
   * Every section subtotal of the statement, summed, must BE the bottom line.
   *
   * `buildPnl` and `pnlChecksum` are the contract's, used here rather than
   * restated: the screen renders those same sections, so if the arithmetic on
   * this side ever stops agreeing with the layout on that side, the operator
   * would be shown a statement whose parts do not add to its own total. Checked
   * for every day AND every period, because a rollup that dropped a field would
   * pass on the days and fail here.
   */
  const statementBreak = (
    label: string,
    row: Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>
  ): string | null => {
    const stated = toCents(pnlChecksum(buildPnl(row)))
    const bottom = toCents(row.netProfit)
    if (stated === bottom) return null
    return (
      `The ${label} statement adds to ${money(stated)} but its net profit says ${money(bottom)}. ` +
      `A line is landing in no section — these totals are incomplete, do not book from them.`
    )
  }

  let reconciled = true
  let reconcileNote: string | null = null
  if (daysRows + unattributed.rowCount !== all.rows) {
    reconciled = false
    reconcileNote =
      `${daysRows} rows on shows + ${unattributed.rowCount} unattributed = ` +
      `${daysRows + unattributed.rowCount}, but ${all.rows} non-payout rows are stored. ` +
      `These totals are incomplete — do not book from them.`
  } else if (daysCents + unCents !== all.cents) {
    reconciled = false
    reconcileNote =
      `${money(daysCents)} on shows + ${money(unCents)} unattributed = ${money(daysCents + unCents)}, ` +
      `but ${money(all.cents)} of non-payout money is stored. These totals are incomplete — do not book from them.`
  } else if (fieldCents !== bookedDayCents) {
    reconciled = false
    reconcileNote =
      `The day breakdown adds to ${money(fieldCents)} before stock cost but ${money(bookedDayCents)} ` +
      `of ledger money is attributed to those days outside postage. Either a bucket is landing in no ` +
      `column, or the derived gross does not fall back to the net Whatnot paid — these totals are ` +
      `incomplete, do not book from them.`
  } else if (ledgerFieldCents !== daysCents) {
    reconciled = false
    reconcileNote =
      `Net after costs adds to ${money(ledgerFieldCents)} before the giveaway loss but ` +
      `${money(daysCents)} of ledger money is attributed to those days. These totals are incomplete, ` +
      `do not book from them.`
  } else {
    const rows: Array<[string, Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>]> = [
      ...days.map((d): [string, StreamDayFinance] => [d.streamDate, d]),
      ...weeks.map((w): [string, FinancePeriodRow] => [w.label, w]),
      ...months.map((m): [string, FinancePeriodRow] => [m.label, m]),
      ['all-time', totals]
    ]
    for (const [label, row] of rows) {
      const broken = statementBreak(label, row)
      if (broken) {
        reconciled = false
        reconcileNote = broken
        break
      }
    }
  }

  return {
    days,
    weeks,
    months,
    totals,
    unattributed,
    imports: listImportsWith(db),
    reconciled,
    reconcileNote
  }
}

function listImportsWith(db: Database): LedgerImport[] {
  const rows = db.prepare(`${IMPORT_SELECT} ORDER BY created_at DESC, rowid DESC`).all() as ImportRow[]
  return rows.map((r) => toImport(r, db))
}

export function streamingFinanceView(): StreamingFinanceView {
  return buildView(getDb())
}
