import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { ClockPushState, PushSubscriptionInput } from '@shared/webPush'
import { currentUser } from './services/auth'
import {
  clockPushState,
  subscribeToClockPush,
  testClockPush,
  unsubscribeFromClockPush
} from './services/webPush'

/**
 * Turning clock-in notifications on for YOURSELF.
 *
 * Gated on 'notifications.clock' — its own permission rather than admin.access,
 * because what it grants is a live feed of when named colleagues start and
 * finish work, delivered to a personal phone. That is a privacy boundary of the
 * same kind as the customer-list export, and it deserves to be grantable and
 * refusable on its own.
 *
 * Every operation here acts on the CALLER and only on the caller. There is no
 * "subscribe Dana's phone" and no "list everyone's devices": the relay filters
 * by employee id and the id comes from the session, never from an argument. A
 * screen that could enumerate whose phones are registered would be answering a
 * question about a colleague's device that nobody needs answered.
 */

class PermissionError extends Error {}

function requirePermission(permission: Permission): { id: string } {
  const user = currentUser()
  if (!user) throw new PermissionError('You are not signed in.')
  if (!user.permissions.includes(permission)) {
    throw new PermissionError('You do not have permission to do that.')
  }
  return user
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

export function registerPushIpc(): void {
  ipcMain.handle(IPC.pushState, async (): Promise<ClockPushState> => {
    const user = currentUser()
    if (!user || !user.permissions.includes('notifications.clock')) {
      // Not an error. The screen is not reachable without the permission, and a
      // thrown rejection here would be a red toast on a tab somebody merely
      // has open when their role changes underneath them.
      return {
        relayConfigured: false,
        ready: false,
        problem: 'You do not have permission to use clock notifications.',
        publicKey: null,
        devices: []
      }
    }
    return clockPushState(user.id)
  })

  ipcMain.handle(
    IPC.pushSubscribe,
    async (_e, input: PushSubscriptionInput): Promise<Result<{ ok: true }>> => {
      try {
        const actor = requirePermission('notifications.clock')
        const result = await subscribeToClockPush(actor.id, input)
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
        const actor = requirePermission('notifications.clock')
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
