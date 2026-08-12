import { useState } from 'react'
import type {
  InventoryProduct,
  ScanPoCandidate,
  ScanResolution,
  ScanSoCandidate
} from '@shared/types'
import { Button } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { CategoryLogo } from './CategoryLogo'
import { structureLabel } from './helpers'

/** What the operator settled, handed back for ScanStation to put on the list. */
export type ScanPick =
  | { kind: 'po_line'; candidate: ScanPoCandidate }
  | { kind: 'so_line'; candidate: ScanSoCandidate }
  | { kind: 'product'; product: InventoryProduct }
  /**
   * "It is on no open order — move it anyway."
   *
   * A recorded decision rather than the default. This used to be what happened
   * silently: a barcode on no purchase order simply became a stock-in, and one
   * on no sales order simply left the building, with nothing on the row to say
   * that nobody had ordered it.
   */
  | { kind: 'override'; product: InventoryProduct }

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
  onAdd
}: {
  resolution: ScanResolution
  /** The catalog the module already holds — used to fill in a product chosen
   * from the ambiguous list without another round trip. */
  products: InventoryProduct[]
  onPick: (pick: ScanPick) => void
  onDismiss: () => void
  /** Open the inline add-product form on this code, inside the station. */
  onAdd: (code: string) => void
}): JSX.Element {
  // Which of several colliding products the user picked (ambiguous state only).
  const [picked, setPicked] = useState<string | null>(null)

  if (resolution.status === 'unknown') {
    return (
      <UnknownResult
        resolution={resolution}
        onDismiss={onDismiss}
        onAdd={onAdd}
      />
    )
  }

  // ON NO OPEN ORDER — a question, not a silent movement.
  if (resolution.status === 'no_order' && resolution.product) {
    const p = resolution.product
    const outbound = resolution.direction === 'out'
    const nothingLeft = outbound && p.quantity <= 0
    return (
      <div className="scan-result scan-result-override">
        <ProductHero
          name={p.name}
          sku={p.sku}
          upc={p.upc}
          category={p.category}
          structure={structureLabel(p)}
          imageUrl={resolution.imageUrl}
          tag={{ label: outbound ? 'No sales order' : 'No purchase order', tone: 'warn' }}
        />
        <div className="scan-banner scan-banner-warn">
          <Icon name="AlertTriangle" size={16} />
          {resolution.message}
        </div>
        <p className="scan-override-note">
          {nothingLeft
            ? 'There is none of this on the shelf, so there is nothing to take out.'
            : outbound
              ? 'Taking it out anyway is recorded as an override, so the movement can be explained later.'
              : 'Adding it anyway is recorded as an override, so the stock can be explained later.'}
        </p>
        <div className="scan-actions">
          <Button variant="ghost" onClick={onDismiss}>
            Cancel
          </Button>
          {!nothingLeft && (
            <Button
              variant="primary"
              icon={outbound ? 'PackageOpen' : 'PackagePlus'}
              onClick={() => onPick({ kind: 'override', product: p })}
            >
              {outbound ? 'Take it out anyway' : 'Add it anyway'}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // Several open SALES orders want this product — which customer's is this box?
  if (resolution.status === 'so_line' && resolution.product) {
    return (
      <SalesOrderChoice
        resolution={resolution}
        product={resolution.product}
        onPick={onPick}
        onDismiss={onDismiss}
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
  //
  // Identified by LINE AND ALLOCATION, because one line split six to RM and six
  // to AM comes back as two candidates that share a line id and differ only in
  // which shelf they land on. Keying on the line alone would make the two rows
  // indistinguishable to this component and silently pick the first — misplacing
  // six boxes with nothing on screen to notice it by.
  const [pickedKey, setPickedKey] = useState<string | null>(null)
  const chosen = candidates.find((c) => candidateKey(c) === pickedKey) ?? null

  // Two slices of ONE order reads differently from two separate orders: the
  // question is not "which box is this" but "which shelf do these go on".
  const oneOrder = new Set(candidates.map((c) => c.poId)).size === 1
  const oneLine = oneOrder && new Set(candidates.map((c) => c.lineId)).size === 1

  return (
    <div className="scan-result scan-result-po">
      <ProductHero
        name={product.name}
        sku={product.sku}
        upc={product.upc}
        category={product.category}
        structure={structureLabel(product)}
        imageUrl={resolution.imageUrl}
        tag={{
          label: oneLine
            ? `Split across ${candidates.length} destinations`
            : `${candidates.length} open PO lines`,
          tone: 'brand'
        }}
      />

      <div className="scan-choose-label">
        {oneLine
          ? 'This line is split across more than one shelf — choose where these go.'
          : 'This barcode is on more than one open order — choose which one arrived.'}
      </div>
      <div className="scan-candidates">
        {candidates.map((c) => (
          <button
            key={candidateKey(c)}
            type="button"
            className={`scan-candidate ${pickedKey === candidateKey(c) ? 'active' : ''}`}
            onClick={() => setPickedKey(candidateKey(c))}
          >
            <span className="scan-cand-radio" aria-hidden />
            <span className="scan-cand-main">
              <span className="scan-cand-title">
                <span className="mono">{c.poNumber}</span>
                {c.supplier ? ` · ${c.supplier}` : ''}
                {/* The shelf leads the title when the order is the same on every
                    row: it is the only thing being chosen between. */}
                {oneLine && <span className="badge loc-badge">{c.location}</span>}
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

/**
 * A candidate's identity for this chooser.
 *
 * Line plus allocation, never the line alone — see the note in MultiPoResult.
 * An unsplit line has no allocation id and keys as it always did.
 */
function candidateKey(c: ScanPoCandidate): string {
  return `${c.lineId}:${c.allocationId ?? ''}`
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
        {/* The ALLOCATION's shelf, not the order's. A line can carry its own
            destination now, and on a split line the header's would be the wrong
            shelf for at least one of the two candidates. */}
        <span className="scan-plan-val">
          <span className="badge loc-badge">{candidate.location}</span>
        </span>
      </div>
      <div className="scan-plan-row">
        <span className="scan-plan-key">Counting</span>
        <span className="scan-plan-val">One per scan — or type the count on the line.</span>
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
  onAdd
}: {
  resolution: ScanResolution
  onDismiss: () => void
  /** Open the inline add-product form on this code, inside the station. */
  onAdd: (code: string) => void
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
      {/* Both actions stay INSIDE the station. The old pair of buttons closed
          it, and the pending list lives in its state — one unknown box part-way
          through a pallet silently binned everything already counted. */}
      <div className="scan-actions scan-actions-center">
        {actionable ? (
          <>
            <Button variant="primary" icon="Plus" onClick={() => onAdd(code)}>
              Add this item
            </Button>
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
  tag: { label: string; tone: 'brand' | 'info' | 'warn' }
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

/**
 * Which open sales order this box is going out against.
 *
 * The mirror of the purchase-order chooser above, and deliberately the same
 * shape: one list, one preselected row, one plan sentence. The operator is
 * answering the same question in both directions — "which order is this?" — and
 * making them read two different layouts for it would be a needless second
 * thing to learn.
 */
function SalesOrderChoice({
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
  const candidates = resolution.soCandidates
  const [lineId, setLineId] = useState<string | null>(resolution.defaultLineId)
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
        tag={{ label: `${candidates.length} open sales orders`, tone: 'brand' }}
      />
      <div className="scan-choose-label">
        More than one open order wants this — choose whose it is.
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
                <span className="mono">{c.invoiceNumber || 'Sales order'}</span>
                {c.customerName ? ` · ${c.customerName}` : ''}
              </span>
              <span className="scan-cand-sub">
                {c.qtyOutstanding} of {c.quantity} still to go out · {formatMoney(c.unitPrice)} each
              </span>
            </span>
          </button>
        ))}
      </div>
      <div className="scan-actions">
        <Button variant="ghost" onClick={onDismiss}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="PackageOpen"
          disabled={!chosen}
          onClick={() => chosen && onPick({ kind: 'so_line', candidate: chosen })}
        >
          {chosen ? `Take out for ${chosen.invoiceNumber || 'this order'}` : 'Pick an order'}
        </Button>
      </div>
    </div>
  )
}
