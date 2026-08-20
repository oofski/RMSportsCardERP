/**
 * Clock-in push notifications: the shapes the app passes around.
 *
 * There is no crypto in this file and there never will be. Every VAPID
 * signature and every aes128gcm payload is produced in the Cloudflare Worker
 * (cloud/worker.js), because punches arrive from several machines and from the
 * web app, and a sender that lives in one Electron process only fires when that
 * particular machine happens to be awake — so the 7am shift, with nobody at a
 * desk, would silently never notify.
 *
 * What the app does is narrower and worth stating: it is the AUTHENTICATED
 * MIDDLEMAN. A phone has no shared relay key and must never be given one, so a
 * subscription travels
 *
 *     browser (session cookie, permission check) → app server → relay (shared key)
 *
 * which is the same path every other operation takes and the reason the relay
 * key still never leaves the server.
 */

/** What `PushManager.subscribe()` produced, in the form the relay stores. */
export interface PushSubscriptionInput {
  /** The push service URL. A bearer capability: whoever holds it can notify that phone. */
  endpoint: string
  /** The device's P-256 public key, base64url, 65 bytes uncompressed. */
  p256dh: string
  /** The device's auth secret, base64url, 16 bytes. */
  auth: string
  /** Something a human recognises in a list — "iPhone (Safari)". Never a fingerprint. */
  label?: string
}

/**
 * One device somebody has turned notifications on for.
 *
 * `id` is a hash of the endpoint, not the endpoint. The endpoint is a capability
 * URL and has no business being on a screen or in a renderer's memory; a hash is
 * enough to say "this row is that device" and cannot be replayed.
 */
export interface PushDevice {
  id: string
  employeeId: string
  label: string | null
  createdAt: string
  lastSentAt: string | null
  /** The push service's hostname, so a person can recognise their own phone. */
  service: string
}

/**
 * Everything the notifications screen needs to tell the truth in one call.
 *
 * `problem` is the field that earns this shape. Without it the screen can only
 * say "notifications are on" — which is exactly what it would say when the
 * relay has no VAPID private key and is therefore sending nothing at all, the
 * one failure of this feature that nobody discovers until a shift goes
 * unannounced.
 */
/**
 * Turn a relay failure into something an operator can act on.
 *
 * One shape of failure earns this: a relay Worker running an OLDER copy of
 * cloud/worker.js. The notification routes live in that file, and it is
 * deployed by pasting the file into a dashboard by hand — so a relay set up
 * before this feature existed answers /v1/push-notify/key with a flat 404, and
 * the screen would otherwise say "Relay error 404." That names nothing, points
 * nowhere, and reads like the relay is down when the relay is perfectly
 * healthy and merely out of date. There is nothing in the Cloudflare dashboard
 * that says the deployed code is older than the repository, so nobody finds
 * this without being told.
 *
 * Everything else is passed through untouched: an invented explanation is worse
 * than a plain error.
 */
export function explainRelayProblem(message: string): string {
  const text = String(message || '').trim()
  if (!/\b404\b|not found/i.test(text)) return text || 'The relay could not be reached.'
  return (
    `${text} The relay Worker does not have the notification routes, which almost always means ` +
    'it is running an older copy of cloud/worker.js. Re-paste that file in the Cloudflare ' +
    'dashboard (Worker → Edit code → select all → paste → Deploy). See docs/CLOUDFLARE.md.'
  )
}

/**
 * What the relay said when asked whether it can keep the clock feed off a
 * device that is not entitled to it.
 *
 *   yes      it advertised clock-scope. Anybody can be enrolled.
 *   no       it answered, and did not. It is an older paste of cloud/worker.js.
 *   unknown  it could not be asked at all — unreachable, refused, or its reply
 *            made no sense.
 *
 * THE THIRD VALUE IS THE POINT. This was a boolean, and everything that was not
 * a clear yes came back as "the relay is running an older version" — so an
 * unreachable relay, a wrong key and a stale paste all produced the same
 * sentence telling somebody to go and paste the Worker again. They did, twice,
 * and nothing changed, because for two of those three causes pasting was never
 * going to change anything. A diagnosis the code has not actually established
 * is worse than no diagnosis: it sends somebody to fix the wrong thing.
 */
export type ClockScopeAnswer = 'yes' | 'no' | 'unknown'

export interface ClockPushState {
  /** Is there a relay at all? A standalone build has none and can do none of this. */
  relayConfigured: boolean
  /** Can the relay actually sign a push right now? */
  ready: boolean
  /** Why not, in words an operator can act on. Null when ready. */
  problem: string | null
  /** The VAPID public key the browser must subscribe with. Served by the relay. */
  publicKey: string | null
  /** This user's own devices. Never anybody else's. */
  devices: PushDevice[]
  /**
   * Whether the relay can scope the clock feed — read BEFORE anybody presses
   * the switch.
   *
   * The gate that uses this used to fire only on the attempt, as a toast that
   * then disappeared. Somebody with no clock permission saw a switch, pressed
   * it, got a wall of text about Cloudflare and had nothing left on screen to
   * show anyone. Stating it up front is the difference between a screen that
   * explains itself and one that has to be provoked into it.
   */
  clockScope: ClockScopeAnswer
  /** What the relay actually said, when it said something unexpected. */
  clockScopeDetail: string | null
}

/**
 * What to tell somebody who cannot be enrolled because of the relay.
 *
 * `entitled` is whether they have the clock permission. Somebody who HAS it is
 * never blocked by this gate — they are entitled to the feed, so a relay that
 * cannot filter it is not a problem for them — which means every reader of this
 * message is somebody the relay would over-notify.
 */
export function clockScopeBlockMessage(answer: ClockScopeAnswer, detail: string | null): string {
  if (answer === 'no') {
    return (
      'The cloud relay is running an older version of its code that cannot keep clock-in alerts ' +
      'off this device, so notifications cannot be switched on here yet. Whoever set up the ' +
      'relay needs to re-paste cloud/worker.js in the Cloudflare dashboard (Worker → Edit code ' +
      '→ select all → paste → Deploy). The app is ready and waiting for it.'
    )
  }
  // NOT "it is out of date" — we do not know that, and saying it sent somebody
  // to paste a file that was already correct.
  return (
    'The app could not reach the cloud relay to check what it supports, so it will not enrol ' +
    'this device yet — on a relay that cannot filter the clock feed, switching notifications on ' +
    'would subscribe this phone to every clock-in in the building. Check the relay address and ' +
    'key under Admin → Developer → Cloud sync.' + (detail ? ` The relay said: ${detail}` : '')
  )
}
