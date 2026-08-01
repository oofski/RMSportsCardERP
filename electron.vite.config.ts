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
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
