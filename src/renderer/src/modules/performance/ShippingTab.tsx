import { useCallback, useEffect, useState } from 'react'
import type { EmployeePerf, PerfStepId, ShippingPerformanceView, StepStat } from '@shared/performance'
import { PERF_STEPS, minutesLabel, perfStep } from '@shared/performance'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'
import { RANGE_PRESETS, activeGrain, rangeLabel, rangeOf, todayKey, type DayRange } from './range'

/**
 * The shipping floor, over a range: what got done, and how long each step took.
 *
 * ## The one thing this screen must never do
 *
 * Print a number it cannot support. Every duration here is DERIVED from two
 * completion stamps — the floor records when work finished, never when it
 * started — so a step with no earlier stamp to measure from has no duration at
 * all. Those show as an em dash and are counted separately in their own column,
 * because "we timed nine of these" and "we timed one of these and guessed the
 * rest" are different statements and an average alone cannot tell them apart.
 * The per-break P&L makes the same refusal about a missing cost, for the same
 * reason: a plausible-looking zero flatters exactly the row that has a problem.
 *
 * ## Why the definitions are on screen
 *
 * Each step's two endpoints and its specific way of misleading are printed
 * under it, verbatim from @shared/performance. A reporting screen whose column
 * headings paraphrase what the code measured is how a figure gets quoted in a
 * conversation it does not support.
 */
export function ShippingTab(): JSX.Element {
  const [range, setRange] = useState<DayRange>(() => RANGE_PRESETS[1].build())
  const [view, setView] = useState<ShippingPerformanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [denied, setDenied] = useState(false)

  const load = useCallback(async (r: DayRange) => {
    setLoading(true)
    try {
      const res = await api.performance.shipping(r.from, r.to)
      // Null is the permission answer, not an error. Kept apart from an empty
      // range so the screen can say "you may not see this" rather than "nobody
      // worked", which are opposite statements.
      setDenied(res === null)
      setView(res)
    } catch {
      setDenied(false)
      setView(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(range)
  }, [load, range])

  const grain = activeGrain(range)

  return (
    <div className="perf">
      <div className="perf-rangebar" role="group" aria-label="Reporting period">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`perf-range-btn${grain === p.key ? ' is-on' : ''}`}
            aria-pressed={grain === p.key}
            title={p.hint}
            onClick={() => setRange(p.build())}
          >
            {p.label}
          </button>
        ))}
        <label className="perf-range-dates">
          <span className="perf-sr">From</span>
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange(rangeOf(e.target.value, range.to))}
          />
          <span aria-hidden="true">–</span>
          <span className="perf-sr">To</span>
          <input
            type="date"
            value={range.to}
            min={range.from}
            max={todayKey()}
            onChange={(e) => e.target.value && setRange(rangeOf(range.from, e.target.value))}
          />
        </label>
        <span className="perf-range-now">
          <Icon name="CalendarRange" size={13} />
          {rangeLabel(range)}
          {grain === 'custom' && <em>custom</em>}
        </span>
      </div>

      {loading ? (
        <CenterLoader />
      ) : denied ? (
        <EmptyState
          icon="ShieldCheck"
          title="Not your report"
          message="Performance is limited to the accounts that can already see the timesheets."
        />
      ) : !view ? (
        <EmptyState
          icon="AlertCircle"
          title="Could not read the work log"
          message="Pick a range again, or reopen the module."
        />
      ) : (
        <Report view={view} />
      )}
    </div>
  )
}

function Report({ view }: { view: ShippingPerformanceView }): JSX.Element {
  return (
    <>
      <div className="perf-tiles">
        <Tile
          icon="Layers"
          label="Breaks done"
          value={view.breaksDone}
          detail={
            view.breaksWorked > view.breaksDone
              ? `${view.breaksWorked} had bench work — ${view.breaksWorked - view.breaksDone} not finished in this range`
              : 'Sleeved, sorted and every team bagged'
          }
        />
        <Tile
          icon="PackageCheck"
          label="Packages packed"
          value={view.packagesPacked}
          detail="Marked packed by somebody at a bench"
        />
        <Tile
          icon="Truck"
          label="Packages shipped"
          value={view.packagesShipped}
          detail="Moved to shipped or delivered BY A PERSON. The carrier's own scans are not counted here — their timestamp is when this app read the tracking page, not when a box was handed over."
        />
      </div>

      {view.empty && <EmptyRangeNote view={view} />}

      {!view.empty && (
        <>
          <StepLegend totals={view.totals} />
          <PeopleTable people={view.people} />
          <Caveats view={view} />
        </>
      )}
    </>
  )
}

