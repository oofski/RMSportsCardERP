import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { IPC } from '@shared/ipc'
import { getDb } from '../main/db/database'
import { runAs } from '../main/services/session'
import { invokeHandler, registeredHandlers, setRegistrationSink } from '../main/ipcRegistry'
import { registerIpcHandlers } from '../main/ipc'
import { registerInventoryIpc } from '../main/inventoryIpc'
import { registerPurchaseOrdersIpc } from '../main/purchaseOrdersIpc'
import { registerShippingIpc } from '../main/shippingIpc'
import { registerStreamingIpc } from '../main/streamingIpc'
import { registerQuickBooksIpc } from '../main/quickbooksIpc'
import { registerFinanceIpc } from '../main/financeIpc'
import { registerSyncIpc } from '../main/syncIpc'
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
 * One process owns the SQLite file and answers the same ~180 operations the
 * desktop app answers locally — the identical handler functions, reached through
 * the registry rather than through a second implementation (see
 * main/ipcRegistry.ts). Everything below is transport: authenticate the caller,
 * run the handler AS that caller, tell everyone else what changed.
 *
 * No web framework and no WebSocket library, because neither earns its
 * dependency here. There are five routes, and the only push the app needs is
 * one-directional — "something changed, refetch" — which is exactly what
 * Server-Sent Events are, built into every client and reconnecting on their own.
 *
 * SQLite stays. WAL mode gives many concurrent readers and one writer, which
 * covers a dozen people doing warehouse work comfortably — and the FIFO cost
 * engine WANTS a single writer. Its invariants were written assuming one process
 * owns the database; here that stops being an assumption and becomes true.
 */

const PORT = Number(process.env.RMOPS_PORT ?? 8787)
const HOST = process.env.RMOPS_HOST ?? '0.0.0.0'
/** Max request body. The largest real payload is a pasted count sheet. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

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

/**
 * Tell every connected client that something changed.
 *
 * Deliberately carries only the operation's name, never its data: a payload
 * would have to be filtered per-recipient against their permissions, and the one
 * thing worse than a screen that is out of date is a screen showing someone
 * numbers they are not allowed to see. Clients refetch through the normal
 * permission-checked path.
 */
function broadcast(event: { channel: string; by: string }): void {
  if (subscribers.size === 0) return
  const frame = `event: changed\ndata: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`
  for (const sub of subscribers) {
    try {
      sub.res.write(frame)
    } catch {
      subscribers.delete(sub)
    }
  }
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
// HTTP plumbing
// ---------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Nothing this server returns should ever be cached: it is all live state.
    'cache-control': 'no-store'
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.')
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
function tokenFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null
  }
  return null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Liveness. Deliberately says nothing about the data — it is the one route
  // that answers without a session, so it must not leak anything.
  if (req.method === 'GET' && path === '/health') {
    send(res, 200, {
      ok: true,
      operations: registeredHandlers().size,
      sessions: activeSessionCount(),
      uptimeSeconds: Math.round(process.uptime())
    })
    return
  }

  if (req.method === 'POST' && path === '/api/login') {
    const body = (await readBody(req)) as { identifier?: string; password?: string } | undefined
    const client = String(req.headers['user-agent'] ?? '').slice(0, 200)
    const { result, session } = signIn(
      String(body?.identifier ?? ''),
      String(body?.password ?? ''),
      client
    )
    if (!result.ok || !session) {
      // 401 with the same generic message the desktop app gives, so this
      // endpoint cannot be used to discover which accounts exist.
      send(res, 401, { ok: false, error: result.error ?? 'Sign-in failed.' })
      return
    }
    send(res, 200, { ok: true, user: result.user, token: session.token, expiresAt: session.expiresAt })
    return
  }

  if (req.method === 'POST' && path === '/api/logout') {
    signOut(tokenFrom(req))
    send(res, 200, { ok: true })
    return
  }

  // First-run setup is the one thing that cannot present a session, because
  // there is nobody to sign in as yet. Exactly two operations are reachable
  // without one, and both are safe on their own terms:
  //
  //   authSetupState  — answers "does this server have any accounts". A server
  //                     with none is not a secret; it is visible from the fact
  //                     that nobody can log in.
  //   authCreateOwner — createOwner() itself refuses once ANY account exists
  //                     ("Setup has already been completed"), so the window in
  //                     which this does anything at all is a database with zero
  //                     employees. After the first owner it is inert.
  //
  // The list is closed and matched exactly. Everything else needs a session,
  // including every read.
  const PRE_AUTH = new Set<string>([IPC.authSetupState, IPC.authCreateOwner])
  const callChannel =
    req.method === 'POST' && path.startsWith('/api/call/')
      ? decodeURIComponent(path.slice('/api/call/'.length))
      : null

  const session = resolveSession(tokenFrom(req))
  if (!session && !(callChannel !== null && PRE_AUTH.has(callChannel))) {
    send(res, 401, { ok: false, error: 'Your session has expired — sign in again.' })
    return
  }

  // Live updates. One long-lived response per client.
  if (req.method === 'GET' && path === '/api/events' && session) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive'
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

  // The one route that matters: run an operation as the caller.
  if (callChannel !== null) {
    const channel = callChannel
    if (!registeredHandlers().has(channel)) {
      send(res, 404, { ok: false, error: `Unknown operation "${channel}".` })
      return
    }
    const body = (await readBody(req)) as { args?: unknown[] } | undefined
    const args = Array.isArray(body?.args) ? (body?.args as unknown[]) : []

    const before = totalChanges()
    try {
      // runAs is what makes ten simultaneous callers safe: everything the
      // handler touches, at any depth and across any await, sees THIS user.
      const data = await runAs({ userId: session?.employeeId ?? null, origin: 'http' }, () =>
        invokeHandler(channel, args)
      )
      // Broadcast only after the write has actually committed, and only if
      // there was one. Announcing before the commit would have clients refetch
      // the state that is about to change.
      if (totalChanges() !== before) broadcast({ channel, by: session?.employeeId ?? 'setup' })
      send(res, 200, { ok: true, data })
    } catch (err) {
      // Handlers throw for permission denials as well as genuine faults. Both
      // are reported the same way the desktop app reports them — as the message
      // — because the renderer already knows how to show that.
      send(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  send(res, 404, { ok: false, error: 'Not found.' })
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export function startServer(): ReturnType<typeof createServer> {
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
        send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
      } else {
        res.end()
      }
    })
  })

  const purge = setInterval(purgeExpiredSessions, 60 * 60 * 1000)
  purge.unref()

  server.listen(PORT, HOST, () => {
    console.log(
      `RM Operations server listening on http://${HOST}:${PORT} — ` +
        `${registeredHandlers().size} operations, database ${db.name}`
    )
  })
  return server
}

/** Started directly (`npm run server`) rather than imported by a test. */
if (process.env.RMOPS_SERVER_AUTOSTART !== 'false') {
  startServer()
}
