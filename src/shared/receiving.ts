/**
 * How much of a purchase order has actually landed.
 *
 * A PO is one document, but a delivery is not. Nine items and thirty-eight
 * units go on the order; twenty-three units turn up on Tuesday and the rest on
 * Friday, or the rest never turn up at all. The receiving side already handled
 * that correctly — `receivePoLine` adds to `qty_received` and only stamps a
 * line received when it reaches the ordered quantity — but nothing on any
 * screen SAID so, which left the operator with a PO that looked untouched and
 * no way to tell a half-arrived shipment from one still on a truck.
 *
 * So the arithmetic lives here, once, and the board, the receipt and the
 * Incoming Inventory panel all read from it. Three screens computing "61%"
 * three ways is how they end up disagreeing on the same PO.
 */

export type ReceiveState =
  /** Nothing has arrived. */
  | 'none'
  /** Some has. This is the state that had nowhere to be shown. */
  | 'partial'
  /** Everything ordered is in. */
  | 'complete'
  /**
   * More came in than was ordered.
   *
   * `receivePoLine` clamps every receipt to what is outstanding, so this cannot
   * be reached by scanning. It is here for data that arrived some other way — a
   * hand-edited row, a restored snapshot — because the alternative is a screen
   * printing 110% or, worse, silently clamping it to "complete" and hiding a
   * discrepancy somebody needs to go and look at.
   */
  | 'over'

export interface ReceiveProgress {
  ordered: number
  received: number
  /** ordered − received, floored at 0. */
  outstanding: number
  /** How many MORE than ordered arrived. 0 in every ordinary case. */
  excess: number
  /** 0..1, clamped. For a bar's width. */
  fraction: number
  /** 0..100, for print. See the rounding rule below. */
  percent: number
  state: ReceiveState
}

/**
 * The rounding rule, which is the only subtle thing in this file.
 *
 * A percentage is rounded for display, and rounding lies exactly where it
 * matters most. 379 units of 380 is 99.7%, which rounds to 100 — and a PO
 * reading "100%" with a unit still outstanding is the reading that closes a
 * shipment somebody is still waiting on. One unit of 380 is 0.26%, which rounds
 * to 0 — and "0%" on a delivery that has started arriving is the reading that
 * sends somebody looking for a truck that is already unloaded.
 *
 * So a PARTIAL delivery is pinned inside 1..99. 0 and 100 are reserved for the
 * two states that really are none and all, and they can only be reached by the
 * counts actually being equal.
 */
export function receiveProgress(orderedRaw: number, receivedRaw: number): ReceiveProgress {
  // Negatives and fractions are not real quantities; treat them as the nearest
  // thing that is rather than propagating NaN into a style width.
  const ordered = Math.max(0, Math.round(Number.isFinite(orderedRaw) ? orderedRaw : 0))
  const received = Math.max(0, Math.round(Number.isFinite(receivedRaw) ? receivedRaw : 0))
  const outstanding = Math.max(0, ordered - received)
  const excess = Math.max(0, received - ordered)

  const state: ReceiveState =
    ordered === 0
      ? received > 0
        ? 'over'
        : 'none'
      : received === 0
        ? 'none'
        : received > ordered
          ? 'over'
          : received === ordered
            ? 'complete'
            : 'partial'

  const fraction = ordered === 0 ? (received > 0 ? 1 : 0) : Math.min(1, received / ordered)
  const percent =
    state === 'partial' ? Math.min(99, Math.max(1, Math.round(fraction * 100))) : Math.round(fraction * 100)

  return { ordered, received, outstanding, excess, fraction, percent, state }
}

/** Add up a set of lines — the PO-level figure on the board and the receipt. */
export function receiveProgressOf(
  lines: Array<{ quantity: number; qtyReceived: number }>
): ReceiveProgress {
  let ordered = 0
  let received = 0
  for (const l of lines) {
    ordered += Math.max(0, Math.round(l.quantity || 0))
    received += Math.max(0, Math.round(l.qtyReceived || 0))
  }
  return receiveProgress(ordered, received)
}

/**
 * "23 of 38 units · 61%" — the one-line answer to "where is this order".
 *
 * The raw counts lead and the percentage trails, because the number somebody
 * acts on is "15 units still to come", not "61%". The percentage is there to be
 * glanced at across a room.
 */
export function receiveSummary(p: ReceiveProgress): string {
  const unit = p.ordered === 1 ? 'unit' : 'units'
  switch (p.state) {
    case 'none':
      return p.ordered === 0 ? 'Nothing ordered' : `None of ${p.ordered} ${unit} received`
    case 'complete':
      return `All ${p.ordered} ${unit} received`
    case 'over':
      return `${p.received} of ${p.ordered} ${unit} received — ${p.excess} more than ordered`
    default:
      return `${p.received} of ${p.ordered} ${unit} · ${p.percent}%`
  }
}

/** The short form for a card, where there is room for a count and nothing else. */
export function receiveShort(p: ReceiveProgress): string {
  return `${p.received}/${p.ordered}`
}

/**
 * The tone a screen paints this in.
 *
 * Green ONLY at complete. A part-received PO in green is the mistake this whole
 * file exists to prevent — it reads as finished to anybody not counting the
 * units — so partial gets its own warning tone, and over-receipt gets the
 * danger one because it is a discrepancy, not progress.
 */
export function receiveTone(p: ReceiveProgress): 'idle' | 'partial' | 'done' | 'over' {
  switch (p.state) {
    case 'complete':
      return 'done'
    case 'partial':
      return 'partial'
    case 'over':
      return 'over'
    default:
      return 'idle'
  }
}
