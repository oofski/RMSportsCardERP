import type { Database } from 'better-sqlite3'
import { newId, nowIso } from '../util'
import { boxesPerCaseOf, brandOf, unitTypeOf, yearOf } from './inventorySeed'

/**
 * The current on-hand snapshot supplied by RM Cardz.
 *
 * [name, sku, category, location, onHand, highBid, avgCost]
 *
 * - `name` is matched (case-insensitively) against the catalog; SKU "BOX"
 *   repeats, so the name is the reliable key.
 * - `highBid` is the current top bid / market value per unit — it drives the
 *   inventory value and spread. `avgCost` is the average cost per unit
 *   (null when we have no cost basis, e.g. the AM consignment boxes).
 * - Derived, not stored: inventory value = onHand × highBid,
 *   total cost = onHand × avgCost, spread = value − cost.
 */
type SnapshotRow = [string, string, string, 'RM' | 'AM', number, number, number | null]

const SNAPSHOT: SnapshotRow[] = [
  ['2026 Bowman Baseball Hobby 12-Box Case', '6578', 'Baseball', 'RM', 18, 4460, 4258.89],
  ['2025 Topps Finest Football Delight 8-Box Case', '6826', 'Football', 'RM', 6, 8070, 7833.33],
  ['2025 Topps Definitive Baseball Hobby 2-Box Case', '6482', 'Baseball', 'RM', 4, 7850, 7777.5],
  ['2025 Topps Chrome Football Hobby 12-Box Case', '6390', 'Football', 'RM', 3, 6970, 6720],
  ['2025 Topps Cosmic Chrome Football Hobby 8-Box Case', '6835', 'Football', 'RM', 2, 7960, 8020],
  ['2025-26 Bowman Basketball Hobby 12-Box Case', '6684', 'Basketball', 'RM', 3, 5260, 4900],
  ['2026 Topps Chrome Marvel Comics Hobby 8-Box Case', '6774', 'Entertainment', 'RM', 4, 3808, 3680],
  ['2025-26 Topps Chrome Basketball Hobby Jumbo 8-Box Case', '6467', 'Basketball', 'RM', 1, 14750, 13500],
  ['2026 Panini Prizm FIFA World Cup Soccer Choice 20-Box Case', '19431', 'Soccer', 'RM', 1, 14000, 16800],
  ['2020-21 Panini Prizm Basketball Hobby Box', 'BOX', 'Basketball', 'AM', 11, 1041.67, null],
  ['2023-24 Topps Royalty Basketball Hobby 4-Box Case', '5590', 'Basketball', 'RM', 2, 5610, 4250],
  ['2025 Topps Finest Football Hobby 8-Box Case', '6827', 'Football', 'RM', 2, 5161, 5120],
  ['2025 Topps Chrome Football Delight 6-Box Case', '6393', 'Football', 'RM', 1, 9365, 8700],
  ['2026 Panini Prizm FIFA World Cup Soccer Hobby 12-Box Case', '19426', 'Soccer', 'RM', 1, 9275, 10725],
  ['2025 Topps Signature Class Football Hobby 12-Box Case', '6828', 'Football', 'RM', 2, 4125, 3825],
  ['2025-26 Topps Cosmic Chrome Basketball Hobby 8-Box Case', '6673', 'Basketball', 'RM', 1, 7120, 6995],
  ['Pokemon Scarlet & Violet Destined Rivals Sleeved Booster Case', '100-10623', 'Pokemon', 'RM', 5, 1350, 1600],
  ['2025-26 Bowman Basketball Hobby Jumbo 8-Box Case', '6685', 'Basketball', 'RM', 1, 5730, 5500],
  ['2025 Bowman Draft Baseball Super Jumbo 6-Box Case', '6462', 'Baseball', 'RM', 1, 5585, 5000],
  ['2026 Bowman Baseball Hobby Jumbo 8-Box Case', '6579', 'Baseball', 'RM', 1, 5260, 4800],
  ['2025-26 Panini Donruss Road to FIFA World Cup Soccer Hobby 12-Box Case', '17867', 'Soccer', 'RM', 1, 4900, 4800],
  ['2025 Topps Signature Class Football Hobby Jumbo 6-Box Case', '7221', 'Football', 'RM', 1, 4305, 4000],
  ['2025 Topps Inception Baseball Hobby 8-Box Case', '6483', 'Baseball', 'RM', 2, 2000, 2260],
  ['2025-26 Topps Three Basketball Hobby 4-Box Case', '6668', 'Basketball', 'RM', 1, 3820, 3900],
  ['2026 Topps Disney Chrome Hobby 8-Box Case', '6782', 'Entertainment', 'RM', 1, 3725, 3710],
  ['2026 Topps Knockout UFC Hobby 8-Box Case', '7138', 'Combat', 'RM', 2, 1735, 1550],
  ['2025 Topps Chrome Platinum Baseball Hobby 12-Box Case', '6178', 'Baseball', 'RM', 1, 2850, 2500],
  ['2025-26 Topps Basketball Hobby Box', 'BOX', 'Basketball', 'AM', 8, 355, null],
  ['2025-26 Topps Hoops Basketball Hobby 12-Box Case', '6698', 'Basketball', 'RM', 1, 2630, 2560],
  ['2026 Topps Chrome VeeFriends Hobby Box', 'BOX', 'Entertainment', 'RM', 10, 252.08, null],
  ['2026 Topps Chrome UFC Delight 8-Box Case', '7128', 'Combat', 'RM', 1, 2310, 2000],
  ['2026 Topps Cosmic Chrome WWE Wrestling Hobby 8-Box Case', '7160', 'Combat', 'RM', 1, 2300, 2000],
  ['2025 Topps Chrome Black Football Hobby Box', 'BOX', 'Football', 'RM', 5, 405, null],
  ['2025-26 Topps Chrome Cactus Jack Basketball Hobby Box', 'BOX', 'Basketball', 'RM', 3, 517.58, null],
  ['2025 Topps Inception Baseball Hobby Box', 'BOX', 'Baseball', 'RM', 4, 262, null],
  ['2025 Topps Stadium Club UFC Hobby Box', 'BOX', 'Combat', 'RM', 8, 87.5, null]
]

