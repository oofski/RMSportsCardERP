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

export default { autoUpdater }
