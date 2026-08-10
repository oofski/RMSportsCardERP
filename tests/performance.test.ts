/**
 * Employee performance — the shipping floor's five step timings.
 *
 * What is pinned here, and how each one fails if it is wrong:
 *
 *   1. AN UNMEASURABLE STEP IS NOT A FAST ONE. Every duration is derived from
 *      two completion stamps, and where the earlier one does not exist there is
 *      no duration at all. If that ever becomes a 0 the averages collapse
 *      towards zero and the worst-recorded person looks like the quickest.
 *
 *   2. A NEGATIVE OR ENORMOUS GAP IS NOT A MEASUREMENT. Two laptops whose
 *      clocks disagree, or a break begun before a shift and ticked after the
 *      next one, must not enter an average — and must still be COUNTED, or the
 *      screen silently reports on a subset it never mentions.
 *
 *   3. AN INTERVAL BELONGS TO WHOEVER ENDED IT. One break worked by three
 *      people produces three rows, each holding the step that person closed.
 *      Any other rule invents a division of labour nobody recorded.
 *
 *   4. NOBODY IS DROPPED OR MERGED. A stamp with no employee on it lands on its
 *      own row, last, and never inside somebody else's figures.
 *
 *   5. DAYS ARE LOCAL, STAMPS ARE UTC. An event belongs to the local day its
 *      CLOSING stamp fell on. Bucketing by the UTC prefix moves a Friday night
 *      onto Saturday for everyone west of Greenwich.
 *
 *   6. THE TOTAL IS NOT AN AVERAGE OF AVERAGES. Somebody who bagged three teams
 *      must not weigh the same as somebody who bagged ninety.
 *
 * ## Why this suite pins TZ=Europe/London
 *
 * Two of the rules above are about timezones, and a date test that inherits
 * whatever the machine is set to only proves the machine's own offset. Most of
 * the file sidesteps that by injecting `dayKeyOf`, but `addDayKey` cannot be
 * injected — it IS the rule. Parsed at local midnight instead of UTC noon it
 * still gives the right answer everywhere WEST of Greenwich, so a suite run in
 * UTC or in New York would pass with the bug in place. London in July is UTC+1,
 * which is enough for the wrong parse to shift a whole day, and it also carries
 * a real DST boundary. See the July assertion in section 5.
 *
 * Every name below is invented. This repository is public.
 *
 * Run: npm run test:performance
 */
const {
  IMPLAUSIBLE_SECONDS,
  PERF_STEPS,
  addDayKey,
  daysBetweenKeys,
  eventSeconds,
  minutesLabel,
  orderDays,
  perfStep,
  summariseShipping,
  utcWindowForDays
} = require('../src/shared/performance')

let pass = 0
let fail = 0
const ok = (c: boolean, name: string, extra = ''): void => {
  if (c) {
    pass++
    console.log('  ok   ' + name)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

// ---------------------------------------------------------------------------
// A fixed local calendar, so nothing here depends on the machine's timezone.
//
// UTC-05:00. Chosen because it is far enough west that a late-evening tick has
// a different UTC date from its local one, which is the whole failure mode
// being guarded against.
// ---------------------------------------------------------------------------
const OFFSET_MIN = -300
const dayKeyOf = (iso: string): string => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t + OFFSET_MIN * 60_000).toISOString().slice(0, 10)
}

type Ev = Record<string, unknown>
let seq = 0
const ev = (over: Ev): Ev => {
  seq += 1
  return {
    id: `e${seq}`,
    kind: 'bag',
    subjectId: `s${seq}`,
    breakId: null,
    breakLabel: null,
    importId: 'imp1',
    employeeId: null,
    startedAt: null,
    startBasis: 'none',
    finishedAt: '2026-03-10T20:00:00.000Z',
    units: 1,
    ...over
  }
}

/** Invented people. */
const NOVA = 'emp_nova_arkwright'
const PIP = 'emp_pip_dalgleish'
const RIO = 'emp_rio_castellan'
const NAMES: Record<string, string> = {
  [NOVA]: 'Nova Arkwright',
  [PIP]: 'Pip Dalgleish',
  [RIO]: 'Rio Castellan'
}
const nameOf = (id: string): string | null => NAMES[id] ?? null

