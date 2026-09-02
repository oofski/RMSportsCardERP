/**
 * PRICING STOCK FROM THE SHELF MUST REACH THE PURCHASE ORDER IT CAME FROM.
 *
 * The owner: "when I went and I placed the price of this item, it went through
 * and it registered in the inventory correctly. But on the PO, it didn't update
 * ... it's important that when we update the price that we buy it at, it updates
 * the PO that it came through so we know how much the PO [cost]."
 *
 * PO-0458 is the case. A roadshow case checked in before its invoice arrived,
 * costed later from the Inventory screen's zero-cost banner. The shelf got its
 * cost, the valuation went right, and the purchase order still read $0.00 a unit
 * and a grand total of $0.00 — a document saying the business paid nothing for
 * something it paid real money for.
 *
 * ## Two doors onto one fact, and only one of them was wired
 *
 * `setLinePrice` in db/purchaseOrders.ts — the roadshow "price it later" flow —
 * already does the whole job: it writes the line, re-costs the layers, restates
 * what has already been sold from them, and restates the order total. It is
 * correct and it is not what the owner used.
 *
 * `setZeroCostBasis` in db/inventory.ts — the Inventory banner — wrote the
 * product average and the layers and STOPPED. Same fact, entered a different way,
 * and everything downstream of the purchase order was left behind: the PO total,
 * the COGS row keyed to it, and the cost of goods on any sale already drawn from
 * those layers, which stayed at zero and reported the whole sale price as profit.
 *
 * So this module holds the half they must share. `restateOrderTotal` moved here
 * out of purchaseOrders.ts rather than being copied, because two copies of "what
 * a purchase order costs" is the same class of bug one layer up.
 *
 * ## THE ONE THING THIS REFUSES TO DO
 *
 * It will not overwrite a line that already carries a REAL price. A figure
 * somebody typed on a purchase order is a stated fact about what was agreed;
 * a cost typed on the Inventory screen is a statement about what is on a shelf.
 * Where the line never had a price — pending, or zero — the two are the same
 * claim and filling it in COMPLETES the record. Where the line has one, they are
 * different claims and the document wins. Silently restating a priced order from
 * an inventory screen is how a month somebody has closed gets rewritten.
 */
import type { Database } from 'better-sqlite3'
import { restateConsumedCost } from './lots'

const cents = (n: number): number => Math.round(n * 100) / 100

/**
 * Recompute a purchase order's stored total from its lines plus freight, and
 * carry it to the COGS row keyed on the order.
 *
 * Moved here from purchaseOrders.ts, which now imports it, so the Inventory path
 * and the purchase-order path cannot disagree about what an order costs.
 *
 * A pending line carries a price of 0, so the header total is the KNOWN total
 * for free and agrees with `tabKnownTotal` without either side knowing about the
 * other.
 */
export function restateOrderTotal(db: Database, poId: string, ts: string): void {
  const all = db
    .prepare('SELECT quantity, unit_price FROM purchase_order_lines WHERE po_id = ?')
    .all(poId) as Array<{ quantity: number; unit_price: number }>
  const freightRow = db
    .prepare('SELECT shipping_cost FROM purchase_orders WHERE id = ?')
    .get(poId) as { shipping_cost: number | null } | undefined
  const freight = Math.max(0, Number(freightRow?.shipping_cost) || 0)
  const total = cents(
    all.reduce((sum, l) => sum + cents(Math.round(l.quantity) * Math.max(0, l.unit_price)), 0) +
      cents(freight)
  )
  db.prepare('UPDATE purchase_orders SET total = ?, updated_at = ? WHERE id = ?').run(total, ts, poId)
  db.prepare('UPDATE finance_cogs SET amount = ? WHERE po_id = ?').run(total, poId)
}

export interface CostPushBack {
  /** Purchase order lines that were given a price. */
  linesPriced: number
  /** Distinct orders whose total was recomputed. */
  ordersRestated: number
  /** Sale lines whose cost of goods was corrected off the old zero. */
  salesRestated: number
  /** The order numbers touched, for the message on screen. */
  poNumbers: string[]
}

