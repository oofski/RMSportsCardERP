/**
 * App-wide configuration constants shared between the main and renderer
 * processes. Values that will eventually point at RM Cardz cloud
 * infrastructure (Cloudflare) are centralised here so there is a single place
 * to update when the backend goes live.
 */

export const APP_NAME = 'RM Operations App'
export const COMPANY_NAME = 'RM Cardz'
export const APP_ID = 'com.rmcardz.operations'

/**
 * Base URL the app fetches `${UPDATE_FEED_URL}/update.json` from to check for
 * updates (the macOS/Linux path; Windows auto-update uses electron-updater).
 *
 * ACTIVE phase = GitHub: `releases/latest/download` always resolves to the
 * newest release's assets, and the release workflow attaches update.json there.
 * When you move to Cloudflare, change this to your R2 domain (e.g.
 * https://updates.rmcardz.com) in the same change that flips electron-builder's
 * publish to generic-first and enables the cloudflare-publish CI job.
 */
export const UPDATE_FEED_URL =
  'https://github.com/oofski/rmsportscarderp/releases/latest/download'

/**
 * Does the macOS build carry an Apple Developer ID signature?
 *
 * This is the single switch that decides how Macs update, and it exists because
 * the answer is a property of the BUILD, not of the machine running it.
 *
 * Squirrel.Mac — the mechanism electron-updater uses on macOS — refuses to
 * replace an app in place unless the app is code-signed and notarized. That is
 * enforced by macOS on the client, so no amount of hosting changes it. While
 * this is false the app checks `update.json` and offers a .dmg to download and
 * reinstall by hand; flip it to true in the SAME change that turns on signing
 * in CI (see docs/UPDATES.md) and Macs update silently, exactly like Windows.
 *
 * Flipping it without signing the build is the one dangerous combination: every
 * Mac would attempt a silent update, Squirrel would reject the unsigned bundle,
 * and the operator would see a recurring failure with no way to act on it.
 */
export const MAC_AUTO_UPDATE = false

/**
 * Where employees download the desktop app manually. Point this at your
 * Cloudflare downloads page once it exists; falls back to GitHub Releases.
 */
export const DOWNLOAD_URL = 'https://github.com/oofski/rmsportscarderp/releases/latest'

/**
 * The eventual Cloudflare-hosted web version of the app for the Mac side of the
 * team. Placeholder until the Cloudflare Pages deployment exists.
 */
export const WEB_APP_URL = 'https://rmcardz.com/app'

/** Support contact surfaced in invite emails. */
export const SUPPORT_EMAIL = 'support@rmcardz.com'

// ---------------------------------------------------------------------------
// Cloud sync — built in, not configured
// ---------------------------------------------------------------------------

/**
 * The relay this app talks to, and the key it presents.
 *
 * Both are baked into the build rather than typed in by each person. Ten people
 * pasting a URL and a key into ten copies of a settings screen is ten chances to
 * get it wrong, and the one who fudges it is silently working on their own
 * private copy of the business — which looks exactly like working normally right
 * up until the numbers disagree.
 *
 * They are INJECTED AT BUILD TIME (see electron.vite.config.ts) rather than
 * written here, because this repository is public. A URL and a bearer token
 * committed side by side get found: scanning GitHub for exactly that pair is
 * automated, and it takes hours, not months. The values live as repository
 * secrets, reach the bundle only inside CI, and never touch a commit.
 *
 * A build made without them (a local `npm run dev`, a fork) falls back to empty.
 * That build is standalone and opens no connection — the settings fields in
 * Admin → Cloud sync are still there so it can be pointed somewhere by hand.
 */
declare const __CLOUD_SYNC_URL__: string | undefined
declare const __CLOUD_SYNC_KEY__: string | undefined

export const CLOUD_SYNC_URL: string =
  typeof __CLOUD_SYNC_URL__ === 'string' ? __CLOUD_SYNC_URL__ : ''
export const CLOUD_SYNC_KEY: string =
  typeof __CLOUD_SYNC_KEY__ === 'string' ? __CLOUD_SYNC_KEY__ : ''

/** Is this build wired to a relay out of the box? */
export const CLOUD_SYNC_BUILT_IN = CLOUD_SYNC_URL.length > 0 && CLOUD_SYNC_KEY.length > 0
