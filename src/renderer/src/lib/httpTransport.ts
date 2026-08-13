import { BYTES_TAG } from '@shared/ipc'
import type { UploadedFile } from '@shared/types'
import type { BridgeTransport } from '../../../bridge'

/**
 * The bridge's transport when the app is running in a browser tab.
 *
 * In Electron the renderer talks to the backend through the preload's
 * `ipcRenderer`. There is no preload in a browser, so this object provides the
 * same three methods over HTTP and Server-Sent Events, and `createBridge()`
 * builds the identical API surface on top of it. No screen knows which one it
 * got — that is the point, and it is why the 114 renderer files did not change.
 *
 * Three things are not obvious and matter:
 *
 *   · A rejected call must REJECT, not resolve. Electron's `invoke` rejects when
 *     a handler throws, and permission denials throw. Resolving with an error
 *     object would turn "you may not do that" into `undefined` halfway through
 *     a screen.
 *   · The session is a cookie the browser holds and no script can read
 *     (HttpOnly), so there is nothing here that stores or attaches a token.
 *     `credentials: 'same-origin'` is what sends it.
 *   · A handful of operations end by asking an operating system to save a file
 *     or open a URL. The server cannot, so it sends back what was asked for and
 *     this carries it out — after the call, so the permission check ran first.
 */

/** Sent on every call. See REQUEST_HEADER in server/index.ts. */
const REQUEST_HEADER = 'x-rmops-request'

/** Which bench this browser is. See STATION_HEADER in server/index.ts. */
const STATION_HEADER = 'x-rmops-station'
const STATION_KEY = 'rmops.stationId'

/**
 * A stable id for THIS browser, minted once and kept.
 *
 * The shipping floor claims work per bench, and on a shared server the bench
 * cannot be the database — there is only one of those, so every browser in the
 * building looked like the same station and each person's session overwrote the
 * last. This is the browser saying which bench it is.
 *
 * localStorage rather than the session cookie, deliberately: a bench is a
 * PHYSICAL place that outlives a login. Somebody signing out at the end of the
 * night and back in the next morning is standing at the same bench, and should
 * still be holding whatever that bench was holding.
 *
 * It grants nothing — see stationKey() in main/db/shipStations.ts — so a
 * private window that cannot persist one simply gets a fresh bench per session,
 * which is the honest description of what a private window is.
 */
