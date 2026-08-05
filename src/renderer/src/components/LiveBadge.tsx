import { useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/sync'
import { api } from '../lib/api'

/**
 * "Is what I am looking at current?" — answered in the chrome, on every screen.
 *
 * This is the difference between an app that happens to share data and one
 * people trust to. Everybody can see it, not just an admin who thinks to open a
 * settings tab, because the person it matters to is whoever is about to count a
 * shelf against a number somebody else changed a minute ago.
 *
 * It is deliberately quiet when things are fine — a small dot and a word — and
 * says something specific when they are not. "Offline" here does NOT mean the
 * app has stopped working: it means this machine's changes are queued and
 * nobody else's have arrived yet, which is exactly what someone needs to know
 * before trusting a total.
 */
export function LiveBadge(): JSX.Element | null {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    let active = true
    void api.sync.status().then((s) => {
      if (active) setStatus(s)
    })
    const offStatus = api.sync.onStatus((next) => {
      if (active) setStatus(next)
    })
    // A visible acknowledgement that data just moved. Without it the numbers
    // change on their own and it reads like a glitch rather than a colleague.
    const offChanged = api.sync.onChanged(() => {
      if (!active) return
      setFlash(true)
      setTimeout(() => active && setFlash(false), 2200)
    })
    return () => {
      active = false
      offStatus()
      offChanged()
    }
  }, [])

  // A standalone build has no relay and nothing to report. Showing "off" there
  // would be a permanent warning about a feature that was never turned on.
  if (!status || (!status.config.enabled && !status.config.keySet)) return null

  const state = ((): { tone: string; label: string; title: string } => {
    if (!status.config.enabled) {
      return {
        tone: 'paused',
        label: 'Paused',
        title: 'Sync is paused. Nobody else can see your changes, and theirs are not arriving.'
      }
    }
    if (status.phase === 'error') {
      return {
        tone: 'offline',
        label: 'Offline',
        title: 'Cannot reach the relay. Work is saved here and uploads when the connection returns.'
      }
    }
    if (status.pending > 0) {
      return {
        tone: 'busy',
        label: 'Sending',
        title: `${status.pending} change${status.pending === 1 ? '' : 's'} on the way up.`
      }
    }
    return {
      tone: 'live',
      label: flash ? 'Updated' : 'Live',
      title: status.lastPullAt
        ? `Up to date with everyone else. Last checked ${new Date(status.lastPullAt).toLocaleTimeString()}.`
        : 'Connected.'
    }
  })()

  return (
    <span className="live-badge" data-tone={state.tone} data-flash={flash ? 'true' : 'false'} title={state.title}>
      <span className="live-dot" />
      {state.label}
    </span>
  )
}
