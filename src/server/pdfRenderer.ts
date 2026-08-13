import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RenderedDocument } from '../main/poPdf'

/**
 * Turning an A4 document into PDF bytes on a machine with no Electron.
 *
 * ## Why this exists now, having deliberately not existed before
 *
 * The server used to hand the browser the same HTML and let the viewer print it
 * (File → Print → Save as PDF). That was a good trade while the only consumer
 * was a person looking at a document: the bytes are identical and only who
 * paginates it changes.
 *
 * It stopped being a good trade when the PDF acquired a second consumer that is
 * not a person — attaching the invoice to its QuickBooks record. A machine
 * cannot press File → Print, so on the web there was simply no PDF in existence
 * to upload. The document had to become bytes on THIS side.
 *
 * ## Chromium, spawned, rather than Puppeteer
 *
 * Chromium's own `--print-to-pdf` does the whole job in one process launch.
 * Puppeteer or Playwright would add a dependency whose main feature — driving a
 * browser over the DevTools protocol — is not needed to lay out a static page
 * that has no scripts, and whose install step wants to download a SECOND copy of
 * the browser the image already carries.
 *
 * Page size and background colours are NOT passed as flags. They are already in
 * the document: `@page { size: A4; margin: 16mm 14mm }` and
 * `print-color-adjust: exact`, which Chromium honours. That is deliberate — the
 * desktop path renders the same HTML through Electron, and a page size set here
 * as well would be a second opinion about the same document, silently disagreeing
 * the day somebody changes one of them.
 *
 * ## It always degrades rather than fails
 *
 * A checkout running `npm run server` on a laptop with no Chromium still works —
 * it gets the HTML, exactly as before. A missing browser must never turn a
 * button somebody presses in front of a customer into an error, so every failure
 * path here returns null and the caller falls back.
 */

/** Where Debian, Alpine and the usual desktops put it. `which` is not available
 *  in every image, so the paths are probed directly. */
const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium'
]

/**
 * A hung browser must not hold a request open forever. Fifteen seconds is many
 * times what a one-page invoice takes and still short enough that a wedged
 * process is noticed as a slow response rather than a dead one.
 */
const TIMEOUT_MS = 15_000

let resolved: string | null | undefined

/**
 * The browser binary, or null.
 *
 * Cached because it cannot appear or vanish while the process lives, and probing
 * five paths per rendered document is five stat calls for an answer that never
 * changes. `RMOPS_CHROMIUM` overrides, for an image that puts it somewhere else.
 */
export function chromiumPath(): string | null {
  if (resolved !== undefined) return resolved
  const fromEnv = (process.env.RMOPS_CHROMIUM ?? '').trim()
  if (fromEnv) return (resolved = existsSync(fromEnv) ? fromEnv : null)
  return (resolved = CANDIDATES.find((p) => existsSync(p)) ?? null)
}

/** PDF bytes, or null when this machine cannot make one. */
async function chromiumPdf(html: string): Promise<Buffer | null> {
  const bin = chromiumPath()
  if (!bin) return null

  // One directory per render, removed either way. The user-data-dir matters:
  // Chromium writes a profile somewhere on every launch, and without one of its
  // own it picks a shared location that a second concurrent render then fights
  // over.
  const dir = mkdtempSync(join(tmpdir(), 'rmops-pdf-'))
  const input = join(dir, 'document.html')
  const output = join(dir, 'document.pdf')

  try {
    // A FILE, not a data: URL. The document is tens of kilobytes and a data URL
    // that size is passed as a single argv entry — which is where the operating
    // system's argument length limit truncates it, producing a PDF of the first
    // half of an invoice rather than an error.
    writeFileSync(input, html, 'utf8')

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn(
        bin,
        [
          '--headless=new',
          // Running as root in the container, where the sandbox cannot
          // initialise. The page has no scripts — `javascript: false` is the
          // desktop equivalent — and its only input is HTML this app generated.
          '--no-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          // No network at all: every document is self-contained by construction,
          // so anything it tried to fetch would be a bug worth failing on rather
          // than a slow render waiting on a timeout.
          '--disable-extensions',
          '--no-first-run',
          '--no-pdf-header-footer',
          `--user-data-dir=${dir}`,
          `--print-to-pdf=${output}`,
          input
        ],
        { stdio: 'ignore' }
      )

      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve(false)
      }, TIMEOUT_MS)

      proc.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })

    // The exit code is necessary but not sufficient — Chromium has exited 0
    // having written nothing when the flag was rejected. The file is the proof.
    if (!ok || !existsSync(output)) return null
    const bytes = readFileSync(output)
    return bytes.length > 0 ? bytes : null
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The renderer the server installs.
 *
 * Real PDF when this machine has a browser; the HTML it always used to return
 * when it does not. Callers already handle both — `RenderedDocument` carries the
 * extension and the MIME type precisely so nothing downstream has to guess.
 */
export async function renderServerDocument(html: string): Promise<RenderedDocument> {
  const pdf = await chromiumPdf(html)
  if (pdf) return { bytes: pdf, extension: '.pdf', mime: 'application/pdf' }
  return {
    bytes: Buffer.from(html, 'utf8'),
    extension: '.html',
    mime: 'text/html; charset=utf-8'
  }
}
