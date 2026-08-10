/**
 * How long the shipping floor takes at each step, and who took it.
 *
 * ## The problem this file exists to solve
 *
 * Every record the floor writes is a COMPLETION STAMP. Ticking "sleeved" says
 * when the sleeving FINISHED; nothing anywhere says when it started. So a
 * duration cannot be read off the data — it has to be DERIVED from two chosen
 * endpoints, and every possible choice measures something slightly different
 * and is wrong in its own way. Idle time between two ticks, two people sharing
 * one break, a whole night's worth of steps ticked in a batch at 10pm, a break
 * begun before a shift and finished after: each of those breaks a different
 * choice of endpoints.
 *
 * The response is not to pick a clever rule. It is to pick a plain one, write
 * down exactly which two instants it uses, carry that decision WITH the number
 * (see `startBasis`), and refuse to print anything at all where the two
 * endpoints do not both exist. `StepStat.avgSeconds` is `null` — a dash on the
 * screen — rather than a zero, for the same reason the per-break P&L refuses to
 * print a missing cost as 0: a plausible-looking number flatters exactly the
 * row that has the problem, and it is the row somebody then acts on.
 *
 * ## The five steps, and the two endpoints each one uses
 *
 * See STEP_DEFS below for the machine-readable version — the screen prints
 * those sentences verbatim, so the operator reads the same definition the
 * arithmetic used.
 *
 *   1 SLEEVE     first per-card sleeve stamp on the break -> the break's
 *                sleeved_at. UNKNOWN when nobody ticked cards individually,
 *                because then there is genuinely no earlier instant on record:
 *                the break's own stamp is the FIRST thing written about it.
 *   2 SORT       the break's sleeved_at -> its sorted_at.
 *   3 BAG        the previous bag tick on the same break (or sorted_at, for the
 *                first team) -> this team's tick. One measurement per TEAM.
 *   4 PACK       the pack station claim's claimed_at -> the package's packed_at.
 *                The only step with a real, recorded start.
 *   5 SHIP       the package's packed_at -> the instant its status moved to a
 *                sent code.
 *
 * ## Attribution: whoever ENDED the interval owns it
 *
 * One rule, applied everywhere, because a break really is worked by several
 * people — one sleeves, another sorts, three share the bagging — and any rule
 * that splits an interval between them would be inventing a division nobody
 * recorded. The person named on the CLOSING stamp gets the whole interval. That
 * is honest about who finished it and silent about who helped, which is the
 * true state of the record.
 *
 * A stamp with nobody on it is a real and common case — an older row, a bulk
 * action taken before the app stamped a name. Those collect on a single
 * unattributed row (`employeeId: null`) rather than being dropped or, worse,
 * folded into whoever else was on that night.
 *
 * ## Wall clock vs instant
 *
 * Every stamp here is a UTC instant: a physical event, at a moment. The RANGE
 * the operator picks is a run of LOCAL days: an intention about a calendar. The
 * two are converted in exactly one place — `dayKeyOf`, injected — and an event
 * belongs to the local day its CLOSING stamp fell on. A break sleeved at 23:50
 * and sorted at 00:10 therefore reports its sort on the second day, which is the
 * day the person doing it would say they did it.
 *
 * ## Minutes, not milliseconds
 *
 * Durations are held in whole SECONDS and meant to be read in minutes. Anything
 * finer is noise here: these are stamps a human pressed, so the last two digits
 * of a millisecond figure describe the click and not the work. Seconds rather
 * than whole minutes because rounding each sample to a minute first would turn
 * every twenty-second team bag into a zero, which is the one number this file
 * exists to refuse.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The five steps a shipping night is measured in. */
export type PerfStepId = 'sleeve' | 'sort' | 'bag' | 'pack' | 'ship'

export const PERF_STEPS: PerfStepId[] = ['sleeve', 'sort', 'bag', 'pack', 'ship']

