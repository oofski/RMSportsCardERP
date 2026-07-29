/**
 * Cases, boxes and packs — the unit model.
 *
 * RM buys cases, breaks boxes, and gives away packs. Three units, and the
 * conversion between them is per-product: an 8-box case and a 12-box case are
 * both "a case", and a box holds a different number of packs in every product
 * line. So nothing here is a constant — every conversion needs the product.
 *
 * WHAT ONE UNIT OF STOCK MEANS VARIES PER PRODUCT.
 *
 * `unitType` decides. A product stocked as 'case' counts cases on hand; one
 * stocked as 'box' counts boxes. Getting this wrong is an order-of-magnitude
 * error in inventory value, not a rounding difference, so every conversion here
 * takes the unit explicitly and refuses rather than assuming a default.
 */

export type StockUnit = 'case' | 'box'

/** Everything needed to convert between units for one product. */
export interface ProductUnits {
  unitType: StockUnit
  /** Boxes in one case. Null when unknown — conversions then refuse. */
  boxesPerCase: number | null
  /** Packs in one box. Null when unknown. */
  packsPerBox: number | null
  /**
   * Whether this product may be held in fractional units.
   *
   * Only ever true for products deliberately stocked as giveaway material. A
   * giveaway of three packs out of a twelve-pack box leaves a quarter of a box
   * on the shelf, which is real — but allowing that everywhere would let
   * rounding dust accumulate across the whole catalog and quietly corrupt the
   * cost basis of stock nobody is giving away. So the fractional path is opt-in
   * per product, and every other product stays a whole number.
   */
  giveawayItem: boolean
}

export interface ConversionResult {
  /** Quantity expressed in the product's own stock unit. */
  quantity: number
  /** True when the result is not a whole number. */
  fractional: boolean
}

export type Conversion = { ok: true; value: ConversionResult } | { ok: false; error: string }

const round4 = (n: number): number => Math.round(n * 10000) / 10000

/**
 * A break entered as CASES + BOXES, converted to the product's stock unit.
 *
 * Breaking is a box-level activity, so the operator thinks in "two cases and
 * three boxes". What that costs depends on how the product is stocked.
 */
export function breakToStock(units: ProductUnits, cases: number, boxes: number): Conversion {
  if (cases < 0 || boxes < 0) return { ok: false, error: 'Enter a quantity of zero or more.' }
  if (cases === 0 && boxes === 0) return { ok: false, error: 'Enter at least one case or box.' }

  if (units.unitType === 'case') {
    // Stock counts cases, so loose boxes are a fraction of one.
    if (boxes > 0) {
      if (!units.boxesPerCase) {
        return {
          ok: false,
          error: 'This product is stocked in cases and has no boxes-per-case set, so loose boxes cannot be converted. Set boxes per case in Inventory.'
        }
      }
      const q = round4(cases + boxes / units.boxesPerCase)
      const fractional = q !== Math.round(q)
      if (fractional && !units.giveawayItem) {
        return {
          ok: false,
          error: `${boxes} loose box(es) is a part-case, and this product is not stocked for fractional quantities. Enter whole cases, or mark it as a giveaway item in Inventory.`
        }
      }
      return { ok: true, value: { quantity: q, fractional } }
    }
    return { ok: true, value: { quantity: cases, fractional: false } }
  }

  // Stock counts boxes.
  if (cases > 0 && !units.boxesPerCase) {
    return {
      ok: false,
      error: 'No boxes-per-case set for this product, so cases cannot be converted to boxes. Set it in Inventory.'
    }
  }
  const q = cases * (units.boxesPerCase ?? 0) + boxes
  return { ok: true, value: { quantity: q, fractional: false } }
}

/**
 * A giveaway entered as BOXES + PACKS, converted to the product's stock unit.
 *
 * Packs are almost always a fraction of a stock unit, which is exactly why the
 * fractional path exists and why it is gated on `giveawayItem`.
 */
export function giveawayToStock(units: ProductUnits, boxes: number, packs: number): Conversion {
  if (boxes < 0 || packs < 0) return { ok: false, error: 'Enter a quantity of zero or more.' }
  if (boxes === 0 && packs === 0) return { ok: false, error: 'Enter at least one box or pack.' }

  if (packs > 0 && !units.packsPerBox) {
    return {
      ok: false,
      error: 'No packs-per-box set for this product, so packs cannot be valued. Set packs per box in Inventory.'
    }
  }

  // First express the whole thing in boxes.
  const inBoxes = boxes + (packs > 0 ? packs / (units.packsPerBox as number) : 0)

  let q: number
  if (units.unitType === 'box') {
    q = round4(inBoxes)
  } else {
    if (!units.boxesPerCase) {
      return {
        ok: false,
        error: 'This product is stocked in cases and has no boxes-per-case set. Set it in Inventory.'
      }
    }
    q = round4(inBoxes / units.boxesPerCase)
  }

  const fractional = q !== Math.round(q)
  if (fractional && !units.giveawayItem) {
    return {
      ok: false,
      error: 'That is a part-unit, and this product is not stocked for fractional quantities. Mark it as a giveaway item in Inventory to allow partial boxes and packs.'
    }
  }
  return { ok: true, value: { quantity: q, fractional } }
}

/**
 * What one pack cost, from the cost of one stock unit.
 *
 * This is the number that values a giveaway as a loss: the cost of a case,
 * divided down through boxes to packs. Deliberately returns null rather than a
 * guess when a divisor is missing — a giveaway silently valued at zero would
 * understate the loss and look like a working feature.
 */
export function packCost(units: ProductUnits, unitCost: number): number | null {
  if (!Number.isFinite(unitCost) || unitCost <= 0) return null
  if (!units.packsPerBox) return null
  const perBox =
    units.unitType === 'case'
      ? units.boxesPerCase
        ? unitCost / units.boxesPerCase
        : null
      : unitCost
  if (perBox === null) return null
  return Math.round((perBox / units.packsPerBox) * 100) / 100
}

/** What one box cost, from the cost of one stock unit. */
export function boxCost(units: ProductUnits, unitCost: number): number | null {
  if (!Number.isFinite(unitCost) || unitCost <= 0) return null
  if (units.unitType === 'box') return Math.round(unitCost * 100) / 100
  if (!units.boxesPerCase) return null
  return Math.round((unitCost / units.boxesPerCase) * 100) / 100
}

/**
 * Read a box count out of a product name: "…Hobby 8-Box Case" → 8.
 *
 * Used once, to backfill `boxes_per_case` for a catalog where the number has
 * always been in the name and never in the field. Only matches the explicit
 * "N-Box" form — anything vaguer is left null for a human, because a wrong
 * divisor here silently distorts every break cost and giveaway valuation.
 */
export function boxesPerCaseFromName(name: string): number | null {
  const m = /(\d+)\s*-?\s*box\b/i.exec(name || '')
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null
}

/** Human summary of a quantity in the product's own unit. */
export function describeQuantity(units: ProductUnits, quantity: number): string {
  const unit = units.unitType === 'case' ? 'case' : 'box'
  const whole = Math.floor(quantity)
  const frac = round4(quantity - whole)
  if (frac === 0) return `${whole} ${unit}${whole === 1 ? '' : 's'}`
  return `${round4(quantity)} ${unit}s`
}
