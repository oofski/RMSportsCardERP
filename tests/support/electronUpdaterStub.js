// Minimal electron-updater shim.
//
// Needed because src/main/ipc.ts imports the updater service, and the real
// package reaches for a running Electron the moment it is loaded. A test that
// wants to call an employee handler should not have to care. Only the surface
// the module touches at IMPORT time — the flags it sets and the events it
// subscribes to — is present; the check/download/install calls are never made
// from a test, and if one ever is, an undefined method is the right kind of
// loud.
const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  forceDevUpdateConfig: false,
  on: () => autoUpdater
}

module.exports = { autoUpdater, default: { autoUpdater } }