/**
 * What the work log records.
 *
 * `break_done` is deliberately NOT one of the five: it carries no duration of
 * its own that anybody works at, it is the moment a break came off the bench —
 * the fact behind "how many breaks were done in the range". Keeping it in the
 * same log rather than in a table of its own is what makes that count and the
 * step timings incapable of disagreeing about the same night.
 */
export type WorkEventKind = PerfStepId | 'break_done'

/**
 * Where an event's START instant came from — recorded per event rather than
 * assumed per step.
 *
 * It has to travel WITH the row. The endpoints are derived at the moment of
 * writing, while both instants still exist (see db/workLog.ts for why they do
 * not exist later), so by the time anything reads this the evidence is gone.
 * A basis of 'none' is the honest statement that no start could be established,
 * and it is what makes an unknown duration distinguishable from a fast one.
 */
export type StartBasis =
  /** The earliest per-card sleeve tick on this break. */
  | 'first-card'
  /** The completion stamp of the step immediately before this one. */
  | 'prev-step'
  /** The previous tick of the SAME step on the same break. */
  | 'prev-tick'
  /** A pick/pack station claim — a genuine "I have started this" record. */
  | 'claim'
  /** The package's packed_at. */
  | 'packed'
  /** Nothing earlier is on record. The duration is unknown, not zero. */
  | 'none'

/** One completed unit of floor work, with both endpoints already resolved. */
export interface WorkEvent {
  id: string
  kind: WorkEventKind
  /** The break, slot, bag or shipment this is about. */
  subjectId: string
  /** Denormalised so a row still reads after its show has been overwritten. */
  breakId: string | null
  breakLabel: string | null
  importId: string | null
  /** Null is a real state: a stamp with nobody on it. */
  employeeId: string | null
  startedAt: string | null
  startBasis: StartBasis
  /** The completion stamp. Always present — it is what makes this an event. */
  finishedAt: string
  /** Physical things covered: 1 team, 1 package, or a break's whole slate. */
  units: number
}

export interface PerfStepDef {
  id: PerfStepId
  n: number
  label: string
  /** The two endpoints, in the words the screen prints under the column. */
  measures: string
  /** The specific way this particular number can mislead. Printed as well. */
  caveat: string
}

/**
 * The definitions, in the app's own vocabulary, kept next to the arithmetic
 * that uses them.
 *
 * These strings are shown on the screen rather than paraphrased there. A
 * reporting screen whose column headings say something slightly different from
 * what the code measured is how a number gets quoted in a conversation it does
 * not support.
 */
export const STEP_DEFS: PerfStepDef[] = [
  {
    id: 'sleeve',
    n: 1,
    label: 'Sleeve & top-load',
    measures: 'First card sleeved on the break → the break ticked as sleeved.',
    caveat:
      'Only measurable when cards were ticked individually. On a break where the whole pile was ticked in one go there is no earlier instant on record, so the time is unknown.'
  },
  {
    id: 'sort',
    n: 2,
    label: 'Sort into trays',
    measures: 'The break ticked as sleeved → the break ticked as sorted.',
    caveat:
      'Elapsed time, not effort: anything between the two ticks counts, including a break, a phone call, or the pile sitting on the bench.'
  },
  {
    id: 'bag',
    n: 3,
    label: 'Sticker & team-bag',
    measures: 'The previous team bagged on this break → this team bagged. The first team measures from the sort tick.',
    caveat:
      'One measurement per team. Teams ticked in a burst at the end read as near-zero and push the average down; the median beside it is there for exactly that.'
  },
  {
    id: 'pack',
    n: 4,
    label: 'Pack',
    measures: 'The packer claimed the order at their station → the package marked packed.',
    caveat:
      'The only step with a recorded start. A package packed without ever being claimed at a station has no start and reads as unknown.'
  },
  {
    id: 'ship',
    n: 5,
    label: 'Scan & ship',
    measures: 'The package marked packed → its status moved to shipped or delivered.',
    caveat:
      'Mostly queue time. Packages are handed to the carrier in batches, so this measures how long a sealed box waited, not how long anybody worked on it.'
  }
]

