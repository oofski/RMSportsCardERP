import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Serve the built renderer.
 *
 * The same bundle the desktop app loads from disk, handed over HTTP instead —
 * `electron-vite build` writes it to out/renderer and nothing here knows or
 * cares that it was ever an Electron app.
 *
 * Two rules matter and both are about not getting them backwards:
 *
 *   · index.html is NEVER cached. It names the hashed asset files, so a cached
 *     copy after a deploy points every browser at bundles that no longer exist
 *     and the app comes up blank until someone hard-refreshes.
 *   · Everything under /assets IS cached forever, because its name contains a
 *     content hash — a changed file is a changed name, so an immutable cache
 *     can never serve a stale one.
 *
 * Unknown paths fall through to index.html, but only the ones that do not name
 * a file. The app has no router today (the shell switches on state, see
 * renderer/src/App.tsx), but a browser reloading on any URL must still land in
 * the app rather than on a 404, and that is the whole of "client-side routing
 * support". Anything with an extension is a file that was asked for by name,
 * and a missing one is a 404 — see the long note in serveStatic for why
 * answering it with the app shell is worse than answering nothing.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Served as octet-stream a browser ignores the manifest entirely, and iOS
  // then never offers "Add to Home Screen" — which is the one thing that makes
  // web push possible there at all.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

export function rendererRoot(): string {
  return resolve(process.env.RMOPS_RENDERER_DIR ?? join(process.cwd(), 'out/renderer'))
}

/** Is there a built renderer to serve at all? */
export function rendererExists(): boolean {
  return existsSync(join(rendererRoot(), 'index.html'))
}

/**
 * Resolve a URL path to a file inside the renderer root, or null.
 *
 * The `startsWith(root + sep)` check is the one that matters: without it
 * `/../../etc/passwd` reads whatever the process can reach. Normalising first
 * and then proving the result is still inside the root is the only form of this
 * check that cannot be tricked by encoding.
 */
function resolveWithin(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const candidate = normalize(join(root, decoded))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  return candidate
}

/**
 * Serve `pathname` from the renderer build.
 *
 * Returns false when there is nothing to serve and the caller should 404 —
 * which for this server only happens when the renderer has not been built.
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  extraHeaders: Record<string, string> = {}
): boolean {
  const root = rendererRoot()
  const index = join(root, 'index.html')
  if (!existsSync(index)) return false

  const resolved = pathname === '/' ? index : resolveWithin(root, pathname)
  const isFile = resolved !== null && existsSync(resolved) && statSync(resolved).isFile()

  // A request that NAMES A FILE and does not find one is a real 404. Only
  // extensionless paths fall through to the app shell, because those are the
  // ones a person could have typed or bookmarked.
  //
  // Answering index.html for a missing file is worse than a 404 every time, and
  // silently so, because the browser gets HTML with a 200 where it expected
  // something else and reports the confusion rather than the cause:
  //
  //   · a missing bundle under /assets is a console error about an unexpected
  //     token that says nothing about the deploy being incomplete;
  //   · /sw.js is worse — HTML registered as a service worker fails and the
  //     browser RETRIES on a schedule of its own for as long as the app is
  //     installed, while the notifications screen shows a toggle that turns
  //     itself back off with no error anywhere;
  //   · and the manifest and its icons are the quietest of the three. A
  //     manifest that parses as HTML, or an icon that does, makes the site
  //     non-installable — so "Add to Home Screen" produces a bookmark that
  //     opens in a browser tab, which on iOS cannot receive a push at all. The
  //     symptom is "notifications don't work" and the cause is a 200.
  //
  // Everything under /assets counts as named whatever it looks like. That is
  // not redundant with the extension test: a percent-encoded path
  // (`/assets/%2e%2e%2f…`) has no visible extension at all, and answering one
  // of those with the app shell would mean a probe for /etc/passwd gets a 200.
  const named =
    pathname.startsWith('/assets/') ||
    (extname(pathname) !== '' && extname(pathname) !== '.html')
  if (!isFile && named) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders })
    res.end('Not found.')
    return true
  }

  const file = isFile ? (resolved as string) : index
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const immutable = file !== index && pathname.startsWith('/assets/')
  // The home-screen icons are the one unhashed thing worth caching. They have
  // stable names, so they cannot be cached forever — but they are fetched again
  // for the icon and the badge of EVERY notification, and no-store on those
  // means re-downloading the artwork on a phone connection every time somebody
  // clocks in. A day is short enough that a changed logo lands the next day.
  // Never the manifest and never /sw.js: those two decide what the installed
  // app IS, and a stale copy of either is a fix that cannot ship.
  const cacheable = file !== index && type === 'image/png'

  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable
      ? 'public, max-age=31536000, immutable'
      : cacheable
        ? 'public, max-age=86400'
        : 'no-store',
    'content-length': statSync(file).size,
    ...extraHeaders
  })
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file).pipe(res)
  return true
}
