import { useCallback, useEffect, useRef, useState } from 'react'
import type { InventoryProduct, ScanCommitResult, ScanMode, ScanResolution } from '@shared/types'
import { normalizeUpc } from '@shared/upc'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { CameraScanner } from './CameraScanner'
import { ScanHistory } from './ScanHistory'
import { ScanPreview, type ScanCommitDraft } from './ScanPreview'
import { useScanInput } from './useScanInput'

type InputMode = 'wedge' | 'camera'

/** crypto.randomUUID is available in the Electron renderer; the fallback only
 * exists so a missing secure context can never break the idempotency key. */
function newToken(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `t-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * The scan surface.
 *
 * Two inputs feed one flow: a handheld keyboard-wedge scanner (the primary path,
 * captured by useScanInput) and the webcam (CameraScanner). Both hand their raw
 * characters to the same resolve → confirm → commit sequence, so there is one
 * behaviour to reason about and a future phone client can join the same contract.
 *
 * Nothing here writes stock directly: resolve is a pure read, and every change
 * goes through the backend's single commit transaction.
 */
export function ScanStation({
  products,
  canManage,
  onClose,
  onChanged,
  onSearchCatalog,
  onCreateProduct
}: {
  products: InventoryProduct[]
  canManage: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
  /** Escape hatch from the "not recognised" state: open the Catalog on this code. */
  onSearchCatalog: (code: string) => void
  /** Escape hatch: open the new-product form with this UPC prefilled. */
  onCreateProduct: (upc: string) => void
}): JSX.Element {
  const toast = useToast()
  const [mode, setMode] = useState<InputMode>('wedge')
  const [manual, setManual] = useState('')
  const [resolution, setResolution] = useState<ScanResolution | null>(null)
  const [scanMode, setScanMode] = useState<ScanMode>('wedge')
  const [resolving, setResolving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<ScanCommitResult | null>(null)
  const [historyKey, setHistoryKey] = useState(0)
  const [denied, setDenied] = useState(false)
  /** Transient, retryable lookup failure — distinct from `denied`. */
  const [scanError, setScanError] = useState<string | null>(null)
  /** Bumped when a re-scan of the on-screen item should confirm it. */
  const [confirmSignal, setConfirmSignal] = useState(0)
  // Bumped per scan so ScanPreview remounts with fresh field state.
  const [seq, setSeq] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  const tokenRef = useRef<string>(newToken())
  // One log-miss per distinct code per session — the read path deliberately
  // writes nothing, so the renderer owns this debounce.
  const loggedMisses = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )

  // `armed` = ready to take a BRAND NEW code. A pending preview no longer kills
  // the listener: the handheld must keep working hands-free (see handleScan,
  // which treats a re-scan of the same code as confirmation).
  const armed = !resolution && !busy && !resolving && !denied
  const listening = !busy && !resolving && !denied

  const handleScan = useCallback(
    async (raw: string, from: ScanMode): Promise<void> => {
      if (!raw.trim()) return
      // A decision is on screen. Re-scanning the SAME item confirms it (that is
      // the hands-free cadence: scan, scan again to accept, move on); a
      // DIFFERENT code replaces the preview with the new item.
      if (resolution) {
        const incoming = normalizeUpc(raw)
        if (incoming && resolution.normalizedCode && incoming === resolution.normalizedCode) {
          setConfirmSignal((n) => n + 1)
          return
        }
      }
      setManual('')
      setResolving(true)
      setLast(null)
      setScanError(null)
      setScanMode(from)
      try {
        // Distinguish a genuine permission denial (the handler RESOLVES null)
        // from a transport/DB failure (it THROWS). Collapsing the two told the
        // user something false and left the station permanently bricked.
        let res: ScanResolution | null
        try {
          res = await api.inventory.scanResolve(raw)
        } catch (err) {
          if (mounted.current) {
            setScanError(err instanceof Error ? err.message : 'Could not look that barcode up.')
          }
          return
        }
        if (!mounted.current) return
        if (!res) {
          setDenied(true)
          return
        }
        // Fresh idempotency key per decision: a double-click or a retry of THIS
        // confirmation replays instead of adding stock twice.
        tokenRef.current = newToken()
        setSeq((s) => s + 1)
        setResolution(res)
        // Log an unrecognised code ONCE per distinct code — resolve deliberately
        // writes nothing, so this is the only record that the scan happened.
        if (res.status === 'unknown' && res.normalizedCode && !loggedMisses.current.has(res.normalizedCode)) {
          loggedMisses.current.add(res.normalizedCode)
          void api.inventory
            .scanLogMiss(raw, from)
            .then(() => {
              if (mounted.current) setHistoryKey((k) => k + 1)
            })
            .catch(() => undefined)
        }
      } finally {
        if (mounted.current) setResolving(false)
      }
    },
    [resolution]
  )

  // The handheld scanner. Listens on window (capture phase) so it works whether
  // or not the field below has focus, and stays armed in camera mode too — the
  // hardware scanner must keep working even when the webcam is up.
  useScanInput({
    enabled: listening,
    onScan: (raw) => void handleScan(raw, 'wedge')
  })

  // Give the wedge somewhere visible to type, and the user somewhere to key a
  // code by hand. Re-focused after each decision clears.
  useEffect(() => {
    if (armed && mode === 'wedge') inputRef.current?.focus()
  }, [armed, mode, seq])

  // A resolved item is a decision the operator must be able to SEE and act on.
  // In camera mode the confirm buttons could otherwise sit below the fold at the
  // app's default window size, with nothing scrolling them into view.
  useEffect(() => {
    if (resolution) previewRef.current?.scrollIntoView({ block: 'nearest' })
  }, [resolution, seq])

  const dismiss = (): void => {
    setResolution(null)
    setManual('')
  }

  const commit = async (draft: ScanCommitDraft): Promise<void> => {
    if (!resolution) return
    setBusy(true)
    try {
      // The same clientToken rides every attempt at THIS decision, so a retry
      // replays the original outcome instead of adding the stock a second time.
      const res = await api.inventory.scanCommit({
        ...draft,
        rawCode: resolution.rawCode,
        mode: scanMode,
        clientToken: tokenRef.current
      })
      if (!mounted.current) return
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Could not scan that in.')
        return
      }
      toast.success(res.data.message)
      setLast(res.data)
      setResolution(null)
      setManual('')
      setHistoryKey((k) => k + 1)
      await onChanged()
    } catch (err) {
      if (mounted.current) {
        toast.error(err instanceof Error ? err.message : 'Could not scan that in.')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <Modal
      title="Scan items in"
      subtitle="Point the handheld scanner at a barcode, or use the camera"
      wide
      onClose={onClose}
    >
      <div className="scan-station">
        {denied ? (
          <div className="scan-result scan-result-unknown">
            <div className="scan-unknown-ico">
              <Icon name="AlertCircle" size={26} />
            </div>
            <div className="scan-unknown-title">Scanning is not available</div>
            <div className="scan-unknown-msg">You do not have permission to look up inventory.</div>
          </div>
        ) : (
          <>
            <div className="scan-modes">
              <button
                type="button"
                className={`scan-mode-btn ${mode === 'wedge' ? 'active' : ''}`}
                onClick={() => setMode('wedge')}
              >
                <Icon name="ScanBarcode" size={16} />
                Handheld scanner
              </button>
              <button
                type="button"
                className={`scan-mode-btn ${mode === 'camera' ? 'active' : ''}`}
                onClick={() => setMode('camera')}
              >
                <Icon name="Camera" size={16} />
                Camera
              </button>
            </div>

            {mode === 'camera' && (
              <CameraScanner
                active={mode === 'camera'}
                onDecode={(raw) => {
                  if (!listening) return
                  void handleScan(raw, 'camera')
                }}
              />
            )}

            <div className={`scan-target ${armed ? 'ready' : 'held'}`}>
              <span className="scan-pulse" aria-hidden />
              <span className="scan-target-label">
                {resolving
                  ? 'Reading barcode…'
                  : busy
                    ? 'Saving…'
                    : resolution
                      ? 'Confirm the item below to carry on scanning'
                      : mode === 'camera'
                        ? 'Ready — hold a barcode up to the camera'
                        : 'Ready — scan a barcode'}
              </span>
              <input
                ref={inputRef}
                className="scan-input"
                data-scan-target="true"
                value={manual}
                placeholder="or type a barcode + Enter"
                aria-label="Barcode"
                disabled={!armed}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  const value = e.currentTarget.value.trim()
                  if (value) void handleScan(value, 'manual')
                }}
              />
            </div>

            {last && !resolution && (
              <div className="scan-banner scan-banner-success">
                <Icon name="CheckCircle2" size={16} />
                {last.message}
              </div>
            )}

            {scanError && (
              <div className="scan-banner scan-banner-error">
                <Icon name="AlertCircle" size={16} />
                <span>{scanError}</span>
                <button type="button" className="link-btn" onClick={() => setScanError(null)}>
                  Dismiss
                </button>
              </div>
            )}

            {resolution && (
              <div ref={previewRef}>
              <ScanPreview
                key={seq}
                confirmSignal={confirmSignal}
                resolution={resolution}
                products={products}
                busy={busy}
                onCommit={(draft) => void commit(draft)}
                onDismiss={dismiss}
                onSearchCatalog={(code) => {
                  dismiss()
                  onSearchCatalog(code)
                }}
                onCreateProduct={(upc) => {
                  dismiss()
                  onCreateProduct(upc)
                }}
              />
              </div>
            )}
          </>
        )}

        {!resolution && (
          <>
            <div className="scan-hist-head">
              <Icon name="History" size={15} />
              Recent scans
            </div>
            <ScanHistory refreshKey={historyKey} canManage={canManage} onUndone={onChanged} />
          </>
        )}
      </div>
    </Modal>
  )
}
