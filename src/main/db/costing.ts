/**
 * Moving weighted-average unit cost after receiving `addQty` units at
 * `addCost` each, given `prevQty` units already on hand at `oldAvg` each.
 *
 * When there is no prior cost basis (oldAvg ≤ 0) or nothing on hand, the new
 * purchase price simply becomes the average. Rounded to whole cents.
 */
export function movingAverageCost(
  prevQty: number,
  oldAvg: number,
  addQty: number,
  addCost: number
): number {
  const avg =
    oldAvg > 0 && prevQty > 0 ? (prevQty * oldAvg + addQty * addCost) / (prevQty + addQty) : addCost
  return Math.round(avg * 100) / 100
}
