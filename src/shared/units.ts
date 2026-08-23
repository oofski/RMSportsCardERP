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

/**
 * How close to a whole number still counts as whole. Matches the tolerance the
 * stock path uses, so the two agree about when a quantity has been fully
 * consumed rather than leaving float dust behind.
 */
export const QTY_EPS = 1e-6

/**
 * Decimal places a stored quantity is held to. Mirrors QTY_DP in
 * src/main/db/lots.ts and the `ROUND(..., 4)` in bumpStock's SQL — the number is
 * restated here because this file has to reason about the error that rounding
 * introduces, and the renderer cannot import from main.
 */
export const QTY_STORED_DP = 4

/**
 * How far a STORED balance may legitimately fall short of a full-precision ask
 * of the same size.
 *
 * Why this exists. A conversion returns 1/N at full precision — 1/6 is
 * 0.16666666666666666 — but every stored balance is re-rounded to four places.
 * Break a 6-box case one box at a time and the balance goes 0.8333, 0.6666,
 * 0.4999, 0.3332, 0.1665: each step loses up to half a quantization step, in the
 * same direction. By the last box the shelf holds 0.1665 while the ask is still
 * 0.16666…, and a fixed QTY_EPS of 1e-6 is 33x too small to bridge it — so the
 * sixth box could never be recorded at all. The mirror case (divisors like 12,
 * where 1/N rounds DOWN) left a permanent 0.0001 residue instead, keeping an
 * empty product on the shelf forever.
 *
 * The bound is the number of pieces a whole unit divides into — at most 1/qty —
 * times half a quantization step. Capped, so a nonsense-small qty cannot ask for
 * unlimited slack.
 */
/**
 * A stored balance at or below this is EXACTLY ZERO.
 *
 * The companion to `quantizationSlack`, for the other side of the same problem.
 * Where 1/N rounds DOWN at four places (3, 9, 11, 12, 30), taking all N pieces
 * of a unit leaves 0.0001–0.001 behind: an open cost layer and a product still
 * reporting stock it does not have, permanently, with no UI able to enter a
 * fraction to clear it.
 *
 * 0.002 is chosen to sit far above that dust (the worst case is ~1.8e-3, at
 * N=36) and far below any quantity that can physically exist: the smallest real
 * holding is one pack, and even a 6-box case of 12-pack boxes makes a pack
 * 1/72 = 0.0139 of a case — seven times this threshold. Nothing a warehouse can
 * hold is ever mistaken for dust.
 */
export const QTY_SNAP = 0.002

export function quantizationSlack(qty: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return QTY_EPS
  const steps = Math.min(2000, Math.ceil(1 / qty))
  return Math.max(QTY_EPS, steps * 0.5 * 10 ** -QTY_STORED_DP)
}

/**
 * Display rounding ONLY. Never applied to a quantity that will be stored or
 * consumed.
 *
 * Rounding a conversion to 4dp looks harmless and is not: giving away three
 * 1-pack lots from a 3-pack box consumes 0.3333 three times, leaving 0.0001 of
 * a box on the shelf forever. That residue is a hundred times LARGER than the
 * epsilon the stock path uses to snap near-zero remainders, so it never clears
 * — it just sits there as a fraction of a box nobody owns. At full precision
 * the same three giveaways leave exactly zero.
 */
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
      /**
       * A CASE THAT SAYS HOW MANY BOXES IT HOLDS CAN BE OPENED, and that used to
       * be refused.
       *
       * Breaking one box out of a case is the single most ordinary thing this
       * business does on air, and the rule here turned it into an error:
       * "…is a part-case, and this product is not stocked for fractional
       * quantities. Enter whole cases, or mark it as a giveaway item." Neither
       * way out was true. Entering a whole case says twelve boxes were opened
       * when one was, and the giveaway flag is a statement about a product being
       * promotional material — ticking it to get past this would put a real case
       * of Tier One in the same category as loose packs handed out on stream.
       *
       * `boxesPerCase` IS the divisibility statement. A product that declares a
       * case holds twelve boxes has said that a box is a twelfth of a case; the
       * refusal below still stands when the divisor is unknown, because then the
       * fraction genuinely cannot be computed.
       *
       * The dust argument that produced the old gate is real and is handled
       * elsewhere rather than avoided here — see QTY_SNAP and
       * `quantizationSlack`, both written for exactly this: breaking a case one
       * box at a time, where each stored balance is re-rounded to four places and
       * the error accumulates in one direction. Without them the last box of a
       * 6-box case could not be recorded and a 12-box case kept a permanent
       * 0.0001 on the shelf. With them, a part-case is an ordinary balance.
       *
       * PACKS ARE STILL GATED. See giveawayToStock, which keeps the flag: a pack
       * is a fraction of a fraction, it is only ever handed out rather than sold,
       * and nothing about this change says a box divides cleanly into packs.
       */
      if (!units.boxesPerCase) {
        return {
          ok: false,
          error: 'This product is stocked in cases and has no boxes-per-case set, so loose boxes cannot be converted. Set boxes per case in Inventory.'
        }
      }
      const q = cases + boxes / units.boxesPerCase
      const fractional = Math.abs(q - Math.round(q)) > QTY_EPS
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
    q = inBoxes
  } else {
    if (!units.boxesPerCase) {
      return {
        ok: false,
        error: 'This product is stocked in cases and has no boxes-per-case set. Set it in Inventory.'
      }
    }
    q = inBoxes / units.boxesPerCase
  }

  const fractional = Math.abs(q - Math.round(q)) > QTY_EPS
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

