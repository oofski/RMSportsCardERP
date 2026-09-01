/**
 * BRINGING A CASE HOME FROM A SHOP — the move this app did not have.
 *
 * The owner: "sometimes I want to be able to take things that I buy from
 * roadshow and move them out of roadshow inventory and then move it to be with
 * us ... if we edit the PO and then it turns into something that we can put into
 * our inventory."
 *
 * ## Why editing the purchase order cannot do it
 *
 * It was the obvious answer and it is refused, for a good reason. Re-routing a
 * purchase order line is a statement about where units WILL go, and
 * `setPurchaseOrderRouting` turns it down the moment any of them have been
 * checked in — "units re-routed here would have nothing left that could check
 * them in". A roadshow line is checked in the instant it is typed (see
 * takeTabDelivery: buying at the shop IS taking delivery), so a tab line is
 * always already received and the routing door is always already shut.
 *
 * That refusal is right. The case is not "going" anywhere — it is HERE, on a
 * shelf in Kentucky, and somebody has now driven it home. That is a physical
 * event after the fact, not a change of plan, and paperwork that pretended
 * otherwise would leave the receiving desk expecting a delivery that already
 * happened.
 *
 * ## Why two stock adjustments are not it either
 *
 * The refusal's own advice — adjust it down at the shop and up at home — loses
 * the money. Adjusting down CONSUMES the shop's cost layer; adjusting up opens a
 * fresh one valued at what the destination shelf is already carrying. A $400
 * case moved to a shelf averaging $150 becomes a $150 case, permanently, and the
 * $250 turns into profit the next time it sells. Worse for a roadshow: an
 * unpriced case is carried at zero, and the new layer would have no link back to
 * the tab, so pricing the line later would re-cost a layer holding nothing.
 *
 * ## So the LAYER moves, and that is the whole idea
 *
 * A cost layer is not a fact about a shelf; it is a fact about a specific set of
 * units — what they cost, when they arrived, which purchase order bought them.
 * Drive them across the country and every one of those is still true. So the
 * layer travels with the units: same unit cost, same received-at (so it keeps
 * its place in the FIFO queue rather than jumping to the back), same link to the
 * purchase-order line — which is what lets a case bought at no price be brought
 * home and priced afterwards, with both the shelf and any sale drawn from it
 * corrected by the one act.
 *
 * ## What this is NOT
 *
 * Not a sale, not a purchase, not a write-off. Nothing is earned or spent by
 * carrying a box to a different room, so the P&L must not move by a cent — see
 * the ledger rows the store writes, which are a matched pair.
 */

/** One move, as the caller states it. */
export interface StockMoveRequest {
  productId: string
  /** The shelf the units are standing on now. */
  from: string
  /** The shelf they are going to. */
  to: string
  quantity: number
  /** Why, in the operator's words. Optional and kept short. */
  note?: string | null
}

export const MOVE_NOTE_MAX = 160

const whole = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const same = (a: string, b: string): boolean =>
  (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

/**
 * Why this move cannot be made, or null when it can.
 *
 * ## IT REFUSES TO MOVE MORE THAN IS THERE, and that is not the same rule the
 * sales-order picker keeps
 *
 * A sales order is allowed to ask for more than a shelf holds, deliberately: the
 * case is in transit, the count is a day old, and `applyInvoiceStock` draws what
 * it can and leaves the rest owed. That is a promise about the future and it can
 * be settled later.
 *
 * A move is a claim about the PAST — somebody has already put these boxes in a
 * car. Letting it through would either drive a shelf negative or invent a layer
 * at the destination out of nothing, and there is no later event that settles
 * it. So this one is a refusal rather than a warning, and it names the count so
 * the operator can go and look.
 */
export function moveRefusal(
  req: StockMoveRequest,
  onHandAtFrom: number
): string | null {
  const from = String(req?.from ?? '').trim()
  const to = String(req?.to ?? '').trim()
  if (!String(req?.productId ?? '').trim()) return 'No product chosen.'
  if (!from) return 'Say where these are coming from.'
  if (!to) return 'Say where these are going.'
  if (same(from, to)) {
    return 'Those are the same shelf — nothing would move.'
  }
  const qty = whole(req?.quantity)
  if (!(qty > 0)) return 'How many are you moving?'
  const have = whole(onHandAtFrom)
  if (qty > have) {
    return have <= 0
      ? `There is nothing at ${from} to move.`
      : `${from} is only holding ${have}, so ${qty} cannot leave it.`
  }
  return null
}

/**
 * What the ledger and the new layer say about where these came from.
 *
 * One sentence, written once, so the row at the old shelf and the row at the new
 * one cannot describe the move differently — which is exactly the sort of thing
 * that makes a stock history unreadable a month later.
 */
export function moveNote(from: string, to: string, note?: string | null): string {
  const said = String(note ?? '').trim().slice(0, MOVE_NOTE_MAX)
  const base = `Moved ${String(from).trim()} → ${String(to).trim()}`
  return said ? `${base} — ${said}` : base
}
