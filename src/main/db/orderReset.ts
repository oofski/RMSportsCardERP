import type {
  OrderResetInput,
  OrderResetPreview,
  OrderResetResult
} from '@shared/orderReset'
import type { Result } from '@shared/types'
import { DEAL_TICKET_FLOOR } from '@shared/dealTickets'
import { getDb, setMeta } from './database'

/**
 * Deleting every order the business has raised.
 *
 * See @shared/orderReset for what this is for and — more to the point — what it
 * deliberately does not do. The short version: the documents go, the SHELF
 * STAYS, and it travels to every machine that syncs.
 *
 * ## Why so much is deleted by hand
 *
 * Three groups, and only one looks after itself.
 *
 * CASCADING: purchase_order_lines, po_unit_destinations and
 * invoice_stock_moves go with their order.
 *
 * PAIR-REFERENCED, so nothing cascades: order_events, order_shipments,
 * order_shipment_lines, order_documents and deal_tickets name an order by two
 * columns — a kind and an id — with no foreign key, because SQLite cannot
 * express a reference whose target table depends on a sibling column.
 *
 * AND `invoice_lines`, WHICH HAS NO FOREIGN KEY AT ALL. Not a cascade, nothing
 * — while its purchase-side counterpart has one, which is exactly how it came
 * to be missed here first time round. The suite asserts on both sides now.
 *
 * What is left behind is not harmless: a document row still carries its label's
 * bytes, and every orphan still syncs.
 */

const COUNT = (sql: string): number => {
  try {
    const r = getDb().prepare(sql).get() as { n: number } | undefined
    return Number(r?.n) || 0
  } catch {
    return 0
  }
}

/**
 * What a reset would remove.
 *
 * Counted rather than estimated, and counted from the same tables the delete
 * empties, so the number on the confirmation is the number that goes. A preview
 * derived differently from the thing it previews is how somebody comes to press
 * a button expecting one order to disappear and losing four hundred.
 */
export function previewOrderReset(): OrderResetPreview {
  return {
    purchaseOrders: COUNT(`SELECT COUNT(*) AS n FROM purchase_orders`),
    salesOrders: COUNT(`SELECT COUNT(*) AS n FROM invoices`),
    dealTickets: COUNT(`SELECT COUNT(*) AS n FROM deal_tickets`),
    events: COUNT(`SELECT COUNT(*) AS n FROM order_events`),
    shipments: COUNT(`SELECT COUNT(*) AS n FROM order_shipments`),
    documents: COUNT(`SELECT COUNT(*) AS n FROM order_documents`),
    // The ones Intuit keeps whatever happens here. Stated up front, because
    // "our copy is gone and theirs is not" is a permanent disagreement and the
    // moment to learn about it is before, not during a reconciliation.
    inQuickBooks: COUNT(
      `SELECT COUNT(*) AS n FROM invoices WHERE qbo_id IS NOT NULL AND qbo_id != ''`
    ),
    // NOT deleted, and counted so the screen can say so in units rather than in
    // a promise. The commonest fear about a button like this is that it empties
    // the warehouse.
    stockUnitsKept: COUNT(`SELECT COALESCE(SUM(quantity), 0) AS n FROM inventory_stock`)
  }
}

/**
 * Do it.
 *
 * ONE TRANSACTION. A reset that stopped halfway would leave orders whose lines
 * are gone and tickets pointing at documents that are not there — a state no
 * screen in this app is written to survive, and one nobody could reason about
 * afterwards. Either the boards are empty or nothing moved.
 */
export function applyOrderReset(
  input: OrderResetInput,
  actorId: string | null
): Result<OrderResetResult> {
  const db = getDb()
  const before = previewOrderReset()
  const restart = input.restartNumbering === true

  try {
    const run = db.transaction(() => {
      // The pair-referenced attachments first, while their orders still exist —
      // not because anything enforces it, but because a half-applied reset read
      // in the debugger should look like "orders with nothing hanging off them"
      // rather than "orphans with no orders".
      for (const table of [
        'order_shipment_lines',
        'order_shipments',
        'order_documents',
        'order_events',
        'deal_tickets'
      ]) {
        db.prepare(`DELETE FROM ${table}`).run()
      }

      // INVOICE LINES HAVE NO FOREIGN KEY AT ALL — not a cascade, nothing. Their
      // purchase-side counterpart does, which is exactly why this was missed
      // first time round and why the suite asserts on both: deleting the
      // invoices alone left every line behind, in a table nothing lists and
      // nothing can clean, still syncing.
      db.prepare(`DELETE FROM invoice_lines`).run()

      // Then the documents. invoice_stock_moves, purchase_order_lines and
      // po_unit_destinations DO cascade and go with them.
      //
      // NOTHING RESTORES STOCK HERE, and that is the decision this whole
      // feature rests on. deleteInvoice hands its units back because deleting
      // ONE sale means it did not happen; doing that for every sale ever made
      // would put every unit ever sold back on the shelf. See @shared/orderReset.
      db.prepare(`DELETE FROM invoices`).run()
      db.prepare(`DELETE FROM purchase_orders`).run()

      if (restart) {
        // Back to the floor rather than to zero: DT-000337 is where the owner's
        // register starts and a ticket below it would be a number this business
        // has never used. The PO and invoice counters are cleared instead of
        // set, because their own suggestion code already falls back to its
        // configured start when the table is empty — which it now is.
        setMeta(db, 'deal_ticket_seq', String(DEAL_TICKET_FLOOR))
      }
    })
    run()
    void actorId
    return { ok: true, data: { ...before, restartedNumbering: restart } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
