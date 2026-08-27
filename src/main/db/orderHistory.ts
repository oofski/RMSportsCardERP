import type Database from 'better-sqlite3'
import { isSettledPurchaseOrder } from '@shared/purchaseOrders'
import type {
  HistoryLineSource,
  HistoryPurchaseRef,
  HistorySaleRef,
  HistorySource,
  OrderHistoryLine,
  OrderHistoryYears,
  PurchaseOrderHistoryRow,
  SalesOrderHistoryRow
} from '@shared/orderHistory'
import { destinationHoldsStock } from '@shared/purchaseOrders'
import type { PurchaseOrderStatus } from '@shared/types'
import { isPurchaseOrderStatus } from '@shared/purchaseOrders'
import { INVOICE_STAGES, isSettledInvoice, type InvoiceStatus } from '@shared/invoices'

/** Coerce a stored status string. Same rule invoices.ts applies on read. */
function asInvoiceStatus(v: unknown): InvoiceStatus {
  return v === 'void' || INVOICE_STAGES.some((s) => s.id === v) ? (v as InvoiceStatus) : 'draft'
}

/**
 * The year's ledger of orders — everything bought and everything sold.
 *
 * ## What this is for
 *
 * A board is a place where work is done. A purchase order that has been paid for
 * AND received has no work left on it, and leaving it there makes the orders that
 * DO need attention harder to see — so it spends a day in the board's Completed
 * column and `listPurchaseOrders` then sweeps it off. This is where it goes, and
 * this is what makes that sweep safe: the
 * order has not been deleted, hidden or summarised. Every line, every date and
 * every number is still here, one search away, for as long as the database
 * exists.
 *
 * ## Why the history shows LIVE orders too
 *
 * It would be tidier to show only the settled ones — "the board has the live
 * work, history has the rest". It would also be wrong the first time somebody
 * looks up PO-0042 and cannot find it because it happens to be in transit. A
 * ledger of the year is a ledger of the year. Each row carries its stage, so a
 * live order is visibly live.
 *
 * ## One shape for both sides
 *
 * A purchase order and a sales order are mirror images — a party, some lines, a
 * total, some dates — and the screen renders them with one component. What
 * differs is what "settled" means on each: units received on the buy side, units
 * off the shelf on the sell side.
 */

const CENTS = (n: number): number => Math.round((Number(n) || 0) * 100) / 100

/**
 * EVERY SALE THAT DRAWS ON A PURCHASE, AND EVERY PURCHASE A SALE DRAWS ON.
 *
 * The union of the three separate claims a sale can make about where its goods
 * came from, because they are three different facts and any one of them makes
 * that purchase the origin:
 *
 *   invoice_lines.source_po_id              this LINE's units came out of it
 *   invoice_line_allocations.source_po_id   these CASES of the line did
 *   sale_purchase_links                     this DOCUMENT was supplied by it
 *
 * Reading only the first — which is what every screen did before — misses a
 * split line entirely and misses every dropship, where the two documents are one
 * deal and often share no catalog product at all. Those are exactly the orders
 * somebody opens a history to understand.
 *
 * VOID SALES ARE EXCLUDED. A cancelled order took nothing and supplied nothing,
 * and counting it would have a roadshow claiming buyers it never had.
 */
const SALE_PURCHASE_PAIRS = `
  SELECT DISTINCT l.invoice_id AS invoice_id, l.source_po_id AS po_id
    FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
   WHERE l.source_po_id IS NOT NULL AND TRIM(l.source_po_id) != '' AND i.status != 'void'
  UNION
  SELECT DISTINCT a.invoice_id, a.source_po_id
    FROM invoice_line_allocations a JOIN invoices i ON i.id = a.invoice_id
   WHERE a.source_po_id IS NOT NULL AND TRIM(a.source_po_id) != '' AND i.status != 'void'
  UNION
  SELECT DISTINCT k.invoice_id, k.po_id
    FROM sale_purchase_links k JOIN invoices i ON i.id = k.invoice_id
   WHERE i.status != 'void'`

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

