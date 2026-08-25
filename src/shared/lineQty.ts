/**
 * NUDGING A LINE'S QUANTITY UP OR DOWN.
 *
 * ## What this is for
 *
 * Both order screens already let a quantity be changed: the number is a box, and
 * you click into it, select what is there and type something else. That is the
 * right control for "make it 40" and the wrong one for "make it one more", which
 * is the change somebody actually makes standing at a shelf — and it is
 * genuinely fiddly on a phone.
 *
 * So the box keeps its job and gets a − and a + beside it. The arithmetic is one
 * line; what earns a shared home is the FLOOR, because the two documents stop in
 * different places for different reasons and neither screen should be deciding
 * that for itself.
 *
 * ## Where each document stops going down
 *
 * A PURCHASE line stops at what has already been RECEIVED. Four cases were
 * ordered, three are checked in and costed against real FIFO layers; taking the
 * order to two would leave stock on the shelf whose paperwork says it was never
 * bought. The repository refuses it either way — see updatePurchaseOrderLine —
 * and this is what stops the screen offering a button that would be refused.
 *
 * A SALES line stops at ONE. Below one is not a smaller sale, it is no sale, and
 * removing a line is what the bin at the end of the row is for. A minus that
 * silently deletes a row is the kind of control somebody presses once and then
 * never trusts again.
 */

/** How far down a purchase line may go: never below what already landed. */
export function purchaseQtyFloor(line: { qtyReceived?: number | null }): number {
  const received = Number(line?.qtyReceived ?? 0)
  return Math.max(1, Number.isFinite(received) ? Math.ceil(received) : 1)
}

/** How far down a sales line may go. Below one is the bin's job, not a step's. */
export const SALES_QTY_FLOOR = 1

/**
 * The quantity a step lands on, clamped at the floor.
 *
 * Clamped rather than refused, so a press at the boundary is a no-op instead of
 * an error — but callers should be disabling the button (see `canStep`) so the
 * boundary is visible before it is reached rather than after.
 */
export function stepQty(current: number, delta: number, floor: number): number {
  const from = Number.isFinite(current) ? Math.round(current) : floor
  return Math.max(floor, from + Math.round(delta))
}

/**
 * Would this step change anything?
 *
 * What the button's `disabled` reads. A minus greyed out at three, on a line
 * where three have been checked in, is the screen explaining the rule by being
 * shaped like it — which beats a toast saying the same words after the press.
 */
export function canStep(current: number, delta: number, floor: number): boolean {
  return stepQty(current, delta, floor) !== Math.round(current)
}

/**
 * Why the minus is greyed out, for the tooltip.
 *
 * Null when it is not — a title attribute that always says something turns into
 * noise, and the one case worth explaining is the one somebody did not expect.
 */
export function stepDownBlockedReason(
  current: number,
  floor: number,
  received: number
): string | null {
  if (canStep(current, -1, floor)) return null
  if (received > 0 && Math.round(current) <= received) {
    return `${received} already received, so this line cannot go below ${received}.`
  }
  return 'Use the bin to take this line off the order.'
}
