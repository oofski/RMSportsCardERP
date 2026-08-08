import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { BYTES_TAG, IPC } from '@shared/ipc'
import { effectivePermissions, type Permission } from '@shared/permissions'
import { getDb } from '../main/db/database'
import { getEmployeeById } from '../main/db/employees'
import { runAs } from '../main/services/session'
import { invokeHandler, registeredHandlers, setRegistrationSink } from '../main/ipcRegistry'
import { setDocumentRenderer } from '../main/poPdf'
import { registerIpcHandlers } from '../main/ipc'
import { registerInventoryIpc } from '../main/inventoryIpc'
import { registerPurchaseOrdersIpc } from '../main/purchaseOrdersIpc'
import { registerShippingIpc } from '../main/shippingIpc'
import { registerStreamingIpc } from '../main/streamingIpc'
import { registerQuickBooksIpc } from '../main/quickbooksIpc'
import { registerFinanceIpc } from '../main/financeIpc'
import { registerSyncIpc } from '../main/syncIpc'
import { registerOwnerIpc } from '../main/ownerIpc'
import { registerScheduleIpc } from '../main/scheduleIpc'
import { registerInvoicesIpc } from '../main/invoicesIpc'
import { initCloudSync, stopCloudSync } from '../main/services/cloudSync'
import { collectClientActions, type PendingDownload } from './clientActions'
import {
  app,
  dataDir,
  isSpoolPath,
  setBroadcastWindow,
  takeSpooledDownloads
} from './electron-stub'
import { loginAllowed, loginFailed, loginSucceeded, purgeRateLimits } from './rateLimit'
import { rendererExists, serveStatic } from './staticFiles'
import {
  activeSessionCount,
  purgeExpiredSessions,
  resolveSession,
  signIn,
  signOut
} from './sessions'

/**
 * The shared-database server.
 *
 * One process owns the SQLite file and answers the same 232 operations the
 * desktop app answers locally — the identical handler functions, reached through
 * the registry rather than through a second implementation (see
 * main/ipcRegistry.ts). Everything below is transport: authenticate the caller,
 * run the handler AS that caller, tell everyone else what changed, and carry
 * out in the browser the few things the handler thinks it is asking an
 * operating system to do.
 *
 * No web framework and no WebSocket library, because neither earns its
 * dependency here. There are seven routes, and the only push the app needs is
 * one-directional — "something changed, refetch" — which is exactly what
 * Server-Sent Events are, built into every client and reconnecting on their own.
 *
 * SQLite stays. WAL mode gives many concurrent readers and one writer, which
 * covers a dozen people doing warehouse work comfortably — and the FIFO cost
 * engine WANTS a single writer. Its invariants were written assuming one process
 * owns the database; here that stops being an assumption and becomes true.
 *
 * SECURITY POSTURE, stated once because this is now internet-facing:
 *   · Every route needs a session except /health, the login POST and the two
 *     first-run setup operations. That includes every read.
 *   · Permission checks are NOT re-implemented here. They live inside the
 *     handlers, read the caller from the request context, and run on this path
 *     exactly as they do on the desktop — see tests/webServer.test.ts, which
 *     asserts a role without a permission is refused over HTTP.
 *   · The session token is an HttpOnly, Secure, SameSite=Strict cookie, so no
 *     script can read it and no other site can send it.
 *   · The relay's shared key is read from the environment and never leaves the
 *     server. The browser is told whether one is set, never what it is.
 */

// `PORT` is the fallback because almost every managed host assigns one and
// expects the process to take it — Render, Railway, Heroku, App Runner. Without
// it the app binds 8787, the platform's health check knocks on the port it
// chose, gets nothing, and reports a deploy that failed for no visible reason.
// RMOPS_PORT still wins, so a machine you control is unaffected.
const DEFAULT_PORT = Number(process.env.RMOPS_PORT ?? process.env.PORT ?? 8787)
const DEFAULT_HOST = process.env.RMOPS_HOST ?? '0.0.0.0'

/**
 * Max request body.
 *
 * Larger than it used to be because uploads now come up inside the JSON body: a
 * 200-page Whatnot packing slip is a few megabytes, and base64 adds a third.
 * Anything past this is refused rather than buffered — the failure mode of
 * having no limit is one request holding the whole heap.
 */
