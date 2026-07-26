import { useEffect, useMemo, useState } from 'react'
import type { InventoryProduct, ScanPoCandidate, ScanResolution } from '@shared/types'
import { LOCATIONS, isLocation, type Location } from '@shared/inventory'
import { Button, Field, Input } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { CategoryLogo } from './CategoryLogo'
import { structureLabel } from './helpers'

/** What the preview hands back — ScanStation adds rawCode / mode / clientToken. */
export interface ScanCommitDraft {
  kind: 'po_line' | 'add_stock'
  lineId?: string
  productId?: string
  location?: string
  quantity?: number
  unitCost?: number | null
}

/**
 * One resolved barcode, rendered as a confirm-before-commit card. This split is
 * the whole point of the two-step scan: nothing moves stock until the person
 * holding the box agrees with what the screen says will happen.
 *
 * Four visually distinct states: matched a PO line, matched a product with no
 * open PO, not recognised, and (legacy dirty data only) more than one product on
 * the same barcode.
 */
export function ScanPreview({
  resolution,
  products,
  busy,
  confirmSignal = 0,
  onCommit,
  onDismiss,
  onSearchCatalog,
  onCreateProduct
}: {
  resolution: ScanResolution
  /** The catalog the module already holds — used to fill in a product chosen
   * from the ambiguous list without another round trip. */
  products: InventoryProduct[]
  busy: boolean
  /** Bumped when the operator re-scans the item already on screen; the confirm
   * action fires as if they had clicked it, giving a hands-free cadence. */
  confirmSignal?: number
  onCommit: (draft: ScanCommitDraft) => void
  onDismiss: () => void
  onSearchCatalog: (code: string) => void
  onCreateProduct: (upc: string) => void
}): JSX.Element {
  // Which of several colliding products the user picked (ambiguous state only).
  const [picked, setPicked] = useState<string | null>(null)

  if (resolution.status === 'unknown') {
    return (
      <UnknownResult
        resolution={resolution}
        onDismiss={onDismiss}
        onSearchCatalog={onSearchCatalog}
        onCreateProduct={onCreateProduct}
      />
    )
  }

  if (resolution.status === 'ambiguous_product') {
    const chosen = picked ? products.find((p) => p.id === picked) : null
    if (!chosen) {
      return (
        <div className="scan-result scan-result-ambiguous">
          <div className="scan-banner scan-banner-warn">
            <Icon name="AlertTriangle" size={16} />
            {resolution.message}
          </div>
          <div className="scan-candidates">
            {resolution.productMatches.map((m) => (
              <button
                key={m.id}
                type="button"
                className="scan-candidate"
                onClick={() => setPicked(m.id)}
              >
                <span className="scan-cand-main">
                  <span className="scan-cand-title">{m.name}</span>
                  <span className="scan-cand-sub mono">
                    {m.sku}
                    {m.upc ? ` · ${m.upc}` : ''}
                  </span>
                </span>
                <Icon name="ChevronRight" size={16} />
              </button>
            ))}
          </div>
          <div className="scan-actions">
            <Button variant="ghost" onClick={onDismiss}>
              Cancel
            </Button>
          </div>
        </div>
      )
    }
    return (
      <AddStockResult
        product={chosen}
        imageUrl={null}
        suggestedQuantity={resolution.suggestedQuantity}
        suggestedUnitCost={chosen.unitCost > 0 ? chosen.unitCost : null}
        suggestedLocation={resolution.suggestedLocation}
        note="No open purchase order — confirm quantity and cost to add stock."
        busy={busy}
        onCommit={onCommit}
        onDismiss={onDismiss}
      />
    )
  }

  // From here a single product matched.
  const product = resolution.product
  if (!product) {
    return (
      <div className="scan-result scan-result-unknown">
        <div className="scan-unknown-ico">
          <Icon name="AlertCircle" size={26} />
        </div>
        <div className="scan-unknown-title">That product is no longer in the catalog</div>
        <div className="scan-actions">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    )
  }

  if (resolution.status === 'po_line' && resolution.candidates.length > 0) {
    return (
      <PoLineResult
        resolution={resolution}
        product={product}
        busy={busy}
        confirmSignal={confirmSignal}
        onCommit={onCommit}
        onDismiss={onDismiss}
      />
    )
  }

  return (
    <AddStockResult
      product={product}
      imageUrl={resolution.imageUrl}
      confirmSignal={confirmSignal}
      suggestedQuantity={resolution.suggestedQuantity}
      suggestedUnitCost={resolution.suggestedUnitCost}
      suggestedLocation={resolution.suggestedLocation}
      note={resolution.message}
      busy={busy}
      onCommit={onCommit}
      onDismiss={onDismiss}
    />
  )
}

