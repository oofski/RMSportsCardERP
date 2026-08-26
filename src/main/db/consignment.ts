/**
 * Sending stock out on consignment, and getting it back.
 *
 * ## The whole design, in one sentence
 *
 * A consignment CONSUMES THE COST LOTS, exactly as a break or a giveaway does,
 * and remembers which layers it took — so the units are not on the shelf, not in
 * any lot, and therefore cannot be sold, cannot be broken on a stream and cannot
 * be scanned out, without one line being added to any of those paths.
 *
 * That is worth being explicit about, because the alternative is what most
 * codebases do: a `consigned` flag on the product, plus a guard in
 * `applyInvoiceStock`, plus a guard in the stream's addItem, plus a guard in the
 * scan queue, plus the one somebody adds next year and forgets — and the one
 * that gets missed is the one that quietly bills a customer for a case sitting
 * in another shop.
 *
 * See @shared/consignment for the contract and the three ways it ends.
 *
 * ## Two invariants this file must not break
 *
 * `Σ lot.qty_remaining == inventory_stock.quantity` for every (product,
 * location) — the invariant the whole FIFO engine rests on, checked by
 * `assertStockLotsConsistent`. Every path here moves BOTH sides together:
 * consumeFifo/restoreFifo for the layers, bumpStock for the balance.
 *
 * And the ledger stays APPEND-ONLY. A return does not delete the sending entry;
 * it writes the opposite one, so either column sums to zero over a round trip.
 */

import { randomUUID } from 'crypto'
import {
  asConsignmentStatus,
  canSettleConsignment,
  settleRefusal,
  validateConsignment,
  type Consignment,
  type NewConsignment
} from '@shared/consignment'
import { getDb } from './database'
import { bumpStock, insertTxn, stockQty } from './inventory'
import { consumeFifo, restoreFifo, slicesCost, syncProductAvgCost, unitMoney } from './lots'

const newId = (): string => randomUUID()
const nowIso = (): string => new Date().toISOString()
const clean = (v: unknown): string => String(v ?? '').trim()

interface Row {
  id: string
  product_id: string | null
  product_name: string
  sku: string
  category: string
  consignee: string
  location: string
  quantity: number
  unit_cost: number
  cost_total: number
  status: string
  sent_at: string
  sent_by: string | null
  settled_at: string | null
  settled_by: string | null
  note: string | null
  created_at: string
  updated_at: string
}

