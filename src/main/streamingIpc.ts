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
import { ipcMain } from './ipcRegistry'
import { IPC } from '@shared/ipc'
import { parseMoneyInput } from '@shared/streaming'
import type { Result } from '@shared/types'
import type { Permission } from '@shared/permissions'
import type {
  NewStreamItem,
  NewStreamSession,
  SetStreamItemCost,
  StreamCalendarMonth,
  StreamSession,
  StreamSessionDetail,
  UpdateStreamSession
} from '@shared/streaming'
import type { NewScheduledStream, ScheduledStream } from '@shared/streamReminders'
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
  setItemCost,
  startSession,
  updateSession
} from './db/streaming'
import {
  cancelScheduled,
  deleteScheduled,
  listScheduledBetween,
  listUpcoming,
  rescheduleStream,
  scheduleStream,
  startScheduled
} from './db/streamSchedule'
import { currentUser } from './services/auth'

function can(permission: Permission): boolean {
  const user = currentUser()
  return !!user && user.permissions.includes(permission)
}

/** Every write in this module goes through here. */
/**
 * Who may put the business on air.
 *
 * `streaming.run` on its own is the BREAKER's grant: start and end, and nothing
 * else in the module. `streaming.manage` includes it, because somebody who may
 * edit a session's costs may obviously open one — writing the narrower
 * permission into every manager's role as well would be a second place to
 * forget it.
 *
 * Deliberately separate from `requireManage`: start/end is the one write on
 * this module that does not touch money, and the rest — items, costs, deleting
 * a night — must stay with whoever runs the shows.
 */
function requireRun(): { id: string } {
  const user = currentUser()
  if (!user) throw new Error('You are not signed in.')
  if (!user.permissions.includes('streaming.run') && !user.permissions.includes('streaming.manage')) {
    throw new Error('You do not have permission to start a stream.')
  }
  return { id: user.id }
}

/** True for anyone who may see whether a stream is live — including a breaker,
 *  whose home button has to know which state it is in. */
function canSeeLive(): boolean {
  return can('module.streaming') || can('streaming.run')
}

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

/** NaN rather than 0 for junk: the db layer refuses a non-finite quantity by
 *  name, whereas a silent 0 would look like a deliberate empty entry. */
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v)
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
      giveawayLoss: 0,
      totalCost: 0,
      sessionCount: 0,
      minutes: 0
    }
  }
}

