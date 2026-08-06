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

await build({
  entryPoints: [resolve(ROOT, entry)],
  outfile: resolve(ROOT, outfile),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
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
        b.onResolve({ filter: /^electron$/ }, () => ({
          path: join(ROOT, 'tests/support/electronStub.js')
        }))
        // Same reason as `electron`: it expects a running app at import time,
        // and a test that reaches src/main/ipc.ts pulls it in transitively.
        b.onResolve({ filter: /^electron-updater$/ }, () => ({
          path: join(ROOT, 'tests/support/electronUpdaterStub.js')
        }))
      }
    }
  ]
})