/**
 * Apply the snapshot: for each row, find the catalog product by name (creating
 * it if missing), set its high bid + average cost, and set the on-hand quantity
 * at the row's location to the exact value. Runs inside a single transaction.
 */
export function seedSnapshot(database: Database): void {
  const ts = nowIso()

  const findByName = database.prepare(
    'SELECT id FROM inventory_products WHERE name = ? COLLATE NOCASE'
  )
  const insertProduct = database.prepare(
    `INSERT INTO inventory_products
       (id, sku, upc, name, category, brand, set_name, year, unit_type,
        boxes_per_case, packs_per_box, unit_cost, high_bid, sale_price, reorder_point,
        notes, created_at, updated_at)
     VALUES
       (@id, @sku, NULL, @name, @category, @brand, '', @year, @unit_type,
        @boxes_per_case, NULL, 0, NULL, NULL, 0, NULL, @ts, @ts)`
  )
  // High bid always set; average cost only overwrites when we have one.
  const updateMetrics = database.prepare(
    `UPDATE inventory_products
       SET category  = @category,
           high_bid  = @high_bid,
           unit_cost = COALESCE(@avg_cost, unit_cost),
           updated_at = @ts
     WHERE id = @id`
  )
  // Set (not add) the exact on-hand count for this product at this location.
  const setStock = database.prepare(
    `INSERT INTO inventory_stock (id, product_id, location, quantity)
     VALUES (@id, @pid, @loc, @qty)
     ON CONFLICT(product_id, location) DO UPDATE SET quantity = excluded.quantity`
  )

  const run = database.transaction(() => {
    for (const [name, sku, category, location, onHand, highBid, avgCost] of SNAPSHOT) {
      const existing = findByName.get(name) as { id: string } | undefined
      let id: string
      if (existing) {
        id = existing.id
      } else {
        id = newId()
        insertProduct.run({
          id,
          sku,
          name,
          category,
          brand: brandOf(name),
          year: yearOf(name),
          unit_type: unitTypeOf(name),
          boxes_per_case: boxesPerCaseOf(name),
          ts
        })
      }
      updateMetrics.run({ id, category, high_bid: highBid, avg_cost: avgCost, ts })
      setStock.run({ id: newId(), pid: id, loc: location, qty: onHand })
    }
  })
  run()
}
