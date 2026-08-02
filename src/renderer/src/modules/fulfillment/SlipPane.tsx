import { useEffect, useRef, useState } from 'react'
import type { ShipDocument } from '@shared/shippingTypes'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'

/**
 * The original packing slip, open beside the work.
 *
 * Everything the floor needs is in the database, and the floor still wants the
 * paper. The slip is the customer's own order in the layout everyone has been
 * reading for a year, and it settles the questions a derived list cannot: what
 * else was on this order, what the buyer wrote, whether the address matches the
 * label in your hand.
 *
 * ## Why this draws the page itself
 *
 * The first attempt handed a blob URL to an <iframe> and let the engine's PDF
 * plugin do the work. It rendered nothing, and said nothing about why: the
 * renderer's Content-Security-Policy has no `frame-src`, so it falls back to
 * `default-src 'self'` and a `blob:` frame is refused. The header said
 * "page 15 / 136" — the page maths was right — over a blank rectangle.
 *
 * That could have been fixed by widening the CSP. Drawing the page ourselves is
 * better anyway:
 *
 *   - ONE page, the order's page. The plugin shows a scrollable document parked
 *     at a page, which a picker can scroll away from and lose. Here there is
 *     nothing to lose your place in.
 *   - It cannot be silently refused. A failure is a message, not an empty box.
 *   - It puts a canvas under our control, which is where highlighting the
 *     customer's teams goes next.
 *
 * ## The legacy build, deliberately
 *
 * pdfjs 5's modern bundle uses JS this Electron's Chromium does not have —
 * verified, not assumed: it throws `getOrInsertComputed is not a function` on
 * the exact document below. The `legacy/` build targets older engines and
 * renders the same file correctly. The main process already imports legacy for
 * the same reason.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** Rendered width. Enough to read an address without a 200-page memory bill. */
const RENDER_WIDTH = 900

export function SlipPane({
  page,
  label
}: {
  /** 1-based page to show. Null while nothing is selected. */
  page: number | null
  /** Whose slip this is, for the header. */
  label: string
}): JSX.Element {
  const [doc, setDoc] = useState<ShipDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  /** The opened document, kept for the life of the pane. */
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null)

  // --- open the document ONCE ----------------------------------------------
  useEffect(() => {
    let active = true
    let task: { destroy: () => void } | null = null
    void (async () => {
      try {
        const meta = await api.shipping.document()
        if (!active) return
        setDoc(meta)
        if (!meta) return
        const bytes = await api.shipping.documentBytes()
        if (!active || !bytes) return
        // Copy: pdfjs takes ownership of the buffer it is handed.
        const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) })
        task = loadingTask as unknown as { destroy: () => void }
        const opened = await loadingTask.promise
        if (!active) return
        pdfRef.current = opened as never
        // Nudge the draw effect now that there is something to draw.
        setRendering((r) => !r)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not open the slip.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
      try {
        task?.destroy()
      } catch {
        /* closing a document that never opened is not an error worth raising */
      }
      pdfRef.current = null
    }
  }, [])

  // --- draw the requested page ---------------------------------------------
  useEffect(() => {
    const pdf = pdfRef.current
    const canvas = canvasRef.current
    if (!pdf || !canvas || page == null || page < 1) return

    let cancelled = false
    let job: { cancel: () => void } | null = null
    void (async () => {
      try {
        setError(null)
        const target = Math.min(Math.max(1, page), pdf.numPages)
        const p = (await pdf.getPage(target)) as {
          getViewport: (o: { scale: number }) => { width: number; height: number }
          render: (o: unknown) => { promise: Promise<void>; cancel: () => void }
        }
        if (cancelled) return
        const base = p.getViewport({ scale: 1 })
        const scale = RENDER_WIDTH / base.width
        const viewport = p.getViewport({ scale })
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const render = p.render({ canvasContext: ctx, viewport, canvas })
        job = render
        await render.promise
      } catch (err) {
        // A cancelled render is the normal result of pressing Next quickly.
        const message = err instanceof Error ? err.message : String(err)
        if (!cancelled && !/cancel/i.test(message)) setError(message)
      }
    })()

    return () => {
      cancelled = true
      try {
        job?.cancel()
      } catch {
        /* already finished */
      }
    }
  }, [page, rendering, doc])

  if (loading) {
    return (
      <div className="slip-pane">
        <CenterLoader />
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="slip-pane">
        <EmptyState
          icon="FileText"
          title="No slip on this machine"
          message="The show imported fine and every card is here — the PDF itself just is not stored on this computer. Whoever ran the import has it; re-import here to work against the paper too."
        />
      </div>
    )
  }

  return (
    <div className="slip-pane">
      <div className="slip-head">
        <Icon name="FileText" size={14} />
        <span className="slip-title">{label}</span>
        {page != null && (
          <span className="slip-page mono">
            page {page}
            {doc.pageCount > 0 ? ` / ${doc.pageCount}` : ''}
          </span>
        )}
      </div>
      <div className="slip-body">
        {error ? (
          <div className="slip-error">
            <Icon name="AlertTriangle" size={15} />
            <span>Could not draw this page — {error}</span>
          </div>
        ) : null}
        <canvas ref={canvasRef} className="slip-canvas" />
      </div>
    </div>
  )
}
