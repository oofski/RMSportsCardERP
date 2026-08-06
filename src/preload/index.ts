import { contextBridge, ipcRenderer } from 'electron'
import { createBridge, type RmOpsApi } from '../bridge'

/**
 * The Electron half of the client bridge.
 *
 * Every method the renderer calls is defined once, in src/bridge — this file
 * only says which transport those methods use. Electron's `ipcRenderer` already
 * has the three methods the bridge asks for, so it is passed straight through
 * and each call is an ordinary IPC invoke, exactly as it was before the browser
 * build existed.
 *
 * The browser build passes a different object to the SAME factory (see
 * renderer/src/lib/httpTransport.ts). Neither side can gain a method the other
 * lacks, because there is only one definition of the surface.
 */
const api: RmOpsApi = createBridge(ipcRenderer)

export type { RmOpsApi }

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('rmops', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore — fallback when context isolation is disabled
  window.rmops = api
}