export function perfStep(id: PerfStepId): PerfStepDef {
  // Every id in the union has an entry, so the fallback is unreachable —
  // returning a real object still beats a crash on a reporting screen.
  return STEP_DEFS.find((s) => s.id === id) ?? STEP_DEFS[0]
}

/**
 * Past this, a gap is not a measurement of anybody's work.
 *
 * Eight hours is longer than any single step has ever taken and shorter than a
 * night plus the morning after. It catches the two cases that would otherwise
 * dominate every average: a break begun before a shift and closed after the
 * next one started, and a step ticked from memory a day later. Those events are
 * COUNTED — see `StepStat.implausible` — and excluded from the averages, so the
 * screen can say "and eleven more we could not time" instead of quietly
 * reporting a nine-hour team bag.
 */
export const IMPLAUSIBLE_SECONDS = 8 * 60 * 60

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface StepStat {
  step: PerfStepId
  /** Events with both endpoints and a believable gap — what the averages use. */
  samples: number
  /**
   * Events with no derivable start. Counted, never averaged, always shown.
   *
   * This is the number that stops the screen lying. Ten bagged teams of which
   * nine could not be timed is a completely different statement from ten timed
   * teams, and an average alone cannot tell them apart.
   */
  unknown: number
  /** Events whose gap was negative or over the cap. Counted, not averaged. */
  implausible: number
  /** Physical things the counted events covered: teams, packages, breaks. */
  units: number
  /** Null when there is nothing to average. Never 0 as a stand-in. */
  avgSeconds: number | null
  /** Robust against a burst of ticks at the end of a night in a way avg is not. */
  medianSeconds: number | null
  /** Time on the clock across the plausible samples only. */
  totalSeconds: number | null
}

export interface EmployeePerf {
  /** Null on the one row that collects stamps with nobody's name on them. */
  employeeId: string | null
  name: string
  steps: Record<PerfStepId, StepStat>
  /** Every event this person closed, of any kind. */
  events: number
  /**
   * Minutes clocked in over the same range, or null when nothing is known.
   *
   * Context, deliberately NOT a denominator. A step timing derived from stamps
   * and a punch clock measure different things — one is a gap between two
   * clicks, the other is a physical presence — and dividing one by the other
   * produces a utilisation figure neither of them supports.
   */
  clockedMinutes: number | null
}

export interface ShippingPerformance {
  /** The local days the report covers, inclusive. */
  from: string
  to: string
  /** Breaks that came off the bench inside the range. */
  breaksDone: number
  /** Breaks with any bench work in the range, finished or not. */
  breaksWorked: number
  /** Distinct packages marked packed in the range. */
  packagesPacked: number
  /** Distinct packages whose status moved to shipped/delivered in the range. */
  packagesShipped: number
  people: EmployeePerf[]
  /** The same five stats over everybody, so a total is never a sum of averages. */
  totals: Record<PerfStepId, StepStat>
  /** Events in the range carrying no employee id. */
  unattributedEvents: number
  /** Breaks whose events in the range name more than one person. */
  sharedBreaks: number
  /**
   * Breaks that show other bench work in the range but no tick for this step.
   *
   * The concrete form of "a step nobody ticked". Without it a step that is
   * simply never recorded looks identical to a step that does not happen.
   */
  breaksMissingStep: Record<'sleeve' | 'sort' | 'bag', number>
  /** Events whose start fell on an earlier local day than their finish. */
  spanningEvents: number
  /** True when the range contains no events at all. */
  empty: boolean
}

/**
 * What a screen receives: the summary plus the log's own extent.
 *
 * `loggedFrom` is the honest empty state, and it is not decoration. This log
 * begins when the feature shipped; every show before that is genuinely
 * unrecoverable, because its stamps lived on tables the next import deleted. A
 * range with nothing in it therefore means one of two completely different
 * things — "nobody worked" or "we were not recording yet" — and only this field
 * tells them apart. Without it the screen would report an empty week as an idle
 * one.
 */