const MAX_BODY_BYTES = Number(process.env.RMOPS_MAX_BODY_MB ?? 48) * 1024 * 1024

const SESSION_COOKIE = 'rmops_session'

/**
 * A header the browser must send on every operation.
 *
 * The session lives in a cookie, and cookies are sent by the browser whether or
 * not the page asking for them is ours. SameSite=Strict already stops the
 * cross-site case; this is the second lock. A form on another site cannot set a
 * custom header, and a script on another site trying to would trigger a
 * preflight — which this server answers with nothing, because it sends no CORS
 * headers at all.
 *
 * Bearer-authenticated callers are exempt: a token has to be attached
 * deliberately, so there is no confused deputy to protect against.
 */
const REQUEST_HEADER = 'x-rmops-request'

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

interface Subscriber {
  id: number
  employeeId: string
  res: ServerResponse
}

const subscribers = new Set<Subscriber>()
let nextSubscriberId = 1

function writeFrame(sub: Subscriber, frame: string): void {
  try {
    sub.res.write(frame)
  } catch {
    subscribers.delete(sub)
  }
}

/**
 * Tell every connected client that something changed.
 *
 * Carries the record KINDS that moved and never their contents: a payload would
 * have to be filtered per-recipient against their permissions, and the one thing
 * worse than a screen that is out of date is a screen showing someone numbers
 * they are not allowed to see. Clients refetch through the normal
 * permission-checked path — which is exactly what the desktop's sync loop does
 * with the same event, so the renderer needs no second code path.
 */
function broadcastChange(event: { channel: string; by: string; kinds: string[] }): void {
  if (subscribers.size === 0) return
  const frame = `event: changed\ndata: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`
  for (const sub of subscribers) writeFrame(sub, frame)
}

/**
 * Which push channels a subscriber is allowed to receive.
 *
 * The three broadcast channels carry different things and are gated
 * accordingly. `shipping:parse:event` names the file being imported and the
 * counts coming out of it, so it goes only to people who can see the
 * fulfillment module at all. The other two carry no business data — a sync
 * phase, an update phase — and match what any signed-in user can already read
 * through the corresponding operation.
 *
 * A channel not listed here is not delivered. That is the safe default: a push
 * added later reaches nobody until somebody decides who may see it, rather than
 * reaching everybody because nobody thought about it.
 */
const PUSH_PERMISSION: Record<string, Permission | null> = {
  [IPC.shipParseEvent]: 'module.fulfillment',
  [IPC.syncStatusEvent]: null,
  [IPC.syncChangedEvent]: null,
  [IPC.updatesStatusEvent]: null
}

function permissionsOf(employeeId: string): Permission[] {
  const employee = getEmployeeById(employeeId)
  if (!employee || employee.status === 'disabled') return []
  return effectivePermissions(employee.role, employee.extraPermissions)
}

/**
 * Deliver one of the app's own push messages over SSE.
 *
 * Installed as a pseudo-window (see electron-stub.ts) so the three modules that
 * announce things by walking `BrowserWindow.getAllWindows()` reach the browser
 * without knowing a browser exists.
 */
function pushToSubscribers(channel: string, payload: unknown): void {
  if (!(channel in PUSH_PERMISSION)) return
  const required = PUSH_PERMISSION[channel]
  if (subscribers.size === 0) return
  const frame = `event: push\ndata: ${JSON.stringify({ channel, payload })}\n\n`
  for (const sub of subscribers) {
    if (required && !permissionsOf(sub.employeeId).includes(required)) continue
    writeFrame(sub, frame)
  }
}

/**
 * Which record kinds this call touched.
 *
 * Read from the sync outbox rather than guessed from the channel name. Capture
 * triggers put a row there for every insert, update and delete on every synced
 * table (db/syncTriggers.ts), so the answer comes from the database itself and
 * a handler added next year is covered without anybody remembering to add it to
 * a list. Timestamps are millisecond ISO strings written by SQLite, so a `>`
 * comparison against the moment the call started is exact enough; a collision
 * inside one millisecond adds a kind to the broadcast, which costs one extra
 * refetch and loses nothing.
 */
function changedKindsSince(mark: string): string[] {
  const rows = getDb()
    .prepare('SELECT DISTINCT kind FROM sync_outbox WHERE updated_at > ?')
    .all(mark) as Array<{ kind: string }>
  return rows.map((r) => r.kind)
}

