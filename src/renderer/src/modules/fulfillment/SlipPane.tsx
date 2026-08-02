import { useEffect, useRef, useState } from 'react'
import type { ShipDocument } from '@shared/shippingTypes'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { CenterLoader, EmptyState } from '../../components/ui'

/**
 * The original packing slip, open beside the work.
 *
 * Everything the floor needs is in the database, and the floor still wants the
 * paper. Not out of habit — the slip is the customer's own order in the layout
 * everyone has been reading for a year, and it settles the questions a derived
 * list cannot: what else was on this order, what the buyer wrote in the notes,
 * whether the address matches the label in your hand.
 *
 * The file is fetched ONCE and turned into a blob URL. After that, moving to the
 * next order is a fragment change against a document the engine already holds,
 * so a picker walking a hundred packages never waits. Fetching page by page over
 * IPC would have made every "next" a round trip, which on a bench is the
 * difference between using this and ignoring it.
 *
 * Chromium's own viewer does the rendering (`plugins: true` on the window), so a
 * 200-page export scrolls, zooms and prints exactly the way the operator's PDF
 * reader does.
 */
export function SlipPane({
  page,
  label,
  onMissing
}: {
  /** 1-based page to show. Null while nothing is selected. */
  page: number | null
  /** What the pane is currently showing, for the header. */
  label: string
  /** Told once, when there is no stored document to show. */
  onMissing?: () => void
}): JSX.Element {
  const [doc, setDoc] = useState<ShipDocument | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  const missingRef = useRef(onMissing)
  missingRef.current = onMissing

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const meta = await api.shipping.document()
        if (!active) return
        setDoc(meta)
        if (!meta) {
          missingRef.current?.()
          return
        }
        const bytes = await api.shipping.documentBytes()
        if (!active) return
        if (!bytes) {
          missingRef.current?.()
          return
        }
        // Copy into a fresh ArrayBuffer: the IPC payload arrives as a view that
        // Blob would otherwise keep alive for the life of the pane.
        const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
        const next = URL.createObjectURL(blob)
        urlRef.current = next
        setUrl(next)
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Could not open the slip.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
      // Revoked on unmount, not on every page change — the whole point is that
      // the document stays loaded while the operator walks the orders.
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [])

  if (loading) return <div className="slip-pane"><CenterLoader /></div>

  if (error) {
    return (
      <div className="slip-pane">
        <EmptyState icon="AlertTriangle" title="Could not open the slip" message={error} />
      </div>
    )
  }

  if (!doc || !url) {
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

  // `#page=` is read by the engine's viewer. Toolbar off: the operator is
  // following the work, not browsing a document, and the chrome costs height
  // that the slip itself should have.
  const src = page && page > 0 ? `${url}#page=${page}&toolbar=0&view=FitH` : `${url}#toolbar=0&view=FitH`

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
      <iframe
        // Keyed on the page so the viewer actually jumps: re-pointing the same
        // frame at a new fragment is a no-op in Chromium once it has loaded.
        key={page ?? 0}
        className="slip-frame"
        src={src}
        title={label}
      />
    </div>
  )
}
