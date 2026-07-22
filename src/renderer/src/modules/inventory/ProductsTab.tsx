import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { LOCATIONS } from '@shared/inventory'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, EmptyState, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { structureLabel } from './helpers'
import { ProductFormModal } from './ProductFormModal'
import { RecordSaleModal } from './RecordSaleModal'
import { StockModal } from './StockModal'

export function ProductsTab({
  products,
  query,
  canManage,
  onChanged
}: {
  products: InventoryProduct[]
  query: string
  canManage: boolean
  onChanged: () => Promise<void>
}): JSX.Element {
  const toast = useToast()
  const [formFor, setFormFor] = useState<InventoryProduct | null | 'new'>(null)
  const [saleFor, setSaleFor] = useState<InventoryProduct | 'any' | null>(null)
  const [stockFor, setStockFor] = useState<InventoryProduct | 'any' | null>(null)
  const [deleteFor, setDeleteFor] = useState<InventoryProduct | null>(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    return products.filter((p) =>
      [p.sku, p.upc ?? '', p.name, p.category, p.brand, p.setName, p.year]
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [products, query])

  const remove = async (p: InventoryProduct): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.inventory.delete(p.id)
      if (res.ok) {
        toast.success('Product deleted.')
        setDeleteFor(null)
        await onChanged()
      } else {
        toast.error(res.error ?? 'Could not delete.')
      }
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
            This removes the product from the catalog along with its stock and history. This can't be
            undone.
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
          <p>
            {filtered.length} of {products.length} products
          </p>
        </div>
        {headerActions}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="Search" title="No products match your search" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Category</th>
                {LOCATIONS.map((l) => (
                  <th key={l.id} style={{ textAlign: 'center' }}>
                    {l.label}
                  </th>
                ))}
                <th style={{ textAlign: 'center' }}>Total</th>
                {canManage && <th style={{ textAlign: 'right' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const low = p.reorderPoint > 0 && p.quantity <= p.reorderPoint
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="prod-cell">
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="p-sub">
                          <span className="mono">{p.sku}</span>
                          <span className="muted"> · {structureLabel(p)}</span>
                        </div>
                      </div>
                    </td>
                    <td>{p.category || <span className="muted">—</span>}</td>
                    {LOCATIONS.map((l) => (
                      <td key={l.id} style={{ textAlign: 'center' }} className="mono">
                        {p.quantityByLocation[l.id] ?? 0}
                      </td>
                    ))}
                    <td
                      className={low ? 'stock-low' : ''}
                      style={{ fontWeight: 700, textAlign: 'center' }}
                    >
                      {p.quantity}
                      {low && <Icon name="AlertTriangle" size={13} strokeWidth={2.5} />}
                    </td>
                    {canManage && (
                      <td>
                        <div className="cell-actions">
                          <Button size="sm" variant="ghost" icon="ShoppingCart" disabled={p.quantity <= 0} onClick={() => setSaleFor(p)}>
                            Sell
                          </Button>
                          <Button size="sm" variant="ghost" icon="PackagePlus" onClick={() => setStockFor(p)}>
                            Stock
                          </Button>
                          <Button size="sm" variant="secondary" icon="Pencil" onClick={() => setFormFor(p)} />
                          <Button size="sm" variant="ghost" icon="Trash2" onClick={() => setDeleteFor(p)} />
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {modals}
    </>
  )
}
