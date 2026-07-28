/**
 * Streaming IPC.
 *
 * Thin: every handler checks one permission, coerces its input and calls
 * db/streaming.ts. No SQL, no stock logic and no derivation here.
 *
 * Reads are gated on 'module.streaming' and resolve to an EMPTY value (null /
 * [] / an empty month) when the caller lacks it, matching the other read
 * handlers — the UI shows its permission empty state rather than an error.
 * Every mutation is gated on 'streaming.manage' and returns Result<T>, because
 * each one of them moves real stock.
 *
 * The mutations that touch a session return the freshly derived session (or its
 * detail), so a screen can reconcile without a refetch.
 */
import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type {
  NewStreamItem,
  NewStreamSession,
  StreamCalendarMonth,
  StreamSession,
  StreamSessionDetail,
  UpdateStreamSession
} from '@shared/streaming'
import {
  addItem,
  calendarMonth,
  createSession,
  deleteSession,
  endSession,
  getActiveSession,
  getSessionDetail,
  listSessions,
  removeItem,
  startSession,
  updateSession
} from './db/streaming'
import { currentUser } from './services/auth'

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

/** Every write in this module goes through here. */
function requireManage(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('streaming.manage')) {
    throw new Error('You do not have permission to manage streams.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** A month with no activity, which is also what "you may not see this" looks
 * like — the renderer draws the same empty grid either way. */
function emptyMonth(month: string): StreamCalendarMonth {
  return {
    month,
    days: [],
    totals: {
      breakLines: 0,
      breakUnits: 0,
      breakCost: 0,
      giveawayLines: 0,
      giveawayUnits: 0,
      giveawayCost: 0,
      totalCost: 0,
      sessionCount: 0,
      minutes: 0
    }
  }
}

export function registerStreamingIpc(): void {
  // ---- Reads (module.streaming) -------------------------------------------
  ipcMain.handle(IPC.streamActive, (): StreamSession | null =>
    can('module.streaming') ? getActiveSession() : null
  )

  ipcMain.handle(IPC.streamCalendar, (_e, month: string): StreamCalendarMonth => {
    const key = str(month).trim()
    return can('module.streaming') ? calendarMonth(key) : emptyMonth(key)
  })

  ipcMain.handle(IPC.streamList, (_e, payload: { from: string; to: string }): StreamSession[] => {
    if (!can('module.streaming')) return []
    const from = str(payload?.from).trim()
    const to = str(payload?.to).trim()
    if (!from || !to) return []
    return listSessions(from, to)
  })

  ipcMain.handle(IPC.streamGet, (_e, id: string): StreamSessionDetail | null =>
    can('module.streaming') ? getSessionDetail(str(id).trim()) : null
  )

  // ---- Writes (streaming.manage) ------------------------------------------
  ipcMain.handle(
    IPC.streamStart,
    (_e, input: { title: string; hostId: string | null; note: string | null }): Result<StreamSession> => {
      try {
        const actor = requireManage()
        return startSession(
          {
            title: str(input?.title),
            hostId: str(input?.hostId).trim() || null,
            note: str(input?.note).trim() || null
          },
          actor.id
        )
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.streamEnd, (_e, id: string): Result<StreamSession> => {
    try {
      const actor = requireManage()
      return endSession(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.streamCreate, (_e, input: NewStreamSession): Result<StreamSession> => {
    try {
      const actor = requireManage()
      return createSession(
        {
          title: str(input?.title),
          startedAt: str(input?.startedAt),
          endedAt: str(input?.endedAt).trim() || null,
          hostId: str(input?.hostId).trim() || null,
          note: str(input?.note).trim() || null
        },
        actor.id
      )
    } catch (err) {
      return fail(err)
    }
  })

  /**
   * Passes each field through ONLY when the caller sent it: `undefined` means
   * "leave it alone" and `null` means "clear it", and collapsing the two would
   * make every partial edit silently blank the fields it didn't mention.
   */
  ipcMain.handle(IPC.streamUpdate, (_e, input: UpdateStreamSession): Result<StreamSession> => {
    try {
      const actor = requireManage()
      const patch: UpdateStreamSession = { id: str(input?.id).trim() }
      if (input?.title !== undefined) patch.title = str(input.title)
      if (input?.startedAt !== undefined) patch.startedAt = str(input.startedAt)
      if (input?.endedAt !== undefined) patch.endedAt = str(input.endedAt).trim() || null
      if (input?.hostId !== undefined) patch.hostId = str(input.hostId).trim() || null
      if (input?.note !== undefined) patch.note = str(input.note).trim() || null
      return updateSession(patch, actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.streamDelete, (_e, id: string): Result => {
    try {
      const actor = requireManage()
      return deleteSession(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.streamItemAdd, (_e, input: NewStreamItem): Result<StreamSessionDetail> => {
    try {
      const actor = requireManage()
      return addItem(input, actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.streamItemRemove, (_e, id: string): Result<StreamSessionDetail> => {
    try {
      const actor = requireManage()
      return removeItem(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })
}
