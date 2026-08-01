/**
 * RM Cardz Shipping Workspace — PDF text extraction (architecture doc 2.0).
 *
 * pdf.js hands back text items in whatever order the content stream emits them,
 * which for a Whatnot export is NOT visual reading order. Rebuild the page the
 * way the doc prescribes:
 *
 *   - bucket text items by their rounded Y baseline (transform[5]) so sub-pixel
 *     jitter collapses into one bucket per visual line
 *   - sort buckets by Y descending (top of the page first)
 *   - inside a line sort by X ascending (transform[4]), join with a space and
 *     collapse whitespace
 *
 * Output is ONE string per page, in page order. Throw only when NO page has any
 * text at all (a scanned / image-only PDF).
 *
 * This is the only file in the shipping backend that performs I/O. pdfjs-dist v5
 * is ESM-only, so it is loaded with a dynamic import from the main process; the
 * import lives inside the function so nothing is pulled in until a PDF is
 * actually parsed.
 */

import type { ShipParseProgress } from '@shared/shippingTypes'
import { parsePages, type ParsePagesOptions } from './parser'
import type { ShippingDataset } from '@shared/shippingTypes'

// Minimal structural types for the bits of pdf.js we touch. Declaring them
// locally keeps this file honest under `strict` without depending on the shape
// of the (ESM-only) pdfjs typings.
interface PdfTextItemLike {
  str?: string
  transform?: number[]
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: PdfTextItemLike[] }>
  cleanup?: () => void
}

interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageLike>
  destroy?: () => Promise<void>
}

interface PdfJsLike {
  getDocument(src: { data: Uint8Array; useSystemFonts?: boolean }): { promise: Promise<PdfDocumentLike> }
}

export interface ExtractPagesOptions {
  /** Called once per page as it is extracted (1-based). */
  onProgress?: (page: number, totalPages: number) => void
}

export class ShippingPdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShippingPdfError'
  }
}

async function loadPdfjs(): Promise<PdfJsLike> {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return mod as unknown as PdfJsLike
}

/**
 * Extract one text string per page, in visual reading order.
 */
/** One positioned run of text from the PDF. */
export interface TextItem {
  y: number
  x: number
  s: string
}

/**
 * Group positioned text into visual lines by CLUSTERING the baseline, not by
 * rounding it.
 *
 * Rounding looks equivalent and is not. A packing-slip row is set in two sizes —
 * the qty, order id and price at 11pt, the team name at 12pt — so the team's
 * baseline sits 0.30pt below the rest of its own row. Whenever that row straddles
 * a .5 boundary the two values round to different integers and the team name is
 * torn onto a line of its own.
 *
 * On the July 2026 Finest Baseball export that hit 105 of 391 rows (27%), and the
 * cost was not cosmetic. Those names stopped resolving to MLB teams, collapsed to
 * the literal string "Unknown team", and two unreadable rows in one break then
 * registered as the same team claimed by two customers — so all 13 breaks
 * reported missing teams and a collision that did not exist. Clustering takes
 * that document from 106 unmatched names to 1 (a slot genuinely titled "#30")
 * and from 13 phantom collisions to none.
 *
 * The tolerance is safe by a wide margin: the largest offset WITHIN a row is
 * 0.96pt (the NEW and GIVEAWAY badges) and the smallest gap BETWEEN two real rows
 * is 12.47pt.
 */
export const LINE_TOLERANCE = 2

export function groupIntoLines(items: TextItem[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y)
  const buckets: { y: number; row: TextItem[] }[] = []
  for (const item of sorted) {
    const last = buckets[buckets.length - 1]
    if (last && Math.abs(last.y - item.y) <= LINE_TOLERANCE) last.row.push(item)
    else buckets.push({ y: item.y, row: [item] })
  }
  return buckets.map(({ row }) =>
    row
      .sort((a, b) => a.x - b.x)
      .map((i) => i.s)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

export async function extractPages(
  buffer: Uint8Array | ArrayBuffer | Buffer,
  options: ExtractPagesOptions = {}
): Promise<string[]> {
  const bytes =
    buffer instanceof Uint8Array
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer as ArrayBuffer)
  if (!bytes.length) throw new ShippingPdfError('The uploaded file is empty.')

  const pdfjs = await loadPdfjs()
  let doc: PdfDocumentLike | null = null
  const pages: string[] = []
  try {
    doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      const items: TextItem[] = []
      for (const it of tc.items) {
        if (!it.str || !it.transform) continue
        items.push({ y: it.transform[5], x: it.transform[4], s: it.str })
      }
      const lines = groupIntoLines(items)
      pages.push(lines.join('\n'))
      page.cleanup?.()
      options.onProgress?.(i, doc.numPages)
    }
  } catch (err) {
    if (err instanceof ShippingPdfError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new ShippingPdfError(`Could not read the PDF: ${message}`)
  } finally {
    try {
      await doc?.destroy?.()
    } catch {
      /* the document is being thrown away anyway */
    }
  }

  if (!pages.some((p) => p.trim().length > 0)) {
    throw new ShippingPdfError(
      'No text found in this PDF — it looks like a scan or an image-only export. Re-download the packing slips from Whatnot as a text PDF.'
    )
  }
  return pages
}

export interface ParsePdfOptions extends ParsePagesOptions {
  onProgress?: (progress: ShipParseProgress) => void
}

/**
 * `extractPages` -> `parsePages`. Runs as a background job (a big export takes
 * 10-30s), so progress is reported through `onProgress` for both phases.
 */
export async function parsePdf(
  buffer: Uint8Array | ArrayBuffer | Buffer,
  options: ParsePdfOptions = {}
): Promise<ShippingDataset> {
  const { onProgress, ...parseOptions } = options
  onProgress?.({ phase: 'extract', page: 0, totalPages: 0, message: 'Reading the PDF…' })
  const pages = await extractPages(buffer, {
    onProgress: (page, totalPages) =>
      onProgress?.({
        phase: 'extract',
        page,
        totalPages,
        message: `Reading page ${page} of ${totalPages}…`
      })
  })
  return parsePages(pages, { ...parseOptions, onProgress })
}
