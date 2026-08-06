import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type {
  IntakeLink,
  IntakeLinkInput,
  IntakeStatus,
  IntakeSubmission,
  SyncConfig,
  SyncReject,
  SyncStatus
} from '@shared/sync'
import { currentUser } from './services/auth'
import {
  seedRelay,
  setSyncConfig,
  syncNow,
  syncStatus,
  testConnection,
  type RoundResult
} from './services/cloudSync'
import { clearRejects, listRejects, stockDrift } from './db/sync'
import {
  acceptIntakeSubmission,
  createIntakeLink,
  listIntakeLinks,
  listIntakeSubmissions,
  rejectIntakeSubmission,
  setIntakeLinkActive
} from './db/intake'

/**
 * Operations for cloud sync and the public intake form.
 *
 * Sync configuration is gated on admin.access rather than on a permission of
 * its own: pointing the app at a different relay, or handing it a different
 * key, decides which company's data this machine reads and writes. That is the
 * same class of decision as managing roles, so it sits behind the same gate.
 *
 * The intake form is gated on shipping.manage — the submissions become shipping
 * customers, and the people who run breaks are the people who should be reading
 * them.
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

export function registerSyncIpc(): void {
  // ---- Status -------------------------------------------------------------
  // Readable by anyone signed in. A person who cannot see whether the app is
  // connected cannot tell the difference between "nothing has happened" and
  // "nothing has reached me", and will act on stale numbers believing they are
  // current. The status carries no business data.
  ipcMain.handle(IPC.syncStatus, (): SyncStatus => {
    const status = syncStatus()
    // The last four characters of the shared key are shown so an administrator
    // can tell WHICH key is installed without revealing it. Everyone else gets
    // "a key is set" and nothing more: on a laptop the only reader was the
    // machine's owner, but this server answers a dozen people over the public
    // internet, and four characters of a bearer token is four characters more
    // than a packer needs.
    const user = currentUser()
    if (user?.permissions.includes('admin.access')) return status
    return { ...status, config: { ...status.config, keyHint: '' } }
  })

  ipcMain.handle(
    IPC.syncConfigure,
    (_e, update: Partial<SyncConfig> & { key?: string }): Result<SyncStatus> => {
      try {
        requirePermission('admin.access')
        return { ok: true, data: setSyncConfig(update) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.syncTest, async (): Promise<Result<{ rows: number }>> => {
    try {
      requirePermission('admin.access')
      const result = await testConnection()
      if (!result.ok) return { ok: false, error: result.error ?? 'Could not reach the relay.' }
      return { ok: true, data: { rows: result.rows ?? 0 } }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.syncNow, async (): Promise<Result<RoundResult>> => {
    try {
      requirePermission('admin.access')
      const result = await syncNow()
      if (!result.ok) return { ok: false, error: result.error ?? 'Sync failed.' }
      return { ok: true, data: result.result as RoundResult }
    } catch (err) {
      return fail(err)
    }
  })

  // Queues the whole database for upload. Done once, from the machine holding
  // the real data — see seedRelay().
  ipcMain.handle(IPC.syncSeed, (): Result<{ queued: number }> => {
    try {
      requirePermission('admin.access')
      return { ok: true, data: seedRelay() }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.syncRejects, (): SyncReject[] => {
    const user = currentUser()
    if (!user || !user.permissions.includes('admin.access')) return []
    return listRejects()
  })

  ipcMain.handle(IPC.syncClearRejects, (): Result<{ cleared: number }> => {
    try {
      requirePermission('admin.access')
      return { ok: true, data: { cleared: clearRejects() } }
    } catch (err) {
      return fail(err)
    }
  })

  // Products whose on-hand quantity and lots disagree — the fingerprint of two
  // people having done contradictory things to the same product while offline.
  ipcMain.handle(
    IPC.syncDrift,
    (): Array<{ productId: string; location: string; stock: number; lots: number }> => {
      const user = currentUser()
      if (!user || !user.permissions.includes('inventory.manage')) return []
      return stockDrift()
    }
  )

  // ---- Public intake form -------------------------------------------------
  ipcMain.handle(IPC.intakeLinks, (): IntakeLink[] => {
    const user = currentUser()
    if (!user || !user.permissions.includes('shipping.manage')) return []
    return listIntakeLinks()
  })

  ipcMain.handle(
    IPC.intakeLinkCreate,
    (_e, input: IntakeLinkInput): Result<IntakeLink> => {
      try {
        const actor = requirePermission('shipping.manage')
        return { ok: true, data: createIntakeLink(input, actor.id) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.intakeLinkSetActive,
    (_e, payload: { id: string; active: boolean }): Result<{ id: string }> => {
      try {
        requirePermission('shipping.manage')
        if (!setIntakeLinkActive(payload.id, payload.active)) {
          return { ok: false, error: 'That link no longer exists.' }
        }
        return { ok: true, data: { id: payload.id } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.intakeSubmissions, (_e, status?: IntakeStatus): IntakeSubmission[] => {
    const user = currentUser()
    if (!user || !user.permissions.includes('shipping.manage')) return []
    return listIntakeSubmissions(status)
  })

  ipcMain.handle(IPC.intakeAccept, (_e, id: string): Result<IntakeSubmission> => {
    try {
      const actor = requirePermission('shipping.manage')
      const result = acceptIntakeSubmission(id, actor.id)
      if (!result.ok) return { ok: false, error: result.error ?? 'Could not accept that.' }
      return { ok: true, data: result.submission as IntakeSubmission }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.intakeReject,
    (_e, payload: { id: string; note: string }): Result<IntakeSubmission> => {
      try {
        const actor = requirePermission('shipping.manage')
        const result = rejectIntakeSubmission(payload.id, payload.note ?? '', actor.id)
        if (!result.ok) return { ok: false, error: result.error ?? 'Could not reject that.' }
        return { ok: true, data: result.submission as IntakeSubmission }
      } catch (err) {
        return fail(err)
      }
    }
  )
}
