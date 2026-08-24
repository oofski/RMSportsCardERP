import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type { StaffBoard } from '@shared/staffBoard'
import type {
  Availability,
  AvailabilityPattern,
  EffectiveAvailabilityWithPerson,
  NewAvailability,
  NewShift,
  PatternDayInput,
  Shift,
  ShiftWithPerson,
  TeamScheduleOverview
} from '@shared/schedule'
import { currentUser } from './services/auth'
import { getStaffBoard } from './db/staffBoard'
import {
  clearAvailability,
  clearPattern,
  copyWeek,
  createShift,
  deleteShift,
  listEffectiveAvailability,
  listShifts,
  myAvailability,
  myPattern,
  myShifts,
  publishShifts,
  setAvailability,
  setPattern,
  teamScheduleOverview,
  unpublishedShifts
} from './db/schedule'
import { notifyMessage } from './services/webPush'
import { describeOwnWeek, ownWeekTitle } from '@shared/schedule'

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

  /**
   * What a week still owes the floor. A pure READ, so the button can carry a
   * count without anybody pressing it.
   */
  ipcMain.handle(
    IPC.schedulePending,
    (_e, payload: { from?: unknown; to?: unknown }): ShiftWithPerson[] => {
      if (!can('admin.hours.view')) return []
      return unpublishedShifts(str(payload?.from), str(payload?.to))
    }
  )

  /**
   * Publish a week: make it visible to the people on it, and tell them.
   *
   * ## The stamp goes down FIRST, and the phones come second
   *
   * Same ordering as a message being sent, and for the same reason. Publishing
   * is the fact — it is what puts the week on everybody's own screen — and a
   * notification is a doorbell. A relay that is down, a VAPID key that has not
   * been pasted, a phone that unsubscribed last week: none of those should mean
   * the rota fails to publish, because the rota is on every device that syncs
   * regardless and the floor can open the app and read it.
   *
   * So `notifyMessage` never throws, whatever it finds, and its trouble comes
   * back as a SENTENCE beside a successful publish rather than as an error that
   * would undo one.
   *
   * ## One message per person, about their own week
   *
   * Not a broadcast. A packer does not need to know that four other people were
   * rostered, and a notification listing the whole floor is one nobody reads to
   * the end — which is exactly where their own Thursday would be. The body is
   * their days and their times and nothing else.
   */
  ipcMain.handle(
    IPC.schedulePublish,
    async (
      _e,
      payload: { from?: unknown; to?: unknown }
    ): Promise<
      Result<{ published: number; people: number; notified: number; problem: string | null }>
    > => {
      try {
        requireRoster()
        const from = str(payload?.from)
        const to = str(payload?.to)
        const published = publishShifts(from, to)
        if (published.length === 0) {
          return { ok: true, data: { published: 0, people: 0, notified: 0, problem: null } }
        }

        const byPerson = new Map<string, ShiftWithPerson[]>()
        for (const shift of published) {
          const list = byPerson.get(shift.employeeId)
          if (list) list.push(shift)
          else byPerson.set(shift.employeeId, [shift])
        }

        // Sent one at a time rather than as one call with everybody's ids,
        // because the whole point is that each body is different. The relay
        // route takes a list because a message goes to a thread; a rota goes to
        // a person.
        let notified = 0
        let problem: string | null = null
        for (const [employeeId, shifts] of byPerson) {
          const result = await notifyMessage({
            employeeIds: [employeeId],
            // The DATE first, then what happened — see ownWeekTitle. The span
            // is this person's own days, not the week the lead published: most
            // people are not on all seven of them.
            title: ownWeekTitle(shifts),
            body: describeOwnWeek(shifts),
            // No thread to open — this is not a conversation. The service
            // worker treats a blank id as "just open the app", which lands on
            // the board with the schedule one tap away.
            threadId: ''
          })
          notified += result.notified
          problem = problem ?? result.problem
        }

        return {
          ok: true,
          data: { published: published.length, people: byPerson.size, notified, problem }
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

  // EFFECTIVE, not raw. A lead building next week wants the answer for each day,
  // and most of those answers come from somebody's usual week rather than a row
  // they tapped — returning only the dated rows would show a blank week for a
  // person who set their Mondays months ago and has not touched a date since.
  // Each row carries `source` so the screen can still tell the two apart.
  ipcMain.handle(
    IPC.availabilityList,
    (_e, payload: { from?: unknown; to?: unknown }): EffectiveAvailabilityWithPerson[] => {
      if (!can('admin.hours.view')) return []
      return listEffectiveAvailability(str(payload?.from), str(payload?.to))
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

  // ---- The usual week ------------------------------------------------------
  //
  // Same rule as everything else here: the employee is the SESSION's, never a
  // payload's. There is no operation that reads or writes a named person's week.
  ipcMain.handle(IPC.patternMine, (): AvailabilityPattern[] => {
    const user = currentUser()
    return user ? myPattern(user.id) : []
  })

  ipcMain.handle(
    IPC.patternSet,
    (_e, payload: { days?: unknown }): Result<AvailabilityPattern[]> => {
      try {
        const actor = requireUser()
        const raw = Array.isArray(payload?.days) ? payload.days : []
        const days: PatternDayInput[] = raw.map((d: Record<string, unknown>) => ({
          weekday: Number(d?.weekday),
          // Anything that is not one of the two answers CLEARS the day. Silence
          // about Tuesday and "I cannot work Tuesday" are different claims, and
          // a malformed value must not be promoted into the second one.
          status:
            d?.status === 'available'
              ? 'available'
              : d?.status === 'unavailable'
                ? 'unavailable'
                : null,
          startTime: d?.startTime ? str(d.startTime) : null,
          endTime: d?.endTime ? str(d.endTime) : null,
          note: d?.note ? str(d.note) : null
        }))
        return { ok: true, data: setPattern(actor.id, days) }
      } catch (err) {
        return fail(err)
      }
    }
  )

  // The lead's oversight read. Same gate as the team timesheet and the team
  // rota: somebody who may not see who worked has no business seeing who said
  // they are away next week. Returns an EMPTY overview rather than null so the
  // screen has one shape to render — a null here would mean every field on the
  // tab needs a second branch for a case that only arises if it is opened by
  // somebody who cannot see it.
  ipcMain.handle(
    IPC.scheduleTeamOverview,
    (_e, payload: { from?: unknown; to?: unknown }): TeamScheduleOverview => {
      const from = str(payload?.from)
      const to = str(payload?.to)
      if (!can('admin.hours.view')) return { from, to, people: [], days: [] }
      return teamScheduleOverview(from, to)
    }
  )

  ipcMain.handle(IPC.patternClear, (): Result<{ cleared: number }> => {
    try {
      const actor = requireUser()
      return { ok: true, data: { cleared: clearPattern(actor.id) } }
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
