import type { Database } from 'better-sqlite3'
import { newId, nowIso } from '../util'

/** [name, abbreviated sku, upc, category] — the products RM Cardz has carried. */
const CATALOG: Array<[string, string, string, string]> = [
  ['2026 Bowman Baseball Hobby 12-Box Case', '6578', '887521158126', 'Baseball'],
  ['2020-21 Panini Prizm Basketball Hobby Box', 'BOX', '613297959809', 'Basketball'],
  ['2026 Topps Chrome VeeFriends Hobby Box', 'BOX', '887521162055', 'Entertainment'],
  ['2025 Topps Stadium Club UFC Hobby Box', 'BOX', '887521148042', 'UFC'],
  ['2025-26 Topps Basketball Hobby Box', 'BOX', '887521149001', 'Basketball'],
  ['2025 Topps Finest Football Delight 8-Box Case', '6826', '887521156481', 'Football'],
  ['Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case', '100-10623', '196214111233', 'Pokemon'],
  ['2025 Topps Chrome Black Football Hobby Box', 'BOX', '887521156955', 'Football'],
  ['2026 Topps Finest Baseball Delight 6-Box Case', '7220', '887521157792', 'Baseball'],
  ['2025 Topps Inception Baseball Hobby Box', 'BOX', '887521151974', 'Baseball'],
  ['2026 Topps Chrome Marvel Comics Hobby 8-Box Case', '6774', '887521156153', 'Entertainment'],
  ['2025 Topps Definitive Baseball Hobby 2-Box Case', '6482', '887521148738', 'Baseball'],
  ['2025-26 Bowman Basketball Hobby 12-Box Case', '6684', '887521155422', 'Basketball'],
  ['2025-26 Topps Chrome Cactus Jack Basketball Hobby Box', 'BOX', '887521156382', 'Basketball'],
  ['2025 Topps Chrome Football Hobby 12-Box Case', '6390', '887521156665', 'Football'],
  ['2025-26 Panini Signature Series Basketball Hobby 12-Box Case', '18974', '746134189746', 'Basketball'],
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby 12-Box Case', '19426', '746134194269', 'Soccer'],
  ['2026 Topps Knockout UFC Hobby 8-Box Case', '7138', '887521157327', 'UFC'],
  ['2025 Topps Cosmic Chrome Football Hobby 8-Box Case', '6835', '887521156061', 'Football'],
  ['2025 Topps Finest Football Hobby 8-Box Case', '6827', '887521156450', 'Football'],
  ['2023-24 Topps Royalty Basketball Hobby 4-Box Case', '5590', '887521127726', 'Basketball'],
  ['2025 Topps Inception Baseball Hobby 8-Box Case', '6483', '887521151981', 'Baseball'],
  ['2025 Topps Signature Class Football Hobby 12-Box Case', '6828', '887521153411', 'Football'],
  ['2025 Topps Chrome Platinum Baseball Hobby 12-Box Case', '6178', '887521143412', 'Baseball'],
  ['2025 Panini Prizm Football Hobby 12-Box Case', '18725', '746134187254', 'Football'],
  ['2025 Panini Select Football Hobby 12-Box Case', '18861', '746134188619', 'Football'],
  ['2025-26 Topps Cosmic Chrome Basketball Hobby 8-Box Case', '6673', '887521151899', 'Basketball'],
  ['2025-26 Panini Donruss Road to FIFA World Cup Soccer Hobby 12-Box Case', '17867', '746134178672', 'Soccer'],
  ['2025-26 Topps Hoops Basketball Hobby 12-Box Case', '6698', '887521157129', 'Basketball'],
  ['2025 Bowman Draft Baseball Super Jumbo 6-Box Case', '6462', '887521149438', 'Baseball'],
  ['2026 Bowman Baseball Hobby Jumbo 8-Box Case', '6579', '887521158140', 'Baseball'],
  ['2025-26 Topps Three Basketball Hobby 4-Box Case', '6668', '887521153046', 'Basketball'],
  ['2026 Topps Cosmic Chrome WWE Wrestling Hobby 8-Box Case', '7160', '887521156023', 'UFC'],
  ['2026 Topps Chrome UFC Delight 8-Box Case', '7128', '887521153626', 'UFC'],
  ['2025 Topps Signature Class Football Hobby Jumbo 6-Box Case', '7221', '887521153442', 'Football'],
  ['2025 Topps Chrome Football Delight 6-Box Case', '6393', '887521156733', 'Football'],
  ['2025-26 Bowman Basketball Hobby Jumbo 8-Box Case', '6685', '887521155453', 'Basketball'],
  ['2026 Topps Disney Chrome Hobby 8-Box Case', '6782', '887521157532', 'Entertainment'],
  ['2026 Panini Prizm FIFA World Cup Soccer Choice 20-Box Case', '19431', '746134194313', 'Soccer'],
  ['2025 Topps Chrome Black Football Hobby 12-Box Case', '6836', '887521156962', 'Football']
]

/** A case if the name says "Case", otherwise a single box. */
export function unitTypeOf(name: string): 'case' | 'box' | 'other' {
  if (/case/i.test(name)) return 'case'
  if (/box/i.test(name)) return 'box'
  return 'other'
}

/** Boxes per case, parsed from "…N-Box Case". Null when not stated. */
export function boxesPerCaseOf(name: string): number | null {
  const m = name.match(/(\d+)-Box\s+Case/i)
  return m ? parseInt(m[1], 10) : null
}

export function brandOf(name: string): string {
  for (const b of ['Bowman', 'Panini', 'Topps', 'Pokemon']) {
    if (name.includes(b)) return b
  }
  return ''
}

export function yearOf(name: string): string {
  const m = name.match(/^(\d{4}(?:-\d{2})?)/)
  return m ? m[1] : ''
}

/** Insert the catalog rows (skipping any whose UPC already exists). */
export function seedCatalog(database: Database): void {
  const ts = nowIso()
  const stmt = database.prepare(
    `INSERT OR IGNORE INTO inventory_products
       (id, sku, upc, name, category, brand, set_name, year, unit_type,
        boxes_per_case, packs_per_box, unit_cost, sale_price, reorder_point,
        notes, created_at, updated_at)
     VALUES (@id, @sku, @upc, @name, @category, @brand, '', @year, @unit_type,
             @boxes_per_case, NULL, 0, NULL, 0, NULL, @ts, @ts)`
  )
  const insertAll = database.transaction((rows: typeof CATALOG) => {
    for (const [name, sku, upc, category] of rows) {
      stmt.run({
        id: newId(),
        sku,
        upc: upc || null,
        name,
        category,
        brand: brandOf(name),
        year: yearOf(name),
        unit_type: unitTypeOf(name),
        boxes_per_case: boxesPerCaseOf(name),
        ts
      })
    }
  })
  insertAll(CATALOG)
}
