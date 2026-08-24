/**
 * Where a product's stock came from, and what is still on order.
 *
 * READ ONLY. Two queries, no writes, nothing derived that is not in
 * @shared/provenance — this file's whole job is getting the rows out, and the
 * meaning of them lives in the shared contract so the screen and any future
 * caller cannot disagree about it.
 *
 * ## Nothing had to be migrated for this
 *
 * The link was already there. `po_line_receipts` records one row per RECEIPT
 * against a purchase-order line, carrying the exact `lot_id` that receipt
 * opened — it exists so cancelling a received PO can hand back precisely what
 * each commit took in. That makes it the answer to the opposite question too:
 * given a cost layer on the shelf, which purchase order brought it. A `po_id`
 * column on `inventory_lots` would have been a second copy of a fact the
 * database already held, and the two would drift the first time a receipt was
 * reversed.
 *
 * ## Why the outstanding side reads lines and not allocations
 *
 * A line is the BUY — this many of this product, at this price. Allocations
 * split that buy across shelves, and a line with no allocation is still a real
 * order. Counting allocations would silently drop those, and "the case is not on
 * the screen" is the worst possible failure for a screen somebody opens to find
 * out whether a case is coming.
 *
 * The DESTINATION is read the way the rest of the app reads it: a split's own
 * shelf, then the line's, then the order header. It is reported only when the
 * whole outstanding balance is headed to ONE shelf, and left null when it is
 * split — naming one of two would send somebody to the wrong building.
 */

import type { PurchaseOrderStatus } from '@shared/types'
import type { IncomingSource, StockProvenance, StockSource } from '@shared/provenance'
import { getDb } from './database'

interface SourceRow {
  lot_id: string
  location: string | null
  qty_remaining: number | null
  unit_cost: number | null
  received_at: string | null
  vendor: string | null
  source: string | null
  note: string | null
  po_id: string | null
  po_number: string | null
}

