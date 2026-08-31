import type Database from 'better-sqlite3'
import { LOCATION_IDS, isLocation } from '@shared/inventory'
import type { WholesaleSaleRow } from '@shared/invoices'
import { newId, nowIso } from '../util'
import { bumpStock, insertTxn, stockQty } from './inventory'
import { buyShortfallAtShop } from './purchaseOrders'
import { recordOrderEvent } from './orderExtras'
import {
  allowsFractionalQty,
  consumeFifo,
  consumeFromPo,
  recordTxnLots,
  restoreFifo,
  roundQty,
  slicesCost,
  syncProductAvgCost,
  type LotSlice
} from './lots'

/**
 * A SALES ORDER IS A SALE, and this is the half that moves the shelf.
 *
 * ## What changed, and why it is not a fulfilment model any more
 *
 * A sales order used to be paperwork: it named products and quantities, and the
 * count on the shelf did not move until somebody scanned the boxes out against
 * it. That is right for a warehouse where writing an order and picking it are
 * days and two people apart. It is not how this business sells wholesale — the
 * owner writes the order because the boxes are going out, and every screen that
 * says how many are on hand has to agree with that immediately.
 *
 * So saving an order consumes FIFO cost layers exactly as `recordSale` does:
 * oldest first, the slices recorded against a real ledger transaction, the
 * product's average cost re-derived. Six on the shelf and a sale of four leaves
 * two, on the dashboard, in the catalog and in the valuation, the moment Save is
 * pressed.
 *
 * ## Release-then-apply, on every save
 *
 * An order is edited: a quantity changes, a line is added, a product is swapped.
 * Rather than work out the delta per line — which is where an off-by-one becomes
 * a box that does not exist — every save hands back everything the order took
 * and then takes what it now needs. `restoreFifo` puts units back into the exact
 * layers they came from, so the re-take walks the same FIFO order and lands on
 * the same layers at the same costs. The result is identical to a delta and
 * cannot drift.
 *
 * It is all inside the caller's transaction, so a failure anywhere leaves the
 * order and the shelf exactly as they were.
 *
 * ## The scan-out flow
 *
 * `saveInvoice` marks every product line fully fulfilled, because the stock HAS
 * left. `outstandingSalesLinesForProduct` filters on `qty_fulfilled < quantity`,
 * so those lines stop being offered to the scanner — which is the point. Two
 * things taking the same boxes off the same shelf is the failure this replaces,
 * not a feature it keeps.
 */

/**
 * One SLICE of a product line, as the stock side needs it.
 *
 * A slice, not a line, since a line may be split by quantity: "eight off RM out
 * of PO-0042, two shipped direct by Kestrel" is one line and one entry here, the
 * dropship half having been filtered out before it got this far. An unsplit line
 * is one slice carrying its whole quantity, which is every line written before
 * splits existed. See stockDrawingLines, which is the only thing that builds
 * these, and @shared/invoiceAllocations for the rule it applies.
 */
export interface InvoiceStockLine {
  position: number
  /**
   * Which slice this is, when the line was split. Null on an unsplit line.
   *
   * Carried so the move row can name it. Two slices of one line share a
   * position, so position alone stopped being a unique answer the moment splits
   * landed — and a map keyed on it would silently keep one of the two.
   */
  allocationId?: string | null
  productId: string
  quantity: number
  /**
   * WHICH SHELF, when the slice names one of its own.
   *
   * Absent means the order's location, which is what every caller passed before
   * a line could carry a destination at all. A split saying "six off RM, four
   * off AM" needs the difference: handing the header's shelf to both would take
   * ten off one of them and leave the other untouched.
   */
  location?: string | null
  /**
   * The purchase order these particular units came out of, when the operator
   * said so. Null on every ordinary line, which walks FIFO exactly as it always
   * has — see consumeFromPo for why a roadshow order needs the difference.
   */
  sourcePoId?: string | null
}

/**
 * The order's number, for a refusal somebody can act on.
 *
 * `consumeFromPo` throws with a sentence naming the order, and an id in that
 * sentence is a sentence nobody can use. Read here rather than threaded through
 * every caller because it is needed only when a line names an order, which is
 * the rare case, and it costs one read on exactly those lines.
 */
