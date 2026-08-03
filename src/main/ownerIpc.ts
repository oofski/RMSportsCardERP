import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { NewReminder, OwnerBoard, Reminder } from '@shared/ownerDashboard'
import { currentUser } from './services/auth'
import { getOwnerBoard } from './db/ownerDashboard'
import {
  createReminder,
  deleteReminder,
  listReminders,
  setReminderStatus
} from './db/reminders'

/**
 * The owner's home board, and the inbox that feeds it.
 *
 * ## Who sees what
 *
 * The board is assembled from whichever modules the CALLER can already open, so
 * it can never become a side door onto a number somebody is not allowed to see.
 * Operations opening it gets the sections their permissions already cover and
 * nulls for the rest; the owner has every permission, so the owner gets all of
 * it. That is the whole access model — no separate "owner board" permission to
 * keep in step with the module list, and nothing to forget when a module is
 * added.
 *
 * ## Reminders are asymmetric on purpose
 *
 * ANYONE signed in may write one. The failure mode of a staff-to-owner inbox is
 * silence — a note somebody has to request permission to send is a note that
 * does not get sent — and the worst case is a message the owner ticks off.
 * Reading and clearing need `admin.access`, because it is the owner's inbox and
 * the floor should not be reading it.
 */

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

function requireUser(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  return { id: user.id }
}

function requireInbox(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('admin.access')) {
    throw new Error('Reminders are the owner’s inbox.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function registerOwnerIpc(): void {
  ipcMain.handle(IPC.ownerBoard, (): OwnerBoard | null => {
    if (!currentUser()) return null
    return getOwnerBoard({
      finance: can('module.finance'),
      invoicing: can('module.invoicing'),
      inventory: can('module.inventory'),
      streaming: can('module.streaming')
    })
  })

  ipcMain.handle(IPC.remindersList, (): Reminder[] => (can('admin.access') ? listReminders() : []))

  ipcMain.handle(
    IPC.remindersCreate,
    (_e, payload: NewReminder): Result<Reminder> => {
      try {
        const actor = requireUser()
        const res = createReminder(
          {
            body: str(payload?.body),
            dueDate: payload?.dueDate ? str(payload.dueDate) : null,
            urgent: payload?.urgent === true
          },
          actor.id
        )
        if (!res.reminder) return { ok: false, error: res.error ?? 'Could not send that.' }
        return { ok: true, data: res.reminder }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    IPC.remindersSetStatus,
    (_e, payload: { id?: unknown; status?: unknown }): Result<Reminder> => {
      try {
        const actor = requireInbox()
        const res = setReminderStatus(
          str(payload?.id),
          payload?.status === 'done' ? 'done' : 'open',
          actor.id
        )
        if (!res.reminder) return { ok: false, error: res.error ?? 'Could not update that.' }
        return { ok: true, data: res.reminder }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.remindersDelete, (_e, id: unknown): Result<boolean> => {
    try {
      requireInbox()
      return { ok: true, data: deleteReminder(str(id)) }
    } catch (err) {
      return fail(err)
    }
  })
}
