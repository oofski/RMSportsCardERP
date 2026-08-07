/**
 * Stands in for electron-updater inside the headless server.
 *
 * `main/ipc.ts` registers the update-check operations, which reach for
 * `autoUpdater`. A server does not update itself the way a desktop app does —
 * it is redeployed — so the object exists to satisfy the import and does
 * nothing. The update operations are among the handful that only make sense on
 * a desktop client, and the desktop client keeps answering them locally.
 */
const noop = (): void => {}

/**
 * The marker that tells services/updater.ts it is running on the server.
 *
 * It has to be able to tell, and this is the honest place to say so: this file
 * is substituted for `electron-updater` by the server build's alias and by
 * nothing else, so the flag is true exactly when the server bundle is the one
 * executing. Sniffing `process.platform` instead would say "linux", which a
 * Linux desktop build also says, and asking `app.getName()` would depend on a
 * string somebody is free to change.
 *
 * What it prevents: a browser tab being told a newer version is available and
 * offered a .dmg it cannot install. A web page is not a build — it is whatever
 * was last deployed, which is by definition current.
 */
export const serverStub = true

export const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  forceDevUpdateConfig: false,
  on: noop,
  once: noop,
  removeAllListeners: noop,
  checkForUpdates: async (): Promise<null> => null,
  downloadUpdate: async (): Promise<never[]> => [],
  quitAndInstall: noop,
  setFeedURL: noop
}

export default { autoUpdater, serverStub }
