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

import type { ShopBuy, ShopShelfRow } from '@shared/availability'
import type { PurchaseOrderStatus } from '@shared/types'
import type { IncomingSource, StockProvenance, StockSource } from '@shared/provenance'
import type { SupplyingOrder } from '@shared/poStock'
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

/**
 * EVERY PURCHASE ORDER still holding stock of this product, per shelf.
 *
 * The same join `stockSources` uses, asked from the other end: not "where did
 * this layer come from" but "which of these orders still has anything left".
 * See @shared/poStock for what happens when one cannot cover a line.
 *
 * ## It was roadshow-only for about a day, and that was too narrow
 *
 * The owner's case: "we buy 5 of product A from a roadshow shop and then we buy
 * 5 from someone else — I want to select which PO these are coming from." The
 * someone else is very often an ordinary distributor, and its order was not on
 * the list, so the one scenario the chooser exists for was the one it could not
 * answer. Five roadshow cases and five distributor cases sitting on the same
 * shelf is exactly when it matters which five went out.
 *
 * A CANCELLED ORDER IS STILL EXCLUDED. Its cost is out of the ledger; selling
 * "out of" it would attribute units to a purchase the books say never happened.
 *
 * ## SUMMED PER ORDER AND SHELF, not per layer
 *
 * One order can open several layers of the same product — a line received over
 * two visits is two receipts and two lots — and the operator is choosing an
 * ORDER, not a layer. Listing "PO-0042 · 4 left" twice because the case arrived
 * in two vans would be asking somebody to answer a question the app should
 * never have shown them.
 *
 * ## Empty layers are dropped in the WHERE, not by the caller
 *
 * `qty_remaining > 0`, so an order whose cases have all been sold does not come
 * back at all. Offering it would offer a row whose only outcome is a refusal —
 * and this list is drawn on a sales order line, where every extra row is one
 * more thing to read past.
 *
 * ## A LOCATION FILTER THAT IS OPTIONAL ON PURPOSE
 *
 * A sale consumes from one shelf, so the screen asks for that shelf. Omitting
 * it answers "anywhere", which is what the purchase order's own receipt wants
 * when it lists what it still has out there.
 */
/**
 * EVERY BUY BEHIND ONE PRODUCT AT ONE SHOP, newest first.
 *
 * The owner: "the products in the roadshow tab should be more like smooth tiles
 * that I can click on and see dates at which I bought, and remember that each
 * time I add a product it is a PO number."
 *
 * A column tells you Kentucky is holding four. It cannot tell you they arrived
 * on three different days, on two different tabs, at two different prices — and
 * that is the question somebody asks the moment they are settling up or working
 * out what a case actually cost them. That answer already exists in the
 * receipts and the cost layers; it had nowhere to be read.
 *
 * ## Every receipt is a row, deliberately
 *
 * Not one row per purchase order. A tab takes a case on Tuesday and two more on
 * Thursday, and those are two separate acts of buying against one bill — the
 * whole shape of a roadshow week. Grouping them by order would hide the dates,
 * which are the thing being asked for.
 *
 * ## What is LEFT, beside what was bought
 *
 * A receipt of three with one remaining says the other two have gone. Reading
 * only the receipt would make a shelf look fuller than it is; reading only
 * what is left would lose the history. Both, and the tile shows the difference.
 */
