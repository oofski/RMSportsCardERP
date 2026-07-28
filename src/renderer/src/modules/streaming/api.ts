import type { Result } from '@shared/types'
import type {
  NewStreamItem,
  NewStreamSession,
  StreamCalendarMonth,
  StreamSession,
  StreamSessionDetail,
  UpdateStreamSession
} from '@shared/streaming'
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
}

const bridge = api as unknown as { streaming?: StreamingApi }

/**
 * False when the app is running against a build whose preload predates this
 * module. Every call here consumes stock or moves money, so the module says so
 * plainly rather than throwing "cannot read property of undefined" at the first
 * click.
 */
export const streamingReady = typeof bridge.streaming?.calendar === 'function'

export const streaming = bridge.streaming as StreamingApi

/** Result → message, so no failed write is ever swallowed into silence. */
export function resultError(res: Result<unknown>, fallback: string): string {
  return res.error?.trim() || fallback
}
