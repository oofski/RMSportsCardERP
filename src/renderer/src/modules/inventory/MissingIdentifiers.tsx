import { useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import {
  countIdentifierGaps,
  identifierGap,
  productsMissingIdentifiers,
  skuGap,
  type IdentifierGap,
  type SkuGap
} from '@shared/identifiers'
import { Button, EmptyState } from '../../components/ui'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import { api } from '../../lib/api'
import { CategoryLogo } from './CategoryLogo'
import { EditField } from './ProductsTab'

/**
 * What each state is called and what it costs, in ONE place.
 *
 * The dashboard tile, the filter chips here and the badge on every row all name
 * the same three numbers, and three sets of words drifting apart is how a screen
 * ends up saying "no UPC" in one corner and "no barcode" in another about the
 * same fourteen products. `noun` is the mid-sentence form the tile needs
 * ("14 no SKU"); `label` is the standalone form a chip and a badge need.
 */
export const GAP_META: Record<IdentifierGap, { label: string; noun: string; blurb: string }> = {
  both: {
    label: 'Neither',
    noun: 'neither',
    blurb: 'No barcode and no SKU — cannot be scanned, and cannot be billed by SKU.'
  },
  sku: {
    label: 'No SKU',
    noun: 'no SKU',
    blurb: 'Scannable, but an invoice line can only match it to QuickBooks by name.'
  },
  upc: {
    label: 'No barcode',
    noun: 'no barcode',
    blurb: 'Billable, but no scanner in the building can find it.'
  }
}

/**
 * The drill-down behind the dashboard's "Missing identifiers" tile: every
 * product with a gap, WITH the two fields that close it.
 *
 * WHY THE FIELDS ARE HERE RATHER THAN A LINK TO THE CATALOG. The names have
 * always been able to be buttons into the Catalog, and that is one navigation,
 * one search and one scroll per product — times a hundred and ninety-eight on a
 * catalog this size. The whole reason for this screen is closing the gaps rather
 * than admiring them, and the gap is two short strings. So it is the catalog's
 * own `EditField` (commit-on-blur, same normalising, same save path through
 * api.inventory.update) sitting on the row it fixes, and the name is still a
 * button for the times the answer is not one of these two fields.
 *
 * NOTHING HERE WRITES A CATEGORY. A product listed under "Neither" is still
 * whatever it always was, and its chip says so on every row — the point being
 * that this is a lens over the catalog, not a bucket products get moved into.
 *
 * A ROW SAVED ON THIS SCREEN STAYS ON IT. Every save reloads the module, and the
 * list re-derives from the reloaded catalog — so without this rule, filling in
 * the SKU of a "Neither" row while the "Neither" filter is on would drop the row
 * out of the list at the exact moment the cursor moved into its barcode field,
 * taking the half-typed second half of a two-field fix with it. Held rows also
 * turn their badge to "Fixed", which is the only confirmation this screen can
 * honestly give that the write reached the database rather than merely that the
 * field lost focus.
 */
export function MissingIdentifiers({
  products,
  canManage,
  onOpenProduct,
  onChanged,
  onBack
}: {
  /** The whole catalog. Filtered here so the count on the tile and the rows on
   *  this screen are one derivation of one rule over one array. */
  products: InventoryProduct[]
  canManage: boolean
  /** Jump to the Catalog focused on this product, for anything these two fields
   *  cannot fix (a duplicate barcode that belongs on the other row, say). */
  onOpenProduct: (name: string) => void
  onChanged: () => Promise<void>
  onBack: () => void
}): JSX.Element {
  const toast = useToast()
  const [only, setOnly] = useState<IdentifierGap | 'all'>('all')
  // Which rows have been saved in this session, so the tick is per product and
  // not a single flash that fires wherever the cursor happens to be.
  const [saved, setSaved] = useState<Record<string, true>>({})

  const counts = useMemo(() => countIdentifierGaps(products), [products])

  /** One line of the table. `gap` is null for a product already put right. */
  type Row = { product: InventoryProduct; gap: IdentifierGap | null; sku: SkuGap | null }

  const rows = useMemo<Row[]>(() => {
    const matching: Row[] = productsMissingIdentifiers(products, only)
    // Everything saved here that the filter (or the fix itself) would otherwise
    // have dropped, appended after the outstanding work — see the note above the
    // component. Ordinary rows keep their worst-first order; the ones already
    // dealt with sink to the bottom where they are out of the way.
    const shown = new Set(matching.map((r) => r.product.id))
    const held: Row[] = products
      .filter((p) => saved[p.id] && !shown.has(p.id))
      .map((p) => ({ product: p, gap: identifierGap(p), sku: skuGap(p.sku) }))
    return [...matching, ...held]
  }, [products, only, saved])

  const save = async (p: InventoryProduct, patch: { sku?: string; upc?: string | null }): Promise<void> => {
    const res = await api.inventory.update({ id: p.id, ...patch })
    if (!res.ok) {
      // The one failure that is not a bug and has to be readable: the barcode is
      // already on another product, and the fix is on that row, not this one.
      toast.error(res.error ?? 'Could not save.')
      return
    }
    setSaved((s) => ({ ...s, [p.id]: true }))
    await onChanged()
  }

  const chips: Array<{ id: IdentifierGap | 'all'; label: string; title: string; count: number }> = [
    { id: 'all', label: 'All', title: 'Every product missing either identifier.', count: counts.total },
    { id: 'both', label: GAP_META.both.label, title: GAP_META.both.blurb, count: counts.both },
    { id: 'sku', label: GAP_META.sku.label, title: GAP_META.sku.blurb, count: counts.sku },
    { id: 'upc', label: GAP_META.upc.label, title: GAP_META.upc.blurb, count: counts.upc }
  ]

  return (
    <>
      <div className="section-head">
        <div className="row" style={{ gap: 12 }}>
          <Button variant="ghost" size="sm" icon="ArrowLeft" onClick={onBack}>
            Back
          </Button>
          <div>
            <h2>Missing identifiers</h2>
            <p>
              {counts.total === 0 ? (
                'Every product in the catalog carries both a SKU and a barcode.'
              ) : (
                <>
                  {counts.total} product{counts.total === 1 ? '' : 's'}, across every category ·{' '}
                  {counts.both} with neither · {counts.sku} with no SKU · {counts.upc} with no
                  barcode
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Not a category filter — these cut across the categories. Rendered as
          chips rather than a Select so the three counts stay legible at a
          glance, which is the difference between a screen somebody works
          through and one they read once. */}
      <div className="ident-filters">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`ident-chip ${only === c.id ? 'active' : ''}`}
            aria-pressed={only === c.id}
            title={c.title}
            onClick={() => setOnly(c.id)}
          >
            {c.label}
            <span className="ident-chip-n">{c.count}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="ScanBarcode"
          title={
            counts.total === 0
              ? 'Every product has a SKU and a barcode'
              : 'Nothing in this state right now'
          }
          message={
            counts.total === 0
              ? 'Nothing in the catalog is invisible to the scanner or to QuickBooks.'
              : 'Clear the filter to see the products that still need one.'
          }
          action={
            counts.total > 0 ? (
              <Button variant="secondary" icon="X" onClick={() => setOnly('all')}>
                Clear filter
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="table-wrap">
          {/* Stacks into one card per product on a phone — see section 3 of
              styles/mobile.css. The first cell carries no data-label on purpose:
              it becomes the card's headline. */}
          <table className="data as-cards ident-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Missing</th>
                <th>SKU</th>
                <th>Barcode (UPC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ product: p, gap, sku }) => (
                <tr key={p.id}>
                  <td>
                    <div className="ident-name">
                      <span className="ident-logo">
                        <CategoryLogo category={p.category} size={16} />
                      </span>
                      <div>
                        <button type="button" className="link-btn ident-open" onClick={() => onOpenProduct(p.name)}>
                          {p.name}
                        </button>
                        {/* The category, printed on every row, because the
                            promise this screen makes is that nothing was
                            refiled to get here. */}
                        <div className="ident-cat">
                          {p.category || 'Uncategorized'}
                          {saved[p.id] && (
                            <span className="ident-saved">
                              <Icon name="Check" size={12} /> Saved
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td data-label="Missing">
                    <span className={`badge ident-badge ident-${gap ?? 'fixed'}`}>
                      {gap ? GAP_META[gap].label : 'Fixed'}
                    </span>
                    {/* A row whose SKU field is not empty but says BOX has to
                        explain itself, or it reads as the screen being wrong. */}
                    {gap && sku === 'placeholder' && (
                      <span className="ident-why">“{p.sku.trim()}” identifies nothing</span>
                    )}
                  </td>
                  <td data-label="SKU">
                    {canManage ? (
                      <EditField
                        label=""
                        ariaLabel={`SKU for ${p.name}`}
                        value={p.sku}
                        onCommit={(v) => void save(p, { sku: v })}
                      />
                    ) : (
                      <span className="mono">{p.sku.trim() || '—'}</span>
                    )}
                  </td>
                  <td data-label="Barcode (UPC)">
                    {canManage ? (
                      <EditField
                        label=""
                        ariaLabel={`Barcode for ${p.name}`}
                        value={p.upc ?? ''}
                        onCommit={(v) => void save(p, { upc: v || null })}
                      />
                    ) : (
                      <span className="mono">{(p.upc ?? '').trim() || '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
