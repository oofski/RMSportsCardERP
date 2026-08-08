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

const TIMEOUT_MS = 40_000

/**
 * What each carrier needs before its page is worth reading.
 *
 * FedEx is the reason this exists. All three fetch their status by XHR after
 * the document is ready, but FedEx's app is the slowest to settle and the most
 * likely to paint a skeleton first — a fixed wait read the skeleton and came
 * back with nothing, which is exactly the empty status line the owner saw.
 *
 * So instead of sleeping a guessed amount, each carrier is POLLED until its
 * page says something recognisable, up to a per-carrier ceiling. A page that
 * settles in a second is read in a second; a slow one gets the time it needs.
 */
interface CarrierProfile {
  /** Give up waiting for a status after this long, and read what is there. */
  maxWaitMs: number
  /** Poll interval while waiting for the page to fill in. */
  pollMs: number
}

const PROFILES: Record<string, CarrierProfile> = {
  // The heaviest of the three, and the one that was failing.
  fedex: { maxWaitMs: 22_000, pollMs: 1000 },
  ups: { maxWaitMs: 18_000, pollMs: 1000 },
  usps: { maxWaitMs: 14_000, pollMs: 800 }
}

const DEFAULT_PROFILE: CarrierProfile = { maxWaitMs: 18_000, pollMs: 1000 }
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

  // ONE RETRY, on a fresh window. These pages lose races — a slow XHR, a cold
  // CDN — and a second attempt costs one page load against a package we were
  // going to report as unreadable anyway. A "not found" page is NOT retried:
  // that is a real answer and asking again just spends a request.
  const first = await readOnce(carrier, url)
  if (first.ok || /did not show a package/.test(first.error ?? '')) return first
  await new Promise((r) => setTimeout(r, 1200))
  const second = await readOnce(carrier, url)
  // Report the SECOND failure: it is the more recent description of what is
  // wrong, and reporting the first would hide a bot wall behind a timeout.
  return second
}

async function readOnce(carrier: string | null, url: string): Promise<TrackingRead> {

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

    const profile = PROFILES[String(carrier ?? '')] ?? DEFAULT_PROFILE
    const text = await withTimeout(loadAndRead(w, url, profile, carrier), TIMEOUT_MS)
    if (text === null) return fail('The carrier page did not finish loading.')
    if (looksUnreadable(text)) {
      return fail('The carrier page did not show a package for that number.')
    }

    const status = parseTrackingStatus(text, carrier)
    if (!status) return fail('Could not make out a status on the carrier page.')

    return { ok: true, status, detail: firstMeaningfulLine(text, carrier), error: null }
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

/**
 * Load the page and wait for it to actually say something.
 *
 * Polls the rendered text until a status can be read out of it, rather than
 * sleeping a fixed guess. Deliberately does NOT wait on a CSS selector: that
 * would need to know what the carrier called its status element this month, and
 * would break silently the first time they renamed a class. What it waits for
 * is MEANING — the same phrases the parser looks for — so it stops the moment
 * the page is useful and never sooner.
 *
 * Returns whatever text it has when the ceiling is reached, so a page that
 * never settles still gets classified honestly (unreadable, or no status) by
 * the caller rather than being reported as a timeout.
 */
async function loadAndRead(
  win: import('electron').BrowserWindow,
  url: string,
  profile: CarrierProfile,
  carrier: string | null
): Promise<string> {
  await win.loadURL(url, { userAgent: UA })

  const deadline = Date.now() + profile.maxWaitMs
  let text = ''
  for (;;) {
    text = ((await win.webContents.executeJavaScript(
      `document.body ? document.body.innerText : ''`,
      true
    )) ?? '') as string

    // The page is worth reading the moment a status can be read out of it.
    if (parseTrackingStatus(text, carrier)) return text
    // A bot wall or a not-found page will not improve with waiting; hand it
    // back now so the caller can say which it was.
    if (text.trim().length > 40 && looksUnreadable(text)) return text
    if (Date.now() >= deadline) return text
    await new Promise((r) => setTimeout(r, profile.pollMs))
  }
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
function firstMeaningfulLine(text: string, carrier: string | null): string | null {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 12 && l.length < 160)
  const hit = lines.find((l) => parseTrackingStatus(l, carrier) !== null)
  return hit ?? lines[0] ?? null
}

/** Space out a sweep so it reads like a person rather than a script. */
export function trackingGap(): Promise<void> {
  return new Promise((r) => setTimeout(r, GAP_MS))
}
