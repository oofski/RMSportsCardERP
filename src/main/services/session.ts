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
