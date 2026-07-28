import { useEffect, useMemo, useState } from 'react'
import type { Employee } from '@shared/types'
import type { StreamSession } from '@shared/streaming'
import { durationMinutes, formatDuration } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Field, Input, Modal, Select } from '../../components/ui'
import { resultError, streaming } from './api'
import {
  crossedDays,
  dayKeyOf,
  isoFromLocalParts,
  longDayLabel,
  shortDayLabel,
  timeInputValue,
  timeLabel,
  todayKey
} from './time'

/**
 * Add or correct a session by hand.
 *
 * Times are typed the way a person remembers them — a date and two clock times —
 * and turned into instants here, because that is the only place the timezone
 * question has one right answer. The end being EARLIER in the day than the start
 * is the normal case for this business, not an error, so the day offset is
 * derived from the two times and then left editable: a 9pm → 2am show should
 * need no thought, and a genuine 26-hour marathon should still be expressible.
 */
export function SessionFormModal({
  session,
  initialDate,
  hosts,
  onClose,
  onSaved
}: {
  /** Present when correcting an existing session; absent when adding one. */
  session?: StreamSession
  /** Prefills the date when the form was opened from a calendar day. */
  initialDate?: string
  hosts: Employee[]
  onClose: () => void
  onSaved: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const editing = !!session
  // A live session has no end yet. Its end field stays optional so "correct the
  // title of the show that is on air" does not force an end time on it.
  const isLive = session?.status === 'live'

  const [date, setDate] = useState(
    () => session?.streamDate ?? initialDate ?? todayKey()
  )
  const [startTime, setStartTime] = useState(() =>
    session ? timeInputValue(session.startedAt) : '19:00'
  )
  const [endTime, setEndTime] = useState(() =>
    session?.endedAt ? timeInputValue(session.endedAt) : ''
  )
  const [endDay, setEndDay] = useState(() =>
    session?.endedAt ? crossedDays(session.startedAt, session.endedAt) : 0
  )
  // Once the operator sets the offset themselves, the clock times stop moving it
  // under them — the derived value is a convenience, not a rule.
  const [endDayPinned, setEndDayPinned] = useState(false)
  const [title, setTitle] = useState(session?.title ?? '')
  const [hostId, setHostId] = useState(session?.hostId ?? '')
  const [note, setNote] = useState(session?.note ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (endDayPinned || !endTime || !startTime) return
    setEndDay(endTime <= startTime ? 1 : 0)
  }, [startTime, endTime, endDayPinned])

  const startIso = useMemo(() => isoFromLocalParts(date, startTime, 0), [date, startTime])
  const endIso = useMemo(
    () => (endTime ? isoFromLocalParts(date, endTime, endDay) : null),
    [date, endTime, endDay]
  )
  const minutes = startIso ? durationMinutes(startIso, endIso) : null
  const endsBeforeStart =
    !!startIso && !!endIso && new Date(endIso).getTime() < new Date(startIso).getTime()

  // The stream date is the local date the show STARTED on, so a date-field edit
  // moves the session's whole business day. Spell that out where it happens.
  const filedUnder = startIso ? dayKeyOf(new Date(startIso)) : date

  const submit = async (): Promise<void> => {
    if (!startIso) {
      setError('Enter a valid date and start time.')
      return
    }
    if (!editing && !endIso) {
      setError('Enter the time the show ended. Use Start stream for one that is running now.')
      return
    }
    if (endsBeforeStart) {
      setError('That end time is before the start. Check the day offset.')
      return
    }
    setError('')
    setBusy(true)
    try {
      const finalTitle = title.trim() || `Stream — ${shortDayLabel(filedUnder)}`
      const res = editing
        ? await streaming.update({
            id: session.id,
            title: finalTitle,
            startedAt: startIso,
            // A live session keeps its open end when the field is left blank;
            // typing one into a live session is how you close it after the fact.
            endedAt: endIso,
            hostId: hostId || null,
            note: note.trim() || null
          })
        : await streaming.create({
            title: finalTitle,
            startedAt: startIso,
            endedAt: endIso,
            hostId: hostId || null,
            note: note.trim() || null
          })
      if (!res.ok) {
        // Overlap rejections come back from here. They are the single most
        // useful thing this form can tell an operator, so they land in the form
        // where the times are, not in a toast that scrolls away.
        setError(resultError(res, editing ? 'Could not save the stream.' : 'Could not add the stream.'))
        return
      }
      toast.success(editing ? 'Stream updated.' : 'Stream added.')
      await onSaved()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={editing ? 'Edit stream' : 'Add a stream'}
      subtitle={
        editing
          ? 'Correct the times, title or host. Breaks and giveaways stay attached.'
          : 'For a show nobody clocked. Times are local — type them as they happened.'
      }
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="Check" loading={busy} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Add stream'}
          </Button>
        </>
      }
    >
      {error && <div className="auth-alert">{error}</div>}

      <div className="stm-form-row">
        <Field label="Date" hint="The day the show started">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Start time">
          <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </Field>
        <Field
          label="End time"
          hint={isLive ? 'Blank keeps it live' : undefined}
          error={endsBeforeStart ? 'Before the start' : undefined}
        >
          <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </Field>
        <Field label="Ends on" hint="Past midnight is normal here">
          <Select
            value={String(endDay)}
            disabled={!endTime}
            onChange={(e) => {
              setEndDayPinned(true)
              setEndDay(Number(e.target.value))
            }}
          >
            <option value="0">The same day</option>
            <option value="1">The next day (+1d)</option>
            <option value="2">Two days later (+2d)</option>
          </Select>
        </Field>
      </div>

      <div className="stm-preview">
        <Icon name="CalendarClock" size={15} />
        <span className="stm-preview-times">
          <b>{shortDayLabel(filedUnder)}</b> {timeLabel(startIso)}
          <Icon name="ArrowRight" size={13} />
          {endIso ? (
            <>
              {timeLabel(endIso)}
              {endDay > 0 && <span className="stm-plus">+{endDay}d</span>}
            </>
          ) : (
            <em>still live</em>
          )}
        </span>
        <span className="stm-preview-dur mono">{formatDuration(minutes)}</span>
        <span className="stm-preview-note">
          Filed under {longDayLabel(filedUnder)} — a stream belongs to the day it started, however
          late it ran.
        </span>
      </div>

      <Field label="Title" hint="Left blank, it takes the date">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Monday Night Rip"
        />
      </Field>

      <div className="stm-form-row">
        {hosts.length > 0 ? (
          <Field label="Host" hint="Optional">
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
          session?.hostName && (
            <Field label="Host" hint="You cannot change this without employee access">
              <Input value={session.hostName} readOnly />
            </Field>
          )
        )}
        <Field label="Note" hint="Optional">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything worth remembering about the show"
          />
        </Field>
      </div>
    </Modal>
  )
}