/**
 * Nothing in the range — and the two reasons for that are not the same.
 *
 * A quiet week and a week before the app was recording look identical in the
 * data and completely different to whoever is reading. `loggedFrom` is the only
 * thing that can separate them, so it is what this panel is built around.
 */
function EmptyRangeNote({ view }: { view: ShippingPerformanceView }): JSX.Element {
  const startedAfter = !!view.loggedFrom && view.loggedFrom.slice(0, 10) > view.to
  const neverLogged = !view.loggedFrom
  return (
    <EmptyState
      icon="Timer"
      title="No work recorded in this range"
      message={
        neverLogged
          ? 'Nothing has been recorded on this machine yet. The log starts filling the first time somebody ticks a step on the bench or packs an order.'
          : startedAfter
            ? `Work has only been recorded since ${view.loggedFrom?.slice(0, 10)}. Anything before that was on a show that has since been overwritten, and it cannot be recovered.`
            : 'The bench recorded nothing between these dates.'
      }
    />
  )
}

function Tile({
  icon,
  label,
  value,
  detail
}: {
  icon: string
  label: string
  value: number
  detail: string
}): JSX.Element {
  return (
    <div className="perf-tile">
      <div className="perf-tile-head">
        <Icon name={icon} size={15} />
        {label}
      </div>
      <div className="perf-tile-value">{value}</div>
      <p className="perf-tile-detail">{detail}</p>
    </div>
  )
}

/**
 * The five steps, what each one measures, and everybody's figures together.
 *
 * The whole-floor row is computed over every event rather than by averaging the
 * people rows — an average of averages weights a person who did three teams the
 * same as one who did ninety.
 */
