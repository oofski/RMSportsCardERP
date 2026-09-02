/**
 * The read behind "where did these units come from". See @shared/lineSources.
 *
 * ## The chain, and the one join that must not be a JOIN
 *
 *   invoice_stock_moves   what this line took, and the transaction it took it in
 *     → inventory_txn_lots   which cost layers that transaction consumed
 *       → inventory_lots     what those layers cost and when they opened
 *         → po_line_receipts which purchase order receipt opened the layer
 *
 * The last step is a SUBQUERY, not a join, and that is load-bearing. A lot can
 * carry several `po_line_receipts` rows — one receipt per delivery against the
 * same layer — so joining it would return the layer once per receipt and every
 * quantity would be counted twice. The units on this screen are the units in the
 * P&L, so a display that doubles them is a display that starts an argument about
 * whether the books are wrong.
 */
import { getDb } from './database'
import type { LineSources, SoldSource } from '@shared/lineSources'

interface Row {
  line_position: number
  location: string
  quantity: number
  unit_cost: number
  picked: number
  received_at: string | null
  vendor: string | null
  po_number: string | null
  po_id: string | null
  supplier: string | null
}

/**
 * Every cost layer each line of one order drew, grouped by line.
 *
 * Ordered oldest layer first, which is the order FIFO consumed them in — so the
 * list reads as the story of the sale rather than as a set.
 */
export function invoiceLineSources(invoiceId: string): LineSources[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT m.line_position, m.location, tl.quantity, tl.unit_cost, tl.picked,
              l.received_at, l.vendor,
              (SELECT po.po_number FROM po_line_receipts r
                 JOIN purchase_orders po ON po.id = r.po_id
                WHERE r.lot_id = l.id LIMIT 1) AS po_number,
              (SELECT po.id FROM po_line_receipts r
                 JOIN purchase_orders po ON po.id = r.po_id
                WHERE r.lot_id = l.id LIMIT 1) AS po_id,
              (SELECT po.supplier FROM po_line_receipts r
                 JOIN purchase_orders po ON po.id = r.po_id
                WHERE r.lot_id = l.id LIMIT 1) AS supplier
         FROM invoice_stock_moves m
         JOIN inventory_txn_lots tl ON tl.txn_id = m.txn_id
         JOIN inventory_lots l ON l.id = tl.lot_id
        WHERE m.invoice_id = ?
        ORDER BY m.line_position ASC, l.received_at ASC`
    )
    .all(String(invoiceId ?? '')) as Row[]

  const byLine = new Map<number, SoldSource[]>()
  for (const r of rows) {
    const list = byLine.get(r.line_position) ?? []
    list.push({
      poNumber: (r.po_number ?? '').trim() || null,
      poId: (r.po_id ?? '').trim() || null,
      // The purchase order's supplier when there is one; otherwise whoever the
      // layer itself names, which is what a hand-counted lot records.
      supplier: (r.supplier ?? '').trim() || (r.vendor ?? '').trim() || null,
      location: r.location,
      quantity: Number(r.quantity) || 0,
      unitCost: Number(r.unit_cost) || 0,
      receivedAt: r.received_at,
      picked: r.picked === 1
    })
    byLine.set(r.line_position, list)
  }
  return [...byLine.entries()]
    .map(([position, sources]) => ({ position, sources }))
    .sort((a, b) => a.position - b.position)
}
