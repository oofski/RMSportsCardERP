import type { Database } from 'better-sqlite3'
import { newId, nowIso } from '../util'
import { brandOf, unitTypeOf, yearOf } from './inventorySeed'

/**
 * Catalog expansion: additional products RM Cardz carries, added with no
 * financial data (cost / high bid stay blank until supervisors set them).
 *
 * [name, sku, upc, category] — `upc` may be null when none was supplied. The
 * two skipped entries (SKU 95978 and 17933) are intentionally absent, and WNBA
 * products are filed under Basketball. Matched by name, so the pre-existing
 * "…Chrome Basketball Hobby Jumbo 8-Box Case" (6467) only backfills its UPC.
 */
const CATALOG_V2: Array<[string, string, string | null, string]> = [
  ['2026 Topps Tier One Baseball Hobby 12-Box Case', '6576', '887521156283', 'Baseball'],
  ['2026 Topps Finest Baseball Hobby 8-Box Case', '6619', '887521157747', 'Baseball'],
  ['2025-26 Topps UEFA Club Competitions Finest Soccer Hobby 8-Box Case', '7059', '887521155705', 'Soccer'],
  ['2025 Topps Cosmic Chrome Baseball Hobby 8-Box Case', '6280', '887521142651', 'Baseball'],
  ['2025 Topps Dynasty Baseball Hobby 5-Box Case', '6484', '887521150755', 'Baseball'],
  ['2025-26 Topps Chrome Basketball Hobby Jumbo 8-Box Case', '6467', '887521149650', 'Basketball'],
  ['2024-25 Upper Deck Ice Hockey Hobby 24-Box Case', '78685', '53334786850', 'Hockey'],
  ['2025 Topps Stadium Club UFC Hobby 16-Box Case', '6339', '887521148059', 'UFC'],
  ['2025-26 Topps Chrome Cactus Jack Basketball Hobby 12-Box Case', '7231', '887521156399', 'Basketball'],
  ['2026 Panini Immaculate Baseball Hobby 6-Box Case', '19876', '746134198762', 'Baseball'],
  ['2026 Topps Series 2 Baseball Hobby 12-Box Case', '6599', '887521164486', 'Baseball'],
  ['2025 Bowman Chrome Baseball Hobby 12-Box Case', '6382', '887521145973', 'Baseball'],
  ["2025 Bowman Draft Baseball Breaker's Delight 6-Box Case", '6463', '887521149469', 'Baseball'],
  ['2025 Bowman Draft Baseball Hobby 8-Box Case', '6461', '887521149407', 'Baseball'],
  ['2025 Bowman Draft Baseball Hobby Box', 'BOX', '887521149391', 'Baseball'],
  ['2025 Bowman Draft Baseball Mega 20-Box Case', '6460', '887521149520', 'Baseball'],
  ['2025 Bowman Draft Baseball Sapphire Edition 10-Box Case', '6464', '887521149490', 'Baseball'],
  ['2025 Bowman Draft Baseball Super Jumbo Box', 'BOX', '887521149421', 'Baseball'],
  ["2025 Bowman's Best Baseball Hobby 8-Box Case", '6531', '887521152421', 'Baseball'],
  ['2025 Panini Donruss Baseball Hobby Blaster 20-Box Case', '18185', '746134181856', 'Baseball'],
  ['2025 Panini Flawless Baseball Hobby 2-Box Case', '18261', '746134182617', 'Baseball'],
  ['2025 Panini Impeccable Baseball Hobby 3-Box Case', '18200', '746134182006', 'Baseball'],
  ['2025 Panini National Treasures Baseball Hobby 4-Box Case', '18233', '746134166914', 'Baseball'],
  ['2025 Panini Prospect Edition Baseball Blaster 20-Box Case', '18271', '746134182716', 'Baseball'],
  ['2025 Panini Prospect Edition Baseball Hobby 20-Box Case', '18266', '746134182662', 'Baseball'],
  ['2025 Panini Select Baseball Hobby Blaster 20-Box Case', '18258', '746134182587', 'Baseball'],
  ['2025 Topps Allen & Ginter Baseball Blaster 40-Box Case', '6332', '887521144334', 'Baseball'],
  ['2025 Topps Allen & Ginter Baseball Fat Pack 108-Pack Case', '6335', '887521144396', 'Baseball'],
  ['2025 Topps Archives Baseball Blaster 40-Box Case', '6289', '887521143313', 'Baseball'],
  ['2025 Topps Chrome Baseball Blaster 40-Box Case', '6247', '887521140763', 'Baseball'],
  ['2025 Topps Chrome Baseball Hobby 12-Box Case', '6244', '887521140657', 'Baseball'],
  ['2025 Topps Chrome Black Baseball Hobby 12-Box Case', '6042', '887521136438', 'Baseball'],
  ['2025 Topps Chrome Platinum Baseball Blaster 40-Box Case', '6179', '887521143450', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Blaster 40-Box Case', '6367', '887521145553', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Delight 6-Box Case', '6365', '887521145492', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Hobby 12-Box Case', '6363', '887521145447', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Jumbo Hobby 8-Box Case', '6364', '887521145478', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Mega 20-Box Case', '6369', '887521145607', 'Baseball'],
  ['2025 Topps Chrome Update Series Baseball Sapphire Edition 10-Box Case', '6366', '887521145522', 'Baseball'],
  ['2025 Topps Finest Baseball Hobby 8-Box Case', '6260', '887521143160', 'Baseball'],
  ['2025 Topps Finest Baseball Hobby Box', 'BOX', '887521143153', 'Baseball'],
  ['2025 Topps Five Star Baseball Hobby 3-Box Case', '6282', '887521148295', 'Baseball'],
  ['2025 Topps Gilded Collection Baseball Hobby 4-Box Case', '6291', '887521144051', 'Baseball'],
  ['2025 Topps Holiday Baseball Mega 20-Box Case', '6284', '887521142699', 'Baseball'],
  ['2025 Topps Museum Collection Baseball Hobby 8-Box Case', '6273', '887521143870', 'Baseball'],
  ['2025 Topps Pristine Baseball Hobby 6-Box Case', '6155', '887521144600', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Blaster 40-Box Case', '6408', '887521148806', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Blaster Box', 'BOX', '887521148783', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Hobby 16-Box Case', '6407', '887521148769', 'Baseball'],
  ['2025 Topps Stadium Club Baseball Mega 20-Box Case', '6410', '887521148851', 'Baseball'],
  ['2025 Topps Transcendent Collection Baseball Hobby Case', '6292', '887521144068', 'Baseball'],
  ['2026 Bowman Baseball Blaster 40-Box Case', '6586', '887521158300', 'Baseball'],
  ["2026 Bowman Baseball Breaker's Delight 6-Box Case", '6577', '887521158171', 'Baseball'],
  ['2026 Bowman Baseball Sapphire Edition Hobby 10-Box Case', '6583', '887521158263', 'Baseball'],
  ['2026 Panini Donruss Elite Baseball Hobby 12-Box Case', '20319', '746134203190', 'Baseball'],
  ['2026 Panini USA Stars And Stripes Prizm Baseball Hobby 12 Box Case', '19614', '746134196140', 'Baseball'],
  ['2026 Topps Chrome Black Baseball Hobby 12-Box Case', '6560', '887521153787', 'Baseball'],
  ['2026 Topps Heritage Baseball Blaster 40-Box Case', '6573', '887521155255', 'Baseball'],
  ['2026 Topps Heritage Baseball Hobby 12-Box Case', '6567', '887521155194', 'Baseball'],
  ['2026 Topps Series 1 Baseball 36-Tin Case', '6553', '887521155101', 'Baseball'],
  ['2026 Topps Series 1 Baseball Blaster 40-Box Case', '6556', '887521154760', 'Baseball'],
  ['2026 Topps Series 1 Baseball Fat Pack 108-Pack Case', '6539', '887521154968', 'Baseball'],
  ['2026 Topps Series 1 Baseball Hobby 12-Box Case', '6544', '887521154685', 'Baseball'],
  ['2026 Topps Series 1 Baseball Hobby Jumbo 6-Box Case', '6545', '887521154715', 'Baseball'],
  ['2026 Topps Series 1 Baseball Mega 20-Box Case', '6549', '938784', 'Baseball'],
  ['2026 Topps Series 2 Baseball Blaster 40-Box Case', '6608', '887521164561', 'Baseball'],
  ['2026 Topps Series 2 Baseball Hobby Jumbo 6-Box Case', '6600', '887521164516', 'Baseball'],
  ['2026 Topps Series 2 Baseball Hobby Jumbo Box', 'BOX', '887521164509', 'Baseball'],
  ['2026 Topps Series 2 Baseball Mega 20-Box Case', '6603', '887521164615', 'Baseball'],
  ['2026 Topps Tier One Baseball Hobby Box', 'BOX', '887521156276', 'Baseball'],
  ['2026 Topps Finest Baseball Hobby Box', 'BOX', '887521157730', 'Baseball'],
  ['2025-26 Bowman Basketball Delight 6-Box Case', '6682', '887521165484', 'Basketball'],
  ['2023-24 Panini Phoenix Basketball Hobby 16-Box Case', '15847', '746134158476', 'Basketball'],
  ['2024-25 Panini Donruss Optic Basketball Hobby 12-Box Case', '17981', '746134179921', 'Basketball'],
  ['2024-25 Panini Prizm Basketball Hobby 12-Box Case', '16416', '746134164163', 'Basketball'],
  ['2024-25 Panini Prizm Deca Basketball Hobby 10-Box Case', '17864', '746134178641', 'Basketball'],
  ['2024-25 Panini Revolution Basketball Blaster 20-Box Case', '17857', '746134178573', 'Basketball'],
  ['2024-25 Panini Select Basketball Hobby 12-Box Case', '18049', '746134180491', 'Basketball'],
  ['2024-25 Panini Select Basketball Hobby International 12-Box Case', '18058', '746134180583', 'Basketball'],
  ['2025 Panini Prizm WNBA Basketball Hobby 12-Box Case', '19032', '746134190322', 'Basketball'],
  ['2025 Panini Select WNBA Basketball Hobby 12-Box Case', '19059', '746134190599', 'Basketball'],
  ['2025 Panini Select WNBA Basketball Hobby Blaster 20-Box Case', '19071', '746134190711', 'Basketball']
]

/**
 * Add the expansion products once. Matches by name so a product already in the
 * catalog is left in place (only backfilling a missing UPC); everything else is
 * inserted with blank financials. UPC collisions are avoided defensively.
 */
export function seedCatalogExpansion(database: Database): void {
  const ts = nowIso()
  const findByName = database.prepare('SELECT id, upc FROM inventory_products WHERE name = ? COLLATE NOCASE')
  const upcOwner = database.prepare('SELECT id FROM inventory_products WHERE upc = ?')
  const insert = database.prepare(
    `INSERT INTO inventory_products
       (id, sku, upc, name, category, brand, set_name, year, unit_type,
        boxes_per_case, packs_per_box, unit_cost, high_bid, sale_price, reorder_point,
        notes, created_at, updated_at)
     VALUES
       (@id, @sku, @upc, @name, @category, @brand, '', @year, @unit_type,
        NULL, NULL, 0, NULL, NULL, 0, NULL, @ts, @ts)`
  )
  const backfillUpc = database.prepare(
    'UPDATE inventory_products SET upc = @upc, updated_at = @ts WHERE id = @id'
  )

  const run = database.transaction(() => {
    for (const [name, sku, upc, category] of CATALOG_V2) {
      const existing = findByName.get(name) as { id: string; upc: string | null } | undefined
      // Only use the UPC if it isn't already owned by a different product.
      const owner = upc ? (upcOwner.get(upc) as { id: string } | undefined) : undefined
      const safeUpc = upc && (!owner || owner.id === existing?.id) ? upc : null

      if (existing) {
        if (!existing.upc && safeUpc) backfillUpc.run({ id: existing.id, upc: safeUpc, ts })
        continue
      }
      insert.run({
        id: newId(),
        sku,
        upc: safeUpc,
        name,
        category,
        brand: brandOf(name),
        year: yearOf(name),
        unit_type: unitTypeOf(name),
        ts
      })
    }
  })
  run()
}
