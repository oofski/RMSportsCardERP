import type { RmOpsApi } from '../bridge'

declare global {
  interface Window {
    /**
     * Present only in the Electron build — the preload puts it there. In a
     * browser it is `undefined`, which is exactly how lib/api.ts decides to
     * build an HTTP-backed bridge instead. Optional on purpose: code that
     * assumes it exists would compile and then fail on first paint in a tab.
     */
    rmops?: RmOpsApi
  }
}

export {}
