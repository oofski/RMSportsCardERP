import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * The relay address and shared key, injected into the MAIN bundle at build time.
 *
 * Not committed, because this repository is public — a URL and a bearer token
 * sitting together in a public repo are found by automated scanners in hours.
 * CI supplies them from repository secrets (see .github/workflows/release.yml);
 * a local build gets empty strings and is simply standalone.
 *
 * Main only. The renderer never needs the key — it is told whether one is set,
 * never what it is — and there is no reason to put a secret in a second bundle.
 */
const syncDefines = {
  __CLOUD_SYNC_URL__: JSON.stringify(process.env.RMOPS_SYNC_URL ?? ''),
  __CLOUD_SYNC_KEY__: JSON.stringify(process.env.RMOPS_SYNC_KEY ?? '')
}

/**
 * The version, baked into the RENDERER bundle.
 *
 * Not a nicety. The server reports its own version at /health, and the desktop
 * app reports its own — but neither answers the question that actually matters
 * when a fix appears not to have landed: WHICH JAVASCRIPT IS THIS BROWSER
 * RUNNING? A tab holding an older bundle looks exactly like a bug that was
 * never fixed, and the two are diagnosed in completely different places.
 *
 * Read from package.json at build time, so it cannot drift from the release it
 * shipped in, and rendered where the work happens rather than buried in an
 * about box nobody opens mid-shift.
 */
const rendererDefines = {
  __APP_VERSION__: JSON.stringify(
    JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
  )
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: syncDefines,
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    define: rendererDefines,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