interface PoRow {
  id: string
  po_number: string
  status: string
  supplier: string | null
  location: string
  total: number
  created_at: string
  ordered_at: string | null
  paid_at: string | null
  received_at: string | null
  cancelled_at: string | null
  carrier: string | null
  tracking_number: string | null
}

interface PoLineRow {
  po_id: string
  position: number
  product_id: string
  quantity: number
  unit_price: number
  qty_received: number | null
  name: string | null
  sku: string | null
}

function asPoStatus(v: unknown): PurchaseOrderStatus {
  return isPurchaseOrderStatus(v) ? v : 'ordered'
}

/**
 * Every purchase order filed under one year.
 *
 * Filed by `ordered_at` where there is one and by `created_at` otherwise — the
 * date the document says it is from, not the date a row happened to be written.
 * A PO raised on 31 December and received in January belongs to the year it was
 * raised, which is the year its money was committed.
 *
 * `LIKE 'YYYY%'` on a stored ISO string is an index-friendly prefix match and
 * needs no date arithmetic; every timestamp in this database is ISO-8601, which
 * sorts and prefixes lexically.
 */
export function listPurchaseOrderHistory(
  db: Database.Database,
  year: number,
  /**
   * NARROWED TO ONE PURCHASE, and then the YEAR IS IGNORED.
   *
   * "Pick a purchase order or a roadshow and see everything that came out of
   * it" — and what came out of a December trip is mostly sold in January, so
   * keeping the year filter on would answer the question with half the answer
   * and no sign that half was missing. Picking a source is a different question
   * from picking a year, so it replaces it rather than narrowing inside it.
   */
  sourcePoId?: string | null
): PurchaseOrderHistoryRow[] {
  const source = (sourcePoId ?? '').trim()
  const prefix = `${year}%`
  const rows = (
    source
      ? db
          .prepare(
            `SELECT id, po_number, status, supplier, location, total, created_at,
                    ordered_at, paid_at, received_at, cancelled_at, carrier, tracking_number
               FROM purchase_orders WHERE id = ?`
          )
          .all(source)
      : db
          .prepare(
            `SELECT id, po_number, status, supplier, location, total, created_at,
                    ordered_at, paid_at, received_at, cancelled_at, carrier, tracking_number
               FROM purchase_orders
              WHERE COALESCE(ordered_at, created_at) LIKE ?
              ORDER BY po_number DESC`
          )
          .all(prefix)
  ) as PoRow[]
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const lines = db
    .prepare(
      `SELECT l.po_id, l.position, l.product_id, l.quantity, l.unit_price, l.qty_received,
              p.name, p.sku
         FROM purchase_order_lines l
         LEFT JOIN inventory_products p ON p.id = l.product_id
        WHERE l.po_id IN (${placeholders})
        ORDER BY l.po_id, l.position`
    )
    .all(...ids) as PoLineRow[]

  const byPo = new Map<string, OrderHistoryLine[]>()
  for (const l of lines) {
    const list = byPo.get(l.po_id) ?? []
    list.push({
      position: l.position,
      productId: l.product_id,
      item: l.name ?? 'Product no longer in the catalog',
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: CENTS(l.unit_price),
      amount: CENTS(l.quantity * l.unit_price),
      settledQty: l.qty_received ?? 0,
      // EMPTY, ALWAYS. A purchase IS where goods came from; asking it the
      // question is asking the wrong document. See OrderHistoryLine.sources.
      sources: []
    })
    byPo.set(l.po_id, list)
  }

  /** Which sales each of these purchases supplied. See SALE_PURCHASE_PAIRS. */
  const wentTo = new Map<string, HistorySaleRef[]>()
  for (const s of db
    .prepare(
      `SELECT pairs.po_id, i.id AS invoice_id, i.invoice_number, i.qbo_doc_number, i.customer_name
         FROM (${SALE_PURCHASE_PAIRS}) pairs
         JOIN invoices i ON i.id = pairs.invoice_id
        WHERE pairs.po_id IN (${placeholders})
        ORDER BY i.invoice_date DESC, i.invoice_number DESC`
    )
    .all(...ids) as Array<{
    po_id: string
    invoice_id: string
    invoice_number: string | null
    qbo_doc_number: string | null
    customer_name: string
  }>) {
    const list = wentTo.get(s.po_id) ?? []
    list.push({
      invoiceId: s.invoice_id,
      number: s.invoice_number || s.qbo_doc_number || '—',
      customerName: s.customer_name
    })
    wentTo.set(s.po_id, list)
  }

  const now = Date.now()
  return rows.map((r) => {
    const own = byPo.get(r.id) ?? []
    const status = asPoStatus(r.status)
    return {
      id: r.id,
      number: r.po_number,
      status,
      supplier: r.supplier,
      destination: r.location,
      date: (r.ordered_at ?? r.created_at).slice(0, 10),
      orderedAt: r.ordered_at,
      paidAt: r.paid_at,
      receivedAt: r.received_at,
      cancelledAt: r.cancelled_at,
      carrier: r.carrier,
      trackingNumber: r.tracking_number,
      unitsOrdered: own.reduce((n, l) => n + l.quantity, 0),
      unitsReceived: own.reduce((n, l) => n + (l.settledQty ?? 0), 0),
      total: CENTS(r.total),
      // ALL FOUR FACTS, because the predicate needs all four. Passing only the
      // status and the receipt date used to be enough; it is not any more, and
      // the failure is silent — an order the board has already swept would show
      // here without the "filed" marker, so the one screen that can tell you
      // where an order went would say it is still on a board it has left.
      settled: isSettledPurchaseOrder(
        {
          status,
          receivedAt: r.received_at,
          paidAt: r.paid_at,
          cancelledAt: r.cancelled_at
        },
        now
      ),
      lines: own,
      suppliedSales: wentTo.get(r.id) ?? []
    }
  })
}

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