const run = (events: Ev[], from = '2026-03-10', to = '2026-03-10', extra: Ev = {}): any =>
  summariseShipping({ events, from, to, nameOf, dayKeyOf, ...extra })

// ---------------------------------------------------------------------------
console.log('=== 1. an unmeasurable step is not a fast one ===')
// ---------------------------------------------------------------------------
const noStart = run([
  ev({ kind: 'sleeve', employeeId: NOVA, breakId: 'break_7', startBasis: 'none', startedAt: null }),
  ev({ kind: 'sleeve', employeeId: NOVA, breakId: 'break_8', startBasis: 'none', startedAt: null })
])
ok(noStart.totals.sleeve.avgSeconds === null, 'no start anywhere leaves the average null, not 0')
ok(noStart.totals.sleeve.medianSeconds === null, 'and the median null too')
ok(noStart.totals.sleeve.totalSeconds === null, 'and the total null too')
ok(noStart.totals.sleeve.unknown === 2, 'both are counted as untimeable', String(noStart.totals.sleeve.unknown))
ok(noStart.totals.sleeve.samples === 0, 'and neither is a sample')
ok(noStart.people[0].steps.sleeve.avgSeconds === null, 'the person row refuses the same way')
ok(noStart.people[0].steps.sleeve.units === 2, 'while still showing the work was done')

// A basis of 'none' must beat a stray start value: a row written by a future
// build that means something else by the word must not become a measurement.
ok(
  eventSeconds(ev({ startedAt: null, startBasis: 'none' })) === null,
  'eventSeconds returns null with no start'
)
ok(
  eventSeconds(
    ev({ startedAt: '2026-03-10T20:00:00.000Z', finishedAt: '2026-03-10T20:04:30.000Z' })
  ) === 270,
  'and whole seconds when there is one'
)

// ---------------------------------------------------------------------------
console.log('\n=== 2. a negative or enormous gap is not a measurement ===')
// ---------------------------------------------------------------------------
ok(
  eventSeconds(
    ev({ startedAt: '2026-03-10T20:10:00.000Z', finishedAt: '2026-03-10T20:00:00.000Z' })
  ) === null,
  'a finish before its start is unknown, never a negative duration'
)

const mixed = run([
  // 4 minutes: an ordinary team bag.
  ev({
    kind: 'bag',
    employeeId: PIP,
    breakId: 'break_7',
    startedAt: '2026-03-10T20:00:00.000Z',
    finishedAt: '2026-03-10T20:04:00.000Z',
    startBasis: 'prev-tick'
  }),
  // 6 minutes.
  ev({
    kind: 'bag',
    employeeId: PIP,
    breakId: 'break_7',
    startedAt: '2026-03-10T20:04:00.000Z',
    finishedAt: '2026-03-10T20:10:00.000Z',
    startBasis: 'prev-tick'
  }),
  // Nine hours: the break that sat overnight. Counted, never averaged.
  ev({
    kind: 'bag',
    employeeId: PIP,
    breakId: 'break_7',
    startedAt: '2026-03-10T11:00:00.000Z',
    finishedAt: '2026-03-10T20:30:00.000Z',
    startBasis: 'prev-tick'
  }),
  // Clocks disagreed between two laptops.
  ev({
    kind: 'bag',
    employeeId: PIP,
    breakId: 'break_7',
    startedAt: '2026-03-10T20:40:00.000Z',
    finishedAt: '2026-03-10T20:39:00.000Z',
    startBasis: 'prev-tick'
  })
])
ok(mixed.totals.bag.samples === 2, 'only the believable gaps are samples', String(mixed.totals.bag.samples))
ok(mixed.totals.bag.avgSeconds === 300, 'the average is over those two only', String(mixed.totals.bag.avgSeconds))
ok(mixed.totals.bag.implausible === 1, 'the nine-hour one is counted as excluded')
ok(mixed.totals.bag.unknown === 1, 'the backwards one is counted as untimeable')
ok(mixed.totals.bag.units === 4, 'and all four teams still count as work done')
ok(IMPLAUSIBLE_SECONDS === 8 * 60 * 60, 'the cap is eight hours')