export interface ShippingPerformanceView extends ShippingPerformance {
  loggedFrom: string | null
  loggedTo: string | null
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * The LOCAL calendar day a UTC instant fell on.
 *
 * Local, deliberately, and it is the whole reason this is a function rather
 * than `iso.slice(0, 10)`. Bucketing by the UTC prefix puts a 7pm tick in New
 * York on tomorrow's report, so a Friday night's work would show up as Saturday
 * for everyone west of Greenwich — including on the "today" preset, which is
 * the one people check while still standing at the bench.
 */
export function localDayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * Shift a YYYY-MM-DD key by whole days, parsed at UTC NOON.
 *
 * The fourth copy of this rule in the codebase, and it keeps its reason with
 * it: a date-only string parsed as local midnight and then moved across a
 * daylight-saving boundary lands at 23:00 the previous day and rounds the wrong
 * way. Noon is twelve hours from either edge, so no real offset reaches across
 * it. See `addDays` in @shared/homeTasks, @shared/schedule and @shared/invoices.
 */
export function addDayKey(day: string, n: number): string {
  const t = Date.parse(`${day}T12:00:00Z`)
  if (!Number.isFinite(t)) return day
  return new Date(t + n * DAY_MS).toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative when reversed. */
export function daysBetweenKeys(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`)
  const b = Date.parse(`${to}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / DAY_MS)
}

/**
 * The half-open UTC window a run of local days occupies: [start, end).
 *
 * THE ONE PLACE a wall-clock intention becomes an instant. `from` and `to` are
 * local calendar days somebody picked; the stamps being selected are physical
 * moments. Built with the numeric Date constructor, which is local by
 * definition — `new Date('2026-03-08')` is NOT the same thing, it parses as UTC
 * midnight and would slide the window by the offset.
 *
 * Half-open at the end so an event stamped at 23:59:59.999 on the last day is
 * inside it and one at 00:00:00.000 the next morning is not. A closed end built
 * from `T23:59:59` silently drops the last second of every range.
 */
export function utcWindowForDays(from: string, to: string): { startIso: string; endIso: string } {
  const a = parseDayParts(from)
  const b = parseDayParts(addDayKey(to, 1))
  if (!a || !b) return { startIso: '', endIso: '' }
  const start = new Date(a.y, a.m - 1, a.d, 0, 0, 0, 0)
  const end = new Date(b.y, b.m - 1, b.d, 0, 0, 0, 0)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function parseDayParts(day: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day ?? '').trim())
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}