interface SoRow {
  id: string
  invoice_number: string | null
  qbo_doc_number: string | null
  status: string
  customer_name: string
  /** The order's own shelf. A blank line destination inherits it. */
  location: string | null
  invoice_date: string
  due_date: string | null
  terms: string
  total: number
  // The four facts isSettledInvoice needs, and no more. Fetched here rather
  // than by calling the board's read, because a history of 2019 must not depend
  // on an order still being on a board.
  paid_at: string | null
  qbo_paid_at: string | null
  qbo_voided: number | null
  last_tracked_at: string | null
}

interface SoLineRow {
  id: string
  invoice_id: string
  position: number
  product_id: string | null
  item: string
  sku: string | null
  quantity: number
  rate: number
  amount: number
  qty_fulfilled: number
  destination: string | null
  supplier: string | null
  source_po_id: string | null
}

/** One per-case split of a sales-order line, as stored. */
interface SoAllocRow {
  invoice_line_id: string
  quantity: number
  destination: string
  supplier: string | null
  source_po_id: string | null
}

/**
 * Every sales order filed under one year, with what it cost us.
 *
 * The cost comes from `invoice_stock_moves` — the receipt written when the order
 * took its stock — so it is the cost of the exact FIFO layers those boxes came
 * from rather than an average applied after the fact. An order with no priced
 * moves reports a null margin instead of one equal to its whole total: a line
 * shipped before orders took their own stock has no recoverable cost, and
 * showing its revenue as pure profit is the one mistake a ledger must not make.
 *
 * VOID ORDERS ARE KEPT. They are part of the year's record — somebody wrote
 * them, and "why is there a gap between 1041 and 1043" is exactly the question a
 * history is for. Their stock has been handed back, so they carry no cost.
 */