export function shopBuys(location: string, productId: string): ShopBuy[] {
  const place = String(location ?? '').trim()
  const id = String(productId ?? '').trim()
  if (!place || !id) return []
  return (
    getDb()
      .prepare(
        `SELECT r.id            AS receipt_id,
                r.po_line_id    AS po_line_id,
                po.id           AS po_id,
                po.po_number    AS po_number,
                po.supplier     AS supplier,
                r.created_at    AS bought_at,
                r.quantity      AS quantity,
                lot.qty_remaining AS remaining,
                lot.unit_cost   AS unit_cost,
                line.price_pending AS price_pending,
                po.tab_opened_at AS tab_opened_at,
                po.tab_closed_at AS tab_closed_at,
                po.paid_at      AS paid_at
           FROM po_line_receipts r
           JOIN inventory_lots lot ON lot.id = r.lot_id
           JOIN purchase_orders po ON po.id = r.po_id
           JOIN purchase_order_lines line ON line.id = r.po_line_id
          WHERE lot.product_id = ?
            AND LOWER(lot.location) = LOWER(?)
            AND po.status != 'cancelled'
          ORDER BY r.created_at DESC, r.rowid DESC`
      )
      .all(id, place) as Array<{
      receipt_id: string
      po_line_id: string
      po_id: string
      po_number: string
      supplier: string | null
      bought_at: string
      quantity: number
      remaining: number
      unit_cost: number | null
      price_pending: number | null
      tab_opened_at: string | null
      tab_closed_at: string | null
      paid_at: string | null
    }>
  ).map((r) => ({
    id: String(r.receipt_id),
    poLineId: String(r.po_line_id),
    poId: String(r.po_id),
    poNumber: String(r.po_number),
    supplier: r.supplier ?? null,
    boughtAt: String(r.bought_at),
    quantity: Number(r.quantity) || 0,
    remaining: Number(r.remaining) || 0,
    // Null rather than zero while nobody has said, so a tile can show "price to
    // come" instead of claiming a case was free. See pricePending.
    unitCost: Number(r.price_pending) === 1 ? null : Number(r.unit_cost) || 0,
    settled: !!r.paid_at,
    tabOpen: !!r.tab_opened_at && !r.tab_closed_at
  }))
}

export function supplyingOrders(
  productId: string,
  location?: string | null
): SupplyingOrder[] {
  const id = String(productId ?? '').trim()
  if (!id) return []
  const shelf = String(location ?? '').trim()
  const rows = getDb()
    .prepare(
      `SELECT po.id             AS po_id,
              po.po_number      AS po_number,
              po.supplier       AS supplier,
              l.location        AS location,
              po.tab_opened_at  AS tab_opened_at,
              po.tab_closed_at  AS tab_closed_at,
              SUM(l.qty_remaining) AS on_hand
         FROM inventory_lots l
         JOIN po_line_receipts r ON r.lot_id = l.id
         JOIN purchase_orders  po ON po.id = r.po_id
        WHERE l.product_id = ?
          AND l.qty_remaining > 0
          AND po.status != 'cancelled'
          AND (? = '' OR l.location = ?)
        GROUP BY po.id, l.location
        -- RUNNING ROADSHOW ORDERS LEAD. They are the ones this control was built
        -- for and the ones somebody is most often reaching for; after them, the
        -- order that can actually cover the line comes first, which is the
        -- question being asked at a chooser like this.
        ORDER BY CASE
                   WHEN po.tab_opened_at IS NOT NULL AND po.tab_closed_at IS NULL THEN 0
                   ELSE 1
                 END,
                 on_hand DESC,
                 po.po_number ASC`
    )
    .all(id, shelf, shelf) as Array<{
    po_id: string
    po_number: string | null
    supplier: string | null
    location: string | null
    tab_opened_at: string | null
    tab_closed_at: string | null
    on_hand: number | null
  }>

  return rows.map((r) => ({
    poId: r.po_id,
    poNumber: str(r.po_number).trim(),
    supplier: str(r.supplier).trim() || null,
    location: str(r.location),
    unitsOnHand: num(r.on_hand),
    tabOpenedAt: r.tab_opened_at ?? null,
    tabClosedAt: r.tab_closed_at ?? null
  }))
}

