/**
 * One definition of every backend operation, bound to whichever transport is
 * asking.
 *
 * The app registers ~180 operations with `ipcMain.handle(channel, fn)`. Those
 * handlers are the entire backend: they hold the permission checks, the
 * transactions, the FIFO engine. To let several people share one database, the
 * same operations have to be reachable over a network as well as over IPC — and
 * the one thing that must never happen is two copies of them drifting apart,
 * because the copy that drifts is the one that quietly gets a permission check
 * or a transaction boundary wrong.
 *
 * So this module offers an object shaped exactly like Electron's `ipcMain`. The
 * seven *Ipc.ts files import `ipcMain` from HERE instead of from 'electron' —
 * a one-line change each, with every handler body untouched — and every
 * registration is recorded in a table as it goes past. A local desktop app
 * forwards that registration straight on to the real Electron ipcMain and
 * behaves exactly as before. A server reads the table and serves the same
 * functions over HTTP.
 *
 * Deliberately does NOT import 'electron'. A headless server process has no
 * Electron to import, and a module in the middle of this path that insists on
 * one would make the whole arrangement pointless. Whoever wants live Electron
 * registration installs it with `setRegistrationSink()`.
 */

import type { WebContents } from 'electron'

/**
 * The event Electron passes as a handler's first argument.
 *
 * A TYPE-only import, so this module still pulls in nothing from Electron at
 * runtime and a headless server can import it freely. `sender` is the one field
 * any handler uses — a handful call `BrowserWindow.fromWebContents(e.sender)` to
 * find the window to hang a file dialog off.
 */
export interface IpcCallEvent {
  sender: WebContents
}

/**
 * Mirrors Electron's own `ipcMain.handle` signature, `any[]` args included.
 * Electron types it that way because a channel's arguments are whatever the two
 * ends agreed on; being stricter here than the thing being stood in for would
 * only mean casting at all 180 registration sites.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcHandler = (event: IpcCallEvent, ...args: any[]) => unknown

/** Receives each registration as it happens (the Electron binding). */
export type RegistrationSink = (channel: string, handler: IpcHandler) => void

const handlers = new Map<string, IpcHandler>()
let sink: RegistrationSink | null = null

/**
 * Bind everything registered — past and future — to a transport.
 *
 * Existing registrations are replayed, so installation order does not matter.
 * That removes a whole class of "worked in dev, silently registered nothing in
 * production" bug where a module happened to be imported before the sink.
 */
export function setRegistrationSink(next: RegistrationSink): void {
  sink = next
  for (const [channel, handler] of handlers) next(channel, handler)
}

/**
 * Drop-in for Electron's `ipcMain`, as far as these files use it.
 *
 * Registering the same channel twice is a programming error rather than a
 * runtime condition — Electron itself throws on it — so it is caught here
 * instead of letting the second registration silently win on one transport and
 * lose on the other.
 */
export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    if (handlers.has(channel)) {
      throw new Error(`IPC channel "${channel}" is registered twice.`)
    }
    handlers.set(channel, handler)
    sink?.(channel, handler)
  }
}

/** Every registered operation, for a server to bind or a test to inspect. */
export function registeredHandlers(): ReadonlyMap<string, IpcHandler> {
  return handlers
}

/** How many operations are registered. */
export function handlerCount(): number {
  return handlers.size
}

/**
 * Invoke one operation by name.
 *
 * The `event` argument every handler takes first is Electron's, and is used by
 * a handful of them only to find the window that asked (for a file dialog).
 * Over a network there is no window, so `null` is passed and those handlers are
 * the ones a server cannot serve — see docs/SERVER.md. Everything else ignores
 * it entirely.
 */
export async function invokeHandler(channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Unknown operation "${channel}".`)
  // No window exists over a network, so there is no sender. The handlers that
  // reach for one are exactly the file-dialog handlers a server cannot serve.
  return await handler({ sender: null } as unknown as IpcCallEvent, ...args)
}

/** Test seam: forget everything. Never call this from the app. */
export function resetRegistryForTests(): void {
  handlers.clear()
  sink = null
}