export function listSalesOrderHistory(
  db: Database.Database,
  year: number,
  /** One purchase, across every year. See the purchase-order twin above. */
  sourcePoId?: string | null
): SalesOrderHistoryRow[] {
  const source = (sourcePoId ?? '').trim()
  const prefix = `${year}%`
  const now = Date.now()
  const COLS = `id, invoice_number, qbo_doc_number, status, customer_name, location,
              invoice_date, due_date, terms, total,
              paid_at, qbo_paid_at, qbo_voided,
              -- The same MAX the board's read takes: a tracking number IS the
              -- shipped event here, and the last parcel to get one is when the
              -- order was fully out the door. See saleCompletedAt.
              (SELECT MAX(s.created_at) FROM order_shipments s
                WHERE s.order_kind = 'so' AND s.order_id = invoices.id
                  AND TRIM(COALESCE(s.tracking_number, '')) != '') AS last_tracked_at`
  const rows = (
    source
      ? db
          .prepare(
            `SELECT ${COLS}
               FROM invoices
              WHERE id IN (SELECT invoice_id FROM (${SALE_PURCHASE_PAIRS}) WHERE po_id = ?)
              ORDER BY invoice_date DESC, invoice_number DESC`
          )
          .all(source)
      : db
          .prepare(
            `SELECT ${COLS}
               FROM invoices
              WHERE invoice_date LIKE ?
              ORDER BY invoice_date DESC, invoice_number DESC`
          )
          .all(prefix)
  ) as SoRow[]
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const lines = db
    .prepare(
      `SELECT id, invoice_id, position, product_id, item, sku, quantity, rate, amount,
              qty_fulfilled, destination, supplier, source_po_id
         FROM invoice_lines
        WHERE invoice_id IN (${placeholders})
        ORDER BY invoice_id, position`
    )
    .all(...ids) as SoLineRow[]

  /**
   * The per-case splits, RAW.
   *
   * Read straight off the rows rather than through `effectiveSlices`, which is
   * the COST view and deliberately blanks the purchase order on any slice that
   * draws no shelf. That is right for money and wrong here: a dropship off a
   * roadshow tab is precisely the case where nothing else will ever say where
   * the goods came from.
   */
  const splits = new Map<string, SoAllocRow[]>()
  for (const a of db
    .prepare(
      `SELECT a.invoice_line_id, a.quantity, a.destination, a.supplier, a.source_po_id
         FROM invoice_line_allocations a
        WHERE a.invoice_id IN (${placeholders})
        ORDER BY a.position ASC, a.created_at ASC`
    )
    .all(...ids) as SoAllocRow[]) {
    const list = splits.get(a.invoice_line_id) ?? []
    list.push(a)
    splits.set(a.invoice_line_id, list)
  }

  /**
   * Every purchase order named anywhere on these sales, so a number and a
   * supplier can be printed instead of an id. ONE query for the lot: a year of
   * orders would otherwise cost a lookup per line, and almost every line names
   * nothing at all.
   */
  const poNames = new Map<string, { number: string; supplier: string | null }>()
  const namedPos = new Set<string>()
  for (const l of lines) if (l.source_po_id) namedPos.add(l.source_po_id)
  for (const list of splits.values()) {
    for (const a of list) if (a.source_po_id) namedPos.add(a.source_po_id)
  }
  const linkRows = db
    .prepare(
      `SELECT k.invoice_id, k.po_id, po.po_number, po.supplier
         FROM sale_purchase_links k
         JOIN purchase_orders po ON po.id = k.po_id
        WHERE k.invoice_id IN (${placeholders})
        ORDER BY k.created_at ASC, po.po_number ASC`
    )
    .all(...ids) as Array<{
    invoice_id: string
    po_id: string
    po_number: string
    supplier: string | null
  }>
  const attached = new Map<string, HistoryPurchaseRef[]>()
  for (const k of linkRows) {
    poNames.set(k.po_id, { number: k.po_number, supplier: k.supplier })
    const list = attached.get(k.invoice_id) ?? []
    list.push({ poId: k.po_id, poNumber: k.po_number, supplier: k.supplier })
    attached.set(k.invoice_id, list)
  }
  const unnamed = [...namedPos].filter((id) => !poNames.has(id))
  if (unnamed.length > 0) {
    for (const po of db
      .prepare(
        `SELECT id, po_number, supplier FROM purchase_orders
          WHERE id IN (${unnamed.map(() => '?').join(',')})`
      )
      .all(...unnamed) as Array<{ id: string; po_number: string; supplier: string | null }>) {
      poNames.set(po.id, { number: po.po_number, supplier: po.supplier })
    }
  }

  /**
   * WHERE ONE LINE'S GOODS CAME FROM, splits accounted for.
   *
   * Zero split rows is one implicit origin covering the whole line — the same
   * back-compat rule `effectiveSlices` keeps, restated here because this read
   * needs the raw purchase order and that function does not give it. A line with
   * no product is stock nobody ever held, so it reports nothing rather than
   * claiming it came off a shelf.
   */
  const originsOf = (l: SoLineRow, headerLocation: string): HistoryLineSource[] => {
    if (!l.product_id) return []
    const rows = splits.get(l.id) ?? []
    const one = (
      quantity: number,
      destination: string | null,
      supplier: string | null,
      poId: string | null
    ): HistoryLineSource => {
      const where = (destination ?? '').trim() || headerLocation
      const fromShelf = destinationHoldsStock(where)
      const po = poId ? poNames.get(poId) : undefined
      return {
        quantity,
        where,
        fromShelf,
        poId: poId || null,
        poNumber: po?.number ?? null,
        // The supplier of the PURCHASE when there is one; otherwise the party
        // shipping it direct, which on a dropship IS the destination.
        supplier: po?.supplier ?? (fromShelf ? null : (supplier ?? '').trim() || where)
      }
    }
    if (rows.length > 0) {
      return rows.map((a) => one(a.quantity, a.destination, a.supplier, a.source_po_id))
    }
    return [one(l.quantity, l.destination, l.supplier, l.source_po_id)]
  }

  // What each order's units cost, and whether that cost is knowable at all.
  const cost = new Map<string, { total: number; priced: number }>()
  for (const m of db
    .prepare(
      `SELECT invoice_id,
              COALESCE(SUM(cost_total), 0) AS c,
              COALESCE(SUM(CASE WHEN txn_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced
         FROM invoice_stock_moves
        WHERE invoice_id IN (${placeholders})
        GROUP BY invoice_id`
    )
    .all(...ids) as Array<{ invoice_id: string; c: number; priced: number }>) {
    cost.set(m.invoice_id, { total: CENTS(m.c), priced: m.priced })
  }

  const shelfOf = new Map(rows.map((r) => [r.id, (r.location ?? '').trim() || 'RM']))
  const byInvoice = new Map<string, OrderHistoryLine[]>()
  for (const l of lines) {
    const list = byInvoice.get(l.invoice_id) ?? []
    list.push({
      position: l.position,
      productId: l.product_id,
      item: l.item,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: CENTS(l.rate),
      amount: CENTS(l.amount),
      // A line with no product was never stock, so "how many went out" is not a
      // question about it. Null rather than zero, which would read as "none of
      // it shipped".
      settledQty: l.product_id ? l.qty_fulfilled : null,
      sources: originsOf(l, shelfOf.get(l.invoice_id) ?? 'RM')
    })
    byInvoice.set(l.invoice_id, list)
  }

  return rows.map((r) => {
    const own = byInvoice.get(r.id) ?? []
    const money = cost.get(r.id)
    const total = CENTS(r.total)
    return {
      id: r.id,
      number: r.invoice_number || r.qbo_doc_number || '—',
      status: asInvoiceStatus(r.status),
      customerName: r.customer_name,
      date: r.invoice_date.slice(0, 10),
      dueDate: r.due_date,
      terms: r.terms,
      qboDocNumber: r.qbo_doc_number,
      unitsSold: own.reduce((n, l) => n + l.quantity, 0),
      unitsOut: own.reduce((n, l) => n + (l.settledQty ?? 0), 0),
      total,
      cost: money?.total ?? 0,
      margin: money && money.priced > 0 ? CENTS(total - money.total) : null,
      // ALL FOUR FACTS, for the reason written on the purchase-order twin above:
      // the predicate needs every one of them, and passing fewer fails SILENTLY
      // — an order the board has already swept would show here without the
      // "filed" marker, so the one screen that can say where an order went would
      // claim it is still on a board it has left.
      settled: isSettledInvoice(
        {
          status: asInvoiceStatus(r.status),
          paidAt: r.paid_at,
          qboPaidAt: r.qbo_paid_at,
          qboVoided: !!r.qbo_voided,
          lastTrackedAt: r.last_tracked_at
        },
        now
      ),
      lines: own,
      sourcePos: attached.get(r.id) ?? []
    }
  })
}