function StepLegend({ totals }: { totals: Record<PerfStepId, StepStat> }): JSX.Element {
  return (
    <div className="perf-steps">
      {PERF_STEPS.map((id) => {
        const def = perfStep(id)
        const stat = totals[id]
        return (
          <div className="perf-step" key={id}>
            <div className="perf-step-head">
              <span className="perf-step-n">{def.n}</span>
              <strong>{def.label}</strong>
            </div>
            <div className="perf-step-figs">
              <span className="perf-step-avg">{minutesLabel(stat.avgSeconds)}</span>
              <span className="perf-step-sub">
                avg · median {minutesLabel(stat.medianSeconds)}
              </span>
            </div>
            <div className="perf-step-counts">
              <span>{stat.samples} timed</span>
              {stat.unknown > 0 && <span className="warn">{stat.unknown} not timeable</span>}
              {stat.implausible > 0 && (
                <span
                  className="warn"
                  title="Longer than eight hours or ending before it started — left out of the average rather than dragging it."
                >
                  {stat.implausible} excluded
                </span>
              )}
            </div>
            <p className="perf-step-measures">
              <Icon name="ArrowRight" size={11} /> {def.measures}
            </p>
            <p className="perf-step-caveat">{def.caveat}</p>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Per person, per step.
 *
 * Each interval belongs to WHOEVER ENDED IT. A break really is worked by
 * several people, and no record anywhere says how they divided it, so any rule
 * that split an interval between them would be inventing a fact. The person on
 * the closing stamp gets the whole of it — honest about who finished, silent
 * about who helped — and the note under the table says so.
 */
function PeopleTable({ people }: { people: EmployeePerf[] }): JSX.Element {
  return (
    <div className="perf-tablewrap">
      <table className="perf-table">
        <thead>
          <tr>
            <th>Person</th>
            {PERF_STEPS.map((id) => (
              <th className="num" key={id} title={perfStep(id).measures}>
                {perfStep(id).label}
              </th>
            ))}
            <th className="num">Clocked in</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.employeeId ?? 'unattributed'} className={p.employeeId ? '' : 'unattributed'}>
              <td>
                <span className="perf-name">{p.name}</span>
                <span className="perf-events">{p.events} ticks</span>
              </td>
              {PERF_STEPS.map((id) => (
                <Cell key={id} stat={p.steps[id]} />
              ))}
              <td className="num">
                {p.clockedMinutes === null ? (
                  <span className="perf-unknown" title="No time-clock entries overlap this range.">
                    —
                  </span>
                ) : (
                  minutesLabel(p.clockedMinutes * 60)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * One person's figure for one step.
 *
 * A step they never touched is blank. A step they touched but that could not be
 * timed shows the count and a dash — never a zero, which on a column of minutes
 * reads as "instant" and is the single most misleading thing this screen could
 * print.
 */
function Cell({ stat }: { stat: StepStat }): JSX.Element {
  const touched = stat.samples + stat.unknown + stat.implausible
  if (touched === 0) return <td className="num perf-none">·</td>
  return (
    <td className="num">
      <span className="perf-avg">{minutesLabel(stat.avgSeconds)}</span>
      <span className="perf-units">
        {stat.units} {stat.units === 1 ? 'unit' : 'units'}
        {stat.unknown > 0 && (
          <em title="No earlier stamp exists to measure these from, so they have no duration at all.">
            {' '}
            · {stat.unknown} untimed
          </em>
        )}
      </span>
    </td>
  )
}

/** The things a reader has to know before quoting any of the above. */
function Caveats({ view }: { view: ShippingPerformanceView }): JSX.Element {
  return (
    <div className="perf-caveats">
      <p>
        <Icon name="Info" size={13} />
        <span>
          Every figure is the gap between two completion stamps. The floor records
          when work FINISHED, never when it started, so a duration is always
          elapsed time between two ticks — waiting, talking and walking included —
          except step 4, which measures from a real pack-station claim.
        </span>
      </p>
      <p>
        <Icon name="Users" size={13} />
        <span>
          An interval belongs to whoever ENDED it. Nothing records how two people
          sharing a break divided it.
          {view.sharedBreaks > 0
            ? ` ${view.sharedBreaks} ${view.sharedBreaks === 1 ? 'break' : 'breaks'} in this range had more than one name on ${view.sharedBreaks === 1 ? 'it' : 'them'}.`
            : ''}
        </span>
      </p>
      {view.unattributedEvents > 0 && (
        <p>
          <Icon name="UserMinus" size={13} />
          <span>
            {view.unattributedEvents} {view.unattributedEvents === 1 ? 'tick' : 'ticks'} carry
            nobody&rsquo;s name and are collected on their own row rather than being
            dropped or folded into somebody else&rsquo;s.
          </span>
        </p>
      )}
      {(view.breaksMissingStep.sleeve > 0 ||
        view.breaksMissingStep.sort > 0 ||
        view.breaksMissingStep.bag > 0) && (
        <p>
          <Icon name="AlertCircle" size={13} />
          <span>
            Breaks with bench work but no tick at all for a step:{' '}
            {(['sleeve', 'sort', 'bag'] as const)
              .filter((s) => view.breaksMissingStep[s] > 0)
              .map((s) => `${perfStep(s).label.toLowerCase()} ${view.breaksMissingStep[s]}`)
              .join(', ')}
            . Those steps are missing from the record, not measured as zero.
          </span>
        </p>
      )}
      {view.spanningEvents > 0 && (
        <p>
          <Icon name="CalendarClock" size={13} />
          <span>
            {view.spanningEvents} {view.spanningEvents === 1 ? 'interval' : 'intervals'} started on
            an earlier day than they finished. They count on the day they FINISHED,
            which is the day the person doing them would say they did them.
          </span>
        </p>
      )}
      <p>
        <Icon name="Clock" size={13} />
        <span>
          Clocked-in time is shown for context only. It is never divided into a step
          timing — a punch clock measures presence and a tick measures a gap between
          two clicks, and a ratio of the two would be supported by neither.
        </span>
      </p>
    </div>
  )
}
