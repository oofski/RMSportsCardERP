import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  InventoryProduct,
  ScanCommitResult,
  ScanDirection,
  ScanMode,
  ScanResolution
} from '@shared/types'
import { normalizeUpc } from '@shared/upc'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/ui'
import { useToast } from '../../components/Toast'
import { CameraScanner } from './CameraScanner'
import { ScanHistory } from './ScanHistory'
import { ScanPreview, type ScanPick } from './ScanPreview'
import { ScanQueue } from './ScanQueue'
import {
  lineFromScan,
  mergeScan,
  queueTotals,
  removeLine,
  setLocation,
  setQuantity,
  setUnitCost,
  toCommitInput,
  type PendingLine
} from './scanLines'
import { useScanInput } from './useScanInput'

type InputMode = 'wedge' | 'camera'

/**
 * The scan surface.
 *
 * Two inputs feed one flow: a handheld keyboard-wedge scanner (the primary path,
 * captured by useScanInput) and the webcam (CameraScanner). Both hand their raw
 * characters to the same resolve → list → confirm sequence, so there is one
 * behaviour to reason about and a future phone client can join the same contract.
 *
 * TWO things shape that flow:
 *
 *  · DIRECTION is a session mode, chosen before scanning and on screen at all
 *    times. Every beep in the session moves stock the same way, so an operator
 *    part-way through a stack is never guessing.
 *
 *  · REPEAT SCANS ACCUMULATE. Scanning a code that is already pending bumps that
 *    line's count instead of opening a second confirmation — same product, same
 *    cost, nothing new to decide. Five scans of one box is one line reading 5 and
 *    ONE confirmation, which commits as one ordinary quantity-5 commit.
 *
 * Nothing here writes stock directly: resolve is a pure read, and every change
 * goes through the backend's existing single-commit transaction — one per line,
 * each with its own idempotency token.
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
  const [direction, setDirection] = useState<ScanDirection>('in')
  const [manual, setManual] = useState('')
  const [pending, setPending] = useState<PendingLine[]>([])
  /** Only set for a barcode that genuinely needs a human decision. */
  const [resolution, setResolution] = useState<ScanResolution | null>(null)
  /** How the code behind that question arrived, so the audit row is honest. */
  const [scanMode, setScanMode] = useState<ScanMode>('wedge')
  const [resolving, setResolving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<ScanCommitResult[]>([])
  const [historyKey, setHistoryKey] = useState(0)
  const [denied, setDenied] = useState(false)
  /** Transient, retryable lookup failure — distinct from `denied`. */
  const [scanError, setScanError] = useState<string | null>(null)
  // Bumped per decision so ScanPreview remounts with fresh field state.
  const [seq, setSeq] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)
  // One log-miss per distinct code per session — the read path deliberately
  // writes nothing, so the renderer owns this debounce.
  const loggedMisses = useRef<Set<string>>(new Set())
  const mounted = useRef(true)
  // Set on the way IN as well as cleared on the way out. StrictMode mounts,
  // unmounts and remounts every effect in development: a cleanup-only version
  // of this leaves `mounted` false forever, which silently kills the drain loop
  // in `feed()` — every beep queues and nothing is ever looked up. Same pattern
  // as IncomingPanel / useIncomingFeed / SupplyOrdersSection.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Live values for the scan pump, which runs outside React's render cycle.
  const directionRef = useRef(direction)
  directionRef.current = direction
  const resolutionRef = useRef(resolution)
  resolutionRef.current = resolution

  const out = direction === 'out'
  const totals = queueTotals(pending)
  // The direction is a SESSION mode: it may only change while nothing is
  // half-decided — no pending list, and no unanswered question.
  const dirLocked = pending.length > 0 || !!resolution
  const dirLockReason =
    pending.length > 0
      ? 'Confirm or clear the list before switching direction'
      : 'Answer the question below before switching direction'
  // `armed` = ready to take a brand new code. A pending LIST never disarms the
  // station — that is the whole point; only an unresolved decision does.
  const armed = !resolution && !busy && !resolving && !denied

  const enqueue = useCallback((line: PendingLine): void => {
    setPending((lines) => mergeScan(lines, line))
    setLast([])
  }, [])

  const handleScan = useCallback(
    async (raw: string, from: ScanMode): Promise<void> => {
      if (!raw.trim()) return
      const dir = directionRef.current
      // A decision is already on screen. Re-scanning the SAME code cannot answer
      // it (these are exactly the cases only a human can settle), so it is
      // ignored rather than replacing the question with itself.
      const showing = resolutionRef.current
      if (showing) {
        const incoming = normalizeUpc(raw)
        if (incoming && showing.normalizedCode && incoming === showing.normalizedCode) return
      }
      setManual('')
      setResolving(true)
      setScanError(null)
      setScanMode(from)
      try {
        // Distinguish a genuine permission denial (the handler RESOLVES null)
        // from a transport/DB failure (it THROWS). Collapsing the two told the
        // user something false and left the station permanently bricked.
        let res: ScanResolution | null
        try {
          res = await api.inventory.scanResolve(raw, dir)
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
        // The direction flipped while this lookup was in flight (or a stale
        // reply landed): drop it rather than queue a line the wrong way round.
        if (res.direction !== directionRef.current) return

        // Not recognised — never a silent no-op; log it ONCE per distinct code.
        if (res.status === 'unknown') {
          setSeq((s) => s + 1)
          setResolution(res)
          if (res.normalizedCode && !loggedMisses.current.has(res.normalizedCode)) {
            loggedMisses.current.add(res.normalizedCode)
            void api.inventory
              .scanLogMiss(raw, from)
              .then(() => {
                if (mounted.current) setHistoryKey((k) => k + 1)
              })
              .catch(() => undefined)
          }
          return
        }

        // Genuinely needs a person: which of two products on one barcode, or
        // which of several open orders this box belongs to.
        if (res.status === 'ambiguous_product' || (res.status === 'po_line' && res.candidates.length > 1)) {
          setSeq((s) => s + 1)
          setResolution(res)
          return
        }

        const product = res.product
        if (!product) {
          setScanError('That product is no longer in the catalog.')
          return
        }
        if (dir === 'out' && product.quantity <= 0) {
          setScanError(`${product.name} has nothing on hand, so there is nothing to take out.`)
          return
        }
        enqueue(
          lineFromScan({
            resolution: res,
            product,
            direction: dir,
            mode: from,
            candidate: res.candidates[0] ?? null
          })
        )
      } finally {
        if (mounted.current) setResolving(false)
      }
    },
    [enqueue]
  )

  // A wedge fires faster than a round trip returns. Codes go into a FIFO and are
  // resolved strictly one at a time, so a burst of beeps at a stack of boxes
  // cannot drop the ones that land while an earlier lookup is still open.
  const inbox = useRef<Array<{ raw: string; from: ScanMode }>>([])
  const draining = useRef(false)
  const feed = useCallback(
    (raw: string, from: ScanMode): void => {
      inbox.current.push({ raw, from })
      if (draining.current) return
      draining.current = true
      void (async () => {
        try {
          while (inbox.current.length > 0 && mounted.current) {
            const next = inbox.current.shift() as { raw: string; from: ScanMode }
            await handleScan(next.raw, next.from)
          }
        } finally {
          // Deliberately does NOT clear the queue: anything pushed while the
          // last lookup was settling is still waiting, and dropping it here is
          // exactly the lost-scan bug this pump exists to prevent.
          draining.current = false
        }
      })()
    },
    [handleScan]
  )

  // The handheld scanner. Listens on window (capture phase) so it works whether
  // or not the field below has focus, and stays armed in camera mode too — the
  // hardware scanner must keep working even when the webcam is up. It also stays
  // armed while a lookup or a commit is running: the buffer absorbs the burst.
  useScanInput({
    enabled: !denied,
    onScan: (raw) => feed(raw, 'wedge')
  })

  // Give the wedge somewhere visible to type, and the user somewhere to key a
  // code by hand. Re-focused after each decision clears.
  useEffect(() => {
    if (armed && mode === 'wedge') inputRef.current?.focus()
  }, [armed, mode, seq, pending.length])

  // A question the operator must answer has to be SEEN. In camera mode it could
  // otherwise sit below the fold at the app's default window size.
  useEffect(() => {
    if (resolution) previewRef.current?.scrollIntoView({ block: 'nearest' })
  }, [resolution, seq])

  const dismiss = (): void => {
    setResolution(null)
    setManual('')
  }

  /** The operator answered a question: put the answer on the list. */
  const pick = (choice: ScanPick): void => {
    const res = resolution
    if (!res) return
    setResolution(null)
    setManual('')
    // The question was asked of a DIFFERENT direction (the toggle is only free
    // while the list is empty, so a question can outlive the mode it was asked
    // in). Answering it would file the answer under the wrong direction — an
    // inbound PO choice would receive stock in a session labelled "Stock out".
    if (res.direction !== direction) {
      setScanError('The scan direction changed — scan that barcode again.')
      return
    }
    if (choice.kind === 'po_line') {
      const product = res.product
      if (!product) return
      enqueue(
        lineFromScan({ resolution: res, product, direction, mode: scanMode, candidate: choice.candidate })
      )
      return
    }
    if (direction === 'out' && choice.product.quantity <= 0) {
      setScanError(`${choice.product.name} has nothing on hand, so there is nothing to take out.`)
      return
    }
    enqueue(lineFromScan({ resolution: res, product: choice.product, direction, mode: scanMode }))
  }

  /**
   * Confirm the list. Each line is ONE commit through the existing path,
   * carrying its accumulated quantity and its own clientToken — so a retry
   * replays that line instead of applying it twice. Each commit is atomic on its
   * own (commitScan wraps itself in a transaction); a line that fails stops the
   * run with its reason and stays on the list, with everything already applied
   * removed from it, so a second press never re-applies what worked.
   */
  const confirm = async (): Promise<void> => {
    if (pending.length === 0 || busy) return
    setBusy(true)
    const done: ScanCommitResult[] = []
    try {
      for (const line of pending) {
        let res: Awaited<ReturnType<typeof api.inventory.scanCommit>>
        try {
          res = await api.inventory.scanCommit(toCommitInput(line))
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not scan that in.')
          break
        }
        if (!res.ok || !res.data) {
          toast.error(`${line.productName}: ${res.error ?? 'could not be scanned in.'}`)
          break
        }
        done.push(res.data)
        // Drop as we go, so an error part-way leaves exactly the unapplied lines.
        setPending((lines) => removeLine(lines, line.key))
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
    if (!mounted.current || done.length === 0) return
    setLast(done)
    toast.success(
      done.length === 1
        ? done[0].message
        : `${done.reduce((n, r) => n + r.quantity, 0)} units across ${done.length} items ${
            out ? 'taken out' : 'scanned in'
          }.`
    )
    setHistoryKey((k) => k + 1)
    await onChanged()
  }

  const idle = pending.length === 0 && !resolution

  return (
    <Modal
      title={out ? 'Scan items out' : 'Scan items in'}
      subtitle={
        out
          ? 'Taking stock off the shelf — scan each item, or scan one item repeatedly to count it up'
          : 'Point the handheld scanner at a barcode, or use the camera'
      }
      wide
      onClose={onClose}
    >
      <div className={`scan-station scan-station-${direction}`}>
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
            {/* DIRECTION — decided before scanning, and never off screen while
                scanning. Locked once a list exists so half a stack cannot be
                added and the other half removed, and locked again while a
                question is open: that question was asked of one direction and
                its answer must not be filed under the other. */}
            <div className="scan-modes scan-dirs" role="group" aria-label="Scan direction">
              <button
                type="button"
                className={`scan-mode-btn scan-dir-btn ${direction === 'in' ? 'active' : ''}`}
                aria-pressed={direction === 'in'}
                disabled={dirLocked}
                title={dirLocked ? dirLockReason : undefined}
                onClick={() => setDirection('in')}
              >
                <Icon name="PackagePlus" size={16} />
                Stock in
              </button>
              <button
                type="button"
                className={`scan-mode-btn scan-dir-btn ${out ? 'active' : ''}`}
                aria-pressed={out}
                disabled={dirLocked}
                title={dirLocked ? dirLockReason : undefined}
                onClick={() => setDirection('out')}
              >
                <Icon name="PackageMinus" size={16} />
                Stock out
              </button>
            </div>

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
              <CameraScanner active={mode === 'camera'} onDecode={(raw) => feed(raw, 'camera')} />
            )}

            <div className={`scan-target ${armed ? 'ready' : 'held'}`}>
              <span className="scan-pulse" aria-hidden />
              {/* The direction is repeated here because this strip is what the
                  operator's eye is on while scanning. */}
              <span className="scan-chip scan-chip-brand scan-dir-chip">
                <Icon name={out ? 'PackageMinus' : 'PackagePlus'} size={13} />
                {out ? 'Taking OUT' : 'Adding IN'}
              </span>
              <span className="scan-target-label">
                {resolving
                  ? 'Reading barcode…'
                  : busy
                    ? 'Saving…'
                    : resolution
                      ? 'Answer the question below to carry on scanning'
                      : pending.length > 0
                        ? `${totals.units} counted — keep scanning`
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
                  if (value) feed(value, 'manual')
                }}
              />
            </div>

            {last.length > 0 && idle && (
              <div className="scan-banner scan-banner-success">
                <Icon name="CheckCircle2" size={16} />
                {last.length === 1
                  ? last[0].message
                  : last.map((r) => `${r.quantity} × ${r.product?.name ?? 'item'}`).join(' · ')}
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

            {pending.length > 0 && (
              <ScanQueue
                lines={pending}
                direction={direction}
                busy={busy}
                onQuantity={(key, quantity) => setPending((l) => setQuantity(l, key, quantity))}
                onLocation={(key, location) => setPending((l) => setLocation(l, key, location))}
                onUnitCost={(key, unitCost) => setPending((l) => setUnitCost(l, key, unitCost))}
                onRemove={(key) => setPending((l) => removeLine(l, key))}
                onClear={() => setPending([])}
                onConfirm={() => void confirm()}
              />
            )}

            {resolution && (
              <div ref={previewRef}>
                <ScanPreview
                  key={seq}
                  resolution={resolution}
                  products={products}
                  onPick={pick}
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

        {idle && (
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