/**
 * THE PURCHASES WORTH NARROWING THE HISTORY TO.
 *
 * Only the ones that actually supplied something: a picker listing every
 * purchase ever raised would bury the four that answer "what came out of the
 * Kansas City trip" among two hundred that supplied nothing anybody is asking
 * about. Counted through the same union the rest of this file uses, so a
 * purchase attached to a dropship — which shares no catalog product with the
 * sale and appears on no line — is offered exactly like one whose cases were
 * picked off a shelf.
 *
 * NOT SCOPED TO A YEAR, deliberately. A December roadshow is mostly sold in
 * January, and offering it only while the 2025 tab is open would hide the source
 * from the year that actually needs it.
 */
export function listHistorySources(db: Database.Database): HistorySource[] {
  return (
    db
      .prepare(
        `SELECT po.id, po.po_number, po.supplier,
                COALESCE(po.ordered_at, po.created_at) AS ordered_at,
                po.tab_opened_at,
                COUNT(DISTINCT pairs.invoice_id) AS sale_count
           FROM (${SALE_PURCHASE_PAIRS}) pairs
           JOIN purchase_orders po ON po.id = pairs.po_id
          GROUP BY po.id
          ORDER BY ordered_at DESC, po.po_number DESC`
      )
      .all() as Array<{
      id: string
      po_number: string
      supplier: string | null
      ordered_at: string | null
      tab_opened_at: string | null
      sale_count: number
    }>
  ).map((r) => ({
    poId: r.id,
    poNumber: r.po_number,
    supplier: (r.supplier ?? '').trim() || null,
    orderedOn: r.ordered_at ? r.ordered_at.slice(0, 10) : null,
    roadshow: !!r.tab_opened_at,
    saleCount: Number(r.sale_count) || 0
  }))
}

/**
 * Which years have anything in them.
 *
 * Read from the data rather than counted back from today, so a database with two
 * years in it offers two years and an empty one offers the current year to land
 * on rather than an empty picker.
 */
export function orderHistoryYears(db: Database.Database): OrderHistoryYears {
  const years = (sql: string): number[] =>
    (db.prepare(sql).all() as Array<{ y: string }>)
      .map((r) => Number(r.y))
      .filter((y) => Number.isInteger(y) && y > 1970)
      .sort((a, b) => b - a)

  const purchase = years(
    `SELECT DISTINCT substr(COALESCE(ordered_at, created_at), 1, 4) AS y FROM purchase_orders`
  )
  const sales = years(`SELECT DISTINCT substr(invoice_date, 1, 4) AS y FROM invoices`)
  const thisYear = new Date().getFullYear()
  return {
    purchase: purchase.length > 0 ? purchase : [thisYear],
    sales: sales.length > 0 ? sales : [thisYear]
  }
}
