import { createBridge, type RmOpsApi } from '../../../bridge'
import { httpTransport } from './httpTransport'

/**
 * Single access point to the backend, on whichever transport this build has.
 *
 * `window.rmops` exists only when a preload put it there — that is the Electron
 * app talking to its own main process over IPC. In a browser tab there is no
 * preload and no `window.rmops`, so the SAME bridge definition is built over
 * HTTP instead (see httpTransport.ts) and every screen carries on unchanged.
 *
 * Decided at runtime rather than at build time on purpose: one renderer bundle
 * is served by the desktop app and by the server, so there is no second build to
 * keep in step and no way to ship the wrong one.
 *
 * Everything else in the UI imports `api` from here rather than reaching for a
 * global, which is what made this a one-line decision instead of a rewrite.
 */
export const api: RmOpsApi = window.rmops ?? createBridge(httpTransport)
