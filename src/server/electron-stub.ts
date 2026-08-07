/**
 * Stands in for Electron inside the headless server.
 *
 * The handler files import `dialog`, `BrowserWindow`, `shell` and `safeStorage`
 * for the operations that open a file picker, a save dialog, a browser or the
 * OS keychain. There is no window on a server and no screen to put one on — but
 * there IS a browser at the other end of the request, and it can do most of
 * those things natively. So rather than throw, this stub records what the
 * handler asked for (see clientActions.ts) and the HTTP layer sends it back for
 * the browser to carry out.
 *
 * Exactly one thing genuinely cannot be answered this way: `showOpenDialog`.
 * Choosing a file is the one action that has to happen BEFORE the handler runs,
 * and no amount of plumbing after the fact can undo that. Those handlers take
 * the file's CONTENT instead — see @shared/types `UploadedFile` — and this stub
 * only ever sees the dialog call when something on the desktop path is reached
 * by mistake, which is why the message says what to do instead.
 *
 * `app.getPath('userData')` is the one thing that must genuinely work, because
 * it is where the database and the product images live. On a server that is a
 * configured directory rather than an OS profile path, and on a deployment it
 * is the mounted volume — see docs/WEB.md.
 */

import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  currentClientActions,
  mimeForFilename,
  safeDownloadName,
  type PendingDownload
} from './clientActions'

/**
 * Where everything durable lives.
 *
 * Defaults to ./data so a developer running `npm run server` gets something
 * that works. In the container it is /data, which is the mount point of the
 * volume — a deployment that forgets to mount one silently writes the company's
 * database into a filesystem that dies with the container, which is why
 * server/index.ts refuses to start in production unless this is set explicitly.
 */
export function dataDir(): string {
  const dir = resolve(process.env.RMOPS_DATA_DIR ?? './data')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * What version this server is running.
 *
 * It used to answer '0.0.0' unless somebody remembered to set an environment
 * variable, and nobody did — so the web app displayed "version 0.0.0" and, worse,
 * every release looked NEWER than it, which is how a browser tab came to offer a
 * macOS installer it could not possibly use.
 *
 * Read from package.json rather than injected at build time, because the file is
 * genuinely there in every case that matters: the Dockerfile copies it into the
 * runtime image beside out/server, and a checkout running `npm run server` has it
 * at the working directory. Both are tried; the answer is cached because it
 * cannot change while the process lives.
 */
let cachedVersion: string | null = null

function readVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  const fromEnv = process.env.RMOPS_VERSION
  if (fromEnv) return (cachedVersion = fromEnv)
  const candidates = [
    // out/server/index.cjs → /app/package.json, which is the container layout.
    join(__dirname, '..', '..', 'package.json'),
    join(process.cwd(), 'package.json')
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return (cachedVersion = parsed.version)
      }
    } catch {
      // Next candidate. A missing or unreadable package.json is not fatal —
      // the version is a label, and the server has a warehouse to run.
    }
  }
  return (cachedVersion = '0.0.0')
}

function unavailable(what: string): never {
  throw new Error(
    `${what} is not available on the server — the browser sends the file up instead.`
  )
}

