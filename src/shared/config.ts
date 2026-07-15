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
 * Where employees download the desktop app. Today this is the GitHub Releases
 * page; once the app is published to Cloudflare R2 / a custom domain this can
 * be swapped without touching the invite-email logic.
 */
export const DOWNLOAD_URL = 'https://github.com/oofski/rmsportscarderp/releases/latest'

/**
 * The eventual Cloudflare-hosted web version of the app for the Mac side of the
 * team. Placeholder until the Cloudflare Pages deployment exists.
 */
export const WEB_APP_URL = 'https://rmcardz.com/app'

/** Support contact surfaced in invite emails. */
export const SUPPORT_EMAIL = 'support@rmcardz.com'
