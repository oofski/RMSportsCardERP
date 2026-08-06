import { app } from 'electron'
import { basename, extname, join } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'

/**
 * Product images live as files in the app's user-data directory and are handed
 * to the renderer as base64 `data:` URLs (allowed by the app CSP), which keeps
 * the database small and avoids any custom-protocol wiring.
 *
 * The `data:` URL is also what makes images work unchanged in the browser
 * build: they arrive through the same permission-checked operation as every
 * other read (`inventory:images:list`), so there is no second, unauthenticated
 * route serving customer-facing photos off the volume. On a server
 * `app.getPath('userData')` is the mounted data directory — see
 * server/electron-stub.ts — so the files land on the volume beside the
 * database rather than in the container filesystem.
 */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/**
 * Where an image came in from.
 *
 * A desktop user picks a file and main copies it. A browser user has no path to
 * give — the bytes come up the wire — so the same code takes either. Both ends
 * land in the same directory with the same name, which is why an image added
 * from a laptop and one added from a tab are indistinguishable afterwards.
 */
export type ImageSource = string | { filename: string; bytes: Buffer | Uint8Array }

export function imagesDir(): string {
  const dir = join(app.getPath('userData'), 'product-images')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Store an image and return the filename it was stored under.
 *
 * The extension is taken from the source name and checked against the table
 * above rather than trusted: an uploaded "photo.php" must not become a file
 * called .php on the server, and an unknown extension is stored as .png, which
 * is what every reader here already assumes when it cannot tell.
 */
export function importImage(source: ImageSource, id: string): string {
  const rawName = typeof source === 'string' ? source : source.filename
  const rawExt = extname(rawName).toLowerCase()
  const ext = MIME[rawExt] ? rawExt : '.png'
  const filename = `${id}${ext}`
  const target = join(imagesDir(), filename)
  if (typeof source === 'string') {
    copyFileSync(source, target)
  } else {
    writeFileSync(target, Buffer.from(source.bytes))
  }
  return filename
}

export function deleteImageFile(filename: string): void {
  try {
    const f = join(imagesDir(), basename(filename))
    if (existsSync(f)) unlinkSync(f)
  } catch {
    // best-effort cleanup — a missing file is not an error
  }
}

/** Read a stored image back as a `data:` URL, or null if it's gone. */
export function imageDataUrl(filename: string): string | null {
  try {
    const f = join(imagesDir(), basename(filename))
    if (!existsSync(f)) return null
    const mime = MIME[extname(f).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${readFileSync(f).toString('base64')}`
  } catch {
    return null
  }
}
