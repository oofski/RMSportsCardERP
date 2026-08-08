/**
 * Read a carrier's tracking page, in the app's own browser.
 *
 * The owner wants live status and does not want another service in the middle.
 * Every carrier API needs a developer account and an OAuth dance, and an
 * aggregator needs a signup — so the only route left is the page the Track
 * button already opens. This app carries a real Chromium, so it can open that
 * page offscreen, let it run its own JavaScript, and read the result.
 *
 * ## What this is not
 *
 * It is not an API, and it comes with no promises. Carriers restructure their
 * pages and push back on automated reads. So the whole design is built around
 * failing SAFELY rather than failing rarely:
 *
 *   - Every failure mode returns `{ ok: false }` with a reason. Nothing invents
 *     a status, and the caller never writes one it did not get.
 *   - There is a hard timeout. A page that hangs must not hold a window open
 *     for the rest of the session.
 *   - The window is offscreen, has no node integration, shares no session with
 *     the app, and is destroyed in a `finally`. It is loading somebody else's
 *     JavaScript, and it gets no more than a browser tab would.
 *   - Reads are SEQUENTIAL and spaced. Fifteen packages an hour, one at a time,
 *     looks like a person; fifteen at once looks like a script and gets
 *     blocked, which would take the working ones down with it.
 *
 * On the web build there is no BrowserWindow at all, so this reports that
 * plainly and the browser client falls back to whatever a desktop machine last
 * synced. See `canRead`.
 */
import type { ShipStatusCode } from '@shared/shippingTypes'
import { looksUnreadable, parseTrackingStatus } from '@shared/tracking'
import { trackingUrl } from '@shared/freight'

export interface TrackingRead {
  ok: boolean
  status: ShipStatusCode | null
  /** The carrier's own words, for a human to check the parse against. */
  detail: string | null
  error: string | null
}

const TIMEOUT_MS = 25_000
/** Between reads. Enough that a sweep does not read as a burst. */
const GAP_MS = 1500

/** A recent desktop Chrome. A default Electron UA is refused by some carriers. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function fail(error: string): TrackingRead {
  return { ok: false, status: null, detail: null, error }
}

/**
 * Whether reading is possible at all in this build.
 *
 * The server build stubs `electron`, so BrowserWindow is either absent or not a
 * usable constructor. Asked rather than assumed, so the web client can say
 * "checked on the desktop app" instead of showing a broken button.
 */
export function canRead(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron')
    return typeof electron?.BrowserWindow === 'function'
  } catch {
    return false
  }
}

/**
 * Load one tracking page and read a status out of it.
 *
 * Returns `ok: false` for every kind of not-knowing — no URL, no browser, a
 * timeout, a blocked page, or text we could not interpret. The caller writes
 * nothing on `ok: false`, which is what keeps a working status from being
 * replaced by a bad afternoon at a carrier.
 */
export async function readTracking(
  carrier: string | null,
  trackingNumber: string
): Promise<TrackingRead> {
  const url = trackingUrl(carrier, trackingNumber)
  if (!url) return fail('No carrier for that tracking number.')
  if (!canRead()) return fail('Tracking can only be read by the desktop app.')

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BrowserWindow } = require('electron')
  let win: import('electron').BrowserWindow | undefined

  try {
    const w: import('electron').BrowserWindow = new BrowserWindow({
      show: false,
      width: 1200,
      height: 900,
      webPreferences: {
        // Somebody else's page. It gets a plain sandboxed renderer and no
        // bridge, no preload and no access to this app's session.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:tracking',
        offscreen: false,
        javascript: true
      }
    })
    win = w
    w.setMenu?.(null)

    const text = await withTimeout(loadAndRead(w, url), TIMEOUT_MS)
    if (text === null) return fail('The carrier page did not finish loading.')
    if (looksUnreadable(text)) {
      return fail('The carrier page did not show a package for that number.')
    }

    const status = parseTrackingStatus(text)
    if (!status) return fail('Could not make out a status on the carrier page.')

    return { ok: true, status, detail: firstMeaningfulLine(text), error: null }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  } finally {
    // ALWAYS. A leaked window survives the failure that created it and the app
    // ends the night holding a dozen of them.
    try {
      win?.destroy()
    } catch {
      /* already gone */
    }
  }
}

async function loadAndRead(win: import('electron').BrowserWindow, url: string): Promise<string> {
  await win.loadURL(url, { userAgent: UA })
  // These pages fetch their status AFTER the document is ready, so reading at
  // load time reliably returns the skeleton. A short settle is cruder than
  // waiting on a selector and far more durable: it does not need to know what
  // the carrier called its status element this month.
  await new Promise((r) => setTimeout(r, 3500))
  return (await win.webContents.executeJavaScript(
    `document.body ? document.body.innerText : ''`,
    true
  )) as string
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

/**
 * The carrier's own sentence, for the operator to sanity-check the parse.
 *
 * Kept short and stripped of the navigation that surrounds it. It is shown, not
 * interpreted — the status code is what the app acts on.
 */
function firstMeaningfulLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 12 && l.length < 160)
  const hit = lines.find((l) => parseTrackingStatus(l) !== null)
  return hit ?? lines[0] ?? null
}

/** Space out a sweep so it reads like a person rather than a script. */
export function trackingGap(): Promise<void> {
  return new Promise((r) => setTimeout(r, GAP_MS))
}
