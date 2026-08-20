import { useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import { useSession } from '../../lib/session'
import { Button } from '../../components/ui'
import { ProductFormModal } from './ProductFormModal'

/**
 * What a catalog search says when it finds nothing, and the way out of it.
 *
 * ## Why this is a component and not three copies of six lines
 *
 * There are THREE catalog typeaheads in this app — the invoicing one shared by
 * sales orders, purchase orders and the pasted-offer review; Inventory's own in
 * IncomingModal; and Streaming's in AddItemForm. They differ in the read they
 * make and in what each result line says underneath the name, which is why they
 * are three components. AddItemForm's own header comment already warns what
 * happens when that multiplies ("a second search implementation would be a
 * second set of matching rules to keep in step") — so the escape hatch lands
 * here once rather than being pasted into all three, where the button would
 * drift out of step with the permission it is gated on.
 *
 * ## Offered only to somebody who can actually do it
 *
 * Creating a product is `inventory.manage` in the IPC handler. Two of these
 * three searches run on something looser — the invoicing one deliberately needs
 * only `module.invoicing`, so a person raising orders can find products without
 * holding the catalog. Drawing the button for the difference between those sets
 * would be a button that fills in a whole product form and is then refused at
 * the end of it. Somebody without the permission just sees the plain sentence,
 * exactly as before.
 */
export function CatalogEmpty({
  query,
  onCreated
}: {
  /** What was typed. Becomes the new product's name, so nobody types it twice. */
  query: string
  onCreated: (product: InventoryProduct) => void
}): JSX.Element {
  const { can } = useSession()
  const [creating, setCreating] = useState<string | null>(null)
  const wanted = query.trim()

  if (!can('inventory.manage')) {
    return <div className="ta-empty">No match in the catalog.</div>
  }

  return (
    <>
      <div className="ta-empty ta-empty-action">
        <span>No match in the catalog.</span>
        <Button
          variant="secondary"
          size="sm"
          icon="PackagePlus"
          onClick={() => setCreating(wanted)}
        >
          Add “{wanted}”
        </Button>
      </div>
      {creating !== null && (
        <ProductFormModal
          product={null}
          presetName={creating}
          onClose={() => setCreating(null)}
          onSaved={(p) => {
            // Straight back to the caller. Re-running the search that just
            // failed and trusting it to turn up the row we are already holding
            // would be guessing at an answer the save already gave.
            setCreating(null)
            onCreated(p)
          }}
        />
      )}
    </>
  )
}
