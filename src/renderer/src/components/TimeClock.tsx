import { useEffect, useRef, useState } from 'react'
import type { ClockStatus } from '@shared/types'
import { api } from '../lib/api'
import { useToast } from './Toast'
import { Button } from './ui'
import { Icon } from './Icon'
import { formatHours } from '../lib/format'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function elapsedLabel(fromIso: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000))
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`
}

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * Self-service time clock shown on the Home page. Every signed-in user can
 * clock in and out; the shift time ticks live while clocked in, and a rough
 * location is captured on each punch (handled in the main process).
 */
export function TimeClock(): JSX.Element {
  const toast = useToast()
  const [status, setStatus] = useState<ClockStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const timer = useRef<number | null>(null)

  const open = status?.open ?? null

  useEffect(() => {
    api.clock.status().then(setStatus)
  }, [])

  // Tick every second while clocked in so the shift timer stays live.
  useEffect(() => {
    if (open) {
      timer.current = window.setInterval(() => setNow(Date.now()), 1000)
      return () => {
        if (timer.current) window.clearInterval(timer.current)
      }
    }
    return undefined
  }, [open])

  const punch = async (dir: 'in' | 'out'): Promise<void> => {
    setBusy(true)
    try {
      const res = dir === 'in' ? await api.clock.in() : await api.clock.out()
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not update the clock.')
        return
      }
      setStatus(res.data)
      setNow(Date.now())
      toast.success(dir === 'in' ? "You're clocked in." : "You're clocked out.")
    } finally {
      setBusy(false)
    }
  }

  const isOpen = !!open
  const place = open?.clockInLocation.place

  return (
    <div className="panel-card">
      <div className="timeclock">
        <div className="tc-left">
          <div className={`tc-ring ${isOpen ? 'on' : ''}`}>
            <Icon name={isOpen ? 'Timer' : 'Play'} size={24} />
          </div>
          <div>
            <div className={`tc-state ${isOpen ? 'on' : ''}`}>
              {isOpen ? (
                <>
                  <span className="ld" /> On the clock
                </>
              ) : (
                'Clocked out'
              )}
            </div>
            <div className="tc-timer">
              {isOpen ? elapsedLabel(open.clockIn, now) : formatHours(status?.todayMinutes ?? 0)}
            </div>
            <div className="tc-sub">
              {isOpen ? (
                <span>
                  Since <b>{timeOfDay(open.clockIn)}</b>
                </span>
              ) : (
                <span>logged today</span>
              )}
              <span>
                This week <b>{formatHours(status?.weekMinutes ?? 0)}</b>
              </span>
              {isOpen && place && (
                <span className="loc">
                  <Icon name="MapPin" size={13} />
                  {place}
                </span>
              )}
            </div>
          </div>
        </div>

        <Button
          className="tc-cta"
          variant={isOpen ? 'danger' : 'primary'}
          icon={isOpen ? 'Square' : 'Play'}
          loading={busy}
          onClick={() => punch(isOpen ? 'out' : 'in')}
        >
          {busy ? 'Saving…' : isOpen ? 'Clock out' : 'Clock in'}
        </Button>
      </div>
    </div>
  )
}
