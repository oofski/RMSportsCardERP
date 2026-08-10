import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Employee } from '@shared/types'
import type { ScheduledStream } from '@shared/streamReminders'
import { SCHEDULED_NOTE_MAX, SCHEDULED_TITLE_MAX } from '@shared/streamReminders'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { resultError, scheduleReady, streamPlans } from './api'
import { isoFromLocalParts, shortDayLabel, timeLabel, todayKey } from './time'

/**
 * The diary: shows that have not happened yet.
 *
 * This exists because the reminders do. An hour before a planned stream, and
 * again a quarter of an hour before, every admin's phone (and the host's) is
 * told to go and start it — and none of that can happen unless somebody can
 * write down that there IS a stream on Friday. Until this, nothing in the app
 * could record that.
 *
 * ## The one thing to understand before editing this file
 *
 * A planned show is a WALL-CLOCK fact: a local day and a local HH:MM, "9:00 PM
 * on Friday", which stays 9:00 PM across a daylight-saving boundary. The
 * reminders are INSTANTS: "one hour before" is a moment the relay compares its
 * own clock against.
 *
 * The conversion between the two happens HERE, exactly once, in the browser —
 * because the browser is the only party in the chain that knows what timezone
 * the person typing "9:00 PM" is standing in. Main may be a server in another
 * zone in the web build, and the Cloudflare Worker that sends the reminders runs
 * in UTC and has no idea at all. `isoFromLocalParts` does it, and the answer
 * travels beside the wall clock as `startsAt`. Nothing downstream re-derives it.
 *
 * Get that wrong and every reminder arrives four or five hours out — and it
 * looks like the notification system is broken rather than a date conversion.
 */

/** Local "9:00 PM · Fri 21 Aug" for a plan, from the instant it resolved to. */
function planWhen(plan: ScheduledStream): string {
  return `${timeLabel(plan.startsAt)} · ${shortDayLabel(plan.streamDate)}`
}

