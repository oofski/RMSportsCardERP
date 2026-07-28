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
 * 1. Drop a line. Whatnot's export is not valid RFC4180 — it wraps Show Boost
 *    titles in unescaped double quotes — so some lines need repairing, and a
 *    line that still cannot be read is written to `ledger_quarantine` with its
 *    raw text. A vanished row is money with no trace, which is strictly worse
 *    than a loud error.
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
 * Everything about classification, date parsing, identity and the attribution
 * predicate lives in @shared/financeStreaming and is USED here, never restated:
 * main and the renderer must never be able to disagree about what a row is.
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { Result } from '@shared/types'
import type {
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
  carryBackEligible,
  classifyLedgerRow,
  findCarryBackSession,
  ledgerFingerprintSource,
  parseBreakNumber,
  parseLedgerAmount,
  parseLedgerDate,
  rowInSession,
  sumTreatment
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

/**
 * Strict RFC4180 for ONE physical line. Returns null the moment anything is not
 * exactly to spec — a bare `"` inside an unquoted field, a quote followed by
 * something other than `,` or end-of-line, an unterminated quote.
 *
 * Strictness is the point. A lenient parser hands back 8 plausible-looking
 * fields for 7 of Whatnot's 8 malformed rows and quietly produces garbage for
 * the 8th (the one whose show title contains commas reads its Transaction Type
 * as " CACTUS JACK BASKETBALL"). Nothing announces the problem. Failing here is
 * what routes those rows into the anchored repair instead.
 */
function strictSplit(line: string): string[] | null {
  const out: string[] = []
  const n = line.length
  let i = 0
  for (;;) {
    let field = ''
    if (line[i] === '"') {
      i += 1
      for (;;) {
        if (i >= n) return null // unterminated quoted field
        const ch = line[i]
        if (ch === '"') {
          if (line[i + 1] === '"') {
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
      if (i < n && line[i] !== ',') return null // stray text after the close quote
    } else {
      while (i < n && line[i] !== ',') {
        if (line[i] === '"') return null // bare quote in an unquoted field
        field += line[i]
        i += 1
      }
    }
    out.push(field)
    if (i >= n) return out
    i += 1 // consume the comma
  }
}

/**
 * The anchored repair, for Whatnot's unescaped-quote rows.
 *
 * The schema is pinned at BOTH ends: the first four fields and the last three
 * are quote-delimited and none of them can contain a `"` or a `,`. Only
 * `Message` is free text. So bind the head, bind the tail, and let a greedy
 * middle take everything else — which forces the tail anchors onto the LAST
 * three quoted fields and recovers the row with its inner quotes intact.
 *
 * Deliberately per-row, and deliberately recorded: regex-replacing quotes across
 * the whole file before parsing would "fix" it invisibly and there would be no
 * way to tell a repaired row from a clean one afterwards.
 */
const REPAIR_RE =
  /^"([^"]*)","([^"]*)","([^"]*)","([^"]*)",(.*),"([^"]*)","([^"]*)","([^"]*)"$/

function repairSplit(line: string): string[] | null {
  const m = REPAIR_RE.exec(line)
  if (!m) return null
  let message = m[5]
  if (message.startsWith('"')) message = message.slice(1)
  if (message.endsWith('"')) message = message.slice(0, -1)
  message = message.replace(/""/g, '"')
  return [m[1], m[2], m[3], m[4], message, m[6], m[7], m[8]]
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
  /** Physical, non-blank lines after the header. rows + quarantine must equal it. */
  dataLines: number
  headerError: string | null
}

/**
 * Parse strictly, repair second, quarantine third — never in any other order.
 *
 * Line-oriented is safe for this format because no record contains an embedded
 * newline (verified across 9,225 real rows). Should one ever appear, its two
 * halves fail both the strict parse and the repair and land in quarantine with
 * their raw text — visible and recoverable, rather than silently merged into
 * whatever the lenient parser felt like.
 */
function parseLedgerCsv(text: string): ParseOutcome {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split('\n')
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

  const headerLine = lines[0].replace(/\r$/, '')
  const header = strictSplit(headerLine)
  if (!header || header.length !== LEDGER_HEADER.length || LEDGER_HEADER.some((h, i) => header[i] !== h)) {
    out.headerError =
      `That does not look like a Whatnot ledger export. Expected the columns ` +
      `${LEDGER_HEADER.join(', ')} but the file starts with: ${headerLine.slice(0, 300)}`
    return out
  }

  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i].replace(/\r$/, '')
    if (!raw.trim()) continue // blank lines are not data and are not rejects
    out.dataLines += 1
    const strict = strictSplit(raw)
    if (strict && strict.length === LEDGER_HEADER.length) {
      out.rows.push({ lineNumber: i + 1, fields: strict, repaired: false })
      continue
    }
    const fixed = repairSplit(raw)
    if (fixed) {
      out.repaired += 1
      out.rows.push({ lineNumber: i + 1, fields: fixed, repaired: true })
      continue
    }
    out.quarantine.push({
      lineNumber: i + 1,
      raw,
      reason:
        strict === null
          ? 'The line is not valid CSV and the anchored repair did not match it.'
          : `Expected ${LEDGER_HEADER.length} fields, found ${strict.length}.`
    })
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

function fingerprintOf(
  createdRaw: string,
  amount: number,
  listingId: string,
  orderId: string,
  message: string,
  txnType: string
): string {
  return createHash('sha256')
    .update(ledgerFingerprintSource(createdRaw, amount, listingId, orderId, message, txnType))
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
      // parseLedgerAmount treats "$" as 0 (Number('') === 0), so require a digit
      // before trusting it. A zero-amount row is real and common (381 of 636
      // shipping subsidies are $0.00); a DIGITLESS amount cell is not.
      const amount = /\d/.test(amountRaw) ? parseLedgerAmount(amountRaw) : null
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
        fingerprint: fingerprintOf(createdRaw, amount, listingId, orderId, message, txnType),
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

  if (stats.unattributedRows > 0) {
    warnings.push(
      `${stats.unattributedRows} row${stats.unattributedRows === 1 ? '' : 's'} (${money(stats.unattributedCents)}) fell outside ` +
        `every logged show. Add the missing session and re-run attribution — nothing has been reassigned or dropped.`
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

function emptyDay(streamDate: string): StreamDayFinance {
  return {
    streamDate,
    sessionCount: 0,
    sessionTitles: [],
    minutes: 0,
    sales: 0,
    shippingSubsidy: 0,
    tips: 0,
    bonuses: 0,
    reversals: 0,
    giveawayShipping: 0,
    shippingCharges: 0,
    refundShipping: 0,
    showBoost: 0,
    grossRevenue: 0,
    showCosts: 0,
    netRevenue: 0,
    rowCount: 0,
    carriedBackRows: 0,
    carriedBackAmount: 0,
    breakCost: 0,
    giveawayCost: 0
  }
}

function emptyTotals(): StreamFinanceTotals {
  const day = emptyDay('')
  const rest = day as Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'> &
    Partial<Pick<StreamDayFinance, 'streamDate' | 'sessionTitles'>>
  delete rest.streamDate
  delete rest.sessionTitles
  return { ...(rest as Omit<StreamDayFinance, 'streamDate' | 'sessionTitles'>), dayCount: 0 }
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
    totals: emptyTotals(),
    unattributed: emptyUnattributed(),
    imports: [],
    reconciled: true,
    reconcileNote: null
  }
}

/** bucket key → the named field it lands in on a day. */
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

  const itemRows = db
    .prepare(
      `SELECT s.stream_date AS d, i.kind AS kind,
              COALESCE(SUM(CAST(ROUND(i.cost_total * 100) AS INTEGER)), 0) AS cents
         FROM stream_items i JOIN stream_sessions s ON s.id = i.session_id
        GROUP BY s.stream_date, i.kind`
    )
    .all() as Array<{ d: string; kind: string; cents: number }>
  for (const r of itemRows) {
    const day = dayFor(r.d)
    if (r.kind === 'giveaway') day.giveawayCost = toDollars(toCents(day.giveawayCost) + r.cents)
    else day.breakCost = toDollars(toCents(day.breakCost) + r.cents)
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

  for (const [date, day] of dayMap) {
    const cents = dayCents.get(date) ?? {}
    const dollars: Partial<Record<LedgerBucket, number>> = {}
    for (const key of Object.keys(cents) as LedgerBucket[]) {
      dollars[key] = toDollars(cents[key] as number)
    }
    // sumTreatment is the ONE definition of a day's arithmetic, shared with the
    // renderer. `unclassified` is treated as revenue here on purpose: the money
    // is included at face value and flagged, never dropped, so the totals still
    // tie out while the warning says the shape is unrecognised.
    day.grossRevenue = sumTreatment(dollars, 'revenue') + sumTreatment(dollars, 'contra')
    day.grossRevenue = toDollars(toCents(day.grossRevenue))
    day.showCosts = sumTreatment(dollars, 'expense')
    day.netRevenue = toDollars(toCents(day.grossRevenue) + toCents(day.showCosts))
  }

  const days = [...dayMap.values()].sort((a, b) =>
    a.streamDate < b.streamDate ? -1 : a.streamDate > b.streamDate ? 1 : 0
  )

  // --- totals ---------------------------------------------------------------
  const totals = emptyTotals()
  const MONEY_FIELDS: Array<keyof StreamFinanceTotals> = [
    'sales',
    'shippingSubsidy',
    'tips',
    'bonuses',
    'reversals',
    'giveawayShipping',
    'shippingCharges',
    'refundShipping',
    'showBoost',
    'grossRevenue',
    'showCosts',
    'netRevenue',
    'carriedBackAmount',
    'breakCost',
    'giveawayCost'
  ]
  const acc = new Map<string, number>()
  for (const day of days) {
    const dayFields = day as unknown as Record<string, number>
    totals.dayCount += 1
    totals.sessionCount += day.sessionCount
    totals.minutes += day.minutes
    totals.rowCount += day.rowCount
    totals.carriedBackRows += day.carriedBackRows
    for (const f of MONEY_FIELDS) {
      acc.set(f, (acc.get(f) ?? 0) + toCents(dayFields[f]))
    }
  }
  const totalFields = totals as unknown as Record<string, number>
  for (const f of MONEY_FIELDS) totalFields[f] = toDollars(acc.get(f) ?? 0)

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
  }

  return {
    days,
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
