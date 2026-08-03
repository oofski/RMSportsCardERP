// Minimal Electron shim so the main-process DB layer can run under plain Node.
// Only the surface the database module actually touches.
module.exports = {
  app: {
    getPath: () => process.env.TEST_DB_DIR,
    getName: () => 'rm-operations-test',
    getVersion: () => '0.0.0'
  },
  ipcMain: { handle: () => {} },
  BrowserWindow: {},
  // Owner recovery reports the new password through a modal. Capturing the
  // detail text is what lets a test assert that the password shown is the one
  // that actually signs in — the property the whole mechanism rests on.
  dialog: {
    showMessageBoxSync: (opts) => {
      global.__lastDialogDetail = opts && opts.detail ? String(opts.detail) : ''
      return 0
    }
  },
  shell: {},
  nativeTheme: {},
  session: {},
  contextBridge: {},
  ipcRenderer: {},
  safeStorage: {}
}
