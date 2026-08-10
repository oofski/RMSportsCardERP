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
}