// ---------------------------------------------------------------------------
console.log('\n=== 3. an interval belongs to whoever ended it ===')
// ---------------------------------------------------------------------------
// One break: Nova sleeves it, Pip sorts it, Rio bags the last team and closes
// it. Three people, one break, and nobody's figure includes anybody else's.
const shared = run([
  ev({
    kind: 'sleeve',
    employeeId: NOVA,
    breakId: 'break_11a',
    subjectId: 'break_11a',
    startedAt: '2026-03-10T19:00:00.000Z',
    finishedAt: '2026-03-10T19:30:00.000Z',
    startBasis: 'first-card',
    units: 30
  }),
  ev({
    kind: 'sort',
    employeeId: PIP,
    breakId: 'break_11a',
    subjectId: 'break_11a',
    startedAt: '2026-03-10T19:30:00.000Z',
    finishedAt: '2026-03-10T19:50:00.000Z',
    startBasis: 'prev-step',
    units: 30
  }),
  ev({
    kind: 'bag',
    employeeId: RIO,
    breakId: 'break_11a',
    startedAt: '2026-03-10T19:50:00.000Z',
    finishedAt: '2026-03-10T19:52:00.000Z',
    startBasis: 'prev-step'
  }),
  ev({
    kind: 'break_done',
    employeeId: RIO,
    breakId: 'break_11a',
    subjectId: 'break_11a',
    startedAt: '2026-03-10T19:00:00.000Z',
    finishedAt: '2026-03-10T19:52:00.000Z',
    startBasis: 'prev-step',
    units: 30
  })
])
const byName = (n: string): any => shared.people.find((p: any) => p.name === n)
ok(byName('Nova Arkwright').steps.sleeve.avgSeconds === 1800, 'the sleeve interval is Nova only')
ok(byName('Nova Arkwright').steps.sort.samples === 0, 'and Nova has no sort figure at all')
ok(byName('Pip Dalgleish').steps.sort.avgSeconds === 1200, 'the sort interval is Pip only')
ok(byName('Rio Castellan').steps.bag.avgSeconds === 120, 'the bag interval is Rio only')
ok(shared.sharedBreaks === 1, 'and the break is reported as having several names on it')

// break_done is a marker, not a sixth step: its 52-minute span must never land
// in a step bucket, or the whole break would be counted twice.
ok(
  PERF_STEPS.every((s: string) => shared.totals[s].samples <= 1),
  'break_done adds no duration to any step'
)
ok(shared.breaksDone === 1, 'but it is what "breaks done" counts')
ok(shared.breaksWorked === 1, 'and the break shows as worked')

// ---------------------------------------------------------------------------
console.log('\n=== 4. nobody is dropped or merged ===')
// ---------------------------------------------------------------------------
const anon = run([
  ev({
    kind: 'sort',
    employeeId: NOVA,
    breakId: 'break_3',
    startedAt: '2026-03-10T19:00:00.000Z',
    finishedAt: '2026-03-10T19:10:00.000Z',
    startBasis: 'prev-step'
  }),
  ev({
    kind: 'sort',
    employeeId: null,
    breakId: 'break_4',
    startedAt: '2026-03-10T19:00:00.000Z',
    finishedAt: '2026-03-10T19:40:00.000Z',
    startBasis: 'prev-step'
  })
])
ok(anon.people.length === 2, 'an unnamed stamp gets its own row rather than being dropped')
ok(anon.people[anon.people.length - 1].employeeId === null, 'and it sorts last, after the people')
ok(
  anon.people.find((p: any) => p.employeeId === NOVA).steps.sort.avgSeconds === 600,
  "Nova's figure is untouched by it"
)
ok(anon.unattributedEvents === 1, 'and the screen is told how many there were')
ok(anon.totals.sort.samples === 2, 'while the floor total still includes both')

// A stamp naming somebody who is no longer on the roster is NOT the same thing
// as a stamp naming nobody. Folding the two together would quietly credit a
// departed packer's night to the row that means "we do not know who".
const ghost = run([
  ev({ kind: 'pack', employeeId: 'emp_marlowe_ashgrove_left_in_may' }),
  ev({ kind: 'pack', employeeId: null })
])
ok(ghost.people.length === 2, 'an id that resolves to nobody keeps its own row')
ok(ghost.unattributedEvents === 1, 'and is not counted as an unattributed tick')
ok(
  ghost.people.filter((p: any) => p.name === 'Not attributed').length === 1,
  'only the genuinely nameless row is labelled as such'
)

