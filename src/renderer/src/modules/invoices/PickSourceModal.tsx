import { useEffect, useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { ProductAvailability } from '@shared/availability'
import { placesWorthNaming, unitsOwned } from '@shared/availability'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'
import { Button, Modal } from '../../components/ui'

/**
 * HOW MANY, AND WHICH SHELF THEY COME OFF. Asked once, when the line is added.
 *
 * The owner: "when I am searching a product it should just allow me to click,
 * and then when I am inserting it — increasing the count — it should let me
 * pick, kind of the pop-up for FIFO, which place I want to take it from."
 *
 * ## What adding a line used to be
 *
 * Click a search result and a line appeared with a quantity of 1, fulfilled
 * from wherever the ORDER was pointed — which is right almost every time and
 * silently wrong the moment the stock is somewhere else. Fixing it meant
 * knowing to look three columns right, finding a dropdown that showed six
 * places without saying which of them had any, and picking. The information
 * that would have made the choice obvious — two here, three in Kentucky — was
 * on a different screen.
 *
 * So the question is asked where the answer is known, with the counts in front
 * of somebody, at the one moment they are already thinking about this product.
 *
 * ## It is a SHORTCUT, never a gate
 *
 * Everything here can be changed afterwards on the line itself, and the
 * defaults are the old behaviour exactly: one unit, wherever the order points.
 * Somebody who presses Add without reading gets what they got before.
 *
 * ## Places with none are shown, and shown as empty
 *
 * Not hidden. "RM 0" is the reason somebody is about to pick Kentucky, and a
 * picker that silently dropped the empty shelf would leave them wondering
 * whether it had been looked at. The two home shelves are always listed for the
 * same reason; a shop appears once it is holding something.
 */
export function PickSourceModal({
  product,
  defaultLocation,
  onCancel,
  onAdd
}: {
  product: InventoryProduct
  /** Where the ORDER is pointed — the answer when nobody chooses. */
  defaultLocation: string
  onCancel: () => void
  /** Blank location means "same as the order", which is how a line stores it. */
  onAdd: (choice: { quantity: number; location: string }) => void
}): JSX.Element {
  const [have, setHave] = useState<ProductAvailability | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [place, setPlace] = useState<string>('')

  useEffect(() => {
    let alive = true
    void api.inventory
      .productAvailability(product.id)
      .then((a) => alive && setHave(a ?? null))
      .catch(() => alive && setHave(null))
    return () => {
      alive = false
    }
  }, [product.id])

  /**
   * Every place worth offering: the ones holding something, and the shelf the
   * order already points at even when it is empty — because that is the one
   * being chosen BETWEEN, and an option that vanished when it ran out would
   * make the default unpickable.
   */
  const places = useMemo(() => {
    const held = placesWorthNaming(have)
    const rows = held.map((p) => ({ id: p.location, quantity: p.quantity }))
    if (!rows.some((r) => r.id.toLowerCase() === defaultLocation.toLowerCase())) {
      rows.unshift({ id: defaultLocation, quantity: 0 })
    }
    return rows
  }, [have, defaultLocation])

  const picked = place || defaultLocation
  const atPicked = places.find((p) => p.id.toLowerCase() === picked.toLowerCase())?.quantity ?? 0
  const short = Math.max(0, quantity - atPicked)

  return (
    <Modal
      title={product.name}
      subtitle="How many, and which shelf they come off"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            icon="Plus"
            onClick={() =>
              onAdd({
                quantity: Math.max(1, quantity),
                // Blank when it is the order's own shelf: a line stores the
                // INHERITANCE rather than a copy, so a later change to the
                // order's location still carries.
                location: picked.toLowerCase() === defaultLocation.toLowerCase() ? '' : picked
              })
            }
          >
            Add to order
          </Button>
        </>
      }
    >
      <div className="ps-qty">
        <span className="ps-label">How many</span>
        <div className="ps-stepper">
          <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
            −
          </button>
          <input
            value={quantity}
            inputMode="numeric"
            onChange={(e) => setQuantity(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" onClick={() => setQuantity((q) => q + 1)}>
            +
          </button>
        </div>
      </div>

      <div className="ps-places">
        <span className="ps-label">Take them from</span>
        {have === null ? (
          <p className="ps-hint">Counting what is where…</p>
        ) : (
          <ul className="ps-list">
            {places.map((p) => {
              const on = p.id.toLowerCase() === picked.toLowerCase()
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`ps-place${on ? ' is-on' : ''}${p.quantity === 0 ? ' is-empty' : ''}`}
                    onClick={() => setPlace(p.id)}
                  >
                    <span className="ps-place-name">
                      {on && <Icon name="Check" size={13} />}
                      {p.id}
                      {p.id.toLowerCase() === defaultLocation.toLowerCase() && (
                        <span className="ps-default">the order’s shelf</span>
                      )}
                    </span>
                    <span className="ps-place-qty mono">{p.quantity}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* SAID, NOT REFUSED. Selling ahead of the shelf is ordinary here — the
          case is in transit, the shop is holding one, the count is a day old —
          and applyInvoiceStock already draws what it can and leaves the rest
          owed. What must not happen is finding out later. */}
      {short > 0 && have !== null && (
        <p className="ps-warn">
          <Icon name="AlertTriangle" size={13} />
          {atPicked === 0 ? 'Nothing' : `Only ${atPicked}`} at {picked} — this order will be{' '}
          <b>{short}</b> short unless it arrives.
          {unitsOwned(have) > atPicked && ' There is some at another place above.'}
        </p>
      )}
    </Modal>
  )
}
