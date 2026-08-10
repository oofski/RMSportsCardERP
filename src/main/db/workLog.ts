/**
 * Writing the floor's work log, at the one moment both endpoints exist.
 *
 * Every function here is called from inside a mutation that has just stamped a
 * completion. It derives the matching START from whatever is on record — the
 * previous step, the earliest per-card sleeve tick, the pack station's claim —
 * and stores BOTH instants plus the rule it used. That has to happen now: the
 * rows it reads live on DATASET_TABLES and the next import deletes them, so a
 * duration derived later is not slower, it is impossible. See the v60 note in
 * database.ts.
 *
 * ## Recording must never break the work
 *
 * A performance log is a reporting convenience; a bench tick is somebody
 * standing in front of a pile of cards. So every write here is wrapped: a
 * failure to record loses a measurement and never the tick. The alternative —
 * an exception from the log rolling back the transaction the tick was in — is a
 * floor that cannot check a card off because a reporting table has a problem.
 *
 * ## What is deliberately NOT recorded
 *
 * The picker's bulk check-off ("Picked · next order") stamps every card in an
 * order at ONE instant. Step 3's tick and the pick list's tick are the same
 * flag on purpose (see @shared/breakSteps), so the two cannot be told apart
 * afterwards — but they can be told apart HERE, by which code path is running.
 * Only the bench path records bag events. A bulk pick stamp would hand the
 * first card of an order a real interval and the rest a string of zeros, under
 * whoever happened to be picking, and a zero that looks like a measurement is
 * the exact failure this module exists to avoid.
 */
import type { StartBasis, WorkEventKind } from '@shared/performance'
import type { WorkEvent } from '@shared/performance'
import { getDb } from './database'
import {
  WORK_LOG_UPSERT_SQL,
  toWorkEvent,
  workLogId,
  workLogParams,
  type WorkLogRow,
  type WorkLogWrite
} from './workLogStore'

/** Status codes that mean the package has physically left the building. */
const SENT_CODES = new Set(['in_transit', 'out_for_delivery', 'delivered', 'returned'])

export function isSentStatus(code: string | null | undefined): boolean {
  return !!code && SENT_CODES.has(code)
}

/**
 * Swallow anything this module throws.
 *
 * Named rather than inlined so the reason is stated once and every call site
 * inherits it: no measurement is worth refusing a tick over.
 */