export const app = {
  getPath: (name: string): string => (name === 'userData' ? dataDir() : dataDir()),
  getName: (): string => 'RM Operations Server',
  getVersion: readVersion,
  isPackaged: true,
  relaunch: (): never => {
    throw new Error('Restarting the app is a desktop action; redeploy the server instead.')
  },
  quit: (): void => process.exit(0),
  on: (): void => {},
  whenReady: async (): Promise<void> => {}
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

interface SaveDialogOptions {
  defaultPath?: string
  title?: string
}

/**
 * Where a "saved" file is actually written, and what it should be called when
 * it reaches the browser. Keyed by the temp path handed back to the handler,
 * because the handler writes to that path with an ordinary `writeFileSync` and
 * never learns that anything unusual happened.
 */
const spooled = new Map<string, { filename: string }>()

function spoolDir(): string {
  const dir = join(tmpdir(), 'rmops-exports')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Turn a save dialog into a download.
 *
 * The handler believes it picked a location and writes the file there; it lands
 * in a temp directory instead, and `takeSpooledDownloads()` collects it once the
 * handler returns. Nothing about the export code changes — including the
 * permission check that decides whether the file may be produced at all.
 */
export const dialog = {
  showOpenDialog: (): never => unavailable('Choosing a file'),
  showSaveDialog: async (
    ...args: unknown[]
  ): Promise<{ canceled: boolean; filePath?: string }> => {
    const actions = currentClientActions()
    // Outside a request there is nobody to hand the file to. That is a bug
    // rather than a user-facing condition, so it says so plainly.
    if (!actions) unavailable('Saving a file')
    const opts = (args[args.length - 1] ?? {}) as SaveDialogOptions
    const filename = safeDownloadName(basename(String(opts.defaultPath ?? '')), 'export.csv')
    const filePath = join(spoolDir(), `${randomUUID()}-${filename}`)
    spooled.set(filePath, { filename })
    return { canceled: false, filePath }
  },
  showMessageBox: (): never => {
    throw new Error('A message box is a desktop action and has no meaning on a server.')
  },
  showMessageBoxSync: (): number => 0
}

/** Is this one of the temporary paths a save dialog handed back? */
export function isSpoolPath(path: string): boolean {
  return path.startsWith(spoolDir() + '/') || path.startsWith(tmpdir())
}

/**
 * Collect whatever the handler wrote through a save dialog.
 *
 * Reads the spooled files and forgets them: an export is handed over exactly
 * once, and a temp file left on disk after a failed request is a copy of
 * business data nobody is watching.
 */
export function takeSpooledDownloads(): PendingDownload[] {
  const out: PendingDownload[] = []
  for (const [path, meta] of spooled) {
    spooled.delete(path)
    try {
      out.push({
        filename: meta.filename,
        mime: mimeForFilename(meta.filename),
        bytes: readFileSync(path),
        disposition: 'attachment'
      })
    } catch {
      // The handler cancelled before writing, or wrote nowhere. Not an error:
      // an export the user abandoned should produce no download at all.
    }
    try {
      unlinkSync(path)
    } catch {
      // Best effort. The directory is temp; the OS clears it either way.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export const shell = {
  /**
   * The desktop hands a URL to the OS browser. Here the caller IS a browser, so
   * the URL is sent back and the tab opens it — after the handler's permission
   * check, and after its own scheme check, both of which still run.
   */
  openExternal: async (url: string): Promise<void> => {
    const actions = currentClientActions()
    if (!actions) throw new Error('Opening a link outside a request.')
    if (!/^https?:/i.test(url) && !/^mailto:/i.test(url)) {
      throw new Error('Refusing to open an unexpected URL scheme.')
    }
    actions.open.push(url)
  },
  /**
   * "Show the user this file I just made." On the desktop that is the OS
   * viewer; here it is an inline download, which is the same thing a browser
   * does with a PDF.
   *
   * Resolves to the empty string on success, because that is Electron's
   * contract and `openPoPdf` treats any non-empty string as the failure reason.
   */
  openPath: async (path: string): Promise<string> => {
    const actions = currentClientActions()
    if (!actions) return 'Opening a file is not available on the server.'
    try {
      const filename = safeDownloadName(basename(path), 'document')
      actions.downloads.push({
        filename,
        mime: mimeForFilename(filename),
        bytes: readFileSync(path),
        disposition: 'inline'
      })
      return ''
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  },
  showItemInFolder: (): void => {
    // Nothing to reveal and nowhere to reveal it. Silent rather than throwing:
    // no handler's result depends on this having happened.
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The window list the push code iterates.
 *
 * Three modules announce things by walking `BrowserWindow.getAllWindows()` and
 * calling `webContents.send(channel, payload)` — the parse job's progress, the
 * sync loop's status, the updater's. On a server there are no windows, so the
 * loop found nothing and every push silently went nowhere.
 *
 * Rather than change those three modules, the server installs ONE pseudo-window
 * whose `send` fans the message out over Server-Sent Events. The push code is
 * untouched and cannot tell the difference, which is the same trick that lets
 * the handlers themselves be shared.
 */
export interface PseudoWindow {
  isDestroyed: () => boolean
  webContents: { send: (channel: string, payload: unknown) => void }
}

let windows: PseudoWindow[] = []

export function setBroadcastWindow(win: PseudoWindow | null): void {
  windows = win ? [win] : []
}

export const BrowserWindow = {
  fromWebContents: (): null => null,
  getFocusedWindow: (): null => null,
  getAllWindows: (): PseudoWindow[] => windows
}

export const nativeTheme = { themeSource: 'light', shouldUseDarkColors: false }

/**
 * There is no OS keychain in a datacentre.
 *
 * Reporting "not available" is the honest answer and the one every caller
 * already handles: `services/credentials.ts` falls back to base64, and
 * `quickbooks/store.ts` does the same. What that means for the server is
 * spelled out in docs/WEB.md — briefly, "remember me" is the session cookie
 * instead, and the QuickBooks refresh token sits on the volume in plain text,
 * which is a real exposure and is documented as one.
 */
export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (): never => {
    throw new Error('No OS keychain on the server.')
  },
  decryptString: (): never => {
    throw new Error('No OS keychain on the server.')
  }
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
export const clipboard = {
  writeText: (): never => {
    throw new Error('The clipboard is a desktop action; copy from the page instead.')
  }
}

export default { app, dialog, shell, BrowserWindow, nativeTheme, safeStorage, ipcMain, session }