interface BlankLineRow {
  po_line_id: string
  po_id: string
  po_number: string | null
  lot_id: string
  lot_cost: number
}

/**
 * Fill in every purchase order line for this product that is still blank, using
 * the cost of the layer its own receipt created.
 *
 * ## Why this is driven by the PRODUCT and not by "the layers I just changed"
 *
 * The first cut took a list of lot ids — the layers the caller had that moment
 * re-based from zero — and priced the lines behind them. It passed its tests and
 * DID NOT WORK ON THE OWNER'S DATA, which is the only test that counts:
 *
 *     after the old behaviour  : PO line $0 | layer $900 | PO total $0
 *     after re-typing the price: PO line $0 | layer $900 | PO total $0
 *
 * Everything he had already priced from the Inventory screen was in exactly that
 * state — layer costed, purchase order blank — and re-typing the price moved
 * NOTHING, because there was no longer a zero-cost layer to re-base, so the list
 * of lot ids came back empty and the push had nothing to push. The repair I told
 * him to use was a dead end for the very rows that needed it.
 *
 * The question is not "what did I just change". It is "which purchase order
 * lines are still blank, and what did the stock behind them actually cost". That
 * is answerable at any time, from the data as it stands, which is why this now
 * runs off the product and reaches rows priced long before the fix existed.
 *
 * THE PRICE COMES FROM THE LAYER, not from whatever the caller typed. A line
 * gets the cost of the units IT received. Where a product's layers came in at
 * different prices from different orders, handing every line the newest typed
 * figure would quietly restate what the older ones cost.
 *
 * The refusal is unchanged and is the thing that keeps this safe: a line that
 * already states a price is never touched. See the header.
 */
export function pushCostToPurchaseOrders(db: Database, productId: string, ts: string): CostPushBack {
  const empty: CostPushBack = { linesPriced: 0, ordersRestated: 0, salesRestated: 0, poNumbers: [] }
  if (!productId) return empty

  const rows = db
    .prepare(
      `SELECT r.po_line_id, r.po_id, po.po_number, r.lot_id, lot.unit_cost AS lot_cost
         FROM po_line_receipts r
         JOIN purchase_order_lines l ON l.id = r.po_line_id
         JOIN purchase_orders po ON po.id = r.po_id
         JOIN inventory_lots lot ON lot.id = r.lot_id
        WHERE l.product_id = ?
          AND lot.unit_cost > 0
          -- The refusal, in the query: a line that already states a price is not
          -- this operation's business. See the header.
          AND (COALESCE(l.price_pending, 0) = 1 OR COALESCE(l.unit_price, 0) <= 0)
        ORDER BY r.created_at ASC`
    )
    .all(productId) as BlankLineRow[]
  if (rows.length === 0) return empty

  const priceLine = db.prepare(
    `UPDATE purchase_order_lines SET unit_price = ?, price_pending = 0 WHERE id = ?`
  )
  const orders = new Map<string, string>()
  const linesDone = new Set<string>()
  let salesRestated = 0

  for (const r of rows) {
    const cost = Number(r.lot_cost)
    if (!(cost > 0)) continue
    if (!linesDone.has(r.po_line_id)) {
      priceLine.run(cost, r.po_line_id)
      linesDone.add(r.po_line_id)
    }
    orders.set(r.po_id, (r.po_number ?? '').trim())
    // WHAT HAS ALREADY LEFT THIS LAYER. Re-costing the lot fixes the stock still
    // on the shelf and leaves every sale drawn from it costed at the old zero.
    salesRestated += restateConsumedCost(db, r.lot_id, cost)
  }

  for (const poId of orders.keys()) restateOrderTotal(db, poId, ts)

  return {
    linesPriced: linesDone.size,
    ordersRestated: orders.size,
    salesRestated,
    poNumbers: [...orders.values()].filter(Boolean)
  }
}
