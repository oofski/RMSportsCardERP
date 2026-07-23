import { app, BrowserWindow } from 'electron'
import pkg from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { IPC } from '@shared/ipc'
import { UPDATE_FEED_URL } from '@shared/config'

// electron-updater ships as CommonJS; destructure the default export.
const { autoUpdater } = pkg

/**
 * Auto-update wiring, delivered from the Cloudflare-hosted feed.
 *
 * - Windows: electron-updater (generic provider → Cloudflare) downloads and
 *   installs the new version automatically.
 * - macOS: because unsigned Mac apps cannot self-install (an Apple / Gatekeeper
 *   requirement, independent of where the files are hosted), the app instead
 *   checks a small `update.json` on the feed and, when a newer version exists,
 *   offers a direct download of the .dmg for the user to reinstall. Once the
 *   app is code-signed + notarized this can be switched to true auto-update.
 */
const platform = process.platform
const isWindows = platform === 'win32'

let status: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  platform
}

let initialised = false

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.updatesStatusEvent, status)
  }
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch, currentVersion: app.getVersion(), platform }
  broadcast()
}

export function initUpdater(): void {
  if (initialised) return
  initialised = true
  if (!isWindows) return // macOS/Linux use the JSON check below, no listeners needed

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
  if (isWindows) {
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
  // Only Windows performs an in-app download+install; macOS uses openDownload().
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
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

/** The direct download link for the current available update (macOS path). */
export function currentDownloadUrl(): string | null {
  return status.downloadUrl ?? null
}
