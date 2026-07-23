import { useEffect, useState } from 'react'
import type { ProductLot, UnitType } from '@shared/types'
import { api } from '../../lib/api'
import { Modal } from '../../components/ui'
import { formatDate, formatMoney } from '../../lib/format'
import { unitLabel } from './helpers'

interface CaseUnit {
  n: number
  unitCost: number
  location: string
  receivedAt: string
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
    api.inventory.productLots(productId).then((l) => {
      if (active) setLots(l)
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

/** Quick-view modal: product specs + the FIFO case breakdown. */
export function ProductQuickView({
  productId,
  name,
  sku,
  category,
  unitType,
  quantity,
  unitCost,
  highBid,
  onClose
}: {
  productId: string
  name: string
  sku: string
  category: string
  unitType: UnitType
  quantity: number
  unitCost: number
  highBid: number | null
  onClose: () => void
}): JSX.Element {
  const market = highBid != null && highBid > 0 ? highBid : unitCost
  const invValue = quantity * market
  const spread = invValue - quantity * unitCost
  return (
    <Modal title={name} subtitle={`${sku}${category ? ` · ${category}` : ''}`} onClose={onClose} wide>
      <div className="qv-specs">
        <Spec label="On hand" value={`${quantity} ${unitLabel(unitType).toLowerCase()}${quantity === 1 ? '' : 's'}`} />
        <Spec label="Avg cost" value={formatMoney(unitCost)} />
        <Spec label="High bid" value={highBid != null && highBid > 0 ? formatMoney(highBid) : '—'} />
        <Spec label="Inv. value" value={formatMoney(invValue)} />
        <Spec label="Spread" value={formatMoney(spread)} tone={spread < 0 ? 'neg' : spread > 0 ? 'pos' : undefined} />
      </div>
      <div className="qv-cases-head">Cases · FIFO order (sold oldest first)</div>
      <ProductCasesLoader productId={productId} unitType={unitType} />
    </Modal>
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