function quietly(what: () => void): void {
  try {
    what()
  } catch {
    /* A lost measurement. The work it was measuring still happened. */
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export function recordWorkEvent(w: WorkLogWrite): void {
  quietly(() => {
    getDb().prepare(WORK_LOG_UPSERT_SQL).run(workLogParams(w, nowIso()))
  })
}

/**
 * Forget an event, because the step it recorded was un-ticked.
 *
 * A delete rather than a tombstone, which is the opposite of what the unsold-
 * team bag rows do, and the difference is worth stating. A bag row's absence
 * and its cleared stamp have to be distinguishable because the row IS the fact.
 * Here the fact is "this took from A to B", and a step somebody un-ticked did
 * not take any time at all — it did not happen. The delete is captured by the
 * sync trigger like any other write, so it travels.
 */
export function clearWorkEvent(kind: WorkEventKind, subjectId: string): void {
  quietly(() => {
    getDb().prepare(`DELETE FROM ship_work_log WHERE id = ?`).run(workLogId(kind, subjectId))
  })
}

/** The show currently on the floor — stamped on each row so it survives it. */
function currentImportId(): string | null {
  const row = getDb()
    .prepare(`SELECT id FROM ship_imports ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get() as { id: string } | undefined
  return row?.id ?? null
}

interface BreakFacts {
  breakId: string
  breakLabel: string | null
  sleevedAt: string | null
  sortedAt: string | null
  cards: number
  firstCardSleeve: string | null
}

function breakFacts(breakId: string): BreakFacts | null {
  const db = getDb()
  const br = db
    .prepare(`SELECT id, break_label, sleeved_at, sorted_at FROM ship_breaks WHERE id = ?`)
    .get(breakId) as
    | { id: string; break_label: string | null; sleeved_at: string | null; sorted_at: string | null }
    | undefined
  if (!br) return null
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS cards, MIN(sleeved_at) AS first_sleeve
         FROM ship_team_slots WHERE break_id = ?`
    )
    .get(breakId) as { cards: number; first_sleeve: string | null }
  return {
    breakId: br.id,
    breakLabel: br.break_label,
    sleevedAt: br.sleeved_at,
    sortedAt: br.sorted_at,
    cards: agg?.cards ?? 0,
    firstCardSleeve: agg?.first_sleeve ?? null
  }
}

/**
 * An earlier instant, or nothing at all.
 *
 * The ordering test is the load-bearing part. A candidate start that is not
 * strictly before the finish is not a start — it is a correction made after the
 * fact, or two machines whose clocks disagree — and letting it through would
 * produce a zero or a negative duration that looks exactly like a measurement.
 */
function startOrNone(
  candidate: string | null | undefined,
  finishedAt: string,
  basis: StartBasis
): { startedAt: string | null; startBasis: StartBasis } {
  if (candidate && candidate < finishedAt) return { startedAt: candidate, startBasis: basis }
  return { startedAt: null, startBasis: 'none' }
}

// ---------------------------------------------------------------------------
// Steps 1 and 2 — the whole-break ticks
// ---------------------------------------------------------------------------

/**
 * Record (or forget) step 1 or step 2 for a break.
 *
 * SLEEVE has no predecessor. It is the first thing anybody writes about a
 * break, so the only earlier instant on record is the earliest card somebody
 * sleeved INDIVIDUALLY on the checker screen. Where the floor ticked the pile
 * in one go — which is the ordinary case — there is genuinely nothing earlier
 * and the duration stays unknown. Reaching for the shift's clock-in instead
 * was considered and rejected: it would charge the whole evening before anybody
 * touched the break to the person who eventually did.
 *
 * SORT measures from the sleeve stamp on the SAME break. That is elapsed time
 * and not effort — the pile can sit on the bench between the two — and the
 * screen says so under the column.
 */
export function recordBenchStep(
  breakId: string,
  step: 'sleeve' | 'sort',
  done: boolean,
  by: string | null,
  finishedAt: string
): void {
  if (!done) {
    clearWorkEvent(step, breakId)
    // Un-sleeving cascades to sorting (see stepsClearedBy), and an un-sorted
    // break is not off the bench either. Both measurements go with it, or the
    // log would keep asserting a completion the checklist has withdrawn.
    if (step === 'sleeve') clearWorkEvent('sort', breakId)
    clearWorkEvent('break_done', breakId)
    return
  }
  quietly(() => {
    const f = breakFacts(breakId)
    if (!f) return
    const start =
      step === 'sleeve'
        ? startOrNone(f.firstCardSleeve, finishedAt, 'first-card')
        : startOrNone(f.sleevedAt, finishedAt, 'prev-step')
    recordWorkEvent({
      kind: step,
      subjectId: breakId,
      breakId,
      breakLabel: f.breakLabel,
      importId: currentImportId(),
      employeeId: by,
      startedAt: start.startedAt,
      startBasis: start.startBasis,
      finishedAt,
      // Cards, so "sleeved" and "sorted" can be compared against a break with
      // twice the slate rather than counted as one event each.
      units: f.cards
    })
  })
}

// ---------------------------------------------------------------------------
// Step 3 — one measurement per team
// ---------------------------------------------------------------------------

/**
 * Record (or forget) one team's bag tick.
 *
 * The start is the PREVIOUS bag tick on the same break, which makes each team's
 * figure the gap since the last one — the closest thing to "how long that team
 * took" the data can support. The first team of a break measures from the sort
 * stamp instead, because that is when the tray it is being taken from was ready.
 *
 * `subjectId` is the card slot's id for a sold team and the derived bag row id
 * for an unsold one. Both are stable across a re-tick, which is what keeps the
 * derived row id from splitting into two.
 */
export function recordBagTick(args: {
  breakId: string
  subjectId: string
  bagged: boolean
  by: string | null
  finishedAt: string
}): void {
  if (!args.bagged) {
    clearWorkEvent('bag', args.subjectId)
    clearWorkEvent('break_done', args.breakId)
    return
  }
  quietly(() => {
    const f = breakFacts(args.breakId)
    if (!f) return
    const prev = getDb()
      .prepare(
        `SELECT MAX(finished_at) AS t FROM ship_work_log
          WHERE kind = 'bag' AND break_id = ? AND finished_at < ?`
      )
      .get(args.breakId, args.finishedAt) as { t: string | null } | undefined
    const start = prev?.t
      ? startOrNone(prev.t, args.finishedAt, 'prev-tick')
      : startOrNone(f.sortedAt, args.finishedAt, 'prev-step')
    recordWorkEvent({
      kind: 'bag',
      subjectId: args.subjectId,
      breakId: args.breakId,
      breakLabel: f.breakLabel,
      importId: currentImportId(),
      employeeId: args.by,
      startedAt: start.startedAt,
      startBasis: start.startBasis,
      finishedAt: args.finishedAt,
      units: 1
    })
  })
}

/**
 * The break came off the bench.
 *
 * Its own kind rather than a flag on the last bag tick, because "how many
 * breaks were done in the range" is the question the owner asked first and it
 * must not depend on reconstructing a slate size from a dataset that will be
 * gone. Written the moment the checklist says every step is finished; removed
 * again if anything is un-ticked.
 *
 * It carries a duration — the whole bench elapsed, sleeve stamp to last tick —
 * and that duration is deliberately excluded from every step average, because
 * it is the same time the steps already measured.
 */
export function recordBreakDone(breakId: string, by: string | null, finishedAt: string): void {
  quietly(() => {
    const f = breakFacts(breakId)
    if (!f) return
    const start = startOrNone(f.sleevedAt, finishedAt, 'prev-step')
    recordWorkEvent({
      kind: 'break_done',
      subjectId: breakId,
      breakId,
      breakLabel: f.breakLabel,
      importId: currentImportId(),
      employeeId: by,
      startedAt: start.startedAt,
      startBasis: start.startBasis,
      finishedAt,
      units: f.cards
    })
  })
}

// ---------------------------------------------------------------------------
// Steps 4 and 5 — the packages
// ---------------------------------------------------------------------------

/**
 * Record a package as packed.
 *
 * THE ONE STEP WITH A REAL START. A pack station claim is written when somebody
 * takes the order and carries claimed_at — an explicit "I have started this",
 * not a completion stamp being read backwards. Everything else in this file is
 * an inference; this is a measurement.
 *
 * A package packed from the Orders screen was never claimed at a station, so it
 * has no start and reads as unknown. That is the honest answer: nothing anywhere
 * says when that person picked the box up.
 */
export function recordPack(args: {
  shipmentId: string
  customerId: string | null
  by: string | null
  finishedAt: string
}): void {
  quietly(() => {
    const claimed = args.customerId
      ? ((
          getDb()
            .prepare(
              `SELECT MAX(claimed_at) AS t FROM ship_work_claims
                WHERE customer_id = ? AND role = 'pack' AND released_at IS NULL
                  AND claimed_at <= ?`
            )
            .get(args.customerId, args.finishedAt) as { t: string | null } | undefined
        )?.t ?? null)
      : null
    const start = startOrNone(claimed, args.finishedAt, 'claim')
    recordWorkEvent({
      kind: 'pack',
      subjectId: args.shipmentId,
      importId: currentImportId(),
      employeeId: args.by,
      startedAt: start.startedAt,
      startBasis: start.startBasis,
      finishedAt: args.finishedAt,
      units: 1
    })
  })
}

/**
 * Record a package as gone.
 *
 * Measured from packed_at, which makes it a QUEUE WAIT and not a piece of work:
 * boxes go to the carrier in batches, so this is how long a sealed mailer sat.
 * It is still worth having — a rising figure is a pile nobody is taking out —
 * and the screen labels it as what it is rather than as effort.
 */
export function recordShip(args: {
  shipmentId: string
  packedAt: string | null
  by: string | null
  finishedAt: string
}): void {
  quietly(() => {
    const start = startOrNone(args.packedAt, args.finishedAt, 'packed')
    recordWorkEvent({
      kind: 'ship',
      subjectId: args.shipmentId,
      importId: currentImportId(),
      employeeId: args.by,
      startedAt: start.startedAt,
      startBasis: start.startBasis,
      finishedAt: args.finishedAt,
      units: 1
    })
  })
}

/** A package that went back to not-shipped never shipped. */
export function clearShipEvent(shipmentId: string): void {
  clearWorkEvent('ship', shipmentId)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every event whose completion falls in [startIso, endIso).
 *
 * Half-open, and the window is a UTC approximation of a run of LOCAL days —
 * @shared/performance re-tests each row against the local calendar, because the
 * offset in force can differ across a range that spans a clock change and only
 * the local test is definitive. This one is here to keep the query off the
 * whole table.
 */
export function listWorkEvents(startIso: string, endIso: string): WorkEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, subject_id, break_id, break_label, import_id, employee_id,
              started_at, start_basis, finished_at, units
         FROM ship_work_log
        WHERE finished_at >= ? AND finished_at < ?
        ORDER BY finished_at ASC`
    )
    .all(startIso, endIso) as WorkLogRow[]
  const out: WorkEvent[] = []
  for (const r of rows) {
    const ev = toWorkEvent(r)
    // A kind this build does not recognise is dropped rather than counted as
    // something it is not — a newer machine's row can arrive here by sync.
    if (ev) out.push(ev)
  }
  return out
}

/** The oldest and newest completion in the log, for an honest empty state. */
export function workLogSpan(): { first: string | null; last: string | null } {
  const row = getDb()
    .prepare(`SELECT MIN(finished_at) AS a, MAX(finished_at) AS b FROM ship_work_log`)
    .get() as { a: string | null; b: string | null } | undefined
  return { first: row?.a ?? null, last: row?.b ?? null }
}
