import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { useChrome } from '../../lib/chrome'
import { api } from '../../lib/api'
import { useToast } from '../../components/Toast'
import { Button, EmptyState, Modal } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { formatMoney } from '../../lib/format'
import { UnitBadge } from './helpers'
import { ProductFormModal } from './ProductFormModal'
import { RecordSaleModal } from './RecordSaleModal'
import { RestockModal } from './RestockModal'

export function ProductsTab({
  products,
  canManage,
  onChanged
}: {
  products: InventoryProduct[]
  canManage: boolean
  onChanged: () => Promise<void>
}): JSX.Element {
  const { search } = useChrome()
  const toast = useToast()
  const [formFor, setFormFor] = useState<InventoryProduct | null | 'new'>(null)
  const [saleFor, setSaleFor] = useState<InventoryProduct | 'any' | null>(null)
  const [restockFor, setRestockFor] = useState<InventoryProduct | null>(null)
  const [deleteFor, setDeleteFor] = useState<InventoryProduct | null>(null)
  const [busy, setBusy] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter((p) =>
      [p.sku, p.name, p.category, p.brand, p.setName, p.year].join(' ').toLowerCase().includes(q)
    )
  }, [products, search])

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

  if (products.length === 0) {
    return (
      <>
        <EmptyState
          icon="Boxes"
          title="No inventory yet"
          message="Add your first product — a case, box, pack or single — and set its opening stock and cost."
          action={
            canManage ? (
              <Button variant="primary" icon="PackagePlus" onClick={() => setFormFor('new')}>
                Add product
              </Button>
            ) : undefined
          }
        />
        {formFor && (
          <ProductFormModal
            product={null}
            onClose={() => setFormFor(null)}
            onSaved={async () => {
              setFormFor(null)
              await onChanged()
            }}
          />
        )}
      </>
    )
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2>Products</h2>
          <p>
            {filtered.length} of {products.length} shown. Search from the top bar.
          </p>
        </div>
        {canManage && (
          <div className="row" style={{ gap: 8 }}>
            <Button variant="secondary" icon="ShoppingCart" onClick={() => setSaleFor('any')}>
              Record sale
            </Button>
            <Button variant="primary" icon="PackagePlus" onClick={() => setFormFor('new')}>
              Add product
            </Button>
          </div>
        )}
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
                <th>Unit</th>
                <th>Qty</th>
                <th>Unit cost</th>
                <th>Value</th>
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
                          {(p.brand || p.setName || p.year) && (
                            <>
                              {' · '}
                              {[p.brand, p.setName, p.year].filter(Boolean).join(' ')}
                            </>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{p.category || <span className="muted">—</span>}</td>
                    <td>
                      <UnitBadge unit={p.unitType} />
                    </td>
                    <td className={low ? 'stock-low' : ''} style={{ fontWeight: 600 }}>
                      {p.quantity}
                      {low && (
                        <Icon name="AlertTriangle" size={13} className="" strokeWidth={2.5} />
                      )}
                    </td>
                    <td className="money">{formatMoney(p.unitCost)}</td>
                    <td className="money">{formatMoney(p.quantity * p.unitCost)}</td>
                    {canManage && (
                      <td>
                        <div className="cell-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="ShoppingCart"
                            disabled={p.quantity <= 0}
                            onClick={() => setSaleFor(p)}
                          >
                            Sell
                          </Button>
                          <Button size="sm" variant="ghost" icon="PackagePlus" onClick={() => setRestockFor(p)}>
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

      {restockFor && (
        <RestockModal
          product={restockFor}
          onClose={() => setRestockFor(null)}
          onSaved={async () => {
            setRestockFor(null)
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
            This removes the product and its stock history. Recorded sales revenue is also removed.
            This can't be undone.
          </p>
        </Modal>
      )}
    </>
  )
}
