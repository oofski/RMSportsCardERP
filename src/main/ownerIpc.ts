import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { NewReminder, OwnerBoard, Reminder, Todo } from '@shared/ownerDashboard'
import type { StaffBoard } from '@shared/staffBoard'
import type { NewShift, Shift, ShiftWithPerson } from '@shared/schedule'
import { currentUser } from './services/auth'
import { getOwnerBoard } from './db/ownerDashboard'
import { getStaffBoard } from './db/staffBoard'
import { copyWeek, createShift, deleteShift, listShifts, myShifts } from './db/schedule'
import {
  createReminder,
  deleteReminder,
  listReminders,
  setReminderStatus
} from './db/reminders'
import { clearDoneTodos, createTodo, deleteTodo, listTodos, setTodoDone } from './db/todos'
import {
  completeRecurring,
  createRecurring,
  deleteRecurring,
  listRecurring,
  myHours
} from './db/homeTasks'
import type { RecurringTask } from '@shared/homeTasks'

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

/**
 * Whoever may change the rota.
 *
 * The same permission that adds and edits people, deliberately: putting
 * somebody on a shift is a statement about their week, and the set of people
 * who may make it is the set who may hire them.
 */
function requireRoster(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('admin.employees.manage')) {
    throw new Error('Only a lead can change the rota.')
  }
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
      streaming: can('module.streaming'),
      fulfillment: can('module.fulfillment'),
      // The team's hours, not the caller's own. Somebody who cannot open the
      // Hours screen has no business reading who came in this morning off the
      // home page — the same boundary, stated in the same place.
      hours: can('admin.hours.view'),
      // The slips-missing task needs BOTH: it is a statement about a stream
      // (streaming) that resolves by importing a slip (fulfillment). Somebody
      // who cannot do the second should not be handed the first as a job.
      viewerId: currentUser()?.id ?? null
    })
  })

  // The floor's board. Same access model as the owner's: assembled from what
  // the caller can already open, and scoped to them by the session rather than
  // by an argument. `hours` and `shifts` are theirs by construction, so there is
  // no permission on them — a packer checking their own fortnight is not an
  // administrative act.
  ipcMain.handle(IPC.staffBoard, (): StaffBoard | null => {
    const user = currentUser()
    if (!user) return null
    return getStaffBoard({ fulfillment: can('module.fulfillment'), viewerId: user.id })
  })

  // ---- The rota -----------------------------------------------------------
  //
  // Reading YOUR OWN needs nothing but a session, and the employee is the
  // session's — there is no channel here that reads a named person's shifts.
  ipcMain.handle(IPC.scheduleMine, (): Shift[] => {
    const user = currentUser()
    return user ? myShifts(user.id) : []
  })

  // The team's rota. Same gate as the team timesheet it sits beside: somebody
  // who cannot see who worked has no business seeing who is due in.
  ipcMain.handle(
    IPC.scheduleList,
    (_e, payload: { from?: unknown; to?: unknown }): ShiftWithPerson[] => {
      if (!can('admin.hours.view')) return []
      return listShifts(str(payload?.from), str(payload?.to))
    }
  )

  ipcMain.handle(IPC.scheduleCreate, (_e, payload: NewShift): Result<Shift> => {
    try {
      const actor = requireRoster()
      return {
        ok: true,
        data: createShift(
          {
            employeeId: str(payload?.employeeId),
            day: str(payload?.day),
            startTime: payload?.startTime ? str(payload.startTime) : null,
            endTime: payload?.endTime ? str(payload.endTime) : null,
            note: payload?.note ? str(payload.note) : null
          },
          actor.id
        )
      }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.scheduleDelete, (_e, id: unknown): Result<{ id: string }> => {
    try {
      requireRoster()
      const target = str(id)
      if (!deleteShift(target)) return { ok: false, error: 'That shift is already gone.' }
      return { ok: true, data: { id: target } }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.scheduleCopyWeek,
    (_e, payload: { from?: unknown; to?: unknown }): Result<{ created: number }> => {
      try {
        const actor = requireRoster()
        return {
          ok: true,
          data: { created: copyWeek(str(payload?.from), str(payload?.to), actor.id) }
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.remindersList, (): Reminder[] => (can('admin.access') ? listReminders() : []))

  // ---- The caller's own to-do list ----------------------------------------
  //
  // No permission beyond being signed in, because there is nothing here to gate:
  // it is your list. What IS load-bearing is that the owner id comes from the
  // session on every single one of these and is never taken from the payload —
  // an operation that accepted "whose list" would be one typo away from letting
  // anybody read or tick anybody else's.
  ipcMain.handle(IPC.todosList, (): Todo[] => {
    const user = currentUser()
    return user ? listTodos(user.id) : []
  })

  ipcMain.handle(IPC.todoCreate, (_e, body: unknown): Result<Todo> => {
    try {
      const actor = requireUser()
      return { ok: true, data: createTodo(actor.id, str(body)) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(
    IPC.todoSetDone,
    (_e, payload: { id?: unknown; done?: unknown }): Result<Todo> => {
      try {
        const actor = requireUser()
        const todo = setTodoDone(actor.id, str(payload?.id), payload?.done !== false)
        if (!todo) return { ok: false, error: 'That task is no longer on your list.' }
        return { ok: true, data: todo }
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.todoDelete, (_e, id: unknown): Result<{ id: string }> => {
    try {
      const actor = requireUser()
      const target = str(id)
      if (!deleteTodo(actor.id, target)) {
        return { ok: false, error: 'That task is no longer on your list.' }
      }
      return { ok: true, data: { id: target } }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.todosClearDone, (): Result<{ cleared: number }> => {
    try {
      const actor = requireUser()
      return { ok: true, data: { cleared: clearDoneTodos(actor.id) } }
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Jobs on a clock ----------------------------------------------------
  ipcMain.handle(IPC.recurringList, (): RecurringTask[] => {
    const user = currentUser()
    return user ? listRecurring(user.id) : []
  })

  ipcMain.handle(
    IPC.recurringCreate,
    (_e, input: { title?: unknown; everyDays?: unknown; anchorDate?: unknown; leadDays?: unknown }): Result<RecurringTask> => {
      try {
        const actor = requireUser()
        return {
          ok: true,
          data: createRecurring(actor.id, {
            title: str(input?.title),
            everyDays: Number(input?.everyDays),
            anchorDate: str(input?.anchorDate),
            leadDays: input?.leadDays === undefined ? undefined : Number(input.leadDays)
          })
        }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // The OCCURRENCE is named by the caller, not assumed to be today. Somebody
  // ticking Wednesday's payroll on Friday has done Wednesday's, and recording
  // Friday would walk the whole series two days out of step for ever.
  ipcMain.handle(
    IPC.recurringComplete,
    (_e, payload: { id?: unknown; occurrence?: unknown }): Result<{ id: string }> => {
      try {
        const actor = requireUser()
        const id = str(payload?.id)
        if (!completeRecurring(actor.id, id, str(payload?.occurrence))) {
          return { ok: false, error: 'That job is no longer on your list.' }
        }
        return { ok: true, data: { id } }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // Somebody's own shifts. Gated on nothing but being signed in — it is their
  // own timesheet — and the employee id comes from the session, never a payload.
  ipcMain.handle(IPC.myHours, (): ReturnType<typeof myHours> | null => {
    const user = currentUser()
    return user ? myHours(user.id) : null
  })

  ipcMain.handle(IPC.recurringDelete, (_e, id: unknown): Result<{ id: string }> => {
    try {
      const actor = requireUser()
      const target = str(id)
      if (!deleteRecurring(actor.id, target)) {
        return { ok: false, error: 'That job is no longer on your list.' }
      }
      return { ok: true, data: { id: target } }
    } catch (err) {
      return fail(err)
    }
  })

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
