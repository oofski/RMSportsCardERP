import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, extname } from 'node:path'

/**
 * What a handler asked the DESKTOP to do, collected so a BROWSER can do it
 * instead.
 *
 * Fourteen of the app's operations end by asking the operating system for
 * something: save this file somewhere, open this URL, show me this document.
 * Those are not incidental — they are the last step of exporting a payroll CSV
 * or opening a tracking page, and an app that cannot do them is missing
 * features, not polish.
 *
 * A server has no OS to ask. But the person on the other end of the request has
 * a browser, which can do all three natively and rather better. So instead of
 * throwing, the Electron stub records the intent HERE, and the HTTP layer sends
 * it back with the response for the browser to carry out:
 *
 *   dialog.showSaveDialog + writeFileSync  →  a download
 *   shell.openPath(file)                   →  a download
 *   shell.openExternal(url)                →  window.open
 *
 * The important property is that the handler runs FIRST and unchanged, so every
 * permission check, every validation and every "you may not export customer
 * addresses" still happens before a single byte is offered to anyone.
 *
 * Scoped per request through AsyncLocalStorage for the same reason the user is
 * (services/session.ts): ten people are being served at once and one of them
 * must never receive another's export.
 */

export interface PendingDownload {
  filename: string
  mime: string
  bytes: Buffer
  /** `attachment` for a save-dialog export, `inline` for "open this document". */
  disposition: 'attachment' | 'inline'
}

export interface ClientActions {
  downloads: PendingDownload[]
  /** URLs the handler handed to the OS. Only http(s) and mailto ever get here. */
  open: string[]
}

const storage = new AsyncLocalStorage<ClientActions>()

/** Run a handler with a fresh slot, and hand back whatever it asked for. */
export async function collectClientActions<T>(
  fn: () => Promise<T>
): Promise<{ value: T; actions: ClientActions }> {
  const actions: ClientActions = { downloads: [], open: [] }
  const value = await storage.run(actions, fn)
  return { value, actions }
}

/** The current request's slot, or null outside a request. */
export function currentClientActions(): ClientActions | null {
  return storage.getStore() ?? null
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

/**
 * A conservative content type.
 *
 * Anything unrecognised is served as a stream of bytes, never as something the
 * browser might decide to execute or render in our own origin. The exports this
 * sees are CSV, TSV and (from the purchase-order document) HTML; an HTML
 * download is fine because it goes out as an attachment and is opened from the
 * user's disk, not from this site.
 */
export function mimeForFilename(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/** Strip anything that could steer a download out of its folder. */
export function safeDownloadName(filename: string, fallback: string): string {
  const name = basename(String(filename ?? '')).replace(/[\r\n"]/g, '')
  return name.trim() || fallback
}
