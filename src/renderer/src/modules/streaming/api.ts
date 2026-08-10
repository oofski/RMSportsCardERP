import type { Result } from '@shared/types'
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
import { api } from '../../lib/api'

/**
 * The Streaming bridge, named here rather than inferred from the preload.
 *
 * The renderer and the main process are built by different hands; writing the
 * surface out against @shared/streaming means this module compiles against the
 * CONTRACT, and any drift shows up as a mismatch at the boundary instead of
 * silently reshaping every screen that reads it.
 */
export interface StreamingApi {
  /** The session currently on air, or null. */
  active(): Promise<StreamSession | null>
  /** `month` is a local YYYY-MM key. Only days WITH activity come back. */
  calendar(month: string): Promise<StreamCalendarMonth>
  /** Inclusive YYYY-MM-DD range over `streamDate`, not over end times. */
  list(from: string, to: string): Promise<StreamSession[]>
  get(id: string): Promise<StreamSessionDetail | null>
  start(input: { title: string; hostId: string | null; note: string | null }): Promise<
    Result<StreamSession>
  >
  end(id: string): Promise<Result<StreamSession>>
  create(input: NewStreamSession): Promise<Result<StreamSession>>
  update(input: UpdateStreamSession): Promise<Result<StreamSession>>
  remove(id: string): Promise<Result>
  addItem(input: NewStreamItem): Promise<Result<StreamSessionDetail>>
  removeItem(id: string): Promise<Result<StreamSessionDetail>>
  /** What a line turns out to have cost, per one stock unit of the product.
   *  Corrects the STATEMENT: no stock moves and no cost layer is revalued. */
  setItemCost(input: SetStreamItemCost): Promise<Result<StreamSessionDetail>>
  /**
   * Shows that have not happened yet.
   *
   * Optional on the type because a packaged preload older than this feature does
   * not have it, and the screens check `scheduleReady` rather than calling into
   * `undefined` on click.
   */
  plans?: ScheduledStreamsApi
}

export interface ScheduledStreamsApi {
  upcoming(): Promise<ScheduledStream[]>
  range(from: string, to: string): Promise<ScheduledStream[]>
  create(input: NewScheduledStream): Promise<Result<ScheduledStream>>
  update(input: { id: string } & Partial<NewScheduledStream>): Promise<Result<ScheduledStream>>
  cancel(id: string): Promise<Result<ScheduledStream>>
  remove(id: string): Promise<Result>
  start(id: string): Promise<Result<{ sessionId: string }>>
}

/**
 * The annotation is the point: if the preload bridge ever stops satisfying the
 * interface above, this line fails to compile instead of the drift surfacing as
 * an undefined at runtime, halfway through recording a break.
 */
export const streaming: StreamingApi = api.streaming

/**
 * False when the renderer is running against an older packaged preload that
 * predates this module. Every call here moves stock, so the module says so
 * plainly rather than throwing "cannot read property of undefined" on click.
 */
export const streamingReady = typeof streaming?.calendar === 'function'

/**
 * False against a packaged preload older than entering a cost after the fact.
 *
 * Checked separately from `streamingReady` because the consequence is different:
 * a screen without the module at all says so, whereas a screen without THIS
 * still shows every uncosted line — the disclosure lands either way — and simply
 * does not offer the button that would throw "setItemCost is not a function" on
 * click.
 */
export const costEntryReady = typeof streaming?.setItemCost === 'function'

/**
 * False against a packaged preload older than scheduled streams.
 *
 * Its own flag, like `costEntryReady`, and for the same reason: the rest of the
 * module works perfectly without this, so the right behaviour is to hide the
 * upcoming strip rather than to declare the whole module unavailable.
 */
export const scheduleReady = typeof streaming?.plans?.upcoming === 'function'

/** The plans surface, once `scheduleReady` says it is there. */
export const streamPlans = streaming?.plans as ScheduledStreamsApi

/** Result → message, so no failed write is ever swallowed into silence. */
export function resultError(res: Result<unknown>, fallback: string): string {
  return res.error?.trim() || fallback
}
