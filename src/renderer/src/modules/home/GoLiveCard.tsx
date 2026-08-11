import { useCallback, useEffect, useState } from 'react'
import type { StreamSession } from '@shared/streaming'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { useSession } from '../../lib/session'

/**
 * On air, from the breaker's own home page.
 *
 * The person in front of the camera is not the person running the Streaming
 * module. Starting a show used to require `streaming.manage`, which is also the
 * permission for editing a session's costs, adding the boxes opened and
 * deleting a night — so the only way to let a breaker go live was to hand them
 * the P&L of every show the business has run. This card is the narrow answer:
 * one button, on their own page, against `streaming.run` and nothing else.
 *
 * ## It is deliberately the whole feature for them
 *
 * No calendar, no cost entry, no session list. A breaker starts a show and ends
 * it; everything that happens in between is recorded against the session by
 * whoever runs the module. Giving them a second screen "for context" would be
 * giving them the module by another name.
 *
 * ## Live, not remembered
 *
 * Refreshed off the same broadcast channel the Streaming module uses, because
 * two people can be looking at this: a show started at the desk has to turn
 * this card red on the breaker's laptop without anybody pressing anything. A
 * button that thinks nothing is on air, on a night that is, would start a
 * second overlapping session — which the main process refuses, so the failure
 * mode is a confusing error rather than bad data, and neither is acceptable
 * when somebody is about to go live.
 */
export function GoLiveCard(): JSX.Element | null {
  const { can } = useSession()
  const toast = useToast()
  const [active, setActive] = useState<StreamSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')

  const mayRun = can('streaming.run') || can('streaming.manage')

  const load = useCallback(async () => {
    const s = await api.streaming.active()
    setActive(s)
  }, [])

  useLiveRefresh(LIVE.streaming, load)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await load()
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [load])

  // A running clock, and only while something is running. An idle card has
  // nothing to count and should not hold a timer open all day.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [active?.id])

  if (!mayRun) return null

  const start = async (): Promise<void> => {
    setBusy(true)
    try {
      // A blank title still starts. Somebody about to go on camera should not
      // be stopped by a form error, and an unnamed row in the calendar is
      // fixable afterwards in a way that a missed opening is not.
      const res = await api.streaming.start({
        title: title.trim() || `Stream — ${new Date().toLocaleDateString()}`,
        hostId: null,
        note: null
      })
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not start the stream.')
        return
      }
      setTitle('')
      setActive(res.data)
      toast.success('You are live.')
    } finally {
      setBusy(false)
    }
  }

  const end = async (): Promise<void> => {
    if (!active) return
    setBusy(true)
    try {
      const res = await api.streaming.end(active.id)
      if (!res.ok) {
        toast.error(res.error ?? 'Could not end the stream.')
        return
      }
      setActive(null)
      toast.success('Stream ended.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="golive is-loading">
        <Icon name="Loader2" size={16} className="spin-ico" />
        <span>Checking what&rsquo;s on air…</span>
      </div>
    )
  }

  if (active) {
    const mins = Math.max(0, Math.floor((now - Date.parse(active.startedAt)) / 60000))
    const hh = Math.floor(mins / 60)
    const mm = mins % 60
    return (
      <div className="golive is-live">
        <span className="golive-dot" aria-hidden />
        <div className="golive-main">
          <b className="golive-title">{active.title || 'Live'}</b>
          <span className="golive-sub">
            On air {hh > 0 ? `${hh}h ` : ''}
            {mm}m
          </span>
        </div>
        <Button variant="danger" icon="Square" loading={busy} disabled={busy} onClick={() => void end()}>
          End stream
        </Button>
      </div>
    )
  }

  return (
    <div className="golive">
      <div className="golive-main">
        <b className="golive-title">Not on air</b>
        <span className="golive-sub">Name the show if you like, then go live.</span>
      </div>
      <input
        className="input golive-name"
        value={title}
        placeholder="Tonight's show"
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) void start()
        }}
      />
      <Button variant="primary" icon="Radio" loading={busy} disabled={busy} onClick={() => void start()}>
        Start stream
      </Button>
    </div>
  )
}
