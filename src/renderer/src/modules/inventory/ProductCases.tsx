import { useEffect, useState, type CSSProperties } from 'react'
import type { ProductLot, UnitType } from '@shared/types'
import { api } from '../../lib/api'
import { Modal } from '../../components/ui'
import { formatDate, formatMoney } from '../../lib/format'
import { CategoryLogo } from './CategoryLogo'
import { unitLabel } from './helpers'

interface CaseUnit {
  n: number
  unitCost: number
  location: string
  receivedAt: string
}

/** The identity + money a product card needs to render specs and cases. */
export interface ProductCardData {
  productId: string
  name: string
  sku: string
  category: string
  unitType: UnitType
  quantity: number
  unitCost: number
  highBid: number | null
}

/** Flatten FIFO lots into one row per physical case, in consumption order. */
function enumerateCases(lots: ProductLot[]): CaseUnit[] {
  const out: CaseUnit[] = []
  let n = 0
  for (const lot of lots) {
    for (let i = 0; i < lot.qtyRemaining; i++) {
      n += 1
      out.push({ n, unitCost: lot.unitCost, location: lot.location, receivedAt: lot.receivedAt })
    }
  }
  return out
}

/**
 * Shows each on-hand case individually, in FIFO (oldest-first) order, with the
 * cost of the lot it came from — the order they'll actually be sold.
 */
export function CaseList({ lots, unitType }: { lots: ProductLot[]; unitType: UnitType }): JSX.Element {
  const cases = enumerateCases(lots)
  const noun = unitLabel(unitType)
  if (cases.length === 0) {
    return <div className="cases-empty">No units on hand.</div>
  }
  return (
    <div className="cases-list">
      {cases.map((c) => (
        <div className="case-row" key={c.n}>
          <span className="case-n">
            {noun} {c.n}
          </span>
          <span className="case-loc">{c.location}</span>
          <span className="case-date">{c.receivedAt ? formatDate(c.receivedAt) : '—'}</span>
          <span className="case-cost mono">{formatMoney(c.unitCost)}</span>
        </div>
      ))}
    </div>
  )
}

/** Loads a product's FIFO lots and renders the enumerated case list. */
export function ProductCasesLoader({ productId, unitType }: { productId: string; unitType: UnitType }): JSX.Element {
  const [lots, setLots] = useState<ProductLot[] | null>(null)
  useEffect(() => {
    let active = true
    api.inventory
      .productLots(productId)
      .then((l) => {
        if (active) setLots(l)
      })
      .catch(() => {
        if (active) setLots([])
      })
    return () => {
      active = false
    }
  }, [productId])

  if (lots === null) {
    return (
      <div className="cases-loading">
        <span className="spinner dark" />
      </div>
    )
  }
  return <CaseList lots={lots} unitType={unitType} />
}

/** The product's primary uploaded image, falling back to its category logo. */
function ProductImageThumb({
  productId,
  category,
  name
}: {
  productId: string
  category: string
  name: string
}): JSX.Element {
  // undefined = loading, null = no image on file.
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let active = true
    api.inventory
      .listImages(productId)
      .then((imgs) => {
        if (active) setUrl(imgs[0]?.dataUrl ?? null)
      })
      .catch(() => {
        if (active) setUrl(null)
      })
    return () => {
      active = false
    }
  }, [productId])

  return (
    <div className="qv-img">
      {url === undefined ? (
        <span className="spinner dark" />
      ) : url ? (
        <img src={url} alt={name} />
      ) : (
        <CategoryLogo category={category} size={34} />
      )}
    </div>
  )
}

/**
 * Shared card content — the uploaded image, the money specs, and the FIFO case
 * breakdown. Used by both the click-to-open quick-view modal (Pricing tab) and
 * the dashboard hover card, so they always show the same thing.
 */
export function ProductDetailBody({ data }: { data: ProductCardData }): JSX.Element {
  const { productId, name, category, unitType, quantity, unitCost, highBid } = data
  const market = highBid != null && highBid > 0 ? highBid : unitCost
  const invValue = quantity * market
  const totalCost = quantity * unitCost
  const spread = invValue - totalCost
  const noun = unitLabel(unitType).toLowerCase()
  return (
    <div className="qv-body">
      <div className="qv-top">
        <ProductImageThumb productId={productId} category={category} name={name} />
        <div className="qv-specs">
          <Spec label="On hand" value={`${quantity} ${noun}${quantity === 1 ? '' : 's'}`} />
          <Spec label="Avg cost" value={formatMoney(unitCost)} />
          <Spec label="Total cost" value={formatMoney(totalCost)} />
          <Spec label="High bid" value={highBid != null && highBid > 0 ? formatMoney(highBid) : '—'} />
          <Spec label="Inv. value" value={formatMoney(invValue)} />
          <Spec label="Spread" value={formatMoney(spread)} tone={spread < 0 ? 'neg' : spread > 0 ? 'pos' : undefined} />
        </div>
      </div>
      <div className="qv-cases-head">Cases · FIFO order (sold oldest first)</div>
      <div className="qv-cases-scroll">
        <ProductCasesLoader productId={productId} unitType={unitType} />
      </div>
    </div>
  )
}

/** Quick-view modal: product image + specs + the FIFO case breakdown. */
export function ProductQuickView({
  data,
  onClose
}: {
  data: ProductCardData
  onClose: () => void
}): JSX.Element {
  return (
    <Modal title={data.name} subtitle={`${data.sku}${data.category ? ` · ${data.category}` : ''}`} onClose={onClose} wide>
      <ProductDetailBody data={data} />
    </Modal>
  )
}

/**
 * Floating hover card for the dashboard product table — the same image, specs
 * and FIFO cases as the quick-view, positioned next to the hovered row. It stays
 * open while the pointer is over the card (so the case list can be scrolled).
 */
export function ProductHoverCard({
  data,
  style,
  onMouseEnter,
  onMouseLeave
}: {
  data: ProductCardData
  style: CSSProperties
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  return (
    <div className="hovercard" style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="hovercard-head">
        <span className="hc-name">{data.name}</span>
        <span className="hc-sub">
          <span className="mono">{data.sku}</span>
          {data.category && <span> · {data.category}</span>}
        </span>
      </div>
      <ProductDetailBody data={data} />
    </div>
  )
}

function Spec({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' }): JSX.Element {
  return (
    <div className="qv-spec">
      <div className="qv-k">{label}</div>
      <div className={`qv-v ${tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}`}>{value}</div>
    </div>
  )
}