function toConsignment(r: Row): Consignment {
  return {
    id: r.id,
    productId: r.product_id ?? null,
    productName: r.product_name,
    sku: r.sku ?? '',
    category: r.category ?? '',
    consignee: r.consignee,
    location: r.location,
    quantity: Number(r.quantity) || 0,
    unitCost: Number(r.unit_cost) || 0,
    costTotal: Number(r.cost_total) || 0,
    status: asConsignmentStatus(r.status),
    sentAt: r.sent_at,
    sentBy: r.sent_by ?? null,
    settledAt: r.settled_at ?? null,
    settledBy: r.settled_by ?? null,
    note: r.note ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

const COLS = `id, product_id, product_name, sku, category, consignee, location, quantity,
              unit_cost, cost_total, status, sent_at, sent_by, settled_at, settled_by,
              note, created_at, updated_at`

/**
 * Hand units to somebody to sell for us.
 *
 * ## Validated against THIS shelf, not the product
 *
 * A case at AM is not something RM can send. Without the location in the test,
 * an over-send would get as far as `consumeFifo` and throw with a message about
 * cost lots — accurate, and meaningless to somebody holding a box.
 *
 * ## The name is a STRING, not a record
 *
 * Same rule a purchase order's supplier follows. A one-off consignment to a shop
 * that is not in the directory yet must not require a detour into a contacts
 * screen first; the picker offers everybody already known and takes anything
 * else typed.
 */
export function sendOnConsignment(
  input: NewConsignment,
  actorId: string | null
): { consignment: Consignment | null; error?: string } {
  const db = getDb()
  const productId = clean(input?.productId)
  const location = clean(input?.location)
  const product = db
    .prepare(`SELECT id, name, sku, category FROM inventory_products WHERE id = ?`)
    .get(productId) as { id: string; name: string; sku: string; category: string } | undefined
  if (!product) return { consignment: null, error: 'That product is gone.' }

  const problem = validateConsignment(
    { ...input, productId, location },
    stockQty(productId, location)
  )
  if (problem) return { consignment: null, error: problem }

  const qty = Number(input.quantity)
  const run = db.transaction((): Consignment => {
    // THE LAYERS FIRST. It throws if they cannot cover the ask, which rolls the
    // whole transaction back — including the row below — so a consignment can
    // never exist for units that never left.
    const slices = consumeFifo(db, productId, location, qty)
    const cost = slicesCost(slices)
    bumpStock(productId, location, -qty)
    syncProductAvgCost(db, productId)

    const id = newId()
    const stamp = nowIso()
    db.prepare(
      `INSERT INTO consignments
         (${COLS})
       VALUES (@id, @product_id, @product_name, @sku, @category, @consignee, @location,
               @quantity, @unit_cost, @cost_total, 'out', @sent_at, @sent_by,
               NULL, NULL, @note, @created_at, @updated_at)`
    ).run({
      id,
      product_id: productId,
      product_name: product.name,
      sku: product.sku ?? '',
      category: product.category ?? '',
      consignee: clean(input.consignee),
      location,
      quantity: qty,
      // Per unit off the layers actually consumed — never the product's average,
      // which is a derived reference figure and not what these units cost.
      unit_cost: qty > 0 ? unitMoney(cost / qty) : 0,
      cost_total: cost,
      sent_at: stamp,
      sent_by: actorId,
      note: clean(input.note) || null,
      created_at: stamp,
      updated_at: stamp
    })

    const putLot = db.prepare(
      `INSERT INTO consignment_lots (id, consignment_id, lot_id, quantity, unit_cost)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const s of slices) putLot.run(newId(), id, s.lotId, s.qty, s.unitCost)

    // The stock ledger stays the one complete account of what happened to a
    // product. An adjustment rather than a sale: no money changed hands, and
    // recording it as revenue would put a sale in the P&L that nobody made.
    insertTxn(
      productId,
      'adjustment',
      -qty,
      null,
      clean(input.consignee),
      `Sent on consignment to ${clean(input.consignee)}`,
      actorId,
      location,
      cost
    )

    return toConsignment(
      db.prepare(`SELECT ${COLS} FROM consignments WHERE id = ?`).get(id) as Row
    )
  })
  return { consignment: run() }
}

/**
 * It came back unsold, or they sold it.
 *
 * RETURNED PUTS THE EXACT LAYERS BACK. `restoreFifo` writes the quantity into
 * the very lot rows it came out of, so the shelf's cost basis and its FIFO order
 * are what they would have been had the case never gone — which is the reason
 * consignment_lots exists at all. Re-costing a return at today's average would
 * be a different number, and a shelf that quietly changed value while a box sat
 * in a van.
 *
 * SOLD MOVES NO STOCK. The case is genuinely gone; its cost left the shelf when
 * it was sent and stays gone. What the consignee owes is a conversation about
 * money, and this app does not invent a settlement it has never been given the
 * terms of.
 *
 * ## Refused on anything already settled
 *
 * A second return would put a second copy of the units on the shelf — inventing
 * stock out of a double click. Checked here as well as in the shared rule,
 * because a screen is not a gate.
 */
export function settleConsignment(
  id: string,
  outcome: 'returned' | 'sold',
  actorId: string | null
): { consignment: Consignment | null; error?: string } {
  const db = getDb()
  const row = db.prepare(`SELECT ${COLS} FROM consignments WHERE id = ?`).get(clean(id)) as
    | Row
    | undefined
  if (!row) return { consignment: null, error: 'That consignment is gone.' }
  const current = asConsignmentStatus(row.status)
  if (!canSettleConsignment(current)) {
    return { consignment: toConsignment(row), error: settleRefusal(current) ?? 'Already settled.' }
  }

  const run = db.transaction((): Consignment => {
    const stamp = nowIso()
    if (outcome === 'returned' && row.product_id) {
      // The product may have been deleted while the case was out. Putting units
      // back for something that is no longer in the catalog would invent stock
      // nobody can sell — the same judgement removeStreamItem makes.
      const stillCataloged = !!db
        .prepare(`SELECT 1 FROM inventory_products WHERE id = ?`)
        .get(row.product_id)
      if (stillCataloged) {
        const slices = db
          .prepare(
            `SELECT lot_id, quantity, unit_cost FROM consignment_lots WHERE consignment_id = ?`
          )
          .all(row.id) as Array<{ lot_id: string; quantity: number; unit_cost: number }>
        restoreFifo(
          db,
          slices.map((s) => ({ lotId: s.lot_id, qty: s.quantity, unitCost: s.unit_cost }))
        )
        bumpStock(row.product_id, row.location, row.quantity)
        syncProductAvgCost(db, row.product_id)
        insertTxn(
          row.product_id,
          'adjustment',
          row.quantity,
          null,
          row.consignee,
          `Returned from consignment with ${row.consignee}`,
          actorId,
          row.location,
          row.cost_total
        )
      }
    }
    db.prepare(
      `UPDATE consignments
          SET status = ?, settled_at = ?, settled_by = ?, updated_at = ?
        WHERE id = ?`
    ).run(outcome, stamp, actorId, stamp, row.id)
    return toConsignment(
      db.prepare(`SELECT ${COLS} FROM consignments WHERE id = ?`).get(row.id) as Row
    )
  })
  return { consignment: run() }
}

/**
 * Everything ever consigned for one product, newest first.
 *
 * Settled rows are INCLUDED. "This case went to Fenwick in March and came back
 * in April" is the history somebody opens this panel for, and a list that
 * silently dropped everything but the open ones would answer a narrower question
 * than the one being asked. The screen sums only the open ones — see
 * consignedUnits.
 */
export function consignmentsForProduct(productId: string): Consignment[] {
  return (
    getDb()
      .prepare(
        `SELECT ${COLS} FROM consignments
          WHERE product_id = ?
          ORDER BY sent_at DESC, rowid DESC`
      )
      .all(clean(productId)) as Row[]
  ).map(toConsignment)
}

/**
 * Everything still out, across the catalog — what somebody else is holding.
 *
 * Oldest first, because that is the order it becomes worth chasing in: a case
 * that went out in January is the one to ask about.
 */
export function listOpenConsignments(limit = 500): Consignment[] {
  return (
    getDb()
      .prepare(
        `SELECT ${COLS} FROM consignments
          WHERE status = 'out'
          ORDER BY sent_at ASC, rowid ASC
          LIMIT ?`
      )
      .all(Math.max(1, Math.min(2000, limit))) as Row[]
  ).map(toConsignment)
}

/**
 * How many units of each product are out, keyed by product id.
 *
 * ONE READ FOR A WHOLE CATALOG PAGE. The products table can be showing fifty
 * rows and each of them wants to say whether any of it is with somebody else; a
 * per-row query would be fifty round trips to answer one question.
 */
export function consignedUnitsByProduct(): Record<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT product_id, SUM(quantity) AS n FROM consignments
        WHERE status = 'out' AND product_id IS NOT NULL
        GROUP BY product_id`
    )
    .all() as Array<{ product_id: string; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.product_id] = Number(r.n) || 0
  return out
}