// ---------------------------------------------------------------------------
console.log('\n=== 5. days are local, stamps are UTC ===')
// ---------------------------------------------------------------------------
// 02:00Z on the 11th is 21:00 on the 10th at UTC-05:00 — a Tuesday evening at
// the bench. Bucketing by the ISO prefix would file it under Wednesday.
const lateNight = ev({
  kind: 'pack',
  employeeId: NOVA,
  startedAt: '2026-03-11T01:40:00.000Z',
  finishedAt: '2026-03-11T02:00:00.000Z',
  startBasis: 'claim'
})
ok(run([lateNight], '2026-03-10', '2026-03-10').totals.pack.samples === 1,
  'a 9pm local tick belongs to the local day, not the UTC one')
ok(run([lateNight], '2026-03-11', '2026-03-11').empty === true,
  'and does NOT belong to the next day')

// An interval that crosses local midnight counts on the day it FINISHED, and
// the fact that it spanned is reported rather than hidden.
const overMidnight = ev({
  kind: 'ship',
  employeeId: PIP,
  // 22:30 local on the 10th -> 00:30 local on the 11th.
  startedAt: '2026-03-11T03:30:00.000Z',
  finishedAt: '2026-03-11T05:30:00.000Z',
  startBasis: 'packed'
})
const spanning = run([overMidnight], '2026-03-11', '2026-03-11')
ok(spanning.totals.ship.samples === 1, 'an interval across midnight lands on its finishing day')
ok(spanning.spanningEvents === 1, 'and is reported as having started on an earlier day')
ok(run([overMidnight], '2026-03-10', '2026-03-10').empty === true,
  'it is not also counted on the day it started')

// The UTC window a run of local days occupies is half-open: an event at
// 23:59:59.999 on the last day is in, and 00:00:00.000 the next morning is out.
const win = utcWindowForDays('2026-03-10', '2026-03-12')
ok(win.startIso < win.endIso, 'the window runs forwards')
ok(
  Math.round((Date.parse(win.endIso) - Date.parse(win.startIso)) / 3_600_000) >= 71,
  'and covers three local days',
  `${win.startIso} .. ${win.endIso}`
)

// The UTC-noon rule for day arithmetic. 8 March 2026 is a US spring-forward
// date; parsed at local midnight and shifted, this lands on the wrong day.
ok(addDayKey('2026-03-07', 1) === '2026-03-08', 'day arithmetic crosses a DST boundary intact')
ok(addDayKey('2026-03-08', 1) === '2026-03-09', 'and the day after it')
ok(addDayKey('2026-11-01', -1) === '2026-10-31', 'and back across the autumn one')
ok(daysBetweenKeys('2026-03-07', '2026-03-09') === 2, 'and the span across it is two days')
ok(addDayKey('2026-12-31', 1) === '2027-01-01', 'and a year boundary')
// THE ONE THAT CATCHES A LOCAL-MIDNIGHT PARSE. In London this date is UTC+1, so
// midnight local is 23:00 the previous day in UTC and the shifted result lands
// back on the day it started. Noon is twelve hours from either edge and cannot.
ok(addDayKey('2026-07-01', 1) === '2026-07-02', 'and a day east of Greenwich in summer')
ok(addDayKey('2026-07-31', 1) === '2026-08-01', 'and a month boundary inside it')
const swapped = orderDays('2026-03-12', '2026-03-10')
ok(swapped.from === '2026-03-10' && swapped.to === '2026-03-12', 'a reversed range is ordered')
ok(
  run([ev({ kind: 'pack', employeeId: NOVA })], '2026-03-12', '2026-03-01').from === '2026-03-01',
  'and a reversed range still reports on the right days'
)

// ---------------------------------------------------------------------------
console.log('\n=== 6. the total is not an average of averages ===')
// ---------------------------------------------------------------------------
// Nova bags one team slowly; Pip bags nine quickly. The floor average must be
// weighted by teams, not by people.
const weighted = run([
  ev({
    kind: 'bag',
    employeeId: NOVA,
    breakId: 'break_5',
    startedAt: '2026-03-10T19:00:00.000Z',
    finishedAt: '2026-03-10T19:10:00.000Z',
    startBasis: 'prev-tick'
  }),
  ...Array.from({ length: 9 }, () =>
    ev({
      kind: 'bag',
      employeeId: PIP,
      breakId: 'break_5',
      startedAt: '2026-03-10T19:00:00.000Z',
      finishedAt: '2026-03-10T19:01:00.000Z',
      startBasis: 'prev-tick'
    })
  )
])
// (600 + 9*60) / 10 = 114. An average of the two people's averages would be 330.
ok(weighted.totals.bag.avgSeconds === 114, 'the floor average is weighted by work, not by person',
  String(weighted.totals.bag.avgSeconds))
