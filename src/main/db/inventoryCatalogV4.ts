import type { Database } from 'better-sqlite3'
import { seedCatalogRows, type CatalogImportResult } from './inventoryCatalogV3'

/**
 * The owner's catalog, as it stood in August 2026 — the rows the v3 list did
 * not have.
 *
 * Thirty-five products, checked against the existing catalog name by name
 * before being written down here: nothing in this list is a second copy of
 * something already in v3, and the two together are the whole sheet the owner
 * sent. Mostly the 2025-26 releases that had not been announced when v3 was
 * captured — the Chrome Update Series basketball run, the single-box SKUs for
 * products previously carried only by the case, and two Pokemon lines.
 *
 * ## What is NOT here, and why
 *
 * Four rows on the owner's sheet are not products:
 *
 *   DealerNet EFT to Wire Swap · Giveaways · Show Boost · Super Seller Bonus
 *
 * They are invoice adjustments — a payment-method fee swap, an allocation, a
 * promotional credit and a rebate — carried on the same distributor export as
 * the boxes. They have no barcode, no unit, no cost basis and no category, and
 * adding them would put four permanently-empty rows in the catalog and four
 * more entries on the "products nothing can identify" screen. They are named
 * here rather than silently dropped, so the next person comparing the sheet to
 * the catalog can see the decision instead of rediscovering the gap.
 *
 * ## Inserts only
 *
 * Runs through the same `seedCatalogRows` the v3 import uses: a product already
 * in the catalog — by name, or by a real SKU under a different name — is
 * skipped whole and keeps its stock, cost basis, UPC, images and every edit
 * anyone has made to it. Nothing in this file can modify an existing row.
 */
const CATALOG_V4: ReadonlyArray<readonly [string, string, string]> = [
  ['2025-26 Topps Chrome Update Series Basketball Hobby Jumbo 8-Box Case', '6721', 'Basketball'],
  ['2025-26 Topps Chrome Update Series Basketball Hobby 12-Box Case', '6720', 'Basketball'],
  ['2025 Bowman Draft Baseball Breaker\'s Delight 6-Box Case', '6463', 'Baseball'],
  ['2026 Bo Jackson Battle Arena Tecmo Bowl Edition - Hobby 6-Box Case', '21067', 'Football'],
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby Mega 20-Box Case', '20262', 'Soccer'],
  ['2025 Topps Resurgence Football Hobby 12-Box Case', '6838', 'Football'],
  ['2025-26 Panini Court Kings Basketball Hobby 16-Box Case', '18980', 'Basketball'],
  ['2025-26 Topps Chrome Update Series Basketball Delight 6-Box Case', '6717', 'Basketball'],
  ['2025-26 Panini Pitch Kings Soccer Hobby International 16-Box Case', '20445', 'Soccer'],
  ['2025 Bowman\'s Best Baseball Hobby 8-Box Case', '6531', 'Baseball'],
  ['2026 Bowman Baseball Breaker\'s Delight 6-Box Case', '6577', 'Baseball'],
  ['2026 Topps Finest Baseball Delight Box', 'BOX', 'Baseball'],
  ['2026 Topps Chrome Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2026 Topps Chrome Baseball Delight Box', 'BOX', 'Baseball'],
  ['2026 Topps Chrome Baseball Jumbo Hobby Box', 'BOX', 'Baseball'],
  ['2026 Topps Tribute Baseball Hobby Box', 'BOX', 'Baseball'],
  ['2025-26 Topps Cosmic Chrome Basketball Hobby Box', 'BOX', 'Basketball'],
  ['2025-26 Topps Inception Basketball Hobby Box', 'BOX', 'Basketball'],
  ['2025-26 Topps Basketball Hobby 12-Box Case', '6489', 'Basketball'],
  ['2026 Topps Chrome Marvel Comics Sapphire Edition 10-Box Case', '6775', 'Entertainment'],
  ['2025 Bowman Chrome University Football Breaker\'s Delight 10-Box Case', '6374', 'Football'],
  ['2025 Topps Finest Football Delight Box', 'BOX', 'Football'],
  ['2025 Topps Chrome Football Delight Box', 'BOX', 'Football'],
  ['Pokemon Mega Evolution ME4 Chaos Rising Booster 6-Box Case', '10407-119', 'Pokemon'],
  ['Pokemon Scarlet & Violet Destined Rivals Elite Trainer 10-Box Case', '100-10652', 'Pokemon'],
  ['2025-26 Panini Obsidian Soccer Hobby 12-Box Case', '19366', 'Soccer'],
  ['2024-25 Topps Chrome UEFA Women\'s Champions League Soccer Hobby 12-Box Case', '6229', 'Soccer'],
  ['2025-26 Topps Chrome UEFA Women\'s Champions League Soccer Hobby 12-Box Case', '7069', 'Soccer'],
  ['2025 Topps Chrome Tennis Breaker\'s Delight 12-Box Case', '6337', 'Tennis'],
  ['2025-26 Topps Pristine English Premier League Soccer Hobby 6-Box Case', '7058', 'Soccer'],
  ['2025-26 Topps Chrome Update Series Basketball Blaster 40-Box Case', '6728', 'Basketball'],
  ['2025-26 Topps Chrome Update Series Basketball Blaster Box', 'BOX', 'Basketball'],
  ['2026 Topps Disney Chrome Sapphire Edition 10-Box Case', '6786', 'Entertainment'],
  ['2026 Topps Chrome Baseball Mega 20-Box Case', '6630', 'Baseball'],
  ['2026 Topps Pristine Baseball Hobby 6-Box Case', '6611', 'Baseball'],]

export function seedCatalogV4(database: Database): CatalogImportResult {
  return seedCatalogRows(database, CATALOG_V4)
}

/**
 * One transposed SKU: 19837 where the distributor's sheet says 19387.
 *
 * `2025-26 Panini Select Road to FIFA World Cup Soccer Hobby 12-Box Case`. Two
 * digits swapped, and the wrong value matches nothing at that distributor — so
 * a purchase order raised against it could never be matched by SKU.
 *
 * ## Why it is guarded rather than run as a blanket update
 *
 * A BARCODED ROW IS LEFT ALONE, even though its SKU is wrong. A product
 * somebody can scan is one that has already been through their hands — checked,
 * matched, corrected — and rewriting a field underneath them is the one thing
 * the owner asked not to happen. The trade is deliberate and this is the record
 * of it: a scannable product keeps its wrong SKU, because it does not need the
 * SKU to be found.
 *
 * Matched on the WRONG VALUE, not on the product, so it cannot touch a row
 * somebody has since corrected by hand.
 *
 * Returns how many rows changed — 0 and 1 are both ordinary answers.
 */
export function fixTransposedSku(database: Database): number {
  return database
    .prepare(
      `UPDATE inventory_products
          SET sku = '19387', updated_at = ?
        WHERE sku = '19837'
          AND (upc IS NULL OR TRIM(upc) = '')`
    )
    .run(new Date().toISOString()).changes
}
