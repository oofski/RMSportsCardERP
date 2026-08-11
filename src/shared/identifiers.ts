/**
 * Whether a catalog product can be found by MACHINE — the pure half of the
 * "Missing identifiers" view on the inventory dashboard.
 *
 * A product carries two identifiers and they do two different jobs.
 *
 *   The UPC is what a scanner matches on. `resolveScan` in db/scanning.ts
 *   normalises the barcode and looks it up through `findProductsByUpc`, so a
 *   product with no UPC answers "isn't in the catalog" to every scan of the box
 *   physically sitting on the bench — including the PO check-in path, which
 *   receives a purchase order line at a time BY scanning it.
 *
 *   The SKU is what an invoice line matches a QuickBooks item on.
 *   `resolveLineItemRef` in @shared/invoices tries the SKU FIRST and falls back
 *   to the item NAME — and a name in QuickBooks is a merchandising decision that
 *   gets tidied. A line with no SKU therefore resolves against whatever item
 *   still happens to carry the old name, or against nothing at all, and
 *   `toQboInvoice` refuses the whole invoice rather than posting half of one.
 *
 * So this is not a tidiness report. Every product it names is one the app
 * ALREADY cannot do something with, and that is why the three states are kept
 * apart instead of summed into one "incomplete" figure: they are three different
 * jobs. A product missing both can neither be scanned onto a shelf nor billed
 * off one, and folding it into a single total is exactly how the worst fourteen
 * rows hide inside a hundred and ninety-eight.
 *
 * THIS IS A VIEW, NOT A CATEGORY, and nothing here writes. A product with no
 * SKU is still a Football product — it has a data gap, not a different kind.
 * Filing it under a pseudo-category would move it out of its own group and take
 * its case count and its market value with it, because the dashboard's category
 * cards and the value-by-category chart both sum straight off the stored
 * `category` column (see `categorySummaries` in db/inventory.ts). The gap has to
 * cut across the categories rather than replace one.
 *
 * Pure — no I/O, no database, no Electron. The count on the tile and the list
 * behind it are both derived from the SAME catalog array the Catalog tab
 * renders, so a tile promising fourteen products can never open onto thirteen.
 */

/**
 * SKU values that are typed into the field and identify nothing.
 *
 * `BOX` is the placeholder the owner's own product list uses for any single box
 * — 27 catalog rows share it — and `n/a` / `none` / `-` speak for themselves.
 * The catalog importer has refused to MATCH on these since v3 (matching on `BOX`
 * would make the first such row swallow every later one), and this is now the
 * one place that rule is written down; db/inventoryCatalogV3.ts re-exports it
 * rather than keeping a second copy that could drift.
 *
 * A value the app already refuses to identify a product by is not an identifier,
 * so this view counts it as MISSING rather than as filled in. Judge it the other
 * way and 27 products nobody can tell apart, half of them with no barcode
 * either, report as complete on the one screen built to find them.
 */
export const PLACEHOLDER_SKUS = new Set(['BOX', 'N/A', 'NA', 'NONE', '-'])

/**
 * Shortest SKU still worth matching a product on. Two characters collide long
 * before they identify anything across three hundred rows, and the importer has
 * always drawn the line here — so this screen draws it in the same place rather
 * than calling a SKU real that the rest of the app will not match on.
 */
export const MIN_SKU_LENGTH = 3

/** Why a SKU field is not an identifier. Null from `skuGap` means it is one. */
export type SkuGap = 'blank' | 'placeholder'

/**
 * Why this SKU identifies nothing, or null when it identifies something.
 *
 * TRIMMED BEFORE JUDGING, and that is not pedantry: `sku` is `TEXT NOT NULL
 * DEFAULT ''` while `upc` is a nullable UNIQUE column, so "the operator left it
 * empty" reaches this function as three different values depending on which path
 * wrote the row — NULL from a catalog seed, '' from ScanNewProduct, and a stray
 * space from anything a person pasted. All three read as empty to a person, so
 * all three have to count the same or the tile reports a number nobody can
 * reproduce by looking at the screen.
 */
export function skuGap(sku: string | null | undefined): SkuGap | null {
  const s = (sku ?? '').trim().toUpperCase()
  if (s === '') return 'blank'
  if (s.length < MIN_SKU_LENGTH || PLACEHOLDER_SKUS.has(s)) return 'placeholder'
  return null
}

/** Is this SKU a real identifier, i.e. worth matching an existing product on? */
export function isMatchableSku(sku: string | null | undefined): boolean {
  return skuGap(sku) === null
}

