import type Database from 'better-sqlite3'
import { isSettledPurchaseOrder } from '@shared/purchaseOrders'
import type {
  OrderHistoryLine,
  OrderHistoryYears,
  PurchaseOrderHistoryRow,
  SalesOrderHistoryRow
} from '@shared/orderHistory'
import type { PurchaseOrderStatus } from '@shared/types'
import { isPurchaseOrderStatus } from '@shared/purchaseOrders'
import { INVOICE_STAGES, type InvoiceStatus } from '@shared/invoices'

/** Coerce a stored status string. Same rule invoices.ts applies on read. */
function asInvoiceStatus(v: unknown): InvoiceStatus {
  return v === 'void' || INVOICE_STAGES.some((s) => s.id === v) ? (v as InvoiceStatus) : 'draft'
}

/**
 * The year's ledger of orders — everything bought and everything sold.
 *
 * ## What this is for
 *
 * A board is a place where work is done. A purchase order that has been received
 * and settled has no work left on it, and leaving it there makes the orders that
 * DO need attention harder to see — so `listPurchaseOrders` sweeps it off after
 * two days. This is where it goes, and this is what makes that sweep safe: the
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
  year: number
): PurchaseOrderHistoryRow[] {
  const prefix = `${year}%`
  const rows = db
    .prepare(
      `SELECT id, po_number, status, supplier, location, total, created_at,
              ordered_at, paid_at, received_at, cancelled_at, carrier, tracking_number
         FROM purchase_orders
        WHERE COALESCE(ordered_at, created_at) LIKE ?
        ORDER BY po_number DESC`
    )
    .all(prefix) as PoRow[]
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
      settledQty: l.qty_received ?? 0
    })
    byPo.set(l.po_id, list)
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
      settled: isSettledPurchaseOrder({ status, receivedAt: r.received_at }, now),
      lines: own
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
  invoice_date: string
  due_date: string | null
  terms: string
  total: number
}

interface SoLineRow {
  invoice_id: string
  position: number
  product_id: string | null
  item: string
  sku: string | null
  quantity: number
  rate: number
  amount: number
  qty_fulfilled: number
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
  year: number
): SalesOrderHistoryRow[] {
  const prefix = `${year}%`
  const rows = db
    .prepare(
      `SELECT id, invoice_number, qbo_doc_number, status, customer_name,
              invoice_date, due_date, terms, total
         FROM invoices
        WHERE invoice_date LIKE ?
        ORDER BY invoice_date DESC, invoice_number DESC`
    )
    .all(prefix) as SoRow[]
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const lines = db
    .prepare(
      `SELECT invoice_id, position, product_id, item, sku, quantity, rate, amount, qty_fulfilled
         FROM invoice_lines
        WHERE invoice_id IN (${placeholders})
        ORDER BY invoice_id, position`
    )
    .all(...ids) as SoLineRow[]

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
      settledQty: l.product_id ? l.qty_fulfilled : null
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
      lines: own
    }
  })
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
