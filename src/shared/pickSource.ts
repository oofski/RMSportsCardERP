/**
 * TAKING ONE LINE'S UNITS OFF SEVERAL SHELVES AT ONCE.
 *
 * The owner, looking at the picker with three shelves each holding one: "I want
 * to be able to add each of these here to sum to 3."
 *
 * ## What the picker used to be
 *
 * A single choice. Tick one shelf, and the number beside each was how many that
 * shelf HELD — information, not a quantity you could set. Asking for three when
 * the chosen shelf had one produced a warning that the order would be two short,
 * and the two units sitting on the other two shelves could not be reached
 * without adding the product twice more and routing each afterwards.
 *
 * That is the whole gap. Five cases across two roadshows and the home shelf is
 * an ordinary week here, and it was the one thing the control could not say.
 *
 * ## The number beside a shelf changes meaning, and that is the change
 *
 * It stops being "what is here" and becomes "how many I am taking from here".
 * What is here is still shown, beside it, because that is what makes the choice
 * possible — but it is no longer the figure being edited.
 *
 * ## THE DEFAULT IS THE OLD BEHAVIOUR, EXACTLY
 *
 * Everything at the order's own shelf, which is what one implicit slice has
 * always meant. Somebody who presses Add without reading gets precisely what
 * they got before this existed — see `defaultAllocation` and the `''` location
 * that `toLineChoice` emits for it, which is the inheritance form a line has
 * always stored rather than a copy of the shelf name.
 *
 * ## Short is SAID, never refused
 *
 * A shelf allocated more than it holds is warned about and allowed, because the
 * case is in transit, the shop is holding one, the count is a day old — and
 * `applyInvoiceStock` already draws what it can and leaves the rest owed. That
 * rule is inherited from the picker this replaces and is not being revisited.
 *
 * The one thing that IS refused is rows that do not add up to the quantity being
 * sold, because that is not a judgement about stock — it is a line that would
 * put a different number of units on the document than on the shelves.
 */

/** Some of a line's units, coming off one shelf. */
export interface ShelfSlice {
  /** The shelf name as inventory knows it. Never blank here — see toLineChoice. */
  location: string
  /** How many to take from it. Zero is allowed while editing, never on the way out. */
  quantity: number
}

/** A shelf that could be picked, and what it is holding. */
export interface ShelfOption {
  location: string
  /** Units on hand. Zero is a real answer and the row is still offered. */
  onHand: number
}

const n = (v: unknown): number => {
  const x = Math.round(Number(v))
  return Number.isFinite(x) && x > 0 ? x : 0
}

