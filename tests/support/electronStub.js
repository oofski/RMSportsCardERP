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
  dialog: {},
  shell: {},
  nativeTheme: {},
  session: {},
  contextBridge: {},
  ipcRenderer: {},
  safeStorage: {}
}
