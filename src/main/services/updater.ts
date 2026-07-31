import { app, BrowserWindow } from 'electron'
import pkg from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { IPC } from '@shared/ipc'
import { MAC_AUTO_UPDATE, UPDATE_FEED_URL } from '@shared/config'

// electron-updater ships as CommonJS; destructure the default export.
const { autoUpdater } = pkg

/**
 * Auto-update wiring, delivered from the update feed.
 *
 * Two paths, and which one a platform takes is decided by ONE question: can
 * this build replace itself in place?
 *
 *  · MANAGED (electron-updater): downloads and installs on its own. Always the
 *    case on Windows. On macOS only when the build is signed and notarized —
 *    Squirrel.Mac checks the signature before swapping the bundle, and rejects
 *    an unsigned one. See MAC_AUTO_UPDATE in @shared/config.
 *
 *  · MANUAL (`update.json` + a download link): the app reports that a newer
 *    version exists and hands over a .dmg to reinstall. Used on an unsigned
 *    macOS build and on Linux.
 *
 * That is an Apple rule enforced on the client, so it is unaffected by where
 * the files are hosted — moving the feed from GitHub to Cloudflare changes the
 * URL and nothing else about it.
 */
const platform = process.platform
const isWindows = platform === 'win32'
const isMac = platform === 'darwin'

/** Can this build install its own update, or must a human reinstall it? */
const selfUpdating = isWindows || (isMac && MAC_AUTO_UPDATE)

let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  platform,
  selfUpdating
}

let initialised = false

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.updatesStatusEvent, status)
  }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion(), platform, selfUpdating }
  broadcast()
}

export function initUpdater(): void {
  if (initialised) return
  initialised = true
  // A manual-path platform has nothing to listen to — it polls update.json.
  if (!selfUpdating) return

  // Auto-sync: on launch the app quietly pulls a newer version in the background
  // (delta download) and installs it on the next quit — or the user can restart
  // to apply it immediately from the update panel.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.on('checking-for-update', () => setStatus({ phase: 'checking', message: 'Checking for updates…' }))
  autoUpdater.on('update-available', (info) =>
    setStatus({
      phase: 'available',
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      releaseDate: info.releaseDate,
      message: `Version ${info.version} is available.`
    })
  )
  autoUpdater.on('update-not-available', () =>
    setStatus({ phase: 'not-available', message: "You're on the latest version." })
  )
  autoUpdater.on('download-progress', (p) =>
    setStatus({ phase: 'downloading', percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond, message: `Downloading… ${Math.round(p.percent)}%` })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setStatus({ phase: 'downloaded', availableVersion: info.version, percent: 100, message: `Version ${info.version} is ready to install.` })
  )
  autoUpdater.on('error', (err) =>
    setStatus({ phase: 'error', message: err == null ? 'Update error.' : String(err.message ?? err) })
  )

  // Check once on launch, a few seconds after startup so it never blocks the UI.
  // Only in packaged builds; errors are swallowed so a transient network hiccup
  // never nags the user (the manual "Check for updates" button still reports).
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => undefined)
    }, 4000)
  }
}

export function getUpdateStatus(): UpdateStatus {
  return { ...status, currentVersion: app.getVersion(), platform }
}

// ---------------------------------------------------------------------------
// macOS / Linux: JSON feed check (no auto-install for unsigned builds)
// ---------------------------------------------------------------------------

interface UpdateJson {
  version: string
  releaseDate?: string
  notes?: string
  downloads?: Record<string, string>
}

/** Compare dotted numeric versions. Returns true when `remote` > `current`. */
function isNewer(remote: string, current: string): boolean {
  const norm = (v: string): number[] =>
    v.replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const a = norm(remote)
  const b = norm(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** The update.json download key for the current platform, or null if none. */
function downloadKey(): string | null {
  if (platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'win32') return 'win'
  return null
}

async function checkViaJson(): Promise<void> {
  setStatus({ phase: 'checking', message: 'Checking for updates…' })
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    let res: Response
    try {
      res = await fetch(`${UPDATE_FEED_URL}/update.json?ts=${Date.now()}`, {
        signal: controller.signal,
        cache: 'no-store'
      } as RequestInit)
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`Feed responded ${res.status}`)
    const data = (await res.json()) as UpdateJson

    if (!data.version || !isNewer(data.version, app.getVersion())) {
      setStatus({ phase: 'not-available', message: "You're on the latest version." })
      return
    }
    const key = downloadKey()
    const url = key ? data.downloads?.[key] : undefined
    setStatus({
      phase: 'available',
      availableVersion: data.version,
      releaseNotes: data.notes,
      releaseDate: data.releaseDate,
      downloadUrl: url,
      message: `Version ${data.version} is available to download.`
    })
  } catch (err) {
    setStatus({
      phase: 'error',
      message: err instanceof Error ? err.message : 'Could not reach the update server.'
    })
  }
}

// ---------------------------------------------------------------------------
// Public actions (called from IPC)
// ---------------------------------------------------------------------------

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (selfUpdating) {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  } else {
    await checkViaJson()
  }
  return getUpdateStatus()
}

export async function downloadUpdate(): Promise<UpdateStatus> {
  // Only a self-updating build downloads in-app; the rest use openDownload().
  if (!selfUpdating) return getUpdateStatus()
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
  if (!selfUpdating) return
  if (status.phase !== 'downloaded') return
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

/** The direct download link for the current available update (macOS path). */
export function currentDownloadUrl(): string | null {
  return status.downloadUrl ?? null
}
