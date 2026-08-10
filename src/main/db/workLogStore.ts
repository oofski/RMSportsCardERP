/**
 * The work log's one write statement, and the one-time backfill that seeds it.
 *
 * Split out from db/workLog.ts, which is the app-facing API, for one mechanical
 * reason: database.ts must call the backfill during migration, and workLog.ts
 * imports getDb from database.ts. Everything here takes an explicit Database
 * handle and imports no sibling of database.ts, so the migration path has no
 * cycle to resolve.
 */
import type { Database } from 'better-sqlite3'
import type { StartBasis, WorkEvent, WorkEventKind } from '@shared/performance'

/**
 * The row id: derived from the kind and the subject, never minted.
 *
 * One subject has exactly one outcome per step — a break is sorted once, a
 * package is packed once — so two machines recording the same tick produce the
 * SAME row and the relay compares it against an older copy of itself. A UUID
 * would leave two rows describing one event, and every average would count it
 * twice. Same rule as the availability, shift and unsold-team-bag ids.
 */
export function workLogId(kind: WorkEventKind, subjectId: string): string {
  return `wl_${kind}_${subjectId}`
}

export interface WorkLogRow {
  id: string
  kind: string
  subject_id: string
  break_id: string | null
  break_label: string | null
  import_id: string | null
  employee_id: string | null
  started_at: string | null
  start_basis: string
  finished_at: string
  units: number
}

const KINDS = new Set<WorkEventKind>(['sleeve', 'sort', 'bag', 'pack', 'ship', 'break_done'])
const BASES = new Set<StartBasis>(['first-card', 'prev-step', 'prev-tick', 'claim', 'packed', 'none'])

/**
 * Read a stored row back as an event.
 *
 * Written defensively over kind and basis because both are free text in SQLite
 * and a row could have been written by a newer build and pulled here by sync. A
 * kind this build does not know is dropped by the caller rather than counted as
 * something it is not; an unknown basis degrades to 'none', which is the safe
 * direction — it makes a duration read as unknown rather than as measured.
 */
export function toWorkEvent(row: WorkLogRow): WorkEvent | null {
  if (!KINDS.has(row.kind as WorkEventKind)) return null
  const basis = BASES.has(row.start_basis as StartBasis) ? (row.start_basis as StartBasis) : 'none'
  return {
    id: row.id,
    kind: row.kind as WorkEventKind,
    subjectId: row.subject_id,
    breakId: row.break_id,
    breakLabel: row.break_label,
    importId: row.import_id,
    employeeId: row.employee_id,
    // A basis of 'none' must never carry a start. Belt and braces against a row
    // written by a future build that means something different by the word.
    startedAt: basis === 'none' ? null : row.started_at,
    startBasis: basis,
    finishedAt: row.finished_at,
    units: Number.isFinite(row.units) && row.units > 0 ? Math.trunc(row.units) : 1
  }
}

/**
 * Upsert, not insert.
 *
 * The same tick can legitimately be recorded twice — an un-tick followed by a
 * re-tick, two machines that both saw the click — and the second recording is
 * the current truth about that subject. created_at is preserved on conflict so
 * a re-tick does not rewrite when the log first learned of the work.
 */
export const WORK_LOG_UPSERT_SQL = `
  INSERT INTO ship_work_log
    (id, kind, subject_id, break_id, break_label, import_id, employee_id,
     started_at, start_basis, finished_at, units, created_at, updated_at)
  VALUES
    (@id, @kind, @subjectId, @breakId, @breakLabel, @importId, @employeeId,
     @startedAt, @startBasis, @finishedAt, @units, @at, @at)
  ON CONFLICT(id) DO UPDATE SET
    break_id    = excluded.break_id,
    break_label = excluded.break_label,
    import_id   = excluded.import_id,
    employee_id = excluded.employee_id,
    started_at  = excluded.started_at,
    start_basis = excluded.start_basis,
    finished_at = excluded.finished_at,
    units       = excluded.units,
    updated_at  = excluded.updated_at
`

export interface WorkLogWrite {
  kind: WorkEventKind
  subjectId: string
  breakId?: string | null
  breakLabel?: string | null
  importId?: string | null
  employeeId?: string | null
  startedAt?: string | null
  startBasis: StartBasis
  finishedAt: string
  units?: number
}

/** Bind a write to the statement's named parameters. */
export function workLogParams(w: WorkLogWrite, at: string): Record<string, unknown> {
  const hasStart = !!w.startedAt && w.startBasis !== 'none'
  return {
    id: workLogId(w.kind, w.subjectId),
    kind: w.kind,
    subjectId: w.subjectId,
    breakId: w.breakId ?? null,
    breakLabel: w.breakLabel ?? null,
    importId: w.importId ?? null,
    employeeId: w.employeeId || null,
    startedAt: hasStart ? w.startedAt : null,
    startBasis: hasStart ? w.startBasis : 'none',
    finishedAt: w.finishedAt,
    units: Math.max(1, Math.trunc(w.units ?? 1)),
    at
  }
}