function poNumberOf(db: Database.Database, poId: string): string {
  try {
    const row = db.prepare('SELECT po_number FROM purchase_orders WHERE id = ?').get(poId) as
      | { po_number: string | null }
      | undefined
    return (row?.po_number ?? '').trim()
  } catch {
    return ''
  }
}

/** What one slice took, for the receipt and for the Wholesale report. */
export interface InvoiceStockMove {
  position: number
  /** The slice it was taken for, or null on an unsplit line. */
  allocationId: string | null
  productId: string
  location: string
  quantity: number
  costTotal: number
}

/**
 * Which shelf a sales order sells from.
 *
 * The order's own location when it names one, RM otherwise — the same default
 * `createPurchaseOrder` applies on the buy side, and for the same reason: the
 * overwhelming majority of what this business ships goes out of the main room,
 * and an order that never had the field filled in is one of those.
 *
 * A destination that is NOT a shelf (a dropship stop, a shop's name) falls back
 * to RM as well. `isLocation` is the only thing that decides what a shelf is;
 * consuming against a customer's name would open a phantom stock row keyed to
 * it, which is the failure the v67 note in database.ts describes at length.
 */
export function invoiceStockLocation(location: string | null | undefined): string {
  const wanted = (location ?? '').trim()
  return isLocation(wanted) ? wanted : LOCATION_IDS[0]
}

/**
 * Everything this order currently holds against the shelf, put back.
 *
 * Returns how many moves were released, which the caller uses only for
 * diagnostics — the operation is unconditional and idempotent, so an order that
 * has taken nothing releases nothing and reports zero.
 *
 * A move with no `txn_id` is a legacy row written by the v68 backfill: it
 * records that the units are gone without being able to say which layers they
 * came from, because they left through a scan months before this table existed.
 * Its quantity is NOT handed back, and that is the honest answer rather than a
 * gap — inventing layers for it would put stock on a shelf that nobody has.
 *
 * MUST be called inside the caller's db.transaction().
 */
export function releaseInvoiceStock(db: Database.Database, invoiceId: string): number {
  const moves = db
    .prepare(
      `SELECT id, product_id, location, quantity, txn_id
         FROM invoice_stock_moves WHERE invoice_id = ?`
    )
    .all(invoiceId) as Array<{
    id: string
    product_id: string
    location: string
    quantity: number
    txn_id: string | null
  }>
  if (moves.length === 0) return 0

  const readSlices = db.prepare(
    'SELECT lot_id, quantity, unit_cost FROM inventory_txn_lots WHERE txn_id = ?'
  )
  const touched = new Set<string>()
  for (const move of moves) {
    if (!move.txn_id) continue
    const rows = readSlices.all(move.txn_id) as Array<{
      lot_id: string
      quantity: number
      unit_cost: number
    }>
    const slices: LotSlice[] = rows.map((r) => ({
      lotId: r.lot_id,
      qty: r.quantity,
      unitCost: r.unit_cost
    }))
    // The layers first, then the shelf. Both or neither: restoreFifo throws
    // rather than clamping when a restore would overfill a layer, and that throw
    // has to take the stock bump with it.
    restoreFifo(db, slices)
    bumpStock(move.product_id, move.location, move.quantity)
    // The ledger row and its slices go with the units. A sale that is being
    // unwound is not a sale that happened, and leaving the transaction behind
    // would double every Wholesale figure the next time the order was saved.
    db.prepare('DELETE FROM inventory_txn_lots WHERE txn_id = ?').run(move.txn_id)
    db.prepare('DELETE FROM inventory_transactions WHERE id = ?').run(move.txn_id)
    touched.add(move.product_id)
  }
  db.prepare('DELETE FROM invoice_stock_moves WHERE invoice_id = ?').run(invoiceId)
  for (const productId of touched) syncProductAvgCost(db, productId)
  return moves.length
}

