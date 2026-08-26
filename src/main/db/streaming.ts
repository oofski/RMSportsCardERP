import type { Database } from 'better-sqlite3'
import type { Result } from '@shared/types'
import type {
  NewStreamItem,
  NewStreamSession,
  SetStreamItemCost,
  StreamCalendarDay,
  StreamCalendarMonth,
  StreamCrewMember,
  StreamItem,
  StreamItemKind,
  StreamSession,
  StreamSessionDetail,
  StreamStatus,
  StreamTotals,
  UpdateStreamSession
} from '@shared/streaming'
import {
  durationMinutes,
  hostFromCrew,
  isPastDatedSession,
  normalizeCrew,
  parseMoneyInput,
  sessionsOverlap,
  streamDateOf
} from '@shared/streaming'
import { isLocation } from '@shared/inventory'
// The unit contract. Never reimplemented here: what one unit of stock MEANS
// varies per product, and a second copy of that arithmetic is an
// order-of-magnitude error waiting to happen.
import { boxCost, breakToStock, giveawayToStock, packCost, quantizationSlack, type ProductUnits } from '@shared/units'
import { getDb } from './database'
import {
  QTY_EPS,
  consumeLots,
  restoreFifo,
  roundQty,
  slicesCost,
  syncProductAvgCost,
  type LotSlice
} from './lots'
import { tidyPicks, type LotPick } from '@shared/costLots'
// Shared with db/inventory.ts rather than reimplemented: a stream line moves
// stock the same way a sale does, and one implementation is the only way that
// stays true.
import { bumpStock, insertTxn, productThumbnail, stockQty, stockUnitOf } from './inventory'
import { newId, nowIso } from '../util'

/**
 * Streaming — show sessions and the stock they consumed.
 *
 * Two rules run through everything here.
 *
 * A session is an absolute time window that belongs to ONE business day: the
 * local calendar date it STARTED on. Shows run past midnight, so the day a sale
 * landed is not the day the show belongs to, and every grouping in this file is
 * on `stream_date` rather than on a timestamp. See @shared/streaming.
 *
 * Sessions may not overlap. An overlap makes a sale's owning show ambiguous and
 * there is no correct way to resolve it afterwards, so it is refused at entry —
 * on create AND on edit — naming the show it collides with.
 *
 * A break or a giveaway is the same operation against inventory as a sale (pull
 * N units out of a location at their real FIFO cost) and takes the SAME path in
 * the same order as recordSale, so the two can never value a movement
 * differently. What it additionally records is the exact cost layers it took, in
 * stream_item_lots, which is what makes removing a line able to give back
 * precisely what it took instead of re-lotting at today's average.
 */

const cents = (n: number): number => Math.round(n * 100) / 100

/** A stream line is visible in inventory history like every other movement, and
 * says which of the two things it was. */
function txnType(kind: StreamItemKind): string {
  return kind === 'break' ? 'stream_break' : 'stream_giveaway'
}

// ---------------------------------------------------------------------------
// Rows → contract types
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string
  title: string
  started_at: string
  ended_at: string | null
  stream_date: string
  status: string
  source: string
  host_id: string | null
  host_name: string | null
  /** Newline-joined, ordered by position. See zipCrew. */
  crew_ids: string | null
  crew_names: string | null
  note: string | null
  created_at: string
  updated_at: string
  created_by: string | null
}

interface ItemRow {
  id: string
  session_id: string
  kind: string
  product_id: string | null
  product_name: string
  sku: string
  category: string
  break_number: number | null
  recipient: string | null
  quantity: number
  entered_cases: number | null
  entered_boxes: number | null
  entered_packs: number | null
  location: string
  unit_cost: number
  cost_total: number
  stated_case_price: number | null
  pack_cost: number | null
  loss_value: number
  note: string | null
  created_at: string
  created_by: string | null
  /** Joined from the catalog, not stored on the line. NULL once the product is
   *  deleted — see `StreamItem.stockUnit`. */
  unit_type: string | null
}

const SESSION_SELECT = `
  SELECT s.id, s.title, s.started_at, s.ended_at, s.stream_date, s.status, s.source,
         s.host_id, (e.first_name || ' ' || e.last_name) AS host_name,
         s.note, s.created_at, s.updated_at, s.created_by,
         -- THE WHOLE CREW, in one read.
         --
         -- A show is run by more than one person and host_id holds one of them.
         -- It still does — it is the FIRST of the crew and every existing read
         -- of it is unchanged — and this is the rest, gathered here rather than
         -- fetched per session because the calendar draws a month of them.
         --
         -- Ids and names come back as two parallel newline-joined strings
         -- ordered by the same position, so a crew member whose employee record
         -- is gone still occupies its slot rather than shifting everybody else
         -- up by one. See toSession, which zips them.
         (SELECT GROUP_CONCAT(h.employee_id, char(10))
            FROM (SELECT employee_id FROM stream_session_hosts
                   WHERE session_id = s.id ORDER BY position ASC, rowid ASC) h) AS crew_ids,
         (SELECT GROUP_CONCAT(COALESCE(TRIM(he.first_name || ' ' || he.last_name), ''), char(10))
            FROM (SELECT employee_id FROM stream_session_hosts
                   WHERE session_id = s.id ORDER BY position ASC, rowid ASC) h
            LEFT JOIN employees he ON he.id = h.employee_id) AS crew_names
  FROM stream_sessions s
  LEFT JOIN employees e ON e.id = s.host_id
`

/**
 * The two parallel GROUP_CONCATs above, back into a list.
 *
 * SPLIT ON NEWLINE, not on a comma: a person called "Vega, Marisol" is a name
 * somebody can type into an employee record, and a comma separator would tear
 * them into two crew members. A newline cannot appear in either column.
 *
 * A missing NAME keeps its slot with a null, so the ids and the names stay in
 * step. Dropping the row would shift everybody after it up by one and put
 * somebody else's name against this id.
 */
function zipCrew(ids: string | null, names: string | null): StreamCrewMember[] {
  const idList = (ids ?? '').split('\n').filter((v) => v.trim())
  if (idList.length === 0) return []
  const nameList = (names ?? '').split('\n')
  return idList.map((id, i) => ({
    employeeId: id.trim(),
    name: (nameList[i] ?? '').trim() || null
  }))
}

function toSession(row: SessionRow): StreamSession {
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    streamDate: row.stream_date,
    status: row.status === 'ended' ? 'ended' : 'live',
    source: row.source === 'manual' ? 'manual' : 'live',
    hostId: row.host_id,
    // NULL when the employee record is gone; the id is kept either way so the
    // line still says a host was set.
    hostName: row.host_name?.trim() || null,
    crew: zipCrew(row.crew_ids, row.crew_names),
    note: row.note,
    durationMinutes: durationMinutes(row.started_at, row.ended_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by
  }
}

/** Thumbnails are resolved through a per-call cache: a session usually breaks
 * the same product repeatedly, and each miss reads an image off disk. */
function toItem(row: ItemRow, thumbs: Map<string, string | null>): StreamItem {
  let image: string | null = null
  if (row.product_id) {
    if (!thumbs.has(row.product_id)) thumbs.set(row.product_id, productThumbnail(row.product_id))
    image = thumbs.get(row.product_id) ?? null
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind === 'giveaway' ? 'giveaway' : 'break',
    productId: row.product_id,
    productName: row.product_name,
    sku: row.sku,
    category: row.category,
    image,
    breakNumber: row.break_number,
    recipient: row.recipient,
    quantity: row.quantity,
    enteredCases: row.entered_cases,
    enteredBoxes: row.entered_boxes,
    enteredPacks: row.entered_packs,
    location: row.location,
    unitCost: row.unit_cost,
    costTotal: row.cost_total,
    statedCasePrice: row.stated_case_price,
    packCost: row.pack_cost,
    lossValue: row.loss_value ?? 0,
    // Which unit `quantity` counts, joined live off the catalog rather than
    // snapshotted: it is not a fact about what happened on the night, it is what
    // the product IS, and a price typed against this line has to be per whatever
    // the product is stocked in today. Null once the catalog row is gone, and
    // for anything the unit contract has no case/box structure for.
    stockUnit: row.unit_type ? stockUnitOf(row.unit_type) : null,
    note: row.note,
    createdAt: row.created_at,
    createdBy: row.created_by
  }
}