// ---------------------------------------------------------------------------
// The one-time backfill
// ---------------------------------------------------------------------------

/** Status codes that mean the package has physically left the building. */
const SENT_CODES = new Set(['in_transit', 'out_for_delivery', 'delivered', 'returned'])

interface BreakRow {
  id: string
  break_label: string | null
  sleeved_at: string | null
  sleeved_by: string | null
  sorted_at: string | null
  sorted_by: string | null
}

/**
 * Seed the log from the show that is currently loaded.
 *
 * FOUR of the six kinds, and the two that are missing are missing on purpose.
 *
 * BAG IS NOT BACKFILLED. Step 3's tick is ship_team_slots.checked_off, which is
 * the same flag the PICK LIST writes — deliberately, because "this team's card
 * is accounted for" is one fact and the app refuses to record it twice (see
 * @shared/breakSteps). In a loaded dataset the two are indistinguishable: a
 * picker's "Picked · next order" stamps every card in an order at ONE instant,
 * so chaining those stamps would hand one team a real interval and the rest of
 * the order a string of zeros, under whoever happened to be picking. Going
 * forward the bench path records its own per-team events; history keeps its bag
 * timings unknown rather than inventing plausible ones.
 *
 * BREAK_DONE IS backfilled, because it needs only the LAST tick on a finished
 * break and not the spacing between them, so the ambiguity above does not
 * reach it.
 *
 * Returns how many rows were written.
 */
