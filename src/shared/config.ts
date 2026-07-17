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
 * Base URL of the Cloudflare-hosted update feed (R2 bucket behind a custom
 * domain). The app fetches `${UPDATE_FEED_URL}/update.json` to check for new
 * versions, and Windows auto-update reads its generic feed (latest.yml) from
 * the same base. Point this at your real Cloudflare domain before releasing
 * through Cloudflare — it MUST match the `publish.url` in electron-builder.yml
 * and the CF_UPDATES_URL used by the release workflow.
 */
export const UPDATE_FEED_URL = 'https://updates.rmcardz.com'

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
