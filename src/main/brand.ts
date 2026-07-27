/**
 * The RM Sportscards mark, used on generated documents (the PO PDF today).
 *
 * Held here as an inline SVG rather than a file on disk on purpose: main-process
 * asset paths differ between `electron-vite dev` and a packaged build, and a
 * logo that silently 404s in the installer while working in dev is exactly the
 * kind of thing nobody notices until a supplier gets a broken invoice.
 *
 * It is drawn on a TRANSPARENT background — no black plate — so it sits on the
 * white paper of a receipt.
 *
 * TO REPLACE WITH THE OFFICIAL ARTWORK: swap RM_LOGO_SVG for the real file's
 * contents (or a `data:image/png;base64,…` string in RM_LOGO_DATA_URI). Nothing
 * else needs to change — every document reads it from here.
 */

const BRAND_BLUE = '#1F5AA8'

/**
 * A geometric rendition of the round mark: blue disc, inset white ring, the RM
 * monogram, and SPORTSCARDS letterspaced beneath it between two rules.
 */
export const RM_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="RM Sportscards">
  <circle cx="100" cy="100" r="100" fill="${BRAND_BLUE}"/>
  <circle cx="100" cy="100" r="89" fill="none" stroke="#ffffff" stroke-width="6"/>
  <text x="100" y="112" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="76" font-weight="700"
        letter-spacing="-2" fill="#ffffff">RM</text>
  <g stroke="#ffffff" stroke-width="2.5" stroke-linecap="round">
    <line x1="40" y1="140" x2="60" y2="140"/>
    <line x1="140" y1="140" x2="160" y2="140"/>
  </g>
  <text x="100" y="145" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="600"
        letter-spacing="2.4" fill="#ffffff">SPORTSCARDS</text>
</svg>`

/**
 * The same mark as a data URI, for an <img src> in generated HTML. Base64 rather
 * than percent-encoded so the `#` in the hex colours cannot terminate the URI.
 */
export const RM_LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(RM_LOGO_SVG, 'utf8').toString('base64')}`
