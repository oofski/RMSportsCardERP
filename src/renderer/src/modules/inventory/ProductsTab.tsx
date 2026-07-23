import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { InventoryProduct, ProductImage, UpdateInventoryProduct } from '@shared/types'
import { CATEGORY_ORDER, LOCATIONS, categoryColor } from '@shared/inventory'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, EmptyState, Field, Input, Modal, Select } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { CategoryLogo } from './CategoryLogo'
import { productMatches, structureLabel } from './helpers'
import { ImageLightbox } from './ImageLightbox'
import { ProductCasesLoader } from './ProductCases'
import { ProductFormModal } from './ProductFormModal'
import { RecordSaleModal } from './RecordSaleModal'
import { StockModal } from './StockModal'

export function ProductsTab({
  products,
  query,
  category,
  onCategory,
  thumbnails,
  canManage,
  onChanged,
  onImagesChanged
}: {
  products: InventoryProduct[]
  query: string
  category: string
  onCategory: (c: string) => void
  thumbnails: Record<string, string>
  canManage: boolean
  onChanged: () => Promise<void>
  onImagesChanged: () => void
}): JSX.Element {
  const toast = useToast()
  const [formFor, setFormFor] = useState<InventoryProduct | null | 'new'>(null)
  const [saleFor, setSaleFor] = useState<InventoryProduct | 'any' | null>(null)
  const [stockFor, setStockFor] = useState<InventoryProduct | 'any' | null>(null)
  const [deleteFor, setDeleteFor] = useState<InventoryProduct | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
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

  const filtered = useMemo(
    () =>
      products.filter((p) => {
        if (category && p.category !== category) return false
        return productMatches(p, query)
      }),
    [products, query, category]
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
                      {LOCATIONS.map((l) => (
                        <span key={l.id} className="crs-loc">
                          <em>{l.label}</em> {p.quantityByLocation[l.id] ?? 0}
                        </span>
                      ))}
                      <span className={`crs-total ${low ? 'stock-low' : ''}`}>
                        {p.quantity}
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
                    onDelete={() => setDeleteFor(p)}
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
  onDelete
}: {
  product: InventoryProduct
  canManage: boolean
  onChanged: () => Promise<void>
  onImagesChanged: () => void
  onEdit: () => void
  onStock: () => void
  onSell: () => void
  onDelete: () => void
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
        {LOCATIONS.map((l) => (
          <span key={l.id}>
            <em>{l.label}</em> {product.quantityByLocation[l.id] ?? 0}
          </span>
        ))}
        <span>
          <em>Total</em> {product.quantity}
        </span>
      </div>

      {product.quantity > 0 && (
        <div className="cd-cases">
          <div className="cd-cases-head">
            Cases · FIFO order <span>(sold oldest first)</span>
          </div>
          <ProductCasesLoader productId={product.id} unitType={product.unitType} />
        </div>
      )}

      {canManage && (
        <div className="cd-actions">
          <Button size="sm" variant="secondary" icon="PackagePlus" onClick={onStock}>
            Add stock
          </Button>
          <Button size="sm" variant="secondary" icon="ShoppingCart" disabled={product.quantity <= 0} onClick={onSell}>
            Sell
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

function EditField({
  label,
  value,
  onCommit,
  type = 'text',
  required = false
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  type?: string
  required?: boolean
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
      <Input type={type} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} />
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