/** A range from two day keys in either order. */
export function orderDays(a: string, b: string): { from: string; to: string } {
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

interface Bucket {
  durations: number[]
  unknown: number
  implausible: number
  units: number
}

function emptyBucket(): Bucket {
  return { durations: [], unknown: 0, implausible: 0, units: 0 }
}

function emptyBuckets(): Record<PerfStepId, Bucket> {
  return {
    sleeve: emptyBucket(),
    sort: emptyBucket(),
    bag: emptyBucket(),
    pack: emptyBucket(),
    ship: emptyBucket()
  }
}

/**
 * An event's duration in whole seconds, or null when it has none.
 *
 * Three ways to have none, and they are not the same and are not merged:
 *   - no start was ever established (basis 'none'),
 *   - a stamp that will not parse — corrupt or hand-edited,
 *   - a NEGATIVE gap, which means the two stamps came from machines whose
 *     clocks disagree. That is a real possibility here: a bench laptop writes
 *     the tick and another machine may have written the stamp before it, and
 *     the sync layer arbitrates rows, not clocks. Returning a negative number
 *     would drag an average below zero.
 */
export function eventSeconds(ev: WorkEvent): number | null {
  if (!ev.startedAt) return null
  const a = Date.parse(ev.startedAt)
  const b = Date.parse(ev.finishedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const secs = Math.round((b - a) / 1000)
  return secs < 0 ? null : secs
}

function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = n >> 1
  return n % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function statFrom(step: PerfStepId, b: Bucket): StepStat {
  const sorted = [...b.durations].sort((x, y) => x - y)
  const total = sorted.reduce((s, n) => s + n, 0)
  return {
    step,
    samples: sorted.length,
    unknown: b.unknown,
    implausible: b.implausible,
    units: b.units,
    // Null rather than 0 throughout. A step with nothing to average has no
    // average, and printing 0 there says "instant" to anybody reading a column
    // of numbers.
    avgSeconds: sorted.length > 0 ? Math.round(total / sorted.length) : null,
    medianSeconds: sorted.length > 0 ? median(sorted) : null,
    totalSeconds: sorted.length > 0 ? total : null
  }
}

function statsFrom(buckets: Record<PerfStepId, Bucket>): Record<PerfStepId, StepStat> {
  return {
    sleeve: statFrom('sleeve', buckets.sleeve),
    sort: statFrom('sort', buckets.sort),
    bag: statFrom('bag', buckets.bag),
    pack: statFrom('pack', buckets.pack),
    ship: statFrom('ship', buckets.ship)
  }
}

/** Where a person's name comes from, and what stands in when there is none. */
export const UNATTRIBUTED_NAME = 'Not attributed'

export interface SummariseArgs {
  events: readonly WorkEvent[]
  /** Inclusive local day keys. */
  from: string
  to: string
  /** Display name for an employee id; null when the id resolves to nobody. */
  nameOf?: (employeeId: string) => string | null
  /** Clocked-in minutes per employee over the same range. Absent = unknown. */
  clockedMinutes?: ReadonlyMap<string, number>
  /**
   * Instant -> local day. Injected rather than called directly so a test can
   * pin a timezone instead of inheriting whatever the machine running it is
   * set to — which is how a date bug hides until it is somebody else's Tuesday.
   */
  dayKeyOf?: (iso: string) => string
}

/**
 * Roll a range of work events up into the screen's whole answer.
 *
 * Filtering happens HERE rather than only in the query that fetched the rows.
 * The main process narrows by a UTC window for speed, but the window is an
 * approximation of a run of local days and the last hour of it depends on the
 * offset in force that week. The definitive test — does this event's closing
 * stamp fall on a local day inside the range — is applied here, where it is
 * tested.
 */
export function summariseShipping(args: SummariseArgs): ShippingPerformance {
  const dayKeyOf = args.dayKeyOf ?? localDayKey
  const { from, to } = orderDays(args.from, args.to)
  const nameOf = args.nameOf ?? ((): string | null => null)

  const inRange = args.events.filter((ev) => {
    const key = dayKeyOf(ev.finishedAt)
    return key !== '' && key >= from && key <= to
  })

  const totals = emptyBuckets()
  const perPerson = new Map<string, { id: string | null; buckets: Record<PerfStepId, Bucket>; events: number }>()

  const breaksDone = new Set<string>()
  const breaksWorked = new Set<string>()
  const packedSubjects = new Set<string>()
  const shippedSubjects = new Set<string>()
  const breakPeople = new Map<string, Set<string>>()
  const breaksWithStep: Record<'sleeve' | 'sort' | 'bag', Set<string>> = {
    sleeve: new Set(),
    sort: new Set(),
    bag: new Set()
  }
  let unattributedEvents = 0
  let spanningEvents = 0

  for (const ev of inRange) {
    if (!ev.employeeId) unattributedEvents += 1
    if (ev.startedAt) {
      const startDay = dayKeyOf(ev.startedAt)
      if (startDay !== '' && startDay < dayKeyOf(ev.finishedAt)) spanningEvents += 1
    }

    // A break's identity for the "who worked it" question is the id, which is
    // stable within a show. Events with no break at all (pack and ship are
    // about packages) contribute nothing here rather than sharing one bucket.
    if (ev.breakId) {
      const who = breakPeople.get(ev.breakId) ?? new Set<string>()
      who.add(ev.employeeId ?? '')
      breakPeople.set(ev.breakId, who)
      if (ev.kind === 'sleeve' || ev.kind === 'sort' || ev.kind === 'bag') {
        breaksWorked.add(ev.breakId)
        breaksWithStep[ev.kind].add(ev.breakId)
      }
    }

    if (ev.kind === 'break_done') {
      breaksDone.add(ev.subjectId)
      // Deliberately no duration bucket: it is a marker, not one of the five,
      // and folding its whole-break elapsed into any step would double-count
      // time already measured by the steps themselves.
      continue
    }

    if (ev.kind === 'pack') packedSubjects.add(ev.subjectId)
    if (ev.kind === 'ship') shippedSubjects.add(ev.subjectId)

    const key = ev.employeeId ?? ''
    let person = perPerson.get(key)
    if (!person) {
      person = { id: ev.employeeId ?? null, buckets: emptyBuckets(), events: 0 }
      perPerson.set(key, person)
    }
    person.events += 1

    const step = ev.kind
    const units = Number.isFinite(ev.units) && ev.units > 0 ? Math.trunc(ev.units) : 1
    totals[step].units += units
    person.buckets[step].units += units

    const secs = eventSeconds(ev)
    if (secs === null) {
      totals[step].unknown += 1
      person.buckets[step].unknown += 1
    } else if (secs > IMPLAUSIBLE_SECONDS) {
      totals[step].implausible += 1
      person.buckets[step].implausible += 1
    } else {
      totals[step].durations.push(secs)
      person.buckets[step].durations.push(secs)
    }
  }

  const people: EmployeePerf[] = [...perPerson.values()]
    .map((p) => ({
      employeeId: p.id,
      name: p.id ? (nameOf(p.id) ?? `Unknown (${p.id.slice(0, 8)})`) : UNATTRIBUTED_NAME,
      steps: statsFrom(p.buckets),
      events: p.events,
      clockedMinutes: p.id ? (args.clockedMinutes?.get(p.id) ?? null) : null
    }))
    // Named people first, alphabetically; the unattributed row last. Last
    // rather than first because it is a gap in the record, and sorting a gap
    // above every real person puts it where somebody starts reading.
    .sort((a, b) => {
      if (a.employeeId === null) return b.employeeId === null ? 0 : 1
      if (b.employeeId === null) return -1
      return a.name.localeCompare(b.name)
    })

  let sharedBreaks = 0
  for (const who of breakPeople.values()) if (who.size > 1) sharedBreaks += 1

  return {
    from,
    to,
    breaksDone: breaksDone.size,
    breaksWorked: breaksWorked.size,
    packagesPacked: packedSubjects.size,
    packagesShipped: shippedSubjects.size,
    people,
    totals: statsFrom(totals),
    unattributedEvents,
    sharedBreaks,
    breaksMissingStep: {
      sleeve: countMissing(breaksWorked, breaksWithStep.sleeve),
      sort: countMissing(breaksWorked, breaksWithStep.sort),
      bag: countMissing(breaksWorked, breaksWithStep.bag)
    },
    spanningEvents,
    empty: inRange.length === 0
  }
}

function countMissing(all: ReadonlySet<string>, have: ReadonlySet<string>): number {
  let n = 0
  for (const id of all) if (!have.has(id)) n += 1
  return n
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Seconds as the screen prints them, or an em dash when there is nothing.
 *
 * The dash is the point of the function. An empty cell reads as a rendering
 * fault; a dash reads as "not known", which is what it is. Same decision, same
 * character, as the per-break P&L's missing cost.
 */
export function minutesLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds}s`
  const mins = seconds / 60
  // One decimal below an hour: "12.4 min" is a figure somebody can act on and
  // "12 min 24 s" is a figure they have to parse. Whole minutes above it,
  // because a tenth of a minute inside a two-hour queue wait is noise.
  if (mins < 60) return `${Math.round(mins * 10) / 10} min`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${Math.round(mins - hrs * 60)}m`
}