function stationId(): string {
  try {
    const held = window.localStorage.getItem(STATION_KEY)
    if (held && held.trim()) return held.trim()
    const minted =
      typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `st-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    window.localStorage.setItem(STATION_KEY, minted)
    return minted
  } catch {
    // Storage disabled or full. A per-tab id is still better than every browser
    // sharing one, which is the bug this exists to fix.
    return memoStation
  }
}

/** The fallback when localStorage refuses. Per page load, which is per tab. */
const memoStation =
  typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `st-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

interface CallEnvelope {
  ok: boolean
  data?: unknown
  error?: string
  /** Exports the handler produced, each collectable exactly once. */
  downloads?: Array<{ token: string; filename: string; disposition: 'attachment' | 'inline' }>
  /** URLs the handler handed to the OS. In a browser, that is a new tab. */
  open?: string[]
}

/**
 * Fetch an export and put it in front of the user.
 *
 * An anchor with `download` rather than `location.href`, so the filename the
 * handler chose survives and the current page is not navigated away from
 * mid-export. The blob is revoked afterwards; without that, every export in a
 * long shift stays in memory until the tab is closed.
 */
async function collectDownload(entry: {
  token: string
  filename: string
  disposition: 'attachment' | 'inline'
}): Promise<void> {
  const res = await fetch(`/api/download/${encodeURIComponent(entry.token)}`, {
    credentials: 'same-origin'
  })
  if (!res.ok) return
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  if (entry.disposition === 'inline') {
    // "Open this document" — a purchase order, which the browser prints. A
    // popup blocker can refuse this; the download below is the fallback.
    const opened = window.open(url, '_blank')
    if (opened) {
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return
    }
  }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = entry.filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function performClientActions(envelope: CallEnvelope): Promise<void> {
  for (const url of envelope.open ?? []) {
    // Deliberately not awaited on the response of anything: this is the browser
    // doing what the desktop asked the OS to do. A blocked popup is the one
    // failure mode, and it is the user's own setting to fix.
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  for (const download of envelope.downloads ?? []) {
    try {
      await collectDownload(download)
    } catch {
      // The export was produced and the ticket expires by itself. Failing to
      // save it is not worth destroying the caller's result over.
    }
  }
}

async function call(channel: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`/api/call/${encodeURIComponent(channel)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      [REQUEST_HEADER]: '1',
      [STATION_HEADER]: stationId()
    },
    body: JSON.stringify({ args })
  })

  let envelope: CallEnvelope
  try {
    envelope = (await res.json()) as CallEnvelope
  } catch {
    throw new Error(`The server did not answer (${res.status}).`)
  }
  if (!envelope.ok) throw new Error(envelope.error || 'That did not work.')
  await performClientActions(envelope)
  return withBytesRestored(envelope.data)
}

/**
 * Turn tagged binary back into a Uint8Array.
 *
 * The mirror of withBytesTagged() on the server, and the reason both exist:
 * Electron's IPC carries a Uint8Array as a Uint8Array, JSON does not. A
 * `{"0":37,"1":80,…}` object reached `new Uint8Array(…)` in the pane and came
 * out ZERO BYTES long, so the packing slip rendered as pdf.js's "The PDF file is
 * empty" over a blank sheet — on the web only, while the desktop was fine.
 *
 * Recursive for the same reason the encoder is: the next operation to return
 * bytes may well return them inside an object, and it would fail exactly as
 * silently.
 */
function withBytesRestored(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withBytesRestored)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const tagged = record[BYTES_TAG]
    if (typeof tagged === 'string' && Object.keys(record).length === 1) {
      return fromBase64(tagged)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(record)) out[k] = withBytesRestored(v)
    return out
  }
  return value
}

/** base64 → bytes, without atob's one-character-at-a-time cost on 10 MB. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

type Listener = (event: unknown, ...args: unknown[]) => void

const listeners = new Map<string, Set<Listener>>()
let stream: EventSource | null = null

/**
 * Which record kinds a `changed` frame carries.
 *
 * The server derives them from the sync outbox — the same capture triggers the
 * desktop's sync loop reads — so the browser's live refresh is driven by
 * exactly the tables that moved, and `useLiveRefresh` needs no browser-specific
 * code path.
 */
interface ChangedFrame {
  channel: string
  by: string
  kinds?: string[]
}

function deliver(channel: string, payload: unknown): void {
  const set = listeners.get(channel)
  if (!set) return
  // A null event object stands in for Electron's IpcRendererEvent. Every
  // listener in the bridge ignores it; none may start reading it.
  for (const listener of [...set]) listener(null, payload)
}

/**
 * One EventSource for the whole tab, opened on the first subscription.
 *
 * EventSource reconnects on its own after a dropped connection or a deploy,
 * which is the entire reason it is used here rather than a WebSocket: a
 * warehouse tab left open all day must not need a refresh to start seeing other
 * people's work again.
 */
function ensureStream(): void {
  if (stream || typeof EventSource === 'undefined') return
  stream = new EventSource('/api/events', { withCredentials: true })
  stream.addEventListener('changed', (event) => {
    try {
      const frame = JSON.parse((event as MessageEvent).data) as ChangedFrame
      const kinds = Array.isArray(frame.kinds) ? frame.kinds : []
      if (kinds.length > 0) deliver('sync:changed-event', { kinds })
    } catch {
      // A malformed frame is not worth tearing the stream down for.
    }
  })
  stream.addEventListener('push', (event) => {
    try {
      const frame = JSON.parse((event as MessageEvent).data) as {
        channel: string
        payload: unknown
      }
      deliver(frame.channel, frame.payload)
    } catch {
      // As above.
    }
  })
}

// ---------------------------------------------------------------------------
// Choosing a file
// ---------------------------------------------------------------------------

/** Bytes → base64 without blowing the stack on a 10MB packing slip. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * The browser's own file picker, standing in for the native one.
 *
 * A hidden `<input type="file">` clicked programmatically. It has to be in the
 * document for Safari to fire `change` at all, and it is removed as soon as the
 * answer is known so a shift's worth of imports does not leave a trail of
 * inputs in the DOM.
 *
 * There is no reliable cancel event across browsers — `cancel` is recent and
 * not universal — so a cancelled dialog simply never resolves the change
 * handler. The promise resolving to null on `cancel` where it exists is a
 * nicety; the operation being abandoned costs nothing either way.
 */
async function pickFile(options: {
  accept: string
  as: 'text' | 'bytes'
}): Promise<UploadedFile | null> {
  return new Promise<UploadedFile | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = options.accept
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)

    const done = (value: UploadedFile | null): void => {
      input.remove()
      resolve(value)
    }

    input.addEventListener('cancel', () => done(null))
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return done(null)
      const reader = new FileReader()
      reader.onerror = () => done(null)
      reader.onload = () => {
        if (options.as === 'text') {
          done({ filename: file.name, text: String(reader.result ?? '') })
        } else {
          done({
            filename: file.name,
            base64: toBase64(new Uint8Array(reader.result as ArrayBuffer))
          })
        }
      }
      if (options.as === 'text') reader.readAsText(file)
      else reader.readAsArrayBuffer(file)
    })

    input.click()
  })
}

export const httpTransport: BridgeTransport = {
  invoke: (channel: string, ...args: unknown[]) => call(channel, args),
  pickFile,
  on: (channel: string, listener: Listener) => {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(channel, set)
    ensureStream()
  },
  removeListener: (channel: string, listener: Listener) => {
    listeners.get(channel)?.delete(listener)
  }
}
