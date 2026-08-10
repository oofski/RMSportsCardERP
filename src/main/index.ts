import { app, shell, BrowserWindow, nativeTheme, session, ipcMain as electronIpcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { APP_NAME } from '@shared/config'
import { setRegistrationSink } from './ipcRegistry'
import { registerIpcHandlers } from './ipc'
import { honourOwnerReset } from './services/ownerRecovery'
import { registerInventoryIpc } from './inventoryIpc'
import { registerPurchaseOrdersIpc } from './purchaseOrdersIpc'
import { startTrackingPoller } from './tracking/poller'
import { registerShippingIpc } from './shippingIpc'
import { registerStreamingIpc } from './streamingIpc'
import { registerQuickBooksIpc } from './quickbooksIpc'
import { registerFinanceIpc } from './financeIpc'
import { registerSyncIpc } from './syncIpc'
import { registerOwnerIpc } from './ownerIpc'
import { registerScheduleIpc } from './scheduleIpc'
import { registerInvoicesIpc } from './invoicesIpc'
import { registerPerformanceIpc } from './performanceIpc'
import { getDb, closeDb } from './db/database'
import { initUpdater } from './services/updater'
import { initCloudSync, stopCloudSync } from './services/cloudSync'

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
      nodeIntegration: false,
      // Chromium's built-in PDF viewer. The picker works with the original
      // packing slip open beside the pick list, and it has to page around a
      // 200-page document instantly — that is a job for the engine's own viewer
      // rather than something rendered a page at a time over IPC.
      plugins: true
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

  // Deny EVERY permission class. The webcam barcode decoder was the only thing
  // that ever needed one ('media' for getUserMedia); scanning is now the
  // handheld wedge only, which is plain keyboard input and asks for nothing. An
  // operations app that reads local files and talks to one API has no business
  // holding a camera, microphone, geolocation or notification grant, so the
  // handlers stay — saying no — rather than being deleted.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  // Send every operation the modules below register on to Electron's real
  // ipcMain. They register with the transport-agnostic registry instead of
  // importing ipcMain directly, so the identical handlers can also be served
  // over a network by a shared-database server — see ipcRegistry.ts. Installed
  // BEFORE the register* calls, though the registry replays anything earlier
  // anyway rather than depending on the order.
  setRegistrationSink((channel, handler) => {
    electronIpcMain.handle(channel, handler as Parameters<typeof electronIpcMain.handle>[1])
  })

  // Initialise the database up front so a failure surfaces early.
  getDb()
  // Before the window opens, so the new password is on screen at the same time
  // as the login form asking for it. No-op unless the trigger file is present.
  honourOwnerReset()
  registerIpcHandlers()
  registerInventoryIpc()
  registerPurchaseOrdersIpc()
  // The hourly carrier sweep. Starts itself late and does nothing at all on a
  // build with no browser to read with — see src/main/tracking/poller.ts.
  startTrackingPoller()
  registerShippingIpc()
  registerStreamingIpc()
  registerQuickBooksIpc()
  registerFinanceIpc()
  registerSyncIpc()
  registerOwnerIpc()
  registerScheduleIpc()
  registerInvoicesIpc()
  registerPerformanceIpc()
  initUpdater()
  // Starts the push/pull loop only if sync has been switched on; a standalone
  // install never opens a socket.
  initCloudSync()

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
  stopCloudSync()
  closeDb()
})
