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
 * The ledger's sale figure is GROSS. Whatnot's commission (6%) and processing
 * (2.9% plus 30c a transaction, both on the gross) come off it, on SALES ONLY —
 * `computeFees` in the contract owns that arithmetic and it is never inlined.
 * Fees are computed once, ON A DAY, and weeks, months and the grand total are
 * built by SUMMING day rows. Nothing re-derives a fee from a period's gross: the
 * flat 30c is per sale row, so a period that recomputed it would depend on how
 * it was sliced and would eventually contradict the days inside it.
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
 * and `cogs` is their sum. `grossProfit` is revenue plus cogs; `netProfit` is
 * gross profit after fees, shipping, show costs and adjustments.
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
  FinancePeriodRow,
  LedgerAttribution,
  LedgerBucket,
  LedgerImport,
  LedgerImportResult,
  LedgerRow,
  StreamDayFinance,
  StreamFinanceTotals,
  StreamingFinanceView,
  UnattributedCluster,
  UnattributedSummary
} from '@shared/financeStreaming'
import {
  CARRY_BACK_MAX_HOURS,
  CLUSTER_GAP_MINUTES,
  LEDGER_BUCKETS,
  LEDGER_CLASSIFIER_VERSION,
  SESSION_VACUUM_SHARE,
  buildPnl,
  carryBackEligible,
  classifyLedgerRow,
  computeFees,
  findCarryBackSession,
  ledgerFingerprintSource,
  parseBreakNumber,
  parseLedgerAmount,
  parseLedgerDate,
  pnlChecksum,
  rowInSession
} from '@shared/financeStreaming'
import type { StreamSession } from '@shared/streaming'
import { durationMinutes, isSuspiciouslyLong, streamDateOf } from '@shared/streaming'
import { getDb } from './database'
import { newId, nowIso } from '../util'

// ---------------------------------------------------------------------------
// Money. Every total in this file is accumulated in INTEGER CENTS and converted
// back to dollars exactly once, at the edge. Adding 9,225 floats and comparing
// the result to another sum of 9,225 floats is how a reconciliation check
// reports a phantom one-cent break.
// ---------------------------------------------------------------------------

