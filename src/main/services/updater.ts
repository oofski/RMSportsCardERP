import { app, BrowserWindow } from 'electron'
import pkg from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { IPC } from '@shared/ipc'

// electron-updater ships as CommonJS; destructure the default export.
const { autoUpdater } = pkg

/**
 * Auto-update wiring.
 *
 * For now the full download-and-install flow is Windows-only (per the current
 * requirement). On macOS/Linux the "Check for updates" panel reports that
 * auto-update isn't available yet, rather than erroring — the Mac flow will be
 * added in a later pass once the app is code-signed.
 */
const isWindows = process.platform === 'win32'

let status: UpdateStatus = {
  phase: isWindows ? 'idle' : 'unsupported',
  currentVersion: app.getVersion(),
  message: isWindows
    ? undefined
    : 'Automatic updates are Windows-only for now. On Mac, download the latest version from the releases page.'
}

let initialised = false

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.updatesStatusEvent, status)
  }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion() }
  broadcast()
}

export function initUpdater(): void {
  if (initialised || !isWindows) {
    initialised = true
    return
  }
  initialised = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // Lets "Check for updates" be exercised against the real feed while running
  // an unpackaged dev build (uses dev-app-update.yml).
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('checking-for-update', () => {
    setStatus({ phase: 'checking', message: 'Checking for updates…' })
  })

  autoUpdater.on('update-available', (info) => {
    setStatus({
      phase: 'available',
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate,
      message: `Version ${info.version} is available.`
    })
  })

  autoUpdater.on('update-not-available', () => {
    setStatus({
      phase: 'not-available',
      message: "You're on the latest version."
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    setStatus({
      phase: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
      message: `Downloading… ${Math.round(progress.percent)}%`
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({
      phase: 'downloaded',
      availableVersion: info.version,
      percent: 100,
      message: `Version ${info.version} is ready to install.`
    })
  })

  autoUpdater.on('error', (err) => {
    setStatus({
      phase: 'error',
      message: err == null ? 'Update error.' : String(err.message ?? err)
    })
  })
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status, currentVersion: app.getVersion() }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!isWindows) {
    return getUpdateStatus()
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return getUpdateStatus()
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!isWindows) return getUpdateStatus()
  if (status.phase !== 'available' && status.phase !== 'error') return getUpdateStatus()
  try {
    setStatus({ phase: 'downloading', percent: 0, message: 'Starting download…' })
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
  }
  return getUpdateStatus()
}

export function installUpdate(): void {
  if (!isWindows) return
  if (status.phase !== 'downloaded') return
  // Quit and install on next tick so the IPC reply can flush first.
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}
