import { useEffect, useState } from 'react'
import type { Employee } from '@shared/types'
import type { StreamSession } from '@shared/streaming'
import { STREAM_LONG_HOURS, formatDuration, isSuspiciouslyLong } from '@shared/streaming'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { Button, Input, Select } from '../../components/ui'
import { resultError, streaming } from './api'
import { formatElapsed, shortDayLabel, timeLabel, todayKey } from './time'

/**
 * The live bar — the one thing that is true no matter which tab is open.
 *
 * A show that is on air owns every sale until it closes, so the bar never
 * collapses: either it is offering Start, or it is showing what is running and
 * for how long. The elapsed clock ticks because a static number invites the eye
 * to skip it, and a forgotten "End stream" is the failure this module is most
 * exposed to — past STREAM_LONG_HOURS the bar stops being informational and
 * starts complaining.
 */
export function LiveBar({
  active,
  loading,
  canManage,
  hosts,
  onStarted,
  onEnded,
  onOpen
}: {
  active: StreamSession | null
  loading: boolean
  canManage: boolean
  /** Empty when the signed-in user cannot read the employee list — the host
   *  picker then hides itself rather than offering an empty dropdown. */
  hosts: Employee[]
  onStarted: (session: StreamSession) => void | Promise<void>
  onEnded: () => void | Promise<void>
  onOpen: (id: string) => void
}): JSX.Element {
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [hostId, setHostId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Re-render once a second only while something is actually live; an idle bar
  // has nothing to count and should not keep a timer alive.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active?.id])

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      // A blank title would produce an unidentifiable row in the calendar, and
      // the operator is mid-setup and about to go live — so name it for them
      // rather than blocking the start on a form error.
      const res = await streaming.start({
        title: title.trim() || `Stream — ${shortDayLabel(todayKey())}`,
        hostId: hostId || null,
        note: note.trim() || null
      })
      if (!res.ok || !res.data) {
        toast.error(resultError(res, 'Could not start the stream.'))
        return
      }
      setTitle('')
      setNote('')
      toast.success('Stream started.')
      await onStarted(res.data)
    } finally {
      setBusy(false)
    }
  }

  const end = async (): Promise<void> => {
    if (!active) return
    setBusy(true)
    try {
      const res = await streaming.end(active.id)
      if (!res.ok) {
        toast.error(resultError(res, 'Could not end the stream.'))
        return
      }
      toast.success(`Stream ended — ${formatDuration(res.data?.durationMinutes ?? null)}.`)
      await onEnded()
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="stm-live is-loading">
        <span className="stm-live-label">
          <Icon name="Loader2" size={15} className="spin-ico" /> Checking what&rsquo;s on air&hellip;
        </span>
      </div>
    )
  }

  if (!active) {
    return (
      <div className="stm-live">
        <span className="stm-live-label off">
          <Icon name="Moon" size={15} />
          Nothing live
        </span>
        {canManage ? (
          <div className="stm-start">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What’s the show? (optional)"
              aria-label="Stream title"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void start()
              }}
            />
            {hosts.length > 0 && (
              <Select
                value={hostId}
                onChange={(e) => setHostId(e.target.value)}
                aria-label="Host"
                className="stm-host-select"
              >
                <option value="">No host</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.firstName} {h.lastName}
                  </option>
                ))}
              </Select>
            )}
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              aria-label="Note"
            />
            <Button variant="primary" icon="Play" loading={busy} onClick={() => void start()}>
              Start stream
            </Button>
          </div>
        ) : (
          <span className="stm-live-hint">
            You can see streams but not start one — that needs Manage streams.
          </span>
        )}
      </div>
    )
  }

  const elapsed = now - new Date(active.startedAt).getTime()
  const runaway = isSuspiciouslyLong(active, now)

  return (
    <div className={`stm-live is-on ${runaway ? 'is-runaway' : ''}`}>
      <div className="stm-live-row">
        <span className="stm-live-label on">
          <span className="stm-live-dot" aria-hidden="true" />
          Live
        </span>
        <button type="button" className="stm-live-title" onClick={() => onOpen(active.id)}>
          {active.title}
          <Icon name="ChevronRight" size={15} />
        </button>
        <span className="stm-live-since">
          <Icon name="Clock" size={13} />
          since {timeLabel(active.startedAt)}
          {active.hostName && <> &middot; {active.hostName}</>}
        </span>
        <span className="stm-live-clock mono" aria-label="Elapsed" role="timer">
          {formatElapsed(elapsed)}
        </span>
        {canManage && (
          <Button variant="primary" icon="Square" loading={busy} onClick={() => void end()}>
            End stream
          </Button>
        )}
      </div>

      {runaway && (
        <div className="stm-live-warn" role="alert">
          <Icon name="AlertTriangle" size={15} />
          <span>
            Live for <b>{formatDuration(Math.floor(elapsed / 60000))}</b> — past {STREAM_LONG_HOURS}
            h. That is usually a forgotten <b>End stream</b>. Until it closes, this session claims
            every sale that lands, so end it at the time the show actually finished.
          </span>
        </div>
      )}
    </div>
  )
}
