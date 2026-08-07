import { useEffect, useMemo, useState } from 'react'
import type { AvailabilityPattern, AvailabilityStatus, PatternDayInput } from '@shared/schedule'
import { AVAILABILITY_NOTE_MAX, WEEKDAY_NAMES, patternSummary } from '@shared/schedule'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/ui'
import { useToast } from '../../components/Toast'

/**
 * Your usual week — set once, and after that only the days that differ.
 *
 * ## Why this is the primary control and the calendar is not
 *
 * Nobody thinks about their availability one date at a time. They think "I work
 * Mondays, Wednesdays and Fridays, and I have class on Tuesday" — a shape that
 * repeats — and asking somebody to express that by tapping thirty squares a
 * month is asking them to do arithmetic on their own routine. They would do it
 * once and never again, which is the same as not having the feature.
 *
 * So this is seven rows and one Save, and the calendar underneath becomes what
 * it should always have been: the place you record an EXCEPTION. "I normally do
 * Thursdays, but not this Thursday."
 *
 * ## Three positions per day, not a checkbox
 *
 * Can work / cannot work / nothing said. A two-position control would force
 * silence into one of the two answers, and both readings are wrong: as "cannot"
 * nobody gets rostered until they opt in; as "can" nobody's day off is ever
 * respected. So the middle position exists and is the default.
 *
 * ## Local until Save
 *
 * The whole week is edited in local state and written in one call. Saving each
 * toggle as you press it would mean a dropped connection could leave Monday
 * saved and Wednesday not — a half-written week that reads as a real answer, and
 * the sort of thing a lead would roster against without knowing.
 */

interface DayDraft {
  status: AvailabilityStatus | null
  startTime: string
  endTime: string
  note: string
}

const EMPTY: DayDraft = { status: null, startTime: '', endTime: '', note: '' }

function draftsFrom(pattern: AvailabilityPattern[]): DayDraft[] {
  const out: DayDraft[] = Array.from({ length: 7 }, () => ({ ...EMPTY }))
  for (const p of pattern) {
    if (p.weekday < 0 || p.weekday > 6) continue
    out[p.weekday] = {
      status: p.status,
      startTime: p.startTime ?? '',
      endTime: p.endTime ?? '',
      note: p.note ?? ''
    }
  }
  return out
}

function sameWeek(a: DayDraft[], b: DayDraft[]): boolean {
  return a.every(
    (d, i) =>
      d.status === b[i].status &&
      d.startTime === b[i].startTime &&
      d.endTime === b[i].endTime &&
      d.note === b[i].note
  )
}

