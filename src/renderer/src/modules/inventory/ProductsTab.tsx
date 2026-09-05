import { isHomeShelf } from '@shared/availability'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { InventoryProduct, ProductImage, UpdateInventoryProduct } from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS, categoryColor } from '@shared/inventory'
import { api } from '../../lib/api'
import {
  formatStockOnHand,
  hasOpenCase,
  productUnits,
  stockBreakdown
} from '../../lib/productUnits'
import { useToast } from '../../components/Toast'
import { Button, EmptyState, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { CategoryLogo } from './CategoryLogo'
import { countByPriceBand, matchesPriceBand } from '@shared/priceBands'
import { PriceBandChips } from '../../components/PriceBandChips'
import { productMatches, structureLabel, unitLabel } from './helpers'
import { ImageLightbox } from './ImageLightbox'
import { ProductCasesLoader } from './ProductCases'
import { ProductOrigins } from './ProductOrigins'
import { ProductFormModal } from './ProductFormModal'
import { RecordSaleModal } from './RecordSaleModal'
import { ConsignModal } from './ConsignModal'
import { ProductConsignments } from './ProductConsignments'
import { StockModal } from './StockModal'

/**
 * THE PLACES WORTH NAMING ON A ROW.
 *
 * A row used to name every place there was, which was fine while there were
 * two. The four roadshow shops made it six, and six labels on a row sized for
 * three wrapped into a block of mostly-zeroes with the product's name squashed
 * beside it — "California Roadshow 0, Kentucky Roadshow 0, New York Roadshow 0,
 * Texas Roadshow 0" on a box that is sitting at AM.
 *
 * So: THE TWO HOME SHELVES ALWAYS, and anywhere else only when it is holding
 * something. RM 0 is worth printing — it means look somewhere else, and it is
 * the number somebody scans this column for. "Texas Roadshow 0" is not; it is
 * the answer to a question nobody asked, repeated four times, and it pushes the
 * one place that DOES have stock off the edge.
 *
 * The row therefore reads exactly as it did before the shops existed, until a
 * shop actually has something — at which point that shop, and only that shop,
 * appears beside them.
 */
function placesOnRow(byLocation: Record<string, number>): Array<{
  id: string
  label: string
  qty: number
}> {
  return LOCATIONS.filter((l) => isHomeShelf(l.id) || (byLocation[l.id] ?? 0) > 0).map((l) => ({
    id: l.id,
    label: l.label,
    qty: byLocation[l.id] ?? 0
  }))
}

export function ProductsTab({
  products,
  query,
  category,
  onCategory,
  thumbnails,
  canManage,
  onChanged,
  onImagesChanged,
  onOpenPo
}: {
  products: InventoryProduct[]
  query: string
  category: string
  onCategory: (c: string) => void
  thumbnails: Record<string, string>
  canManage: boolean
  /** Open the purchase order a case came off — see ProductOrigins. */
  onOpenPo?: (poId: string) => void
  onChanged: () => Promise<void>
  onImagesChanged: () => void
}): JSX.Element {
  const toast = useToast()
  const [formFor, setFormFor] = useState<InventoryProduct | null | 'new'>(null)
  const [saleFor, setSaleFor] = useState<InventoryProduct | 'any' | null>(null)
  const [stockFor, setStockFor] = useState<InventoryProduct | 'any' | null>(null)
  const [deleteFor, setDeleteFor] = useState<InventoryProduct | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [band, setBand] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkDelete, setBulkDelete] = useState(false)
  const [busy, setBusy] = useState(false)

  const categoryOptions = useMemo(() => {
    const set = new Set(products.map((p) => p.category).filter(Boolean))
    const rank = (c: string): number => {
      const i = CATEGORY_ORDER.indexOf(c)
      return i === -1 ? CATEGORY_ORDER.length : i
    }
    return [...set].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  }, [products])

  /**
   * Category and text, before the price band — the chip counts are taken from
   * this list so each one says how many rows a click would actually land on
   * from where the operator is standing. Counting after the band would make
   * every unselected chip read zero.
   */
  const searched = useMemo(
    () =>
      products.filter((p) => {
        if (category && p.category !== category) return false
        return productMatches(p, query)
      }),
    [products, query, category]
  )

  const bandCounts = useMemo(() => countByPriceBand(searched, (p) => p.highBid), [searched])

  const filtered = useMemo(
    () => searched.filter((p) => matchesPriceBand(p.highBid, band)),
    [searched, band]
  )

  const toggleSelect = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const dropSelected = (id: string): void =>
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })

  const remove = async (p: InventoryProduct): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.inventory.delete(p.id)
      if (res.ok) {
        toast.success('Product deleted.')
        setDeleteFor(null)
        dropSelected(p.id)
        onImagesChanged()
        await onChanged()
      } else {
        toast.error(res.error ?? 'Could not delete.')
      }
    } finally {
      setBusy(false)
    }
  }

  const removeSelected = async (): Promise<void> => {
    setBusy(true)
    try {
      const ids = [...selected]
      let ok = 0
      for (const id of ids) {
        try {
          const res = await api.inventory.delete(id)
          if (res.ok) ok++
        } catch {
          // count as failure, keep going
        }
      }
      const failed = ids.length - ok
      if (ok > 0) toast.success(`Deleted ${ok} product${ok === 1 ? '' : 's'}.`)
      if (failed > 0) toast.error(`${failed} could not be deleted.`)
      setSelected(new Set())
      setBulkDelete(false)
      onImagesChanged()
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  /** The product whose consignment dialog is open. See ConsignModal. */
  const [consignFor, setConsignFor] = useState<InventoryProduct | null>(null)

  const headerActions = canManage && (
    <div className="row" style={{ gap: 8 }}>
      <Button variant="secondary" icon="ShoppingCart" onClick={() => setSaleFor('any')}>
        Record sale
      </Button>
      <Button variant="secondary" icon="PackagePlus" onClick={() => setStockFor('any')}>
        Add stock
      </Button>
      <Button variant="primary" icon="Plus" onClick={() => setFormFor('new')}>
        Add product
      </Button>
    </div>
  )

  const modals = (
    <>
      {formFor && (
        <ProductFormModal
          product={formFor === 'new' ? null : formFor}
          onClose={() => setFormFor(null)}
          onSaved={async () => {
            setFormFor(null)
            await onChanged()
          }}
        />
      )}
      {saleFor && (
        <RecordSaleModal
          products={products}
          presetProductId={saleFor === 'any' ? undefined : saleFor.id}
          onClose={() => setSaleFor(null)}
          onSaved={async () => {
            setSaleFor(null)
            await onChanged()
          }}
        />
      )}
      {consignFor && (
        <ConsignModal
          product={consignFor}
          onClose={() => setConsignFor(null)}
          onSaved={async () => {
            setConsignFor(null)
            await onChanged()
          }}
        />
      )}
      {stockFor && (
        <StockModal
          presetProduct={stockFor === 'any' ? null : stockFor}
          onClose={() => setStockFor(null)}
          onSaved={async () => {
            setStockFor(null)
            await onChanged()
          }}
        />
      )}
      {deleteFor && (
        <Modal
          title="Delete product?"
          subtitle={`${deleteFor.name} (${deleteFor.sku})`}
          onClose={() => setDeleteFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleteFor(null)}>
                Cancel
              </Button>
              <Button variant="danger" icon="Trash2" loading={busy} onClick={() => remove(deleteFor)}>
                Delete product
              </Button>
            </>
          }
        >
          <p className="muted">
            This removes the product from the catalog along with its stock, images and history. This
            can't be undone.
          </p>
        </Modal>
      )}
      {bulkDelete && (
        <Modal
          title={`Delete ${selected.size} product${selected.size === 1 ? '' : 's'}?`}
          onClose={() => setBulkDelete(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setBulkDelete(false)}>
                Cancel
              </Button>
              <Button variant="danger" icon="Trash2" loading={busy} onClick={removeSelected}>
                Delete selected
              </Button>
            </>
          }
        >
          <p className="muted">
            This permanently removes the selected products, their stock, images and history.
          </p>
        </Modal>
      )}
    </>
  )

  if (products.length === 0) {
    return (
      <>
        <EmptyState
          icon="Boxes"
          title="Your catalog is empty"
          message="Add a product to the catalog, then add stock to a location."
          action={
            canManage ? (
              <Button variant="primary" icon="PackagePlus" onClick={() => setFormFor('new')}>
                Add product
              </Button>
            ) : undefined
          }
        />
        {modals}
      </>
    )
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Catalog</h2>
          <div className="cat-subhead">
            <span>
              {filtered.length} of {products.length} products
            </span>
            <Select value={category} onChange={(e) => onCategory(e.target.value)}>
              <option value="">All categories</option>
              {categoryOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {headerActions}
      </div>

      {/* The same chips the Pricing tab draws, measured on the same figure, so
          "Under $100" narrows to the same set of products on either screen. */}
      <PriceBandChips value={band} counts={bandCounts} onChange={setBand} label="Market value" />

      {filtered.length === 0 ? (
        <EmptyState
          icon="Search"
          title="No products match"
          message={category ? 'Try clearing the category filter or search.' : 'Try a different search.'}
          action={
            category ? (
              <Button variant="secondary" icon="X" onClick={() => onCategory('')}>
                Clear category
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="cat-list">
          {filtered.map((p) => {
            const open = expanded === p.id
            const thumb = thumbnails[p.id]
            const low = p.reorderPoint > 0 && p.quantity <= p.reorderPoint
            return (
              <div
                className={`cat-row ${open ? 'open' : ''}`}
                key={p.id}
                style={p.category ? ({ '--cat': categoryColor(p.category) } as CSSProperties) : undefined}
              >
                <div className="cr-head">
                  {canManage && (
                    <input
                      type="checkbox"
                      className="cr-check"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${p.name}`}
                    />
                  )}
                  <button
                    className="cr-open"
                    aria-expanded={open}
                    aria-controls={`cd-${p.id}`}
                    onClick={() => setExpanded(open ? null : p.id)}
                  >
                    <span className="cr-thumb">
                      {thumb ? (
                        <img src={thumb} alt="" />
                      ) : (
                        <span className="cr-thumb-ph">
                          <CategoryLogo category={p.category} size={18} />
                        </span>
                      )}
                    </span>
                    <span className="cr-main">
                      <span className="cr-name">{p.name}</span>
                      <span className="cr-sub">
                        <span className="mono">{p.sku}</span>
                        {p.category && <span className="cr-chip">{p.category}</span>}
                      </span>
                    </span>
                    <span className="cr-stock">
                      {placesOnRow(p.quantityByLocation).map((l) => (
                        <span key={l.id} className="crs-loc">
                          <em>{l.label}</em> {formatStockOnHand(productUnits(p), l.qty)}
                        </span>
                      ))}
                      <span className={`crs-total ${low ? 'stock-low' : ''}`}>
                        {formatStockOnHand(productUnits(p), p.quantity)}
                        {/* A CRACKED CASE, said on the row rather than left to be
                            inferred from a decimal. "3 + 11 boxes" already reads
                            as one case being open; this is what makes it findable
                            when somebody is scanning the list for what is part-used
                            rather than reading one product's numbers. */}
                        {hasOpenCase(productUnits(p), p.quantity) && (
                          <span className="crs-open" title="A case is open — see the boxes left in it">
                            <Icon name="PackageOpen" size={12} strokeWidth={2.5} />
                          </span>
                        )}
                        {low && <Icon name="AlertTriangle" size={12} strokeWidth={2.5} />}
                      </span>
                    </span>
                    <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={17} className="cr-exp" />
                  </button>
                </div>
                {open && (
                  <ProductDetail
                    product={p}
                    canManage={canManage}
                    onChanged={onChanged}
                    onImagesChanged={onImagesChanged}
                    onEdit={() => setFormFor(p)}
                    onStock={() => setStockFor(p)}
                    onSell={() => setSaleFor(p)}
                    onConsign={() => setConsignFor(p)}
                    onDelete={() => setDeleteFor(p)}
                    onOpenPo={onOpenPo}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {canManage && selected.size > 0 && (
        <div className="cat-bulkbar">
          <span>
            {selected.size} selected
            <button className="link-btn" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </span>
          <Button variant="danger" size="sm" icon="Trash2" onClick={() => setBulkDelete(true)}>
            Delete selected
          </Button>
        </div>
      )}

      {modals}
    </>
  )
}

/** Expanded product detail: image carousel + Add image, plus auto-saving fields. */
function ProductDetail({
  product,
  canManage,
  onChanged,
  onImagesChanged,
  onEdit,
  onStock,
  onSell,
  onConsign,
  onDelete,
  onOpenPo
}: {
  product: InventoryProduct
  canManage: boolean
  onChanged: () => Promise<void>
  onImagesChanged: () => void
  onEdit: () => void
  onStock: () => void
  onSell: () => void
  /** Hand units to somebody to sell for us. See ConsignModal. */
  onConsign: () => void
  onDelete: () => void
  /** Open the purchase order a case came off. Absent when nothing can navigate. */
  onOpenPo?: (poId: string) => void
}): JSX.Element {
  const toast = useToast()
  const [images, setImages] = useState<ProductImage[] | null>(null)
  const [idx, setIdx] = useState(0)
  const [imgBusy, setImgBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [zoom, setZoom] = useState(false)

  useEffect(() => {
    let active = true
    api.inventory.listImages(product.id).then((imgs) => {
      if (active) {
        setImages(imgs)
        setIdx(0)
      }
    })
    return () => {
      active = false
    }
  }, [product.id])

  const flash = (): void => {
    setSaved(true)
    window.setTimeout(() => setSaved(false), 1500)
  }

  const save = async (patch: Omit<UpdateInventoryProduct, 'id'>): Promise<void> => {
    const res = await api.inventory.update({ id: product.id, ...patch })
    if (res.ok) {
      flash()
      await onChanged()
    } else {
      toast.error(res.error ?? 'Could not save.')
    }
  }

  const addImage = async (): Promise<void> => {
    setImgBusy(true)
    try {
      const res = await api.inventory.addImage(product.id)
      if (res.ok && res.data) {
        setImages(res.data)
        setIdx(res.data.length - 1)
        toast.success('Image added.')
        onImagesChanged()
      } else if (res.error && res.error !== 'No image selected.') {
        toast.error(res.error)
      }
    } finally {
      setImgBusy(false)
    }
  }

  const removeImage = async (id: string): Promise<void> => {
    setImgBusy(true)
    try {
      const res = await api.inventory.removeImage(id)
      if (res.ok && res.data) {
        const imgs = res.data
        setImages(imgs)
        setIdx((i) => Math.max(0, Math.min(i, imgs.length - 1)))
        onImagesChanged()
      } else {
        toast.error(res.error ?? 'Could not remove image.')
      }
    } finally {
      setImgBusy(false)
    }
  }

  const current = images && images.length > 0 ? images[Math.min(idx, images.length - 1)] : null

  return (
    <div className="cat-detail" id={`cd-${product.id}`}>
      <div className="cd-grid">
        <div className="cd-media">
          <div className="cd-frame">
            {images === null ? (
              <div className="cd-loading">
                <span className="spinner dark" />
              </div>
            ) : current ? (
              <button
                type="button"
                className="cd-frame-img"
                onClick={() => setZoom(true)}
                aria-label="Expand image"
                title="Click to expand"
              >
                <img src={current.dataUrl} alt={product.name} />
                <span className="cd-zoom-hint">
                  <Icon name="Maximize2" size={15} />
                </span>
              </button>
            ) : (
              <div className="cd-ph">
                <CategoryLogo category={product.category} size={34} />
                <span>No image yet</span>
              </div>
            )}
            {canManage && current && (
              <button className="cd-remove" title="Remove image" onClick={() => removeImage(current.id)}>
                <Icon name="Trash2" size={14} />
              </button>
            )}
          </div>
          <div className="cd-media-bar">
            {images && images.length > 1 ? (
              <div className="cd-nav">
                <button
                  aria-label="Previous image"
                  onClick={() => setIdx((i) => (i - 1 + images.length) % images.length)}
                >
                  <Icon name="ArrowLeft" size={15} />
                </button>
                <span>
                  {Math.min(idx, images.length - 1) + 1} of {images.length}
                </span>
                <button
                  aria-label="Next image"
                  onClick={() => setIdx((i) => (i + 1) % images.length)}
                >
                  <Icon name="ArrowRight" size={15} />
                </button>
              </div>
            ) : (
              <span />
            )}
            {canManage && (
              <Button size="sm" variant="secondary" icon="Plus" loading={imgBusy} onClick={addImage}>
                Add image
              </Button>
            )}
          </div>
        </div>

        <div className="cd-fields">
          {canManage ? (
            <>
              <div className="field-row">
                <EditField label="Display name" required value={product.name} onCommit={(v) => save({ name: v })} />
              </div>
              <div className="field-row">
                <EditField label="SKU" value={product.sku} onCommit={(v) => save({ sku: v })} />
                <EditField label="Barcode (UPC)" value={product.upc ?? ''} onCommit={(v) => save({ upc: v || null })} />
              </div>
              <div className="field-row">
                <EditField label="Brand" value={product.brand} onCommit={(v) => save({ brand: v })} />
                <EditField label="Category" value={product.category} onCommit={(v) => save({ category: v })} />
              </div>
              <div className="field-row">
                <EditField
                  label="Average cost"
                  type="number"
                  value={String(product.unitCost)}
                  onCommit={(v) => save({ unitCost: v === '' ? 0 : Number(v) })}
                />
                <EditField
                  label="High bid"
                  type="number"
                  value={product.highBid != null ? String(product.highBid) : ''}
                  onCommit={(v) => save({ highBid: v === '' ? null : Number(v) })}
                />
              </div>
            </>
          ) : (
            <div className="cd-readonly">
              <ReadRow label="SKU" value={product.sku} />
              <ReadRow label="Barcode" value={product.upc ?? '—'} />
              <ReadRow label="Brand" value={product.brand || '—'} />
              <ReadRow label="Category" value={product.category || '—'} />
            </div>
          )}
        </div>
      </div>

      <div className="cd-stockline">
        <span>
          <em>Type</em> {structureLabel(product)}
        </span>
        {placesOnRow(product.quantityByLocation).map((l) => (
          <span key={l.id}>
            <em>{l.label}</em> {formatStockOnHand(productUnits(product), l.qty)}
          </span>
        ))}
        <span>
          <em>Total</em> {formatStockOnHand(productUnits(product), product.quantity)}
        </span>
        {/* What is actually in the open case, spelled out. The row above reads
            "3 + 11 boxes"; this says which of those numbers is the broken one and
            how much of it is left, which is the question somebody opens a product
            to answer. */}
        {(() => {
          const split = stockBreakdown(productUnits(product), product.quantity)
          if (!split || !split.open) return null
          return (
            <span className="cd-opencase" title="One case has been broken into">
              <Icon name="PackageOpen" size={11} />
              {split.fullCases} sealed · 1 open with {split.looseBoxes} box
              {split.looseBoxes === 1 ? '' : 'es'} left
            </span>
          )
        })()}
        {/* Only this flag makes a fractional on-hand legal, so it is named where
            the fraction is read. Without it "2.25" here looks like a bug. */}
        {product.giveawayItem && (
          <span className="cd-giveaway-flag" title="Part boxes and packs are allowed on this product">
            <Icon name="Gift" size={11} />
            Giveaway item — part units allowed
          </span>
        )}
      </div>

      {product.quantity > 0 && (
        <div className="cd-cases">
          <div className="cd-cases-head">
            Cases · FIFO order <span>(sold oldest first)</span>
          </div>
          <ProductCasesLoader productId={product.id} unitType={product.unitType} />
        </div>
      )}

      {/* Which order bought these, and what is still coming. Shown even at zero
          on hand: "nothing here and PO-0009 is bringing four" is the answer
          somebody is looking for exactly when the shelf is empty. */}
      <ProductOrigins productId={product.id} onOpenPo={onOpenPo} />

      {/* WHERE THE CASES THAT ARE NOT HERE ARE.

          Consigning takes units off the shelf — that is what makes them
          unsellable and unbreakable — so without this the count would simply
          drop and nothing would say where three cases went. Draws nothing at
          all on a product that has never been consigned. */}
      <ProductConsignments
        productId={product.id}
        unitNoun={unitLabel(product.unitType).toLowerCase()}
        canManage={canManage}
        onChanged={onChanged}
      />

      {canManage && (
        <div className="cd-actions">
          <Button size="sm" variant="secondary" icon="PackagePlus" onClick={onStock}>
            Add stock
          </Button>
          <Button size="sm" variant="secondary" icon="ShoppingCart" disabled={product.quantity <= 0} onClick={onSell}>
            Sell
          </Button>
          {/* Beside Sell, because it is the other way stock leaves this
              building — and the one that is not a sale. Disabled at zero on
              hand for the same reason Sell is: there is nothing to send. */}
          <Button
            size="sm"
            variant="secondary"
            icon="Send"
            disabled={product.quantity <= 0}
            title="Hand these to somebody to sell for us — they come off the shelf and cannot be sold or broken while they are out"
            onClick={onConsign}
          >
            Consign
          </Button>
          <Button size="sm" variant="ghost" icon="Pencil" onClick={onEdit}>
            Full edit
          </Button>
          <Button size="sm" variant="ghost" icon="Trash2" aria-label="Delete product" title="Delete product" onClick={onDelete} />
          <span className={`cd-saved ${saved ? 'show' : ''}`}>
            <Icon name="Check" size={13} /> Saved
          </span>
        </div>
      )}

      {zoom && images && images.length > 0 && (
        <ImageLightbox
          images={images}
          index={idx}
          alt={product.name}
          onIndex={setIdx}
          onClose={() => setZoom(false)}
        />
      )}
    </div>
  )
}

/**
 * Commit-on-blur text/number field — the catalog's inline edit.
 *
 * EXPORTED for the zero-cost banner on the Overview, which now offers the same
 * cost field beside each product it names. Same component rather than a second
 * one: the two are the same interaction (type a cost, look away, it saves) and
 * the normalising this does — reverting an unreadable number, snapping "10.0" to
 * "10" so it does not re-fire on every blur — is exactly the fiddly part nobody
 * would remember to reimplement.
 */
export function EditField({
  label,
  value,
  onCommit,
  type = 'text',
  required = false,
  ariaLabel
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  type?: string
  required?: boolean
  /**
   * The name a screen reader announces, when the visible label is carried by
   * something else — a column header in the missing-identifier table, where a
   * label above every cell would double the height of every row. Passing an
   * empty `label` alone would leave the control with no accessible name at all,
   * which is a field nobody using a reader can tell from the one beside it.
   */
  ariaLabel?: string
}): JSX.Element {
  const [v, setV] = useState(value)
  useEffect(() => {
    setV(value)
  }, [value])

  // On blur: normalize, revert invalid/blanked-required input, and only save a
  // genuine change — then snap the field to the canonical value so it never
  // stays "dirty" (e.g. "10.0" → "10") and re-fires on every subsequent blur.
  const commit = (): void => {
    const raw = v.trim()
    if (type === 'number') {
      if (raw === '') {
        if (value !== '') onCommit('')
        setV('')
        return
      }
      const num = Number(raw)
      if (!Number.isFinite(num)) {
        setV(value)
        return
      }
      const canonical = String(num)
      if (canonical !== value) onCommit(canonical)
      setV(canonical)
      return
    }
    if (required && raw === '') {
      setV(value)
      return
    }
    if (raw !== value) onCommit(raw)
    setV(raw)
  }

  return (
    <Field label={label}>
      <Input
        type={type}
        aria-label={ariaLabel}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
      />
    </Field>
  )
}

function ReadRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="metric-row">
      <span className="m-k">{label}</span>
      <span className="m-v">{value}</span>
    </div>
  )
}