// ---------------------------------------------------------------------------
// (a) Matched an outstanding purchase-order line
// ---------------------------------------------------------------------------

function PoLineResult({
  resolution,
  product,
  busy,
  confirmSignal = 0,
  onCommit,
  onDismiss
}: {
  resolution: ScanResolution
  product: InventoryProduct
  busy: boolean
  confirmSignal?: number
  onCommit: (draft: ScanCommitDraft) => void
  onDismiss: () => void
}): JSX.Element {
  const candidates = resolution.candidates
  const multi = candidates.length > 1
  // Oldest PO preselected (purchase-side FIFO) when there is only one sensible
  // answer; with several, the user must choose — each line carries its own unit
  // price, so guessing would write the wrong cost basis onto the wrong PO.
  const [lineId, setLineId] = useState<string | null>(multi ? null : resolution.defaultLineId)
  const chosen = useMemo(() => candidates.find((c) => c.lineId === lineId) ?? null, [candidates, lineId])

  // Re-scanning the item already on screen confirms it, so the operator can work
  // the whole shipment from the handheld without reaching for the mouse. Skipped
  // when several POs are in play — that genuinely needs a human choice.
  useEffect(() => {
    if (confirmSignal > 0 && chosen && !busy && !multi) {
      onCommit({ kind: 'po_line', lineId: chosen.lineId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmSignal])

  return (
    <div className="scan-result scan-result-po">
      <ProductHero
        name={product.name}
        sku={product.sku}
        upc={product.upc}
        category={product.category}
        structure={structureLabel(product)}
        imageUrl={resolution.imageUrl}
        tag={{ label: multi ? `${candidates.length} open PO lines` : 'On a purchase order', tone: 'brand' }}
      />

      {multi && (
        <>
          <div className="scan-choose-label">
            This barcode is on more than one open order — choose which one arrived.
          </div>
          <div className="scan-candidates">
            {candidates.map((c) => (
              <button
                key={c.lineId}
                type="button"
                className={`scan-candidate ${lineId === c.lineId ? 'active' : ''}`}
                onClick={() => setLineId(c.lineId)}
              >
                <span className="scan-cand-radio" aria-hidden />
                <span className="scan-cand-main">
                  <span className="scan-cand-title">
                    <span className="mono">{c.poNumber}</span>
                    {c.supplier ? ` · ${c.supplier}` : ''}
                  </span>
                  <span className="scan-cand-sub">
                    {c.qtyOutstanding} of {c.quantity} outstanding · {formatMoney(c.unitPrice)} each · →{' '}
                    {c.location} · {relativeDay(c.poCreatedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {chosen ? (
        <PlanBlock candidate={chosen} />
      ) : (
        <div className="scan-plan scan-plan-empty">Pick an order above to see what will happen.</div>
      )}

      <div className="scan-actions">
        <Button variant="ghost" onClick={onDismiss} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="PackageCheck"
          loading={busy}
          disabled={!chosen}
          autoFocus
          onClick={() => chosen && onCommit({ kind: 'po_line', lineId: chosen.lineId })}
        >
          {chosen ? `Receive ${chosen.qtyOutstanding} into ${chosen.location}` : 'Receive'}
        </Button>
      </div>
    </div>
  )
}

/** Spells out, in words, exactly what pressing the button will do. */
function PlanBlock({ candidate }: { candidate: ScanPoCandidate }): JSX.Element {
  const total = candidate.qtyOutstanding * candidate.unitPrice
  return (
    <div className="scan-plan">
      <div className="scan-plan-row">
        <span className="scan-plan-key">Order</span>
        <span className="scan-plan-val">
          <span className="mono">{candidate.poNumber}</span>
          {candidate.supplier ? ` · ${candidate.supplier}` : ''}
        </span>
      </div>
      <div className="scan-plan-row">
        <span className="scan-plan-key">Receiving</span>
        <span className="scan-plan-val">
          <strong>{candidate.qtyOutstanding}</strong> × {formatMoney(candidate.unitPrice)} ={' '}
          {formatMoney(total)}
        </span>
      </div>
      <div className="scan-plan-row">
        <span className="scan-plan-key">Into</span>
        <span className="scan-plan-val">
          <span className="badge loc-badge">{candidate.location}</span>
        </span>
      </div>
      <div className="scan-plan-row">
        <span className="scan-plan-key">Order after</span>
        <span className="scan-plan-val">
          {candidate.completesPo ? (
            <span className="scan-chip scan-chip-success">
              <Icon name="CheckCircle2" size={13} /> Completes {candidate.poNumber}
            </span>
          ) : (
            `${Math.max(0, candidate.poLinesOutstanding - 1)} of ${candidate.poLinesTotal} item${
              candidate.poLinesTotal === 1 ? '' : 's'
            } still outstanding`
          )}
        </span>
      </div>
      {candidate.unitPrice === 0 && (
        <div className="scan-warn">
          <Icon name="AlertTriangle" size={15} />
          This line has no cost — it will book at $0.00 cost basis.
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// (b) Matched a product with no open PO — confirm quantity and cost
// ---------------------------------------------------------------------------

function AddStockResult({
  product,
  imageUrl,
  suggestedQuantity,
  suggestedUnitCost,
  suggestedLocation,
  note,
  busy,
  confirmSignal = 0,
  onCommit,
  onDismiss
}: {
  product: InventoryProduct
  imageUrl: string | null
  suggestedQuantity: number
  suggestedUnitCost: number | null
  suggestedLocation: string
  note: string
  busy: boolean
  confirmSignal?: number
  onCommit: (draft: ScanCommitDraft) => void
  onDismiss: () => void
}): JSX.Element {
  const [quantity, setQuantity] = useState(String(suggestedQuantity || 1))
  const [unitCost, setUnitCost] = useState(suggestedUnitCost != null ? String(suggestedUnitCost) : '')
  const [location, setLocation] = useState<Location>(
    isLocation(suggestedLocation) ? suggestedLocation : 'RM'
  )
  const [error, setError] = useState('')

  const qty = parseInt(quantity, 10)
  const qtyValid = Number.isInteger(qty) && qty >= 1

  // Same hands-free confirmation as the PO path.
  useEffect(() => {
    if (confirmSignal > 0 && !busy && qtyValid) submit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmSignal])

  const submit = (): void => {
    if (!qtyValid) {
      setError('Quantity must be a whole number of at least 1.')
      return
    }
    const cost = unitCost.trim() === '' ? null : parseFloat(unitCost)
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
      setError('Enter a valid unit cost.')
      return
    }
    setError('')
    onCommit({ kind: 'add_stock', productId: product.id, location, quantity: qty, unitCost: cost })
  }

  return (
    <div className="scan-result scan-result-product">
      <ProductHero
        name={product.name}
        sku={product.sku}
        upc={product.upc}
        category={product.category}
        structure={structureLabel(product)}
        imageUrl={imageUrl}
        tag={{ label: 'No open order', tone: 'info' }}
      />

      <div className="scan-note">{note}</div>
      {error && <div className="auth-alert">{error}</div>}

      <Field label="Location">
        <div className="loc-pills">
          {LOCATIONS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`loc-pill ${location === l.id ? 'active' : ''}`}
              onClick={() => setLocation(l.id)}
            >
              {l.label}
              <div className="lp-sub">{product.quantityByLocation[l.id] ?? 0} on hand</div>
            </button>
          ))}
        </div>
      </Field>

      <div className="field-row">
        <Field label="Quantity">
          <Input
            type="number"
            min={1}
            step="1"
            value={quantity}
            invalid={!!quantity && !qtyValid}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </Field>
        <Field label="Unit cost" hint="Blank keeps the current average cost">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={unitCost}
            placeholder="0.00"
            onChange={(e) => setUnitCost(e.target.value)}
          />
        </Field>
      </div>

      {unitCost.trim() === '0' && (
        <div className="scan-warn">
          <Icon name="AlertTriangle" size={15} />
          A cost of 0 books a real $0.00 cost basis — leave it blank to keep the running average.
        </div>
      )}

      <div className="scan-actions">
        <Button variant="ghost" onClick={onDismiss} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" icon="PackagePlus" loading={busy} disabled={!qtyValid} autoFocus onClick={submit}>
          Add {qtyValid ? qty : ''} to {location}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// (c) Not recognised — never a silent no-op
// ---------------------------------------------------------------------------

function UnknownResult({
  resolution,
  onDismiss,
  onSearchCatalog,
  onCreateProduct
}: {
  resolution: ScanResolution
  onDismiss: () => void
  onSearchCatalog: (code: string) => void
  onCreateProduct: (upc: string) => void
}): JSX.Element {
  const code = resolution.cleanedCode
  // "Nothing was scanned" (empty / a bare terminator) has no code to act on.
  const actionable = !!resolution.normalizedCode && !!code

  return (
    <div className="scan-result scan-result-unknown">
      <div className="scan-unknown-ico">
        <Icon name="AlertCircle" size={26} />
      </div>
      <div className="scan-unknown-title">
        {actionable ? 'Barcode not recognised' : 'Nothing was scanned'}
      </div>
      {actionable && <div className="scan-code mono">{code}</div>}
      <div className="scan-unknown-msg">
        {actionable
          ? 'No product in the catalog carries this barcode.'
          : 'Try the scan again, or type the barcode and press Enter.'}
      </div>
      <div className="scan-actions scan-actions-center">
        {actionable ? (
          <>
            <Button variant="secondary" icon="Search" onClick={() => onSearchCatalog(code)}>
              Search the catalog
            </Button>
            <Button variant="primary" icon="Plus" onClick={() => onCreateProduct(code)}>
              Add a product with this UPC
            </Button>
            {/* Without this, one uncatalogued item in a shipment forces the
                operator to abandon the whole receiving session. */}
            <Button variant="ghost" onClick={onDismiss}>
              Skip and keep scanning
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function ProductHero({
  name,
  sku,
  upc,
  category,
  structure,
  imageUrl,
  tag
}: {
  name: string
  sku: string
  upc: string | null
  category: string
  structure: string
  imageUrl: string | null
  tag: { label: string; tone: 'brand' | 'info' }
}): JSX.Element {
  return (
    <div className="scan-hero">
      <span className="scan-thumb">
        {imageUrl ? <img src={imageUrl} alt="" /> : <CategoryLogo category={category} size={22} />}
      </span>
      <span className="scan-hero-main">
        <span className="scan-name" title={name}>
          {name}
        </span>
        <span className="scan-meta">
          <span className="mono">{sku}</span>
          {upc && <span className="mono">{upc}</span>}
          <span>{structure}</span>
        </span>
      </span>
      <span className={`scan-chip scan-chip-${tag.tone}`}>{tag.label}</span>
    </div>
  )
}

/** "today" / "3 days ago" / "5 Mar" — enough to tell two open POs apart. */
function relativeDay(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
