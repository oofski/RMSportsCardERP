import { useCallback, useEffect, useState } from 'react'
import type { ClockPushState } from '@shared/webPush'
import { api } from '../../lib/api'
import { Button, CenterLoader } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatDateTime } from '../../lib/format'
import {
  currentEndpoint,
  isStandalone,
  pushCapability,
  subscribeThisDevice,
  unsubscribeThisDevice,
  type PushCapability
} from '../../lib/webPush'

/**
 * Turning clock-in notifications on, for this device, for the person looking at
 * the screen.
 *
 * The screen has exactly one job beyond the toggle, and it is the reason it is
 * laid out this way: WHEN THE TOGGLE CANNOT BE OFFERED, SAY WHY IN A SENTENCE
 * SOMEBODY CAN ACT ON. There are five separate ways this is unavailable — the
 * desktop build, an insecure origin, an iPhone that has not been added to the
 * Home Screen, a browser that cannot do it at all, and a permission already
 * refused — and four of them look identical from the outside: a switch that
 * does nothing. The iOS one is the single most likely support question this
 * feature will ever generate, so it gets the instructions in full rather than a
 * link.
 *
 * "On" means three things being true at once and the screen distinguishes them,
 * because two of them are invisible failures:
 *
 *   · this browser holds a push subscription   (the phone's side)
 *   · the relay has a row for it               (the server's side)
 *   · the relay has a VAPID private key        (or it sends nothing, silently)
 *
 * The last one is why `state.problem` exists at all: without it this screen
 * would happily report "notifications are on" for a relay that has never been
 * able to send one.
 */
