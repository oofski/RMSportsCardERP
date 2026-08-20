import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { ClockPushState, PushSubscriptionInput } from '@shared/webPush'
import { clockScopeBlockMessage } from '@shared/webPush'
import { currentUser } from './services/auth'
import {
  clockPushState,
  relayClockScope,
  subscribeToClockPush,
  testClockPush,
  unsubscribeFromClockPush
} from './services/webPush'

/**
 * Turning notifications on for YOURSELF, on the device in your hand.
 *
 * ## Enrolment is not a privilege; the clock feed is
 *
 * These two used to be one thing, and gating them together was a bug that only
 * became visible once messages started arriving this way. `notifications.clock`
 * is held by owners and operations alone, so every other role — staff, the
 * packing bench, breakers — could not register a phone AT ALL. Not "could not
 * see punches": could not receive anything. The messaging feature shipped into
 * a floor that was structurally unreachable.
 *
 * So the gate moved. Registering a device now needs nothing but being signed in,
 * because it is your device, your browser permission prompt and your consent,
 * and nothing about it discloses anybody else. What `notifications.clock` still
 * decides is whether the CLOCK FEED — a live account of when named colleagues
 * start and finish work — is delivered to that device. That is the privacy
 * boundary it was always about, and it is now enforced where the fan-out
 * happens: the flag rides along on subscribe and the relay filters on it. See
 * `addClockOkColumn` in cloud/worker.js.
 *
 * Every operation here acts on the CALLER and only on the caller. There is no
 * "subscribe Dana's phone" and no "list everyone's devices": the relay filters
 * by employee id and the id comes from the session, never from an argument. A
 * screen that could enumerate whose phones are registered would be answering a
 * question about a colleague's device that nobody needs answered.
 */

class PermissionError extends Error {}

function requireSignedIn(): { id: string; permissions: Permission[] } {
  const user = currentUser()
  if (!user) throw new PermissionError('You are not signed in.')
  return user
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export function registerPushIpc(): void {
  ipcMain.handle(IPC.pushState, async (): Promise<ClockPushState> => {
    const user = currentUser()
    if (!user) {
      // Not an error. A thrown rejection here would be a red toast on a tab
      // somebody merely has open when their session ends underneath them.
      return {
        relayConfigured: false,
        ready: false,
        problem: 'You are not signed in.',
        publicKey: null,
        devices: [],
        clockScope: 'unknown',
        clockScopeDetail: null
      }
    }
    // Scoped to the caller by the id, which comes from the session. The relay's
    // list route filters on it, so this can only ever return your own devices.
    return clockPushState(user.id)
  })

  ipcMain.handle(
    IPC.pushSubscribe,
    async (_e, input: PushSubscriptionInput): Promise<Result<{ ok: true }>> => {
      try {
        const actor = requireSignedIn()
        // Read from the SESSION, never from the renderer. The flag decides
        // whether this device joins the clock feed, so a value posted by the
        // page would be a permission the page granted itself.
        const clock = actor.permissions.includes('notifications.clock')
        // FAIL CLOSED ACROSS THE DEPLOY BOUNDARY.
        //
        // This app ships on every push; the relay ships when somebody pastes
        // cloud/worker.js into Cloudflare. Between the two there is a window
        // where this build sends `clock: false` to a relay that has never heard
        // of the field — which drops it, keeps no column for it, and fans every
        // punch out to every subscription it holds. Enrolling somebody there is
        // not "notifications on with the clock feed off"; it IS the clock feed.
        //
        // So an unentitled device is refused until the relay can prove it will
        // honour the flag. The cost is somebody waiting for a paste. The
        // alternative cost is the floor holding a live record of when everybody
        // works, with nothing on any screen to show it happened.
        if (!clock) {
          const scope = await relayClockScope()
          if (scope.answer !== 'yes') {
            return { ok: false, error: clockScopeBlockMessage(scope.answer, scope.detail) }
          }
        }
        const result = await subscribeToClockPush(actor.id, input, clock)
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, data: { ok: true } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Deliberately NOT permission-gated the way subscribing is.
  //
  // Somebody whose permission was taken away, or who is being switched off,
  // still has a phone that will keep buzzing until its row is deleted — and the
  // browser is the only party that knows its own endpoint. Refusing to let them
  // turn it off would leave the notifications running with no way to stop them,
  // which is worse than the thing the gate protects. Signed in is enough.
  ipcMain.handle(
    IPC.pushUnsubscribe,
    async (_e, endpoint: string): Promise<Result<{ ok: true }>> => {
      try {
        if (!currentUser()) throw new PermissionError('You are not signed in.')
        const result = await unsubscribeFromClockPush(String(endpoint ?? ''))
        if (!result.ok) return { ok: false, error: result.error }
        return { ok: true, data: { ok: true } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.pushTest,
    async (): Promise<Result<{ sent: number; dropped: number; failed: number }>> => {
      try {
        // Signed in is enough: a test goes to the caller's OWN devices and
        // nowhere else, and somebody who has just switched notifications on
        // needs to be able to prove it worked. Refusing the proof to the people
        // most likely to be standing in a warehouse wondering why their phone is
        // silent would be exactly backwards.
        const actor = requireSignedIn()
        const result = await testClockPush(actor.id, 'Test notification')
        if (!result.ok) return { ok: false, error: result.error ?? 'Nothing was delivered.' }
        return {
          ok: true,
          data: { sent: result.sent ?? 0, dropped: result.dropped ?? 0, failed: result.failed ?? 0 }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )
}