export function backfillWorkLog(database: Database): number {
  // Guarded rather than assumed: this runs inside migrate(), where a database
  // restored from an older snapshot may not have every ship table yet.
  const have = new Set(
    (
      database
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
  )
  if (!have.has('ship_work_log')) return 0

  const at = new Date().toISOString()
  const ins = database.prepare(WORK_LOG_UPSERT_SQL)
  const writes: WorkLogWrite[] = []

  // Which show these rows belong to: the newest import is the one whose rows
  // are in the dataset tables right now.
  const importId = have.has('ship_imports')
    ? ((
        database
          .prepare(`SELECT id FROM ship_imports ORDER BY created_at DESC, rowid DESC LIMIT 1`)
          .get() as { id: string } | undefined
      )?.id ?? null)
    : null

  if (have.has('ship_breaks') && have.has('ship_team_slots')) {
    const breaks = database
      .prepare(
        `SELECT id, break_label, sleeved_at, sleeved_by, sorted_at, sorted_by FROM ship_breaks`
      )
      .all() as BreakRow[]

    // Per break: how many cards it holds, the earliest per-card sleeve tick,
    // and the last tick of any kind. Three aggregates in one pass rather than
    // three queries per break.
    const perBreak = new Map<
      string,
      { cards: number; firstCardSleeve: string | null; lastTick: string | null; lastTickBy: string | null }
    >()
    const slotRows = database
      .prepare(
        `SELECT break_id, sleeved_at, checked_off, checked_off_at, checked_off_by
           FROM ship_team_slots`
      )
      .all() as Array<{
      break_id: string | null
      sleeved_at: string | null
      checked_off: number
      checked_off_at: string | null
      checked_off_by: string | null
    }>
    for (const s of slotRows) {
      if (!s.break_id) continue
      const e = perBreak.get(s.break_id) ?? {
        cards: 0,
        firstCardSleeve: null,
        lastTick: null,
        lastTickBy: null
      }
      e.cards += 1
      if (s.sleeved_at && (!e.firstCardSleeve || s.sleeved_at < e.firstCardSleeve)) {
        e.firstCardSleeve = s.sleeved_at
      }
      if (s.checked_off && s.checked_off_at && (!e.lastTick || s.checked_off_at > e.lastTick)) {
        e.lastTick = s.checked_off_at
        e.lastTickBy = s.checked_off_by
      }
      perBreak.set(s.break_id, e)
    }

    if (have.has('ship_break_team_bags')) {
      const bags = database
        .prepare(
          `SELECT break_id, bagged_at, bagged_by FROM ship_break_team_bags WHERE bagged_at IS NOT NULL`
        )
        .all() as Array<{ break_id: string; bagged_at: string; bagged_by: string | null }>
      for (const b of bags) {
        const e = perBreak.get(b.break_id)
        if (!e) continue
        if (!e.lastTick || b.bagged_at > e.lastTick) {
          e.lastTick = b.bagged_at
          e.lastTickBy = b.bagged_by
        }
      }
    }

    for (const br of breaks) {
      const agg = perBreak.get(br.id)
      const cards = agg?.cards ?? 0

      if (br.sleeved_at) {
        // The only start on record for step 1 is the earliest card somebody
        // sleeved individually, and only when it precedes the break's own
        // stamp. A card ticked AFTER the pile was called done is a correction,
        // not a start, and using it would produce a negative duration.
        const first = agg?.firstCardSleeve ?? null
        const usable = !!first && first < br.sleeved_at
        writes.push({
          kind: 'sleeve',
          subjectId: br.id,
          breakId: br.id,
          breakLabel: br.break_label,
          importId,
          employeeId: br.sleeved_by,
          startedAt: usable ? first : null,
          startBasis: usable ? 'first-card' : 'none',
          finishedAt: br.sleeved_at,
          units: cards
        })
      }

      if (br.sorted_at) {
        const usable = !!br.sleeved_at && br.sleeved_at <= br.sorted_at
        writes.push({
          kind: 'sort',
          subjectId: br.id,
          breakId: br.id,
          breakLabel: br.break_label,
          importId,
          employeeId: br.sorted_by,
          startedAt: usable ? br.sleeved_at : null,
          startBasis: usable ? 'prev-step' : 'none',
          finishedAt: br.sorted_at,
          units: cards
        })
      }

      // Off the bench: sleeved, sorted, and every card it holds ticked. The
      // slate size an import recorded is deliberately not consulted here — a
      // backfill that demanded a total the dataset can no longer prove would
      // silently report every break as unfinished.
      const allTicked =
        cards > 0 &&
        slotRows.filter((s) => s.break_id === br.id && s.checked_off).length === cards
      if (br.sleeved_at && br.sorted_at && allTicked && agg?.lastTick) {
        writes.push({
          kind: 'break_done',
          subjectId: br.id,
          breakId: br.id,
          breakLabel: br.break_label,
          importId,
          employeeId: agg.lastTickBy,
          startedAt: br.sleeved_at <= agg.lastTick ? br.sleeved_at : null,
          startBasis: br.sleeved_at <= agg.lastTick ? 'prev-step' : 'none',
          finishedAt: agg.lastTick,
          units: cards
        })
      }
    }
  }

  if (have.has('ship_shipments')) {
    // The pack claim that ended each package, if there was one. A claim is the
    // only genuine "I have started this" record anywhere on the floor, so it is
    // worth the extra query even in a backfill.
    const claimStart = new Map<string, string>()
    if (have.has('ship_work_claims')) {
      const claims = database
        .prepare(
          `SELECT customer_id, claimed_at FROM ship_work_claims
            WHERE role = 'pack' AND finished_at IS NOT NULL AND released_at IS NULL
            ORDER BY claimed_at ASC`
        )
        .all() as Array<{ customer_id: string; claimed_at: string }>
      // Last claim wins: an order sent back and re-packed was started again,
      // and the interval anybody cares about is the one that finished it.
      for (const c of claims) claimStart.set(c.customer_id, c.claimed_at)
    }

    const shipments = database
      .prepare(
        `SELECT id, customer_id, packed_at, packed_by, status_code, status_set_at, status_set_by
           FROM ship_shipments`
      )
      .all() as Array<{
      id: string
      customer_id: string | null
      packed_at: string | null
      packed_by: string | null
      status_code: string
      status_set_at: string | null
      status_set_by: string | null
    }>

    for (const sh of shipments) {
      if (sh.packed_at) {
        const claimed = sh.customer_id ? (claimStart.get(sh.customer_id) ?? null) : null
        const usable = !!claimed && claimed <= sh.packed_at
        writes.push({
          kind: 'pack',
          subjectId: sh.id,
          importId,
          employeeId: sh.packed_by,
          startedAt: usable ? claimed : null,
          startBasis: usable ? 'claim' : 'none',
          finishedAt: sh.packed_at,
          units: 1
        })
      }
      if (SENT_CODES.has(sh.status_code) && sh.status_set_at) {
        const usable = !!sh.packed_at && sh.packed_at <= sh.status_set_at
        writes.push({
          kind: 'ship',
          subjectId: sh.id,
          importId,
          employeeId: sh.status_set_by,
          startedAt: usable ? sh.packed_at : null,
          startBasis: usable ? 'packed' : 'none',
          finishedAt: sh.status_set_at,
          units: 1
        })
      }
    }
  }

  if (writes.length === 0) return 0
  database.transaction(() => {
    for (const w of writes) ins.run(workLogParams(w, at))
  })()
  return writes.length
}