function emptyTotals(): StreamTotals {
  return {
    breakLines: 0,
    breakUnits: 0,
    breakCost: 0,
    giveawayLines: 0,
    giveawayUnits: 0,
    giveawayCost: 0,
    giveawayLoss: 0,
    totalCost: 0
  }
}

function totalsOf(items: StreamItem[]): StreamTotals {
  const t = emptyTotals()
  for (const item of items) {
    if (item.kind === 'break') {
      t.breakLines += 1
      t.breakUnits += item.quantity
      t.breakCost += item.costTotal
    } else {
      t.giveawayLines += 1
      t.giveawayUnits += item.quantity
      t.giveawayCost += item.costTotal
      t.giveawayLoss += item.lossValue
    }
  }
  // Units can be fractional on a giveaway-flagged product, so the sums are
  // re-rounded rather than left as a float trail.
  t.breakUnits = qtySum(t.breakUnits)
  t.giveawayUnits = qtySum(t.giveawayUnits)
  t.breakCost = cents(t.breakCost)
  t.giveawayCost = cents(t.giveawayCost)
  t.giveawayLoss = cents(t.giveawayLoss)
  t.totalCost = cents(t.breakCost + t.giveawayCost)
  return t
}

const qtySum = (n: number): number => Math.round(n * 10000) / 10000

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validInstant(iso: string): boolean {
  return !!iso && !Number.isNaN(new Date(iso).getTime())
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

interface OverlapRow {
  id: string
  title: string
  started_at: string
  ended_at: string | null
}

/** "Monday Night Rip" (Jul 27, 9:00 PM–2:00 AM) — enough for the operator to
 * recognise which show is in the way without opening the calendar. */
function describeSession(row: OverlapRow): string {
  const title = row.title.trim() || 'an untitled stream'
  const start = new Date(row.started_at)
  if (Number.isNaN(start.getTime())) return `"${title}"`
  const time = (d: Date): string => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (!row.ended_at) return `"${title}" (${day} ${time(start)}, still live)`
  const end = new Date(row.ended_at)
  if (Number.isNaN(end.getTime())) return `"${title}" (${day} ${time(start)})`
  return `"${title}" (${day} ${time(start)}–${time(end)})`
}

/**
 * THE validation of this module. Checked against every other session, on create
 * and on edit alike, because an overlap introduced by an edit is exactly as
 * ambiguous as one introduced by a create.
 *
 * Session count is tiny (a few hundred a year) so the scan is cheap and, unlike
 * a SQL range predicate, it uses the same sessionsOverlap() the renderer does —
 * main and renderer can never disagree about what a conflict is.
 */
function overlapError(
  db: Database,
  startedAt: string,
  endedAt: string | null,
  exceptId: string | null
): string | null {
  const rows = (
    exceptId
      ? db.prepare('SELECT id, title, started_at, ended_at FROM stream_sessions WHERE id <> ?').all(exceptId)
      : db.prepare('SELECT id, title, started_at, ended_at FROM stream_sessions').all()
  ) as OverlapRow[]
  for (const row of rows) {
    if (sessionsOverlap(startedAt, endedAt, row.started_at, row.ended_at)) {
      return `That overlaps ${describeSession(row)}. Two shows cannot share the same minute — a sale inside the overlap would have no single owner.`
    }
  }
  return null
}

/** Shared start/end sanity for both the manual create and the edit. */
function timeError(startedAt: string, endedAt: string | null): string | null {
  if (!validInstant(startedAt)) return 'Enter a valid start time.'
  if (endedAt !== null) {
    if (!validInstant(endedAt)) return 'Enter a valid end time.'
    if (new Date(endedAt).getTime() <= new Date(startedAt).getTime()) {
      return 'The end time has to be after the start time.'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Sessions — reads
// ---------------------------------------------------------------------------

function getSession(id: string): StreamSession | null {
  const row = getDb().prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined
  return row ? toSession(row) : null
}

/**
 * The show currently on air. At most one can exist — two open-ended sessions
 * both run to the end of time and therefore always overlap, so the overlap
 * check has already refused the second. LIMIT 1 is belt-and-braces for a
 * database that predates that guarantee.
 */
export function getActiveSession(): StreamSession | null {
  const row = getDb()
    .prepare(`${SESSION_SELECT} WHERE s.status = 'live' ORDER BY s.started_at DESC LIMIT 1`)
    .get() as SessionRow | undefined
  return row ? toSession(row) : null
}

/** Sessions whose BUSINESS DAY falls in [from, to], newest first. Deliberately
 * ranged on stream_date, never on started_at: a 1am session belongs to the
 * previous evening and has to come back with it. */
export function listSessions(from: string, to: string): StreamSession[] {
  const rows = getDb()
    .prepare(
      `${SESSION_SELECT}
       WHERE s.stream_date >= ? AND s.stream_date <= ?
       ORDER BY s.stream_date DESC, s.started_at DESC`
    )
    .all(from, to) as SessionRow[]
  return rows.map(toSession)
}

export function getSessionDetail(id: string): StreamSessionDetail | null {
  const session = getSession(id)
  if (!session) return null
  const rows = getDb()
    .prepare(
      `SELECT i.id, i.session_id, i.kind, i.product_id, i.product_name, i.sku, i.category,
              i.break_number, i.recipient, i.quantity, i.entered_cases, i.entered_boxes,
              i.entered_packs, i.location, i.unit_cost, i.cost_total, i.stated_case_price,
              i.pack_cost, i.loss_value, i.note, i.created_at, i.created_by,
              p.unit_type AS unit_type
       FROM stream_items i
       LEFT JOIN inventory_products p ON p.id = i.product_id
       WHERE i.session_id = ? ORDER BY i.created_at ASC, i.rowid ASC`
    )
    .all(id) as ItemRow[]
  const thumbs = new Map<string, string | null>()
  const items = rows.map((r) => toItem(r, thumbs))
  return { session, items, totals: totalsOf(items) }
}

// ---------------------------------------------------------------------------
// Sessions — writes
// ---------------------------------------------------------------------------

/**
 * Write the crew, and keep `host_id` as the first of them.
 *
 * ONE FUNCTION FOR BOTH, and that is the whole reason it exists: two places
 * deciding who leads is how a show comes to name one person in its header and a
 * different one in its list. Every caller here goes through this, so the column
 * and the table cannot drift.
 *
 * ## Replace, not merge
 *
 * The list arrives complete from a picker that shows the whole crew, so a
 * removal is expressed by a name being ABSENT. Merging would make it impossible
 * to take anybody off a show.
 *
 * ## And it accepts either input
 *
 * A caller that only knows about a single host — the live bar's Start button,
 * anything written before crews existed — passes `hostId` and gets a one-person
 * crew. A caller that passes `crew` gets the host set from it. Passing neither
 * leaves the session alone, which is what an edit of the title must do.
 */
function writeCrew(
  db: Database,
  sessionId: string,
  crew: readonly string[],
  stamp: string
): void {
  db.prepare(`DELETE FROM stream_session_hosts WHERE session_id = ?`).run(sessionId)
  const put = db.prepare(
    `INSERT INTO stream_session_hosts (id, session_id, employee_id, position, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
  crew.forEach((employeeId, i) => put.run(newId(), sessionId, employeeId, i, stamp))
  db.prepare(`UPDATE stream_sessions SET host_id = ?, updated_at = ? WHERE id = ?`).run(
    hostFromCrew(crew),
    stamp,
    sessionId
  )
}

/**
 * What a caller meant, whichever of the two fields they sent.
 *
 * `crew` wins when present, because it is the richer statement. `hostId` alone
 * is a one-person crew. Both absent is null, which callers read as "leave it".
 */
function crewFromInput(input: {
  hostId?: string | null
  crew?: readonly string[]
}): string[] | null {
  if (input?.crew !== undefined) return normalizeCrew(input.crew)
  if (input?.hostId !== undefined) return normalizeCrew([input.hostId])
  return null
}

/**
 * Clock a show on air. The start is NOW, so the only thing that can be entered
 * wrongly is the title — which is the whole point of this path existing beside
 * the manual one.
 */
export function startSession(
  input: { title: string; hostId: string | null; note: string | null },
  actorId: string | null
): Result<StreamSession> {
  const db = getDb()
  if (getActiveSession()) return { ok: false, error: 'A stream is already live — end it first.' }
  const startedAt = nowIso()
  // A live session runs to the end of time, so it can still collide with a
  // window already typed in for tonight. Say which one rather than creating an
  // overlap that no later report could untangle.
  const clash = overlapError(db, startedAt, null, null)
  if (clash) return { ok: false, error: clash }

  const id = newId()
  db.prepare(
    `INSERT INTO stream_sessions
       (id, title, started_at, ended_at, stream_date, status, source, host_id, note,
        created_at, updated_at, created_by)
     VALUES (@id, @title, @started_at, NULL, @stream_date, 'live', 'live', @host_id, @note,
             @ts, @ts, @created_by)`
  ).run({
    id,
    title: (input?.title ?? '').trim(),
    started_at: startedAt,
    stream_date: streamDateOf(startedAt),
    host_id: input?.hostId || null,
    note: input?.note?.trim() || null,
    ts: startedAt,
    created_by: actorId
  })
  writeCrew(db, id, crewFromInput(input) ?? [], startedAt)
  return { ok: true, data: getSession(id) as StreamSession }
}

export function endSession(id: string, actorId: string | null): Result<StreamSession> {
  void actorId
  const db = getDb()
  const row = db.prepare('SELECT id, status FROM stream_sessions WHERE id = ?').get(id) as
    | { id: string; status: StreamStatus }
    | undefined
  if (!row) return { ok: false, error: 'That stream session no longer exists.' }
  if (row.status !== 'live') return { ok: false, error: 'That stream has already ended.' }
  const ts = nowIso()
  db.prepare(
    "UPDATE stream_sessions SET ended_at = ?, status = 'ended', updated_at = ? WHERE id = ?"
  ).run(ts, ts, id)
  return { ok: true, data: getSession(id) as StreamSession }
}

/**
 * Type in a show that was never clocked — the common case, because Start stream
 * gets forgotten. Identical to a clocked session for every downstream purpose;
 * `source` records only that the times were recalled rather than measured.
 *
 * An open-ended manual session is allowed (the show is on air and nobody
 * clocked it), and reads as live, which is what it is.
 */
export function createSession(input: NewStreamSession, actorId: string | null): Result<StreamSession> {
  const db = getDb()
  const startedAt = (input?.startedAt ?? '').trim()
  const endedAt = input?.endedAt ? String(input.endedAt).trim() : null

  const bad = timeError(startedAt, endedAt)
  if (bad) return { ok: false, error: bad }
  const clash = overlapError(db, startedAt, endedAt, null)
  if (clash) return { ok: false, error: clash }

  const id = newId()
  const ts = nowIso()
  db.prepare(
    `INSERT INTO stream_sessions
       (id, title, started_at, ended_at, stream_date, status, source, host_id, note,
        created_at, updated_at, created_by)
     VALUES (@id, @title, @started_at, @ended_at, @stream_date, @status, 'manual', @host_id, @note,
             @ts, @ts, @created_by)`
  ).run({
    id,
    title: (input?.title ?? '').trim(),
    started_at: startedAt,
    ended_at: endedAt,
    stream_date: streamDateOf(startedAt),
    status: endedAt ? 'ended' : 'live',
    host_id: input?.hostId || null,
    note: input?.note?.trim() || null,
    ts,
    created_by: actorId
  })
  writeCrew(db, id, crewFromInput(input) ?? [], ts)
  return { ok: true, data: getSession(id) as StreamSession }
}

/**
 * Correct a session. Every field is optional; anything omitted keeps its
 * current value, so the caller never has to round-trip a whole record to fix
 * one time.
 */
export function updateSession(input: UpdateStreamSession, actorId: string | null): Result<StreamSession> {
  void actorId
  const db = getDb()
  const existing = getSession((input?.id ?? '').trim())
  if (!existing) return { ok: false, error: 'That stream session no longer exists.' }

  const startedAt = input.startedAt !== undefined ? String(input.startedAt).trim() : existing.startedAt
  const endedAt =
    input.endedAt !== undefined ? (input.endedAt ? String(input.endedAt).trim() : null) : existing.endedAt

  const bad = timeError(startedAt, endedAt)
  if (bad) return { ok: false, error: bad }
  // Excluding this session is what makes an edit that changes nothing about the
  // times succeed — it would otherwise always collide with itself.
  const clash = overlapError(db, startedAt, endedAt, existing.id)
  if (clash) return { ok: false, error: clash }

  const streamDate = streamDateOf(startedAt)

  /**
   * ONE TRANSACTION, because two rows now have to agree about the business day.
   *
   * The session's own `stream_date` used to be rewritten alone, and the comment
   * below claimed that moved "everything attributed to it" with it. It did not:
   * `ledger_rows.stream_date` is written at import and re-attribution and
   * nowhere else, so correcting a show's start across midnight left its revenue
   * and fees on the old day while the show and its cost of goods moved to the
   * new one. Finance then reported one night as two half-days — the first with
   * all the money and no show, the second with the show and no money — and
   * neither figure was the show's real net.
   */
  const run = db.transaction((): void => {
  db.prepare(
    `UPDATE stream_sessions
        SET title = @title, started_at = @started_at, ended_at = @ended_at,
            stream_date = @stream_date, status = @status, host_id = @host_id,
            note = @note, updated_at = @updated_at
      WHERE id = @id`
  ).run({
    id: existing.id,
    title: input.title !== undefined ? input.title.trim() : existing.title,
    started_at: startedAt,
    ended_at: endedAt,
    // Recomputed on every write because the business day IS the local date the
    // show started on. The ledger rows attributed to this session are moved to
    // match, below — the two must never disagree.
    stream_date: streamDate,
    // Status follows the end time rather than being edited on its own: a
    // session with an end is off air, one without is on it. Clearing an end
    // therefore puts a show back on air, which is safe only because two
    // open-ended sessions always overlap — so the check above has already
    // refused it if another stream is live.
    status: endedAt ? 'ended' : 'live',
    host_id: input.hostId !== undefined ? input.hostId || null : existing.hostId,
    note: input.note !== undefined ? input.note?.trim() || null : existing.note,
    updated_at: nowIso()
  })

    /**
     * Re-home the rows already booked to this session.
     *
     * This moves the DAY, which is what the edit actually changed. It does not
     * re-decide WHICH rows belong to the session: if the window also shrank,
     * rows now outside it stay attached until the operator presses Re-attribute
     * in Finance, exactly as they always have. Re-running attribution from here
     * would mean this module reaching into the ledger engine, and the honest
     * fix for that case is the button — which is why it is no longer hidden
     * behind "there is unattributed money".
     */
    db.prepare('UPDATE ledger_rows SET stream_date = @d WHERE session_id = @id').run({
      d: streamDate,
      id: existing.id
    })

    /**
     * The crew, LAST — after the UPDATE above, which also writes host_id.
     *
     * Order matters: writeCrew sets host_id from the first of the crew, and
     * running it first would have the statement above overwrite that with the
     * caller's (or the existing) hostId a moment later. Whoever writes last
     * wins, and the crew is the richer statement.
     *
     * Only when the caller SAID something. crewFromInput returns null when
     * neither field was sent, and an edit that changes only the title must not
     * clear the crew — which replacing with an empty list is exactly what it
     * would do.
     */
    const crew = crewFromInput(input)
    if (crew) writeCrew(db, existing.id, crew, nowIso())
  })
  run()
  return { ok: true, data: getSession(existing.id) as StreamSession }
}

/**
 * Delete a session and everything it consumed. The stock its lines took comes
 * back through the SAME path removeItem uses, so a stream deleted whole and a
 * stream emptied line by line leave inventory in identical states.
 *
 * One transaction: a session whose rows are gone but whose stock never returned
 * would be silently unrecoverable.
 */
export function deleteSession(id: string, actorId: string | null): Result {
  const db = getDb()
  const run = db.transaction((): Result => {
    const header = db.prepare('SELECT id, title FROM stream_sessions WHERE id = ?').get(id) as
      | { id: string; title: string }
      | undefined
    if (!header) return { ok: false, error: 'That stream session no longer exists.' }
    const note = `Deleted stream ${header.title.trim() || '(untitled)'}`
    // Newest line first, mirroring the PO cancel path: unwinding in reverse
    // order of consumption never leaves a lot half-restored behind a later one.
    const items = db
      .prepare('SELECT id FROM stream_items WHERE session_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(id) as Array<{ id: string }>
    for (const item of items) restoreItemStock(db, item.id, note, actorId)
    db.prepare('DELETE FROM stream_sessions WHERE id = ?').run(id)
    return { ok: true }
  })
  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** Half-open [from, to) bounds for a 'YYYY-MM' month; null when unparseable. */
function monthBounds(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month.trim())
  if (!m) return null
  const year = Number(m[1])
  const mon = Number(m[2])
  if (mon < 1 || mon > 12) return null
  const nextYear = mon === 12 ? year + 1 : year
  const nextMon = mon === 12 ? 1 : mon + 1
  return { from: `${m[1]}-${m[2]}-01`, to: `${nextYear}-${String(nextMon).padStart(2, '0')}-01` }
}

/**
 * A month of activity, one entry per day that HAS any — the renderer builds the
 * grid, so emitting empty cells here would only be data it has to filter back
 * out.
 *
 * Grouped on stream_date, NEVER on the date a session ended. That single choice
 * is the module: a Monday show that ends at 2am is entirely Monday's, and
 * bucketing it by its end would put half of RM's shows on the wrong day.
 */
export function calendarMonth(month: string): StreamCalendarMonth {
  const key = month.trim()
  const bounds = monthBounds(key)
  const totals = { ...emptyTotals(), sessionCount: 0, minutes: 0 }
  if (!bounds) return { month: key, days: [], totals }

  const db = getDb()
  const sessions = db
    .prepare(
      `SELECT stream_date, status, started_at, ended_at FROM stream_sessions
       WHERE stream_date >= ? AND stream_date < ?`
    )
    .all(bounds.from, bounds.to) as Array<{
    stream_date: string
    status: string
    started_at: string
    ended_at: string | null
  }>

  const itemRows = db
    .prepare(
      `SELECT s.stream_date AS d, i.kind AS kind, COUNT(*) AS lines,
              COALESCE(SUM(i.quantity), 0) AS units, COALESCE(SUM(i.cost_total), 0) AS cost,
              COALESCE(SUM(i.loss_value), 0) AS loss
       FROM stream_items i
       JOIN stream_sessions s ON s.id = i.session_id
       WHERE s.stream_date >= ? AND s.stream_date < ?
       GROUP BY s.stream_date, i.kind`
    )
    .all(bounds.from, bounds.to) as Array<{
    d: string
    kind: string
    lines: number
    units: number
    cost: number
    loss: number
  }>

  const byDay = new Map<string, StreamCalendarDay>()
  const dayFor = (date: string): StreamCalendarDay => {
    let cell = byDay.get(date)
    if (!cell) {
      cell = { date, sessionCount: 0, liveCount: 0, minutes: 0, breakUnits: 0, giveawayUnits: 0, cost: 0 }
      byDay.set(date, cell)
    }
    return cell
  }

  for (const s of sessions) {
    const cell = dayFor(s.stream_date)
    cell.sessionCount += 1
    if (s.status === 'live') cell.liveCount += 1
    // A live show contributes nothing yet: its duration is not a fact until it
    // ends, and guessing "so far" would make yesterday's total change overnight.
    cell.minutes += durationMinutes(s.started_at, s.ended_at) ?? 0
  }

  for (const r of itemRows) {
    const cell = dayFor(r.d)
    if (r.kind === 'giveaway') {
      cell.giveawayUnits += r.units
      totals.giveawayLines += r.lines
      totals.giveawayUnits += r.units
      totals.giveawayCost += r.cost
      totals.giveawayLoss += r.loss
    } else {
      cell.breakUnits += r.units
      totals.breakLines += r.lines
      totals.breakUnits += r.units
      totals.breakCost += r.cost
    }
    cell.cost = cents(cell.cost + r.cost)
  }

  const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  totals.sessionCount = sessions.length
  totals.minutes = days.reduce((sum, d) => sum + d.minutes, 0)
  totals.breakUnits = qtySum(totals.breakUnits)
  totals.giveawayUnits = qtySum(totals.giveawayUnits)
  totals.breakCost = cents(totals.breakCost)
  totals.giveawayCost = cents(totals.giveawayCost)
  totals.giveawayLoss = cents(totals.giveawayLoss)
  totals.totalCost = cents(totals.breakCost + totals.giveawayCost)
  return { month: key, days, totals }
}

// ---------------------------------------------------------------------------
// Items — the stock path
// ---------------------------------------------------------------------------

function normalizeBreakNumber(value: number | null | undefined): number | null {
  const n = Math.round(Number(value))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** What the movement reads as in inventory history, where the reader has no
 * stream context — so it has to name the show itself. */
function ledgerNote(
  title: string,
  kind: StreamItemKind,
  breakNumber: number | null,
  recipient: string | null,
  reconciled = false
): string {
  const show = title.trim() || 'Stream'
  const what =
    kind === 'break'
      ? breakNumber
        ? `${show} — Break #${breakNumber}`
        : `${show} — break`
      : recipient
        ? `${show} — giveaway to ${recipient}`
        : `${show} — giveaway`
  // A reconciliation row carries a cost and a quantity change of zero, and
  // somebody reading inventory history has no other way to tell why. Saying so
  // on the row is cheaper than their working it out from the arithmetic.
  return reconciled ? `${what} (reconciled — stock had already gone)` : what
}

/** A supplied entered-unit field, or null when the caller omitted it. Anything
 *  non-numeric is null rather than 0 — "not entered" and "zero" are different
 *  answers and the unit contract treats them differently. */
function enteredUnit(value: number | null | undefined): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * What a giveaway COST THE SHOW, and what one pack of it was worth.
 *
 * The P&L side of a giveaway. The FIFO consumption beside it is the
 * balance-sheet side (stock left the shelf at what it cost); this is what
 * running the show cost in prizes. They are not double counting — one moves
 * inventory, the other is reported as a cost of the day alongside Show Boost.
 *
 * Valued at PACK cost when packs were given away, because that is the unit that
 * left: `packCost` divides the cost of a stock unit down through boxes to packs
 * and returns null rather than a guess when a divisor is missing. Otherwise it
 * is simply the cost of the whole boxes that went out.
 *
 * A reconciled giveaway enters no packs, so it lands on that second branch and
 * the loss is the cost that was stated for it — which is exactly right: what the
 * prize cost the business is what the business paid for it.
 *
 * ONE FUNCTION because two callers now need it. `addItem` values a giveaway as
 * it is recorded, and `setItemCost` re-values one whose price arrives weeks
 * later. A second copy of this arithmetic would let the same prize be worth two
 * different things depending on when its cost was typed, and only one of the two
 * figures would be in the statement.
 */
function giveawayLossOf(
  units: ProductUnits | null,
  perStockUnit: number,
  costTotal: number,
  boxes: number | null,
  packs: number | null
): { lossValue: number; packCost: number | null } {
  let packCostVal: number | null = null
  let lossValue = costTotal
  if (units) {
    packCostVal = packCost(units, perStockUnit)
    const perBox = boxCost(units, perStockUnit)
    if ((packs ?? 0) > 0 && packCostVal !== null && perBox !== null) {
      lossValue = cents((boxes ?? 0) * perBox + (packs as number) * packCostVal)
    }
  }
  return { lossValue, packCost: packCostVal }
}

/**
 * Record something opened or given away on a show.
 *
 * TWO ACTS SHARE THIS FUNCTION, and which one it is comes from the SESSION,
 * never from the caller.
 *
 * ## A show that is running, or finished today — a stock movement
 *
 * HOW MUCH is entered the way the work is described — a break in CASES + BOXES,
 * a giveaway in BOXES + PACKS — and converted to the product's own stock unit by
 * @shared/units. What one unit of stock means varies per product, so the
 * conversion needs the product and refuses rather than assuming: a missing
 * boxes-per-case, a part-case on a product that is not stocked fractionally, a
 * giveaway in packs with no packs-per-box. Those refusals are surfaced VERBATIM
 * because each one names the exact field to go and fill in. The stock comes off
 * the shelf at the real FIFO cost of the layers it takes.
 *
 * ## A show that is already history — a RECONCILIATION
 *
 * The stock left the shelf weeks ago, and every honest question about it has a
 * different answer. There is nothing on hand to consume — usually literally
 * zero — so the ordinary path would refuse outright, and where stock DOES exist
 * it is stock bought since, which the show never touched: consuming it would
 * take units the warehouse still has and cost an old show at this month's
 * prices. Both failures are silent in the P&L.
 *
 * So a reconciliation asserts instead of infers. The operator states how much
 * was broken and what one of them cost, and the line books exactly that:
 * `count × price`. It moves NO stock, opens NO cost lot and consumes NO layer,
 * because it is a statement about stock that is gone rather than a claim about
 * stock on hand — and `Σ lot.qty_remaining == inventory_stock.quantity` is an
 * invariant this module must leave exactly as it found it.
 *
 * WHAT IT IS COUNTED IN is the product's own stock unit: a case-stocked product
 * in cases at a price per case, a box-stocked one in boxes at a price per box.
 * There is nothing to convert on a box-stocked product — one box IS one stock
 * unit — so insisting on cases would invent a division it does not need, and
 * then refuse the whole entry over a boxes-per-case the product has no reason
 * to carry.
 *
 * One transaction covering stock, cost lots, the ledger row, the line and the
 * layers it consumed — a line that exists without its stock movement (or the
 * reverse) is not something a later reconciliation could detect, let alone fix.
 */
export function addItem(input: NewStreamItem, actorId: string | null): Result<StreamSessionDetail> {
  const db = getDb()
  const sessionId = (input?.sessionId ?? '').trim()
  const productId = (input?.productId ?? '').trim()
  const kind: StreamItemKind = input?.kind === 'giveaway' ? 'giveaway' : 'break'
  const location = input?.location ?? ''
  const inCases = enteredUnit(input?.cases)
  const inBoxes = enteredUnit(input?.boxes)
  const inPacks = enteredUnit(input?.packs)
  // Which way the caller said how much. Entered units win when ANY of them is
  // present; `quantity` is the raw stock-unit escape hatch that keeps every
  // pre-v25 caller working.
  const byUnits = inCases !== null || inBoxes !== null || inPacks !== null
  // Whether a price was OFFERED is a separate question from whether it is a
  // usable one, and the two need separate answers: an omitted price on a past
  // show and a typo in the field are different mistakes with different fixes.
  // Re-parsed here rather than trusted — this is the write, and the renderer is
  // not a trust boundary.
  const priceGiven = input?.casePrice !== undefined && input?.casePrice !== null
  // Per unit of ENTRY, not per case — see NewStreamItem.casePrice for why the
  // field kept the older name.
  const statedPrice = priceGiven ? parseMoneyInput(input.casePrice) : NaN
  // The operator's cost-layer choice, with its empty rows dropped. The dialog
  // holds a quantity for every layer on screen and most of them are zero; a zero
  // row would put a slice in this line's record claiming a layer supplied
  // nothing. Empty after tidying is the same as none given.
  const allocation: LotPick[] = tidyPicks(Array.isArray(input?.allocation) ? input.allocation : [])

  const run = db.transaction((): Result<StreamSessionDetail> => {
    const session = db
      .prepare('SELECT id, title, stream_date, ended_at FROM stream_sessions WHERE id = ?')
      .get(sessionId) as
      | { id: string; title: string; stream_date: string; ended_at: string | null }
      | undefined
    if (!session) return { ok: false, error: 'That stream session no longer exists.' }

    /**
     * WHICH ACT THIS IS, read off the stored session rather than taken from the
     * caller. The renderer decides which form to draw from the same rule, but a
     * form drawn before midnight can be submitted after it, and only one of the
     * two answers may be allowed to move money.
     *
     * The mode is then required to MATCH the entry in both directions. A silent
     * fallback either way is the failure that would not be noticed: a stated
     * price ignored on tonight's show books the average while the screen showed
     * $2,400 a case, and a missing price on an old show quietly eats layers
     * bought since. Both halves of that are refused below — the second here, the
     * first with the entry, where the product is known and the refusal can name
     * the unit the price should have been in.
     */
    const reconcile = isPastDatedSession({
      streamDate: session.stream_date,
      endedAt: session.ended_at
    })

    if (!isLocation(location)) return { ok: false, error: 'Pick a stock location.' }
    const product = db
      .prepare(
        `SELECT id, name, sku, category, unit_type, boxes_per_case, packs_per_box, giveaway_item
           FROM inventory_products WHERE id = ?`
      )
      .get(productId) as
      | {
          id: string
          name: string
          sku: string
          category: string
          unit_type: string
          boxes_per_case: number | null
          packs_per_box: number | null
          giveaway_item: number
        }
      | undefined
    if (!product) return { ok: false, error: 'Product not found.' }

    const stockUnit = stockUnitOf(product.unit_type)
    const units: ProductUnits | null = stockUnit
      ? {
          unitType: stockUnit,
          boxesPerCase: product.boxes_per_case,
          packsPerBox: product.packs_per_box,
          giveawayItem: Number(product.giveaway_item) === 1
        }
      : null
    const fractional = Number(product.giveaway_item) === 1

    // The other half of the mode check, made here rather than beside the
    // session because "leave the case price out" is the wrong instruction for a
    // product that would have been priced per box.
    if (!reconcile && priceGiven) {
      return {
        ok: false,
        error: `That show is not history yet — its stock is still on the shelf and costs what it cost. Leave the ${
          units ? units.unitType : 'stated'
        } price out; the line books the real cost of the stock it takes.`
      }
    }
    // The mirror of that check, for the other input that only makes sense in one
    // mode. A reconciliation consumes no cost layer, so an allocation against it
    // describes layers it is not touching — refused rather than ignored, because
    // a picked allocation silently dropped is a decision the operator watched
    // themselves make and that never happened.
    if (reconcile && allocation.length > 0) {
      return {
        ok: false,
        error: 'That show is already history, so there are no cost layers left to take this from. Enter what one cost instead.'
      }
    }

    let qty: number
    // What the operator TYPED, kept beside the converted quantity so the line
    // reads back the way it was entered. Which of the three are filled in is
    // what says how the line was counted, so they are decided in the same place
    // the quantity is rather than re-derived at the INSERT.
    let entryCases: number | null = null
    let entryBoxes: number | null = null
    let entryPacks: number | null = null
    if (reconcile) {
      /**
       * A reconciliation is counted in the PRODUCT'S OWN STOCK UNIT, whichever
       * kind of line it is, and priced per one of those.
       *
       * That is the only unit the price can honestly be in. A case-stocked
       * product is bought and thought about by the case; a box-stocked one is
       * bought and thought about by the box, and one box is already one stock
       * unit — asking for a case count would make the entry depend on a
       * boxes-per-case that such a product has no reason to carry, and refuse
       * the whole line when it does not. There is nothing to convert, so nothing
       * to demand a divisor for.
       *
       * The other fields are refused rather than ignored: a typed number that
       * does nothing is a wrong total waiting to be believed.
       */
      if (!units) {
        return {
          ok: false,
          error: `This product is stocked in ${product.unit_type}, not cases or boxes, so there is no unit for it to be priced by. Set its unit type to case or box in Inventory.`
        }
      }
      const unit = units.unitType
      const plural = unit === 'case' ? 'cases' : 'boxes'
      if (!priceGiven) {
        return {
          ok: false,
          error: `That show is already history, so its stock is long gone and there is nothing left to cost it from. Enter how many ${plural} were broken and what one ${unit} cost.`
        }
      }
      if (!Number.isFinite(statedPrice)) {
        return {
          ok: false,
          error: `Enter what one ${unit} cost, as a number — 2400, not a blank or a word.`
        }
      }
      if (statedPrice < 0) {
        return { ok: false, error: `A ${unit} cannot have cost less than nothing.` }
      }
      if (unit === 'case' && ((inBoxes ?? 0) > 0 || (inPacks ?? 0) > 0)) {
        return {
          ok: false,
          error: 'This product is stocked in cases, so a reconciliation of it is priced per case and entered in cases. Record loose boxes as their own line, at what those boxes cost.'
        }
      }
      if (unit === 'box' && ((inCases ?? 0) > 0 || (inPacks ?? 0) > 0)) {
        return {
          ok: false,
          error: 'This product is stocked in boxes, so a reconciliation of it is priced per box and entered in boxes. Enter the boxes those cases held, at what one box cost.'
        }
      }
      // FRACTIONAL COUNTS ARE ALLOWED HERE, and only here.
      //
      // Everywhere else a count must be whole, because everywhere else it moves
      // stock, and a shelf cannot carry a quarter of a case unless the product
      // is flagged for fractional holding. None of that applies to a
      // reconciliation: it writes a quantity change of ZERO and opens no cost
      // layer, so there is no shelf for a fraction to corrupt. What it records
      // is what a night cost, and a night that went through a case and a quarter
      // cost a case and a quarter — refusing 1.25 would force a number that is
      // wrong into the only field that was going to say what really happened.
      // The same is true of half a box, which is why this reads off the entry
      // unit rather than off the word "case".
      const counted = (unit === 'case' ? inCases : inBoxes) ?? 0
      // Zero, a negative and a value that was never a number all arrive here as
      // nothing entered — enteredUnit() has already turned the last of those
      // into null — and one sentence answers all three.
      if (!(counted > 0)) {
        return { ok: false, error: `Enter at least one ${unit} — 2, or 1.25 for part of one.` }
      }
      // Through the same contract every other entry goes through, so a case
      // means here exactly what it means on tonight's show and a box means
      // exactly one unit of a box-stocked shelf.
      const conv =
        unit === 'case' ? breakToStock(units, counted, 0) : breakToStock(units, 0, counted)
      if (!conv.ok) return { ok: false, error: conv.error }
      qty = conv.value.quantity
      // Which of the two is set is what tells a reader of this row — and
      // statedPriceUnit — which unit its stated price is per.
      if (unit === 'case') entryCases = counted
      else entryBoxes = counted
    } else if (byUnits) {
      if (!units) {
        return {
          ok: false,
          error: `This product is stocked in ${product.unit_type}, not cases or boxes, so a case/box/pack entry cannot be converted. Set its unit type to case or box in Inventory.`
        }
      }
      const conv =
        kind === 'break'
          ? breakToStock(units, inCases ?? 0, inBoxes ?? 0)
          : giveawayToStock(units, inBoxes ?? 0, inPacks ?? 0)
      // Verbatim: the contract's messages name the field to fill in, and
      // rewording them here would lose that.
      if (!conv.ok) return { ok: false, error: conv.error }
      qty = conv.value.quantity
      entryCases = kind === 'break' ? (inCases ?? 0) : null
      entryBoxes = inBoxes ?? 0
      entryPacks = kind === 'giveaway' ? (inPacks ?? 0) : null
    } else {
      qty = roundQty(Number(input?.quantity), fractional)
    }
    if (!Number.isFinite(qty) || !(qty > 0)) {
      return {
        ok: false,
        error: fractional ? 'Enter a quantity greater than zero.' : 'Quantity must be at least 1.'
      }
    }

    // Only a movement can be short of stock. A reconciliation is not competing
    // for the shelf — it is describing a shelf that emptied weeks ago — so the
    // check is skipped rather than passed a number it would always fail.
    if (!reconcile) {
      const have = stockQty(productId, location)
      /**
       * The last piece of a unit taken piece by piece.
       *
       * The stored balance is re-rounded to four places on every step, so after
       * N-1 pieces it sits just BELOW (N-1)/N while the ask is still a
       * full-precision 1/N. On a 6-box case the shelf reads 0.1665 and the sixth
       * box asks for 0.16666… — refused forever with "Only 0.1665 in RM", so that
       * box's cost never reached the show and the fraction stayed on the books
       * with no way to clear it (the adjust-stock form parses with parseInt).
       *
       * Within the accumulated rounding error the ask IS the remaining balance, so
       * it is clamped to it and consumes the shelf to exactly zero.
       */
      if (qty > have + QTY_EPS) {
        if (fractional && have > 0 && qty - have <= quantizationSlack(qty)) {
          qty = have
        } else {
          return { ok: false, error: `Only ${have} in ${location}.` }
        }
      }
    }

    const breakNumber = kind === 'break' ? normalizeBreakNumber(input.breakNumber) : null
    const recipient = kind === 'giveaway' ? input.recipient?.trim() || null : null
    const note = input.note?.trim() || null

    let costTotal: number
    let slices: LotSlice[] = []
    if (reconcile) {
      /**
       * NOTHING MOVES, and that is the feature.
       *
       * No bumpStock: the count on the shelf today is a physical fact — it was
       * counted, or reset from a count sheet, AFTER this show — and those cases
       * are already absent from it. Deducting them again would take the same
       * stock off the books twice, and the product would read short by exactly
       * the amount somebody was trying to be accurate about.
       *
       * No consumeFifo and no createLot: a cost lot is a claim about stock ON
       * HAND, tied to `inventory_stock` by an invariant the whole FIFO engine
       * rests on. A layer opened for stock that is gone would either sit open —
       * inflating the shelf's value with cases nobody has — or be a create and
       * an immediate reversal, which is two writes that cancel and leave the
       * same nothing this does. What a reconciliation knows is a PRICE, not a
       * layer, so the price is what it records.
       *
       * No syncProductAvgCost: see the note at the transaction below. The layers
       * on hand did not change, and a price from June must not re-base what
       * today's shelf is carried at.
       *
       * The stated cost is `the entered count × price`, NOT `qty ×
       * per-stock-unit`: the operator asserted what one of the things they
       * counted cost, and dividing that down and multiplying it back would round
       * a 12-box case's cost by a cent or two against the number they typed. On
       * a box-stocked product the two are the same arithmetic — one box is one
       * stock unit — and it is written this way so both units go through one
       * rule rather than two that happen to agree.
       */
      costTotal = cents((entryCases ?? entryBoxes ?? 0) * statedPrice)
      // Quantity change of ZERO. The row is written for the same reason every
      // other movement writes one — the ledger is append-only and a cost that
      // appears in the P&L with no entry behind it is untraceable — but it
      // carries only the money. A -4 here would make inventory history disagree
      // with the shelf it is supposed to explain.
      insertTxn(
        productId,
        txnType(kind),
        0,
        null,
        recipient,
        ledgerNote(session.title, kind, breakNumber, recipient, true),
        actorId,
        location,
        costTotal
      )
    } else {
      // The exact sequence recordSale uses: drop the count, consume the cost
      // layers, re-average what is left, then write the ledger row. A stream line
      // and a sale are the same movement and must be valued identically —
      // including which layers they may be told to take, which is why both go
      // through consumeLots rather than one of them reaching for consumeFifo.
      bumpStock(productId, location, -qty)
      slices = consumeLots(db, productId, location, qty, allocation)
      costTotal = slicesCost(slices)
      syncProductAvgCost(db, productId)
      insertTxn(
        productId,
        txnType(kind),
        -qty,
        null,
        recipient,
        ledgerNote(session.title, kind, breakNumber, recipient),
        actorId,
        location,
        costTotal
      )
    }

    // What this line cost per STOCK unit: from the layers it actually took, or
    // from the price that was stated for it — never the product's moving
    // average, which drifts with every purchase and knows nothing about either.
    const perStockUnit = cents(costTotal / qty)

    // The P&L side of a giveaway. See `giveawayLossOf`, which owns the
    // arithmetic so that backfilling a cost onto a line months later values the
    // prize exactly the way recording it tonight would.
    const { lossValue, packCost: packCostVal } =
      kind === 'giveaway'
        ? giveawayLossOf(units, perStockUnit, costTotal, inBoxes, inPacks)
        : { lossValue: 0, packCost: null }

    const id = newId()
    const ts = nowIso()
    db.prepare(
      `INSERT INTO stream_items
         (id, session_id, kind, product_id, product_name, sku, category, break_number, recipient,
          quantity, entered_cases, entered_boxes, entered_packs, location, unit_cost, cost_total,
          stated_case_price, pack_cost, loss_value, note, created_at, created_by)
       VALUES (@id, @session_id, @kind, @product_id, @product_name, @sku, @category, @break_number,
               @recipient, @quantity, @entered_cases, @entered_boxes, @entered_packs, @location,
               @unit_cost, @cost_total, @stated_case_price, @pack_cost, @loss_value, @note, @ts,
               @created_by)`
    ).run({
      id,
      session_id: sessionId,
      kind,
      product_id: productId,
      // Snapshotted, not joined: this line has to still say what was opened
      // after the catalog entry is deleted.
      product_name: product.name,
      sku: product.sku,
      category: product.category,
      break_number: breakNumber,
      recipient,
      quantity: qty,
      // Stored beside the converted quantity so the line can be read back the
      // way it was typed. NULL when it was entered in stock units directly.
      entered_cases: entryCases,
      entered_boxes: entryBoxes,
      entered_packs: entryPacks,
      location,
      unit_cost: perStockUnit,
      cost_total: costTotal,
      // The assertion this line rests on, kept as it was typed: what ONE UNIT
      // OF ENTRY cost. Which unit that is, the row says for itself through the
      // entered count above — see statedPriceUnit, and the note there on why
      // this column keeps a name that now only half fits. It is also the switch
      // every reversal reads: a row with a price here moved no stock, so nothing
      // may be handed back for it.
      stated_case_price: reconcile ? cents(statedPrice) : null,
      pack_cost: packCostVal,
      loss_value: lossValue,
      note,
      ts,
      created_by: actorId
    })

    // Empty for a reconciliation, and correctly so: no layer was consumed, so
    // there is no layer to name and nothing for a later removal to give back.
    //
    // `picked` says whether an operator allocated these layers or the FIFO walk
    // produced them unasked. Investigating a break whose margin looks wrong, that
    // is the one thing the amounts cannot tell you: a $1,400 cost against a
    // $1,600 case reads identically whether somebody chose it or nobody was
    // asked, and only one of those is a costing bug.
    const picked = allocation.length > 0 ? 1 : 0
    const insertLot = db.prepare(
      `INSERT INTO stream_item_lots (id, item_id, lot_id, quantity, unit_cost, picked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    for (const slice of slices) {
      insertLot.run(newId(), id, slice.lotId, slice.qty, slice.unitCost, picked, ts)
    }

    return { ok: true, data: getSessionDetail(sessionId) as StreamSessionDetail }
  })
  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

interface ItemStockRow {
  id: string
  session_id: string
  kind: string
  product_id: string | null
  quantity: number
  location: string
  cost_total: number
  stated_case_price: number | null
}

/**
 * Give back exactly what one line took — the same cost layers, at the same
 * costs — and drop the line. The single restore path, shared by removeItem and
 * deleteSession.
 *
 * A RECONCILIATION took nothing, so nothing is given back: the units never left
 * the count and no layer was consumed, and handing units to a shelf that never
 * lost them would invent stock out of an undo. What the line DOES leave behind
 * is the cost it booked, so that is what the reversal cancels.
 *
 * The decision is read off the LINE (`stated_case_price`), never re-derived from
 * the session's date. A session can be re-dated after the fact — that is what
 * updateSession is for — and a line must always reverse the way it was written,
 * whatever day its show has since been moved to.
 *
 * MUST be called inside the caller's db.transaction(); throws to roll it back.
 */
function restoreItemStock(db: Database, itemId: string, note: string, actorId: string | null): string {
  const item = db
    .prepare(
      `SELECT id, session_id, kind, product_id, quantity, location, cost_total, stated_case_price
         FROM stream_items WHERE id = ?`
    )
    .get(itemId) as ItemStockRow | undefined
  if (!item) throw new Error('That line no longer exists.')
  const reconciled = item.stated_case_price !== null

  const slices: LotSlice[] = (
    db
      .prepare('SELECT lot_id, quantity, unit_cost FROM stream_item_lots WHERE item_id = ? ORDER BY rowid')
      .all(itemId) as Array<{ lot_id: string; quantity: number; unit_cost: number }>
  ).map((r) => ({ lotId: r.lot_id, qty: r.quantity, unitCost: r.unit_cost }))

  // The product was deleted after this line was recorded: its stock row and its
  // cost lots cascaded away with it, so there is nothing left to restore into.
  // The line is dropped and inventory is left alone — putting units back for a
  // product that no longer exists would invent stock nobody can sell.
  const productId = item.product_id
  const stillCataloged =
    !!productId && !!db.prepare('SELECT 1 FROM inventory_products WHERE id = ?').get(productId)

  if (productId && stillCataloged) {
    // The stock half, skipped entirely for a reconciliation. `slices` is empty
    // on one of those anyway, so restoreFifo would be a no-op — it is bumpStock
    // that would do the damage, adding units to a shelf that never lost them.
    if (!reconciled) {
      restoreFifo(db, slices)
      bumpStock(productId, item.location, item.quantity)
      syncProductAvgCost(db, productId)
    }
    // Reverses the row addItem wrote — same type, opposite sign on BOTH the
    // quantity and the cost, so either column sums to zero over a removed line.
    // For a reconciliation both sides of that are zero-quantity, which is
    // exactly as true. The original entry is never deleted; the ledger stays
    // append-only, as it is everywhere else in the app.
    insertTxn(
      productId,
      txnType(item.kind === 'giveaway' ? 'giveaway' : 'break'),
      reconciled ? 0 : item.quantity,
      null,
      null,
      note,
      actorId,
      item.location,
      item.cost_total === 0 ? 0 : -item.cost_total
    )
  }

  // stream_item_lots cascades with the line.
  db.prepare('DELETE FROM stream_items WHERE id = ?').run(itemId)
  return item.session_id
}

/** Undo one line: the stock goes back where it came from and the line is gone.
 * ONE transaction — a line removed without its stock returning is a silent
 * shrinkage nobody would think to look for. */
export function removeItem(id: string, actorId: string | null): Result<StreamSessionDetail> {
  const db = getDb()
  const run = db.transaction((): Result<StreamSessionDetail> => {
    const row = db
      .prepare(
        `SELECT i.id, i.session_id, s.title
           FROM stream_items i JOIN stream_sessions s ON s.id = i.session_id
          WHERE i.id = ?`
      )
      .get(id) as { id: string; session_id: string; title: string } | undefined
    if (!row) return { ok: false, error: 'That line no longer exists.' }
    restoreItemStock(db, id, `Removed from ${row.title.trim() || 'stream'}`, actorId)
    return { ok: true, data: getSessionDetail(row.session_id) as StreamSessionDetail }
  })
  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}

interface CostRow {
  id: string
  session_id: string
  kind: string
  product_id: string | null
  product_name: string
  quantity: number
  entered_boxes: number | null
  entered_packs: number | null
  cost_total: number
  location: string
  stated_case_price: number | null
  title: string
}

/**
 * Say what a line COST, after the fact.
 *
 * The owner's sentence: "give me the ability in the streaming or finance to
 * enter the price … since we might not always know in the moment." A box gets
 * broken on air, nobody has the invoice to hand, and the line lands carrying
 * zero. That zero is now printed on the P&L instead of being hidden — see
 * `PnlLine.uncosted` — and this is what the printed line is FOR.
 *
 * `unitPrice` is per one of whatever the product is stocked in: per case for a
 * case-stocked product, per box for a box-stocked one, exactly the unit
 * `AddItemForm` prices a reconciliation in. `quantity` on the line is already in
 * that same unit, so the cost is a plain multiplication and nothing has to be
 * divided down and multiplied back — which is what would round a 12-box case's
 * cost a cent or two away from the number that was typed. Decimals are accepted
 * throughout: a night that went through a case and a quarter cost a case and a
 * quarter.
 *
 * ## IT RECORDS WHAT WAS PAID. IT DOES NOT MOVE STOCK. EITHER KIND OF LINE.
 *
 * This is the thing to get right, and the two paths fail differently if it is
 * got wrong.
 *
 * A RECONCILED line (`stated_case_price` is set) never consumed FIFO, never
 * opened a lot and never re-based the product's average, because the stock it
 * describes left the shelf weeks before anybody typed it — see `addItem`, which
 * spells the whole argument out. A cost arriving for that line late changes
 * exactly one thing: the price the operator is asserting. Consuming layers here
 * would take units the warehouse still has, for a show that never touched them,
 * and break `Σ lot.qty_remaining == inventory_stock.quantity` on the way.
 *
 * A LIVE-path line DID consume FIFO, at whatever its layers were carrying — and
 * this deliberately leaves those layers exactly as they are. The steer, and it
 * is the right one: the layers are a record of what the SHELF held, and they
 * have already been reversed out of it. Rewriting them now would revalue stock
 * that is long gone, move the product's average on the strength of a price for
 * stock nobody has, and cascade into every later line that consumed the same
 * lot. What the operator is fixing is the STATEMENT — what that night cost — so
 * that is the only thing this touches, and both the comment here and the form on
 * screen say so in as many words.
 *
 * `stated_case_price` is written only where it was already set. On a live line it
 * MUST stay null: `restoreItemStock` reads that column to decide whether a
 * removal hands stock back, so setting it would strand on the shelf the units
 * this line really did take.
 *
 * The ledger gets a correcting row rather than an edit, like everything else in
 * this app: original + correction + the reversal a removal writes still nets to
 * zero, and inventory history keeps saying what was believed and when.
 */
export function setItemCost(
  input: SetStreamItemCost,
  actorId: string | null
): Result<StreamSessionDetail> {
  const db = getDb()
  const itemId = (input?.itemId ?? '').trim()
  const unitPrice = Number(input?.unitPrice)

  const run = db.transaction((): Result<StreamSessionDetail> => {
    const item = db
      .prepare(
        `SELECT i.id, i.session_id, i.kind, i.product_id, i.product_name, i.quantity,
                i.entered_boxes, i.entered_packs, i.cost_total, i.location, i.stated_case_price,
                s.title
           FROM stream_items i JOIN stream_sessions s ON s.id = i.session_id
          WHERE i.id = ?`
      )
      .get(itemId) as CostRow | undefined
    if (!item) return { ok: false, error: 'That line no longer exists.' }

    // Parsed at the boundary too, and checked again here: this is the write, and
    // a NaN stored in `cost_total` would poison every total that sums the column
    // with nothing on any screen to say which line did it.
    if (!Number.isFinite(unitPrice)) {
      return { ok: false, error: 'Enter what one of them cost, as a number — 2400, or 1.25.' }
    }
    if (unitPrice < 0) return { ok: false, error: 'It cannot have cost less than nothing.' }
    const qty = Number(item.quantity)
    if (!Number.isFinite(qty) || !(qty > 0)) {
      return { ok: false, error: 'That line has no quantity to price.' }
    }

    // The product may have been deleted since — the denormalised name on the
    // line is there precisely for that. A price can still be recorded for the
    // statement; only the pack-level valuation of a giveaway needs the divisors,
    // and `giveawayLossOf` already falls back to the whole cost without them.
    const product = item.product_id
      ? (db
          .prepare(
            `SELECT unit_type, boxes_per_case, packs_per_box, giveaway_item
               FROM inventory_products WHERE id = ?`
          )
          .get(item.product_id) as
          | {
              unit_type: string
              boxes_per_case: number | null
              packs_per_box: number | null
              giveaway_item: number
            }
          | undefined)
      : undefined
    const stockUnit = product ? stockUnitOf(product.unit_type) : null
    const units: ProductUnits | null =
      product && stockUnit
        ? {
            unitType: stockUnit,
            boxesPerCase: product.boxes_per_case,
            packsPerBox: product.packs_per_box,
            giveawayItem: Number(product.giveaway_item) === 1
          }
        : null

    const costTotal = cents(qty * unitPrice)
    const perStockUnit = cents(costTotal / qty)
    const reconciled = item.stated_case_price !== null
    const kind: StreamItemKind = item.kind === 'giveaway' ? 'giveaway' : 'break'
    // Re-valued from the counts the line was TYPED with, through the same
    // function that valued it when it was recorded — so a prize given away as
    // four packs is still worth four packs once its price arrives.
    const { lossValue, packCost: packCostVal } =
      kind === 'giveaway'
        ? giveawayLossOf(units, perStockUnit, costTotal, item.entered_boxes, item.entered_packs)
        : { lossValue: 0, packCost: null }

    const delta = cents(costTotal - Number(item.cost_total ?? 0))

    db.prepare(
      `UPDATE stream_items
          SET unit_cost = @unit_cost, cost_total = @cost_total, loss_value = @loss_value,
              pack_cost = @pack_cost, stated_case_price = @stated
        WHERE id = @id`
    ).run({
      id: item.id,
      unit_cost: perStockUnit,
      cost_total: costTotal,
      loss_value: lossValue,
      pack_cost: packCostVal,
      // Only ever rewritten, never introduced. See the note above on what
      // setting it on a live line would do to that line's removal.
      stated: reconciled ? cents(unitPrice) : null
    })

    // Nothing above touched bumpStock, consumeFifo, restoreFifo, createLot or
    // syncProductAvgCost, and nothing below does either. The shelf, the cost
    // layers and the product's average are exactly where this found them.
    if (item.product_id && delta !== 0) {
      insertTxn(
        item.product_id,
        txnType(kind),
        // A quantity change of ZERO on both kinds of line. The reconciled one
        // never moved stock; the live one moved it when it was recorded and is
        // not moving it again. A number here would make inventory history
        // disagree with the shelf it exists to explain.
        0,
        null,
        null,
        `${item.title.trim() || 'Stream'} — cost entered afterwards for ${item.product_name}`,
        actorId,
        item.location,
        delta
      )
    }

    return { ok: true, data: getSessionDetail(item.session_id) as StreamSessionDetail }
  })
  try {
    return run()
  } catch (err) {
    return fail(err)
  }
}
