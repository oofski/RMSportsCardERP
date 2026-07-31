/**
 * Stands in for Electron inside the headless server.
 *
 * The handler files import `dialog`, `BrowserWindow` and `shell` for the 14
 * operations that open a file picker, a save dialog or a browser. Those are
 * desktop actions by definition — there is no window on a server and no screen
 * to put one on — so rather than pretend, each throws a sentence that says what
 * happened and where to do it instead.
 *
 * `app.getPath('userData')` is the one thing that must genuinely work, because
 * it is where the database lives. On a server that is a configured directory
 * rather than an OS profile path.
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

function dataDir(): string {
  const dir = resolve(process.env.RMOPS_DATA_DIR ?? './data')
  mkdirSync(dir, { recursive: true })
  return dir
}

function unavailable(what: string): never {
  throw new Error(
    `${what} is not available on the server — do that from the desktop app, which sends the file up.`
  )
}

export const app = {
  getPath: (name: string): string => (name === 'userData' ? dataDir() : dataDir()),
  getName: (): string => 'RM Operations Server',
  getVersion: (): string => process.env.RMOPS_VERSION ?? '0.0.0',
  isPackaged: true,
  relaunch: (): never => unavailable('Restarting the app'),
  quit: (): void => process.exit(0),
  on: (): void => {},
  whenReady: async (): Promise<void> => {}
}

export const dialog = {
  showOpenDialog: (): never => unavailable('Choosing a file'),
  showSaveDialog: (): never => unavailable('Saving a file'),
  showMessageBox: (): never => unavailable('A message box')
}

export const shell = {
  openExternal: (): never => unavailable('Opening a link'),
  openPath: (): never => unavailable('Opening a file'),
  showItemInFolder: (): never => unavailable('Revealing a file')
}

export const BrowserWindow = {
  fromWebContents: (): null => null,
  getFocusedWindow: (): null => null,
  getAllWindows: (): never[] => []
}

export const nativeTheme = { themeSource: 'light' as const, shouldUseDarkColors: false }

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): never => unavailable('The OS keychain'),
  decryptString: (): never => unavailable('The OS keychain')
}

export const ipcMain = { handle: (): void => {}, on: (): void => {} }
export const ipcRenderer = {}
export const contextBridge = {}
export const session = {
  defaultSession: {
    setPermissionRequestHandler: (): void => {},
    setPermissionCheckHandler: (): void => {}
  }
}
export const clipboard = { writeText: (): never => unavailable('The clipboard') }

export default { app, dialog, shell, BrowserWindow, nativeTheme, safeStorage, ipcMain, session }
