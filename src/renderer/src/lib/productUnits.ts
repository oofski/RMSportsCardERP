import type { InventoryProduct, UnitType } from '@shared/types'
import type { StreamItem } from '@shared/streaming'
import type { CaseBreakdown, ProductUnits, StockUnit } from '@shared/units'
import { caseBreakdown } from '@shared/units'

/**
 * The renderer's bridge from a catalog product to the unit contract.
 *
 * @shared/units is the only place a case/box/pack conversion may be written, and
 * every screen here calls into it. What that contract cannot decide is what to
 * make of a product the catalog holds but the contract has no unit for — so that
 * judgement lives here, once, instead of being re-made in each form.
 */

/**
 * The stock unit for a product, or null when the contract does not model it.
 *
 * `UnitType` has five members; `StockUnit` has two. Packs, singles and "other"
 * are real catalog rows (loose singles, sealed oddments) with no case/box
 * structure to convert through, so they get null and the caller falls back to
 * entering a plain unit count. Coercing them to 'box' would put a
 * cases-and-boxes form over a product measured in single cards and hand the
 * contract a divisor that means nothing.
 *
 * Main draws the same line in `stockUnitOf` in db/inventory.ts, and refuses a
 * case/box/pack entry for anything outside it.
 */
export function stockUnitOf(unitType: UnitType): StockUnit | null {
  return unitType === 'case' || unitType === 'box' ? unitType : null
}

/**
 * Everything the contract needs to convert for this product, or null when the
 * product is not stocked in cases or boxes.
 */
export function productUnits(
  product: Pick<InventoryProduct, 'unitType' | 'boxesPerCase' | 'packsPerBox' | 'giveawayItem'>
): ProductUnits | null {
  const unitType = stockUnitOf(product.unitType)
  if (!unitType) return null
  return {
    unitType,
    boxesPerCase: product.boxesPerCase,
    packsPerBox: product.packsPerBox,
    // A packaged main that predates the flag sends nothing here, and "absent"
    // has to read as "not a giveaway item": that keeps the product on the
    // whole-number path. Defaulting the other way would open the fractional
    // path on the entire catalog.
    giveawayItem: product.giveawayItem === true
  }
}

/**
 * A stock count as a person would write it: 2, or 2.25, never 2.2500000001.
 *
 * Fractional stock is real on giveaway items and arrives as a float sum, so the
 * trailing binary dust has to be cut somewhere. Four places matches the
 * contract's own rounding, and trailing zeros are dropped so whole numbers keep
 * reading as whole numbers.
 */
export function formatUnitCount(quantity: number): string {
  if (!Number.isFinite(quantity)) return '0'
  return String(Math.round(quantity * 10000) / 10000)
}

/**
 * The same count, but read as cases and boxes when the product has been broken
 * into.
 *
 * `formatUnitCount` on its own prints 3.9167, which is the truth and not an
 * answer: what the operator is asking is how many sealed cases are on the shelf
 * and how many boxes are left in the open one. Every screen that shows a
 * balance for a KNOWN product should use this; the plain formatter stays for the
 * places that have a number and no product to interpret it with.
 *
 * Falls through to the plain number whenever the split would be invented — see
 * caseBreakdown, which refuses a box-stocked product, a missing divisor, and a
 * balance that is not a whole number of boxes.
 */
export function formatStockOnHand(
  units: ProductUnits | null,
  quantity: number
): string {
  if (!Number.isFinite(quantity)) return '0'
  if (!units) return formatUnitCount(quantity)
  const split = caseBreakdown(units, quantity)
  if (!split || !split.open) return formatUnitCount(quantity)
  const boxes = `${split.looseBoxes} box${split.looseBoxes === 1 ? '' : 'es'}`
  return split.fullCases > 0 ? `${split.fullCases} + ${boxes}` : boxes
}

/**
 * Is one of this product's cases open on the shelf?
 *
 * Drives the marker beside a count. A cracked case is worth calling out because
 * it is the one holding that cannot be read off the number of cases — and
 * because it is the thing somebody is looking for when they ask what is left to
 * break tonight.
 */
export function hasOpenCase(units: ProductUnits | null, quantity: number): boolean {
  return stockBreakdown(units, quantity)?.open === true
}

/**
 * `caseBreakdown` for a product the renderer may not have units for.
 *
 * `productUnits` returns null for a single, a pack or an "other" — rows with no
 * case/box structure at all — so every caller here would otherwise repeat the
 * same null check, or invent a placeholder ProductUnits to get past the type,
 * which is how a divisor that means nothing reaches the contract.
 */
export function stockBreakdown(
  units: ProductUnits | null,
  quantity: number
): CaseBreakdown | null {
  if (!units) return null
  return caseBreakdown(units, quantity)
}

/** "case" / "cases" — the noun for a product's own stock unit. */
export function stockUnitWord(unitType: StockUnit, count = 1): string {
  if (count === 1) return unitType === 'case' ? 'case' : 'box'
  return unitType === 'case' ? 'cases' : 'boxes'
}

/**
 * How a stream line was TYPED, e.g. "2 cases + 3 boxes", or null when it was
 * entered directly in stock units.
 *
 * The converted quantity cannot reconstruct this. A break of 2 cases + 3 boxes
 * on a box-stocked product is stored as 27 boxes, and 27 boxes is equally "0
 * cases + 27 boxes" — so the entry is kept on the line, and a line that has none
 * (every line recorded before this shipped) gets null rather than an invented
 * split.
 */
export function typedEntryLabel(
  line: Pick<StreamItem, 'enteredCases' | 'enteredBoxes' | 'enteredPacks'>
): string | null {
  const parts: string[] = []
  const push = (n: number | null, one: string, many: string): void => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return
    parts.push(`${n} ${n === 1 ? one : many}`)
  }
  push(line.enteredCases, 'case', 'cases')
  push(line.enteredBoxes, 'box', 'boxes')
  push(line.enteredPacks, 'pack', 'packs')
  return parts.length > 0 ? parts.join(' + ') : null
}
