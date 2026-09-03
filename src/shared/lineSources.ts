/**
 * WHERE THE UNITS ON A SOLD LINE ACTUALLY CAME FROM.
 *
 * The owner's ask: "in sales orders I can hover over units and see where they
 * are coming from in terms of inventory". The information already existed and
 * was unreachable — a sale records which cost layers it consumed
 * (`inventory_txn_lots`), and a layer records which purchase order receipt
 * opened it (`po_line_receipts`), so every unit on a sales order can be traced
 * back to the order that bought it. Nothing ever showed that chain.
 *
 * ## Why it is worth showing
 *
 * A line that says "3 cases" is one number covering up to three different
 * facts: three cases off one purchase order at one price, or one case from each
 * of three orders bought months apart at three different prices. Those look
 * identical on the document and are completely different when somebody asks
 * "what did we make on this" or "which of these was the case with the problem".
 *
 * It also settles the question this app kept being asked in another form.
 * Invoice 2392 carries the same product on two separate lines — which reads as
 * a duplicate until you can see that the two lines drew different purchase
 * orders, at which point it reads as exactly what it is.
 *
 * ## The rules
 *
 *   - A LAYER WITH NO PURCHASE ORDER IS NOT A BUG. Stock counted in by hand, or
 *     carried over from before the purchase orders existed, has a real cost and
 *     no order behind it. It is named as such rather than hidden, because a
 *     total that silently omits some units is worse than one that admits it.
 *
 *   - PICKED IS WORTH SAYING. When an operator chose the shelf themselves the
 *     allocation is a decision; when FIFO ran unasked it is a default. Somebody
 *     checking a margin wants to know which.
 *
 *   - A DROPSHIPPED LINE HAS NO SOURCES AND THAT IS CORRECT. It never touched a
 *     shelf. Saying "nothing came off the shelf" out loud beats an empty box
 *     that looks like a failed load.
 */

/** One cost layer a sold line drew from. */
export interface SoldSource {
  /** The purchase order that bought these units, when one did. */
  poNumber: string | null
  poId: string | null
  supplier: string | null
  /** The shelf they left. */
  location: string
  quantity: number
  /** What each of these units cost. */
  unitCost: number
  /** When the layer was opened — how old this stock is. */
  receivedAt: string | null
  /** Did somebody choose this shelf, or did FIFO take it? */
  picked: boolean
}

export interface LineSources {
  /** The line's position on the order — how a screen matches it up. */
  position: number
  sources: SoldSource[]
}

const money = (n: number): string =>
  `$${(Math.round(n * 100) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`

/** Units across every layer this line drew. */
export function sourcedUnits(s: LineSources | null | undefined): number {
  if (!s) return 0
  return Math.round(s.sources.reduce((sum, x) => sum + x.quantity, 0) * 1000) / 1000
}

/** What these units cost us in total — the line's COGS. */
export function sourcedCost(s: LineSources | null | undefined): number {
  if (!s) return 0
  return Math.round(s.sources.reduce((sum, x) => sum + x.quantity * x.unitCost, 0) * 100) / 100
}

/** How a single layer is named on screen. */
export function sourceName(s: SoldSource): string {
  if (s.poNumber) return s.poNumber
  if (s.supplier) return s.supplier
  // Deliberately not "Unknown". These units have a real cost and a real shelf;
  // what they lack is a purchase order, and saying THAT is useful where
  // "unknown" would read as data loss.
  return 'No purchase order'
}

/**
 * WHO SOLD US THESE, said alongside the purchase order rather than instead of it.
 *
 * The owner: "can we also show the vendor as well please."
 *
 * The first version treated the two as alternatives — `sourceName` returns the
 * PO number when there is one and falls back to the supplier, and the detail
 * line printed the supplier only when there was no PO. So the commonest case,
 * a layer that came in on a real purchase order, showed the number and hid the
 * name. "PO-0458" answers WHICH ORDER; it does not answer WHO, and on a floor
 * buying from several distributors that is the question actually being asked.
 *
 * Returns null when the name is ALREADY the headline — a hand-counted layer with
 * no purchase order is titled with its vendor by `sourceName`, and printing it
 * again underneath would say one fact twice.
 */
export function sourceVendor(s: SoldSource): string | null {
  const name = (s.supplier ?? '').trim()
  if (!name) return null
  return s.poNumber ? name : null
}

/**
 * The second line of a layer's row: where it sat, whether it was chosen, and who
 * it came from.
 *
 * Assembled here rather than in the renderer so the three parts cannot drift
 * apart, and so the "say it once" rule above is enforced in the place that knows
 * what the headline said.
 */
export function sourceWhere(s: SoldSource): string {
  const parts = [s.location]
  // Said only when it was a decision. FIFO running unasked is the default and
  // does not need announcing on every row.
  if (s.picked) parts.push('picked')

  const vendor = sourceVendor(s)
  if (vendor) parts.push(vendor)
  return parts.filter(Boolean).join(' · ')
}

/**
 * The one line printed above the list.
 *
 * Leads with the count and the cost, because those are what somebody is
 * checking. The empty case gets a sentence rather than a blank, since a blank
 * popover is indistinguishable from one that failed to load.
 */
export function describeLineSources(s: LineSources | null | undefined): string {
  const n = s?.sources.length ?? 0
  if (n === 0) {
    return 'Nothing came off a shelf for this line — it was drop-shipped, or its stock was never booked.'
  }
  const units = sourcedUnits(s)
  const cost = sourcedCost(s)
  const from = n === 1 ? 'one place' : `${n} places`
  return `${units} unit${units === 1 ? '' : 's'} from ${from}, costing ${money(cost)} in total.`
}