/**
 * A shelf balance read back as whole cases and loose boxes.
 *
 * ## The number on its own is unreadable
 *
 * Stock is one decimal count of the product's own unit, which is right for the
 * arithmetic and useless to a person: break a box out of a 12-box case and the
 * shelf holds 3.9167, which answers no question anybody asks. What the operator
 * wants to know is what is physically in the room — three sealed cases and an
 * open one with eleven boxes in it.
 *
 * ## Rounding to the nearest BOX, deliberately
 *
 * Every stored balance is re-rounded to four places, so 3.9167 × 12 is 47.0004
 * and 3.9166 × 12 is 46.9992 — both are 47 boxes, and rounding is what says so.
 * Flooring instead would report 46 for one of them and lose a box that exists.
 *
 * ## Null when the split would be a lie
 *
 * Returns null for a box-stocked product (there is nothing to divide), when
 * `boxesPerCase` is unknown (the divisor is the whole basis of the split), and
 * when the balance is not a whole number of boxes — a giveaway item holding
 * two-thirds of a box has no honest reading as "0 boxes" or "1 box", so the
 * caller falls back to the decimal rather than inventing one.
 */
export interface CaseBreakdown {
  /** Sealed cases — untouched, whole. */
  fullCases: number
  /** Boxes sitting in the one case that has been opened. Zero when none is. */
  looseBoxes: number
  /** True when a case has been cracked and still has boxes in it. */
  open: boolean
  /** Everything, counted in boxes. What a break actually consumes. */
  totalBoxes: number
}

export function caseBreakdown(units: ProductUnits, quantity: number): CaseBreakdown | null {
  if (units.unitType !== 'case') return null
  if (!units.boxesPerCase || units.boxesPerCase <= 0) return null
  if (!Number.isFinite(quantity) || quantity < 0) return null

  const totalBoxes = Math.round(quantity * units.boxesPerCase)
  // A balance that is not a whole number of boxes is a fraction this reading
  // cannot express — see the note above.
  if (Math.abs(quantity * units.boxesPerCase - totalBoxes) > 0.01) return null

  const fullCases = Math.floor(totalBoxes / units.boxesPerCase)
  const looseBoxes = totalBoxes - fullCases * units.boxesPerCase
  return { fullCases, looseBoxes, open: looseBoxes > 0, totalBoxes }
}

/**
 * Human summary of a quantity in the product's own unit.
 *
 * A part-case reads as "3 cases + 11 boxes" rather than "3.9167 cases" — see
 * caseBreakdown, which is what makes the difference between a number and an
 * answer. Anything it cannot split honestly falls back to the decimal.
 */
export function describeQuantity(units: ProductUnits, quantity: number): string {
  const unit = units.unitType === 'case' ? 'case' : 'box'
  const whole = Math.floor(quantity)
  const frac = round4(quantity - whole)
  if (frac === 0) return `${whole} ${unit}${whole === 1 ? '' : 's'}`

  const split = caseBreakdown(units, quantity)
  if (split && split.open) {
    const cases = `${split.fullCases} case${split.fullCases === 1 ? '' : 's'}`
    const boxes = `${split.looseBoxes} box${split.looseBoxes === 1 ? '' : 'es'}`
    return split.fullCases > 0 ? `${cases} + ${boxes}` : boxes
  }
  return `${round4(quantity)} ${unit}s`
}
