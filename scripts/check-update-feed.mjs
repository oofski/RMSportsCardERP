#!/usr/bin/env node
/**
 * Preflight for an update feed.
 *
 * Switching the app's feed is the one change that can break every installed
 * copy at once and give no sign of it: the app looks fine, "Check for updates"
 * just quietly never finds anything again. Nobody notices until a release goes
 * out that nobody receives.
 *
 * So the feed is verified BEFORE anything is pointed at it, and again after
 * every release that publishes to it. This checks the three things that
 * actually break:
 *
 *  1. The feed files exist and parse (update.json, latest.yml, latest-mac.yml).
 *  2. They are served with no-cache. A CDN holding a feed file for a year is
 *     indistinguishable from "there is no update" — this is the classic R2/
 *     Cloudflare mistake, because the sensible cache policy for the 100 MB
 *     installer beside it is the exact opposite.
 *  3. Every download URL the feed advertises actually resolves, and is big
 *     enough to be an installer rather than an error page with a 200 on it.
 *
 * Usage:
 *   node scripts/check-update-feed.mjs https://updates.rmcardz.com
 *   node scripts/check-update-feed.mjs https://updates.rmcardz.com --expect 0.0.52
 *
 * Exits non-zero on any failure, so CI can gate on it.
 */

const args = process.argv.slice(2)
const base = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '')
const expectAt = args.indexOf('--expect')
const expected = expectAt >= 0 ? args[expectAt + 1] : null

if (!base) {
  console.error('Usage: node scripts/check-update-feed.mjs <feed-base-url> [--expect <version>]')
  process.exit(2)
}

let failures = 0
let warnings = 0

const pass = (msg) => console.log(`  ok    ${msg}`)
const fail = (msg) => {
  failures++
  console.log(`  FAIL  ${msg}`)
}
const warn = (msg) => {
  warnings++
  console.log(`  warn  ${msg}`)
}

const TIMEOUT_MS = 15000

