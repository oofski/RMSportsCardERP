import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShipDocument } from '@shared/shippingTypes'
import { pageRangeLabel } from '@shared/shippingViews'
import { api } from '../../lib/api'
import { LIVE, useLiveRefresh } from '../../lib/live'
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
 * So the pane draws the whole run AT ONCE, laid out side by side, and says how
 * many there are. A five-page order is five sheets on screen together, not five
 * scroll positions — somebody deciding whether a box is complete needs to see
 * the whole order in one look, and a pager or a tall stack makes them hold four
 * pages in their head to do it.
 *
 * Sheets shrink to fit, so any one of them can be clicked to fill the window at
 * a size meant for reading. That is the trade the layout makes: all of it at a
 * glance, one of it in detail, and never a page you did not know was there.
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

/**
 * Rendered width of a sheet in the grid. Generous on purpose: the sheets are
 * displayed small, and a canvas rendered at display size turns to mush the
 * moment the pane is on a big monitor.
 */
const RENDER_WIDTH = 900

/** Reading width for the one sheet somebody has opened. */
const ZOOM_WIDTH = 1500

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
  const [arrival, setArrival] = useState<{ have: number; total: number; name: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const canvasRefs = useRef<Array<HTMLCanvasElement | null>>([])
  /** Index into `pages` of the sheet blown up for reading, or null. */
  const [zoom, setZoom] = useState<number | null>(null)
  const zoomCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const pdfRef = useRef<{ numPages: number; getPage: (n: number) => Promise<unknown> } | null>(null)

  // The identity of the run, so the draw effect re-fires when the order changes
  // but not when React hands back an equal-but-new array.
  const key = pages.join(',')

  /**
   * Which stored document is open. Bumped when the one on disk changes.
   *
   * The open below used to run once and only once, and "once" outlived the file
   * it opened. On a second machine the tiny rows of tonight's import arrive
   * first and the slip — half a megabyte at a time — lands minutes later, so the
   * pane opened LAST show's PDF and then kept drawing it: tonight's customers,
   * last week's pages, for as long as the screen stayed put. Somebody would have
   * had to leave the module and come back to see the right paper, with nothing
   * on screen suggesting they should.
   */
  const [openedId, setOpenedId] = useState<string | null>(null)

  const checkDocument = useCallback(async (): Promise<void> => {
    const meta = await api.shipping.document()
    setDoc(meta)
    setArrival(meta ? null : await api.shipping.documentArrival())
    setOpenedId(meta?.id ?? null)
  }, [])

  useLiveRefresh(LIVE.shipping, checkDocument)

  // --- open the document, and again if it is replaced -----------------------
  useEffect(() => {
    let active = true
    let task: { destroy: () => void } | null = null
    void (async () => {
      try {
        const meta = await api.shipping.document()
        if (!active) return
        setDoc(meta)
        setOpenedId(meta?.id ?? null)
        if (!meta) {
          // Nothing to draw — but say WHY, which is either "nobody sent it" or
          // "it is four slices of twelve in".
          const inflight = await api.shipping.documentArrival()
          if (active) setArrival(inflight)
          return
        }
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
      setReady(false)
    }
  }, [openedId])

  // --- a blown-up sheet belongs to ONE order --------------------------------
  //
  // The overlay used to survive the walk. Somebody reading page 30 of a five-page
  // order full size, who then pressed Next — the walker's arrow keys still fire,
  // because a sheet is a <button> and only Escape is intercepted — kept looking
  // at the PREVIOUS customer's page at reading size, under the NEW customer's
  // name in the bar above it. The canvas is never redrawn when `pages` shrinks
  // past the open index, so it simply stayed there, order after order.
  //
  // Closing on a change of order is the honest answer: the sheet somebody opened
  // is not on the screen any more, so neither is its picture.
  useEffect(() => {
    setZoom(null)
  }, [key])

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
          // NOT clamped into range. A page number past the end of the open
          // file means the file is not the one this order was parsed from, and
          // clamping turned that into a perfectly legitimate-looking page
          // belonging to a different customer on a different night. Better to
          // say so.
          if (target > pdf.numPages) {
            if (!cancelled) {
              setError(
                `page ${target} is past the end of the slip on this computer (${pdf.numPages} pages) — this is not the file this order came from`
              )
            }
            return
          }
          const p = (await pdf.getPage(target)) as {
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

  // --- the blown-up sheet ---------------------------------------------------
  // Drawn fresh at reading width rather than scaling the thumbnail up: a
  // stretched canvas is exactly as unreadable as the small one it came from.
  useEffect(() => {
    const pdf = pdfRef.current
    const canvas = zoomCanvasRef.current
    if (!pdf || canvas == null || zoom == null) return
    const target = pages[zoom]
    // Belt and braces for the same fault: an index past the end of THIS order's
    // pages closes the overlay rather than leaving the last drawing on it.
    if (!target) {
      setZoom(null)
      return
    }
    let cancelled = false
    let job: { cancel: () => void } | null = null
    void (async () => {
      try {
        if (target > pdf.numPages) {
          setZoom(null)
          return
        }
        const p = (await pdf.getPage(target)) as {
          getViewport: (o: { scale: number }) => { width: number; height: number }
          render: (o: unknown) => { promise: Promise<void>; cancel: () => void }
        }
        if (cancelled) return
        const base = p.getViewport({ scale: 1 })
        const viewport = p.getViewport({ scale: ZOOM_WIDTH / base.width })
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const render = p.render({ canvasContext: ctx, viewport, canvas })
        job = render
        await render.promise
      } catch {
        /* closing the overlay cancels this; nothing to report */
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
  }, [zoom, pages, ready])

  // Escape closes the blown-up sheet before the walker's arrow keys see it.
  useEffect(() => {
    if (zoom == null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setZoom(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoom])

  if (loading) {
    return (
      <div className="slip-pane">
        <CenterLoader />
      </div>
    )
  }

  // The slip travels from whoever imported it in slices, so a blank pane is two
  // different situations. Telling somebody to re-import a file that is already
  // arriving is the wrong instruction and the wrong thing to do.
  if (!doc) {
    return (
      <div className="slip-pane">
        {arrival ? (
          <EmptyState
            icon="DownloadCloud"
            title="The slip is on its way"
            message={`${arrival.have} of ${arrival.total} pieces have arrived from the computer that imported it. It opens here on its own.`}
          />
        ) : (
          <EmptyState
            icon="FileText"
            title="No slip on this machine"
            message="The show imported fine — the PDF has not reached this computer. It arrives with the next sync; re-import here if sync is off."
          />
        )}
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
          <span
            className="slip-multi"
            title="This order runs onto several pages — click any one."
          >
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
      {error ? (
        <div className="slip-error">
          <Icon name="AlertTriangle" size={15} />
          <span>Could not draw this page — {error}</span>
        </div>
      ) : null}
      <div className="slip-body" ref={bodyRef} data-sheets={Math.min(pages.length, 4)}>
        {pages.map((p, i) => (
          <button
            type="button"
            className="slip-sheet"
            key={`${p}-${i}`}
            title={`Page ${p} — click to read it full size`}
            onClick={() => setZoom(i)}
          >
            {many && (
              <span className="slip-sheet-tag">
                {i + 1} of {pages.length}
              </span>
            )}
            <canvas
              ref={(el) => {
                canvasRefs.current[i] = el
              }}
              className="slip-canvas"
            />
          </button>
        ))}
      </div>

      {zoom != null && (
        <div className="slip-zoom" onClick={() => setZoom(null)}>
          <div className="slip-zoom-bar">
            <span>
              {label} · page {pages[zoom]}
              {many ? ` (${zoom + 1} of ${pages.length})` : ''}
            </span>
            <button
              className="slip-zoom-step"
              disabled={zoom === 0}
              onClick={(e) => {
                e.stopPropagation()
                setZoom((z) => (z == null ? null : Math.max(0, z - 1)))
              }}
            >
              <Icon name="ChevronLeft" size={15} />
            </button>
            <button
              className="slip-zoom-step"
              disabled={zoom >= pages.length - 1}
              onClick={(e) => {
                e.stopPropagation()
                setZoom((z) => (z == null ? null : Math.min(pages.length - 1, z + 1)))
              }}
            >
              <Icon name="ChevronRight" size={15} />
            </button>
            <button className="slip-zoom-close" onClick={() => setZoom(null)}>
              <Icon name="X" size={16} />
            </button>
          </div>
          <div className="slip-zoom-body" onClick={(e) => e.stopPropagation()}>
            <canvas ref={zoomCanvasRef} className="slip-zoom-canvas" />
          </div>
        </div>
      )}
    </div>
  )
}