export function NotificationsTab(): JSX.Element {
  const toast = useToast()
  const [state, setState] = useState<ClockPushState | null>(null)
  const [capability, setCapability] = useState<PushCapability | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const next = await api.push.state()
    setState(next)
    const cap = pushCapability()
    setCapability(cap)
    // Only ask the browser about its own subscription when it has the APIs to
    // be asked. On the desktop build these are absent and the call throws.
    setEndpoint(cap.usable ? await currentEndpoint() : null)
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await load()
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [load])

  // The service worker tells us when the browser rotated the subscription behind
  // our back — it expires them, and when it does the old row on the relay is
  // dead and this screen would otherwise keep claiming it is on.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    const onMessage = (event: MessageEvent): void => {
      if (event.data?.type === 'rmops-push-subscription-changed') void load()
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [load])

  if (loading || !state || !capability) return <CenterLoader />

  const relayReady = state.relayConfigured && state.ready
  const on = !!endpoint && state.devices.length > 0

  const turnOn = async (): Promise<void> => {
    setBusy('on')
    try {
      const result = await subscribeThisDevice(state.publicKey ?? '')
      if (!result.ok || !result.subscription) {
        toast.error(result.error ?? 'Could not turn notifications on.')
        return
      }
      const saved = await api.push.subscribe(result.subscription)
      if (!saved.ok) {
        toast.error(saved.error ?? 'The relay would not accept this device.')
        return
      }
      toast.success('Notifications are on for this device.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const turnOff = async (): Promise<void> => {
    setBusy('off')
    try {
      const gone = await unsubscribeThisDevice()
      // Fall back to whatever this screen last knew: a browser that has already
      // dropped its subscription still leaves a row on the relay, and leaving it
      // there is a phone the relay keeps trying forever.
      const target = gone ?? endpoint
      if (target) {
        const removed = await api.push.unsubscribe(target)
        if (!removed.ok) {
          toast.error(removed.error ?? 'Turned off here, but the relay still has this device.')
          await load()
          return
        }
      }
      toast.success('Notifications are off for this device.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const sendTest = async (): Promise<void> => {
    setBusy('test')
    try {
      const result = await api.push.test()
      if (!result.ok || !result.data) {
        toast.error(result.error ?? 'Nothing was delivered.')
        await load()
        return
      }
      const { sent, dropped } = result.data
      toast.success(`Sent to ${sent} device${sent === 1 ? '' : 's'}. It can take a few seconds.`)
      // A dropped subscription means the relay just deleted a row this screen is
      // still showing, so the list has to be refetched or it lies.
      if (dropped > 0) await load()
    } finally {
      setBusy(null)
    }
  }

  const banner = ((): { tone: 'ok' | 'warn' | 'error'; title: string; detail: string } => {
    if (!state.relayConfigured) {
      return {
        tone: 'warn',
        title: 'This app is not connected to the relay',
        detail: state.problem ?? 'Notifications are sent by the cloud relay, and there is none.'
      }
    }
    if (!state.ready) {
      return {
        tone: 'error',
        title: 'The relay cannot send notifications yet',
        detail: state.problem ?? 'The relay has no signing key.'
      }
    }
    if (!capability.usable) {
      return {
        tone: 'warn',
        title:
          capability.blocker === 'ios-needs-home-screen'
            ? 'One step needed on this iPhone or iPad'
            : 'This device cannot receive notifications',
        detail: capability.message
      }
    }
    if (on) {
      return {
        tone: 'ok',
        title: 'On for this device',
        detail: 'You will get a notification when anyone clocks in or out. Not for your own punches.'
      }
    }
    return {
      tone: 'warn',
      title: 'Off for this device',
      detail:
        'Turn it on and this phone gets a notification when somebody starts or finishes a shift.'
    }
  })()

  return (
    <div className="sync-page">
      <div className="sync-state" data-tone={banner.tone}>
        <span className="sync-dot" />
        <div className="sync-state-main">
          <div className="sync-state-title">{banner.title}</div>
          <div className="sync-state-sub">{banner.detail}</div>
        </div>
        <div className="sync-state-actions">
          {capability.usable && relayReady && (
            <Button
              variant={on ? 'secondary' : 'primary'}
              icon={on ? 'BellOff' : 'Bell'}
              loading={busy === 'on' || busy === 'off'}
              onClick={on ? turnOff : turnOn}
            >
              {on ? 'Turn off' : 'Turn on'}
            </Button>
          )}
          {on && relayReady && (
            <Button icon="Send" loading={busy === 'test'} onClick={sendTest}>
              Send a test
            </Button>
          )}
        </div>
      </div>

      {/* ---- The iOS answer, in full, where somebody holding the phone will
              read it. Not a link and not a tooltip: this is the one support
              question this feature is guaranteed to generate, and the person
              asking it is standing in a warehouse. */}
      {capability.blocker === 'ios-needs-home-screen' && (
        <section className="sync-card sync-card-warn">
          <header>
            <Icon name="Smartphone" size={17} />
            <h3>Add this app to your Home Screen first</h3>
          </header>
          <p className="sync-note">
            Apple only allows notifications for a web app that has been added to the Home Screen —
            there is no way around it and nothing is wrong with your phone.
          </p>
          <ol className="sync-note" style={{ paddingLeft: 18 }}>
            <li>Open this page in Safari (Chrome on iPhone cannot do this).</li>
            <li>
              Tap the Share button — the square with an arrow out of the top, at the bottom of the
              screen.
            </li>
            <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            <li>Close Safari and open the app from the new icon.</li>
            <li>Come back to this screen and press Turn on.</li>
          </ol>
          <p className="sync-note">
            It also needs iOS 16.4 or newer. On an older version this cannot work at all — the
            desktop app on a computer is the alternative.
          </p>
        </section>
      )}

      {/* Added to the Home Screen and still refused: worth saying so explicitly,
          because the instructions above would otherwise read as "you did it
          wrong" to somebody who did it right. */}
      {capability.blocker === 'unsupported' && isStandalone() && (
        <section className="sync-card sync-card-warn">
          <header>
            <Icon name="AlertTriangle" size={17} />
            <h3>Installed, but this browser still cannot</h3>
          </header>
          <p className="sync-note">
            The app is running from the Home Screen and the browser still offers no notification
            support. On an iPhone that means iOS is older than 16.4. Update it, or use a computer.
          </p>
        </section>
      )}

      {/* ---- Capable, but still a browser tab.
              Android and desktop Chrome deliver notifications to a tab
              perfectly well, so this is not a blocker and does not hide the
              toggle. It is here because a tab is not what anybody wants at
              7am: a notification tapped from the lock screen should open the
              app, not whatever was last on screen in a browser with twenty
              other tabs. Installed, it has its own icon and its own window. */}
      {capability.usable && !isStandalone() && (
        <section className="sync-card">
          <header>
            <Icon name="Smartphone" size={17} />
            <h3>Add it to your Home Screen</h3>
          </header>
          <p className="sync-note">
            Notifications already work in this browser, so this is optional here — but installed,
            the app gets its own icon and opens on its own instead of inside a browser tab.
          </p>
          <ul className="sync-note" style={{ paddingLeft: 18 }}>
            <li>
              <b>Android (Chrome):</b> menu (⋮) → <b>Add to Home screen</b> or <b>Install app</b>.
            </li>
            <li>
              <b>Computer (Chrome or Edge):</b> the install icon at the right-hand end of the
              address bar.
            </li>
          </ul>
        </section>
      )}

      {capability.blocker === 'permission-denied' && (
        <section className="sync-card sync-card-warn">
          <header>
            <Icon name="BellOff" size={17} />
            <h3>Notifications are blocked in the browser</h3>
          </header>
          <p className="sync-note">{capability.message}</p>
        </section>
      )}

      {/* ---- What is actually registered, so "on" is checkable rather than
              claimed. A device here with no matching subscription in this
              browser is another phone — which is normal, and which is why the
              list exists at all. */}
      <section className="sync-card">
        <header>
          <Icon name="Smartphone" size={17} />
          <h3>
            {state.devices.length === 0
              ? 'No devices turned on'
              : `${state.devices.length} device${state.devices.length === 1 ? '' : 's'} turned on`}
          </h3>
        </header>
        <p className="sync-note">
          Only your own. Notifications go to the people who switched them on for themselves — there
          is no way to switch them on for somebody else, and nothing here shows whose phones anyone
          else has registered.
        </p>
        {state.devices.length > 0 && (
          <ul className="sync-reject-list">
            {state.devices.map((device) => (
              <li key={device.id}>
                <code>{device.label ?? device.service}</code>
                {/* WHEN IT LAST WORKED, not whether it is switched on. A row in
                    the relay's table says only that somebody pressed a button
                    once; a phone that stopped receiving weeks ago looks
                    identical to one that has had a quiet week, and this is the
                    only place the difference is visible. */}
                <span>
                  {device.lastSentAt
                    ? `Last notified ${formatDateTime(device.lastSentAt)}`
                    : 'Nothing sent to it yet — send a test'}
                </span>
                <time>Added {formatDateTime(device.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sync-card">
        <header>
          <Icon name="ShieldCheck" size={17} />
          <h3>Where these notifications go</h3>
        </header>
        <p className="sync-note">
          Nowhere but your phone. The notification is encrypted on our own relay before it is handed
          to Apple, Google or Mozilla to deliver, so the only thing they carry is a sealed
          block of bytes — no name, no time, nothing readable. That is why this was built rather
          than pointed at a notification service: any of those would have been a permanent record of
          who works here and what hours they keep, held by somebody else.
        </p>
      </section>
    </div>
  )
}