/**
 * EVERYTHING ONE SHOP HAS HANDED OVER, and what became of it.
 *
 * The read behind the roadshow column. `stockAtLocation` answers "what can I
 * sell from here" and this answers "what has this week done", which is the
 * question somebody settling up with a shop is actually asking — and the one
 * that had no screen, because a case bought and sold the same afternoon never
 * appeared on the board at all.
 *
 * ## Every figure is COUNTED, and that is the design
 *
 * Three subqueries against three tables rather than one number and two
 * subtractions. `bought` comes off the receipts, keyed on the shelf the case
 * LANDED on — po_line_receipts.location, which stays put when a layer is later
 * driven home. `here` is the live shelf. `sold` is what left on invoices.
 *
 * Inferring `sold` as bought − here would report a case carried back to RM as
 * sold, which is a claim about money nobody received. Stock leaves a shelf three
 * ways and a subtraction cannot tell them apart — so the third way gets its own
 * figure, `movedOn`, and is zero on almost every row.
 *
 * ## What it lists
 *
 * Anything with a history OR a balance. A product bought and entirely sold has
 * bought > 0 and here = 0 and belongs on the list — that is the whole ask.
 * Something that arrived by transfer with no receipt behind it has here > 0 and
 * bought = 0 and belongs too, because it is standing there and can be sold.
 *
 * Void invoices are excluded from `sold` for the reason they are excluded
 * everywhere: voiding releases the stock, so those units are back on the shelf
 * and counting them as sold would double-count them against `here`.
 */
export function shopShelf(location: string): ShopShelfRow[] {
  const place = String(location ?? '').trim()
  if (!place) return []
  return (
    getDb()
      .prepare(
        `WITH bought AS (
           SELECT l.product_id AS pid, SUM(r.quantity) AS n
             FROM po_line_receipts r
             JOIN purchase_order_lines l ON l.id = r.po_line_id
             JOIN purchase_orders po ON po.id = r.po_id
            WHERE LOWER(TRIM(COALESCE(r.location, ''))) = LOWER(?)
              AND po.status != 'cancelled'
            GROUP BY l.product_id
         ),
         here AS (
           SELECT product_id AS pid, SUM(quantity) AS n
             FROM inventory_stock
            WHERE LOWER(TRIM(location)) = LOWER(?)
            GROUP BY product_id
         ),
         sold AS (
           SELECT m.product_id AS pid, SUM(m.quantity) AS n
             FROM invoice_stock_moves m
             JOIN invoices i ON i.id = m.invoice_id
            WHERE LOWER(TRIM(m.location)) = LOWER(?)
              AND i.status != 'void'
            GROUP BY m.product_id
         ),
         every_product AS (
           SELECT pid FROM bought UNION SELECT pid FROM here UNION SELECT pid FROM sold
         )
         SELECT p.id, p.name, p.sku, p.category,
                COALESCE(b.n, 0) AS bought,
                COALESCE(h.n, 0) AS here,
                COALESCE(s.n, 0) AS sold
           FROM every_product e
           JOIN inventory_products p ON p.id = e.pid
           LEFT JOIN bought b ON b.pid = e.pid
           LEFT JOIN here   h ON h.pid = e.pid
           LEFT JOIN sold   s ON s.pid = e.pid
          WHERE COALESCE(b.n, 0) > 0 OR COALESCE(h.n, 0) > 0 OR COALESCE(s.n, 0) > 0
          ORDER BY p.name ASC`
      )
      .all(place, place, place) as Array<{
      id: string
      name: string
      sku: string | null
      category: string | null
      bought: number
      here: number
      sold: number
    }>
  ).map((r) => {
    const bought = Number(r.bought) || 0
    const here = Number(r.here) || 0
    const sold = Number(r.sold) || 0
    return {
      productId: r.id,
      name: r.name,
      sku: r.sku ?? null,
      category: r.category ?? null,
      bought,
      here,
      sold,
      // Never negative: a shelf topped up by transfer legitimately holds more
      // than it ever bought, and a negative "moved on" would be nonsense on a
      // card rather than a diagnostic.
      movedOn: Math.max(0, bought - here - sold)
    }
  })
}
