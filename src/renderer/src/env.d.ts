/// <reference types="vite/client" />
import type { RmOpsApi } from '../../preload/index'

declare global {
  interface Window {
    rmops: RmOpsApi
  }
  /**
   * The version this BUNDLE was built from, injected by
   * electron.vite.config.ts.
   *
   * Inside `declare global` deliberately: this file imports, which makes it a
   * module, and a bare `declare const` in a module is scoped to the file rather
   * than ambient — so it would typecheck here and be missing everywhere it is
   * actually used.
   *
   * Distinct from anything the server or the desktop shell reports about
   * itself. This is the one number that answers "which JavaScript is this
   * browser running", which a tab holding a stale bundle otherwise makes
   * impossible to answer — and a stale bundle looks exactly like a bug that was
   * never fixed.
   */
  const __APP_VERSION__: string
}

export {}

/**
 * The version this BUNDLE was built from, injected by electron.vite.config.ts.
 *
 * Distinct from anything the server or the desktop shell reports about itself:
 * this is the one number that answers "which JavaScript is this browser
 * running", which is the question a tab holding a stale bundle makes impossible
 * to answer any other way — and a stale bundle looks exactly like a bug that was
 * never fixed.
 */