const same = (a: string, b: string): boolean =>
  (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

/**
 * The whole quantity at the order's own shelf.
 *
 * The back-compat state, and the state the picker opens in. It deliberately
 * ignores what that shelf is holding: the old control defaulted here whether or
 * not there was any, said so in a warning, and let it through. Defaulting to
 * "wherever there happens to be stock" would be a different and more surprising
 * app — it would quietly source from a roadshow nobody mentioned.
 */
export function defaultAllocation(quantity: number, defaultLocation: string): ShelfSlice[] {
  return [{ location: defaultLocation, quantity: Math.max(1, n(quantity)) }]
}

/** What the rows currently add up to. */
export function allocationTotal(slices: readonly ShelfSlice[]): number {
  let total = 0
  for (const s of slices) total += n(s.quantity)
  return total
}

/**
 * Why these rows cannot be added, or null when they can.
 *
 * ONLY the arithmetic. Not whether a shelf has enough — that is a warning, and
 * conflating the two would either refuse an ordinary sale of stock in transit or
 * let through a line whose units do not add up.
 *
 * NOT `allocationProblem` in @shared/invoiceAllocations, and deliberately not
 * named like it. That one validates rows about to be STORED and rightly refuses
 * a single row covering the whole line — "one split of a line is just the line".
 * Here a single row is the ordinary state, because everything at one shelf is
 * what the picker opens in. Two questions, two names.
 */
export function shelfSumProblem(
  slices: readonly ShelfSlice[],
  quantity: number
): string | null {
  const want = Math.max(1, n(quantity))
  const got = allocationTotal(slices)
  if (got === want) return null
  if (got < want) {
    const missing = want - got
    return `${missing} of the ${want} ${want === 1 ? 'unit is' : 'units are'} not on a shelf yet.`
  }
  return `That is ${got - want} more than the ${want} being sold.`
}

/**
 * Shelves asked for more than they hold, loudest first.
 *
 * A warning, not a refusal. Named per shelf rather than as one total because
 * "two short" across three shelves does not tell somebody which one to chase,
 * and chasing the wrong shop is the cost of saying it the vague way.
 */
export function shelfShortfalls(
  slices: readonly ShelfSlice[],
  options: readonly ShelfOption[]
): Array<{ location: string; want: number; have: number; short: number }> {
  const out: Array<{ location: string; want: number; have: number; short: number }> = []
  for (const s of slices) {
    const want = n(s.quantity)
    if (want <= 0) continue
    const have = options.find((o) => same(o.location, s.location))?.onHand ?? 0
    if (want > have) out.push({ location: s.location, want, have, short: want - have })
  }
  return out.sort((a, b) => b.short - a.short || a.location.localeCompare(b.location))
}

/**
 * The rows as the line should store them.
 *
 * Two things happen here and both are about not writing something the old path
 * would not have written:
 *
 *   · EMPTY ROWS ARE DROPPED. A zero is a row somebody cleared while deciding,
 *     not a claim about a shelf, and storing it would put a slice on the line
 *     that draws nothing and reads on every later screen as a real choice.
 *   · ONE ROW AT THE ORDER'S OWN SHELF BECOMES NO SPLIT AT ALL, with the blank
 *     location a line has always used to mean "wherever the order points". That
 *     is what keeps an ordinary single-shelf add byte-identical to what it was,
 *     including following the order if its location is changed later.
 */
export function toLineChoice(
  slices: readonly ShelfSlice[],
  quantity: number,
  defaultLocation: string
): { quantity: number; location: string; allocations: ShelfSlice[] } {
  const want = Math.max(1, n(quantity))
  const real = slices.filter((s) => n(s.quantity) > 0 && (s.location || '').trim() !== '')
  const single = real.length === 1 ? real[0] : null
  if (single && same(single.location, defaultLocation)) {
    return { quantity: want, location: '', allocations: [] }
  }
  if (single) {
    return { quantity: want, location: single.location, allocations: [] }
  }
  return {
    quantity: want,
    // A split line's own column describes its FIRST slice, which is the
    // convention the routing path already stores and the receipts already read.
    location: same(real[0]?.location ?? '', defaultLocation) ? '' : (real[0]?.location ?? ''),
    allocations: real.map((s) => ({ location: s.location, quantity: n(s.quantity) }))
  }
}

/**
 * Put the remaining units on this shelf, capped at what it holds.
 *
 * The one-click path to the owner's case: three shelves holding one each, press
 * each in turn and the line is 1 + 1 + 1 without typing a digit. Capping at the
 * shelf's own count is what makes it useful rather than merely fast — filling a
 * shelf past what it has is possible by typing, and should not be what a
 * convenience button does on its own.
 */
export function fillFromShelf(
  slices: readonly ShelfSlice[],
  option: ShelfOption,
  quantity: number
): ShelfSlice[] {
  const want = Math.max(1, n(quantity))
  const others = slices.filter((s) => !same(s.location, option.location))
  const remaining = Math.max(0, want - allocationTotal(others))
  const take = Math.min(remaining, Math.max(0, n(option.onHand)))
  const next = others.map((s) => ({ location: s.location, quantity: n(s.quantity) }))
  if (take > 0) next.push({ location: option.location, quantity: take })
  return next
}

/** The quantity currently on one shelf, for rendering a row. */
export function quantityAt(slices: readonly ShelfSlice[], location: string): number {
  return n(slices.find((s) => same(s.location, location))?.quantity)
}

/** Set one shelf's quantity, adding or removing the row as needed. */
export function setShelfQuantity(
  slices: readonly ShelfSlice[],
  location: string,
  quantity: number
): ShelfSlice[] {
  const q = n(quantity)
  const others = slices
    .filter((s) => !same(s.location, location))
    .map((s) => ({ location: s.location, quantity: n(s.quantity) }))
  return q > 0 ? [...others, { location, quantity: q }] : others
}
