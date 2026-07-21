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
