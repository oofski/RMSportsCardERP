import { useEffect, useRef, useState } from 'react'
import type { ShipDocument } from '@shared/shippingTypes'
import { pageRangeLabel } from '@shared/shippingViews'
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
 * ## Every page of the order, not just the first
 *
 * A big order runs onto more pages — on the July show nine of a hundred and
 * twenty-two did, and one buyer's forty-seven cards took five. Showing only the
 * first page is worse than showing none: it looks complete. Somebody checking a
 * box against page 27 of 27–31 sees a short list, agrees with it, and seals the
 * package.
 *
 * So the pane draws the whole run, stacked, and says how many there are. No
 * pager: a pager is one more thing to be on the wrong page of, and scrolling a
 * two-page order is not a feature anybody needs taught.
 *
 * ## Why this draws the pages itself
 *
 * The first attempt handed a blob URL to an <iframe> and let the engine's PDF
 * plugin do the work. It rendered nothing, and said nothing about why: the
 * renderer's Content-Security-Policy has no `frame-src`, so it falls back to
 * `default-src 'self'` and a `blob:` frame is refused. The header read
 * "page 15 / 136" — the page maths was right — over a blank rectangle.
 *
 * Drawing it ourselves cannot be silently refused, shows exactly the pages that
 * belong to this order, and puts a canvas under our control, which is where
 * highlighting the customer's teams goes next.
 *
 * ## The legacy build, deliberately
 *
 * pdfjs 5's modern bundle uses JS this Electron's Chromium does not have —
 * verified, not assumed: it throws `getOrInsertComputed is not a function` on
 * the exact documents below. The `legacy/` build renders them correctly, and
 * the main process already imports legacy for the same reason.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** Rendered width. Enough to read an address without a 200-page memory bill. */
const RENDER_WIDTH = 900

export function SlipPane({
  pages,
  label
}: {
  /** The 1-based pages of this order's slip, in order. Empty when unknown. */
  pages: number[]
  /** Whose slip this is, for the header. */
  label: string
}): JSX.Element {
  const [doc, setDoc] = useState<ShipDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([])
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null)

  // The identity of the run, so the draw effect re-fires when the order changes
  // but not when React hands back an equal-but-new array.
  const key = pages.join(',')

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
        setReady(true)
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

  // --- draw every page of this order ---------------------------------------
  useEffect(() => {
    const pdf = pdfRef.current
    if (!pdf || pages.length === 0) return

    let cancelled = false
    const jobs: Array<{ cancel: () => void }> = []

    void (async () => {
      setError(null)
      // Back to the top: a new order starts at ITS first page, never wherever
      // the last one was scrolled to.
      if (bodyRef.current) bodyRef.current.scrollTop = 0
      // Sequentially. Five pages at once fights over one worker and lands the
      // first page — the one being read — last.
      for (let i = 0; i < pages.length; i++) {
        if (cancelled) return
        const canvas = canvasRefs.current[i]
        const target = pages[i]
        if (!canvas || !target || target < 1) continue
        try {
          const p = (await pdf.getPage(Math.min(target, pdf.numPages))) as {
            getViewport: (o: { scale: number }) => { width: number; height: number }
            render: (o: unknown) => { promise: Promise<void>; cancel: () => void }
          }
          if (cancelled) return
          const base = p.getViewport({ scale: 1 })
          const viewport = p.getViewport({ scale: RENDER_WIDTH / base.width })
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          canvas.width = Math.floor(viewport.width)
          canvas.height = Math.floor(viewport.height)
          ctx.clearRect(0, 0, canvas.width, canvas.height)
          const render = p.render({ canvasContext: ctx, viewport, canvas })
          jobs.push(render)
          await render.promise
        } catch (err) {
          // A cancelled render is the normal result of pressing Next quickly.
          const message = err instanceof Error ? err.message : String(err)
          if (!cancelled && !/cancel/i.test(message)) setError(message)
          return
        }
      }
    })()

    return () => {
      cancelled = true
      for (const j of jobs) {
        try {
          j.cancel()
        } catch {
          /* already finished */
        }
      }
    }
  }, [key, ready, pages])

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

  const many = pages.length > 1

  return (
    <div className="slip-pane">
      <div className="slip-head">
        <Icon name="FileText" size={14} />
        <span className="slip-title">{label}</span>
        {many && (
          <span className="slip-multi" title="This order runs onto more than one page — scroll for the rest">
            <Icon name="Copy" size={11} />
            {pages.length} pages
          </span>
        )}
        {pages.length > 0 && (
          <span className="slip-page mono">
            {many ? 'pages' : 'page'} {pageRangeLabel(pages)}
            {doc.pageCount > 0 ? ` / ${doc.pageCount}` : ''}
          </span>
        )}
      </div>
      <div className="slip-body" ref={bodyRef}>
        {error ? (
          <div className="slip-error">
            <Icon name="AlertTriangle" size={15} />
            <span>Could not draw this page — {error}</span>
          </div>
        ) : null}
        {pages.map((p, i) => (
          <div className="slip-sheet" key={`${p}-${i}`}>
            {many && (
              <div className="slip-sheet-tag">
                {i + 1} of {pages.length}
              </div>
            )}
            <canvas
              ref={(el) => {
                canvasRefs.current[i] = el
              }}
              className="slip-canvas"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