function outboxMark(): string {
  const row = getDb()
    .prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS t`)
    .get() as { t: string }
  return row.t
}

/**
 * Did this call write anything?
 *
 * Asked of SQLite rather than guessed from the channel name. `total_changes()`
 * counts every row inserted, updated or deleted on this connection since it
 * opened, so a call that moved it wrote something and a call that did not, did
 * not. A name-based guess would need maintaining forever and would silently stop
 * broadcasting the day someone adds a handler that does not match the pattern.
 */
function totalChanges(): number {
  const row = getDb().prepare('SELECT total_changes() AS n').get() as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

interface HeldDownload extends PendingDownload {
  employeeId: string
  expiresAt: number
}

/**
 * Exports waiting to be collected.
 *
 * A handler produced the bytes during a permission-checked call; the browser
 * then fetches them with a second request, because a JSON response cannot BE a
 * download. Each ticket is single-use, expires in two minutes, and is bound to
 * the session that created it — so a leaked URL in a log or a shoulder-surfed
 * address bar is worth nothing to anyone else, and worth nothing to its owner
 * twice.
 */
const heldDownloads = new Map<string, HeldDownload>()
const DOWNLOAD_TTL_MS = 2 * 60 * 1000

function holdDownload(employeeId: string, download: PendingDownload): string {
  const token = randomUUID()
  heldDownloads.set(token, { ...download, employeeId, expiresAt: Date.now() + DOWNLOAD_TTL_MS })
  return token
}

function purgeDownloads(): void {
  const now = Date.now()
  for (const [token, held] of heldDownloads) {
    if (held.expiresAt <= now) heldDownloads.delete(token)
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** True unless explicitly turned off for local development over plain http. */
function cookiesAreSecure(): boolean {
  return process.env.RMOPS_COOKIE_SECURE !== '0'
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    // No script can read it, so an XSS in the app cannot steal a session.
    'HttpOnly',
    // No other site can cause the browser to send it.
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ]
  if (cookiesAreSecure()) parts.push('Secure')
  return parts.join('; ')
}

function clearedCookie(): string {
  return sessionCookie('', 0)
}

/**
 * Headers on every response.
 *
 * `nosniff` matters most: exports go out as CSV and one goes out as HTML, and a
 * browser guessing at content types is how a downloaded file becomes a script
 * running in this origin. The frame denial stops the app being embedded and
 * clickjacked, and the referrer policy keeps our URLs out of other people's
 * logs.
 *
 * HSTS is only sent when the connection is already secure, because sending it
 * over plain http tells a browser to refuse http for this host for a year —
 * which, on a development machine, is very hard to undo.
 */
function securityHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin'
  }
  if (isSecureRequest(req)) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
  }
  return headers
}

/**
 * Are the `x-forwarded-*` headers on this request trustworthy?
 *
 * Only when something in front of us sets them. Behind Fly's proxy they are
 * authoritative; on a machine reachable directly they are whatever the caller
 * typed, and believing them means a client can claim any address it likes and
 * spend the login throttle ten times over. Off by default, and turned on in
 * fly.toml where it is true.
 */
function trustsProxy(): boolean {
  return process.env.RMOPS_TRUST_PROXY === '1'
}

function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted === true) return true
  if (!trustsProxy()) return false
  return String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https'
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Nothing this server returns should ever be cached: it is all live state.
    'cache-control': 'no-store',
    ...securityHeaders(req),
    ...extra
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('That file is too large to upload.')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Request body is not valid JSON.')
  }
}

/** The bearer token on this request, if any. */
function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null
  }
  return null
}

function cookieFrom(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}

/** The session token this request is presenting, cookie or bearer. */
function tokenFrom(req: IncomingMessage): string | null {
  return cookieFrom(req, SESSION_COOKIE) ?? bearerFrom(req)
}

/** Who the request appears to come from, for throttling. */
function clientAddress(req: IncomingMessage): string {
  if (trustsProxy()) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return req.socket.remoteAddress || 'unknown'
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * First-run setup is the one thing that cannot present a session, because there
 * is nobody to sign in as yet. Exactly two operations are reachable without one,
 * and both are safe on their own terms:
 *
 *   authSetupState  — answers "does this server have any accounts". A server
 *                     with none is not a secret; it is visible from the fact
 *                     that nobody can log in.
 *   authCreateOwner — createOwner() itself refuses once ANY account exists
 *                     ("Setup has already been completed"), so the window in
 *                     which this does anything at all is a database with zero
 *                     employees. After the first owner it is inert.
 *
 * The list is closed and matched exactly. Everything else needs a session,
 * including every read.
 */
const PRE_AUTH = new Set<string>([IPC.authSetupState, IPC.authCreateOwner])

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Liveness. Deliberately says nothing about the data — it is the one route
  // that answers without a session, so it must not leak anything.
  if (req.method === 'GET' && path === '/health') {
    send(req, res, 200, {
      ok: true,
      // The version is here so "did my deploy actually land?" is one URL rather
      // than a guess. It is not a secret: the repository and every release are
      // public, and the alternative — reading it off a screen inside the app —
      // needs a session, which is exactly what you cannot get when a deploy has
      // gone wrong.
      version: app.getVersion(),
      operations: registeredHandlers().size,
      sessions: activeSessionCount(),
      uptimeSeconds: Math.round(process.uptime())
    })
    return
  }

  const callChannel =
    req.method === 'POST' && path.startsWith('/api/call/')
      ? decodeURIComponent(path.slice('/api/call/'.length))
      : null

  // Cross-site request forgery: see REQUEST_HEADER. Applied to every operation,
  // including the pre-auth ones — creating the first Owner from another site's
  // form would be a fine way to take a fresh server.
  if (callChannel !== null && !bearerFrom(req) && req.headers[REQUEST_HEADER] === undefined) {
    send(req, res, 400, { ok: false, error: 'Missing client header.' })
    return
  }

  const session = resolveSession(tokenFrom(req))

  // Logging in and out are the two operations that MANAGE the session rather
  // than run inside one, so they are handled here instead of being dispatched
  // to a handler that has no idea a session exists.
  if (callChannel === IPC.authLogin) {
    await handleLogin(req, res)
    return
  }
  if (callChannel === IPC.authLogout) {
    signOut(tokenFrom(req))
    send(req, res, 200, { ok: true, data: { ok: true } }, { 'set-cookie': clearedCookie() })
    return
  }

  if (!session && !(callChannel !== null && PRE_AUTH.has(callChannel))) {
    // Static assets and the app shell are served to anyone — they contain no
    // data, only the code that asks for it, and a login page nobody can load is
    // a login page nobody can use. Every byte of business data is behind the
    // check above.
    if (callChannel === null && (req.method === 'GET' || req.method === 'HEAD')) {
      if (path.startsWith('/api/')) {
        send(req, res, 401, { ok: false, error: 'Your session has expired — sign in again.' })
        return
      }
      if (serveStatic(req, res, path, securityHeaders(req))) return
    }
    send(req, res, 401, { ok: false, error: 'Your session has expired — sign in again.' })
    return
  }

  // Live updates. One long-lived response per client.
  if (req.method === 'GET' && path === '/api/events' && session) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // Some reverse proxies buffer responses by default, which turns a live
      // event stream into a stream that arrives all at once, eventually.
      'x-accel-buffering': 'no',
      ...securityHeaders(req)
    })
    res.write(': connected\n\n')
    const sub: Subscriber = { id: nextSubscriberId++, employeeId: session.employeeId, res }
    subscribers.add(sub)
    // A comment frame every 25s keeps proxies from closing an idle stream.
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(keepAlive)
        subscribers.delete(sub)
      }
    }, 25_000)
    req.on('close', () => {
      clearInterval(keepAlive)
      subscribers.delete(sub)
    })
    return
  }

  // Collect an export produced by an earlier call.
  if (req.method === 'GET' && path.startsWith('/api/download/') && session) {
    const token = decodeURIComponent(path.slice('/api/download/'.length))
    const held = heldDownloads.get(token)
    if (!held || held.expiresAt <= Date.now() || held.employeeId !== session.employeeId) {
      // Deliberately NOT deleted here. Consuming a ticket on a failed attempt
      // would let anybody holding a session destroy somebody else's export by
      // asking for it once — a denial of service that looks exactly like a
      // flaky download.
      if (held && held.expiresAt <= Date.now()) heldDownloads.delete(token)
      send(req, res, 404, { ok: false, error: 'That download has expired.' })
      return
    }
    heldDownloads.delete(token)
    res.writeHead(200, {
      'content-type': held.mime,
      'content-length': held.bytes.length,
      'content-disposition': `${held.disposition}; filename="${held.filename}"`,
      'cache-control': 'no-store',
      ...securityHeaders(req)
    })
    res.end(held.bytes)
    return
  }

  // The one route that matters: run an operation as the caller.
  if (callChannel !== null) {
    await handleCall(req, res, callChannel, session?.employeeId ?? null)
    return
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && !path.startsWith('/api/')) {
    if (serveStatic(req, res, path, securityHeaders(req))) return
    send(req, res, 404, {
      ok: false,
      error: 'The app has not been built. Run `npm run build` before starting the server.'
    })
    return
  }

  send(req, res, 404, { ok: false, error: 'Not found.' })
}

/**
 * Verify credentials and start a session.
 *
 * Deliberately not a handler: `auth:login` on the desktop sets a module
 * variable, which is exactly the thing a server must not do. The password check
 * itself is still the app's own `login()` (through sessions.ts), so there is one
 * place that decides whether a password is correct.
 */
async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { args?: unknown[] } | undefined
  const payload = (Array.isArray(body?.args) ? body?.args[0] : body) as
    | { identifier?: string; password?: string }
    | undefined
  const identifier = String(payload?.identifier ?? '')
  const client = clientAddress(req)

  if (!loginAllowed(client, identifier)) {
    // 429 with the same vague wording: a throttle that says "that account is
    // real, slow down" is still telling you the account is real.
    send(req, res, 429, { ok: false, error: 'Too many sign-in attempts. Wait a few minutes.' })
    return
  }

  const { result, session } = signIn(
    identifier,
    String(payload?.password ?? ''),
    String(req.headers['user-agent'] ?? '').slice(0, 200)
  )
  if (!result.ok || !session) {
    loginFailed(client, identifier)
    // 200 with the app's own AuthResult, because that is what the login screen
    // renders. The failure message is the generic one `login()` produces, so
    // this endpoint cannot be used to discover which accounts exist.
    send(req, res, 200, { ok: true, data: result })
    return
  }
  loginSucceeded(client, identifier)
  const maxAge = Math.max(1, Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 1000))
  send(
    req,
    res,
    200,
    { ok: true, data: result, session: { expiresAt: session.expiresAt } },
    { 'set-cookie': sessionCookie(session.token, maxAge) }
  )
}

/**
 * Replace the temporary path an export was written to with its filename.
 *
 * Every export handler answers `{ ok: true, path }` and two screens put that
 * straight into a toast — "Exported to …". On a desktop that is where the file
 * went and is exactly what somebody wants to read. On a server it is a path
 * inside the container's /tmp, which tells the operator nothing, names a
 * directory they cannot reach, and describes a file that has already been
 * deleted by the time they finish reading it.
 *
 * So the shape stays and the value becomes the name the browser saved it as,
 * which is the true answer to the question the toast is asking.
 */
/**
 * Tag any raw bytes in a result so JSON can carry them.
 *
 * Recursive, because a handler is free to return bytes inside an object and a
 * top-level-only conversion would fail the next one silently and identically —
 * an empty file, no error, on the web only. The walk costs what stringifying
 * costs, which this is about to do anyway.
 *
 * Base64 rather than a second binary route: it is one function on each side, it
 * needs no new authentication path, and the only caller fetches once when a pane
 * opens. A tenth again in size on that one call is the whole price.
 */
function withBytesTagged(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BYTES_TAG]: Buffer.from(value).toString('base64') }
  }
  if (Buffer.isBuffer(value)) return { [BYTES_TAG]: value.toString('base64') }
  if (Array.isArray(value)) return value.map(withBytesTagged)
  if (value !== null && typeof value === 'object') {
    // Only plain objects. A Date has a JSON form of its own and walking one
    // would replace it with an empty object.
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = withBytesTagged(v)
    }
    return out
  }
  return value
}

function withoutServerPaths(value: unknown, filename: string | null): unknown {
  if (!filename || typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || !isSpoolPath(record.path)) return value
  return { ...record, path: filename }
}

/**
 * Run one operation as the caller.
 *
 * The order here is the whole security model: resolve the session, run the
 * handler inside a context that says who it is, and only then look at what the
 * handler wanted to do with the result. Nothing skips the handler, so nothing
 * skips its permission check.
 */
async function handleCall(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string,
  employeeId: string | null
): Promise<void> {
  if (!registeredHandlers().has(channel)) {
    send(req, res, 404, { ok: false, error: `Unknown operation "${channel}".` })
    return
  }
  const body = (await readBody(req)) as { args?: unknown[] } | undefined
  const args = Array.isArray(body?.args) ? (body?.args as unknown[]) : []

  const before = totalChanges()
  const mark = outboxMark()
  try {
    // runAs is what makes ten simultaneous callers safe: everything the handler
    // touches, at any depth and across any await, sees THIS user.
    const { value, actions } = await collectClientActions(async () =>
      runAs({ userId: employeeId, origin: 'http' }, () => invokeHandler(channel, args))
    )

    // Files the handler "saved" through a save dialog, plus anything it asked
    // the OS to open. Collected only after the handler returned, so a call that
    // threw hands over nothing.
    const downloads = [...actions.downloads, ...takeSpooledDownloads()]
    const result = withBytesTagged(withoutServerPaths(value, downloads[0]?.filename ?? null))
    const extra: Record<string, unknown> = {}
    if (downloads.length > 0 && employeeId) {
      extra.downloads = downloads.map((d) => ({
        token: holdDownload(employeeId, d),
        filename: d.filename,
        disposition: d.disposition
      }))
    }
    if (actions.open.length > 0) extra.open = actions.open

    // Broadcast only after the write has actually committed, and only if there
    // was one. Announcing before the commit would have clients refetch the state
    // that is about to change.
    if (totalChanges() !== before) {
      broadcastChange({ channel, by: employeeId ?? 'setup', kinds: changedKindsSince(mark) })
    }

    // The first Owner has just been created and there is nobody to sign them in
    // — the handler set a module variable that means nothing here. Issue the
    // session the same way login does, or setup finishes and the browser is
    // still anonymous.
    if (channel === IPC.authCreateOwner) {
      const created = value as { ok?: boolean; user?: { companyId?: string } } | null
      const owner = created?.ok ? created.user : null
      if (owner) {
        const password = (args[0] as { password?: string } | undefined)?.password ?? ''
        const { session } = signIn(String(owner.companyId ?? ''), password, 'setup')
        if (session) {
          const maxAge = Math.max(
            1,
            Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
          )
          send(req, res, 200, { ok: true, data: result, ...extra }, {
            'set-cookie': sessionCookie(session.token, maxAge)
          })
          return
        }
      }
    }

    send(req, res, 200, { ok: true, data: result, ...extra })
  } catch (err) {
    // Handlers throw for permission denials as well as genuine faults. Both are
    // reported the same way the desktop app reports them — as the message —
    // because the renderer already knows how to show that.
    send(req, res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port?: number
  host?: string
}

/**
 * Refuse to run in production without an explicit data directory.
 *
 * This is the single most expensive mistake available here. `dataDir()` falls
 * back to ./data, which inside a container is a directory on the container's
 * own filesystem — it works perfectly, right up until the next deploy replaces
 * the container and takes the company's database with it. There is no warning
 * and no error; the app comes up asking to create an Owner account.
 *
 * So a production start with no RMOPS_DATA_DIR does not start at all. See
 * docs/WEB.md and the volume mount in fly.toml.
 */
function assertDurableStorage(): void {
  if (process.env.NODE_ENV !== 'production') return
  if (process.env.RMOPS_ALLOW_EPHEMERAL_DATA === '1') {
    console.warn(
      'RMOPS_ALLOW_EPHEMERAL_DATA=1 — the database is NOT on a volume and will be lost ' +
        'when this container is replaced. Never set this on the real deployment.'
    )
    return
  }
  if (!process.env.RMOPS_DATA_DIR) {
    throw new Error(
      'RMOPS_DATA_DIR is not set. Refusing to start: the database would be written to the ' +
        'container filesystem and lost on the next deploy. Mount a volume and point ' +
        'RMOPS_DATA_DIR at it (see docs/WEB.md).'
    )
  }
  // Naming a directory is not the same as mounting one. A typo in the mount
  // path, a volume that failed to attach, a `docker run` without `-v` — all of
  // them leave RMOPS_DATA_DIR set and pointing at an ordinary directory inside
  // the container, which works perfectly until the container is replaced and
  // the company's entire database goes with it. There is no error, no warning
  // and no missing file: the app comes up asking to create an Owner account.
  //
  // A mounted volume is a different filesystem, so it has a different device
  // number. That is the one check that can tell the difference, and it is
  // cheap enough to run on every boot.
  if (statSync(dataDir()).dev === statSync('/').dev) {
    throw new Error(
      `RMOPS_DATA_DIR (${dataDir()}) is on the container's own filesystem, not a mounted ` +
        'volume. Refusing to start: everything written there is destroyed by the next ' +
        'deploy. Mount a volume at that path (see docs/WEB.md). If this really is what ' +
        'you want — a throwaway demo — set RMOPS_ALLOW_EPHEMERAL_DATA=1.'
    )
  }
}

