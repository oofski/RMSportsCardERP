import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScanMode, ScanRecord } from '@shared/types'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { formatMoney } from '../../lib/format'

const MODE_ICON: Record<ScanMode, string> = {
  wedge: 'ScanBarcode',
  camera: 'Camera',
  manual: 'Keyboard'
}
const MODE_LABEL: Record<ScanMode, string> = {
  wedge: 'Handheld scanner',
  camera: 'Camera',
  manual: 'Typed by hand'
}

/**
 * The scan log. Every scan lands here — including the ones that matched nothing,
 * which is what answers "I scanned it and nothing happened".
 *
 * Undo is offered only where it can actually succeed: `undoable` is computed by
 * the backend from whether the exact FIFO lot that scan created still holds all
 * of its stock. Once any has been sold a clean reversal is impossible, so the
 * button is disabled with the reason rather than failing on click.
 */
export function ScanHistory({
  refreshKey,
  canManage,
  onUndone
}: {
  /** Bumped by the parent after a commit so the list re-reads. */
  refreshKey: number
  canManage: boolean
  onUndone: () => void | Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [rows, setRows] = useState<ScanRecord[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const mounted = useRef(true)

  // Set on mount as well as cleared on unmount: StrictMode mounts, unmounts and
  // remounts every effect in development, and a cleanup-only version leaves
  // this false forever — `load()` would then never call setRows and the history
  // would spin for good.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const r = await api.inventory.scanHistory(50).catch(() => [])
    if (mounted.current) setRows(r)
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const undo = async (row: ScanRecord): Promise<void> => {
    setBusyId(row.id)
    try {
      const res = await api.inventory.scanUndo(row.id)
      if (res.ok) {
        toast.success(`Undid ${row.quantity} × ${row.productName ?? 'item'}.`)
        await load()
        await onUndone()
      } else {
        toast.error(res.error ?? 'Could not undo that scan.')
        // The reason is usually "already sold" — re-read so the row's state and
        // its disabled button now agree with the database.
        await load()
      }
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }

  if (rows === null) {
    return (
      <div className="scan-history">
        <div className="scan-hist-loading">
          <span className="spinner dark" />
        </div>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="scan-history">
        <div className="scan-hist-empty">
          <Icon name="History" size={20} />
          <span>No scans yet. Scanned items will appear here.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="scan-history">
      {rows.map((r) => {
        const undone = !!r.undoneAt
        const miss = r.outcome === 'unknown'
        const out = r.outcome === 'remove_stock'
        return (
          <div
            key={r.id}
            className={`scan-hist-row ${miss ? 'miss' : ''} ${out ? 'out' : ''} ${
              undone ? 'scan-hist-undone' : ''
            }`}
          >
            <span className="scan-hist-ico" title={MODE_LABEL[r.mode]}>
              <Icon name={miss ? 'AlertCircle' : MODE_ICON[r.mode]} size={15} />
            </span>
            <span className="scan-hist-main">
              <span className="scan-hist-title">
                {miss ? (
                  <>
                    Not recognised · <span className="mono">{r.normalizedCode ?? r.rawCode}</span>
                  </>
                ) : (
                  r.productName ?? 'Deleted product'
                )}
              </span>
              <span className="scan-hist-sub">
                {!miss && (
                  <>
                    {/* The sign is the whole story on this row: the quantity is
                        stored positive, and the outcome says which way it went. */}
                    <strong>
                      {out ? '−' : '+'}
                      {r.quantity}
                    </strong>
                    {r.location && <> {out ? 'from' : '→'} {r.location}</>}
                    {r.poNumber && (
                      <>
                        {' · '}
                        <span className="mono">{r.poNumber}</span>
                      </>
                    )}
                    {r.unitCost != null && <> · {formatMoney(r.unitCost)} each</>}
                    {' · '}
                  </>
                )}
                {relativeTime(r.createdAt)}
                {r.actorName && ` · ${r.actorName}`}
              </span>
            </span>

            {r.poCompleted && !undone && (
              <span className="scan-chip scan-chip-success" title="This scan completed its purchase order">
                <Icon name="CheckCircle2" size={12} /> PO done
              </span>
            )}
            {undone && <span className="scan-chip scan-chip-muted">Undone</span>}

            {/* Undo reverses the exact FIFO lot a receipt created. A scan-OUT
                created no lot — putting those units back would have to invent a
                cost for them — so it is not offered here at all rather than
                offered and refused. */}
            {canManage && !undone && !miss && !out && (
              <button
                type="button"
                className="scan-hist-undo"
                disabled={!r.undoable || busyId === r.id}
                onClick={() => undo(r)}
                aria-label={`Undo ${r.productName ?? 'scan'}`}
                title={
                  r.undoable
                    ? 'Undo this scan'
                    : 'Cannot undo — some of this stock has already been sold. Adjust it manually instead.'
                }
              >
                <Icon name="Undo2" size={14} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** "just now" / "4m ago" / "2h ago" / "3d ago" / a date. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${Math.max(1, mins)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