export function registerStreamingIpc(): void {
  // ---- Reads (module.streaming) -------------------------------------------
  // Readable by a breaker as well: their home page has one button, and it
  // cannot say "Start" or "End" without knowing whether a show is on.
  ipcMain.handle(IPC.streamActive, (): StreamSession | null =>
    canSeeLive() ? getActiveSession() : null
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
    (
      _e,
      input: { title: string; hostId: string | null; crew?: unknown; note: string | null }
    ): Result<StreamSession> => {
      try {
        const actor = requireRun()
        return startSession(
          {
            title: str(input?.title),
            hostId: str(input?.hostId).trim() || null,
            // Only when the caller SENT one. Passing [] for an absent field
            // would clear a host the old single-field path had just set —
            // crewFromInput reads `crew` first, and an empty array is a
            // statement rather than a silence.
            ...(Array.isArray(input?.crew) ? { crew: input.crew.map((v) => str(v)) } : {}),
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
      const actor = requireRun()
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
          ...(Array.isArray(input?.crew) ? { crew: input.crew.map((v) => str(v)) } : {}),
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
      // An ARRAY or nothing. `undefined` leaves the crew alone; `[]` clears it,
      // which is how somebody takes the last name off a show.
      if (Array.isArray(input?.crew)) patch.crew = input.crew.map((v) => str(v))
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

  /**
   * Add a line. Quantity arrives EITHER as entered units (cases + boxes for a
   * break, boxes + packs for a giveaway) OR as a raw stock-unit `quantity`.
   *
   * `undefined` and a number are kept apart deliberately: an omitted `cases` is
   * "not entered" and a `cases: 0` is "zero cases", and collapsing them would
   * turn a giveaway of four packs into a break of nothing. The conversion, and
   * every refusal, happen in db/streaming.ts against @shared/units — none of it
   * is restated here.
   *
   * `casePrice` gets the same treatment for the same reason, and is parsed
   * rather than cast: it comes off a text field, so "2,400" and "$2,400" are
   * what an operator will type and `Number()` reads neither. Anything that is
   * not a plain amount becomes NaN and db/streaming.ts refuses it by name —
   * whereas a silent 0 would book a case of Bowman at nothing and look like a
   * working feature. Neither whether a price is ALLOWED at all nor which unit it
   * is PER is decided here: the first depends on the session's date and the
   * second on the product's stock unit, and only the write can see either.
   */
  ipcMain.handle(IPC.streamItemAdd, (_e, input: NewStreamItem): Result<StreamSessionDetail> => {
    try {
      const actor = requireManage()
      const payload: NewStreamItem = {
        sessionId: str(input?.sessionId).trim(),
        kind: input?.kind === 'giveaway' ? 'giveaway' : 'break',
        productId: str(input?.productId).trim(),
        location: str(input?.location).trim(),
        breakNumber: input?.breakNumber ?? null,
        recipient: input?.recipient ?? null,
        note: input?.note ?? null
      }
      if (input?.quantity !== undefined) payload.quantity = num(input.quantity)
      if (input?.cases !== undefined && input.cases !== null) payload.cases = num(input.cases)
      if (input?.boxes !== undefined && input.boxes !== null) payload.boxes = num(input.boxes)
      if (input?.packs !== undefined && input.packs !== null) payload.packs = num(input.packs)
      if (input?.casePrice !== undefined && input.casePrice !== null) {
        payload.casePrice = parseMoneyInput(input.casePrice)
      }
      return addItem(payload, actor.id)
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

  /**
   * Say what a line cost, after the fact.
   *
   * Gated on `streaming.manage` like every other write here even though the P&L
   * is one of the two screens that offers it: what it writes is a stream line,
   * and the permission that governs a stream line is this one wherever the click
   * came from.
   *
   * The price is parsed rather than cast, for the same reason `casePrice` is: it
   * comes off a text field, so "1,250" and "$1,250" are what an operator types
   * and `Number()` reads neither. Anything that is not a plain amount becomes NaN
   * and db/streaming.ts refuses it by name — a silent 0 would look exactly like
   * the uncosted line the operator was trying to fix.
   */
  ipcMain.handle(IPC.streamItemCost, (_e, input: SetStreamItemCost): Result<StreamSessionDetail> => {
    try {
      const actor = requireManage()
      return setItemCost(
        { itemId: str(input?.itemId).trim(), unitPrice: parseMoneyInput(input?.unitPrice) },
        actor.id
      )
    } catch (err) {
      return fail(err)
    }
  })

  // ---- Scheduled shows ------------------------------------------------------
  //
  // Same gates as everything above: reads on 'module.streaming' returning an
  // empty list, writes on 'streaming.manage'. A plan is not a stock movement,
  // but it IS what makes several phones buzz an hour later, and the permission
  // that decides who may run a show is the one that decides who may announce one.
  ipcMain.handle(IPC.streamPlanList, (): ScheduledStream[] =>
    can('module.streaming') ? listUpcoming() : []
  )

  ipcMain.handle(
    IPC.streamPlanRange,
    (_e, payload: { from: string; to: string }): ScheduledStream[] => {
      if (!can('module.streaming')) return []
      const from = str(payload?.from).trim()
      const to = str(payload?.to).trim()
      if (!from || !to) return []
      return listScheduledBetween(from, to)
    }
  )

  /**
   * `startsAt` arrives from the CLIENT and is passed through unrecomputed.
   *
   * Main cannot redo the conversion: in the web build it runs on a server that
   * may sit in a different timezone than the browser where somebody typed "9:00
   * PM", and resolving the wall clock there would schedule the reminders against
   * the server's evening rather than the warehouse's. The browser is the only
   * party that knows what was meant. db/streamSchedule.ts checks the instant is
   * a plausible conversion of the pair beside it rather than trusting it blindly
   * — see `impliedZoneOffsetMinutes` for what that does and does not prove.
   */
  ipcMain.handle(IPC.streamPlanCreate, (_e, input: NewScheduledStream): Result<ScheduledStream> => {
    try {
      const actor = requireManage()
      return scheduleStream(
        {
          title: str(input?.title),
          streamDate: str(input?.streamDate).trim(),
          startTime: str(input?.startTime).trim(),
          startsAt: str(input?.startsAt).trim(),
          hostId: str(input?.hostId).trim() || null,
          note: str(input?.note).trim() || null
        },
        actor.id
      )
    } catch (err) {
      return fail(err)
    }
  })

  /** Partial, with the same undefined/null discipline the session edit uses. */
  ipcMain.handle(
    IPC.streamPlanUpdate,
    (_e, input: { id: string } & Partial<NewScheduledStream>): Result<ScheduledStream> => {
      try {
        const actor = requireManage()
        const patch: { id: string } & Partial<NewScheduledStream> = { id: str(input?.id).trim() }
        if (input?.title !== undefined) patch.title = str(input.title)
        if (input?.streamDate !== undefined) patch.streamDate = str(input.streamDate).trim()
        if (input?.startTime !== undefined) patch.startTime = str(input.startTime).trim()
        if (input?.startsAt !== undefined) patch.startsAt = str(input.startsAt).trim()
        if (input?.hostId !== undefined) patch.hostId = str(input.hostId).trim() || null
        if (input?.note !== undefined) patch.note = str(input.note).trim() || null
        return rescheduleStream(patch, actor.id)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(IPC.streamPlanCancel, (_e, id: string): Result<ScheduledStream> => {
    try {
      const actor = requireManage()
      return cancelScheduled(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.streamPlanDelete, (_e, id: string): Result => {
    try {
      const actor = requireManage()
      return deleteScheduled(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle(IPC.streamPlanStart, (_e, id: string): Result<{ sessionId: string }> => {
    try {
      const actor = requireManage()
      return startScheduled(str(id).trim(), actor.id)
    } catch (err) {
      return fail(err)
    }
  })
}