/**
 * A barcode the scanner could match on.
 *
 * Blank in any of its forms is no barcode. There is deliberately NO format check
 * here: @shared/upc already folds UPC-E, UPC-A, EAN-13, GTIN-14 and Code-128
 * internal shop labels onto one canonical key, and a screen that told the
 * operator their barcode was "wrong" for not looking like a GTIN would be wrong
 * itself about the labels this shop prints and scans every day.
 */
export function hasUpc(upc: string | null | undefined): boolean {
  return (upc ?? '').trim() !== ''
}

/**
 * Which identifier a product is missing.
 *
 * MUTUALLY EXCLUSIVE. 'both' is not the intersection of the other two — a
 * product counted there is counted nowhere else — so the three numbers add up to
 * the number of rows in the list and the operator reads the tile as three jobs
 * rather than as overlapping totals they have to reconcile in their head.
 */
export type IdentifierGap = 'sku' | 'upc' | 'both'

/** The two columns this file judges. Structural, so a real InventoryProduct goes
 *  straight in and a test can build a case without the twenty other columns. */
export interface ProductIdentifiers {
  sku?: string | null
  upc?: string | null
}

/** What this product is missing, or null when it carries both. */
export function identifierGap(p: ProductIdentifiers): IdentifierGap | null {
  const noSku = skuGap(p.sku) !== null
  const noUpc = !hasUpc(p.upc)
  if (noSku && noUpc) return 'both'
  if (noSku) return 'sku'
  if (noUpc) return 'upc'
  return null
}

export interface IdentifierGapCounts {
  /** Has a barcode, no SKU: scannable, but billable only by name. */
  sku: number
  /** Has a SKU, no barcode: billable, but invisible to every scanner. */
  upc: number
  /** Neither. The worst case, and the reason it gets its own number. */
  both: number
  /** sku + upc + both, and never a count of anything else. */
  total: number
}

/**
 * How many products sit in each state.
 *
 * Counted from the catalog array rather than by a second SQL query on purpose.
 * The tile's number and the list behind it come from one read of one rule; a
 * COUNT(*) in db/inventory.ts would be a second definition of "empty" written in
 * SQL, and the day the two disagree is the day the tile says fourteen and opens
 * onto eleven with no way to tell which one lied.
 */
export function countIdentifierGaps(products: readonly ProductIdentifiers[]): IdentifierGapCounts {
  const counts: IdentifierGapCounts = { sku: 0, upc: 0, both: 0, total: 0 }
  for (const p of products) {
    const gap = identifierGap(p)
    if (!gap) continue
    counts[gap]++
    counts.total++
  }
  return counts
}

/**
 * Worst first. A product with neither identifier is off the scanner AND off the
 * QuickBooks item list, so it leads. A missing SKU comes next because it can
 * REFUSE an invoice outright — the line falls back to a name match and
 * `toQboInvoice` throws when that finds nothing — while a missing barcode costs
 * somebody a lookup by hand, which is a slower day rather than money stuck.
 */
const GAP_RANK: Record<IdentifierGap, number> = { both: 0, sku: 1, upc: 2 }

/** One product that needs work, and what it needs. */
export interface IdentifierGapRow<T extends ProductIdentifiers> {
  product: T
  gap: IdentifierGap
  /** Why the SKU does not count, so a row showing the word BOX can say so. */
  sku: SkuGap | null
}

/**
 * The products behind those numbers, worst first, optionally narrowed to one
 * state.
 *
 * Generic over the product type so the renderer gets its InventoryProducts back
 * as InventoryProducts — the same reason `OfferMatchOption` in
 * @shared/supplierOffers is generic. Widening to `ProductIdentifiers` here would
 * force a cast at the call site, and a cast is how the wrong object eventually
 * reaches a screen whose entire job is editing the right one.
 *
 * The sort is stable within a state, so the caller's order (the catalog's, which
 * is by name) survives and the row somebody was typing into does not move under
 * the cursor when a sibling is saved.
 */
export function productsMissingIdentifiers<T extends ProductIdentifiers>(
  products: readonly T[],
  only: IdentifierGap | 'all' = 'all'
): IdentifierGapRow<T>[] {
  const rows: IdentifierGapRow<T>[] = []
  for (const product of products) {
    const gap = identifierGap(product)
    if (!gap) continue
    if (only !== 'all' && gap !== only) continue
    rows.push({ product, gap, sku: skuGap(product.sku) })
  }
  return rows.sort((a, b) => GAP_RANK[a.gap] - GAP_RANK[b.gap])
}
