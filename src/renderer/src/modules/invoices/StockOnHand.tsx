import { useEffect, useState } from 'react'
import type { ProductAvailability } from '@shared/availability'
import { availabilityNote, isHomeShelf, placesWorthNaming, unitsHere } from '@shared/availability'
import { api } from '../../lib/api'
import { Icon } from '../../components/Icon'

/**
 * HOW MANY WE HAVE AND WHERE, on the line where the quantity is being typed.
 *
 * The owner's case, which this whole roadshow change was built around:
 *
 *   "Say I have 4 of product A in total in RM but I need 7. How this logically
 *    should work is that I can say I want 7 — now I can add 3 of product A to
 *    roadshow and pull from there ... when putting quantities of things I need
 *    the RM inventory + roadshow open tabs."
 *
 * The sales-order line editor showed NOTHING: not a count, not a place, not a
 * warning. Somebody typing 7 found out the answer later, when the shelf came up
 * short and the order sat in Awaiting items with no explanation on it.
 *
 * ## Quiet when there is nothing to say
 *
 * Silent whenever our own shelves cover the quantity — which is almost every
 * line. A count under every row would be read past within a day, and then the
 * one that matters would be read past too. It appears exactly when the number
 * typed is more than is downstairs.
 *
 * ## It never refuses anything
 *
 * Selling more than is on hand is ordinary trade here: the case is in transit,
 * the shop is holding one, the count is a day old. `applyInvoiceStock` already
 * draws what it can and leaves the rest owed, and an app that blocked the line
 * would be an app somebody works around. This is a sentence, not a gate.
 *
 * ## Read per line, as the product changes
 *
 * One small query, and only for a line that names a catalog product. Asked
 * again when the product changes because the answer is about that product —
 * and not re-asked as the quantity is typed, because the stock did not move.
 */
export function StockOnHand({
  productId,
  quantity,
  location
}: {
  productId: string
  /** What the line is asking for. */
  quantity: number
  /**
   * WHERE THIS LINE IS ACTUALLY DRAWING FROM — the "Fulfilled from" answer.
   *
   * This note used to ignore it and measure against the home shelves whatever
   * the line said, which put a flat contradiction on the screen: a line pointed
   * at Kentucky Roadshow, with two cases standing in Kentucky, was told "Only 0
   * here — the rest are at 2 at Kentucky Roadshow". The line had already
   * answered the question the note was asking.
   *
   * So the note answers about the place the line NAMES. Two controls that
   * disagree about one fact are worse than one control, and the owner said as
   * much: fulfilled-from "needs to match up".
   */
  location?: string | null
}): JSX.Element | null {
  const [have, setHave] = useState<ProductAvailability | null>(null)

  useEffect(() => {
    if (!productId) {
      setHave(null)
      return
    }
    let alive = true
    void api.inventory
      .productAvailability(productId)
      .then((a) => {
        if (alive) setHave(a ?? null)
      })
      .catch(() => {
        // A read that failed must not stop somebody writing a sales order. No
        // note is the same outcome as enough on the shelf, which is what almost
        // every line sees anyway.
        if (alive) setHave(null)
      })
    return () => {
      alive = false
    }
  }, [productId])

  if (!productId || !have) return null

  /**
   * A LINE THAT NAMES ITS SHELF IS ASKED ABOUT THAT SHELF.
   *
   * The general note — here versus away — is for a line that has not chosen,
   * which is the ordinary case: it inherits the order's location and somebody
   * wants to know whether the building can cover it. Once a line points
   * somewhere specific, "here" stops being the question. What matters is
   * whether THAT place has enough, and the note has to be silent when it does
   * or it is arguing with the dropdown beside it.
   */
  const named = String(location ?? '').trim()
  const namedPlace = named
    ? placesWorthNaming(have).find((p) => p.location.toLowerCase() === named.toLowerCase())
    : undefined
  if (named && !isHomeShelf(named)) {
    const want = Number(quantity) || 0
    const at = namedPlace?.quantity ?? 0
    if (want <= 0 || at >= want) return null
    return (
      <div className="so-onhand is-short">
        <Icon name="AlertTriangle" size={12} />
        <span>
          {at === 0 ? 'None' : <b>{at}</b>} at {named} — <b>{want - at}</b> short of {want}.
        </span>
      </div>
    )
  }

  const note = availabilityNote(have, quantity)
  if (!note) return null

  const places = placesWorthNaming(have)
  return (
    <div className={`so-onhand${note.kind === 'short' ? ' is-short' : ''}`}>
      <Icon name={note.kind === 'short' ? 'AlertTriangle' : 'Package'} size={12} />
      <span>
        {note.kind === 'away' ? (
          <>
            Only <b>{unitsHere(have)}</b> here — the rest {note.away === 1 ? 'is' : 'are'} at{' '}
            {places
              .filter((p) => !p.here)
              .map((p) => `${p.quantity} at ${p.location}`)
              .join(', ')}
            .
          </>
        ) : (
          <>
            You have <b>{unitsHere(have) + note.away}</b> in total
            {note.away > 0 ? ` (${unitsHere(have)} here, ${note.away} away)` : ''} —{' '}
            <b>{note.short}</b> short of {quantity}.
          </>
        )}
      </span>
    </div>
  )
}