// The median is why it is printed beside the average: nine of ten took a minute.
ok(weighted.totals.bag.medianSeconds === 60, 'and the median resists the one long tail')

// ---------------------------------------------------------------------------
console.log('\n=== 7. the counts the owner asked for ===')
// ---------------------------------------------------------------------------
const counts = run([
  ev({ kind: 'break_done', breakId: 'break_1', subjectId: 'break_1', employeeId: NOVA }),
  ev({ kind: 'break_done', breakId: 'break_2', subjectId: 'break_2', employeeId: NOVA }),
  // The same break closed twice — a correction, not a second break.
  ev({ kind: 'break_done', breakId: 'break_2', subjectId: 'break_2', employeeId: PIP }),
  // Worked but never finished: sleeved and sorted, no bag tick.
  ev({ kind: 'sleeve', breakId: 'break_9', subjectId: 'break_9', employeeId: PIP }),
  ev({ kind: 'sort', breakId: 'break_9', subjectId: 'break_9', employeeId: PIP }),
  ev({ kind: 'pack', subjectId: 'ship_wildoak', employeeId: RIO }),
  ev({ kind: 'pack', subjectId: 'ship_wildoak', employeeId: RIO }),
  ev({ kind: 'pack', subjectId: 'ship_penhallow', employeeId: RIO }),
  ev({ kind: 'ship', subjectId: 'ship_wildoak', employeeId: RIO })
])
ok(counts.breaksDone === 2, 'a break closed twice counts once', String(counts.breaksDone))
ok(counts.breaksWorked === 1, 'breaks worked counts only ones with bench ticks in the range',
  String(counts.breaksWorked))
ok(counts.packagesPacked === 2, 'packages packed is distinct packages', String(counts.packagesPacked))
ok(counts.packagesShipped === 1, 'and packages shipped likewise')
ok(counts.breaksMissingStep.bag === 1, 'a break with no bag tick at all is reported as missing one')
ok(counts.breaksMissingStep.sleeve === 0, 'and one that was sleeved is not')

// ---------------------------------------------------------------------------
console.log('\n=== 8. clocked-in time is context, never a denominator ===')
// ---------------------------------------------------------------------------
const clocked = summariseShipping({
  events: [ev({ kind: 'pack', employeeId: NOVA }), ev({ kind: 'pack', employeeId: PIP })],
  from: '2026-03-10',
  to: '2026-03-10',
  nameOf,
  dayKeyOf,
  clockedMinutes: new Map([[NOVA, 245]])
})
ok(
  clocked.people.find((p: any) => p.employeeId === NOVA).clockedMinutes === 245,
  'a punch-clock total is carried through'
)
ok(
  clocked.people.find((p: any) => p.employeeId === PIP).clockedMinutes === null,
  'and somebody with no entries reads as unknown, not as zero hours'
)

// ---------------------------------------------------------------------------
console.log('\n=== 9. what the screen prints ===')
// ---------------------------------------------------------------------------
ok(minutesLabel(null) === '—', 'an absent duration prints as a dash, never a zero')
ok(minutesLabel(undefined) === '—', 'and so does an undefined one')
ok(minutesLabel(0) === '0s', 'a genuine zero still prints as a zero')
ok(minutesLabel(45) === '45s', 'under a minute reads in seconds')
ok(minutesLabel(270) === '4.5 min', 'and above it in minutes to a tenth')
ok(minutesLabel(9000) === '2h 30m', 'and above an hour in hours and minutes')
ok(perfStep('bag').n === 3, 'the steps keep the bench checklist numbering')
ok(perfStep('ship').measures.length > 20, 'and every step states its two endpoints on screen')
ok(
  PERF_STEPS.join(',') === 'sleeve,sort,bag,pack,ship',
  'the five steps are the five the owner named'
)

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