/** "in 2 days" / "in 3 hours" / "in 40 minutes" / "now". */
function untilLabel(startsAt: string, nowMs: number): string {
  const at = Date.parse(startsAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.round((at - nowMs) / 60_000)
  if (minutes <= 0) return 'due now'
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'in about an hour' : `in about ${hours} hours`
  const days = Math.round(hours / 24)
  return days === 1 ? 'tomorrow' : `in ${days} days`
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

/**
 * What is coming up, and the buttons for it.
 *
 * Sits under the live bar because it answers the same question from the other
 * side: the bar says what is on air, this says what is not on air yet. Hidden
 * entirely when there is nothing scheduled AND the viewer cannot schedule
 * anything — an empty box offering an action nobody may take is furniture.
 */
export function ScheduledStrip({
  version,
  canManage,
  hosts,
  onChanged,
  onOpenSession
}: {
  version: number
  canManage: boolean
  hosts: Employee[]
  onChanged: () => void | Promise<void>
  onOpenSession: (id: string) => void
}): JSX.Element | null {
  const toast = useToast()
  const [plans, setPlans] = useState<ScheduledStream[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ScheduledStream | null>(null)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Re-read the clock every half minute so "in 40 min" does not sit there
  // saying 40 while the show gets closer. Cheap, and this strip is the one
  // place in the module where a stale relative time is actively misleading.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const reload = useCallback(async () => {
    if (!scheduleReady) {
      setLoading(false)
      return
    }
    try {
      setPlans(await streamPlans.upcoming())
    } catch {
      // The strip is a convenience beside the live bar, not the module. A failed
      // read leaves it empty rather than taking the streaming screen down.
      setPlans([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, version])

  const refresh = useCallback(async () => {
    await reload()
    await onChanged()
  }, [reload, onChanged])

  const startNow = async (plan: ScheduledStream): Promise<void> => {
    setBusyId(plan.id)
    try {
      const res = await streamPlans.start(plan.id)
      if (!res.ok || !res.data) {
        // "A stream is already live", "that overlaps ..." — the refusals that
        // come back from here are the useful ones and are shown verbatim.
        toast.error(resultError(res, 'Could not start that stream.'))
        return
      }
      toast.success('Stream started.')
      await refresh()
      onOpenSession(res.data.sessionId)
    } finally {
      setBusyId(null)
    }
  }

  const cancel = async (plan: ScheduledStream): Promise<void> => {
    setBusyId(plan.id)
    try {
      const res = await streamPlans.cancel(plan.id)
      if (!res.ok) {
        toast.error(resultError(res, 'Could not cancel that stream.'))
        return
      }
      // Said out loud, because the thing that stops is invisible: what a cancel
      // really does is call off two notifications nobody has received yet.
      toast.success('Cancelled — no reminders will go out for it.')
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (!scheduleReady) return null
  if (loading) return null
  if (plans.length === 0 && !canManage) return null

  return (
    <div className="stm-sched">
      <div className="stm-sched-head">
        <span className="stm-sched-label">
          <Icon name="CalendarClock" size={15} />
          Scheduled
        </span>
        {plans.length > 0 && (
          <span className="stm-sched-hint">
            Everyone with Admin access — and the host — gets a reminder an hour before and again
            fifteen minutes before.
          </span>
        )}
        {canManage && (
          <Button size="sm" icon="Plus" onClick={() => setAdding(true)}>
            Schedule a stream
          </Button>
        )}
      </div>

      {plans.length === 0 ? (
        <div className="stm-sched-empty">
          <Icon name="Moon" size={14} />
          Nothing scheduled. A stream put in here reminds the team before it starts.
        </div>
      ) : (
        <ul className="stm-sched-list">
          {plans.map((plan) => (
            <li className="stm-sched-row" key={plan.id}>
              <span className="stm-sched-when mono">{planWhen(plan)}</span>
              <span className="stm-sched-title">{plan.title || 'Untitled stream'}</span>
              {plan.hostName && (
                <span className="stm-sched-host">
                  <Icon name="User" size={12} />
                  {plan.hostName}
                </span>
              )}
              <span className="stm-sched-until">{untilLabel(plan.startsAt, now)}</span>
              {canManage && (
                <span className="stm-sched-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    icon="Play"
                    loading={busyId === plan.id}
                    onClick={() => void startNow(plan)}
                  >
                    Start now
                  </Button>
                  <Button size="sm" icon="Pencil" onClick={() => setEditing(plan)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" icon="X" onClick={() => void cancel(plan)}>
                    Cancel
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {(adding || editing) && (
        <ScheduleStreamModal
          plan={editing ?? undefined}
          hosts={hosts}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSaved={async () => {
            setAdding(false)
            setEditing(null)
            await refresh()
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * Put a show in the diary, or move one.
 *
 * A date and a time, typed the way somebody says them, converted to an instant
 * here — see the note at the top of this file for why here and nowhere else.
 * There is no end time: a plan is a start, and a show's length is a thing that
 * turns out to be true rather than a thing anybody schedules.
 */
export function ScheduleStreamModal({
  plan,
  hosts,
  onClose,
  onSaved
}: {
  plan?: ScheduledStream
  hosts: Employee[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const editing = !!plan

  const [date, setDate] = useState(() => plan?.streamDate ?? todayKey())
  const [time, setTime] = useState(() => plan?.startTime ?? '19:00')
  const [title, setTitle] = useState(plan?.title ?? '')
  const [hostId, setHostId] = useState(plan?.hostId ?? '')
  const [note, setNote] = useState(plan?.note ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * THE CONVERSION. Local day + local HH:MM → a UTC instant, done in the
   * browser where "7:00 PM" has exactly one meaning.
   *
   * Recomputed on every keystroke rather than at submit so the preview below
   * shows the instant that will actually be stored — which is the only way
   * anybody would ever notice a machine whose timezone is wrong before the
   * reminders start arriving at the wrong hour.
   */
  const startsAt = useMemo(() => isoFromLocalParts(date, time, 0), [date, time])
  const inThePast = !!startsAt && Date.parse(startsAt) <= Date.now()

  const submit = async (): Promise<void> => {
    if (!startsAt) {
      setError('Enter a valid date and start time.')
      return
    }
    if (inThePast) {
      setError('That start time has already passed. Pick one in the future.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const payload = {
        title: title.trim().slice(0, SCHEDULED_TITLE_MAX) || `Stream — ${shortDayLabel(date)}`,
        streamDate: date,
        startTime: time,
        startsAt,
        hostId: hostId || null,
        note: note.trim().slice(0, SCHEDULED_NOTE_MAX) || null
      }
      const res = editing
        ? await streamPlans.update({ id: plan.id, ...payload })
        : await streamPlans.create(payload)
      if (!res.ok) {
        setError(resultError(res, 'Could not save that.'))
        return
      }
      toast.success(editing ? 'Stream rescheduled.' : 'Stream scheduled.')
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editing ? 'Reschedule stream' : 'Schedule a stream'}
      subtitle="Reminders go out an hour before and fifteen minutes before."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={() => void submit()}>
            {editing ? 'Save' : 'Schedule it'}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <div className="stm-form-row">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Start time" error={inThePast ? 'Already past' : undefined}>
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
      </div>

      {/* The preview is doing real work, not decoration: it is where a machine
          with the wrong timezone gives itself away, before the reminders do. */}
      <div className="stm-preview">
        <Icon name="Bell" size={15} />
        <span className="stm-preview-times">
          Reminders at <b>{timeLabel(shiftIso(startsAt, -60))}</b> and{' '}
          <b>{timeLabel(shiftIso(startsAt, -15))}</b>
        </span>
        <span className="stm-preview-note">
          for a show starting {timeLabel(startsAt)} on {shortDayLabel(date)}.
        </span>
      </div>

      <Field label="Title" hint="Left blank, it takes the date">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Monday Night Rip"
          maxLength={SCHEDULED_TITLE_MAX}
        />
      </Field>

      <div className="stm-form-row">
        {hosts.length > 0 ? (
          <Field label="Host" hint="Reminded too, even without Admin access">
            <Select value={hostId} onChange={(e) => setHostId(e.target.value)}>
              <option value="">No host</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.firstName} {h.lastName}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          plan?.hostName && (
            <Field label="Host" hint="You cannot change this without employee access">
              <Input value={plan.hostName} readOnly />
            </Field>
          )
        )}
        <Field label="Note" hint="Optional">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything the host needs to know"
            maxLength={SCHEDULED_NOTE_MAX}
          />
        </Field>
      </div>
    </Modal>
  )
}

/** An instant, `minutes` away. Only ever used to SHOW the two reminder times. */
function shiftIso(iso: string | null, minutes: number): string | null {
  if (!iso) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return new Date(at + minutes * 60_000).toISOString()
}
