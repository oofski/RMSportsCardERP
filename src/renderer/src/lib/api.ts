/**
 * Single access point to the preload-exposed bridge. Keeping it here means the
 * rest of the UI imports `api` rather than reaching for `window.rmops`
 * directly, which makes the surface easy to mock or swap for a Cloudflare-
 * backed transport later.
 */
export const api = window.rmops
