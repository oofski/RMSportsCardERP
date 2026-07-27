import { useState } from 'react'
import type { InventoryProduct, ScanPoCandidate, ScanResolution } from '@shared/types'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { CategoryLogo } from './CategoryLogo'
import { structureLabel } from './helpers'

/** What the operator settled, handed back for ScanStation to put on the list. */
export type ScanPick =
  | { kind: 'po_line'; candidate: ScanPoCandidate }
  | { kind: 'product'; product: InventoryProduct }

/**
 * The questions a barcode can raise that ONLY a person can answer:
 *
 *   · it is on more than one open purchase order — which box arrived?
 *   · two catalog rows carry it (legacy dirty data) — which product is this?
 *   · nothing in the catalog carries it at all.
 *
 * Everything else goes straight onto the pending list, because there is nothing
 * to ask: the product, the cost and the destination are already known, and a
 * repeat scan of the same thing just counts up. This card exists for the cases
 * where guessing would write the wrong cost basis onto the wrong order.
 */
export function ScanPreview({
  resolution,
  products,
  onPick,
  onDismiss,
  onSearchCatalog,
  onCreateProduct
}: {
  resolution: ScanResolution
  /** The catalog the module already holds — used to fill in a product chosen
   * from the ambiguous list without another round trip. */
  products: InventoryProduct[]
  onPick: (pick: ScanPick) => void
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
              className={`scan-candidate ${picked === m.id ? 'active' : ''}`}
              onClick={() => {
                setPicked(m.id)
                const chosen = products.find((p) => p.id === m.id)
                if (chosen) onPick({ kind: 'product', product: chosen })
              }}
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

  const product = resolution.product
  // Defensive: everything else is queued without a question, so a card with
  // nothing to choose between is a bug, not a state to strand the operator in.
  if (!product || resolution.candidates.length === 0) {
    return (
      <div className="scan-result scan-result-unknown">
        <div className="scan-unknown-ico">
          <Icon name="AlertCircle" size={26} />
        </div>
        <div className="scan-unknown-title">
          {product ? 'There is nothing left to choose here' : 'That product is no longer in the catalog'}
        </div>
        <div className="scan-actions">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    )
  }

  return <MultiPoResult resolution={resolution} product={product} onPick={onPick} onDismiss={onDismiss} />
}

// ---------------------------------------------------------------------------
// (a) On several open purchase-order lines — which order arrived?
// ---------------------------------------------------------------------------

function MultiPoResult({
  resolution,
  product,
  onPick,
  onDismiss
}: {
  resolution: ScanResolution
  product: InventoryProduct
  onPick: (pick: ScanPick) => void
  onDismiss: () => void
}): JSX.Element {
  const candidates = resolution.candidates
  // Each line carries its own unit price, so guessing would write the wrong cost
  // basis onto the wrong order. The choice goes on the list the moment it is made.
  const [lineId, setLineId] = useState<string | null>(null)
  const chosen = candidates.find((c) => c.lineId === lineId) ?? null

  return (
    <div className="scan-result scan-result-po">
      <ProductHero
        name={product.name}
        sku={product.sku}
        upc={product.upc}
        category={product.category}
        structure={structureLabel(product)}
        imageUrl={resolution.imageUrl}
        tag={{ label: `${candidates.length} open PO lines`, tone: 'brand' }}
      />

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

      {chosen ? (
        <PlanBlock candidate={chosen} />
      ) : (
        <div className="scan-plan scan-plan-empty">Pick an order above to see what will happen.</div>
      )}

      <div className="scan-actions">
        <Button variant="ghost" onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="Plus"
          disabled={!chosen}
          autoFocus
          onClick={() => chosen && onPick({ kind: 'po_line', candidate: chosen })}
        >
          {chosen ? `Add 1 from ${chosen.poNumber}` : 'Add to the list'}
        </Button>
      </div>
    </div>
  )
}

/** Spells out, in words, what putting this order on the list means. */
function PlanBlock({ candidate }: { candidate: ScanPoCandidate }): JSX.Element {
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
        <span className="scan-plan-key">Price</span>
        <span className="scan-plan-val">
          {formatMoney(candidate.unitPrice)} each · {candidate.qtyOutstanding} still outstanding
        </span>
      </div>
      <div className="scan-plan-row">
        <span className="scan-plan-key">Into</span>
        <span className="scan-plan-val">
          <span className="badge loc-badge">{candidate.location}</span>
        </span>
      </div>
      <div className="scan-plan-row">
        <span className="scan-plan-key">Counting</span>
        <span className="scan-plan-val">
          One per scan — scan the rest of the stack, or type the count on the line.
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
// (b) Not recognised — never a silent no-op
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
