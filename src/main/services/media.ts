import { app } from 'electron'
import { basename, extname, join } from 'path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs'

/**
 * Product images live as files in the app's user-data directory and are handed
 * to the renderer as base64 `data:` URLs (allowed by the app CSP), which keeps
 * the database small and avoids any custom-protocol wiring.
 */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

export function imagesDir(): string {
  const dir = join(app.getPath('userData'), 'product-images')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Copy a picked source image into the media dir; returns the stored filename. */
export function importImageFile(src: string, id: string): string {
  const rawExt = extname(src).toLowerCase()
  const ext = MIME[rawExt] ? rawExt : '.png'
  const filename = `${id}${ext}`
  copyFileSync(src, join(imagesDir(), filename))
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
