/**
 * Bundle a main-process test to CJS so it can run under plain Node.
 *
 * Needed for anything that touches src/main: those modules import `electron`
 * (which does not exist outside the app) and `@shared/*` (a tsconfig path alias
 * esbuild's CLI cannot resolve on its own). Both are rewritten here.
 *
 *   node tests/build.mjs <entry.ts> <out.cjs>
 */
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [entry, outfile] = process.argv.slice(2)
if (!entry || !outfile) {
  console.error('usage: node tests/build.mjs <entry.ts> <out.cjs>')
  process.exit(1)
}

/**
 * THE SUITES RUN ON THE BUSINESS'S CLOCK, not the developer's.
 *
 * RM operates in US Central, and that is what @shared/businessTime measures
 * every business day and every ledger instant against. The suites, though, build
 * their fixtures with `new Date(2026, 6, 12, 19)` and render their fake Whatnot
 * exports with local getters — the MACHINE's zone on both sides. That is
 * self-consistent wherever it runs, which is exactly why it could never see the
 * bug it was hiding: on a UTC machine the fixture means 7pm UTC while the ledger
 * parser correctly reads "7:00 PM" as 7pm Central, and a show matches none of
 * its own sales. The suite went green on the owner's laptop and red in a
 * container, for the same reason the web app did.
 *
 * Pinning the zone here makes every suite deterministic and makes the fixtures
 * mean what they say. It is set as a BANNER so it runs before any module in the
 * bundle touches a date — Node re-reads TZ on assignment, but only for dates
 * created afterwards.
 *
 * `RMOPS_TEST_TZ_PASSTHROUGH` is the deliberate escape hatch, and exactly one
 * caller uses it: tests/businessTime.test.ts spawns itself in three different
 * zones to prove desktop and web now agree. Forcing the zone on those children
 * would make that proof vacuous.
 */
const TZ_BANNER =
  "if (!process.env.RMOPS_TEST_TZ_PASSTHROUGH) process.env.TZ = process.env.RMOPS_TEST_TZ || 'America/Chicago';"

await build({
  entryPoints: [resolve(ROOT, entry)],
  outfile: resolve(ROOT, outfile),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
  banner: { js: TZ_BANNER },
  // Native module: must stay a real require, not be inlined.
  external: ['better-sqlite3'],
  plugins: [
    {
      name: 'rmops-test-aliases',
      setup(b) {
        b.onResolve({ filter: /^@shared\// }, (a) => ({
          path: join(ROOT, 'src/shared', a.path.replace(/^@shared\//, '') + '.ts')
        }))
        // Feasibility spike: point the db layer at the Cloudflare Durable Object
        // adapter instead of the native driver, WITHOUT editing src/main. A suite
        // that passes under this flag is evidence the code transplants; one that
        // fails names something a Durable Object cannot do. Off by default, so
        // `npm test` keeps testing what ships.
        if (process.env.RMOPS_SQL_ADAPTER === '1') {
          b.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: join(ROOT, 'tests/support/betterSqlite3Adapter.ts')
          }))
        }
        // Which Electron stand-in a test gets.
        //
        // Most tests want the minimal one in tests/support: enough surface for
        // the database layer, and nothing else. The web-server test wants the
        // one the SERVER actually ships with — it is the thing under test.
        // Downloads, the SSE push window and the data directory all live in
        // that file, so testing against a different stub would be testing a
        // server that does not exist.
        const serverStub = process.env.RMOPS_ELECTRON === 'server'
        b.onResolve({ filter: /^electron$/ }, () => ({
          path: join(ROOT, serverStub ? 'src/server/electron-stub.ts' : 'tests/support/electronStub.js')
        }))
        // Same reason as `electron`: it expects a running app at import time,
        // and a test that reaches src/main/ipc.ts pulls it in transitively.
        b.onResolve({ filter: /^electron-updater$/ }, () => ({
          path: join(
            ROOT,
            serverStub ? 'src/server/electron-updater-stub.ts' : 'tests/support/electronUpdaterStub.js'
          )
        }))
        // pdfjs is ESM-only and must stay a real runtime import: bundled into
        // CJS it loses the environment it expects and dies on a missing
        // DOMMatrix the first time a PDF is parsed.
        b.onResolve({ filter: /^pdfjs-dist/ }, (a) => ({ path: a.path, external: true }))
      }
    }
  ]
})
