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
 * Unknown paths fall through to index.html. The app has no router today (the
 * shell switches on state, see renderer/src/App.tsx), but a browser reloading
 * on any URL must still land in the app rather than on a 404, and that is the
 * whole of "client-side routing support".
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

  // A missing ASSET is a real 404 — answering index.html for a missing bundle
  // hands the browser HTML where it expected JavaScript, and the console error
  // that follows says nothing about the deploy being incomplete.
  if (!isFile && pathname.startsWith('/assets/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...extraHeaders })
    res.end('Not found.')
    return true
  }

  const file = isFile ? (resolved as string) : index
  const immutable = file !== index && pathname.startsWith('/assets/')

  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
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