export function UsualWeek({
  pattern,
  onSaved
}: {
  pattern: AvailabilityPattern[]
  onSaved: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const saved = useMemo(() => draftsFrom(pattern), [pattern])
  const [draft, setDraft] = useState<DayDraft[]>(saved)
  const [open, setOpen] = useState(() => pattern.length === 0)
  const [busy, setBusy] = useState(false)

  // A week set on another machine — or by this person on their phone — has to
  // land here rather than being quietly overwritten by a stale local draft.
  // Only when there is nothing half-typed: clobbering somebody mid-edit would be
  // worse than showing them a week that is one sync behind.
  useEffect(() => {
    setDraft((current) => (sameWeek(current, saved) ? current : saved))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern])

  const dirty = !sameWeek(draft, saved)

  const set = (weekday: number, patch: Partial<DayDraft>): void => {
    setDraft((d) => d.map((day, i) => (i === weekday ? { ...day, ...patch } : day)))
  }

  const cycle = (weekday: number, next: AvailabilityStatus): void => {
    // Pressing the position you are already on returns to "nothing said", which
    // is what makes the third state reachable without a third button.
    const current = draft[weekday].status
    set(weekday, { status: current === next ? null : next })
  }

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const days: PatternDayInput[] = draft.map((d, weekday) => ({
        weekday,
        status: d.status,
        // Times only mean anything on a day somebody CAN work. Sending them with
        // a "cannot" would store a contradiction that some later screen has to
        // decide how to read.
        startTime: d.status === 'available' ? d.startTime : null,
        endTime: d.status === 'available' ? d.endTime : null,
        note: d.note
      }))
      const res = await api.staff.setPattern(days)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not save your week.')
        return
      }
      toast.success('Saved your usual week.')
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  const clearAll = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const res = await api.staff.clearPattern()
      if (!res.ok) {
        toast.error(res.error ?? 'Could not clear that.')
        return
      }
      await onSaved()
      toast.success('Cleared your usual week.')
    } finally {
      setBusy(false)
    }
  }

  const freeDays = draft.filter((d) => d.status === 'available').length

  return (
    <div className="panel-card usual-week">
      <div className="panel-head" onClick={() => setOpen((v) => !v)} style={{ cursor: 'pointer' }}>
        <h3>Your usual week</h3>
        <span className="ph-sub">
          {pattern.length === 0 ? 'Not set yet' : patternSummary(pattern)}
        </span>
        <button className="uw-toggle" aria-label={open ? 'Collapse' : 'Expand'}>
          <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={16} />
        </button>
      </div>

      {!open ? (
        <p className="uw-collapsed">
          {pattern.length === 0
            ? 'Set the days you normally can and cannot work — then you only have to touch the days that are different.'
            : 'Applies to every week from now on. Change a single date on the calendar below when one week is different.'}
        </p>
      ) : (
        <>
          <p className="uw-intro">
            Set the days you normally can and cannot work. This applies to every week
            from now on — you only have to touch the calendar below when one week is
            different.
          </p>

          <div className="uw-grid">
            {WEEKDAY_NAMES.map((name, weekday) => {
              const d = draft[weekday]
              return (
                <div className="uw-row" key={name} data-status={d.status ?? 'none'}>
                  <span className="uw-day">{name}</span>

                  <div className="uw-choice">
                    <button
                      className={`uw-opt ${d.status === 'available' ? 'on' : ''}`}
                      data-kind="available"
                      onClick={() => cycle(weekday, 'available')}
                      title={
                        d.status === 'available'
                          ? `Press again to say nothing about ${name}s`
                          : `I can normally work ${name}s`
                      }
                    >
                      <Icon name="Check" size={14} strokeWidth={3} />
                      Can work
                    </button>
                    <button
                      className={`uw-opt ${d.status === 'unavailable' ? 'on' : ''}`}
                      data-kind="unavailable"
                      onClick={() => cycle(weekday, 'unavailable')}
                      title={
                        d.status === 'unavailable'
                          ? `Press again to say nothing about ${name}s`
                          : `I cannot normally work ${name}s`
                      }
                    >
                      <Icon name="Ban" size={14} strokeWidth={3} />
                      Cannot
                    </button>
                  </div>

                  {/* Times only on a day somebody can work — an "until" on a day
                      they cannot is a contradiction, not extra detail. */}
                  {d.status === 'available' ? (
                    <div className="uw-times">
                      <input
                        type="time"
                        value={d.startTime}
                        aria-label={`${name} from`}
                        onChange={(e) => set(weekday, { startTime: e.target.value })}
                      />
                      <span>–</span>
                      <input
                        type="time"
                        value={d.endTime}
                        aria-label={`${name} until`}
                        onChange={(e) => set(weekday, { endTime: e.target.value })}
                      />
                    </div>
                  ) : (
                    <div className="uw-times uw-times-empty">
                      {d.status === 'unavailable' ? 'Not available' : 'Nothing said'}
                    </div>
                  )}

                  <input
                    className="uw-note"
                    value={d.note}
                    maxLength={AVAILABILITY_NOTE_MAX}
                    placeholder={
                      d.status === 'unavailable' ? 'Reason (optional)' : 'Note (optional)'
                    }
                    onChange={(e) => set(weekday, { note: e.target.value })}
                  />
                </div>
              )
            })}
          </div>

          <div className="uw-foot">
            <span className="uw-count">
              {freeDays === 0
                ? 'No days marked as workable yet.'
                : `${freeDays} day${freeDays === 1 ? '' : 's'} a week you can work.`}
            </span>
            {pattern.length > 0 && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void clearAll()}>
                Clear week
              </Button>
            )}
            {dirty && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDraft(saved)}>
                Undo
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              icon="Check"
              loading={busy}
              disabled={!dirty}
              onClick={() => void save()}
            >
              {dirty ? 'Save week' : 'Saved'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
