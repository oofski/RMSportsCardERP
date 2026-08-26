/**
 * SELLING THE CASES THAT CAME OFF ONE PARTICULAR PURCHASE ORDER.
 *
 * The owner's words: "let's say I buy ten cases of tribute baseball from a
 * roadshow, and then I sell five cases to another person. I would be able to
 * just select the cases when I'm selecting the cases in the inventory UI — I
 * would be able to sell those in the sales order using the roadshow cases."
 *
 * ## Why "which order did these come from" is not already answerable at a sale
 *
 * A sale takes stock the way every other consumption does: oldest layer first.
 * That is right almost always — the shelf holds one kind of case and the FIFO
 * walk is what keeps the cost basis honest without anybody choosing.
 *
 * It is wrong for a roadshow. That order stays open for a week, buying and
 * selling against itself the whole time, and the question being asked of it is
 * "what did we make on this week with this shop". Answer that with FIFO and the
 * five cases sold on Wednesday are costed against whatever happened to be
 * oldest on the shelf — a distributor's case bought in March, at a completely
 * different price — while the roadshow's own ten sit there untouched. The
 * order's margin is then a number about somebody else's stock.
 *
 * So a sales order line may NAME the order its units come out of, and the
 * consumption follows the name.
 *
 * ## What is offered, and what is deliberately not
 *
 * ONLY AN OPEN ROADSHOW ORDER. Every purchase order on the board has cost
 * layers on the shelf somewhere, and offering all of them would put a chooser on
 * every line of every sales order in the app to serve a case that arises on one
 * kind of order. A settled order is not offered either: its week is closed and
 * its bill is paid, and a sale attributed to it afterwards would move a figure
 * somebody has already reconciled.
 *
 * An ordinary line names nothing and walks FIFO, exactly as it always has.
 */

export { isRoadshowLocation } from './inventory'

/**
 * A purchase order that still has some of this product on the shelf.
 *
 * `unitsOnHand` is what is LEFT of that order's layers at the shelf being sold
 * from — not what the order bought. Ten cases bought and six already sold is a
 * four, and offering ten would be offering stock that is gone.
 */
export interface SupplyingOrder {
  poId: string
  poNumber: string
  supplier: string | null
  /** The shelf these units are sitting on. A sale takes from one shelf. */
  location: string
  /** How many are still there, out of the layers this order opened. */
  unitsOnHand: number
  /** Non-null while the order is still running. See @shared/roadshowTab. */
  tabOpenedAt: string | null
  tabClosedAt: string | null
}

/** How it reads in the chooser: "PO-0042 · Roadshow Dallas · 4 left". */
export function supplyingOrderLabel(o: SupplyingOrder): string {
  const who = (o.supplier ?? '').trim()
  return `${o.poNumber}${who ? ` · ${who}` : ''} · ${o.unitsOnHand} left`
}

/**
 * Why this line cannot come out of that order — null when it can.
 *
 * ## Refused rather than topped up from elsewhere
 *
 * A line for six against an order holding four could be served by taking the
 * four and letting FIFO find two more. That is the tempting behaviour and it is
 * the wrong one: the operator said "these six are the roadshow's", the document
 * would say so, and two of them would be costed against a case from a different
 * purchase entirely — silently, with nothing on any screen to say a substitution
 * happened. A refusal that names both numbers is a worse moment and a better
 * outcome.
 *
 * The caller may still sell six by clearing the choice, which takes all six
 * FIFO and claims nothing about where they came from.
 */
export function supplyRefusal(
  order: SupplyingOrder | null | undefined,
  quantity: number,
  productName?: string
): string | null {
  if (!order) return null
  const want = Number(quantity) || 0
  if (want <= 0) return null
  const have = Number(order.unitsOnHand) || 0
  if (have <= 0) {
    return (
      `${order.poNumber} has none of ${productName || 'that'} left on the ${order.location} shelf. ` +
      'Pick another order, or sell it from ordinary stock.'
    )
  }
  if (want > have) {
    return (
      `${order.poNumber} has ${have} of ${productName || 'that'} left, not ${want}. ` +
      'Lower the quantity, or sell it from ordinary stock — a line cannot be part one order and ' +
      'part another.'
    )
  }
  return null
}

/**
 * The orders worth offering for one line, best first.
 *
 * Ordered by units on hand DESCENDING rather than by date, because the question
 * at this control is "can this order cover what I am selling" and the one that
 * can is the one to show first. Anything holding nothing is dropped: a row
 * reading "0 left" is a row whose only outcome is a refusal.
 */
export function offerableOrders(orders: readonly SupplyingOrder[]): SupplyingOrder[] {
  return orders
    .filter((o) => (Number(o.unitsOnHand) || 0) > 0 && !!o.tabOpenedAt && !o.tabClosedAt)
    .sort((a, b) => b.unitsOnHand - a.unitsOnHand || a.poNumber.localeCompare(b.poNumber))
}

/**
 * The one order every line of a sale points at, when they agree — else null.
 *
 * A sales order is LINKED to a purchase order as a whole (`invoices.source_po_id`),
 * because that is the relationship the board, the deal ticket and the dropship
 * pair all read. Lines can in principle name different orders, and when they do
 * this yields null rather than picking one: naming one of three on the document
 * reads as the answer, and it would put a sale on a purchase order that supplied
 * a third of it.
 *
 * Lines naming NOTHING are ignored rather than counted as disagreement — a sale
 * of five roadshow cases plus a T-shirt off the ordinary shelf is still that
 * roadshow's sale.
 */
export function soleSourceOrder(lines: readonly { sourcePoId?: string | null }[]): string | null {
  let found: string | null = null
  for (const l of lines) {
    const id = (l.sourcePoId ?? '').trim()
    if (!id) continue
    if (found && found !== id) return null
    found = id
  }
  return found
}