async function req(url, method = 'GET') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { method, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * How safe is this Cache-Control for a file that must always be fresh?
 *
 * 'ok'   — explicitly no-cache, or a short max-age.
 * 'bad'  — an explicitly LONG max-age. This is the real R2 footgun: the
 *          sensible policy for the 100 MB installer next to it is
 *          `immutable, max-age=31536000`, and applying that to the feed file
 *          pins every client to today's version for a year.
 * 'none' — no header at all. Not a failure: GitHub's release CDN sends none and
 *          works fine, because the client/CDN default is to revalidate. Worth
 *          saying out loud on a bucket you control, not worth blocking on.
 */
function cacheVerdict(header) {
  if (!header) return 'none'
  const h = header.toLowerCase()
  if (/no-cache|no-store|max-age\s*=\s*0/.test(h)) return 'ok'
  const m = /max-age\s*=\s*(\d+)/.exec(h)
  if (!m) return 'none'
  // A few minutes is fine; a day is not. The window between publishing and
  // clients seeing it should be shorter than the time it takes someone to ask
  // why they haven't got the update.
  return Number(m[1]) <= 300 ? 'ok' : 'bad'
}

/** Report on a feed file's cache headers. */
function checkCache(name, header) {
  const verdict = cacheVerdict(header)
  if (verdict === 'ok') pass(`cache-control ${header}`)
  else if (verdict === 'bad') {
    fail(`cache-control is "${header}" — clients will keep serving a stale version for that long`)
  } else {
    warn(`${name} sends no cache-control — works today, but set no-cache on a bucket you control`)
  }
}

console.log(`\nUpdate feed preflight — ${base}\n`)

// --- 1. update.json (the macOS / manual path) ------------------------------
console.log('update.json')
let feed = null
try {
  const res = await req(`${base}/update.json?ts=${Date.now()}`)
  if (!res.ok) {
    fail(`responded ${res.status} ${res.statusText}`)
  } else {
    pass(`responded ${res.status}`)
    const ctype = res.headers.get('content-type') ?? ''
    if (ctype.includes('json')) pass(`content-type ${ctype}`)
    else warn(`content-type is "${ctype}" — expected application/json`)

    checkCache('update.json', res.headers.get('cache-control'))

    try {
      feed = JSON.parse(await res.text())
      pass('parses as JSON')
    } catch (err) {
      fail(`does not parse: ${err.message}`)
    }
  }
} catch (err) {
  fail(`unreachable: ${err.message}`)
}

if (feed) {
  if (typeof feed.version === 'string' && /^\d+\.\d+\.\d+/.test(feed.version)) {
    pass(`advertises version ${feed.version}`)
  } else {
    fail(`version is ${JSON.stringify(feed.version)} — expected a dotted version string`)
  }
  if (expected && feed.version !== expected) {
    fail(`expected version ${expected}, feed says ${feed.version}`)
  } else if (expected) {
    pass(`version matches the release being published (${expected})`)
  }

  const downloads = feed.downloads ?? {}
  const wanted = ['win', 'mac-arm64', 'mac-x64']
  for (const key of wanted) {
    const url = downloads[key]
    if (!url) {
      fail(`downloads.${key} is missing — that platform can never update`)
      continue
    }
    try {
      // HEAD first; some object stores answer HEAD differently, so fall back to
      // a ranged GET rather than reporting a false failure.
      let res = await req(url, 'HEAD')
      if (!res.ok || !res.headers.get('content-length')) res = await req(url, 'GET')
      const len = Number(res.headers.get('content-length') ?? 0)
      if (!res.ok) fail(`downloads.${key} → ${res.status} ${res.statusText}`)
      else if (len > 0 && len < 1_000_000) {
        // A 200 that is 3 KB is an error page, not an installer.
        fail(`downloads.${key} is only ${len} bytes — that is not an installer`)
      } else {
        pass(`downloads.${key} → ${res.status}${len ? ` (${(len / 1e6).toFixed(1)} MB)` : ''}`)
      }
    } catch (err) {
      fail(`downloads.${key} unreachable: ${err.message}`)
    }
  }
}

// --- 2. electron-updater feeds (the self-updating path) --------------------
for (const name of ['latest.yml', 'latest-mac.yml']) {
  console.log(`\n${name}`)
  try {
    const res = await req(`${base}/${name}?ts=${Date.now()}`)
    if (!res.ok) {
      // latest-mac.yml only matters once Macs self-update; say so rather than
      // failing a Windows-only feed.
      if (name === 'latest-mac.yml') warn(`responded ${res.status} — needed only once Macs self-update`)
      else fail(`responded ${res.status} ${res.statusText} — Windows auto-update will not work`)
      continue
    }
    pass(`responded ${res.status}`)
    checkCache(name, res.headers.get('cache-control'))

    const body = await res.text()
    const version = /^version:\s*(.+)$/m.exec(body)?.[1]?.trim()
    const path = /^path:\s*(.+)$/m.exec(body)?.[1]?.trim()
    if (version) pass(`advertises version ${version}`)
    else fail('no `version:` line')
    if (expected && version && version !== expected) {
      fail(`expected version ${expected}, ${name} says ${version}`)
    }
    if (!path) {
      fail('no `path:` line — electron-updater will not know what to download')
    } else {
      const url = `${base}/${encodeURIComponent(path)}`
      try {
        let res2 = await req(url, 'HEAD')
        if (!res2.ok) res2 = await req(url, 'GET')
        if (res2.ok) pass(`path resolves → ${path}`)
        else fail(`path does not resolve (${res2.status}): ${path}`)
      } catch (err) {
        fail(`path unreachable: ${err.message}`)
      }
    }
  } catch (err) {
    fail(`unreachable: ${err.message}`)
  }
}

console.log(
  `\n${failures === 0 ? 'FEED OK' : 'FEED NOT READY'} — ${failures} failure(s), ${warnings} warning(s)\n`
)
process.exit(failures === 0 ? 0 : 1)
