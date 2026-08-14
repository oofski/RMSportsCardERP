import type Database from 'better-sqlite3'
import { LOCATION_IDS, isLocation } from '@shared/inventory'
import type { WholesaleSaleRow } from '@shared/invoices'
import { newId, nowIso } from '../util'
import { bumpStock, insertTxn, stockQty } from './inventory'
import {
  allowsFractionalQty,
  consumeFifo,
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

/** One product line's worth of an order, as the stock side needs it. */
export interface InvoiceStockLine {
  position: number
  productId: string
  quantity: number
}

/** What one line took, for the receipt and for the Wholesale report. */
export interface InvoiceStockMove {
  position: number
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
 * One ledger transaction per LINE rather than per product, because the Wholesale
 * report is a line-by-line margin and an order may list the same box twice at
 * two prices. Rolling those into one transaction would give both lines a cost
 * that is neither of theirs.
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
 * The clamp is re-read PER LINE, so two lines of the same product against one
 * short shelf split what there is in line order rather than both claiming it.
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
       (id, invoice_id, line_position, product_id, location, quantity, cost_total, txn_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const out: InvoiceStockMove[] = []
  const touched = new Set<string>()

  for (const line of lines) {
    const fractional = allowsFractionalQty(db, line.productId)
    const asked = roundQty(line.quantity, fractional)
    if (!(asked > 0)) continue
    // What the shelf can actually give, read fresh so two lines of the same
    // product cannot both claim the last box.
    const have = roundQty(Math.max(0, stockQty(line.productId, location)), fractional)
    const qty = Math.min(asked, have)
    if (!(qty > 0)) continue

    // The shelf first, then the layers — the same order recordSale uses, so a
    // layer shortfall throws with the stock already decremented inside a
    // transaction that is about to roll back.
    bumpStock(line.productId, location, -qty)
    const slices = consumeFifo(db, line.productId, location, qty)
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
      location,
      cost
    )
    recordTxnLots(db, txnId, slices, false)
    insertMove.run(
      newId(),
      invoiceId,
      line.position,
      line.productId,
      location,
      qty,
      cost,
      txnId,
      stamp
    )
    out.push({
      position: line.position,
      productId: line.productId,
      location,
      quantity: qty,
      costTotal: cost
    })
    touched.add(line.productId)
  }

  for (const productId of touched) syncProductAvgCost(db, productId)
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
 * LEGACY ROWS COST NOTHING. A move written by the v68 backfill records units
 * that left through a scan before this table existed, and their layers are not
 * knowable from here. `cost_total` is 0, so the row reports its revenue and a
 * margin equal to it. Flagged rather than hidden — `costKnown` is false on those
 * rows so the screen can mark them instead of quietly overstating the month.
 */

export function listWholesaleSales(db: Database.Database, limit = 500): WholesaleSaleRow[] {
  const rows = db
    .prepare(
      `SELECT m.invoice_id, m.product_id, m.location, m.quantity, m.cost_total, m.txn_id,
              i.invoice_number, i.invoice_date, i.customer_name, i.status,
              l.rate, l.item,
              p.name AS product_name, p.sku AS product_sku
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
      costKnown: !!r.txn_id
    }
  })
}