/**
 * Take the order's stock off the shelf and write the receipt.
 *
 * One ledger transaction per SLICE rather than per product, because the
 * Wholesale report is a line-by-line margin and an order may list the same box
 * twice at two prices. Rolling those into one transaction would give both lines
 * a cost that is neither of theirs.
 *
 * A slice is a whole unsplit line on nearly every order. A line split by
 * quantity contributes one entry per stock slice, so "six out of PO-0042 and
 * four ordinary FIFO" writes two transactions and two moves at different costs —
 * which is the honest answer, and the reason the move row names the allocation.
 *
 * ## A short shelf CLAMPS; it does not refuse
 *
 * The first version threw, on the reasoning `recordSale` uses: you cannot sell
 * what you do not have. That reasoning is right for a counter sale and wrong
 * here, because a sales order is also the thing somebody writes the day BEFORE
 * the pallet lands. Refusing the save would mean the only way to record an
 * agreed order is to wait for the boxes, and the work would be typed into a
 * notebook instead.
 *
 * So a line takes what is on the shelf and no more. Four sold against six on
 * hand takes four. Ten sold against six takes six, and the other four stay
 * outstanding on the line — which is exactly the state the scan-out flow already
 * understands, so the remainder goes out the moment the stock arrives and
 * somebody scans it, or on the next save of the order once it is on the shelf.
 * Nothing is ever invented and nothing goes negative.
 *
 * The clamp is re-read PER SLICE, so two lines of the same product against one
 * short shelf split what there is in line order rather than both claiming it —
 * and so do two stock slices of the SAME line.
 *
 * MUST be called inside the caller's db.transaction().
 */