export function startServer(options: ServerOptions = {}): Server {
  assertDurableStorage()

  // Collect the handlers without binding them to Electron — there is none here.
  setRegistrationSink(() => {})
  registerIpcHandlers()
  registerInventoryIpc()
  registerPurchaseOrdersIpc()
  registerShippingIpc()
  registerStreamingIpc()
  registerQuickBooksIpc()
  registerFinanceIpc()
  registerSyncIpc()
  // Was missing, and its absence was invisible: the owner's home board and the
  // reminders inbox simply 404'd on the server while working on the desktop.
  registerOwnerIpc()
  registerScheduleIpc()
  registerInvoicesIpc()

  // The three modules that push do it by walking the window list. Give them one
  // window whose `send` goes out over SSE, and they push to the browser without
  // knowing there is one.
  setBroadcastWindow({
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => pushToSubscribers(channel, payload) }
  })

  // No Chromium here, so a purchase order is printed by the browser that asked
  // for it rather than rendered server-side. Same document, different printer.
  setDocumentRenderer(async (html) => ({
    bytes: Buffer.from(html, 'utf8'),
    extension: '.html',
    mime: 'text/html; charset=utf-8'
  }))

  const db = getDb()
  // Many readers, one writer, and readers never block the writer. This is the
  // pragma that makes a shared SQLite file work for a team.
  db.pragma('journal_mode = WAL')
  // Wait rather than fail when the writer holds the lock. Without it a
  // concurrent write returns SQLITE_BUSY, which surfaces as a random failure
  // under exactly the load this server exists to carry.
  db.pragma('busy_timeout = 5000')

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        send(req, res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      } else {
        res.end()
      }
    })
  })

  // The relay is what serves the public intake form and the staff clock portal,
  // so a server that never syncs is a server where nobody's submission ever
  // arrives. Off unless RMOPS_SYNC_URL and RMOPS_SYNC_KEY are both present —
  // see services/cloudSync.ts — so a deployment that was given no keys opens no
  // connection at all.
  initCloudSync()
  server.on('close', () => stopCloudSync())

  const housekeeping = setInterval(
    () => {
      purgeExpiredSessions()
      purgeRateLimits()
      purgeDownloads()
    },
    5 * 60 * 1000
  )
  housekeeping.unref()
  server.on('close', () => clearInterval(housekeeping))

  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST
  server.listen(port, host, () => {
    const address = server.address()
    const actual = typeof address === 'object' && address ? address.port : port
    console.log(
      `RM Operations server listening on http://${host}:${actual} — ` +
        `${registeredHandlers().size} operations, data in ${dataDir()}, database ${db.name}`
    )
    if (!rendererExists()) {
      console.warn('No built renderer found. Run `npm run build` to serve the app itself.')
    }
    if (!cookiesAreSecure()) {
      console.warn('RMOPS_COOKIE_SECURE=0 — session cookies will be sent over plain http.')
    }
  })
  return server
}

/** Started directly (`npm run web`) rather than imported by a test. */
if (process.env.RMOPS_SERVER_AUTOSTART !== 'false') {
  try {
    startServer()
  } catch (err) {
    // A refusal to start is an operator's problem, not a programmer's — the
    // message says exactly what to fix, and a Node stack trace above it only
    // makes it harder to find in `fly logs`.
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
