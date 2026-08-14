import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who is making the current request.
 *
 * The desktop app has exactly one signed-in user, held in a module variable in
 * services/auth.ts. That is correct for one person at one computer and wrong the
 * moment a shared server is answering ten people at once: every request is a
 * different person, and a global cannot be two people at the same time.
 *
 * Rather than thread a user argument through 180 handlers and ~26 permission
 * checks — a change large enough that a missed call site would silently run
 * someone else's request with someone else's rights — the caller is carried in
 * an AsyncLocalStorage. `runAs()` wraps the handler; everything it calls,
 * however deep and across any number of awaits, sees the right user.
 *
 * The distinction that matters:
 *
 *   · NO context at all  → the desktop app. Fall back to the signed-in user.
 *   · A context of null  → a server request that presented no valid session.
 *                          This must NOT fall back — falling back would answer
 *                          an unauthenticated request as whoever happened to be
 *                          signed in on the server process.
 *
 * That is why the reader returns `undefined` for "no context" and `null` for
 * "nobody", and why the two are never collapsed.
 */
export interface RequestContext {
  /** The authenticated user for this request, or null when unauthenticated. */
  userId: string | null
  /** Where the request came from, for audit and debugging. */
  origin?: string
  /**
   * WHICH BENCH this request came from, on a shared server.
   *
   * The shipping floor claims work per STATION — a physical bench with a person
   * standing at it — and a station used to be identified by `deviceId()`, which
   * is stored in the database. On the desktop that is exactly right: one machine,
   * one database, one bench.
   *
   * On the server it is exactly wrong. There is ONE database, so `deviceId()`
   * returns the same value to every browser in the building and the whole floor
   * collapses into a single station. `ship_station_sessions` is keyed on it, so
   * the second person to start a job overwrote the first person's session and
   * released the order they were holding — which is precisely the "it kicks me
   * out after every order" everybody was hitting.
   *
   * So the browser tells us which bench it is. Untrusted and deliberately so:
   * it grants nothing, is never an input to a permission decision, and the worst
   * a forged one can do is share a bench with somebody. See stationKey().
   */
  stationId?: string | null
  /**
   * WHICH SESSION this request is presenting — the stored hash, never the token.
   *
   * Exists for exactly one decision: changing your own password signs out every
   * OTHER session you have, and must not sign out the browser you are typing in.
   * Without this the choice was between leaving old sessions alive (a stolen
   * password stays usable after the theft is noticed, which is the whole reason
   * anybody changes one in a hurry) and logging the person out mid-gesture.
   *
   * The HASH and not the token, because that is what the table holds and there
   * is no reason for a raw credential to travel any further into the app than
   * the request handler that received it.
   *
   * Absent on the desktop, where there are no server sessions to spare.
   */
  sessionTokenHash?: string | null
}

const storage = new AsyncLocalStorage<RequestContext>()

/**
 * Run `fn` as `userId`. Everything it calls sees that user, including across
 * awaits, and concurrent calls never see each other's.
 */
export function runAs<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn)
}

/**
 * The user for the current request.
 *
 * `undefined` means there is no request context — the single-user desktop path.
 * `null` means there IS one and it is unauthenticated.
 */
export function contextUserId(): string | null | undefined {
  const store = storage.getStore()
  return store ? store.userId : undefined
}

/** The full context, when there is one. */
export function currentContext(): RequestContext | undefined {
  return storage.getStore()
}

/** True when running inside a request — i.e. served, not local. */
export function hasRequestContext(): boolean {
  return storage.getStore() !== undefined
}
