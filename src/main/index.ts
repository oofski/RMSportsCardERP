import { app, shell, BrowserWindow, nativeTheme, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { APP_NAME } from '@shared/config'
import { registerIpcHandlers } from './ipc'
import { registerInventoryIpc } from './inventoryIpc'
import { registerPurchaseOrdersIpc } from './purchaseOrdersIpc'
import { getDb, closeDb } from './db/database'
import { initUpdater } from './services/updater'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    // Never open windows in-app; hand only safe, expected schemes to the OS.
    if (/^https?:/i.test(details.url) || /^mailto:/i.test(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.rmcardz.operations')
  nativeTheme.themeSource = 'light'

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Camera access for in-app barcode scanning: grant only 'media' (getUserMedia)
  // to our own window and deny every other permission class outright. Both
  // handlers are needed — Chromium asks the check handler before it even offers
  // the device list.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media')
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  // Initialise the database up front so a failure surfaces early.
  getDb()
  registerIpcHandlers()
  registerInventoryIpc()
  registerPurchaseOrdersIpc()
  initUpdater()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  closeDb()
})