export function applyInvoiceStock(
  db: Database.Database,
  invoiceId: string,
  invoiceNumber: string | null,
  customerName: string | null,
  lines: readonly InvoiceStockLine[],
  location: string,
  actorId: string | null
): InvoiceStockMove[] {
  const stamp = nowIso()
  const insertMove = db.prepare(
    `INSERT INTO invoice_stock_moves
       (id, invoice_id, line_position, allocation_id, product_id, location, quantity,
        cost_total, txn_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const out: InvoiceStockMove[] = []
  const touched = new Set<string>()
  /** What this save had to buy at a shop to fill itself. See buyShortfallAtShop. */
  const shopBuys: Array<{ shop: string; units: number }> = []

  for (const line of lines) {
    // THE SLICE'S OWN SHELF WHEN IT NAMES ONE. Only a split line ever does; an
    // unsplit line leaves it absent and gets the order's location, which is the
    // only thing this function had before.
    const shelf = isLocation((line.location ?? '').trim())
      ? (line.location as string).trim()
      : location
    const fractional = allowsFractionalQty(db, line.productId)
    const asked = roundQty(line.quantity, fractional)
    if (!(asked > 0)) continue
    // What the shelf can actually give, read fresh so two lines of the same
    // product cannot both claim the last box.
    let have = roundQty(Math.max(0, stockQty(line.productId, shelf)), fractional)
    const fromPo = (line.sourcePoId ?? '').trim()
    /**
     * SHORT AT A ROADSHOW SHOP MEANS "BOUGHT AND NOT WRITTEN DOWN YET".
     *
     * Everywhere else a short shelf is a real shortfall and the clamp below is
     * the honest answer: the boxes are not in the building, and the rest of the
     * line stays owed. At one of the four shops it means something different,
     * because the person writing this sale is standing next to the goods — they
     * bought the case a minute ago and are selling it now. See
     * buyShortfallAtShop, which is where the rule and its limits live.
     *
     * Deliberately NOT done for a line that names a purchase order. That line is
     * a claim about WHICH units — "six of PO-0042's cases" — and buying more to
     * satisfy it would be answering a question nobody asked; consumeFromPo
     * refuses instead, which is right.
     *
     * The shelf is re-read afterwards rather than assumed, so a buy that was
     * refused for any reason leaves the ordinary clamp in charge and the line
     * simply stays short.
     */
    if (!fromPo && asked > have) {
      const bought = buyShortfallAtShop(db, line.productId, shelf, asked - have, actorId)
      if (bought > 0) {
        have = roundQty(Math.max(0, stockQty(line.productId, shelf)), fractional)
        shopBuys.push({ shop: shelf, units: bought })
      }
    }
    /**
     * A LINE THAT NAMES AN ORDER IS NOT TRIMMED TO THE SHELF.
     *
     * The clamp above exists so a sale of six against a shelf holding four
     * books four rather than throwing — a deliberate leniency on the ordinary
     * path, where the operator asked for stock and the shelf is the answer.
     *
     * It is the wrong leniency here. "Six of PO-0042's cases" is a claim about
     * WHICH units, and quietly booking four of them would leave the document
     * saying six while two were never sold and nothing said so. So a named line
     * asks for exactly what it says and consumeFromPo refuses if that order
     * cannot cover it.
     */
    const qty = fromPo ? asked : Math.min(asked, have)
    if (!(qty > 0)) continue

    // The shelf first, then the layers — the same order recordSale uses, so a
    // layer shortfall throws with the stock already decremented inside a
    // transaction that is about to roll back.
    bumpStock(line.productId, shelf, -qty)
    const slices = fromPo
      ? consumeFromPo(db, line.productId, shelf, qty, fromPo, poNumberOf(db, fromPo))
      : consumeFifo(db, line.productId, shelf, qty)
    const cost = slicesCost(slices)

    // A real ledger row, of the same type and shape a counter sale writes. It is
    // what the activity feed, the valuation and the P&L already know how to
    // read, and it is what carries the slices.
    const txnId = insertTxn(
      line.productId,
      'sale',
      -qty,
      null,
      customerName,
      invoiceNumber ? `Sales order ${invoiceNumber}` : 'Sales order',
      actorId,
      shelf,
      cost
    )
    recordTxnLots(db, txnId, slices, false)
    insertMove.run(
      newId(),
      invoiceId,
      line.position,
      line.allocationId ?? null,
      line.productId,
      shelf,
      qty,
      cost,
      txnId,
      stamp
    )
    out.push({
      position: line.position,
      allocationId: line.allocationId ?? null,
      productId: line.productId,
      location: shelf,
      quantity: qty,
      costTotal: cost
    })
    touched.add(line.productId)
  }

  for (const productId of touched) syncProductAvgCost(db, productId)
  /**
   * SAY WHAT THIS SALE BOUGHT, on the sale.
   *
   * Filling a line by buying at a shop creates a real liability — a case we now
   * owe a shop for — and it happens as a SIDE EFFECT of saving a sales order.
   * An effect like that must not be silent, or the first anybody knows of it is
   * an unexplained line on a week's bill.
   *
   * One entry per shop rather than per line, because two lines filled at the
   * same counter are one trip and one act. It reads back on the order's own
   * history, next to everything else that happened to it.
   */
  if (shopBuys.length > 0) {
    const byShop = new Map<string, number>()
    for (const b of shopBuys) byShop.set(b.shop, (byShop.get(b.shop) ?? 0) + b.units)
    for (const [shop, units] of byShop) {
      recordOrderEvent('so', invoiceId, 'link', {
        detail:
          `Bought ${units} unit${units === 1 ? '' : 's'} at ${shop} to fill this order — ` +
          'on that shop’s open tab, at a price still to be entered.',
        actorId,
        db
      })
    }
  }
  return out
}

/**
 * One row per product line sold on a sales order — the Wholesale report.
 *
 * ## What each row is
 *
 * The units that ACTUALLY LEFT (the move's quantity, not the line's), what they
 * were sold for at the line's rate, and what those exact FIFO layers cost. The
 * margin is the subtraction, done once, here.
 *
 * Revenue is `quantity × rate` rather than the line's stored `amount`, and the
 * two differ in one case that matters: a line for ten against a shelf of six
 * moved six, so its revenue on this report is six units' worth. Using the stored
 * amount would report the whole order's price against part of its cost and show
 * a margin that is not real. The four that have not gone appear here on the day
 * they do.
 *
 * ## What is left out, and why
 *
 * VOID ORDERS. Voiding releases the stock, so a void order has no moves left to
 * join to — the exclusion below is belt and braces rather than the mechanism.
 *
 * A SPLIT LINE APPEARS ONCE PER STOCK SLICE, joined to the same line and so
 * reported at the same rate. That is deliberate: the two halves came off the
 * shelf at different costs — one out of a named purchase order, one walking
 * ordinary FIFO — so they are two margins, and rolling them into one row would
 * report an average nobody made. Revenue still sums to the line's, because each
 * row is its own quantity × the shared rate.
 *
 * LEGACY ROWS COST NOTHING. A move written by the v68 backfill records units
 * that left through a scan before this table existed, and their layers are not
 * knowable from here. `cost_total` is 0, so the row reports its revenue and a
 * margin equal to it. Flagged rather than hidden — `costKnown` is false on those
 * rows so the screen can mark them instead of quietly overstating the month.
 *
 * ## AND ROWS WHOSE COST HAS NOT BEEN SAID YET, which is a different zero
 *
 * A roadshow case is bought on a tab at a price nobody knows and can be sold the
 * same afternoon — that is the ordinary shape of a shop, not an edge case, and
 * `buyShortAtShop` produces it without anybody choosing to. Its layer opens at
 * zero, so the sale landed here reporting the whole sale price as margin.
 *
 * That zero reads exactly like a legacy one and is the opposite of it: the layer
 * is right there and the figure is coming. So it gets its own flag, found by
 * walking the slices this move consumed back to the purchase-order line that
 * opened them and asking whether that line is still price-pending. The screen
 * holds it out of the margin totals — a cost of nothing counted as a cost is the
 * one failure this report must not have — and names the tab to go and price.
 *
 * IT CLEARS ITSELF. `setPurchaseOrderLinePrice` re-costs the layer AND the sales
 * already drawn from it (see restateConsumedCost), which writes the real figure
 * into `cost_total` on the very rows below. Nothing here is re-derived on the
 * fly, so what this reports and what the ledger holds cannot drift.
 */

export function listWholesaleSales(db: Database.Database, limit = 500): WholesaleSaleRow[] {
  const rows = db
    .prepare(
      `SELECT m.invoice_id, m.product_id, m.location, m.quantity, m.cost_total, m.txn_id,
              i.invoice_number, i.invoice_date, i.customer_name, i.status,
              l.rate, l.item,
              p.name AS product_name, p.sku AS product_sku,
              -- The tab still owing a price on one of the layers these units
              -- came off, or NULL when every layer has a real figure on it.
              -- MIN because a move can walk several layers and one name is what
              -- the screen has room for; the smallest number is the oldest tab,
              -- which is the one that has been waiting longest.
              (SELECT MIN(pend_po.po_number)
                 FROM inventory_txn_lots pend_tl
                 JOIN po_line_receipts pend_r ON pend_r.lot_id = pend_tl.lot_id
                 JOIN purchase_order_lines pend_l ON pend_l.id = pend_r.po_line_id
                 JOIN purchase_orders pend_po ON pend_po.id = pend_l.po_id
                WHERE pend_tl.txn_id = m.txn_id
                  AND pend_l.price_pending = 1) AS pending_po
         FROM invoice_stock_moves m
         JOIN invoices i ON i.id = m.invoice_id
         LEFT JOIN invoice_lines l
           ON l.invoice_id = m.invoice_id AND l.position = m.line_position
         LEFT JOIN inventory_products p ON p.id = m.product_id
        WHERE i.status <> 'void' AND m.quantity > 0
        ORDER BY i.invoice_date DESC, i.invoice_number DESC, m.line_position ASC
        LIMIT ?`
    )
    .all(Math.max(1, Math.min(5000, limit))) as Array<{
    invoice_id: string
    product_id: string
    location: string
    quantity: number
    cost_total: number
    txn_id: string | null
    invoice_number: string | null
    invoice_date: string
    customer_name: string | null
    status: string
    rate: number | null
    item: string | null
    product_name: string | null
    product_sku: string | null
    pending_po: string | null
  }>

  return rows.map((r) => {
    const unitPrice = Number(r.rate ?? 0)
    const revenue = Math.round(r.quantity * unitPrice * 100) / 100
    const cost = Math.round(Number(r.cost_total ?? 0) * 100) / 100
    return {
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number ?? '',
      invoiceDate: r.invoice_date,
      customerName: r.customer_name ?? '',
      status: r.status,
      productId: r.product_id,
      productName: r.product_name ?? r.item ?? 'Unknown product',
      sku: r.product_sku ?? '',
      location: r.location,
      quantity: r.quantity,
      unitPrice,
      revenue,
      cost,
      margin: Math.round((revenue - cost) * 100) / 100,
      costKnown: !!r.txn_id,
      costPending: !!r.pending_po,
      pendingPoNumber: r.pending_po ?? null
    }
  })
}