const toCents = (dollars: number): number => Math.round(dollars * 100)
const toDollars = (cents: number): number => Math.round(cents) / 100

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
  if (!names || names.length !== FIELD_COUNT || LEDGER_HEADER.some((h, i) => names[i] !== h)) {
    out.headerError =
      `That does not look like a Whatnot ledger export. Expected the columns ` +
      `${LEDGER_HEADER.join(', ')} but the file starts with: ${headerLine.slice(0, 300)}`
    return out
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

    // 1. Strict RFC4180 on the line as it stands. This is the path both real
    //    formats take: 2,551 of 2,551 new-format rows and 6,666 of 6,674
    //    old-format rows.
    const strict = strictSplit(raw)
    if (strict.kind === 'ok' && strict.fields.length === FIELD_COUNT) {
      out.rows.push({ lineNumber, fields: strict.fields, repaired: false })
      i += 1
      continue
    }

    // 2. An open quoted field: pull in following lines until the record closes.
    //    Abandoned the moment joining stops helping, and it never advances past
    //    the lines it actually consumed.
    if (strict.kind === 'unterminated') {
      let joined = raw
      let taken = 0
      let closed = false
      while (i + taken + 1 < lines.length && taken < MAX_RECORD_LINES) {
        taken += 1
        joined += `\n${lines[i + taken]}`
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
    const fixed = repairSplit(raw)
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
      staged.push({
        occurredAt,
        instantMs: new Date(occurredAt).getTime(),
        amount,
        listingId,
        orderId,
        message,
        txnType,
        bucket: classifyLedgerRow(txnType, message),
        breakNumber: parseBreakNumber(message),
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
          classifier_version, created_at)
       VALUES (@id, @import_id, @occurred_at, @amount, @order_id, @listing_id, @message,
               @txn_type, @bucket, @session_id, @stream_date, @attribution, @break_number,
               @fingerprint, @repaired, @classifier_version, @created_at)
       ON CONFLICT(fingerprint) DO NOTHING`
    )

    for (const s of staged) {
      const found = attributeRow(s.bucket, s.instantMs, sessions)
      const match = found.session
      const info = insert.run({
        id: newId(),
        import_id: importId,
        occurred_at: s.occurredAt,
        amount: s.amount,
        order_id: s.orderId || null,
        listing_id: s.listingId || null,
        message: s.message,
        txn_type: s.txnType,
        bucket: s.bucket,
        session_id: match ? match.id : null,
        stream_date: match ? match.streamDate : null,
        attribution: found.attribution,
        break_number: s.breakNumber,
        fingerprint: s.fingerprint,
        repaired: s.repaired ? 1 : 0,
        classifier_version: LEDGER_CLASSIFIER_VERSION,
        created_at: ts
      })
      if (info.changes === 0) {
        // Already imported — an overlapping week re-uploaded, which must be a
        // no-op rather than an error or a second copy of the money.
        stats.duplicate += 1
        continue
      }
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
      } else {
        stats.unattributedRows += 1
        stats.unattributedCents += toCents(s.amount)
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
      `${stats.unclassified} row${stats.unclassified === 1 ? '' : 's'} carry a message shape this version does not ` +
        `recognise (for example: "${(stats.unclassifiedExample ?? '').slice(0, 160)}"). ` +
        `They are counted at face value, not dropped.`
    )
  }

  // NOT an error, and deliberately worded so it does not read like one. The
  // owner's instruction is explicit: "if a stream isn't in the streaming
  // schedule, don't worry about that ledger row, just let it be — it'll show up
  // empty." So the money is kept, counted, clustered and stated, the import
  // succeeds, and nothing waits on the operator. Adding the session later moves
  // these rows onto it; never adding it leaves them visible here forever, which
  // is a fine end state.
  if (stats.unattributedRows > 0) {
    warnings.push(
      `${stats.unattributedRows} row${stats.unattributedRows === 1 ? '' : 's'} (${money(stats.unattributedCents)}) are not ` +
        `inside any logged show. That is fine — they are stored, counted and listed under "outside every show". ` +
        `If one of them was a real stream, add the session and re-run attribution and they will move onto it.`
    )
  }

  // Stated plainly rather than left implicit: a day's shipping costs otherwise
  // look like they appeared from nowhere hours after the show ended, and an
  // unexplained number in an accounting screen is one nobody trusts twice.
  if (stats.carriedBackRows > 0) {
    warnings.push(
      `${stats.carriedBackRows} settlement row${stats.carriedBackRows === 1 ? '' : 's'} (${money(stats.carriedBackCents)}) ` +
        `posted after the show that caused them — shipping subsidies, platform charges and giveaway postage — and were ` +
        `carried back to it. Sales are never carried back: a sale outside every window stays unattributed so a missing ` +
        `show cannot hide inside the previous one.`
    )
  }

  if (rowsRepaired > 0) {
    warnings.push(
      `${rowsRepaired} line${rowsRepaired === 1 ? '' : 's'} needed repairing (Whatnot writes show titles with ` +
        `unescaped quotes). They were recovered whole and are flagged as repaired.`
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
      const bucket = stale ? classifyLedgerRow(r.txn_type, r.message) : (r.bucket as LedgerBucket)
      const instantMs = new Date(r.occurred_at).getTime()
      // BOTH passes, exactly as an import runs them — otherwise adding a session
      // would re-home in-window rows while leaving that show's own settlement
      // rows stranded, and the two paths would disagree about the same money.
      const found = attributeRow(bucket, instantMs, sessions)
      const sessionId = found.session ? found.session.id : null
      const streamDate = found.session ? found.session.streamDate : null

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
 * Undo an upload. Its rows go with it (ON DELETE CASCADE) — that money leaves
 * the P&L, which is the point: this is a correction, not data loss.
 *
 * Note the consequence of fingerprint de-dup: a row is owned by the import that
 * FIRST saw it, so deleting import #1 also removes rows that a later,
 * overlapping import #2 skipped as duplicates. Re-uploading #2 puts them back.
 */
export function deleteImport(id: string, actorId: string | null): Result<StreamingFinanceView> {
  void actorId
  const db = getDb()
  const run = db.transaction((): Result<StreamingFinanceView> => {
    const info = db.prepare('DELETE FROM ledger_imports WHERE id = ?').run(id)
    if (info.changes === 0) return { ok: false, error: 'That import no longer exists.' }
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

interface RawLedgerRow {
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

function toRow(r: RawLedgerRow): LedgerRow {
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
    `SELECT id, import_id, occurred_at, amount, order_id, listing_id, message, txn_type,
            bucket, session_id, stream_date, attribution, break_number, fingerprint, repaired,
            classifier_version
       FROM ledger_rows
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, rowid DESC
      LIMIT ${limit}`
  return (db.prepare(sql).all(args) as RawLedgerRow[]).map(toRow)
}

// ---------------------------------------------------------------------------
// The day-by-day view
// ---------------------------------------------------------------------------

/**
 * Every money field a day carries, in one list, used by the day builder AND by
 * every rollup. Adding a field to the contract and forgetting it here would make
 * a week quietly disagree with the days inside it, so the list is the single
 * place it has to be named.
 */
const MONEY_FIELDS = [
  'sales',
  'tips',
  'bonuses',
  'totalRevenue',
  'whatnotFee',
  'processingFee',
  'totalFees',
  'netRevenue',
  'shippingSubsidy',
  'shippingCharges',
  'giveawayShipping',
  'refundShipping',
  'netShipping',
  'showBoost',
  'reversals',
  // From the Streaming module, not the ledger, and part of netAfterCosts. Kept
  // equal to `giveawayCost` — it is the same money under the name the ledger
  // view has always used for it — so nothing that reads it changes meaning.
  'giveawayLoss',
  'netAfterCosts',
  'carriedBackAmount',
  // Cost of goods, all NEGATIVE, and all from stream_items rather than the
  // ledger. Listed here so weeks and months roll them through the SAME
  // accumulator as every other figure: a period that summed the biggest cost of
  // running a show differently from the days inside it would be worse than no
  // period at all.
  'breakCost',
  'giveawayCost',
  'cogs',
  'grossProfit',
  'netProfit'
] as const

/** Counts, which add as plain integers. */
const COUNT_FIELDS = [
  'sessionCount',
  'minutes',
  'saleCount',
  'rowCount',
  'carriedBackRows'
] as const

type MoneyField = (typeof MONEY_FIELDS)[number]
type CountField = (typeof COUNT_FIELDS)[number]

function emptyDay(streamDate: string): StreamDayFinance {
  return {
    streamDate,
    sessionCount: 0,
    sessionTitles: [],
    minutes: 0,
    sales: 0,
    saleCount: 0,
    tips: 0,
    bonuses: 0,
    totalRevenue: 0,
    whatnotFee: 0,
    processingFee: 0,
    totalFees: 0,
    netRevenue: 0,
    shippingSubsidy: 0,
    shippingCharges: 0,
    giveawayShipping: 0,
    refundShipping: 0,
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
 * A rollup in progress. Money accumulates in INTEGER CENTS and converts back to
 * dollars exactly once, at the end — adding 27 day figures as floats and then
 * comparing the result to another float sum is how a reconciliation check
 * reports a phantom cent.
 */
interface Rollup {
  money: Map<MoneyField, number>
  counts: Map<CountField, number>
  dates: string[]
}

function newRollup(): Rollup {
  return { money: new Map(), counts: new Map(), dates: [] }
}

/**
 * Add ONE day to a rollup — the only way a week, a month or the grand total is
 * ever built.
 *
 * Every field is SUMMED, including the fees. Recomputing `computeFees` on the
 * period's gross would give the right percentages and the WRONG flat fee: the
 * $0.30 is charged per sale row, so re-deriving it from a period's total gross
 * would silently drop it or re-add it depending on how the period was sliced.
 * Two numbers that must agree and are derived two different ways will eventually
 * disagree, and a week that contradicts the days inside it is worse than no week
 * at all.
 */
function addDay(roll: Rollup, day: StreamDayFinance): void {
  const fields = day as unknown as Record<string, number>
  for (const f of MONEY_FIELDS) roll.money.set(f, (roll.money.get(f) ?? 0) + toCents(fields[f]))
  for (const f of COUNT_FIELDS) roll.counts.set(f, (roll.counts.get(f) ?? 0) + fields[f])
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
    clusters: []
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
  sale: 'sales',
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
function clusterOf(rows: Array<{ occurredAt: string; cents: number }>): UnattributedCluster[] {
  const gapMs = CLUSTER_GAP_MINUTES * 60_000
  const out: UnattributedCluster[] = []
  let current: { from: string; to: string; rowCount: number; cents: number; lastMs: number } | null = null

  for (const r of rows) {
    const ms = new Date(r.occurredAt).getTime()
    if (Number.isNaN(ms)) continue
    if (current && ms - current.lastMs <= gapMs) {
      current.to = r.occurredAt
      current.rowCount += 1
      current.cents += r.cents
      current.lastMs = ms
      continue
    }
    if (current) {
      out.push({
        from: current.from,
        to: current.to,
        rowCount: current.rowCount,
        amount: toDollars(current.cents),
        localDate: streamDateOf(current.from)
      })
    }
    current = { from: r.occurredAt, to: r.occurredAt, rowCount: 1, cents: r.cents, lastMs: ms }
  }
  if (current) {
    out.push({
      from: current.from,
      to: current.to,
      rowCount: current.rowCount,
      amount: toDollars(current.cents),
      localDate: streamDateOf(current.from)
    })
  }
  // Biggest money first: that is the show most worth logging.
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
  const itemRows = db
    .prepare(
      `SELECT s.stream_date AS d, i.kind AS kind,
              COALESCE(SUM(CAST(ROUND(i.cost_total * 100) AS INTEGER)), 0) AS cents,
              COALESCE(SUM(CAST(ROUND(i.loss_value * 100) AS INTEGER)), 0) AS loss
         FROM stream_items i JOIN stream_sessions s ON s.id = i.session_id
        GROUP BY s.stream_date, i.kind`
    )
    .all() as Array<{ d: string; kind: string; cents: number; loss: number }>
  // Both are stored POSITIVE on the line and reported NEGATIVE here: every
  // figure that feeds a bottom line is a signed number, so the total is a plain
  // sum and no screen has to remember which way to apply it. Getting this sign
  // wrong does not fail anywhere — it silently ADDS the cost of a broken case to
  // the profit of the show that broke it.
  for (const r of itemRows) {
    const day = dayFor(r.d)
    if (r.kind === 'giveaway') {
      // ONE cost-of-goods line for given-away stock, not two. `cost_total` is
      // the balance-sheet movement (stock left the shelf); `loss_value` is what
      // that stock was worth as a cost of the show, valued at pack cost when
      // packs went out. Booking both would count the same prize twice.
      day.giveawayCost = toDollars(toCents(day.giveawayCost) - r.loss)
      // The same money under the name this view has always used for it, kept so
      // netAfterCosts and everything reading it keep meaning what they meant.
      day.giveawayLoss = day.giveawayCost
    } else {
      day.breakCost = toDollars(toCents(day.breakCost) - r.cents)
    }
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
        WHERE session_id IS NOT NULL AND stream_date IS NOT NULL AND bucket <> 'payout'
        GROUP BY stream_date, bucket`
    )
    .all() as Array<{ d: string; bucket: string; rows: number; cents: number }>

  for (const r of bucketRows) {
    const day = dayFor(r.d)
    day.rowCount += r.rows
    const bucket = r.bucket as LedgerBucket
    // ONE sale row is ONE transaction, and that is what the flat 30c processing
    // fee is charged on. It is counted here, from the row table, rather than
    // inferred from a dollar total — no average ticket price can recover it.
    if (bucket === 'sale') day.saleCount += r.rows
    const amounts = dayCents.get(r.d) as Partial<Record<LedgerBucket, number>>
    amounts[bucket] = (amounts[bucket] ?? 0) + r.cents
    dayNetCents.set(r.d, (dayNetCents.get(r.d) ?? 0) + r.cents)
    const field = BUCKET_FIELD[bucket]
    if (field) {
      const fields = day as unknown as Record<string, number>
      fields[field] = toDollars(toCents(fields[field]) + r.cents)
    }
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

  // --- what Whatnot actually keeps -------------------------------------------
  //
  // The ledger's "Earnings for selling" figure is GROSS, before Whatnot takes
  // anything (confirmed by the owner; the file itself has no commission line, so
  // this could not be settled from the data). Two charges come off it:
  //   commission  6%   of gross
  //   processing  2.9% of gross PLUS 30c on every sale row
  // Both on the GROSS amount, not one after the other, and on SALES ONLY —
  // shipping subsidies, tips and bonuses arrive whole.
  //
  // The arithmetic is `computeFees` in the contract and is never restated here.
  // A blended "8.9%" would be wrong in exactly the direction that matters: RM
  // sells break spots at small ticket prices, so the flat 30c lands 1,929 times
  // in a single week and is worth another 1.5% on a $20 spot. Modelling it as a
  // percentage understates fees most on the shows that sell the most spots.
  //
  // A DAY IS WHERE FEES ARE COMPUTED, AND THE ONLY PLACE. Weeks, months and the
  // grand total SUM these numbers (see `addDay`); none of them re-derive fees
  // from their own gross, because the flat-fee component would then depend on
  // how the period was sliced and two views of the same money would drift.
  for (const [date, day] of dayMap) {
    const cents = dayCents.get(date) ?? {}
    const salesCents = toCents(day.sales)
    const unknownCents = cents.unclassified ?? 0

    // `unclassified` has no field of its own in the day shape, so its money is
    // carried at FACE VALUE in totalRevenue and flagged in the import warnings.
    // It is deliberately NOT added to `sales`: no fee is charged on a shape this
    // version cannot identify, because charging 8.9% on a guess invents a cost.
    day.totalRevenue = toDollars(
      salesCents + toCents(day.tips) + toCents(day.bonuses) + unknownCents
    )

    const fees = computeFees(day.sales, day.saleCount)
    day.whatnotFee = fees.whatnotFee
    day.processingFee = fees.processingFee
    day.totalFees = fees.totalFees
    day.netRevenue = toDollars(toCents(day.totalRevenue) + toCents(day.totalFees))

    day.netShipping = toDollars(
      toCents(day.shippingSubsidy) +
        toCents(day.shippingCharges) +
        toCents(day.giveawayShipping) +
        toCents(day.refundShipping)
    )

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
    day.netProfit = toDollars(
      toCents(day.grossProfit) +
        toCents(day.totalFees) +
        toCents(day.netShipping) +
        toCents(day.showBoost) +
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
        WHERE session_id IS NULL AND bucket <> 'payout'
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
  unattributed.clusters = clusterOf(
    unRows.map((r) => ({ occurredAt: r.occurred_at, cents: r.cents }))
  )

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

  // The day fields must decompose the SAME money the rows carry. THREE figures
  // on a day are not ledger rows — the fees, which are derived, and both
  // cost-of-goods terms, which come from the Streaming module — so stripping all
  // of them back out has to land exactly on the raw net:
  //     netProfit − totalFees − cogs == Σ(attributed non-payout rows)
  // Subtracting the fees alone was right until the bottom line started carrying
  // stock cost; leaving `cogs` in would report every day with a break as
  // unreconciled, which is exactly the kind of false alarm that teaches an
  // operator to ignore the flag.
  //
  // This is what catches a future bucket that classification learns to produce
  // but the day shape has no field for. Without it that money would vanish from
  // every screen while the row-level reconciliation above still said "fine",
  // because the rows themselves would all still be present and counted.
  let fieldCents = 0
  // The same test for the OTHER published bottom line. netAfterCosts carries the
  // giveaway loss and no break cost, so it strips differently — and a figure
  // nobody checks is a figure that drifts.
  let ledgerFieldCents = 0
  for (const day of days) {
    fieldCents += toCents(day.netProfit) - toCents(day.totalFees) - toCents(day.cogs)
    ledgerFieldCents +=
      toCents(day.netAfterCosts) - toCents(day.totalFees) - toCents(day.giveawayLoss)
  }

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
  } else if (fieldCents !== daysCents) {
    reconciled = false
    reconcileNote =
      `The day breakdown adds to ${money(fieldCents)} before fees and stock cost but ${money(daysCents)} ` +
      `of ledger money is attributed to those days. A bucket is landing in no column — these totals are ` +
      `incomplete, do not book from them.`
  } else if (ledgerFieldCents !== daysCents) {
    reconciled = false
    reconcileNote =
      `Net after costs adds to ${money(ledgerFieldCents)} before fees and the giveaway loss but ` +
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
