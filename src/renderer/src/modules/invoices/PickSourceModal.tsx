import { useEffect, useMemo, useState } from 'react'
import type { InventoryProduct } from '@shared/types'
import type { ProductAvailability } from '@shared/availability'
import { placesWorthNaming } from '@shared/availability'
import type { ShelfOption, ShelfSlice } from '@shared/pickSource'
import {
  shelfSumProblem,
  allocationTotal,
  defaultAllocation,
  fillFromShelf,
  quantityAt,
  setShelfQuantity,
  shelfShortfalls,
  toLineChoice
} from '@shared/pickSource'
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
 * ## SEVERAL SHELVES AT ONCE, which is what the number beside each one is for
 *
 * The owner: "I want to be able to add each of these here to sum to 3." Three
 * shelves each holding one, and a line for three that has to come off all of
 * them. The figure beside a shelf used to be what it HELD — information you
 * could not edit — so the only reachable answer was one shelf and a warning
 * that the order would be short.
 *
 * Now it is how many you are taking from there, with what it holds shown
 * alongside. Pressing a row fills it from what is left, so 1 + 1 + 1 is three
 * clicks and no typing. The rows must add up to the quantity, and that is the
 * one thing here that is refused rather than warned about: rows that do not sum
 * would put a different number of units on the document than on the shelves.
 * See @shared/pickSource, which owns every rule below.
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
  /**
   * Blank location means "same as the order", which is how a line stores it.
   *
   * `allocations` is EMPTY for a single-shelf add — see `toLineChoice` — so the
   * ordinary path writes exactly what it always wrote and only a genuine split
   * carries rows.
   */
  onAdd: (choice: { quantity: number; location: string; allocations: ShelfSlice[] }) => void
}): JSX.Element {
  const [have, setHave] = useState<ProductAvailability | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [alloc, setAlloc] = useState<ShelfSlice[]>(() => defaultAllocation(1, defaultLocation))
  /**
   * Has anybody actually touched the shelves?
   *
   * While nobody has, the allocation FOLLOWS the quantity stepper — so the
   * ordinary add, where somebody sets three and presses Add without reading the
   * list, behaves exactly as it did before this control could split. Once a
   * shelf has been set by hand the rows are left alone, because silently
   * rewriting a split somebody just typed is worse than making them fix a total.
   */
  const [touched, setTouched] = useState(false)

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

  /** The shelves as the rules module wants them. */
  const options: ShelfOption[] = useMemo(
    () => places.map((p) => ({ location: p.id, onHand: p.quantity })),
    [places]
  )

  // While untouched the split simply IS the quantity, at the order's shelf.
  const slices = touched ? alloc : defaultAllocation(quantity, defaultLocation)
  const allocated = allocationTotal(slices)
  const problem = shelfSumProblem(slices, quantity)
  const shortfalls = shelfShortfalls(slices, options)

  const setAt = (location: string, q: number): void => {
    setTouched(true)
    setAlloc(setShelfQuantity(slices, location, q))
  }
  /** Press a row and it takes whatever is still unplaced, up to what it holds. */
  const fill = (o: ShelfOption): void => {
    setTouched(true)
    setAlloc(fillFromShelf(slices, o, quantity))
  }

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
            // The ONLY refusal here. A shelf short of what it was asked for is
            // warned about below and allowed through; rows that do not add up
            // are not a judgement about stock, they are a line whose units do
            // not match the document.
            disabled={!!problem}
            title={problem ?? undefined}
            onClick={() => onAdd(toLineChoice(slices, quantity, defaultLocation))}
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
              const taking = quantityAt(slices, p.id)
              const on = taking > 0
              return (
                <li key={p.id}>
                  <div className={`ps-place${on ? ' is-on' : ''}${p.quantity === 0 ? ' is-empty' : ''}`}>
                    {/* The NAME is the fill button — press it and the row takes
                        whatever is still unplaced. That is what makes three
                        shelves holding one each into 1+1+1 without typing. */}
                    <button
                      type="button"
                      className="ps-place-name"
                      onClick={() => fill({ location: p.id, onHand: p.quantity })}
                      title={`Take what is left from ${p.id}`}
                    >
                      {on && <Icon name="Check" size={13} />}
                      {p.id}
                      {p.id.toLowerCase() === defaultLocation.toLowerCase() && (
                        <span className="ps-default">the order’s shelf</span>
                      )}
                      <span className="ps-place-have">{p.quantity} here</span>
                    </button>
                    <div className="ps-place-take">
                      <button
                        type="button"
                        aria-label={`One fewer from ${p.id}`}
                        disabled={taking <= 0}
                        onClick={() => setAt(p.id, taking - 1)}
                      >
                        −
                      </button>
                      <input
                        aria-label={`Units from ${p.id}`}
                        className="mono"
                        inputMode="numeric"
                        value={String(taking)}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) =>
                          setAt(p.id, Math.max(0, Math.round(Number(e.target.value.replace(/\D+/g, '')) || 0)))
                        }
                      />
                      <button
                        type="button"
                        aria-label={`One more from ${p.id}`}
                        onClick={() => setAt(p.id, taking + 1)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* THE RUNNING TOTAL, always shown once the list has been touched.
          A control whose Add button can be disabled has to say why before it is
          reached for, not after — so the sum is on screen from the first edit
          rather than appearing as an error at the end. */}
      {have !== null && (touched || problem) && (
        <p className={`ps-total${problem ? ' is-off' : ''}`}>
          <Icon name={problem ? 'AlertTriangle' : 'Check'} size={13} />
          <span>
            <b>
              {allocated} of {Math.max(1, quantity)}
            </b>{' '}
            placed on shelves{problem ? ` — ${problem}` : ''}
          </span>
        </p>
      )}

      {/* SAID, NOT REFUSED. Selling ahead of a shelf is ordinary — the case is
          in transit, the shop is holding one, the count is a day old — and
          applyInvoiceStock already draws what it can and leaves the rest owed.
          What must not happen is finding out later.

          NAMED PER SHELF rather than as one total: "two short" across three
          shelves does not say which shop to chase, and chasing the wrong one is
          what the vague version costs. */}
      {have !== null &&
        shortfalls.map((s) => (
          <p className="ps-warn" key={s.location}>
            <Icon name="AlertTriangle" size={13} />
            {s.have === 0 ? 'Nothing' : `Only ${s.have}`} at {s.location}, and {s.want}{' '}
            {s.want === 1 ? 'is' : 'are'} coming off it — <b>{s.short}</b> short unless it arrives.
          </p>
        ))}
    </Modal>
  )
}
