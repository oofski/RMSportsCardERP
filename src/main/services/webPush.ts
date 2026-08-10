import type { ClockPushState, PushDevice, PushSubscriptionInput } from '@shared/webPush'
import { call, getSyncConfig } from './cloudSync'

/**
 * The app's half of clock-in push notifications: forwarding, and nothing else.
 *
 * Every byte of cryptography is in cloud/worker.js. This file exists because of
 * a credential asymmetry:
 *
 *   · A phone has a SESSION. It must never have the relay's shared key — that
 *     key reads and writes the entire company, and it is not going in a browser.
 *   · The relay has the VAPID PRIVATE KEY. It must never leave Cloudflare.
 *
 * So a subscription travels browser → app (session, permission check) → relay
 * (shared key), which is the same path every other operation already takes.
 *
 * Everything here fails soft on purpose. A build with no relay configured — a
 * standalone laptop — must show a screen that explains that, not one that
 * throws; and a relay that is briefly unreachable must not make the Admin module
 * unopenable.
 */

interface RelayKeyReply {
  ok?: boolean
  configured?: boolean
  publicKey?: string | null
  subject?: string | null
  problem?: string | null
}

function relayConfigured(): boolean {
  // syncStatus() already computes this, but importing it would pull the whole
  // sync loop's state in for one boolean. The address is the question.
  return getSyncConfig().url.trim().length > 0
}

const NO_RELAY =
  'This copy of the app is not connected to the cloud relay, and the relay is what sends ' +
  'notifications. Set it up under Admin → Developer → Cloud sync.'

/**
 * What the notifications screen renders, in one call.
 *
 * The device list is scoped to ONE employee by the caller and the relay filters
 * on it server-side. Nobody sees whose phones are registered but their own —
 * "who is being notified" is a fact about a colleague's phone, and this screen
 * has no reason to answer it.
 */
export async function clockPushState(employeeId: string): Promise<ClockPushState> {
  if (!relayConfigured()) {
    return { relayConfigured: false, ready: false, problem: NO_RELAY, publicKey: null, devices: [] }
  }
  try {
    const key = (await call('/v1/push-notify/key', { method: 'GET' })) as RelayKeyReply
    const list = (await call(
      `/v1/push-notify/list?employeeId=${encodeURIComponent(employeeId)}`,
      { method: 'GET' }
    )) as { devices?: PushDevice[] }
    return {
      relayConfigured: true,
      ready: key.configured === true,
      problem: key.configured === true ? null : (key.problem ?? 'The relay cannot sign notifications.'),
      publicKey: key.publicKey ?? null,
      devices: Array.isArray(list.devices) ? list.devices : []
    }
  } catch (err) {
    // A relay that cannot be reached right now is a fact to display, not an
    // exception to throw at a screen somebody opened to read a toggle.
    return {
      relayConfigured: true,
      ready: false,
      problem: err instanceof Error ? err.message : String(err),
      publicKey: null,
      devices: []
    }
  }
}

export async function subscribeToClockPush(
  employeeId: string,
  input: PushSubscriptionInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!relayConfigured()) return { ok: false, error: NO_RELAY }
  try {
    await call('/v1/push-notify/subscribe', {
      method: 'POST',
      body: {
        employeeId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        label: input.label ?? null
      }
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Take a device off the list.
 *
 * Keyed by the endpoint the browser holds rather than by the hashed id the
 * screen shows, because the browser is the only party that reliably knows which
 * subscription is ITS OWN — and unsubscribing the wrong row would silently stop
 * somebody else's notifications.
 */
export async function unsubscribeFromClockPush(
  endpoint: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!relayConfigured()) return { ok: false, error: NO_RELAY }
  try {
    await call('/v1/push-notify/unsubscribe', { method: 'POST', body: { endpoint } })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Send yourself one, now.
 *
 * The only way to find out whether the chain works without waiting for somebody
 * to start a shift. Everything between the toggle and a phone buzzing is
 * invisible — the key pair, the row, the JWT, the encryption, the push service
 * — so without this the first evidence any of it is misconfigured arrives at 7am
 * on a Monday.
 */
export async function testClockPush(
  employeeId: string,
  name: string
): Promise<{ ok: boolean; error?: string; sent?: number; dropped?: number; failed?: number }> {
  if (!relayConfigured()) return { ok: false, error: NO_RELAY }
  try {
    const reply = (await call('/v1/push-notify/test', {
      method: 'POST',
      body: { employeeId, name }
    })) as { ok?: boolean; sent?: number; dropped?: number; failed?: number; error?: string }
    return {
      ok: reply.ok === true,
      error: reply.error,
      sent: reply.sent,
      dropped: reply.dropped,
      failed: reply.failed
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
