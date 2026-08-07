import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { StaffBoard } from '@shared/staffBoard'
import type {
  Availability,
  AvailabilityWithPerson,
  NewAvailability,
  NewShift,
  Shift,
  ShiftWithPerson
} from '@shared/schedule'
import { currentUser } from './services/auth'
import { getStaffBoard } from './db/staffBoard'
import {
  clearAvailability,
  copyWeek,
  createShift,
  deleteShift,
  listAvailability,
  listShifts,
  myAvailability,
  myShifts,
  setAvailability
} from './db/schedule'

/**
 * The floor's board, the rota, and availability.
 *
 * ## Three access rules, and they are not the same rule
 *
 * YOUR OWN — the staff board, your shifts, your availability. Gated on nothing
 * but being signed in, because there is nothing here to gate: it is yours. What
 * IS load-bearing is that the employee comes from the SESSION on every one of
 * these and is never taken from the payload. There is deliberately no operation
 * anywhere that reads or writes a NAMED person's shifts or availability —
 * that is the shape where somebody eventually forgets the filter.
 *
 * THE TEAM'S — everybody's rota, everybody's availability. `admin.hours.view`,
 * the same gate as the team timesheet: somebody who may not see who worked has
 * no business seeing who is due in or who said they are away next week.
 *
 * CHANGING THE ROTA — `admin.employees.manage`. Putting somebody on a shift is
 * a statement about their week, and the set of people who may make it is the
 * set who may hire them. Note the asymmetry with availability, which anybody
 * may write for themselves: saying when you can work is not a privilege, and a
 * system that made it one would simply go back to being text messages.
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

function requireRoster(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('admin.employees.manage')) {
    throw new Error('Only a lead can change the rota.')
  }
  return { id: user.id }
}

function fail(err: unknown): Result<never> {
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

export function registerScheduleIpc(): void {
  // The floor's board. Same access model as the owner's: assembled from what the
  // caller can already open, and scoped to them by the session rather than by an
  // argument. `hours` and `shifts` are theirs by construction, so there is no
  // permission on them — a packer checking their own fortnight is not an
  // administrative act.
  ipcMain.handle(IPC.staffBoard, (): StaffBoard | null => {
    const user = currentUser()
    if (!user) return null
    return getStaffBoard({ fulfillment: can('module.fulfillment'), viewerId: user.id })
  })

  // ---- The rota -----------------------------------------------------------
  ipcMain.handle(IPC.scheduleMine, (): Shift[] => {
    const user = currentUser()
    return user ? myShifts(user.id) : []
  })

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

  // ---- Availability -------------------------------------------------------
  //
  // WRITING is yours and needs no permission. Reading the TEAM's is the lead's
  // view and needs the same gate as the rota it is read against — there is no
  // point collecting answers nobody building next week can see, and no reason a
  // packer should be able to read everyone else's days off.
  ipcMain.handle(IPC.availabilityMine, (): Availability[] => {
    const user = currentUser()
    return user ? myAvailability(user.id) : []
  })

  ipcMain.handle(
    IPC.availabilityList,
    (_e, payload: { from?: unknown; to?: unknown }): AvailabilityWithPerson[] => {
      if (!can('admin.hours.view')) return []
      return listAvailability(str(payload?.from), str(payload?.to))
    }
  )

  ipcMain.handle(IPC.availabilitySet, (_e, payload: NewAvailability): Result<Availability> => {
    try {
      const actor = requireUser()
      return {
        ok: true,
        data: setAvailability(actor.id, {
          day: str(payload?.day),
          status: payload?.status === 'available' ? 'available' : 'unavailable',
          startTime: payload?.startTime ? str(payload.startTime) : null,
          endTime: payload?.endTime ? str(payload.endTime) : null,
          note: payload?.note ? str(payload.note) : null
        })
      }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.availabilityClear, (_e, day: unknown): Result<{ day: string }> => {
    try {
      const actor = requireUser()
      const target = str(day)
      if (!clearAvailability(actor.id, target)) {
        return { ok: false, error: 'You had not said anything about that day.' }
      }
      return { ok: true, data: { day: target } }
    } catch (err) {
      return fail(err)
    }
  })
}