interface IncomingRow {
  po_id: string
  po_number: string | null
  supplier: string | null
  status: string | null
  ordered: number | null
  received: number | null
  unit_price: number | null
  ordered_at: string | null
  created_at: string | null
  paid_at: string | null
  destinations: number | null
  destination: string | null
  split_lines: number | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Every cost layer of this product still on a shelf, oldest first, with the
 * purchase order it arrived on when there was one.
 *
 * LEFT JOIN, deliberately and twice over. A layer opened by an opening balance,
 * a count sheet or a found-stock adjustment has no receipt row and no purchase
 * order, and those are ordinary layers holding real cases — an inner join would
 * quietly drop exactly the stock somebody most needs explaining.
 *
 * Oldest first because that is FIFO, which is the order these will actually be
 * consumed in. Somebody reading this list is choosing which case to open.
 */
export function stockSources(productId: string): StockSource[] {
  const rows = getDb()
    .prepare(
      `SELECT l.id            AS lot_id,
              l.location      AS location,
              l.qty_remaining AS qty_remaining,
              l.unit_cost     AS unit_cost,
              l.received_at   AS received_at,
              l.vendor        AS vendor,
              l.source        AS source,
              l.note          AS note,
              po.id           AS po_id,
              po.po_number    AS po_number
         FROM inventory_lots l
         -- The receipt that opened this layer. There is at most one: a receipt
         -- writes exactly one lot, which is why the reversal path can target it.
         LEFT JOIN po_line_receipts r ON r.lot_id = l.id
         LEFT JOIN purchase_orders  po ON po.id = r.po_id
        WHERE l.product_id = ? AND l.qty_remaining > 0
        ORDER BY l.received_at ASC, l.rowid ASC`
    )
    .all(productId) as SourceRow[]

  return rows.map((r) => ({
    lotId: r.lot_id,
    location: str(r.location),
    qtyRemaining: num(r.qty_remaining),
    unitCost: num(r.unit_cost),
    receivedAt: str(r.received_at),
    vendor: str(r.vendor).trim() || null,
    source: str(r.source) || 'restock',
    note: str(r.note).trim() || null,
    poId: r.po_id ?? null,
    poNumber: str(r.po_number).trim() || null
  }))
}

/**
 * Purchase orders with units of this product still to arrive.
 *
 * A CANCELLED ORDER BRINGS NOTHING and is excluded — it is not "coming", it is
 * over, and listing it under a heading that says what is on the way would have
 * somebody waiting for a case nobody is sending.
 *
 * Lines are grouped by ORDER rather than listed one per line: two lines of the
 * same product on one purchase order is one delivery, and a screen answering
 * "what is coming" should say "PO-0007 is bringing 4", not print the order
 * twice.
 */
export function incomingSources(productId: string): IncomingSource[] {
  const rows = getDb()
    .prepare(
      `SELECT po.id         AS po_id,
              po.po_number  AS po_number,
              po.supplier   AS supplier,
              po.status     AS status,
              po.ordered_at AS ordered_at,
              po.created_at AS created_at,
              po.paid_at    AS paid_at,
              SUM(l.quantity)                       AS ordered,
              SUM(COALESCE(recv.got, 0))            AS received,
              -- The price these units were bought at. Two lines of one product
              -- at two prices is rare and real; the higher one is the honest
              -- figure to plan a cost against.
              MAX(l.unit_price)                     AS unit_price,
              -- WHERE THESE UNITS ARE HEADED, in the order the app decides it
              -- everywhere else: a split's own shelf, then the line's, then the
              -- order header. An UNSPLIT LINE WRITES ZERO ALLOCATION ROWS by
              -- design — that is what makes an ordinary order identical to one
              -- raised before splitting existed — so reading allocations alone
              -- reports "nowhere" for almost every real purchase order.
              -- A line whose own splits disagree resolves to NULL, and a NULL
              -- anywhere means the order has no single destination. Falling
              -- through to the header there would print "to RM" on an order
              -- half of which is going to AM.
              COUNT(DISTINCT CASE WHEN dest.n_dest > 1 THEN NULL
                                  ELSE COALESCE(dest.only_one, l.destination, po.location) END) AS destinations,
              MIN(CASE WHEN dest.n_dest > 1 THEN NULL
                       ELSE COALESCE(dest.only_one, l.destination, po.location) END)            AS destination,
              SUM(CASE WHEN dest.n_dest > 1 THEN 1 ELSE 0 END)                                  AS split_lines
         FROM purchase_order_lines l
         JOIN purchase_orders po ON po.id = l.po_id
         -- What has already landed against each line, summed before the join so
         -- a line received in three commits is not counted three times.
         LEFT JOIN (
           SELECT po_line_id, SUM(quantity) AS got FROM po_line_receipts GROUP BY po_line_id
         ) recv ON recv.po_line_id = l.id
         -- AGGREGATED BEFORE THE JOIN, for the same reason the receipts are.
         -- Joining the allocation rows directly FANS THE LINE OUT: a line split
         -- across two shelves matched twice, so SUM(l.quantity) counted the
         -- order's four cases as eight and the screen reported twice as much
         -- stock coming as anybody had bought. only_one is NULL when a line
         -- is split, which is what makes the destination fall through to null
         -- rather than naming one of two.
         LEFT JOIN (
           SELECT po_line_id,
                  COUNT(DISTINCT destination) AS n_dest,
                  MIN(destination)            AS only_one
             FROM purchase_order_allocations
            GROUP BY po_line_id
         ) dest ON dest.po_line_id = l.id
        WHERE l.product_id = ? AND po.status != 'cancelled'
        GROUP BY po.id
       HAVING SUM(l.quantity) > SUM(COALESCE(recv.got, 0))
        ORDER BY COALESCE(po.ordered_at, po.created_at) ASC, po.po_number ASC`
    )
    .all(productId) as IncomingRow[]

  return rows.map((r) => {
    const ordered = num(r.ordered)
    const received = num(r.received)
    return {
      poId: r.po_id,
      poNumber: str(r.po_number),
      supplier: str(r.supplier).trim() || null,
      status: (str(r.status) || 'ordered') as PurchaseOrderStatus,
      // Named only when the WHOLE outstanding balance is headed to one shelf.
      // A split order has no single destination, and picking one of two would
      // send somebody to the wrong building.
      destination:
        num(r.destinations) === 1 && num(r.split_lines) === 0
          ? str(r.destination).trim() || null
          : null,
      ordered,
      received,
      outstanding: Math.max(0, Math.round((ordered - received) * 10000) / 10000),
      unitPrice: num(r.unit_price),
      orderedAt: str(r.ordered_at) || str(r.created_at),
      paid: !!r.paid_at
    }
  })
}

/** Both halves in one read, so the panel opens with one round trip. */
export function productProvenance(productId: string): StockProvenance {
  const id = String(productId ?? '').trim()
  if (!id) return { productId: '', onHand: [], incoming: [] }
  return { productId: id, onHand: stockSources(id), incoming: incomingSources(id) }
}
